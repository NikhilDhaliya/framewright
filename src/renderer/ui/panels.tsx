import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, type SFName } from './Icon'
import { t } from '../i18n'

export function PanelHeader({ children, className, style }: { children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`pp-panel-header${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  )
}

export interface TitleTab<T extends string> {
  id: T
  title: string
  icon: SFName
}

/** Equal-width icon-over-label tabs with a 1 px underline on the active tab. */
export function TitleTabBar<T extends string>({ tabs, active, onSelect }: { tabs: TitleTab<T>[]; active: T; onSelect: (id: T) => void }) {
  return (
    <div className="pp-panel-header pp-title-tabs">
      {tabs.map((t) => (
        <button key={t.id} type="button" className={`pp-title-tab${t.id === active ? ' on' : ''}`} onClick={() => onSelect(t.id)}>
          <Icon sf={t.icon} size={10} />
          <span>{t.title}</span>
        </button>
      ))}
    </div>
  )
}

interface GroupProps {
  title: string
  /** Stable state key within the enclosing `GroupScope`; defaults to the title. */
  stateId?: string
  defaultExpanded?: boolean
  accessory?: ReactNode
  onReset?: () => void
  resetTip?: string
  contentStyle?: CSSProperties
  disabled?: boolean
  children: ReactNode
}

const groupState = new Map<string, boolean>()

const GroupScopeContext = createContext('inspector')

/**
 * Namespaces the collapse state of the `Group`s inside it, so panels that reuse titles (Captions "Style"/"Settings"/
 * "Animation" vs the inspector's) keep separate state — the Mac keeps one `@State` per view (`EditorPanelGroup`).
 * Groups outside any scope belong to "inspector".
 */
export function GroupScope({ id, children }: { id: string; children: ReactNode }) {
  const parent = useContext(GroupScopeContext)
  return <GroupScopeContext.Provider value={parent === 'inspector' ? id : `${parent}/${id}`}>{children}</GroupScopeContext.Provider>
}

/** Key a group's collapse state is stored under (exported for tests). */
export const groupStateKey = (scope: string, id: string) => `${scope}\u0000${id}`

/** EditorPanelGroup: collapsible section; collapse state survives remounts per scope + stable id (title by default). */
export function Group({ title, stateId, defaultExpanded = true, accessory, onReset, resetTip, contentStyle, disabled, children }: GroupProps) {
  const key = groupStateKey(useContext(GroupScopeContext), stateId ?? title)
  const [expanded, setExpanded] = useState(() => groupState.get(key) ?? defaultExpanded)
  const toggle = () => {
    groupState.set(key, !expanded)
    setExpanded(!expanded)
  }
  return (
    <section className="pp-group">
      <div className="pp-group-header" onClick={toggle}>
        <span className="pp-group-chevron">
          <Icon sf={expanded ? 'chevron.down' : 'chevron.right'} size={9} strokeWidth={2.5} />
        </span>
        <span className="pp-group-title ellipsis">{title}</span>
        <span style={{ flex: 1 }} />
        {accessory && <span onClick={(e) => e.stopPropagation()}>{accessory}</span>}
        {onReset && (
          <button
            type="button"
            className="pp-iconbtn hh tone-tertiary"
            style={{ width: 22, height: 22 }}
            data-tip={resetTip ?? t('Reset: {0}', title)}
            onClick={(e) => {
              e.stopPropagation()
              onReset()
            }}
          >
            <Icon sf="arrow.counterclockwise" size={11} />
          </button>
        )}
      </div>
      {expanded && (
        <div className={`pp-group-content${disabled ? ' disabled' : ''}`} style={contentStyle}>
          {children}
        </div>
      )}
    </section>
  )
}

interface DocTabProps {
  label: string
  active: boolean
  closeable?: boolean
  onSelect: () => void
  onClose?: () => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  children?: ReactNode
}

/** documentTabChrome: pill tab with a hover-only close button. */
export function DocTab({ label, active, closeable, onSelect, onClose, onDoubleClick, onContextMenu, children }: DocTabProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [active])
  return (
    <div
      ref={ref}
      className={`pp-doc-tab hh${active ? ' on' : ''}${closeable ? ' closeable' : ''}`}
      data-active={active || undefined}
      onPointerDown={(e) => {
        if (e.button === 0) onSelect()
      }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {children ?? <span className="ellipsis">{label}</span>}
      {closeable && onClose && (
        <button
          type="button"
          className="pp-doc-tab-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <Icon sf="xmark" size={8} strokeWidth={3} />
        </button>
      )}
    </div>
  )
}

/** Horizontal tab scroller; a vertical wheel scrolls it sideways. */
export function TabStrip({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div
      className={`pp-tabstrip no-scrollbar${className ? ` ${className}` : ''}`}
      style={style}
      onWheel={(e) => {
        if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY
      }}
    >
      {children}
    </div>
  )
}

interface SearchFieldProps {
  value: string
  onChange: (v: string) => void
  expanded: boolean
  onExpandedChange: (v: boolean) => void
  placeholder?: string
  tip?: string
  width?: number
  size?: 'small' | 'regular'
}

/** ExpandablePanelSearch: icon button that expands into a capsule field; Esc or clearing collapses. */
export function SearchField({ value, onChange, expanded, onExpandedChange, placeholder = t('Search'), tip = t('Search'), width, size = 'small' }: SearchFieldProps) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (expanded) ref.current?.focus()
  }, [expanded])
  const collapse = () => {
    onChange('')
    onExpandedChange(false)
  }
  if (!expanded) {
    return (
      <button type="button" className="pp-iconbtn hh tone-tertiary" style={size === 'small' ? { width: 18, height: 18 } : { width: 22, height: 22 }} data-tip={tip} data-tip-align="trailing" onClick={() => onExpandedChange(true)}>
        <Icon sf="magnifyingglass" size={size === 'small' ? 10 : 11} />
      </button>
    )
  }
  return (
    <div className={`pp-search ${size}`} style={{ width }}>
      <Icon sf="magnifyingglass" size={size === 'small' ? 10 : 11} className="tone-tertiary" />
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') collapse()
        }}
        onBlur={() => {
          if (!value) onExpandedChange(false)
        }}
      />
      {value && (
        <button type="button" className="pp-search-clear" data-tip={t('Clear search')} onPointerDown={(e) => e.preventDefault()} onClick={collapse}>
          <Icon sf="xmark.circle.fill" size={10} />
        </button>
      )}
    </div>
  )
}
