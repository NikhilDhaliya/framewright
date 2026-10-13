/**
 * Generation service (spec 06 §B4–B6, §B12.0): placeholders, reference preparation, provider jobs, monitoring,
 * download into `<package>/media/gen-<8>.<ext>`, status persistence, resume after reopen and cancellation.
 *
 * The document is snapshot-undoable, so the service keeps the authoritative state of every asset it owns and
 * re-applies it when an undo/redo restores a stale copy (a finished asset that reappears as "generating").
 */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { isUsableRoute, type ByokRoute, type CatalogEntry } from '../../core/generation/catalog'
import type { ByokJobHandle, GenerationParams } from '../../core/generation/params'
import { byokJobOf, failedStatus, isForeignJob, isInFlight, parseStatus, resultURLsOf } from '../../core/generation/status'
import { hasTrim, type TrimmedSource } from '../../core/generation/validation'
import { bundledEntries } from '../../core/generation/catalog'
import { clipTypeForExtension, newId, type ClipType, type GenerationInput, type MediaManifestEntry } from '../../core/model'
import type { Doc } from '../../core/ops/context'
import { addMediaEntries, updateMediaEntry } from '../../core/ops/project'
import { installPackageMedia, sourceForPath } from '../project/packageIO'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { appDirs } from '../paths'
import { notifyGenerationComplete } from '../notifications'
import { createAdapter } from './providers/index'
import { isInlineRef } from './providers/inline'
import { ProviderError, type Output, type ProviderAdapter } from './providers/types'
import { convertImageToJpeg, extractTrimmedRange } from './preprocess'
import { UploadCache } from './uploadCache'
import { APP_NAME } from '../../shared/brand'

/** Mac reference date (2001-01-01) offset for `createdAt` (01 §5.14 RefDate). */
const REF_DATE_OFFSET = 978307200
export const refDateNow = (): number => Date.now() / 1000 - REF_DATE_OFFSET

const RESULT_MAX_BYTES = 5 * 1024 ** 3

export const CANCELLED_MESSAGE = 'Generation cancelled'

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  aiff: 'audio/aiff', aif: 'audio/aiff', aifc: 'audio/aiff', caf: 'audio/x-caf', flac: 'audio/flac',
}
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/flac': 'flac',
}

/** Content type for an upload (§B4.2). */
export function contentTypeFor(file: string, type: ClipType): string {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  if (type === 'image') return 'image/jpeg'
  if (type === 'video' || type === 'sequence') return 'video/mp4'
  if (type === 'audio') return 'audio/mpeg'
  if (type === 'lottie') return 'application/json'
  return 'application/octet-stream'
}

