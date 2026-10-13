import { projectOps } from '@core/ops'
import { totalFrames } from '@core/timeline'
import { openDialog } from '../state/dialogs'
import { runOp } from '../state/ops'
import { useTimeline } from '../state/project'
import { MenuValue } from '../ui/controls'
import { Icon } from '../ui/Icon'
import type { MenuItem } from '../ui/Menu'
import { Group, PanelHeader } from '../ui/panels'
import { t } from '../i18n'

const { ASPECT_PRESETS, FPS_PRESETS, QUALITY_PRESETS, qualityResolution } = projectOps

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/** "16:9", or "2.39:1" when the reduced ratio isn't a small pair. */
export function aspectLabel(w: number, h: number): string {
  const g = gcd(w, h)
  const a = w / g
  const b = h / g
  if (a <= 32 && b <= 32) return `${a}:${b}`
  return w >= h ? `${(w / h).toFixed(2)}:1` : `1:${(h / w).toFixed(2)}`
}

/** `m:ss`, or `h:mm:ss` from one hour. */
export function shortDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pp-insp-setting-row">
      <span className="pp-insp-setting-label">{label}</span>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  )
}

export function ProjectSettings() {
  const tl = useTimeline()
  if (!tl) return null
  const { fps, width: w, height: h } = tl
  const apply = (next: { fps?: number; width?: number; height?: number }) => void runOp('applyProjectSettings', { fps: next.fps ?? fps, width: next.width ?? w, height: next.height ?? h })
  const shortEdge = Math.min(w, h)

  const resolutionItems = (): MenuItem[] =>
    QUALITY_PRESETS.map((q) => {
      const r = qualityResolution(q.shortEdge, w, h)
      return { label: q.label, checked: q.shortEdge === shortEdge, onSelect: () => apply(r) }
    })
  const fpsItems = (): MenuItem[] => FPS_PRESETS.map((f) => ({ label: t('{0} fps', f), checked: f === fps, onSelect: () => apply({ fps: f }) }))
  const aspectItems = (): MenuItem[] => [
    ...ASPECT_PRESETS.map((p) => {
      const r = qualityResolution(shortEdge, p.width, p.height)
      return { label: p.label, checked: Math.abs(p.width / p.height - w / h) < 1e-3, onSelect: () => apply(r) }
    }),
    { kind: 'divider' },
    { label: t('Custom…'), onSelect: () => openDialog({ kind: 'customAspect' }) },
  ]

  return (
    <div className="pp-insp-root">
      <PanelHeader className="pp-insp-header">
        <span className="pp-insp-header-icon">
          <Icon sf="movieclapper" size={12} />
        </span>
        <span className="pp-insp-header-title">{t('Project Settings')}</span>
        <span style={{ flex: 1 }} />
        <span className="pp-insp-header-meta tnum">{shortDuration(totalFrames(tl) / fps)}</span>
      </PanelHeader>
      <div className="pp-insp-scroll">
        <Group title={t('Canvas')} contentStyle={{ gap: 6 }}>
          <SettingRow label={t('Resolution')}>
            <MenuValue text={`${w} × ${h}`} items={resolutionItems} minWidth={140} />
          </SettingRow>
          <SettingRow label={t('Frame Rate')}>
            <MenuValue text={t('{0} fps', fps)} items={fpsItems} minWidth={140} />
          </SettingRow>
          <SettingRow label={t('Aspect Ratio')}>
            <MenuValue text={aspectLabel(w, h)} items={aspectItems} minWidth={140} />
          </SettingRow>
        </Group>
      </div>
    </div>
  )
}
