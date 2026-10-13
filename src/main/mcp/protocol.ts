/** One MCP `Server` per client session: the Mac's server info, instructions, tools, resources and errors. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { EventStore } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { MCP_TOOLS, SERVER_CAPABILITIES, SERVER_INFO, SERVER_INSTRUCTIONS } from './tools/definitions'
import type { ToolExecutor } from './tools/executor'
import { modelResource } from './tools/generation'

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** A JSON-RPC error with an exact code and message (the SDK copies both into the response). */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

const RESOURCES = [
  { name: 'Video Models', uri: 'palmier://models/video', description: 'Available AI video generation models and their capabilities', mimeType: 'application/json' },
  { name: 'Image Models', uri: 'palmier://models/image', description: 'Available AI image generation models and their capabilities', mimeType: 'application/json' },
]

const TOOL_LIST = MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: 'object' } }))

export function createProtocolServer(executor: ToolExecutor): Server {
  const server = new Server(SERVER_INFO, { capabilities: SERVER_CAPABILITIES, instructions: SERVER_INSTRUCTIONS })
  let initialized = false
  server.setRequestHandler(InitializeRequestSchema, async (req) => {
    if (initialized) throw new RpcError(-32600, 'Server is already initialized')
    initialized = true
    const requested = req.params.protocolVersion
    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: SERVER_CAPABILITIES,
      serverInfo: SERVER_INFO,
      instructions: SERVER_INSTRUCTIONS,
    }
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await executor.execute(req.params.name, req.params.arguments ?? {})
    return result.isError ? { content: result.content, isError: true } : { content: result.content }
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }))
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({ contents: [modelResource(req.params.uri)] }))
  server.fallbackRequestHandler = async (req) => {
    throw new RpcError(-32601, `Unknown method: ${req.method}`)
  }
  return server
}

const EVENT_LIMIT = 500

/** Bounded in-memory event log so a dropped SSE stream can resume with Last-Event-ID. */
export class MemoryEventStore implements EventStore {
  private events: { id: string; stream: string; message: JSONRPCMessage }[] = []
  private counter = 0

  async storeEvent(stream: string, message: JSONRPCMessage): Promise<string> {
    const id = `${stream}_${++this.counter}`
    this.events.push({ id, stream, message })
    if (this.events.length > EVENT_LIMIT) this.events.shift()
    return id
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.find((e) => e.id === eventId)?.stream
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }): Promise<string> {
    const index = this.events.findIndex((e) => e.id === lastEventId)
    if (index < 0) throw new Error('Unknown event id')
    const stream = this.events[index].stream
    for (const e of this.events.slice(index + 1)) if (e.stream === stream && Object.keys(e.message).length) await send(e.id, e.message)
    return stream
  }
}
