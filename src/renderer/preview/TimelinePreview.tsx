import { useEffect, useLayoutEffect, useRef } from 'react'
import { expandToLinkGroup, totalFrames } from '@core/timeline'
import { editor, selectClips, useEditor } from '../state/editor'
import { beginScrub, endScrub, scrub, seek, step, togglePlay, usePlayhead } from '../state/playback'
import { useProject, useTimeline } from '../state/project'
import { Icon } from '../ui/Icon'
import { CanvasArea } from './CanvasArea'
import { CaptionPreviewOverlay, useCaptionPreviewShown } from './CaptionPreviewOverlay'
import { CropOverlay } from './CropOverlay'
import { engineCanvas, resizeEngine, useEngineError } from './engineHost'
import { croppableClip, hitTestPreview, selectedVisualClip, type Size } from './geometry'
import { GuidesOverlay } from './Guides'
import { OfflineOverlay } from './OfflineOverlay'
import { TimelineGenerationOverlay } from '../generation/PreviewStatus'
import { GuidesButton, ScrubBar, SpeedBadge, Timecode, TransportBar, TransportButtons, ZoomBadge } from './Transport'
import { TransformOverlay } from './TransformOverlay'
import { SlipTwoUp } from './SlipTwoUp'
import { setPreviewZoom, usePreviewView } from './view'
import { CaptureFrameButton } from '../extras/CaptureFrameButton'
import { ChromaSamplerOverlay, chromaSamplingActive, useChromaSampler } from '../extras/ChromaSampler'
import { beep } from '../ui/toast'
import { t } from '../i18n'

function EngineSurface({ size }: { size: Size }) {
  const ref = useRef<HTMLDivElement>(null)
  const error = useEngineError((s) => s.error)
  useLayoutEffect(() => {
    ref.current!.appendChild(engineCanvas)
  }, [])
  useEffect(() => resizeEngine(size.w, size.h), [size.w, size.h])
  return (
    <div ref={ref} className="pp-engine-surface">
      {error && (
        <div className="pp-source-center pp-engine-error">
          <Icon sf="exclamationmark.triangle.fill" size={22} />
          <span className="title">{t('Preview Unavailable')}</span>
          <span className="detail">{error}</span>
        </div>
      )}
    </div>
  )
}

function ClipOverlays({ size, box }: { size: Size; box: () => DOMRect }) {
  const t = useTimeline()
  const ids = useEditor((s) => s.selectedClipIds)
  const cropping = useEditor((s) => s.cropEditing)
  const frame = usePlayhead((s) => (s.playing ? -1 : s.frame))
  const assets = useProject((s) => s.snapshot?.doc.manifest)
  if (!t || frame < 0) return null
  const clip = selectedVisualClip(t, ids)
  if (!clip || frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) return null
  if (cropping && croppableClip(t, ids) === clip) return <CropOverlay clip={clip} frame={frame} canvas={size} container={box} />
  const asset = assets?.entries.find((e) => e.id === clip.mediaRef)
  const child = clip.sourceClipType === 'sequence' ? useProject.getState().snapshot?.doc.file.timelines.find((x) => x.id === clip.mediaRef) : undefined
  const sw = asset?.sourceWidth ?? child?.width
  const sh = asset?.sourceHeight ?? child?.height
  return <TransformOverlay clip={clip} frame={frame} canvas={size} mediaAspect={sw && sh ? sw / sh : null} container={box} />
}

function TimelineTransport() {
  const t = useTimeline()
  const frame = usePlayhead((s) => s.frame)
  const playing = usePlayhead((s) => s.playing)
  const zoom = usePreviewView((s) => s.zoom)
  const total = t ? totalFrames(t) : 0
  const fps = t?.fps ?? 30
  return (
    <>
      <ScrubBar frame={frame} total={total} onBegin={beginScrub} onScrub={scrub} onEnd={endScrub} />
      <TransportBar
        left={<Timecode frame={frame} total={total} fps={fps} />}
        center={<TransportButtons playing={playing} actions={{ toStart: () => seek(0), stepBack: (s) => step(s ? -5 : -1), toggle: togglePlay, stepForward: (s) => step(s ? 5 : 1), toEnd: () => seek(total) }} />}
        right={
          <>
            <CaptureFrameButton source={() => ({ kind: 'timeline', frame: usePlayhead.getState().frame })} />
            <GuidesButton />
            <SpeedBadge />
            <ZoomBadge zoom={zoom} setZoom={(z) => setPreviewZoom(z)} />
          </>
        }
      />
    </>
  )
}

export function TimelinePreview() {
  const t = useTimeline()
  // While shown, the caption preview takes precedence over the transform overlay and click-to-select (05 §5.3).
  const captionPreview = useCaptionPreviewShown()
  const sampling = useChromaSampler((s) => !!s.clipId)
  return (
    <>
      <CanvasArea
        aspect={t ? t.width / t.height : 16 / 9}
        background="#000"
        onBackgroundPointerDown={() => (chromaSamplingActive() ? beep() : editor().selectedClipIds.length && selectClips([]))}
      >
        {(size, box) => (
          <>
            <EngineSurface size={size} />
            <div
              className="pp-canvas-hit"
              onPointerDown={(e) => {
                if (!t || e.button !== 0 || editor().cropEditing || captionPreview) return
                const r = box()
                const id = hitTestPreview(t, usePlayhead.getState().frame, { x: e.clientX - r.left, y: e.clientY - r.top }, size)
                selectClips(id ? [...expandToLinkGroup(t, [id])] : [])
              }}
            />
            {t && <TimelineGenerationOverlay timeline={t} />}
            {t && <OfflineOverlay timeline={t} />}
            <GuidesOverlay size={size} />
            {sampling ? <ChromaSamplerOverlay /> : captionPreview ? <CaptionPreviewOverlay size={size} /> : <ClipOverlays size={size} box={box} />}
            <SlipTwoUp />
          </>
        )}
      </CanvasArea>
      <TimelineTransport />
    </>
  )
}
