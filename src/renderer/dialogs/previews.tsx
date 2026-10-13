import type { AppSettings } from '../../shared/api'

function ThemeHalf({ dark }: { dark: boolean }) {
  return (
    <div className={`pp-prev-theme ${dark ? 'dark' : 'light'}`}>
      <span className="pp-prev-bar" style={{ width: '28%' }} />
      <span className="pp-prev-bar" style={{ width: '48%' }} />
      <div className="pp-prev-panel">
        {[0, 1, 2].map((i) => (
          <div key={i} className="pp-prev-panel-row">
            <span className="pp-prev-bar" style={{ width: '22%' }} />
            <span className="pp-prev-bar" style={{ width: '44%' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Appearance ▸ Theme card artwork; System shows light on the left and dark on the right. */
export function ThemePreview({ theme }: { theme: AppSettings['theme'] }) {
  if (theme !== 'system') return <div className="pp-prev-frame">{<ThemeHalf dark={theme === 'dark'} />}</div>
  return (
    <div className="pp-prev-frame split">
      <div className="pp-prev-clip left">
        <ThemeHalf dark={false} />
      </div>
      <div className="pp-prev-clip right">
        <ThemeHalf dark />
      </div>
    </div>
  )
}

function Timeline({ style }: { style: React.CSSProperties }) {
  return (
    <div className="pp-prev-box timeline" style={style}>
      <span className="pp-prev-track" style={{ background: 'color-mix(in srgb, var(--pp-clip-text) 70%, transparent)', width: '34%', marginLeft: '18%' }} />
      <span className="pp-prev-track" style={{ background: 'color-mix(in srgb, var(--pp-clip-video) 70%, transparent)', width: '62%', marginLeft: '6%' }} />
      <span className="pp-prev-track" style={{ background: 'color-mix(in srgb, var(--pp-clip-audio) 70%, transparent)', width: '52%', marginLeft: '6%' }} />
      <span className="pp-prev-playhead" />
    </div>
  )
}

const box = (kind: 'preview' | 'side', style: React.CSSProperties) => <div className={`pp-prev-box ${kind}`} style={style} />

/** Appearance ▸ Workspace layout mini-diagrams (proportions per spec 05 §11.4). */
export function LayoutDiagram({ preset }: { preset: AppSettings['layoutPreset'] }) {
  const g = 'max(1.2%, 1px)'
  return (
    <div className="pp-prev-frame layout" style={{ gap: g }}>
      {preset === 'default' && (
        <div className="pp-prev-col" style={{ gap: g }}>
          <div className="pp-prev-row" style={{ gap: g, flex: 71 }}>
            {box('side', { flex: 24 })}
            {box('preview', { flex: 54 })}
            {box('side', { flex: 22 })}
          </div>
          <Timeline style={{ flex: 29 }} />
        </div>
      )}
      {preset === 'media' && (
        <div className="pp-prev-row" style={{ gap: g }}>
          {box('side', { flex: 28 })}
          <div className="pp-prev-col" style={{ gap: g, flex: 72 }}>
            <div className="pp-prev-row" style={{ gap: g, flex: 61 }}>
              {box('preview', { flex: 80 })}
              {box('side', { flex: 20 })}
            </div>
            <Timeline style={{ flex: 39 }} />
          </div>
        </div>
      )}
      {preset === 'vertical' && (
        <div className="pp-prev-row" style={{ gap: g }}>
          <div className="pp-prev-col" style={{ gap: g, flex: 50 }}>
            <div className="pp-prev-row" style={{ gap: g, flex: 61 }}>
              {box('side', { flex: 55 })}
              {box('side', { flex: 45 })}
            </div>
            <Timeline style={{ flex: 39 }} />
          </div>
          {box('preview', { flex: 50 })}
        </div>
      )}
    </div>
  )
}
