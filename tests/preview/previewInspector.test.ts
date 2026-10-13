import { describe, expect, it } from 'vitest'
import type { TimelineMarker } from '@core/model'
import { lockedAspectNormalized, lockForRatio, lockLabel, pannedCrop, resizedCrop, sameLock } from '../../src/renderer/preview/cropMath'
import { hueHistogram, sampleStride, yrgbHistogram } from '../../src/renderer/preview/histogram'
import { markerThumbnailSize, sortedMarkers } from '../../src/renderer/media/index/markers'

const ident = { left: 0, top: 0, right: 0, bottom: 0 }
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9)

describe('crop drag math (Mac CropOverlayView)', () => {
  it('pans inside the source keeping the window size', () => {
    const c = pannedCrop({ left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 }, { dx: 0.5, dy: -0.5 })
    close(c.left, 0.4)
    close(c.right, 0)
    close(c.top, 0)
    close(c.bottom, 0.4)
  })

  it('free resize moves only the dragged corner and keeps the minimum visible', () => {
    const c = resizedCrop(ident, 'bottomRight', { dx: -0.2, dy: -0.1 }, null)
    expect(c).toEqual({ left: 0, top: 0, right: 0.2, bottom: expect.closeTo(0.1, 9) })
    const tiny = resizedCrop(ident, 'topLeft', { dx: 2, dy: 2 }, null, 0.05)
    close(1 - tiny.left - tiny.right, 0.05)
    close(1 - tiny.top - tiny.bottom, 0.05)
  })

  it('locked resize keeps the aspect, driven by the dominant axis', () => {
    // 16:9 source locked to 1:1 → normalized aspect 9/16.
    const aspectN = lockedAspectNormalized(lockForRatio(1, 1), 16 / 9)!
    close(aspectN, 9 / 16)
    const start = resizedCrop(ident, 'bottomRight', { dx: -0.5, dy: 0 }, aspectN)
    const visW = 1 - start.left - start.right
    const visH = 1 - start.top - start.bottom
    close(visW / visH, aspectN)
    close(visW, 0.5)
    // The anchored (opposite) corner stays put.
    close(start.left, 0)
    close(start.top, 0)
    // Height-dominant drag from the top-left corner.
    const tl = resizedCrop({ left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 }, 'topLeft', { dx: 0, dy: 0.1 }, 1)
    close(1 - tl.left - tl.right, 0.5)
    close(1 - tl.top - tl.bottom, 0.5)
    close(tl.right, 0.2)
    close(tl.bottom, 0.2)
  })

  it('free and original locks do not constrain drags', () => {
    expect(lockedAspectNormalized({ kind: 'free' }, 16 / 9)).toBeNull()
    expect(lockedAspectNormalized({ kind: 'original' }, 16 / 9)).toBeNull()
  })

  it('maps typed ratios to presets, else a custom W:H lock (CropAspectLock.locked(to:))', () => {
    expect(lockForRatio(32, 18)).toEqual({ kind: 'fixed', ratio: 16 / 9, label: '16:9' })
    expect(lockForRatio(2.35, 1)).toEqual({ kind: 'fixed', ratio: 2.35, label: '2.35:1' })
    expect(lockLabel({ kind: 'free' })).toBe('Freeform')
    expect(lockLabel({ kind: 'original' })).toBe('Original')
    expect(sameLock(lockForRatio(4, 3), lockForRatio(8, 6))).toBe(true)
    expect(sameLock({ kind: 'free' }, { kind: 'original' })).toBe(false)
  })
})

function frame(w: number, h: number, rgb: (x: number, y: number) => [number, number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgb(x, y)
      px.set([r, g, b, 255], (y * w + x) * 4)
    }
  return px
}

describe('frame histograms (Mac VideoEngine.histogramYRGB / hueHistogram)', () => {
  it('downsamples to about 320×180', () => {
    expect(sampleStride(320, 180)).toBe(1)
    expect(sampleStride(1920, 1080)).toBe(6)
  })

  it('bins luma and channels and normalizes by the largest bin', () => {
    const px = frame(4, 1, (x) => (x < 2 ? [255, 0, 0] : [0, 0, 0]))
    const h = yrgbHistogram(px, 4, 1, 256, 1)!
    expect(h.r[255]).toBe(0.5)
    expect(h.r[0]).toBe(0.5)
    expect(h.g[0]).toBe(1)
    expect(h.b[0]).toBe(1)
    // Rec.709 luma of pure red = 0.2126 → bin 54.
    expect(h.y[54]).toBe(0.5)
    expect(Math.max(...h.y, ...h.r, ...h.g, ...h.b)).toBe(1)
  })

  it('hue bins are saturation-weighted, sqrt-compressed, and skip greys', () => {
    const px = frame(4, 1, (x) => (x === 0 ? [255, 0, 0] : x === 1 ? [0, 0, 255] : x === 2 ? [0, 0, 255] : [128, 128, 128]))
    const h = hueHistogram(px, 4, 1, 96, 1)!
    expect(h[64]).toBe(1) // blue = 240° → 2/3 · 96
    expect(h[0]).toBeCloseTo(Math.sqrt(0.5), 6) // red
    expect(h.reduce((a, v) => a + (v > 0 ? 1 : 0), 0)).toBe(2)
  })
})

const marker = (id: string, startFrame: number, extra: Partial<TimelineMarker> = {}): TimelineMarker => ({
  id,
  name: `Marker ${id}`,
  startFrame,
  durationFrames: 0,
  color: { r: 0, g: 0.478, b: 1, a: 1 },
  comment: '',
  status: 'open',
  ...extra,
})

describe('marker browser helpers (Mac MarkerBrowserNavigation)', () => {
  const ms = [marker('b', 10, { comment: 'Fix the Logo' }), marker('a', 10), marker('c', 5, { status: 'resolved', name: 'Intro' })]
  it('sorts by start frame then id', () => {
    expect(sortedMarkers(ms, '').map((m) => m.id)).toEqual(['c', 'a', 'b'])
  })
  it('filters by name or comment, case-insensitively, and by status', () => {
    expect(sortedMarkers(ms, '  logo ').map((m) => m.id)).toEqual(['b'])
    expect(sortedMarkers(ms, 'intro').map((m) => m.id)).toEqual(['c'])
    expect(sortedMarkers(ms, '', 'resolved').map((m) => m.id)).toEqual(['c'])
    expect(sortedMarkers(ms, 'logo', 'resolved')).toEqual([])
  })
  it('thumbnail keeps the canvas aspect at the row height', () => {
    expect(markerThumbnailSize(1920, 1080, 62)).toEqual({ w: (1920 * 62) / 1080, h: 62 })
    expect(markerThumbnailSize(0, 1080, 62)).toEqual({ w: 0, h: 0 })
  })
})
