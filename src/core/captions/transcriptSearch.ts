/** `Transcription/TranscriptSearch.swift` — exact keyword search over cached transcripts (spec 07 §1.12). */
import type { TranscriptionResult } from './transcript'

export interface TranscriptHit {
  assetId: string
  start: number
  end: number
  text: string
}

/** Query split on whitespace, edge punctuation stripped ("budget," → "budget"). */
export function searchTerms(query: string): string[] {
  return query
    .split(/[\p{White_Space}]+/u)
    .map((t) => t.replace(/^[\p{P}]+|[\p{P}]+$/gu, ''))
    .filter(Boolean)
}

/** Case- and diacritic-insensitive folding. */
export const foldForSearch = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()

export function matchesTerms(text: string, terms: string[]): boolean {
  const hay = foldForSearch(text)
  return terms.every((t) => hay.includes(foldForSearch(t)))
}

/** Segments of each asset's cached transcript containing every term, in asset order, stopping at `limit`. */
export function searchTranscripts(query: string, assets: { id: string; transcript: TranscriptionResult | null }[], limit = 20): TranscriptHit[] {
  const terms = searchTerms(query)
  if (!terms.length) return []
  const hits: TranscriptHit[] = []
  for (const asset of assets) {
    if (!asset.transcript) continue
    for (const s of asset.transcript.segments) {
      if (!matchesTerms(s.text, terms)) continue
      hits.push({ assetId: asset.id, start: s.start, end: s.end, text: s.text })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
