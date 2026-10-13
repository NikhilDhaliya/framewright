import { describe, expect, it } from 'vitest'
import { initialStreamState, presentAgentStream, PresentationBuffer, reduceStream, type Scheduler, type StreamSnapshot, type StreamState } from '../../src/main/agent/presentation'
import type { ProviderEvent } from '../../src/main/agent/providers/types'

const run = (events: ProviderEvent[], model: 'gpt-5.6-terra' | 'claude-opus-5' = 'gpt-5.6-terra'): StreamState => events.reduce((s, e) => reduceStream(s, e, model), initialStreamState())

describe('stream reducer', () => {
  it('appends thinking text and signature to the last thinking block, else starts one', () => {
    const s = run(
      [
        { type: 'thinkingDelta', text: 'a' },
        { type: 'thinkingDelta', text: 'b' },
        { type: 'thinkingSignature', signature: 'S1' },
        { type: 'thinkingSignature', signature: 'S2' },
        { type: 'textDelta', text: 'x' },
        { type: 'thinkingSignature', signature: 'only' },
      ],
      'claude-opus-5',
    )
    expect(s.blocks).toEqual([
      { kind: 'thinking', text: 'ab', signature: 'S1S2' },
      { kind: 'text', text: 'x' },
      { kind: 'thinking', text: '', signature: 'only' },
    ])
  })

  it('coalesces text deltas and pushes tool uses / redacted thinking', () => {
    const s = run([
      { type: 'textDelta', text: 'Hel' },
      { type: 'textDelta', text: 'lo' },
      { type: 'toolUseComplete', id: 't1', name: 'get_timeline', input: '{}' },
      { type: 'textDelta', text: 'after' },
      { type: 'redactedThinking', data: 'R' },
    ])
    expect(s.blocks).toEqual([
      { kind: 'text', text: 'Hello' },
      { kind: 'toolUse', id: 't1', name: 'get_timeline', input: '{}' },
      { kind: 'text', text: 'after' },
      { kind: 'redactedThinking', data: 'R' },
    ])
  })

  it('streams an OpenAI reasoning summary into one block and completes it', () => {
    const s = run([
      { type: 'reasoningSummaryDelta', text: 'Pl' },
      { type: 'reasoningSummaryDelta', text: 'an' },
      { type: 'reasoningComplete', id: 'rs_1', summary: '', encryptedContent: 'E' },
      { type: 'reasoningComplete', id: null, summary: 'Second', encryptedContent: 'E2' },
    ])
    expect(s.blocks).toEqual([
      { kind: 'openAIReasoning', summary: 'Plan', encryptedContent: 'E', itemID: 'rs_1', model: 'gpt-5.6-terra' },
      { kind: 'openAIReasoning', summary: 'Second', encryptedContent: 'E2', model: 'gpt-5.6-terra' },
    ])
  })

  it('records the stop reason without changing blocks', () => {
    const before = run([{ type: 'textDelta', text: 'a' }])
    const after = reduceStream(before, { type: 'messageStop', reason: 'tool_use' }, 'gpt-5.6-terra')
    expect(after.blocks).toBe(before.blocks)
    expect(after.stopReason).toBe('tool_use')
    expect(initialStreamState().stopReason).toBe('end_turn')
  })
})

/** Manual clock for the 50 ms coalescing timer. */
function fakeScheduler() {
  const timers: { fn: () => void; at: number; id: number }[] = []
  let now = 0
  let next = 1
  const sched: Scheduler = {
    set: (fn, ms) => {
      const id = next++
      timers.push({ fn, at: now + ms, id })
      return id
    },
    clear: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const t of [...timers].filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
  }
  return { sched, advance, pending: () => timers.length }
}

describe('presentation buffer', () => {
  it('publishes the first change at once, then at most one coalesced snapshot per interval', () => {
    const { sched, advance, pending } = fakeScheduler()
    const published: StreamSnapshot[] = []
    const buf = new PresentationBuffer('gpt-5.6-terra', (s) => published.push(s), 50, sched)
    buf.apply({ type: 'textDelta', text: 'a' })
    expect(published.map((p) => p.revision)).toEqual([1])
    buf.apply({ type: 'textDelta', text: 'b' })
    buf.apply({ type: 'textDelta', text: 'c' })
    expect(pending()).toBe(1)
    expect(published).toHaveLength(1)
    advance(49)
    expect(published).toHaveLength(1)
    advance(1)
    expect(published.map((p) => [p.revision, (p.blocks[0] as { text: string }).text])).toEqual([
      [1, 'a'],
      [3, 'abc'],
    ])
    // messageStop is not a revision bump and does not publish.
    buf.apply({ type: 'messageStop', reason: 'end_turn' })
    expect(pending()).toBe(0)
    buf.apply({ type: 'textDelta', text: 'd' })
    const final = buf.complete()
    expect(final.revision).toBe(4)
    expect(published.at(-1)!.revision).toBe(4)
    expect(pending()).toBe(0)
    buf.apply({ type: 'textDelta', text: 'ignored' })
    expect(buf.snapshot().revision).toBe(4)
  })

  it('presentAgentStream applies snapshots, returns the final one and applies partial state before rethrowing', async () => {
    const applied: number[] = []
    async function* ok(): AsyncGenerator<ProviderEvent> {
      yield { type: 'textDelta', text: 'x' }
      yield { type: 'textDelta', text: 'y' }
      yield { type: 'messageStop', reason: 'tool_use' }
    }
    const final = await presentAgentStream(ok(), 'gpt-5.6-terra', (s) => applied.push(s.revision), { intervalMs: 10_000 })
    expect(final.stopReason).toBe('tool_use')
    expect(final.blocks).toEqual([{ kind: 'text', text: 'xy' }])
    expect(applied).toEqual([1, 2])

    const partial: StreamSnapshot[] = []
    async function* failing(): AsyncGenerator<ProviderEvent> {
      yield { type: 'textDelta', text: 'part' }
      yield { type: 'textDelta', text: 'ial' }
      throw new Error('boom')
    }
    await expect(presentAgentStream(failing(), 'gpt-5.6-terra', (s) => partial.push(s), { intervalMs: 10_000 })).rejects.toThrow('boom')
    expect(partial.at(-1)!.blocks).toEqual([{ kind: 'text', text: 'partial' }])
  })
})
