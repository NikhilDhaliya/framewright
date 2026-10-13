/** Anthropic Messages API over SSE, BYOK (spec 06 §A6; AnthropicProvider.swift, BYOKClient.swift). */
import { dataPayloads, postForStream, readBody, sortedJson, splitLines } from '../sse'
import { stopReasonOf, type AgentClient, type ClientOptions, type ProviderEvent, type RequestBlock, type StreamRequest } from './types'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const EPHEMERAL = { type: 'ephemeral' }

type Json = Record<string, unknown>

function parseObject(text: string): Json {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

const imageBlock = (mediaType: string, data: string): Json => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })

/** Stored/request block → Messages API content block, or null when the API can't take it (§A6.2). */
export function anthropicContent(b: RequestBlock): Json | null {
  switch (b.kind) {
    case 'image':
      return imageBlock(b.mediaType, b.base64)
    case 'thinking':
      return b.signature ? { type: 'thinking', thinking: b.text, signature: b.signature } : null
    case 'redactedThinking':
      return b.data ? { type: 'redacted_thinking', data: b.data } : null
    case 'openAIReasoning':
      return null
    case 'text':
      return b.text ? { type: 'text', text: b.text } : null
    case 'toolUse':
      return { type: 'tool_use', id: b.id, name: b.name, input: parseObject(b.input) }
    case 'toolResult':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: b.content.map((c) => (c.kind === 'text' ? { type: 'text', text: c.text } : imageBlock(c.mediaType, c.base64))),
        is_error: b.isError,
      }
  }
}

/** Request body (keys are sorted at serialization). Three cache breakpoints: last tool, system, last block of the last message. */
export function buildAnthropicBody(req: StreamRequest): Json {
  const tools: Json[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: EPHEMERAL }
  const messages: Json[] = []
  for (const m of req.messages) {
    const content = m.content.map(anthropicContent).filter((c): c is Json => c !== null)
    if (content.length) messages.push({ role: m.role, content })
  }
  const last = messages[messages.length - 1]
  if (last) {
    const content = [...(last.content as Json[])]
    content[content.length - 1] = { ...content[content.length - 1], cache_control: EPHEMERAL }
    messages[messages.length - 1] = { ...last, content }
  }
  const body: Json = {
    max_tokens: req.maxTokens,
    messages,
    model: req.model,
    output_config: { effort: req.effort },
    stream: true,
    system: [{ cache_control: EPHEMERAL, text: req.system, type: 'text' }],
    thinking: { display: 'summarized', type: 'adaptive' },
  }
  if (tools.length) body.tools = tools
  return body
}

/** Messages API SSE → provider events (§A6.3). Unparsable lines are ignored. */
export async function* parseAnthropicStream(payloads: AsyncIterable<string>): AsyncGenerator<ProviderEvent> {
  const pending = new Map<number, { id: string; name: string; json: string }>()
  for await (const payload of payloads) {
    let event: Json
    try {
      const v = JSON.parse(payload)
      if (!v || typeof v !== 'object' || typeof v.type !== 'string') continue
      event = v
    } catch {
      continue
    }
    const index = typeof event.index === 'number' ? event.index : null
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block as Json | undefined
        if (index === null || !block) break
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') pending.set(index, { id: block.id, name: block.name, json: '' })
        else if (block.type === 'redacted_thinking' && typeof block.data === 'string') yield { type: 'redactedThinking', data: block.data }
        break
      }
      case 'content_block_delta': {
        const delta = event.delta as Json | undefined
        if (index === null || !delta) break
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) yield { type: 'textDelta', text: delta.text }
        else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) yield { type: 'thinkingDelta', text: delta.thinking }
        else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature) yield { type: 'thinkingSignature', signature: delta.signature }
        else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const acc = pending.get(index)
          if (acc) acc.json += delta.partial_json
        }
        break
      }
      case 'content_block_stop': {
        const acc = index === null ? undefined : pending.get(index)
        if (acc && index !== null) {
          pending.delete(index)
          yield { type: 'toolUseComplete', id: acc.id, name: acc.name, input: acc.json || '{}' }
        }
        break
      }
      case 'message_delta': {
        const delta = event.delta as Json | undefined
        if (delta && typeof delta.stop_reason === 'string') yield { type: 'messageStop', reason: stopReasonOf(delta.stop_reason) }
        break
      }
      case 'error': {
        const err = event.error as Json | undefined
        if (err && typeof err.message === 'string') throw new Error(`Anthropic stream error: ${err.message}`)
        break
      }
      default:
        break
    }
  }
}

export class AnthropicClient implements AgentClient {
  constructor(private readonly opts: ClientOptions) {}

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const base = (this.opts.baseUrl ?? process.env.PALMIER_ANTHROPIC_BASE_URL ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': this.opts.apiKey,
      'anthropic-version': '2023-06-01',
    }
    const body = await postForStream(`${base}/messages`, headers, sortedJson(buildAnthropicBody(req)), 'Anthropic', { signal, idleMs: this.opts.idleMs, fetchImpl: this.opts.fetchImpl })
    yield* parseAnthropicStream(dataPayloads(splitLines(readBody(body, { signal, idleMs: this.opts.idleMs }))))
  }
}