class Semaphore {
  private active = 0
  private waiters: (() => void)[] = []
  constructor(private readonly limit: number) {}
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR')

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** What `generate` needs (Mac `GenerationService.generate`, §B4.1). */
export interface GenerationJobSpec {
  session: ProjectSession
  entry: CatalogEntry
  route: ByokRoute
  genInput: GenerationInput
  assetType: ClipType
  fileExtension: string
  placeholderDuration: number
  /** Library assets to upload, in slot order (§B4.3). */
  references: MediaManifestEntry[]
  trim?: TrimmedSource | null
  preprocessSourceVideo?: (file: string, signal: AbortSignal) => Promise<string | null>
  preprocessRef?: (index: number, ref: MediaManifestEntry, file: string, signal: AbortSignal) => Promise<string | null>
  numImages?: number
  name?: string
  folderId?: string | null
  buildParams: (uploaded: string[]) => GenerationParams
  snapshotRefs?: (input: GenerationInput, uploaded: string[]) => GenerationInput
  /** Undo step that adds the placeholders (and `place`'s edits). */
  undoLabel: string
  place?: (draft: Doc, placeholderIds: string[]) => void
  onComplete?: (asset: MediaManifestEntry) => void
  onFailure?: () => void
}

interface Job {
  id: string
  session: ProjectSession
  entry: CatalogEntry | null
  route: ByokRoute | null
  ids: string[]
  handle: ByokJobHandle | null
  abort: AbortController
  done: boolean
  /** Downloads/installs still running after the provider finished. */
  finalizing?: boolean
  /** Results that arrived while none of the placeholders was in the library (Q-B5). */
  pendingOutputs: Output[] | null
  onComplete?: (asset: MediaManifestEntry) => void
  onFailure?: () => void
}

/** Fields the service owns on an asset it generates. */
type OwnedPatch = Pick<MediaManifestEntry, 'source' | 'type' | 'duration' | 'hasAudio' | 'sourceWidth' | 'sourceHeight' | 'sourceFPS' | 'generationStatus' | 'generationInput'>

interface Tracked {
  job: Job
  /** Latest state the service wrote. */
  patch: Partial<OwnedPatch>
}

export interface GenerationServiceOptions {
  /** Poll interval by elapsed time (default 2 s for the first minute, then 5 s). */
  pollDelay?: (elapsedMs: number) => number
  /** Adapter per provider; default builds fal / Google / ElevenLabs adapters from the settings keys (env base URLs in tests). */
  adapter?: (provider: string) => ProviderAdapter | null
  falBases?: { queueBase: string; restBase: string } | null
  uploadCacheFile?: string
  fetch?: typeof fetch
  entries?: CatalogEntry[]
}

export class GenerationService {
  private readonly jobs = new Map<string, Job>()
  private readonly tracked = new Map<string, Tracked>()
  private readonly attached = new Map<ProjectSession, () => void>()
  private readonly prepareGate = new Semaphore(3)
  private readonly downloadGate = new Semaphore(3)
  private readonly uploads: UploadCache
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly app: AppContext,
    private readonly opts: GenerationServiceOptions = {},
  ) {
    this.uploads = new UploadCache(opts.uploadCacheFile ?? path.join(appDirs.cache, 'generation-uploads.json'))
    this.fetchImpl = opts.fetch ?? fetch
  }

  private adapterFor(provider: string): ProviderAdapter | null {
    if (this.opts.adapter) return this.opts.adapter(provider)
    return createAdapter(provider, this.app.settings().apiKeys, { fetch: this.opts.fetch, falBases: this.opts.falBases })
  }

  private pollDelay(elapsed: number): number {
    return this.opts.pollDelay ? this.opts.pollDelay(elapsed) : elapsed < 60_000 ? 2000 : 5000
  }

  // ---------- Document writes ----------

  private entryOf(session: ProjectSession, id: string): MediaManifestEntry | undefined {
    return session.doc.manifest.entries.find((e) => e.id === id)
  }

  /** Non-undoable metadata write, persisted (checkpoint autosave). */
  private writeQuietly(session: ProjectSession, fn: (d: Doc) => void, save = true): void {
    if (session.closed) return
    const out = session.transact('Update Media', fn, false)
    if (save && out.ok && out.changed) void session.save().catch(() => undefined)
  }

  /** Records the owned state of `id` and writes it into the document if the asset is present. */
  private setState(job: Job, id: string, patch: Partial<OwnedPatch>, save = true): void {
    const t = this.tracked.get(id)
    const merged: Partial<OwnedPatch> = { ...(t?.patch ?? {}), ...patch }
    this.tracked.set(id, { job, patch: merged })
    if (!this.entryOf(job.session, id)) return
    this.writeQuietly(
      job.session,
      (d) => {
        if (d.manifest.entries.some((e) => e.id === id)) updateMediaEntry(d, id, patch)
      },
      save,
    )
  }

  private setStatus(job: Job, id: string, status: string | undefined, save = true): void {
    this.setState(job, id, { generationStatus: status }, save)
  }

  private updateInput(job: Job, id: string, fn: (input: GenerationInput) => GenerationInput, save = true): void {
    const current = this.tracked.get(id)?.patch.generationInput ?? this.entryOf(job.session, id)?.generationInput
    if (!current) return
    this.setState(job, id, { generationInput: fn(current) }, save)
  }

  private failAll(job: Job, message: string): void {
    job.done = true
    for (const id of job.ids) this.setStatus(job, id, failedStatus(message))
    job.onFailure?.()
  }

  // ---------- Session lifecycle ----------

