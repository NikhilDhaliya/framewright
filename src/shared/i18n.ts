/**
 * Shared localization core (parity gap 16; Mac `Localization/AppLocalization.swift`).
 *
 * Keys are the English UI strings (the Mac's `Localizable.strings` keys, converted by
 * `scripts/i18n/build-locales.mjs`): `%@`/`%lld` become positional `{0}`, `{1}`…, `%%` becomes `%`,
 * and the product name becomes `{app}` (fed from `src/shared/brand.ts`). A missing key renders the key itself,
 * so English needs no table. Plurals follow the Mac: separate "1 item" / "{0} items" keys.
 */
import { APP_NAME } from './brand'

/** The Mac's 28 `.lproj` folders (`Resources/Localization`). */
export const LOCALES = [
  'ar', 'bn', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'id', 'it', 'ja',
  'ko', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-Hans', 'zh-Hant',
] as const
export type LocaleId = (typeof LOCALES)[number]

export const RTL_LOCALES: readonly string[] = ['ar', 'he']

export type StringTable = Record<string, string>

/** What main hands the renderer at startup (`i18n:get`). */
export interface I18nPayload {
  /** Locale the UI runs in for this process (changes need a restart, as on the Mac). */
  active: LocaleId
  /** Resolved "System Language" locale. */
  system: LocaleId
  /** Stored choice: 'system' or a locale id. */
  selection: 'system' | LocaleId
  strings: StringTable
}

export type FormatArg = string | number

export function isLocaleId(v: unknown): v is LocaleId {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}

/**
 * `{0}`… and `{app}` substitution. Numbers print as plain digits without grouping, like the Mac's `%lld`
 * (`String(localized:)` formats `%lld` without a thousands separator).
 */
export function formatMessage(template: string, args: readonly FormatArg[]): string {
  if (!template.includes('{')) return template
  return template.replace(/\{(\d+|app)\}/g, (m, k: string) => {
    if (k === 'app') return APP_NAME
    const v = args[Number(k)]
    return v === undefined ? m : String(v)
  })
}

export interface Translator {
  locale: string
  t(key: string, ...args: FormatArg[]): string
  /** Mac-style plural pair: `n === 1` uses `one` (no args), otherwise `other` with `{0}` = n. */
  plural(n: number, one: string, other: string, ...rest: FormatArg[]): string
}

export function createTranslator(locale: string, strings: StringTable): Translator {
  const t = (key: string, ...args: FormatArg[]) => formatMessage(strings[key] ?? key, args)
  return {
    locale,
    t,
    plural: (n, one, other, ...rest) => (n === 1 ? t(one, ...rest) : t(other, n, ...rest)),
  }
}

/**
 * Picks the locale for "System Language" from the OS preference list, like `Bundle.preferredLocalizations`:
 * the first preferred language with any match wins; English when nothing matches.
 */
export function resolveSystemLocale(preferred: readonly string[]): LocaleId {
  for (const raw of preferred) {
    const m = matchLocale(raw)
    if (m) return m
  }
  return 'en'
}

export function matchLocale(raw: string): LocaleId | null {
  if (!raw) return null
  const tag = raw.split('.')[0].split('@')[0].replace(/_/g, '-').replace(/-u-.*$/i, '')
  if (tag === 'C' || tag === 'POSIX') return 'en'
  const parts = tag.split('-')
  const lang = parts[0].toLowerCase()
  const rest = parts.slice(1).map((p) => p.toLowerCase())
  if (lang === 'zh') {
    if (rest.includes('hant') || rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo')) return 'zh-Hant'
    return 'zh-Hans'
  }
  if (lang === 'pt') {
    if (rest.length === 0 || rest.includes('br')) return 'pt-BR'
    return 'pt-PT'
  }
  if (lang === 'no' || lang === 'nn' || lang === 'nb') return 'nb'
  if (lang === 'iw') return 'he'
  if (lang === 'in') return 'id'
  return isLocaleId(lang) ? lang : null
}

/** Each language's own name ("Deutsch", "العربية"), like `Locale(identifier: id).localizedString(forIdentifier: id)`. */
export function nativeLanguageName(id: string): string {
  try {
    return new Intl.DisplayNames([id], { type: 'language', languageDisplay: 'standard' }).of(id) ?? id
  } catch {
    return id
  }
}

/** Language popup order: locales sorted by native name (Mac: `localizedStandardCompare`). */
export function sortedLocales(collatorLocale: string): LocaleId[] {
  const collator = new Intl.Collator(collatorLocale, { numeric: true, sensitivity: 'base' })
  return [...LOCALES].sort((a, b) => collator.compare(nativeLanguageName(a), nativeLanguageName(b)))
}

/** Marks a literal as a translation key (for scripts/i18n/build-locales.mjs) without translating it; translate later with `t(x)`. */
export const tk = <S extends string>(key: S): S => key

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches an English message against a key's shape (`{0}` = any text); returns the arguments in index order. */
export function keyMatcher(key: string): (message: string) => string[] | null {
  const order: number[] = []
  const src = key
    .split(/(\{\d+\}|\{app\})/)
    .map((part) => {
      const m = /^\{(\d+)\}$/.exec(part)
      if (m) {
        order.push(Number(m[1]))
        return '(.+?)'
      }
      return escapeRe(part === '{app}' ? APP_NAME : part)
    })
    .join('')
  const re = new RegExp(`^${src}$`, 's')
  return (message) => {
    const m = re.exec(message)
    if (!m) return null
    const args: string[] = []
    order.forEach((idx, i) => (args[idx] = m[i + 1]))
    return args
  }
}
