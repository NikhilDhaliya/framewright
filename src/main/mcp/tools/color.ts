/** apply_color (grade knobs / pasted grade), apply_effect (non-color FX) and inspect_color (scopes). */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { transformAt } from '../../../core/clip'
import type { Clip } from '../../../core/model'
import { activeTimeline } from '../../../core/ops/context'
import { applyEffectEntries, effectDescriptor, type EffectEntry } from '../../../core/ops/effects'
import { buildColorStack, gradeFromColorObject, GRADE_KNOBS, mergeColorGrade, pasteColorStack, type GradeInput, type HueTarget } from '../../../core/ops/grade'
import { findClip } from '../../../core/timeline'
import { appDirs } from '../../paths'
import { projectIdFor } from '../../project/registry'
import { ToolError, decodeArgs, isObj, opt, validateUnknownKeys, type Fields, type Obj } from './args'
import { image, mutate, okRawJson, type Block, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { decodeRgba, imageSize, transcodeImage } from './images'
import { gap, measureScopes, readout, SCOPE_GRID, type Scopes } from './scopes'

// ---------- apply_color ----------

type ColorInput = Partial<Record<(typeof GRADE_KNOBS)[number], number>> & {
  clipIds: string[]
  reset?: boolean
  masterCurve?: number[][]
  redCurve?: number[][]
  greenCurve?: number[][]
  blueCurve?: number[][]
  hueCurves?: { targets?: HueTarget[] }
  lut?: { path?: string; strength?: number }
}

const curve = opt({ arr: { arr: 'Double' } })
const knob = opt('Double')
const COLOR_FIELDS: Fields = {
  clipIds: { arr: 'String' },
  reset: opt('Bool'),
  exposure: knob,
  contrast: knob,
  saturation: knob,
  vibrance: knob,
  temperature: knob,
  tint: knob,
  highlights: knob,
  shadows: knob,
  blacks: knob,
  whites: knob,
  shadowsHue: knob,
  shadowsAmount: knob,
  shadowsLum: knob,
  midsHue: knob,
  midsAmount: knob,
  midsGamma: knob,
  highsHue: knob,
  highsAmount: knob,
  highsGain: knob,
  masterCurve: curve,
  redCurve: curve,
  greenCurve: curve,
  blueCurve: curve,
  hueCurves: opt({ obj: { targets: opt({ arr: { obj: { targetHue: 'Double', hueShift: opt('Double'), satScale: opt('Double'), lumShift: opt('Double') } } }) } }),
  lut: opt({ obj: { path: opt('String'), strength: opt('Double') } }),
}

const COLOR_OBJECT_KEYS = [...Object.keys(COLOR_FIELDS).filter((k) => !['clipIds', 'reset', 'hueCurves'].includes(k)), 'hueCurvesRaw']

/** Minimal .cube validation: a 3D table of the declared size. */
function isCube(text: string): boolean {
  let dimension = 0
  let values = 0
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/ +/)
    const key = parts[0].toUpperCase()
    if (key === 'LUT_1D_SIZE') return false
    if (key === 'TITLE' || key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') continue
    if (key === 'LUT_3D_SIZE') dimension = Number.parseInt(parts[parts.length - 1], 10) || 0
    else if (parts.length >= 3) {
      if (parts.slice(0, 3).some((p) => !Number.isFinite(Number(p)))) return false
      values++
    }
  }
  return dimension > 1 && dimension <= 128 && values === dimension ** 3
}

/** Copies a .cube into the app's LUT store (projects drop unknown files) and returns the stored path. */
async function storeLut(raw: string, projectId: string | null): Promise<string> {
  const source = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()))
  const text = await fs.readFile(source, 'utf8').catch(() => null)
  if (text === null) throw new ToolError(`No file at path: ${source}`)
  if (!isCube(text)) throw new ToolError(`Not a valid .cube 3D LUT: ${path.basename(source)}`)
  const dir = path.join(appDirs.data, 'luts', projectId ?? 'default')
  await fs.mkdir(dir, { recursive: true })
  const dest = path.join(dir, path.basename(source))
  if (dest !== source) await fs.copyFile(source, dest)
  return dest
}

function requireGradable(env: ToolEnv, ids: string[], tool: string): void {
  const t = activeTimeline(env.session.doc)
  for (const id of ids) {
    const c = findClip(t, id)?.clip
    if (!c) throw new ToolError(`Clip not found: ${id}`)
    if (c.mediaType !== 'video' && c.mediaType !== 'image') throw new ToolError(`Clip ${id} is a ${c.mediaType} clip; ${tool} needs a video or image clip.`)
  }
}

