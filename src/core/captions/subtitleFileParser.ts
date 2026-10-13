/** SRT / WebVTT cue parsing (`MediaPanel/CaptionsTab/SubtitleFileParser.swift`, spec 07 §1.8). Pure. */
import { trimWhitespace } from './text'

export interface SubtitleCue {
  text: string
  startSeconds: number
  endSeconds: number
}

export type SubtitleFormat = 'srt' | 'vtt'

/** `SubtitleFileParser.ParseError` with the Mac's messages. */
export class SubtitleParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubtitleParseError'
  }
  static unsupportedFileType = (ext: string) => new SubtitleParseError(`Unsupported subtitle file type “.${ext}”. Use SRT or WebVTT.`)
  static missingWebVTTHeader = () => new SubtitleParseError('Not a WebVTT file — the WEBVTT header is missing.')
  static malformedCue = (line: number) => new SubtitleParseError(`Malformed cue timing at line ${line}.`)
  static noCues = () => new SubtitleParseError('The file contains no captions.')
}

export function subtitleFormat(ext: string): SubtitleFormat | null {
  const e = ext.replace(/^\./, '').toLowerCase()
  return e === 'srt' ? 'srt' : e === 'vtt' ? 'vtt' : null
}

const isKeywordLine = (line: string, keyword: string) => line === keyword || line.startsWith(`${keyword} `) || line.startsWith(`${keyword}\t`)

function seconds(token: string): number | null {
  const m = /^(?:(\d{1,4}):)?([0-5]?\d):([0-5]?\d)[.,](\d{1,3})(?=\s|$)/.exec(token.trim())
  if (!m) return null
  const ms = Number(m[4]) * [100, 10, 1][m[4].length - 1]
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000
}

function plainText(line: string): string {
  let text = line.replace(/<[^>]*>|\{[^}]*\}/g, '')
  for (const [entity, value] of [
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&nbsp;', '\u00A0'],
    ['&lrm;', '\u200E'],
    ['&rlm;', '\u200F'],
    ['&amp;', '&'],
  ])
    text = text.split(entity).join(value)
  return trimWhitespace(text)
}

export function parseSubtitles(contents: string, format: SubtitleFormat): SubtitleCue[] {
  const lines = contents
    .replace(/^\uFEFF/, '')
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map(trimWhitespace)
  const blocks: { start: number; lines: string[] }[] = []
  lines.forEach((line, index) => {
    if (!line) return
    const last = blocks[blocks.length - 1]
    if (last && last.start + last.lines.length === index) last.lines.push(line)
    else blocks.push({ start: index, lines: [line] })
  })
  if (format === 'vtt') {
    if (!blocks[0] || !isKeywordLine(blocks[0].lines[0], 'WEBVTT')) throw SubtitleParseError.missingWebVTTHeader()
    blocks.shift()
  }
  const cues: SubtitleCue[] = []
  for (const block of blocks) {
    if (format === 'vtt' && ['NOTE', 'STYLE', 'REGION'].some((k) => isKeywordLine(block.lines[0], k))) continue
    const timing = block.lines.slice(0, 2).findIndex((l) => l.includes('-->'))
    if (timing < 0) throw SubtitleParseError.malformedCue(block.start + 1)
    const sides = block.lines[timing].split('-->')
    const start = sides.length === 2 ? seconds(sides[0]) : null
    const end = sides.length === 2 ? seconds(sides[1]) : null
    if (start === null || end === null || !(end > start)) throw SubtitleParseError.malformedCue(block.start + timing + 1)
    const text: string[] = []
    block.lines.forEach((line, offset) => {
      if (offset <= timing) return
      if (line.includes('-->')) throw SubtitleParseError.malformedCue(block.start + offset + 1)
      const stripped = plainText(line)
      if (stripped) text.push(stripped)
    })
    if (text.length) cues.push({ text: text.join('\n'), startSeconds: start, endSeconds: end })
  }
  if (!cues.length) throw SubtitleParseError.noCues()
  return cues.sort((a, b) => a.startSeconds - b.startSeconds)
}

/** UTF-8, else Latin-1 (which decodes any byte sequence). */
export function decodeSubtitleBytes(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return new TextDecoder('latin1').decode(data)
  }
}

export function parseSubtitleBytes(data: Uint8Array, ext: string): SubtitleCue[] {
  const format = subtitleFormat(ext)
  if (!format) throw SubtitleParseError.unsupportedFileType(ext.replace(/^\./, ''))
  return parseSubtitles(decodeSubtitleBytes(data), format)
}

/** `HH:MM:SS,mmm` as shown by the subtitle preview. */
export function srtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const ms = totalMs % 1000
  const s = Math.floor(totalMs / 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)},${p(ms, 3)}`
}
