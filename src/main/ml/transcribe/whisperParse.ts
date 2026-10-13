/** whisper.cpp `-ojf` JSON → `TranscriptionResult` (spec 07 §1.5). Pure; unit-tested. */
import { normalizedResult, TranscriptionError, type TranscriptionResult, type TranscriptionSegment, type TranscriptionWord } from '../../../core/captions/transcript'
import { languageSubtag, UNSPACED_LANGUAGES } from '../../../core/captions/languages'

interface WhisperToken {
  text: string
  offsets?: { from: number; to: number }
}

interface WhisperSegment {
  text: string
  offsets: { from: number; to: number }
  tokens?: WhisperToken[]
}

export interface WhisperJson {
  result?: { language?: string }
  transcription: WhisperSegment[]
}

/** Whisper control tokens: `[_BEG_]`, `[_TT_123]`, `<|endoftext|>` … */
const isSpecialToken = (t: string) => /^\[_.*\]$/.test(t) || t.startsWith('<|')
/** Whole-segment non-speech annotations whisper emits for silence/music ("[BLANK_AUDIO]", "(music)"). */
const isAnnotation = (t: string) => /^\s*(\[[^\]]*\]|\([^)]*\)|♪+)\s*$/.test(t)

/** Maps whisper's full JSON. `chosenLang` (the user's BCP-47 tag) wins over the detected code, as on the Mac. */
export function fromWhisper(json: unknown, chosenLang?: string): TranscriptionResult {
  const j = json as WhisperJson
  if (!j || !Array.isArray(j.transcription)) throw new TranscriptionError('decodeFailed')
  const language = chosenLang ?? j.result?.language
  const unspaced = language ? UNSPACED_LANGUAGES.has(languageSubtag(language)) : false
  const segments: TranscriptionSegment[] = []
  const words: TranscriptionWord[] = []
  let full = ''
  for (const seg of j.transcription) {
    if (typeof seg?.text !== 'string' || !seg.offsets) throw new TranscriptionError('decodeFailed')
    if (isAnnotation(seg.text)) continue
    full += seg.text
    const segStart = seg.offsets.from / 1000
    const segEnd = Math.max(segStart, seg.offsets.to / 1000)
    const t = seg.text.trim()
    const clamp = (v: number) => Math.min(Math.max(v, segStart), segEnd)
    let cur: { text: string; start: number; end: number } | null = null
    let prevEnd = segStart
    const segWords: TranscriptionWord[] = []
    const close = (c: { text: string; start: number; end: number }) => {
      const text = c.text.trim()
      if (!text) return
      const start = clamp(c.start)
      segWords.push({ text, start, end: Math.max(clamp(c.end), start + 0.01) })
    }
    for (const tok of seg.tokens ?? []) {
      if (typeof tok?.text !== 'string' || isSpecialToken(tok.text)) continue
      const s = tok.offsets ? tok.offsets.from / 1000 : prevEnd
      const e = tok.offsets ? tok.offsets.to / 1000 : prevEnd
      prevEnd = e
      const startsWord = cur === null || unspaced || /^\s/.test(tok.text)
      if (startsWord) {
        if (cur) close(cur)
        cur = { text: tok.text, start: s, end: e }
      } else {
        cur!.text += tok.text
        cur!.end = e
      }
    }
    if (cur) close(cur)
    words.push(...segWords)
    if (t) segments.push(...sentenceSegments(t, segStart, segEnd, segWords, unspaced))
  }
  return normalizedResult({ text: full.trim(), language, words, segments })
}

/**
 * whisper segments are decoding windows (up to 30 s), not utterances like Apple's results; split each one after
 * words ending a sentence so segments stay sentence-level (inspect_media, Index rows, spoken search). The first and
 * last piece keep the segment's own bounds. A segment without timed words, or with one sentence, is kept whole.
 */
function sentenceSegments(text: string, start: number, end: number, words: TranscriptionWord[], unspaced: boolean): TranscriptionSegment[] {
  const groups: TranscriptionWord[][] = [[]]
  words.forEach((w, i) => {
    groups[groups.length - 1].push(w)
    if (i + 1 < words.length && /[.?!。？！]["'”’)\]]*$/.test(w.text)) groups.push([])
  })
  if (groups.length < 2) return [{ text, start, end }]
  return groups.map((g, i) => ({
    text: g.map((w) => w.text).join(unspaced ? '' : ' '),
    start: i === 0 ? start : g[0].start!,
    end: i === groups.length - 1 ? end : g[g.length - 1].end!,
  }))
}

/** `whisper_print_progress_callback: progress = NN%` → 0…1, else null. */
export function parseWhisperProgress(line: string): number | null {
  const m = /progress\s*=\s*(\d+)%/.exec(line)
  return m ? Math.min(1, Number(m[1]) / 100) : null
}
