/** First-launch onboarding on Home (spec 05 §8.6, 07 §7.2): Welcome → two cosmetic survey steps → Add API keys. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings } from '../../shared/api'
import { updateSettings, useSettings } from '../state/settings'
import { requestTourOnOpen, useTour } from '../tour/store'
import { Capsule } from '../ui/buttons'
import { Icon } from '../ui/Icon'
import { DISCOVERY_QUESTIONS, PROFILE_QUESTIONS, toggleOption, type SurveyQuestion } from './survey'
import { t } from '../i18n'

type Step = 'welcome' | 'discovery' | 'profile' | 'keys'
const ORDER: Step[] = ['welcome', 'discovery', 'profile', 'keys']

type Provider = keyof AppSettings['apiKeys']
const KEY_ROWS: { provider: Provider; title: string; hint: string; group: 'chat' | 'gen' }[] = [
  { provider: 'anthropic', title: 'Anthropic', hint: 'sk-ant-…', group: 'chat' },
  { provider: 'openai', title: 'OpenAI', hint: 'sk-…', group: 'chat' },
  { provider: 'fal', title: 'fal.ai', hint: t('fal key id:secret'), group: 'gen' },
  { provider: 'replicate', title: 'Replicate', hint: 'r8_…', group: 'gen' },
  { provider: 'elevenlabs', title: 'ElevenLabs', hint: 'sk_…', group: 'gen' },
  { provider: 'google', title: 'Google Gemini', hint: 'AIza…', group: 'gen' },
]

function Chips({ q, selected, onToggle }: { q: SurveyQuestion; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="pp-onb-question">
      <span className="pp-onb-question-title">{t(q.title)}</span>
      <div className="pp-onb-chips">
        {q.options.map((o) => (
          <button key={o.id} type="button" className={`pp-onb-chip${selected.includes(o.id) ? ' on' : ''}`} aria-pressed={selected.includes(o.id)} onClick={() => onToggle(o.id)}>
            {t(o.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

function KeyRow({ title, hint, saved, value, onChange }: { title: string; hint: string; saved: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="pp-onb-key">
      <span className="pp-onb-key-title">{title}</span>
      <input className="pp-onb-key-input mono" type="password" value={value} placeholder={saved || hint} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      {saved && !value && <Icon sf="checkmark" size={10} className="pp-onb-key-ok" />}
    </label>
  )
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome')
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [drafts, setDrafts] = useState<Partial<Record<Provider, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saved = useSettings((s) => s.settings?.apiKeys) ?? {}
  const index = ORDER.indexOf(step)
  const question = step === 'discovery' || step === 'profile'

  const saveDrafts = async () => {
    const apiKeys: AppSettings['apiKeys'] = {}
    for (const [p, v] of Object.entries(drafts) as [Provider, string][]) if (v.trim()) apiKeys[p] = v.trim()
    if (Object.keys(apiKeys).length) await updateSettings({ apiKeys })
  }
  const finish = async (keepKeys: boolean) => {
    if (keepKeys) await saveDrafts()
    onDone()
  }
  const tutorial = async () => {
    setBusy(true)
    setError(null)
    await saveDrafts()
    requestTourOnOpen()
    const r = await window.palmier.home.openTutorial()
    setBusy(false)
    if (!r.ok) {
      useTour.setState({ pendingStart: false })
      setError(t('Tutorial project couldn’t be opened. Try again.'))
      return
    }
    onDone()
  }
  const advance = () => setStep(ORDER[Math.min(index + 1, ORDER.length - 1)])
  const primary = step === 'keys' ? () => void finish(true) : advance
  const primaryRef = useRef(primary)
  primaryRef.current = busy ? () => undefined : primary
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || document.querySelector('.pp-sheet-backdrop, .pp-menu-backdrop, .pp-popover')) return
      e.preventDefault()
      primaryRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  let body: ReactNode
  if (step === 'welcome') {
    body = (
      <>
        <span className="pp-onb-title">{t('Welcome to {app}')}</span>
        <div className="pp-onb-hero" aria-hidden>
          <Icon sf="film.stack" size={44} />
        </div>
        <span className="pp-onb-detail">{t('A video editor built for AI. Generate, and edit all in one place.')}</span>
      </>
    )
  } else if (question) {
    const qs = step === 'discovery' ? DISCOVERY_QUESTIONS : PROFILE_QUESTIONS
    body = (
      <>
        <span className="pp-onb-title">{step === 'discovery' ? t('Quick questions') : t('Tell us about your work')}</span>
        <div className="pp-onb-questions no-scrollbar">
          {qs.map((q) => (
            <Chips key={q.id} q={q} selected={answers[q.id] ?? []} onToggle={(o) => setAnswers((a) => ({ ...a, [q.id]: toggleOption(q, a[q.id] ?? [], o) }))} />
          ))}
        </div>
      </>
    )
  } else {
    body = (
      <>
        <span className="pp-onb-title">{t('Add API keys')}</span>
        <span className="pp-onb-detail">{t('Bring your own keys for AI chat and media generation. They’re stored in your system keyring; change them any time in Settings.')}</span>
        <div className="pp-onb-keys no-scrollbar">
          {(['chat', 'gen'] as const).map((g) => (
            <div key={g} className="pp-onb-key-group">
              <span className="pp-onb-question-title">{g === 'chat' ? t('AI Chat') : t('Generation Providers')}</span>
              {KEY_ROWS.filter((r) => r.group === g).map((r) => (
                <KeyRow key={r.provider} title={r.title} hint={r.hint} saved={saved[r.provider] ?? ''} value={drafts[r.provider] ?? ''} onChange={(v) => setDrafts((d) => ({ ...d, [r.provider]: v }))} />
              ))}
            </div>
          ))}
        </div>
        {error && <span className="pp-dlg-error">{error}</span>}
      </>
    )
  }

  return (
    <div className="pp-onb-backdrop" data-testid="onboarding" data-step={step}>
      <div className={`pp-onb-card${question ? ' question' : ''}`} role="dialog" aria-label={t('Welcome')}>
        <div className="pp-onb-body">{body}</div>
        <div className="pp-onb-footer">
          {index > 0 && (
            <Capsule size="regular" onClick={() => setStep(ORDER[index - 1])} disabled={busy}>
              {t('Back')}
            </Capsule>
          )}
          <span style={{ flex: 1 }} />
          {step === 'keys' ? (
            <>
              <Capsule size="regular" onClick={() => void finish(false)} disabled={busy}>
                {t('Skip')}
              </Capsule>
              <Capsule size="regular" className="pp-onb-secondary" onClick={() => void tutorial()} disabled={busy}>
                {busy ? t('Opening…') : t('Tutorial')}
              </Capsule>
              <Capsule size="regular" variant="prominent" onClick={primary} disabled={busy}>
                {t('Done')}
              </Capsule>
            </>
          ) : (
            <Capsule size="regular" variant="prominent" onClick={primary}>
              {t('Continue')}
            </Capsule>
          )}
        </div>
      </div>
    </div>
  )
}

