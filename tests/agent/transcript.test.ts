import { describe, expect, it } from 'vitest'
import { newProjectFile, emptyManifest, newTimeline } from '../../src/core/model'
import type { Doc } from '../../src/core/ops/context'
import { mentionHint, referencedMentions } from '../../src/main/agent/mentions'
import { apiMessages, dropEmptyAssistantTurn, inlineNote, resolveOrphanToolUses, titleFrom, type MentionContextProvider } from '../../src/main/agent/transcript'
import { AGENT_INSTRUCTIONS, skillsSection, systemPrompt } from '../../src/main/agent/instructions'
import spec from '../../docs/port-spec/02-mcp-tools.tools.json'
import { REBRAND } from '../../src/main/mcp/brandedSpec'
import { mentionDisplayName, type AgentMention, type AgentMessage } from '../../src/shared/agent'

const msg = (role: AgentMessage['role'], blocks: AgentMessage['blocks'], extra: Partial<AgentMessage> = {}): AgentMessage => ({ id: `${role}-${Math.random()}`, role, blocks, mentions: [], ...extra })

describe('orphan tool uses', () => {
  it('prepends Cancelled results to the following tool-result message', () => {
    const m = [
      msg('user', [{ kind: 'text', text: 'go' }]),
      msg('assistant', [
        { kind: 'toolUse', id: 'a', name: 'x', input: '{}' },
        { kind: 'toolUse', id: 'b', name: 'y', input: '{}' },
      ]),
      msg('system', [{ kind: 'text', text: 'Now editing: P' }]),
      msg('user', [{ kind: 'toolResult', toolUseId: 'b', content: [{ kind: 'text', text: 'ok' }], isError: false }]),
    ]
    expect(resolveOrphanToolUses(m)).toBe(true)
    expect(m[3].blocks).toEqual([
      { kind: 'toolResult', toolUseId: 'a', content: [{ kind: 'text', text: 'Cancelled' }], isError: true },
      { kind: 'toolResult', toolUseId: 'b', content: [{ kind: 'text', text: 'ok' }], isError: false },
    ])
    expect(resolveOrphanToolUses(m)).toBe(false)
  })

  it('inserts a new user message after the assistant (past system notices) when none follows', () => {
    const m = [msg('user', [{ kind: 'text', text: 'go' }]), msg('assistant', [{ kind: 'toolUse', id: 'a', name: 'x', input: '{}' }]), msg('system', [{ kind: 'text', text: 'n' }]), msg('user', [{ kind: 'text', text: 'next' }])]
    resolveOrphanToolUses(m)
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'system', 'user', 'user'])
    expect(m[3].blocks[0]).toMatchObject({ kind: 'toolResult', toolUseId: 'a', isError: true })
    expect(m[4].blocks).toEqual([{ kind: 'text', text: 'next' }])
  })
})

describe('incomplete blocks', () => {
  it('drops unsigned thinking, empty redacted/reasoning/text, keeps partial text and tools', () => {
    const m = [
      msg('assistant', [
        { kind: 'thinking', text: 'half', signature: '' },
        { kind: 'redactedThinking', data: '' },
        { kind: 'openAIReasoning', summary: 's', encryptedContent: '', model: 'gpt-5.6-sol' },
        { kind: 'text', text: '' },
        { kind: 'text', text: 'partial' },
        { kind: 'toolUse', id: 't', name: 'n', input: '{}' },
      ]),
    ]
    dropEmptyAssistantTurn(m, m[0].id)
    expect(m[0].blocks).toEqual([
      { kind: 'text', text: 'partial' },
      { kind: 'toolUse', id: 't', name: 'n', input: '{}' },
    ])
    const empty = [msg('assistant', [{ kind: 'thinking', text: 'x', signature: '' }])]
    dropEmptyAssistantTurn(empty, empty[0].id)
    expect(empty).toEqual([])
  })
})

