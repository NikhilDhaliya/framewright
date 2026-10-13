/** Generation visuals on media tiles (05 §4.5, §3.7): generating overlay, failed state and the "AI" badge. */
import { useEffect, useState } from 'react'
import { displayStatus, STATUS_LABELS, stringList } from '@core/generation/status'
import type { MediaManifestEntry } from '@core/model'
import { Icon } from '../ui/Icon'
import { loadThumbnail } from '../media/thumbnails'
import './generation.css'
import { t } from '../i18n'

/** First reference image of a generated asset (shown blurred behind the generating overlay). */
export function referenceImageId(e: MediaManifestEntry): string | null {
  const input = e.generationInput
  if (!input) return null
  return stringList(input.imageURLAssetIds)[0] ?? stringList(input.referenceImageAssetIds)[0] ?? null
}

export function useThumb(assetId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!assetId) return setUrl(null)
    let alive = true
    void loadThumbnail(assetId).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [assetId])
  return url
}

/** "Generating…" + progress bar that eases to 90 % over 45 s, with a shimmer (§3.7). */
export function GeneratingOverlay({ label, size = 'thumbnail' }: { label: string; size?: 'thumbnail' | 'preview' }) {
  return (
    <div className={`pp-gen-overlay ${size}`}>
      <span className="pp-gen-overlay-label">{label}</span>
      <span className="pp-gen-overlay-track">
        <span className="pp-gen-overlay-fill" />
      </span>
      <span className="pp-gen-shimmer" />
    </div>
  )
}

export function isGeneratingEntry(e: MediaManifestEntry): boolean {
  const s = displayStatus(e)
  return s.kind !== 'none' && s.kind !== 'failed'
}

/** Overlay for a tile's thumbnail box, or null when the asset is ready. */
export function TileGenerationStatus({ entry }: { entry: MediaManifestEntry }) {
  const status = displayStatus(entry)
  const refId = status.kind !== 'none' && status.kind !== 'failed' ? referenceImageId(entry) : null
  const ref = useThumb(refId)
  if (status.kind === 'none') return entry.generationInput ? <span className="pp-gen-ai-badge">AI</span> : null
  if (status.kind === 'failed') {
    return (
      <div className="pp-gen-failed" data-tip={status.message}>
        <Icon sf="exclamationmark.triangle.fill" size={14} className="pp-gen-failed-icon" />
        <span className="pp-gen-failed-title">{t('Failed')}</span>
        {status.message && <span className="pp-gen-failed-text">{status.message}</span>}
      </div>
    )
  }
  return (
    <div className="pp-gen-generating">
      {ref && <img className="pp-gen-ref-blur" src={ref} alt="" draggable={false} />}
      <span className="pp-gen-scrim" />
      <GeneratingOverlay label={t(STATUS_LABELS[status.kind])} />
    </div>
  )
}
