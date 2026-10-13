/**
 * Per-project indexing queue and visual search (spec 07 §2.1, §2.5; Mac `SearchIndexCoordinator.swift`).
 *
 * Triggers: project open (prepare + sweep), model ready (sweep), and every document change that adds an asset or
 * changes one's file/duration/audio/generation state — which covers import, generation results, captured frames and
 * relink without hooking each path. The FIFO runs serially; exports pause it.
 */
import { EventEmitter } from 'node:events'
import { isInFlight } from '../../../core/generation/status'
import type { MediaManifestEntry } from '../../../core/model'
import { visualSearch, VISUAL_MATCH_COSINE_FLOOR, type VisualHit } from '../../../core/search/ranking'
import type { AssetIndex } from '../../../core/search/store'
import type { ProjectSession } from '../../project/session'
import { indexImage, indexSpecOf, indexVideo, type IndexDeps } from './indexer'
import type { SearchModel } from './model'
import type { EmbeddingStore } from './store'

export interface Transcriber {
  /** Whether indexing should create a transcript for this file (engine installed, nothing cached yet). */
  needs(file: string): Promise<boolean>
  run(file: string, isVideo: boolean, signal: AbortSignal): Promise<void>
}

export interface CoordinatorDeps {
  model: SearchModel
  store: EmbeddingStore
  isExportActive(): boolean
  transcriber?: Transcriber
  exportPollMs?: number
  /** Test seams for decoding. */
  indexDeps?: Pick<IndexDeps, 'frames' | 'still' | 'samplerOptions'>
  log?: (msg: string) => void
}

interface Snapshot {
  id: string
  file: string | null
  type: MediaManifestEntry['type']
  duration: number
  hasAudio: boolean
  isGenerating: boolean
}

interface Work {
  asset: Snapshot
  spec: string
}

const snapKey = (s: Snapshot) => `${s.file}|${s.type}|${s.duration}|${s.hasAudio}|${s.isGenerating}`
const abortError = () => new DOMException('Aborted', 'AbortError')
const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'

export class SearchIndexCoordinator extends EventEmitter {
  batchTotal = 0
  batchCompleted = 0
  currentAssetFraction = 0

  private queue: Work[] = []
  private scheduledIds = new Set<string>()
  private failedIds = new Set<string>()
  private isCancelling = false
  private worker: { promise: Promise<void>; controller: AbortController } | null = null
  private loadedIndexes = new Map<string, { key: string; index: AssetIndex }>()
  private seen = new Map<string, string>()
  private readonly onChange = () => this.documentChanged()
  private disposed = false

  constructor(
    readonly session: ProjectSession,
    private readonly d: CoordinatorDeps,
  ) {
    super()
    for (const e of session.doc.manifest.entries) this.seen.set(e.id, snapKey(this.snapshot(e)))
    session.on('change', this.onChange)
  }

  get indexingActive(): boolean {
    return this.batchCompleted < this.batchTotal
  }

  get indexingProgress(): number {
    if (this.batchTotal <= 0) return 0
    return Math.min(1, (this.batchCompleted + Math.min(Math.max(this.currentAssetFraction, 0), 1)) / this.batchTotal)
  }

  private changed(): void {
    this.emit('change')
  }

  private assets(): MediaManifestEntry[] {
    return this.session.closed ? [] : this.session.doc.manifest.entries
  }

  private snapshot(e: MediaManifestEntry): Snapshot {
    return { id: e.id, file: this.session.resolveMedia(e), type: e.type, duration: e.duration, hasAudio: !!e.hasAudio, isGenerating: isInFlight(e.generationStatus) }
  }

  // ---------- triggers ----------

  async projectOpened(): Promise<void> {
    await this.d.model.prepare()
    this.sweep()
  }

  /** Schedules every asset; failed ones get a fresh chance. Needs enabled + ready. */
  sweep(): void {
    if (this.disposed || !this.d.model.enabled || !this.d.model.isReady) return
    this.failedIds.clear()
    for (const a of this.assets()) this.schedule(a)
  }

