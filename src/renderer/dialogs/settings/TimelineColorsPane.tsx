/** Settings ▸ Appearance ▸ Timeline colors (spec 05 §11.4, Mac `TimelineColorsPane.swift`). */
import { Fragment, useState } from 'react'
import type { AppSettings } from '../../../shared/api'
import { updateSettings, useSettings } from '../../state/settings'
import { Capsule } from '../../ui/buttons'
import { ColorField, fromHex, toHex } from '../../ui/ColorField'
import './settings.css'
import { t } from '../../i18n'

/** Default palette (tokens.css `--pp-clip-*`, same in dark and light). */
export const DEFAULT_TIMELINE_COLORS = {
  video: '#1D5878',
  audio: '#2E7765',
  image: '#715486',
  text: '#715486',
  animation: '#A07822',
  sequence: '#B9B29A',
} as const

type Kind = keyof typeof DEFAULT_TIMELINE_COLORS

const ROWS: { kind: Kind; label: string }[] = [
  { kind: 'video', label: t('Video') },
  { kind: 'audio', label: t('Audio') },
  { kind: 'image', label: t('Image') },
  { kind: 'text', label: t('Text') },
  { kind: 'animation', label: t('Animation') },
  { kind: 'sequence', label: t('Sequence') },
]

/** Overrides with `kind` set to `hex`. Like the Mac palette, any pick is an override (even the default value) until Reset All. */
export function withTimelineColor(current: Record<string, string> | undefined, kind: Kind, hex: string): Record<string, string> {
  return { ...(current ?? {}), [kind]: hex.toUpperCase() }
}

export function TimelineColorsSection({ settings }: { settings: AppSettings }) {
  const overrides = settings.timelineColors ?? {}
  const [draft, setDraft] = useState<Partial<Record<Kind, string>>>({})
  const anyOverride = ROWS.some((r) => overrides[r.kind])
  const commit = (kind: Kind, hex: string) => {
    setDraft((d) => ({ ...d, [kind]: undefined }))
    void updateSettings({ timelineColors: withTimelineColor(useSettings.getState().settings?.timelineColors, kind, hex) })
  }
  return (
    <section className="pp-set-section">
      <div className="pp-set-section-title">{t('Timeline colors')}</div>
      <div className="pp-set-card pp-tlc-card">
        {ROWS.map((r, i) => {
          const hex = draft[r.kind] ?? overrides[r.kind] ?? DEFAULT_TIMELINE_COLORS[r.kind]
          return (
            <Fragment key={r.kind}>
              {i > 0 && <div className="pp-tlc-divider" />}
              <div className="pp-tlc-row" data-kind={r.kind}>
                <span className="pp-set-row-title">{r.label}</span>
                <span style={{ flex: 1 }} />
                <span className="pp-tlc-hex mono">{hex.toUpperCase()}</span>
                <ColorField
                  value={fromHex(hex)}
                  alpha={false}
                  width={64}
                  height={24}
                  onChange={(c) => setDraft((d) => ({ ...d, [r.kind]: toHex(c) }))}
                  onCommit={(c) => commit(r.kind, toHex(c))}
                />
              </div>
            </Fragment>
          )
        })}
        <div className="pp-tlc-footer">
          <Capsule className="pp-tlc-reset" disabled={!anyOverride} onClick={() => void updateSettings({ timelineColors: {} })}>
            {t('Reset All')}
          </Capsule>
        </div>
      </div>
    </section>
  )
}

