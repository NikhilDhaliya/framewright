import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings } from '../../shared/api'
import { closeDialog, openDialog, type SettingsPane } from '../state/dialogs'
import { updateSettings, useSettings } from '../state/settings'
import { Capsule, IconButton } from '../ui/buttons'
import { Switch } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { LayoutDiagram, ThemePreview } from './previews'
import { SpeechSettingsSection } from '../media/captions/SpeechSettings'
import { GenerationModelsSettings } from '../generation/ModelsSettings'
import { StoragePane } from '../media/search/StoragePane'
import { SkillsPane } from './settings/SkillsPane'
import { TimelineColorsSection } from './settings/TimelineColorsPane'
import { i18nPayload, t } from '../i18n'
import { nativeLanguageName, sortedLocales, type LocaleId } from '../../shared/i18n'
import type { MenuItem } from '../ui/Menu'
import { MenuValue } from '../ui/controls'

const PANES: { id: SettingsPane; label: string; icon: SFName }[] = [
  { id: 'general', label: t('General'), icon: 'gearshape' },
  { id: 'appearance', label: t('Appearance'), icon: 'sun.max' },
  { id: 'keys', label: t('Models & API Keys'), icon: 'square.stack.3d.up' },
  { id: 'mcp', label: t('MCP Server'), icon: 'network' },
  { id: 'skills', label: t('Skills'), icon: 'book.closed' },
  { id: 'storage', label: t('Storage'), icon: 'internaldrive' },
]

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pp-set-section">
      <div className="pp-set-section-title">{title}</div>
      <div className="pp-set-card">{children}</div>
    </section>
  )
}

function ToggleRow({ title, subtitle, on, onChange }: { title: string; subtitle: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="pp-set-toggle">
      <div className="pp-set-toggle-text">
        <span className="pp-set-row-title">{title}</span>
        <span className="pp-set-row-sub">{subtitle}</span>
      </div>
      <Switch on={on} onChange={onChange} />
    </div>
  )
}

export function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button type="button" className="pp-set-link" onClick={() => window.palmier.app.openExternal(url)}>
      {children}
      <Icon sf="arrow.up.right" size={9} />
    </button>
  )
}

function GeneralPane({ settings }: { settings: AppSettings }) {
  const [dir, setDir] = useState(settings.projectsDirectory)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDir(settings.projectsDirectory), [settings.projectsDirectory])
  const commitDir = () => {
    const v = dir.trim()
    if (v === settings.projectsDirectory) return setError(null)
    if (!v.startsWith('/')) return setError(t('Enter an absolute folder path, e.g. /home/you/Videos/{app}.'))
    setError(null)
    void updateSettings({ projectsDirectory: v })
  }
  return (
    <>
      <SettingsSection title={t('General')}>
        <LanguageRow selection={settings.appLanguage ?? 'system'} />
      </SettingsSection>
      <SettingsSection title={t('Projects')}>
        <div className="pp-set-field">
          <span className="pp-set-row-title">{t('Projects folder')}</span>
          <span className="pp-set-row-sub">{t('New projects are saved here.')}</span>
          <input
            className="pp-set-input mono"
            value={dir}
            spellCheck={false}
            onChange={(e) => setDir(e.target.value)}
            onBlur={commitDir}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDir()
            }}
          />
          {error && <span className="pp-dlg-error">{error}</span>}
        </div>
      </SettingsSection>
      <SettingsSection title={t('Editing')}>
        <ToggleRow
          title={t('Ripple timeline markers')}
          subtitle={t('Markers move with ripple edits, inserts and deletions.')}
          on={settings.rippleTimelineMarkers}
          onChange={(v) => void updateSettings({ rippleTimelineMarkers: v })}
        />
      </SettingsSection>
      <SettingsSection title={t('Notifications')}>
        <ToggleRow
          title={t('Show notifications')}
          subtitle={t('Get a notification when a generation finishes.')}
          on={settings.notificationsEnabled !== false}
          onChange={(v) => void updateSettings({ notificationsEnabled: v })}
        />
      </SettingsSection>
    </>
  )
}

