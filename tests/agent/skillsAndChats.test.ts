import { TEST_ROOT } from './env'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeSession, encodeSession, isoNow, loadChatSessions, saveChatSessions, type ChatSession } from '../../src/main/agent/chatStore'
import { skillToolHandlers } from '../../src/main/agent/skillTools'
import { parseFrontmatter, replacingFields, sha12, shouldAutomaticallyInstall, skillContents, SkillStore, suggestedId } from '../../src/main/agent/skills'
import type { ToolEnv, ToolResult } from '../../src/main/mcp/tools/context'
import { ToolError } from '../../src/main/mcp/tools/args'

const call = async (store: SkillStore, name: 'read_skill' | 'manage_skills', args: Record<string, unknown>): Promise<ToolResult> => {
  try {
    return await skillToolHandlers(store)[name]({} as ToolEnv, args)
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true }
    throw e
  }
}
const text = (r: ToolResult) => (r.content[0] as { text: string }).text

describe('SKILL.md format', () => {
  it('parses frontmatter (quotes stripped, body trimmed) and patches fields', () => {
    const raw = '---\nname: "Color grade"\ndescription: Warm looks\nextra: 1\n---\n\n  ## Steps\n1. a\n'
    expect(parseFrontmatter(raw)).toEqual({ fields: { name: 'Color grade', description: 'Warm looks', extra: '1' }, body: '## Steps\n1. a' })
    expect(replacingFields(raw, { description: 'Cool looks' })).toBe(raw.replace('Warm looks', 'Cool looks'))
    expect(replacingFields('---\nname: A\n---\nbody', { description: 'D', instructions: 'new' })).toBe('---\nname: A\ndescription: D\n---\n\nnew')
    expect(skillContents('N', 'D', 'I')).toBe('---\nname: N\ndescription: D\n---\nI')
  })

  it('suggests ids and applies the auto-install rule', () => {
    expect(suggestedId('Make a UGC ad — v2!')).toBe('make-a-ugc-ad-v2')
    expect(suggestedId('!!!')).toBe('new-skill')
    expect(suggestedId('x'.repeat(70) + ' y')).toBe('x'.repeat(64))
    expect(shouldAutomaticallyInstall(undefined, undefined, 'c', false)).toBe(true)
    expect(shouldAutomaticallyInstall(undefined, 'old', 'c', false)).toBe(false)
    expect(shouldAutomaticallyInstall('a', 'a', 'b', false)).toBe(true)
    expect(shouldAutomaticallyInstall('mod', 'a', 'b', false)).toBe(false)
    expect(shouldAutomaticallyInstall('a', undefined, 'b', false)).toBe(false)
    expect(shouldAutomaticallyInstall(undefined, undefined, 'c', true)).toBe(false)
  })
})

