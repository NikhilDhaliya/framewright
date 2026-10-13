/**
 * Text layout and rasterisation with Canvas2D (spec 04 §9, TextFrameRenderer.swift / TextLayout.swift).
 * Rasters are canvas-positioned, straight sRGB; the compositor handles entrance transforms, effects,
 * rotation/tilt and blending.
 */
import { textStyleAt, transformAt } from '@core/clip'
import type { Clip, RGBA, TextAlignment, TextStyle } from '@core/model'
import type { TextBox } from '@core/ops/project'
import { cssFont, loadBundledFonts, resolveFont, type ResolvedFont } from './fonts'
import { clipEntry, renderMode, tokenize, tokenTimings, typewriterText, wordState, type ClipEntryState, type Token, type WordState } from './textAnim'
import type { TextMeasurer } from './types'

export const REFERENCE_HEIGHT = 1080
const SHADOW_PADDING = 12

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
const outset = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d })
const integral = (r: Rect): Rect => {
  const x = Math.floor(r.x)
  const y = Math.floor(r.y)
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y }
}

/** `TextStyle.scaledVisualStyle`: folds fontScale into every size. */
export function scaledVisualStyle(s: TextStyle): TextStyle {
  const k = s.fontScale
  if (k === 1) return s
  return {
    ...s,
    fontSize: s.fontSize * k,
    tracking: s.tracking * k,
    lineSpacing: s.lineSpacing * k,
    shadow: { ...s.shadow, offsetX: s.shadow.offsetX * k, offsetY: s.shadow.offsetY * k, blur: s.shadow.blur * k },
    border: { ...s.border, width: s.border.width * k },
    background: {
      ...s.background,
      paddingX: s.background.paddingX * k,
      paddingY: s.background.paddingY * k,
      cornerRadius: s.background.cornerRadius * k,
      offsetX: s.background.offsetX * k,
      offsetY: s.background.offsetY * k,
      outlineWidth: s.background.outlineWidth * k,
    },
    fontScale: 1,
  }
}

export const displayText = (text: string, s: TextStyle): string => (s.fontCase === 'uppercase' ? text.toUpperCase() : s.fontCase === 'lowercase' ? text.toLowerCase() : text)

const css = (c: RGBA) => `color(srgb ${c.r} ${c.g} ${c.b} / ${c.a})`

type Ctx2D = OffscreenCanvasRenderingContext2D

let measureCtx: Ctx2D | null = null
/** Font configuration currently applied to the shared measuring context. */
let measureTag = ''
function mctx(): Ctx2D {
  if (!measureCtx) measureCtx = new OffscreenCanvas(8, 8).getContext('2d')!
  return measureCtx
}

/** Font + metrics in canvas px for one style at one size. */
export interface FontState {
  font: ResolvedFont
  css: string
  px: number
  widthScale: number
  heightScale: number
  trackingPx: number
  ascent: number
  descent: number
  leading: number
  lineSpacingPx: number
  underlinePos: number
  underlineThick: number
  strikePos: number
  strikeThick: number
}

export function fontState(st: TextStyle, px: number): FontState {
  const font = resolveFont(st)
  const c = cssFont(font, px)
  const ws = st.widthScale > 0 ? st.widthScale : 1
  const hs = st.heightScale > 0 ? st.heightScale : 1
  let m = font.metrics
  if (!m) {
    // System fonts: metrics from the canvas, no line gap [APPROX].
    const ctx = mctx()
    ctx.font = cssFont(font, 100)
    measureTag = ''
    const tm = ctx.measureText('Hg')
    m = {
      ascent: (tm.fontBoundingBoxAscent || 80) / 100,
      descent: (tm.fontBoundingBoxDescent || 20) / 100,
      lineGap: 0,
      underlinePosition: -0.1,
      underlineThickness: 0.05,
      strikeoutPosition: 0.3,
      strikeoutSize: 0.05,
    }
  }
  // CoreText line metrics assumed to scale with heightScale (§9.4).
  return {
    font,
    css: c,
    px,
    widthScale: ws,
    heightScale: hs,
    trackingPx: st.tracking * (px / Math.max(1, st.fontSize)),
    ascent: m.ascent * px * hs,
    descent: m.descent * px * hs,
    leading: Math.max(0, m.lineGap) * px * hs,
    lineSpacingPx: st.lineSpacing * (px / Math.max(1, st.fontSize)),
    underlinePos: m.underlinePosition * px * hs,
    underlineThick: Math.max(1, m.underlineThickness * px * hs),
    strikePos: m.strikeoutPosition * px * hs,
    strikeThick: Math.max(1, m.strikeoutSize * px * hs),
  }
}

