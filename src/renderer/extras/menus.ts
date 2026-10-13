/** Context-menu entries for spec 07 §6.3 (clip ▸ Save as Media / Save as Audio, range ▸ Save Range as Media, media ▸ Extract Audio). */
import type { Clip, MediaManifestEntry, Timeline } from '@core/model'
import { audioClipForExtraction, canExtractAudio, canSaveClipAsMedia } from '../../shared/extras'
import type { MenuItem } from '../ui/Menu'
import { toast } from '../ui/toast'
import { t } from '../i18n'

const report = (p: Promise<{ ok: boolean; error?: string }>) =>
  void p.then(
    (r) => {
      if (!r.ok && r.error) toast(r.error, 'error')
    },
    () => undefined,
  )

/** The clip menu's media group (Mac `TimelineView` media items, minus Swap Media). */
export function clipMediaMenuItems(tl: Timeline, entries: MediaManifestEntry[], clip: Clip): MenuItem[] {
  const items: MenuItem[] = []
  if (canSaveClipAsMedia(clip)) items.push({ label: t('Save as Media'), onSelect: () => report(window.palmier.extras.saveClipAsMedia(clip.id)) })
  if (clip.mediaType === 'video' && audioClipForExtraction(tl, entries, clip.id)) items.push({ label: t('Save as Audio'), onSelect: () => report(window.palmier.extras.saveClipAsAudio(clip.id)) })
  return items
}

/** Timeline range menu item (after "Add Range to Chat"). */
export function saveRangeMenuItem(range: { start: number; end: number }): MenuItem {
  return { label: t('Save Range as Media'), onSelect: () => report(window.palmier.extras.saveRangeAsMedia({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) })) }
}

/** Media tab asset menu: shown when any target asset can give up its audio; runs on every target. */
export function extractAudioMenuItem(assets: MediaManifestEntry[]): MenuItem | false {
  if (!assets.some((a) => canExtractAudio(a))) return false
  return { label: t('Extract Audio'), onSelect: () => report(window.palmier.extras.extractAudio(assets.map((a) => a.id))) }
}
