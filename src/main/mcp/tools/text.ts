/** add_texts and update_text: style patch parsing, box measurement and placement. */
import { defaultTextStyle, defaultTransform, TEXT_ANIMATION_PRESETS, type RGBA, type TextAnimation, type TextFillMode, type TextStyle, type Timeline, type Transform } from '../../../core/model'
import {
  applyStylePatch,
  DEFAULT_FOOTAGE_MATTE,
  placeTextClips,
  stylePatchAffectsLayout,
  stylePatchHasAny,
  textCenterX,
  updateTextClip,
  type ColorPatch,
  type TextClipSpec,
  type TextStylePatch,
} from '../../../core/ops/agent'
import { activeTimeline } from '../../../core/ops/context'
import type { TextBox } from '../../../core/ops/project'
import { findClip, insertTrack } from '../../../core/timeline'
import { ToolError, isObj, lenient, parseColor, validateUnknownKeys, type Obj } from './args'
import { mutate, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { swiftDouble } from './json'

/** Natural normalized text boxes, measured by the renderer's layout code. */
export function measureBoxes(env: ToolEnv, t: Timeline, reqs: { content: string; style: TextStyle }[]): Promise<TextBox[]> {
  if (!reqs.length) return Promise.resolve([])
  return env.app.render.measureText(reqs.map((r) => ({ content: r.content, style: r.style, canvasWidth: t.width, canvasHeight: t.height })))
}

// ---------- Patch parsing ----------

function optionalNumber(o: Obj, key: string, path: string, range?: [number, number]): number | undefined {
  if (!(key in o)) return undefined
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`${path}.${key}: expected finite number`)
  if (range && !(v >= range[0] && v <= range[1])) throw new ToolError(`${path}.${key}: must be between ${swiftDouble(range[0])} and ${swiftDouble(range[1])}`)
  return v
}

function optionalBool(o: Obj, key: string, path: string): boolean | undefined {
  if (!(key in o)) return undefined
  if (typeof o[key] !== 'boolean') throw new ToolError(`${path}.${key}: expected boolean`)
  return o[key] as boolean
}

function optionalObject(o: Obj, key: string, path: string): Obj | undefined {
  if (!(key in o)) return undefined
  if (!isObj(o[key])) throw new ToolError(`${path}.${key}: expected object`)
  return o[key] as Obj
}

