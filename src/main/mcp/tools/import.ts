/** import_media: local path (file or folder), inline bytes, HTTPS download, or a generated solid matte. */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { clipTypeForExtension, newId, type ClipType, type MediaManifestEntry } from '../../../core/model'
import { addMediaEntries, updateMediaEntry } from '../../../core/ops/project'
import { isLottieFile } from '../../media/lottie'
import { sniffLottie } from '../../../shared/lottie'
import { installPackageMedia, sourceForPath } from '../../project/packageIO'
import type { ProjectSession } from '../../project/session'
import type { AppContext } from '../../services'
import { ToolError, hexColor, isObj, lenient, validateUnknownKeys, type Obj } from './args'
import { mutate, okRawJson, updateQuietly, type ToolEnv, type ToolResult } from './context'
import { resolveOrCreateFolder } from './folders'
import { createMatte } from '../../extras/matte'
import { MATTE_ASPECTS, parseMatteAspect } from '../../../shared/extras'

export const REMOTE_IMPORT_MAX_BYTES = 5 * 1024 ** 3
const REMOTE_IMPORT_TIMEOUT_MS = 15 * 60 * 1000
const BYTES_MAX_BASE64 = 15 * 1024 * 1024
const ACCEPTED_MIME =
  'Accepted: video/mp4, video/quicktime, audio/mpeg, audio/wav, audio/aac, audio/mp4, audio/aiff, audio/x-caf, audio/flac, image/png, image/jpeg, image/tiff, image/heic, application/x-subrip, text/vtt.'

const MIME_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/mpeg4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/aifc': 'aifc',
  'audio/x-aifc': 'aifc',
  'audio/caf': 'caf',
  'audio/x-caf': 'caf',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'application/json': 'json',
  'application/vnd.lottie+json': 'json',
  'application/x-subrip': 'srt',
  'text/srt': 'srt',
  'text/vtt': 'vtt',
}

export const mimeExtension = (mime: string): string | undefined => MIME_EXTENSIONS[mime.toLowerCase()]

/** `LottieVideoGenerator.isLottie` on JSON text: `{` first, keys layers/v/w/h/op within the first 256 KiB. */
export function isLottieText(text: string): boolean {
  return sniffLottie('json', new TextEncoder().encode(text))
}

/** Probes a file and builds its manifest entry (package-relative when inside the package). */
export async function probedEntry(app: AppContext, session: ProjectSession, file: string, name: string, folderId?: string): Promise<MediaManifestEntry> {
  const p = await app.media.probe(file)
  const e: MediaManifestEntry = {
    id: newId(),
    name,
    type: p.type,
    source: sourceForPath(file, session.path),
    duration: p.duration,
    hasAudio: p.type === 'audio' || (p.type === 'video' && p.hasAudio),
  }
  if (p.width) e.sourceWidth = p.width
  if (p.height) e.sourceHeight = p.height
  if (p.fps && p.type === 'video') e.sourceFPS = p.fps
  if (folderId) e.folderId = folderId
  return e
}

function ensureFolder(env: ToolEnv, folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined
  return mutate(env, 'New Folder', (d) => resolveOrCreateFolder(d, folder).id)
}

export async function importMedia(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['source', 'name', 'folder'], 'import_media')
  if (!isObj(args.source)) throw new ToolError("Missing required 'source' object")
  const source = args.source
  validateUnknownKeys(source, ['url', 'path', 'bytes', 'matte', 'mimeType'], 'source')
  const url = lenient.string(source, 'url')
  const file = lenient.string(source, 'path')
  const bytes = lenient.string(source, 'bytes')
  const matte = isObj(source.matte) ? source.matte : undefined
  const mimeType = lenient.string(source, 'mimeType')
  const count = [url, file, bytes, matte].filter((v) => v !== undefined).length
  if (count !== 1) throw new ToolError(`source must set exactly one of 'url', 'path', 'bytes', or 'matte' (got ${count})`)
  const folderId = ensureFolder(env, lenient.string(args, 'folder'))
  const name = lenient.string(args, 'name')
  if (file !== undefined) return importPath(env, file, name, folderId)
  if (bytes !== undefined) {
    if (mimeType === undefined) throw new ToolError('source.mimeType is required when source.bytes is set')
    return importBytes(env, bytes, mimeType, name, folderId)
  }
  if (matte) return importMatte(env, matte, name, folderId)
  return importUrl(env, url!, mimeType, name, folderId)
}

