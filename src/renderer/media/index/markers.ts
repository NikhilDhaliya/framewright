/** Index ▸ Markers helpers (Mac `MarkerBrowserNavigation`, `MarkerThumbnailMetrics`). Pure. */
import type { MarkerStatus, TimelineMarker } from '@core/model'
import { tk } from '../../../shared/i18n'

export const MARKER_STATUSES: { status: MarkerStatus; title: string; color: string }[] = [
  { status: 'open', title: tk('Open'), color: 'var(--pp-status-pending)' },
  { status: 'review', title: tk('Review'), color: 'var(--pp-status-warning)' },
  { status: 'resolved', title: tk('Resolved'), color: 'var(--pp-status-success)' },
]

export const statusInfo = (s: MarkerStatus) => MARKER_STATUSES.find((x) => x.status === s) ?? MARKER_STATUSES[0]

/** Markers matching `query` (name or comment, case-insensitive) and `status`, sorted by (startFrame, id). */
export function sortedMarkers(markers: readonly TimelineMarker[], query: string, status: MarkerStatus | null = null): TimelineMarker[] {
  const q = query.trim().toLocaleLowerCase()
  return markers
    .filter((m) => (status === null || m.status === status) && (!q || m.name.toLocaleLowerCase().includes(q) || m.comment.toLocaleLowerCase().includes(q)))
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Thumbnail box: the canvas aspect at the given height; zero for a degenerate canvas. */
export function markerThumbnailSize(canvasW: number, canvasH: number, height: number): { w: number; h: number } {
  if (!(canvasW > 0 && canvasH > 0 && height > 0)) return { w: 0, h: 0 }
  return { w: (canvasW * height) / canvasH, h: height }
}
