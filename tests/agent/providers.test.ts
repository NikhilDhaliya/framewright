import { describe, expect, it } from 'vitest'
import { buildAnthropicBody, parseAnthropicStream } from '../../src/main/agent/providers/anthropic'
import { buildOpenAIBody, openAIInputItems, parseOpenAIStream } from '../../src/main/agent/providers/openai'
import type { ProviderEvent, RequestMessage, StreamRequest } from '../../src/main/agent/providers/types'
import { AgentCancelled, dataPayloads, postForStream, readBody, sortedJson, splitLines } from '../../src/main/agent/sse'

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder()
  for (const p of parts) yield enc.encode(p)
}

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

/** SSE text for a list of JSON events, then split into arbitrary small chunks (partial lines, split UTF-8). */
function sse(events: unknown[], opts: { chunk?: number; eventNames?: boolean; crlf?: boolean } = {}): string[] {
  const nl = opts.crlf ? '\r\n' : '\n'
  const text = events
    .map((e) => {
      const name = opts.eventNames && typeof e === 'object' && e && 'type' in e ? `event: ${(e as { type: string }).type}${nl}` : ''
      return `${name}data: ${typeof e === 'string' ? e : JSON.stringify(e)}${nl}${nl}`
    })
    .join('')
  const bytes = Buffer.from(text)
  const size = opts.chunk ?? 7
  const out: string[] = []
  // Split on byte boundaries (may cut a multi-byte character) and decode via Uint8Array path below.
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size).toString('latin1'))
  return out
}

async function* byteChunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield Uint8Array.from(Buffer.from(p, 'latin1'))
}

const anthropicEvents = (events: unknown[], o?: Parameters<typeof sse>[1]) => collect(parseAnthropicStream(dataPayloads(splitLines(byteChunks(sse(events, o))))))
const openAIEvents = (events: unknown[], o?: Parameters<typeof sse>[1]) => collect(parseOpenAIStream(dataPayloads(splitLines(byteChunks(sse(events, o))))))

describe('SSE line reader', () => {
  it('splits LF, CRLF and CR across chunk boundaries', async () => {
    const lines = await collect(splitLines(chunks(['a\r', '\nb\n', 'c', '\rd\r\n\r\n', 'tail'])))
    expect(lines).toEqual(['a', 'b', 'c', 'd', '', 'tail'])
  })

  it('keeps multi-byte characters split across chunks intact', async () => {
    const bytes = Buffer.from('data: héllo — ✓\n')
    const parts = [bytes.subarray(0, 8), bytes.subarray(8, 15), bytes.subarray(15)]
    async function* gen() {
      for (const p of parts) yield new Uint8Array(p)
    }
    expect(await collect(dataPayloads(splitLines(gen())))).toEqual(['héllo — ✓'])
  })

  it('fails with the timeout message after the inactivity window', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: 1\n'))
      },
    })
    const got: Uint8Array[] = []
    await expect(
      (async () => {
        for await (const c of readBody(body, { idleMs: 30 })) got.push(c)
      })(),
    ).rejects.toThrow('The request timed out.')
    expect(got).toHaveLength(1)
  })

  it('turns an abort into AgentCancelled', async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 10)
    await expect(collect(readBody(body, { signal: ac.signal, idleMs: 5000 }))).rejects.toBeInstanceOf(AgentCancelled)
  })

  it('maps HTTP errors to "<Provider> API error (<status>): <first 500 chars>"', async () => {
    const long = 'x'.repeat(800)
    const fetchImpl = (async () => new Response(`{"error":"${long}"}`, { status: 401 })) as typeof fetch
    const err = await postForStream('http://x', {}, '{}', 'Anthropic', { fetchImpl }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(`Anthropic API error (401): ${`{"error":"${long}"}`.slice(0, 500)}`)
  })

  it('serializes request bodies with sorted keys at every depth', () => {
    expect(sortedJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}')
  })
})

