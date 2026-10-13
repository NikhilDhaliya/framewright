/** Ported from the Mac's SubtitleFileParserTests, TranscriptSearchTests, WordCutPlannerTests and TranscriptCacheTests. */
import { describe, expect, it } from 'vitest'
import { decodeSubtitleBytes, parseSubtitleBytes, parseSubtitles, srtTimestamp, subtitleFormat, SubtitleParseError } from '../../src/core/captions/subtitleFileParser'
import { matchesTerms, searchTerms, searchTranscripts } from '../../src/core/captions/transcriptSearch'
import { cutRanges, KEPT_GAP_MS } from '../../src/core/captions/wordCutPlanner'
import { filterToRange, normalizedResult, offsetting, TranscriptionError, type TranscriptionResult } from '../../src/core/captions/transcript'

const malformed = (line: number) => new SubtitleParseError(`Malformed cue timing at line ${line}.`)

describe('SubtitleFileParser', () => {
  it('parses SRT tolerating BOM, CRLF, dot millis, missing indices and out-of-order cues', () => {
    const srt = '\uFEFF1\r\n00:01:00.250 --> 00:01:02,000\r\nLine one\r\nLine two\r\n\r\n' + '00:00:01,000 --> 00:00:02,500\r\nFirst.\r\n\r\n' + '3\r\n00:00:07,000 --> 00:00:08,000\r\n<i></i>\r\n'
    expect(parseSubtitles(srt, 'srt')).toEqual([
      { text: 'First.', startSeconds: 1, endSeconds: 2.5 },
      { text: 'Line one\nLine two', startSeconds: 60.25, endSeconds: 62 },
    ])
  })
  it('parses WebVTT header, comment blocks, identifiers and settings', () => {
    const vtt = [
      'WEBVTT - Test file',
      'Kind: captions',
      '',
      'NOTE',
      'This comment block is skipped.',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'intro',
      '00:05.000 --> 00:07.500 align:start line:0',
      '<v Speaker><i>Styled</i> &amp; <00:00:06.500>timed</v>{\\an8}',
      '',
      '01:00:00.000 --> 01:00:01.000',
      'Escapes: &lt;tag&gt; &amp;lt;',
    ].join('\n')
    expect(parseSubtitles(vtt, 'vtt')).toEqual([
      { text: 'Styled & timed', startSeconds: 5, endSeconds: 7.5 },
      { text: 'Escapes: <tag> &lt;', startSeconds: 3600, endSeconds: 3601 },
    ])
  })
  for (const [srt, line] of [
    ['1\n00:00:xx,000 --> 00:00:01,000\nBad start.', 2],
    ['1\n00:00:01,000 --> 00:00:01,000\nEnd not after start.', 2],
    ['1\n00:75:00,000 --> 00:76:00,000\nMinutes out of range.', 2],
    ['1\n00:00:01,0000 --> 00:00:02,000\nToo many millisecond digits.', 2],
    ['No timing line at all.', 1],
  ] as const) {
    it(`reports malformed cues at line ${line}: ${srt.split('\n').at(-1)}`, () => {
      expect(() => parseSubtitles(srt, 'srt')).toThrow(malformed(line))
    })
  }
  it('treats keyword-prefixed identifiers as cues, not comments', () => {
    expect(parseSubtitles('WEBVTT\n\nNOTE123\n00:01.000 --> 00:02.000\nA cue, not a comment.\n', 'vtt')).toEqual([{ text: 'A cue, not a comment.', startSeconds: 1, endSeconds: 2 }])
    expect(() => parseSubtitles('WEBVTTjunk\n\n00:01.000 --> 00:02.000\nBad header.', 'vtt')).toThrow('Not a WebVTT file — the WEBVTT header is missing.')
  })
  it('rejects cues missing their blank-line separator', () => {
    expect(() => parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nFirst.\n2\n00:00:03,000 --> 00:00:04,000\nSwallowed.\n', 'srt')).toThrow(malformed(5))
  })
  it('rejects a missing header, empty files and unknown extensions', () => {
    expect(() => parseSubtitles('00:00.000 --> 00:01.000\nNo header.', 'vtt')).toThrow('WEBVTT header is missing')
    expect(() => parseSubtitles('', 'srt')).toThrow('The file contains no captions.')
    expect(() => parseSubtitles('WEBVTT\n\nNOTE only comments here\n', 'vtt')).toThrow('The file contains no captions.')
    expect(subtitleFormat('SRT')).toBe('srt')
    expect(subtitleFormat('.vtt')).toBe('vtt')
    expect(subtitleFormat('mov')).toBeNull()
    expect(() => parseSubtitleBytes(new Uint8Array(), 'mov')).toThrow('Unsupported subtitle file type “.mov”. Use SRT or WebVTT.')
  })
  it('decodes Latin-1 when the bytes are not UTF-8 and formats SRT timestamps', () => {
    expect(decodeSubtitleBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
    expect(srtTimestamp(3723.4567)).toBe('01:02:03,457')
  })
})

describe('TranscriptSearch', () => {
  it('parses terms stripping edge punctuation', () => {
    expect(searchTerms('  budget, meeting!  ')).toEqual(['budget', 'meeting'])
    expect(searchTerms("don't stop")).toEqual(["don't", 'stop'])
    expect(searchTerms('...')).toEqual([])
    expect(searchTerms('')).toEqual([])
  })
  it('matches all terms in any order', () => {
    const text = 'We reviewed the Q3 budget at the morning meeting.'
    expect(matchesTerms(text, ['budget', 'meeting'])).toBe(true)
    expect(matchesTerms(text, ['meeting', 'budget'])).toBe(true)
    expect(matchesTerms(text, ['budget', 'harbor'])).toBe(false)
  })
  it('is case and diacritic insensitive and matches partial words', () => {
    expect(matchesTerms('Visit the CAFÉ downtown', ['cafe'])).toBe(true)
    expect(matchesTerms('she was running fast', ['run'])).toBe(true)
  })
  it('searches assets in order and stops at the limit', () => {
    const tr = (texts: string[]): TranscriptionResult => ({ text: '', words: [], segments: texts.map((text, i) => ({ text, start: i, end: i + 1 })) })
    const assets = [
      { id: 'a', transcript: tr(['the budget', 'nothing', 'budget again']) },
      { id: 'b', transcript: null },
      { id: 'c', transcript: tr(['Budget!']) },
    ]
    expect(searchTranscripts('budget', assets).map((h) => [h.assetId, h.start])).toEqual([
      ['a', 0],
      ['a', 2],
      ['c', 0],
    ])
    expect(searchTranscripts('budget', assets, 2)).toHaveLength(2)
  })
})

describe('WordCutPlanner', () => {
  const words = (selected: number[]) =>
    [
      [0, 10],
      [11, 20],
      [21, 30],
      [31, 40],
    ].map(([s, e], i) => ({ startFrame: s, endFrame: e, selected: selected.includes(i) }))
  it('cuts a single word', () => expect(cutRanges(words([1]), 0, 100, 6)).toEqual([{ start: 11, end: 20 }]))
  it('cuts a contiguous run', () => expect(cutRanges(words([1, 2]), 0, 100, 6)).toEqual([{ start: 11, end: 30 }]))
  it('non-adjacent words yield two ranges', () => expect(cutRanges(words([0, 2]), 0, 100, 0)).toHaveLength(2))
  it('handles overlapping timestamps', () => {
    const ws = [
      { startFrame: 0, endFrame: 10, selected: false },
      { startFrame: 9, endFrame: 20, selected: true },
      { startFrame: 19, endFrame: 30, selected: false },
    ]
    expect(cutRanges(ws, 0, 100, 6)).toEqual([{ start: 9, end: 20 }])
  })
  it('removes most of a long surrounding pause, keeping half the gap on each side', () => {
    const ws = [
      { startFrame: 0, endFrame: 10, selected: false },
      { startFrame: 30, endFrame: 40, selected: true },
      { startFrame: 60, endFrame: 70, selected: false },
    ]
    expect(cutRanges(ws, 0, 100, 10)).toEqual([{ start: 15, end: 55 }])
    expect(cutRanges([{ startFrame: 30, endFrame: 40, selected: true }], 0, 100, 10)).toEqual([{ start: 5, end: 95 }])
    expect(cutRanges(ws, 50, 40, 10)).toEqual([])
    expect(KEPT_GAP_MS).toEqual({ tight: 60, balanced: 150, loose: 320 })
  })
})

describe('Transcript helpers', () => {
  const full: TranscriptionResult = {
    text: 'Hello there. How are you. Fine thanks.',
    language: 'en-US',
    words: [
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'there', start: 0.4, end: 0.8 },
      { text: 'How', start: 5, end: 5.2 },
      { text: 'are', start: 5.2, end: 5.5 },
      { text: 'you', start: 5.5, end: 5.8 },
      { text: 'Fine', start: 10, end: 10.4 },
      { text: 'thanks', start: 10.4, end: 10.9 },
    ],
    segments: [
      { text: 'Hello there.', start: 0, end: 0.8 },
      { text: 'How are you.', start: 5, end: 5.8 },
      { text: 'Fine thanks.', start: 10, end: 10.9 },
    ],
  }
  it('filter keeps only overlapping entries', () => {
    const w = filterToRange(full, 4, 6)
    expect(w.segments.map((s) => s.text)).toEqual(['How are you.'])
    expect(w.words.map((s) => s.text)).toEqual(['How', 'are', 'you'])
    expect(w.text).toBe('How are you.')
    expect(w.language).toBe('en-US')
  })
  it('filter includes boundary straddlers', () => {
    expect(filterToRange(full, 0.5, 5.2).segments.map((s) => s.text)).toEqual(['Hello there.', 'How are you.'])
  })
  it('round-trips through JSON with nil optionals omitted, keys in declaration order', () => {
    const r = normalizedResult({ text: 'a', words: [{ text: 'a', start: undefined, end: 1 }], segments: [{ text: 'a', start: 0, end: 1, speaker: undefined }], language: undefined })
    expect(JSON.stringify(r)).toBe('{"text":"a","words":[{"text":"a","end":1}],"segments":[{"text":"a","start":0,"end":1}]}')
    expect(JSON.parse(JSON.stringify(full))).toEqual(full)
  })
  it('offsetting shifts timed words and segments', () => {
    const r = offsetting({ text: 'x', words: [{ text: 'x', start: 1, end: 2 }, { text: 'y' }], segments: [{ text: 'x', start: 1, end: 2 }] }, 10)
    expect(r.words).toEqual([{ text: 'x', start: 11, end: 12 }, { text: 'y' }])
    expect(r.segments).toEqual([{ text: 'x', start: 11, end: 12 }])
    expect(offsetting(full, 0)).toBe(full)
  })
  it('error strings match the Mac', () => {
    expect(new TranscriptionError('unsupportedLocale', 'xx-YY').message).toBe('On-device transcription is not available for xx-YY.')
    expect(new TranscriptionError('modelInstallFailed', 'HTTP 404').message).toBe('Could not install the on-device speech model: HTTP 404')
    expect(new TranscriptionError('decodeFailed').message).toBe('Could not parse transcription result.')
    expect(new TranscriptionError('audioExtractionFailed', 'No audio track in a.mp4').message).toBe('Audio extraction failed: No audio track in a.mp4')
    expect(new TranscriptionError('analysisFailed', 'boom').message).toBe('Transcription failed: boom')
  })
})
