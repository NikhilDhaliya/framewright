/** Ported from the Mac's CaptionGenerationTests.swift (CaptionSpecBuilderTests) and SubtitleCueSpecTests. */
import { describe, expect, it } from 'vitest'
import {
  adjustedCaptionTiming,
  applyCaptionCase,
  buildCaptionSpecs,
  buildCueSpecs,
  captionTextStyle,
  maximumGapFrames,
  snappedCoordinate,
  validGapSeconds,
  type CaptionLayout,
  type CaptionTarget,
} from '../../src/core/captions/specBuilder'
import { characterCount } from '../../src/core/captions/text'
import { defaultTextStyle, type TextAnimationPreset } from '../../src/core/model'
import { clip } from './fixtures'

const layout: CaptionLayout = { canvasWidth: 1920, canvasHeight: 1080, fits: () => true, box: (t) => ({ width: Math.min(0.9, t.length * 0.02), height: 0.08 }) }

function gapTarget(id: string, startFrame: number, durationFrames: number, o: { captionDurationFrames?: number; hasWordTiming?: boolean } = {}): CaptionTarget {
  const c = clip({ id, mediaRef: `media-${id}`, mediaType: 'audio', start: startFrame, duration: durationFrames })
  const dur = (o.captionDurationFrames ?? Math.min(21, durationFrames)) / 30
  return {
    clip: c,
    result: { text: id, language: 'en', words: o.hasWordTiming === false ? [] : [{ text: id, start: 0, end: dur }], segments: [{ text: id, start: 0, end: dur }] },
  }
}

function build(targets: CaptionTarget[], o: { maximumGapSeconds?: number; timelineEndFrame?: number; maxCharacters?: number; preset?: TextAnimationPreset; textCase?: 'auto' | 'upper' | 'lower' } = {}) {
  return buildCaptionSpecs({
    targets,
    fps: 30,
    timelineEndFrame: o.timelineEndFrame ?? Math.max(0, ...targets.map((t) => t.clip.startFrame + t.clip.durationFrames)),
    style: defaultTextStyle(),
    center: { x: 0.5, y: 0.8 },
    textCase: o.textCase ?? 'auto',
    maxCharacters: o.maxCharacters,
    maximumGapSeconds: o.maximumGapSeconds ?? 0.5,
    animation: o.preset ? { preset: o.preset, perWordFrames: 6 } : undefined,
    layout,
  })
}

