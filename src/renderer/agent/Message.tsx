import { Brain, Check, ChevronRight, CircleCheck, CircleX, Copy } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import type { AgentContentBlock, AgentMessage } from '../../shared/agent'
import { Spinner } from '../ui/controls'
import { MarkdownText } from './Markdown'
import { t } from '../i18n'

type ToolUse = Extract<AgentContentBlock, { kind: 'toolUse' }>
type ToolResult = Extract<AgentContentBlock, { kind: 'toolResult' }>

const round3 = (v: unknown): unknown => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000
  if (Array.isArray(v)) return v.map(round3)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round3(x)]))
  return v
}

/** Input JSON pretty-printed with floats rounded to 3 places; `(no args)` when empty. */
export function prettyArgs(input: string): string {
  const t = input.trim()
  if (!t || t === '{}') return '(no args)'
  try {
    const v = JSON.parse(t)
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return '(no args)'
    return JSON.stringify(round3(v), null, 2)
  } catch {
    return t
  }
}

/** ToolRunRow: status, monospace tool name, chevron; expands to args and the result the model saw. */
const ToolRunRow = memo(function ToolRunRow({ use, result, live }: { use: ToolUse; result: ToolResult | undefined; live: boolean }) {
  const [open, setOpen] = useState(false)
  const running = !result && live
  const failed = result ? result.isError : !live
  return (
    <div className={`pp-agent-tool${open ? ' open' : ''}`}>
      <button type="button" className="pp-agent-tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="pp-agent-tool-status">
          {running ? <Spinner size={10} /> : failed ? <CircleX size={11} className="err" /> : <CircleCheck size={11} />}
        </span>
        <span className="pp-agent-tool-name" style={{ opacity: running ? 0.7 : 1 }}>
          {use.name}
        </span>
        <ChevronRight size={9} strokeWidth={3} className="pp-agent-tool-chevron" />
      </button>
      {open && (
        <div className="pp-agent-tool-body">
          <div className="pp-agent-tool-label">{t('args')}</div>
          <pre>{prettyArgs(use.input)}</pre>
          {result && (
            <>
              <div className={`pp-agent-tool-label${result.isError ? ' err' : ''}`}>{result.isError ? t('error') : t('result')}</div>
              {result.content.map((c, i) =>
                c.kind === 'text' ? (
                  <pre key={i}>{c.text}</pre>
                ) : c.base64 ? (
                  <img key={i} className="pp-agent-tool-img" src={`data:${c.mediaType};base64,${c.base64}`} alt="" />
                ) : (
                  <pre key={i}>{t('(image payload)')}</pre>
                ),
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})

/** ThinkingSummaryView: live text while streaming, then a toggle that reveals it. */
function ThinkingSummary({ text, complete }: { text: string; complete: boolean }) {
  const [open, setOpen] = useState(false)
  if (!complete) return <div className="pp-agent-thinking">{text}</div>
  return (
    <div className="pp-agent-thinking-wrap">
      <button type="button" className={`pp-agent-thinking-toggle${open ? ' on' : ''}`} data-tip={open ? t('Hide reasoning') : t('Show reasoning')} aria-label={open ? t('Hide reasoning') : t('Show reasoning')} onClick={() => setOpen((o) => !o)}>
        <Brain size={14} strokeWidth={open ? 2 : 1.5} />
      </button>
      {open && <div className="pp-agent-thinking fade-in">{text}</div>}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className="pp-agent-copy"
      data-tip={t('Copy message')}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? t('Copied') : t('Copy')}
    </button>
  )
}

export const MessageView = memo(function MessageView({ message, results, live }: { message: AgentMessage; results: Map<string, ToolResult>; live: boolean }) {
  if (message.role === 'user') {
    const text = message.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n')
    if (!text) return null
    return (
      <div className="pp-agent-user-row">
        <div className="pp-agent-user-bubble">{text}</div>
      </div>
    )
  }
  if (message.role === 'system') {
    const text = message.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n')
    return <div className="pp-agent-system">{text}</div>
  }
  const texts = message.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : []))
  return (
    <div className="pp-agent-assistant">
      {message.blocks.map((b, i) => {
        switch (b.kind) {
          case 'thinking':
            return b.text ? <ThinkingSummary key={i} text={b.text} complete={!!b.signature} /> : null
          case 'openAIReasoning':
            return b.summary ? <ThinkingSummary key={i} text={b.summary} complete={!!b.encryptedContent} /> : null
          case 'text':
            return <MarkdownText key={i} text={b.text} />
          case 'toolUse':
            return <ToolRunRow key={b.id} use={b} result={results.get(b.id)} live={live} />
          default:
            return null
        }
      })}
      {texts.length > 0 && <CopyButton text={texts.join('\n\n')} />}
    </div>
  )
})

/** Three 5 px dots; the active one is opaque, advancing every 0.28 s. */
export function ThinkingDots() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => (x + 1) % 3), 280)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="pp-agent-dots" aria-label={t('Working')}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ opacity: i === n ? 1 : 0.25 }} />
      ))}
    </div>
  )
}
