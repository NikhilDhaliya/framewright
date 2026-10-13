/** Renderer ↔ main contract for audio analysis, sync, multicam and denoise (spec 07 §3, §5). */
import type { BeatAnalysis } from '../core/audio/beats'
import type { SyncMode, SyncReport } from '../core/audio/clipSync'
import type { QuietMaskData, SilenceSettings } from '../core/audio/deadAir'
import type { Unsubscribe } from './api'

export type { BeatAnalysis, QuietMaskData, SilenceSettings, SyncMode, SyncReport }

export type SpeechOutcome = { ok: true; quiet: QuietMaskData; chunkCount: number } | { ok: false; error: string; offline?: boolean }
export type BeatsOutcome = { ok: true; analysis: BeatAnalysis } | { ok: false; error: string }
export type EditOutcome<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string; beep?: boolean }
export type DenoiseStateView = 'idle' | 'baking' | 'baked' | 'failed'
/** Speaker masks are `[startCell, endCell, globalId]` runs over 32 ms cells. */
export type SpeakersOutcome = { ok: true; masks: Record<string, { count: number; runs: [number, number, number][] }>; assignments: Record<string, Record<string, number>>; error?: string } | { ok: false; error: string }

export interface AudioApi {
  /** VAD + quiet mask for an asset (cached per file; runs on the analysis lane). */
  speech(assetId: string): Promise<SpeechOutcome>
  /** Session-only Minimum Pause / Speech Padding (also the agent's defaults). */
  setSilenceSettings(s: SilenceSettings): void
  /** Ripple-deletes dead air: everywhere (`clipId` omitted) or the span of `clipId` under `frame`. One undo step. */
  removeDeadAir(req: { clipId?: string; frame?: number }): Promise<EditOutcome<{ sections: number }>>
  beats(assetId: string, force: boolean): Promise<BeatsOutcome>
  cachedBeats(assetId: string): Promise<BeatAnalysis | null>
  /** Synchronize ▸ Auto/Audio/Timecode on the selection. */
  synchronize(req: { clipIds: string[]; mode: SyncMode }): Promise<EditOutcome<{ report: SyncReport }>>
  denoiseState(assetId: string): Promise<DenoiseStateView>
  /** Baked fully-wet 48 kHz WAV for an asset (null = not baked; play the original). Mix amount·wet + (1−amount)·dry. */
  enhancedAudioPath(assetId: string): Promise<string | null>
  /** (Re)schedules bakes for every enabled denoise in the project; clears a failure for `assetId`. */
  scheduleDenoise(assetId?: string): void
  onDenoiseState(cb: (e: { assetId: string; state: DenoiseStateView }) => void): Unsubscribe
  onAnalysis(cb: (e: { kind: 'speech' | 'beats'; assetId: string }) => void): Unsubscribe
  /** Identify / Refresh (or the cache-only auto run at project open). New registry entries land in ProjectFile.speakers. */
  identifySpeakers(req: { cacheOnly: boolean }): Promise<SpeakersOutcome>
  onSpeakerPhase(cb: (phase: string) => void): Unsubscribe
  /** Rename / recolour (RGBA 0–1) / remove a registry speaker (persisted, no undo). */
  updateSpeaker(req: { id: number; name?: string; color?: number[]; remove?: boolean }): Promise<{ ok: boolean; error?: string }>
}
