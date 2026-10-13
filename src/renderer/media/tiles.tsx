import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MediaFolder, MediaManifestEntry, Timeline } from '@core/model'
import type { MediaKey } from '../state/editor'
import { InlineRename, MiddleTruncate } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { acceptsFolderDrop, beginRename, cancelRename, clickItem, commitRename, dragStartItem, dropIntoFolder, itemContextMenu } from './interactions'
import { TYPE_COLOR, TYPE_ICON, formatBadgeDuration, timelineSeconds } from './model'
import { cachedThumbnail, cachedWaveform, loadThumbnail, loadWaveform, useLazy } from './thumbnails'
import { AddToChatButton } from '../agent/handoffs'
import { isGeneratingEntry, TileGenerationStatus } from '../generation/TileStatus'
import { tileOffline } from './mediaRules'
import { useOffline } from './offline'
import { completeMediaSwap } from './swap'
import { t } from '../i18n'

interface ScaffoldProps {
  itemKey: MediaKey
  width: number
  selected: boolean
  name: string
  renaming: boolean
  nameWeight: 'regular' | 'medium'
  /** Optional element before the name (active-timeline dot). */
  namePrefix?: ReactNode
  artwork: ReactNode
  bar?: string | null
  dropHover?: boolean
  onNameDoubleClick?: () => void
  dropHandlers?: Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
  /** Extra state classes (`missing`, `swap-ok`, `swap-dim`). */
  stateClass?: string
  /** Replaces click selection (swap mode completes the swap instead). */
  onPick?: () => void
}

function TileScaffold({ itemKey, width, selected, name, renaming, nameWeight, namePrefix, artwork, bar, dropHover, onNameDoubleClick, dropHandlers, stateClass, onPick }: ScaffoldProps) {
  return (
    <div
      className={`pp-media-tile${selected ? ' selected' : ''}${dropHover ? ' drop-hover' : ''}${stateClass ? ` ${stateClass}` : ''}`}
      style={{ width }}
      data-media-key={itemKey}
      draggable={!renaming && !onPick}
      onClick={(e) => {
        e.stopPropagation()
        if (onPick) onPick()
        else clickItem(itemKey, e)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => itemContextMenu(itemKey, e)}
      onDragStart={(e) => dragStartItem(itemKey, e)}
      {...dropHandlers}
    >
      <div className="pp-media-art">{artwork}</div>
      <div className="pp-media-bar" style={{ background: bar ?? 'transparent' }} />
      <div className={`pp-media-name ${nameWeight}${renaming ? ' editing' : ''}`} onDoubleClick={onNameDoubleClick}>
        {renaming ? (
          <InlineRename className="pp-media-rename" value={name} placeholder={t('Name')} onCommit={(n) => void commitRename(itemKey, n)} onCancel={cancelRename} />
        ) : (
          <>
            {namePrefix}
            <MiddleTruncate text={name} />
          </>
        )}
      </div>
    </div>
  )
}

function Waveform({ peaks }: { peaks: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    c.width = Math.round(w * dpr)
    c.height = Math.round(h * dpr)
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    const bars = Math.max(8, Math.floor(w / 3))
    for (let i = 0; i < bars; i++) {
      const p = peaks[Math.min(peaks.length - 1, Math.floor((i / bars) * peaks.length))]
      const bh = Math.max(1, p * h)
      ctx.fillRect(i * 3, (h - bh) / 2, 2, bh)
    }
  }, [peaks])
  return <canvas ref={ref} className="pp-media-wave" />
}

interface AssetTileProps {
  entry: MediaManifestEntry
  width: number
  selected: boolean
  renaming: boolean
  onTimeline: boolean
  /** Swap mode (§4.5): compatible tiles complete the swap on click; the rest are dimmed and inert. */
  swap?: 'compatible' | 'dimmed' | null
}

const OFFLINE_TIP = t("{app} couldn't load this source file. It may be missing, on an ejected drive, or unreadable.")

