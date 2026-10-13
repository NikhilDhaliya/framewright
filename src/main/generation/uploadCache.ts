/**
 * Reference upload cache (spec 06 §B4.2 Linux): provider URLs for untouched library files, keyed by
 * (absolute path, size, mtime, provider), kept for the provider's expiry minus a margin. Never written to media.json.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** fal CDN files live ≥ 7 days; reuse for 6. Providers not listed are never cached. */
export const UPLOAD_TTL_MS: Record<string, number> = { fal: 6 * 24 * 3600 * 1000 }

interface Row {
  url: string
  expiresAt: number
}

export class UploadCache {
  private rows: Record<string, Row> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<Record<string, Row>> {
    if (this.rows) return this.rows
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.rows = parsed && typeof parsed === 'object' ? (parsed as Record<string, Row>) : {}
    } catch {
      this.rows = {}
    }
    return this.rows
  }

  private static async key(file: string, provider: string): Promise<string | null> {
    const st = await fs.stat(file).catch(() => null)
    return st ? `${provider}|${path.resolve(file)}|${st.size}|${Math.trunc(st.mtimeMs)}` : null
  }

  async get(file: string, provider: string): Promise<string | null> {
    if (!UPLOAD_TTL_MS[provider]) return null
    const key = await UploadCache.key(file, provider)
    if (!key) return null
    const row = (await this.load())[key]
    return row && row.expiresAt > this.now() && typeof row.url === 'string' ? row.url : null
  }

  async put(file: string, provider: string, url: string): Promise<void> {
    const ttl = UPLOAD_TTL_MS[provider]
    if (!ttl || url.startsWith('data:')) return
    const key = await UploadCache.key(file, provider)
    if (!key) return
    const rows = await this.load()
    const now = this.now()
    for (const [k, r] of Object.entries(rows)) if (!(r.expiresAt > now)) delete rows[k]
    rows[key] = { url, expiresAt: now + ttl }
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${randomUUID()}`
      await fs.writeFile(tmp, JSON.stringify(rows))
      await fs.rename(tmp, this.file)
    }
    this.chain = this.chain.then(write, write).catch(() => undefined)
    await this.chain
  }
}
