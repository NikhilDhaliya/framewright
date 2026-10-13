import { TEST_ROOT } from './env'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activeTimeline } from '../../src/core/ops/context'
import { AGENT_INSTRUCTIONS } from '../../src/main/agent/instructions'
import { AgentPrefs } from '../../src/main/agent/prefs'
import { AgentService, IN_APP_TOOLS } from '../../src/main/agent/service'
import { SkillStore } from '../../src/main/agent/skills'
import type { AgentPanelState, AgentStreamUpdate } from '../../src/shared/agent'
import { anthropic, makeProject, openai, startFakeProvider, type AgentTestEnv, type FakeProvider } from './harness'

let fake: FakeProvider

beforeAll(async () => {
  fake = await startFakeProvider()
  process.env.PALMIER_ANTHROPIC_BASE_URL = fake.baseUrl
  process.env.PALMIER_OPENAI_BASE_URL = fake.baseUrl
})
afterAll(async () => {
  await fake.close()
})

interface Rig extends AgentTestEnv {
  agent: AgentService
  prefs: AgentPrefs
  states: AgentPanelState[]
  streams: AgentStreamUpdate[]
}

async function rig(): Promise<Rig> {
  const env = await makeProject()
  const prefs = new AgentPrefs(null)
  const skills = new SkillStore({ dir: path.join(TEST_ROOT, 'skills-int'), catalogBase: 'file:///nonexistent' })
  const states: AgentPanelState[] = []
  const streams: AgentStreamUpdate[] = []
  const agent = new AgentService({
    app: env.ctx,
    project: env.session,
    prefs,
    skills,
    keys: () => ({ anthropic: env.settings.apiKeys.anthropic, openai: env.settings.apiKeys.openai }),
    onState: (s) => states.push(structuredClone(s)),
    onStream: (u) => streams.push(structuredClone(u)),
    streamIntervalMs: 5,
  })
  await agent.ready
  return { ...env, agent, prefs, states, streams }
}

const markers = (r: Rig) => activeTimeline(r.session.doc).markers.map((m) => m.name)

