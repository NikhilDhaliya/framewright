import { create } from 'zustand'
import type { MenuItem } from '../ui/Menu'
import type { Size } from './geometry'
import { t, tk } from '../i18n'

type Format = 'scope' | 'wide' | 'square' | 'portrait'
const FORMAT_ASPECT: Record<Format, number> = { scope: 2.39, wide: 1.85, square: 1, portrait: 9 / 16 }
const FORMAT_LABEL: Record<Format, string> = { scope: tk('Scope (2.39:1)'), wide: tk('Wide (1.85:1)'), square: tk('Square (1:1)'), portrait: tk('Portrait (9:16)') }

interface GuideState {
  grid: number
  actionSafe: boolean
  titleSafe: boolean
  center: boolean
  format: Format | null
}

const OFF: GuideState = { grid: 0, actionSafe: false, titleSafe: false, center: false, format: null }

/** Canvas guides are local view state (not persisted). */
export const useGuides = create<GuideState>(() => OFF)
export const guidesOn = (g: GuideState) => g.grid > 0 || g.actionSafe || g.titleSafe || g.center || g.format !== null

export function guidesMenu(): MenuItem[] {
  const g = useGuides.getState()
  const set = (p: Partial<GuideState>) => useGuides.setState(p)
  return [
    { label: t('Grid'), submenu: [{ label: t('None'), checked: g.grid === 0, onSelect: () => set({ grid: 0 }) }, { kind: 'divider' }, ...[2, 3, 4, 5].map((n) => ({ label: `${n} × ${n}`, checked: g.grid === n, onSelect: () => set({ grid: n }) }))] },
    {
      label: t('Safe Zones'),
      submenu: [
        { label: t('Action Safe'), checked: g.actionSafe, onSelect: () => set({ actionSafe: !g.actionSafe }) },
        { label: t('Title Safe'), checked: g.titleSafe, onSelect: () => set({ titleSafe: !g.titleSafe }) },
        { label: t('Center'), checked: g.center, onSelect: () => set({ center: !g.center }) },
      ],
    },
    {
      label: t('Format References'),
      submenu: [
        { label: t('None'), checked: g.format === null, onSelect: () => set({ format: null }) },
        { kind: 'divider' },
        ...(Object.keys(FORMAT_LABEL) as Format[]).map((f) => ({ label: t(FORMAT_LABEL[f]), checked: g.format === f, onSelect: () => set({ format: f }) })),
      ],
    },
    { kind: 'divider' },
    { label: t('Hide Guides'), disabled: !guidesOn(g), onSelect: () => set(OFF) },
  ]
}

function Line({ x1, y1, x2, y2, op }: { x1: number; y1: number; x2: number; y2: number; op: number }) {
  return (
    <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.55)" strokeWidth={2} />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={`rgba(255,255,255,${op})`} strokeWidth={0.5} />
    </>
  )
}

function Frame({ inset, size, op }: { inset: number; size: Size; op: number }) {
  const x = size.w * inset
  const y = size.h * inset
  return (
    <>
      <rect x={x} y={y} width={size.w - 2 * x} height={size.h - 2 * y} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={2} />
      <rect x={x} y={y} width={size.w - 2 * x} height={size.h - 2 * y} fill="none" stroke={`rgba(255,255,255,${op})`} strokeWidth={0.5} />
    </>
  )
}

export function GuidesOverlay({ size }: { size: Size }) {
  const g = useGuides()
  if (!guidesOn(g)) return null
  const { w, h } = size
  let fmt: { x: number; y: number; w: number; h: number } | null = null
  if (g.format) {
    const a = FORMAT_ASPECT[g.format]
    fmt = w / h > a ? { w: h * a, h, x: (w - h * a) / 2, y: 0 } : { w, h: w / a, x: 0, y: (h - w / a) / 2 }
  }
  return (
    <svg className="pp-guides" width={w} height={h}>
      {fmt && (
        <>
          <path d={`M0 0H${w}V${h}H0Z M${fmt.x} ${fmt.y}v${fmt.h}h${fmt.w}v${-fmt.h}Z`} fill="rgba(0,0,0,0.55)" fillRule="evenodd" />
          <rect x={fmt.x} y={fmt.y} width={fmt.w} height={fmt.h} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={2} />
          <rect x={fmt.x} y={fmt.y} width={fmt.w} height={fmt.h} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={0.5} />
        </>
      )}
      {g.grid > 0 &&
        Array.from({ length: g.grid - 1 }, (_, i) => (i + 1) / g.grid).map((f) => (
          <g key={f}>
            <Line x1={w * f} y1={0} x2={w * f} y2={h} op={0.8} />
            <Line x1={0} y1={h * f} x2={w} y2={h * f} op={0.8} />
          </g>
        ))}
      {g.actionSafe && <Frame inset={0.035} size={size} op={0.35} />}
      {g.titleSafe && <Frame inset={0.05} size={size} op={0.8} />}
      {g.center && (
        <>
          <Line x1={w / 2 - 14} y1={h / 2} x2={w / 2 + 14} y2={h / 2} op={0.8} />
          <Line x1={w / 2} y1={h / 2 - 14} x2={w / 2} y2={h / 2 + 14} op={0.8} />
        </>
      )}
    </svg>
  )
}
