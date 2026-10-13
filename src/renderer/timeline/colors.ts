import type { ClipType } from '@core/model'
import { useSettings } from '../state/settings'

export interface Palette {
  clip: Record<ClipType, string>
  fg: Record<ClipType, string>
  surface: string
  base: string
  borderPrimary: string
  borderSubtle: string
  borderDivider: string
  clipBorder: string
  clipBorderSelected: string
  markerBorder: string
  markerBorderSelected: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  textMuted: string
  timecode: string
  playhead: string
  error: string
  yellow: string
  orange: string
  fillSoft: string
  multicam: string
}

const KIND_VAR: Record<ClipType, string> = {
  video: '--pp-clip-video',
  audio: '--pp-clip-audio',
  image: '--pp-clip-image',
  text: '--pp-clip-text',
  subtitle: '--pp-clip-text',
  lottie: '--pp-clip-animation',
  sequence: '--pp-clip-sequence',
}

const KIND_SETTING: Record<ClipType, string> = { video: 'video', audio: 'audio', image: 'image', text: 'text', subtitle: 'text', lottie: 'animation', sequence: 'sequence' }

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** Black or white, whichever has the higher WCAG contrast against `hex`. */
export function readableForeground(hex: string): string {
  const l = luminance(hex)
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#FFFFFF'
}

let cached: Palette | null = null

export function palette(): Palette {
  if (cached) return cached
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(name).trim()
  const overrides = useSettings.getState().settings?.timelineColors ?? {}
  const clip = {} as Record<ClipType, string>
  const fg = {} as Record<ClipType, string>
  for (const k of Object.keys(KIND_VAR) as ClipType[]) {
    clip[k] = overrides[KIND_SETTING[k]] ?? v(KIND_VAR[k])
    fg[k] = readableForeground(clip[k])
  }
  cached = {
    clip,
    fg,
    surface: v('--pp-bg-surface'),
    base: v('--pp-bg-base'),
    borderPrimary: v('--pp-border-primary'),
    borderSubtle: v('--pp-border-subtle'),
    borderDivider: v('--pp-border-divider'),
    clipBorder: v('--pp-border-timeline-clip'),
    clipBorderSelected: v('--pp-border-timeline-clip-selected'),
    markerBorder: v('--pp-border-timeline-marker'),
    markerBorderSelected: v('--pp-border-timeline-marker-selected'),
    textPrimary: v('--pp-text-primary'),
    textSecondary: v('--pp-text-secondary'),
    textTertiary: v('--pp-text-tertiary'),
    textMuted: v('--pp-text-muted'),
    timecode: v('--pp-timecode'),
    playhead: v('--pp-playhead'),
    error: v('--pp-status-error'),
    yellow: v('--pp-system-yellow'),
    orange: v('--pp-system-orange'),
    fillSoft: v('--pp-fill-soft'),
    multicam: v('--pp-multicam'),
  }
  return cached
}

const listeners = new Set<() => void>()

export function onPaletteChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function invalidate(): void {
  cached = null
  for (const l of listeners) l()
}

new MutationObserver(invalidate).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
useSettings.subscribe((s, p) => {
  if (s.settings?.timelineColors !== p.settings?.timelineColors) invalidate()
})
