import { TEST_ROOT } from './env'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BRANDED_SPEC as spec } from '../../src/main/mcp/brandedSpec'
import manifest from '../../resources/mcpb/manifest.json'
import { startHarness, videoEntry, type Harness } from './harness'

const SHIM = path.resolve(__dirname, '../../resources/mcpb/server/index.js')

let h: Harness
let shim: ChildProcessWithoutNullStreams
const received: any[] = []
const waiters: (() => void)[] = []

function next(match: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const check = () => {
      const hit = received.find(match)
      if (hit) resolve(hit)
      else waiters.push(check)
    }
    check()
  })
}

const send = (msg: unknown) => shim.stdin.write(`${JSON.stringify(msg)}\n`)

beforeAll(async () => {
  h = await startHarness([videoEntry()])
  // The Linux shim follows the port in Framewright's settings.json under XDG_CONFIG_HOME.
  const config = path.join(TEST_ROOT, 'shim-config')
  fs.mkdirSync(path.join(config, 'framewright'), { recursive: true })
  fs.writeFileSync(path.join(config, 'framewright', 'settings.json'), JSON.stringify({ mcpPort: Number(new URL(h.url).port) }))
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: config }
  delete env.PALMIER_MCP_URL
  delete env.FRAMEWRIGHT_MCP_URL
  shim = spawn(process.execPath, [SHIM], { env })
  let buf = ''
  shim.stdout.setEncoding('utf8')
  shim.stdout.on('data', (chunk: string) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      received.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
      for (const w of waiters.splice(0)) w()
    }
  })
})

afterAll(async () => {
  shim.stdin.end()
  await new Promise((r) => shim.once('exit', r))
  await h.close()
})

describe('mcpb stdio shim', () => {
  it('targets Linux in its manifest', () => {
    expect(manifest.compatibility.platforms).toContain('linux')
    expect(manifest).toMatchObject({ name: 'framewright', display_name: 'Framewright' })
    expect(manifest.server.mcp_config).toEqual({ command: 'node', args: ['${__dirname}/server/index.js'] })
  })

  it('proxies initialize, tools/list and tools/call over stdio', { timeout: 15000 }, async () => {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } })
    const init = await next((m) => m.id === 1)
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: spec.serverInfo, instructions: spec.instructions })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const list = await next((m) => m.id === 2)
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(spec.tools.map((t) => t.name))
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_timeline', arguments: {} } })
    const timeline = await next((m) => m.id === 3)
    expect(JSON.parse(timeline.result.content[0].text)).toMatchObject({ fps: 30, width: 1920, height: 1080 })
    // The standalone GET stream's one-time announce is forwarded as a notification.
    expect(await next((m) => m.method === 'notifications/tools/list_changed')).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  })
})
