/**
 * Session audio-analysis state for the editor (spec 07 §3): speech/quiet masks (Mac `SpeechMaskStore`), beat
 * analyses (`BeatStore`), denoise bake states, and the mark flags + session-only silence settings.
 * Masks load lazily the first time a clip draws (analysis runs in main, cached per file).
 */
import { create } from 'zustand'
import { beatResultMessage, type BeatAnalysis } from '@core/audio/beats'
import { DeadAirResolver, DEFAULT_SILENCE_SETTINGS, deadAirCount, type QuietMaskData, type SilenceSettings } from '@core/audio/deadAir'
import type { Doc } from '@core/ops/context'
import type { DenoiseStateView, SyncMode } from '../../shared/audio'
import { onAssetSourceChange } from '../state/mediaPaths'
import { editor } from '../state/editor'
import { beep, dismissToast, toast } from '../ui/toast'
import { t, plural } from '../i18n'

interface AudioState {
  markDeadAir: boolean
  markBeats: boolean
  markSpeakers: boolean
  silence: SilenceSettings
  quiet: Record<string, QuietMaskData>
  beats: Record<string, BeatAnalysis>
  denoise: Record<string, DenoiseStateView>
  speechInFlight: number
  beatsInFlight: Record<string, true>
  /** Session speaker masks per asset: `[startCell, endCell, globalId]` runs. */
  speakerMasks: Record<string, { count: number; runs: [number, number, number][] }>
  speakerPhase: string | null
  speakerError: string | null
}

export const useAudio = create<AudioState>(() => ({
  markDeadAir: true,
  markBeats: true,
  markSpeakers: true,
  silence: DEFAULT_SILENCE_SETTINGS,
  quiet: {},
  beats: {},
  denoise: {},
  speechInFlight: 0,
  beatsInFlight: {},
  speakerMasks: {},
  speakerPhase: null,
  speakerError: null,
}))

export const audioState = () => useAudio.getState()
const set = (p: Partial<AudioState> | ((s: AudioState) => Partial<AudioState>)) => useAudio.setState(p)

const requested = new Set<string>()
const failed = new Set<string>()
const hydrated = new Set<string>()
const denoiseAsked = new Set<string>()
let epoch = 0
let listening = false

function listen(): void {
  if (listening || typeof window === 'undefined' || !window.palmier?.audio) return
  listening = true
  window.palmier.audio.onDenoiseState(({ assetId, state }) => set((s) => ({ denoise: { ...s.denoise, [assetId]: state } })))
  window.palmier.audio.onAnalysis(({ kind, assetId }) => {
    if (kind === 'speech' && !audioState().quiet[assetId]) {
      requested.delete(assetId)
      requestSpeech(assetId)
    }
  })
  onAssetSourceChange((ids) => {
    for (const id of ids) {
      requested.delete(id)
      failed.delete(id)
      hydrated.delete(id)
    }
    set((s) => {
      const quiet = { ...s.quiet }
      const beats = { ...s.beats }
      for (const id of ids) {
        delete quiet[id]
        delete beats[id]
      }
      return { quiet, beats }
    })
  })
}

/** Starts (once) speech detection for an asset; the mask lands in the store when ready. */
export function requestSpeech(assetId: string): void {
  listen()
  if (requested.has(assetId) || failed.has(assetId)) return
  requested.add(assetId)
  const my = epoch
  set((s) => ({ speechInFlight: s.speechInFlight + 1 }))
  void window.palmier.audio
    .speech(assetId)
    .then((r) => {
      if (my !== epoch) return
      if (r.ok) set((s) => ({ quiet: { ...s.quiet, [assetId]: r.quiet } }))
      else if (!r.offline) failed.add(assetId)
      else requested.delete(assetId)
    })
    .finally(() => {
      if (my === epoch) set((s) => ({ speechInFlight: Math.max(0, s.speechInFlight - 1) }))
    })
}

/** Cache-only beat hydration (`BeatStore.hydrate`): detection never runs automatically. */
export function hydrateBeats(assetId: string): void {
  listen()
  if (hydrated.has(assetId)) return
  hydrated.add(assetId)
  void window.palmier.audio.cachedBeats(assetId).then((a) => {
    if (a) set((s) => ({ beats: { ...s.beats, [assetId]: a } }))
  })
}

/** Quiet mask for drawing (null until analysed); also kicks analysis for audio-bearing assets. */
export function quietMaskFor(assetId: string): QuietMaskData | null {
  const q = audioState().quiet[assetId]
  if (!q) requestSpeech(assetId)
  return q ?? null
}

export function beatsFor(assetId: string): BeatAnalysis | null {
  const b = audioState().beats[assetId]
  if (!b) hydrateBeats(assetId)
  return b ?? null
}

/** New project: drop session masks (stale completions are ignored by the epoch). */
export function resetAudioSession(): void {
  epoch++
  requested.clear()
  failed.clear()
  hydrated.clear()
  denoiseAsked.clear()
  autoSpeakers = false
  set({ quiet: {}, beats: {}, denoise: {}, speechInFlight: 0, beatsInFlight: {}, silence: DEFAULT_SILENCE_SETTINGS, speakerMasks: {}, speakerPhase: null, speakerError: null })
}

let resolverCache: { doc: Doc; quiet: Record<string, QuietMaskData>; silence: SilenceSettings; r: DeadAirResolver } | null = null

