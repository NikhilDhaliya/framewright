/**
 * Embedding files on disk (spec 07 §2.4): `$XDG_CACHE_HOME/framewright/Embeddings/<key>.embed`, key =
 * first 32 hex chars of SHA-256("<path>|<mtime seconds as a double>|<size>"). Writes are atomic.
 */
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  decodeEmbeddingHeader,
  decodeEmbeddings,
  EMBED_PREFIX_BYTES,
  encodeEmbeddings,
  headerLength,
  isCurrentHeader,
  type AssetIndex,
  type EmbeddingHeader,
  type EmbeddingRow,
} from '../../../core/search/store'

export interface IndexSpec {
  model: string
  modelVersion: number
  samplerVersion: number
}

export async function dirBytes(p: string): Promise<number> {
  const st = await fs.lstat(p).catch(() => null)
  if (!st) return 0
  if (!st.isDirectory()) return st.size
  let n = 0
  for (const name of await fs.readdir(p).catch(() => [] as string[])) n += await dirBytes(path.join(p, name))
  return n
}

export class EmbeddingStore {
  constructor(readonly dir: string) {}

  /** Null when the file is missing (offline media is never indexed). */
  key(file: string): string | null {
    let st
    try {
      st = statSync(file)
    } catch {
      return null
    }
    if (!st.isFile()) return null
    return createHash('sha256').update(`${file}|${st.mtimeMs / 1000}|${st.size}`, 'utf8').digest('hex').slice(0, 32)
  }

  file(key: string): string {
    return path.join(this.dir, `${key}.embed`)
  }

  async header(key: string): Promise<EmbeddingHeader | null> {
    let fh: fs.FileHandle | null = null
    try {
      fh = await fs.open(this.file(key), 'r')
      const prefix = Buffer.alloc(EMBED_PREFIX_BYTES)
      const { bytesRead } = await fh.read(prefix, 0, prefix.length, 0)
      const len = headerLength(prefix.subarray(0, bytesRead))
      if (len === null || len > 1 << 20) return null
      const all = Buffer.alloc(EMBED_PREFIX_BYTES + len)
      const r = await fh.read(all, 0, all.length, 0)
      return decodeEmbeddingHeader(all.subarray(0, r.bytesRead))
    } catch {
      return null
    } finally {
      await fh?.close().catch(() => undefined)
    }
  }

  async isCurrent(key: string, spec: IndexSpec): Promise<boolean> {
    return isCurrentHeader(await this.header(key), spec)
  }

  /** `VisualIndexer.needsIndex`: false for a missing file. */
  async needsIndex(file: string, spec: IndexSpec): Promise<boolean> {
    const key = this.key(file)
    return key !== null && !(await this.isCurrent(key, spec))
  }

  async load(key: string): Promise<AssetIndex> {
    return decodeEmbeddings(new Uint8Array(await fs.readFile(this.file(key))))
  }

  async save(header: EmbeddingHeader, rows: EmbeddingRow[], vectors: ArrayLike<number>, key: string): Promise<void> {
    const bytes = encodeEmbeddings(header, rows, vectors)
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = path.join(this.dir, `.${key}.${randomUUID()}.tmp`)
    await fs.writeFile(tmp, bytes)
    await fs.rename(tmp, this.file(key))
  }

  async clearAll(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true })
  }

  bytes(): Promise<number> {
    return dirBytes(this.dir)
  }
}
