/** get_timeline, create_timeline, set_active_timeline, manage_markers, set_project_settings, undo. */
import { DEFAULT_MARKER_COLOR, type MarkerStatus, type TimelineMarker } from '../../../core/model'
import { activeTimeline, timelineById } from '../../../core/ops/context'
import { applyTimelineSettings, createTimeline, duplicateTimeline, qualityResolution, renameTimeline } from '../../../core/ops/project'
import { changeMarkers } from '../../../core/ops/tracks'
import { allClips, EditRefusal, totalFrames } from '../../../core/timeline'
import { ToolError, decodeArgs, lenient, opt, parseColor, validateUnknownKeys, type Obj } from './args'
import { mutate, ok, okJson, okRawJson, type ToolEnv, type ToolResult } from './context'
import { canGenerate } from './generation'
import { swiftDouble } from './json'
import { frameWindow, markerDict, timelinePayload } from './timelineView'

export function getTimeline(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['startFrame', 'endFrame', 'captionDetail'], 'get_timeline')
  const window = frameWindow(args)
  const doc = env.session.doc
  const clipIds = new Set(allClips(activeTimeline(doc)).map((c) => c.id))
  const mediaIds = new Set(doc.manifest.entries.map((e) => e.id))
  const ui = env.session.ui
  const range: [number, number] | null = ui.rangeIn !== null && ui.rangeOut !== null ? [Math.min(ui.rangeIn, ui.rangeOut), Math.max(ui.rangeIn, ui.rangeOut)] : null
  return okJson(
    timelinePayload(doc, {
      window,
      captionDetail: args.captionDetail === true,
      currentFrame: ui.playheadFrame,
      canGenerate: canGenerate(env.app),
      selection: { clipIds: ui.selectedClipIds.filter((id) => clipIds.has(id)), mediaIds: ui.selectedMediaIds.filter((id) => mediaIds.has(id)), range },
    }),
  )
}

export function createTimelineTool(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['name', 'from'], 'create_timeline')
  const from = lenient.string(args, 'from')
  const name = lenient.string(args, 'name')
  let id: string
  let note: string
  if (from) {
    const source = timelineById(env.session.doc, from)
    if (!source) throw new ToolError(`No timeline with id '${from}'. get_media lists the project's timelines.`)
    id = mutate(env, 'Duplicate Timeline (Agent)', (d) => {
      const copy = duplicateTimeline(d, from)
      if (name) ignoringNoop(() => renameTimeline(d, copy.id, name))
      return copy.id
    })
    note = `Duplicated "${source.name}" and switched to the copy. Its clip and track ids are new — re-read get_timeline before editing.`
  } else {
    id = mutate(env, 'Create Timeline (Agent)', (d) => createTimeline(d, name).id)
    note = 'Empty and now active; all edit tools target it.'
  }
  return okRawJson({ timelineId: id, name: timelineById(env.session.doc, id)?.name ?? '', active: true, note })
}

/** Domain refusals of no-op edits (unchanged name, track already in place) are not errors for the agent. */
export function ignoringNoop(rename: () => void): void {
  try {
    rename()
  } catch (e) {
    if (!(e instanceof EditRefusal)) throw e
  }
}

export function setActiveTimeline(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['timelineId'], 'set_active_timeline')
  const id = lenient.string(args, 'timelineId')
  if (!id) throw new ToolError('timelineId is required')
  const target = timelineById(env.session.doc, id)
  if (!target) throw new ToolError(`No timeline with id '${id}'. get_media lists the project's timelines.`)
  const payload: Obj = { timelineId: target.id, name: target.name, active: true, totalFrames: totalFrames(target), fps: target.fps, trackCount: target.tracks.length }
  if (activeTimeline(env.session.doc).id === target.id) payload.note = 'Already the active timeline.'
  else {
    env.session.apply('activateTimeline', { id: target.id })
    payload.note = 'Re-read get_timeline — clip and track ids from the previous timeline no longer apply.'
  }
  return okRawJson(payload)
}

// ---------- Markers ----------

interface MarkersInput {
  action: string
  markerId?: string
  name?: string
  startFrame?: number
  durationFrames?: number
  color?: string
  comment?: string
  status?: string
}

const STATUSES: MarkerStatus[] = ['open', 'review', 'resolved']

function validMarker(m: TimelineMarker): void {
  const name = m.name.trim()
  // eslint-disable-next-line no-control-regex
  if (!name || [...name].length > 120 || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(name)) throw new ToolError('Marker names must be non-empty single lines of at most 120 characters.')
  if ([...m.comment].length > 4000) throw new ToolError('Marker comments must be at most 4000 characters.')
}

