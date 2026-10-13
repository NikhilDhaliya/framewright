/**
 * Slip two-up (05 §5.9; Mac `Preview/SlipTwoUpView.swift`): while a timeline slip drag is live, the canvas shows the
 * slipped clip's new first ("Start") and last ("End") source frames side by side. Frames refresh at most every 67 ms
 * (latest request wins), decoded at 960 px max. The overlay ignores the pointer.
 */
import { useEffect, useRef, useState } from 'react'
import type { MediaManifestEntry } from '@core/model'
import { formatTimecode } from '@core/time'
import { findClip } from '@core/timeline'
import { mediaUrl } from '../../shared/api'
import { useEditor, type SlipPreview } from '../state/editor'
import { useProject, useTimeline } from '../state/project'
import { t } from '../i18n'

export const SLIP_REFRESH_MS = 67
const MAX_DECODE = 960

interface Request {
  startFrame: number
  endFrame: number
}

/** Seeks a detached <video> to a source frame and copies it into `canvas` (≤ 960 px). Resolves false on failure. */
function grab(video: HTMLVideoElement, seconds: number, canvas: HTMLCanvasElement): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      resolve(ok)
    }
    const onSeeked = () => {
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return finish(false)
      const k = Math.min(1, MAX_DECODE / Math.max(vw, vh))
      const w = Math.max(1, Math.round(vw * k))
      const h = Math.max(1, Math.round(vh * k))
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      canvas.getContext('2d')?.drawImage(video, 0, 0, w, h)
      finish(true)
    }
    const onError = () => finish(false)
    const timeout = setTimeout(() => finish(false), 3000)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    const target = Math.max(0, Math.min(seconds, Number.isFinite(video.duration) ? video.duration : seconds))
    if (video.readyState >= 1 && Math.abs(video.currentTime - target) < 1e-4) {
      // Same time again: no 'seeked' would fire.
      onSeeked()
      return
    }
    video.currentTime = target
  })
}

function makeVideo(src: string): HTMLVideoElement {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.src = src
  return v
}

/** Which asset the two-up decodes: the slip's clip, when it is a video file clip (not a nested sequence). */
function useSlipAsset(slip: SlipPreview | null): MediaManifestEntry | null {
  const t = useTimeline()
  return useProject((s) => {
    if (!slip || !t) return null
    const clip = findClip(t, slip.clipId)?.clip
    if (!clip || clip.sourceClipType === 'sequence') return null
    const asset = s.snapshot?.doc.manifest.entries.find((e) => e.id === clip.mediaRef)
    return asset?.type === 'video' ? asset : null
  })
}

function Pane({ label, frame, fps, canvasRef, ready }: { label: string; frame: number; fps: number; canvasRef: React.RefObject<HTMLCanvasElement | null>; ready: boolean }) {
  return (
    <div className="pp-slip-pane">
      <canvas ref={canvasRef} className="pp-slip-frame" style={{ visibility: ready ? 'visible' : 'hidden' }} />
      <div className="pp-slip-label">
        <span className="name">{label}</span>
        <span className="tc">{formatTimecode(frame, fps)}</span>
      </div>
    </div>
  )
}

export function SlipTwoUp() {
  const slip = useEditor((s) => s.slipPreview)
  const asset = useSlipAsset(slip)
  if (!slip || !asset) return null
  return <TwoUp key={asset.id} slip={slip} assetId={asset.id} />
}

function TwoUp({ slip, assetId }: { slip: SlipPreview; assetId: string }) {
  const fps = useTimeline()?.fps ?? 30
  const startCanvas = useRef<HTMLCanvasElement>(null)
  const endCanvas = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState({ start: false, end: false })
  const loader = useRef<{ enqueue(r: Request): void } | null>(null)

  useEffect(() => {
    let live = true
    let pending: Request | null = null
    let running = false
    let videos: [HTMLVideoElement, HTMLVideoElement] | null = null
    const srcPromise = window.palmier.media.playbackPath(assetId).then((p) => (p ? mediaUrl(p) : null))
    const run = async () => {
      running = true
      const src = await srcPromise
      if (live && src && !videos) videos = [makeVideo(src), makeVideo(src)]
      while (live && pending && videos) {
        const r: Request = pending
        pending = null
        // Mac decodes source frame N at N / timeline fps; nudge inside the frame so rounding never lands on N-1.
        const at = (f: number) => (Math.max(0, f) + 0.25) / fps
        const [okStart, okEnd] = await Promise.all([grab(videos[0], at(r.startFrame), startCanvas.current!), grab(videos[1], at(r.endFrame), endCanvas.current!)])
        if (!live) break
        // Keep the previous image when a decode fails (Mac only replaces on success).
        setReady((s) => ({ start: s.start || okStart, end: s.end || okEnd }))
        await new Promise((res) => setTimeout(res, SLIP_REFRESH_MS))
      }
      running = false
    }
    loader.current = {
      enqueue(r) {
        pending = r
        if (!running) void run()
      },
    }
    return () => {
      live = false
      loader.current = null
      for (const v of videos ?? []) {
        v.removeAttribute('src')
        v.load()
      }
    }
  }, [assetId, fps])

  useEffect(() => {
    loader.current?.enqueue({ startFrame: slip.startFrame, endFrame: slip.endFrame })
  }, [slip.startFrame, slip.endFrame, assetId, fps])

  return (
    <div className="pp-slip-twoup" data-testid="slip-two-up">
      <Pane label={t('Start')} frame={slip.startFrame} fps={fps} canvasRef={startCanvas} ready={ready.start} />
      <Pane label={t('End')} frame={slip.endFrame} fps={fps} canvasRef={endCanvas} ready={ready.end} />
    </div>
  )
}
