import { ArrowDown, Book, Captions, Film, History, Layers2, Metronome, Music, Plus, RectangleVertical, Scissors, Settings, Trash2, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PROVIDER_NAMES, modelInfo, type AgentContentBlock, type AgentPanelState, type AgentStreamError, type ChatSessionInfo } from '../../shared/agent'
import { openDialog } from '../state/dialogs'
import { useProject } from '../state/project'
import { DocTab } from '../ui/panels'
import { Popover, rectOf, type AnchorRect } from '../ui/Popover'
import { Composer } from './Composer'
import { MessageView, ThinkingDots } from './Message'
import { fillPrompt, refreshAgent, useAgent } from './store'
import './agent.css'
import { activeLocale, t } from '../i18n'

type ToolResult = Extract<AgentContentBlock, { kind: 'toolResult' }>

export const STARTERS: { id: string; title: string; icon: LucideIcon; prompt: string }[] = [
  { id: 'keep_best_takes', title: t('Keep the best takes'), icon: Scissors, prompt: 'Tighten this edit. Keep the strongest takes, cut filler words and long silences, and leave a clean continuous cut.' },
  { id: 'sync_multicam', title: t('Sync my multicam'), icon: Layers2, prompt: 'Set up my multicam. Group the matching camera angles with their audio, verify sync, and leave it ready to switch.' },
  { id: 'generate_broll', title: t('Generate B-roll'), icon: Film, prompt: 'Generate B-roll that fits this edit. Find moments that need cutaways, create matching shots, and place them where they support the story.' },
  { id: 'score_timeline', title: t('Score my timeline'), icon: Music, prompt: 'Generate music for this timeline. Match the mood and length, then place it on an audio track synced to the edit.' },
  { id: 'cut_to_beat', title: t('Cut to the beat'), icon: Metronome, prompt: 'Assemble my clips to the beat of a song. Detect the beats and cut or place clips so the edit hits the rhythm.' },
  { id: 'add_captions', title: t('Add captions'), icon: Captions, prompt: 'Add captions to this timeline. Transcribe the dialogue, phrase it for readability, and place text clips locked to the speech.' },
  {
    id: 'make_vertical_shorts',
    title: t('Make vertical shorts'),
    icon: RectangleVertical,
    prompt: 'Find the strongest moments in this video and turn each into a short-form vertical clip. Create multiple 9:16 timelines, reframe for vertical, and keep every clip tight and self-contained.',
  },
]

const openKeys = () => openDialog({ kind: 'settings', pane: 'keys' })
const tabTitle = (t: string) => (t.length > 20 ? `${t.slice(0, 20)}…` : t)

function relativeTime(iso: string): string {
  const secs = (Date.parse(iso) - Date.now()) / 1000
  const rtf = new Intl.RelativeTimeFormat(activeLocale(), { style: 'short', numeric: 'always' })
  const abs = Math.abs(secs)
  if (abs < 60) return rtf.format(Math.round(secs), 'second')
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(secs / 86400), 'day')
  return rtf.format(Math.round(secs / (86400 * 30)), 'month')
}

