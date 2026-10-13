import { describe, expect, it } from 'vitest'
import type { Clip, Track } from '../../src/core/model'
import { calloutPosition, findAIEditClip, hostPanel, linkGroupIds, makeSteps, stepCounter } from '../../src/renderer/tour/logic'
import { DISCOVERY_QUESTIONS, PROFILE_QUESTIONS, toggleOption } from '../../src/renderer/onboarding/survey'
import { formatMessage } from '../../src/shared/i18n'

const ids = (ctx: Parameters<typeof makeSteps>[0]) => makeSteps(ctx).map((s) => s.id)

describe('makeSteps (07 §7.3)', () => {
  it('has all 13 Mac steps (plus 10b) when everything is available', () => {
    expect(ids({ canGenerate: true, smartSearchOffered: true, hasAIEditClip: true })).toEqual([
      'intro', 'media', 'import', 'generate', 'generation', 'smartSearch', 'preview', 'screenshot', 'timeline', 'inspector', 'aiEdit', 'agent', 'skills', 'outro',
    ])
  })
  it('skips Generate steps without a provider key, and conditional steps', () => {
    expect(ids({ canGenerate: false, smartSearchOffered: false, hasAIEditClip: false })).toEqual(['intro', 'media', 'import', 'preview', 'screenshot', 'timeline', 'inspector', 'agent', 'skills', 'outro'])
  })
  it('uses the Linux copy and the AI-edit timeline variant', () => {
    const steps = makeSteps({ canGenerate: true, smartSearchOffered: true, hasAIEditClip: true })
    const by = (id: string) => steps.find((s) => s.id === id)!
    expect(by('smartSearch').instruction).toMatch(/nothing leaves your computer\.$/)
    expect(by('agent').instruction).toMatch(/adding your Anthropic or OpenAI API key in Settings\.$/)
    expect(by('timeline').instruction).toBe("Your timeline: the top half is video, the bottom half is audio. Click a clip to inspect it — we've selected one for you.")
    expect(by('timeline')).toMatchObject({ prepare: 'selectAIEditClip' })
    expect(by('inspector')).toMatchObject({ prepare: 'revealInspectorOverview' })
    expect(by('aiEdit')).toMatchObject({ prepare: 'revealAIEditTab' })
    const plain = makeSteps({ canGenerate: false, smartSearchOffered: false, hasAIEditClip: false })
    expect(plain.find((s) => s.id === 'timeline')!.instruction).toBe('Your timeline: the top half is video, the bottom half is audio. This is where you edit.')
    expect(plain.find((s) => s.id === 'inspector')).not.toHaveProperty('prepare')
  })
  it('counts spotlight steps only; the intro is step 0', () => {
    const steps = makeSteps({ canGenerate: false, smartSearchOffered: false, hasAIEditClip: false })
    expect(stepCounter(steps, 1)).toBe('Step 1 of 8')
    expect(stepCounter(steps, 8)).toBe('Step 8 of 8')
  })
  it('maps targets to host panels', () => {
    const steps = makeSteps({ canGenerate: true, smartSearchOffered: true, hasAIEditClip: true })
    const host = Object.fromEntries(steps.map((s) => [s.id, hostPanel(s)]))
    expect(host).toMatchObject({ intro: null, import: 'media', generation: 'media', aiEdit: 'inspector', skills: 'agent', timeline: 'timeline', outro: null })
  })
})

const clip = (id: string, mediaType: Clip['mediaType'], mediaRef: string, linkGroupId?: string) => ({ id, mediaType, mediaRef, linkGroupId }) as Clip
const track = (clips: Clip[]) => ({ clips }) as Track

describe('AI-edit clip', () => {
  const tracks = [track([clip('t1', 'text', 'x'), clip('v0', 'video', 'gone')]), track([clip('v1', 'video', 'a', 'g1'), clip('i1', 'image', 'b')]), track([clip('a1', 'audio', 'a', 'g1')])]
  const lib = (ref: string) => ref === 'a' || ref === 'b'
  it('is the first visual non-text clip in track order whose media is in the library', () => {
    expect(findAIEditClip(tracks, lib)?.id).toBe('v1')
    expect(findAIEditClip([track([clip('a', 'audio', 'a')])], lib)).toBeNull()
  })
  it('selects the whole link group', () => {
    expect(linkGroupIds(tracks, findAIEditClip(tracks, lib)!)).toEqual(['v1', 'a1'])
    expect(linkGroupIds(tracks, tracks[1].clips[1])).toEqual(['i1'])
  })
})

describe('calloutPosition (Mac: card centre, margin 24, est. height 220)', () => {
  const win = { width: 1600, height: 1000 }
  it('centres without a frame', () => {
    expect(calloutPosition(null, win)).toEqual({ x: 800, y: 500 })
  })
  it('prefers the right side, then left, vertically centred on the frame and clamped', () => {
    expect(calloutPosition({ x: 0, y: 100, width: 400, height: 300 }, win)).toEqual({ x: 584, y: 250 })
    expect(calloutPosition({ x: 1100, y: 100, width: 480, height: 300 }, win)).toEqual({ x: 1100 - 24 - 160, y: 250 })
    expect(calloutPosition({ x: 0, y: 0, width: 400, height: 40 }, win)).toEqual({ x: 584, y: 134 })
  })
  it('then above when there is room, else below, clamped inside the window', () => {
    expect(calloutPosition({ x: 100, y: 600, width: 1400, height: 300 }, win)).toEqual({ x: 800, y: 466 })
    expect(calloutPosition({ x: 100, y: 40, width: 1400, height: 300 }, win)).toEqual({ x: 800, y: 474 })
    expect(calloutPosition({ x: 0, y: 40, width: 1600, height: 940 }, win)).toEqual({ x: 800, y: 866 })
  })
})

describe('onboarding survey toggles (OnboardingStore.toggle)', () => {
  const single = DISCOVERY_QUESTIONS[0]
  const editors = DISCOVERY_QUESTIONS[1]
  it('single choice replaces and toggles off', () => {
    expect(toggleOption(single, [], 'google')).toEqual(['google'])
    expect(toggleOption(single, ['google'], 'github')).toEqual(['github'])
    expect(toggleOption(single, ['github'], 'github')).toEqual([])
  })
  it('the exclusive "None" clears others and is removed by another pick', () => {
    expect(toggleOption(editors, ['capcut', 'imovie'], 'none')).toEqual(['none'])
    expect(toggleOption(editors, ['none'], 'capcut')).toEqual(['capcut'])
    expect(toggleOption(editors, ['capcut'], 'imovie')).toEqual(['capcut', 'imovie'])
  })
  it('keeps the Mac option lists', () => {
    expect(editors.options.map((o) => o.label)).toContain('DaVinci Resolve')
    expect(PROFILE_QUESTIONS.map((q) => formatMessage(q.title, []))).toEqual(['What best describes your role?', 'What do you make?', 'What interests you most about Framewright?'])
  })
})
