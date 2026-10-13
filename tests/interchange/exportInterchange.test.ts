// End-to-end: exportInterchange on a temp ProjectSession with ffmpeg-generated media (XDG_* → temp dirs), plus the
// Mac's export-service and unwritable-destination tests.
import { TEST_ROOT } from './env'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultTextStyle, newClip, newId, newTimeline, newTrack, type MediaManifestEntry, type Timeline } from '../../src/core/model'
import { totalFrames } from '../../src/core/timeline'
import { exportInterchange } from '../../src/main/interchange/exportInterchange'
import { resolveFontInfo } from '../../src/main/interchange/fontInfo'
import { probeFile } from '../../src/main/media/probe'
import { ProjectSession } from '../../src/main/project/session'
import { assertWellFormed, attr, childText, findAll } from './wellFormed'

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const root = path.join(TEST_ROOT, 'e2e')
const mediaDir = path.join(root, 'Media – Ünïcode & co')
const outDir = path.join(root, 'out')
const camName = 'cam #1 (take 2) Café.mov'
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })

let session: ProjectSession
let main: Timeline
const ids = { cam: newId(), music: newId(), still: newId(), link: newId(), gone: newId() }

async function entryFor(id: string, file: string): Promise<MediaManifestEntry> {
  const p = await probeFile(file)
  return {
    id,
    name: path.basename(file, path.extname(file)),
    type: p.type,
    source: { external: { absolutePath: file } },
    duration: p.duration,
    ...(p.width ? { sourceWidth: p.width, sourceHeight: p.height } : {}),
    ...(p.fps ? { sourceFPS: p.fps } : {}),
    hasAudio: p.hasAudio,
  }
}

beforeAll(async () => {
  if (!hasFfmpeg) return
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })
  const cam = path.join(mediaDir, camName)
  ff('-f', 'lavfi', '-i', 'testsrc=d=2:r=30000/1001:s=320x180', '-f', 'lavfi', '-i', 'sine=d=2:r=48000', '-timecode', '01:00:00;00', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', cam)
  const music = path.join(mediaDir, 'music.wav')
  ff('-f', 'lavfi', '-i', 'sine=d=3:r=48000', '-write_bext', '1', '-metadata', 'time_reference=172800000', music)
  const still = path.join(mediaDir, 'still.png')
  ff('-f', 'lavfi', '-i', 'testsrc=s=640x480', '-frames:v', '1', still)
  const link = path.join(mediaDir, 'link.mov')
  fs.symlinkSync(cam, link)

  const entries = [
    await entryFor(ids.cam, cam),
    await entryFor(ids.music, music),
    await entryFor(ids.still, still),
    await entryFor(ids.link, link),
    { id: ids.gone, name: 'gone', type: 'video' as const, source: { external: { absolutePath: path.join(mediaDir, 'gone.mov') } }, duration: 1 },
  ]

  const nested = newTimeline({
    name: 'Nested & Co',
    tracks: [
      newTrack('video', { clips: [newClip({ mediaRef: '', mediaType: 'text', sourceClipType: 'text', startFrame: 0, durationFrames: 30, textContent: 'Lower third', textStyle: { ...defaultTextStyle(), fontName: 'Poppins-Bold', isBold: true } })] }),
      newTrack('video', { clips: [newClip({ mediaRef: ids.link, startFrame: 0, durationFrames: 45, trimStartFrame: 3 })] }),
    ],
  })
  const vLink = newId()
  main = newTimeline({
    name: 'Main',
    tracks: [
      newTrack('video', {
        clips: [
          newClip({ mediaRef: '', mediaType: 'text', sourceClipType: 'text', startFrame: 10, durationFrames: 20, textContent: 'Title', opacity: 0.5 }),
          newClip({ mediaRef: ids.gone, startFrame: 40, durationFrames: 10 }),
        ],
      }),
      newTrack('video', {
        clips: [
          newClip({ mediaRef: ids.cam, startFrame: 0, durationFrames: 40, trimStartFrame: 5, linkGroupId: vLink, fadeInFrames: 6 }),
          newClip({ mediaRef: ids.still, mediaType: 'image', sourceClipType: 'image', startFrame: 40, durationFrames: 30, transform: { ...newClip({ mediaRef: '', startFrame: 0, durationFrames: 1 }).transform, centerX: 0.25, width: 0.5, height: 0.5 } }),
          newClip({ mediaRef: nested.id, mediaType: 'sequence', sourceClipType: 'sequence', startFrame: 70, durationFrames: totalFrames(nested) }),
        ],
      }),
      newTrack('audio', {
        clips: [
          newClip({ mediaRef: ids.cam, mediaType: 'audio', sourceClipType: 'audio', startFrame: 0, durationFrames: 40, trimStartFrame: 5, linkGroupId: vLink, volume: 0.5 }),
          newClip({ mediaRef: ids.music, mediaType: 'audio', sourceClipType: 'audio', startFrame: 40, durationFrames: 60, speed: 2, volumeTrack: { keyframes: [{ frame: 0, value: 0, interpolationOut: 'linear' }, { frame: 30, value: -12, interpolationOut: 'linear' }] } }),
        ],
      }),
    ],
  })
  session = await ProjectSession.create(path.join(root, 'Interchange.palmier'), {
    file: { timelines: [main, nested], activeTimelineId: main.id, openTimelineIds: [main.id] },
    manifest: { version: 2, entries, folders: [] },
  })
}, 60_000)