  /** Starts watching a session: reconciles undo/redo and resumes persisted jobs (§B5). Idempotent. */
  attach(session: ProjectSession): void {
    if (this.attached.has(session) || session.closed) return
    const onChange = () => this.reconcile(session)
    session.on('change', onChange)
    this.attached.set(session, () => session.off('change', onChange))
    void this.restore(session)
  }

  /** Forgets closed sessions; jobs whose placeholders are gone for good are cancelled at the provider. */
  sweepClosed(): void {
    for (const [session, off] of this.attached) {
      if (!session.closed) continue
      off()
      this.attached.delete(session)
      this.closeJobs(session)
    }
  }

  private closeJobs(session: ProjectSession): void {
    for (const job of this.jobs.values()) {
      if (job.session !== session) continue
      const present = job.ids.some((id) => this.entryOf(session, id))
      job.abort.abort()
      if (!job.done && !present && job.handle) void this.adapterFor(job.handle.provider)?.cancel?.(job.handle)
      this.jobs.delete(job.id)
    }
    for (const [id, t] of this.tracked) if (t.job.session === session) this.tracked.delete(id)
  }

  private reconcile(session: ProjectSession): void {
    for (const [id, t] of this.tracked) {
      if (t.job.session !== session) continue
      const e = this.entryOf(session, id)
      if (!e) continue
      const job = t.job
      if (!job.done) {
        const want = t.patch
        const statusDiffers = want.generationStatus !== e.generationStatus
        const inputDiffers = want.generationInput !== undefined && JSON.stringify(want.generationInput) !== JSON.stringify(e.generationInput)
        if (statusDiffers || inputDiffers) {
          const patch: Partial<OwnedPatch> = { generationStatus: want.generationStatus }
          if (inputDiffers) patch.generationInput = want.generationInput
          this.writeQuietly(session, (d) => updateMediaEntry(d, id, patch), false)
        }
        continue
      }
      if (job.pendingOutputs && isInFlight(e.generationStatus)) {
        const outputs = job.pendingOutputs
        job.pendingOutputs = null
        job.done = false
        void this.finalize(job, outputs)
        continue
      }
      if (isInFlight(e.generationStatus) && t.patch.generationStatus !== e.generationStatus) {
        this.writeQuietly(session, (d) => updateMediaEntry(d, id, t.patch), false)
      }
    }
  }

  private async fileExists(session: ProjectSession, e: MediaManifestEntry): Promise<boolean> {
    const p = session.resolveMedia(e)
    return !!p && (await fs.stat(p).then((s) => s.isFile() && s.size > 0).catch(() => false))
  }

  /** Project-open restore (01 §1.9 + §B5.2): settle stale statuses, resume Linux jobs, leave Mac jobs alone. */
  private async restore(session: ProjectSession): Promise<void> {
    const groups = new Map<string, MediaManifestEntry[]>()
    for (const e of session.doc.manifest.entries) {
      const input = e.generationInput
      if (!input || isForeignJob(e) || this.tracked.has(e.id)) continue
      const status = parseStatus(e.generationStatus)
      if (status.kind === 'none') continue
      const handle = byokJobOf(input)
      if (await this.fileExists(session, e)) {
        if (status.kind !== 'failed') this.writeQuietly(session, (d) => updateMediaEntry(d, e.id, { generationStatus: undefined }))
        continue
      }
      const recover = status.kind === 'failed' ? resultURLsOf(input).length > 0 : true
      if (!handle) {
        if (status.kind !== 'failed') this.writeQuietly(session, (d) => updateMediaEntry(d, e.id, { generationStatus: undefined }))
        continue
      }
      if (!recover) continue
      const key = `${handle.provider}|${handle.requestId}`
      groups.set(key, [...(groups.get(key) ?? []), e])
    }
    for (const entries of groups.values()) {
      entries.sort((a, b) => Number(a.generationInput?.outputIndex ?? 0) - Number(b.generationInput?.outputIndex ?? 0))
      const input = entries[0].generationInput!
      const handle = byokJobOf(input)!
      const entry = bundledEntriesFor(this.opts.entries).find((m) => m.id === input.model || m.aliases?.includes(String(input.model))) ?? null
      const job: Job = {
        id: randomUUID(),
        session,
        entry,
        route: entry?.byok?.routes.find((r) => r.provider === handle.provider && isUsableRoute(r)) ?? null,
        ids: entries.map((e) => e.id),
        handle,
        abort: new AbortController(),
        done: false,
        pendingOutputs: null,
      }
      this.jobs.set(job.id, job)
      for (const e of entries) this.setState(job, e.id, { generationStatus: 'generating', generationInput: e.generationInput }, false)
      const stored = resultURLsOf(entries[0].generationInput)
      if (stored.length) void this.finalize(job, stored.map((url) => ({ url })))
      else void this.monitor(job)
    }
  }

