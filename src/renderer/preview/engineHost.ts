import { create } from 'zustand'
import { denoiseTargets } from '@core/audio/denoise'
import { createPreviewEngine } from '../render/engine'
import type { PreviewEngine } from '../render/types'
import { attachEngine, detachEngine } from '../state/playback'
import { originalPathOf } from '../state/mediaPaths'
import { timelineOf, useProject } from '../state/project'

/** The editor's single preview engine and the canvas it draws into (re-parented as preview tabs change). */
export const engineCanvas = document.createElement('canvas')
engineCanvas.className = 'pp-engine-canvas'

/** Why the engine could not start (e.g. no WebGL 2), or null while it runs. */
export const useEngineError = create<{ error: string | null }>(() => ({ error: null }))

let engine: PreviewEngine | null = null
let unsub: (() => void) | null = null
let bakeKey = ''

export function startEngine(): boolean {
  if (engine) return true
  try {
    engine = createPreviewEngine({
      canvas: engineCanvas,
      resolvePlaybackPath: (id) => window.palmier.media.playbackPath(id),
      resolveOriginalPath: originalPathOf,
      // Denoise wet files: re-resolved whenever a bake state changes (Mac rebuilds on bake).
      enhancedAudio: {
        path: (id) => window.palmier.audio.enhancedAudioPath(id),
        onChange: (cb) => window.palmier.audio.onDenoiseState(({ assetId }) => cb(assetId)),
      },
    })
  } catch (e) {
    console.error('Preview engine unavailable:', e)
    useEngineError.setState({ error: e instanceof Error ? e.message : String(e) })
    return false
  }
  useEngineError.setState({ error: null })
  const sync = () => {
    const { snapshot, preview } = useProject.getState()
    const doc = preview ?? snapshot?.doc
    const t = timelineOf(doc)
    if (doc && t) engine?.setDocument(doc, t.id)
    // `enhancePendingDenoises` on project open and every timeline change (undo, paste, agent edits): main bakes
    // missing wet files and skips baked / in-flight / failed ones.
    const committed = snapshot?.doc
    const key = committed ? denoiseTargets(committed).join('\n') : ''
    if (key !== bakeKey) {
      bakeKey = key
      if (key) window.palmier.audio?.scheduleDenoise()
    }
  }
  sync()
  unsub = useProject.subscribe((s, p) => {
    if (s.snapshot !== p.snapshot || s.preview !== p.preview) sync()
  })
  attachEngine(engine)
  return true
}

export function stopEngine(): void {
  unsub?.()
  unsub = null
  detachEngine()
  engine?.dispose()
  engine = null
}

/** CSS size of the canvas; the engine applies the device pixel ratio to its backing store. */
export function resizeEngine(w: number, h: number): void {
  engineCanvas.style.width = `${w}px`
  engineCanvas.style.height = `${h}px`
  engine?.resize(w, h, window.devicePixelRatio || 1)
}
