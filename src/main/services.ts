/**
 * Main-process service contracts shared by the IPC layer, the MCP tool executor and export.
 * Implementations: media/mediaService.ts, render/renderService.ts, export/exportService.ts.
 */
import type { TextStyle } from '../core/model'
import type { TextBox } from '../core/ops/project'
import type { AppSettings, ExportJob, ExportOptions, ImportResult, ProbeResult, UiCommand, WaveformData } from '../shared/api'
import type { AudioAnalysisService } from './ml/audio/service'
import type { DenoiseService } from './ml/audio/denoise'
import type { SessionSpeakers } from './ml/audio/sessionSpeakers'
import type { SearchService } from './ml/search/service'
import type { TranscriptionService } from './ml/transcribe/service'
import type { ProjectSession } from './project/session'

export interface MediaService {
  probe(path: string): Promise<ProbeResult>
  /** Probes files/folders and adds them to the library as one undo step. */
  importPaths(session: ProjectSession, paths: string[], folderId?: string): Promise<ImportResult>
  /** Downloads/writes bytes into <package>/media and adds the asset. */
  importBytes(session: ProjectSession, data: Buffer, filename: string, opts?: { name?: string; folderId?: string; prefix?: string }): Promise<string>
  playbackPath(session: ProjectSession, assetId: string): Promise<string | null>
  thumbnail(session: ProjectSession, assetId: string, atSeconds?: number): Promise<string | null>
  filmstrip(session: ProjectSession, assetId: string, frameCount: number, height: number): Promise<string[]>
  waveform(session: ProjectSession, assetId: string): Promise<WaveformData | null>
  /** Extracts one source frame as an image (for inspect_media / capture tools). */
  extractFrame(path: string, atSeconds: number, opts?: { width?: number; format?: 'png' | 'jpeg' }): Promise<Buffer>
}

export interface CaptureRequest {
  timelineId: string
  frame: number
  /** Output width in px; height follows the timeline aspect. Defaults to the timeline width. */
  width?: number
  format?: 'png' | 'jpeg'
  quality?: number
}

export interface TextMeasureRequest {
  content: string
  style: TextStyle
  canvasWidth: number
  canvasHeight: number
}

export interface RenderService {
  /** Renders one composited timeline frame (frame-accurate, via ffmpeg decode) to an image. */
  captureFrame(session: ProjectSession, req: CaptureRequest): Promise<Buffer>
  /** Natural normalized text box sizes, measured with the same layout code the renderer draws with. */
  measureText(reqs: TextMeasureRequest[]): Promise<TextBox[]>
  /**
   * Lottie frames (relative indices, 0 = `ip`) rendered fit-within `maxSide` as PNGs, over `background` when given
   * (spec 07 §4.2). Optional so test doubles need not provide it.
   */
  lottieFrames?(file: string, req: { frames: number[]; maxSide: number; background?: string }): Promise<Buffer[]>
}

export interface ExportService {
  start(session: ProjectSession, options: ExportOptions): ExportJob
  get(jobId: string): ExportJob | undefined
  list(): ExportJob[]
  cancel(jobId: string): void
  /** Resolves when the job reaches a terminal status. */
  wait(jobId: string): Promise<ExportJob>
  on(event: 'progress', cb: (job: ExportJob) => void): void
  /** Drops a finished job from the queue list (Export dialog ▸ Dismiss); returns the removed ids. */
  remove?(jobId: string): string[]
  /** Drops every finished job of the project at `projectPath` (all projects when omitted); returns the removed ids. */
  clearFinished?(projectPath?: string): string[]
}

export interface SessionRegistry {
  /** The project in the frontmost editor window, if any. */
  focused(): ProjectSession | null
  all(): ProjectSession[]
  openPath(path: string): Promise<ProjectSession>
  create(name: string): Promise<ProjectSession>
  /** Saves and closes `session` in its window (manage_project close); without it the session is only saved and closed. */
  close?(session: ProjectSession): Promise<void>
}

export interface AppContext {
  sessions: SessionRegistry
  media: MediaService
  render: RenderService
  exporter: ExportService
  settings(): AppSettings
  /** Sends a UI command (seek, select, toast, …) to the editor window showing `session`. */
  ui(session: ProjectSession, cmd: UiCommand): void
  /** Speech-to-text (spec 07 §1); absent in contexts without the ML stack. */
  transcription?: TranscriptionService
  /** Audio analysis: VAD/dead air, beats, sync envelopes (spec 07 §3); absent in contexts without the ML stack. */
  audio?: AudioAnalysisService
  /** DeepFilterNet3 denoise bakes (spec 07 §3.6). */
  denoise?: DenoiseService
  /** Session speaker masks from Identify (spec 07 §3.5), for get_transcript's project-wide speaker labels. */
  speakers?: SessionSpeakers
  /** Smart search: visual index + Moments (spec 07 §2); absent in contexts without the ML stack. */
  search?: SearchService
}
