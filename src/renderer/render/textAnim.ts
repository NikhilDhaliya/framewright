/** Text animation timing (spec 04 §9.8, TextAnimator.swift / TextFrameRenderer.swift). Pure. */
import { smoothstep } from '@core/keyframes'
import type { RGBA, TextAnimation, TextAnimationPreset, WordTiming } from '@core/model'

export type RenderMode = 'entrance' | 'perWord' | 'typewriter'

export function renderMode(p: TextAnimationPreset): RenderMode | null {
  switch (p) {
    case 'popIn':
    case 'slideUp':
      return 'entrance'
    case 'typewriter':
      return 'typewriter'
    case 'wordReveal':
    case 'wordSlide':
    case 'highlightPop':
    case 'highlightBlock':
      return 'perWord'
    default:
      return null
  }
}

export const HIGHLIGHT_DEFAULT: RGBA = { r: 1, g: 0.85, b: 0, a: 1 }

const linear = (rel: number, start: number, dur: number) => (rel <= start ? 0 : rel >= start + dur ? 1 : (rel - start) / dur)
const progress = (rel: number, start: number, dur: number) => smoothstep(linear(rel, start, dur))

function rampDuration(w: WordTiming, max: number): number | null {
  const span = w.endFrame - w.startFrame
  return span > 1 ? Math.min(Math.max(1, max), Math.max(1, Math.trunc(span / 2))) : null
}

function activeRamp(rel: number, w: WordTiming, ramp: number): number {
  if (rel < w.startFrame || rel >= w.endFrame) return 0
  const r = rampDuration(w, ramp)
  if (r === null) return 1
  return Math.min(smoothstep(Math.min(1, (rel - w.startFrame) / r)), smoothstep(Math.min(1, (w.endFrame - rel) / r)))
}

function heldHighlight(rel: number, w: WordTiming, next: WordTiming | undefined, ramp: number): number {
  if (rel < w.startFrame) return 0
  const d = rampDuration(w, ramp)
  const rampIn = d === null ? 1 : smoothstep(Math.min(1, (rel - w.startFrame) / d))
  if (!next || rel < next.startFrame) return rampIn
  const dn = rampDuration(next, ramp)
  if (dn === null) return 0
  return Math.min(rampIn, smoothstep(1 - Math.min(1, (rel - next.startFrame) / dn)))
}

export function lerpRGBA(a: RGBA, b: RGBA, t: number): RGBA {
  const k = Math.min(1, Math.max(0, t))
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k }
}

export interface ClipEntryState {
  opacity: number
  scale: number
  /** Fraction of render height, positive = down. */
  dy: number
}

export function clipEntry(anim: TextAnimation, rel: number): ClipEntryState {
  const t = progress(rel, 0, Math.max(1, anim.perWordFrames))
  if (anim.preset === 'popIn') return { opacity: t, scale: 0.6 + 0.4 * t, dy: 0 }
  if (anim.preset === 'slideUp') return { opacity: t, scale: 1, dy: 0.05 * (1 - t) }
  return { opacity: 1, scale: 1, dy: 0 }
}

export interface WordState {
  opacity: number
  scale: number
  /** Fraction of the font size, positive = down. */
  dy: number
  color: RGBA
  bg?: RGBA
}

export function wordState(anim: TextAnimation, w: WordTiming, next: WordTiming | undefined, rel: number, base: RGBA): WordState {
  const hl = anim.highlight ?? HIGHLIGHT_DEFAULT
  const hand = Math.max(1, anim.perWordFrames)
  const tint = () => (anim.highlight ? lerpRGBA(base, anim.highlight, activeRamp(rel, w, hand)) : base)
  switch (anim.preset) {
    case 'wordReveal':
      return { opacity: progress(rel, w.startFrame, hand), scale: 1, dy: 0, color: tint() }
    case 'wordSlide': {
      const t = progress(rel, w.startFrame, hand)
      return { opacity: t, scale: 1, dy: 0.5 * (1 - t), color: tint() }
    }
    case 'highlightPop':
      return { opacity: 1, scale: 1, dy: 0, color: lerpRGBA(base, hl, heldHighlight(rel, w, next, Math.min(hand, 4))) }
    case 'highlightBlock':
      return { opacity: 1, scale: 1, dy: 0, color: base, bg: { ...hl, a: hl.a * heldHighlight(rel, w, next, Math.min(hand, 4)) } }
    default:
      return { opacity: 1, scale: 1, dy: 0, color: base }
  }
}

export interface Token {
  /** UTF-16 offset into the content. */
  start: number
  length: number
  text: string
}

const isSpaceUnit = (u: number) =>
  (u >= 0x09 && u <= 0x0d) || u === 0x20 || u === 0x85 || u === 0xa0 || u === 0x1680 || (u >= 0x2000 && u <= 0x200a) || u === 0x2028 || u === 0x2029 || u === 0x202f || u === 0x205f || u === 0x3000

