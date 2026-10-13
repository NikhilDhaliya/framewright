/** Smart search status for this window (spec 07 §2.6), pushed by main over `search:status`. */
import { create } from 'zustand'
import type { SearchStatus } from '../../../shared/search'
import { t } from '../../i18n'

export const useSearchStatus = create<{ status: SearchStatus | null }>(() => ({ status: null }))

let started = false

/** Idempotent: first fetch + subscription to pushes. */
export function startSearchStatus(): void {
  if (started || !window.palmier?.search) return
  started = true
  void window.palmier.search.status().then((s) => useSearchStatus.setState({ status: s }))
  window.palmier.search.onStatus((s) => useSearchStatus.setState({ status: s }))
}

/** `ByteCountFormatter(.file)`: decimal (1000-based) units; KB whole, MB one decimal, GB+ two ("378.2 MB"). */
export function formatFileBytes(bytes: number): string {
  if (bytes <= 0) return t('Zero KB')
  if (bytes < 1000) return t('{0} bytes', bytes)
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  if (i === 0) return `${Math.round(v)} KB`
  return `${v.toFixed(i === 1 ? 1 : 2)} ${units[i]}`
}

/** `M:SS`, or `H:MM:SS` from an hour (Mac `timecode`, rounded seconds). */
export function searchTimecode(seconds: number): string {
  const s = Math.round(seconds)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`
}
