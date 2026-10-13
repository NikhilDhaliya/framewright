import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { newClip, newProjectFile, newTrack, type MediaManifestEntry } from '../../src/core/model'
import { CAPTURE_ERRORS, lastPtsTime, pngSize, sourceFrameArgs, sourceFrameRequest } from '../../src/main/extras/captureFrame'
import { clipRangeArgs, extractAudioArgs, seconds, stretchFactor } from '../../src/main/extras/ffmpegArgs'
import { mattePng, parseHex } from '../../src/main/extras/matte'
import { averageRgb, keyHueFromPixels, patchRect, rgbToHsb } from '../../src/renderer/extras/chroma'
import {
  audioClipForExtraction,
  canExtractAudio,
  canSaveClipAsMedia,
  captureToast,
  matteEven,
  matteFit,
  matteHex,
  matteName,
  mattePixelSize,
  parseMatteAspect,
} from '../../src/shared/extras'

describe('ffmpeg args (07 §6.3)', () => {
  const base = { source: '/s.mov', output: '/o.mp4', fps: 30, trimStartFrame: 45, sourceFramesConsumed: 90, durationFrames: 90, speed: 1, mediaType: 'video' as const, sampleRate: 48000, hasAudio: true }

  it('video at speed 1: trim range, mapped streams, H.264 CRF 18 + AAC 256k, faststart', () => {
    expect(clipRangeArgs(base)).toEqual([
      '-y', '-ss', '1.5', '-t', '3', '-i', '/s.mov', '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '/o.mp4',
    ])
  })

  it('speed 2 time-stretches video and pitch-shifts audio by the frame ratio', () => {
    const a = clipRangeArgs({ ...base, speed: 2, sourceFramesConsumed: 120, durationFrames: 60 })
    expect(a.slice(a.indexOf('-vf'), a.indexOf('-vf') + 2)).toEqual(['-vf', 'setpts=PTS*0.5,scale=trunc(iw/2)*2:trunc(ih/2)*2'])
    expect(a.slice(a.indexOf('-af'), a.indexOf('-af') + 2)).toEqual(['-af', 'asetrate=96000,aresample=48000'])
    expect(a.slice(a.indexOf('-t'), a.indexOf('-t') + 2)).toEqual(['-t', '4'])
    expect(stretchFactor({ speed: 0.5, sourceFramesConsumed: 30, durationFrames: 60 })).toBe(2)
  })

  it('video without audio gets no audio filter; audio-only drops video', () => {
    expect(clipRangeArgs({ ...base, speed: 2, durationFrames: 45, hasAudio: false, sampleRate: undefined })).not.toContain('-af')
    expect(clipRangeArgs({ ...base, mediaType: 'audio', output: '/o.m4a' })).toEqual(['-y', '-ss', '1.5', '-t', '3', '-i', '/s.mov', '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '256k', '/o.m4a'])
    expect(clipRangeArgs({ ...base, mediaType: 'audio', speed: 1.5, sourceFramesConsumed: 90, durationFrames: 60 })).toContain('asetrate=72000,aresample=48000')
  })

  it('extract audio copies AAC and re-encodes anything else', () => {
    expect(extractAudioArgs('/a.mp4', '/o.m4a', 'aac')).toEqual(['-y', '-i', '/a.mp4', '-map', '0:a:0', '-vn', '-c:a', 'copy', '/o.m4a'])
    expect(extractAudioArgs('/a.mov', '/o.m4a', 'pcm_s16le')).toEqual(['-y', '-i', '/a.mov', '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '256k', '/o.m4a'])
  })

  it('seconds() prints clean decimals', () => {
    expect(seconds(0)).toBe('0')
    expect(seconds(1 / 3)).toBe('0.333333')
    expect(seconds(10)).toBe('10')
    expect(seconds(1001 / 30000)).toBe('0.033367')
  })
})

describe('menu conditions (07 §6.3)', () => {
  const video: MediaManifestEntry = { id: 'V', name: 'Talk', type: 'video', source: { external: { absolutePath: '/v.mp4' } }, duration: 10, hasAudio: true }
  const silent: MediaManifestEntry = { ...video, id: 'S', hasAudio: false }
  const tl = () => {
    const t = newProjectFile().timelines[0]
    t.tracks = [newTrack('video'), newTrack('audio')]
    return t
  }

  it('extract audio needs a video with audio, not generating, online', () => {
    expect(canExtractAudio(video)).toBe(true)
    expect(canExtractAudio(silent)).toBe(false)
    expect(canExtractAudio({ ...video, generationStatus: 'generating' })).toBe(false)
    expect(canExtractAudio({ ...video, generationStatus: 'failed: x' })).toBe(true)
    expect(canExtractAudio(video, () => true)).toBe(false)
    expect(canExtractAudio({ ...video, type: 'audio' })).toBe(false)
  })

  it('save as media: video/audio clips only', () => {
    expect(canSaveClipAsMedia(newClip({ mediaRef: 'V', startFrame: 0, durationFrames: 10 }))).toBe(true)
    expect(canSaveClipAsMedia(newClip({ mediaRef: 'V', startFrame: 0, durationFrames: 10, mediaType: 'audio' }))).toBe(true)
    expect(canSaveClipAsMedia(newClip({ mediaRef: 'V', startFrame: 0, durationFrames: 10, mediaType: 'image' }))).toBe(false)
  })

  it('save as audio prefers the linked audio partner, else the video itself', () => {
    const t = tl()
    const v = newClip({ mediaRef: 'V', startFrame: 0, durationFrames: 30, linkGroupId: 'L' })
    const a = newClip({ mediaRef: 'V', startFrame: 0, durationFrames: 30, linkGroupId: 'L', mediaType: 'audio', sourceClipType: 'video' })
    t.tracks[0].clips.push(v)
    t.tracks[1].clips.push(a)
    expect(audioClipForExtraction(t, [video], v.id)?.id).toBe(a.id)
    expect(audioClipForExtraction(t, [video], a.id)?.id).toBe(a.id)
    expect(audioClipForExtraction(t, [video], v.id, () => true)).toBeNull()
    const lone = newClip({ mediaRef: 'V', startFrame: 40, durationFrames: 30 })
    const mute = newClip({ mediaRef: 'S', startFrame: 80, durationFrames: 30 })
    const multicam = newClip({ mediaRef: 'V', startFrame: 120, durationFrames: 30, multicamGroupId: 'M' })
    const nested = newClip({ mediaRef: 'T', startFrame: 160, durationFrames: 30, sourceClipType: 'sequence' })
    t.tracks[0].clips.push(lone, mute, multicam, nested)
    expect(audioClipForExtraction(t, [video, silent], lone.id)?.id).toBe(lone.id)
    expect(audioClipForExtraction(t, [video, silent], mute.id)).toBeNull()
    expect(audioClipForExtraction(t, [video, silent], multicam.id)).toBeNull()
    expect(audioClipForExtraction(t, [video, silent], nested.id)).toBeNull()
    expect(audioClipForExtraction(t, [{ ...video, generationStatus: 'downloading' }], lone.id)).toBeNull()
  })
})

describe('mattes (07 §6.5)', () => {
  it('pixel sizes per aspect (Matte.swift)', () => {
    expect(mattePixelSize('Project', 1920, 1080)).toEqual([1920, 1080])
    expect(mattePixelSize('Project', 1921, 1081)).toEqual([1920, 1080])
    expect(mattePixelSize('16:9', 1920, 1080)).toEqual([1920, 1080])
    expect(mattePixelSize('9:16', 1920, 1080)).toEqual([1080, 1920])
    expect(mattePixelSize('1:1', 1920, 1080)).toEqual([1080, 1080])
    expect(mattePixelSize('4:3', 1920, 1080)).toEqual([1440, 1080])
    expect(mattePixelSize('9:14', 1920, 1080)).toEqual([1080, 1680])
    expect(mattePixelSize('2.4:1', 1920, 1080)).toEqual([2592, 1080])
    expect(mattePixelSize('9:16', 1080, 1920)).toEqual([1080, 1920])
    expect(mattePixelSize('16:9', 1000, 563)).toEqual([1000, 562])
    expect(matteFit(563, 16, 9)).toEqual([1000, 562])
    expect(matteEven(1, 0)).toEqual([2, 2])
    expect(matteEven(7, 9)).toEqual([6, 8])
  })

  it('hex truncates components, names and aspect parsing', () => {
    expect(matteHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
    expect(matteHex({ r: 1, g: 0.5, b: 0.999 })).toBe('#FF7FFE')
    expect(matteHex({ r: 0.2, g: 0.4, b: 0.6 })).toBe('#336699')
    expect(matteName('Project', 1920, 1080)).toBe('Matte · 1920×1080')
    expect(matteName('9:16', 1080, 1920)).toBe('Matte · 9:16')
    expect(parseMatteAspect(' PROJECT ')).toBe('Project')
    expect(parseMatteAspect('2.4:1')).toBe('2.4:1')
    expect(parseMatteAspect('21:9')).toBeNull()
    expect(parseMatteAspect('')).toBeNull()
  })

  it('PNG is an even-sized opaque RGBA fill of the colour', () => {
    const png = mattePng('#336699', 5, 3)
    expect(pngSize(png)).toEqual({ width: 4, height: 2 })
    expect(png[24 + 1]).toBe(6) // colour type RGBA (IHDR byte 9)
    const idat = png.indexOf('IDAT')
    const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)))
    expect([...raw.subarray(0, 9)]).toEqual([0, 0x33, 0x66, 0x99, 255, 0x33, 0x66, 0x99, 255])
    expect(raw.length).toBe(2 * (1 + 4 * 4))
    expect(() => mattePng('#zz', 4, 4)).toThrow("Couldn't render matte image.")
    expect(parseHex('#ABC')).toEqual({ r: 0xaa / 255, g: 0xbb / 255, b: 0xcc / 255, a: 1 })
  })
})

describe('chroma sampler (07 §6.6)', () => {
  const fill = (n: number, rgb: [number, number, number]) => Uint8Array.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 255 : rgb[i % 4]))

  it('9×9 patch centred on the point, clipped to the image', () => {
    expect(patchRect(0.5, 0.5, 100, 100)).toEqual({ x: 46, y: 46, w: 9, h: 9 })
    expect(patchRect(0, 0, 100, 100)).toEqual({ x: 0, y: 0, w: 5, h: 5 })
    expect(patchRect(1, 1, 100, 50)).toEqual({ x: 96, y: 46, w: 4, h: 4 })
    expect(patchRect(0.5, 0.5, 0, 10)).toBeNull()
  })

  it('HSB like NSColor.getHue', () => {
    expect(rgbToHsb(0, 1, 0)).toEqual({ h: 1 / 3, s: 1, v: 1 })
    expect(rgbToHsb(1, 0, 0).h).toBe(0)
    expect(rgbToHsb(0, 0, 1).h).toBeCloseTo(2 / 3)
    expect(rgbToHsb(1, 0, 0.5).h).toBeCloseTo(11 / 12)
    expect(rgbToHsb(0.5, 0.5, 0.5)).toEqual({ h: 0, s: 0, v: 0.5 })
  })

  it('averages the encoded values and gates saturation at 0.12', () => {
    const half = new Uint8Array([...fill(1, [0, 255, 0]), ...fill(1, [0, 0, 255])])
    expect(averageRgb(half)).toEqual([0, 0.5, 0.5])
    expect(keyHueFromPixels(half)).toBeCloseTo(0.5)
    expect(keyHueFromPixels(fill(81, [40, 200, 60]))).toBeCloseTo(rgbToHsb(40 / 255, 200 / 255, 60 / 255).h)
    // s = (120 − 106) / 120 ≈ 0.117 < 0.12 → no hue; 105 gives 0.125 → hue.
    expect(keyHueFromPixels(fill(9, [106, 120, 106]))).toBeNull()
    expect(keyHueFromPixels(fill(9, [105, 120, 105]))).toBeCloseTo(1 / 3)
    expect(keyHueFromPixels(new Uint8Array())).toBeNull()
  })
})