function optionalColor(o: Obj, key: string, path: string): ColorPatch | undefined {
  if (!(key in o)) return undefined
  const raw = o[key]
  if (typeof raw !== 'string') throw new ToolError(`${path}.${key}: expected string`)
  const value = parseColor(raw, `${path}.${key}`)
  return { value, includesOpacity: raw.trim().replace(/^#+/, '').length === 8 }
}

function optionalPair(o: Obj, key: string, path: string, range: [number, number]): { x?: number; y?: number } | undefined {
  const pair = optionalObject(o, key, path)
  if (!pair) return undefined
  const p = `${path}.${key}`
  validateUnknownKeys(pair, ['x', 'y'], p)
  return { x: optionalNumber(pair, 'x', p, range), y: optionalNumber(pair, 'y', p, range) }
}

const STYLE_KEYS = ['fontName', 'fontSize', 'widthScale', 'heightScale', 'bold', 'italic', 'underline', 'strikethrough', 'overline', 'tracking', 'lineSpacing', 'fontCase', 'color', 'alignment', 'outline', 'shadow', 'background', 'blur']

function parseStyleObject(o: Obj, path: string): TextStylePatch {
  validateUnknownKeys(o, STYLE_KEYS, path)
  let outline: TextStylePatch['outline']
  const ro = optionalObject(o, 'outline', path)
  if (ro) {
    const p = `${path}.outline`
    validateUnknownKeys(ro, ['enabled', 'color', 'width'], p)
    outline = { enabled: optionalBool(ro, 'enabled', p), color: optionalColor(ro, 'color', p)?.value, width: optionalNumber(ro, 'width', p, [0, 40]) }
  }
  let shadow: TextStylePatch['shadow']
  const rs = optionalObject(o, 'shadow', path)
  if (rs) {
    const p = `${path}.shadow`
    validateUnknownKeys(rs, ['enabled', 'color', 'opacity', 'offset', 'blur'], p)
    const offset = optionalPair(rs, 'offset', p, [-200, 200])
    shadow = {
      enabled: optionalBool(rs, 'enabled', p),
      color: optionalColor(rs, 'color', p),
      opacity: optionalNumber(rs, 'opacity', p, [0, 1]),
      offsetX: offset?.x,
      offsetY: offset?.y,
      blur: optionalNumber(rs, 'blur', p, [0, 100]),
    }
  }
  let background: TextStylePatch['background']
  const rb = optionalObject(o, 'background', path)
  if (rb) {
    const p = `${path}.background`
    validateUnknownKeys(rb, ['enabled', 'color', 'opacity', 'padding', 'center', 'cornerRadius', 'outline'], p)
    const padding = optionalPair(rb, 'padding', p, [0, 300])
    const center = optionalPair(rb, 'center', p, [-500, 500])
    const bo = optionalObject(rb, 'outline', p)
    if (bo) validateUnknownKeys(bo, ['color', 'width'], `${p}.outline`)
    background = {
      enabled: optionalBool(rb, 'enabled', p),
      color: optionalColor(rb, 'color', p),
      opacity: optionalNumber(rb, 'opacity', p, [0, 1]),
      paddingX: padding?.x,
      paddingY: padding?.y,
      offsetX: center?.x,
      offsetY: center?.y,
      cornerRadius: optionalNumber(rb, 'cornerRadius', p, [0, 300]),
      outlineColor: bo ? optionalColor(bo, 'color', `${p}.outline`)?.value : undefined,
      outlineWidth: bo ? optionalNumber(bo, 'width', `${p}.outline`, [0, 40]) : undefined,
    }
  }
  let fontName: string | undefined
  if ('fontName' in o) {
    if (typeof o.fontName !== 'string' || !o.fontName.trim()) throw new ToolError(`${path}.fontName: expected non-empty string`)
    fontName = o.fontName
  }
  let fontCase: TextStyle['fontCase'] | undefined
  if ('fontCase' in o) {
    if (o.fontCase !== 'mixed' && o.fontCase !== 'uppercase' && o.fontCase !== 'lowercase') throw new ToolError(`${path}.fontCase: expected mixed, uppercase, or lowercase`)
    fontCase = o.fontCase
  }
  let alignment: TextStyle['alignment'] | undefined
  if ('alignment' in o) {
    if (typeof o.alignment !== 'string') throw new ToolError(`${path}.alignment: expected string`)
    if (o.alignment !== 'left' && o.alignment !== 'center' && o.alignment !== 'right') {
      throw new ToolError(`${path}.alignment: invalid alignment '${o.alignment}'. Expected 'left', 'center', or 'right'.`)
    }
    alignment = o.alignment
  }
  return {
    fontName,
    fontSize: optionalNumber(o, 'fontSize', path, [12, 300]),
    widthScale: optionalNumber(o, 'widthScale', path, [0.1, 10]),
    heightScale: optionalNumber(o, 'heightScale', path, [0.1, 10]),
    isBold: optionalBool(o, 'bold', path),
    isItalic: optionalBool(o, 'italic', path),
    isUnderlined: optionalBool(o, 'underline', path),
    isStruckThrough: optionalBool(o, 'strikethrough', path),
    isOverlined: optionalBool(o, 'overline', path),
    tracking: optionalNumber(o, 'tracking', path, [-20, 100]),
    lineSpacing: optionalNumber(o, 'lineSpacing', path, [-100, 300]),
    fontCase,
    color: optionalColor(o, 'color', path)?.value,
    alignment,
    outline,
    shadow,
    background,
    blur: optionalNumber(o, 'blur', path, [0, 100]),
  }
}

export function parseStylePatch(o: Obj, path: string): TextStylePatch | undefined {
  if (!('style' in o)) return undefined
  if (!isObj(o.style)) throw new ToolError(`${path}.style: expected object`)
  return parseStyleObject(o.style, `${path}.style`)
}

export interface TextTransformInput {
  x?: number
  y?: number
  rotation?: number
  rotationX?: number
  rotationY?: number
}

export function parseTextTransform(raw: unknown, path: string): TextTransformInput | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) throw new ToolError(`${path}: expected object`)
  validateUnknownKeys(raw, ['x', 'y', 'rotation', 'rotationX', 'rotationY'], path)
  const t: TextTransformInput = {
    x: optionalNumber(raw, 'x', path),
    y: optionalNumber(raw, 'y', path),
    rotation: optionalNumber(raw, 'rotation', path),
    rotationX: optionalNumber(raw, 'rotationX', path, [-89, 89]),
    rotationY: optionalNumber(raw, 'rotationY', path, [-89, 89]),
  }
  return Object.values(t).some((v) => v !== undefined) ? t : undefined
}

const AGENT_PRESETS = TEXT_ANIMATION_PRESETS.filter((p) => p !== 'none')