/** Advance width in canvas px, tracking after every character, widthScale applied. */
function measurer(fs: FontState): (s: string) => number {
  const ctx = mctx()
  const spacing = `${fs.trackingPx / fs.widthScale}px`
  const tag = `${fs.css}|${spacing}`
  const cache = new Map<string, number>()
  return (s: string) => {
    if (!s) return 0
    let w = cache.get(s)
    if (w === undefined) {
      if (measureTag !== tag) {
        ctx.font = fs.css
        ctx.letterSpacing = spacing
        measureTag = tag
      }
      w = ctx.measureText(s).width * fs.widthScale
      cache.set(s, w)
    }
    return w
  }
}

export interface Line {
  /** UTF-16 range in the laid-out content (trailing whitespace included). */
  start: number
  end: number
  text: string
  /** Typographic width without trailing whitespace. */
  width: number
}

const trimEnd = (s: string) => s.replace(/\s+$/u, '')
const PARAGRAPH = /\r\n|[\n\r\u2028\u2029]/g

/** Chunks ending at break opportunities: after whitespace runs and after word-internal hyphens. */
function chunks(p: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    cur += ch
    const next = p[i + 1]
    if (next === undefined) break
    const isWs = /\s/u.test(ch)
    if ((isWs && !/\s/u.test(next)) || (ch === '-' && !isWs && !/\s/u.test(next) && i > 0 && !/\s/u.test(p[i - 1]))) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur) out.push(cur)
  return out
}

const graphemes = (s: string): string[] => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (g) => g.segment)

/** Greedy UAX-14-style breaking of one paragraph; overlong words break at grapheme boundaries. */
function breakParagraph(p: string, offset: number, maxW: number, w: (s: string) => number, out: Line[]): void {
  if (!p) {
    out.push({ start: offset, end: offset, text: '', width: 0 })
    return
  }
  let cur = ''
  let curStart = offset
  const push = () => {
    out.push({ start: curStart, end: curStart + cur.length, text: cur, width: w(trimEnd(cur)) })
    curStart += cur.length
    cur = ''
  }
  for (const chunk of chunks(p)) {
    if (w(trimEnd(cur + chunk)) <= maxW + 1e-6) {
      cur += chunk
      continue
    }
    if (cur) push()
    if (w(trimEnd(chunk)) <= maxW + 1e-6) {
      cur = chunk
      continue
    }
    for (const g of graphemes(chunk)) {
      if (cur && w(trimEnd(cur + g)) > maxW + 1e-6 && trimEnd(cur + g) !== trimEnd(cur)) push()
      cur += g
    }
  }
  if (cur || out.length === 0) push()
}

export function breakLines(content: string, maxW: number, w: (s: string) => number): Line[] {
  const out: Line[] = []
  let offset = 0
  PARAGRAPH.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PARAGRAPH.exec(content))) {
    breakParagraph(content.slice(offset, m.index), offset, maxW, w, out)
    offset = m.index + m[0].length
  }
  breakParagraph(content.slice(offset), offset, maxW, w, out)
  return out
}

export interface PlacedLine extends Line {
  x: number
  baseline: number
}

export interface Layout {
  lines: PlacedLine[]
  fs: FontState
  measure: (s: string) => number
}

const lineHeight = (fs: FontState) => fs.ascent + fs.descent + fs.leading
const pitch = (fs: FontState) => lineHeight(fs) + Math.max(0, fs.lineSpacingPx)
const contentHeight = (n: number, fs: FontState) => Math.ceil(n * lineHeight(fs) + Math.max(0, n - 1) * Math.max(0, fs.lineSpacingPx))

