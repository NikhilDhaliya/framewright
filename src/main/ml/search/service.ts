/**
 * Smart search service (spec 07 §2): the app-level model loader, one indexing coordinator per open project, the
 * Settings ▸ Storage actions and the search_media visual half.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModelStateView } from '../../../shared/api'
import type { SearchStatus, StorageInfo, StorageModelRow } from '../../../shared/search'
import type { VisualHit } from '../../../core/search/ranking'
import type { ProjectSession } from '../../project/session'
import { MANIFESTS, type ModelId } from '../manifests'
import type { ModelManager } from '../models'
import { SearchIndexCoordinator, type Transcriber } from './coordinator'
import type { IndexDeps } from './indexer'
import { SEARCH_MODEL_DOWNLOAD_BYTES, SEARCH_MODEL_ID, SearchModel } from './model'
import type { Embedder } from './siglip'
import { dirBytes, EmbeddingStore } from './store'

export interface SearchServiceDeps {
  models: ModelManager
  /** `$XDG_CACHE_HOME/framewright/Embeddings`. */
  embeddingsDir: string
  /** `$XDG_CACHE_HOME/framewright` (Storage pane path) and the cache subdirectories "Clear cache" empties. */
  cacheRoot: string
  clearableCacheDirs: string[]
  /** Called after "Clear cache" (e.g. the transcript memory cache). */
  onCacheCleared?: () => void
  enabled(): boolean
  persistEnabled(value: boolean): Promise<void> | void
  loadEmbedder(dir: string): Promise<Embedder>
  isExportActive(): boolean
  transcriber?: Transcriber
  exportPollMs?: number
  indexDeps?: Pick<IndexDeps, 'frames' | 'still' | 'samplerOptions'>
  log?: (msg: string) => void
}

/** The Mac's display path: the home directory as `~`. */
function displayPath(p: string): string {
  const home = os.homedir()
  return home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p
}

/** Statuses of search_media's `index` object (spec 02 §3.11). */
export type IndexStatusName = 'disabled' | 'ready' | 'indexing' | 'modelNotInstalled' | 'downloadingModel' | 'preparing' | 'failed'

export class SearchService extends EventEmitter {
  readonly model: SearchModel
  readonly store: EmbeddingStore
  private readonly coordinators = new Map<ProjectSession, SearchIndexCoordinator>()

  constructor(private readonly d: SearchServiceDeps) {
    super()
    this.setMaxListeners(50)
    this.store = new EmbeddingStore(d.embeddingsDir)
    this.model = new SearchModel({ models: d.models, enabled: d.enabled, persistEnabled: d.persistEnabled, loadEmbedder: d.loadEmbedder })
    this.model.on('state', () => this.emit('status', null))
    this.model.on('ready', () => this.sweepAll())
  }

  // ---------- projects ----------

  /** The coordinator of `session`, created (and "project opened") on first use. */
  coordinator(session: ProjectSession): SearchIndexCoordinator {
    let c = this.coordinators.get(session)
    if (!c) {
      c = new SearchIndexCoordinator(session, {
        model: this.model,
        store: this.store,
        isExportActive: this.d.isExportActive,
        transcriber: this.d.transcriber,
        exportPollMs: this.d.exportPollMs,
        indexDeps: this.d.indexDeps,
        log: this.d.log,
      })
      const owner = session
      c.on('change', () => this.emit('status', owner))
      this.coordinators.set(session, c)
      void c.projectOpened()
    }
    return c
  }

  /** Reconciles coordinators with the open projects (call on open/close). */
  syncSessions(open: ProjectSession[]): void {
    const live = new Set(open.filter((s) => !s.closed))
    for (const [s, c] of this.coordinators) {
      if (!live.has(s)) {
        this.coordinators.delete(s)
        void c.dispose()
      }
    }
    for (const s of live) this.coordinator(s)
  }

  sweepAll(): void {
    for (const c of this.coordinators.values()) c.sweep()
  }

