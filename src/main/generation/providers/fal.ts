/**
 * fal.ai queue adapter (spec 06 §B12.1): submit → status → result, cancel, and CDN uploads for local references.
 * Base URLs are injectable so tests run against a local fake server; production uses queue.fal.run / rest.fal.ai.
 */
import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ByokRoute, CatalogEntry } from '../../../core/generation/catalog'
import type { ByokJobHandle, GenerationParams } from '../../../core/generation/params'
import { falOutputUrls, falRequest } from './falModels'
import { ProviderError, type LocalInput, type Output, type PollResult, type ProviderAdapter } from './types'

export const FAL_QUEUE_BASE = 'https://queue.fal.run'
export const FAL_REST_BASE = 'https://rest.fal.ai'
/** Files at or below this size are sent inline as data: URIs instead of a CDN upload. */
export const FAL_INLINE_MAX_BYTES = 64 * 1024
export const FAL_MULTIPART_THRESHOLD = 90 * 1024 * 1024
const PART_SIZE = 10 * 1024 * 1024

export interface FalOptions {
  key: string
  queueBase?: string
  restBase?: string
  fetch?: typeof fetch
  inlineMaxBytes?: number
  multipartThreshold?: number
  partSize?: number
}

/** `PALMIER_FAL_BASE_URL=http://127.0.0.1:<port>` points the adapter at a fake server (`/queue`, `/rest`). Tests only. */
export function falBasesFromEnv(env: NodeJS.ProcessEnv = process.env): { queueBase: string; restBase: string } | null {
  const base = env.PALMIER_FAL_BASE_URL?.replace(/\/+$/, '')
  return base ? { queueBase: `${base}/queue`, restBase: `${base}/rest` } : null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The message fal puts in an error body: `detail[0].msg`, `detail`, `error`, or the raw text. */
export function falErrorMessage(status: number, text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (isObj(parsed)) {
    const d = parsed.detail
    if (Array.isArray(d) && isObj(d[0]) && typeof d[0].msg === 'string') return d[0].msg
    if (typeof d === 'string' && d) return d
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message
  }
  if (status === 401 || status === 403) return `fal.ai rejected the API key (HTTP ${status}).`
  const trimmed = text.trim().slice(0, 300)
  return trimmed ? `fal.ai returned HTTP ${status}: ${trimmed}` : `fal.ai returned HTTP ${status}.`
}

export class FalAdapter implements ProviderAdapter {
  private readonly queueBase: string
  private readonly restBase: string
  private readonly fetch: typeof fetch

  constructor(private readonly o: FalOptions) {
    this.queueBase = (o.queueBase ?? FAL_QUEUE_BASE).replace(/\/+$/, '')
    this.restBase = (o.restBase ?? FAL_REST_BASE).replace(/\/+$/, '')
    this.fetch = o.fetch ?? fetch
  }

  private headers(json = true): Record<string, string> {
    return { Authorization: `Key ${this.o.key}`, ...(json ? { 'Content-Type': 'application/json' } : null) }
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text()
    if (!res.ok) throw new ProviderError(falErrorMessage(res.status, text))
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ProviderError('fal.ai returned an unreadable response.')
    }
    if (!isObj(parsed)) throw new ProviderError('fal.ai returned an unexpected response.')
    return parsed
  }

  async prepareInput(file: LocalInput, signal?: AbortSignal): Promise<string> {
    if (file.size <= (this.o.inlineMaxBytes ?? FAL_INLINE_MAX_BYTES)) {
      return `data:${file.mime};base64,${(await readFile(file.path)).toString('base64')}`
    }
    if (file.size > (this.o.multipartThreshold ?? FAL_MULTIPART_THRESHOLD)) return this.uploadMultipart(file, signal)
    const init = await this.json(
      await this.fetch(`${this.restBase}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ content_type: file.mime, file_name: path.basename(file.path) }),
        signal,
      }),
    )
    const uploadUrl = init.upload_url
    const fileUrl = init.file_url
    if (typeof uploadUrl !== 'string' || typeof fileUrl !== 'string') throw new ProviderError('fal.ai did not return an upload URL.')
    const put = await this.fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.mime }, body: await readFile(file.path), signal })
    if (!put.ok) throw new ProviderError(falErrorMessage(put.status, await put.text()))
    return fileUrl
  }

  private async uploadMultipart(file: LocalInput, signal?: AbortSignal): Promise<string> {
    const init = await this.json(
      await this.fetch(`${this.restBase}/storage/upload/initiate-multipart?storage_type=fal-cdn-v3`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ content_type: file.mime, file_name: path.basename(file.path) }),
        signal,
      }),
    )
    const uploadUrl = init.upload_url
    const fileUrl = init.file_url
    if (typeof uploadUrl !== 'string' || typeof fileUrl !== 'string') throw new ProviderError('fal.ai did not return an upload URL.')
    const u = new URL(uploadUrl)
    const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`
    const query = u.search
    const partSize = this.o.partSize ?? PART_SIZE
    const parts: { partNumber: number; etag: string }[] = []
    const fh = await open(file.path, 'r')
    try {
      for (let offset = 0, n = 1; offset < file.size; offset += partSize, n++) {
        const len = Math.min(partSize, file.size - offset)
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, offset)
        const res = await this.fetch(`${base}/${n}${query}`, { method: 'PUT', headers: { 'Content-Type': file.mime }, body: buf, signal })
        if (!res.ok) throw new ProviderError(falErrorMessage(res.status, await res.text()))
        parts.push({ partNumber: n, etag: res.headers.get('etag') ?? '' })
      }
    } finally {
      await fh.close()
    }
    const done = await this.fetch(`${base}/complete${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts }), signal })
    if (!done.ok) throw new ProviderError(falErrorMessage(done.status, await done.text()))
    return fileUrl
  }

  async submit(entry: CatalogEntry, route: ByokRoute, params: GenerationParams, signal?: AbortSignal): Promise<{ handle: ByokJobHandle }> {
    const req = falRequest(entry, route, params)
    const res = await this.json(await this.fetch(`${this.queueBase}/${req.endpoint}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(req.body), signal }))
    const requestId = res.request_id
    if (typeof requestId !== 'string' || !requestId) throw new ProviderError('fal.ai did not accept the job.')
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    return {
      handle: {
        provider: 'fal',
        endpoint: req.endpoint,
        requestId,
        statusUrl: str(res.status_url),
        responseUrl: str(res.response_url),
        cancelUrl: str(res.cancel_url),
        submittedAt: new Date().toISOString(),
      },
    }
  }

  /** fal-js builds request URLs from the app id (first two path segments) when the response omitted them. */
  private requestUrl(handle: ByokJobHandle, suffix: string): string {
    const app = handle.endpoint.split('/').slice(0, 2).join('/')
    return `${this.queueBase}/${app}/requests/${handle.requestId}${suffix}`
  }

  async poll(handle: ByokJobHandle, signal?: AbortSignal): Promise<PollResult> {
    const statusUrl = handle.statusUrl ?? this.requestUrl(handle, '/status')
    const res = await this.fetch(statusUrl, { headers: this.headers(false), signal })
    const text = await res.text()
    if (!res.ok) {
      // Unknown request ids are terminal; transient errors (5xx, rate limits) keep polling.
      if (res.status === 404 || res.status === 401 || res.status === 403 || res.status === 422) return { state: 'failed', message: falErrorMessage(res.status, text) }
      throw new ProviderError(falErrorMessage(res.status, text))
    }
    let status: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObj(parsed)) status = parsed
    } catch {
      throw new ProviderError('fal.ai returned an unreadable status.')
    }
    if (status.status === 'IN_QUEUE') return { state: 'queued' }
    if (status.status === 'IN_PROGRESS') return { state: 'running' }
    if (status.status !== 'COMPLETED') throw new ProviderError(`fal.ai returned an unknown status: ${String(status.status)}`)
    if (typeof status.error === 'string' && status.error) return { state: 'failed', message: status.error }
    const out = await this.fetch(handle.responseUrl ?? this.requestUrl(handle, ''), { headers: this.headers(false), signal })
    const body = await out.text()
    if (!out.ok) return { state: 'failed', message: falErrorMessage(out.status, body) }
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      return { state: 'failed', message: 'fal.ai returned an unreadable result.' }
    }
    const urls = falOutputUrls(json)
    return { state: 'succeeded', outputs: urls.map((url): Output => ({ url })) }
  }

  async cancel(handle: ByokJobHandle): Promise<void> {
    const url = handle.cancelUrl ?? this.requestUrl(handle, '/cancel')
    await this.fetch(url, { method: 'PUT', headers: this.headers(false) }).then((r) => r.body?.cancel()).catch(() => undefined)
  }
}
