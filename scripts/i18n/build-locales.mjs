#!/usr/bin/env node
/**
 * Builds resources/locales/*.json from the Mac's Localizable.strings (parity gap 16). Repeatable and mechanical:
 *
 *   1. Extract every literal key passed to t / tm / tk / plural / tmPlural in src/ → resources/locales/en.json
 *      (English is the source of truth: key = the current UI string).
 *   2. Parse <mac>/Resources/Localization/<id>.lproj/Localizable.strings and normalise each pair the way
 *      src/shared/i18n.ts expects: `%@`/`%lld`… → `{0}`, `{1}`… (in order), `%%` → `%`, "Palmier Pro"/"Palmier" → `{app}`.
 *   3. For each English key take the Mac translation of the same key; else of its typographic twin (straight vs curly
 *      quotes, "..." vs "…"); else of an alias in scripts/i18n/aliases.json (Linux wording with the same meaning,
 *      optional value rewrites such as ⌘Z → Ctrl+Z). Otherwise the key stays English and is listed in the report.
 *   4. Write resources/locales/<id>.json (translated keys only) and docs/i18n-coverage.md.
 *
 * Usage: node scripts/i18n/build-locales.mjs [--mac <palmier-pro source root>] [--check]
 *   --check: exit 1 if en.json is out of date with the sources (nothing is written).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
// Mac Localizable.strings (Palmier Pro v0.7.6, GPLv3) are vendored in resources/i18n/mac-v0.7.6; --mac reads a source checkout instead.
const macArg = argValue('--mac')
const lprojDir = macArg
  ? path.join(path.resolve(macArg.replace(/^~/, os.homedir())), 'Sources/PalmierPro/Resources/Localization')
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '../../resources/i18n/mac-v0.7.6')
const outDir = path.join(root, 'resources/locales')
const reportPath = path.join(root, 'docs/i18n-coverage.md')
const LOCALES = ['ar', 'bn', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'id', 'it', 'ja', 'ko', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-Hans', 'zh-Hant']

// ---------------------------------------------------------------- 1. extraction (also used by tests/i18n)

export const KEY_FUNCS = ['t', 'tm', 'tk']
export const PLURAL_FUNCS = ['plural', 'tmPlural']

/** Reads one JS string literal starting at s[i] (a quote); returns { value, end } or null for template literals with ${}. */
function readString(s, i) {
  const q = s[i]
  let j = i + 1
  let out = ''
  while (j < s.length && s[j] !== q) {
    if (s[j] === '\\') {
      const c = s[j + 1]
      if (c === 'n') out += '\n'
      else if (c === 't') out += '\t'
      else if (c === 'u') {
        if (s[j + 2] === '{') {
          const close = s.indexOf('}', j)
          out += String.fromCodePoint(parseInt(s.slice(j + 3, close), 16))
          j = close + 1
          continue
        }
        out += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16))
        j += 6
        continue
      } else if (c === '\n') out += ''
      else out += c
      j += 2
      continue
    }
    if (q === '`' && s[j] === '$' && s[j + 1] === '{') return { value: null, end: j }
    out += s[j]
    j++
  }
  return { value: out, end: j + 1 }
}

/** Skips one argument expression starting at i; returns the index of the ',' or ')' that ends it. */
function skipArg(s, i) {
  let depth = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') {
      i = readString(s, i).end
      if (c === '`') {
        // template with ${}: skip to the closing backtick naively
        while (i < s.length && s[i] !== '`') i++
        i++
      }
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i
      depth--
    } else if (c === ',' && depth === 0) return i
    i++
  }
  return i
}

