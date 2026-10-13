import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs build script without types
import { extractAll, extractFromSource, looseKey, normalizeMac, parseStrings } from '../../scripts/i18n/build-locales.mjs'
import { LOCALES } from '../../src/shared/i18n'

const root = path.resolve(import.meta.dirname, '../..')
const localeDir = path.join(root, 'resources/locales')
const read = (id: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(localeDir, `${id}.json`), 'utf8'))
const placeholders = (s: string) => [...s.matchAll(/\{(\d+|app)\}/g)].map((m) => m[1]).sort().join(',')

describe('translation keys', () => {
  const en = read('en')
  const { keys, bad } = extractAll() as { keys: Map<string, string>; bad: string[] }

  it('uses literal keys only (no template literals)', () => {
    expect(bad).toEqual([])
  })

  it('every t()/tm()/tk()/plural() key in src exists in resources/locales/en.json', () => {
    const missing = [...keys.keys()].filter((k) => !(k in en)).map((k) => `${k}  (${keys.get(k)})`)
    expect(missing, 'run node scripts/i18n/build-locales.mjs').toEqual([])
  })

  it('does not bake the product name into keys', () => {
    expect([...keys.keys()].filter((k) => /Palmier Pro/.test(k))).toEqual([])
  })
})

describe('locale files', () => {
  const en = read('en')
  it('ships one file per Mac locale', () => {
    expect(LOCALES).toHaveLength(28)
    for (const id of LOCALES) expect(fs.existsSync(path.join(localeDir, `${id}.json`)), id).toBe(true)
  })

  for (const id of LOCALES) {
    it(`${id}.json parses, uses English keys and keeps every placeholder`, () => {
      const table = read(id)
      for (const [k, v] of Object.entries(table)) {
        expect(k in en, `${id}: unknown key ${k}`).toBe(true)
        expect(typeof v).toBe('string')
        expect(placeholders(v), `${id}: ${k}`).toBe(placeholders(k))
        expect(v).not.toMatch(/%(@|lld)/)
      }
    })
  }

  it('non-English locales are mostly translated', () => {
    for (const id of LOCALES) if (id !== 'en') expect(Object.keys(read(id)).length, id).toBeGreaterThan(500)
  })
})

describe('build-locales helpers', () => {
  it('normalises Mac format strings', () => {
    expect(normalizeMac('%@ exported with %lld warnings.').text).toBe('{0} exported with {1} warnings.')
    expect(normalizeMac('Downloading %lld%%').text).toBe('Downloading {0}%')
    expect(normalizeMac('Welcome to Palmier Pro, %@').text).toBe('Welcome to {app}, {0}')
    expect(normalizeMac("Palmier couldn't load").text).toBe("{app} couldn't load")
  })

  it('parses .strings with escapes and comments', () => {
    const m = parseStrings('/* c */\n"Can\'t add \\"%@\\"" = "Nope \\"%@\\"";\n"a" = "b";\n')
    expect(m.get('Can\'t add "%@"')).toBe('Nope "%@"')
    expect(m.get('a')).toBe('b')
  })

  it('extracts literal keys from t, plural and tk calls', () => {
    const src = "t('A {0}', x); plural(items.length, '1 item', '{0} items'); tk(\"B\"); toast('not a key'); obj.t('nope'); t(`tpl ${x}`)"
    const r = extractFromSource(src)
    expect(r.keys.map((k: { key: string }) => k.key)).toEqual(['A {0}', '1 item', '{0} items', 'B'])
    expect(r.bad).toHaveLength(1)
  })

  it('treats typographic twins as the same key', () => {
    expect(looseKey('What’s New...')).toBe(looseKey("What's New…"))
  })
})
