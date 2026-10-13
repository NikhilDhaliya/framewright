/** Ported from the Mac's Tests/PalmierProTests/Captions/CaptionBuilderTests.swift and CaptionGenerationTests.swift. */
import { describe, expect, it } from 'vitest'
import { phrasesForSegment, phrasesFromTimedWords, phraseSpecs, timelineFrameForSource, type Phrase } from '../../src/core/captions/captionBuilder'
import { clipPhrases, sourceUnion, spokenWordCount } from '../../src/core/captions/transcriptMapper'
import { alphanumericCount, characterCount, trimWhitespaceAndNewlines, wordCount } from '../../src/core/captions/text'
import { defaultTextStyle, defaultTransform } from '../../src/core/model'
import { clip, result } from './fixtures'

const seg = (text: string, start: number, end: number) => ({ text, start, end })
const len = (s: string) => characterCount(s)

describe('CaptionBuilder.phrases', () => {
  it('keeps a segment whole when it fits', () => {
    expect(phrasesForSegment(seg('Hello there', 1, 2), [], () => true)).toEqual([{ text: 'Hello there', start: 1, end: 2, words: [] }])
  })
  it('splits at a sentence boundary and distributes time', () => {
    const p = phrasesForSegment(seg('One. Two.', 0, 8), [], (t) => len(t) <= 5)
    expect(p.map((x) => x.text)).toEqual(['One.', 'Two.'])
    expect(p.map((x) => x.start)).toEqual([0, 4])
    expect(p.map((x) => x.end)).toEqual([4, 8])
  })
  it('splits at a clause when there is no sentence', () => {
    expect(phrasesForSegment(seg('alpha, beta', 0, 2), [], (t) => len(t) <= 6).map((x) => x.text)).toEqual(['alpha,', 'beta'])
  })
  it('splits at the middle word without punctuation', () => {
    expect(phrasesForSegment(seg('a b c d', 0, 4), [], (t) => len(t) <= 3).map((x) => x.text)).toEqual(['a b', 'c d'])
  })
  it('caps words per caption', () => {
    const p = phrasesForSegment(seg('one two three four five six', 0, 6), [], () => true, { maxWords: 2 })
    expect(p.every((x) => x.text.split(' ').length <= 2)).toBe(true)
    expect(p.map((x) => x.text).join(' ')).toBe('one two three four five six')
  })
  it('max words still prefers a sentence boundary', () => {
    expect(phrasesForSegment(seg('Hi there. How are you', 0, 6), [], () => true, { maxWords: 3 }).map((x) => x.text)).toEqual(['Hi there.', 'How are you'])
  })
  it('caps characters per caption', () => {
    const p = phrasesForSegment(seg('one two three four', 0, 4), [], () => true, { maxCharacters: 8 })
    expect(p.every((x) => len(x.text) <= 8)).toBe(true)
    expect(p.map((x) => x.text).join(' ')).toBe('one two three four')
  })
  it('counts spaces and punctuation toward the character cap', () => {
    expect(phrasesForSegment(seg('hi, you', 0, 2), [], () => true, { maxCharacters: 6 }).map((x) => x.text)).toEqual(['hi,', 'you'])
  })
  it('applies word and character caps together without dropping text', () => {
    const p = phrasesForSegment(seg('a bb ccc dddd', 0, 4), [], () => true, { maxWords: 2, maxCharacters: 5 })
    expect(p.every((x) => x.text.split(' ').length <= 2 && len(x.text) <= 5)).toBe(true)
    expect(p.map((x) => x.text).join(' ')).toBe('a bb ccc dddd')
  })
  it('keeps punctuated tokens intact', () => {
    expect(phrasesForSegment(seg('U.S. army here', 0, 6), [], (t) => len(t) <= 6).map((x) => x.text)).toEqual(['U.S.', 'army', 'here'])
  })
  it('distributes time by character count', () => {
    const p = phrasesForSegment(seg('aaaa bb', 0, 6), [], (t) => len(t) <= 4)
    expect(p.map((x) => [x.text, x.start, x.end])).toEqual([
      ['aaaa', 0, 4],
      ['bb', 4, 6],
    ])
  })
  it('keeps dense word timings exact', () => {
    const words = [
      { text: 'Okay,', start: 1.235, end: 1.413 },
      { text: 'so', start: 1.43, end: 1.609 },
      { text: "I've", start: 1.641, end: 1.739 },
      { text: 'been', start: 1.739, end: 1.836 },
      { text: 'sleeping', start: 1.836, end: 2.161 },
    ]
    const p = phrasesForSegment(seg("Okay, so I've been sleeping", 1.235, 2.161), words, (t) => t === 'Okay,' || t === "so I've been sleeping")
    expect(p.map((x) => x.text)).toEqual(['Okay,', "so I've been sleeping"])
    expect(p.map((x) => x.start)).toEqual([1.235, 1.43])
    expect(p[0].end).toBe(1.413)
    expect(p[1].words.map((w) => w.text)).toEqual(['so', "I've", 'been', 'sleeping'])
  })
  it('builds phrases only from the passed timed words', () => {
    const p = phrasesFromTimedWords(
      [
        { text: 'Okay,', start: 1, end: 1.2 },
        { text: 'go', start: 2, end: 2.2 },
        { text: 'untimed' },
      ],
      () => true,
    )
    expect(p.map((x) => x.text)).toEqual(['Okay, go'])
    expect(p[0].words.map((w) => w.text)).toEqual(['Okay,', 'go'])
  })
  it('keeps an over-long single word', () => {
    expect(phrasesForSegment(seg('supercalifragilistic', 0, 1), [], () => false).map((x) => x.text)).toEqual(['supercalifragilistic'])
  })
  it('falls back to distribution when word runs do not cover every piece', () => {
    const p = phrasesForSegment(seg('one two', 0, 2), [{ text: 'one', start: 0, end: 1 }], (t) => len(t) <= 3)
    expect(p.map((x) => [x.text, x.start, x.end, x.words.length])).toEqual([
      ['one', 0, 1, 0],
      ['two', 1, 2, 0],
    ])
  })
})