const ws = (s, i) => {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

/**
 * Finds translation calls in one source file. Returns { keys: [{key, line}], dynamic: [{fn, line}] } where
 * `dynamic` lists calls whose key isn't a plain literal (allowed for t(variable), reported for template literals).
 */
export function extractFromSource(src) {
  const keys = []
  const bad = []
  const re = new RegExp(`(?<![\\w$.])(${[...KEY_FUNCS, ...PLURAL_FUNCS].join('|')})\\(`, 'g')
  let m
  const lineOf = (i) => src.slice(0, i).split('\n').length
  while ((m = re.exec(src))) {
    const fn = m[1]
    let i = m.index + m[0].length
    const literalPositions = PLURAL_FUNCS.includes(fn) ? [1, 2] : [0]
    for (let argIndex = 0; argIndex <= Math.max(...literalPositions); argIndex++) {
      i = ws(src, i)
      if (literalPositions.includes(argIndex)) {
        const q = src[i]
        if (q === '"' || q === "'" || q === '`') {
          const r = readString(src, i)
          if (r.value === null) bad.push({ fn, line: lineOf(i), reason: 'template literal with ${}' })
          else keys.push({ key: r.value, line: lineOf(i) })
          i = r.end
          i = ws(src, i)
          if (src[i] !== ',' && src[i] !== ')') i = skipArg(src, i)
        } else i = skipArg(src, i)
      } else i = skipArg(src, i)
      if (src[i] !== ',') break
      i++
    }
  }
  return { keys, bad }
}

export function sourceFiles(dir = path.join(root, 'src')) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

export function extractAll() {
  const keys = new Map()
  const bad = []
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, 'utf8')
    if (!/\b(t|tm|tk|plural|tmPlural)\(/.test(src)) continue
    const r = extractFromSource(src)
    const rel = path.relative(root, f)
    for (const k of r.keys) if (!keys.has(k.key)) keys.set(k.key, `${rel}:${k.line}`)
    for (const b of r.bad) bad.push(`${rel}:${b.line} ${b.fn}(): ${b.reason}`)
  }
  return { keys, bad }
}

// ---------------------------------------------------------------- 2. .strings parsing + normalisation

export function parseStrings(text) {
  const out = new Map()
  let i = 0
  const n = text.length
  const readQuoted = () => {
    let v = ''
    i++ // opening quote
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') {
        const c = text[i + 1]
        v += c === 'n' ? '\n' : c === 't' ? '\t' : c
        i += 2
      } else v += text[i++]
    }
    i++
    return v
  }
  while (i < n) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 2
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    if (c === '"') {
      const key = readQuoted()
      while (i < n && text[i] !== '"') i++
      const value = readQuoted()
      out.set(key, value)
      while (i < n && text[i] !== ';') i++
      i++
      continue
    }
    i++
  }
  return out
}