/** CTFrame layout in `box`: vertically centred, overflowing lines dropped (§9.5). */
export function layoutText(content: string, fs: FontState, box: Rect, alignment: TextAlignment, sizingContent?: string): Layout {
  const measure = measurer(fs)
  const lines = breakLines(content, box.w, measure)
  const n = sizingContent === undefined ? lines.length : breakLines(sizingContent, box.w, measure).length
  const frameH = Math.min(box.h, contentHeight(n, fs))
  const frameTop = box.y + box.h / 2 - frameH / 2
  const placed: PlacedLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const baseline = frameTop + fs.ascent + i * pitch(fs)
    if (baseline + fs.descent > frameTop + frameH + 1e-3) break
    const l = lines[i]
    const x = alignment === 'left' ? box.x : alignment === 'right' ? box.x + box.w - l.width : box.x + (box.w - l.width) / 2
    placed.push({ ...l, x, baseline })
  }
  return { lines: placed, fs, measure }
}

/** Natural layout size without a box (CTFramesetterSuggestFrameSize). */
function suggestedSize(content: string, fs: FontState, maxW: number): { w: number; h: number } {
  const measure = measurer(fs)
  const lines = breakLines(content, maxW, measure)
  let w = 0
  for (const l of lines) w = Math.max(w, l.width)
  return { w, h: contentHeight(lines.length, fs) }
}

/** Natural normalized box for new / fit-to-content text clips (§9.12). */
export const textMeasurer: TextMeasurer = {
  measure(content: string, style: TextStyle, canvasWidth: number, canvasHeight: number): TextBox {
    if (!(canvasWidth > 0 && canvasHeight > 0)) return { width: 0, height: 0 }
    const vs = style.fontScale
    const st = scaledVisualStyle(style)
    const cs = canvasHeight / REFERENCE_HEIGHT
    const px = st.fontSize * cs
    if (!(px > 0)) return { width: 0, height: 0 }
    const measured = displayText(content, st) || ' '
    const maxW = 0.9 * canvasWidth * vs
    const bounding = suggestedSize(measured, fontState(st, px), Number.isFinite(maxW) ? maxW : Number.MAX_VALUE)
    const slack = Math.max(0, vs) * 4
    const shadowBlur = Math.max(0, st.shadow.blur)
    const shadowX = st.shadow.enabled ? Math.max(SHADOW_PADDING * vs, shadowBlur + Math.abs(st.shadow.offsetX)) * cs * 2 : 0
    const shadowY = st.shadow.enabled ? Math.max(SHADOW_PADDING * vs, shadowBlur + Math.abs(st.shadow.offsetY)) * cs * 2 : 0
    const borderP = st.border.enabled ? glyphBorderPadding(st, px) * 2 : 0
    const bgX = st.background.enabled ? Math.max(0, st.background.paddingX) * cs * 2 : 0
    const bgY = st.background.enabled ? Math.max(0, st.background.paddingY) * cs * 2 : 0
    const w = Math.max(1, Math.ceil(bounding.w) + shadowX + borderP + bgX + slack)
    const h = Math.max(1, Math.ceil(bounding.h) + shadowY + borderP + bgY + slack)
    return { width: w / canvasWidth, height: h / canvasHeight }
  },
}

const glyphBorderPadding = (st: TextStyle, px: number) => Math.ceil((px * Math.max(0, st.border.width)) / Math.max(1, st.fontSize))
const drawsGlyphOutline = (st: TextStyle) => st.border.enabled && st.border.width > 0 && st.color.a >= 1

export type TextRasterMode = 'normal' | 'inverted' | 'mask'

export interface TextRaster {
  /** Cache key: identical keys rasterise to identical pixels. */
  key: string
  /** Raster rect in canvas px (integral). */
  rect: Rect
  /** Clip box in canvas px (entrance pivot). */
  box: Rect
  /** Whole-raster entrance transform (popIn / slideUp), applied by the compositor. */
  entrance: ClipEntryState | null
  draw(): OffscreenCanvas
}

interface Prepared {
  style: TextStyle
  content: string
  px: number
  s: number
  box: Rect
  textBox: Rect
  rect: Rect
}

