import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Icon, type SFName } from './Icon'

export type MenuItem =
  | {
      kind?: 'item'
      label: string
      icon?: SFName
      checked?: boolean
      disabled?: boolean
      destructive?: boolean
      shortcut?: string
      tip?: string
      onSelect?: () => void
      submenu?: MenuItem[]
    }
  | { kind: 'divider' }
  | { kind: 'header'; label: string }

type Actionable = Extract<MenuItem, { label: string; kind?: 'item' }>

interface OpenMenu {
  items: MenuItem[]
  x: number
  y: number
  /** Flip above this y when there is no room below (dropdowns anchored to a control). */
  flipY?: number
  minWidth?: number
  alignRight?: boolean
  onClose?: () => void
}

const useMenuStore = create<{ menu: OpenMenu | null }>(() => ({ menu: null }))

/** Drops empty groups and stray dividers so callers can build menus from optional sections. */
export function tidy(items: (MenuItem | false | null | undefined)[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const it of items) {
    if (!it) continue
    if (it.kind === 'divider' && (out.length === 0 || out[out.length - 1].kind === 'divider')) continue
    out.push(it)
  }
  while (out.length && out[out.length - 1].kind === 'divider') out.pop()
  return out
}

export function openMenu(items: MenuItem[], x: number, y: number, opts: Partial<Pick<OpenMenu, 'flipY' | 'minWidth' | 'alignRight' | 'onClose'>> = {}): void {
  const clean = tidy(items)
  if (!clean.length) return
  useMenuStore.setState({ menu: { items: clean, x, y, ...opts } })
}

export function openMenuBelow(anchor: Element, items: MenuItem[], opts: { minWidth?: number; alignRight?: boolean; onClose?: () => void } = {}): void {
  const r = anchor.getBoundingClientRect()
  openMenu(items, opts.alignRight ? r.right : r.left, r.bottom + 2, { flipY: r.top - 2, ...opts })
}

export function closeMenu(): void {
  const m = useMenuStore.getState().menu
  useMenuStore.setState({ menu: null })
  m?.onClose?.()
}

export const isMenuOpen = () => useMenuStore.getState().menu !== null

const actionable = (it: MenuItem): it is Actionable => it.kind !== 'divider' && it.kind !== 'header'

interface MenuListProps {
  items: MenuItem[]
  x: number
  y: number
  flipY?: number
  minWidth?: number
  alignRight?: boolean
  depth: number
  onPick: (it: Actionable) => void
}

function MenuList({ items, x, y, flipY, minWidth, alignRight, depth, onPick }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, ready: false })
  const [hover, setHover] = useState(-1)
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null)
  const hasChecks = items.some((it) => actionable(it) && it.checked !== undefined)
  const hasIcons = items.some((it) => actionable(it) && it.icon)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = alignRight ? x - w : x
    let top = y
    if (top + h > window.innerHeight - 6) top = flipY !== undefined && flipY - h > 6 ? flipY - h : Math.max(6, window.innerHeight - h - 6)
    if (left + w > window.innerWidth - 6) left = depth > 0 ? Math.max(6, left - w - el.parentElement!.offsetWidth) : window.innerWidth - w - 6
    setPos({ left: Math.max(6, left), top, ready: true })
  }, [x, y, flipY, alignRight, depth])

  useEffect(() => {
    if (depth > 0) return
    const onKey = (e: KeyboardEvent) => {
      const idxs = items.map((it, i) => (actionable(it) && !it.disabled ? i : -1)).filter((i) => i >= 0)
      if (e.key === 'Escape') closeMenu()
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const cur = idxs.indexOf(hover)
        const next = e.key === 'ArrowDown' ? idxs[(cur + 1) % idxs.length] : idxs[(cur - 1 + idxs.length) % idxs.length]
        setHover(next ?? -1)
      } else if (e.key === 'Enter' && hover >= 0) {
        const it = items[hover]
        if (actionable(it) && !it.submenu) onPick(it)
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, hover, depth, onPick])

  return (
    <div
      ref={ref}
      className="pp-menu"
      style={{ left: pos.left, top: pos.top, minWidth, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.kind === 'divider') return <div key={i} className="pp-menu-divider" />
        if (it.kind === 'header') return <div key={i} className="pp-menu-header">{it.label}</div>
        return (
          <div
            key={i}
            className={`pp-menu-item${it.disabled ? ' disabled' : ''}${it.destructive ? ' destructive' : ''}${hover === i ? ' hover' : ''}`}
            data-tip={it.tip}
            onPointerEnter={(e) => {
              setHover(i)
              if (it.submenu && !it.disabled) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setSub({ index: i, x: r.right - 2, y: r.top - 5 })
              } else setSub(null)
            }}
            onClick={() => {
              if (!it.disabled && !it.submenu) onPick(it)
            }}
          >
            {hasChecks && <span className="pp-menu-check">{it.checked ? <Icon sf="checkmark" size={10} /> : null}</span>}
            {hasIcons && <span className="pp-menu-icon">{it.icon ? <Icon sf={it.icon} size={11} /> : null}</span>}
            <span className="pp-menu-label">{it.label}</span>
            {it.shortcut && <span className="pp-menu-shortcut">{it.shortcut}</span>}
            {it.submenu && <Icon sf="chevron.right" size={9} className="pp-menu-chevron" />}
            {sub?.index === i && it.submenu && <MenuList items={tidy(it.submenu)} x={sub.x} y={sub.y} depth={depth + 1} onPick={onPick} />}
          </div>
        )
      })}
    </div>
  )
}

export function MenuHost() {
  const menu = useMenuStore((s) => s.menu)
  if (!menu) return null
  const pick = (it: Actionable) => {
    closeMenu()
    it.onSelect?.()
  }
  return createPortal(
    <div
      className="pp-menu-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeMenu()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (e.target === e.currentTarget) closeMenu()
      }}
    >
      <MenuList items={menu.items} x={menu.x} y={menu.y} flipY={menu.flipY} minWidth={menu.minWidth} alignRight={menu.alignRight} depth={0} onPick={pick} />
    </div>,
    document.body,
  )
}
