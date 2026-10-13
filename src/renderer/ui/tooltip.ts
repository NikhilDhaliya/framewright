/** One shared capsule tooltip for every element carrying `data-tip` (optional `data-tip-align`: leading | trailing). */
const SHOW_DELAY_MS = 20

let tipEl: HTMLDivElement | null = null
let anchor: HTMLElement | null = null
let timer = 0

function element(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div')
    tipEl.className = 'pp-tooltip'
    document.body.appendChild(tipEl)
  }
  return tipEl
}

function hide(): void {
  window.clearTimeout(timer)
  anchor = null
  tipEl?.classList.remove('visible')
}

function show(target: HTMLElement): void {
  const text = target.dataset.tip
  if (!text) return hide()
  const el = element()
  el.textContent = text
  const r = target.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  const align = target.dataset.tipAlign
  let x = align === 'leading' ? r.left : align === 'trailing' ? r.right - w : r.left + r.width / 2 - w / 2
  let y = r.bottom + 4
  if (y + h > window.innerHeight - 4) y = r.top - h - 4
  x = Math.max(4, Math.min(window.innerWidth - w - 4, x))
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  el.classList.add('visible')
}

export function installTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    const target = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null
    if (target === anchor) return
    window.clearTimeout(timer)
    if (!target) return hide()
    anchor = target
    timer = window.setTimeout(() => anchor === target && target.isConnected && show(target), SHOW_DELAY_MS)
  })
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('wheel', hide, { capture: true, passive: true })
  document.addEventListener('keydown', hide, true)
  window.addEventListener('blur', hide)
}