export const AssetTile = memo(function AssetTile({ entry, width, selected, renaming, onTimeline, swap = null }: AssetTileProps) {
  const artRef = useRef<HTMLDivElement>(null)
  const visual = entry.type === 'video' || entry.type === 'image' || entry.type === 'lottie'
  const generating = isGeneratingEntry(entry)
  const missing = useOffline((s) => tileOffline(entry, s.offline))
  const thumb = useLazy(artRef, visual && !generating && !missing ? entry.id : null, loadThumbnail, cachedThumbnail)
  const peaks = useLazy(artRef, entry.type === 'audio' && !generating && !missing ? entry.id : null, loadWaveform, cachedWaveform)
  const [failed, setFailed] = useState(false)
  const timed = entry.type === 'video' || entry.type === 'audio'
  const stateClass = swap ? `swap-${swap === 'compatible' ? 'ok' : 'dim'}` : missing ? 'missing' : undefined
  return (
    <TileScaffold
      itemKey={`asset:${entry.id}`}
      width={width}
      selected={selected}
      name={entry.name}
      renaming={renaming}
      nameWeight="regular"
      bar={onTimeline ? TYPE_COLOR[entry.type] : null}
      onNameDoubleClick={() => beginRename(`asset:${entry.id}`)}
      stateClass={stateClass}
      onPick={swap === 'compatible' ? () => void completeMediaSwap(entry.id) : undefined}
      artwork={
        <div ref={artRef} className="pp-media-thumb">
          {missing ? (
            <div className="pp-media-offline" data-tip={OFFLINE_TIP}>
              <Icon sf="exclamationmark.triangle.fill" size={14} className="pp-media-offline-icon" />
              <span className="pp-media-offline-title">{t('Media Offline')}</span>
            </div>
          ) : thumb && !failed ? (
            <img src={thumb} alt="" draggable={false} onError={() => setFailed(true)} />
          ) : peaks ? (
            <Waveform peaks={peaks} />
          ) : (
            <Icon sf={TYPE_ICON[entry.type]} size={18} className="pp-media-type-icon" />
          )}
          {timed && <span className="pp-media-badge br tnum">{formatBadgeDuration(entry.duration)}</span>}
          {(entry.generationInput || entry.generationStatus) && <TileGenerationStatus entry={entry} />}
          {!generating && !swap && <AddToChatButton assetId={entry.id} />}
        </div>
      }
    />
  )
})

interface FolderTileProps {
  folder: MediaFolder
  count: number
  width: number
  selected: boolean
  renaming: boolean
}

export const FolderTile = memo(function FolderTile({ folder, count, width, selected, renaming }: FolderTileProps) {
  const [hover, setHover] = useState(false)
  return (
    <TileScaffold
      itemKey={`folder:${folder.id}`}
      width={width}
      selected={selected}
      name={folder.name}
      renaming={renaming}
      nameWeight="medium"
      dropHover={hover}
      dropHandlers={{
        onDragOver: (e) => {
          if (!acceptsFolderDrop(e, folder.id)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move'
          setHover(true)
        },
        onDragLeave: () => setHover(false),
        onDrop: (e) => {
          setHover(false)
          void dropIntoFolder(e, folder.id)
        },
      }}
      artwork={
        <div className="pp-media-folder-art">
          <Icon sf="folder.fill" size={36} strokeWidth={1} className="pp-media-folder-icon" />
          {count > 0 && <span className="pp-media-badge tr tnum strong">{count}</span>}
        </div>
      }
    />
  )
})

interface TimelineTileProps {
  timeline: Timeline
  posterAssetId: string | null
  active: boolean
  width: number
  selected: boolean
  renaming: boolean
}

export const TimelineTile = memo(function TimelineTile({ timeline, posterAssetId, active, width, selected, renaming }: TimelineTileProps) {
  const artRef = useRef<HTMLDivElement>(null)
  const poster = useLazy(artRef, posterAssetId, loadThumbnail, cachedThumbnail)
  return (
    <TileScaffold
      itemKey={`timeline:${timeline.id}`}
      width={width}
      selected={selected}
      name={timeline.name}
      renaming={renaming}
      nameWeight="medium"
      namePrefix={active ? <span className="pp-media-active-dot" /> : null}
      artwork={
        <div ref={artRef} className="pp-media-timeline-art">
          {poster ? (
            <>
              <img src={poster} alt="" draggable={false} />
              <span className={`pp-media-badge tl${active ? '' : ' dim'}`}>
                <Icon sf="film.stack" size={9} strokeWidth={2} />
              </span>
            </>
          ) : (
            <Icon sf="film.stack" size={18} strokeWidth={1.25} className="pp-media-timeline-icon" />
          )}
          <span className="pp-media-badge br tnum">{formatBadgeDuration(timelineSeconds(timeline))}</span>
        </div>
      }
    />
  )
})
