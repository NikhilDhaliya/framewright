/**
 * Main-process Lottie support (spec 07 §4.2): exact recognition, metadata, and the animation JSON served to the
 * renderer (`palmier-media://lottie/<path>`), with `.lottie` archives unzipped here and the results cached (bounded).
 */
import fs from 'node:fs/promises'
import { extensionOf, LOTTIE_SNIFF_BYTES, lottieMeta, parseLottie, sniffLottie, type LottieJson, type LottieMeta } from '../../shared/lottie'

/** Reads at most `n` leading bytes of a file. */
async function readHead(file: string, n: number): Promise<Uint8Array> {
  const fh = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** `LottieVideoGenerator.isLottie(at:)`: false for unreadable files. */
export async function isLottieFile(file: string): Promise<boolean> {
  try {
    const ext = extensionOf(file)
    return sniffLottie(ext, await readHead(file, ext === 'lottie' ? 4 : LOTTIE_SNIFF_BYTES))
  } catch {
    return false
  }
}

interface Entry {
  json: string
  meta: LottieMeta
}

const CACHE_MAX_ENTRIES = 32
const CACHE_MAX_CHARS = 128 * 1024 * 1024
const cache = new Map<string, Promise<Entry>>()
const sizes = new Map<string, number>()
let cachedChars = 0

function evict(): void {
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES && cachedChars <= CACHE_MAX_CHARS) break
    if (cache.size <= 1) break
    cache.delete(key)
    cachedChars -= sizes.get(key) ?? 0
    sizes.delete(key)
  }
}

/** Parsed animation (dotLottie: first animation, images inlined) as JSON text plus its metadata; cached per file version. */
export async function loadLottie(file: string): Promise<Entry> {
  const st = await fs.stat(file)
  const key = `${file}|${st.size}|${Math.trunc(st.mtimeMs)}`
  let p = cache.get(key)
  if (p) {
    cache.delete(key)
    cache.set(key, p)
    return p
  }
  p = (async () => {
    const bytes = await fs.readFile(file)
    const ext = extensionOf(file)
    const anim: LottieJson = parseLottie(ext, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    const meta = lottieMeta(anim)
    const json = ext === 'lottie' ? JSON.stringify(anim) : bytes.toString('utf8')
    return { json, meta }
  })()
  cache.set(key, p)
  p.then(
    (e) => {
      if (!cache.has(key)) return
      sizes.set(key, e.json.length)
      cachedChars += e.json.length
      evict()
    },
    () => cache.delete(key),
  )
  return p
}

/** Composition metadata (`w, h, fr, ip, op`); throws `not a Lottie animation.` when unreadable. */
export async function lottieFileMeta(file: string): Promise<LottieMeta> {
  try {
    return (await loadLottie(file)).meta
  } catch (e) {
    if (e instanceof Error && e.message === 'not a Lottie animation.') throw e
    throw new Error('not a Lottie animation.')
  }
}

/** Response for `palmier-media://lottie/<path>`: the animation JSON of a `.json` or `.lottie` file. */
export async function lottieResponse(file: string): Promise<Response> {
  try {
    const { json } = await loadLottie(file)
    return new Response(json, { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } })
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    return new Response(missing ? 'Not found' : 'Not a Lottie animation', { status: missing ? 404 : 422 })
  }
}