  private documentChanged(): void {
    if (this.disposed) return
    const now = new Map<string, string>()
    const changed: MediaManifestEntry[] = []
    for (const e of this.assets()) {
      const k = snapKey(this.snapshot(e))
      now.set(e.id, k)
      if (this.seen.get(e.id) !== k) changed.push(e)
    }
    this.seen = now
    for (const id of this.loadedIndexes.keys()) if (!now.has(id)) this.loadedIndexes.delete(id)
    for (const e of changed) {
      this.failedIds.delete(e.id)
      this.schedule(e)
    }
  }

  schedule(asset: MediaManifestEntry): void {
    const embedder = this.d.model.embedder
    if (this.disposed || this.isCancelling || !this.d.model.enabled || !embedder || isInFlight(asset.generationStatus)) return
    if (this.scheduledIds.has(asset.id) || this.failedIds.has(asset.id)) return
    this.queue.push({ asset: this.snapshot(asset), spec: JSON.stringify(embedder.spec) })
    this.scheduledIds.add(asset.id)
    this.batchTotal++
    this.changed()
    this.ensureWorker()
  }

  async cancelIndexing(): Promise<void> {
    this.isCancelling = true
    try {
      const current = this.worker
      this.worker = null
      this.queue = []
      this.scheduledIds.clear()
      this.resetBatch()
      current?.controller.abort()
      await current?.promise.catch(() => undefined)
      this.resetBatch()
    } finally {
      this.isCancelling = false
    }
  }

  /** `resetAll` for this project: cancel, forget loaded indexes and failures. */
  async reset(): Promise<void> {
    await this.cancelIndexing()
    this.loadedIndexes.clear()
    this.failedIds.clear()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.session.off('change', this.onChange)
    await this.cancelIndexing()
    this.removeAllListeners()
  }

  // ---------- worker ----------

  private resetBatch(): void {
    this.batchTotal = 0
    this.batchCompleted = 0
    this.currentAssetFraction = 0
    this.changed()
  }

  private ensureWorker(): void {
    if (this.worker) return
    const controller = new AbortController()
    const run = async () => {
      while (!controller.signal.aborted) {
        const work = this.queue.shift()
        if (!work) {
          this.resetBatch()
          break
        }
        this.currentAssetFraction = 0
        await this.process(work, controller.signal)
      }
    }
    const handle = { controller, promise: Promise.resolve() }
    handle.promise = run().finally(() => {
      if (this.worker === handle) this.worker = null
    })
    this.worker = handle
  }

  private isCurrent(work: Work): boolean {
    const embedder = this.d.model.embedder
    if (!this.d.model.enabled || !embedder || JSON.stringify(embedder.spec) !== work.spec) return false
    const asset = this.assets().find((a) => a.id === work.asset.id)
    return !!asset && snapKey(this.snapshot(asset)) === snapKey(work.asset)
  }

