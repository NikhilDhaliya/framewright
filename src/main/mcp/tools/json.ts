/** JSON output conventions of the Mac tool payloads: sorted keys, compact, floats rounded to 3 places. */

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = sorted(value[k])
    return out
  }
  return value
}

export function jsonString(value: unknown): string {
  return JSON.stringify(sorted(value))
}

/** Plain (half away from zero) rounding to 3 decimals, ignoring binary noise below 15 significant digits. */
export function round3(x: number): number {
  const scaled = Number((Math.abs(x) * 1000).toPrecision(15))
  return (Math.sign(x) * Math.round(scaled)) / 1000 + 0
}

export function roundFloats(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? (Number.isInteger(value) ? value : round3(value)) : null
  if (Array.isArray(value)) return value.map(roundFloats)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = roundFloats(v)
    return out
  }
  return value
}

/** Fixed-decimal number (e.g. transcript seconds), emitted without trailing zeros. */
export const fixed = (x: number, places: number): number => Number(x.toFixed(places))

/** Swift's `Double.description`: integral values keep a trailing `.0`. */
export function swiftDouble(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf'
  if (Object.is(v, -0)) return '-0.0'
  const abs = Math.abs(v)
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    const [mant, exp] = v.toExponential().split('e')
    const n = Number(exp)
    return `${mant}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`
  }
  return Number.isInteger(v) ? `${v}.0` : String(v)
}
