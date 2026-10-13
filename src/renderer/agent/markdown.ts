/**
 * The agent's Markdown subset (spec 06 §A11.7; MarkdownText.swift): fenced code, ATX headings, GFM tables,
 * and whitespace-preserving prose with inline-only formatting. Never produces raw HTML.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type ProsePart = { kind: 'heading'; level: number; inline: Inline[] } | { kind: 'para'; inline: Inline[] }

export type Align = 'left' | 'center' | 'right'

export type MdBlock =
  | { kind: 'prose'; parts: ProsePart[] }
  | { kind: 'code'; lang: string | null; code: string }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][]; aligns: Align[] }

function parseHeading(line: string): { level: number; body: string } | null {
  const m = /^(#{1,6}) (.*)$/.exec(line)
  return m ? { level: m[1].length, body: m[2].trim() } : null
}

export function parseTableSeparator(line: string): Align[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  const cells = trimmed.split('|')
  if (cells[0]?.trim() === '') cells.shift()
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop()
  if (!cells.length) return null
  const aligns: Align[] = []
  for (const cell of cells) {
    const c = cell.trim()
    if (!c) return null
    const left = c.startsWith(':')
    const right = c.endsWith(':') && c.length > 1
    const middle = c.slice(left ? 1 : 0, right ? -1 : undefined)
    if (!middle || !/^-+$/.test(middle)) return null
    aligns.push(left && right ? 'center' : right ? 'right' : 'left')
  }
  return aligns
}

export function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  if (cells[0] === '') cells.shift()
  if (cells.length && cells[cells.length - 1] === '') cells.pop()
  return cells
}

const SAFE_HREF = /^(https?:|mailto:)/i

/** Inline Markdown: `code`, **bold** / __bold__, *italic* / _italic_, ~~strike~~, [text](url). Whitespace is kept. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ kind: 'text', text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()#|]/.test(src[i + 1])) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      let n = 1
      while (src[i + n] === '`') n++
      const fence = '`'.repeat(n)
      const end = src.indexOf(fence, i + n)
      if (end > i + n - 1 && end >= 0) {
        flush()
        out.push({ kind: 'code', text: src.slice(i + n, end) })
        i = end + n
        continue
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const close = src.indexOf(ch + ch, i + 2)
      if (close > i + 2) {
        flush()
        out.push({ kind: 'bold', children: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }
    if (ch === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2)
      if (close > i + 2) {
        flush()
        out.push({ kind: 'strike', children: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] !== ' ' && src[i + 1] !== undefined) {
      // `_` inside a word (snake_case) is literal.
      const wordBefore = ch === '_' && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1])
      let close = -1
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\n' && src[j + 1] === '\n') break
        if (src[j] === ch && src[j - 1] !== ' ' && src[j + 1] !== ch && !(ch === '_' && /[\p{L}\p{N}]/u.test(src[j + 1] ?? ''))) {
          close = j
          break
        }
      }
      if (!wordBefore && close > i + 1) {
        flush()
        out.push({ kind: 'italic', children: parseInline(src.slice(i + 1, close)) })
        i = close + 1
        continue
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i))
      if (m) {
        flush()
        if (SAFE_HREF.test(m[2])) out.push({ kind: 'link', href: m[2], children: parseInline(m[1]) })
        else out.push(...parseInline(m[1]))
        i += m[0].length
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

export function parseMarkdown(text: string): MdBlock[] {
  const out: MdBlock[] = []
  let prose: ProsePart[] = []
  let buffer: string[] = []
  const lines = text.split('\n')
  const flushBuffer = () => {
    // Blank lines at the edges of a paragraph only add empty space (the text inside is kept as is).
    const joined = buffer.join('\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '')
    buffer = []
    if (joined.trim()) prose.push({ kind: 'para', inline: parseInline(joined) })
  }
  const emitProse = () => {
    flushBuffer()
    if (prose.length) out.push({ kind: 'prose', parts: prose })
    prose = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      emitProse()
      const lang = trimmed.slice(3)
      const code: string[] = []
      i++
      while (i < lines.length) {
        if (lines[i].trim().startsWith('```')) {
          i++
          break
        }
        code.push(lines[i])
        i++
      }
      out.push({ kind: 'code', lang: lang || null, code: code.join('\n') })
      continue
    }
    const heading = parseHeading(trimmed)
    if (heading) {
      flushBuffer()
      prose.push({ kind: 'heading', level: heading.level, inline: parseInline(heading.body) })
      i++
      continue
    }
    const aligns = line.includes('|') && i + 1 < lines.length ? parseTableSeparator(lines[i + 1]) : null
    if (aligns) {
      const header = splitTableRow(line)
      if (!header.length) {
        buffer.push(line)
        i++
        continue
      }
      emitProse()
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const row = splitTableRow(lines[i])
        while (row.length < header.length) row.push('')
        rows.push(row.slice(0, header.length))
        i++
      }
      const full = [...aligns]
      while (full.length < header.length) full.push('left')
      out.push({ kind: 'table', header: header.map(parseInline), rows: rows.map((r) => r.map(parseInline)), aligns: full.slice(0, header.length) })
      continue
    }
    buffer.push(line)
    i++
  }
  emitProse()
  return out
}

const cache = new Map<string, MdBlock[]>()

/** Parse cache keyed by text (512 entries, cleared when full). */
export function cachedParse(text: string): MdBlock[] {
  const hit = cache.get(text)
  if (hit) return hit
  const v = parseMarkdown(text)
  if (cache.size >= 512) cache.clear()
  cache.set(text, v)
  return v
}
