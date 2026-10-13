/**
 * AI Edit entry points (spec 06 §B9.3): media asset menu, timeline clip menu ▸ AI Edit, the clip-aware `begin*`
 * actions (`EditorViewModel+AIEdit.swift`), FLUX Enhance and Create AI Transition (§B10).
 */
import { sourceFramesConsumed } from '@core/clip'
import {
  actionGroup,
  AUDIO_TRANSFORMS,
  audioTransformSeed,
  createVideoSeed,
  editSeed,
  lipSyncSeed,
  menuActions,
  menuAudioTransforms,
  reframeSeed,
  transitionAvailability,
  transitionSeed,
  upscaleModelFor,
  upscaleSeed,
  VIDEO_TO_AUDIO,
  videoAudioSeed,
  type AudioPlacement,
  type AudioTransformKind,
  type EditAction,
  type PendingContext,
  type TransitionGap,
  type TransitionPlacement,
  type VideoToAudioKind,
} from '@core/generation/edit'
import type { ModelSet } from '@core/generation/models'
import type { Clip, GenerationInput, MediaManifestEntry, Timeline } from '@core/model'
import { findClip } from '@core/timeline'
import { getDoc, getTimeline, useProject } from '../state/project'
import type { MenuItem } from '../ui/Menu'
import { toast } from '../ui/toast'
import { currentModelSet, seedGenerationPanel } from './store'
import { t, tk, tx } from '../i18n'

const lookup = (id: string): MediaManifestEntry | undefined => getDoc()?.manifest.entries.find((e) => e.id === id)

// ---------- Clip context ----------

export interface ClipContext {
  clip: Clip
  asset: MediaManifestEntry
  timeline: Timeline
}

export function clipContext(clipId: string): ClipContext | null {
  const t = getTimeline()
  const clip = t ? findClip(t, clipId)?.clip : undefined
  const asset = clip ? lookup(clip.mediaRef) : undefined
  return t && clip && asset ? { clip, asset, timeline: t } : null
}

/** `aiEditTrimmedSource`: seconds of a trimmed video/audio clip's visible range, else null. */
export function trimmedSeconds(c: ClipContext): number | null {
  if (c.asset.type !== 'video' && c.asset.type !== 'audio') return null
  if (!(c.clip.trimStartFrame > 0 || c.clip.trimEndFrame > 0)) return null
  return sourceFramesConsumed(c.clip) / Math.max(1, c.timeline.fps)
}

const trimRef = (c: ClipContext, use: boolean) => (use && trimmedSeconds(c) !== null ? { timelineId: c.timeline.id, clipId: c.clip.id } : null)

/** `aiAudioPlacement`: at the clip start; span = trimmed seconds ?? asset duration ?? clip length; at least one frame. */
export function audioPlacement(c: ClipContext, useTrim: boolean, actionName: string): AudioPlacement {
  const fps = Math.max(1, c.timeline.fps)
  const trimmed = useTrim ? trimmedSeconds(c) : null
  const span = trimmed ?? (c.asset.duration > 0 ? c.asset.duration : c.clip.durationFrames / fps)
  return { timelineId: c.timeline.id, startFrame: c.clip.startFrame, spanSeconds: Math.max(span, 1 / fps), actionName }
}

const replacement = (c: ClipContext): PendingContext => ({ replacementClipId: c.clip.id, replacementTimelineId: c.timeline.id })

// ---------- Seeding actions ----------

/** Options of the inspector / clip flows (`AIEditTab` toggles; the timeline menu always replaces and uses the trim). */
export interface FlowOptions {
  replace: boolean
  useTrim: boolean
  place: boolean
}
const CLIP_MENU: FlowOptions = { replace: true, useTrim: true, place: true }

function seed(asset: MediaManifestEntry, stored: GenerationInput | null, pending: PendingContext | null = null): void {
  if (!stored) return
  cancelPendingTransition()
  seedGenerationPanel(asset, stored, pending)
}

