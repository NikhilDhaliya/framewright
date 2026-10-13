import { TEST_ROOT } from './env'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha12, skillContents, skillStatus, SkillStore, uniqueSkillId } from '../../src/main/agent/skills'
import { copyToExternalAgent, createSkillFromText, skillsSnapshot, tildePath, validateSkillText } from '../../src/main/agent/skillsPane'
import { sanitizeTimelineColors } from '../../src/main/settings'
import { NEW_SKILL_TEMPLATE } from '../../src/shared/skills'

const body = (n: string, extra = '') => `---\nname: ${n}\ndescription: ${n} desc\n---\nBody of ${n}${extra}`

async function catalogAt(name: string, ids: string[], version: Record<string, string> = {}) {
  const base = path.join(TEST_ROOT, name)
  const entries = ids.map((id) => ({ id, name: id, description: `${id} desc`, sha: sha12(body(id, version[id] ?? '')), path: `skills/${id}/SKILL.md` }))
  for (const id of ids) {
    await fs.mkdir(path.join(base, 'skills', id), { recursive: true })
    await fs.writeFile(path.join(base, 'skills', id, 'SKILL.md'), body(id, version[id] ?? ''))
  }
  await fs.writeFile(path.join(base, 'catalog.json'), JSON.stringify(entries))
  return pathToFileURL(base).href
}

describe('skill status and ids', () => {
  it('derives Local / Community / Update available / Modified', () => {
    expect(skillStatus('a', undefined, undefined)).toBe('local')
    expect(skillStatus('a', undefined, 'b')).toBe('local')
    expect(skillStatus('a', 'a', 'a')).toBe('community')
    expect(skillStatus('a', 'a', undefined)).toBe('community')
    expect(skillStatus('a', 'a', 'b')).toBe('update')
    expect(skillStatus('x', 'a', 'b')).toBe('modified')
  })

  it('picks a free id', () => {
    expect(uniqueSkillId('new-skill', new Set())).toBe('new-skill')
    expect(uniqueSkillId('new-skill', new Set(['new-skill', 'new-skill-2']))).toBe('new-skill-3')
  })

  it('validates SKILL.md text like the Mac save (nonempty name and description)', () => {
    expect(validateSkillText(NEW_SKILL_TEMPLATE)).toBeNull()
    expect(validateSkillText('no frontmatter')).toBe('Add nonempty name and description fields to the skill frontmatter.')
    expect(validateSkillText('---\nname: A\n---\nx')).toBe('Add nonempty name and description fields to the skill frontmatter.')
  })

  it('shows home paths with ~', () => {
    expect(tildePath('/home/me/.palmier/skills/x', '/home/me')).toBe('~/.palmier/skills/x')
    expect(tildePath('/opt/x', '/home/me')).toBe('/opt/x')
  })
})

