/**
 * Censor profanity (spec 07 §1.5): Apple's `.etiquetteReplacements` has no whisper equivalent, so matched words
 * become their first letter + `*` for the remaining letters, keeping surrounding punctuation. [UNVERIFIED] mask form.
 */
import { languageSubtag } from '../../../core/captions/languages'
import { graphemes } from '../../../core/captions/text'
import type { TranscriptionResult } from '../../../core/captions/transcript'
import data from './profanity.json'

const LISTS: Record<string, Set<string>> = Object.fromEntries(Object.entries((data as { lists: Record<string, string[]> }).lists).map(([k, v]) => [k, new Set(v.map((w) => w.toLocaleLowerCase()))]))

export const hasProfanityList = (language: string | undefined): boolean => !!language && !!LISTS[languageSubtag(language)]

/** `fuck,` → `f***,`; letters only are masked so apostrophes and punctuation stay. */
function maskWord(core: string): string {
  const g = graphemes(core)
  return g.map((c, i) => (i === 0 || !/[\p{L}\p{N}]/u.test(c) ? c : '*')).join('')
}

function censorText(text: string, list: Set<string>): string {
  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu, (token) => (list.has(token.toLocaleLowerCase()) ? maskWord(token) : token))
}

/** Applies the language's list to words, segments and the full text; a language without a list is unchanged. */
export function censorTranscript(r: TranscriptionResult, language: string | undefined = r.language): TranscriptionResult {
  const list = language ? LISTS[languageSubtag(language)] : undefined
  if (!list) return r
  return {
    ...r,
    text: censorText(r.text, list),
    words: r.words.map((w) => ({ ...w, text: censorText(w.text, list) })),
    segments: r.segments.map((s) => ({ ...s, text: censorText(s.text, list) })),
  }
}
