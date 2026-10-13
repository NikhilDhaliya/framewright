/** Home overlays shown once: onboarding on first launch, What's New after an update (spec 05 §8.6, 07 §7.2, §7.5). */
import { useEffect, useRef, useState } from 'react'
import changelogJson from '../../../resources/changelog.json'
import { RELEASES_URL } from '../../shared/brand'
import { whatsNewEntry, type ChangelogEntry, type ChangelogFeed } from '../../shared/firstRun'
import { updateSettings, useSettings } from '../state/settings'
import { Capsule } from '../ui/buttons'
import { Icon } from '../ui/Icon'
import { Onboarding } from './Onboarding'
import './onboarding.css'
import { t } from '../i18n'

const FEED = changelogJson as ChangelogFeed

/** Mac `ChangelogStore.shared.pending`: survives Home remounts until dismissed. */
let pending: ChangelogEntry | null = null
let checked = false

function WhatsNew({ release, onDone }: { release: ChangelogEntry; onDone: () => void }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || document.querySelector('.pp-sheet-backdrop, .pp-menu-backdrop, .pp-popover')) return
      e.preventDefault()
      done.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="pp-onb-backdrop" data-testid="whats-new">
      <div className="pp-wn-card" role="dialog" aria-label={t("What's New")}>
        <span className="pp-onb-title">{t('What’s New in v{0}', release.version)}</span>
        <div className="pp-wn-body no-scrollbar">
          {release.sections.map((s, i) => (
            <section key={i} className="pp-wn-section">
              {s.heading && <span className="pp-wn-heading">{s.heading}</span>}
              <ul className="pp-wn-list">
                {s.items.map((item) => (
                  <li key={item}>
                    <span className="pp-wn-bullet">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="pp-onb-footer flush">
          <button type="button" className="pp-set-link" style={{ alignSelf: 'center' }} onClick={() => window.palmier.app.openExternal(FEED.changelogURL || RELEASES_URL)}>
            {t('Full changelog')}
            <Icon sf="arrow.up.right" size={9} />
          </button>
          <span style={{ flex: 1 }} />
          <Capsule size="regular" variant="prominent" onClick={onDone}>
            {t('Continue')}
          </Capsule>
        </div>
      </div>
    </div>
  )
}

/** Home overlays (Mac `HomeView.overlay`): onboarding until complete, else What's New when a version change is pending. */
export function FirstRunOverlays() {
  const settings = useSettings((s) => s.settings)
  const [version, setVersion] = useState<string | null>(null)
  const [, rerender] = useState(0)
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
  useEffect(() => {
    void window.palmier.app.info().then((i) => setVersion(i.version))
  }, [])
  useEffect(() => {
    if (!settings || !version) return
    if (onboardingDone === null) setOnboardingDone(!!settings.hasSeenWelcome)
    if (checked) return
    // Mac `checkForWhatsNew` on Home appear: always records the running version.
    checked = true
    pending = whatsNewEntry(FEED, settings.lastSeenVersion, version)
    if (settings.lastSeenVersion !== version) void updateSettings({ lastSeenVersion: version })
    rerender((n) => n + 1)
  }, [settings, version, onboardingDone])
  if (onboardingDone === null) return null
  if (!onboardingDone) {
    return (
      <Onboarding
        onDone={() => {
          setOnboardingDone(true)
          void updateSettings({ hasSeenWelcome: true })
        }}
      />
    )
  }
  if (!pending) return null
  return (
    <WhatsNew
      release={pending}
      onDone={() => {
        pending = null
        rerender((n) => n + 1)
      }}
    />
  )
}