/** Maximal runs of non-whitespace UTF-16 units (a lone surrogate counts as non-space). */
export function tokenize(content: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < content.length) {
    while (i < content.length && isSpaceUnit(content.charCodeAt(i))) i++
    if (i >= content.length) break
    const start = i
    while (i < content.length && !isSpaceUnit(content.charCodeAt(i))) i++
    out.push({ start, length: i - start, text: content.slice(start, i) })
  }
  return out
}

function evenTimings(tokens: Token[], duration: number): WordTiming[] {
  const d = Math.max(0, duration)
  const n = Math.max(1, tokens.length)
  return tokens.map((t, i) => ({ text: t.text, startFrame: Math.trunc((d * i) / n), endFrame: Math.trunc((d * (i + 1)) / n) }))
}

function clamped(w: WordTiming, text: string, duration: number): WordTiming {
  const maxFrame = Math.max(0, duration)
  const start = Math.min(Math.max(0, w.startFrame), maxFrame)
  return { text, startFrame: start, endFrame: Math.min(Math.max(start, w.endFrame), maxFrame) }
}

const normalized = (s: string) => {
  let out = ''
  for (const ch of s) if (/[\p{L}\p{M}\p{N}]/u.test(ch)) out += ch.toLowerCase()
  return out
}

function aligned(tokens: Token[], words: WordTiming[], duration: number): WordTiming[] | null {
  const result: WordTiming[] = []
  let ti = 0
  let wi = 0
  while (ti < tokens.length && wi < words.length) {
    let te = ti
    let we = wi
    let tText = ''
    let wText = ''
    let found = false
    while (te < tokens.length || we < words.length) {
      const appendToken = we >= words.length ? true : te >= tokens.length ? false : [...tText].length <= [...wText].length
      if (appendToken) tText += normalized(tokens[te++].text)
      else wText += normalized(words[we++].text)
      if (tText && tText === wText) {
        found = true
        break
      }
    }
    if (!found) return null
    const tCount = te - ti
    const wCount = we - wi
    if (tCount === wCount) {
      for (let k = 0; k < tCount; k++) result.push(clamped(words[wi + k], tokens[ti + k].text, duration))
    } else {
      const maxFrame = Math.max(0, duration)
      const start = Math.min(Math.max(0, words[wi].startFrame), maxFrame)
      const end = Math.min(Math.max(start, words[we - 1].endFrame), maxFrame)
      const span = Math.max(0, end - start)
      for (let k = 0; k < tCount; k++) {
        const s = start + Math.trunc((span * k) / tCount)
        const e = k === tCount - 1 ? end : start + Math.trunc((span * (k + 1)) / tCount)
        result.push({ text: tokens[ti + k].text, startFrame: s, endFrame: e })
      }
    }
    ti = te
    wi = we
  }
  return ti === tokens.length && wi === words.length && result.length === tokens.length ? result : null
}

/** One timing per token, aligning transcript words when counts differ (§9.8). */
export function tokenTimings(tokens: Token[], words: WordTiming[] | undefined, duration: number): WordTiming[] {
  if (!tokens.length) return []
  if (!words?.length) return evenTimings(tokens, duration)
  if (words.length === tokens.length) return tokens.map((t, i) => clamped(words[i], t.text, duration))
  return aligned(tokens, words, duration) ?? evenTimings(tokens, duration)
}

const TYPEWRITER_HOLD = 18

/** Largest grapheme boundary ≤ `i`, so a reveal never splits a cluster [QUIRK Q13 fixed]. */
function graphemeFloor(s: string, i: number): number {
  if (i <= 0 || i >= s.length) return i
  let best = 0
  for (const seg of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) {
    if (seg.index > i) break
    best = seg.index
  }
  return best
}

/** Visible prefix (with blinking caret) for the typewriter preset at clip-relative frame `rel`. */
export function typewriterText(content: string, tokens: Token[], timings: WordTiming[], rel: number, duration: number): string {
  let visLen = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const tm = timings[i]
    let revealEnd = tm.endFrame
    if (i === tokens.length - 1 && tm.endFrame > tm.startFrame) {
      const desiredHold = Math.min(TYPEWRITER_HOLD, Math.max(1, Math.trunc(duration / 3)))
      const existingHold = Math.max(1, duration - tm.endFrame + 1)
      const span = tm.endFrame - tm.startFrame
      const minReveal = Math.min(span - 1, tok.length) + 1
      const extraHold = Math.min(Math.max(0, desiredHold - existingHold), span - minReveal)
      revealEnd = Math.max(tm.startFrame + 1, tm.endFrame - extraHold)
    }
    if (rel >= revealEnd) {
      visLen = tok.start + tok.length
      continue
    }
    if (rel >= tm.startFrame) {
      const span = revealEnd - tm.startFrame
      const p = span === 1 ? 1 : (rel - tm.startFrame) / (span - 1)
      visLen = tok.start + Math.floor(tok.length * p)
    }
    break
  }
  let visible = content.slice(0, graphemeFloor(content, Math.min(visLen, content.length)))
  const doneAt = timings.length ? timings[timings.length - 1].endFrame : duration
  if (rel <= doneAt + TYPEWRITER_HOLD && Math.trunc(rel / 15) % 2 === 0) visible += '|'
  return visible
}
