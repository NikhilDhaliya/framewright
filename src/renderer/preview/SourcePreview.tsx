import { useEffect, useRef, useState } from 'react'
import type { MediaManifestEntry } from '@core/model'
import { mediaUrl } from '../../shared/api'
import { originalPath } from '../state/mediaPaths'
import { useTimeline } from '../state/project'
import { Spinner } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { CanvasArea } from './CanvasArea'
import { GuidesOverlay } from './Guides'
import { sourcePlayer } from './sourcePlayer'
import { takeSourceSeek, useSourceSeek } from '../media/search/sourceSeek'
import { GuidesButton, ScrubBar, Timecode, TransportBar, TransportButtons, ZoomBadge } from './Transport'
import { setPreviewZoom, usePreviewView } from './view'
import { SubtitlePreview } from '../media/captions/subtitles'
import { LottiePreview } from './LottiePreview'
import { GenerationSourcePreview, hasPreviewGenerationState } from '../generation/PreviewStatus'
import { CaptureFrameButton } from '../extras/CaptureFrameButton'
import { useOffline } from '../media/offline'
import { OfflinePanel } from './OfflineOverlay'
import { t } from '../i18n'

/**
 * Playable URL of the asset. Re-resolved only when the asset's source actually changes (relink, swap, generation
 * finishing) — not on every doc change, which hands us a fresh entry object and would reload the element (playback
 * back to 0 s, timecode stale).
 */
function useMediaSrc(asset: MediaManifestEntry): string | null | undefined {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  const sourceKey = `${asset.id}|${asset.type}|${originalPath(asset) ?? ''}|${asset.generationStatus ?? ''}`
  const assetRef = useRef(asset)
  assetRef.current = asset
  useEffect(() => {
    let live = true
    const a = assetRef.current
    setSrc(undefined)
    if (a.type === 'image') setSrc(originalPath(a) ? mediaUrl(originalPath(a)!) : null)
    else void window.palmier.media.playbackPath(a.id).then((p) => live && setSrc(p ? mediaUrl(p) : null))
    return () => {
      live = false
    }
  }, [sourceKey])
  return src
}

function ZoomOnly() {
  const zoom = usePreviewView((s) => s.zoom)
  return (
    <TransportBar
      left={null}
      right={
        <>
          <GuidesButton />
          <ZoomBadge zoom={zoom} setZoom={(z) => setPreviewZoom(z)} />
        </>
      }
    />
  )
}

function ImagePreview({ asset }: { asset: MediaManifestEntry }) {
  const src = useMediaSrc(asset)
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading')
  const aspect = (asset.sourceWidth ?? 16) / (asset.sourceHeight ?? 9)
  return (
    <>
      <CanvasArea aspect={aspect} background="#000">
        {(size) => (
          <>
            {src && <img className="pp-source-media" src={src} alt="" onLoad={() => setState('ok')} onError={() => setState('failed')} />}
            {state === 'loading' && <div className="pp-source-center"><Spinner /></div>}
            {(state === 'failed' || src === null) && <div className="pp-source-center tone-tertiary"><Icon sf="photo" size={18} /></div>}
            <GuidesOverlay size={size} />
          </>
        )}
      </CanvasArea>
      <ZoomOnly />
    </>
  )
}