describe('capture validation (07 §6.4)', () => {
  it('verbatim error texts', () => {
    expect(CAPTURE_ERRORS.noProject).toBe('No project is open.')
    expect(CAPTURE_ERRORS.timelineEmpty).toBe('The timeline is empty.')
    expect(CAPTURE_ERRORS.frameOutOfRange(300, 300)).toBe('Timeline frame 300 is outside 0..<300.')
    expect(CAPTURE_ERRORS.mediaNotFound('abc')).toBe('Media asset not found: abc')
    expect(CAPTURE_ERRORS.mediaNotVideo('abc')).toBe('Media asset abc is not a video.')
    expect(CAPTURE_ERRORS.mediaPreparing('abc')).toBe('Media asset abc is still preparing.')
    expect(CAPTURE_ERRORS.mediaFailed('abc', 'boom')).toBe('Media asset abc failed: boom')
    expect(CAPTURE_ERRORS.folderMissing).toBe('The destination media folder no longer exists.')
  })

  it('source frame request: range check, last-frame selection', () => {
    expect(() => sourceFrameRequest(2.0021, 2, 1 / 30)).toThrow('Source time 2.002s is outside 0…2.000s.')
    expect(() => sourceFrameRequest(-0.5, 2, 1 / 30)).toThrow('Source time -0.500s is outside 0…2.000s.')
    expect(() => sourceFrameRequest(1, Number.NaN, 1 / 30)).toThrow('The video has no finite duration.')
    expect(() => sourceFrameRequest(1, 0, 1 / 30)).toThrow('The video has no finite duration.')
    expect(sourceFrameRequest(2.0005, 2, 1 / 30)).toEqual({ time: 2 - 1 / 30, capturesLastFrame: true })
    expect(sourceFrameRequest(1.97, 2, 1 / 30).capturesLastFrame).toBe(true)
    expect(sourceFrameRequest(1, 2, 1 / 30)).toEqual({ time: 1, capturesLastFrame: false })
  })

  it('ffmpeg args and showinfo parsing', () => {
    expect(sourceFrameArgs('/v.mp4', '/o.png', { time: 1, capturesLastFrame: false }, 1 / 30)).toEqual([
      '-hide_banner', '-nostdin', '-loglevel', 'info', '-y', '-copyts', '-ss', '1.000000', '-i', '/v.mp4', '-map', '0:v:0', '-vf', 'showinfo', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', '/o.png',
    ])
    expect(sourceFrameArgs('/v.mp4', '/o.png', { time: 1.9, capturesLastFrame: true }, 1 / 30)).toContain('-sseof')
    expect(lastPtsTime('[Parsed_showinfo_0] n:0 pts:15000 pts_time:1   duration\n[Parsed_showinfo_0] n:1 pts:15360 pts_time:1.033333 ')).toBe(1.033333)
    expect(lastPtsTime('nothing')).toBeNull()
  })

  it('toasts', () => {
    expect(captureToast('Frame 12', false)).toEqual({ message: 'Captured Frame 12.', kind: 'success' })
    expect(captureToast('Frame 12', true)).toEqual({ message: 'Captured Frame 12. The destination folder was removed, so the frame was saved at the top level of Media.', kind: 'warning' })
  })
})
