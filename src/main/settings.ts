import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { AppSettings } from '../shared/api'
import { appDirs, defaultProjectsDir } from './paths'
import { isLocaleId } from '../shared/i18n'

type ApiKeys = AppSettings['apiKeys']
type Provider = keyof ApiKeys

const PROVIDERS: Provider[] = ['fal', 'replicate', 'openai', 'anthropic', 'elevenlabs', 'google']
const MASK = '•'.repeat(36)
const settingsFile = path.join(appDirs.config, 'settings.json')
const keysFile = path.join(appDirs.config, 'api-keys.bin')

export const DEFAULT_SETTINGS: AppSettings = {
  projectsDirectory: defaultProjectsDir,
  mcpEnabled: true,
  mcpPort: 19789,
  rippleTimelineMarkers: true,
  theme: 'dark',
  apiKeys: {},
  panels: { media: true, inspector: true, agent: false },
  layoutPreset: 'default',
}

async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${randomUUID()}`
  await fs.writeFile(tmp, data, { mode: 0o600 })
  await fs.rename(tmp, target)
}

function sanitize(raw: unknown): Omit<AppSettings, 'apiKeys'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>
  const d = DEFAULT_SETTINGS
  const port = Number(r.mcpPort)
  const panels = (r.panels && typeof r.panels === 'object' ? r.panels : {}) as Partial<AppSettings['panels']>
  return {
    projectsDirectory: typeof r.projectsDirectory === 'string' && path.isAbsolute(r.projectsDirectory) ? r.projectsDirectory : d.projectsDirectory,
    mcpEnabled: typeof r.mcpEnabled === 'boolean' ? r.mcpEnabled : d.mcpEnabled,
    mcpPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : d.mcpPort,
    rippleTimelineMarkers: typeof r.rippleTimelineMarkers === 'boolean' ? r.rippleTimelineMarkers : d.rippleTimelineMarkers,
    theme: r.theme === 'light' || r.theme === 'dark' || r.theme === 'system' ? r.theme : d.theme,
    timelineColors: sanitizeTimelineColors(r.timelineColors),
    panels: {
      media: typeof panels.media === 'boolean' ? panels.media : d.panels.media,
      inspector: typeof panels.inspector === 'boolean' ? panels.inspector : d.panels.inspector,
      agent: typeof panels.agent === 'boolean' ? panels.agent : d.panels.agent,
    },
    layoutPreset: r.layoutPreset === 'media' || r.layoutPreset === 'vertical' || r.layoutPreset === 'default' ? r.layoutPreset : d.layoutPreset,
    transcription: sanitizeTranscription(r.transcription),
    disabledModelIds: Array.isArray(r.disabledModelIds) ? [...new Set(r.disabledModelIds.filter((x): x is string => typeof x === 'string'))] : undefined,
    generationPromptExtra: typeof r.generationPromptExtra === 'number' && Number.isFinite(r.generationPromptExtra) ? Math.max(0, Math.min(600, r.generationPromptExtra)) : undefined,
    searchIndexEnabled: typeof r.searchIndexEnabled === 'boolean' ? r.searchIndexEnabled : undefined,
    hasSeenWelcome: typeof r.hasSeenWelcome === 'boolean' ? r.hasSeenWelcome : undefined,
    lastSeenVersion: typeof r.lastSeenVersion === 'string' ? r.lastSeenVersion : undefined,
    notificationsEnabled: typeof r.notificationsEnabled === 'boolean' ? r.notificationsEnabled : undefined,
    appLanguage: isLocaleId(r.appLanguage) ? r.appLanguage : undefined,
  }
}

/** Settings ▸ Appearance ▸ Timeline colors: `#RRGGBB` per clip kind; anything else is dropped (spec 05 §11.4). */
export const TIMELINE_COLOR_KINDS = ['video', 'audio', 'image', 'text', 'animation', 'sequence'] as const

export function sanitizeTimelineColors(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const k of TIMELINE_COLOR_KINDS) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v.toUpperCase()
  }
  return Object.keys(out).length ? out : undefined
}

/** Spec 07 §0.5 speech keys; unknown values drop back to their defaults. */
function sanitizeTranscription(raw: unknown): AppSettings['transcription'] {
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as Record<string, unknown>
  const out: NonNullable<AppSettings['transcription']> = {}
  if (typeof t.localModel === 'string' && ['large-v3-turbo-q5_0', 'small', 'base', 'tiny-q5_1'].includes(t.localModel)) out.localModel = t.localModel
  if (typeof t.localAutoDetect === 'boolean') out.localAutoDetect = t.localAutoDetect
  if (t.cloudProvider === 'elevenlabs' || t.cloudProvider === 'openai') out.cloudProvider = t.cloudProvider
  return Object.keys(out).length ? out : undefined
}

/** App preferences in $XDG_CONFIG_HOME/framewright; API keys encrypted with the system keyring when available. */
export class SettingsStore extends EventEmitter {
  private values: AppSettings = { ...DEFAULT_SETTINGS }
  private chain: Promise<void> = Promise.resolve()

  async load(): Promise<void> {
    const raw = await fs.readFile(settingsFile, 'utf8').then(JSON.parse).catch(() => ({}))
    this.values = { ...sanitize(raw), apiKeys: await this.loadKeys() }
  }

  private async loadKeys(): Promise<ApiKeys> {
    try {
      const bytes = await fs.readFile(keysFile)
      const text = bytes[0] === 0x7b ? bytes.toString('utf8') : safeStorage.decryptString(bytes)
      const parsed = JSON.parse(text) as Record<string, unknown>
      const keys: ApiKeys = {}
      for (const p of PROVIDERS) if (typeof parsed[p] === 'string' && parsed[p]) keys[p] = parsed[p] as string
      return keys
    } catch {
      return {}
    }
  }

  /** Full values including raw API keys (main process only). */
  get(): AppSettings {
    return this.values
  }

  /** Renderer-safe view: API keys masked. */
  masked(): AppSettings {
    const apiKeys: ApiKeys = {}
    for (const p of PROVIDERS) {
      const k = this.values.apiKeys[p]
      apiKeys[p] = k ? MASK + k.slice(-4) : ''
    }
    return { ...this.values, apiKeys }
  }

  set(patch: Partial<AppSettings>): Promise<AppSettings> {
    const { apiKeys: keyPatch, ...rest } = patch
    const next = { ...sanitize({ ...this.values, ...rest }), apiKeys: { ...this.values.apiKeys } }
    let keysChanged = false
    if (keyPatch && typeof keyPatch === 'object') {
      for (const p of PROVIDERS) {
        const v = keyPatch[p]
        if (typeof v !== 'string' || v.startsWith('•')) continue
        const trimmed = v.trim()
        if (trimmed) next.apiKeys[p] = trimmed
        else delete next.apiKeys[p]
        keysChanged = true
      }
    }
    this.values = next
    const run = async () => {
      const { apiKeys, ...plain } = next
      await writeAtomic(settingsFile, JSON.stringify(plain, null, 2))
      if (keysChanged) {
        const json = JSON.stringify(apiKeys)
        // Without a keyring the file is plain JSON readable only by the user (0600).
        await writeAtomic(keysFile, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json)
      }
    }
    const done = this.chain.then(run, run)
    this.chain = done.catch(() => undefined)
    this.emit('change', this.values)
    return done.then(() => this.masked())
  }
}
