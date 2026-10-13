import { ArrowUp, AudioWaveform, Brain, Film, Image as ImageIcon, KeyRound, Square, Type } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import type { MediaManifestEntry } from '@core/model'
import { AGENT_MODELS, EFFORT_LABELS, modelInfo, PROVIDER_NAMES, supportedEfforts, type AgentPanelState } from '../../shared/agent'
import { getDoc, useManifest } from '../state/project'
import { openMenuBelow, type MenuItem } from '../ui/Menu'
import { cachedThumbnail, loadThumbnail, useLazy } from '../media/thumbnails'
import { ProviderLogo } from './logos'
import { atQuery, attachAsset, mentionCandidates, pickMention, type PickerTab } from './mentions'
import { sendDraft, setDraft, useAgent } from './store'
import { t } from '../i18n'

const TABS: { id: PickerTab; label: string; empty: string }[] = [
  { id: 'all', label: t('All'), empty: t('No media') },
  { id: 'video', label: t('Video'), empty: t('No video clips') },
  { id: 'image', label: t('Image'), empty: t('No images') },
  { id: 'audio', label: t('Audio'), empty: t('No audio') },
]

const TYPE_LABEL: Record<string, string> = { video: t('Video'), audio: t('Audio'), image: t('Image'), text: t('Text'), lottie: t('Animation'), sequence: t('Timeline'), subtitle: t('Subtitles') }

function TypeIcon({ type }: { type: string }) {
  const Cmp = type === 'audio' ? AudioWaveform : type === 'image' ? ImageIcon : type === 'text' || type === 'subtitle' ? Type : Film
  return <Cmp size={11} />
}