/** null for `off` (or absent); otherwise the preset with an optional highlight. */
export function parseTextAnimation(raw: string | undefined, highlight: string | undefined, path: string): { preset: TextAnimation['preset']; highlight?: RGBA } | null {
  if (raw === undefined || raw === 'off') return null
  if (!(AGENT_PRESETS as string[]).includes(raw)) throw new ToolError(`${path}: animation must be one of ${['off', ...AGENT_PRESETS].join(', ')}`)
  return { preset: raw as TextAnimation['preset'], highlight: highlight !== undefined ? parseColor(highlight, path) : undefined }
}

export function parseFillMode(raw: string | undefined, path: string): TextFillMode | undefined {
  if (raw === undefined) return undefined
  if (raw !== 'color' && raw !== 'footage' && raw !== 'inverted') throw new ToolError(`${path}.fillMode: expected color, footage, inverted`)
  return raw
}

// ---------- add_texts ----------

const ADD_KEYS = ['trackIndex', 'startFrame', 'endFrame', 'content', 'style', 'transform', 'animation', 'highlightColor', 'fillMode']

export async function addTexts(env: ToolEnv, args: Obj): Promise<ToolResult> {
  const raw = args.entries
  if (!Array.isArray(raw) || !raw.length) throw new ToolError("Missing or empty 'entries' array")
  const doc = env.session.doc
  const t = activeTimeline(doc)
  const partials = raw.map((entry, i) => {
    const path = `entries[${i}]`
    if (!isObj(entry)) throw new ToolError(`${path} must be an object`)
    validateUnknownKeys(entry, ADD_KEYS, path)
    const trackIndex = lenient.int(entry, 'trackIndex')
    const startFrame = lenient.requireInt(entry, 'startFrame')
    const endFrame = lenient.requireInt(entry, 'endFrame')
    const content = lenient.requireString(entry, 'content')
    let trackId: string | undefined
    if (trackIndex !== undefined) {
      const track = t.tracks[trackIndex]
      if (!track) throw new ToolError(`${path}: track index ${trackIndex} out of range (0..${t.tracks.length - 1})`)
      if (track.type === 'audio') throw new ToolError(`${path}: track ${trackIndex} is an audio track; text requires a video/image/text track`)
      trackId = track.id
    }
    if (startFrame < 0) throw new ToolError(`${path}: startFrame must be >= 0 (got ${startFrame})`)
    if (endFrame <= startFrame) throw new ToolError(`${path}: endFrame (${endFrame}) must be greater than startFrame (${startFrame})`)
    const patch = parseStylePatch(entry, path)
    const fillMode = parseFillMode(lenient.string(entry, 'fillMode'), path)
    let style = patch ? applyStylePatch(defaultTextStyle(), patch) : defaultTextStyle()
    if (fillMode === 'footage' && !patch?.color) style = { ...style, color: { ...DEFAULT_FOOTAGE_MATTE } }
    const transform = parseTextTransform(entry.transform, `${path}.transform`)
    const anim = parseTextAnimation(lenient.string(entry, 'animation'), lenient.string(entry, 'highlightColor'), path)
    const animation: TextAnimation | undefined = anim ? { preset: anim.preset, perWordFrames: 6, ...(anim.highlight ? { highlight: anim.highlight } : {}) } : undefined
    return { trackId, startFrame, duration: endFrame - startFrame, content, style, transform, animation, fillMode }
  })
  const omitted = partials.filter((p) => !p.trackId).length
  if (omitted !== 0 && omitted !== partials.length) {
    throw new ToolError(`Mixed trackIndex: ${omitted} of ${partials.length} entries omitted trackIndex. Either set it on every entry or omit it on every entry (to auto-create a shared new track).`)
  }
  const boxes = await measureBoxes(env, t, partials)
  const before = snapshot(doc)
  mutate(env, partials.length === 1 ? 'Add Text (Agent)' : 'Add Texts (Agent)', (d) => {
    const dt = activeTimeline(d)
    const created = omitted ? dt.tracks[insertTrack(dt, 0, 'video')].id : undefined
    const specs: TextClipSpec[] = partials.flatMap((p, i) => {
      const trackIndex = dt.tracks.findIndex((x) => x.id === (created ?? p.trackId))
      if (trackIndex < 0) return []
      const box = boxes[i]
      const transform: Transform | undefined = p.transform
        ? {
            ...defaultTransform(),
            centerX: p.transform.x !== undefined ? textCenterX(p.transform.x, box.width, p.style.alignment) : 0.5,
            centerY: p.transform.y ?? 0.5,
            width: box.width,
            height: box.height,
            rotation: p.transform.rotation ?? 0,
            rotationX: p.transform.rotationX ?? 0,
            rotationY: p.transform.rotationY ?? 0,
          }
        : undefined
      return [{ trackIndex, startFrame: p.startFrame, durationFrames: p.duration, content: p.content, style: p.style, box, transform, animation: p.animation, fillMode: p.fillMode }]
    })
    if (!placeTextClips(d, specs).length) throw new ToolError('Failed to place any text clips')
  })
  return mutationResult(env.session.doc, before)
}

