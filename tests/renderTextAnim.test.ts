import { describe, expect, it } from 'vitest'
import type { TextAnimation } from '../src/core/model'
import { clipEntry, tokenize, tokenTimings, typewriterText, wordState } from '../src/renderer/render/textAnim'

const anim = (preset: TextAnimation['preset'], extra: Partial<TextAnimation> = {}): TextAnimation => ({ preset, perWordFrames: 6, ...extra })
const white = { r: 1, g: 1, b: 1, a: 1 }

describe('text animation timing (§9.8)', () => {
  it('tokenizes on whitespace with UTF-16 ranges', () => {
    expect(tokenize('  Hi there\nyou 🎉')).toEqual([
      { start: 2, length: 2, text: 'Hi' },
      { start: 5, length: 5, text: 'there' },
      { start: 11, length: 3, text: 'you' },
      { start: 15, length: 2, text: '🎉' },
    ])
  })

  it('splits evenly without word timings, zips equal counts, aligns differing counts', () => {
    const toks = tokenize('one two three')
    expect(tokenTimings(toks, undefined, 10).map((t) => [t.startFrame, t.endFrame])).toEqual([[0, 3], [3, 6], [6, 10]])
    expect(tokenTimings(toks, [{ text: 'one', startFrame: -2, endFrame: 4 }, { text: 'two', startFrame: 4, endFrame: 3 }, { text: 'three', startFrame: 5, endFrame: 99 }], 20).map((t) => [t.startFrame, t.endFrame])).toEqual([[0, 4], [4, 4], [5, 20]])
    const merged = tokenTimings(tokenize("don't stop"), [{ text: 'don', startFrame: 0, endFrame: 4 }, { text: "'t", startFrame: 4, endFrame: 8 }, { text: 'stop', startFrame: 8, endFrame: 12 }], 20)
    expect(merged.map((t) => [t.startFrame, t.endFrame])).toEqual([[0, 8], [8, 12]])
    const split = tokenTimings(tokenize('new york'), [{ text: 'New York', startFrame: 2, endFrame: 10 }], 20)
    expect(split.map((t) => [t.startFrame, t.endFrame])).toEqual([[2, 6], [6, 10]])
  })

  it('entrance presets ease opacity, scale and offset', () => {
    expect(clipEntry(anim('popIn'), 0)).toEqual({ opacity: 0, scale: 0.6, dy: 0 })
    expect(clipEntry(anim('popIn'), 3).opacity).toBeCloseTo(0.5)
    expect(clipEntry(anim('slideUp'), 6)).toEqual({ opacity: 1, scale: 1, dy: 0 })
  })

  it('per-word states: reveal, slide, held highlights', () => {
    const w = { text: 'a', startFrame: 10, endFrame: 20 }
    const next = { text: 'b', startFrame: 20, endFrame: 30 }
    expect(wordState(anim('wordReveal'), w, next, 10, white).opacity).toBe(0)
    expect(wordState(anim('wordSlide'), w, next, 13, white).dy).toBeCloseTo(0.25)
    const hl = { r: 1, g: 0, b: 0, a: 1 }
    expect(wordState(anim('highlightPop', { highlight: hl }), w, next, 15, white).color).toEqual(hl)
    expect(wordState(anim('highlightPop', { highlight: hl }), w, next, 25, white).color).toEqual(white)
    expect(wordState(anim('highlightBlock'), w, next, 15, white).bg?.a).toBe(1)
  })

  it('typewriter reveals characters, holds the last word and blinks a caret', () => {
    const content = 'ab cd'
    const toks = tokenize(content)
    const tm = tokenTimings(toks, undefined, 60)
    expect(typewriterText(content, toks, tm, 0, 60)).toBe('|')
    expect(typewriterText(content, toks, tm, 16, 60)).toBe('a')
    expect(typewriterText(content, toks, tm, 59, 60)).toBe('ab cd')
    const emoji = '🎉🎉'
    const et = tokenize(emoji)
    const et5 = [{ text: emoji, startFrame: 0, endFrame: 5 }]
    expect(typewriterText(emoji, et, et5, 1, 60)).toBe('|')
    expect(typewriterText(emoji, et, et5, 2, 60)).toBe('🎉|')
  })
})