describe('CaptionSpecBuilder', () => {
  it('builds caption specs from immutable input', () => {
    const c = clip({ id: 'source', mediaRef: 'media', mediaType: 'audio', start: 0, duration: 300 })
    const specs = build(
      [
        {
          clip: c,
          result: {
            text: 'hello world',
            language: 'en',
            words: [
              { text: 'hello', start: 1, end: 1.4 },
              { text: 'world', start: 1.5, end: 2 },
            ],
            segments: [],
          },
        },
      ],
      { textCase: 'upper' },
    )
    expect(specs).toHaveLength(1)
    expect(specs[0].content).toBe('HELLO WORLD')
    expect(specs[0].startFrame).toBe(30)
    expect(specs[0].durationFrames).toBe(45)
    expect(specs[0].transform).toMatchObject({ centerX: 0.5, centerY: 0.8, width: 0.22, height: 0.08 })
    expect(specs[0].words?.map((w) => w.text)).toEqual(['hello', 'world'])
    expect(specs[0].captionGroupId).toBeTruthy()
  })

  it('applies the character cap', () => {
    const c = clip({ mediaRef: 'media', mediaType: 'audio', start: 0, duration: 90 })
    const r = {
      text: 'one two three',
      words: [
        { text: 'one', start: 0, end: 0.2 },
        { text: 'two', start: 0.3, end: 0.5 },
        { text: 'three', start: 0.6, end: 0.8 },
      ],
      segments: [{ text: 'one two three', start: 0, end: 0.8 }],
    }
    expect(build([{ clip: c, result: r }], { maxCharacters: 7 }).map((s) => s.content)).toEqual(['one', 'two', 'three'])
  })

  for (const [gap, maxGap, first, last] of [
    [6, 0.25, 27, 28],
    [7, 0.25, 28, 28],
    [8, 0.25, 21, 28],
    [6, 0, 21, 21],
  ] as const) {
    it(`closes only gaps within the frame-rounded threshold (gap ${gap}, max ${maxGap})`, () => {
      const specs = build([gapTarget('one', 0, 21), gapTarget('two', 21 + gap, 30)], { maximumGapSeconds: maxGap })
      expect(specs.map((s) => s.startFrame)).toEqual([0, 21 + gap])
      expect(specs.map((s) => s.durationFrames)).toEqual([first, last])
      expect(specs[0].words).toEqual([{ text: 'one', startFrame: 0, endFrame: 21 }])
    })
  }

  for (const preset of ['popIn', 'slideUp', 'typewriter', 'wordReveal', 'wordSlide'] as const) {
    it(`closes an animated caption gap without overlap (${preset})`, () => {
      const specs = build([gapTarget('one', 0, 21), gapTarget('two', 27, 30)], { preset })
      expect(specs.map((s) => s.durationFrames)).toEqual([27, 30])
      expect(specs[0].startFrame + specs[0].durationFrames).toBe(specs[1].startFrame)
      expect(specs[0].words?.at(-1)?.endFrame).toBe(21)
      expect(specs[1].words?.at(-1)?.endFrame).toBe(21)
      expect(specs[0].animation?.preset).toBe(preset)
    })
  }

  it('a one-frame animated caption closes the following gap without overlap', () => {
    const specs = build([gapTarget('one', 0, 21), gapTarget('two', 27, 1, { hasWordTiming: false }), gapTarget('three', 33, 30)], { preset: 'popIn' })
    expect(specs.map((s) => s.durationFrames)).toEqual([27, 6, 30])
  })

  it('trims overlaps when gap closing is disabled', () => {
    const specs = build([gapTarget('one', 0, 21), gapTarget('two', 20, 30)], { maximumGapSeconds: 0 })
    expect(specs.map((s) => s.startFrame)).toEqual([0, 20])
    expect(specs.map((s) => s.durationFrames)).toEqual([20, 21])
    expect(specs[0].words?.at(-1)?.endFrame).toBe(20)
  })

  it('trims nested overlaps without extending across a long gap', () => {
    const specs = build([gapTarget('outer', 0, 40), gapTarget('nested', 10, 5), gapTarget('next', 31, 30)])
    expect(specs.map((s) => s.startFrame)).toEqual([0, 10, 31])
    expect(specs.map((s) => s.durationFrames)).toEqual([10, 5, 30])
  })

  it('the shorter previous caption owns overlapping frames', () => {
    const specs = build([gapTarget('one', 0, 5), gapTarget('two', 4, 21)], { maximumGapSeconds: 0 })
    expect(specs.map((s) => [s.content, s.startFrame, s.durationFrames])).toEqual([
      ['one', 0, 5],
      ['two', 5, 20],
    ])
    expect(specs[1].words).toEqual([{ text: 'two', startFrame: 0, endFrame: 20 }])
  })

  it('the shorter next caption owns overlapping frames', () => {
    const specs = build([gapTarget('one', 0, 21), gapTarget('two', 20, 5)], { maximumGapSeconds: 0 })
    expect(specs.map((s) => [s.startFrame, s.durationFrames])).toEqual([
      [0, 20],
      [20, 5],
    ])
  })

  it('the later caption wins an equal-duration tie', () => {
    const specs = build([gapTarget('one', 0, 5), gapTarget('two', 4, 5)], { maximumGapSeconds: 0 })
    expect(specs.map((s) => [s.startFrame, s.durationFrames])).toEqual([
      [0, 4],
      [4, 5],
    ])
  })

  it('same-frame captions remain separate and capped', () => {
    const specs = build([gapTarget('one', 0, 21), gapTarget('two', 0, 5)], { maximumGapSeconds: 0, maxCharacters: 3 })
    expect(specs.map((s) => [s.content, s.startFrame, s.durationFrames])).toEqual([
      ['one', 0, 1],
      ['two', 1, 4],
    ])
    expect(specs.every((s) => characterCount(s.content) <= 3)).toBe(true)
    expect(specs[1].words).toEqual([{ text: 'two', startFrame: 0, endFrame: 4 }])
  })

  it('a same-frame collision chain preserves every caption', () => {
    const specs = build([gapTarget('aaa', 0, 3), gapTarget('bb', 0, 2), gapTarget('c', 0, 1)], { maximumGapSeconds: 0, maxCharacters: 3 })
    expect(specs.map((s) => [s.content, s.startFrame, s.durationFrames])).toEqual([
      ['aaa', 0, 1],
      ['bb', 1, 1],
      ['c', 2, 1],
    ])
  })

  for (const [end, gap, expected] of [
    [100, 0.5, 16],
    [10, 0.5, 10],
    [100, 0, 1],
  ] as const) {
    it(`holds the final caption within the timeline (end ${end}, gap ${gap})`, () => {
      const specs = build([gapTarget('last', 0, end, { captionDurationFrames: 1 })], { maximumGapSeconds: gap, timelineEndFrame: end })
      expect(specs.map((s) => s.durationFrames)).toEqual([expected])
    })
  }

  it('gap settings validate and round down to frames', () => {
    expect(maximumGapFrames(0.5, 30)).toBe(15)
    expect(maximumGapFrames(0, 30)).toBe(0)
    expect(maximumGapFrames(0.49, 24)).toBe(11)
    expect(validGapSeconds(-0.1)).toBeNull()
    expect(validGapSeconds(2.1)).toBeNull()
    expect(validGapSeconds(Infinity)).toBeNull()
    expect(validGapSeconds(2)).toBe(2)
  })

  it('adjustedCaptionTiming keeps an empty list empty', () => {
    expect(adjustedCaptionTiming([], 0.5, 30, 100)).toEqual([])
  })
})

