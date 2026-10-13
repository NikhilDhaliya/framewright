import { ffmpeg } from '../media/ffmpeg'
import { exists } from './packageIO'
import type { ProjectSession } from './session'

const LONGEST_EDGE = 640

/** Home-screen poster per spec 01 §1.5: first video/image clip on a video track of the active timeline. */
export async function generateProjectThumbnail(session: ProjectSession): Promise<Buffer | null> {
  const timeline = session.activeTimeline()
  for (const track of timeline.tracks) {
    if (track.type !== 'video') continue
    for (const clip of track.clips) {
      if (clip.mediaType !== 'video' && clip.mediaType !== 'image') continue
      const file = session.resolveMedia(clip.mediaRef)
      if (!file || !(await exists(file))) continue
      const at = clip.mediaType === 'video' ? clip.trimStartFrame / Math.max(1, timeline.fps) : 0
      try {
        return await ffmpeg([
          '-ss', String(at), '-i', file, '-frames:v', '1',
          '-vf', `scale='min(${LONGEST_EDGE},iw)':'min(${LONGEST_EDGE},ih)':force_original_aspect_ratio=decrease`,
          '-q:v', '5', '-f', 'mjpeg', 'pipe:1',
        ])
      } catch {
        // Try the next candidate, as the Mac does.
      }
    }
  }
  return null
}
