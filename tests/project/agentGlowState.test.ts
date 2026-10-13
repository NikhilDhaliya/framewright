import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentActivity,
  emptyActivity,
  glowOpacity,
  handleAgentUiCommand,
  isEmpty,
  useAgentActivity,
  withChanges,
  withReadBegin,
} from '../../src/renderer/timeline/agentActivity'

const changes = (added: string[], mutated: string[] = [], tracks: string[] = []) => ({ addedClipIds: added, mutatedClipIds: mutated, mutatedTrackIds: tracks })

beforeEach(() => {
  vi.useFakeTimers()
  clearAgentActivity()
})
afterEach(() => vi.useRealTimers())

describe('agent glow state (Mac EditorViewModel+AgentActivity)', () => {
  it('change highlights accumulate, added wins over mutated, and clear after hold + fade', () => {
    handleAgentUiCommand({ type: 'agentChanges', changes: changes(['a'], ['b']) })
    handleAgentUiCommand({ type: 'agentChanges', changes: changes([], ['a', 'c'], ['t1']) })
    const a = useAgentActivity.getState()
    expect([...a.addedClipIds]).toEqual(['a'])
    expect([...a.mutatedClipIds].sort()).toEqual(['b', 'c'])
    expect([...a.mutatedTrackIds]).toEqual(['t1'])
    vi.advanceTimersByTime(1200)
    expect(isEmpty(useAgentActivity.getState())).toBe(false)
    vi.advanceTimersByTime(200)
    expect(isEmpty(useAgentActivity.getState())).toBe(true)
  })

  it('a read stays lit while the tool runs, fades after success, clears at once on failure', () => {
    handleAgentUiCommand({ type: 'agentActivity', tool: 'inspect_media', status: 'start', read: { clipIds: ['a'], range: null } })
    expect(useAgentActivity.getState().isActive).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(useAgentActivity.getState().isActive).toBe(true)
    handleAgentUiCommand({ type: 'agentActivity', tool: 'inspect_media', status: 'end', ok: true })
    const ended = useAgentActivity.getState()
    expect(ended.isActive).toBe(false)
    expect([...ended.readClipIds]).toEqual(['a'])
    vi.advanceTimersByTime(1000)
    expect(isEmpty(useAgentActivity.getState())).toBe(true)

    handleAgentUiCommand({ type: 'agentActivity', tool: 'get_timeline', status: 'start', read: { clipIds: [], range: [0, 30] } })
    handleAgentUiCommand({ type: 'agentActivity', tool: 'get_timeline', status: 'end', ok: false })
    expect(isEmpty(useAgentActivity.getState())).toBe(true)
  })

  it('a read never replaces a change highlight; a change replaces a read', () => {
    const changed = withChanges(emptyActivity(), changes(['a']))!
    expect(withReadBegin(changed, { clipIds: ['b'], range: null })).toBeNull()
    const read = withReadBegin(emptyActivity(), { clipIds: ['b'], range: null })!
    const after = withChanges(read, changes([], ['c']))!
    expect([...after.readClipIds]).toEqual([])
    expect([...after.mutatedClipIds]).toEqual(['c'])
  })

  it('opacity holds, then eases out to zero', () => {
    const a = withChanges(emptyActivity(), changes(['a']))!
    expect(glowOpacity(a, 0.5)).toBe(1)
    expect(glowOpacity(a, 1.15)).toBeGreaterThan(0)
    expect(glowOpacity(a, 1.15)).toBeLessThan(1)
    expect(glowOpacity(a, 1.3)).toBe(0)
    expect(glowOpacity({ ...withReadBegin(emptyActivity(), { clipIds: ['a'], range: null })! }, 99)).toBe(1)
  })
})