/** General ▸ Language (Mac `GeneralPane`): "System Language" + every locale by its own name; applies after a restart. */
function LanguageRow({ selection }: { selection: string }) {
  const i18n = i18nPayload()
  const sel = (selection === 'system' ? 'system' : selection) as 'system' | LocaleId
  const label = (id: 'system' | LocaleId) => (id === 'system' ? t('System Language') : nativeLanguageName(id))
  const choose = (id: 'system' | LocaleId) => void updateSettings({ appLanguage: id })
  const items = (): MenuItem[] => [
    { label: label('system'), checked: sel === 'system', onSelect: () => choose('system') },
    ...sortedLocales(i18n.active).map((id): MenuItem => ({ label: label(id), checked: sel === id, onSelect: () => choose(id) })),
  ]
  const requiresRestart = (sel === 'system' ? i18n.system : sel) !== i18n.active
  return (
    <>
      <div className="pp-set-toggle">
        <div className="pp-set-toggle-text">
          <span className="pp-set-row-title">{t('Language')}</span>
          <span className="pp-set-row-sub">{t('Language for the editor UI')}</span>
        </div>
        <MenuValue text={label(sel)} items={items} tip={t('Language')} />
      </div>
      {requiresRestart && (
        <div className="pp-set-toggle">
          <span className="pp-set-row-sub" style={{ flex: 1 }}>
            {t('Changes take effect after restarting {app}.')}
          </span>
          <Capsule size="regular" className="pp-raised" onClick={() => window.palmier.app.restart()}>
            {t('Restart {app}')}
          </Capsule>
        </div>
      )}
    </>
  )
}

