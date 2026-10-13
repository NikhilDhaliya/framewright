/** Line-based SSE reading for the provider adapters (spec 06 §A6.3, §A7.3, §A16.3). */

export const IDLE_TIMEOUT_MS = 600_000
export const TIMEOUT_MESSAGE = 'The request timed out.'

/** Thrown when a run is cancelled (Stop, new chat, abort); never shown as an error banner. */
export class AgentCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'AgentCancelled'
  }
}

export const isAbortError = (e: unknown): boolean =>
  e instanceof AgentCancelled || (e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR'))

/** Splits a byte stream into lines (`\n`, `\r\n` or `\r`), keeping partial lines across chunks. */
export async function* splitLines(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buf = ''
  let pendingCR = false
  for await (const chunk of chunks) {
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    if (pendingCR && text.startsWith('\n')) text = text.slice(1)
    pendingCR = false
    buf += text
    let start = 0
    for (let i = 0; i < buf.length; i++) {
      const ch = buf.charCodeAt(i)
      if (ch !== 10 && ch !== 13) continue
      yield buf.slice(start, i)
      if (ch === 13) {
        if (i + 1 < buf.length) {
          if (buf.charCodeAt(i + 1) === 10) i++
        } else pendingCR = true
      }
      start = i + 1
    }
    buf = buf.slice(start)
  }
  const tail = buf + decoder.decode()
  if (tail) yield tail
}

/** Payloads of `data:` lines (prefix and surrounding whitespace stripped). */
export async function* dataPayloads(lines: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of lines) {
    if (line.startsWith('data:')) yield line.slice(5).trim()
  }
}

/**
 * Reads a fetch body chunk by chunk. A gap longer than `idleMs` between chunks fails with
 * "The request timed out." (the Mac's URLRequest.timeoutInterval); an abort surfaces as AgentCancelled.
 */
export async function* readBody(body: ReadableStream<Uint8Array>, opts: { idleMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS
  let timer: NodeJS.Timeout | null = null
  let onAbort: (() => void) | null = null
  try {
    while (true) {
      if (opts.signal?.aborted) throw new AgentCancelled()
      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), idleMs)
        onAbort = () => reject(new AgentCancelled())
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        reader.read().then(resolve, reject)
      }).finally(() => {
        if (timer) clearTimeout(timer)
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
      })
      if (next.done) return
      yield next.value
    }
  } catch (e) {
    throw isAbortError(e) || opts.signal?.aborted ? new AgentCancelled() : e
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/** POSTs a JSON body and returns the response once headers arrive, mapping HTTP ≥ 400 to `<label> API error (<status>): <body…500>`. */
export async function postForStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  label: string,
  opts: { signal?: AbortSignal; idleMs?: number; fetchImpl?: typeof fetch },
): Promise<ReadableStream<Uint8Array>> {
  const doFetch = opts.fetchImpl ?? fetch
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS
  // The idle timer also covers the wait for response headers.
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), idleMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal
  let res: Response
  try {
    res = await doFetch(url, { method: 'POST', headers, body, signal })
  } catch (e) {
    if (opts.signal?.aborted) throw new AgentCancelled()
    if (timeout.signal.aborted) throw new Error(TIMEOUT_MESSAGE)
    throw e
  } finally {
    clearTimeout(timer)
  }
  if (res.status >= 400) {
    let text = ''
    try {
      text = await res.text()
    } catch (e) {
      if (opts.signal?.aborted) throw new AgentCancelled()
    }
    throw new Error(`${label} API error (${res.status}): ${text.slice(0, 500)}`)
  }
  if (!res.body) throw new Error(`${label} API error (${res.status}): empty response body`)
  return res.body
}

/** Deterministic compact JSON with sorted object keys (keeps the cached prompt prefix byte-stable). */
export function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const obj = value as Record<string, unknown>
    for (const k of Object.keys(obj).sort()) if (obj[k] !== undefined) out[k] = sortKeys(obj[k])
    return out
  }
  return value
}
