// Port of the Mac Tests/PalmierProTests/Export/XMLExporterTimecodeTests.swift plus printf / XML-writer checks.
import { describe, expect, it } from 'vitest'
import {
  displayToFrames,
  el,
  formatFixed,
  formatSmpteTimecode,
  leaf,
  node,
  pad2,
  parseTimecodeString,
  rateTags,
  rationalSeconds,
  renderDocument,
  textEl,
  timecodeFramesAt,
  timecodeSeconds,
  timecodeTags,
} from '../../src/core/interchange'

describe('XMLExporter timecode (Mac XMLExporterTimecodeTests)', () => {
  it('mac: nonDropSourceEmitsNonDropTimecodeRegardlessOfVideoNtsc', () => {
    const tc = timecodeTags({ frame: 1968620, quanta: 30, dropFrame: false }, 30, true)
    expect(tc.base).toBe(30)
    expect(tc.ntsc).toBe(true)
    expect(tc.dropFrame).toBe(false)
    expect(tc.string).toBe('18:13:40:20')
    expect(tc.string).not.toContain(';')
  })

  it('mac: dropFrameSourceOn60pUsesTrackQuantaNotVideoRate', () => {
    const tc = timecodeTags({ frame: 42966, quanta: 30, dropFrame: true }, 60, true)
    expect(tc.base).toBe(30)
    expect(tc.dropFrame).toBe(true)
    expect(tc.frame).toBe(42966)
    expect(tc.string).toBe('00;23;53;18')
  })

  it('mac: cleanThirtyFpsSourceStaysNonNtsc', () => {
    const tc = timecodeTags({ frame: 0, quanta: 30, dropFrame: false }, 30, false)
    expect(tc.ntsc).toBe(false)
    expect(tc.string).toBe('00:00:00:00')
  })

  it('mac: noTimecodeTrackFallsBackToVideoRateAndZero', () => {
    const tc = timecodeTags(undefined, 30, true)
    expect(tc.frame).toBe(0)
    expect(tc.base).toBe(30)
    expect(tc.dropFrame).toBe(true)
    expect(tc.string).toBe('00;00;00;00')
  })

  it('mac: nonDropFormattingRollsFieldsAtFps', () => {
    expect(formatSmpteTimecode(0, 25, false)).toBe('00:00:00:00')
    expect(formatSmpteTimecode(1688098, 25, false)).toBe('18:45:23:23')
    expect(formatSmpteTimecode(24 * 3600, 24, false)).toBe('01:00:00:00')
  })

  it('mac: dropFrameSkipsDroppedFrameNumbers', () => {
    expect(formatSmpteTimecode(0, 30, true)).toBe('00;00;00;00')
    expect(formatSmpteTimecode(42966, 30, true)).toBe('00;23;53;18')
  })

  it('mac: zeroFpsDoesNotCrash', () => {
    expect(formatSmpteTimecode(100, 0, false)).toBe('00:00:00:00')
  })
})

