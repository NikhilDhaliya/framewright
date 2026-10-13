/** Timeline context-menu entries for audio analysis (05 §6.11 Sync group, dead-air span menu). */
import { syncSelection } from '@core/audio/clipSync'
import type { Clip } from '@core/model'
import type { Doc } from '@core/ops/context'
import type { MenuItem } from '../ui/Menu'
import { audioState, deadAirResolver, detectBeats, removeDeadAir, setMarks, synchronize } from './store'
import { t } from '../i18n'

const hasAudio = (doc: Doc, c: Clip) => {
  if (c.mediaType !== 'audio' && c.mediaType !== 'video') return false
  const e = doc.manifest.entries.find((x) => x.id === c.mediaRef)
  return !!e && (e.type === 'audio' || (e.type === 'video' && !!e.hasAudio))
}

/** t('Remove Dead Air') when `frame` lies in a dead-air span of the (audio) clip, else null. */
export function deadAirSpanMenu(doc: Doc, clip: Clip, frame: number): MenuItem[] | null {
  if (!audioState().markDeadAir || clip.mediaType !== 'audio') return null
  const fps = doc.file.timelines.find((t) => t.tracks.some((tr) => tr.clips.some((c) => c.id === clip.id)))?.fps
  if (!fps) return null
  const span = deadAirResolver(doc)
    .ranges(clip, fps)
    .find((r) => r.start <= frame && frame < r.end)
  return span ? [{ label: t('Remove Dead Air'), onSelect: () => void removeDeadAir({ clipId: clip.id, frame }) }] : null
}

/** Sync group: Synchronize ▸ Auto/Audio/Timecode, Detect/Redetect Beats, Mark Beats. */
export function clipSyncMenuItems(doc: Doc, clip: Clip, selected: string[]): MenuItem[] {
  const items: MenuItem[] = []
  if (!clip.multicamGroupId && syncSelection(doc, selected)) {
    items.push({
      label: t('Synchronize'),
      submenu: [
        { label: t('Auto'), onSelect: () => void synchronize('auto') },
        { label: t('Audio'), onSelect: () => void synchronize('audio') },
        { label: t('Timecode'), onSelect: () => void synchronize('timecode') },
      ],
    })
  }
  if (hasAudio(doc, clip) && clip.sourceClipType !== 'sequence') {
    const has = !!audioState().beats[clip.mediaRef]
    const busy = !!audioState().beatsInFlight[clip.mediaRef]
    items.push({ label: has ? t('Redetect Beats') : t('Detect Beats'), disabled: busy, onSelect: () => void detectBeats(clip.mediaRef, has) })
    if (has) items.push({ label: t('Mark Beats'), checked: audioState().markBeats, onSelect: () => setMarks({ markBeats: !audioState().markBeats }) })
  }
  return items
}