describe('titles', () => {
  it('uses the first non-empty user text, trimmed, 40 graphemes', () => {
    expect(titleFrom([msg('user', [{ kind: 'text', text: '   ' }, { kind: 'text', text: `  ${'é'.normalize('NFD')}${'x'.repeat(50)} ` }])])).toBe('é'.normalize('NFD') + 'x'.repeat(39))
    expect(titleFrom([msg('system', [{ kind: 'text', text: 'n' }])])).toBe('New chat')
    expect(titleFrom([msg('user', [{ kind: 'text', text: '👩‍👩‍👧 hi' }])])).toBe('👩‍👩‍👧 hi')
  })
})

describe('mentions', () => {
  it('normalizes display names', () => {
    expect(mentionDisplayName('  My  clip - final\tcut-- ')).toBe('My-clip-final-cut')
    expect(mentionDisplayName('---')).toBe('')
  })

  it('keeps only mentions still present in the text', () => {
    const ms: AgentMention[] = [
      { id: '1', displayName: 'Beach', mediaRef: 'A', type: 'video' },
      { id: '2', displayName: 'Gone', mediaRef: 'B', type: 'image' },
    ]
    expect(referencedMentions(ms, 'use @Beach please').map((m) => m.id)).toEqual(['1'])
  })

  it('builds the hint with sorted keys, clip summaries and notes', () => {
    const file = newProjectFile()
    const tl = file.timelines[0] ?? newTimeline()
    const doc: Doc = { file, manifest: emptyManifest() }
    doc.manifest.entries.push({ id: 'MEDIA-1', name: 'Beach Day', type: 'video', source: { external: { absolutePath: '/x.mp4' } }, duration: 10, hasAudio: true })
    tl.tracks.push({
      id: 'T1',
      type: 'video',
      muted: false,
      hidden: false,
      syncLocked: true,
      displayHeight: 44,
      clips: [
        {
          id: 'CLIP-1', mediaRef: 'MEDIA-1', mediaType: 'video', sourceClipType: 'video', startFrame: 10, durationFrames: 20, trimStartFrame: 2, trimEndFrame: 3, speed: 1.5,
        } as never,
      ],
    })
    if (!file.timelines.length) file.timelines.push(tl)
    const hint = mentionHint(
      [
        { id: 'm1', displayName: 'Beach-Day', mediaRef: 'MEDIA-1', type: 'video' },
        { id: 'm2', displayName: 'Beach-Day-V1-00:00:00:10', mediaRef: 'MEDIA-1', type: 'video', clipId: 'CLIP-1' },
        { id: 'm3', displayName: 'Ghost', mediaRef: 'X', type: 'video', clipId: 'NOPE' },
        {
          id: 'm4',
          displayName: 'Range-00:00:01:00-00:00:02:00',
          timelineRange: { startFrame: 30, endFrame: 60, durationFrames: 30, fps: 30, startTimecode: '00:00:01:00', endTimecode: '00:00:02:00', durationTimecode: '00:00:01:00', rangeSemantics: 'startInclusiveEndExclusive' },
        },
      ],
      doc,
    )
    expect(hint).toBe(
      'Referenced assets and timeline context in this message: [' +
        '{"kind":"mediaAsset","mediaRef":"MEDIA-1","mention":"@Beach-Day","type":"video"},' +
        '{"clip":{"clipId":"CLIP-1","durationFrames":20,"endFrame":30,"label":"Beach Day","mediaRef":"MEDIA-1","mediaType":"video","sourceClipType":"video","speed":1.5,"startFrame":10,"trackIndex":0,"trackType":"video","trimEndFrame":3,"trimStartFrame":2},"clipId":"CLIP-1","kind":"timelineClip","mediaRef":"MEDIA-1","mention":"@Beach-Day-V1-00:00:00:10","type":"video"},' +
        '{"clip":{"clipId":"NOPE","error":"clip not found"},"clipId":"NOPE","kind":"timelineClip","mediaRef":"X","mention":"@Ghost","type":"video"},' +
        '{"kind":"timelineRange","mention":"@Range-00:00:01:00-00:00:02:00","timelineRange":{"durationFrames":30,"durationTimecode":"00:00:01:00","endFrame":60,"endTimecode":"00:00:02:00","fps":30,"rangeSemantics":"startInclusiveEndExclusive","startFrame":30,"startTimecode":"00:00:01:00"}}' +
        ']. Entries with "clipId" refer to timeline clips; use clipId for timeline edits and pass it to inspect_media when inspecting visible source media. Entries with "timelineRange" refer to selected timeline time spans; their frame ranges are half-open: startFrame inclusive, endFrame exclusive.',
    )
    expect(mentionHint([{ id: 'c', displayName: 'C', mediaRef: 'm', type: 'video', clipId: 'CLIP-1' }], null)).toContain('{"clipId":"CLIP-1","error":"editor unavailable"}')
  })

  it('writes the inline image note', () => {
    expect(inlineNote({ images: [], inlinedIds: [], failures: {} })).toBeNull()
    expect(inlineNote({ images: [], inlinedIds: ['B', 'A'], failures: { Z: 'asset not in media library', Y: 'could not read or decode image file' } })).toBe(
      'These mentioned images are attached inline as image blocks — do not call inspect_media for them: A, B. These images could not be attached; tell the user the image could not be read rather than describing it: Y (could not read or decode image file), Z (asset not in media library).',
    )
  })
})

