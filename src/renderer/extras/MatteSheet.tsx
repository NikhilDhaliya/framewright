/** Matte sheet (spec 05 §4.12, `MatteSheet.swift`): colour (no alpha, default black), aspect, size, Create Matte. */
import './extras.css'
import { useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RGBA } from '@core/model'
import { MATTE_ASPECTS, matteHex, mattePixelSize, type MatteAspect } from '../../shared/extras'
import { editor } from '../state/editor'
import { useTimeline } from '../state/project'
import { ColorField } from '../ui/ColorField'
import { MenuValue } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { t } from '../i18n'

/** `AppTheme.MediaOverlay.background`: black. */
const DEFAULT_COLOR: RGBA = { r: 0, g: 0, b: 0, a: 1 }

function Row({ icon, label, children }: { icon: SFName; label: string; children: ReactNode }) {
  return (
    <div className="pp-matte-row">
      <span className="pp-matte-icon">
        <Icon sf={icon} size={11} />
      </span>
      <span className="pp-matte-label">{label}</span>
      <span style={{ flex: 1, minWidth: 12 }} />
      <div className="pp-matte-control">{children}</div>
    </div>
  )
}

export function MatteSheet({ onClose }: { onClose: () => void }) {
  const tl = useTimeline()
  const [color, setColor] = useState<RGBA>(DEFAULT_COLOR)
  const [aspect, setAspect] = useState<MatteAspect>('Project')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [w, h] = mattePixelSize(aspect, tl?.width ?? 1920, tl?.height ?? 1080)
  const create = async () => {
    setError(null)
    setCreating(true)
    try {
      const r = await window.palmier.extras.createMatte({ hex: matteHex(color), aspect, folderId: editor().mediaFolderId })
      if (r.ok) onClose()
      else setError(r.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }
  return (
    <Sheet width={280} onClose={onClose}>
      <div className="pp-matte-sheet">
        <Row icon="paintpalette" label={t('Color')}>
          <ColorField value={color} alpha={false} onChange={setColor} onCommit={setColor} />
        </Row>
        <Row icon="aspectratio" label={t('Aspect')}>
          <MenuValue text={t(aspect)} width={116} items={() => MATTE_ASPECTS.map((a) => ({ label: t(a), checked: a === aspect, onSelect: () => setAspect(a) }))} />
        </Row>
        <Row icon="ruler" label={t('Size')}>
          <span className="pp-matte-size mono tnum">
            {w} × {h}
          </span>
        </Row>
        {error && <span className="pp-matte-error">{error}</span>}
        <button type="button" className="pp-matte-create" disabled={creating} onClick={() => void create()}>
          {creating ? t('Creating…') : t('Create Matte')}
        </button>
      </div>
    </Sheet>
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null

export function closeMatteSheet(): void {
  root?.unmount()
  host?.remove()
  root = null
  host = null
}

/** Media tab toolbar ⋯ ▸ Create Matte. */
export function openMatteSheet(): void {
  closeMatteSheet()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<MatteSheet onClose={closeMatteSheet} />)
}