async function importPath(env: ToolEnv, file: string, name: string | undefined, folderId: string | undefined): Promise<ToolResult> {
  const st = await fs.stat(file).catch(() => null)
  if (!st) throw new ToolError(`File not found: ${file}`)
  if (st.isDirectory()) {
    const foldersBefore = env.session.doc.manifest.folders.length
    const result = await env.app.media.importPaths(env.session, [path.resolve(file)], folderId)
    if (!result.added.length) throw new ToolError(`No supported media found in folder: ${file}`)
    return okRawJson({
      status: 'ready',
      imported: result.added.length,
      folders: env.session.doc.manifest.folders.length - foldersBefore,
      note: `Imported from '${path.basename(file)}', mirroring its structure. See get_media.`,
    })
  }
  const ext = path.extname(file).slice(1).toLowerCase()
  const type = clipTypeForExtension(ext)
  if (!type) {
    throw new ToolError(`Unsupported file extension '.${ext}'. Supported: mov/mp4/m4v, mp3/wav/aac/m4a/aiff/aifc/caf/flac, png/jpg/jpeg/tiff/heic, json (Lottie), srt/vtt (subtitles).`)
  }
  if (type === 'lottie' && !(await isLottieFile(file))) throw new ToolError(`Unsupported Lottie file: ${path.basename(file)}`)
  const resolved = path.resolve(file)
  const entry = await probedEntry(env.app, env.session, resolved, name ?? path.basename(resolved, path.extname(resolved)), folderId).catch(() => {
    throw new ToolError(`Could not read media file: ${path.basename(file)}`)
  })
  mutate(env, 'Import Media (Agent)', (d) => addMediaEntries(d, [entry]))
  return okRawJson({ mediaRef: entry.id, name: entry.name, type, status: 'ready' })
}

async function importBytes(env: ToolEnv, base64: string, mimeType: string, name: string | undefined, folderId: string | undefined): Promise<ToolResult> {
  const size = Buffer.byteLength(base64, 'utf8')
  if (size > BYTES_MAX_BASE64) throw new ToolError(`source.bytes is too large (${size} chars; max ${BYTES_MAX_BASE64}). Use source.url or source.path for larger files.`)
  const ext = mimeExtension(mimeType)
  if (!ext) throw new ToolError(`Unsupported mimeType '${mimeType}'. ${ACCEPTED_MIME}`)
  const data = Buffer.from(base64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (!data.length) throw new ToolError('source.bytes is not valid non-empty base64')
  if (clipTypeForExtension(ext) === 'lottie' && !sniffLottie(ext, data)) throw new ToolError('source.bytes is not a valid Lottie animation')
  const id = await env.app.media.importBytes(env.session, data, `import.${ext}`, { name: name ?? 'Imported asset', folderId, prefix: 'imported' })
  const entry = env.session.doc.manifest.entries.find((e) => e.id === id)
  return okRawJson({ mediaRef: id, name: entry?.name ?? name ?? 'Imported asset', type: entry?.type ?? clipTypeForExtension(ext), status: 'ready' })
}

// ---------- URL downloads ----------

function parseHttpsUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError('source.url is not a valid URL')
  }
  if (url.protocol !== 'https:') throw new ToolError('source.url must use https')
  if (url.username || url.password) throw new ToolError('source.url must not embed credentials')
  if (!url.hostname) throw new ToolError('source.url has no host')
  return url
}