describe('CaptionBuilder.specs', () => {
  const source = () => clip({ mediaRef: 'm', start: 30, duration: 120 })
  const style = defaultTextStyle()

  it('carries word timings (clip-relative) and the animation', () => {
    const p: Phrase = {
      text: 'hi there',
      start: 1,
      end: 2,
      words: [
        { text: 'hi', start: 1, end: 1.4 },
        { text: 'there', start: 1.5, end: 2 },
      ],
    }
    const specs = phraseSpecs([p], source(), 30, { style, captionGroupId: 'g1', animation: { preset: 'wordSlide', perWordFrames: 6 } })
    expect(specs[0].animation?.preset).toBe('wordSlide')
    expect(specs[0].words).toEqual([
      { text: 'hi', startFrame: 0, endFrame: 12 },
      { text: 'there', startFrame: 15, endFrame: 30 },
    ])
  })
  it('maps a word ending at the clip boundary', () => {
    const p: Phrase = {
      text: 'hi there',
      start: 0,
      end: 1,
      words: [
        { text: 'hi', start: 0, end: 0.5 },
        { text: 'there', start: 0.5, end: 1 },
      ],
    }
    const specs = phraseSpecs([p], clip({ start: 0, duration: 30 }), 30, { style })
    expect(specs[0].words).toEqual([
      { text: 'hi', startFrame: 0, endFrame: 15 },
      { text: 'there', startFrame: 15, endFrame: 30 },
    ])
  })
  it('maps seconds through the clip placement', () => {
    const specs = phraseSpecs([{ text: 'hi', start: 1, end: 2, words: [] }], source(), 30, { style, captionGroupId: 'g1' })
    expect(specs.map((s) => [s.startFrame, s.durationFrames, s.captionGroupId])).toEqual([[60, 30, 'g1']])
    expect(specs[0].words).toBeUndefined()
  })
  it('clamps a phrase running past the clip end', () => {
    const specs = phraseSpecs([{ text: 'long', start: 1, end: 10, words: [] }], source(), 30, { style })
    expect([specs[0].startFrame, specs[0].durationFrames]).toEqual([60, 90])
  })
  it('clamps a phrase spanning a trimmed clip', () => {
    const c = source()
    c.trimStartFrame = 60
    const specs = phraseSpecs([{ text: 'full', start: 0, end: 10, words: [] }], c, 30, { style })
    expect(specs.map((s) => [s.startFrame, s.durationFrames])).toEqual([[30, 120]])
  })
  it('resolves each box through transformFor', () => {
    const box = { ...defaultTransform(), centerY: 0.85, width: 0.4, height: 0.1 }
    const specs = phraseSpecs([{ text: 'hi', start: 1, end: 2, words: [] }], source(), 30, { style, transformFor: () => box })
    expect(specs[0].transform).toEqual(box)
  })
  it('drops a phrase entirely before the trim in', () => {
    const c = source()
    c.trimStartFrame = 60
    expect(phraseSpecs([{ text: 'gone', start: 0.5, end: 1, words: [] }], c, 30, { style })).toEqual([])
  })
  it('maps through speed', () => {
    const c = clip({ start: 0, duration: 50, speed: 2 })
    const specs = phraseSpecs([{ text: 'fast', start: 1, end: 2, words: [] }], c, 30, { style })
    expect(specs.map((s) => [s.startFrame, s.durationFrames])).toEqual([[15, 15]])
  })
  it('timelineFrame is nil before the trim or outside the clip', () => {
    const c = source()
    c.trimStartFrame = 30
    expect(timelineFrameForSource(c, 0.5, 30)).toBeNull()
    expect(timelineFrameForSource(c, 1, 30)).toBe(30)
    expect(timelineFrameForSource(c, 5, 30)).toBeNull()
  })
})

