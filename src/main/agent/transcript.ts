/** Transcript rules: orphan tool uses, incomplete-block dropping, titles and API message assembly (spec 06 §A3, §A5). */
import { randomUUID } from 'node:crypto'
import type { AgentContentBlock, AgentMention, AgentMessage } from '../../shared/agent'
import type { RequestBlock, RequestMessage } from './providers/types'

export const NEW_CHAT_TITLE = 'New chat'
export const CANCELLED = 'Cancelled'

export const newMessageId = (): string => randomUUID().toUpperCase()

export function userMessage(blocks: AgentContentBlock[], mentions: AgentMention[] = [], contextHint?: string): AgentMessage {
  const m: AgentMessage = { id: newMessageId(), role: 'user', blocks, mentions }
  if (contextHint !== undefined) m.contextHint = contextHint
  return m
}

export function isCompleteBlock(b: AgentContentBlock): boolean {
  switch (b.kind) {
    case 'thinking':
      return b.signature !== ''
    case 'redactedThinking':
      return b.data !== ''
    case 'openAIReasoning':
      return b.encryptedContent !== ''
    case 'text':
      return b.text !== ''
    case 'toolUse':
    case 'toolResult':
      return true
  }
}

/** Removes incomplete blocks from the assistant message `id`, and the message itself if nothing is left. */
export function dropEmptyAssistantTurn(messages: AgentMessage[], id: string): void {
  const i = messages.findIndex((m) => m.id === id && m.role === 'assistant')
  if (i < 0) return
  messages[i] = { ...messages[i], blocks: messages[i].blocks.filter(isCompleteBlock) }
  if (!messages[i].blocks.length) messages.splice(i, 1)
}

function nextNonSystemIndex(messages: AgentMessage[], index: number): number {
  let next = index + 1
  while (next < messages.length && messages[next].role === 'system') next++
  return next
}

const toolUseIds = (m: AgentMessage): string[] => m.blocks.flatMap((b) => (b.kind === 'toolUse' ? [b.id] : []))
const toolResultIds = (m: AgentMessage): string[] => m.blocks.flatMap((b) => (b.kind === 'toolResult' ? [b.toolUseId] : []))

/** Ids that already have a result in the next non-system message (when it is a user message). */
export function resolvedToolUseIds(messages: AgentMessage[], assistantIndex: number): Set<string> {
  const next = nextNonSystemIndex(messages, assistantIndex)
  return next < messages.length && messages[next].role === 'user' ? new Set(toolResultIds(messages[next])) : new Set()
}

export const cancelledResult = (toolUseId: string, reason = CANCELLED): AgentContentBlock => ({
  kind: 'toolResult',
  toolUseId,
  content: [{ kind: 'text', text: reason }],
  isError: true,
})

/** Gives every unanswered tool use a synthetic "Cancelled" error result so both APIs accept the transcript (§A3.6). */
export function resolveOrphanToolUses(messages: AgentMessage[], reason = CANCELLED): boolean {
  let changed = false
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'assistant') continue
    const ids = toolUseIds(messages[i])
    if (!ids.length) continue
    const next = nextNonSystemIndex(messages, i)
    const nextIsToolResult = next < messages.length && messages[next].role === 'user' && messages[next].blocks.some((b) => b.kind === 'toolResult')
    const resolved = new Set(nextIsToolResult ? toolResultIds(messages[next]) : [])
    const orphans = ids.filter((id) => !resolved.has(id))
    if (!orphans.length) continue
    const synthetic = orphans.map((id) => cancelledResult(id, reason))
    if (nextIsToolResult) messages[next] = { ...messages[next], blocks: [...synthetic, ...messages[next].blocks] }
    else messages.splice(next, 0, userMessage(synthetic))
    changed = true
  }
  return changed
}

/** First non-empty user text, trimmed, first 40 grapheme clusters. */
export function titleFrom(messages: AgentMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return NEW_CHAT_TITLE
  for (const b of first.blocks) {
    if (b.kind !== 'text') continue
    const trimmed = b.text.trim()
    if (!trimmed) continue
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let out = ''
    let n = 0
    for (const { segment } of seg.segment(trimmed)) {
      if (n++ >= 40) break
      out += segment
    }
    return out
  }
  return NEW_CHAT_TITLE
}

export interface InlinedImages {
  images: { base64: string; mediaType: string }[]
  inlinedIds: string[]
  /** mediaRef → reason */
  failures: Record<string, string>
}

export interface MentionContextProvider {
  /** Live hint for messages that have no frozen `contextHint`. */
  hint(mentions: AgentMention[]): string
  inlineImages(mentions: AgentMention[]): Promise<InlinedImages>
}

/** The inline note appended to the hint (never stored). */
export function inlineNote(inlined: InlinedImages): string | null {
  const parts: string[] = []
  if (inlined.inlinedIds.length) parts.push(`These mentioned images are attached inline as image blocks — do not call inspect_media for them: ${[...inlined.inlinedIds].sort().join(', ')}.`)
  const failed = Object.keys(inlined.failures).sort()
  if (failed.length) parts.push(`These images could not be attached; tell the user the image could not be read rather than describing it: ${failed.map((id) => `${id} (${inlined.failures[id]})`).join(', ')}.`)
  return parts.length ? parts.join(' ') : null
}

/** Stored transcript → provider-neutral request messages (§A5.1). */
export async function apiMessages(messages: AgentMessage[], ctx: MentionContextProvider): Promise<RequestMessage[]> {
  const out: RequestMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    let content: RequestBlock[] = [...msg.blocks]
    if (msg.role === 'user' && msg.mentions.length) {
      const inlined = await ctx.inlineImages(msg.mentions)
      let hint = msg.contextHint ?? ctx.hint(msg.mentions)
      const note = inlineNote(inlined)
      if (note) hint += ' ' + note
      content = [{ kind: 'text', text: hint }, ...inlined.images.map((i) => ({ kind: 'image' as const, ...i })), ...content]
    }
    if (!content.length) continue
    out.push({ role: msg.role === 'user' ? 'user' : 'assistant', content })
  }
  return out
}
