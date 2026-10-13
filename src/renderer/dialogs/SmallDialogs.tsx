import { useEffect, useRef, useState } from 'react'
import { closeDialog, type SettingsSuggestion } from '../state/dialogs'
import { useTimeline } from '../state/project'
import { runOp } from '../state/ops'
import { Capsule } from '../ui/buttons'
import { Sheet } from '../ui/Sheet'
import { SheetFooter, dialogKeys } from './common'
import { t } from '../i18n'
import { APP_NAME, ATTRIBUTION, LICENSE_URL, MODIFICATIONS_NOTICE, REPO_URL, UPSTREAM_COPYRIGHT, UPSTREAM_NAME, UPSTREAM_URL } from '../../shared/brand'
import { AppIcon } from '../ui/AppIcon'
import { ExternalLink } from './SettingsDialog'

export function AboutDialog() {
  const [info, setInfo] = useState<{ version: string; ffmpeg: string } | null>(null)
  useEffect(() => {
    void window.palmier.app.info().then(setInfo)
  }, [])
  return (
    <Sheet width={340} onClose={closeDialog}>
      <div className="pp-dlg pp-about" {...dialogKeys(closeDialog)}>
        <AppIcon className="pp-about-mark" size={64} />
        <div className="pp-about-name">{APP_NAME}</div>
        <div className="pp-about-version tnum">{info ? t('Version {0}', info.version) : ' '}</div>
        {/* GPLv3 attribution and notice: proper names and legal text, not localized. */}
        <div className="pp-about-text">{ATTRIBUTION}</div>
        <div className="pp-about-legal">
          {UPSTREAM_COPYRIGHT}
          <br />
          {MODIFICATIONS_NOTICE}
        </div>
        <div className="pp-about-links">
          <ExternalLink url={REPO_URL}>{t('Source Code')}</ExternalLink>
          <ExternalLink url={UPSTREAM_URL}>{UPSTREAM_NAME}</ExternalLink>
          <ExternalLink url={LICENSE_URL}>GPLv3</ExternalLink>
        </div>
        {info?.ffmpeg && (
          <div className="pp-about-ffmpeg mono ellipsis" data-tip={info.ffmpeg}>
            {t('FFmpeg: {0}', info.ffmpeg)}
          </div>
        )}
        <SheetFooter>
          <Capsule size="regular" variant="prominent" onClick={closeDialog}>
            {t('OK')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}

export function NewProjectDialog() {
  const [name, setName] = useState(t('Untitled Project'))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const create = async () => {
    const n = name.trim()
    if (!n) return setError(t('Enter a name for the project.'))
    if (/[/\\]/.test(n)) return setError(t('Project names can’t contain slashes.'))
    setBusy(true)
    const r = await window.palmier.home.createProject(n)
    setBusy(false)
    if (r.ok) closeDialog()
    else setError(r.error || t('Couldn’t create the project.'))
  }
  return (
    <Sheet width={380} onClose={closeDialog}>
      <div className="pp-dlg" {...dialogKeys(() => void create())}>
        <span className="pp-dlg-title">{t('New Project')}</span>
        <label className="pp-dlg-field">
          <span className="pp-dlg-field-label">{t('Name')}</span>
          <input
            ref={ref}
            className="pp-text-input"
            value={name}
            spellCheck={false}
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </label>
        {error && <span className="pp-dlg-error">{error}</span>}
        <SheetFooter>
          <Capsule size="regular" onClick={closeDialog}>
            {t('Cancel')}
          </Capsule>
          <Capsule size="regular" variant="prominent" disabled={busy || !name.trim()} onClick={() => void create()}>
            {t('Create')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}

const MAX_EDGE = 8192
const evenRound = (v: number) => Math.round(v / 2) * 2
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** Keeps the short edge (made even) and derives the long edge from the ratio. */
function aspectResolution(rw: number, rh: number, w: number, h: number): { width: number; height: number } | string {
  if (!(rw > 0 && rh > 0) || !Number.isFinite(rw) || !Number.isFinite(rh)) return t('Enter a width and height greater than zero.')
  const short = Math.max(2, evenRound(Math.min(w, h)))
  const size = rw >= rh ? { width: evenRound((short * rw) / rh), height: short } : { width: short, height: evenRound((short * rh) / rw) }
  if (size.width < 2 || size.height < 2) return t('The resulting resolution is too small.')
  if (size.width > MAX_EDGE || size.height > MAX_EDGE) return t('The resulting resolution exceeds {0} pixels per edge.', MAX_EDGE)
  return size
}

export function CustomAspectDialog() {
  const tl = useTimeline()
  const divisor = tl ? gcd(tl.width, tl.height) || 1 : 1
  const [rw, setRw] = useState(tl ? String(tl.width / divisor) : '16')
  const [rh, setRh] = useState(tl ? String(tl.height / divisor) : '9')
  if (!tl) return null
  const parse = (s: string) => Number(s.trim().replace(',', '.'))
  const result = aspectResolution(parse(rw), parse(rh), tl.width, tl.height)
  const valid = typeof result !== 'string'
  const changed = valid && (result.width !== tl.width || result.height !== tl.height)
  const apply = async () => {
    if (!valid || !changed) return
    if ((await runOp('applyProjectSettings', { fps: tl.fps, width: result.width, height: result.height })) !== undefined) closeDialog()
  }
  return (
    <Sheet width={340} onClose={closeDialog}>
      <div className="pp-dlg pp-aspect" {...dialogKeys(() => void apply())}>
        <span className="pp-aspect-title">{t('Custom Aspect Ratio')}</span>
        <span className="pp-dlg-text">{t('Changing the ratio preserves the shorter edge.')}</span>
        <div className="pp-aspect-fields">
          <input className="pp-text-input tnum" value={rw} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setRw(e.target.value)} aria-label={t('Width')} />
          <span className="pp-aspect-colon">:</span>
          <input className="pp-text-input tnum" value={rh} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setRh(e.target.value)} aria-label={t('Height')} />
        </div>
        {valid ? <span className="pp-aspect-preview tnum">{t('Resolution {0} × {1}', result.width, result.height)}</span> : <span className="pp-dlg-error">{result}</span>}
        <SheetFooter>
          <Capsule size="regular" onClick={closeDialog}>
            {t('Cancel')}
          </Capsule>
          <Capsule size="regular" variant="prominent" disabled={!valid || !changed} onClick={() => void apply()}>
            {t('Apply')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}

export function MismatchDialog({ suggestion, resolve }: { suggestion: SettingsSuggestion; resolve: (change: boolean | null) => void }) {
  const tl = useTimeline()
  if (!tl) return null
  const fpsDiff = suggestion.fps !== tl.fps
  const resDiff = suggestion.width !== tl.width || suggestion.height !== tl.height
  return (
    <Sheet width={360} onClose={() => resolve(null)}>
      <div className="pp-dlg" {...dialogKeys(() => resolve(true))}>
        <span className="pp-dlg-title">{t('Clip Settings Mismatch')}</span>
        <span className="pp-dlg-text">{t('The clip you’re adding has different settings than the current project.')}</span>
        <div className="pp-mismatch tnum">
          <span />
          <span className="pp-mismatch-head">{t('Project')}</span>
          <span className="pp-mismatch-head">{t('Clip')}</span>
          <span className="pp-mismatch-label">{t('FPS')}</span>
          <span>{tl.fps}</span>
          <span className={fpsDiff ? 'diff' : undefined}>{suggestion.fps}</span>
          <span className="pp-mismatch-label">{t('Resolution')}</span>
          <span>
            {tl.width} × {tl.height}
          </span>
          <span className={resDiff ? 'diff' : undefined}>
            {suggestion.width} × {suggestion.height}
          </span>
        </div>
        <SheetFooter>
          <Capsule size="regular" onClick={() => resolve(false)}>
            {t('Keep Current')}
          </Capsule>
          <Capsule size="regular" variant="prominent" onClick={() => resolve(true)}>
            {t('Change to Match')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}
