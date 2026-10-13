import { describe, expect, it } from 'vitest'
import { emptyManifest, newProjectFile, type Clip } from '../../src/core/model'
import type { Doc } from '../../src/core/ops/context'
import { parseInline, parseMarkdown } from '../../src/renderer/agent/markdown'
import { atQuery, attachAsset, attachClips, attachRange, mentionCandidates, pickMention, pruneMentions } from '../../src/renderer/agent/mentions'
import { prettyArgs } from '../../src/renderer/agent/Message'

describe('markdown subset', () => {
  it('splits fences, headings, tables and prose', () => {
    const md = ['# Title', 'Intro **bold** and `code`.', '', 'More', '```ts', 'const a = 1', '```', '| A | B |', '|:--|--:|', '| 1 | x \\| y |', '| 2 |', 'after'].join('\n')
    const blocks = parseMarkdown(md)
    expect(blocks.map((b) => b.kind)).toEqual(['prose', 'code', 'table', 'prose'])
    const prose = blocks[0] as Extract<(typeof blocks)[0], { kind: 'prose' }>
    expect(prose.parts[0]).toEqual({ kind: 'heading', level: 1, inline: [{ kind: 'text', text: 'Title' }] })
    expect(prose.parts[1].inline).toEqual([
      { kind: 'text', text: 'Intro ' },
      { kind: 'bold', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: '.\n\nMore' },
    ])
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', code: 'const a = 1' })
    const table = blocks[2] as Extract<(typeof blocks)[0], { kind: 'table' }>
    expect(table.aligns).toEqual(['left', 'right'])
    expect(table.rows.map((r) => r.map((c) => (c[0] as { text?: string })?.text ?? ''))).toEqual([
      ['1', 'x | y'],
      ['2', ''],
    ])
  })

  it('handles an unterminated fence, lists as literal text, and no raw HTML', () => {
    expect(parseMarkdown('```\nopen')).toEqual([{ kind: 'code', lang: null, code: 'open' }])
    const blocks = parseMarkdown('- one\n- two <b>x</b>')
    expect(blocks).toEqual([{ kind: 'prose', parts: [{ kind: 'para', inline: [{ kind: 'text', text: '- one\n- two <b>x</b>' }] }] }])
  })

  it('parses inline links (http only), italics, strike, and leaves snake_case alone', () => {
    expect(parseInline('see [docs](https://x.dev) and [bad](javascript:alert(1))')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', href: 'https://x.dev', children: [{ kind: 'text', text: 'docs' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'text', text: 'bad' },
      { kind: 'text', text: ')' },
    ])
    expect(parseInline('*it* ~~gone~~ get_timeline')).toEqual([
      { kind: 'italic', children: [{ kind: 'text', text: 'it' }] },
      { kind: 'text', text: ' ' },
      { kind: 'strike', children: [{ kind: 'text', text: 'gone' }] },
      { kind: 'text', text: ' get_timeline' },
    ])
  })
})