function prepare(clip: Clip, f: number, W: number, H: number, mode: TextRasterMode): Prepared | null {
  if (W < 1 || H < 1) return null
  let base = textStyleAt(clip, f)
  if (mode === 'inverted') {
    base = {
      ...base,
      color: { r: 1, g: 1, b: 1, a: 1 },
      border: { ...base.border, enabled: false },
      shadow: { ...base.shadow, enabled: false },
      background: { ...base.background, color: { ...base.background.color, a: 0 }, outlineColor: { ...base.background.outlineColor, a: 0 } },
    }
  } else if (mode === 'mask') base = { ...base, color: { r: 1, g: 1, b: 1, a: 1 } }
  const style = { ...scaledVisualStyle(base), blur: 0 }
  const content = displayText(clip.textContent ?? '', style)
  if (!content) return null
  const s = H / REFERENCE_HEIGHT
  const px = style.fontSize * s
  if (!(px > 0) || !Number.isFinite(px)) return null
  const t = transformAt(clip, f)
  const box: Rect = { x: (t.centerX - t.width / 2) * W, y: (t.centerY - t.height / 2) * H, w: Math.max(1, t.width * W), h: Math.max(1, t.height * H) }
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return null
  let textBox = box
  const bg = style.background
  if (bg.enabled) {
    const dx = Math.max(0, bg.paddingX * s)
    const dy = Math.max(0, bg.paddingY * s)
    const inset = { x: box.x + dx, y: box.y + dy, w: box.w - 2 * dx, h: box.h - 2 * dy }
    textBox = inset.w >= 1 && inset.h >= 1 ? inset : { x: box.x + box.w / 2 - 0.5, y: box.y + box.h / 2 - 0.5, w: 1, h: 1 }
  }
  let r = union(textBox, box)
  if (bg.enabled) r = union(r, outset({ x: box.x + bg.offsetX * s, y: box.y + bg.offsetY * s, w: box.w, h: box.h }, (Math.max(0, bg.outlineWidth) * s) / 2))
  if (style.border.enabled && style.border.width > 0) r = outset(r, glyphBorderPadding(style, px))
  const anim = clip.textAnimation
  const rm = anim && anim.preset !== 'none' ? renderMode(anim.preset) : null
  if (rm && rm !== 'entrance') r = outset(r, px)
  if (style.shadow.enabled) {
    const b = Math.max(0, style.shadow.blur * s)
    const dx = style.shadow.offsetX * s
    const dy = style.shadow.offsetY * s
    r = { x: r.x + Math.min(0, dx) - b, y: r.y + Math.min(0, dy) - b, w: r.w + Math.abs(dx) + 2 * b, h: r.h + Math.abs(dy) + 2 * b }
  }
  r = integral(outset(r, 2))
  // Bound memory for text far off-canvas [APPROX]: macOS keeps the whole raster.
  const lim = Math.ceil(Math.max(W, H))
  const x1 = Math.max(r.x, -lim)
  const y1 = Math.max(r.y, -lim)
  r = { x: x1, y: y1, w: Math.min(r.x + r.w, Math.ceil(W) + lim) - x1, h: Math.min(r.y + r.h, Math.ceil(H) + lim) - y1 }
  if (r.w < 1 || r.h < 1) return null
  return { style, content, px, s, box, textBox, rect: r }
}

const q64 = (v: number) => Math.round(v * 64)