/** Memoized resolver for the current doc + masks + settings. */
export function deadAirResolver(doc: Doc): DeadAirResolver {
  const { quiet, silence } = audioState()
  if (resolverCache && resolverCache.doc === doc && resolverCache.quiet === quiet && resolverCache.silence === silence) return resolverCache.r
  const r = new DeadAirResolver(quiet, silence, doc.file.multicamGroups ?? [])
  resolverCache = { doc, quiet, silence, r }
  return r
}

export function deadAirSections(doc: Doc | null): number {
  if (!doc) return 0
  try {
    return deadAirCount(doc, audioState().quiet, audioState().silence)
  } catch {
    return 0
  }
}

export function setSilenceSettings(patch: Partial<SilenceSettings>): void {
  const next = { ...audioState().silence, ...patch }
  set({ silence: next })
  window.palmier.audio.setSilenceSettings(next)
}

export function setMarks(patch: Partial<Pick<AudioState, 'markDeadAir' | 'markBeats' | 'markSpeakers'>>): void {
  set(patch)
}

// ---------- Actions ----------

export async function removeDeadAir(target?: { clipId: string; frame: number }): Promise<void> {
  const r = await window.palmier.audio.removeDeadAir(target ?? {})
  if (!r.ok) {
    beep()
    return
  }
}

export async function detectBeats(assetId: string, force: boolean): Promise<void> {
  if (audioState().beatsInFlight[assetId]) return
  set((s) => ({ beatsInFlight: { ...s.beatsInFlight, [assetId]: true }, markBeats: true }))
  const progress = toast(t('Detecting beats…'), 'progress')
  try {
    const r = await window.palmier.audio.beats(assetId, force)
    dismissToast(progress)
    if (!r.ok) {
      toast(r.error, 'warning')
      return
    }
    set((s) => ({ beats: { ...s.beats, [assetId]: r.analysis } }))
    const m = beatResultMessage(r.analysis)
    toast(m.text, m.kind)
  } finally {
    set((s) => {
      const f = { ...s.beatsInFlight }
      delete f[assetId]
      return { beatsInFlight: f }
    })
  }
}

export async function synchronize(mode: SyncMode): Promise<void> {
  const ids = editor().selectedClipIds
  const progress = toast(t('Synchronizing…'), 'progress')
  const r = await window.palmier.audio.synchronize({ clipIds: ids, mode })
  dismissToast(progress)
  if (!r.ok) {
    toast(r.error, 'warning')
    if (r.beep) beep()
    return
  }
  const rep = r.report
  if (!rep.synced.length) {
    toast(rep.failures[0]?.message ?? t('No clips aligned.'), 'warning')
    return
  }
  const n = rep.synced.length
  const failures = rep.failures.length ? ` ${t('{0} failed: {1}', rep.failures.length, rep.failures[0].message)}` : ''
  toast(`${plural(n, 'Synchronized 1 clip', 'Synchronized {0} clips')}.${failures}`, rep.failures.length ? 'warning' : 'success')
}

export function denoiseStateOf(assetId: string): DenoiseStateView {
  listen()
  const s = audioState().denoise[assetId]
  if (s === undefined && !denoiseAsked.has(assetId)) {
    denoiseAsked.add(assetId)
    void window.palmier.audio.denoiseState(assetId).then((v) => set((st) => ({ denoise: { ...st.denoise, [assetId]: st.denoise[assetId] ?? v } })))
  }
  return s ?? 'idle'
}

export function scheduleDenoise(assetId?: string): void {
  listen()
  window.palmier.audio.scheduleDenoise(assetId)
}

// ---------- Speakers ----------

let autoSpeakers = false

/** Identify (button) or the cache-only auto run at project open (`markSpeakers`). */
export async function identifySpeakers(cacheOnly: boolean): Promise<void> {
  listen()
  if (audioState().speakerPhase) return
  set({ speakerPhase: cacheOnly ? null : t('Identifying…'), speakerError: null })
  const off = cacheOnly ? () => undefined : window.palmier.audio.onSpeakerPhase((phase) => set({ speakerPhase: phase }))
  try {
    const r = await window.palmier.audio.identifySpeakers({ cacheOnly })
    if (!r.ok) {
      if (!cacheOnly) set({ speakerError: r.error })
      return
    }
    set((st) => ({ speakerMasks: { ...st.speakerMasks, ...r.masks }, speakerError: r.error ?? null }))
  } finally {
    off()
    set({ speakerPhase: null })
  }
}

/** Kicks the cache-only auto run once per session (called while drawing). */
export function autoIdentifySpeakers(): void {
  if (autoSpeakers || !audioState().markSpeakers || typeof window === 'undefined' || !window.palmier?.audio) return
  autoSpeakers = true
  void identifySpeakers(true)
}

export async function updateSpeaker(req: { id: number; name?: string; color?: number[]; remove?: boolean }): Promise<void> {
  const r = await window.palmier.audio.updateSpeaker(req)
  if (!r.ok) {
    toast(r.error ?? t('Could not update the speaker.'), 'error')
    return
  }
  if (req.remove) {
    set((st) => {
      const masks: AudioState['speakerMasks'] = {}
      for (const [ref, m] of Object.entries(st.speakerMasks)) masks[ref] = { count: m.count, runs: m.runs.filter((x) => x[2] !== req.id) }
      return { speakerMasks: masks }
    })
  }
}