/** Mac format string → our template. Returns { text, count }. */
export function normalizeMac(s) {
  let idx = 0
  const text = s
    .replace(/%(?:(\d+)\$)?(@|lld|ld|lu|llu|d|i|u|f|\.\d+f|%)/g, (m, pos, spec) => {
      if (spec === '%') return '%'
      const k = pos ? Number(pos) - 1 : idx
      idx++
      return `{${k}}`
    })
    .replace(/Palmier Pro/g, '{app}')
    .replace(/Palmier(?=[\s’'])/g, '{app}')
  return { text, count: idx }
}

const placeholders = (s) => [...s.matchAll(/\{(\d+|app)\}/g)].map((m) => m[1]).sort().join(',')

/** Typographic twin used for loose matching (quotes, ellipsis, dashes, spacing). */
export const looseKey = (s) =>
  s
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\.\.\./g, '…')
    .replace(/\s+/g, ' ')
    .trim()

function loadMacLocale(id) {
  const file = path.join(lprojDir, `${id}.lproj`, 'Localizable.strings')
  const raw = parseStrings(fs.readFileSync(file, 'utf8'))
  const exact = new Map()
  const loose = new Map()
  let dropped = 0
  for (const [k, v] of raw) {
    const nk = normalizeMac(k).text
    const nv = normalizeMac(v).text
    if (placeholders(nk) !== placeholders(nv)) {
      dropped++
      continue
    }
    exact.set(nk, nv)
    if (!loose.has(looseKey(nk))) loose.set(looseKey(nk), nv)
  }
  return { exact, loose, dropped, total: raw.size }
}

// ---------------------------------------------------------------- 3/4. build

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

function main() {
  const { keys, bad } = extractAll()
  if (bad.length) {
    console.error(`Non-literal translation keys:\n  ${bad.join('\n  ')}`)
    process.exit(1)
  }
  const enObj = sortedObject([...keys.keys()].map((k) => [k, k]))
  const enJson = JSON.stringify(enObj, null, 2) + '\n'
  const enPath = path.join(outDir, 'en.json')
  if (args.includes('--check')) {
    const cur = fs.existsSync(enPath) ? fs.readFileSync(enPath, 'utf8') : ''
    if (cur !== enJson) {
      console.error('resources/locales/en.json is out of date: run node scripts/i18n/build-locales.mjs')
      process.exit(1)
    }
    console.log(`en.json up to date (${keys.size} keys)`)
    return
  }
  if (!fs.existsSync(lprojDir)) {
    console.error(`Mac localizations not found at ${lprojDir} (pass --mac <path>)`)
    process.exit(1)
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(enPath, enJson)

  const aliasFile = path.join(root, 'scripts/i18n/aliases.json')
  const aliases = fs.existsSync(aliasFile) ? JSON.parse(fs.readFileSync(aliasFile, 'utf8')) : {}
  const english = loadMacLocale('en')
  const enKeys = [...keys.keys()]

  // How each English key maps to a Mac key (same for every locale).
  const source = new Map()
  const viaAlias = []
  const untranslated = []
  for (const k of enKeys) {
    if (english.exact.has(k)) source.set(k, { mac: k })
    else if (aliases[k]) {
      const a = typeof aliases[k] === 'string' ? { mac: aliases[k] } : aliases[k]
      if (!english.exact.has(a.mac)) throw new Error(`aliases.json: Mac key not found for "${k}": "${a.mac}"`)
      source.set(k, a)
      viaAlias.push(k)
    } else {
      const lk = looseKey(k)
      const twin = [...english.exact.keys()].find((mk) => looseKey(mk) === lk)
      if (twin) source.set(k, { mac: twin, loose: true })
      else untranslated.push(k)
    }
  }

  const rows = []
  for (const id of LOCALES) {
    if (id === 'en') continue
    const mac = loadMacLocale(id)
    const out = []
    for (const k of enKeys) {
      const src = source.get(k)
      if (!src) continue
      let v = mac.exact.get(src.mac)
      if (v === undefined) continue
      for (const [from, to] of src.replace ?? []) v = v.split(from).join(to)
      if (placeholders(v) !== placeholders(k)) continue
      if (v === k) {
        // Mac left it English too (brand names, "OK"…): still counts, keep it out of the file.
        out.push([k, null])
        continue
      }
      out.push([k, v])
    }
    const translated = out.filter(([, v]) => v !== null)
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(sortedObject(translated), null, 2) + '\n')
    rows.push({ id, covered: out.length, file: translated.length, dropped: mac.dropped })
  }

  const total = enKeys.length
  const lines = [
    '# i18n coverage',
    '',
    `Generated by \`node scripts/i18n/build-locales.mjs\` from ${path.relative(os.homedir(), lprojDir).replace(/^/, '~/')} — do not edit by hand.`,
    '',
    `English keys in use (t/tm/tk/plural calls in src/): **${total}**. Mac English keys: ${english.total}.`,
    `Mapped to a Mac key: ${source.size} (${viaAlias.length} via scripts/i18n/aliases.json, ${[...source.values()].filter((s) => s.loose).length} by typographic twin). Linux-only or reworded (English fallback): ${untranslated.length}.`,
    '',
    '| Locale | Translated | % |',
    '|---|---:|---:|',
    ...rows.map((r) => `| ${r.id} | ${r.covered} / ${total} | ${((100 * r.covered) / Math.max(1, total)).toFixed(1)} |`),
    '',
    '"Translated" counts keys with a Mac translation, including ones the Mac keeps in English (brand names).',
    '',
    `## Keys via aliases (${viaAlias.length})`,
    '',
    ...viaAlias.map((k) => `- \`${k.replace(/\n/g, '\\n')}\` ← \`${source.get(k).mac.replace(/\n/g, '\\n')}\``),
    '',
    `## English-only keys (${untranslated.length})`,
    '',
    'Linux-only UI, or Linux wording whose meaning differs from the nearest Mac string; these show in English in every locale.',
    '',
    ...untranslated.map((k) => `- \`${k.replace(/\n/g, '\\n')}\` (${keys.get(k)})`),
    '',
  ]
  fs.writeFileSync(reportPath, lines.join('\n'))
  console.log(`${total} keys; mapped ${source.size}; English-only ${untranslated.length}; wrote ${rows.length + 1} locale files and ${path.relative(root, reportPath)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