describe('skill tools', () => {
  it('create / read / update / remove with receipts and suppression', async () => {
    const dir = path.join(TEST_ROOT, 'skills-tools')
    const store = new SkillStore({ dir, catalogBase: 'file:///nonexistent' })
    await store.reload()
    expect(text(await call(store, 'manage_skills', {}))).toBe('manage_skills.action: expected one of: create, update, remove')
    expect(text(await call(store, 'manage_skills', { action: 'zap' }))).toBe("Unknown skill action 'zap'. Expected one of: create, update, remove.")
    expect(text(await call(store, 'manage_skills', { action: 'create', name: 'X', description: 'a\nb', instructions: 'i' }))).toBe('manage_skills.description: expected one line')
    expect(text(await call(store, 'manage_skills', { action: 'create', name: 'X', description: 'd', instructions: 'i', bogus: 1 }))).toBe(
      "manage_skills: unknown field(s) 'bogus'. Allowed: action, description, instructions, name.",
    )
    const created = await call(store, 'manage_skills', { action: 'create', name: ' Beat Cuts ', description: 'Cut to music', instructions: '## Do\nCut on beats.' })
    expect(JSON.parse(text(created))).toEqual({ skill: { description: 'Cut to music', id: 'beat-cuts', name: 'Beat Cuts' }, status: 'created' })
    expect(await fs.readFile(path.join(dir, 'beat-cuts', 'SKILL.md'), 'utf8')).toBe('---\nname: Beat Cuts\ndescription: Cut to music\n---\n## Do\nCut on beats.')
    expect(store.index()).toEqual([{ id: 'beat-cuts', description: 'Cut to music' }])
    expect(JSON.parse(text(await call(store, 'manage_skills', { action: 'create', name: 'Beat Cuts', description: 'Cut to music', instructions: '## Do\nCut on beats.' }))).status).toBe('unchanged')
    expect(text(await call(store, 'manage_skills', { action: 'create', name: 'Beat Cuts', description: 'Other', instructions: 'x' }))).toBe(
      "A skill with id 'beat-cuts' already exists. Use manage_skills with action='update'.",
    )
    expect(text(await call(store, 'read_skill', { id: 'beat-cuts' }))).toBe('## Do\nCut on beats.')
    expect(text(await call(store, 'read_skill', {}))).toBe("read_skill requires an 'id'.")
    expect(text(await call(store, 'read_skill', { id: 'nope' }))).toBe('Unknown skill: nope')
    expect(text(await call(store, 'manage_skills', { action: 'update', id: 'beat-cuts' }))).toBe('manage_skills update requires at least one of: name, description, instructions.')
    const updated = JSON.parse(text(await call(store, 'manage_skills', { action: 'update', id: 'beat-cuts', description: 'Cut to the beat', name: 'Beat Cuts' })))
    expect(updated).toEqual({ changed: ['description'], skill: { description: 'Cut to the beat', id: 'beat-cuts', name: 'Beat Cuts' }, status: 'updated' })
    const removed = JSON.parse(text(await call(store, 'manage_skills', { action: 'remove', id: 'beat-cuts' })))
    expect(removed).toEqual({ id: 'beat-cuts', name: 'Beat Cuts', status: 'removed' })
    expect(store.list()).toEqual([])
    const ledger = JSON.parse(await fs.readFile(path.join(dir, '.installed.json'), 'utf8'))
    expect(ledger).toEqual({ installed: {}, suppressed: ['beat-cuts'], version: 1 })
  })

  it('syncs the community catalog from a file:// base: installs new, skips suppressed and locally modified', async () => {
    const base = path.join(TEST_ROOT, 'catalog')
    const dir = path.join(TEST_ROOT, 'skills-sync')
    const body = (n: string) => `---\nname: ${n}\ndescription: ${n} desc\n---\nBody of ${n}`
    const entries = ['alpha', 'beta', 'gamma'].map((id) => ({ id, name: id, description: `${id} desc`, sha: sha12(body(id)), path: `skills/${id}/SKILL.md` }))
    for (const e of entries) {
      await fs.mkdir(path.join(base, 'skills', e.id), { recursive: true })
      await fs.writeFile(path.join(base, e.path), body(e.id))
    }
    await fs.writeFile(path.join(base, 'catalog.json'), JSON.stringify(entries))
    await fs.mkdir(path.join(dir, 'gamma'), { recursive: true })
    await fs.writeFile(path.join(dir, 'gamma', 'SKILL.md'), '---\nname: gamma\ndescription: mine\n---\nlocal')
    await fs.writeFile(path.join(dir, '.installed.json'), JSON.stringify({ version: 1, installed: {}, suppressed: ['beta'] }))
    const cacheFile = path.join(TEST_ROOT, 'cache', 'skills-catalog.json')
    const store = new SkillStore({ dir, catalogBase: pathToFileURL(base).href, cacheFile })
    await store.startSync()
    await store.waitForSync()
    expect(store.list().map((s) => [s.id, s.description])).toEqual([
      ['alpha', 'alpha desc'],
      ['gamma', 'mine'],
    ])
    const ledger = JSON.parse(await fs.readFile(path.join(dir, '.installed.json'), 'utf8'))
    expect(ledger.installed).toEqual({ alpha: entries[0].sha })
    expect(ledger.suppressed).toEqual(['beta'])
    expect(JSON.parse(await fs.readFile(cacheFile, 'utf8'))).toHaveLength(3)
  })
})