describe('apiMessages', () => {
  it('skips system messages, prefixes hint + inline images to user messages with mentions, maps roles', async () => {
    const calls: string[] = []
    const ctx: MentionContextProvider = {
      hint: (ms) => {
        calls.push('hint')
        return `LIVE(${ms.length})`
      },
      inlineImages: async (ms) => ({
        images: ms.filter((m) => m.type === 'image').map(() => ({ base64: 'IMG', mediaType: 'image/png' })),
        inlinedIds: ms.filter((m) => m.type === 'image').map((m) => m.mediaRef!),
        failures: {},
      }),
    }
    const out = await apiMessages(
      [
        msg('system', [{ kind: 'text', text: 'notice' }]),
        msg('user', [{ kind: 'text', text: 'look @Pic' }], { mentions: [{ id: '1', displayName: 'Pic', mediaRef: 'P1', type: 'image' }], contextHint: 'FROZEN' }),
        msg('assistant', [{ kind: 'text', text: 'ok' }]),
        msg('user', [{ kind: 'text', text: 'and @Vid' }], { mentions: [{ id: '2', displayName: 'Vid', mediaRef: 'V1', type: 'video' }] }),
        msg('assistant', []),
      ],
      ctx,
    )
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { kind: 'text', text: 'FROZEN These mentioned images are attached inline as image blocks — do not call inspect_media for them: P1.' },
          { kind: 'image', base64: 'IMG', mediaType: 'image/png' },
          { kind: 'text', text: 'look @Pic' },
        ],
      },
      { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      { role: 'user', content: [{ kind: 'text', text: 'LIVE(1)' }, { kind: 'text', text: 'and @Vid' }] },
    ])
    expect(calls).toEqual(['hint'])
  })
})

describe('system prompt', () => {
  it('is serverInstructions with only the rebrand + BYOK sentence rewritten, plus the skills section', () => {
    const base = spec.serverInstructions as string
    expect(AGENT_INSTRUCTIONS).not.toContain('sign in to Palmier')
    expect(AGENT_INSTRUCTIONS).toContain('ask the user to add an API key in Settings › Models & API Keys   first.')
    expect(REBRAND.reduce((s, [mac, linux]) => s.split(linux).join(mac), AGENT_INSTRUCTIONS)).toBe(base)
    expect(AGENT_INSTRUCTIONS).not.toContain('# Projects (MCP)')
    expect(skillsSection([])).toBe('')
    expect(systemPrompt([])).toBe(AGENT_INSTRUCTIONS)
    expect(
      systemPrompt([
        { id: 'zeta', description: 'Z things' },
        { id: 'caption-templates', description: 'Caption styles' },
      ]),
    ).toBe(`${AGENT_INSTRUCTIONS}\n# Skills\nPlaybooks for specific tasks. Before a task that matches one, call read_skill(id) to load its full procedure, then follow it.\n- caption-templates: Caption styles\n- zeta: Z things`)
  })
})
