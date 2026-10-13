import type { I18nPayload } from './i18n'
/**
 * Contract between the Electron main process and the editor renderer (exposed as `window.palmier`).
 * Main owns the document; the renderer sends ops by name and receives full snapshots.
 */
import type { TranscriptionResult } from '../core/captions/transcript'
import type { MediaManifestEntry } from '../core/model'
import type { OpArgs, OpName, OpResult } from '../core/ops'
import type { Doc } from '../core/ops/context'
import type { AgentApi } from './agent'
import type { GenerationApi } from '../core/generation/requests'
import type { ExtrasApi } from './extras'
import type { AudioApi } from './audio'
import type { SearchApi } from './search'
import type { SkillsApi } from './skills'
import type { FeedbackSystemInfo } from './firstRun'

export type Unsubscribe = () => void

export interface RecentProject {
  id: string
  path: string
  name: string
  createdAt: string
  lastOpenedAt: string
  accessible: boolean
  thumbnailPath: string | null
}

export interface ProjectState {
  doc: Doc
  version: number
  path: string
  name: string
  dirty: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export type OpOutcome<R> = { ok: true; result: R; changed: boolean } | { ok: false; error: string; beep: boolean }

export interface UiState {
  playheadFrame: number
  selectedClipIds: string[]
  selectedMediaIds: string[]
  rangeIn: number | null
  rangeOut: number | null
}

/** Requests from main (menus, MCP agents) that the renderer applies to its local UI state. */
export type UiCommand =
  | { type: 'menu'; command: MenuCommand }
  | { type: 'seek'; frame: number }
  | { type: 'select'; clipIds: string[] }
  | { type: 'toast'; message: string; kind?: 'info' | 'error' }
  | { type: 'agentActivity'; tool: string; status: 'start' | 'end'; read?: AgentReadHighlight; ok?: boolean }
  | { type: 'agentChanges'; changes: AgentChangeHighlight }
  /** Reveal and select an asset in the media panel (desktop notification click). */
  | { type: 'revealAsset'; assetId: string }

/** Clips/range an agent tool is reading (Mac `AgentActivityHighlight` read half); range = [start, end) frames. */
export interface AgentReadHighlight {
  clipIds: string[]
  range: [number, number] | null
}

/** What an agent edit added or changed on the active timeline (Mac `showAgentChanges`). */
export interface AgentChangeHighlight {
  addedClipIds: string[]
  mutatedClipIds: string[]
  mutatedTrackIds: string[]
}

export type MenuCommand =
  | 'new-project'
  | 'open-project'
  | 'save'
  | 'save-as'
  | 'close-project'
  | 'import-media'
  | 'export'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'delete'
  | 'select-all'
  | 'split'
  | 'add-marker'
  | 'add-text'
  | 'toggle-media-panel'
  | 'toggle-inspector'
  | 'layout-default'
  | 'layout-media'
  | 'layout-vertical'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'shortcuts'
  | 'mcp-instructions'
  | 'settings'
  | 'toggle-ripple-markers'
  | 'new-folder'
  | 'select-forward-track'
  | 'select-forward-all'
  | 'trim-start'
  | 'trim-end'
  | 'ripple-delete'
  | 'toggle-agent-panel'
  | 'maximize-panel'
  | 'tutorial'
  | 'feedback'
  | 'about'

export type NativeEditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface ProbeResult {
  type: MediaManifestEntry['type']
  duration: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  hasVideo: boolean
  videoCodec?: string
  audioCodec?: string
  rotation?: number
  hasAlpha?: boolean
}

export interface ImportResult {
  added: string[]
  rejected: { path: string; reason: string }[]
}

export interface WaveformData {
  /** Peak magnitudes 0–1, `samplesPerSecond` buckets per second of source. */
  peaks: number[]
  samplesPerSecond: number
  duration: number
}

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif' | 'm4a' | 'wav' | 'png' | 'fcpxml' | 'xml' | 'palmier'

export interface ExportOptions {
  timelineId: string
  format: ExportFormat
  outputPath: string
  /** h264 | hevc | prores | vp9 | ... depending on format */
  codec?: string
  width?: number
  height?: number
  fps?: number
  quality?: 'low' | 'medium' | 'high' | 'max'
  range?: { start: number; end: number }
  includeAudio?: boolean
  /** fcpxml only: which app's crop/position conventions to write (default resolve). */
  fcpxmlTarget?: 'resolve' | 'fcp'
  /** fcpxml only: the document's `version` attribute (default 1.10). */
  fcpxmlVersion?: '1.10' | '1.11' | '1.12' | '1.13' | '1.14'
}

export interface ExportJob {
  id: string
  options: ExportOptions
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  framesRendered: number
  totalFrames: number
  startedAt: string
  finishedAt?: string
  error?: string
  /** Non-fatal issues, e.g. offline media left out of the export. */
  warnings?: string[]
  outputPath: string
  /** Project package the job was started from (the Mac's per-project queue, ExportQueue.jobs(for:)). */
  projectPath?: string
}

export interface AppSettings {
  projectsDirectory: string
  mcpEnabled: boolean
  mcpPort: number
  rippleTimelineMarkers: boolean
  theme: 'dark' | 'light' | 'system'
  apiKeys: { fal?: string; replicate?: string; openai?: string; anthropic?: string; elevenlabs?: string; google?: string }
  /** Clip color overrides, `#RRGGBB` keyed video/audio/image/text/animation/sequence (Settings ▸ Appearance ▸ Timeline colors). */
  timelineColors?: Record<string, string>
  panels: { media: boolean; inspector: boolean; agent: boolean }
  layoutPreset: 'default' | 'media' | 'vertical'
  /** Linux speech settings (spec 07 §0.5). */
  transcription?: TranscriptionSettings
  /** Generation models hidden from the Generate panel and default selection (spec 06 §B1.4). */
  disabledModelIds?: string[]
  /** Generate panel prompt height extra in px (spec 06 §B7.1 `generationPromptExtra`). */
  generationPromptExtra?: number
  /** Settings ▸ Storage ▸ Media indexing (spec 07 §0.5 `searchIndexEnabled`); absent = true. */
  searchIndexEnabled?: boolean
  /** Settings ▸ General ▸ Show notifications (generation done, export done/failed); absent = true. */
  notificationsEnabled?: boolean
  /** Onboarding finished or skipped (spec 07 §0.5 `hasSeenWelcome`); absent = false. */
  hasSeenWelcome?: boolean
  /** App version whose What's New was last shown or skipped (spec 07 §7.5 `lastSeenVersion`). */
  lastSeenVersion?: string
  /** Settings ▸ General ▸ Language (Mac `appLanguage`): 'system' or a locale id from src/shared/i18n.ts; absent = system. Applies after a restart. */
  appLanguage?: string
}

export interface TranscriptionSettings {
  /** whisper model: 'large-v3-turbo-q5_0' (default) | 'small' | 'base' ('tiny-q5_1' is accepted for tests). */
  localModel?: string
  /** Local "Auto" passes `-l auto` instead of using the system language. Default false. */
  localAutoDetect?: boolean
  /** BYOK cloud provider: 'elevenlabs' | 'openai'; default = the first with a key. */
  cloudProvider?: string
}

/** Progress of one transcription job: first-use model download, then whisper's own percentage. */
export type TranscriptionProgress = { phase: 'downloading'; fraction: number } | { phase: 'transcribing'; fraction: number }

export type ModelStateView =
  | { kind: 'unknown' }
  | { kind: 'notInstalled' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'preparing' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

export interface TranscribeIpcRequest {
  /** Caller-chosen id for `cancel` and progress events. */
  jobId: string
  /** Asset id; main resolves the file (the renderer never touches files). */
  mediaRef: string
  isVideo: boolean
  range?: [number, number] | null
  provider: 'local' | 'cloud'
  /** BCP-47; omitted = Auto. */
  locale?: string
  censorProfanity: boolean
}

export type TranscribeOutcome = { ok: true; result: TranscriptionResult } | { ok: false; error: string; cancelled?: boolean }

export type SubtitleCuesOutcome = { ok: true; cues: { text: string; startSeconds: number; endSeconds: number }[] } | { ok: false; error: string; offline?: boolean }

export interface SpeechStatus {
  cloudAvailable: boolean
  cloudProvider: string | null
  /** The whisper model id `transcription.localModel` selects. */
  localModelId: string
  localModelBytes: number
  localModelInstalled: boolean
}

/** Media intelligence (spec 07 §0.3), the transcription part. */
export interface MlApi {
  transcribe(req: TranscribeIpcRequest): Promise<TranscribeOutcome>
  cancel(jobId: string): void
  onProgress(cb: (p: TranscriptionProgress & { jobId: string }) => void): Unsubscribe
  /** Local full-file cache windowed to `range`; null when not cached. */
  cachedTranscript(mediaRef: string, range?: [number, number] | null): Promise<TranscriptionResult | null>
  cachedCloudTranscript(mediaRef: string, range: [number, number] | null, language: string | null): Promise<TranscriptionResult | null>
  speechStatus(): Promise<SpeechStatus>
  /** Parsed SRT/WebVTT cues of a subtitle asset (spec 07 §1.8). */
  subtitleCues(mediaRef: string): Promise<SubtitleCuesOutcome>
  models: {
    state(id: string): Promise<ModelStateView>
    ensure(id: string): Promise<{ ok: true } | { ok: false; error: string }>
    remove(id: string): Promise<void>
    onState(cb: (e: { id: string; state: ModelStateView }) => void): Unsubscribe
  }
}

export interface PalmierApi {
  app: {
    info(): Promise<{ version: string; platform: string; mcpUrl: string; mcpRunning: boolean; ffmpeg: string }>
    onCommand(cb: (cmd: UiCommand) => void): Unsubscribe
    showItemInFolder(path: string): void
    openExternal(url: string): void
    /** Runs the browser's own edit command on the focused text field (menu Undo/Copy/… while typing). */
    nativeEdit(action: NativeEditAction): void
    /** Closes this window (projects save first). */
    closeWindow(): void
    /** Reports the panels this editor actually lays out (View-menu checkmarks). */
    reportPanels(panels: AppSettings['panels']): void
    /** Settings ▸ General ▸ Restart: saves every project, quits, and relaunches (Mac `AppDelegate.restart`). */
    restart(): void
  }
  /** UI language for this process (src/shared/i18n.ts). */
  i18n: {
    get(): Promise<I18nPayload>
  }
  home: {
    listRecent(): Promise<RecentProject[]>
    createProject(name: string): Promise<{ ok: true } | { ok: false; error: string }>
    openProject(path?: string): Promise<{ ok: true } | { ok: false; error: string }>
    removeRecent(path: string): Promise<void>
    trashProject(path: string): Promise<{ ok: true } | { ok: false; error: string }>
    /** Onboarding ▸ Tutorial: a fresh untitled project in `$TMPDIR/palmier-tutorial`, not added to recents (07 §7.2). */
    openTutorial(): Promise<{ ok: true } | { ok: false; error: string }>
  }
  /** Help ▸ Send Feedback (07 §7.4 Linux). */
  feedback: {
    /** PNG data URL of this window, longest side ≤ 1920; null when capture fails. */
    capture(): Promise<string | null>
    /** Save dialog, then writes the PNG; returns the path, or null when cancelled. */
    saveScreenshot(pngDataUrl: string): Promise<{ ok: true; path: string } | { ok: false; error: string } | null>
    systemInfo(): Promise<FeedbackSystemInfo>
  }
  project: {
    get(): Promise<ProjectState | null>
    onState(cb: (s: ProjectState | null) => void): Unsubscribe
    op<N extends OpName>(name: N, args: OpArgs<N>): Promise<OpOutcome<OpResult<N>>>
    undo(): Promise<string | null>
    redo(): Promise<string | null>
    save(): Promise<void>
    saveAs(): Promise<void>
    close(): Promise<void>
    setUi(patch: Partial<UiState>): void
  }
  media: {
    importFiles(paths?: string[], folderId?: string): Promise<ImportResult>
    probe(path: string): Promise<ProbeResult>
    /** Absolute path of a Chromium-playable file for preview (original or cached proxy). */
    playbackPath(assetId: string): Promise<string | null>
    thumbnail(assetId: string, atSeconds?: number): Promise<string | null>
    filmstrip(assetId: string, frameCount: number, height: number): Promise<string[]>
    waveform(assetId: string): Promise<WaveformData | null>
    relink(assetId: string, newPath?: string): Promise<{ ok: boolean; error?: string }>
    /** Assets whose files are missing, or present but unreadable (Mac `isMediaOffline`); in-flight generations are skipped. */
    offline(): Promise<{ missing: string[]; unprocessable: string[] }>
    /** "Relink Folder…": picks a folder (unless given) and relinks offline assets to same-named files; null when cancelled. */
    relinkFolder(folder?: string): Promise<{ relinked: number; total: number; error?: string } | null>
    /** Imports files or image data from the system clipboard into a folder (Media panel paste). */
    pasteClipboard(folderId?: string): Promise<({ kind: 'files' | 'image' } & ImportResult) | { kind: 'empty' }>
    pickFiles(kind: 'media' | 'lut'): Promise<string[]>
  }
  export: {
    chooseOutput(defaultName: string, format: ExportFormat): Promise<string | null>
    start(options: ExportOptions): Promise<{ ok: true; job: ExportJob } | { ok: false; error: string }>
    cancel(jobId: string): Promise<void>
    list(): Promise<ExportJob[]>
    onProgress(cb: (job: ExportJob) => void): Unsubscribe
    /** Dismiss one finished job (Mac ExportQueue.remove). */
    remove(jobId: string): Promise<void>
    /** Clear Finished: drops this window's project's completed/failed/cancelled jobs. */
    clearFinished(): Promise<void>
    /** Job ids dropped by remove/clearFinished in any window. */
    onRemoved(cb: (jobIds: string[]) => void): Unsubscribe
  }
  settings: {
    /** API keys come back masked ('•' × 36 + last 4 chars); an empty string means no key. */
    get(): Promise<AppSettings>
    /** apiKeys entries: a new key saves it, '' removes it, masked values are ignored. Keys merge per provider. */
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    onChange(cb: (s: AppSettings) => void): Unsubscribe
  }
  /** In-app agent chat of this window's project (spec 06 §A; types in shared/agent.ts). */
  agent: AgentApi
  /** Transcription and model downloads (spec 07 §0–§1). */
  ml: MlApi
  /** AI generation with the user's provider keys (spec 06 Part B; types in core/generation/requests.ts). */
  generation: GenerationApi
  /** Save as media/audio, extract audio, save range, capture frame, mattes (spec 07 §6.3–6.5; types in shared/extras.ts). */
  extras: ExtrasApi
  /** Audio analysis, sync, multicam and denoise (spec 07 §3, §5; types in shared/audio.ts). */
  audio: AudioApi
  /** Smart search: Moments, spoken hits, index status, Settings ▸ Storage (spec 07 §2; types in shared/search.ts). */
  search: SearchApi
  /** Settings ▸ Skills (spec 05 §11.7; types in shared/skills.ts). */
  skills: SkillsApi
}

export const MEDIA_SCHEME = 'palmier-media'

/** URL the renderer uses to load a local file through the range-capable media protocol. */
export function mediaUrl(absPath: string): string {
  return `${MEDIA_SCHEME}://local${absPath.split('/').map(encodeURIComponent).join('/')}`
}
