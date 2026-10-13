import { randomUUID } from 'node:crypto'
import { constants as fsc } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeManifest, decodeProjectFile, encodeManifest, encodeProjectFile } from '../../core/codec'
import { emptyManifest, PROJECT, type MediaManifest, type MediaManifestEntry, type ProjectFile } from '../../core/model'

export interface LoadedPackage {
  file: ProjectFile
  manifest: MediaManifest
  /** Original media.json bytes kept when the manifest could not be decoded. */
  preservedManifest: Buffer | null
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsc.F_OK)
    return true
  } catch {
    return false
  }
}

export function normalizePackagePath(p: string): string {
  const resolved = path.resolve(p)
  return path.basename(resolved) === PROJECT.timelineFilename ? path.dirname(resolved) : resolved
}

export async function readPackage(dir: string): Promise<LoadedPackage> {
  const text = await fs.readFile(path.join(dir, PROJECT.timelineFilename), 'utf8')
  const file = decodeProjectFile(text)
  let manifest = emptyManifest()
  let preservedManifest: Buffer | null = null
  const manifestPath = path.join(dir, PROJECT.manifestFilename)
  if (await exists(manifestPath)) {
    const bytes = await fs.readFile(manifestPath)
    try {
      manifest = decodeManifest(bytes.toString('utf8'))
    } catch {
      preservedManifest = bytes
    }
  }
  return { file, manifest, preservedManifest }
}

async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.tmp-${randomUUID()}`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, target)
}

export interface WriteOptions {
  file: ProjectFile
  manifest: MediaManifest
  preservedManifest: Buffer | null
  thumbnail?: Buffer | null
  /** Package the media/, chat/ and thumbnail are carried forward from (Save As). */
  sourceDir?: string | null
}

/** Mirrors the Mac's package save: atomic JSON, preserved manifest, carried-forward chat/media. */
export async function writePackage(dir: string, o: WriteOptions): Promise<void> {
  const st = await fs.stat(dir).catch(() => null)
  if (st && !st.isDirectory()) await fs.rm(dir)
  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(path.join(dir, PROJECT.timelineFilename), encodeProjectFile(o.file))
  const manifestEmpty = o.manifest.entries.length === 0 && o.manifest.folders.length === 0
  if (o.preservedManifest && manifestEmpty) {
    await writeAtomic(path.join(dir, PROJECT.manifestFilename), o.preservedManifest)
  } else {
    await writeAtomic(path.join(dir, PROJECT.manifestFilename), encodeManifest(withPackageSources(o.manifest, dir, o.sourceDir ?? dir)))
  }
  const thumbPath = path.join(dir, PROJECT.thumbnailFilename)
  if (o.thumbnail) await writeAtomic(thumbPath, o.thumbnail)
  else if (o.sourceDir && o.sourceDir !== dir && (await exists(path.join(o.sourceDir, PROJECT.thumbnailFilename)))) {
    await fs.copyFile(path.join(o.sourceDir, PROJECT.thumbnailFilename), thumbPath)
  }
  if (o.sourceDir && o.sourceDir !== dir) {
    for (const sub of [PROJECT.mediaDirectoryName, PROJECT.chatDirectoryName]) {
      const from = path.join(o.sourceDir, sub)
      if (await exists(from)) {
        await fs.rm(path.join(dir, sub), { recursive: true, force: true })
        await fs.cp(from, path.join(dir, sub), { recursive: true })
      }
    }
  }
  await fs.mkdir(path.join(dir, PROJECT.mediaDirectoryName), { recursive: true })
  await fs.mkdir(path.join(dir, PROJECT.chatDirectoryName), { recursive: true })
}

/** Package-owned media stays package-relative when saved to a new location. */
function withPackageSources(m: MediaManifest, dir: string, sourceDir: string): MediaManifest {
  if (sourceDir === dir) return m
  return {
    ...m,
    entries: m.entries.map((e) => {
      if (!('external' in e.source)) return e
      const abs = e.source.external.absolutePath
      if (abs === sourceDir || abs.startsWith(sourceDir + path.sep)) {
        return { ...e, source: { project: { relativePath: path.relative(sourceDir, abs).split(path.sep).join('/') } } }
      }
      return e
    }),
  }
}

export function resolveMediaPath(entry: MediaManifestEntry, packageDir: string | null): string | null {
  if ('external' in entry.source) return entry.source.external.absolutePath
  if (!packageDir) return null
  const rel = entry.source.project.relativePath
  const abs = path.resolve(packageDir, rel)
  return abs === packageDir || abs.startsWith(packageDir + path.sep) ? abs : null
}

export function sourceForPath(absPath: string, packageDir: string | null): MediaManifestEntry['source'] {
  if (packageDir && (absPath === packageDir || absPath.startsWith(packageDir + path.sep))) {
    return { project: { relativePath: path.relative(packageDir, absPath).split(path.sep).join('/') } }
  }
  return { external: { absolutePath: absPath } }
}

/** Writes a file into <package>/media atomically (staged next to the package). */
export async function installPackageMedia(packageDir: string, filename: string, data: Buffer | { copyFrom: string }): Promise<string> {
  const mediaDir = path.join(packageDir, PROJECT.mediaDirectoryName)
  await fs.mkdir(mediaDir, { recursive: true })
  const stage = path.join(path.dirname(packageDir), `.framewright-stage-${randomUUID()}`)
  try {
    if (Buffer.isBuffer(data)) await fs.writeFile(stage, data)
    else await fs.copyFile(data.copyFrom, stage)
    const dest = path.join(mediaDir, filename)
    await fs.rename(stage, dest)
    return dest
  } catch (e) {
    await fs.rm(stage, { force: true })
    throw e
  }
}
