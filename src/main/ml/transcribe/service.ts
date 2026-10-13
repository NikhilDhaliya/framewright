/**
 * Transcription service (spec 07 §1.3–1.6): local whisper.cpp with the Mac's cache semantics, plus BYOK cloud.
 * Shared by the Captions tab / Index (via IPC), the MCP tools and the in-app agent.
 */
import fs from 'node:fs/promises'
import { whisperLanguage, languageSubtag } from '../../../core/captions/languages'
import { filterToRange, isCancellation, offsetting, TranscriptionError, type TranscriptionResult } from '../../../core/captions/transcript'
import type { TranscriptionProgress, TranscriptionSettings } from '../../../shared/api'
import { Semaphore } from '../jobs'
import { DEFAULT_WHISPER_MODEL, isWhisperModelName, WHISPER_MODELS, manifestBytes, type ModelId } from '../manifests'
import { ModelInstallError, type ModelManager } from '../models'
import { extractSpeechWav } from './audio'
import { cloudCacheKey, localCacheKey, type TranscriptCache } from './cache'
import { CLOUD_UNAVAILABLE_MESSAGE, resolveCloudProvider } from './cloud'
import type { HttpFetch } from './cloud/types'
import { censorTranscript } from './profanity'
import { findWhisperCli, runWhisper } from './whisper'

export interface TranscribeRequest {
  /** Absolute media path. */
  file: string
  isVideo?: boolean
  /** Source-seconds range; null/undefined = the whole file. */
  range?: [number, number] | null
  provider: 'local' | 'cloud'
  /** BCP-47; undefined = Auto. */
  locale?: string
  censorProfanity?: boolean
  signal?: AbortSignal
  onProgress?: (p: TranscriptionProgress) => void
}

export interface TranscriptionDeps {
  models: ModelManager
  cache: TranscriptCache
  settings: () => { apiKeys: Record<string, string | undefined>; transcription?: TranscriptionSettings }
  /** `app.getPreferredSystemLanguages()`. */
  systemLanguages: () => string[]
  /** Electron `net.fetch` (system proxies). */
  fetch: HttpFetch
  /** Test override of cloud API origins. */
  cloudBaseUrl?: string
}

const abortIfNeeded = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

export class TranscriptionService {
  /** The "transcribe" lane: one whisper process at a time (spec 07 §1.5, §3.9). */
  private readonly lane = new Semaphore(1)

  constructor(private readonly d: TranscriptionDeps) {}

  /** The configured whisper model id (`transcription.localModel`). */
  whisperModelId(): ModelId {
    const name = this.d.settings().transcription?.localModel
    return WHISPER_MODELS[isWhisperModelName(name) ? name : DEFAULT_WHISPER_MODEL]
  }

  cloudAvailable(): boolean {
    return resolveCloudProvider(this.d.settings()) !== null
  }

  /**
   * Local language: an explicit locale must map to a whisper language; Auto = the first system language whisper
   * knows (Mac parity: Auto is the user's language, not detection) unless `transcription.localAutoDetect`.
   */
  resolveLocalLanguage(locale?: string): { code: string; tag?: string } {
    if (locale) {
      const code = whisperLanguage(locale)
      if (!code) throw new TranscriptionError('unsupportedLocale', locale)
      return { code, tag: locale }
    }
    if (this.d.settings().transcription?.localAutoDetect) return { code: 'auto' }
    const system = this.d.systemLanguages()
    for (const tag of system) {
      const code = whisperLanguage(tag)
      if (code) return { code, tag }
    }
    throw new TranscriptionError('unsupportedLocale', system[0] ?? 'und')
  }

  async transcribe(req: TranscribeRequest): Promise<TranscriptionResult> {
    abortIfNeeded(req.signal)
    if (req.provider === 'cloud') return this.transcribeCloud(req)
    const range = req.range ?? null
    if (req.censorProfanity || req.locale) {
      // Option variants produce different transcripts: bypass the cache (EditorViewModel+Captions.swift:493-497).
      return this.transcribeLocal(req.file, range, req)
    }
    const modelId = this.whisperModelId()
    const key = localCacheKey(req.file, modelId)
    let full = await this.d.cache.read(key)
    if (!full) {
      full = await this.lane.run(async () => {
        const again = await this.d.cache.read(key)
        if (again) return again
        const r = await this.transcribeLocal(req.file, null, req, true)
        abortIfNeeded(req.signal)
        await this.d.cache.write(key, r)
        return r
      }, req.signal)
    }
    return range ? filterToRange(full, range[0], range[1]) : full
  }

  /** Cached local full transcript windowed to `range`, or null (never transcribes). */
  async cachedTranscript(file: string, range?: [number, number] | null): Promise<TranscriptionResult | null> {
    const full = await this.d.cache.read(localCacheKey(file, this.whisperModelId()))
    if (!full) return null
    return range ? filterToRange(full, range[0], range[1]) : full
  }

