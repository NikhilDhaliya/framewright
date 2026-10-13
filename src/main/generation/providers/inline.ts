/**
 * In-memory input refs for providers that take file bytes in the request itself (Google inline base64, ElevenLabs
 * multipart; spec 06 §B12.2). `prepareInput` reads the file once (preprocessed temp files are removed right after)
 * and returns a short opaque ref, so neither the upload cache nor the persisted `generationInput` carries the bytes.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LocalInput } from './types'
import { ProviderError } from './types'

export const INLINE_PREFIX = 'inline:'
/** Kept long enough for a slow submit (and a retry of the same request), then dropped. */
const TTL_MS = 60 * 60 * 1000

export interface InlineFile {
  bytes: Buffer
  mime: string
  name: string
}

const store = new Map<string, InlineFile>()

export const isInlineRef = (ref: string): boolean => ref.startsWith(INLINE_PREFIX)

export async function stashFile(file: LocalInput, maxBytes?: number): Promise<string> {
  if (maxBytes !== undefined && file.size > maxBytes) throw new ProviderError(`${path.basename(file.path)} is too large to send (${Math.round(file.size / 1e6)} MB).`)
  const bytes = await readFile(file.path)
  const id = randomUUID()
  store.set(id, { bytes, mime: file.mime, name: path.basename(file.path) })
  setTimeout(() => store.delete(id), TTL_MS).unref?.()
  return `${INLINE_PREFIX}${id}/${encodeURIComponent(path.basename(file.path))}`
}

/** Bytes for an inline ref or a `data:` URI. */
export function inlineBytes(ref: string): InlineFile {
  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',')
    const meta = ref.slice(5, comma)
    const data = ref.slice(comma + 1)
    const mime = meta.split(';')[0] || 'application/octet-stream'
    return { bytes: meta.endsWith(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data)), mime, name: 'input' }
  }
  if (isInlineRef(ref)) {
    const id = ref.slice(INLINE_PREFIX.length).split('/')[0]
    const hit = store.get(id)
    if (hit) return hit
    throw new ProviderError('The prepared input expired. Try again.')
  }
  throw new ProviderError('This provider needs a local file as input.')
}
