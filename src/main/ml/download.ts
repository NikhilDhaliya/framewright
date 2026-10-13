/** Resumable, verified file download (spec 07 §0.2). Used by the model manager; injectable fetch for tests and proxies. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

export type FetchLike = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' }) => Promise<Response>

export type DownloadErrorKind = 'http' | 'checksum' | 'size' | 'network'

/** `ModelDownloader.Error`: httpError(status, file), checksumMismatch(file), plus Linux network/size failures. */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: DownloadErrorKind,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

export interface DownloadSpec {
  url: string
  /** Expected size; enables size checks and progress before Content-Length arrives. */
  bytes?: number
  /** Lowercase hex sha256 of the whole file. */
  sha256?: string
  /** Name used in error messages. */
  name?: string
}

export interface DownloadOptions {
  fetch?: FetchLike
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
  /** Attempts after the first for network errors and 5xx (default 3). */
  retries?: number
  retryDelayMs?: number
}

const abortError = () => new DOMException('Aborted', 'AbortError')
const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const fileSize = (p: string) => fs.stat(p).then((s) => s.size, () => 0)

/** sha256 of a file, read in 1 MiB chunks (the Mac verifier's chunk size). */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    if (signal?.aborted) throw abortError()
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Downloads `spec.url` into `partialPath`, resuming from bytes already there (HTTP Range), retrying transient
 * failures, then verifying size and sha256. A checksum or size mismatch deletes the partial file; a cancellation keeps it.
 */
export async function downloadFile(spec: DownloadSpec, partialPath: string, opts: DownloadOptions = {}): Promise<void> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const name = spec.name ?? spec.url.split('/').pop() ?? spec.url
  const retries = opts.retries ?? 3
  let offset = await fileSize(partialPath)
  if (spec.bytes !== undefined && offset > spec.bytes) {
    await fs.rm(partialPath, { force: true })
    offset = 0
  }
  let total = spec.bytes ?? 0
  let attempt = 0
  for (;;) {
    if (opts.signal?.aborted) throw abortError()
    if (spec.bytes !== undefined && offset === spec.bytes) break
    try {
      const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {}
      const res = await doFetch(spec.url, { headers, signal: opts.signal, redirect: 'follow' })
      if (res.status === 416 && offset > 0) {
        // The partial file already holds the whole body (or is stale): verify below or restart.
        await res.body?.cancel().catch(() => undefined)
        if (spec.bytes === undefined || offset === spec.bytes) break
        await fs.rm(partialPath, { force: true })
        offset = 0
        continue
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        const err = new DownloadError(`HTTP ${res.status} downloading ${name}`, 'http', res.status)
        if (res.status >= 500 && attempt < retries) throw Object.assign(err, { retryable: true })
        throw err
      }
      if (offset > 0 && res.status !== 206) {
        // The server ignored the Range header: start over.
        offset = 0
      }
      const length = Number(res.headers.get('content-length'))
      if (!spec.bytes && Number.isFinite(length) && length > 0) total = offset + length
      const file = await fs.open(partialPath, offset > 0 ? 'a' : 'w')
      try {
        if (!res.body) throw new DownloadError(`Empty response downloading ${name}`, 'network')
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          await file.write(value)
          offset += value.byteLength
          opts.onProgress?.(offset, Math.max(total, offset))
        }
      } finally {
        await file.close()
      }
      if (spec.bytes !== undefined && offset < spec.bytes) throw Object.assign(new DownloadError(`Download of ${name} ended early`, 'network'), { retryable: true })
      break
    } catch (e) {
      if (isAbort(e) || opts.signal?.aborted) throw abortError()
      const retryable = (e as { retryable?: boolean }).retryable === true || !(e instanceof DownloadError)
      if (!retryable || attempt >= retries) {
        if (e instanceof DownloadError) throw e
        throw new DownloadError(e instanceof Error ? e.message : String(e), 'network')
      }
      attempt++
      offset = await fileSize(partialPath)
      await delay((opts.retryDelayMs ?? 1000) * attempt, opts.signal)
    }
  }
  const size = await fileSize(partialPath)
  if (spec.bytes !== undefined && size !== spec.bytes) {
    await fs.rm(partialPath, { force: true })
    throw new DownloadError(`Size mismatch for ${name}: expected ${spec.bytes} bytes, got ${size}`, 'size')
  }
  if (spec.sha256) {
    const digest = await sha256File(partialPath, opts.signal)
    if (digest !== spec.sha256.toLowerCase()) {
      await fs.rm(partialPath, { force: true })
      throw new DownloadError(`Checksum mismatch for ${name}`, 'checksum')
    }
  }
}
