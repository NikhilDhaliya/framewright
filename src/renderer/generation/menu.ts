/** Generation items for the media asset context menu: Cancel Generation, Retry Download (§B4.5) and AI Edit ▸ (§B9.3). */
import { parseStatus, isForeignJob, resultURLsOf } from '@core/generation/status'
import type { MediaManifestEntry } from '@core/model'
import type { MenuItem } from '../ui/Menu'
import { toast } from '../ui/toast'
import { aiEditItems } from './aiEdit'
import { t } from '../i18n'

export function generationMenuItems(e: MediaManifestEntry): MenuItem[] {
  const items: MenuItem[] = []
  const input = e.generationInput
  if (input) {
    const status = parseStatus(e.generationStatus)
    const inFlight = status.kind !== 'none' && status.kind !== 'failed'
    if (inFlight && !isForeignJob(e)) {
      items.push({ label: t('Cancel Generation'), onSelect: () => void window.palmier.generation.cancel(e.id) })
    }
    if (status.kind === 'failed' && resultURLsOf(input).length) {
      items.push({
        label: t('Retry Download'),
        onSelect: () =>
          void window.palmier.generation.retryDownload(e.id).then((ok) => {
            if (!ok) toast(t('Download failed. The result may have expired.'), 'error')
          }),
      })
    }
  }
  const ai = aiEditItems(e, null)
  if (ai.length) items.push({ label: t('AI Edit'), submenu: ai })
  return items
}
