/** Creates the smart search service with the app's real dependencies (spec 07 §2.7). */
import path from 'node:path'
import { appDirs } from '../../paths'
import type { ModelManager } from '../models'
import type { TranscriptionService } from '../transcribe/service'
import type { Transcriber } from './coordinator'
import { loadRemoteSiglip } from './remote'
import { SearchService } from './service'

export interface CreateSearchOptions {
  models: ModelManager
  transcription?: TranscriptionService
  enabled(): boolean
  persistEnabled(value: boolean): Promise<void> | void
  isExportActive(): boolean
  cacheRoot?: string
}

/** Cache subdirectories "Clear cache" empties (Mac `StoragePane.caches`; not BeatAnalysis, not Embeddings). */
export const CLEARABLE_CACHE_DIRS = ['proxies', 'thumbnails', 'filmstrips', 'waveforms', 'MediaVisualCache', 'Transcripts', 'AudioAnalysis', 'EnhancedAudio', 'SpeakerVoices']

/**
 * Transcripts during indexing (spec 07 §2.1) use the local engine only when it is already installed: on Linux the
 * whisper model is a ~574 MB download, which indexing must not trigger on its own.
 */
export function localTranscriber(models: ModelManager, stt: TranscriptionService): Transcriber {
  return {
    async needs(file) {
      const id = stt.whisperModelId()
      if (!models.isInstalled(id) || !models.isInstalled('whisper-cli')) return false
      return !(await stt.hasCachedOnDisk(file))
    },
    async run(file, isVideo, signal) {
      await stt.transcribe({ file, isVideo, range: null, provider: 'local', censorProfanity: false, signal })
    },
  }
}

export function createSearch(o: CreateSearchOptions): SearchService {
  const cacheRoot = o.cacheRoot ?? appDirs.cache
  return new SearchService({
    models: o.models,
    embeddingsDir: path.join(cacheRoot, 'Embeddings'),
    cacheRoot,
    clearableCacheDirs: CLEARABLE_CACHE_DIRS.map((d) => path.join(cacheRoot, d)),
    onCacheCleared: () => o.transcription?.clearMemory(),
    enabled: o.enabled,
    persistEnabled: o.persistEnabled,
    loadEmbedder: loadRemoteSiglip,
    isExportActive: o.isExportActive,
    transcriber: o.transcription ? localTranscriber(o.models, o.transcription) : undefined,
    log: (m) => console.log(m),
  })
}