function PickerRow({ entry, highlighted, onHover, onPick }: { entry: MediaManifestEntry; highlighted: boolean; onHover: () => void; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const thumb = useLazy(ref, entry.type === 'audio' ? null : entry.id, loadThumbnail, cachedThumbnail)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  return (
    <button ref={ref} type="button" className={`pp-agent-pick-row${highlighted ? ' on' : ''}`} onPointerMove={onHover} onPointerDown={(e) => e.preventDefault()} onClick={onPick}>
      <span className="pp-agent-pick-thumb">{thumb ? <img src={thumb} alt="" /> : <TypeIcon type={entry.type} />}</span>
      <span className="pp-agent-pick-text">
        <span className="pp-agent-pick-name">{entry.name}</span>
        <span className="pp-agent-pick-type">{TYPE_LABEL[entry.type] ?? entry.type}</span>
      </span>
    </button>
  )
}

function MentionPicker({ query, tab, setTab, items, highlight, setHighlight, onPick }: { query: string; tab: PickerTab; setTab: (t: PickerTab) => void; items: MediaManifestEntry[]; highlight: number; setHighlight: (i: number) => void; onPick: (e: MediaManifestEntry) => void }) {
  const empty = query ? t('No matches for "{0}"', query) : TABS.find((t) => t.id === tab)!.empty
  return (
    <div className="pp-agent-picker" onPointerDown={(e) => e.preventDefault()}>
      <div className="pp-agent-picker-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={t.id === tab ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="pp-agent-picker-list">
        {items.length === 0 ? <div className="pp-agent-picker-empty">{empty}</div> : items.map((e, i) => <PickerRow key={e.id} entry={e} highlighted={i === highlight} onHover={() => setHighlight(i)} onPick={() => onPick(e)} />)}
      </div>
    </div>
  )
}

/** The six models by display name; like the Mac, no checkmark on the current one (Q-A6). */
function modelMenu(): MenuItem[] {
  return AGENT_MODELS.map((m) => ({ label: m.displayName, onSelect: () => window.palmier.agent.setModel(m.id) }))
}

/** AgentInputBox: auto-growing editor, @ mentions, drop/paste import, model/effort pickers, send/stop. */
export function Composer({ state }: { state: AgentPanelState }) {
  const draft = useAgent((s) => s.draft)
  const nonce = useAgent((s) => s.draftNonce)
  const manifest = useManifest()
  const ta = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const [dropTarget, setDropTarget] = useState(false)
  const [tab, setTab] = useState<PickerTab>('all')
  const [highlight, setHighlight] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)

  const query = atQuery(draft)
  const pickerOpen = query !== null && dismissedAt !== draft && focused
  const items = useMemo(() => (pickerOpen ? mentionCandidates(manifest?.entries ?? [], tab, query ?? '') : []), [pickerOpen, manifest, tab, query])
  useEffect(() => setHighlight(0), [query, tab])

  const canSend = !state.isStreaming && state.canStream && draft.trim() !== ''

  // Height grows 32 → 64 px, then scrolls; an emptied draft (after send) starts from the top again.
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(64, Math.max(32, el.scrollHeight))}px`
    if (draft === '') el.scrollTop = 0
  }, [draft])

  // A draft replaced from outside (starter prompt, hand-off, Add to chat) takes focus with the caret at the end.
  useEffect(() => {
    if (!nonce) return
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [nonce])

  const pick = (entry: MediaManifestEntry) => {
    const s = useAgent.getState()
    const d = pickMention({ text: s.draft, mentions: s.mentions }, entry)
    setDraft(d.text, d.mentions)
    requestAnimationFrame(() => {
      const el = ta.current
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  const attachIds = (ids: string[]) => {
    const s = useAgent.getState()
    let d = { text: s.draft, mentions: s.mentions }
    const entries = getDoc()?.manifest.entries ?? []
    for (const id of ids) {
      const e = entries.find((x) => x.id === id)
      if (e) d = attachAsset(d, e)
    }
    setDraft(d.text, d.mentions)
  }

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return
    const r = await window.palmier.media.importFiles(paths)
    // Wait one tick for the project snapshot carrying the new assets.
    setTimeout(() => attachIds(r.added), 50)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(0, Math.min(items.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))))
        return
      }
      if (e.key === 'Enter' && !e.repeat) {
        e.preventDefault()
        if (items[highlight]) pick(items[highlight])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissedAt(draft)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const i = TABS.findIndex((t) => t.id === tab)
        setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canSend) sendDraft()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files]
    const paths = files.map((f) => window.palmierFiles.pathForFile(f)).filter(Boolean)
    if (paths.length) {
      e.preventDefault()
      void importPaths(paths)
      return
    }
    const image = files.find((f) => f.type === 'image/png' || f.type === 'image/tiff')
    if (image) {
      e.preventDefault()
      void image.arrayBuffer().then(async (buf) => {
        const id = await window.palmier.agent.importPastedImage(new Uint8Array(buf), image.type as 'image/png' | 'image/tiff')
        if (id) setTimeout(() => attachIds([id]), 50)
      })
    }
  }

  const onDrop = (e: DragEvent) => {
    setDropTarget(false)
    const paths = [...e.dataTransfer.files].map((f) => window.palmierFiles.pathForFile(f)).filter(Boolean)
    if (!paths.length) return
    e.preventDefault()
    e.stopPropagation()
    void importPaths(paths)
  }

  const info = modelInfo(state.model)
  const efforts = supportedEfforts(state.model)
  const border = dropTarget ? 'drop' : focused ? 'focus' : ''

  return (
    <div
      className={`pp-agent-composer ${border}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault()
          e.stopPropagation()
          setDropTarget(true)
        }
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={onDrop}
    >
      {pickerOpen && <MentionPicker query={query ?? ''} tab={tab} setTab={setTab} items={items} highlight={highlight} setHighlight={setHighlight} onPick={pick} />}
      <textarea
        ref={ta}
        className="pp-agent-input"
        value={draft}
        placeholder={t('Ask, or type @ to reference media')}
        rows={1}
        spellCheck
        onChange={(e) => {
          setDraft(e.target.value)
          if (dismissedAt !== null && atQuery(e.target.value) !== atQuery(dismissedAt)) setDismissedAt(null)
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      <div className="pp-agent-bottombar">
        <button type="button" className="pp-agent-picker-btn" data-tip={t('Model')} aria-label={t('Model')} onClick={(e) => openMenuBelow(e.currentTarget, modelMenu(), { minWidth: 160 })}>
          <span className="ellipsis">{info.displayName}</span>
          <ProviderLogo provider={info.provider} />
        </button>
        <button
          type="button"
          className="pp-agent-picker-btn"
          data-tip={t('Reasoning effort')}
          aria-label={t('Reasoning effort')}
          onClick={(e) => openMenuBelow(e.currentTarget, efforts.map((x) => ({ label: t(EFFORT_LABELS[x]), checked: x === state.effort, onSelect: () => window.palmier.agent.setEffort(x) })), { minWidth: 120 })}
        >
          <span>{t(EFFORT_LABELS[state.effort])}</span>
          <Brain size={13} strokeWidth={1.5} className="tertiary" />
        </button>
        {state.activeBYOKProvider && (
          <span className="pp-agent-key" data-tip={t('Streaming through your {0} API key (BYOK)', PROVIDER_NAMES[state.activeBYOKProvider])} aria-label={t('using {0} API key', PROVIDER_NAMES[state.activeBYOKProvider])}>
            <KeyRound size={11} />
          </span>
        )}
        <span className="pp-agent-spacer" />
        {state.isStreaming ? (
          <button type="button" className="pp-agent-stop" data-tip={t('Stop')} aria-label={t('Stop')} onClick={() => window.palmier.agent.cancel()}>
            <Square size={9} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button type="button" className="pp-agent-send" aria-label={t('Send')} disabled={!canSend} onPointerDown={(e) => e.preventDefault()} onClick={() => sendDraft()}>
            <ArrowUp size={12} strokeWidth={3} />
          </button>
        )}
      </div>
    </div>
  )
}
