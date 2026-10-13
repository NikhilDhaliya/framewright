/** Messages between the main-process RenderService and the hidden render-host window. Types only. */
import type { TextStyle } from '@core/model'
import type { TextBox } from '@core/ops/project'
import type { Scene } from '../render/compositor'

export const HOST_CHANNELS = {
  request: 'render-host:request',
  response: 'render-host:response',
  progress: 'render-host:progress',
  ready: 'render-host:ready',
} as const

export interface CaptureParams extends Scene {
  frame: number
  width: number
  height: number
  format: 'png' | 'jpeg'
  /** 0–1 (JPEG). */
  quality: number
}

export interface MeasureParams {
  reqs: { content: string; style: TextStyle; canvasWidth: number; canvasHeight: number }[]
}

export interface ExportVideoParams extends Scene {
  jobId: string
  /** First timeline frame and number of output frames. */
  startFrame: number
  frameCount: number
  /** Output frame rate; output frame i shows timeline frame startFrame + floor(i · fps / outFps). */
  outFps: number
  width: number
  height: number
  /** Full ffmpeg argument list; raw RGBA frames are written to its stdin. */
  ffmpegArgs: string[]
}

/** Frames of a Lottie file as PNGs (library thumbnails, inspect_media), spec 07 §4.2. */
export interface LottieFramesParams {
  path: string
  /** Relative frame indices (0 = `ip`); clamped to the animation. */
  frames: number[]
  /** Rendered fit-within this many px (then clamped and even). */
  maxSide: number
  /** Opaque CSS colour composited under the frames; transparent when absent. */
  background?: string
}

export type HostRequest =
  | { id: number; method: 'capture'; params: CaptureParams }
  | { id: number; method: 'lottie'; params: LottieFramesParams }
  | { id: number; method: 'measure'; params: MeasureParams }
  | { id: number; method: 'export'; params: ExportVideoParams }
  | { id: number; method: 'cancel'; params: { jobId: string } }

export interface HostResults {
  capture: Uint8Array
  lottie: Uint8Array[]
  measure: TextBox[]
  export: { frames: number }
  cancel: null
}

export type HostResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

export interface HostProgress {
  jobId: string
  framesRendered: number
}