describe('CaptionTranscriptMapper', () => {
  for (const timed of [true, false]) {
    it(`preserves short timings across segments (word timings: ${timed})`, () => {
      const r = result(
        timed
          ? [
              ['Sophie?', 0, 0.2],
              ['Hi,', 0.3, 0.5],
            ]
          : [],
        [
          ['Sophie?', 0, 0.2],
          ['Hi,', 0.3, 0.5],
        ],
      )
      const p = clipPhrases(clip({ mediaType: 'audio', start: 0, duration: 60 }), r, 30, () => true, { maxCharacters: 4 })
      expect(p.map((x) => x.text)).toEqual(['Sophie?', 'Hi,'])
      expect(p.map((x) => x.start)).toEqual([0, 0.3])
      expect(p.map((x) => x.end)).toEqual([0.2, 0.5])
    })
  }
  it('ignores words outside the current clip fragment', () => {
    const r = result(
      [
        ['keep', 0.1, 0.3],
        ['um', 1.1, 1.2],
        ['go', 2.1, 2.3],
      ],
      [['keep um go', 0, 3]],
    )
    const first = clip({ id: 'first', mediaRef: 'media-1', mediaType: 'audio', start: 0, duration: 30, trimStart: 0 })
    const second = clip({ id: 'second', mediaRef: 'media-1', mediaType: 'audio', start: 30, duration: 30, trimStart: 60 })
    expect(clipPhrases(first, r, 30, () => true).map((x) => x.text)).toEqual(['keep'])
    expect(clipPhrases(second, r, 30, () => true).map((x) => x.text)).toEqual(['go'])
  })
  it('uses a fallback segment when the transcript has words but no segments', () => {
    const r = result([
      ['hello', 1, 1.4],
      ['world', 1.5, 2],
    ])
    const p = clipPhrases(clip({ mediaType: 'audio', start: 0, duration: 300 }), r, 30, () => true)
    expect(p.map((x) => [x.text, x.start, x.end])).toEqual([['hello world', 1, 2]])
  })
  it('clips segment-only transcripts to the visible window', () => {
    const r = result([], [['a b c d', 0, 4]])
    const p = clipPhrases(clip({ start: 0, duration: 60, trimStart: 30 }), r, 30, () => true)
    expect(p.map((x) => [x.text, x.start, x.end])).toEqual([['a b c d', 1, 3]])
  })
  it('sourceUnion pads by one second and floors at zero', () => {
    const a = clip({ mediaRef: 'x', start: 0, duration: 30, trimStart: 15 })
    const b = clip({ mediaRef: 'x', start: 100, duration: 60, trimStart: 300, speed: 2 })
    expect(sourceUnion('x', [a, b, clip({ mediaRef: 'y' })], 30)).toEqual([0, 14 + 1])
    expect(sourceUnion('x', [clip({ mediaRef: 'x', trimStart: 90, duration: 30 })], 30)).toEqual([2, 5])
    expect(sourceUnion('none', [a], 30)).toBeNull()
  })
  it('counts spoken words by midpoint in the visible span', () => {
    const r = result([
      ['a', 0, 0.5],
      ['b', 0.9, 1.2],
      ['c', 2, 2.2],
    ])
    expect(spokenWordCount(clip({ start: 0, duration: 30, trimStart: 0 }), r, 30)).toBe(1)
    expect(spokenWordCount(clip({ start: 0, duration: 60, trimStart: 30 }), r, 30)).toBe(2)
  })
})

describe('Swift string helpers', () => {
  it('match Swift semantics', () => {
    expect(wordCount('  a\tb\nc  ')).toBe(3)
    expect(characterCount('e\u0301👍🏽')).toBe(2)
    expect(alphanumericCount("I've 3.14!")).toBe(6)
    expect(trimWhitespaceAndNewlines('\n hi \u2028')).toBe('hi')
  })
})
