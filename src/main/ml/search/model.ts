/**
 * App-level search model loader (spec 07 §2.1, Mac `VisualModelLoader.swift`):
 * `unknown → notInstalled | preparing → ready | failed(msg)`, `downloading(fraction)`.
 * `prepare()` never downloads; `download()` is the explicit "Smart search"/"Retry" action (or the agent's search_media).
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { manifestBytes, MANIFESTS, type ModelId } from '../manifests'
import type { ModelManager, ModelState } from '../models'
import { SIGLIP_FILES, type Embedder } from './siglip'

export const SEARCH_MODEL_ID: ModelId = 'search-siglip2-b16-256-int8'

/** Image + text tower bytes (the Mac tooltip counts only the two encoders). */
export const SEARCH_MODEL_DOWNLOAD_BYTES = MANIFESTS[SEARCH_MODEL_ID].files.filter((f) => f.path === SIGLIP_FILES.vision || f.path === SIGLIP_FILES.text).reduce((n, f) => n + f.bytes, 0)
export const SEARCH_MODEL_TOTAL_BYTES = manifestBytes(MANIFESTS[SEARCH_MODEL_ID])

export interface SearchModelDeps {
  models: ModelManager
  enabled(): boolean
  persistEnabled(value: boolean): Promise<void> | void
  loadEmbedder(dir: string): Promise<Embedder>
}

export class SearchModel extends EventEmitter {
  private _state: ModelState = { kind: 'unknown' }
  private _embedder: Embedder | null = null
  private loadToken = 0

  constructor(private readonly d: SearchModelDeps) {
    super()
    d.models.on('state', (id: string, s: ModelState) => {
      if (id !== SEARCH_MODEL_ID) return
      if (s.kind === 'downloading' && this._state.kind === 'downloading') this.set(s)
    })
  }

  get state(): ModelState {
    return this._state
  }
  get enabled(): boolean {
    return this.d.enabled()
  }
  get isReady(): boolean {
    return this._state.kind === 'ready'
  }
  get embedder(): Embedder | null {
    return this._embedder
  }

  private set(s: ModelState): void {
    this._state = s
    this.emit('state', s)
  }

  /** Loads an installed model; never downloads. Idempotent. */
  async prepare(): Promise<void> {
    if (!this.enabled || this._state.kind !== 'unknown') return
    if (!this.d.models.isInstalled(SEARCH_MODEL_ID)) return this.set({ kind: 'notInstalled' })
    this.set({ kind: 'preparing' })
    await this.load(this.d.models.dir(SEARCH_MODEL_ID))
  }

  /** From notInstalled / failed / unknown only. Resolves when the download and load settle. */
  async download(): Promise<void> {
    const k = this._state.kind
    if (k === 'downloading' || k === 'preparing' || k === 'ready') return
    this.set({ kind: 'downloading', fraction: 0 })
    let dir: string
    try {
      dir = await this.d.models.ensure(SEARCH_MODEL_ID, { userInitiated: true })
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError'
      this.set(aborted ? { kind: 'notInstalled' } : { kind: 'failed', message: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!this.enabled) return this.set({ kind: 'unknown' })
    this.set({ kind: 'preparing' })
    await this.load(dir)
  }

  private async load(dir: string): Promise<void> {
    const token = ++this.loadToken
    try {
      const embedder = await this.d.loadEmbedder(dir)
      if (token !== this.loadToken) {
        await embedder.dispose()
        return
      }
      this._embedder = embedder
      this.set({ kind: 'ready' })
      this.emit('ready')
    } catch (e) {
      if (token !== this.loadToken) return
      this.set({ kind: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Off cancels indexing (by the service) and drops the embedder; on prepares again. */
  async setEnabled(value: boolean): Promise<void> {
    await this.d.persistEnabled(value)
    if (value) {
      await this.prepare()
      return
    }
    this.loadToken++
    const e = this._embedder
    this._embedder = null
    await e?.dispose()
    if (this._state.kind === 'ready' || this._state.kind === 'preparing') this.set({ kind: 'unknown' })
  }

  /** Linux: deletes only Models/search/ (the Mac deletes the whole Models dir, which here also holds speech models). */
  async remove(): Promise<void> {
    this.loadToken++
    const e = this._embedder
    this._embedder = null
    await e?.dispose()
    await this.d.models.remove(SEARCH_MODEL_ID)
    await fs.rm(path.dirname(this.d.models.dir(SEARCH_MODEL_ID)), { recursive: true, force: true })
    this.set({ kind: 'notInstalled' })
  }

  /** After an inference error: if the utility process died, drop it and load a fresh one. */
  async recoverIfCrashed(): Promise<void> {
    const e = this._embedder as (Embedder & { alive?: boolean }) | null
    if (!e || e.alive !== false) return
    this._embedder = null
    this.set({ kind: 'unknown' })
    await this.prepare()
  }

  async dispose(): Promise<void> {
    this.loadToken++
    await this._embedder?.dispose()
    this._embedder = null
  }
}
