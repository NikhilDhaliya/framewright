import { useState } from 'react'
import type { ClipType, MediaManifestEntry } from '@core/model'
import { useFileSize } from '../state/fileStat'
import { originalPath } from '../state/mediaPaths'
import { IconButton } from '../ui/buttons'
import { MiddleTruncate } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import { Popover, rectOf, type AnchorRect } from '../ui/Popover'
import { PanelHeader } from '../ui/panels'
import { shortDuration } from './ProjectSettings'
import { AssetAIEdit } from '../generation/AIEditTab'
import { GenerationInputGroup } from '../generation/GenerationInputGroup'
import { t } from '../i18n'

export const TYPE_ICON: Record<ClipType, SFName> = {
  video: 'video',
  audio: 'waveform',
  image: 'photo',
  text: 'textformat',
  lottie: 'sparkles',
  sequence: 'film.stack',
  subtitle: 'captions.bubble',
}

const TYPE_NAME: Record<ClipType, string> = { video: t('Video'), audio: t('Audio'), image: t('Image'), text: t('Text'), lottie: t('Animation'), sequence: t('Timeline'), subtitle: t('Subtitles') }

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB']

function formatBytes(n: number): string {
  let i = 0
  let v = n
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000
    i++
  }
  return i === 0 ? t('{0} bytes', n) : `${v.toFixed(v < 10 ? 1 : 0)} ${UNITS[i]}`
}

function InfoRows({ asset }: { asset: MediaManifestEntry }) {
  const path = originalPath(asset) ?? ('project' in asset.source ? asset.source.project.relativePath : '')
  const size = useFileSize(originalPath(asset))
  const rows: [string, string][] = [[t('Type'), TYPE_NAME[asset.type]]]
  if (asset.type !== 'audio' && asset.sourceWidth && asset.sourceHeight) rows.push([t('Dimensions'), `${asset.sourceWidth} × ${asset.sourceHeight}`])
  if (asset.sourceFPS) rows.push([t('FPS'), t('{0} fps', Number(asset.sourceFPS.toFixed(3)))])
  if (asset.type !== 'image') rows.push([t('Duration'), shortDuration(asset.duration)])
  if (typeof size === 'number') rows.push([t('Size'), formatBytes(size)])
  return (
    <div className="pp-insp-info">
      {rows.map(([k, v]) => (
        <div key={k} className="pp-insp-info-row">
          <span className="pp-insp-info-label">{k}</span>
          <span className="pp-insp-info-value tnum">{v}</span>
        </div>
      ))}
      <div className="pp-insp-info-row" data-tip={path}>
        <span className="pp-insp-info-label">{t('Path')}</span>
        <MiddleTruncate className="pp-insp-info-value" text={path} tail={18} />
      </div>
    </div>
  )
}

export function AssetInspector({ asset }: { asset: MediaManifestEntry }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  return (
    <div className="pp-insp-root">
      <PanelHeader className="pp-insp-header">
        <span className="pp-insp-header-icon">
          <Icon sf={TYPE_ICON[asset.type]} size={12} />
        </span>
        <span className="pp-insp-header-title" data-tip={asset.name} style={{ minWidth: 0 }}>
          <MiddleTruncate text={asset.name} />
        </span>
        <span style={{ flex: 1 }} />
        <IconButton
          sf={anchor ? 'info.circle.fill' : 'info.circle'}
          size={13}
          frame={26}
          tone={anchor ? 'primary' : 'tertiary'}
          tip={anchor ? t('Hide Info') : t('Show Info')}
          onClick={(e) => setAnchor(anchor ? null : rectOf(e.currentTarget))}
        />
      </PanelHeader>
      {anchor && (
        <Popover anchor={anchor} align="end" onClose={() => setAnchor(null)} className="pp-insp-info-popover">
          <InfoRows asset={asset} />
        </Popover>
      )}
      <div className="pp-insp-empty">
        <InfoRows asset={asset} />
      </div>
      <AssetAIEdit asset={asset} lead={asset.generationInput ? <GenerationInputGroup gen={asset.generationInput} /> : undefined} />
    </div>
  )
}
