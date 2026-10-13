/** apply_layout: place new clips into, or re-frame existing clips onto, a named multi-video layout. */
import { adoptClipResolution, applyLayout as applyLayoutOp, type LayoutSlotRequest } from '../../../core/ops/agent'
import { activeTimeline, type PlaceableAsset } from '../../../core/ops/context'
import { isVideoLayout, layoutSlots, VIDEO_LAYOUTS, type LayoutFit } from '../../../core/ops/layout'
import { findClip } from '../../../core/timeline'
import { ToolError, decodeArgs, isObj, opt, validateUnknownKeys, type Obj } from './args'
import { clipSource } from './clips'
import { mutate, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { swiftDouble } from './json'

const ANCHORS: Record<string, [number, number]> = {
  center: [0.5, 0.5],
  top: [0.5, 0],
  bottom: [0.5, 1],
  left: [0, 0.5],
  right: [1, 0.5],
  top_left: [0, 0],
  top_right: [1, 0],
  bottom_left: [0, 1],
  bottom_right: [1, 1],
}

interface SlotEntry {
  slot: string
  mediaRef?: string
  clipIds?: string[]
  anchor?: string
  anchorX?: number
  anchorY?: number
}

const SLOT_FIELDS = { slot: 'String', mediaRef: opt('String'), clipIds: opt({ arr: 'String' }), anchor: opt('String'), anchorX: opt('Double'), anchorY: opt('Double') } as const

function resolveAnchor(e: SlotEntry, path: string): [number, number] {
  let anchor = ANCHORS.center
  if (e.anchor !== undefined) {
    if (!ANCHORS[e.anchor]) throw new ToolError(`${path}: invalid anchor '${e.anchor}'. Valid: ${Object.keys(ANCHORS).sort().join(', ')}, or anchorX/anchorY for in-between values.`)
    anchor = ANCHORS[e.anchor]
  }
  for (const [axis, v] of [
    ['anchorX', e.anchorX],
    ['anchorY', e.anchorY],
  ] as const) {
    if (v !== undefined && !(v >= 0 && v <= 1)) throw new ToolError(`${path}: ${axis} must be between 0 and 1 (got ${swiftDouble(v)})`)
  }
  return [e.anchorX ?? anchor[0], e.anchorY ?? anchor[1]]
}

export function applyLayout(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<{ layout: string; slots: SlotEntry[]; startFrame?: number; endFrame?: number; fit?: string }>(args, 'apply_layout', {
    layout: 'String',
    slots: { arr: { obj: SLOT_FIELDS } },
    startFrame: opt('Int'),
    endFrame: opt('Int'),
    fit: opt('String'),
  })
  if (Array.isArray(args.slots)) args.slots.forEach((s, i) => isObj(s) && validateUnknownKeys(s, Object.keys(SLOT_FIELDS), `slots[${i}]`))
  if (!isVideoLayout(input.layout)) throw new ToolError(`unknown layout '${input.layout}'. Valid: ${VIDEO_LAYOUTS.join(', ')}`)
  const fit = input.fit ?? 'fill'
  if (fit !== 'fill' && fit !== 'fit') throw new ToolError(`invalid fit '${input.fit ?? ''}'. Valid: fill, fit`)
  if (!input.slots.length) throw new ToolError("apply_layout needs a non-empty 'slots' array")
  const layout = input.layout
  const slotDefs = layoutSlots(layout)
  const seen = new Set<string>()
  const seenClips = new Set<string>()
  let usesMedia = false
  let usesClips = false
  const entries = input.slots.map((e, i) => {
    const def = slotDefs.find((s) => s.id === e.slot)
    if (!def) throw new ToolError(`slots[${i}]: '${e.slot}' is not a slot of layout '${layout}'. Slots: ${slotDefs.map((s) => s.id).join(', ')}`)
    if (seen.has(e.slot)) throw new ToolError(`slots[${i}]: duplicate slot '${e.slot}'`)
    seen.add(e.slot)
    if ((e.mediaRef !== undefined) === (e.clipIds !== undefined)) throw new ToolError(`slots[${i}]: provide exactly one of 'mediaRef' or 'clipIds'`)
    if (e.clipIds) {
      if (!e.clipIds.length) throw new ToolError(`slots[${i}]: 'clipIds' must not be empty`)
      for (const c of e.clipIds) {
        if (seenClips.has(c)) throw new ToolError(`slots[${i}]: clip '${c}' is assigned to more than one slot; each clip can fill only one.`)
        seenClips.add(c)
      }
    }
    usesMedia ||= e.mediaRef !== undefined
    usesClips ||= e.clipIds !== undefined
    return { def, e, anchor: resolveAnchor(e, `slots[${i}]`) }
  })
  const missing = slotDefs.map((s) => s.id).filter((id) => !seen.has(id)).sort()
  if (missing.length) throw new ToolError(`layout '${layout}' needs every slot filled. Missing: ${missing.join(', ')}`)
  if (usesMedia && usesClips) {
    throw new ToolError("apply_layout: don't mix 'mediaRef' and 'clipIds' — either place new clips (all mediaRef) or re-layout existing clips (all clipIds).")
  }
  const doc = env.session.doc
  const t = activeTimeline(doc)
  const startFrame = input.startFrame ?? 0
  const duration = input.endFrame !== undefined ? input.endFrame - startFrame : 0
  const assets = new Map<string, PlaceableAsset>()
  if (usesMedia) {
    if (startFrame < 0) throw new ToolError(`startFrame must be >= 0 (got ${startFrame})`)
    if (duration < 1) throw new ToolError('apply_layout placing new clips requires endFrame > startFrame.')
    for (const { def, e } of entries) {
      const a = clipSource(doc, e.mediaRef!, `slot '${def.id}'`)
      if (a.type !== 'video' && a.type !== 'image' && a.type !== 'sequence') throw new ToolError(`slot '${def.id}': ${e.mediaRef} is ${a.type}; layout slots take video, image, or nested timeline.`)
      assets.set(def.id, a)
    }
  } else {
    const byTrack = new Map<string, { slot: string; start: number; end: number }[]>()
    const bySlot = new Map<string, [number, number][]>()
    for (const { def, e } of entries) {
      for (const cid of e.clipIds!) {
        const loc = findClip(t, cid)
        if (!loc) throw new ToolError(`slot '${def.id}': clip not found: ${cid}`)
        const c = loc.clip
        if (c.mediaType !== 'video' && c.mediaType !== 'image' && c.mediaType !== 'sequence') {
          throw new ToolError(`slot '${def.id}': clip ${cid} is ${c.mediaType}; layout applies to video, image, and nested timeline clips.`)
        }
        const start = c.startFrame
        const end = c.startFrame + c.durationFrames
        for (const other of byTrack.get(loc.track.id) ?? []) {
          if (other.slot !== def.id && start < other.end && other.start < end) {
            throw new ToolError(
              `clips in slots '${other.slot}' and '${def.id}' are on the same track and their times overlap; only the first would render. Move them to separate tracks (or place new clips with mediaRef) so every region shows.`,
            )
          }
        }
        byTrack.set(loc.track.id, [...(byTrack.get(loc.track.id) ?? []), { slot: def.id, start, end }])
        bySlot.set(def.id, [...(bySlot.get(def.id) ?? []), [start, end]])
      }
    }
    if (entries.length > 1) {
      const candidates = [...bySlot.values()].flatMap((ivs) => ivs.map(([s]) => s))
      const coincides = candidates.some((f) => [...bySlot.values()].every((ivs) => ivs.some(([s, e]) => s <= f && f < e)))
      if (!coincides) {
        throw new ToolError(
          'the selected clips never play at the same time, so no single frame shows every region. Overlap their timeline ranges (or place new clips with mediaRef) before laying them out.',
        )
      }
    }
  }
  const requests: LayoutSlotRequest[] = entries.map(({ def, e, anchor }) => ({
    slotId: def.id,
    rect: def.rect,
    z: def.z,
    anchorX: anchor[0],
    anchorY: anchor[1],
    clipIds: e.clipIds,
    asset: assets.get(def.id),
  }))
  const before = snapshot(doc)
  const { note, slots } = mutate(env, 'Apply Layout (Agent)', (d) => {
    const note = usesMedia
      ? adoptClipResolution(
          d,
          slotDefs.flatMap((s) => (assets.get(s.id) && assets.get(s.id)!.type !== 'sequence' ? [assets.get(s.id)!] : [])),
        )
      : null
    const slots = applyLayoutOp(d, requests, fit as LayoutFit, startFrame, duration)
    if (!Object.keys(slots).length) throw new ToolError('apply_layout changed no clips.')
    return { note, slots }
  })
  const notes = note ? [note] : []
  if (!usesMedia) notes.push("Stacking follows current track order (index 0 on top); fix with manage_tracks reorder if an inset isn't on top.")
  return mutationResult(env.session.doc, before, { touched: Object.values(slots).flat(), extra: { layout, slots }, notes })
}