  // ---------- Submission ----------

  /** Creates the placeholders (one undo step) and runs the job in the background. Returns the placeholder ids. */
  generate(spec: GenerationJobSpec): string[] {
    const { session } = spec
    const count = Math.max(1, Math.min(4, Math.trunc(spec.numImages ?? 1)))
    const baseName = spec.name ?? [...spec.genInput.prompt].slice(0, 30).join('')
    const folderId = spec.folderId && session.doc.manifest.folders.some((f) => f.id === spec.folderId) ? spec.folderId : undefined
    const entries: MediaManifestEntry[] = []
    for (let k = 0; k < count; k++) {
      const id = newId()
      const e: MediaManifestEntry = {
        id,
        name: baseName,
        type: spec.assetType,
        source: { project: { relativePath: `media/gen-${id.slice(0, 8)}.${spec.fileExtension}` } },
        duration: spec.placeholderDuration,
        hasAudio: false,
        generationInput: { ...spec.genInput, outputIndex: k },
        generationStatus: 'preparing',
      }
      if (folderId) e.folderId = folderId
      entries.push(e)
    }
    const ids = entries.map((e) => e.id)
    const out = session.transact(spec.undoLabel, (d) => {
      addMediaEntries(d, entries)
      spec.place?.(d, ids)
    })
    if (!out.ok) throw new Error(out.error)
    this.attach(session)
    const job: Job = {
      id: randomUUID(),
      session,
      entry: spec.entry,
      route: spec.route,
      ids,
      handle: null,
      abort: new AbortController(),
      done: false,
      pendingOutputs: null,
      onComplete: spec.onComplete,
      onFailure: spec.onFailure,
    }
    this.jobs.set(job.id, job)
    for (const e of entries) this.tracked.set(e.id, { job, patch: { generationStatus: 'preparing', generationInput: e.generationInput } })
    void this.run(job, spec)
    return ids
  }

  private async run(job: Job, spec: GenerationJobSpec): Promise<void> {
    const adapter = this.adapterFor(spec.route.provider)
    if (!adapter) return this.failAll(job, 'Backend not configured')
    let submitted = false
    await this.prepareGate.use(async () => {
      let uploaded: string[]
      try {
        uploaded = await this.prepareReferences(job, spec, adapter)
      } catch (e) {
        if (job.abort.signal.aborted) return
        return this.failAll(job, `Upload failed: ${errorText(e)}`)
      }
      if (job.abort.signal.aborted) return
      const base = spec.snapshotRefs ? spec.snapshotRefs({ ...spec.genInput }, uploaded) : { ...spec.genInput, imageURLs: uploaded.length ? uploaded : undefined }
      if (base.imageURLs === undefined) delete base.imageURLs
      if (base.createdAt === undefined) base.createdAt = refDateNow()
      job.ids.forEach((id, k) => this.updateInput(job, id, () => ({ ...base, outputIndex: k }), false))
      let result: Awaited<ReturnType<ProviderAdapter['submit']>>
      try {
        result = await adapter.submit(spec.entry, spec.route, spec.buildParams(uploaded), job.abort.signal)
      } catch (e) {
        if (job.abort.signal.aborted) return
        return this.failAll(job, errorText(e))
      }
      submitted = true
      if ('outputs' in result) {
        void this.finalize(job, result.outputs)
        return
      }
      job.handle = result.handle
      job.ids.forEach((id) => {
        this.updateInput(job, id, (input) => ({ ...input, byokJob: result.handle }), false)
        this.setStatus(job, id, 'generating')
      })
    })
    if (submitted && job.handle && !job.done) await this.monitor(job)
  }

