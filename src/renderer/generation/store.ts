/** Generate panel state (spec 06 §B7) and its actions; the pure rules live in panelLogic.ts. */
import { useMemo } from 'react'
import { create } from 'zustand'
import { hasKeyFrom } from '@core/generation/catalog'
import type { PendingContext } from '@core/generation/edit'
import { modelSet, type AnyModel, type AudioModel, type ImageModel, type ModelSet, type UpscaleModel, type VideoModel } from '@core/generation/models'
import type { VideoInputMode } from '@core/generation/requests'
import { validateAudioReferences, validateImage, validateVideoInputs, type RefAsset } from '@core/generation/validation'
import type { ClipType, GenerationInput, MediaManifestEntry } from '@core/model'
import { editor, setEditor } from '../state/editor'
import { getDoc, whenMediaPresent } from '../state/project'
import { updateSettings, useSettings } from '../state/settings'
import { setMediaView } from '../media/model'
import { markPendingReplacement } from './pendingReplacements'
import { revealKey } from '../media/interactions'
import { toast } from '../ui/toast'
import {
  addReference,
  afterSubmit,
  buildRequest,
  canSubmit,
  clearedReferences,
  initialPanelState,
  normalizeModel,
  resetAudioState,
  resetSettings,
  seedState,
  selectedModel,
  usesSourceVideoInput,
  type GenType,
  type PanelState,
  type Seed,
} from './panelLogic'
import { t } from '../i18n'

interface GenerationStore extends PanelState {
  open: boolean
  error: string | null
  submitting: boolean
  pendingSeed: Seed | null
  /** AI Edit / AI Transition context of the current seed (§B9.4); cleared on submit and close. */
  pending: PendingContext | null
}

export const useGeneration = create<GenerationStore>(() => ({ ...initialPanelState(), open: false, error: null, submitting: false, pendingSeed: null, pending: null }))
const gen = () => useGeneration.getState()
const patch = (p: Partial<GenerationStore>) => useGeneration.setState(p)

/** The catalog through the user's keys (masked keys still mark presence) and Settings ▸ Models. */
export function useModelSet(): ModelSet {
  const apiKeys = useSettings((s) => s.settings?.apiKeys)
  const disabled = useSettings((s) => s.settings?.disabledModelIds)
  const keyMask = JSON.stringify(Object.entries(apiKeys ?? {}).map(([k, v]) => [k, !!v]))
  const disabledMask = JSON.stringify(disabled ?? [])
  return useMemo(() => modelSet(hasKeyFrom(apiKeys), disabled ?? []), [keyMask, disabledMask])
}

export const currentModelSet = (): ModelSet => {
  const s = useSettings.getState().settings
  return modelSet(hasKeyFrom(s?.apiKeys), s?.disabledModelIds ?? [])
}

const lookup = (id: string): MediaManifestEntry | undefined => getDoc()?.manifest.entries.find((e) => e.id === id)

let errorTimer: number | null = null
/** Flashes a panel error for 3 s (§B7.5). */
export function flashError(message: string): void {
  if (errorTimer !== null) window.clearTimeout(errorTimer)
  patch({ error: message })
  errorTimer = window.setTimeout(() => {
    errorTimer = null
    patch({ error: null })
  }, 3000)
}

export function openGenerationPanel(): void {
  setMediaView({ section: 'media' })
  patch({ open: true })
}

/** Closing clears every pending seed state and the edit folder (§B7.1). */
export function closeGenerationPanel(): void {
  patch({ open: false, pendingSeed: null, editFolderId: null, pending: null })
}

/** `clearPendingGenerationPanelState(preservingReplacement)`. */
function clearedPending(preservingReplacement: boolean): PendingContext | null {
  const p = gen().pending
  if (!preservingReplacement || !p?.replacementClipId) return null
  return { replacementClipId: p.replacementClipId, replacementTimelineId: p.replacementTimelineId }
}

export function toggleGenerationPanel(): void {
  if (gen().open) closeGenerationPanel()
  else openGenerationPanel()
}

export function patchPanel(p: Partial<PanelState>): void {
  patch(p)
}

/** Type change (§B7.4): normalize, reset settings, clear references (audio → reset audio state). */
export function setGenType(set: ModelSet, type: GenType): void {
  const s = gen()
  if (s.type === type) return
  const modelId = normalizeModel(set, s, type)
  const base: PanelState = { ...s, type, modelIds: { ...s.modelIds, [type]: modelId }, ...clearedReferences(), editFolderId: null }
  const m = selectedModel(set, base)
  let next: Partial<PanelState> = { ...base, ...resetSettings(base, m) }
  if (type === 'audio') next = { ...next, ...resetAudioState({ ...base, ...next } as PanelState, m as AudioModel | null) }
  patch({ ...next, pending: clearedPending(true) })
}