describe('agent run loop against fake providers', () => {
  it('Anthropic: streams and runs real tools across iterations; each mutating call is one undo step', async () => {
    const r = await rig()
    r.prefs.setModel('claude-opus-5')
    r.prefs.setEffort('high')
    const before = r.session.doc
    fake.requests.length = 0
    fake.script.push(
      {
        events: anthropic.message(
          'tool_use',
          anthropic.thinking(0, 'Need two markers.', 'sig-1'),
          anthropic.text(1, "I'll add the markers."),
          anthropic.tool(2, 'toolu_1', 'manage_markers', { action: 'create', name: 'Intro', startFrame: 0 }),
        ),
        delayMs: 2,
      },
      { events: anthropic.message('tool_use', anthropic.tool(0, 'toolu_2', 'manage_markers', { action: 'create', name: 'Outro', startFrame: 30 })) },
      { events: anthropic.message('end_turn', anthropic.text(0, 'Done — two markers added.')) },
    )
    r.agent.send('  Add intro and outro markers  ', [])
    expect(r.agent.state().isStreaming).toBe(true)
    await r.agent.idle()

    expect(r.agent.streamError).toBeNull()
    expect(markers(r)).toEqual(['Intro', 'Outro'])

    // Three provider requests with the BYOK headers and the in-app tool list.
    expect(fake.requests.map((q) => q.path)).toEqual(['/v1/messages', '/v1/messages', '/v1/messages'])
    const [q1, q2, q3] = fake.requests
    expect(q1.headers['x-api-key']).toBe('sk-ant-test')
    expect(q1.headers['anthropic-version']).toBe('2023-06-01')
    expect(q1.headers['anthropic-beta']).toBeUndefined()
    expect(q1.headers.accept).toBe('text/event-stream')
    expect(q1.body.model).toBe('claude-opus-5')
    expect(q1.body.output_config).toEqual({ effort: 'high' })
    expect(q1.body.system[0].text).toBe(AGENT_INSTRUCTIONS)
    expect(q1.body.tools).toHaveLength(51)
    expect(q1.body.tools.map((t: { name: string }) => t.name)).not.toContain('manage_project')
    expect(q1.body.tools.at(-1)).toMatchObject({ name: 'manage_skills', cache_control: { type: 'ephemeral' } })
    expect(q1.raw.startsWith('{"max_tokens":64000,"messages":')).toBe(true)
    expect(q1.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Add intro and outro markers', cache_control: { type: 'ephemeral' } }] }])
    // Iteration 2 replays the signed thinking, the text, the tool use and its result.
    expect(q2.body.messages[1].content.map((b: { type: string }) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(q2.body.messages[1].content[2]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'manage_markers', input: { action: 'create', name: 'Intro', startFrame: 0 } })
    const result1 = q2.body.messages[2].content[0]
    expect(result1).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, cache_control: { type: 'ephemeral' } })
    expect(q3.body.messages).toHaveLength(5)

    // Transcript shape.
    const msgs = r.agent.state().messages
    expect(msgs.map((m) => [m.role, m.blocks.map((b) => b.kind).join(',')])).toEqual([
      ['user', 'text'],
      ['assistant', 'thinking,text,toolUse'],
      ['user', 'toolResult'],
      ['assistant', 'toolUse'],
      ['user', 'toolResult'],
      ['assistant', 'text'],
    ])
    expect(msgs[5].blocks[0]).toEqual({ kind: 'text', text: 'Done — two markers added.' })
    expect(r.streams.length).toBeGreaterThan(0)
    expect(r.streams.at(-1)!.blocks).toEqual(msgs[5].blocks)
    expect(r.states.at(-1)!.isStreaming).toBe(false)
    expect(r.agent.state().sessions[0].title).toBe('Add intro and outro markers')
    expect(r.ui.some((c) => c.type === 'agentActivity' && c.tool === 'manage_markers')).toBe(true)

    // Each mutating tool call is its own undo step, named by the tool, on the user's stack.
    expect(r.session.snapshot().undoLabel).toBe('Add Marker (Agent)')
    expect(r.session.undo()).toBe('Add Marker (Agent)')
    expect(markers(r)).toEqual(['Intro'])
    expect(r.session.undo()).toBe('Add Marker (Agent)')
    expect(markers(r)).toEqual([])
    expect(activeTimeline(r.session.doc)).toEqual(activeTimeline(before))
    expect(r.session.undo()).toBeNull()
    expect(r.session.redo()).toBe('Add Marker (Agent)')
    expect(r.session.redo()).toBe('Add Marker (Agent)')
    expect(markers(r)).toEqual(['Intro', 'Outro'])

    // chat/<UUID>.json written.
    await r.agent.saveNow()
    const files = await fs.readdir(path.join(r.session.path, 'chat'))
    expect(files).toEqual([`${r.agent.currentId}.json`])
    const saved = JSON.parse(await fs.readFile(path.join(r.session.path, 'chat', files[0]), 'utf8'))
    expect(saved.messages).toHaveLength(6)
    expect(saved.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  })

  it('OpenAI: replays same-model reasoning, sends function_call_output; one undo step per tool call', async () => {
    const r = await rig()
    r.prefs.setModel('gpt-5.6-terra')
    r.prefs.setEffort('minimal')
    fake.requests.length = 0
    fake.script.push(
      { events: [...openai.reasoning('rs_1', 'Plan', 'ENC-1'), ...openai.call('call_1', 'manage_markers', { action: 'create', name: 'A', startFrame: 0 }), openai.completed([{ type: 'reasoning' }, { type: 'function_call' }])] },
      { events: [...openai.text('Added A.'), openai.completed([{ type: 'message', content: [{ type: 'output_text' }] }])] },
      { events: [...openai.call('call_2', 'manage_markers', { action: 'create', name: 'B', startFrame: 12 }), openai.completed([{ type: 'function_call' }])] },
      { events: [...openai.text('Added B.'), openai.completed([])] },
    )
    r.agent.send('Add marker A', [])
    await r.agent.idle()
    r.agent.send('Add marker B', [])
    await r.agent.idle()
    expect(r.agent.streamError).toBeNull()
    expect(markers(r)).toEqual(['A', 'B'])
    const [q1, q2] = fake.requests
    expect(q1.path).toBe('/v1/responses')
    expect(q1.headers.authorization).toBe('Bearer sk-openai-test')
    expect(q1.body).toMatchObject({ model: 'gpt-5.6-terra', reasoning: { effort: 'minimal', summary: 'auto' }, store: false, stream: true, instructions: AGENT_INSTRUCTIONS })
    expect(q1.body.tools).toHaveLength(51)
    expect(q2.body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add marker A' }] },
      { type: 'reasoning', encrypted_content: 'ENC-1', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan' }] },
      { type: 'function_call', call_id: 'call_1', name: 'manage_markers', arguments: '{"action":"create","name":"A","startFrame":0}' },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: expect.any(String) }] },
    ])
    expect(r.agent.state().messages[1].blocks[0]).toEqual({ kind: 'openAIReasoning', summary: 'Plan', encryptedContent: 'ENC-1', itemID: 'rs_1', model: 'gpt-5.6-terra' })
    // Two user turns → two undo steps.
    r.session.undo()
    expect(markers(r)).toEqual(['A'])
    r.session.undo()
    expect(markers(r)).toEqual([])
  })

  it('Stop: aborts the stream, keeps partial text, shows no error; the next send resolves orphans', async () => {
    const r = await rig()
    r.prefs.setModel('claude-sonnet-5')
    fake.requests.length = 0
    fake.script.push({ events: [{ type: 'message_start', message: {} }, ...anthropic.text(0, 'Partial answer that never ends').slice(0, 4)], hang: true })
    r.agent.send('Say something long', [])
    for (let i = 0; i < 200 && !r.agent.state().messages[1]?.blocks.length; i++) await new Promise((res) => setTimeout(res, 10))
    r.agent.cancel()
    expect(r.agent.state().isStreaming).toBe(false)
    await r.agent.idle()
    expect(r.agent.streamError).toBeNull()
    const msgs = r.agent.state().messages
    expect(msgs).toHaveLength(2)
    expect(msgs[1].blocks[0].kind).toBe('text')
    expect((msgs[1].blocks[0] as { text: string }).text.length).toBeGreaterThan(0)
  })

  it('maps HTTP errors and missing keys to banners', async () => {
    const r = await rig()
    r.prefs.setModel('claude-fable-5')
    fake.script.push({ status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' })
    r.agent.send('hi', [])
    await r.agent.idle()
    expect(r.agent.streamError).toEqual({ kind: 'upstream', message: 'Anthropic API error (401): {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' })
    expect(r.agent.state().messages.map((m) => m.role)).toEqual(['user'])

    r.settings.apiKeys = {}
    r.agent.send('again', [])
    expect(r.agent.streamError).toEqual({ kind: 'unavailable', model: 'claude-fable-5', provider: 'anthropic' })
    expect(r.agent.state().canStream).toBe(false)
    expect(r.agent.state().activeBYOKProvider).toBeNull()
    r.settings.apiKeys = { openai: 'k' }
    r.prefs.setModel('gpt-5.6-sol')
    r.agent.onModelChanged()
    expect(r.agent.streamError).toBeNull()
    expect(r.agent.state().activeBYOKProvider).toBe('openai')
  })

  it('refusal stop reason shows the refusal banner', async () => {
    const r = await rig()
    r.prefs.setModel('claude-opus-5')
    fake.script.push({ events: anthropic.message('refusal', anthropic.text(0, 'No.')) })
    r.agent.send('bad request', [])
    await r.agent.idle()
    expect(r.agent.streamError).toEqual({ kind: 'refusal', model: 'claude-opus-5' })
  })

  it('session lifecycle: new chat, select, close, delete, reload from chat/', async () => {
    const r = await rig()
    r.prefs.setModel('claude-opus-5')
    fake.script.push({ events: anthropic.message('end_turn', anthropic.text(0, 'One')) })
    r.agent.send('first chat', [])
    await r.agent.idle()
    const first = r.agent.currentId
    r.agent.newChat()
    const second = r.agent.currentId
    expect(second).not.toBe(first)
    r.agent.newChat() // empty current is replaced, not kept
    expect(r.agent.sessions.filter((s) => s.messages.length === 0)).toHaveLength(1)
    r.agent.select(first)
    expect(r.agent.currentId).toBe(first)
    r.agent.closeTab(first)
    expect(r.agent.sessions.find((s) => s.id === first)!.isOpen).toBe(false)
    expect(r.agent.current.isOpen).toBe(true)
    await r.agent.saveNow()

    const reloaded = new AgentService({ app: r.ctx, project: r.session, prefs: r.prefs, skills: new SkillStore({ dir: path.join(TEST_ROOT, 'skills-int') }), keys: () => ({}), onState: () => undefined, onStream: () => undefined })
    await reloaded.ready
    expect(reloaded.sessions).toHaveLength(2)
    expect(reloaded.sessions[0].messages).toEqual([])
    expect(reloaded.sessions[1]).toMatchObject({ id: first, title: 'first chat', isOpen: false })
    reloaded.deleteSession(first)
    expect(reloaded.sessions).toHaveLength(1)
  })
})