  /** §B4.2: trim → source preprocess → per-ref preprocess → upload (cached), in input order; temp files removed. */
  private async prepareReferences(job: Job, spec: GenerationJobSpec, adapter: ProviderAdapter): Promise<string[]> {
    const signal = job.abort.signal
    const temps: string[] = []
    try {
      const files = spec.references.map((r) => job.session.resolveMedia(r))
      const touched = files.map(() => false)
      files.forEach((f, i) => {
        if (!f) throw new Error(`Media file not on disk: ${spec.references[i].name}`)
      })
      const paths = files as string[]
      const trim = spec.trim
      if (hasTrim(trim)) {
        const i = paths.indexOf(trim.sourcePath)
        if (i >= 0) {
          paths[i] = await extractTrimmedRange(trim, signal)
          temps.push(paths[i])
          touched[i] = true
        }
      }
      if (spec.preprocessSourceVideo && paths.length) {
        const out = await spec.preprocessSourceVideo(paths[0], signal)
        if (out) {
          paths[0] = out
          temps.push(out)
          touched[0] = true
        }
      }
      if (spec.preprocessRef) {
        await Promise.all(
          paths.map(async (p, i) => {
            const out = await spec.preprocessRef!(i, spec.references[i], p, signal)
            if (out) {
              paths[i] = out
              temps.push(out)
              touched[i] = true
            }
          }),
        )
      }
      return await Promise.all(
        paths.map(async (p, i) => {
          const ref = spec.references[i]
          let file = p
          const ext = path.extname(file).slice(1).toLowerCase()
          if (ref.type === 'image' && ['heic', 'heif', 'tiff', 'tif'].includes(ext)) {
            file = await convertImageToJpeg(file, signal)
            temps.push(file)
            touched[i] = true
          }
          const provider = spec.route.provider
          if (!touched[i]) {
            const hit = await this.uploads.get(file, provider)
            if (hit) return hit
          }
          const st = await fs.stat(file)
          const url = await adapter.prepareInput({ path: file, mime: contentTypeFor(file, ref.type), size: st.size }, signal)
          // In-memory inline refs (Google, ElevenLabs) are per request and never cached.
          if (!touched[i] && !isInlineRef(url)) await this.uploads.put(file, provider, url)
          return url
        }),
      )
    } finally {
      await Promise.all(temps.map((t) => fs.rm(t, { force: true })))
    }
  }

  // ---------- Monitoring ----------

  private async monitor(job: Job): Promise<void> {
    const handle = job.handle
    if (!handle) return
    const adapter = this.adapterFor(handle.provider)
    if (!adapter) return
    const started = Date.now()
    const signal = job.abort.signal
    for (;;) {
      if (job.session.closed || signal.aborted || job.done) return
      try {
        await sleep(this.pollDelay(Date.now() - started), signal)
      } catch {
        return
      }
      if (job.session.closed) return
      let r: Awaited<ReturnType<ProviderAdapter['poll']>>
      try {
        r = await adapter.poll(handle, signal)
      } catch (e) {
        if (isAbort(e) || signal.aborted) return
        // Transient provider/network errors: keep polling (the job is persisted and resumes on reopen anyway).
        continue
      }
      if (r.state === 'queued' || r.state === 'running') {
        for (const id of job.ids) {
          const e = this.entryOf(job.session, id)
          if (e?.generationStatus !== 'downloading' && this.tracked.get(id)?.patch.generationStatus !== 'generating') this.setStatus(job, id, 'generating')
        }
        continue
      }
      if (r.state === 'failed') return this.failAll(job, r.message || 'Generation failed')
      if (r.state === 'succeeded') return this.finalize(job, r.outputs)
    }
  }

  // ---------- Finalize (§B4.5) ----------

