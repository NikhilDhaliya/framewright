/**
 * Transcript cache (spec 07 §1.3, Mac `TranscriptCache.swift`): `$XDG_CACHE_HOME/framewright/Transcripts/<key>.json`,
 * a 4-entry memory map cleared whole when full, atomic writes. Local keys add the whisper model id (Linux deviation).
 */
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizedResult, type TranscriptionResult } from '../../../core/captions/transcript'

const MEMORY_LIMIT = 4

/** Swift `Double.description` for the mtime part of the identity. */
function swiftDouble(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v)
}

/** `"<abs path>|<mtime seconds>|<size>"`, or null when `stat` fails (no caching). */
export function fileIdentity(file: string): string | null {
  try {
    const st = statSync(file)
    return `${path.resolve(file)}|${swiftDouble(st.mtimeMs / 1000)}|${st.size}`
  } catch {
    return null
  }
}

export const cacheKey = (identity: string): string => createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)

export function localCacheKey(file: string, modelId: string): string | null {
  const base = fileIdentity(file)
  return base ? cacheKey(`local|${modelId}|${base}`) : null
}

/** `cloud|<lang|auto>|full` or `cloud|<lang|auto>|<lo %.3f>...<hi %.3f>`, then `|<base>`. */
export function cloudCacheKey(file: string, range: [number, number] | null | undefined, language: string | null | undefined): string | null {
  const base = fileIdentity(file)
  if (!base) return null
  const lang = language ?? 'auto'
  const prefix = range ? `cloud|${lang}|${range[0].toFixed(3)}...${range[1].toFixed(3)}` : `cloud|${lang}|full`
  return cacheKey(`${prefix}|${base}`)
}

export class TranscriptCache {
  private memory = new Map<string, TranscriptionResult>()

  constructor(readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`)
  }

  private remember(key: string, r: TranscriptionResult): void {
    if (!this.memory.has(key) && this.memory.size >= MEMORY_LIMIT) this.memory.clear()
    this.memory.set(key, r)
  }

  async read(key: string | null): Promise<TranscriptionResult | null> {
    if (!key) return null
    const hit = this.memory.get(key)
    if (hit) return hit
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(key), 'utf8')) as TranscriptionResult
      if (typeof parsed?.text !== 'string' || !Array.isArray(parsed.words) || !Array.isArray(parsed.segments)) return null
      this.remember(key, parsed)
      return parsed
    } catch {
      return null
    }
  }

  has(key: string | null): Promise<boolean> {
    if (!key) return Promise.resolve(false)
    if (this.memory.has(key)) return Promise.resolve(true)
    return fs.access(this.file(key)).then(
      () => true,
      () => false,
    )
  }

  async write(key: string | null, r: TranscriptionResult): Promise<void> {
    if (!key) return
    const normalized = normalizedResult(r)
    this.remember(key, normalized)
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = `${this.file(key)}.tmp-${randomUUID()}`
    await fs.writeFile(tmp, JSON.stringify(normalized))
    await fs.rename(tmp, this.file(key))
  }

  /** Settings ▸ Storage ▸ Clear cache. */
  clearMemory(): void {
    this.memory.clear()
  }

  /** Removes every cached transcript (memory and disk). */
  async clear(): Promise<void> {
    this.memory.clear()
    await fs.rm(this.dir, { recursive: true, force: true })
  }
}