/** Raster description for a text clip at timeline frame `f` on a `W × H` canvas, or null when nothing draws. */
export function textRaster(clip: Clip, f: number, W: number, H: number, mode: TextRasterMode = 'normal'): TextRaster | null {
  const p = prepare(clip, f, W, H, mode)
  if (!p) return null
  const { style, content, rect } = p
  const anim = clip.textAnimation
  const rm = anim && anim.preset !== 'none' ? renderMode(anim.preset) : null
  const rel = f - clip.startFrame
  let state = ''
  let draw: (ctx: Ctx2D) => void
  if (rm === 'perWord' && anim) {
    const tokens = tokenize(content)
    const timings = tokenTimings(tokens, clip.wordTimings, clip.durationFrames)
    const states = timings.map((w, i) => wordState(anim, w, timings[i + 1], rel, style.color))
    state = JSON.stringify(states)
    draw = (ctx) => drawPerWord(ctx, p, tokens, states)
  } else if (rm === 'typewriter') {
    const tokens = tokenize(content)
    const timings = tokenTimings(tokens, clip.wordTimings, clip.durationFrames)
    const visible = typewriterText(content, tokens, timings, rel, clip.durationFrames)
    state = `tw:${visible}`
    draw = (ctx) => {
      if (visible) drawStatic(ctx, p, visible, 'left', content)
    }
  } else {
    draw = (ctx) => drawStatic(ctx, p, content, style.alignment)
  }
  const key = [
    content,
    JSON.stringify(style),
    q64(p.textBox.x - rect.x), q64(p.textBox.y - rect.y), q64(p.textBox.w), q64(p.textBox.h),
    q64(p.box.x - rect.x), q64(p.box.y - rect.y), q64(p.box.w), q64(p.box.h),
    rect.w, rect.h, W, H, state,
  ].join('|')
  return {
    key,
    rect,
    box: p.box,
    entrance: rm === 'entrance' && anim ? clipEntry(anim, rel) : null,
    draw: () => {
      const canvas = new OffscreenCanvas(rect.w, rect.h)
      const ctx = canvas.getContext('2d')!
      ctx.translate(-rect.x, -rect.y)
      drawBackgroundBox(ctx, p)
      const layer = new OffscreenCanvas(rect.w, rect.h)
      const g = layer.getContext('2d')!
      g.translate(-rect.x, -rect.y)
      draw(g)
      const sh = style.shadow
      if (sh.enabled) {
        ctx.shadowColor = css(sh.color)
        ctx.shadowBlur = Math.max(0, sh.blur * p.s)
        ctx.shadowOffsetX = sh.offsetX * p.s
        ctx.shadowOffsetY = sh.offsetY * p.s
      }
      ctx.drawImage(layer, rect.x, rect.y)
      return canvas
    },
  }
}

function roundRect(ctx: Ctx2D, r: Rect, radius: number): void {
  ctx.beginPath()
  if (radius > 0) ctx.roundRect(r.x, r.y, r.w, r.h, radius)
  else ctx.rect(r.x, r.y, r.w, r.h)
}

function drawBackgroundBox(ctx: Ctx2D, p: Prepared): void {
  const bg = p.style.background
  if (!bg.enabled) return
  const rect = { x: p.box.x + bg.offsetX * p.s, y: p.box.y + bg.offsetY * p.s, w: p.box.w, h: p.box.h }
  const radius = Math.min(Math.max(0, bg.cornerRadius * p.s), Math.min(rect.w, rect.h) / 2)
  if (bg.color.a > 0) {
    roundRect(ctx, rect, radius)
    ctx.fillStyle = css(bg.color)
    ctx.fill()
  }
  if (bg.outlineWidth > 0 && bg.outlineColor.a > 0) {
    roundRect(ctx, rect, radius)
    ctx.strokeStyle = css(bg.outlineColor)
    ctx.lineWidth = bg.outlineWidth * p.s
    ctx.stroke()
  }
}

interface GlyphRun {
  text: string
  x: number
  baseline: number
}

/** Stroke widths are given in canvas px; the run is drawn in a widthScale × heightScale space [APPROX]. */
function strokeScale(fs: FontState): number {
  return Math.sqrt(fs.widthScale * fs.heightScale)
}

function runText(g: Ctx2D, fs: FontState, run: GlyphRun, op: (g: Ctx2D) => void): void {
  g.save()
  g.translate(run.x, run.baseline)
  g.scale(fs.widthScale, fs.heightScale)
  g.font = fs.css
  g.letterSpacing = `${fs.trackingPx / fs.widthScale}px`
  g.textBaseline = 'alphabetic'
  g.textAlign = 'left'
  op(g)
  g.restore()
}

function undercoat(g: Ctx2D, fs: FontState, st: TextStyle, s: number, run: GlyphRun): void {
  runText(g, fs, run, (c) => {
    c.lineJoin = 'round'
    c.lineWidth = (2 * st.border.width * s) / strokeScale(fs)
    c.strokeStyle = css(st.border.color)
    c.strokeText(run.text, 0, 0)
  })
}

