/** Small Swift string-semantics helpers shared by the caption builders. */

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** Swift `Character`s (extended grapheme clusters). */
export function graphemes(text: string): string[] {
  if (!segmenter) return [...text]
  const out: string[] = []
  for (const s of segmenter.segment(text)) out.push(s.segment)
  return out
}

/** Swift `String.count`. */
export const characterCount = (text: string): number => graphemes(text).length

/** `trimmingCharacters(in: .whitespaces)` — spaces and tabs, not newlines. */
export const trimWhitespace = (text: string): string => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '')

/** `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export const trimWhitespaceAndNewlines = (text: string): string => text.replace(/^[\p{Zs}\t\n\r\u000B\u000C\u0085\u2028\u2029]+|[\p{Zs}\t\n\r\u000B\u000C\u0085\u2028\u2029]+$/gu, '')

/** `split(whereSeparator: \.isWhitespace).count`. */
export const wordCount = (text: string): number => text.split(/[\p{White_Space}]+/u).filter(Boolean).length

/** Characters that are letters or numbers (`Character.isLetter || isNumber`). */
export const alphanumericCount = (text: string): number => graphemes(text).reduce((n, g) => n + (/^[\p{L}\p{N}]/u.test(g) ? 1 : 0), 0)
