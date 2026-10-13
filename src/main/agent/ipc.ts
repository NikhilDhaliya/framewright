/** `agent:*` IPC handlers (the renderer side is `window.palmier.agent`, preload). */
import fs from 'node:fs/promises'
import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { isAgentModelId, type AgentMention, type AgentReasoningEffort } from '../../shared/agent'
import type { ProjectSession } from '../project/session'
import type { AgentHub } from './hub'
import type { AgentService } from './service'
import type { ExternalAgent } from '../../shared/skills'
import type { SkillStore } from './skills'
import { copyToExternalAgent, createSkillFromText, skillsSnapshot, validateSkillText } from './skillsPane'

const EFFORTS = new Set<AgentReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function cleanMentions(raw: unknown): AgentMention[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((m): m is AgentMention => !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.displayName === 'string')
}

export function registerAgentIpc(hub: AgentHub, sessionFor: (sender: WebContents) => ProjectSession | null): void {
  const svc = (e: IpcMainEvent | IpcMainInvokeEvent): AgentService | null => {
    const session = sessionFor(e.sender)
    return session && !session.closed ? hub.serviceFor(session) : null
  }
  const on = (channel: string, fn: (s: AgentService, ...args: unknown[]) => void) =>
    ipcMain.on(channel, (e, ...args: unknown[]) => {
      const s = svc(e)
      if (s) fn(s, ...args)
    })

  ipcMain.handle('agent:getState', async (e) => {
    const s = svc(e)
    if (!s) return null
    await s.ready
    return s.state()
  })
  on('agent:send', (s, text, mentions) => {
    if (typeof text === 'string') s.send(text, cleanMentions(mentions))
  })
  on('agent:cancel', (s) => s.cancel())
  on('agent:newChat', (s) => s.newChat())
  on('agent:select', (s, id) => typeof id === 'string' && s.select(id))
  on('agent:closeTab', (s, id) => typeof id === 'string' && s.closeTab(id))
  on('agent:delete', (s, id) => typeof id === 'string' && s.deleteSession(id))
  on('agent:setModel', (s, model) => isAgentModelId(model) && s.setModel(model))
  on('agent:setEffort', (s, effort) => EFFORTS.has(effort as AgentReasoningEffort) && s.setEffort(effort as AgentReasoningEffort))
  ipcMain.handle('agent:importPastedImage', async (e, data: unknown, mediaType: unknown) => {
    const session = sessionFor(e.sender)
    if (!session || session.closed || !(data instanceof Uint8Array) || (mediaType !== 'image/png' && mediaType !== 'image/tiff')) return null
    const ext = mediaType === 'image/png' ? 'png' : 'tiff'
    try {
      return await hub.app.media.importBytes(session, Buffer.from(data), `pasted.${ext}`, { prefix: 'pasted' })
    } catch (err) {
      console.error(`[agent] paste import failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })
  ipcMain.on('agent:openSkillsFolder', () => {
    void fs.mkdir(hub.skills.dir, { recursive: true }).then(() => shell.openPath(hub.skills.dir))
  })
  registerSkillsIpc(hub.skills)
}

/** `skills:*` handlers behind Settings ▸ Skills (renderer `window.palmier.skills`). */
export function registerSkillsIpc(store: SkillStore): void {
  const find = (id: unknown) => (typeof id === 'string' ? store.list().find((s) => s.id === id) : undefined)
  ipcMain.handle('skills:list', async () => {
    if (!store.isSyncing) await store.reload()
    return skillsSnapshot(store)
  })
  ipcMain.handle('skills:waitSync', async () => {
    await store.waitForSync()
    return skillsSnapshot(store)
  })
  ipcMain.handle('skills:refresh', async () => {
    await store.startSync()
    return skillsSnapshot(store)
  })
  ipcMain.handle('skills:read', (_e, id: unknown) => (typeof id === 'string' ? store.readRaw(id) : null))
  ipcMain.handle('skills:create', (_e, raw: unknown) => (typeof raw === 'string' ? createSkillFromText(store, raw) : { ok: false, error: 'Invalid skill.' }))
  ipcMain.handle('skills:save', async (_e, id: unknown, raw: unknown) => {
    if (typeof id !== 'string' || typeof raw !== 'string') return { ok: false, error: 'Invalid skill.' }
    const error = validateSkillText(raw)
    if (error) return { ok: false, error }
    return (await store.saveRaw(id, raw)) ? { ok: true } : { ok: false, error: 'Could not save the skill.' }
  })
  ipcMain.handle('skills:rename', async (_e, id: unknown, name: unknown) => {
    const skill = find(id)
    const v = typeof name === 'string' ? name.trim() : ''
    if (!skill || !v || /[\n\r]/.test(v)) return { ok: false, error: 'Enter a name.' }
    return (await store.update(skill, { name: v })) ? { ok: true } : { ok: false, error: 'Could not rename the skill.' }
  })
  ipcMain.handle('skills:delete', (_e, id: unknown) => {
    const skill = find(id)
    return skill ? store.delete(skill) : false
  })
  ipcMain.handle('skills:install', (_e, id: unknown) => {
    const entry = store.catalog.find((c) => c.id === id)
    return entry ? store.install(entry) : false
  })
  ipcMain.on('skills:showInFolder', (_e, id: unknown) => {
    const skill = find(id)
    if (skill) shell.showItemInFolder(skill.path)
  })
  ipcMain.on('skills:openFolder', () => {
    void fs.mkdir(store.dir, { recursive: true }).then(() => shell.openPath(store.dir))
  })
  ipcMain.handle('skills:addToExternal', (_e, id: unknown, agent: unknown) =>
    agent === 'claude' || agent === 'codex' || agent === 'cursor' ? copyToExternalAgent(store, String(id), agent as ExternalAgent) : { ok: false, error: 'Unknown agent.' },
  )
}
