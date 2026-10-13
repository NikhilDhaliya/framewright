import './env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BRANDED_SPEC as spec } from '../../src/main/mcp/brandedSpec'
import { call, connect, startHarness, videoEntry, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await startHarness([videoEntry()])
})

afterAll(async () => {
  await h.close()
})

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('MCP transport and protocol', () => {
  it('initializes with the (rebranded) Mac server info, instructions and capabilities', async () => {
    const client = await connect(h.url)
    expect(client.getServerVersion()).toEqual({ name: 'framewright', version: '1.0.0' })
    expect(client.getInstructions()).toBe(spec.instructions)
    expect(client.getServerCapabilities()).toEqual(spec.capabilities)
    await client.close()
  })

  it('lists the 50 tools in order with the verbatim schemas', async () => {
    const client = await connect(h.url)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(spec.tools.map((t) => t.name))
    for (const [i, t] of tools.entries()) {
      expect(t.inputSchema).toEqual(spec.tools[i].inputSchema)
      expect(t.description).toBe(spec.tools[i].description)
      expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name'])
    }
    await client.close()
  })

  it('serves the model resources and reports unknown URIs as text', async () => {
    const client = await connect(h.url)
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(['palmier://models/video', 'palmier://models/image'])
    const video = await client.readResource({ uri: 'palmier://models/video' })
    const models = JSON.parse((video.contents[0] as { text: string }).text)
    expect(models[0].id).toBe('minimax-h3')
    expect(models).toHaveLength(17)
    expect(models[0].type).toBeUndefined()
    const unknown = await client.readResource({ uri: 'palmier://nope' })
    expect(unknown.contents[0]).toEqual({ uri: 'palmier://nope', text: 'Unknown resource: palmier://nope' })
    await client.close()
  })

  it('answers unknown tools and methods the Mac way', async () => {
    const client = await connect(h.url)
    const r = await call(client, 'read_skill', { id: 'x' })
    expect(r).toMatchObject({ isError: true, text: 'Unknown tool: read_skill' })
    await expect(client.listPrompts()).rejects.toThrow(/Unknown method: prompts\/list/)
    await client.close()
  })

  it('serves sessionless JSON-RPC (curl style) without initialize', async () => {
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.status).toBe(200)
    expect(list.headers.get('content-type')).toContain('application/json')
    const body = await list.json()
    expect(body.result.tools).toHaveLength(50)
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_timeline', arguments: {} } })
    const payload = await res.json()
    const timeline = JSON.parse(payload.result.content[0].text)
    expect(timeline.fps).toBe(30)
    expect(payload.result.isError).toBeUndefined()
  })

  it('validates Host, Origin and Content-Type and rejects stale sessions', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://evil.example' })).status).toBe(403)
    expect((await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415)
    const stale = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Mcp-Session-Id': 'F00D' })
    expect(stale.status).toBe(404)
    expect(await stale.text()).toBe('')
    const port = new URL(h.url).port
    const http = await import('node:http')
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, (res) => {
        res.resume()
        resolve(res.statusCode!)
      })
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    })
    expect(status).toBe(421)
  })

  it('answers the OAuth probe and 404s other paths', async () => {
    const base = h.url.replace(/\/mcp$/, '')
    const probe = await fetch(`${base}/.well-known/oauth-protected-resource`)
    expect(await probe.json()).toEqual({ resource: `http://127.0.0.1:${new URL(h.url).port}` })
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404)
  })

  it('reports a busy port in the error message', async () => {
    const { startMcpServer } = await import('../../src/main/mcp/server')
    await expect(startMcpServer(h.ctx, { port: Number(new URL(h.url).port) })).rejects.toThrow(/already in use/)
  })
})
