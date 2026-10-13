import { describe, expect, it } from 'vitest'
import { outputSize, videoCodecFor, videoEncoderArgs } from '../src/main/export/encoders'

describe('export encoders (§11.4)', () => {
  it('picks codecs per container', () => {
    expect(videoCodecFor('mp4')).toBe('h264')
    expect(videoCodecFor('mp4', 'HEVC')).toBe('hevc')
    expect(videoCodecFor('mov')).toBe('prores')
    expect(videoCodecFor('webm')).toBe('vp9')
    expect(videoCodecFor('wav')).toBeNull()
  })

  it('keeps output sizes even and follows the timeline aspect', () => {
    expect(outputSize({}, 1921, 1081)).toEqual({ width: 1920, height: 1080 })
    expect(outputSize({ width: 1280 }, 1920, 1080)).toEqual({ width: 1280, height: 720 })
    expect(outputSize({ height: 101 }, 1080, 1920)).toEqual({ width: 56, height: 100 })
    expect(outputSize({ width: 7 }, 16, 9, false)).toEqual({ width: 7, height: 4 })
  })

  it('maps quality to CRF with the bitrate cap and BT.709 tags', () => {
    const a = videoEncoderArgs({ format: 'mp4', width: 1920, height: 1080, fps: 30, quality: 'medium', audioPath: '/mix.wav', output: '/o.mp4' })
    expect(a.join(' ')).toContain('-f rawvideo -pix_fmt rgba -video_size 1920x1080 -framerate 30 -i pipe:0 -i /mix.wav -map 0:v:0 -map 1:a:0')
    expect(a.join(' ')).toContain('-c:v libx264 -preset slow -profile:v high -crf 23 -maxrate 15676k -bufsize 20902k')
    expect(a).toEqual(expect.arrayContaining(['-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+faststart']))
    const p = videoEncoderArgs({ format: 'mov', width: 640, height: 360, fps: 25, audioPath: null, output: '/o.mov' })
    expect(p.join(' ')).toContain('format=yuv422p10le -c:v prores_ks -profile:v 2 -vendor apl0')
    expect(p).not.toContain('-c:a')
    const h = videoEncoderArgs({ format: 'mp4', codec: 'hevc', width: 1920, height: 1080, fps: 30, audioPath: null, output: '/o.mp4' })
    expect(h).toEqual(expect.arrayContaining(['libx265', '-tag:v', 'hvc1']))
  })
})
