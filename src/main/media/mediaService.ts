import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { clipTypeForExtension, newId, type MediaFolder, type MediaManifestEntry } from '../../core/model'
import type { ImportResult, ProbeResult, WaveformData } from '../../shared/api'
import { appDirs } from '../paths'
import { exists, installPackageMedia, sourceForPath } from '../project/packageIO'
import type { ProjectSession } from '../project/session'
import type { MediaService } from '../services'
import { ffmpeg } from './ffmpeg'
import { isChromiumPlayable, probeFile } from './probe'
import { isLottieFile } from './lottie'
import { LOTTIE_THUMBNAIL_SIDE } from '../../shared/lottie'

/** Renders frames of a Lottie file (relative indices) as PNGs; the render host provides it (spec 07 §4.2). */
export type LottieRasterizer = (file: string, req: { frames: number[]; maxSide: number }) => Promise<Buffer[]>

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

const cacheDir = (kind: string) => path.join(appDirs.cache, kind)

async function fileKey(file: string, extra = ''): Promise<string> {
  const st = await fs.stat(file)
  return createHash('sha256').update(`${file}|${st.size}|${Math.trunc(st.mtimeMs)}|${extra}`).digest('hex').slice(0, 32)
}

async function writeCache(target: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${randomUUID()}`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, target)
}

const SUPPORTED_EXTENSIONS = (name: string) => clipTypeForExtension(path.extname(name).slice(1)) !== null

export class LocalMediaService implements MediaService {
  private readonly probeGate = new Semaphore(4)
  private readonly decodeGate = new Semaphore(3)
  private readonly proxyGate = new Semaphore(1)
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly probeCache = new Map<string, ProbeResult>()
  /** Library thumbnails for Lottie assets (set once the render service exists). */
  lottieRasterizer: LottieRasterizer | null = null

  private dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined
    if (existing) return existing
    const p = fn().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  async probe(file: string): Promise<ProbeResult> {
    const key = await fileKey(file)
    const hit = this.probeCache.get(key)
    if (hit) return hit
    const result = await this.dedupe(`probe:${key}`, () => this.probeGate.use(() => probeFile(file)))
    this.probeCache.set(key, result)
    return result
  }

  private entryFor(file: string, p: ProbeResult, packageDir: string, folderId?: string, name?: string): MediaManifestEntry {
    const e: MediaManifestEntry = {
      id: newId(),
      name: name ?? path.basename(file, path.extname(file)),
      type: p.type,
      source: sourceForPath(file, packageDir),
      duration: p.duration,
      hasAudio: p.type === 'audio' ? true : p.type === 'video' ? p.hasAudio : false,
    }
    if (p.width) e.sourceWidth = p.width
    if (p.height) e.sourceHeight = p.height
    if (p.fps && (p.type === 'video' || p.type === 'lottie')) e.sourceFPS = p.fps
    if (folderId) e.folderId = folderId
    return e
  }

  async importPaths(session: ProjectSession, paths: string[], folderId?: string): Promise<ImportResult> {
    const folders: MediaFolder[] = []
    const files: { file: string; folderId?: string; root: boolean }[] = []
    const rejected: ImportResult['rejected'] = []
    let lottieRejected = 0
    const scan = async (p: string, parent: string | undefined, root: boolean): Promise<void> => {
      const st = await fs.stat(p).catch(() => null)
      if (!st) {
        rejected.push({ path: p, reason: 'File not found.' })
        return
      }
      if (st.isDirectory() && !p.endsWith('.palmier')) {
        const folder: MediaFolder = { id: newId(), name: path.basename(p) }
        if (parent) folder.parentFolderId = parent
        folders.push(folder)
        const names = (await fs.readdir(p)).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        for (const n of names) await scan(path.join(p, n), folder.id, false)
        return
      }
      if (!SUPPORTED_EXTENSIONS(p)) {
        if (root) rejected.push({ path: p, reason: `Can't import "${path.basename(p)}" — unsupported file type.` })
        return
      }
      // LottieVideoGenerator.isLottie at scan time; the Mac toast prefers unsupported names, so these sort first.
      if (clipTypeForExtension(path.extname(p).slice(1)) === 'lottie' && !(await isLottieFile(p))) {
        rejected.splice(lottieRejected++, 0, { path: p, reason: `Can't import "${path.basename(p)}" — not a Lottie animation.` })
        return
      }
      files.push({ file: p, folderId: parent, root })
    }
    for (const p of paths) await scan(path.resolve(p), folderId, true)
    const entries = (
      await Promise.all(
        files.map(async (f) => {
          try {
            const p = await this.probe(f.file)
            return this.entryFor(f.file, p, session.path, f.folderId)
          } catch (e) {
            rejected.push({ path: f.file, reason: `Can't import "${path.basename(f.file)}" — ${e instanceof Error ? e.message : 'unreadable media.'}` })
            return null
          }
        }),
      )
    ).filter((e): e is MediaManifestEntry => !!e)
    if (!entries.length && !folders.length) return { added: [], rejected }
    const outcome = session.apply('addMedia', { entries, folders })
    if (!outcome.ok) return { added: [], rejected: [...rejected, ...paths.map((p) => ({ path: p, reason: outcome.error }))] }
    return { added: entries.map((e) => e.id), rejected }
  }

  async importBytes(session: ProjectSession, data: Buffer, filename: string, opts: { name?: string; folderId?: string; prefix?: string } = {}): Promise<string> {
    const ext = path.extname(filename).toLowerCase() || '.bin'
    const stored = `${opts.prefix ?? 'imported'}-${randomUUID().slice(0, 8).toUpperCase()}${ext}`
    const dest = await installPackageMedia(session.path, stored, data)
    const p = await this.probe(dest)
    const entry = this.entryFor(dest, p, session.path, opts.folderId, opts.name ?? path.basename(filename, ext))
    const outcome = session.apply('addMedia', { entries: [entry] })
    if (!outcome.ok) throw new Error(outcome.error)
    return entry.id
  }

  async playbackPath(session: ProjectSession, assetId: string): Promise<string | null> {
    const file = session.resolveMedia(assetId)
    if (!file || !(await exists(file))) return null
    const p = await this.probe(file)
    if (p.type === 'lottie' || isChromiumPlayable(file, p)) return file
    const key = await fileKey(file, 'proxy-v1')
    const ext = p.hasAlpha ? '.webm' : '.mp4'
    const target = path.join(cacheDir('proxies'), key + ext)
    if (await exists(target)) return target
    return this.dedupe(`proxy:${key}`, () =>
      this.proxyGate.use(async () => {
        const tmp = path.join(cacheDir('proxies'), `${key}.partial${ext}`)
        await fs.mkdir(path.dirname(tmp), { recursive: true })
        const video = p.hasVideo
          ? p.hasAlpha
            ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8']
            : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '15', '-movflags', '+faststart']
          : ['-vn']
        const audio = p.hasAudio ? (p.hasAlpha ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k']) : ['-an']
        await ffmpeg(['-y', '-i', file, '-map', '0:v:0?', '-map', '0:a:0?', ...video, ...audio, tmp])
        await fs.rename(tmp, target)
        return target
      }),
    )
  }

  async thumbnail(session: ProjectSession, assetId: string, atSeconds?: number): Promise<string | null> {
    const entry = session.doc.manifest.entries.find((e) => e.id === assetId)
    const file = session.resolveMedia(assetId)
    if (entry?.type === 'lottie' && file) return this.lottieThumbnail(file)
    if (!entry || !file || !(await exists(file)) || (entry.type !== 'video' && entry.type !== 'image')) return null
    const at = atSeconds ?? (entry.type === 'video' ? Math.min(1, entry.duration / 3) : 0)
    const key = await fileKey(file, `thumb-${at.toFixed(3)}`)
    const target = path.join(cacheDir('thumbnails'), `${key}.jpg`)
    if (await exists(target)) return target
    return this.dedupe(`thumb:${key}`, () =>
      this.decodeGate.use(async () => {
        const jpg = await this.extractFrame(file, entry.type === 'image' ? 0 : at, { width: 320, format: 'jpeg' })
        await writeCache(target, jpg)
        return target
      }),
    )
  }

  /** Frame `ip` rendered fit-within 512 px with alpha (`LottieVideoGenerator.inspect`), cached as PNG. */
  private async lottieThumbnail(file: string): Promise<string | null> {
    const raster = this.lottieRasterizer
    if (!raster || !(await exists(file))) return null
    const key = await fileKey(file, 'lottie-thumb-v1')
    const target = path.join(cacheDir('thumbnails'), `${key}.png`)
    if (await exists(target)) return target
    return this.dedupe(`thumb:${key}`, () =>
      this.decodeGate.use(async () => {
        const [png] = await raster(file, { frames: [0], maxSide: LOTTIE_THUMBNAIL_SIDE })
        if (!png) return null
        await writeCache(target, png)
        return target
      }),
    ).catch(() => null)
  }

  async filmstrip(session: ProjectSession, assetId: string, frameCount: number, height: number): Promise<string[]> {
    const entry = session.doc.manifest.entries.find((e) => e.id === assetId)
    const file = session.resolveMedia(assetId)
    if (!entry || !file || entry.type !== 'video' || !(await exists(file))) return []
    const count = Math.max(1, Math.min(240, Math.trunc(frameCount)))
    const h = Math.max(16, Math.min(360, Math.trunc(height)))
    const key = await fileKey(file, `strip-${count}-${h}`)
    const dir = path.join(cacheDir('filmstrips'), key)
    const done = path.join(dir, 'done')
    const frames = Array.from({ length: count }, (_, i) => path.join(dir, `${String(i + 1).padStart(4, '0')}.jpg`))
    if (await exists(done)) return frames
    return this.dedupe(`strip:${key}`, () =>
      this.decodeGate.use(async () => {
        await fs.mkdir(dir, { recursive: true })
        const rate = count / Math.max(entry.duration, 0.001)
        await ffmpeg(['-y', '-i', file, '-vf', `fps=${rate},scale=-2:${h}`, '-frames:v', String(count), '-q:v', '5', path.join(dir, '%04d.jpg')])
        await fs.writeFile(done, '')
        const present = await Promise.all(frames.map(exists))
        return frames.filter((_, i) => present[i])
      }),
    )
  }

  async waveform(session: ProjectSession, assetId: string): Promise<WaveformData | null> {
    const entry = session.doc.manifest.entries.find((e) => e.id === assetId)
    const file = session.resolveMedia(assetId)
    if (!entry || !file || !(entry.type === 'audio' || (entry.type === 'video' && entry.hasAudio)) || !(await exists(file))) return null
    const key = await fileKey(file, 'wave-v1')
    const target = path.join(cacheDir('waveforms'), `${key}.json`)
    try {
      return JSON.parse(await fs.readFile(target, 'utf8')) as WaveformData
    } catch {
      // Not cached yet.
    }
    return this.dedupe(`wave:${key}`, () =>
      this.decodeGate.use(async () => {
        const sampleRate = 8000
        const samplesPerSecond = 100
        const pcm = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'])
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
        const bucket = sampleRate / samplesPerSecond
        const peaks: number[] = []
        for (let i = 0; i < samples.length; i += bucket) {
          let peak = 0
          const end = Math.min(samples.length, i + bucket)
          for (let j = i; j < end; j++) {
            const v = Math.abs(samples[j])
            if (v > peak) peak = v
          }
          peaks.push(Math.round((peak / 32768) * 1000) / 1000)
        }
        const data: WaveformData = { peaks, samplesPerSecond, duration: samples.length / sampleRate }
        await writeCache(target, JSON.stringify(data))
        return data
      }),
    )
  }

  extractFrame(file: string, atSeconds: number, opts: { width?: number; format?: 'png' | 'jpeg' } = {}): Promise<Buffer> {
    const fmt = opts.format ?? 'png'
    const scale = opts.width ? ['-vf', `scale=${Math.trunc(opts.width)}:-2`] : []
    return ffmpeg([
      '-ss', String(Math.max(0, atSeconds)), '-i', file, '-frames:v', '1', ...scale,
      ...(fmt === 'jpeg' ? ['-q:v', '4', '-f', 'mjpeg'] : ['-f', 'image2', '-c:v', 'png']),
      'pipe:1',
    ])
  }
}