describe('undo (parity with spec 06 §A3.8)', () => {
  it('the agent undo tool pops the latest step whatever its origin', async () => {
    const r = await rig()
    r.prefs.setModel('claude-opus-5')
    // A user edit first, on the same stack.
    r.session.transact('Add Marker', (d) => void activeTimeline(d).markers.push({ id: 'U', name: 'user', startFrame: 5, durationFrames: 0, color: { r: 1, g: 0, b: 0, a: 1 }, comment: '', status: 'open' } as never))
    fake.script.push(
      {
        events: anthropic.message(
          'tool_use',
          anthropic.tool(0, 'toolu_a', 'manage_markers', { action: 'create', name: 'A', startFrame: 0 }),
          anthropic.tool(1, 'toolu_u1', 'undo', {}),
          anthropic.tool(2, 'toolu_u2', 'undo', {}),
          anthropic.tool(3, 'toolu_u3', 'undo', {}),
        ),
      },
      { events: anthropic.message('end_turn', anthropic.text(0, 'Reverted.')) },
    )
    r.agent.send('add A then undo everything', [])
    await r.agent.idle()
    expect(r.agent.streamError).toBeNull()
    const results = r.agent.state().messages[2].blocks as { kind: string; isError: boolean; content: { text: string }[] }[]
    expect(results.map((b) => [b.kind, b.isError])).toEqual([
      ['toolResult', false],
      ['toolResult', false],
      ['toolResult', false],
      ['toolResult', true],
    ])
    expect(results[3].content[0].text).toBe('Nothing to undo.')
    // The first agent undo removed A, the second popped the user's own edit.
    expect(markers(r)).toEqual([])
    expect(r.session.undo()).toBeNull()
    expect(r.session.redo()).toBe('Add Marker')
    expect(r.session.redo()).toBe('Add Marker (Agent)')
    expect(markers(r)).toEqual(['A', 'user']) // markers are kept sorted by frame
  })
})

describe('tool list', () => {
  it('is the MCP list minus manage_project plus read_skill and manage_skills', () => {
    expect(IN_APP_TOOLS).toHaveLength(51)
    expect(IN_APP_TOOLS.slice(-3).map((t) => t.name)).toEqual(['send_feedback', 'read_skill', 'manage_skills'])
    expect(IN_APP_TOOLS[0].name).toBe('get_timeline')
  })
})
