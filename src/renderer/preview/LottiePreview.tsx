/**
 * Media preview tab for a Lottie asset (spec 07 §4.2): the animation plays live with the compositor's
 * `LottieInstance`, driven by a source playhead at the timeline fps (last frame held at the end).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaManifestEntry } from '@core/model'
import { lottieMediaUrl, type LottieJson } from '../../shared/lottie'
import { LottieInstance } from '../render/lottieSource'
import { originalPath } from '../state/mediaPaths'
import { useTimeline } from '../state/project'
import { Spinner } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { CanvasArea } from './CanvasArea'
import { GuidesOverlay } from './Guides'
import { sourcePlayer } from './sourcePlayer'
import { GuidesButton, ScrubBar, Timecode, TransportBar, TransportButtons, ZoomBadge } from './Transport'
import { setPreviewZoom, usePreviewView } from './view'

export function LottiePreview({ asset }: { asset: MediaManifestEntry }) {
  // The animation draws into this canvas, which is attached once the canvas area has a size.
  const [canvas] = useState(() => {
    const c = document.createElement('canvas')
    c.className = 'pp-source-media'
    return c
  })
  const attach = useCallback((el: HTMLDivElement | null) => {
    if (el && canvas.parentElement !== el) el.appendChild(canvas)
  }, [canvas])
  /** undefined while loading, null when the file is missing or not playable. */
  const [anim, setAnim] = useState<LottieInstance | null | undefined>(undefined)
  const fps = useTimeline()?.fps ?? 30
  const total = Math.max(0, Math.floor(asset.duration * fps))
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const zoom = usePreviewView((s) => s.zoom)
  const clock = useRef({ t: 0, frame: 0 })
  const path = originalPath(asset)

  useEffect(() => {
    let live = true
    let inst: LottieInstance | null = null
    setAnim(undefined)
    void (async () => {
      try {
        if (!path) throw new Error('offline')
        const r = await fetch(lottieMediaUrl(path), { cache: 'no-cache' })
        if (!r.ok) throw new Error(String(r.status))
        const data = (await r.json()) as LottieJson
        if (!live) return
        inst = new LottieInstance(data, undefined, canvas)
        await inst.loaded
        if (live) setAnim(inst)
      } catch {
        if (live) setAnim(null)
      }
    })()
    return () => {
      live = false
      inst?.destroy()
    }
  }, [path, canvas])

  useEffect(() => {
    if (anim) anim.render(anim.index(frame / fps))
  }, [anim, frame, fps])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const f = clock.current.frame + Math.floor(((performance.now() - clock.current.t) / 1000) * fps + 1e-6)
      if (f >= total) {
        setFrame(total)
        setPlaying(false)
        return
      }
      setFrame(f)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, fps, total])

  const seekTo = (f: number) => {
    const clamped = Math.max(0, Math.min(total, Math.round(f)))
    clock.current = { t: performance.now(), frame: clamped }
    setFrame(clamped)
  }
  const toggle = () => {
    if (playing) return setPlaying(false)
    seekTo(frame >= total ? 0 : frame)
    setPlaying(total > 0)
  }
  const stepBy = (n: number) => {
    setPlaying(false)
    seekTo(frame + n)
  }
  useEffect(() => {
    sourcePlayer.current = { toggle, step: stepBy }
    return () => {
      sourcePlayer.current = null
    }
  })

  return (
    <>
      <CanvasArea aspect={(asset.sourceWidth ?? 16) / (asset.sourceHeight ?? 9)} background="#000">
        {(size) => (
          <>
            <div ref={attach} className="pp-source-media" />
            {anim === undefined && <div className="pp-source-center"><Spinner /></div>}
            {anim === null && <div className="pp-source-center tone-tertiary"><Icon sf="sparkles" size={18} /></div>}
            <GuidesOverlay size={size} />
          </>
        )}
      </CanvasArea>
      <ScrubBar frame={frame} total={total} onBegin={() => setPlaying(false)} onScrub={seekTo} onEnd={() => undefined} />
      <TransportBar
        left={<Timecode frame={frame} total={total} fps={fps} />}
        center={<TransportButtons playing={playing} actions={{ toStart: () => seekTo(0), stepBack: (s) => stepBy(s ? -5 : -1), toggle, stepForward: (s) => stepBy(s ? 5 : 1), toEnd: () => seekTo(total) }} />}
        right={
          <>
            <GuidesButton />
            <ZoomBadge zoom={zoom} setZoom={(z) => setPreviewZoom(z)} />
          </>
        }
      />
    </>
  )
}
