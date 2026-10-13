/**
 * Contract between the editor UI and the rendering/playback engine.
 * The engine owns WebGL compositing, media element pooling and Web Audio mixing.
 */
import type { TextStyle } from '@core/model'
import type { TextBox } from '@core/ops/project'
import type { Doc } from '@core/ops/context'

export type Unsubscribe = () => void

export interface PreviewEngineOptions {
  canvas: HTMLCanvasElement
  /** Absolute path of a Chromium-playable file for an asset (may be a proxy). */
  resolvePlaybackPath(assetId: string): Promise<string | null>
  /** Absolute path of the original asset file (images, LUTs, Lottie JSON). */
  resolveOriginalPath(assetId: string): string | null
  /**
   * Denoise wet files (spec 07 §3.6): the baked fully-wet WAV of an asset or null while unbaked;
   * `onChange` fires when an asset's bake state changes (the engine re-resolves it).
   */
  enhancedAudio?: { path(assetId: string): Promise<string | null>; onChange(cb: (assetId: string) => void): Unsubscribe }
}

export interface SeekOptions {
  /** Arrow-key step: also plays a short audible scrub of the frame (spec 05 §5.5). */
  audible?: boolean
}

export interface PreviewEngine {
  /** Replaces the document; cheap to call on every state change. */
  setDocument(doc: Doc, timelineId: string): void
  /** Committed seek; renders the exact frame as soon as sources are ready. */
  seek(frame: number, opts?: SeekOptions): void
  /** Low-latency seek used while scrubbing; plays scrub audio while paused. */
  scrub(frame: number): void
  play(): void
  pause(): void
  readonly playing: boolean
  readonly currentFrame: number
  /** Called on every displayed frame during playback and after seeks. */
  onFrame(cb: (frame: number) => void): Unsubscribe
  onPlayStateChange(cb: (playing: boolean) => void): Unsubscribe
  /** Canvas backing-store size in px; the engine keeps the timeline aspect inside it. */
  resize(width: number, height: number, devicePixelRatio: number): void
  setVolume(linear: number): void
  /** Preview playback rate (0.5×…10×, spec 05 §5.6); audio follows, the meter is off at 4× and above. */
  setPlaybackRate(rate: number): void
  readonly playbackRate: number
  /** Audio meter levels (0–1 per channel) for the UI meter. */
  meter(): number[]
  /** Pixels (RGBA8) of a region of the last presented frame, rows counted from the top (chroma key sampler, 07 §6.6). */
  readPresentedRegion?(pick: (width: number, height: number) => { x: number; y: number; w: number; h: number } | null): Uint8Array | null
  /** Preview: show/hide the "Media Offline" text on offline placeholders (hidden while the offline panel is shown). */
  setOfflineLabel?(show: boolean): void
  dispose(): void
}

export interface TextMeasurer {
  measure(content: string, style: TextStyle, canvasWidth: number, canvasHeight: number): TextBox
}

export type CreatePreviewEngine = (opts: PreviewEngineOptions) => PreviewEngine
