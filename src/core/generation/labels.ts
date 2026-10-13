/** Display labels for model settings (spec 06 §B1.2, §B7.6). */

export function parseWxH(s: string): [number, number] | null {
  const parts = s.toLowerCase().split('x')
  if (parts.length !== 2) return null
  const w = Number(parts[0])
  const h = Number(parts[1])
  return Number.isInteger(w) && Number.isInteger(h) && parts[0] !== '' && parts[1] !== '' ? [w, h] : null
}

export function resolutionDisplayLabel(id: string): string {
  const wh = parseWxH(id)
  if (!wh) return id
  const [w, h] = wh
  if (w === h) return 'Square'
  const orientation = w > h ? 'Landscape' : 'Portrait'
  const long = Math.max(w, h)
  const tier = long === 3840 ? '4K' : long === 2560 ? '2K' : long === 1920 ? '1080p' : long === 1024 || long === 1536 ? '' : `${long}p`
  return tier ? `${orientation} ${tier}` : orientation
}

export function aspectRatioDisplayLabel(id: string): string {
  if (id.includes(':')) return id
  const parts = id.split('_').filter((p) => p !== '')
  if (!parts.length) return id
  if (parts.length >= 2) {
    const w = parts[parts.length - 2]
    const h = parts[parts.length - 1]
    if (/^\d+$/.test(w) && /^\d+$/.test(h)) parts.splice(parts.length - 2, 2, `${Number(w)}:${Number(h)}`)
  }
  return parts
    .map((t) => {
      const lower = t.toLowerCase()
      return ['hd', 'uhd', '1k', '2k', '4k', '8k'].includes(lower) ? lower.toUpperCase() : lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', hi: 'Hindi', ar: 'Arabic', ru: 'Russian', nl: 'Dutch', pl: 'Polish', tr: 'Turkish',
}

export function languageName(code: string): string {
  if (!code) return 'Target Language'
  try {
    const n = new Intl.DisplayNames(['en'], { type: 'language' }).of(code)
    if (n && n !== code) return n.charAt(0).toUpperCase() + n.slice(1)
  } catch {
    // fall through to the static table
  }
  return LANGUAGE_NAMES[code] ?? code.toUpperCase()
}

export const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
