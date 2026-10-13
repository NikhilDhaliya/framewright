import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { loadJSON, saveJSON } from '../state/persist'

export interface PaneSpec {
  id: string
  min: number
  /** Initial size (px) for a fixed pane, from the container's extent. */
  initial?: (total: number) => number
  /** The pane that absorbs remaining space. */
  flex?: boolean
  hidden?: boolean
  content: ReactNode
}

interface SplitProps {
  dir: 'row' | 'column'
  storageKey: string
  panes: PaneSpec[]
}

/** Resizable split with 1 px panel dividers (6 px grab zone); fixed-pane sizes persist per key. */
export function Split({ dir, storageKey, panes }: SplitProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [total, setTotal] = useState(0)
  const [sizes, setSizes] = useState<Record<string, number>>(() => loadJSON(storageKey, {}))
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    setSizes(loadJSON(storageKey, {}))
  }, [storageKey])

  useLayoutEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setTotal(dir === 'row' ? el.clientWidth : el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [dir])

  const visible = panes.filter((p) => !p.hidden)
  const flexId = (visible.find((p) => p.flex) ?? visible[visible.length - 1])?.id
  const dividers = Math.max(0, visible.length - 1)
  const available = Math.max(0, total - dividers)

  const flexMin = visible.find((p) => p.id === flexId)?.min ?? 0
  const fixed = visible.filter((p) => p.id !== flexId)
  const wants = fixed.map((p) => Math.max(p.min, sizes[p.id] ?? Math.round(p.initial?.(total) ?? p.min)))
  // When the fixed panes don't leave the flex pane its minimum, shrink them toward their minimums in proportion to their slack.
  const excess = wants.reduce((s, w) => s + w, 0) - Math.max(0, available - flexMin)
  const slack = fixed.reduce((s, p, i) => s + wants[i] - p.min, 0)
  const resolved: Record<string, number> = {}
  let fixedSum = 0
  fixed.forEach((p, i) => {
    const w = excess > 0 && slack > 0 ? wants[i] - (Math.min(excess, slack) * (wants[i] - p.min)) / slack : wants[i]
    resolved[p.id] = Math.round(w)
    fixedSum += resolved[p.id]
  })

  const startDrag = (e: React.PointerEvent, before: PaneSpec, after: PaneSpec) => {
    const target = before.id !== flexId ? before : after
    const sign = target === before ? 1 : -1
    const start = resolved[target.id]
    const origin = dir === 'row' ? e.clientX : e.clientY
    const othersFixed = fixedSum - start
    const max = Math.max(target.min, available - flexMin - othersFixed)
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    let latest = start
    const move = (ev: PointerEvent) => {
      const delta = (dir === 'row' ? ev.clientX : ev.clientY) - origin
      latest = Math.round(Math.min(max, Math.max(target.min, start + sign * delta)))
      setSizes((s) => ({ ...s, [target.id]: latest }))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDragging(false)
      setSizes((s) => {
        const next = { ...s, [target.id]: latest }
        saveJSON(storageKey, next)
        return next
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div ref={ref} className={`pp-split ${dir}${dragging ? ' dragging' : ''}`}>
      {panes.map((p) => {
        const vi = visible.indexOf(p)
        const next = vi >= 0 ? visible[vi + 1] : undefined
        const basis = p.hidden ? 0 : p.id === flexId ? undefined : resolved[p.id]
        return (
          <Fragment key={p.id}>
            <div
              className={`pp-split-pane${p.hidden ? ' collapsed' : ''}`}
              style={p.id === flexId && !p.hidden ? { flex: '1 1 0', minWidth: 0, minHeight: 0 } : { flex: `0 0 ${basis}px` }}
            >
              {p.content}
            </div>
            {next && (
              <div className="pp-split-divider" onPointerDown={(e) => startDrag(e, p, next)}>
                <span />
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
