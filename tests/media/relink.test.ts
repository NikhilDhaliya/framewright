/** Brief B: offline detection, Relink / Relink Folder matching, clipboard file lists. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ clipboard: {} }))
import { fileUriPaths } from '../../src/main/media/clipboard'
import { extensionType, fileIndex, matchOffline, offlineReport, relinkPatch, relinkTypeMismatch } from '../../src/main/media/relink'
import { asset } from '../captions/fixtures'

const resolve = (e: { source: { external?: { absolutePath: string } } | { project: { relativePath: string } } }) =>
  'external' in e.source ? e.source.external!.absolutePath : null

describe('offlineReport', () => {
  it('splits missing and unreadable files and skips in-flight generations', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relink-'))
    const ok = path.join(dir, 'ok.mp4')
    const bad = path.join(dir, 'bad.mp4')
    writeFileSync(ok, 'x')
    writeFileSync(bad, 'x')
    const entries = [
      asset('a', { source: { external: { absolutePath: ok } } }),
      asset('b', { source: { external: { absolutePath: bad } } }),
      asset('c', { source: { external: { absolutePath: path.join(dir, 'gone.mp4') } } }),
      asset('d', { source: { external: { absolutePath: path.join(dir, 'gen.mp4') } }, generationStatus: 'generating' }),
      asset('e', { source: { external: { absolutePath: path.join(dir, 'failed.mp4') } }, generationStatus: 'failed: x' }),
    ]
    const r = await offlineReport(entries, resolve as never, async (f) => {
      if (f === bad) throw new Error('unreadable')
    })
    expect(r).toEqual({ missing: ['c', 'e'], unprocessable: ['b'] })
  })
})

describe('Relink Folder matching', () => {
  it('indexes files recursively by lowercased name, first match wins', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relink-'))
    mkdirSync(path.join(dir, 'a'))
    mkdirSync(path.join(dir, 'b'))
    writeFileSync(path.join(dir, 'a', 'Clip.MP4'), 'x')
    writeFileSync(path.join(dir, 'b', 'clip.mp4'), 'x')
    writeFileSync(path.join(dir, 'b', 'other.wav'), 'x')
    const idx = await fileIndex(dir)
    expect(idx.get('clip.mp4')).toBe(path.join(dir, 'a', 'Clip.MP4'))
    expect(idx.size).toBe(2)
    const entries = [
      asset('x', { source: { external: { absolutePath: '/old/place/CLIP.mp4' } } }),
      asset('y', { source: { external: { absolutePath: '/old/place/other.wav' } }, type: 'audio' }),
      asset('z', { source: { external: { absolutePath: '/old/place/none.mov' } } }),
    ]
    const m = matchOffline(entries, new Set(['x', 'z']), resolve as never, idx)
    expect([...m]).toEqual([['x', path.join(dir, 'a', 'Clip.MP4')]])
    expect((await fileIndex(dir, 1)).size).toBe(1)
  })

  it('builds the manifest patch and the Mac type-mismatch message', () => {
    const src = { external: { absolutePath: '/n/x.mp4' } }
    expect(relinkPatch(src, null)).toEqual({ source: src })
    expect(relinkPatch(src, { type: 'video', duration: 4, hasAudio: false, hasVideo: true, width: 640, height: 360, fps: 25 })).toEqual({
      source: src, duration: 4, hasAudio: false, sourceWidth: 640, sourceHeight: 360, sourceFPS: 25,
    })
    expect(extensionType('/a/b.WAV')).toBe('audio')
    expect(extensionType('/a/b.xyz')).toBeNull()
    expect(relinkTypeMismatch('/a/song.wav', 'video', 'audio')).toBe('Can\'t relink "song.wav". Required media type: Video. Selected media type: Audio.')
  })
})

describe('clipboard file lists', () => {
  it('reads file:// URIs from uri-list and gnome-copied-files', () => {
    expect(fileUriPaths('file:///tmp/a%20b.mp4\r\nfile:///tmp/c.png\n')).toEqual(['/tmp/a b.mp4', '/tmp/c.png'])
    expect(fileUriPaths('copy\nfile:///home/u/x.mov')).toEqual(['/home/u/x.mov'])
    expect(fileUriPaths('https://example.com/x.mp4\n# comment')).toEqual([])
  })
})