export async function applyColor(env: ToolEnv, args: Obj): Promise<ToolResult> {
  const colorDict = isObj(args.color) ? args.color : undefined
  const { color: _color, ...knobArgs } = args
  const input = decodeArgs<ColorInput>(knobArgs, 'apply_color', COLOR_FIELDS)
  if (!input.clipIds.length) throw new ToolError('clipIds is empty.')
  const hasAnyParam =
    GRADE_KNOBS.some((k) => input[k] !== undefined) ||
    [input.masterCurve, input.redCurve, input.greenCurve, input.blueCurve].some((c) => c !== undefined) ||
    !!input.hueCurves?.targets?.length ||
    input.lut !== undefined
  if (colorDict) {
    if (hasAnyParam || input.reset === true) throw new ToolError("'color' pastes a complete grade — don't combine it with individual knobs or reset.")
    validateUnknownKeys(colorDict, COLOR_OBJECT_KEYS, 'apply_color.color')
  } else if (!hasAnyParam && !input.reset) throw new ToolError('No grade parameters provided.')
  requireGradable(env, input.clipIds, 'apply_color')
  const projectId = await projectIdFor(env.session.path)
  const lutDest = input.lut?.path ? await storeLut(input.lut.path, projectId) : undefined
  let pasted: ReturnType<typeof buildColorStack> | undefined
  if (colorDict) {
    const state = gradeFromColorObject(colorDict)
    if (state.lutPath) state.lutPath = await storeLut(state.lutPath, projectId)
    if (state.lutIntensity !== undefined) state.lutIntensity = Math.min(1, Math.max(0, state.lutIntensity))
    pasted = buildColorStack(state)
  }
  const grade: GradeInput = { masterCurve: input.masterCurve, redCurve: input.redCurve, greenCurve: input.greenCurve, blueCurve: input.blueCurve, hueTargets: input.hueCurves?.targets, lutStrength: input.lut?.strength }
  for (const k of GRADE_KNOBS) grade[k] = input[k]
  const before = snapshot(env.session.doc)
  const label = input.clipIds.length === 1 ? 'Color Grade (Agent)' : `Color Grade ×${input.clipIds.length} (Agent)`
  mutate(env, label, (d) => {
    const t = activeTimeline(d)
    for (const id of new Set(input.clipIds)) {
      const c = findClip(t, id)!.clip
      if (pasted) pasteColorStack(c, JSON.parse(JSON.stringify(pasted)))
      else mergeColorGrade(c, grade, input.reset ?? false, lutDest)
    }
  })
  return mutationResult(env.session.doc, before, { touched: input.clipIds })
}

// ---------- apply_effect ----------

export function applyEffect(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<{ clipIds: string[]; effects?: EffectEntry[]; remove?: string[] }>(args, 'apply_effect', {
    clipIds: { arr: 'String' },
    effects: opt({ arr: { obj: { type: 'String', params: opt({ dict: 'Double' }), enabled: opt('Bool') } } }),
    remove: opt({ arr: 'String' }),
  })
  if (!input.clipIds.length) throw new ToolError('clipIds is empty.')
  const adds = input.effects ?? []
  const removes = input.remove ?? []
  if (!adds.length && !removes.length) throw new ToolError('Provide effects to add/update or remove types to delete.')
  for (const e of adds) {
    const desc = effectDescriptor(e.type)
    if (!desc) throw new ToolError(`Unknown effect '${e.type}'. See the apply_effect description for available types.`)
    if (e.type.startsWith('color.')) throw new ToolError(`'${e.type}' is a color grade — use apply_color, not apply_effect.`)
    const allowed = new Set(desc.params.map((p) => p.key))
    const unknown = Object.keys(e.params ?? {}).filter((k) => !allowed.has(k)).sort()
    if (unknown.length) throw new ToolError(`${e.type}: unknown param(s) '${unknown.join("', '")}'. Allowed: ${[...allowed].sort().join(', ')}.`)
  }
  requireGradable(env, input.clipIds, 'apply_effect')
  const t = activeTimeline(env.session.doc)
  const setsBlur = adds.some((e) => e.type === 'blur.gaussian' && e.params?.radius !== undefined)
  const clearedBlur = setsBlur ? input.clipIds.filter((id) => findClip(t, id)?.clip.effects?.some((e) => e.type === 'blur.gaussian' && e.params.radius?.track)) : []
  const before = snapshot(env.session.doc)
  const label = input.clipIds.length === 1 ? 'Apply Effect (Agent)' : `Apply Effect ×${input.clipIds.length} (Agent)`
  mutate(env, label, (d) => {
    const dt = activeTimeline(d)
    for (const id of new Set(input.clipIds)) applyEffectEntries(findClip(dt, id)!.clip, adds, removes)
  })
  return mutationResult(env.session.doc, before, { touched: input.clipIds, notes: clearedBlur.length ? [`Static blur cleared existing blur keyframes on: ${clearedBlur.join(', ')}.`] : [] })
}

// ---------- inspect_color ----------