export function manageMarkers(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<MarkersInput>(args, 'manage_markers', {
    action: 'String',
    markerId: opt('String'),
    name: opt('String'),
    startFrame: opt('Int'),
    durationFrames: opt('Int'),
    color: opt('String'),
    comment: opt('String'),
    status: opt('String'),
  })
  if (input.status !== undefined && !STATUSES.includes(input.status as MarkerStatus)) throw new ToolError('status must be open, review, or resolved.')
  const status = input.status as MarkerStatus | undefined
  const t = activeTimeline(env.session.doc)
  let change: Parameters<typeof changeMarkers>[1]
  let label: string
  switch (input.action) {
    case 'create': {
      if (input.name === undefined || input.startFrame === undefined) throw new ToolError('create requires name and startFrame.')
      const marker: TimelineMarker = {
        id: '',
        name: input.name,
        startFrame: input.startFrame,
        durationFrames: input.durationFrames ?? 0,
        color: input.color !== undefined ? parseColor(input.color, 'color') : { ...DEFAULT_MARKER_COLOR },
        comment: input.comment ?? '',
        status: status ?? 'open',
      }
      validMarker(marker)
      const { id: _id, ...draft } = marker
      change = { creates: [draft] }
      label = 'Add Marker (Agent)'
      break
    }
    case 'update': {
      const hasPatch = [input.name, input.startFrame, input.durationFrames, input.color, input.comment, input.status].some((v) => v !== undefined)
      if (input.markerId === undefined || !hasPatch) throw new ToolError('update requires markerId and at least one field to change.')
      const current = t.markers.find((m) => m.id === input.markerId)
      if (!current) throw new ToolError(`Unknown markerId '${input.markerId}'.`)
      const marker: TimelineMarker = { ...current, color: { ...current.color } }
      if (input.name !== undefined) marker.name = input.name
      if (input.startFrame !== undefined) marker.startFrame = input.startFrame
      if (input.durationFrames !== undefined) marker.durationFrames = input.durationFrames
      if (input.color !== undefined) marker.color = parseColor(input.color, 'color')
      if (input.comment !== undefined) marker.comment = input.comment
      if (status) marker.status = status
      validMarker(marker)
      change = { updates: [marker] }
      label = 'Change Marker (Agent)'
      break
    }
    case 'delete':
      if (input.markerId === undefined) throw new ToolError('delete requires markerId.')
      change = { deleteIds: [input.markerId] }
      label = 'Delete Marker (Agent)'
      break
    default:
      throw new ToolError('action must be create, update, or delete.')
  }
  const outcome = env.session.transact(label, (d) => changeMarkers(d, change))
  if (!outcome.ok) {
    if (outcome.error === 'No marker changes.') return okRawJson({ noOp: true })
    throw new ToolError('Marker frames must be non-negative integer ranges and every ID must exist.')
  }
  const r = outcome.result
  const payload: Obj = {}
  if (r.created[0]) payload.created = markerDict(r.created[0])
  if (r.updated[0]) payload.updated = markerDict(r.updated[0])
  if (r.deletedIds[0]) payload.deletedMarkerId = r.deletedIds[0]
  return okRawJson(Object.keys(payload).length ? payload : { noOp: true })
}

// ---------- Project settings ----------

interface SettingsInput {
  fps?: number
  width?: number
  height?: number
  aspectRatio?: string
  quality?: string
}

export interface ValidatedSettings {
  input: SettingsInput
  ratio?: number
  shortEdge?: number
}

const QUALITY_SHORT_EDGE: Record<string, number> = { '720p': 720, '1080p': 1080, '2K': 1440, '4K': 2160 }

function parseAspectRatio(text: string): number {
  const parts = text.split(':')
  const nums = parts.map((p) => p.trim())
  const valid = (s: string) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)
  if (parts.length !== 2 || !valid(nums[0]) || !valid(nums[1])) throw new ToolError('Use an aspect ratio with two positive numbers, such as 3:2.')
  const [h, v] = nums.map(Number)
  if (!(Number.isFinite(h) && Number.isFinite(v) && h > 0 && v > 0 && Number.isFinite(h / v))) throw new ToolError('Use an aspect ratio with two positive numbers, such as 3:2.')
  return h / v
}

