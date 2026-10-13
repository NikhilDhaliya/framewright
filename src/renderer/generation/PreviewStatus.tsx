/**
 * Generation states in the preview (05 §5.3 overlay stack 3–4): the generating overlay (reference image blurred,
 * scrim, `GeneratingOverlay` at preview size) and the "Generation Failed" panel with optional Retry Download.
 * Used for library assets (source tab) and for the topmost clip under the playhead (timeline tab).
 */
import { useState } from 'react'
import { displayStatus, resultURLsOf, STATUS_LABELS } from '@core/generation/status'
import type { MediaManifestEntry, Timeline } from '@core/model'
import { usePlayhead } from '../state/playback'
import { useProject } from '../state/project'
import { Icon } from '../ui/Icon'
import { toast } from '../ui/toast'
import { CanvasArea } from '../preview/CanvasArea'
import { GeneratingOverlay, referenceImageId, useThumb } from './TileStatus'
import './generation.css'
import { t } from '../i18n'

/** True when the preview should show a generation state instead of the media (generating or failed). */
export const hasPreviewGenerationState = (e: MediaManifestEntry): boolean => displayStatus(e).kind !== 'none'

export function PreviewGenerationOverlay({ asset }: { asset: MediaManifestEntry }) {
  const status = displayStatus(asset)
  const ref = useThumb(status.kind !== 'none' && status.kind !== 'failed' ? referenceImageId(asset) : null)
  const [busy, setBusy] = useState(false)
  if (status.kind === 'none') return null
  if (status.kind === 'failed') {
    const canRetry = resultURLsOf(asset.generationInput).length > 0
    const retry = async () => {
      setBusy(true)
      try {
        if (!(await window.palmier.generation.retryDownload(asset.id))) toast(t('Download failed. The result may have expired.'), 'error')
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="pp-gen-preview-failed">
        <Icon sf="exclamationmark.triangle.fill" size={36} className="pp-gen-failed-icon" />
        <span className="pp-gen-preview-failed-title">{t('Generation Failed')}</span>
        {status.message && <div className="pp-gen-preview-failed-text">{status.message}</div>}
        {canRetry && (
          <button type="button" className="pp-gen-preview-retry" disabled={busy} onClick={() => void retry()}>
            <Icon sf="arrow.clockwise" size={11} />
            {t('Retry Download')}
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="pp-gen-generating preview">
      {ref && <img className="pp-gen-ref-blur" src={ref} alt="" draggable={false} />}
      <span className="pp-gen-scrim" />
      <GeneratingOverlay label={t(STATUS_LABELS[status.kind])} size="preview" />
    </div>
  )
}

/** Source-tab preview of a generating or failed library asset. */
export function GenerationSourcePreview({ asset }: { asset: MediaManifestEntry }) {
  const aspect = (asset.sourceWidth ?? 16) / (asset.sourceHeight ?? 9)
  return (
    <CanvasArea aspect={asset.type === 'audio' ? 16 / 9 : aspect} background="#000">
      {() => <PreviewGenerationOverlay asset={asset} />}
    </CanvasArea>
  )
}

/** Asset of the topmost visible video/image clip at `frame` (track 0 is topmost). */
function topAssetAt(t: Timeline, frame: number): string | null {
  for (const tr of t.tracks) {
    if (tr.hidden) continue
    const c = tr.clips.find((x) => (x.mediaType === 'video' || x.mediaType === 'image') && x.sourceClipType !== 'sequence' && x.startFrame <= frame && frame < x.startFrame + x.durationFrames)
    if (c) return c.mediaRef
  }
  return null
}

/** Timeline-tab overlay for the clip on screen whose asset is still generating or failed. */
export function TimelineGenerationOverlay({ timeline }: { timeline: Timeline }) {
  const assetId = usePlayhead((s) => topAssetAt(timeline, s.frame))
  const asset = useProject((s) => (assetId ? s.snapshot?.doc.manifest.entries.find((e) => e.id === assetId) : undefined))
  if (!asset || !hasPreviewGenerationState(asset)) return null
  return <PreviewGenerationOverlay asset={asset} />
}
