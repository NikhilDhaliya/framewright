import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface PopoverProps {
  anchor: AnchorRect
  onClose: () => void
  /** Horizontal alignment relative to the anchor. */
  align?: 'center' | 'start' | 'end'
  className?: string
  style?: CSSProperties
  children: ReactNode
}

const stack: symbol[] = []

export const rectOf = (el: Element): AnchorRect => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/** Floating panel under an anchor; Esc or a click outside closes it. */
export function Popover({ anchor, onClose, align = 'center', className, style, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const cx = (anchor.left + anchor.right) / 2
    let left = align === 'start' ? anchor.left : align === 'end' ? anchor.right - w : cx - w / 2
    let top = anchor.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6)
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left))
    setPos({ left, top })
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, align])

  useEffect(() => {
    const id = Symbol('popover')
    stack.push(id)
    const isTop = () => stack[stack.length - 1] === id
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (!isTop() || ref.current?.contains(t) || t.closest?.('.pp-menu-backdrop')) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      stack.splice(stack.indexOf(id), 1)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      className={`pp-popover${className ? ` ${className}` : ''}`}
      style={{ ...style, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