interface Measured {
  frame: Buffer
  scopes: Scopes
}

async function measureFrame(png: Buffer, crop?: { x: number; y: number; width: number; height: number }): Promise<Measured | null> {
  const size = imageSize(png)
  if (!size) return null
  const grid = await decodeRgba(png, { size: { width: SCOPE_GRID, height: SCOPE_GRID }, crop }).catch(() => null)
  if (!grid) return null
  const frame = await transcodeImage(png, 'jpeg', 0.8, crop).catch(() => null)
  return frame ? { frame, scopes: measureScopes(grid) } : null
}

/** The clip's graded look: the composited frame at the sample point, cropped to the clip's on-canvas box. */
async function gradedClip(env: ToolEnv, clipId: string, atFrame: number | undefined): Promise<Measured> {
  const t = activeTimeline(env.session.doc)
  const c: Clip | undefined = findClip(t, clipId)?.clip
  if (!c) throw new ToolError(`Clip not found: ${clipId}`)
  if (c.mediaType !== 'video' && c.mediaType !== 'image') throw new ToolError(`Clip ${clipId} is a ${c.mediaType} clip; inspect_color needs a video or image clip.`)
  if (!env.session.doc.manifest.entries.some((e) => e.id === c.mediaRef)) throw new ToolError(`Clip source not found: ${c.mediaRef}`)
  if (!env.session.resolveMedia(c.mediaRef)) throw new ToolError(`Could not resolve a source URL for clip ${clipId}.`)
  const offset = atFrame !== undefined ? Math.max(0, Math.min(c.durationFrames - 1, atFrame - c.startFrame)) : Math.trunc(c.durationFrames / 2)
  const frame = c.startFrame + offset
  const png = await env.app.render.captureFrame(env.session, { timelineId: t.id, frame, format: 'png' }).catch(() => null)
  const size = png ? imageSize(png) : null
  if (!png || !size) throw new ToolError(`Could not decode a frame for clip ${clipId}.`)
  const tr = transformAt(c, frame)
  const x0 = Math.max(0, (tr.centerX - tr.width / 2) * size.width)
  const y0 = Math.max(0, (tr.centerY - tr.height / 2) * size.height)
  const x1 = Math.min(size.width, (tr.centerX + tr.width / 2) * size.width)
  const y1 = Math.min(size.height, (tr.centerY + tr.height / 2) * size.height)
  const crop = x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined
  const measured = await measureFrame(png, crop)
  if (!measured) throw new ToolError('Could not measure the clip frame.')
  return measured
}

/** A raw asset frame (no grade): the image itself, or a video's midpoint. */
async function rawAsset(env: ToolEnv, ref: string, label: string): Promise<Measured> {
  const entry = env.session.doc.manifest.entries.find((e) => e.id === ref)
  if (!entry) throw new ToolError(`${label} not found: ${ref}`)
  if (entry.type !== 'video' && entry.type !== 'image') throw new ToolError(`${label} ${ref} is a ${entry.type} asset; inspect_color needs a video or image asset.`)
  const file = env.session.resolveMedia(entry)
  if (!file) throw new ToolError(`Could not resolve a URL for ${ref}.`)
  const png = await env.app.media.extractFrame(file, entry.type === 'video' ? entry.duration / 2 : 0, { format: 'png' }).catch(() => null)
  const measured = png ? await measureFrame(png) : null
  if (!measured) throw new ToolError(`Could not measure ${ref}.`)
  return measured
}

export async function inspectColor(env: ToolEnv, args: Obj): Promise<ToolResult> {
  const input = decodeArgs<{ clipId?: string; mediaRef?: string; atFrame?: number; reference?: string }>(args, 'inspect_color', {
    clipId: opt('String'),
    mediaRef: opt('String'),
    atFrame: opt('Int'),
    reference: opt('String'),
  })
  let subject: Measured
  let key: string
  if (input.clipId !== undefined) {
    subject = await gradedClip(env, input.clipId, input.atFrame)
    key = 'clip'
  } else if (input.mediaRef !== undefined) {
    subject = await rawAsset(env, input.mediaRef, 'Media')
    key = 'media'
  } else throw new ToolError('Provide either clipId (measures the graded clip) or mediaRef (measures the raw asset).')
  const blocks: Block[] = [image(subject.frame, 'image/jpeg')]
  const payload: Obj = { [key]: readout(subject.scopes) }
  if (key === 'clip') payload.note = "Measured from the composited timeline frame, cropped to the clip's on-canvas box."
  if (input.reference !== undefined) {
    const ref = await rawAsset(env, input.reference, 'Reference')
    blocks.push(image(ref.frame, 'image/jpeg'))
    payload.reference = readout(ref.scopes)
    payload.gap = gap(subject.scopes, ref.scopes)
  }
  const text = okRawJson(payload).content[0]
  return { content: [...blocks, text] }
}
