/** Argument parsing with the Mac's two styles: strict (Swift `Decodable`) and lenient (`[String: Any]`). */
import type { RGBA } from '../../../core/model'

export class ToolError extends Error {}

export type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validateUnknownKeys(entry: Obj, allowed: Iterable<string>, path: string): void {
  const allow = new Set(allowed)
  const unknown = Object.keys(entry).filter((k) => !allow.has(k)).sort()
  if (!unknown.length) return
  const list = allow.size ? [...allow].sort().join(', ') : 'none'
  throw new ToolError(`${path}: unknown field(s) '${unknown.join("', '")}'. Allowed: ${list}.`)
}

// ---------- Lenient accessors ----------

const parseSwiftInt = (s: string): number | undefined => (/^[+-]?\d+$/.test(s) ? Number(s) : undefined)
const parseSwiftDouble = (s: string): number | undefined => {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return undefined
  return Number(s)
}
const truncInt = (v: number): number | undefined => (Number.isFinite(v) && Math.abs(v) < 2 ** 63 ? Math.trunc(v) + 0 : undefined)

export const lenient = {
  string: (o: Obj, k: string): string | undefined => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : undefined),
  int: (o: Obj, k: string): number | undefined => {
    const v = o[k]
    if (typeof v === 'number') return truncInt(v)
    if (typeof v === 'string') return parseSwiftInt(v)
    return undefined
  },
  double: (o: Obj, k: string): number | undefined => {
    const v = o[k]
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseSwiftDouble(v)
    return undefined
  },
  bool: (o: Obj, k: string): boolean | undefined => {
    const v = o[k]
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (v === 'true') return true
    if (v === 'false') return false
    return undefined
  },
  stringArray: (o: Obj, k: string): string[] => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []),
  requireString: (o: Obj, k: string): string => {
    if (typeof o[k] !== 'string') throw new ToolError(`Missing required argument: ${k}`)
    return o[k] as string
  },
  requireInt: (o: Obj, k: string): number => {
    const v = lenient.int(o, k)
    if (v === undefined) throw new ToolError(`Missing required argument: ${k}`)
    return v
  },
}

/** Strict JSON integer for indexes and identifiers: no booleans, fractions or strings. */
export const exactInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined)

// ---------- Strict decoding ----------

export type TypeSpec = 'Int' | 'Double' | 'String' | 'Bool' | { arr: TypeSpec } | { obj: Fields } | { dict: TypeSpec }
export type Fields = Record<string, TypeSpec | { opt: TypeSpec }>

type Trail = (string | number)[]
const trailText = (t: Trail) => t.map((k) => (typeof k === 'number' ? `[${k}]` : `.${k}`)).join('')
const typeName = (s: TypeSpec) => (typeof s === 'string' ? s : 'arr' in s ? 'Array<Any>' : 'Dictionary<String, Any>')

function decodeValue(v: unknown, spec: TypeSpec, path: string, trail: Trail): unknown {
  const fail = (msg: string): never => {
    throw new ToolError(`${path}${trailText(trail)}: ${msg}`)
  }
  if (v === null || v === undefined) return fail(`missing required ${typeName(spec)} value`)
  const mismatch = () => fail(`expected ${typeName(spec)}, got something else`)
  switch (spec) {
    case 'Int':
      if (typeof v !== 'number') return mismatch()
      if (!Number.isInteger(v) || Math.abs(v) >= 2 ** 63) return fail(`Parsed JSON number <${v}> does not fit in Int.`)
      return v
    case 'Double':
      return typeof v === 'number' ? v : mismatch()
    case 'String':
      return typeof v === 'string' ? v : mismatch()
    case 'Bool':
      return typeof v === 'boolean' ? v : mismatch()
  }
  if ('arr' in spec) {
    if (!Array.isArray(v)) return mismatch()
    return v.map((x, i) => decodeValue(x, spec.arr, path, [...trail, i]))
  }
  if (!isObj(v)) return mismatch()
  if ('dict' in spec) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeValue(x, spec.dict, path, [...trail, k])]))
  return decodeFields(v, spec.obj, path, trail)
}

function decodeFields(o: Obj, fields: Fields, path: string, trail: Trail): Obj {
  const out: Obj = {}
  for (const [key, f] of Object.entries(fields)) {
    const optional = typeof f === 'object' && 'opt' in f
    const spec = optional ? (f as { opt: TypeSpec }).opt : (f as TypeSpec)
    const v = o[key]
    if (v === undefined || (optional && v === null)) {
      if (!optional) throw new ToolError(`${path}${trailText(trail)}: missing required field '${key}'`)
      continue
    }
    out[key] = decodeValue(v, spec, path, [...trail, key])
  }
  return out
}

/** `decodeToolArgs`: top-level unknown keys are refused, then fields decode in declaration order. */
export function decodeArgs<T>(args: Obj, path: string, fields: Fields, alsoAllowed: string[] = []): T {
  validateUnknownKeys(args, [...Object.keys(fields), ...alsoAllowed], path)
  return decodeFields(args, fields, path, []) as T
}

export const opt = (spec: TypeSpec) => ({ opt: spec })

// ---------- Shared value parsing ----------

/** `#RGB`, `#RRGGBB` or `#RRGGBBAA` (leading `#` optional). */
export function hexColor(hex: string): RGBA | null {
  let s = hex.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (!/^[0-9A-Fa-f]*$/.test(s)) return null
  const byte = (i: number, len: number) => parseInt(len === 1 ? s[i] + s[i] : s.slice(i, i + 2), 16) / 255
  if (s.length === 3) return { r: byte(0, 1), g: byte(1, 1), b: byte(2, 1), a: 1 }
  if (s.length === 6) return { r: byte(0, 2), g: byte(2, 2), b: byte(4, 2), a: 1 }
  if (s.length === 8) return { r: byte(0, 2), g: byte(2, 2), b: byte(4, 2), a: byte(6, 2) }
  return null
}

export function parseColor(hex: string, path: string): RGBA {
  const c = hexColor(hex)
  if (!c) throw new ToolError(`${path}: invalid color '${hex}'. Expected '#RGB', '#RRGGBB', or '#RRGGBBAA'.`)
  return c
}

export function hexString(c: RGBA): string {
  const b = [c.r, c.g, c.b, c.a].map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255))
  return `#${b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('')}`
}