// ---------- update_text ----------

const UPDATE_KEYS = ['clipIds', 'captionGroupId', 'content', 'style', 'transform', 'animation', 'highlightColor', 'fillMode']

export async function updateText(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, UPDATE_KEYS, 'update_text')
  const hasContent = 'content' in args
  if (hasContent && typeof args.content !== 'string') throw new ToolError('update_text.content: expected String')
  const content = hasContent ? (args.content as string) : undefined
  const doc = env.session.doc
  const t = activeTimeline(doc)
  const clipIds = lenient.stringArray(args, 'clipIds')
  const gid = lenient.string(args, 'captionGroupId')
  if (gid) {
    const members = t.tracks.flatMap((tr) => tr.clips).filter((c) => c.captionGroupId === gid && c.mediaType === 'text').map((c) => c.id)
    if (!members.length) throw new ToolError(`No caption clips found for captionGroupId: ${gid}`)
    for (const id of members) if (!clipIds.includes(id)) clipIds.push(id)
  }
  if (!clipIds.length) throw new ToolError("Provide a non-empty 'clipIds' array or a 'captionGroupId'")
  const patch = parseStylePatch(args, 'update_text')
  const transform = parseTextTransform(args.transform, 'update_text.transform')
  const animationRaw = lenient.string(args, 'animation')
  const animation = parseTextAnimation(animationRaw, lenient.string(args, 'highlightColor'), 'update_text')
  const highlightRaw = animationRaw === undefined ? lenient.string(args, 'highlightColor') : undefined
  const highlightOnly = highlightRaw !== undefined ? parseColor(highlightRaw, 'update_text') : undefined
  const fillMode = parseFillMode(lenient.string(args, 'fillMode'), 'update_text')
  if (!hasContent && !(patch && stylePatchHasAny(patch)) && !transform && animationRaw === undefined && !highlightOnly && !fillMode) {
    throw new ToolError('update_text needs at least one text property to apply')
  }
  const clips = clipIds.map((id) => {
    const c = findClip(t, id)?.clip
    if (!c) throw new ToolError(`Clip not found: ${id}`)
    if (c.mediaType !== 'text') throw new ToolError(`update_text only applies to text clips: ${id} is ${c.mediaType}`)
    return c
  })
  const notes: string[] = []
  if (hasContent) {
    const n = clips.filter((c) => c.wordTimings && c.textContent !== content).length
    if (n) notes.push(`Content change cleared word timings on ${n} clip${n === 1 ? '' : 's'} — karaoke highlighting falls back to plain text there.`)
  }
  if (transform?.rotation !== undefined) {
    const ids = clips.filter((c) => c.rotationTrack).map((c) => c.id)
    if (ids.length) notes.push(`Static rotation cleared existing rotation keyframes on: ${ids.join(', ')}.`)
  }
  if (patch?.blur !== undefined) {
    const ids = clips.filter((c) => c.effects?.some((e) => e.type === 'blur.gaussian' && e.params.radius?.track)).map((c) => c.id)
    if (ids.length) notes.push(`Static blur cleared existing blur keyframes on: ${ids.join(', ')}.`)
  }
  const refit = hasContent || (!!patch && stylePatchAffectsLayout(patch))
  const boxes = refit
    ? await measureBoxes(
        env,
        t,
        clips.map((c) => {
          const base = c.textStyle ?? defaultTextStyle()
          return { content: (hasContent ? content : c.textContent) ?? ' ', style: patch && stylePatchHasAny(patch) ? applyStylePatch(base, patch) : base }
        }),
      )
    : []
  const beforeClips = clips.map((c) => JSON.stringify(c))
  const before = snapshot(doc)
  mutate(env, clipIds.length === 1 ? 'Update Text (Agent)' : 'Update Texts (Agent)', (d) => {
    const dt = activeTimeline(d)
    clipIds.forEach((id, i) => {
      const c = findClip(dt, id)?.clip
      if (!c) return
      updateTextClip(c, {
        content,
        style: patch,
        box: refit ? boxes[i] : undefined,
        ...transform,
        animation: animationRaw === undefined ? undefined : animation,
        highlightOnly,
        fillMode,
      })
    })
  })
  const after = activeTimeline(env.session.doc)
  const changed = clipIds.some((id, i) => JSON.stringify(findClip(after, id)?.clip) !== beforeClips[i])
  return mutationResult(env.session.doc, before, { touched: clipIds, extra: { changed }, notes })
}
