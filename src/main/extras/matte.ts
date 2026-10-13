/** Solid mattes (spec 07 §6.5, `EditorViewModel+Matte.swift`): shared by the Matte sheet and `import_media {matte}`. */
import fs from 'node:fs/promises'
import { newId, DEFAULTS, type MediaManifestEntry, type RGBA } from '../../core/model'
import { addMediaEntries } from '../../core/ops/project'
import { MATTE_ERRORS, matteEven, matteName, mattePixelSize, type MatteAspect } from '../../shared/extras'
import type { ProjectSession } from '../project/session'
import { sourceForPath } from '../project/packageIO'
import { solidPng } from './png'
import { commitStaged, hex8, removeQuietly, stagePath, writeQuietly } from './stage'

/** `TextStyle.RGBA(hex:)`: `#RGB`, `#RRGGBB` or `#RRGGBBAA` (the alpha is ignored by mattes). */
export function parseHex(hex: string): RGBA | null {
  let s = hex.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (!/^[0-9A-Fa-f]*$/.test(s)) return null
  const byte = (i: number, len: number) => parseInt(len === 1 ? s[i] + s[i] : s.slice(i, i + 2), 16) / 255
  if (s.length === 3) return { r: byte(0, 1), g: byte(1, 1), b: byte(2, 1), a: 1 }
  if (s.length === 6) return { r: byte(0, 2), g: byte(2, 2), b: byte(4, 2), a: 1 }
  if (s.length === 8) return { r: byte(0, 2), g: byte(2, 2), b: byte(4, 2), a: byte(6, 2) }
  return null
}

/** `Matte.png(hex:width:height:)`: the whole (even-sized) canvas filled with the colour at alpha 1. */
export function mattePng(hex: string, width: number, height: number): Buffer {
  const c = parseHex(hex)
  if (!c) throw new Error(MATTE_ERRORS.renderFailed)
  const [w, h] = matteEven(width, height)
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  return solidPng(w, h, [byte(c.r), byte(c.g), byte(c.b)])
}

export interface MatteRequest {
  hex: string
  aspect?: MatteAspect
  folderId?: string | null
  name?: string
}

/** Creates the PNG, commits it as `media/matte-<8 hex>.png` and adds the asset without an undo entry. */
export async function createMatte(session: ProjectSession | null, req: MatteRequest): Promise<MediaManifestEntry> {
  if (!session || session.closed) throw new Error(MATTE_ERRORS.noProject)
  const aspect = req.aspect ?? 'Project'
  const t = session.activeTimeline()
  const [w, h] = mattePixelSize(aspect, t.width, t.height)
  const filename = `matte-${hex8()}.png`
  const data = mattePng(req.hex, w, h)
  const staged = stagePath('png')
  let dest: string
  try {
    await fs.writeFile(staged, data)
    dest = await commitStaged(session, staged, filename)
  } finally {
    await removeQuietly(staged)
  }
  const entry: MediaManifestEntry = {
    id: newId(),
    name: req.name ?? matteName(aspect, w, h),
    type: 'image',
    source: sourceForPath(dest, session.path),
    duration: DEFAULTS.imageDurationSeconds,
    sourceWidth: w,
    sourceHeight: h,
    hasAudio: false,
  }
  const folderId = req.folderId && session.doc.manifest.folders.some((f) => f.id === req.folderId) ? req.folderId : undefined
  if (folderId) entry.folderId = folderId
  if (!writeQuietly(session, (d) => addMediaEntries(d, [entry]))) throw new Error(MATTE_ERRORS.noProject)
  return entry
}
