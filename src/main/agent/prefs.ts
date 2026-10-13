/** App-level agent preferences: `agentModel` and per-model reasoning effort (spec 06 §A1.1–§A1.2). */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeEffort,
  normalizeModelId,
  supportedEfforts,
  type AgentModelId,
  type AgentReasoningEffort,
} from '../../shared/agent'

interface Stored {
  agentModel?: string
  agentReasoningEffort?: Record<string, string>
}

/** Stored in its own file (`agent.json` next to settings.json) so the shared settings schema is untouched. */
export class AgentPrefs extends EventEmitter {
  private data: Stored = {}
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly file: string | null) {
    super()
  }

  async load(): Promise<void> {
    if (!this.file) return
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (raw && typeof raw === 'object') this.data = raw
    } catch {
      this.data = {}
    }
  }

  get model(): AgentModelId {
    return normalizeModelId(this.data.agentModel)
  }

  effort(model: AgentModelId = this.model): AgentReasoningEffort {
    return normalizeEffort(model, this.data.agentReasoningEffort?.[model])
  }

  setModel(model: AgentModelId): void {
    if (normalizeModelId(model) !== model || model === this.model) return
    this.data = { ...this.data, agentModel: model }
    this.persist()
  }

  /** Unsupported efforts for the current model are ignored. */
  setEffort(effort: AgentReasoningEffort): void {
    const model = this.model
    if (!supportedEfforts(model).includes(effort)) return
    this.data = { ...this.data, agentReasoningEffort: { ...(this.data.agentReasoningEffort ?? {}), [model]: effort } }
    this.persist()
  }

  private persist(): void {
    this.emit('change')
    const file = this.file
    if (!file) return
    const json = JSON.stringify(this.data, null, 2)
    const run = async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${randomUUID()}`
      await fs.writeFile(tmp, json)
      await fs.rename(tmp, file)
    }
    this.chain = this.chain.then(run, run).catch((e) => console.error(`[agent] prefs: ${e instanceof Error ? e.message : String(e)}`))
  }
}
