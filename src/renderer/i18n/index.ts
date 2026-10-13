/**
 * Renderer localization (parity gap 16). `t(key, ...args)` (key = the English text) looks the English string up in the table
 * main loaded for this process; missing keys fall back to English. Keys use `{0}`… for arguments and `{app}` for
 * the product name (src/shared/i18n.ts). The table is fixed for the life of the window: changing the language
 * needs a restart, as on the Mac.
 *
 * Every literal key passed to `t`, `plural` or `tk` is checked against `resources/locales/en.json`
 * (tests/i18n/keys.test.ts); run `node scripts/i18n/build-locales.mjs` after adding strings.
 */
import { createTranslator, keyMatcher, RTL_LOCALES, tk, type FormatArg, type I18nPayload, type LocaleId } from '../../shared/i18n'

let payload: I18nPayload = { active: 'en', system: 'en', selection: 'system', strings: {} }
let translator = createTranslator('en', {})

/** Loads this window's table; must finish before any UI module is imported (main.tsx). */
export async function loadLocale(): Promise<void> {
  try {
    payload = await window.palmier.i18n.get()
  } catch (e) {
    console.error('[i18n] falling back to English', e)
  }
  translator = createTranslator(payload.active, payload.strings)
  const root = document.documentElement
  root.lang = payload.active
  rtl = RTL_LOCALES.includes(payload.active)
  root.dir = rtl ? 'rtl' : 'ltr'
}

/** In right-to-left locales an untranslated (English) string is wrapped in a first-strong isolate so it keeps its own order. */
const isolate = (key: string, out: string): string => (rtl && !(key in payload.strings) && /[A-Za-z0-9]/.test(out) ? `\u2068${out}\u2069` : out)
let rtl = false

export function t(key: string, ...args: FormatArg[]): string {
  return isolate(key, translator.t(key, ...args))
}

/** Mac-style plural pair: `n === 1` → `one`; otherwise `other` with `{0}` = n (extra args from `{1}`). */
export function plural(n: number, one: string, other: string, ...rest: FormatArg[]): string {
  return isolate(n === 1 ? one : other, translator.plural(n, one, other, ...rest))
}

let patterns: { match: (s: string) => string[] | null; key: string }[] | null = null

/**
 * Translates a finished English message produced outside the renderer's t() calls (src/core reasons, main-process
 * errors): an exact key first, then any `{0}` key whose English shape matches, with the captured arguments.
 * Unknown text passes through unchanged.
 */
export function tx(message: string | null | undefined): string {
  if (!message) return message ?? ''
  const strings = payload.strings
  if (strings[message]) return translator.t(message)
  patterns ??= Object.keys(strings)
    .filter((k) => /\{\d+\}/.test(k))
    .map((key) => ({ key, match: keyMatcher(key) }))
  for (const p of patterns) {
    const args = p.match(message)
    if (args) return translator.t(p.key, ...args)
  }
  return message
}

/** Marks a key for extraction without translating it; translate at use with `t(x)`. */
export { tk }

export const activeLocale = (): LocaleId => payload.active
export const i18nPayload = (): I18nPayload => payload
export const isRtl = (): boolean => RTL_LOCALES.includes(payload.active)

/** A language code's name in the UI language, capitalized (Mac `Locale.current.localizedString(forLanguageCode:)`). */
export function languageDisplayName(code: string, emptyLabel = t('Target Language')): string {
  if (!code) return emptyLabel
  try {
    const n = new Intl.DisplayNames([payload.active], { type: 'language' }).of(code)
    if (n && n !== code) return n.charAt(0).toLocaleUpperCase(payload.active) + n.slice(1)
  } catch {
    // fall through
  }
  return code.toUpperCase()
}
