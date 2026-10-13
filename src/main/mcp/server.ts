/**
 * The MCP endpoint (`/mcp`, alias `/`) on 127.0.0.1: per-client Streamable HTTP sessions with SSE responses,
 * plus a sessionless JSON fallback for clients that never initialize (plain curl).
 */
import { randomUUID } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AppContext } from '../services'
import { APP_NAME } from '../../shared/brand'
import { createProtocolServer, MemoryEventStore, SUPPORTED_PROTOCOL_VERSIONS } from './protocol'
import { ToolExecutor } from './tools/executor'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_HEADER_BYTES = 64 * 1024
const SESSION_IDLE_MS = 3600 * 1000
const SESSION_LIMIT = 32

interface Session {
  server: Server
  transport: WebStandardStreamableHTTPServerTransport
  lastUsed: number
  announced: boolean
}

export interface McpServerHandle {
  url: string
  close(): Promise<void>
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v.join(', ') : v
}

function sendEmpty(res: ServerResponse, status: number, keepAlive: boolean, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Length': '0', Connection: keepAlive ? 'keep-alive' : 'close', ...extra })
  res.end()
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(data.length), Connection: 'keep-alive', ...extra })
  res.end(data)
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_REQUEST_BYTES) {
        resolve(null)
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const isInitialize = (body: unknown) => typeof body === 'object' && body !== null && !Array.isArray(body) && (body as { method?: unknown }).method === 'initialize'

/** Streams SSE bodies (closing the connection after, like the Mac); other bodies go out with Content-Length. */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((v, k) => (headers[k] = v))
  const sse = (headers['content-type'] ?? '').startsWith('text/event-stream')
  if (!sse) {
    const body = Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, { ...headers, 'Content-Length': String(body.length), Connection: 'keep-alive' })
    res.end(body)
    return
  }
  res.writeHead(response.status, { ...headers, Connection: 'close' })
  res.flushHeaders()
  const reader = response.body!.getReader()
  res.on('close', () => void reader.cancel().catch(() => undefined))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch {
    // The client went away; the transport has already dropped the stream.
  }
  res.end()
}

