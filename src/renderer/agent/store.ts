/** Renderer view of the window's agent (state snapshots from main) plus the local draft and its mentions. */
import { create } from 'zustand'
import type { AgentMention, AgentPanelState, AgentStreamUpdate } from '../../shared/agent'
import { getDoc, getTimeline } from '../state/project'
import { editor } from '../state/editor'
import { showPanelFitting } from '../editor/panelFit'
import { attachAsset, attachClips, attachRange, type Draft } from './mentions'

interface AgentStore {
  state: AgentPanelState | null
  draft: string
  mentions: AgentMention[]
  /** Bumped when the draft is replaced from outside the composer (focus + caret to end). */
  draftNonce: number
}

export const useAgent = create<AgentStore>(() => ({ state: null, draft: '', mentions: [], draftNonce: 0 }))

let subscribed = false

function applyStream(u: AgentStreamUpdate): void {
  const cur = useAgent.getState().state
  if (!cur || cur.currentId !== u.sessionId) return
  const i = cur.messages.findIndex((m) => m.id === u.messageId)
  if (i < 0) return
  const messages = cur.messages.slice()
  messages[i] = { ...messages[i], blocks: u.blocks }
  useAgent.setState({ state: { ...cur, messages } })
}

/** Subscribes once per window and (re)fetches the current project's agent state. */
export async function refreshAgent(): Promise<void> {
  if (!subscribed) {
    subscribed = true
    window.palmier.agent.onState((state) => useAgent.setState({ state }))
    window.palmier.agent.onStream(applyStream)
  }
  const state = await window.palmier.agent.getState()
  useAgent.setState({ state })
}

export const setDraft = (draft: string, mentions?: AgentMention[]) => useAgent.setState(mentions ? { draft, mentions } : { draft })

const replaceDraft = (d: Draft) => useAgent.setState((s) => ({ draft: d.text, mentions: d.mentions, draftNonce: s.draftNonce + 1 }))
const currentDraft = (): Draft => ({ text: useAgent.getState().draft, mentions: useAgent.getState().mentions })

export function showAgentPanel(): void {
  showPanelFitting('agent')
}

/** Composer submit: sends and clears the draft (the panel's submit handler, §A3.1). */
export function sendDraft(): void {
  const { draft, mentions, state } = useAgent.getState()
  if (!state || state.isStreaming || !state.canStream || !draft.trim()) return
  window.palmier.agent.send(draft, mentions)
  useAgent.setState({ draft: '', mentions: [] })
}

/** Starter prompt: fills the draft, clears draft mentions, never sends. */
export function fillPrompt(prompt: string): void {
  useAgent.setState((s) => ({ draft: prompt, mentions: [], draftNonce: s.draftNonce + 1 }))
}

/** Hand-off (§A14): new chat → draft = prompt (mentions untouched) → show the panel. Nothing is sent. */
export function handOff(prompt: string): void {
  window.palmier.agent.newChat()
  useAgent.setState((s) => ({ draft: prompt, draftNonce: s.draftNonce + 1 }))
  showAgentPanel()
}

export function addAssetToChat(assetId: string): void {
  const entry = getDoc()?.manifest.entries.find((e) => e.id === assetId)
  if (!entry) return
  showAgentPanel()
  replaceDraft(attachAsset(currentDraft(), entry))
}

export function addClipsToChat(clipIds: string[]): void {
  const doc = getDoc()
  const timeline = getTimeline()
  if (!doc || !timeline || !clipIds.length) return
  showAgentPanel()
  replaceDraft(attachClips(currentDraft(), doc, timeline, clipIds))
}

export function addRangeToChat(): void {
  const range = editor().range
  const timeline = getTimeline()
  if (!range || !timeline || range.end === range.start) return
  showAgentPanel()
  replaceDraft(attachRange(currentDraft(), range, timeline.fps))
}

export function addImportedAssetsToChat(assetIds: string[]): void {
  for (const id of assetIds) addAssetToChat(id)
}
