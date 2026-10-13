/** Staged owned-media writes (spec 01 §1.7) shared by the extras: stage in $TMPDIR, then install into `media/`. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Doc } from '../../core/ops/context'
import { installPackageMedia } from '../project/packageIO'
import type { ProjectSession } from '../project/session'

/** First 8 characters of a fresh upper-case UUID (`UUID().uuidString.prefix(8)`). */
export const hex8 = (): string => randomUUID().slice(0, 8).toUpperCase()

/** `$TMPDIR/framewright-stage-<UUID>.<ext>` (`FileIO.temporaryFileURL`). */
export const stagePath = (ext: string): string => path.join(os.tmpdir(), `framewright-stage-${randomUUID().toUpperCase()}.${ext}`)

export const removeQuietly = (p: string): Promise<void> => fs.rm(p, { force: true }).catch(() => undefined)

/** `commitStagedProjectMedia`: moves the staged file into `<package>/media/<filename>` (atomic, next to the package). */
export async function commitStaged(session: ProjectSession, staged: string, filename: string): Promise<string> {
  if (session.closed) throw new Error('No project is open.')
  return installPackageMedia(session.path, filename, { copyFrom: staged })
}

/** Non-undoable document change, persisted with a checkpoint save (Mac `updateManifestMetadata` / checkpoint). */
export function writeQuietly(session: ProjectSession, fn: (d: Doc) => void): boolean {
  if (session.closed) return false
  const out = session.transact('Update Media', fn, false)
  if (out.ok && out.changed) void session.save().catch(() => undefined)
  return out.ok
}