/** Runs one AI Edit action for an asset, or for a clip when `clip` is given (`begin*`, `AIEditTab.present`). */
export function runAction(action: EditAction, asset: MediaManifestEntry, clip: ClipContext | null = null, o: FlowOptions = CLIP_MENU, set: ModelSet = currentModelSet()): void {
  const trimSecs = clip && o.useTrim ? trimmedSeconds(clip) : null
  const withReplace = (extra: PendingContext = {}): PendingContext | null => {
    const p: PendingContext = { ...(clip && o.replace ? replacement(clip) : {}), ...extra }
    return Object.keys(p).length ? p : null
  }
  const trim = clip ? trimRef(clip, o.useTrim) : null
  switch (action) {
    case 'enhanceDraft':
      return void enhanceDraft(asset)
    case 'upscale': {
      const m = upscaleModelFor(set, asset, !!clip)
      if (m) seed(asset, upscaleSeed(asset, m, trimSecs), withReplace({ trim }))
      return
    }
    case 'edit':
      return seed(asset, editSeed(set, asset), withReplace({ trim }))
    case 'reframe':
      return seed(asset, reframeSeed(set, asset, trimSecs), withReplace({ trim }))
    case 'lipSync':
      return seed(asset, lipSyncSeed(set, asset), withReplace({ trim }))
    case 'rerun':
      if (asset.generationInput) seed(asset, asset.generationInput, withReplace())
      return
    case 'createVideo':
      return createVideo(asset, false, clip, o)
    case 'generateMusic':
    case 'generateSFX':
      return videoAudio(asset, action === 'generateMusic' ? 'music' : 'sfx', clip, o, set)
  }
}

export function createVideo(asset: MediaManifestEntry, asReference: boolean, clip: ClipContext | null = null, o: FlowOptions = CLIP_MENU, set: ModelSet = currentModelSet()): void {
  seed(asset, createVideoSeed(set, asset, asReference), clip && o.replace ? replacement(clip) : null)
}

/** Generate Music / SFX: new audio, never a replacement; clip flows place it at the clip (`beginAIVideoAudio`). */
export function videoAudio(asset: MediaManifestEntry, kind: VideoToAudioKind, clip: ClipContext | null = null, o: FlowOptions = CLIP_MENU, set: ModelSet = currentModelSet()): void {
  const stored = videoAudioSeed(set, asset, kind)
  if (!stored) return
  const pending: PendingContext | null = clip
    ? { trim: trimRef(clip, o.useTrim), audioPlacement: o.place ? audioPlacement(clip, o.useTrim, VIDEO_TO_AUDIO[kind].timelineAction) : null }
    : null
  seed(asset, stored, pending)
}

/** Clean Up Voice / Dub (`beginAIAudioTransform`); without a clip context it seeds with no placement. */
export function audioTransform(asset: MediaManifestEntry, kind: AudioTransformKind, clip: ClipContext | null = null, o: FlowOptions = CLIP_MENU, set: ModelSet = currentModelSet()): void {
  if (!clip) return seed(asset, audioTransformSeed(set, asset, kind))
  const placement = o.place ? audioPlacement(clip, o.useTrim, AUDIO_TRANSFORMS[kind].timelineAction) : null
  const trimSecs = o.useTrim ? trimmedSeconds(clip) : null
  seed(asset, audioTransformSeed(set, asset, kind, placement?.spanSeconds ?? trimSecs), { trim: trimRef(clip, o.useTrim), audioPlacement: placement })
}

/** FLUX Enhance (§B9.6): direct submission. */
export async function enhanceDraft(asset: MediaManifestEntry): Promise<void> {
  const out = await window.palmier.generation.enhance(asset.id)
  if (!out.ok) toast(out.error, 'error')
}

// ---------- Menus ----------

const ENHANCE_LABELS: Record<EditAction, string> = {
  upscale: tk('Upscale…'),
  edit: tk('Edit…'),
  rerun: tk('Rerun'),
  lipSync: tk('Lip Sync…'),
  reframe: tk('Reframe…'),
  createVideo: tk('Create Video'),
  enhanceDraft: tk('FLUX Enhance'),
  generateMusic: VIDEO_TO_AUDIO.music.menuTitle,
  generateSFX: VIDEO_TO_AUDIO.sfx.menuTitle,
}

function actionItem(action: EditAction, asset: MediaManifestEntry, clip: ClipContext | null): MenuItem {
  if (action === 'createVideo') {
    return {
      label: t('Create Video'),
      submenu: [
        { label: t('Set as first frame'), onSelect: () => createVideo(asset, false, clip) },
        { label: t('Set as reference'), onSelect: () => createVideo(asset, true, clip) },
      ],
    }
  }
  return { label: t(ENHANCE_LABELS[action]), onSelect: () => runAction(action, asset, clip) }
}

