/** Color scope measurements over a 256×256 RGBA8 grid (no color management), as inspect_color reports them. */
import type { Rgba } from './images'

type RGB = [number, number, number]

export interface Scopes {
  lumaMean: number
  lumaBlack: number
  lumaWhite: number
  clipLow: number
  clipHigh: number
  lumaHistogram: number[]
  meanRGB: RGB
  blackRGB: RGB
  whiteRGB: RGB
  shadowRGB: RGB
  midRGB: RGB
  highRGB: RGB
  saturationMean: number
  warmCoolBias: number
  greenMagentaBias: number
  hueHistogram: number[]
  colorfulPct: number
}

export const SCOPE_GRID = 256

export function measureScopes(img: Rgba): Scopes {
  const count = img.width * img.height
  const rs = new Float32Array(count)
  const gs = new Float32Array(count)
  const bs = new Float32Array(count)
  const ys = new Float32Array(count)
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let sumY = 0
  let sumSat = 0
  const zones: RGB[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const zoneCounts = [0, 0, 0]
  let clipLow = 0
  let clipHigh = 0
  const hist = new Array(16).fill(0)
  const hueHist = new Array(12).fill(0)
  let hueWeight = 0
  let colorful = 0
  for (let i = 0; i < count; i++) {
    const r = img.data[i * 4] / 255
    const g = img.data[i * 4 + 1] / 255
    const b = img.data[i * 4 + 2] / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    rs[i] = r
    gs[i] = g
    bs[i] = b
    ys[i] = y
    sumR += r
    sumG += g
    sumB += b
    sumY += y
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const sat = mx > 0 ? (mx - mn) / mx : 0
    sumSat += sat
    if (sat > 0.15) {
      colorful++
      const d = mx - mn
      let h = 0
      if (d > 1e-6) {
        h = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d
        h /= 6
        if (h < 0) h += 1
      }
      hueHist[Math.min(11, Math.trunc(h * 12))] += sat
      hueWeight += sat
    }
    const zone = y < 1 / 3 ? 0 : y > 2 / 3 ? 2 : 1
    zones[zone][0] += r
    zones[zone][1] += g
    zones[zone][2] += b
    zoneCounts[zone]++
    if (y < 0.02) clipLow++
    if (y > 0.98) clipHigh++
    hist[Math.min(15, Math.trunc(y * 16))]++
  }
  for (const a of [rs, gs, bs, ys]) a.sort()
  const pct = (a: Float32Array, p: number) => a[Math.min(a.length - 1, Math.max(0, Math.trunc(p * (a.length - 1))))]
  const zoneMean = (z: number): RGB => (zoneCounts[z] ? (zones[z].map((v) => v / zoneCounts[z]) as RGB) : [0, 0, 0])
  const meanR = sumR / count
  const meanG = sumG / count
  const meanB = sumB / count
  return {
    lumaMean: sumY / count,
    lumaBlack: pct(ys, 0.02),
    lumaWhite: pct(ys, 0.98),
    clipLow: clipLow / count,
    clipHigh: clipHigh / count,
    lumaHistogram: hist.map((v) => v / count),
    meanRGB: [meanR, meanG, meanB],
    blackRGB: [pct(rs, 0.02), pct(gs, 0.02), pct(bs, 0.02)],
    whiteRGB: [pct(rs, 0.98), pct(gs, 0.98), pct(bs, 0.98)],
    shadowRGB: zoneMean(0),
    midRGB: zoneMean(1),
    highRGB: zoneMean(2),
    saturationMean: sumSat / count,
    warmCoolBias: meanR - meanB,
    greenMagentaBias: meanG - (meanR + meanB) / 2,
    hueHistogram: hueHist.map((v) => (hueWeight > 0 ? v / hueWeight : 0)),
    colorfulPct: colorful / count,
  }
}

const r3 = (v: number) => Number(v.toFixed(3)) + 0
const rgb = (v: RGB) => v.map(r3)

export function readout(s: Scopes): Record<string, unknown> {
  return {
    luma: { black: r3(s.lumaBlack), white: r3(s.lumaWhite), mean: r3(s.lumaMean), clipLowPct: r3(s.clipLow * 100), clipHighPct: r3(s.clipHigh * 100), histogram16: s.lumaHistogram.map(r3) },
    meanRGB: rgb(s.meanRGB),
    blackRGB: rgb(s.blackRGB),
    whiteRGB: rgb(s.whiteRGB),
    zones: { shadows: rgb(s.shadowRGB), mids: rgb(s.midRGB), highs: rgb(s.highRGB) },
    saturation: r3(s.saturationMean),
    balance: { warmCool: r3(s.warmCoolBias), greenMagenta: r3(s.greenMagentaBias) },
    hueHistogram12: s.hueHistogram.map(r3),
    colorfulPct: r3(s.colorfulPct * 100),
  }
}

/** Subject − reference for the key metrics, with hints mapped onto apply_color knobs. */
export function gap(c: Scopes, r: Scopes): Record<string, unknown> {
  const hints: string[] = []
  const db = c.lumaBlack - r.lumaBlack
  if (Math.abs(db) > 0.03) hints.push(db > 0 ? "blacks higher than ref → lower 'blacks' / deepen shadows" : "blacks lower than ref → raise 'blacks'")
  const dw = c.warmCoolBias - r.warmCoolBias
  if (Math.abs(dw) > 0.03) hints.push(dw > 0 ? "warmer than ref → cooler 'temperature'" : "cooler than ref → warmer 'temperature'")
  const dg = c.greenMagentaBias - r.greenMagentaBias
  if (Math.abs(dg) > 0.02) hints.push(dg > 0 ? "greener than ref → 'tint' toward magenta" : "more magenta than ref → 'tint' toward green")
  const ds = c.saturationMean - r.saturationMean
  if (Math.abs(ds) > 0.03) hints.push(ds > 0 ? "more saturated than ref → lower 'saturation'" : "less saturated than ref → raise 'saturation'")
  const diff = (a: RGB, b: RGB) => rgb([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
  return {
    lumaBlack: r3(db),
    lumaWhite: r3(c.lumaWhite - r.lumaWhite),
    lumaMean: r3(c.lumaMean - r.lumaMean),
    warmCool: r3(dw),
    greenMagenta: r3(dg),
    saturation: r3(ds),
    shadowsRGB: diff(c.shadowRGB, r.shadowRGB),
    midsRGB: diff(c.midRGB, r.midRGB),
    highsRGB: diff(c.highRGB, r.highRGB),
    hints,
  }
}
