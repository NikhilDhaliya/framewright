import { useEffect, useMemo, useState } from 'react'
import type { MediaManifestEntry, Timeline } from '@core/model'
import { FEEDBACK_ISSUE_URL } from '../../shared/brand'
import { feedbackIssueUrl } from '../../shared/firstRun'
import { offlineAssetAt } from '../media/mediaRules'
import { relinkAsset, relinkFolder, useOffline } from '../media/offline'
import { originalPath } from '../state/mediaPaths'
import { previewEngine, usePlayhead } from '../state/playback'
import { useProject } from '../state/project'
import { Capsule } from '../ui/buttons'
import { MiddleTruncate } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { t } from '../i18n'

/** `unprocessablePrefill(path:)`. */
const unprocessablePrefill = (path: string | null) => `A clip's media couldn't be prepared for playback.\n\nFile: ${path ? path.slice(path.lastIndexOf('/') + 1) : '(unknown)'}\n\nWhat were you doing when this happened?`

/** "Report a Problem": no Palmier backend on Linux, so it opens a prefilled issue (like Help ▸ Send Feedback). */
async function reportProblem(path: string | null): Promise<void> {
  const info = await window.palmier.feedback.systemInfo()
  window.palmier.app.openExternal(feedbackIssueUrl(FEEDBACK_ISSUE_URL, unprocessablePrefill(path), info))
}

/** "Media Offline" / "Couldn't Prepare Media" panel (§5.3) for the clip on screen whose file can't be used. */
export function OfflineOverlay({ timeline }: { timeline: Timeline }) {
  const entries = useProject((s) => s.snapshot?.doc.manifest.entries)
  const offline = useOffline((s) => s.offline)
  const missing = useOffline((s) => s.missing)
  const byId = useMemo(() => new Map((entries ?? []).map((e) => [e.id, e])), [entries])
  const assetId = usePlayhead((s) => offlineAssetAt(timeline, s.frame, byId, offline))
  const asset = assetId ? byId.get(assetId) : undefined
  // The panel replaces the engine's own grey "Media Offline" placeholder text.
  const shown = !!asset
  useEffect(() => {
    if (!shown) return
    previewEngine()?.setOfflineLabel?.(false)
    return () => previewEngine()?.setOfflineLabel?.(true)
  }, [shown])
  if (!asset) return null
  return <OfflinePanel asset={asset} unprocessable={!missing.has(asset.id)} />
}

/** The offline panel itself; also shown by the media-tab source preview for an offline asset. */
export function OfflinePanel({ asset, unprocessable }: { asset: MediaManifestEntry; unprocessable: boolean }) {
  const [busy, setBusy] = useState(false)
  const path = originalPath(asset)
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pp-offline" data-testid="offline-overlay">
      <Icon sf="exclamationmark.triangle.fill" size={36} className="pp-offline-icon" />
      <span className="pp-offline-title">{unprocessable ? t('Couldn’t Prepare Media') : t('Media Offline')}</span>
      <span className="pp-offline-detail">
        {unprocessable
          ? t("{app} loaded this clip's source file but couldn't prepare it for playback. The file may be corrupt or in an unsupported format.")
          : t("{app} couldn't load this clip's source file. It may be missing, on an ejected drive, or unreadable.")}
      </span>
      {path && <MiddleTruncate text={path} className="pp-offline-path" />}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {unprocessable ? (
          <Capsule variant="prominent" size="regular" onClick={() => void reportProblem(path)}>
            {t('Report a Problem')}
          </Capsule>
        ) : (
          <>
            <Capsule variant="prominent" size="regular" disabled={busy} onClick={() => void run(() => relinkAsset(asset.id))()}>
              {t('Relink…')}
            </Capsule>
            <Capsule variant="secondary" size="regular" disabled={busy} onClick={() => void run(() => relinkFolder())()}>
              {t('Relink Folder…')}
            </Capsule>
          </>
        )}
      </div>
    </div>
  )
}