/** The AI Edit submenu items (`AIEditMenu` / `aiEditSubmenu`); empty when nothing is available. */
export function aiEditItems(asset: MediaManifestEntry, clip: ClipContext | null, set: ModelSet = currentModelSet()): MenuItem[] {
  const trim = clip ? trimmedSeconds(clip) : null
  const actions = menuActions(set, asset, trim, !!clip)
  const transforms = menuAudioTransforms(set, asset, trim)
  const enhance = actions.filter((a) => actionGroup(a, asset.type) === 'enhance')
  const audio = actions.filter((a) => actionGroup(a, asset.type) === 'audio')
  const items: MenuItem[] = []
  if (enhance.length) {
    items.push({ kind: 'header', label: t('AI Enhance') })
    // Asset menu order (`AIEditMenu`): FLUX Enhance last; the clip menu follows candidate order.
    const ordered = clip ? enhance : [...enhance.filter((a) => a !== 'enhanceDraft'), ...enhance.filter((a) => a === 'enhanceDraft')]
    for (const a of ordered) items.push(actionItem(a, asset, clip))
  }
  if (audio.length || transforms.length) {
    if (items.length) items.push({ kind: 'divider' })
    items.push({ kind: 'header', label: t('AI Audio') })
    if (audio.includes('rerun')) items.push(actionItem('rerun', asset, clip))
    for (const k of transforms) items.push({ label: t(AUDIO_TRANSFORMS[k].menuTitle), onSelect: () => audioTransform(asset, k, clip) })
    for (const a of audio) if (a !== 'rerun') items.push(actionItem(a, asset, clip))
  }
  return items
}

/** Timeline clip menu ▸ AI Edit (§6.14); null when the clip has no available action. */
export function clipAIEditMenuItem(clipId: string): MenuItem | null {
  const c = clipContext(clipId)
  if (!c || c.clip.mediaType === 'text' || c.clip.mediaType === 'subtitle') return null
  const items = aiEditItems(c.asset, c)
  return items.length ? { label: t('AI Edit'), submenu: items } : null
}

// ---------- Create AI Transition (§B10) ----------

let transitionToken = 0

/** Resolves true once every id is in the renderer's document (false after `timeoutMs`). */
function whenInDoc(ids: string[], timeoutMs = 5000): Promise<boolean> {
  const ready = () => ids.every((id) => !!lookup(id))
  if (ready()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsub()
      resolve(false)
    }, timeoutMs)
    const unsub = useProject.subscribe(() => {
      if (!ready()) return
      window.clearTimeout(timer)
      unsub()
      resolve(true)
    })
  })
}

/** `cancelPendingTransitionSeed`: a newer seed or transition wins. */
export function cancelPendingTransition(): void {
  transitionToken++
}

/** Empty-area menu item for a gap on a video track; null when the gap doesn't qualify. */
export function transitionMenuItem(tl: Timeline, gap: TransitionGap, set: ModelSet = currentModelSet()): MenuItem | null {
  const a = transitionAvailability(set, tl.tracks[gap.trackIndex]?.type, gap, tl.fps)
  if (!a) return null
  return { label: t('Create AI Transition'), disabled: !a.model, tip: a.refusal ? tx(a.refusal) : undefined, onSelect: () => void beginAITransition(tl, gap) }
}

/** `beginAITransition`: capture the frames around the gap, then open the panel on the first+last-frame model. */
export async function beginAITransition(t: Timeline, gap: TransitionGap, set: ModelSet = currentModelSet()): Promise<void> {
  const a = transitionAvailability(set, t.tracks[gap.trackIndex]?.type, gap, t.fps)
  if (!a?.model) return
  const placement: TransitionPlacement = { timelineId: t.id, trackIndex: gap.trackIndex, gapStartFrame: gap.start, gapLengthFrames: gap.end - gap.start }
  const token = ++transitionToken
  const out = await window.palmier.generation.captureTransitionFrames(placement)
  if (token !== transitionToken) return
  if (!out.ok) return void toast(out.error, 'error')
  if ('stale' in out) return
  // The captured assets reach the renderer with the next document snapshot.
  if (!(await whenInDoc([out.firstId, out.lastId])) || token !== transitionToken) return
  const first = lookup(out.firstId)!
  const stored = transitionSeed(a.model, out.firstId, out.lastId, placement.gapLengthFrames / Math.max(1, t.fps))
  seedGenerationPanel(first, stored, { transitionPlacement: placement })
}