export function setGenModel(set: ModelSet, id: string): void {
  const s = gen()
  const m = set.find(id)
  if (!m) return
  const base: PanelState = { ...s, modelIds: { ...s.modelIds, [s.type]: id } }
  if (m.kind === 'video') {
    const vm = set.findVideo(id)!
    patch({ ...base, ...resetSettings(base, m), imageRefs: [], videoRefs: [], audioRefs: [], frames: [null, null], sourceVideo: vm.requiresSourceVideo ? s.sourceVideo : null })
  } else if (m.kind === 'image') patch({ ...base, ...resetSettings(base, m) })
  else if (m.kind === 'audio') patch({ ...base, imageRefs: [], audioRefs: [], ...resetAudioState(base, m as AudioModel) })
  else {
    const src = s.upscaleSource ? lookup(s.upscaleSource) : undefined
    patch({ ...base, upscaleSettings: (m as UpscaleModel).normalizedSettings((m as UpscaleModel).defaultSettings, src ?? null) })
  }
}

/** Keeps the selected model valid when keys or disabled models change (§B7.3). */
export function normalizeSelection(set: ModelSet): void {
  const s = gen()
  const id = normalizeModel(set, s)
  if (id !== s.modelIds[s.type]) {
    const base: PanelState = { ...s, modelIds: { ...s.modelIds, [s.type]: id } }
    const m = selectedModel(set, base)
    patch({ ...base, ...resetSettings(base, m), ...(m?.kind === 'audio' ? resetAudioState(base, m as AudioModel) : null) })
  }
}

export function canSubmitNow(set: ModelSet): boolean {
  const s = gen()
  return !s.submitting && canSubmit(selectedModel(set, s), s, lookup)
}

export async function submitGeneration(set: ModelSet): Promise<void> {
  const s = gen()
  const m = selectedModel(set, s)
  if (!m || s.submitting || !canSubmit(m, s, lookup)) return
  const req = buildRequest(m, s, lookup, editor().mediaFolderId)
  const pending = s.pending
  if (pending) req.pending = pending
  patch({ submitting: true })
  try {
    const out = await window.palmier.generation.submit(req)
    if (!out.ok) return flashError(out.error)
    patch({ ...afterSubmit(), pendingSeed: null, pending: null })
    // §B7.8 step 6: select the new placeholder in the media panel (not for a replacement).
    const first = out.placeholderIds[0]
    // The placeholder reaches the renderer with the next doc push, which may land after the IPC reply.
    const replacing = pending?.replacementClipId
    if (replacing && out.placeholderIds.length) {
      // Mac markPendingReplacement: the clip shows the generating overlay until its replacement lands or fails.
      void whenMediaPresent(out.placeholderIds).then((ok) => ok && markPendingReplacement(getDoc(), pending.replacementTimelineId, replacing, out.placeholderIds))
    }
    if (first && !replacing) {
      void whenMediaPresent([first]).then((ok) => {
        if (!ok) return
        setEditor({ mediaSelection: [`asset:${first}`], focusedPanel: 'mediaPanel' })
        revealKey(`asset:${first}`)
      })
    }
  } catch (e) {
    flashError(e instanceof Error ? e.message : String(e))
  } finally {
    patch({ submitting: false })
  }
}

/** Opens the panel pre-filled from a seed (Rerun and every AI Edit action; §B7.9 / §B9.2 / §B9.4). */
export function seedGenerationPanel(asset: MediaManifestEntry, stored: GenerationInput, pending: PendingContext | null = null): void {
  const set = currentModelSet()
  const exists = (id: string) => !!lookup(id)
  const next = seedState(set, gen(), { asset, stored }, exists)
  if (!next) return void toast(t('Model no longer available'), 'error')
  if (next.type === 'upscale' && next.upscaleSource) {
    const um = set.findUpscale(next.modelIds.upscale ?? '')
    const src = lookup(next.upscaleSource)
    if (um) next.upscaleSettings = um.normalizedSettings(next.upscaleSettings, src ?? null)
  }
  patch({ ...next, pendingSeed: null, pending })
  openGenerationPanel()
}

export function setPromptExtra(px: number): void {
  void updateSettings({ generationPromptExtra: Math.max(0, Math.round(px)) })
}

// ---------- References (§B7.5) ----------

const extOf = (e: MediaManifestEntry): string => {
  const p = 'external' in e.source ? e.source.external.absolutePath : e.source.project.relativePath
  const dot = p.lastIndexOf('.')
  return dot >= 0 ? p.slice(dot + 1).toLowerCase() : ''
}
const refAsset = (id: string): RefAsset | null => {
  const e = lookup(id)
  return e ? { id: e.id, name: e.name, type: e.type, duration: e.duration, ext: extOf(e) } : null
}
const refAssets = (ids: (string | null)[]): RefAsset[] => ids.flatMap((id) => (id ? [refAsset(id)].filter((x): x is RefAsset => !!x) : []))

