/** Download manager (spec 07 §0.2) against a local HTTP server: verify, resume, retry, cancel, extract. */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ModelManifest } from '../../src/main/ml/manifests'
import { ModelInstallError, ModelManager, type ModelState } from '../../src/main/ml/models'
import { sha256File } from '../../src/main/ml/download'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-models-'))
const model = randomBytes(300_000)
const bad = randomBytes(1000)
let tarball: Buffer
let server: http.Server
let base = ''
const requests: { url: string; range?: string }[] = []
let flakyFailures = 0
let slowGate: (() => void) | null = null

function serve(res: http.ServerResponse, req: http.IncomingMessage, body: Buffer) {
  const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
  const start = m ? Number(m[1]) : 0
  if (start >= body.length && m) {
    res.writeHead(416)
    return res.end()
  }
  res.writeHead(m ? 206 : 200, { 'content-length': String(body.length - start), ...(m ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) })
  res.end(body.subarray(start))
}

beforeAll(async () => {
  const src = path.join(tmp, 'pkg-src', 'whisper-bin-fake')
  mkdirSync(src, { recursive: true })
  writeFileSync(path.join(src, 'whisper-cli'), '#!/bin/sh\necho fake\n', { mode: 0o755 })
  execFileSync('tar', ['-czf', path.join(tmp, 'pkg.tar.gz'), '-C', path.join(tmp, 'pkg-src'), 'whisper-bin-fake'])
  tarball = readFileSync(path.join(tmp, 'pkg.tar.gz'))
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', range: req.headers.range })
    switch (req.url) {
      case '/model.bin':
        return serve(res, req, model)
      case '/bad.bin':
        return serve(res, req, bad)
      case '/pkg.tar.gz':
        return serve(res, req, tarball)
      case '/flaky.bin':
        if (!req.headers.range && flakyFailures-- > 0) {
          // Send half the body, then drop the connection.
          res.writeHead(200, { 'content-length': String(model.length) })
          res.write(model.subarray(0, 150_000), () => res.socket?.destroy())
          return
        }
        return serve(res, req, model)
      case '/error500.bin':
        res.writeHead(500)
        return res.end()
      case '/slow.bin': {
        if (req.headers.range) return serve(res, req, model)
        res.writeHead(200, { 'content-length': String(model.length) })
        res.write(model.subarray(0, 100_000))
        slowGate = () => res.end(model.subarray(100_000))
        return
      }
      default:
        res.writeHead(404)
        res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  await fs.rm(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  requests.length = 0
})

function manifest(id: string, file: string, body: Buffer, o: Partial<ModelManifest['files'][number]> = {}): ModelManifest {
  return { id: id as ModelManifest['id'], dir: `test/${id}`, label: id, files: [{ url: `${base}/${file}`, path: file, bytes: body.length, sha256: sha(body), ...o }] }
}

function manager(manifests: ModelManifest[]) {
  const root = mkdtempSync(path.join(tmp, 'root-'))
  const m = new ModelManager({ root, manifests: Object.fromEntries(manifests.map((x) => [x.id, x])), retries: 2, retryDelayMs: 10 })
  const states: ModelState[] = []
  m.on('state', (_id: string, s: ModelState) => states.push(s))
  return { m, root, states }
}

describe('ModelManager', () => {
  it('downloads, verifies and installs once; later calls resolve without a request', async () => {
    const { m, states } = manager([manifest('plain', 'model.bin', model)])
    expect(m.state('plain')).toEqual({ kind: 'notInstalled' })
    const dir = await m.ensure('plain')
    expect(await sha256File(path.join(dir, 'model.bin'))).toBe(sha(model))
    expect(JSON.parse(readFileSync(path.join(dir, 'spec.json'), 'utf8')).files[0].sha256).toBe(sha(model))
    expect(m.state('plain')).toEqual({ kind: 'ready' })
    const fractions = states.filter((s) => s.kind === 'downloading').map((s) => (s as { fraction: number }).fraction)
    expect(fractions[0]).toBe(0)
    expect(fractions.at(-1)).toBe(1)
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1])).toBe(true)
    expect(states.map((s) => s.kind)).toContain('preparing')
    expect(states.at(-1)).toEqual({ kind: 'ready' })
    expect(requests).toHaveLength(1)
    expect(await m.ensure('plain')).toBe(dir)
    expect(requests).toHaveLength(1)
    expect(await m.sizeOnDisk('plain')).toBeGreaterThan(model.length)
  })

  it('shares one download between concurrent callers', async () => {
    const { m } = manager([manifest('shared', 'model.bin', model)])
    const [a, b] = await Promise.all([m.ensure('shared'), m.ensure('shared')])
    expect(a).toBe(b)
    expect(requests.filter((r) => r.url === '/model.bin')).toHaveLength(1)
  })

  it('fails on a checksum mismatch and deletes the bad file', async () => {
    const { m, root } = manager([manifest('bad', 'bad.bin', bad, { sha256: sha(model) })])
    await expect(m.ensure('bad')).rejects.toThrow(new ModelInstallError('Checksum mismatch for bad.bin'))
    expect(m.state('bad')).toEqual({ kind: 'failed', message: 'Checksum mismatch for bad.bin' })
    expect(existsSync(path.join(root, '.staging', 'bad', 'files', 'bad.bin.part'))).toBe(false)
    expect(m.isInstalled('bad')).toBe(false)
  })

  it('fails on a size mismatch', async () => {
    const { m } = manager([manifest('size', 'bad.bin', bad, { bytes: 999 })])
    await expect(m.ensure('size')).rejects.toThrow(/expected 999 bytes|Size mismatch|416/)
  })

  it('resumes an interrupted download with a Range request', async () => {
    flakyFailures = 1
    const { m } = manager([manifest('flaky', 'flaky.bin', model)])
    const dir = await m.ensure('flaky')
    expect(await sha256File(path.join(dir, 'flaky.bin'))).toBe(sha(model))
    const flaky = requests.filter((r) => r.url === '/flaky.bin')
    expect(flaky).toHaveLength(2)
    expect(flaky[0].range).toBeUndefined()
    expect(flaky[1].range).toMatch(/^bytes=\d+-$/)
    expect(Number(/\d+/.exec(flaky[1].range!)![0])).toBeGreaterThan(0)
  })

  it('reports HTTP errors without retrying client errors, and retries server errors', async () => {
    const { m } = manager([manifest('missing', 'missing.bin', model), manifest('e500', 'error500.bin', model)])
    await expect(m.ensure('missing')).rejects.toThrow('HTTP 404 downloading missing.bin')
    expect(requests.filter((r) => r.url === '/missing.bin')).toHaveLength(1)
    await expect(m.ensure('e500')).rejects.toThrow('HTTP 500 downloading error500.bin')
    expect(requests.filter((r) => r.url === '/error500.bin')).toHaveLength(3)
    expect(m.state('missing').kind).toBe('failed')
  })

  it('extracts tar.gz packages', async () => {
    const { m } = manager([manifest('pkg', 'pkg.tar.gz', tarball, { extract: 'tar.gz' })])
    const dir = await m.ensure('pkg')
    expect(readFileSync(path.join(dir, 'whisper-bin-fake', 'whisper-cli'), 'utf8')).toContain('fake')
    expect(existsSync(path.join(dir, 'pkg.tar.gz'))).toBe(false)
  })

  it('cancel keeps the partial file and the next ensure resumes it', async () => {
    const { m, root } = manager([manifest('slow', 'slow.bin', model)])
    const pending = m.ensure('slow')
    await expect.poll(() => (m.state('slow') as { fraction?: number }).fraction ?? 0).toBeGreaterThan(0)
    m.cancel('slow')
    await expect(pending).rejects.toThrow(/Abort/)
    expect(m.state('slow')).toEqual({ kind: 'notInstalled' })
    const part = path.join(root, '.staging', 'slow', 'files', 'slow.bin.part')
    expect((await fs.stat(part)).size).toBe(100_000)
    slowGate = null
    const resumed = m.ensure('slow')
    const dir = await resumed
    expect(await sha256File(path.join(dir, 'slow.bin'))).toBe(sha(model))
    expect(requests.filter((r) => r.url === '/slow.bin').at(-1)?.range).toBe('bytes=100000-')
  })

  it('one caller aborting does not cancel the download for the others', async () => {
    const { m } = manager([manifest('slow2', 'slow.bin', model)])
    const ac = new AbortController()
    const a = m.ensure('slow2', { signal: ac.signal })
    const b = m.ensure('slow2')
    await expect.poll(() => slowGate !== null).toBe(true)
    ac.abort()
    await expect(a).rejects.toThrow(/Abort/)
    slowGate!()
    slowGate = null
    expect(await b).toContain('slow2')
  })

  it('remove deletes the install, and a changed pin counts as not installed', async () => {
    const { m, root } = manager([manifest('rm', 'model.bin', model)])
    await m.ensure('rm')
    await m.remove('rm')
    expect(m.isInstalled('rm')).toBe(false)
    expect(m.state('rm')).toEqual({ kind: 'notInstalled' })
    const changed = new ModelManager({ root, manifests: { rm: manifest('rm', 'model.bin', model) } })
    await changed.ensure('rm')
    const repinned = new ModelManager({ root, manifests: { rm: { ...manifest('rm', 'model.bin', model), files: [{ ...manifest('rm', 'model.bin', model).files[0], sha256: 'f'.repeat(64) }] } } })
    expect(repinned.isInstalled('rm')).toBe(false)
  })
})