/** Streams a download to `dest`, refusing non-2xx and anything over `maxBytes`. */
export async function download(url: string, dest: string, maxBytes: number, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(REMOTE_IMPORT_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`server returned HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error(`download exceeds ${maxBytes} bytes`)
  let total = 0
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length
      cb(total > maxBytes ? new Error(`download exceeds ${maxBytes} bytes`) : null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), limit, createWriteStream(dest))
}

/** Adds a placeholder asset whose file lands later; `status` is its generationStatus until then. */
export function addPlaceholder(env: ToolEnv, o: { type: ClipType; ext: string; name: string; status: string; folderId?: string; extra?: Partial<MediaManifestEntry>; prefix: string }): MediaManifestEntry {
  const id = newId()
  const entry: MediaManifestEntry = {
    id,
    name: o.name,
    type: o.type,
    source: { project: { relativePath: `media/${o.prefix}-${id.slice(0, 8)}.${o.ext}` } },
    duration: 0,
    hasAudio: false,
    generationStatus: o.status,
    ...o.extra,
  }
  if (o.folderId) entry.folderId = o.folderId
  mutate(env, 'Import Media (Agent)', (d) => addMediaEntries(d, [entry]))
  return entry
}

/** Moves a finished download into the package and finalizes the placeholder's metadata (or marks it failed). */
export async function settlePlaceholder(app: AppContext, session: ProjectSession, entry: MediaManifestEntry, work: (stage: string) => Promise<void>): Promise<void> {
  const stage = path.join(os.tmpdir(), `framewright-download-${entry.id}`)
  try {
    await work(stage)
    const relative = 'project' in entry.source ? entry.source.project.relativePath : `media/${entry.id}`
    const dest = await installPackageMedia(session.path, path.basename(relative), { copyFrom: stage })
    const probed = await probedEntry(app, session, dest, entry.name, entry.folderId)
    updateQuietly(session, (d) =>
      updateMediaEntry(d, entry.id, {
        source: probed.source,
        duration: probed.duration,
        hasAudio: probed.hasAudio,
        sourceWidth: probed.sourceWidth,
        sourceHeight: probed.sourceHeight,
        sourceFPS: probed.sourceFPS,
        type: probed.type === entry.type ? entry.type : probed.type,
        generationStatus: undefined,
        importInput: undefined,
      }),
    )
  } catch (e) {
    updateQuietly(session, (d) => updateMediaEntry(d, entry.id, { generationStatus: `failed: ${e instanceof Error ? e.message : String(e)}` }))
  } finally {
    await fs.rm(stage, { force: true })
  }
}

function importUrl(env: ToolEnv, raw: string, mimeOverride: string | undefined, name: string | undefined, folderId: string | undefined): ToolResult {
  const url = parseHttpsUrl(raw)
  let ext: string
  if (mimeOverride !== undefined) {
    const mapped = mimeExtension(mimeOverride)
    if (!mapped) throw new ToolError(`Unsupported mimeType '${mimeOverride}'. ${ACCEPTED_MIME}`)
    ext = mapped
  } else {
    const urlExt = path.extname(decodeURIComponent(url.pathname)).slice(1).toLowerCase()
    if (!urlExt || !clipTypeForExtension(urlExt)) {
      throw new ToolError(`Cannot infer media type from URL extension ${urlExt ? `.${urlExt}` : '(none)'}. Set source.mimeType to disambiguate (e.g. 'video/mp4', 'image/png').`)
    }
    ext = urlExt
  }
  const type = clipTypeForExtension(ext)
  if (!type) throw new ToolError(`Unsupported file extension '.${ext}'`)
  const stem = path.basename(decodeURIComponent(url.pathname), path.extname(url.pathname))
  const entry = addPlaceholder(env, {
    type,
    ext,
    name: name ?? (stem || 'Imported asset'),
    status: 'downloading',
    folderId,
    prefix: 'imported',
    extra: { importInput: { sourceURL: url.href, createdAt: Date.now() / 1000 - 978307200 } },
  })
  void settlePlaceholder(env.app, env.session, entry, (stage) => download(url.href, stage, REMOTE_IMPORT_MAX_BYTES))
  return okRawJson({
    mediaRef: entry.id,
    type,
    status: 'downloading',
    note: `Downloading in the background. Poll get_media with ids:["${entry.id}"] until generationStatus clears.`,
  })
}

// ---------- Mattes ----------

async function importMatte(env: ToolEnv, matte: Obj, name: string | undefined, folderId: string | undefined): Promise<ToolResult> {
  validateUnknownKeys(matte, ['hex', 'aspectRatio'], 'source.matte')
  const hex = lenient.string(matte, 'hex')?.trim()
  if (!hex) throw new ToolError("source.matte requires 'hex'.")
  const rawAspect = lenient.string(matte, 'aspectRatio')?.trim()
  const aspect = rawAspect === undefined || rawAspect === '' ? 'Project' : parseMatteAspect(rawAspect)
  if (!aspect) throw new ToolError(`source.matte: unknown aspectRatio '${rawAspect}'. Use one of ${MATTE_ASPECTS.join(', ')}.`)
  if (!hexColor(hex)) throw new ToolError("Couldn't render matte image.")
  // Shared with the Matte sheet (spec 07 §6.5): src/main/extras/matte.ts.
  const entry = await createMatte(env.session, { hex, aspect, folderId, name })
  return okRawJson({ mediaRef: entry.id, name: entry.name, type: 'image', status: 'ready' })
}