/** §B1.3 rules over a candidate panel state; the message to flash, or null. */
function validateCandidate(m: AnyModel, s: PanelState): string | null {
  if (m.kind === 'video') {
    const vm = m as VideoModel
    const source = usesSourceVideoInput(vm, s)
    return validateVideoInputs(vm, {
      sourceVideo: source && s.sourceVideo ? refAsset(s.sourceVideo) : null,
      frames: source ? [] : refAssets(s.frames),
      imageRefs: refAssets(s.imageRefs),
      videoRefs: source ? [] : refAssets(s.videoRefs),
      audioRefs: refAssets(s.audioRefs),
    })
  }
  if (m.kind === 'audio') return validateAudioReferences(m as AudioModel, refAssets(s.imageRefs), refAssets(s.audioRefs))
  if (m.kind === 'image') {
    const im = m as ImageModel
    return validateImage(im, '', null, null, s.imageRefs.length, 1)
  }
  return null
}

/** Adds dropped library assets to the reference pools; flashes the first problem (duplicates, wrong type, caps). */
export function dropReferences(set: ModelSet, ids: string[]): void {
  const s = gen()
  const m = selectedModel(set, s)
  if (!m) return
  let next: PanelState = { ...s }
  for (const id of ids) {
    const asset = lookup(id)
    if (!asset) continue
    const out = addReference(m, next, asset)
    if (typeof out === 'string') return flashError(out)
    next = { ...next, ...out }
  }
  const err = validateCandidate(m, next)
  if (err) return flashError(err)
  patch({ imageRefs: next.imageRefs, videoRefs: next.videoRefs, audioRefs: next.audioRefs })
}

export function removeReference(id: string): void {
  const s = gen()
  patch({ imageRefs: s.imageRefs.filter((x) => x !== id), videoRefs: s.videoRefs.filter((x) => x !== id), audioRefs: s.audioRefs.filter((x) => x !== id) })
}

export type SlotKey = 'frame0' | 'frame1' | 'sourceVideo' | 'refImage' | 'refAudio' | 'audioSource' | 'upscaleSource'

/** Single-slot drop (§B7.5): wrong types flash `Drop <types> here.`; the result is validated like a pool drop. */
export function dropOnSlot(set: ModelSet, slot: SlotKey, id: string, accepts: ClipType[]): void {
  const s = gen()
  const m = selectedModel(set, s)
  const asset = lookup(id)
  if (!m || !asset) return
  if (!accepts.includes(asset.type)) return flashError(accepts.length === 2 ? t('Drop {0} or {1} here.', t(accepts[0]), t(accepts[1])) : t('Drop {0} here.', accepts.map((a) => t(a)).join(', ')))
  let p: Partial<PanelState>
  switch (slot) {
    case 'frame0':
      p = { frames: [id, s.frames[1]] }
      break
    case 'frame1':
      p = { frames: [s.frames[0], id] }
      break
    case 'sourceVideo':
      p = { sourceVideo: id }
      break
    case 'refImage':
      p = { imageRefs: [id] }
      break
    case 'refAudio':
      p = { audioRefs: [id] }
      break
    case 'audioSource':
      p = { audioSource: id }
      break
    case 'upscaleSource': {
      const um = m as UpscaleModel
      if (m.kind === 'upscale' && !um.supportedTypes.includes(asset.type)) return flashError(t('{0} does not support this media type.', m.displayName))
      p = { upscaleSource: id, upscaleSettings: m.kind === 'upscale' ? um.normalizedSettings(s.upscaleSettings, asset) : s.upscaleSettings }
      break
    }
  }
  const next = { ...s, ...p }
  if (slot !== 'upscaleSource' && slot !== 'audioSource') {
    const err = validateCandidate(m, next)
    if (err) return flashError(err)
  }
  patch(p)
}

export function clearSlot(slot: SlotKey): void {
  const s = gen()
  const p: Partial<PanelState> =
    slot === 'frame0'
      ? { frames: [null, s.frames[1]] }
      : slot === 'frame1'
        ? { frames: [s.frames[0], null] }
        : slot === 'sourceVideo'
          ? { sourceVideo: null }
          : slot === 'refImage'
            ? { imageRefs: [] }
            : slot === 'refAudio'
              ? { audioRefs: [] }
              : slot === 'audioSource'
                ? { audioSource: null }
                : { upscaleSource: null }
  patch(p)
}

/** Video input mode (§B7.5): choosing a mode clears the other modes' inputs. */
export function setVideoMode(mode: VideoInputMode): void {
  const s = gen()
  if (s.videoMode === mode) return
  if (mode === 'frames') patch({ videoMode: mode, imageRefs: [], videoRefs: [], audioRefs: [], sourceVideo: null })
  else if (mode === 'references') patch({ videoMode: mode, frames: [null, null], sourceVideo: null })
  else patch({ videoMode: mode, frames: [null, null], imageRefs: [], videoRefs: [], audioRefs: [] })
}