afterAll(() => {
  session?.removeAllListeners()
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

const leftovers = () => fs.readdirSync(outDir).filter((f) => f.endsWith('.tmp'))

describe.skipIf(!hasFfmpeg)('exportInterchange (end-to-end)', () => {
  it('writes a well-formed XMEML with Foundation-style pathurls, embedded timecodes, links and nests', async () => {
    const out = path.join(outDir, 'Main.xml')
    const res = await exportInterchange(session, { timelineId: main.id, format: 'xml', outputPath: out })
    expect(res.missingMediaRefs).toEqual([ids.gone])
    const xml = fs.readFileSync(out, 'utf8')
    expect(res.bytes).toBe(Buffer.byteLength(xml))
    expect(leftovers()).toEqual([])
    const doc = assertWellFormed(xml)

    const encodedDir = 'Media%20%E2%80%93%20%C3%9Cn%C3%AFcode%20&amp;%20co'
    expect(xml).toContain(`<pathurl>file://localhost//${root.split('/').map(encodeURIComponent).join('/')}/${encodedDir}/cam%20%231%20(take%202)%20Caf%C3%A9.mov</pathurl>`)
    expect(xml).toContain(`<name>${camName}</name>`)

    const files = findAll(doc, 'file').filter((f) => f.children.length)
    const camVideo = files.find((f) => attr(f, 'id') === `file-${ids.cam}-video`)!
    const tc = camVideo.children.find((c) => c.name === 'timecode')!
    expect(childText(tc, 'string')).toBe('01;00;00;00')
    expect(childText(tc, 'displayformat')).toBe('DF')
    const music = files.find((f) => attr(f, 'id') === `file-${ids.music}-audio`)!
    expect(childText(music.children.find((c) => c.name === 'timecode')!, 'string')).toBe('01:00:00:00')

    expect(findAll(doc, 'link').length).toBe(4)
    expect(xml).toContain('<name>Nested &amp; Co</name>')
    expect(xml).toContain('<sequence id="sequence-2">')
    expect(xml).toContain('<effectid>timeremap</effectid>')
    expect(xml).toContain('<effectid>audiolevels</effectid>')
    expect(xml).toContain('<alignment>start-black</alignment>')
    expect(xml).not.toContain(ids.gone)
    expect(xml).not.toContain('Title')
  })

  it('writes a well-formed FCPXML: timecode starts, merged symlink asset, collapsed pair, titles with resolved fonts', async () => {
    const out = path.join(outDir, 'Main.fcpxml')
    await exportInterchange(session, { timelineId: main.id, format: 'fcpxml', outputPath: out, fcpxmlVersion: '1.13', fcpxmlTarget: 'resolve' })
    const xml = fs.readFileSync(out, 'utf8')
    const doc = assertWellFormed(xml)
    expect(attr(doc, 'version')).toBe('1.13')

    const assets = findAll(doc, 'asset')
    const cam = assets.find((a) => attr(a, 'name') === camName)!
    expect(attr(cam, 'start')).toBe('8999991/2500s')
    expect(attr(cam, 'hasAudio')).toBe('1')
    // The symlink resolves to the same file, so it shares the camera asset.
    expect(assets.filter((a) => attr(a, 'name') === 'link.mov')).toEqual([])
    expect(attr(assets.find((a) => attr(a, 'name') === 'music.wav')!, 'start')).toBe('3600s')
    const src = attr(findAll(cam, 'media-rep')[0], 'src')!
    expect(src).toMatch(/\/Media%20%E2%80%93%20%C3%9Cn%C3%AFcode%20%26%20co\/cam%20%231%20%28take%202%29%20Caf%C3%A9\.mov$/)

    const camClips = findAll(doc, 'asset-clip').filter((c) => attr(c, 'name') === camName)
    expect(camClips.map((c) => attr(c, 'lane'))).toContain('1')
    expect(xml).not.toContain('lane="-1" offset="0s"')
    expect(xml).toContain('<adjust-volume amount="-6.0206"/>')
    expect(findAll(doc, 'video').map((v) => attr(v, 'name'))).toEqual(['still.png'])
    expect(xml).toContain('<media id="nest1" name="Nested &amp; Co">')

    const styles = findAll(doc, 'text-style').filter((s) => attr(s, 'font'))
    expect(styles.map((s) => [attr(s, 'font'), attr(s, 'fontFace')])).toEqual([
      ['Poppins', 'Bold'],
      [expect.any(String), 'Regular'],
    ])
    expect(leftovers()).toEqual([])
  })

  it('mac (XMLExporterTests.xmlExportThroughExportServiceWritesFileWithoutError + FCPXML twin): export resolves and the file exists', async () => {
    for (const format of ['xml', 'fcpxml'] as const) {
      const out = path.join(outDir, `svc.${format}`)
      await expect(exportInterchange(session, { timelineId: main.id, format, outputPath: out })).resolves.toMatchObject({ outputPath: out })
      expect(fs.existsSync(out)).toBe(true)
    }
  })

  it('mac (XMLExporterTests.exportThrowsWhenDestinationIsUnwritable): surfaces the failure and writes nothing', async () => {
    const unwritable = path.join(outDir, 'does-not-exist', 'out.xml')
    await expect(exportInterchange(session, { timelineId: main.id, format: 'xml', outputPath: unwritable })).rejects.toThrow()
    expect(fs.existsSync(unwritable)).toBe(false)
  })

  it('replaces an existing destination atomically and honours cancellation before writing', async () => {
    const out = path.join(outDir, 'replace.fcpxml')
    fs.writeFileSync(out, 'old')
    await exportInterchange(session, { timelineId: main.id, format: 'fcpxml', outputPath: out })
    expect(fs.readFileSync(out, 'utf8').startsWith('<?xml')).toBe(true)

    const ac = new AbortController()
    ac.abort()
    const cancelled = path.join(outDir, 'cancelled.xml')
    await expect(exportInterchange(session, { timelineId: main.id, format: 'xml', outputPath: cancelled, signal: ac.signal })).rejects.toThrow()
    expect(fs.existsSync(cancelled)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('refuses an unknown timeline', async () => {
    await expect(exportInterchange(session, { timelineId: 'nope', format: 'xml', outputPath: path.join(outDir, 'x.xml') })).rejects.toThrow(/no longer exists/)
  })
})

describe('font resolution', () => {
  it('maps PostScript and family names through fc-match, with traits from the matched face', async () => {
    const calls: string[][] = []
    const fake = async (args: string[]) => {
      calls.push(args)
      const pattern = args[args.length - 1]
      if (pattern === ':postscriptname=Roboto\\-Light') return 'Roboto\nRoboto-Light\n50'
      if (pattern.startsWith(':postscriptname=')) return 'DejaVu Sans\nDejaVuSans\n80'
      if (pattern === ':family=Roboto:weight=50:slant=0') return 'Roboto\nLight\n50'
      if (pattern === ':family=Roboto:weight=200:slant=100') return 'Roboto\nBold Italic\n200'
      if (pattern === ':family=Helvetica') return 'Nimbus Sans\n80'
      return 'DejaVu Sans\nBook\n80'
    }
    expect(await resolveFontInfo({ fontName: 'Roboto-Light', isBold: false, isItalic: false }, fake)).toEqual({ family: 'Roboto', face: 'Light', bold: false, italic: false })
    expect(await resolveFontInfo({ fontName: 'Roboto-Light', isBold: true, isItalic: true }, fake)).toEqual({ family: 'Roboto', face: 'Bold Italic', bold: true, italic: true })
    expect(await resolveFontInfo({ fontName: 'Helvetica', isBold: false, isItalic: false }, fake)).toBeUndefined()
    expect(await resolveFontInfo({ fontName: 'Geist Mono', isBold: true, isItalic: false }, fake)).toEqual({ family: 'Geist Mono', face: 'Bold', bold: true, italic: false })
    expect(calls.some((a) => a.at(-1)?.includes('Geist'))).toBe(false)
  })

  it('degrades to undefined when fc-match is unavailable', async () => {
    const broken = async () => {
      throw new Error('spawn fc-match ENOENT')
    }
    expect(await resolveFontInfo({ fontName: 'Some Font', isBold: false, isItalic: false }, broken)).toBeUndefined()
  })
})