describe('chat persistence', () => {
  const session = (over: Partial<ChatSession> = {}): ChatSession => ({
    id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    title: 'Cut the intro',
    updatedAt: '2026-10-13T09:41:00Z',
    isOpen: true,
    messages: [
      { id: 'A1B2C3D4-0000-4000-8000-000000000001', role: 'user', blocks: [{ kind: 'text', text: 'Cut @Intro' }], mentions: [{ id: 'A1B2C3D4-0000-4000-8000-000000000009', displayName: 'Intro', mediaRef: 'M1', type: 'video' }], contextHint: 'hint' },
      {
        id: 'A1B2C3D4-0000-4000-8000-000000000002',
        role: 'assistant',
        blocks: [
          { kind: 'openAIReasoning', summary: 's', encryptedContent: 'e', itemID: 'rs_1', model: 'gpt-5.6-terra' },
          { kind: 'toolUse', id: 'call_1', name: 'remove_clips', input: '{"ids":["a"]}' },
        ],
        mentions: [],
      },
      { id: 'A1B2C3D4-0000-4000-8000-000000000003', role: 'user', blocks: [{ kind: 'toolResult', toolUseId: 'call_1', content: [{ kind: 'image', base64: 'AA', mediaType: 'image/png' }], isError: false }], mentions: [] },
    ],
    ...over,
  })

  it('round-trips with sorted keys, upper-case ids and fraction-free dates', () => {
    const text = encodeSession(session())
    expect(text).toContain('"id": "1B4E28BA-2FA1-11D2-883F-0016D3CCA427"')
    expect(text.indexOf('"id"')).toBeLessThan(text.indexOf('"isOpen"'))
    expect(text).not.toContain('"contextHint": null')
    const back = decodeSession(text)!
    expect(back).toEqual({ ...session(), id: '1B4E28BA-2FA1-11D2-883F-0016D3CCA427' })
    expect(isoNow(new Date('2026-10-13T09:41:00.123Z'))).toBe('2026-10-13T09:41:00Z')
  })

  it('treats the Mac-undecodable as skipped', () => {
    expect(decodeSession('{')).toBeNull()
    const bad = JSON.parse(encodeSession(session()))
    bad.messages[1].blocks[0].model = 'gpt-9'
    expect(decodeSession(JSON.stringify(bad))).toBeNull()
    const noMentions = JSON.parse(encodeSession(session()))
    delete noMentions.messages[0].mentions
    expect(decodeSession(JSON.stringify(noMentions))).toBeNull()
    const noOpen = JSON.parse(encodeSession(session()))
    delete noOpen.isOpen
    expect(decodeSession(JSON.stringify(noOpen))!.isOpen).toBe(true)
  })

  it('writes sessions with messages only and removes stale files', async () => {
    const pkg = path.join(TEST_ROOT, 'chat-pkg.palmier')
    await fs.mkdir(path.join(pkg, 'chat'), { recursive: true })
    await fs.writeFile(path.join(pkg, 'chat', 'OLD.json'), '{}')
    await fs.writeFile(path.join(pkg, 'chat', 'keep.txt'), 'x')
    const empty = session({ id: '2b4e28ba-2fa1-11d2-883f-0016d3cca427', messages: [] })
    await saveChatSessions(pkg, [session(), empty])
    expect((await fs.readdir(path.join(pkg, 'chat'))).sort()).toEqual(['1B4E28BA-2FA1-11D2-883F-0016D3CCA427.json', 'keep.txt'])
    const loaded = await loadChatSessions(pkg)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].messages[2].blocks[0]).toMatchObject({ kind: 'toolResult', content: [{ kind: 'image', base64: 'AA', mediaType: 'image/png' }] })
  })
})
