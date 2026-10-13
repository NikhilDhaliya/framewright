/** OpenAI Responses API over SSE, BYOK (spec 06 §A7; OpenAIProvider.swift). */
import type { AgentModelId } from '../../../shared/agent'
import { AgentCancelled, dataPayloads, postForStream, readBody, sortedJson, splitLines } from '../sse'
import type { AgentClient, ClientOptions, ProviderEvent, RequestMessage, StopReason, StreamRequest } from './types'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

type Json = Record<string, unknown>

const inputImage = (mediaType: string, base64: string): Json => ({ type: 'input_image', image_url: `data:${mediaType};base64,${base64}` })

/** Tool input re-serialized compact with sorted keys, or "{}" when it is not a JSON object/array. */
function normalizedArguments(input: string): string {
  try {
    const v = JSON.parse(input)
    return v && typeof v === 'object' ? sortedJson(v) : '{}'
  } catch {
    return '{}'
  }
}

/** Transcript → Responses `input` items; consecutive text/image blocks share one message item (§A7.2). */
export function openAIInputItems(messages: RequestMessage[], model: AgentModelId): Json[] {
  const items: Json[] = []
  for (const message of messages) {
    let content: Json[] = []
    const flush = () => {
      if (!content.length) return
      items.push({ type: 'message', role: message.role, content })
      content = []
    }
    for (const b of message.content) {
      switch (b.kind) {
        case 'image':
          content.push(inputImage(b.mediaType, b.base64))
          break
        case 'thinking':
        case 'redactedThinking':
          break
        case 'openAIReasoning': {
          if (b.model !== model || !b.encryptedContent) break
          flush()
          const item: Json = { type: 'reasoning', encrypted_content: b.encryptedContent, summary: b.summary ? [{ type: 'summary_text', text: b.summary }] : [] }
          if (b.itemID) item.id = b.itemID
          items.push(item)
          break
        }
        case 'text':
          if (!b.text) break
          content.push(message.role === 'user' ? { type: 'input_text', text: b.text } : { type: 'output_text', text: b.text, annotations: [] })
          break
        case 'toolUse':
          flush()
          items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: normalizedArguments(b.input) })
          break
        case 'toolResult': {
          flush()
          const output: Json[] = b.content.map((c) => (c.kind === 'text' ? { type: 'input_text', text: c.text } : inputImage(c.mediaType, c.base64)))
          if (b.isError) output.unshift({ type: 'input_text', text: 'Tool error' })
          items.push({ type: 'function_call_output', call_id: b.toolUseId, output })
          break
        }
      }
    }
    flush()
  }
  return items
}

export function buildOpenAIBody(req: StreamRequest): Json {
  const body: Json = {
    input: openAIInputItems(req.messages, req.model),
    instructions: req.system,
    max_output_tokens: req.maxTokens,
    model: req.model,
    reasoning: { effort: req.effort, summary: 'auto' },
    store: false,
    stream: true,
  }
  if (req.tools.length) body.tools = req.tools.map((t) => ({ description: t.description, name: t.name, parameters: t.inputSchema, strict: false, type: 'function' }))
  return body
}

const streamError = (message: string) => new Error(`OpenAI stream error: ${message}`)

function terminalStopReason(response: Json): StopReason {
  const output = Array.isArray(response.output) ? (response.output as Json[]) : []
  if (output.some((i) => i?.type === 'function_call')) return 'tool_use'
  if (output.some((i) => Array.isArray(i?.content) && (i.content as Json[]).some((c) => c?.type === 'refusal'))) return 'refusal'
  return 'end_turn'
}

/** Responses SSE → provider events (§A7.3). Throws when the stream ends without a terminal event. */
export async function* parseOpenAIStream(payloads: AsyncIterable<string>): AsyncGenerator<ProviderEvent> {
  let terminated = false
  for await (const payload of payloads) {
    if (payload === '[DONE]') continue
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      throw streamError('Invalid event payload.')
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw streamError('Invalid event payload.')
    const e = event as Json
    switch (e.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (typeof e.delta === 'string' && e.delta) yield { type: 'textDelta', text: e.delta }
        break
      case 'response.reasoning_summary_text.delta':
        if (typeof e.delta === 'string' && e.delta) yield { type: 'reasoningSummaryDelta', text: e.delta }
        break
      case 'response.output_item.done': {
        const item = e.item as Json | undefined
        if (!item || typeof item !== 'object') break
        if (item.type === 'function_call') {
          if (typeof item.call_id === 'string' && item.call_id && typeof item.name === 'string' && item.name) {
            const args = typeof item.arguments === 'string' && item.arguments ? item.arguments : '{}'
            yield { type: 'toolUseComplete', id: item.call_id, name: item.name, input: args }
          }
        } else if (item.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content) {
          const summary = Array.isArray(item.summary) ? (item.summary as Json[]).map((s) => (typeof s?.text === 'string' ? s.text : '')).join('') : ''
          yield { type: 'reasoningComplete', id: typeof item.id === 'string' ? item.id : null, summary, encryptedContent: item.encrypted_content }
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
      case 'response.cancelled': {
        terminated = true
        const response = (e.response && typeof e.response === 'object' ? e.response : {}) as Json
        const status = response.status
        if (e.type === 'response.failed' || status === 'failed') {
          const err = response.error as Json | undefined
          throw streamError(typeof err?.message === 'string' ? err.message : 'The response failed.')
        }
        if (e.type === 'response.cancelled' || status === 'cancelled') throw new AgentCancelled()
        if (e.type === 'response.incomplete' || status === 'incomplete') {
          const details = response.incomplete_details as Json | undefined
          yield { type: 'messageStop', reason: details?.reason === 'max_output_tokens' ? 'max_tokens' : 'other' }
        } else yield { type: 'messageStop', reason: terminalStopReason(response) }
        break
      }
      case 'error': {
        terminated = true
        const err = e.error as Json | undefined
        const message = typeof err?.message === 'string' ? err.message : typeof e.message === 'string' ? e.message : 'Unknown stream error.'
        throw streamError(message)
      }
      default:
        break
    }
  }
  if (!terminated) throw streamError('The stream ended before a terminal event.')
}

export class OpenAIClient implements AgentClient {
  constructor(private readonly opts: ClientOptions) {}

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const base = (this.opts.baseUrl ?? process.env.PALMIER_OPENAI_BASE_URL ?? OPENAI_BASE_URL).replace(/\/+$/, '')
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${this.opts.apiKey}` }
    const body = await postForStream(`${base}/responses`, headers, sortedJson(buildOpenAIBody(req)), 'OpenAI', { signal, idleMs: this.opts.idleMs, fetchImpl: this.opts.fetchImpl })
    yield* parseOpenAIStream(dataPayloads(splitLines(readBody(body, { signal, idleMs: this.opts.idleMs }))))
  }
}
