import { useEffect, useRef, useState } from 'react'
import { BUNDLED_FAMILIES } from '../render/fonts'
import { Icon } from '../ui/Icon'
import { MiddleTruncate } from '../ui/controls'
import { Popover, rectOf, type AnchorRect } from '../ui/Popover'
import { t } from '../i18n'

interface LocalFontData {
  family: string
}

let systemFamilies: Promise<string[]> | null = null

/** System families via the Local Font Access API, minus the bundled ones (empty when unavailable). */
function loadSystemFamilies(): Promise<string[]> {
  systemFamilies ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts
    if (!query) return []
    try {
      const fonts = await query()
      const bundled = new Set(BUNDLED_FAMILIES)
      return [...new Set(fonts.map((f) => f.family))].filter((f) => !bundled.has(f)).sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  })()
  return systemFamilies
}

const FEATURED = [...BUNDLED_FAMILIES].sort((a, b) => a.localeCompare(b))

interface FontPickerProps {
  value: string | null
  onPreview: (family: string) => void
  onCommit: (family: string) => void
  onCancel: () => void
}

/** FontPickerField: hovering an item previews it live, clicking commits, dismissing reverts. */
export function FontPicker({ value, onPreview, onCommit, onCancel }: FontPickerProps) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const [system, setSystem] = useState<string[]>([])
  const picked = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!anchor) return
    picked.current = false
    void loadSystemFamilies().then(setSystem)
    requestAnimationFrame(() => listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'center' }))
  }, [anchor])
  const close = () => {
    setAnchor(null)
    if (!picked.current) onCancel()
  }
  const item = (family: string) => (
    <button
      key={family}
      type="button"
      className={`pp-insp-font-item${family === value ? ' on' : ''}`}
      style={{ fontFamily: `"${family}", var(--pp-font-ui)` }}
      onPointerEnter={() => onPreview(family)}
      onClick={() => {
        picked.current = true
        setAnchor(null)
        onCommit(family)
      }}
    >
      <span className="pp-insp-font-check">{family === value && <Icon sf="checkmark" size={10} />}</span>
      {family}
    </button>
  )
  return (
    <>
      <button type="button" className="pp-value-field pp-insp-font-button" data-active={anchor ? true : undefined} onClick={(e) => (anchor ? close() : setAnchor(rectOf(e.currentTarget)))}>
        <MiddleTruncate text={value ?? t('Mixed')} />
        <Icon sf="chevron.down" size={9} className="tone-tertiary" />
      </button>
      {anchor && (
        <Popover anchor={anchor} align="start" onClose={close} className="pp-insp-font-popover">
          <div ref={listRef} className="pp-insp-font-list">
            <div className="pp-menu-header">{t('Featured')}</div>
            {FEATURED.map(item)}
            {system.length > 0 && (
              <>
                <div className="pp-menu-divider" />
                <div className="pp-menu-header">{t('All fonts')}</div>
                {system.map(item)}
              </>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