const baseReq = (messages: RequestMessage[], extra: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'claude-sonnet-5',
  effort: 'high',
  maxTokens: 64000,
  system: 'SYS',
  tools: [
    { name: 'get_timeline', description: 'Read.', inputSchema: { type: 'object' } },
    { name: 'manage_skills', description: 'Skills.', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
  ],
  messages,
  ...extra,
})

describe('Anthropic request', () => {
  const messages: RequestMessage[] = [
    { role: 'user', content: [{ kind: 'text', text: 'hint' }, { kind: 'image', base64: 'AAA', mediaType: 'image/png' }, { kind: 'text', text: 'Hello' }] },
    {
      role: 'assistant',
      content: [
        { kind: 'thinking', text: 'unsigned', signature: '' },
        { kind: 'thinking', text: 'plan', signature: 'sig' },
        { kind: 'redactedThinking', data: '' },
        { kind: 'redactedThinking', data: 'opaque' },
        { kind: 'openAIReasoning', summary: 's', encryptedContent: 'e', model: 'gpt-5.6-terra' },
        { kind: 'text', text: '' },
        { kind: 'text', text: 'Working.' },
        { kind: 'toolUse', id: 'tu_1', name: 'get_timeline', input: '{"b":1,"a":2}' },
        { kind: 'toolUse', id: 'tu_2', name: 'get_timeline', input: 'not json' },
      ],
    },
    {
      role: 'user',
      content: [
        { kind: 'toolResult', toolUseId: 'tu_1', content: [{ kind: 'text', text: 'ok' }, { kind: 'image', base64: 'BBB', mediaType: 'image/jpeg' }], isError: false },
        { kind: 'toolResult', toolUseId: 'tu_2', content: [{ kind: 'text', text: 'Cancelled' }], isError: true },
      ],
    },
    { role: 'assistant', content: [{ kind: 'openAIReasoning', summary: 'only', encryptedContent: 'x', model: 'gpt-5.6-luna' }] },
  ]

  it('converts blocks, drops what the API cannot take and places three cache breakpoints', () => {
    const body = buildAnthropicBody(baseReq(messages)) as any
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.max_tokens).toBe(64000)
    expect(body.stream).toBe(true)
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.thinking).toEqual({ display: 'summarized', type: 'adaptive' })
    expect(body.system).toEqual([{ cache_control: { type: 'ephemeral' }, text: 'SYS', type: 'text' }])
    expect(body.tools[0]).toEqual({ name: 'get_timeline', description: 'Read.', input_schema: { type: 'object' } })
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body).not.toHaveProperty('temperature')
    // The reasoning-only assistant message converts to nothing and is omitted.
    expect(body.messages).toHaveLength(3)
    expect(body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } })
    expect(body.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'Working.' },
      { type: 'tool_use', id: 'tu_1', name: 'get_timeline', input: { b: 1, a: 2 } },
      { type: 'tool_use', id: 'tu_2', name: 'get_timeline', input: {} },
    ])
    const results = body.messages[2].content
    expect(results[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
      ],
      is_error: false,
    })
    expect(results[1].is_error).toBe(true)
    expect(results[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(results[0].cache_control).toBeUndefined()
    const s = sortedJson(body)
    expect(s.indexOf('"max_tokens"')).toBeLessThan(s.indexOf('"messages"'))
  })

  it('omits tools when there are none', () => {
    expect(buildAnthropicBody(baseReq(messages, { tools: [] }))).not.toHaveProperty('tools')
  })
})

