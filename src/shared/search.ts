/** Smart search IPC types (spec 07 §2; UI 05 §4.10–4.11, §11.8). */
import type { ModelStateView, Unsubscribe } from './api'

export interface SearchStatus {
  enabled: boolean
  model: ModelStateView
  /** Image + text tower bytes, for the "Smart search" tooltip. */
  modelDownloadBytes: number
  /** This window's project indexer. */
  indexing: { active: boolean; completed: number; total: number; progress: number }
}

export interface MomentHit {
  assetId: string
  time: number
  shotStart: number
  shotEnd: number
  score: number
}

export interface SpokenHit {
  assetId: string
  start: number
  end: number
  text: string
}

export interface StorageModelRow {
  id: string
  /** e.g. "Speech model", "Speaker model". */
  kind: string
  label: string
  bytes: number
}

export interface StorageInfo {
  cachePath: string
  /** `cachePath` with the home directory shown as `~`. */
  cacheDisplayPath: string
  cacheBytes: number
  indexBytes: number
  /** Bytes under Models/search/ (0 = no model row). */
  searchModelBytes: number
  searchModelLabel: string
  /** Linux addition: downloaded speech/audio models. */
  otherModels: StorageModelRow[]
}

export interface SearchApi {
  status(): Promise<SearchStatus>
  onStatus(cb: (s: SearchStatus) => void): Unsubscribe
  /** Explicit "Smart search" / "Retry": download (if needed) and load the model. */
  download(): void
  moments(query: string): Promise<MomentHit[]>
  spoken(query: string): Promise<SpokenHit[]>
  /** JPEG data URL of the source frame near `time` (≤ 240 px, ±1 s tolerance). */
  frame(assetId: string, time: number): Promise<string | null>
  storage(): Promise<StorageInfo>
  clearCache(): Promise<void>
  clearIndex(): Promise<void>
  removeSearchModel(): Promise<void>
  removeModel(id: string): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
}
