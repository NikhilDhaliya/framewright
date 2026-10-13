/**
 * In-app agent: model table, transcript types (the on-disk shape of chat/<UUID>.json, spec 01 §5.15)
 * and the panel state the main process pushes to the renderer (spec 06 §A).
 */
import { tk } from './i18n'
import type { ClipType } from '../core/model'

export type AgentProvider = 'anthropic' | 'openai'
export type AgentModelId = 'claude-sonnet-5' | 'claude-opus-5' | 'claude-fable-5' | 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol'
export type AgentReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentModelInfo {
  id: AgentModelId
  displayName: string
  provider: AgentProvider
  maxOutputTokens: number
}

/** Picker order (AgentModel.allCases). */
export const AGENT_MODELS: readonly AgentModelInfo[] = [
  { id: 'claude-sonnet-5', displayName: 'Sonnet 5', provider: 'anthropic', maxOutputTokens: 64000 },
  { id: 'claude-opus-5', displayName: 'Opus 5', provider: 'anthropic', maxOutputTokens: 64000 },
  { id: 'claude-fable-5', displayName: 'Fable 5', provider: 'anthropic', maxOutputTokens: 64000 },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', provider: 'openai', maxOutputTokens: 64000 },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', provider: 'openai', maxOutputTokens: 64000 },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', provider: 'openai', maxOutputTokens: 64000 },
]

export const DEFAULT_AGENT_MODEL: AgentModelId = 'gpt-5.6-terra'
export const DEFAULT_REASONING_EFFORT: AgentReasoningEffort = 'medium'

export const EFFORT_LABELS: Record<AgentReasoningEffort, string> = {
  none: tk('None'),
  minimal: tk('Minimal'),
  low: tk('Low'),
  medium: tk('Medium'),
  high: tk('High'),
  xhigh: tk('X High'),
  max: tk('Max'),
}

const ALL_EFFORTS: AgentReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const ANTHROPIC_EFFORTS: AgentReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const PROVIDER_NAMES: Record<AgentProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

export function modelInfo(id: AgentModelId): AgentModelInfo {
  return AGENT_MODELS.find((m) => m.id === id) ?? AGENT_MODELS.find((m) => m.id === DEFAULT_AGENT_MODEL)!
}

export const isAgentModelId = (v: unknown): v is AgentModelId => AGENT_MODELS.some((m) => m.id === v)

/** Persisted preference → model: the legacy `claude-opus-4-8` maps to Opus 5, anything unknown to the default. */
export function normalizeModelId(raw: unknown): AgentModelId {
  if (raw === 'claude-opus-4-8') return 'claude-opus-5'
  return isAgentModelId(raw) ? raw : DEFAULT_AGENT_MODEL
}

export function supportedEfforts(model: AgentModelId): AgentReasoningEffort[] {
  return modelInfo(model).provider === 'anthropic' ? ANTHROPIC_EFFORTS : ALL_EFFORTS
}

/** A stored effort the model does not support reads back as `medium`. */
export function normalizeEffort(model: AgentModelId, raw: unknown): AgentReasoningEffort {
  return supportedEfforts(model).includes(raw as AgentReasoningEffort) ? (raw as AgentReasoningEffort) : DEFAULT_REASONING_EFFORT
}

// ---------- Transcript (chat/<UUID>.json) ----------

export type ToolResultBlock = { kind: 'text'; text: string } | { kind: 'image'; base64: string; mediaType: string }

export type AgentContentBlock =
  | { kind: 'thinking'; text: string; signature: string }
  | { kind: 'redactedThinking'; data: string }
  | { kind: 'openAIReasoning'; summary: string; encryptedContent: string; itemID?: string; model: AgentModelId }
  | { kind: 'text'; text: string }
  | { kind: 'toolUse'; id: string; name: string; input: string }
  | { kind: 'toolResult'; toolUseId: string; content: ToolResultBlock[]; isError: boolean }

export interface AgentTimelineRangeMention {
  startFrame: number
  endFrame: number
  durationFrames: number
  fps: number
  startTimecode: string
  endTimecode: string
  durationTimecode: string
  rangeSemantics: string
}

export interface AgentMention {
  id: string
  displayName: string
  mediaRef?: string
  type?: ClipType
  clipId?: string
  timelineRange?: AgentTimelineRangeMention
}

export type AgentRole = 'user' | 'assistant' | 'system'

export interface AgentMessage {
  id: string
  role: AgentRole
  blocks: AgentContentBlock[]
  mentions: AgentMention[]
  contextHint?: string
}

/** Collapses every run of whitespace and/or `-` into one `-` and trims `-` (AgentMention.makeDisplayName). */
export function mentionDisplayName(raw: string): string {
  return raw.replace(/[\s-]+/gu, '-').replace(/^-+|-+$/g, '')
}

// ---------- Panel state (main → renderer) ----------

export interface ChatSessionInfo {
  id: string
  title: string
  /** ISO-8601 without fractional seconds. */
  updatedAt: string
  isOpen: boolean
  messageCount: number
}

export type AgentStreamError =
  | { kind: 'unavailable'; model: AgentModelId; provider: AgentProvider }
  | { kind: 'refusal'; model: AgentModelId }
  | { kind: 'upstream'; message: string }

export interface AgentPanelState {
  /** Newest-first insertion order (the tab strip shows the open ones in this order). */
  sessions: ChatSessionInfo[]
  currentId: string
  /** Messages of the current session. */
  messages: AgentMessage[]
  /** A run is active for the current session. */
  isStreaming: boolean
  streamError: AgentStreamError | null
  model: AgentModelId
  effort: AgentReasoningEffort
  canStream: boolean
  activeBYOKProvider: AgentProvider | null
}

/** Streaming update of one assistant message (≤ 20 Hz, first one immediately). */
export interface AgentStreamUpdate {
  sessionId: string
  messageId: string
  blocks: AgentContentBlock[]
  revision: number
}

/** `window.palmier.agent`. The draft and its mentions live in the renderer; sends carry them. */
export interface AgentApi {
  getState(): Promise<AgentPanelState | null>
  onState(cb: (s: AgentPanelState) => void): () => void
  onStream(cb: (u: AgentStreamUpdate) => void): () => void
  send(text: string, mentions: AgentMention[]): void
  cancel(): void
  newChat(): void
  selectSession(id: string): void
  closeTab(id: string): void
  deleteSession(id: string): void
  setModel(model: AgentModelId): void
  setEffort(effort: AgentReasoningEffort): void
  /** Opens ~/.framewright/skills in the file manager. */
  openSkillsFolder(): void
  /** Saves pasted image data as media/pasted-<8hex>.<ext> and imports it; resolves the new asset id. */
  importPastedImage(data: Uint8Array, mediaType: 'image/png' | 'image/tiff'): Promise<string | null>
}
