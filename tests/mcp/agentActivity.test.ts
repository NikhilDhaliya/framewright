import './env'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeTimeline } from '../../src/core/ops/context'
import { withEditOrigin } from '../../src/main/project/editOrigin'
import type { UiCommand } from '../../src/shared/api'
import { call, connect, imageEntry, startHarness, type Harness } from './harness'

let h: Harness
let client: Client
const still = imageEntry()

beforeEach(async () => {
  h = await startHarness([still])
  client = await connect(h.url)
})

afterEach(async () => {
  await client.close()
  await h.close()
})

const timeline = () => activeTimeline(h.session.doc)
const of = <T extends UiCommand['type']>(type: T) => h.ui.filter((c): c is Extract<UiCommand, { type: T }> => c.type === type)

describe('agent activity (Mac ToolExecutor+AgentActivity)', () => {
  it('a read tool reports the range it reads and whether it succeeded', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: still.id, startFrame: 0 }] })
    h.ui.length = 0
    await call(client, 'inspect_timeline', { startFrame: 10, endFrame: 40 })
    const acts = of('agentActivity')
    expect(acts[0]).toEqual({ type: 'agentActivity', tool: 'inspect_timeline', status: 'start', read: { clipIds: [], range: [10, 40] } })
    expect(acts[1]).toMatchObject({ tool: 'inspect_timeline', status: 'end', ok: true })
    expect(of('agentChanges')).toEqual([])
  })

  it('a moved clip is reported as mutated, not added', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: still.id, startFrame: 0 }] })
    const id = timeline().tracks[0].clips[0].id
    h.ui.length = 0
    await call(client, 'move_clips', { moves: [{ clipId: id, toFrame: 60 }] })
    expect(of('agentChanges')).toEqual([{ type: 'agentChanges', changes: { addedClipIds: [], mutatedClipIds: [id], mutatedTrackIds: [] } }])
  })

  it('only edits outside an agent tool bump the non-agent revision', () => {
    const before = h.session.nonAgentTimelineRevision
    h.session.transact('Add Track', (d) => void activeTimeline(d).tracks.push({ ...activeTimeline(d).tracks[0], id: 'x', clips: [] } as never))
    expect(h.session.nonAgentTimelineRevision).toBe(before + 1)
    withEditOrigin('mcp', () => h.session.transact('Rename', (d) => void (activeTimeline(d).tracks[0].name = 'Agent')))
    expect(h.session.nonAgentTimelineRevision).toBe(before + 1)
  })
})