function AppearancePane({ settings }: { settings: AppSettings }) {
  const themes: { id: AppSettings['theme']; label: string }[] = [
    { id: 'system', label: t('System') },
    { id: 'light', label: t('Light') },
    { id: 'dark', label: t('Dark') },
  ]
  const layouts: { id: AppSettings['layoutPreset']; label: string; key: string }[] = [
    { id: 'default', label: t('Default'), key: 'Ctrl+1' },
    { id: 'media', label: t('Media'), key: 'Ctrl+2' },
    { id: 'vertical', label: t('Vertical'), key: 'Ctrl+3' },
  ]
  return (
    <>
      <section className="pp-set-section">
        <div className="pp-set-section-title">{t('Theme')}</div>
        <div className="pp-set-cards">
          {themes.map((t) => (
            <button key={t.id} type="button" className={`pp-set-choice${settings.theme === t.id ? ' on' : ''}`} onClick={() => void updateSettings({ theme: t.id })}>
              <ThemePreview theme={t.id} />
              <span className="pp-set-choice-label">{t.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="pp-set-section">
        <div className="pp-set-section-title">{t('Workspace layout')}</div>
        <div className="pp-set-cards">
          {layouts.map((l) => (
            <button key={l.id} type="button" className={`pp-set-choice${settings.layoutPreset === l.id ? ' on' : ''}`} onClick={() => void updateSettings({ layoutPreset: l.id })}>
              <LayoutDiagram preset={l.id} />
              <span className="pp-set-choice-label">
                {l.label} <span className="pp-set-choice-key">{l.key}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
      <TimelineColorsSection settings={settings} />
    </>
  )
}

type Provider = keyof AppSettings['apiKeys']

function ApiKeyRow({ provider, title, linkLabel, url, hint, saved }: { provider: Provider; title: string; linkLabel: string; url: string; hint: string; saved: string }) {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const save = () => {
    const v = draft.trim()
    if (!v) return
    void updateSettings({ apiKeys: { [provider]: v } })
    setDraft('')
  }
  return (
    <div className="pp-set-key">
      <div className="pp-set-key-head">
        <span className="pp-set-key-title">{title}</span>
        <ExternalLink url={url}>{linkLabel}</ExternalLink>
      </div>
      <div className="pp-set-key-row">
        <input
          className={`pp-set-key-input mono${focused ? ' focused' : ''}`}
          type="password"
          value={draft}
          placeholder={saved || hint}
          spellCheck={false}
          autoComplete="off"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
        {draft ? (
          <Capsule size="regular" variant="prominent" onClick={save}>
            {t('Save')}
          </Capsule>
        ) : saved ? (
          <IconButton sf="trash" size={12} frame={28} tone="tertiary" tip={t('Remove API key')} onClick={() => void updateSettings({ apiKeys: { [provider]: '' } })} />
        ) : null}
      </div>
    </div>
  )
}

function KeysPane({ settings }: { settings: AppSettings }) {
  const k = settings.apiKeys
  return (
    <>
      <p className="pp-set-intro">{t('Use your own API keys for AI chat and media generation. Keys are stored in your system keyring and never written to project files.')}</p>
      <SettingsSection title={t('AI Chat')}>
        <ApiKeyRow provider="anthropic" title={t('Anthropic API Key')} linkLabel={t('Get Anthropic API key')} url="https://console.anthropic.com/settings/keys" hint="sk-ant-…" saved={k.anthropic ?? ''} />
        <ApiKeyRow provider="openai" title={t('OpenAI API Key')} linkLabel={t('Get OpenAI API key')} url="https://platform.openai.com/api-keys" hint="sk-…" saved={k.openai ?? ''} />
      </SettingsSection>
      <SettingsSection title={t('Generation Providers')}>
        <ApiKeyRow provider="fal" title={t('fal.ai API Key')} linkLabel={t('Get fal.ai key')} url="https://fal.ai/dashboard/keys" hint={t('fal key id:secret')} saved={k.fal ?? ''} />
        <ApiKeyRow provider="replicate" title={t('Replicate API Token')} linkLabel={t('Get Replicate token')} url="https://replicate.com/account/api-tokens" hint="r8_…" saved={k.replicate ?? ''} />
        <ApiKeyRow provider="elevenlabs" title={t('ElevenLabs API Key')} linkLabel={t('Get ElevenLabs key')} url="https://elevenlabs.io/app/settings/api-keys" hint="sk_…" saved={k.elevenlabs ?? ''} />
        <ApiKeyRow provider="google" title={t('Google Gemini API Key')} linkLabel={t('Get Gemini API key')} url="https://aistudio.google.com/apikey" hint="AIza…" saved={k.google ?? ''} />
      </SettingsSection>
      <SettingsSection title={t('Models')}>
        <GenerationModelsSettings />
      </SettingsSection>
      <SpeechSettingsSection settings={settings} />
    </>
  )
}

function McpPane({ settings }: { settings: AppSettings }) {
  const [running, setRunning] = useState<boolean | null>(null)
  const [port, setPort] = useState(String(settings.mcpPort))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const poll = () => void window.palmier.app.info().then((i) => alive && setRunning(i.mcpRunning))
    poll()
    const id = window.setInterval(poll, 1500)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [settings.mcpEnabled, settings.mcpPort])
  useEffect(() => setPort(String(settings.mcpPort)), [settings.mcpPort])
  const commitPort = () => {
    const n = Number(port)
    if (n === settings.mcpPort) return setError(null)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return setError(t('Use a port between 1024 and 65535.'))
    setError(null)
    void updateSettings({ mcpPort: n })
  }
  return (
    <SettingsSection title={t('Integrations')}>
      <div className="pp-set-mcp-head">
        <span className="pp-set-key-title">{t('MCP Server')}</span>
        <span className="pp-set-row-sub">{t('Lets external clients like Cursor, Claude Desktop, Claude Code, and Codex edit your timeline.')}</span>
        <button type="button" className="pp-set-link" onClick={() => openDialog({ kind: 'mcp' })}>
          {t('Setup instructions')}
          <Icon sf="arrow.up.right" size={9} />
        </button>
      </div>
      <div className="pp-set-divider" />
      <div className="pp-set-toggle">
        <span className={`pp-set-status-dot${settings.mcpEnabled && running ? ' on' : ''}`} />
        <span className="pp-set-status-text">{settings.mcpEnabled && running ? <>{t('Running on')} <span className="mono">127.0.0.1:{settings.mcpPort}</span></> : settings.mcpEnabled && running === null ? t('Checking…') : t('Stopped')}</span>
        <span style={{ flex: 1 }} />
        <Switch on={settings.mcpEnabled} onChange={(v) => void updateSettings({ mcpEnabled: v })} />
      </div>
      <div className="pp-set-divider" />
      <div className="pp-set-toggle">
        <div className="pp-set-toggle-text">
          <span className="pp-set-row-title">{t('Port')}</span>
          <span className="pp-set-row-sub">{t('Restarts the server when changed.')}</span>
        </div>
        <input
          className="pp-set-input mono narrow"
          value={port}
          inputMode="numeric"
          onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitPort()
          }}
        />
      </div>
      {error && <span className="pp-dlg-error">{error}</span>}
    </SettingsSection>
  )
}

export function SettingsDialog({ pane: initial }: { pane?: SettingsPane }) {
  const settings = useSettings((s) => s.settings)
  const [pane, setPane] = useState<SettingsPane>(initial ?? 'general')
  const title = PANES.find((p) => p.id === pane)!.label
  return (
    <Sheet width={780} onClose={closeDialog} className="pp-set-sheet">
      <div className="pp-set">
        <nav className="pp-set-sidebar">
          {PANES.map((p) => (
            <button key={p.id} type="button" className="pp-set-nav hh" data-active={pane === p.id || undefined} onClick={() => setPane(p.id)}>
              <span className="pp-set-nav-icon">
                <Icon sf={p.icon} size={13} />
              </span>
              <span className="ellipsis">{p.label}</span>
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <Capsule size="regular" className="pp-set-done" onClick={closeDialog}>
            {t('Done')}
          </Capsule>
        </nav>
        <div className="pp-set-detail">
          <div className="pp-set-title">{title}</div>
          {pane === 'skills' ? (
            <div className="pp-set-detail-fixed">
              <SkillsPane />
            </div>
          ) : (
          <div className="pp-set-scroll">
            {settings ? (
              <div className="pp-set-content">
                {pane === 'general' && <GeneralPane settings={settings} />}
                {pane === 'appearance' && <AppearancePane settings={settings} />}
                {pane === 'keys' && <KeysPane settings={settings} />}
                {pane === 'mcp' && <McpPane settings={settings} />}
                {pane === 'storage' && <StoragePane settings={settings} />}
              </div>
            ) : null}
          </div>
          )}
        </div>
      </div>
    </Sheet>
  )
}
