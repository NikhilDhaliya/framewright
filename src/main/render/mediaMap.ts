import { access } from 'node:fs/promises'
import type { MediaMap } from '../../renderer/render/plan'
import type { ProjectSession } from '../project/session'

/** Snapshot of every library asset the renderer may need; missing files map to `path: null` (offline). */
export async function buildMediaMap(session: ProjectSession): Promise<MediaMap> {
  const map: MediaMap = {}
  await Promise.all(
    session.doc.manifest.entries.map(async (e) => {
      const resolved = session.resolveMedia(e)
      let path: string | null = null
      if (resolved) {
        try {
          await access(resolved)
          path = resolved
        } catch {
          path = null
        }
      }
      map[e.id] = { path, type: e.type, duration: e.duration, width: e.sourceWidth, height: e.sourceHeight, hasAudio: e.hasAudio }
    }),
  )
  return map
}