function HistoryPopover({ anchor, sessions, currentId, onClose }: { anchor: AnchorRect; sessions: ChatSessionInfo[]; currentId: string; onClose: () => void }) {
  const rows = [...sessions].filter((s) => s.messageCount > 0 || s.id === currentId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return (
    <Popover anchor={anchor} onClose={onClose} align="center" className="pp-agent-history">
      {rows.length === 0 ? (
        <div className="pp-agent-history-empty">{t('No conversations yet')}</div>
      ) : (
        <div className="pp-agent-history-list no-scrollbar">
          {rows.map((s) => (
            <div
              key={s.id}
              className={`pp-agent-history-row${s.id === currentId ? ' on' : ''}`}
              onClick={() => {
                window.palmier.agent.selectSession(s.id)
                onClose()
              }}
            >
              <div className="pp-agent-history-text">
                <div className="pp-agent-history-title">{s.title}</div>
                <div className="pp-agent-history-time">{relativeTime(s.updatedAt)}</div>
              </div>
              {s.id !== currentId && (
                <button
                  type="button"
                  className="pp-agent-history-trash"
                  data-tip={t('Delete from history')}
                  aria-label={t('Delete from history')}
                  onClick={(e) => {
                    e.stopPropagation()
                    window.palmier.agent.deleteSession(s.id)
                  }}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Popover>
  )
}

function TabBar({ state }: { state: AgentPanelState }) {
  const [history, setHistory] = useState<AnchorRect | null>(null)
  const open = state.sessions.filter((s) => s.isOpen)
  return (
    <div className="pp-agent-tabbar-wrap">
      <div className="pp-agent-tabbar">
        <div
          className="pp-agent-tabs no-scrollbar"
          onWheel={(e) => {
            if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          {open.map((s) => (
            <DocTab key={s.id} label={tabTitle(s.title)} active={s.id === state.currentId} closeable onSelect={() => s.id !== state.currentId && window.palmier.agent.selectSession(s.id)} onClose={() => window.palmier.agent.closeTab(s.id)} />
          ))}
        </div>
        <button type="button" className="pp-agent-barbtn" data-tip={t('New chat')} aria-label={t('New chat')} onClick={() => window.palmier.agent.newChat()}>
          <Plus size={13} />
        </button>
        <button type="button" className={`pp-agent-barbtn${history ? ' on' : ''}`} data-tip={t('Chat history')} aria-label={t('Chat history')} onClick={(e) => setHistory(history ? null : rectOf(e.currentTarget))}>
          <History size={13} />
        </button>
        <button type="button" className="pp-agent-barbtn" data-tour="skillsButton" data-tip={t('View Skills')} aria-label={t('View Skills')} onClick={() => window.palmier.agent.openSkillsFolder()}>
          <Book size={13} />
        </button>
      </div>
      {history && <HistoryPopover anchor={history} sessions={state.sessions} currentId={state.currentId} onClose={() => setHistory(null)} />}
    </div>
  )
}

function errorText(e: AgentStreamError): string {
  switch (e.kind) {
    case 'unavailable':
      return t('Add an {0} API key to use this model.', PROVIDER_NAMES[e.provider])
    case 'refusal':
      return t('The selected model refused this request. Revise the prompt and try again.')
    case 'upstream':
      return e.message
  }
}

function ErrorBanner({ error }: { error: AgentStreamError }) {
  return (
    <div className="pp-agent-error">
      <span>{errorText(error)}</span>
      {error.kind === 'unavailable' && (
        <button type="button" className="pp-capsule secondary small" onClick={openKeys}>
          {t('Open Settings')}
        </button>
      )}
    </div>
  )
}

function MissingKey({ state }: { state: AgentPanelState }) {
  const provider = PROVIDER_NAMES[modelInfo(state.model).provider]
  return (
    <div className="pp-agent-missing">
      <button type="button" className="pp-capsule prominent regular pp-agent-missing-cta" onClick={openKeys}>
        <Settings size={14} />
        {t('Open Settings')}
      </button>
      <button type="button" className="pp-agent-missing-link" onClick={openKeys}>
        {t('Add your own {0} key', provider)}
      </button>
    </div>
  )
}

function EmptyState({ state }: { state: AgentPanelState }) {
  if (!state.canStream) return <MissingKey state={state} />
  return (
    <div className="pp-agent-empty">
      <div className="pp-agent-empty-title">{t('Ask anything, or start with:')}</div>
      <div className="pp-agent-starters">
        {STARTERS.map((s) => (
          <button key={s.id} type="button" className="pp-agent-starter" data-tip={t('Fill prompt')} onClick={() => fillPrompt(s.prompt)}>
            <span className="pp-agent-starter-icon">
              <s.icon size={13} />
            </span>
            {s.title}
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageList({ state }: { state: AgentPanelState }) {
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const results = useMemo(() => {
    const m = new Map<string, ToolResult>()
    for (const msg of state.messages) if (msg.role === 'user') for (const b of msg.blocks) if (b.kind === 'toolResult') m.set(b.toolUseId, b)
    return m
  }, [state.messages])
  const lastAssistant = useMemo(() => [...state.messages].reverse().find((m) => m.role === 'assistant')?.id, [state.messages])

  const scrollToBottom = (smooth: boolean) => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }
  // Message count or streaming changes scroll to the end; token growth follows only while the user is at the bottom.
  useLayoutEffect(() => {
    scrollToBottom(true)
  }, [state.messages.length, state.isStreaming, state.currentId])
  useLayoutEffect(() => {
    if (atBottom.current) scrollToBottom(false)
  }, [state.messages])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottom.current = distance < 24
    setShowLatest(distance > 80)
  }

  if (!state.messages.length && !state.isStreaming) {
    return (
      <div className="pp-agent-list empty">
        <EmptyState state={state} />
        {state.streamError && state.streamError.kind !== 'unavailable' && <ErrorBanner error={state.streamError} />}
      </div>
    )
  }
  return (
    <div className="pp-agent-list-wrap">
      <div className="pp-agent-list" ref={scroller} onScroll={onScroll}>
        <div className="pp-agent-column">
          {state.messages.map((m) => (
            <MessageView key={m.id} message={m} results={results} live={state.isStreaming && m.id === lastAssistant} />
          ))}
          {state.isStreaming && <ThinkingDots />}
          {state.streamError && <ErrorBanner error={state.streamError} />}
        </div>
      </div>
      {showLatest && (
        <button type="button" className="pp-agent-latest" data-tip={t('Scroll to latest')} aria-label={t('Scroll to latest')} onClick={() => scrollToBottom(true)}>
          <ArrowDown size={13} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

/** The agent column: floating tab bar, message list, footer with the composer (spec 06 §A11). */
export function AgentPanel() {
  const state = useAgent((s) => s.state)
  const projectPath = useProject((s) => s.snapshot?.path ?? null)
  useEffect(() => {
    if (projectPath) void refreshAgent()
  }, [projectPath])
  if (!state) return <div className="pp-agent" />
  return (
    <div className="pp-agent">
      <TabBar state={state} />
      <MessageList state={state} />
      <div className="pp-agent-footer">
        {!state.canStream && state.messages.length > 0 && <MissingKey state={state} />}
        <Composer state={state} />
      </div>
    </div>
  )
}