  private async finalize(job: Job, outputs: Output[]): Promise<void> {
    if (!outputs.length) return this.failAll(job, 'No URL in response')
    const present = job.ids.filter((id) => this.entryOf(job.session, id))
    if (!present.length) {
      // Deleted (or undone) while running: keep the result until an undo brings a placeholder back (Q-B5).
      job.done = true
      job.pendingOutputs = outputs
      return
    }
    job.done = true
    job.finalizing = true
    try {
      await this.finishOutputs(job, outputs)
    } finally {
      job.finalizing = false
    }
  }

  private async finishOutputs(job: Job, outputs: Output[]): Promise<void> {
    const urls = outputs.flatMap((o) => ('url' in o ? [o.url] : []))
    const finished: MediaManifestEntry[] = []
    await Promise.all(
      job.ids.map(async (id, position) => {
        const e = this.entryOf(job.session, id)
        const k = Number(e?.generationInput?.outputIndex ?? position)
        const out = outputs[k]
        if (!out) {
          this.setStatus(job, id, failedStatus('No URL for placeholder'))
          return
        }
        this.updateInput(job, id, (input) => {
          const next = { ...input }
          if (urls.length) next.resultURLs = urls
          return next
        }, false)
        this.setStatus(job, id, 'downloading')
        const asset = await this.downloadGate.use(() => this.install(job, id, out))
        if (asset) finished.push(asset)
      }),
    )
    if (!finished.length) return job.onFailure?.()
    for (const a of finished) job.onComplete?.(a)
    const ready = readyMessage(finished)
    this.app.ui(job.session, { type: 'toast', message: ready })
    notifyGenerationComplete(job.session, finished, ready)
  }

  /** Downloads one output into the package and finalizes the placeholder; null on failure (status set). */
  private async install(job: Job, id: string, out: Output): Promise<MediaManifestEntry | null> {
    const session = job.session
    const entry = this.entryOf(session, id)
    const relative = entry && 'project' in entry.source ? entry.source.project.relativePath : `media/gen-${id.slice(0, 8)}.bin`
    let filename = path.basename(relative)
    const stage = path.join(os.tmpdir(), `framewright-stage-${randomUUID()}`)
    try {
      let ext: string | null = null
      if ('url' in out) {
        await this.download(out.url, stage, out.headers ?? {}, job.abort.signal)
        try {
          ext = path.extname(decodeURIComponent(new URL(out.url).pathname)).slice(1).toLowerCase() || null
        } catch {
          ext = null
        }
      } else {
        await fs.writeFile(stage, out.bytes)
        ext = EXT_BY_MIME[out.mime.toLowerCase()] ?? null
      }
      const current = path.extname(filename).slice(1).toLowerCase()
      if (ext && ext !== current && clipTypeForExtension(ext)) filename = `${path.basename(filename, path.extname(filename))}.${ext}`
      if (session.closed) return null
      // Q-B2: install into the package the session points at *now* (Save As may have moved it).
      const dest = await installPackageMedia(session.path, filename, { copyFrom: stage })
      let probe
      try {
        probe = await this.app.media.probe(dest)
      } catch {
        this.setStatus(job, id, failedStatus('Could not read media file.'))
        return null
      }
      const placeholderType = this.entryOf(session, id)?.type ?? entry?.type ?? probe.type
      const type: ClipType = placeholderType === 'audio' && probe.hasAudio ? 'audio' : probe.type
      const patch: Partial<OwnedPatch> = {
        source: sourceForPath(dest, session.path),
        type,
        duration: probe.duration,
        hasAudio: type === 'audio' ? true : type === 'video' ? probe.hasAudio : false,
        sourceWidth: type === 'audio' ? undefined : probe.width,
        sourceHeight: type === 'audio' ? undefined : probe.height,
        sourceFPS: type === 'video' ? probe.fps : undefined,
        generationStatus: undefined,
      }
      this.setState(job, id, patch)
      return this.entryOf(session, id) ?? null
    } catch (e) {
      if (session.closed) return null
      this.setStatus(job, id, failedStatus(errorText(e)))
      return null
    } finally {
      await fs.rm(stage, { force: true })
    }
  }