  private async waitWhileExportActive(signal: AbortSignal): Promise<void> {
    while (this.d.isExportActive()) {
      if (signal.aborted) throw abortError()
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, this.d.exportPollMs ?? 2000)
        function done() {
          clearTimeout(t)
          signal.removeEventListener('abort', done)
          resolve()
        }
        signal.addEventListener('abort', done, { once: true })
      })
    }
    if (signal.aborted) throw abortError()
  }

  private async process(work: Work, signal: AbortSignal): Promise<void> {
    let retry: MediaManifestEntry | undefined
    try {
      const a = work.asset
      const embedder = this.d.model.embedder
      const spec = embedder ? indexSpecOf(embedder.spec) : null
      // Preflight.
      const needsVisual = !!a.file && !!spec && (a.type === 'video' || a.type === 'image') && (await this.d.store.needsIndex(a.file, spec))
      const needsTranscript = !!a.file && !!this.d.transcriber && (a.type === 'audio' || (a.type === 'video' && a.hasAudio)) && (await this.d.transcriber.needs(a.file))
      if (signal.aborted) return
      if (!this.isCurrent(work)) {
        retry = this.assets().find((x) => x.id === a.id)
        return
      }
      if (!needsVisual && !needsTranscript) return
      try {
        await this.waitWhileExportActive(signal)
      } catch {
        return
      }
      const model = this.d.model.embedder
      if (!this.isCurrent(work) || !model) {
        retry = this.assets().find((x) => x.id === a.id)
        return
      }
      await this.indexOne(a, signal, needsVisual, needsTranscript)
    } finally {
      this.scheduledIds.delete(work.asset.id)
      this.batchCompleted++
      this.changed()
      if (retry && !signal.aborted) this.schedule(retry)
    }
  }

  private async indexOne(a: Snapshot, signal: AbortSignal, visual: boolean, transcribe: boolean): Promise<void> {
    const file = a.file!
    const embedder = this.d.model.embedder!
    const visualShare = transcribe && visual ? 0.5 : 1.0
    let lastEmit = 0
    const onProgress = (f: number) => {
      this.currentAssetFraction = f * visualShare
      const now = Date.now()
      if (now - lastEmit > 250) {
        lastEmit = now
        this.changed()
      }
    }
    const deps: IndexDeps = { store: this.d.store, embedder, signal, waitWhileExportActive: (s) => this.waitWhileExportActive(s ?? signal), ...this.d.indexDeps }
    const started = Date.now()
    const transcript = transcribe
      ? (async () => {
          await this.waitWhileExportActive(signal)
          await this.d.transcriber!.run(file, a.type === 'video', signal)
        })()
      : Promise.resolve()
    transcript.catch(() => undefined)
    try {
      if (visual && a.type === 'image') await indexImage(file, deps)
      else if (visual && a.type === 'video') await indexVideo(file, a.duration, deps, onProgress)
      this.loadedIndexes.delete(a.id)
      this.currentAssetFraction = visualShare
      this.changed()
      await transcript
      this.d.log?.(`[search] indexed ${a.id.slice(0, 8)} in ${((Date.now() - started) / 1000).toFixed(1)}s transcribed=${transcribe}`)
    } catch (e) {
      if (isAbort(e) || signal.aborted) return
      this.failedIds.add(a.id)
      this.d.log?.(`[search] index failed ${a.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
      void this.d.model.recoverIfCrashed()
    }
  }

  // ---------- query ----------

  /** Assets of `ids` (default: all video/image) whose index is current. */
  async indexedCount(ids: string[]): Promise<number | null> {
    const embedder = this.d.model.embedder
    if (!embedder) return null
    const spec = indexSpecOf(embedder.spec)
    let n = 0
    for (const id of ids) {
      const file = this.session.resolveMedia(id)
      if (file && !(await this.d.store.needsIndex(file, spec))) n++
    }
    return n
  }

  async search(query: string, limit = 20, within?: Set<string> | null): Promise<VisualHit[]> {
    const model = this.d.model.embedder
    if (!model || !this.d.model.isReady) return []
    const trimmed = query.trim()
    if (!trimmed) return []
    const candidates = this.assets().filter((e) => (e.type === 'video' || e.type === 'image') && (!within || within.has(e.id)))
    const indexes: { assetId: string; index: AssetIndex }[] = []
    for (const e of candidates) {
      const file = this.session.resolveMedia(e)
      const key = file ? this.d.store.key(file) : null
      if (!key) continue
      const cached = this.loadedIndexes.get(e.id)
      if (cached && cached.key === key) {
        indexes.push({ assetId: e.id, index: cached.index })
        continue
      }
      try {
        const index = await this.d.store.load(key)
        this.loadedIndexes.set(e.id, { key, index })
        indexes.push({ assetId: e.id, index })
      } catch {
        // Not indexed yet (or corrupt): skip.
      }
    }
    if (!indexes.length) return []
    let vector: Float32Array
    try {
      vector = await model.encodeText(trimmed)
    } catch {
      return []
    }
    return visualSearch(vector, indexes, { limit, minScore: VISUAL_MATCH_COSINE_FLOOR })
  }
}