describe('SourceTimecode arithmetic', () => {
  it('mac (FCPXMLExporterTests.embeddedTimecodeConvertsToTimelineFrames): frames(atFPS:)', () => {
    const tc = { frame: 744, quanta: 50, dropFrame: false }
    expect(timecodeFramesAt(tc, 50)).toBe(744)
    expect(timecodeFramesAt(tc, 25)).toBe(372)
  })

  it('rational seconds use the NTSC tick when present', () => {
    expect(rationalSeconds({ frame: 100, quanta: 30, dropFrame: true, tick: { num: 1001, den: 30000 } })).toEqual({ num: 100100, den: 30000 })
    expect(rationalSeconds({ frame: 100, quanta: 0, dropFrame: false })).toEqual({ num: 0, den: 1 })
    expect(timecodeSeconds({ frame: 172_800_000, quanta: 48000, dropFrame: false })).toBe(3600)
  })

  it('display ↔ raw frames round-trip through the DF formatter at 29.97 and 59.94', () => {
    for (const [q, h, m, s, f] of [
      [30, 1, 0, 0, 0],
      [30, 0, 1, 0, 2],
      [30, 10, 9, 59, 29],
      [60, 14, 34, 12, 58],
      [60, 23, 59, 59, 59],
    ]) {
      const raw = displayToFrames(h, m, s, f, q, true)
      expect(formatSmpteTimecode(raw, q, true)).toBe([h, m, s, f].map(pad2).join(';'))
    }
  })

  it('parses ffprobe timecode strings (";" = drop-frame)', () => {
    expect(parseTimecodeString('01:00:00:00', 25)).toEqual({ frame: 90000, quanta: 25, dropFrame: false })
    expect(parseTimecodeString('01:00:00;00', 30)).toEqual({ frame: 107892, quanta: 30, dropFrame: true })
    expect(parseTimecodeString('00:00:01:40', 30)).toBeUndefined()
    expect(parseTimecodeString('garbage', 30)).toBeUndefined()
  })

  it('rate tags flag NTSC rates', () => {
    expect(rateTags(23.976)).toEqual({ timebase: 24, ntsc: true })
    expect(rateTags(29.97)).toEqual({ timebase: 30, ntsc: true })
    expect(rateTags(59.94)).toEqual({ timebase: 60, ntsc: true })
    expect(rateTags(24)).toEqual({ timebase: 24, ntsc: false })
    expect(rateTags(0)).toEqual({ timebase: 1, ntsc: true })
  })
})

describe('printf-compatible formatting', () => {
  it('matches C %.Nf, including exact binary ties (half-to-even) and negative zero', () => {
    expect(formatFixed(0.125, 2)).toBe('0.12') // toFixed → 0.13
    expect(formatFixed(0.375, 2)).toBe('0.38')
    expect(formatFixed(2.5, 0)).toBe('2')
    expect(formatFixed(3.5, 0)).toBe('4')
    expect(formatFixed(-0.125, 2)).toBe('-0.12')
    expect(formatFixed(-0, 2)).toBe('-0.00')
    expect(formatFixed(-0.001, 2)).toBe('-0.00')
    expect(formatFixed(1.005, 2)).toBe('1.00') // binary value is 1.00499999…
    expect(formatFixed(200, 4)).toBe('200.0000')
    expect(formatFixed(0.1 + 0.2, 5)).toBe('0.30000')
    expect(formatFixed(1e22, 1)).toBe('10000000000000000000000.0')
    expect(formatFixed(5e-324, 2)).toBe('0.00')
    expect(formatFixed(NaN, 2)).toBe('nan')
    expect(formatFixed(-Infinity, 2)).toBe('-inf')
  })

  it('agrees with toFixed away from exact ties', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2000
    for (let i = 0; i < 2000; i++) {
      const v = rnd()
      for (const d of [1, 2, 4, 5]) {
        const scaled = Math.abs(v) * 10 ** d
        if (Math.abs(scaled - Math.floor(scaled) - 0.5) < 1e-6) continue
        expect(formatFixed(v, d)).toBe(v.toFixed(d))
      }
    }
  })

  it('pads %02d', () => {
    expect(pad2(0)).toBe('00')
    expect(pad2(7)).toBe('07')
    expect(pad2(123)).toBe('123')
    expect(pad2(-5)).toBe('-5')
  })
})

describe('XML writer', () => {
  it('renders 2-space indentation, one-line text elements, self-closing empties and escaped attributes in order', () => {
    const doc = renderDocument(
      'x',
      el('root', [['b', '2'], ['a', `<&"'>`]], [leaf('name', 'A & B'), node('empty'), el('e', [['k', 'v']]), textEl('t', [['ref', 'r']], ''), node('wrap', [leaf('n', 3)])]),
    )
    expect(doc).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE x>',
        '<root b="2" a="&lt;&amp;&quot;&apos;&gt;">',
        '  <name>A &amp; B</name>',
        '  <empty/>',
        '  <e k="v"/>',
        '  <t ref="r"></t>',
        '  <wrap>',
        '    <n>3</n>',
        '  </wrap>',
        '</root>',
      ].join('\n'),
    )
  })
})