function aspectResolution(ratio: number, shortEdge: number): [number, number] {
  if (shortEdge < 2) throw new ToolError('Resolution must be at least 2 × 2 pixels.')
  const short = shortEdge % 2 === 0 ? shortEdge : shortEdge + 1
  const longValue = short * Math.max(ratio, 1 / ratio)
  if (longValue > 8192) throw new ToolError('Resolution must not exceed 8192 pixels on either edge.')
  const long = Math.round(longValue / 2) * 2
  return ratio >= 1 ? [long, short] : [short, long]
}

export function validateProjectSettings(args: Obj): ValidatedSettings {
  const input = decodeArgs<SettingsInput>(args, 'set_project_settings', {
    fps: opt('Int'),
    width: opt('Int'),
    height: opt('Int'),
    aspectRatio: opt('String'),
    quality: opt('String'),
  })
  if (Object.values(input).every((v) => v === undefined)) throw new ToolError('Provide at least one of: fps, width, height, aspectRatio, quality')
  if ((input.width === undefined) !== (input.height === undefined)) throw new ToolError('Provide both width and height')
  if (input.width !== undefined && (input.aspectRatio !== undefined || input.quality !== undefined)) throw new ToolError("Explicit dimensions can't be combined with aspectRatio or quality")
  if (input.fps !== undefined && !(input.fps >= 1 && input.fps <= 120)) throw new ToolError(`fps must be between 1 and 120 (got ${input.fps})`)
  const ratio = input.aspectRatio !== undefined ? parseAspectRatio(input.aspectRatio) : undefined
  let shortEdge: number | undefined
  if (input.quality !== undefined) {
    shortEdge = QUALITY_SHORT_EDGE[input.quality]
    if (shortEdge === undefined) throw new ToolError(`Unknown quality '${input.quality}'. Use one of: 720p, 1080p, 2K, 4K`)
  }
  return { input, ratio, shortEdge }
}

export function resolveSettings(v: ValidatedSettings, current: { fps: number; width: number; height: number }): { fps: number; width: number; height: number } {
  let [w, h] = [v.input.width ?? current.width, v.input.height ?? current.height]
  if (v.ratio !== undefined) [w, h] = aspectResolution(v.ratio, v.shortEdge ?? Math.min(current.width, current.height))
  else if (v.shortEdge !== undefined && w > 0 && h > 0) ({ width: w, height: h } = qualityResolution(v.shortEdge, w, h))
  const changesResolution = v.input.width !== undefined || v.ratio !== undefined || v.shortEdge !== undefined
  if (!(w > 0 && h > 0) || (changesResolution && (w > 8192 || h > 8192))) throw new ToolError('Resolution must be positive and no larger than 8192 pixels on either edge')
  return { fps: v.input.fps ?? current.fps, width: w, height: h }
}

export function aspectLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return '—'
  let [a, b] = [width, height]
  while (b !== 0) [a, b] = [b, a % b]
  const [rw, rh] = [width / a, height / a]
  if (Math.max(rw, rh) <= 100) return `${rw}:${rh}`
  const ratio = width / height
  return ratio >= 1 ? `${swiftDouble(Math.round(ratio * 100) / 100)}:1` : `1:${swiftDouble(Math.round((1 / ratio) * 100) / 100)}`
}

export function settingsReceipt(prev: { fps: number; width: number; height: number }, next: { fps: number; width: number; height: number }): Obj {
  const changed: string[] = []
  if (next.fps !== prev.fps) changed.push('fps')
  if (next.width !== prev.width || next.height !== prev.height) changed.push('resolution')
  const payload: Obj = { fps: next.fps, resolution: `${next.width}x${next.height}`, aspectRatio: aspectLabel(next.width, next.height), changed }
  if (!changed.length) payload.note = 'Settings already matched.'
  else if (changed.includes('fps')) payload.note = `Clip frames rescaled to ${next.fps}fps — re-read get_timeline before frame-based edits.`
  return payload
}

export function setProjectSettings(env: ToolEnv, args: Obj): ToolResult {
  const t = activeTimeline(env.session.doc)
  const prev = { fps: t.fps, width: t.width, height: t.height }
  const next = resolveSettings(validateProjectSettings(args), prev)
  mutate(env, 'Set Project Settings (Agent)', (d) => applyTimelineSettings(d, next.fps, next.width, next.height))
  return okRawJson(settingsReceipt(prev, next))
}

export function undoTool(env: ToolEnv): ToolResult {
  if (env.session.undo() === null) throw new ToolError('Nothing to undo.')
  return ok('Undid the latest action. The timeline is restored to its state before that edit; re-read with get_timeline or get_transcript before editing again.')
}
