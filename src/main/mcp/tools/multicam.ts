/** get_multicam (read a group's members and program cut) and change_cam (switch angles over frame ranges). */
import type { MulticamSource } from '../../../core/model'
import { activeTimeline, type Doc } from '../../../core/ops/context'
import { isVideoLayout, layoutSlots, VIDEO_LAYOUTS, type VideoLayout } from '../../../core/ops/layout'
import { memberUsable, multicamGroup, multicamTrackIndexes, programRows, resolveAngle, switchMulticamAngles, type AngleSwitch } from '../../../core/ops/multicam'
import { findClip } from '../../../core/timeline'
import { ToolError, isObj, lenient, validateUnknownKeys, type Obj } from './args'
import { mutate, okJson, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { frameWindow } from './timelineView'

function requireGroup(doc: Doc, groupId: string): MulticamSource {
  const g = multicamGroup(doc, groupId)
  if (!g) throw new ToolError(`No multicam group '${groupId}'. get_timeline lists multicamGroups.`)
  return g
}

function resolveGroup(doc: Doc, args: Obj): MulticamSource {
  const groupId = lenient.string(args, 'groupId')
  if (groupId) return requireGroup(doc, groupId)
  const clipId = lenient.string(args, 'clipId')
  if (clipId) {
    const c = findClip(activeTimeline(doc), clipId)?.clip
    const g = c?.multicamGroupId ? multicamGroup(doc, c.multicamGroupId) : undefined
    if (!g) throw new ToolError(`Clip '${clipId}' is not part of a multicam group.`)
    return g
  }
  throw new ToolError('Pass groupId or clipId.')
}

const memberRows = (g: MulticamSource): Obj[] =>
  g.members.map((m) => {
    const row: Obj = { angleLabel: m.angleLabel, kind: m.kind, mediaRef: m.mediaRef, offsetSeconds: m.sync.offsetSeconds, confidence: m.sync.confidence }
    if (m.id === g.masterMemberId) row.master = true
    if (m.sync.locked) row.pinned = true
    if (!memberUsable(m)) row.unsynced = true
    return row
  })

export function getMulticam(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['groupId', 'clipId', 'startFrame', 'endFrame'], 'get_multicam')
  const doc = env.session.doc
  const g = resolveGroup(doc, args)
  const window = frameWindow(args)
  return okJson({ groupId: g.id, name: g.name, members: memberRows(g), program: programRows(doc, g.id, window), trackIndexes: multicamTrackIndexes(doc, g.id) })
}

export function changeCam(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['groupId', 'clipId', 'entries'], 'change_cam')
  const doc = env.session.doc
  const g = resolveGroup(doc, args)
  const raw = args.entries
  if (!Array.isArray(raw) || !raw.length || !raw.every(isObj)) throw new ToolError('entries requires at least one {range, angle} entry.')
  const requests = raw.map((entry, i) => {
    const path = `entries[${i}]`
    validateUnknownKeys(entry, ['range', 'angle', 'layout', 'angles'], path)
    const range = entry.range
    const [a, b] = Array.isArray(range) && range.length === 2 && range.every((v) => typeof v === 'number') ? range.map((v) => Math.trunc(v as number)) : [NaN, NaN]
    if (!(a < b)) throw new ToolError(`${path}: range must be [startFrame, endFrame) with start < end.`)
    let layout: VideoLayout = 'full'
    let angles: string[]
    if (typeof entry.layout === 'string') {
      if (entry.angle !== undefined) throw new ToolError(`${path}: pass angle for a full-frame switch OR layout + angles, not both.`)
      if (!isVideoLayout(entry.layout) || entry.layout === 'full') {
        throw new ToolError(`${path}: unknown layout '${entry.layout}'. Valid: ${VIDEO_LAYOUTS.filter((l) => l !== 'full').join(', ')}. For full frame, pass angle instead.`)
      }
      layout = entry.layout
      const slots = layoutSlots(layout)
      if (!Array.isArray(entry.angles) || !entry.angles.length || !entry.angles.every((x) => typeof x === 'string')) {
        throw new ToolError(`${path}: layout needs angles — angleLabels in slot order (${slots.map((s) => s.id).join(', ')}); fewer than slots leaves cells empty.`)
      }
      if (entry.angles.length > slots.length) throw new ToolError(`Layout ${layout} takes at most ${slots.length} angle(s): ${slots.map((s) => s.id).join(', ')}.`)
      angles = entry.angles as string[]
    } else angles = [lenient.requireString(entry, 'angle')]
    return { a, b, layout, angles }
  })
  const entries: AngleSwitch[] = requests.map((r) => {
    try {
      return { start: r.a, end: r.b, layout: r.layout, slots: r.angles.map((label) => resolveAngle(g, label)) }
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : String(e))
    }
  })
  const before = snapshot(doc)
  const outcome = mutate(env, 'Switch Angle (Agent)', (d) => switchMulticamAngles(d, g.id, entries))
  const extra: Obj = { groupId: g.id, switched: outcome.switched }
  if (outcome.merged > 0) extra.cutsMerged = outcome.merged
  if (outcome.overlayClipIds.length) extra.overlayClipIds = outcome.overlayClipIds
  if (outcome.applied.length) {
    const lo = Math.min(...outcome.applied.map((r) => r[0]))
    const hi = Math.max(...outcome.applied.map((r) => r[1]))
    extra.program = programRows(env.session.doc, g.id, { start: lo, end: hi })
  }
  if (outcome.clamped.length) extra.clamped = outcome.clamped
  if (outcome.skipped.length) extra.skipped = outcome.skipped
  return mutationResult(env.session.doc, before, { extra })
}