describe('Settings ▸ Skills backend', () => {
  it('lists installed and community skills with statuses through a catalog update', async () => {
    const dir = path.join(TEST_ROOT, 'pane-skills')
    const cacheFile = path.join(TEST_ROOT, 'pane-cache.json')
    const store = new SkillStore({ dir, catalogBase: await catalogAt('cat1', ['alpha', 'beta']), cacheFile })
    await store.create(skillContents('Mine', 'My own', 'Do it'), 'mine')
    await store.startSync()
    let snap = skillsSnapshot(store, TEST_ROOT)
    expect(snap.catalog).toBe('ok')
    expect(snap.installed.map((s) => [s.id, s.status])).toEqual([['alpha', 'community'], ['beta', 'community'], ['mine', 'local']])
    expect(snap.installed[2].displayDir).toBe('~/pane-skills/mine')
    expect(snap.community.map((c) => [c.id, c.status])).toEqual([['alpha', 'community'], ['beta', 'community']])

    // User edits beta; catalog ships a new alpha and beta → alpha auto-updates, beta stays Modified.
    const beta = store.list().find((s) => s.id === 'beta')!
    expect(await store.saveRaw('beta', body('beta', '\nmine'))).not.toBeNull()
    expect(await store.saveRaw('beta', 'invalid')).toBeNull()
    const store2 = new SkillStore({ dir, catalogBase: await catalogAt('cat2', ['alpha', 'beta', 'gamma'], { alpha: ' v2', beta: ' v2' }), cacheFile })
    await store2.startSync()
    snap = skillsSnapshot(store2, TEST_ROOT)
    expect(Object.fromEntries(snap.installed.map((s) => [s.id, s.status]))).toEqual({ alpha: 'community', beta: 'modified', gamma: 'community', mine: 'local' })
    expect(beta.path).toBe(path.join(dir, 'beta', 'SKILL.md'))

    // Deleting a community skill suppresses it; Community shows it as Available; Install brings it back.
    expect(await store2.delete(store2.list().find((s) => s.id === 'gamma')!)).toBe(true)
    snap = skillsSnapshot(store2, TEST_ROOT)
    expect(snap.community.find((c) => c.id === 'gamma')?.status).toBe('available')
    expect(await store2.install(store2.catalog.find((c) => c.id === 'gamma')!)).toBe(true)
    expect(skillsSnapshot(store2, TEST_ROOT).installed.find((s) => s.id === 'gamma')?.status).toBe('community')
  })

  it('reports an unreachable catalog as unavailable, falling back to the cached one', async () => {
    const dir = path.join(TEST_ROOT, 'pane-offline')
    const offline = new SkillStore({ dir, catalogBase: 'file:///nonexistent-catalog' })
    await offline.startSync()
    expect(skillsSnapshot(offline).catalog).toBe('unavailable')
    expect(skillsSnapshot(offline).catalogError).toMatch(/ENOENT/)
    const cacheFile = path.join(TEST_ROOT, 'offline-cache.json')
    await fs.writeFile(cacheFile, JSON.stringify([{ id: 'c', name: 'c', description: 'd', sha: 'x', path: 'p' }]))
    const cached = new SkillStore({ dir, catalogBase: 'file:///nonexistent-catalog', cacheFile })
    await cached.startSync()
    const snap = skillsSnapshot(cached)
    expect(snap.catalog).toBe('ok')
    expect(snap.community.map((c) => c.id)).toEqual(['c'])
  })

  it('creates new skills under unique ids and copies them to external agents', async () => {
    const dir = path.join(TEST_ROOT, 'pane-new')
    const store = new SkillStore({ dir, catalogBase: 'file:///nonexistent' })
    expect(await createSkillFromText(store, NEW_SKILL_TEMPLATE)).toEqual({ ok: true, id: 'new-skill' })
    expect(await createSkillFromText(store, NEW_SKILL_TEMPLATE.replace('New skill', 'Trailer'))).toEqual({ ok: true, id: 'new-skill-2' })
    expect(await createSkillFromText(store, 'nope')).toMatchObject({ ok: false })
    expect(await store.readRaw('new-skill')).toBe(NEW_SKILL_TEMPLATE)
    const home = path.join(TEST_ROOT, 'home')
    const r = await copyToExternalAgent(store, 'new-skill', 'claude', home)
    expect(r).toEqual({ ok: true, path: path.join(home, '.claude', 'skills', 'framewright-new-skill'), displayPath: '~/.claude/skills/framewright-new-skill' })
    expect(await fs.readFile(path.join(home, '.claude/skills/framewright-new-skill/SKILL.md'), 'utf8')).toBe(NEW_SKILL_TEMPLATE)
    expect((await copyToExternalAgent(store, 'new-skill', 'cursor', home)).ok).toBe(true)
    expect(await copyToExternalAgent(store, 'missing', 'codex', home)).toEqual({ ok: false, error: 'Unknown skill.' })
  })
})

describe('timeline colors setting', () => {
  it('keeps only #RRGGBB values for known kinds', () => {
    expect(sanitizeTimelineColors({ video: '#a1b2c3', audio: 'red', bogus: '#000000', text: '#FFF' })).toEqual({ video: '#A1B2C3' })
    expect(sanitizeTimelineColors({})).toBeUndefined()
    expect(sanitizeTimelineColors('x')).toBeUndefined()
  })
})
