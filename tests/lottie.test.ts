/** Lottie recognition, metadata, dotLottie extraction and frame mapping (spec 07 §4). */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isLottieFile, lottieFileMeta, lottieResponse } from '../src/main/media/lottie'
import { probeFile } from '../src/main/media/probe'
import {
  extractDotLottie,
  LOTTIE_SNIFF_BYTES,
  lottieFrameCount,
  lottieFrameIndex,
  lottieMediaUrl,
  lottieMeta,
  lottieRenderSize,
  lottieSampleIndices,
  lottieThumbnailSize,
  parseLottie,
  sniffLottie,
} from '../src/shared/lottie'
import { dotLottie, rgbAnimation } from './lottieFixtures'

const enc = (s: string) => new TextEncoder().encode(s)
let dir = ''
const file = async (name: string, data: string | Uint8Array) => {
  const p = path.join(dir, name)
  await fs.writeFile(p, data)
  return p
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-lottie-test-'))
})
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('isLottie (LottieVideoGenerator.swift:27-41)', () => {
  const ok = '{"v":"5.7.4","fr":30,"ip":0,"op":30,"w":200,"h":100,"layers":[]}'

  it('accepts a Bodymovin comp with the five signature keys, after JSON whitespace', () => {
    expect(sniffLottie('json', enc(ok))).toBe(true)
    expect(sniffLottie('JSON', enc(` \t\r\n${ok}`))).toBe(true)
    expect(sniffLottie('json', enc('{"layers" :[], "v"\n: "5", "w":1,"h":1,"op":\t2}'))).toBe(true)
  })

  it('rejects other JSON: wrong first byte, BOM, missing keys, keys only as values', () => {
    expect(sniffLottie('json', enc(`[${ok}]`))).toBe(false)
    expect(sniffLottie('json', new Uint8Array([0xef, 0xbb, 0xbf, ...enc(ok)]))).toBe(false)
    expect(sniffLottie('json', enc('{"v":"5","w":1,"h":1,"op":2}'))).toBe(false)
    expect(sniffLottie('json', enc('{"layers":[],"v":"5","w":1,"h":1,"name":"op"}'))).toBe(false)
    expect(sniffLottie('json', enc(''))).toBe(false)
    expect(sniffLottie('json', enc('   '))).toBe(false)
  })

  it('only looks at the first 256 KiB', () => {
    const pad = ' '.repeat(LOTTIE_SNIFF_BYTES)
    expect(sniffLottie('json', enc(`{"layers":[],"v":"5","w":1,"h":1,"pad":"${pad}","op":2}`))).toBe(false)
    expect(sniffLottie('json', enc(`${pad}${ok}`))).toBe(false)
    expect(sniffLottie('json', enc(`{"layers":[],"v":"5","w":1,"h":1,"op":2,"pad":"${pad}"}`))).toBe(true)
  })

  it('.lottie only needs the ZIP magic', () => {
    expect(sniffLottie('lottie', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe(true)
    expect(sniffLottie('Lottie', new Uint8Array([0x50, 0x4b, 0x03]))).toBe(false)
    expect(sniffLottie('lottie', enc(ok))).toBe(false)
  })

  it('isLottieFile reads the file (false when unreadable)', async () => {
    expect(await isLottieFile(await file('a.json', JSON.stringify(rgbAnimation())))).toBe(true)
    expect(await isLottieFile(await file('pkg.json', '{"name":"x","version":"1.0.0"}'))).toBe(false)
    expect(await isLottieFile(await file('a.lottie', dotLottie(rgbAnimation())))).toBe(true)
    expect(await isLottieFile(await file('b.lottie', JSON.stringify(rgbAnimation())))).toBe(false)
    expect(await isLottieFile(path.join(dir, 'missing.json'))).toBe(false)
  })
})

describe('metadata (LottieVideoGenerator.metadata)', () => {
  it('maps w, h, fr, ip, op to size, fps, frameCount = max(1, round(op − ip)) and (op − ip)/fr', () => {
    expect(lottieMeta(rgbAnimation())).toEqual({ width: 200, height: 100, fps: 30, ip: 0, op: 30, frameCount: 30, duration: 1 })
    expect(lottieMeta(rgbAnimation({ ip: 10, op: 70, fr: 24 }))).toMatchObject({ frameCount: 60, duration: 2.5 })
    expect(lottieFrameCount(0, 10.5)).toBe(11)
    expect(lottieFrameCount(0, 10.49)).toBe(10)
    expect(lottieFrameCount(5, 5)).toBe(1)
    expect(lottieFrameCount(5, 5.2)).toBe(1)
  })

  it('throws "not a Lottie animation." without a usable comp', () => {
    expect(() => lottieMeta({ w: 1, h: 1, fr: 30, ip: 0, op: 1 })).toThrow('not a Lottie animation.')
    expect(() => lottieMeta(rgbAnimation({ fr: 0 }))).toThrow('not a Lottie animation.')
    expect(() => lottieMeta(rgbAnimation({ w: '200' }))).toThrow('not a Lottie animation.')
    expect(() => parseLottie('json', enc('{"layers": ['))).toThrow('not a Lottie animation.')
  })

  it('lottieFileMeta reads .json and the first manifest animation of a .lottie', async () => {
    expect(await lottieFileMeta(await file('m.json', JSON.stringify(rgbAnimation({ fr: 25, op: 50 }))))).toMatchObject({ width: 200, height: 100, fps: 25, frameCount: 50, duration: 2 })
    expect(await lottieFileMeta(await file('m.lottie', dotLottie(rgbAnimation({ w: 640, h: 360 }))))).toMatchObject({ width: 640, height: 360, frameCount: 30 })
    expect(await lottieFileMeta(await file('m2.lottie', dotLottie(rgbAnimation({ w: 320, h: 240 }), {}, 'v2')))).toMatchObject({ width: 320, height: 240 })
    await expect(lottieFileMeta(await file('bad.lottie', zipSync({ 'readme.txt': strToU8('hi') })))).rejects.toThrow('not a Lottie animation.')
  })

  it('probe reports a lottie asset: comp size, fr and (op − ip)/fr seconds', async () => {
    const p = await probeFile(await file('probe.json', JSON.stringify(rgbAnimation({ w: 512.6, h: 288, fr: 60, ip: 0, op: 90 }))))
    expect(p).toMatchObject({ type: 'lottie', width: 512, height: 288, fps: 60, duration: 1.5, hasAudio: false, hasVideo: true })
    const z = await probeFile(await file('probe.lottie', dotLottie(rgbAnimation())))
    expect(z).toMatchObject({ type: 'lottie', width: 200, height: 100, fps: 30, duration: 1 })
  })
})

describe('dotLottie', () => {
  it('inlines archive images into the animation as data URIs (e: 1)', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const anim = rgbAnimation({ assets: [{ id: 'img_0', w: 10, h: 10, u: '/images/', p: 'img_0.png', e: 0 }, { id: 'pre', layers: [] }] })
    const out = extractDotLottie(dotLottie(anim, { 'img_0.png': png }))
    expect(out.assets?.[0]).toMatchObject({ id: 'img_0', u: '', e: 1, p: `data:image/png;base64,${Buffer.from(png).toString('base64')}` })
    expect(out.assets?.[1]).toEqual({ id: 'pre', layers: [] })
    const v2 = extractDotLottie(dotLottie(rgbAnimation({ assets: [{ id: 'i', u: 'i/', p: 'pic.jpg', e: 0 }] }), { 'pic.jpg': png }, 'v2'))
    expect(v2.assets?.[0].p).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('falls back to the first animation file without a manifest; rejects non-zips', () => {
    const zip = zipSync({ 'animations/b.json': strToU8(JSON.stringify(rgbAnimation({ w: 2 }))), 'animations/a.json': strToU8(JSON.stringify(rgbAnimation({ w: 1 }))) })
    expect(extractDotLottie(zip).w).toBe(1)
    expect(() => extractDotLottie(enc('not a zip'))).toThrow('not a Lottie animation.')
  })

  it('palmier-media://lottie/<path> serves the animation JSON (archives unzipped) and 404/422 otherwise', async () => {
    const r = await lottieResponse(await file('served.lottie', dotLottie(rgbAnimation({ nm: 'served' }))))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/json')
    expect(((await r.json()) as { nm: string }).nm).toBe('served')
    expect((await lottieResponse(path.join(dir, 'nope.json'))).status).toBe(404)
    expect((await lottieResponse(await file('junk.json', '{"layers": 1'))).status).toBe(422)
    expect(lottieMediaUrl('/a b/c#d.json')).toBe('palmier-media://lottie/a%20b/c%23d.json')
  })
})

describe('frame mapping (spec 07 §4.1)', () => {
  it('lottieFrameIndex = min(frameCount − 1, max(0, floor(srcSec · fps + 1e-6))), last frame held', () => {
    expect(lottieFrameIndex(0, 30, 30)).toBe(0)
    expect(lottieFrameIndex(0.5, 30, 30)).toBe(15)
    expect(lottieFrameIndex(10 / 30, 30, 30)).toBe(10)
    expect(lottieFrameIndex(29 / 30, 30, 30)).toBe(29)
    expect(lottieFrameIndex(1, 30, 30)).toBe(29)
    expect(lottieFrameIndex(1800, 30, 30)).toBe(29)
    expect(lottieFrameIndex(-1, 30, 30)).toBe(0)
    // Timeline 24 fps showing a 60 fps animation: frame f → srcSec f/24.
    expect(lottieFrameIndex(5 / 24, 60, 120)).toBe(12)
    // fps below 1 counts as 1 (the bake's max(1, fr)).
    expect(lottieFrameIndex(2.5, 0.5, 10)).toBe(2)
    expect(lottieFrameIndex(NaN, 30, 30)).toBe(0)
  })

  it('render size: longest side ≤ 4096, each side even (min 2)', () => {
    expect(lottieRenderSize(200, 100)).toEqual({ width: 200, height: 100 })
    expect(lottieRenderSize(501, 301)).toEqual({ width: 500, height: 300 })
    expect(lottieRenderSize(8192, 4096)).toEqual({ width: 4096, height: 2048 })
    expect(lottieRenderSize(1, 1)).toEqual({ width: 2, height: 2 })
  })

  it('thumbnail / inspect size: fit within 512 (never upscaled), clamped and even', () => {
    expect(lottieThumbnailSize(1920, 1080)).toEqual({ width: 512, height: 288 })
    expect(lottieThumbnailSize(1080, 1920)).toEqual({ width: 288, height: 512 })
    expect(lottieThumbnailSize(200, 100)).toEqual({ width: 200, height: 100 })
    expect(lottieThumbnailSize(1000, 333)).toEqual({ width: 512, height: 170 })
  })

  it('sampleFrames indices: n = max(1, min(count, frameCount)), round((frameCount − 1)·i/(n − 1))', () => {
    expect(lottieSampleIndices(30, 6)).toEqual([0, 6, 12, 17, 23, 29])
    expect(lottieSampleIndices(30, 1)).toEqual([0])
    expect(lottieSampleIndices(3, 12)).toEqual([0, 1, 2])
    expect(lottieSampleIndices(1, 6)).toEqual([0])
    expect(lottieSampleIndices(11, 3)).toEqual([0, 5, 10])
  })
})
