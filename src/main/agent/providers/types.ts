import type { AgentContentBlock, AgentModelId, AgentReasoningEffort } from '../../../shared/agent'

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal' | 'other'

const STOP_REASONS = new Set<StopReason>(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal'])
export const stopReasonOf = (raw: string): StopReason => (STOP_REASONS.has(raw as StopReason) ? (raw as StopReason) : 'other')

/** Provider-neutral stream events (AgentStreamEvent). */
export type ProviderEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'thinkingDelta'; text: string }
  | { type: 'thinkingSignature'; signature: string }
  | { type: 'redactedThinking'; data: string }
  | { type: 'reasoningSummaryDelta'; text: string }
  | { type: 'reasoningComplete'; id: string | null; summary: string; encryptedContent: string }
  | { type: 'toolUseComplete'; id: string; name: string; input: string }
  | { type: 'messageStop'; reason: StopReason }

/** A transcript block plus the inline mention image, which only exists in requests. */
export type RequestBlock = AgentContentBlock | { kind: 'image'; base64: string; mediaType: string }

export interface RequestMessage {
  role: 'user' | 'assistant'
  content: RequestBlock[]
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface StreamRequest {
  model: AgentModelId
  effort: AgentReasoningEffort
  maxTokens: number
  system: string
  tools: ToolSchema[]
  messages: RequestMessage[]
}

export interface ClientOptions {
  apiKey: string
  /** Override for tests and proxies (no trailing slash), e.g. http://127.0.0.1:1234/v1. */
  baseUrl?: string
  idleMs?: number
  fetchImpl?: typeof fetch
}

export interface AgentClient {
  stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>
}