function fill(g: Ctx2D, fs: FontState, st: TextStyle, s: number, run: GlyphRun, color: RGBA): void {
  runText(g, fs, run, (c) => {
    c.fillStyle = css(color)
    c.fillText(run.text, 0, 0)
    if (!drawsGlyphOutline(st) && st.border.enabled && st.border.width > 0) {
      c.lineJoin = 'miter'
      c.miterLimit = 10
      c.lineWidth = (st.border.width * s) / strokeScale(fs)
      c.strokeStyle = css(st.border.color)
      c.strokeText(run.text, 0, 0)
    }
  })
}

function decorations(g: Ctx2D, fs: FontState, st: TextStyle, x: number, baseline: number, width: number, color: RGBA): void {
  if (width <= 0) return
  g.fillStyle = css(color)
  if (st.isUnderlined) g.fillRect(x, baseline - fs.underlinePos - fs.underlineThick / 2, width, fs.underlineThick)
  if (st.isStruckThrough) g.fillRect(x, baseline - fs.strikePos, width, fs.strikeThick)
  if (st.isOverlined) {
    const th = fs.underlineThick
    g.fillRect(x, baseline - fs.ascent, width, th)
  }
}

function drawStatic(g: Ctx2D, p: Prepared, content: string, alignment: TextAlignment, sizingContent?: string): void {
  const st = p.style
  const fs = fontState(st, p.px)
  const layout = layoutText(content, fs, p.textBox, alignment, sizingContent)
  const runs = layout.lines.map((l) => ({ text: l.text, x: l.x, baseline: l.baseline }))
  if (drawsGlyphOutline(st)) for (const r of runs) undercoat(g, fs, st, p.s, r)
  for (const r of runs) fill(g, fs, st, p.s, r, st.color)
  for (const l of layout.lines) decorations(g, fs, st, l.x, l.baseline, l.width, st.color)
}

function drawPerWord(g: Ctx2D, p: Prepared, tokens: Token[], states: WordState[]): void {
  const st = p.style
  const fs = fontState(st, p.px)
  const layout = layoutText(p.content, fs, p.textBox, st.alignment)
  interface Placement {
    tok: Token
    state: WordState
    penX: number
    penW: number
    baseline: number
  }
  const placements: Placement[] = []
  tokens.forEach((tok, i) => {
    const state = states[i]
    if (!state || state.opacity <= 0) return
    const line = layout.lines.find((l) => tok.start >= l.start && tok.start < l.end)
    if (!line) return
    const startOff = layout.measure(line.text.slice(0, tok.start - line.start))
    const endOff = layout.measure(line.text.slice(0, tok.start + tok.length - line.start))
    placements.push({ tok, state, penX: line.x + startOff, penW: endOff - startOff, baseline: line.baseline })
  })
  const withState = (pl: Placement, draw: () => void) => {
    g.save()
    g.globalAlpha = pl.state.opacity
    const cx = pl.penX + pl.penW / 2
    const cy = pl.baseline - 0.35 * p.px
    g.translate(0, pl.state.dy * p.px)
    g.translate(cx, cy)
    g.scale(pl.state.scale, pl.state.scale)
    g.translate(-cx, -cy)
    draw()
    g.restore()
  }
  for (const pl of placements) {
    const bg = pl.state.bg
    if (!bg || bg.a <= 0.001) continue
    withState(pl, () => {
      roundRect(g, { x: pl.penX - 0.18 * p.px, y: pl.baseline - fs.ascent - 0.1 * p.px, w: pl.penW + 0.36 * p.px, h: fs.ascent + fs.descent + 0.2 * p.px }, 0.12 * p.px)
      g.fillStyle = css(bg)
      g.fill()
    })
  }
  if (drawsGlyphOutline(st)) for (const pl of placements) withState(pl, () => undercoat(g, fs, st, p.s, { text: pl.tok.text, x: pl.penX, baseline: pl.baseline }))
  for (const pl of placements) {
    withState(pl, () => {
      fill(g, fs, st, p.s, { text: pl.tok.text, x: pl.penX, baseline: pl.baseline }, pl.state.color)
      decorations(g, fs, st, pl.penX, pl.baseline, pl.penW, pl.state.color)
    })
  }
}

/** Starts loading bundled fonts as soon as the text module is used. */
export const fontsReady: Promise<void> = typeof FontFace === 'undefined' ? Promise.resolve() : loadBundledFonts()