  private async download(url: string, dest: string, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      const meta = url.slice(5, comma)
      const data = url.slice(comma + 1)
      await fs.writeFile(dest, meta.endsWith(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data)))
      return
    }
    const res = await this.fetchImpl(url, { headers, signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new ProviderError(`Download failed (HTTP ${res.status})`)
    let total = 0
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length
        cb(total > RESULT_MAX_BYTES ? new Error('Download is too large') : null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), limit, createWriteStream(dest))
  }

  // ---------- Public controls ----------

  /** Uploads a local file for `provider` (e.g. a rendered timeline span, §B8 / `generate_audio`). */
  async uploadFile(provider: string, file: string, type: ClipType): Promise<string> {
    const adapter = this.adapterFor(provider)
    if (!adapter) throw new Error('Backend not configured')
    const st = await fs.stat(file)
    return adapter.prepareInput({ path: file, mime: contentTypeFor(file, type), size: st.size })
  }

  /** Cancels the job behind `assetId` (provider cancel when supported); its placeholders fail as cancelled. */
  async cancel(session: ProjectSession, assetId: string): Promise<boolean> {
    const t = this.tracked.get(assetId)
    if (!t || t.job.session !== session || t.job.done) return false
    const job = t.job
    job.abort.abort()
    if (job.handle) await this.adapterFor(job.handle.provider)?.cancel?.(job.handle)
    this.failAll(job, CANCELLED_MESSAGE)
    return true
  }

  /** Retry Download (§B4.5): re-fetch the stored result URL of a failed asset. */
  async retryDownload(session: ProjectSession, assetId: string): Promise<boolean> {
    const e = this.entryOf(session, assetId)
    const urls = resultURLsOf(e?.generationInput)
    if (!e || parseStatus(e.generationStatus).kind !== 'failed' || !urls.length) return false
    const k = Number(e.generationInput?.outputIndex ?? 0)
    const url = urls[k] ?? urls[0]
    const job: Job = { id: randomUUID(), session, entry: null, route: null, ids: [assetId], handle: byokJobOf(e.generationInput), abort: new AbortController(), done: true, pendingOutputs: null }
    this.jobs.set(job.id, job)
    this.setStatus(job, assetId, 'downloading')
    job.finalizing = true
    try {
      const asset = await this.downloadGate.use(() => this.install(job, assetId, { url }))
      if (asset) this.app.ui(session, { type: 'toast', message: readyMessage([asset]) })
      return !!asset
    } finally {
      job.finalizing = false
    }
  }

  /** Jobs still running (for tests and diagnostics). */
  activeJobCount(session?: ProjectSession): number {
    return [...this.jobs.values()].filter((j) => (!j.done || j.finalizing) && (!session || j.session === session)).length
  }

  /** Resolves once every job of `session` reached a terminal state (tests). */
  async idle(session: ProjectSession, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.activeJobCount(session) > 0) {
      if (Date.now() > deadline) throw new Error('generation jobs did not finish')
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

const bundledEntriesFor = (entries?: CatalogEntry[]): CatalogEntry[] => entries ?? bundledEntries()

const NOUNS: Record<string, [string, string]> = {
  video: ['video', 'videos'],
  audio: ['audio clip', 'audio clips'],
  image: ['image', 'images'],
  text: ['text clip', 'text clips'],
  lottie: ['Lottie animation', 'Lottie animations'],
  subtitle: ['subtitle file', 'subtitle files'],
}

/** Completion message (`AppNotifications.swift:133-154`). */
export function readyMessage(assets: MediaManifestEntry[]): string {
  if (assets.length > 1) return `${assets.length} ${(NOUNS[assets[0].type] ?? NOUNS.video)[1]} are ready in ${APP_NAME}.`
  const a = assets[0]
  return a.name ? `${a.name} is ready.` : `Your ${(NOUNS[a.type] ?? NOUNS.video)[0]} is ready.`
}

// ---------- One service per app context ----------

const services = new WeakMap<AppContext, GenerationService>()

export function generationService(app: AppContext): GenerationService {
  let s = services.get(app)
  if (!s) {
    s = new GenerationService(app)
    services.set(app, s)
  }
  return s
}

/** Installs a configured service for `app` (tests: fast polling, fake providers). */
export function setGenerationService(app: AppContext, service: GenerationService): void {
  services.set(app, service)
}
