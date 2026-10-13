/**
 * Chroma key sampler (spec 07 §6.6, `EditorViewModel+ChromaKey.swift`, `ChromaKeySamplerOverlayView.swift`):
 * inspector eyedropper toggle → paused timeline preview with a crosshair overlay; a click samples the last presented
 * frame and commits `key.chroma` with undo "Sample Key Color". Esc, a preview-tab switch, a selection change or
 * toggling again cancels and reverts the live-disabled key.
 */
import { create } from 'zustand'
import { isVisualType, type Clip } from '@core/model'
import { useEditor } from '../state/editor'
import { clearPreview, commitOp, previewWith } from '../state/ops'
import { pause, previewEngine } from '../state/playback'
import { usePreviewTabs } from '../state/previewTabs'
import { getTimeline, useProject } from '../state/project'
import { Icon } from '../ui/Icon'
import { beep } from '../ui/toast'
import { keyHueFromPixels, patchRect } from './chroma'
import { t } from '../i18n'

const KEY = 'key.chroma'

export const useChromaSampler = create<{ clipId: string | null }>(() => ({ clipId: null }))
export const samplingClipId = (): string | null => useChromaSampler.getState().clipId

function clipFor(id: string): Clip | undefined {
  return getTimeline()?.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
}

/** Live (no undo) "disable the existing key" so the sample sees the un-keyed colour; re-applied as the doc changes. */
function applyLiveDisable(clipId: string): void {
  previewWith((d) => {
    for (const t of d.file.timelines) for (const tr of t.tracks) for (const c of tr.clips) if (c.id === clipId) for (const fx of c.effects ?? []) if (fx.type === KEY) fx.enabled = false
  })
}

let unsubs: (() => void)[] = []

function stopWatching(): void {
  for (const u of unsubs) u()
  unsubs = []
}

function watch(clipId: string): void {
  stopWatching()
  unsubs = [
    usePreviewTabs.subscribe((s, p) => {
      if (s.active !== p.active) cancelChromaKeySampling()
    }),
    useEditor.subscribe((s, p) => {
      if (s.selectedClipIds !== p.selectedClipIds) cancelChromaKeySampling()
    }),
    useProject.subscribe((s, p) => {
      if (s.snapshot === p.snapshot || samplingClipId() !== clipId) return
      if (!clipFor(clipId)) return cancelChromaKeySampling()
      applyLiveDisable(clipId)
    }),
  ]
}

/** `cancelChromaKeySampling` → `revertClipProperty`: drop the live edit. */
export function cancelChromaKeySampling(): boolean {
  if (!samplingClipId()) return false
  useChromaSampler.setState({ clipId: null })
  stopWatching()
  clearPreview()
  return true
}

/** `toggleChromaKeySampling(clipId:)`. */
export function toggleChromaKeySampling(clipId: string): void {
  if (samplingClipId() === clipId) {
    cancelChromaKeySampling()
    return
  }
  cancelChromaKeySampling()
  const clip = clipFor(clipId)
  if (usePreviewTabs.getState().active !== 'timeline' || !clip || !isVisualType(clip.mediaType)) return
  pause()
  if (clip.effects?.some((e) => e.type === KEY)) applyLiveDisable(clipId)
  useChromaSampler.setState({ clipId })
  watch(clipId)
}

/** `commitChromaKeySample(hue:clipId:)`: enabled key with keyHue = hue, tolerance 0.15, softness 0.1, canonical order. */
export async function commitChromaKeySample(hue: number, clipId: string): Promise<void> {
  if (samplingClipId() !== clipId || !Number.isFinite(hue)) return
  useChromaSampler.setState({ clipId: null })
  stopWatching()
  await commitOp('editEffects', { ids: [clipId], edits: [{ type: KEY, enabled: true, params: { keyHue: hue, tolerance: 0.15, softness: 0.1 } }], label: 'Sample Key Color' }, { quiet: true })
}

/** Hue under a normalized point of the last presented frame, or null (beep) when unavailable or too grey. */
export function sampleKeyHue(nx: number, ny: number): number | null {
  const pixels = previewEngine()?.readPresentedRegion?.((w, h) => patchRect(nx, ny, w, h)) ?? null
  return pixels ? keyHueFromPixels(pixels) : null
}

/** Full-size transparent layer over the canvas while sampling; crosshair cursor. */
export function ChromaSamplerOverlay() {
  const clipId = useChromaSampler((s) => s.clipId)
  if (!clipId) return null
  return (
    <div
      className="pp-chroma-sampler"
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair', zIndex: 5 }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        const nx = (e.clientX - r.left) / r.width
        const ny = (e.clientY - r.top) / r.height
        const id = samplingClipId()
        if (!id || !(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return beep()
        const hue = sampleKeyHue(nx, ny)
        if (hue === null) return beep()
        void commitChromaKeySample(hue, id)
      }}
    />
  )
}

/** Inspector ▸ Adjust ▸ Effects ▸ Chroma Key header button (exactly one clip selected). */
export function ChromaEyedropper({ clipId }: { clipId: string }) {
  const sampling = useChromaSampler((s) => s.clipId === clipId)
  const onTimeline = usePreviewTabs((s) => s.active === 'timeline')
  return (
    <button
      type="button"
      className={`pp-iconbtn hh ${sampling ? 'tone-accent' : 'tone-secondary'}`}
      style={{ width: 20, height: 20 }}
      disabled={!onTimeline}
      data-tip={sampling ? t('Cancel key color sampling') : t('Sample key color')}
      aria-label={sampling ? t('Cancel Key Color Sampling') : t('Sample Key Color')}
      onClick={(e) => {
        e.stopPropagation()
        toggleChromaKeySampling(clipId)
      }}
    >
      <Icon sf="eyedropper" size={11} />
    </button>
  )
}

/** Whether a canvas-background click should beep instead of deselecting (sampling mode). */
export const chromaSamplingActive = (): boolean => !!samplingClipId()
