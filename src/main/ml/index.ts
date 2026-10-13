/** ML infrastructure for the main process (spec 07 §0): model manager, caches, jobs and the transcription service. */
import path from 'node:path'
import type { TranscriptionSettings } from '../../shared/api'
import { appDirs } from '../paths'
import type { FetchLike } from './download'
import { JobRegistry } from './jobs'
import { ModelManager } from './models'
import { TranscriptCache } from './transcribe/cache'
import type { HttpFetch } from './transcribe/cloud/types'
import { TranscriptionService } from './transcribe/service'

export const mlDirs = {
  /** `$XDG_DATA_HOME/framewright/Models/{whisper,speaker,search}/`. */
  models: path.join(appDirs.data, 'Models'),
  /** `$XDG_CACHE_HOME/framewright/Transcripts/`. */
  transcripts: path.join(appDirs.cache, 'Transcripts'),
}

export interface Ml {
  models: ModelManager
  cache: TranscriptCache
  transcription: TranscriptionService
  jobs: JobRegistry
  /** before-quit: stop admitting jobs, cancel, wait ≤ 3 s (children are killed by their abort handlers). */
  shutdown(): Promise<void>
}

export interface MlOptions {
  settings: () => { apiKeys: Record<string, string | undefined>; transcription?: TranscriptionSettings }
  systemLanguages: () => string[]
  fetch: HttpFetch
  modelsRoot?: string
  transcriptsDir?: string
}

export function createMl(o: MlOptions): Ml {
  const models = new ModelManager({ root: o.modelsRoot ?? mlDirs.models, fetch: o.fetch as FetchLike })
  const cache = new TranscriptCache(o.transcriptsDir ?? mlDirs.transcripts)
  const transcription = new TranscriptionService({ models, cache, settings: o.settings, systemLanguages: o.systemLanguages, fetch: o.fetch })
  const jobs = new JobRegistry()
  return {
    models,
    cache,
    transcription,
    jobs,
    async shutdown() {
      models.cancelAll()
      await jobs.shutdown(3000)
    },
  }
}