describe('draft mentions', () => {
  const asset = { id: 'ABCDEF12-0000', name: 'Beach  Day - final', type: 'video' as const }

  it('attaches assets with spacing, dedupe and clash suffix', () => {
    let d = attachAsset({ text: 'Use', mentions: [] }, asset)
    expect(d.text).toBe('Use @Beach-Day-final ')
    d = attachAsset(d, asset)
    expect(d.mentions).toHaveLength(1)
    d = attachAsset(d, { id: 'ZZZZZZ99', name: 'Beach Day final', type: 'image' })
    expect(d.text).toBe('Use @Beach-Day-final @Beach-Day-final#ZZZZZZ ')
    expect(pruneMentions({ text: 'nothing', mentions: d.mentions })).toEqual([])
  })

  it('attaches clips with track label + timecode names, and ranges', () => {
    const file = newProjectFile()
    const tl = file.timelines[0]
    const clip = (id: string, startFrame: number, extra: Partial<Clip> = {}) => ({ id, mediaRef: 'M1', mediaType: 'video', sourceClipType: 'video', startFrame, durationFrames: 10, ...extra }) as Clip
    tl.tracks = [{ id: 'T', type: 'video', muted: false, hidden: false, syncLocked: true, displayHeight: 44, clips: [clip('CLIPAAAA1', 30), clip('CLIPBBBB2', 90, { mediaType: 'text', textContent: 'Hello\nworld' })] }] as never
    const doc: Doc = { file, manifest: emptyManifest() }
    doc.manifest.entries.push({ id: 'M1', name: 'Interview take', type: 'video', source: { external: { absolutePath: '/x' } }, duration: 10 })
    const d = attachClips({ text: '', mentions: [] }, doc, tl, ['CLIPBBBB2', 'CLIPAAAA1'])
    const fps = tl.fps
    const tc = (f: number) => {
      const s = Math.floor(f / fps)
      return `00:00:${String(s).padStart(2, '0')}:${String(f % fps).padStart(2, '0')}`
    }
    expect(d.mentions.map((m) => m.displayName)).toEqual([`Interview-take-V1-${tc(30)}`, `Hello-world-V1-${tc(90)}`])
    expect(d.mentions[0]).toMatchObject({ clipId: 'CLIPAAAA1', mediaRef: 'M1', type: 'video' })
    const r = attachRange(d, { start: 60, end: 30 }, 30)
    expect(r.mentions.at(-1)!.displayName).toBe('Range-00:00:01:00-00:00:02:00')
    expect(r.mentions.at(-1)!.timelineRange).toMatchObject({ startFrame: 30, endFrame: 60, durationFrames: 30, durationTimecode: '00:00:01:00' })
    expect(attachRange(r, { start: 30, end: 60 }, 30).mentions).toHaveLength(r.mentions.length)
  })

  it('computes the @ query and picks', () => {
    expect(atQuery('hi @bea')).toBe('bea')
    expect(atQuery('@')).toBe('')
    expect(atQuery('mail a@b')).toBeNull()
    expect(atQuery('hi @bea ch')).toBeNull()
    const d = pickMention({ text: 'look at @bea', mentions: [] }, asset)
    expect(d.text).toBe('look at @Beach-Day-final ')
    expect(d.mentions[0]).toMatchObject({ displayName: 'Beach-Day-final', mediaRef: asset.id })
    const entries = [
      { id: '1', name: 'Beach one', type: 'video' },
      { id: '2', name: 'beach-two', type: 'image' },
      { id: '3', name: 'Song', type: 'audio' },
    ] as never
    expect(mentionCandidates(entries, 'all', 'beach-').map((e) => e.id)).toEqual(['1', '2'])
    expect(mentionCandidates(entries, 'image', '').map((e) => e.id)).toEqual(['2'])
  })

  it('pretty-prints tool args with floats rounded to 3 places', () => {
    expect(prettyArgs('{}')).toBe('(no args)')
    expect(prettyArgs('')).toBe('(no args)')
    expect(prettyArgs('{"x":0.123456,"n":[1,2.00049]}')).toBe('{\n  "x": 0.123,\n  "n": [\n    1,\n    2\n  ]\n}')
  })
})

describe('panel fitting with the agent column', () => {
  it('collapses inspector, then media, then agent so the preview keeps 400 px; never the kept panel', async () => {
    const { fitPanels, presetMinWidth, requiredWidth } = await import('../../src/renderer/editor/panelFit')
    const all = { media: true, inspector: true, agent: true }
    expect(presetMinWidth(all, 'default')).toBe(353 + 400 + 301)
    expect(requiredWidth(all, 'default')).toBe(241 + 1054)
    expect(presetMinWidth({ media: false, inspector: false, agent: true }, 'vertical')).toBe(352 + 1 + 400)
    expect(fitPanels(all, 'default', 1400)).toEqual(all)
    expect(fitPanels(all, 'default', 1200)).toEqual({ media: true, inspector: false, agent: true })
    expect(fitPanels(all, 'default', 900)).toEqual({ media: false, inspector: false, agent: true })
    expect(fitPanels(all, 'default', 1200, 'inspector')).toEqual({ media: false, inspector: true, agent: true })
    expect(fitPanels(all, 'default', 0)).toEqual(all)
  })
})
