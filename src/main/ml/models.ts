/**
 * Model and binary download manager (spec 07 §0.2) — the Linux generalization of the Mac `ModelDownloader`, shared by
 * transcription (§1), smart search (§2) and audio analysis (§3).
 *
 * - Idempotent `ensure()`: an installed model resolves at once; concurrent callers share one download.
 * - Files stream into a stable staging dir (`Models/.staging/<id>/`) so a cancelled or interrupted download resumes
 *   (HTTP Range) on the next attempt; transient failures retry. Each file is size- and sha256-verified.
 * - Archives are extracted with the system `tar`, then the result is renamed atomically into `Models/<dir>/` with a
 *   `spec.json` holding the pins; a changed manifest counts as not installed.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DownloadError, downloadFile, type FetchLike } from './download'
import { MANIFESTS, manifestBytes, type ModelId, type ModelManifest } from './manifests'

export type ModelState =
  | { kind: 'unknown' }
  | { kind: 'notInstalled' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'preparing' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

/** A failed install; `message` is user-facing ("HTTP 404 downloading ggml-base.bin", "Checksum mismatch for …"). */
export class ModelInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelInstallError'
  }
}

export interface ModelManagerOptions {
  /** `$XDG_DATA_HOME/framewright/Models`. */
  root: string
  manifests?: Partial<Record<string, ModelManifest>>
  /** Electron `net.fetch` in the app (system proxies); global fetch in tests. */
  fetch?: FetchLike
  retries?: number
  retryDelayMs?: number
}

export interface EnsureOptions {
  signal?: AbortSignal
  /** Explicit user action (Settings "Download"); informational, the Mac uses it to gate auto-downloads. */
  userInitiated?: boolean
}

interface Inflight {
  promise: Promise<string>
  controller: AbortController
  waiters: number
}

const abortError = () => new DOMException('Aborted', 'AbortError')
const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'

function pins(m: ModelManifest) {
  return m.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }))
}

function untar(archive: string, dest: string, kind: 'tar.gz' | 'tar.bz2', signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', [kind === 'tar.gz' ? '-xzf' : '-xjf', archive, '-C', dest, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    const onAbort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
    child.on('error', (e) => reject(new ModelInstallError(`Could not extract ${path.basename(archive)}: ${e.message}`)))
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(abortError())
      else if (code === 0) resolve()
      else reject(new ModelInstallError(`Could not extract ${path.basename(archive)}: ${err.trim().split('\n').pop() || `tar exited with ${code}`}`))
    })
  })
}

export class ModelManager extends EventEmitter {
  private readonly manifests: Record<string, ModelManifest>
  private readonly states = new Map<string, ModelState>()
  private readonly inflight = new Map<string, Inflight>()

  constructor(private readonly opts: ModelManagerOptions) {
    super()
    this.manifests = { ...MANIFESTS, ...(opts.manifests as Record<string, ModelManifest>) }
  }

  manifest(id: ModelId | string): ModelManifest {
    const m = this.manifests[id]
    if (!m) throw new ModelInstallError(`Unknown model ${id}`)
    return m
  }

  /** Final install directory. */
  dir(id: ModelId | string): string {
    return path.join(this.opts.root, this.manifest(id).dir)
  }

  private stagingDir(id: string): string {
    return path.join(this.opts.root, '.staging', id)
  }

  /** On-disk check: `spec.json` exists and pins the same files as the manifest. */
  isInstalled(id: ModelId | string): boolean {
    const m = this.manifest(id)
    try {
      const spec = JSON.parse(readFileSync(path.join(this.dir(id), 'spec.json'), 'utf8')) as { files?: unknown }
      return JSON.stringify(spec.files) === JSON.stringify(pins(m))
    } catch {
      return false
    }
  }

  /** Current state; the first read resolves `unknown` from disk. */
  state(id: ModelId | string): ModelState {
    const s = this.states.get(id)
    if (s && s.kind !== 'unknown') return s
    const resolved: ModelState = this.isInstalled(id) ? { kind: 'ready' } : { kind: 'notInstalled' }
    this.states.set(id, resolved)
    return resolved
  }

  private setState(id: string, s: ModelState): void {
    this.states.set(id, s)
    this.emit('state', id, s)
  }

  /** Bytes already on disk (installed size, else the resumable partial bytes). */
  async sizeOnDisk(id: ModelId | string): Promise<number> {
    const walk = async (p: string): Promise<number> => {
      const st = await fs.lstat(p).catch(() => null)
      if (!st) return 0
      if (!st.isDirectory()) return st.size
      const names = await fs.readdir(p).catch(() => [] as string[])
      let n = 0
      for (const name of names) n += await walk(path.join(p, name))
      return n
    }
    return this.isInstalled(id) ? walk(this.dir(id)) : walk(this.stagingDir(id))
  }