export async function startMcpServer(ctx: AppContext, opts: { port: number; host?: string }): Promise<McpServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const sessions = new Map<string, Session>()
  let fallbackExecutor: ToolExecutor | null = null
  let port = opts.port

  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  const allowedOrigins = () => allowedHosts().map((h) => `http://${h}`)

  /** Host, Origin, Content-Type and protocol-version checks; Accept is deliberately not validated. */
  function validationError(req: IncomingMessage, initialize: boolean): { status: number; message: string } | null {
    const hostHeader = header(req, 'host')
    if (hostHeader && !allowedHosts().includes(hostHeader)) return { status: 421, message: 'Misdirected Request: Host header not allowed' }
    const origin = header(req, 'origin')
    if (origin && !allowedOrigins().includes(origin)) return { status: 403, message: 'Forbidden: Origin not allowed' }
    if (req.method === 'POST' && (header(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return { status: 415, message: 'Unsupported Media Type: Content-Type must be application/json' }
    }
    const version = header(req, 'mcp-protocol-version')
    if (!initialize && version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return { status: 400, message: `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})` }
    }
    return null
  }

  function webRequest(req: IncomingMessage): Request {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    headers.set('accept', req.method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream')
    return new Request(`http://${host}:${port}${req.url ?? '/mcp'}`, { method: req.method, headers })
  }

  async function evict(id: string): Promise<void> {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    await s.server.close().catch(() => undefined)
  }

  function prune(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS
    for (const [id, s] of sessions) if (s.lastUsed < cutoff) void evict(id)
    while (sessions.size >= SESSION_LIMIT) {
      const oldest = [...sessions].reduce((a, b) => (b[1].lastUsed < a[1].lastUsed ? b : a))
      sessions.delete(oldest[0])
      void oldest[1].server.close().catch(() => undefined)
    }
  }

  function announceTools(id: string): void {
    const s = sessions.get(id)
    if (!s || s.announced) return
    s.announced = true
    s.server.sendToolListChanged().catch(() => {
      const current = sessions.get(id)
      if (current) current.announced = false
    })
  }

  async function handleSession(req: IncomingMessage, res: ServerResponse, id: string, body: unknown): Promise<void> {
    const s = sessions.get(id)
    if (!s) return sendEmpty(res, 404, true)
    const sessionHeader = { 'mcp-session-id': id }
    const invalid = validationError(req, false)
    if (invalid) return sendJson(res, invalid.status, rpcError(-32000, invalid.message), sessionHeader)
    if (req.method === 'POST' && isInitialize(body)) return sendJson(res, 400, rpcError(-32600, 'Bad Request: Session already initialized'), sessionHeader)
    s.lastUsed = Date.now()
    const response = await s.transport.handleRequest(webRequest(req), { parsedBody: body })
    if (req.method === 'DELETE' && response.status === 200) void evict(id)
    if (req.method === 'GET' && response.status === 200) setImmediate(() => announceTools(id))
    await writeResponse(res, response)
  }

  async function handleInitialize(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const invalid = validationError(req, true)
    if (invalid) return sendJson(res, invalid.status, rpcError(-32000, invalid.message))
    let assigned: string | null = null
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID().toUpperCase(),
      eventStore: new MemoryEventStore(),
      onsessioninitialized: (id) => {
        assigned = id
      },
    })
    const server = createProtocolServer(new ToolExecutor(ctx))
    await server.connect(transport)
    const response = await transport.handleRequest(webRequest(req), { parsedBody: body })
    if (assigned && response.headers.get('mcp-session-id')) {
      prune()
      sessions.set(assigned, { server, transport, lastUsed: Date.now(), announced: false })
    } else await server.close().catch(() => undefined)
    await writeResponse(res, response)
  }

  async function handleSessionless(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const invalid = validationError(req, false)
    if (invalid) return sendJson(res, invalid.status, rpcError(-32000, invalid.message))
    fallbackExecutor ??= new ToolExecutor(ctx)
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    const server = createProtocolServer(fallbackExecutor)
    await server.connect(transport)
    try {
      await writeResponse(res, await transport.handleRequest(webRequest(req), { parsedBody: body }))
    } finally {
      await server.close().catch(() => undefined)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/.well-known/oauth-protected-resource') return sendJson(res, 200, { resource: `http://127.0.0.1:${port}` })
    if (path !== '/mcp' && path !== '/') return sendEmpty(res, 404, false)
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
      return sendJson(res, 405, rpcError(-32000, 'Method not allowed.'), { Allow: 'GET, POST, DELETE' })
    }
    const raw = await readBody(req)
    if (raw === null) return sendEmpty(res, 400, false)
    let body: unknown
    if (req.method === 'POST') {
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return sendJson(res, 400, rpcError(-32700, 'Parse error: Invalid JSON'))
      }
    }
    const sessionId = header(req, 'mcp-session-id')
    if (sessionId) return handleSession(req, res, sessionId, body)
    if (req.method === 'POST' && isInitialize(body)) return handleInitialize(req, res, body)
    return handleSessionless(req, res, body)
  }

  const httpServer = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal error'))
      else res.end()
    })
  })
  httpServer.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new Error(`Port ${opts.port} is already in use, so the MCP server couldn't start. Quit the other app using it (or another ${APP_NAME}) and try again.`) : e),
    )
    httpServer.listen(opts.port, host, () => resolve())
  })
  port = (httpServer.address() as AddressInfo).port

  return {
    url: `http://${host}:${port}/mcp`,
    async close() {
      await Promise.all([...sessions.keys()].map(evict))
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
        httpServer.closeAllConnections()
      })
    },
  }
}