describe('subtitle cue specs', () => {
  const box = () => ({ width: 0.3, height: 0.08 })
  it('converts cue seconds to frames in one group, clamping sub-frame cues', () => {
    const specs = buildCueSpecs(
      [
        { text: 'one', startSeconds: 1, endSeconds: 2.5 },
        { text: 'blip', startSeconds: 3, endSeconds: 3.01 },
      ],
      30,
      captionTextStyle(),
      { x: 0.5, y: 0.9 },
      box,
    )
    expect(specs.map((s) => s.startFrame)).toEqual([30, 90])
    expect(specs.map((s) => s.durationFrames)).toEqual([45, 1])
    expect(specs.every((s) => s.transform && s.captionGroupId === specs[0].captionGroupId)).toBe(true)
    expect(specs[0].style.fontSize).toBe(48)
  })
  it('resolves overlaps without closing gaps', () => {
    const specs = buildCueSpecs(
      [
        { text: 'overlapping', startSeconds: 0, endSeconds: 1 },
        { text: 'next', startSeconds: 0.9, endSeconds: 2 },
        { text: 'after gap', startSeconds: 2.2, endSeconds: 3 },
      ],
      30,
      captionTextStyle(),
      { x: 0.5, y: 0.9 },
      box,
    )
    expect(specs.map((s) => s.startFrame)).toEqual([0, 27, 66])
    expect(specs.map((s) => s.durationFrames)).toEqual([27, 33, 24])
  })
})

describe('caption helpers', () => {
  it('transforms text case', () => {
    expect(applyCaptionCase('auto', 'Hello World.')).toBe('Hello World.')
    expect(applyCaptionCase('upper', 'Hello World.')).toBe('HELLO WORLD.')
    expect(applyCaptionCase('lower', 'Hello World.')).toBe('hello world.')
  })
  it('snaps within 0.02 of the centre', () => {
    expect(snappedCoordinate(0.51)).toBe(0.5)
    expect(snappedCoordinate(0.48)).toBe(0.48)
    expect(snappedCoordinate(1.3)).toBe(1.3)
  })
})