  cachedCloudTranscript(file: string, range: [number, number] | null, language: string | null): Promise<TranscriptionResult | null> {
    return this.d.cache.read(cloudCacheKey(file, range, language))
  }

  hasCachedOnDisk(file: string): Promise<boolean> {
    return this.d.cache.has(localCacheKey(file, this.whisperModelId()))
  }

  clearMemory(): void {
    this.d.cache.clearMemory()
  }

  /** Installs the whisper binary and model on first use, reporting combined byte progress. */
  private async ensureEngine(req: TranscribeRequest): Promise<{ binary: string; model: string }> {
    const modelId = this.whisperModelId()
    const ids: ModelId[] = ['whisper-cli', modelId]
    const models = this.d.models
    const total = ids.reduce((n, id) => n + (models.isInstalled(id) ? 0 : manifestBytes(models.manifest(id))), 0)
    const report = () => {
      if (!total) return
      let got = 0
      for (const id of ids) {
        const s = models.state(id)
        const bytes = manifestBytes(models.manifest(id))
        if (models.isInstalled(id)) continue
        if (s.kind === 'downloading') got += s.fraction * bytes
        else if (s.kind === 'preparing' || s.kind === 'ready') got += bytes
      }
      req.onProgress?.({ phase: 'downloading', fraction: Math.min(1, got / total) })
    }
    const onState = () => report()
    models.on('state', onState)
    try {
      if (total) req.onProgress?.({ phase: 'downloading', fraction: 0 })
      const [binDir, modelDir] = await Promise.all(ids.map((id) => models.ensure(id, { signal: req.signal })))
      const binary = findWhisperCli(binDir)
      if (!binary) throw new ModelInstallError('whisper-cli is missing from the downloaded package')
      await fs.chmod(binary, 0o755).catch(() => undefined)
      return { binary, model: `${modelDir}/${models.manifest(modelId).files[0].path}` }
    } catch (e) {
      if (isCancellation(e) || req.signal?.aborted) throw e
      throw new TranscriptionError('modelInstallFailed', e instanceof Error ? e.message : String(e))
    } finally {
      models.off('state', onState)
    }
  }

  private async transcribeLocal(file: string, range: [number, number] | null, req: TranscribeRequest, inLane = false): Promise<TranscriptionResult> {
    const lang = this.resolveLocalLanguage(req.locale)
    const engine = await this.ensureEngine(req)
    abortIfNeeded(req.signal)
    req.onProgress?.({ phase: 'transcribing', fraction: 0 })
    const wav = await extractSpeechWav(file, { range: range ?? undefined, signal: req.signal })
    try {
      const run = () =>
        runWhisper({ binary: engine.binary, model: engine.model, wav, language: lang.code, reportLanguage: lang.tag, signal: req.signal, onProgress: (fraction) => req.onProgress?.({ phase: 'transcribing', fraction }) })
      let result = inLane ? await run() : await this.lane.run(run, req.signal)
      if (range) result = offsetting(result, range[0])
      if (req.censorProfanity) result = censorTranscript(result)
      return result
    } finally {
      await fs.rm(wav, { force: true })
    }
  }

  private async transcribeCloud(req: TranscribeRequest): Promise<TranscriptionResult> {
    const cloud = resolveCloudProvider(this.d.settings())
    if (!cloud) throw new Error(CLOUD_UNAVAILABLE_MESSAGE)
    const range = req.range ?? null
    // `preferredLocale.languageCode ?? bcp47`, nil for Auto (CloudTranscription.swift:46-50).
    const language = req.locale ? languageSubtag(req.locale) : null
    const key = cloudCacheKey(req.file, range, language)
    const cached = await this.d.cache.read(key)
    if (cached) return cached
    req.onProgress?.({ phase: 'transcribing', fraction: 0 })
    const wav = await extractSpeechWav(req.file, { range: range ?? undefined, signal: req.signal })
    try {
      let result: TranscriptionResult
      try {
        result = await cloud.provider.transcribe({ wavPath: wav, language: language ?? undefined, apiKey: cloud.apiKey, signal: req.signal, fetch: this.d.fetch, baseUrl: this.d.cloudBaseUrl })
      } catch (e) {
        if (isCancellation(e) || req.signal?.aborted) throw e
        throw new TranscriptionError('analysisFailed', e instanceof Error ? e.message : String(e))
      }
      abortIfNeeded(req.signal)
      if (range) result = offsetting(result, range[0])
      await this.d.cache.write(key, result)
      return result
    } finally {
      await fs.rm(wav, { force: true })
    }
  }
}