  /** Installs `id` if needed and resolves its directory. Concurrent callers share one download; each may abort alone. */
  ensure(id: ModelId | string, opts: EnsureOptions = {}): Promise<string> {
    this.manifest(id)
    if (opts.signal?.aborted) return Promise.reject(abortError())
    if (!this.inflight.has(id) && this.isInstalled(id)) {
      if (this.state(id).kind !== 'ready') this.setState(id, { kind: 'ready' })
      return Promise.resolve(this.dir(id))
    }
    let job = this.inflight.get(id)
    if (!job) {
      const controller = new AbortController()
      const promise = this.install(id, controller.signal).finally(() => this.inflight.delete(id))
      promise.catch(() => undefined)
      job = { promise, controller, waiters: 0 }
      this.inflight.set(id, job)
    }
    const shared = job
    shared.waiters++
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        if (--shared.waiters === 0) shared.controller.abort()
        reject(abortError())
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      shared.promise.then(
        (dir) => {
          opts.signal?.removeEventListener('abort', onAbort)
          if (settled) return
          settled = true
          shared.waiters--
          resolve(dir)
        },
        (e: unknown) => {
          opts.signal?.removeEventListener('abort', onAbort)
          if (settled) return
          settled = true
          shared.waiters--
          reject(e)
        },
      )
    })
  }

  /** Cancels an in-flight download for every caller; the partial files stay for a later resume. */
  cancel(id: ModelId | string): void {
    this.inflight.get(id)?.controller.abort()
  }

  cancelAll(): void {
    for (const job of this.inflight.values()) job.controller.abort()
  }

  async remove(id: ModelId | string): Promise<void> {
    this.cancel(id)
    await this.inflight.get(id)?.promise.catch(() => undefined)
    await fs.rm(this.dir(id), { recursive: true, force: true })
    await fs.rm(this.stagingDir(id), { recursive: true, force: true })
    this.setState(id, { kind: 'notInstalled' })
  }

  private async install(id: string, signal: AbortSignal): Promise<string> {
    const m = this.manifest(id)
    const staging = this.stagingDir(id)
    const filesDir = path.join(staging, 'files')
    const total = Math.max(1, manifestBytes(m))
    let done = 0
    let lastEmit = 0
    const progress = (received: number) => {
      const now = Date.now()
      if (now - lastEmit < 100 && received < total) return
      lastEmit = now
      this.setState(id, { kind: 'downloading', fraction: Math.min(1, (done + received) / total) })
    }
    try {
      this.setState(id, { kind: 'downloading', fraction: 0 })
      await fs.mkdir(filesDir, { recursive: true })
      for (const f of m.files) {
        const finished = path.join(filesDir, f.path)
        const partial = `${finished}.part`
        await fs.mkdir(path.dirname(finished), { recursive: true })
        const st = existsSync(finished) ? statSync(finished) : null
        if (!(st && st.size === f.bytes)) {
          await downloadFile({ url: f.url, bytes: f.bytes, sha256: f.sha256, name: path.basename(f.path) }, partial, {
            fetch: this.opts.fetch,
            signal,
            retries: this.opts.retries,
            retryDelayMs: this.opts.retryDelayMs,
            onProgress: (received) => progress(received),
          })
          await fs.rename(partial, finished)
        }
        done += f.bytes
        progress(0)
      }
      this.setState(id, { kind: 'preparing' })
      const out = path.join(staging, 'out')
      await fs.rm(out, { recursive: true, force: true })
      await fs.mkdir(out, { recursive: true })
      for (const f of m.files) {
        const file = path.join(filesDir, f.path)
        if (f.extract) await untar(file, out, f.extract, signal)
        else {
          await fs.mkdir(path.dirname(path.join(out, f.path)), { recursive: true })
          await fs.rename(file, path.join(out, f.path))
        }
      }
      await fs.writeFile(path.join(out, 'spec.json'), JSON.stringify({ id: m.id, ...m.spec, files: pins(m) }, null, 2))
      if (signal.aborted) throw abortError()
      const final = this.dir(id)
      await fs.rm(final, { recursive: true, force: true })
      await fs.mkdir(path.dirname(final), { recursive: true })
      await fs.rename(out, final)
      await fs.rm(staging, { recursive: true, force: true })
      this.setState(id, { kind: 'ready' })
      return final
    } catch (e) {
      if (isAbort(e) || signal.aborted) {
        this.setState(id, { kind: 'notInstalled' })
        throw abortError()
      }
      const message = e instanceof DownloadError || e instanceof ModelInstallError ? e.message : e instanceof Error ? e.message : String(e)
      this.setState(id, { kind: 'failed', message })
      throw new ModelInstallError(message)
    }
  }
}
