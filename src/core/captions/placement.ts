/** `placeCaptionTrack` (spec 07 §1.7.8): caption specs on a new top video track as one caption group. */
import type { TextBox } from '../ops/project'
import { activeTimeline, type Doc } from '../ops/context'
import { placeTextClips } from '../ops/agent'
import { EditRefusal, insertTrack } from '../timeline'
import type { CaptionClipSpec } from './captionBuilder'

/** Inserts a video track at index 0 and places the specs there (regions are not cleared elsewhere). Refuses when nothing lands. */
export function placeCaptionTrack(doc: Doc, specs: CaptionClipSpec[]): string[] {
  const usable = specs.filter((s) => s.durationFrames > 0 && s.content)
  if (!usable.length) throw new EditRefusal('No captions to add.')
  const t = activeTimeline(doc)
  const trackIndex = insertTrack(t, 0, 'video')
  const ids = placeTextClips(
    doc,
    usable.map((s) => {
      const box: TextBox = s.transform ? { width: s.transform.width, height: s.transform.height } : { width: 0.5, height: 0.1 }
      return {
        trackIndex,
        startFrame: s.startFrame,
        durationFrames: s.durationFrames,
        content: s.content,
        style: s.style,
        box,
        ...(s.transform ? { transform: s.transform } : {}),
        ...(s.animation ? { animation: s.animation } : {}),
        ...(s.captionGroupId ? { captionGroupId: s.captionGroupId } : {}),
        ...(s.words ? { words: s.words } : {}),
      }
    }),
  )
  if (!ids.length) throw new EditRefusal('No captions to add.')
  return ids
}
