/** Subtitle assets (spec 07 §1.8): timeline placement as caption groups, and the subtitle preview tab. */
import { useEffect, useState } from 'react'
import type { MediaManifestEntry } from '@core/model'
import { buildCueSpecs, CAPTION_DEFAULT_CENTER, captionTextStyle } from '@core/captions/specBuilder'
import { srtTimestamp } from '@core/captions/subtitleFileParser'
import type { SubtitleCuesOutcome } from '../../../shared/api'
import { textMeasurer } from '../../render/text'
import { getBaseDoc, timelineOf } from '../../state/project'
import { runOp } from '../../state/ops'
import { Icon } from '../../ui/Icon'
import { toast } from '../../ui/toast'
import './captions.css'
import { t, tx } from '../../i18n'

/** `placeCaptions(fromSubtitleAssets:)`: each file becomes one caption group on its own new top track ("Add Captions"). */
export async function placeSubtitleAssets(assetIds: string[]): Promise<string[]> {
  const placed: string[] = []
  for (const id of assetIds) {
    const doc = getBaseDoc()
    const asset = doc?.manifest.entries.find((e) => e.id === id)
    const tl = timelineOf(doc)
    if (!asset || asset.type !== 'subtitle' || !tl) continue
    const out = await window.palmier.ml.subtitleCues(id)
    if (!out.ok) {
      toast(out.offline ? t('Can\'t add captions — "{0}" is offline.', asset.name) : t('Can\'t add captions from "{0}" — {1}', asset.name, tx(out.error)), 'error')
      continue
    }
    const style = captionTextStyle()
    const specs = buildCueSpecs(out.cues, tl.fps, style, CAPTION_DEFAULT_CENTER, (text) => textMeasurer.measure(text, style, tl.width, tl.height), crypto.randomUUID().toUpperCase())
    const ids = await runOp('placeCaptions', { specs, actionName: 'Add Captions' })
    if (ids) placed.push(...ids)
  }
  return placed
}

export const isSubtitleAsset = (id: string): boolean => getBaseDoc()?.manifest.entries.find((e) => e.id === id)?.type === 'subtitle'

/** `SubtitlePreviewView`: a scrolling cue list on the preview-canvas colour. */
export function SubtitlePreview({ asset }: { asset: MediaManifestEntry }) {
  const [state, setState] = useState<SubtitleCuesOutcome | null>(null)
  useEffect(() => {
    let live = true
    void window.palmier.ml.subtitleCues(asset.id).then((r) => live && setState(r))
    return () => {
      live = false
    }
  }, [asset.id, asset.source])
  if (!state) return <div className="pp-subtitle-preview" />
  if (!state.ok) {
    return (
      <div className="pp-subtitle-preview error">
        <Icon sf="captions.bubble" size={26} className="tone-tertiary" />
        <span>{state.error}</span>
      </div>
    )
  }
  return (
    <div className="pp-subtitle-preview">
      {state.cues.map((c, i) => (
        <div key={i} className="pp-subtitle-cue">
          <div className="pp-subtitle-cue-head">
            <span className="index">{i + 1}</span>
            <span className="time">{`${srtTimestamp(c.startSeconds)} --> ${srtTimestamp(c.endSeconds)}`}</span>
          </div>
          <div className="pp-subtitle-cue-text">{c.text}</div>
        </div>
      ))}
    </div>
  )
}
