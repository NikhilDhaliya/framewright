/** Whisper's language table (whisper.cpp `g_lang`), the Linux "supported locales" for local transcription (spec 07 §1.5). */
export const WHISPER_LANGUAGES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
  'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
  'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
] as const

/** BCP-47 aliases whisper spells differently. */
const ALIASES: Record<string, string> = { iw: 'he', jv: 'jw', nb: 'no', fil: 'tl', in: 'id', ji: 'yi' }

/** Languages without spaces between words: each whisper token starts a new "word". */
export const UNSPACED_LANGUAGES = new Set(['zh', 'ja', 'th', 'lo', 'km', 'my', 'yue'])

/** Primary language subtag of a BCP-47 tag, with any `-u-…` extension stripped. */
export function languageSubtag(tag: string): string {
  return tag.replace(/-u-.*$/i, '').split(/[-_]/)[0].toLowerCase()
}

/** Whisper's code for a BCP-47 tag (`zh-Hans` → `zh`, `nb` → `no`), or null when whisper has no model for it. */
export function whisperLanguage(tag: string): string | null {
  const lang = languageSubtag(tag)
  const code = ALIASES[lang] ?? lang
  return (WHISPER_LANGUAGES as readonly string[]).includes(code) ? code : null
}

/** Display name for a language code in `uiLocale` (falls back to the code). */
export function languageDisplayName(code: string, uiLocale = 'en'): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The Language menu: whisper's languages sorted by localized display name. */
export function sortedLanguages(uiLocale = 'en'): { code: string; name: string }[] {
  return WHISPER_LANGUAGES.map((code) => ({ code, name: languageDisplayName(code, uiLocale) })).sort((a, b) => a.name.localeCompare(b.name, uiLocale))
}