  private async resetAll(): Promise<void> {
    await Promise.all([...this.coordinators.values()].map((c) => c.reset()))
  }

  // ---------- status ----------

  status(session: ProjectSession | null): SearchStatus {
    const c = session ? this.coordinators.get(session) : undefined
    return {
      enabled: this.model.enabled,
      model: this.model.state as ModelStateView,
      modelDownloadBytes: SEARCH_MODEL_DOWNLOAD_BYTES,
      indexing: { active: !!c?.indexingActive, completed: c?.batchCompleted ?? 0, total: c?.batchTotal ?? 0, progress: c?.indexingProgress ?? 0 },
    }
  }

  statusName(session: ProjectSession): IndexStatusName {
    if (!this.model.enabled) return 'disabled'
    switch (this.model.state.kind) {
      case 'ready':
        return this.coordinators.get(session)?.indexingActive ? 'indexing' : 'ready'
      case 'notInstalled':
        return 'modelNotInstalled'
      case 'downloading':
        return 'downloadingModel'
      case 'failed':
        return 'failed'
      default:
        return 'preparing'
    }
  }

  // ---------- actions ----------

  download(): Promise<void> {
    return this.model.download()
  }

  async setEnabled(value: boolean): Promise<void> {
    if (!value) await Promise.all([...this.coordinators.values()].map((c) => c.cancelIndexing()))
    await this.model.setEnabled(value)
    if (value) this.sweepAll()
    this.emit('status', null)
  }

  async search(session: ProjectSession, query: string, limit = 20, within?: Set<string> | null): Promise<VisualHit[]> {
    return this.coordinator(session).search(query, limit, within)
  }

  /** "Clear index": reset all coordinators, delete Embeddings/, sweep. */
  async clearIndex(): Promise<void> {
    await this.resetAll()
    await this.store.clearAll()
    this.sweepAll()
  }

  /** "Remove model": deletes only Models/search/. */
  async removeSearchModel(): Promise<void> {
    await this.resetAll()
    await this.model.remove()
  }

  async removeModel(id: string): Promise<void> {
    if (id === SEARCH_MODEL_ID) return this.removeSearchModel()
    if (!Object.hasOwn(MANIFESTS, id)) throw new Error(`Unknown model ${id}`)
    await this.d.models.remove(id as ModelId)
  }

  async clearCache(): Promise<void> {
    await Promise.all(this.d.clearableCacheDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
    this.d.onCacheCleared?.()
  }

  async storage(): Promise<StorageInfo> {
    const cacheBytes = (await Promise.all(this.d.clearableCacheDirs.map((d) => dirBytes(d)))).reduce((a, b) => a + b, 0)
    const searchModelBytes = await dirBytes(path.dirname(this.d.models.dir(SEARCH_MODEL_ID)))
    const otherModels: StorageModelRow[] = []
    for (const m of Object.values(MANIFESTS)) {
      if (m.id === SEARCH_MODEL_ID || !this.d.models.isInstalled(m.id)) continue
      const bytes = await dirBytes(this.d.models.dir(m.id))
      const kind = m.id === 'whisper-cli' ? 'Speech engine' : m.id.startsWith('whisper') ? 'Speech model' : m.id.startsWith('speaker') ? 'Speaker model' : 'Audio model'
      otherModels.push({ id: m.id, kind, label: m.label, bytes })
    }
    return {
      cachePath: this.d.cacheRoot,
      cacheDisplayPath: displayPath(this.d.cacheRoot),
      cacheBytes,
      indexBytes: await this.store.bytes(),
      searchModelBytes,
      searchModelLabel: String(MANIFESTS[SEARCH_MODEL_ID].spec?.model ?? 'siglip2-base-patch16-256'),
      otherModels,
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.coordinators.values()].map((c) => c.dispose()))
    this.coordinators.clear()
    await this.model.dispose()
  }
}
