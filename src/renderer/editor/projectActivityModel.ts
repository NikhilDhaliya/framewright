/**
 * Project Activity rows (spec 06 §B11 Linux plan): the Mac's backend `generations:projectActivity` list replaced by a
 * local list built from the media library — every asset with `generationInput` (failed ones included), newest first.
 * No credits. Pure; the popover is ProjectActivity.tsx.
 */
import type { MediaManifestEntry } from '@core/model'
import type { ModelKind } from '@core/generation/catalog'
import { modelSet, type ModelSet } from '@core/generation/models'
import { parseStatus, STATUS_LABELS } from '@core/generation/status'
import { t } from '../i18n'

/** Mac reference date (2001-01-01 UTC) in Unix seconds; `generationInput.createdAt` is stored against it (01 §5.14). */
const REF_DATE_OFFSET = 978307200

export type ActivityState = 'inFlight' | 'failed' | 'ready'

export interface ActivityEntry {
  id: string
  /** SF symbol of the model kind (ProjectActivityView.symbolName). */
  icon: 'video.fill' | 'photo.fill' | 'music.note' | 'arrow.up.right.square.fill' | 'sparkles'
  model: string
  state: ActivityState
  /** `Generating…` (or the current phase), `Failed`, or '' when ready. */
  status: string
  /** Unix ms, or null when the asset carries no creation time. */
  createdAt: number | null
  /** The failure message, for the row tooltip. */
  error?: string
}

const ICONS: Record<ModelKind, ActivityEntry['icon']> = {
  video: 'video.fill',
  image: 'photo.fill',
  audio: 'music.note',
  upscale: 'arrow.up.right.square.fill',
}

let catalog: ModelSet | null = null
const defaultCatalog = (): ModelSet => (catalog ??= modelSet(() => false))

function createdAtMs(e: MediaManifestEntry): number | null {
  const v = e.generationInput?.createdAt ?? e.importInput?.createdAt
  return typeof v === 'number' && Number.isFinite(v) ? (v + REF_DATE_OFFSET) * 1000 : null
}

export function activityEntries(entries: readonly MediaManifestEntry[], set: ModelSet = defaultCatalog()): ActivityEntry[] {
  const rows: ActivityEntry[] = []
  for (const e of entries) {
    const input = e.generationInput
    if (!input) continue
    const modelId = typeof input.model === 'string' ? input.model : ''
    const m = modelId ? set.find(modelId) : undefined
    const st = parseStatus(e.generationStatus)
    const state: ActivityState = st.kind === 'failed' ? 'failed' : st.kind === 'none' ? 'ready' : 'inFlight'
    rows.push({
      id: e.id,
      icon: m ? ICONS[m.kind] : 'sparkles',
      model: m?.displayName ?? (modelId || e.name),
      state,
      status: st.kind === 'failed' ? t('Failed') : st.kind === 'none' ? '' : t(STATUS_LABELS[st.kind]),
      createdAt: createdAtMs(e),
      error: st.kind === 'failed' && st.message ? st.message : undefined,
    })
  }
  return rows.sort((a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity))
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

/** RelativeDateTimeFormatter `.abbreviated` equivalent, e.g. "5 min. ago". */
export function relativeTime(ms: number, now = Date.now(), locale?: string): string {
  const fmt = new Intl.RelativeTimeFormat(locale, { style: 'short', numeric: 'always' })
  const diff = Math.round((ms - now) / 1000)
  for (const [unit, sec] of UNITS) if (Math.abs(diff) >= sec || unit === 'second') return fmt.format(Math.trunc(diff / sec), unit)
  return ''
}