function PlayablePreview({ asset }: { asset: MediaManifestEntry }) {
  const src = useMediaSrc(asset)
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const fps = useTimeline()?.fps ?? 30
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const zoom = usePreviewView((s) => s.zoom)
  const total = Math.max(0, Math.floor(asset.duration * fps))
  const isVideo = asset.type === 'video'

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const tick = () => {
      setFrame(Math.floor(el.currentTime * fps))
      if (!el.paused) raf = requestAnimationFrame(tick)
    }
    const onPlay = () => {
      setPlaying(true)
      tick()
    }
    const onPause = () => {
      setPlaying(false)
      cancelAnimationFrame(raf)
      tick()
    }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', tick)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', tick)
    }
  }, [fps, src])

  const seekTo = (f: number) => {
    const el = ref.current
    if (!el) return
    const clamped = Math.max(0, Math.min(total, f))
    el.currentTime = clamped / fps
    setFrame(clamped)
  }
  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) {
      if (frame >= total) seekTo(0)
      void el.play()
    } else el.pause()
  }
  const stepBy = (n: number) => {
    ref.current?.pause()
    seekTo(frame + n)
  }
  useEffect(() => {
    sourcePlayer.current = { toggle, step: stepBy }
    return () => {
      sourcePlayer.current = null
    }
  })
  // Smart search hits seek the source preview to the hit (05 §4.10).
  const seekRequest = useSourceSeek((s) => s.request)
  useEffect(() => {
    const el = ref.current
    if (!el || !src || seekRequest?.assetId !== asset.id) return
    const apply = () => {
      const r = takeSourceSeek(asset.id)
      if (!r) return
      el.pause()
      seekTo(Math.round(r.seconds * fps))
    }
    if (el.readyState >= 1) return apply()
    el.addEventListener('loadedmetadata', apply, { once: true })
    return () => el.removeEventListener('loadedmetadata', apply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest, src, asset.id, fps])

  const media = isVideo ? <video ref={ref} className="pp-source-media" src={src ?? undefined} preload="auto" /> : <audio ref={ref} src={src ?? undefined} preload="auto" />
  return (
    <>
      <CanvasArea aspect={isVideo ? (asset.sourceWidth ?? 16) / (asset.sourceHeight ?? 9) : 16 / 9} background="#000">
        {(size) => (
          <>
            {media}
            {!isVideo && (
              <div className="pp-source-center tone-tertiary">
                <Icon sf="waveform" size={28} />
              </div>
            )}
            {src === undefined && <div className="pp-source-center"><Spinner /></div>}
            {isVideo && <GuidesOverlay size={size} />}
          </>
        )}
      </CanvasArea>
      <ScrubBar frame={frame} total={total} onBegin={() => ref.current?.pause()} onScrub={seekTo} onEnd={() => undefined} />
      <TransportBar
        left={<Timecode frame={frame} total={total} fps={fps} />}
        center={<TransportButtons playing={playing} actions={{ toStart: () => seekTo(0), stepBack: (s) => stepBy(s ? -5 : -1), toggle, stepForward: (s) => stepBy(s ? 5 : 1), toEnd: () => seekTo(total) }} />}
        right={
          <>
            {isVideo && <CaptureFrameButton source={() => ({ kind: 'media', mediaRef: asset.id, sourceSeconds: frame / fps })} />}
            {isVideo && <GuidesButton />}
            <ZoomBadge zoom={zoom} setZoom={(z) => setPreviewZoom(z)} />
          </>
        }
      />
    </>
  )
}

/** Offline / unprocessable asset (Mac `offlinePreview` on a media tab): black canvas with the offline panel. */
function OfflineSourcePreview({ asset, unprocessable }: { asset: MediaManifestEntry; unprocessable: boolean }) {
  const aspect = asset.sourceWidth && asset.sourceHeight ? asset.sourceWidth / asset.sourceHeight : 16 / 9
  return (
    <>
      <CanvasArea aspect={aspect} background="#000">
        {() => <OfflinePanel asset={asset} unprocessable={unprocessable} />}
      </CanvasArea>
      <ZoomOnly />
    </>
  )
}

export function SourcePreview({ asset }: { asset: MediaManifestEntry }) {
  const offline = useOffline((s) => s.offline.has(asset.id))
  const unprocessable = useOffline((s) => !s.missing.has(asset.id))
  if (hasPreviewGenerationState(asset)) return <GenerationSourcePreview key={asset.id} asset={asset} />
  if (offline) return <OfflineSourcePreview key={asset.id} asset={asset} unprocessable={unprocessable} />
  if (asset.type === 'image') return <ImagePreview key={asset.id} asset={asset} />
  if (asset.type === 'video' || asset.type === 'audio') return <PlayablePreview key={asset.id} asset={asset} />
  if (asset.type === 'subtitle') return <SubtitlePreview key={asset.id} asset={asset} />
  if (asset.type === 'lottie') return <LottiePreview key={asset.id} asset={asset} />
  return <div className="pp-source-unsupported">{t('Preview isn’t available for this file type on Linux yet.')}</div>
}
