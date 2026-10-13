/**
 * Consolidated `.palmier` package export (spec 01 §1.10, spec 04 §11.9): every resolvable source copied
 * into media/, manifest rewritten to package-relative sources, built in a staging dir then swapped in.
 */
import { randomUUID } from 'node:crypto'
import { constants as fsc } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { encodeManifest, encodeProjectFile } from '../../core/codec'
import { PROJECT, type MediaManifestEntry } from '../../core/model'
import type { Doc } from '../../core/ops/context'

const CHUNK = 4 * 1024 * 1024

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsc.F_OK)
    return true
  } catch {
    return false
  }
}

async function copyChunked(src: string, dest: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  const input = await fs.open(src, 'r')
  const output = await fs.open(dest, 'w')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      if (signal.aborted) throw new Error('cancelled')
      const { bytesRead } = await input.read(buf, 0, CHUNK, null)
      if (bytesRead === 0) break
      await output.write(buf, 0, bytesRead)
      onBytes(bytesRead)
    }
  } finally {
    await input.close()
    await output.close()
  }
}

export interface PalmierExportResult {
  missing: number
}

/** `resolve` maps a manifest entry to its absolute source path (or null). */
export async function exportPalmierPackage(
  doc: Doc,
  sourcePackage: string,
  resolve: (e: MediaManifestEntry) => string | null,
  outputPath: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<PalmierExportResult> {
  const parent = path.dirname(outputPath)
  const stage = path.join(parent, `.framewright-export-${randomUUID().toUpperCase()}.partial`)
  await fs.mkdir(path.join(stage, PROJECT.mediaDirectoryName), { recursive: true })
  try {
    const copies = new Map<string, string>()
    const used = new Set<string>()
    const jobs: { src: string; dest: string; size: number }[] = []
    let missing = 0
    const entries: MediaManifestEntry[] = []
    for (const e of doc.manifest.entries) {
      const src = resolve(e)
      const st = src ? await fs.stat(src).catch(() => null) : null
      if (!src || !st?.isFile()) {
        missing++
        entries.push(e)
        continue
      }
      let rel = copies.get(src)
      if (!rel) {
        const ext = path.extname(src)
        const base = 'external' in e.source ? `import-${e.id.slice(0, 8)}` : path.basename(src, ext)
        let name = `${base}${ext}`
        for (let i = 1; used.has(name.toLowerCase()); i++) name = `${base}-${i}${ext}`
        used.add(name.toLowerCase())
        rel = `${PROJECT.mediaDirectoryName}/${name}`
        copies.set(src, rel)
        jobs.push({ src, dest: path.join(stage, rel), size: st.size })
      }
      entries.push({ ...e, source: { project: { relativePath: rel } } })
    }
    const total = Math.max(1, jobs.reduce((n, j) => n + j.size, 0))
    let done = 0
    for (const j of jobs) {
      await copyChunked(j.src, j.dest, signal, (n) => {
        done += n
        onProgress(Math.min(0.99, done / total))
      })
    }
    if (signal.aborted) throw new Error('cancelled')
    await fs.writeFile(path.join(stage, PROJECT.timelineFilename), encodeProjectFile(doc.file))
    await fs.writeFile(path.join(stage, PROJECT.manifestFilename), encodeManifest({ ...doc.manifest, entries }))
    const thumb = path.join(sourcePackage, PROJECT.thumbnailFilename)
    if (await exists(thumb)) await fs.copyFile(thumb, path.join(stage, PROJECT.thumbnailFilename))
    const chat = path.join(sourcePackage, PROJECT.chatDirectoryName)
    if (await exists(chat)) await fs.cp(chat, path.join(stage, PROJECT.chatDirectoryName), { recursive: true })
    else await fs.mkdir(path.join(stage, PROJECT.chatDirectoryName), { recursive: true })
    if (signal.aborted) throw new Error('cancelled')
    if (await exists(outputPath)) {
      const old = path.join(parent, `.framewright-export-${randomUUID().toUpperCase()}.old`)
      await fs.rename(outputPath, old)
      try {
        await fs.rename(stage, outputPath)
      } catch (e) {
        await fs.rename(old, outputPath).catch(() => undefined)
        throw e
      }
      await fs.rm(old, { recursive: true, force: true })
    } else {
      await fs.rename(stage, outputPath)
    }
    onProgress(1)
    return { missing }
  } catch (e) {
    await fs.rm(stage, { recursive: true, force: true })
    throw e
  }
}
