/** One AgentService per open project, shared prefs/skills, and the main → renderer push channels. */
import type { AgentPanelState, AgentStreamUpdate } from '../../shared/agent'
import type { UiCommand } from '../../shared/api'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { InlineImageEncoder } from './images'
import { AgentPrefs } from './prefs'
import type { AgentClient } from './providers/types'
import { AgentService, type ApiKeys } from './service'
import { SkillStore } from './skills'

export const AGENT_STATE_CHANNEL = 'agent:state'
export const AGENT_STREAM_CHANNEL = 'agent:stream'

export interface AgentHubOptions {
  app: AppContext
  /** Pushes to the window showing `session`. */
  push(session: ProjectSession, channel: string, payload: unknown): void
  /** Agent preference file; null keeps preferences in memory (tests). */
  prefsFile: string | null
  skills?: SkillStore
  /** `$XDG_CACHE_HOME/framewright/skills-catalog.json` */
  skillsCacheFile?: string
  clientFor?(provider: 'anthropic' | 'openai', apiKey: string): AgentClient
}

/** Keys from the settings store; in dev builds ANTHROPIC_API_KEY / OPENAI_API_KEY take precedence (§A1.3). */
export function agentKeys(app: AppContext): ApiKeys {
  const k = app.settings().apiKeys
  const dev = process.env.PALMIER_DEV === '1'
  return {
    anthropic: (dev && process.env.ANTHROPIC_API_KEY) || k.anthropic,
    openai: (dev && process.env.OPENAI_API_KEY) || k.openai,
  }
}

export class AgentHub {
  readonly prefs: AgentPrefs
  readonly skills: SkillStore
  private readonly services = new Map<ProjectSession, AgentService>()
  private readonly encoder = new InlineImageEncoder()

  get app(): AppContext {
    return this.opts.app
  }

  constructor(private readonly opts: AgentHubOptions) {
    this.prefs = new AgentPrefs(opts.prefsFile)
    this.skills = opts.skills ?? new SkillStore({ cacheFile: opts.skillsCacheFile })
    this.prefs.on('change', () => {
      for (const s of this.live()) s.onModelChanged()
    })
  }

  private live(): AgentService[] {
    for (const [session, svc] of this.services) {
      if (session.closed) {
        this.services.delete(session)
        void svc.dispose()
      }
    }
    return [...this.services.values()]
  }

  /** The agent of `session`, created on first use (loads chat/ from the package). */
  serviceFor(session: ProjectSession): AgentService {
    this.live()
    let svc = this.services.get(session)
    if (!svc) {
      svc = new AgentService({
        app: this.opts.app,
        project: session,
        prefs: this.prefs,
        skills: this.skills,
        keys: () => agentKeys(this.opts.app),
        onState: (s: AgentPanelState) => this.opts.push(session, AGENT_STATE_CHANNEL, s),
        onStream: (u: AgentStreamUpdate) => this.opts.push(session, AGENT_STREAM_CHANNEL, u),
        clientFor: this.opts.clientFor,
        encoder: this.encoder,
      })
      this.services.set(session, svc)
    }
    return svc
  }

  /** Settings changed (keys may have been added or removed). */
  onSettingsChanged(): void {
    for (const s of this.live()) s.onKeysChanged()
  }

  /** MCP `manage_project open|create` toasts "Now editing: …"; the window's agent gets it as a system notice (§A2.1). */
  onUiCommand(session: ProjectSession, cmd: UiCommand): void {
    if (cmd.type !== 'toast' || !cmd.message.startsWith('Now editing: ')) return
    this.serviceFor(session).postSystemNotice(cmd.message)
  }

  /** Writes every open project's chats (before quit). */
  async saveAll(): Promise<void> {
    await Promise.all(this.live().map((s) => s.saveNow()))
  }

  /** Cancels runs and writes chats. */
  async disposeAll(): Promise<void> {
    const all = [...this.services.values()]
    this.services.clear()
    await Promise.all(all.map((s) => s.dispose()))
  }
}