describe('Anthropic SSE parser', () => {
  const stream = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think — ✓' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'RED' } },
    { type: 'content_block_stop', index: 1 },
    'ping garbage {not json',
    { type: 'ping' },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hi ' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'there' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'manage_markers', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"action":' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"create"}' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'toolu_2', name: 'undo', input: {} } },
    { type: 'content_block_stop', index: 4 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]

  it('emits text, thinking, signature, redacted thinking, tool uses and the stop reason (tiny chunks, CRLF)', async () => {
    for (const opts of [{ chunk: 3 }, { chunk: 1000, crlf: true, eventNames: true }]) {
      const events = await anthropicEvents(stream, opts)
      expect(events).toEqual<ProviderEvent[]>([
        { type: 'thinkingDelta', text: 'Let me ' },
        { type: 'thinkingDelta', text: 'think — ✓' },
        { type: 'thinkingSignature', signature: 'SIG' },
        { type: 'redactedThinking', data: 'RED' },
        { type: 'textDelta', text: 'Hi ' },
        { type: 'textDelta', text: 'there' },
        { type: 'toolUseComplete', id: 'toolu_1', name: 'manage_markers', input: '{"action":"create"}' },
        { type: 'toolUseComplete', id: 'toolu_2', name: 'undo', input: '{}' },
        { type: 'messageStop', reason: 'tool_use' },
      ])
    }
  })

  it('maps unknown stop reasons to other and ends without a terminal-event check', async () => {
    expect(await anthropicEvents([{ type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } }])).toEqual([{ type: 'messageStop', reason: 'other' }])
    expect(await anthropicEvents([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }])).toEqual([{ type: 'textDelta', text: 'x' }])
  })

  it('throws on an error event', async () => {
    await expect(anthropicEvents([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])).rejects.toThrow(
      'Anthropic stream error: Overloaded',
    )
  })
})

describe('OpenAI request', () => {
  it('buffers text/images into message items and converts reasoning, calls and outputs', () => {
    const items = openAIInputItems(
      [
        { role: 'user', content: [{ kind: 'text', text: 'hint' }, { kind: 'image', base64: 'AAA', mediaType: 'image/png' }, { kind: 'text', text: 'Hello' }, { kind: 'text', text: '' }] },
        {
          role: 'assistant',
          content: [
            { kind: 'thinking', text: 't', signature: 's' },
            { kind: 'openAIReasoning', summary: 'other model', encryptedContent: 'E0', model: 'gpt-5.6-luna' },
            { kind: 'openAIReasoning', summary: 'unfinished', encryptedContent: '', model: 'gpt-5.6-terra' },
            { kind: 'text', text: 'Before' },
            { kind: 'openAIReasoning', summary: '', encryptedContent: 'E1', itemID: 'rs_1', model: 'gpt-5.6-terra' },
            { kind: 'openAIReasoning', summary: 'Sum', encryptedContent: 'E2', model: 'gpt-5.6-terra' },
            { kind: 'toolUse', id: 'call_1', name: 'get_timeline', input: '{"z":1,"a":{"y":2,"b":3}}' },
            { kind: 'toolUse', id: 'call_2', name: 'undo', input: 'oops' },
          ],
        },
        {
          role: 'user',
          content: [
            { kind: 'toolResult', toolUseId: 'call_1', content: [{ kind: 'text', text: 'ok' }, { kind: 'image', base64: 'BBB', mediaType: 'image/jpeg' }], isError: false },
            { kind: 'toolResult', toolUseId: 'call_2', content: [{ kind: 'text', text: 'Nothing to undo.' }], isError: true },
          ],
        },
      ],
      'gpt-5.6-terra',
    )
    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hint' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          { type: 'input_text', text: 'Hello' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Before', annotations: [] }] },
      { type: 'reasoning', encrypted_content: 'E1', summary: [], id: 'rs_1' },
      { type: 'reasoning', encrypted_content: 'E2', summary: [{ type: 'summary_text', text: 'Sum' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_timeline', arguments: '{"a":{"b":3,"y":2},"z":1}' },
      { type: 'function_call', call_id: 'call_2', name: 'undo', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'ok' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call_2',
        output: [
          { type: 'input_text', text: 'Tool error' },
          { type: 'input_text', text: 'Nothing to undo.' },
        ],
      },
    ])
  })

  it('builds the Responses body', () => {
    const body = buildOpenAIBody({ ...baseReq([]), model: 'gpt-5.6-terra', effort: 'minimal' }) as any
    expect(body).toMatchObject({ instructions: 'SYS', max_output_tokens: 64000, model: 'gpt-5.6-terra', reasoning: { effort: 'minimal', summary: 'auto' }, store: false, stream: true })
    expect(body).not.toHaveProperty('include')
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body.tools[0]).toEqual({ description: 'Read.', name: 'get_timeline', parameters: { type: 'object' }, strict: false, type: 'function' })
  })
})

