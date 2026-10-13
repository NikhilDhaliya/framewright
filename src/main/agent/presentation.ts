/** Stream presentation: a pure reducer over provider events plus 50 ms snapshot coalescing (spec 06 §A9). */
import type { AgentContentBlock, AgentModelId } from '../../shared/agent'
import type { ProviderEvent, StopReason } from './providers/types'

export interface StreamState {
  blocks: AgentContentBlock[]
  stopReason: StopReason
}

export interface StreamSnapshot extends StreamState {
  revision: number
}

export const initialStreamState = (): StreamState => ({ blocks: [], stopReason: 'end_turn' })

/**
 * Takes the summary of a still-streaming reasoning block of this model off the end.
 * (The Mac also pops a *completed* reasoning block here, dropping its encrypted content when two
 * reasoning items arrive back to back; only the streaming one is merged on Linux.)
 */
function takeStreamingSummary(blocks: AgentContentBlock[], model: AgentModelId): [AgentContentBlock[], string] {
  const last = blocks[blocks.length - 1]
  if (last?.kind === 'openAIReasoning' && last.model === model && !last.encryptedContent) return [blocks.slice(0, -1), last.summary]
  return [blocks, '']
}

/** Pure reducer (AgentStreamReducer). Returns the same state object when nothing visible changed. */
export function reduceStream(state: StreamState, event: ProviderEvent, model: AgentModelId): StreamState {
  const blocks = state.blocks
  const last = blocks[blocks.length - 1]
  const replaceLast = (b: AgentContentBlock) => ({ ...state, blocks: [...blocks.slice(0, -1), b] })
  const push = (b: AgentContentBlock) => ({ ...state, blocks: [...blocks, b] })
  switch (event.type) {
    case 'thinkingDelta':
      return last?.kind === 'thinking' ? replaceLast({ ...last, text: last.text + event.text }) : push({ kind: 'thinking', text: event.text, signature: '' })
    case 'thinkingSignature':
      return last?.kind === 'thinking' ? replaceLast({ ...last, signature: last.signature + event.signature }) : push({ kind: 'thinking', text: '', signature: event.signature })
    case 'redactedThinking':
      return push({ kind: 'redactedThinking', data: event.data })
    case 'reasoningSummaryDelta': {
      const [rest, summary] = takeStreamingSummary(blocks, model)
      return { ...state, blocks: [...rest, { kind: 'openAIReasoning', summary: summary + event.text, encryptedContent: '', model }] }
    }
    case 'reasoningComplete': {
      const [rest, summary] = takeStreamingSummary(blocks, model)
      const block: AgentContentBlock = { kind: 'openAIReasoning', summary: event.summary || summary, encryptedContent: event.encryptedContent, model }
      if (event.id) block.itemID = event.id
      return { ...state, blocks: [...rest, block] }
    }
    case 'textDelta':
      return last?.kind === 'text' ? replaceLast({ kind: 'text', text: last.text + event.text }) : push({ kind: 'text', text: event.text })
    case 'toolUseComplete':
      return push({ kind: 'toolUse', id: event.id, name: event.name, input: event.input })
    case 'messageStop':
      return { ...state, stopReason: event.reason }
  }
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realScheduler: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) }

/** AgentStreamPresentationBuffer: first change publishes at once, later ones at most every `intervalMs`. */
export class PresentationBuffer {
  private state = initialStreamState()
  private revision = 0
  private dirty = false
  private published = false
  private completed = false
  private timer: unknown = null

  constructor(
    private readonly model: AgentModelId,
    private readonly publish: (s: StreamSnapshot) => void,
    private readonly intervalMs = 50,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  snapshot(): StreamSnapshot {
    return { ...this.state, revision: this.revision }
  }

  apply(event: ProviderEvent): void {
    if (this.completed) return
    this.state = reduceStream(this.state, event, this.model)
    if (event.type === 'messageStop') return
    this.revision++
    this.dirty = true
    if (!this.published) this.flush()
    else if (this.timer === null) {
      this.timer = this.scheduler.set(() => {
        this.timer = null
        if (this.dirty && !this.completed) this.flush()
      }, this.intervalMs)
    }
  }

  /** Stops the timer, publishes anything pending and returns the final snapshot; later events are ignored. */
  complete(): StreamSnapshot {
    if (!this.completed) {
      this.completed = true
      if (this.timer !== null) this.scheduler.clear(this.timer)
      this.timer = null
      if (this.dirty) this.flush()
    }
    return this.snapshot()
  }

  private flush(): void {
    this.dirty = false
    this.published = true
    this.publish(this.snapshot())
  }
}

/**
 * Feeds provider events through the buffer, handing snapshots to `apply` (skipping repeats).
 * On error or cancellation the last snapshot is still applied, then the error is rethrown.
 */
export async function presentAgentStream(
  source: AsyncIterable<ProviderEvent>,
  model: AgentModelId,
  apply: (s: StreamSnapshot) => void,
  opts: { intervalMs?: number; scheduler?: Scheduler } = {},
): Promise<StreamSnapshot> {
  let lastApplied = 0
  const deliver = (s: StreamSnapshot) => {
    if (s.revision === lastApplied) return
    lastApplied = s.revision
    apply(s)
  }
  const buffer = new PresentationBuffer(model, deliver, opts.intervalMs, opts.scheduler)
  try {
    for await (const event of source) buffer.apply(event)
  } catch (e) {
    deliver(buffer.complete())
    throw e
  }
  const final = buffer.complete()
  deliver(final)
  return final
}
