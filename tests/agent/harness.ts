import { TEST_ROOT } from './env'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { emptyManifest, newProjectFile } from '../../src/core/model'
import { ProjectSession } from '../../src/main/project/session'
import type { AppContext, SessionRegistry } from '../../src/main/services'
import type { AppSettings, UiCommand } from '../../src/shared/api'

// ---------- Fake provider server ----------

export interface Scripted {
  status?: number
  /** Raw error body for status >= 400. */
  body?: string
  /** SSE `data:` payloads (objects are JSON-encoded). */
  events?: unknown[]
  /** Delay between events (ms). */
  delayMs?: number
  /** Keep the connection open after the events (for cancellation tests). */
  hang?: boolean
}

export interface RecordedRequest {
  path: string
  headers: http.IncomingHttpHeaders
  raw: string
  body: any
}

export interface FakeProvider {
  baseUrl: string
  requests: RecordedRequest[]
  script: Scripted[]
  close(): Promise<void>
}

/** A local HTTP server answering POST /v1/messages and /v1/responses from a script, one entry per request. */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: RecordedRequest[] = []
  const script: Scripted[] = []
  const open = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      requests.push({ path: req.url ?? '', headers: req.headers, raw, body: JSON.parse(raw || '{}') })
      const step = script.shift() ?? { status: 500, body: '{"error":"no scripted response"}' }
      if (step.status && step.status >= 400) {
        res.writeHead(step.status, { 'content-type': 'application/json' })
        res.end(step.body ?? '')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      open.add(res)
      res.on('close', () => open.delete(res))
      for (const e of step.events ?? []) {
        if (res.destroyed) return
        const data = typeof e === 'string' ? e : JSON.stringify(e)
        const name = typeof e === 'object' && e && 'type' in e ? `event: ${(e as { type: string }).type}\n` : ''
        res.write(`${name}data: ${data}\n\n`)
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
      }
      if (!step.hang) res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script,
    async close() {
      for (const r of open) r.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

// ---------- Anthropic / OpenAI event builders ----------

export const anthropic = {
  text: (index: number, text: string) => [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ...[...text.matchAll(/.{1,4}/gsu)].map((m) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: m[0] } })),
    { type: 'content_block_stop', index },
  ],
  thinking: (index: number, text: string, signature: string) => [
    { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
    { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
    { type: 'content_block_stop', index },
  ],
  tool: (index: number, id: string, name: string, input: object) => {
    const json = JSON.stringify(input)
    const mid = Math.floor(json.length / 2)
    return [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, mid) } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(mid) } },
      { type: 'content_block_stop', index },
    ]
  },
  message: (stop: string, ...blocks: unknown[][]) => [
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1 } } },
    ...blocks.flat(),
    { type: 'message_delta', delta: { stop_reason: stop } },
    { type: 'message_stop' },
  ],
}

export const openai = {
  text: (text: string) => [...text.matchAll(/.{1,4}/gsu)].map((m) => ({ type: 'response.output_text.delta', delta: m[0] })),
  reasoning: (id: string, summary: string, enc: string) => [
    { type: 'response.reasoning_summary_text.delta', delta: summary },
    { type: 'response.output_item.done', item: { type: 'reasoning', id, encrypted_content: enc, summary: [{ type: 'summary_text', text: summary }] } },
  ],
  call: (callId: string, name: string, args: object) => [{ type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } }],
  completed: (output: unknown[]) => ({ type: 'response.completed', response: { status: 'completed', output } }),
}

// ---------- Project + app context ----------

class Sessions implements SessionRegistry {
  list: ProjectSession[] = []
  focused() {
    return null
  }
  all() {
    return this.list
  }
  async openPath(): Promise<ProjectSession> {
    throw new Error('not supported in agent tests')
  }
  async create(): Promise<ProjectSession> {
    throw new Error('not supported in agent tests')
  }
}

export interface AgentTestEnv {
  session: ProjectSession
  ctx: AppContext
  settings: AppSettings
  ui: UiCommand[]
}

export async function makeProject(): Promise<AgentTestEnv> {
  const session = await ProjectSession.create(path.join(TEST_ROOT, `agent-${randomUUID().slice(0, 8)}.palmier`), { file: newProjectFile(), manifest: emptyManifest() })
  const sessions = new Sessions()
  sessions.list.push(session)
  const ui: UiCommand[] = []
  const settings: AppSettings = {
    projectsDirectory: path.join(TEST_ROOT, 'projects'),
    mcpEnabled: false,
    mcpPort: 0,
    rippleTimelineMarkers: true,
    theme: 'dark',
    apiKeys: { anthropic: 'sk-ant-test', openai: 'sk-openai-test' },
    panels: { media: true, inspector: true, agent: true },
    layoutPreset: 'default',
  }
  const unsupported = () => {
    throw new Error('not used')
  }
  const ctx: AppContext = {
    sessions,
    media: { probe: unsupported, importPaths: unsupported, importBytes: unsupported, playbackPath: unsupported, thumbnail: unsupported, filmstrip: unsupported, waveform: unsupported, extractFrame: unsupported } as never,
    render: { captureFrame: unsupported, measureText: unsupported } as never,
    exporter: { start: unsupported, get: () => undefined, list: () => [], cancel: () => undefined, wait: unsupported, on: () => undefined } as never,
    settings: () => settings,
    ui: (_s, cmd) => ui.push(cmd),
  }
  return { session, ctx, settings, ui }
}