describe('OpenAI SSE parser', () => {
  const completed = (output: unknown[]) => ({ type: 'response.completed', response: { status: 'completed', output } })

  it('emits text, reasoning summaries, reasoning items and function calls; completed with a call → tool_use', async () => {
    const events = await openAIEvents(
      [
        { type: 'response.created', response: {} },
        { type: 'response.reasoning_summary_text.delta', delta: 'Plan' },
        { type: 'response.reasoning_summary_text.delta', delta: 'ning ✓' },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [{ type: 'summary_text', text: 'Plan' }, { type: 'summary_text', text: 'ning ✓' }] } },
        { type: 'response.output_text.delta', delta: 'Sure' },
        { type: 'response.output_text.delta', delta: '' },
        { type: 'response.refusal.delta', delta: '!' },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'manage_markers', arguments: '{"action":"create"}' } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_2', name: 'undo', arguments: '' } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: '', name: 'bad' } },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', encrypted_content: '' } },
        '[DONE]',
        completed([{ type: 'reasoning' }, { type: 'function_call' }]),
      ],
      { chunk: 5, eventNames: true },
    )
    expect(events).toEqual<ProviderEvent[]>([
      { type: 'reasoningSummaryDelta', text: 'Plan' },
      { type: 'reasoningSummaryDelta', text: 'ning ✓' },
      { type: 'reasoningComplete', id: 'rs_1', summary: 'Planning ✓', encryptedContent: 'ENC' },
      { type: 'textDelta', text: 'Sure' },
      { type: 'textDelta', text: '!' },
      { type: 'toolUseComplete', id: 'call_1', name: 'manage_markers', input: '{"action":"create"}' },
      { type: 'toolUseComplete', id: 'call_2', name: 'undo', input: '{}' },
      { type: 'messageStop', reason: 'tool_use' },
    ])
  })

  it('maps terminal events', async () => {
    expect(await openAIEvents([completed([{ type: 'message', content: [{ type: 'output_text' }] }])])).toEqual([{ type: 'messageStop', reason: 'end_turn' }])
    expect(await openAIEvents([completed([{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }])])).toEqual([{ type: 'messageStop', reason: 'refusal' }])
    expect(await openAIEvents([{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }])).toEqual([{ type: 'messageStop', reason: 'max_tokens' }])
    expect(await openAIEvents([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }])).toEqual([{ type: 'messageStop', reason: 'other' }])
    await expect(openAIEvents([{ type: 'response.failed', response: { status: 'failed', error: { message: 'Server overloaded' } } }])).rejects.toThrow('OpenAI stream error: Server overloaded')
    await expect(openAIEvents([{ type: 'response.completed', response: { status: 'failed' } }])).rejects.toThrow('OpenAI stream error: The response failed.')
    await expect(openAIEvents([{ type: 'response.cancelled', response: {} }])).rejects.toBeInstanceOf(AgentCancelled)
  })

  it('fails on error events, invalid payloads and a stream without a terminal event', async () => {
    await expect(openAIEvents([{ type: 'error', error: { message: 'Rate limited' } }])).rejects.toThrow('OpenAI stream error: Rate limited')
    await expect(openAIEvents([{ type: 'error', message: 'Top-level' }])).rejects.toThrow('OpenAI stream error: Top-level')
    await expect(openAIEvents([{ type: 'error' }])).rejects.toThrow('OpenAI stream error: Unknown stream error.')
    await expect(openAIEvents(['[1,2]'])).rejects.toThrow('OpenAI stream error: Invalid event payload.')
    await expect(openAIEvents(['{"type":'])).rejects.toThrow('OpenAI stream error: Invalid event payload.')
    await expect(openAIEvents([{ type: 'response.output_text.delta', delta: 'partial' }])).rejects.toThrow('OpenAI stream error: The stream ended before a terminal event.')
  })
})
