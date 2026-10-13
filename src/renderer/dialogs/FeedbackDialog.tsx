/**
 * Help ▸ Send Feedback (spec 05 §10.5, 07 §7.4 Linux): no Palmier backend, so "Send" opens a prefilled GitHub issue
 * in the browser. The window screenshot (captured before this sheet opened) can't ride along in a URL, so it is
 * saved to a file the user picks and the issue body says to attach it.
 */
import { useEffect, useState } from 'react'
import { FEEDBACK_ISSUE_URL } from '../../shared/brand'
import { FEEDBACK_MAX_CHARS, feedbackIssueUrl, type FeedbackSystemInfo } from '../../shared/firstRun'
import { closeDialog, openDialog } from '../state/dialogs'
import { Capsule } from '../ui/buttons'
import { Checkbox, Spinner } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { toast } from '../ui/toast'
import { SheetFooter, dialogKeys } from './common'
import './feedback.css'
import { t } from '../i18n'

/** Captures the window first (so the sheet isn't in the picture), then opens the dialog. */
export async function openFeedback(): Promise<void> {
  const screenshot = await window.palmier.feedback.capture().catch(() => null)
  openDialog({ kind: 'feedback', screenshot })
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export function FeedbackDialog({ screenshot }: { screenshot: string | null }) {
  const [message, setMessage] = useState('')
  const [includeShot, setIncludeShot] = useState(!!screenshot)
  const [info, setInfo] = useState<FeedbackSystemInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ screenshotPath: string | null } | null>(null)
  useEffect(() => {
    void window.palmier.feedback.systemInfo().then(setInfo)
  }, [])
  const canSend = !!message.trim() && !!info && !busy

  const send = async () => {
    if (!canSend || !info) return
    setBusy(true)
    let shotPath: string | null = null
    if (includeShot && screenshot) {
      const r = await window.palmier.feedback.saveScreenshot(screenshot)
      if (!r) return setBusy(false)
      if (!r.ok) {
        setBusy(false)
        toast(r.error, 'error')
        return
      }
      shotPath = r.path
    }
    window.palmier.app.openExternal(feedbackIssueUrl(FEEDBACK_ISSUE_URL, message, info, shotPath ? basename(shotPath) : null))
    setBusy(false)
    setDone({ screenshotPath: shotPath })
  }

  if (done) {
    return (
      <Sheet width={480} onClose={closeDialog}>
        <div className="pp-dlg pp-fb-done" {...dialogKeys(closeDialog)} data-testid="feedback-done">
          <Icon sf="checkmark.circle.fill" size={28} className="pp-fb-check" />
          <span className="pp-fb-done-title">{t('Thanks for the feedback.')}</span>
          <span className="pp-dlg-text">{t('Your browser opened a new GitHub issue with your message. Review it there and submit.')}</span>
          {done.screenshotPath && (
            <span className="pp-dlg-text">
              {t('Screenshot saved to')} <span className="mono">{done.screenshotPath}</span>. {t('Drag it into the issue to attach it.')}
            </span>
          )}
          <SheetFooter leading={done.screenshotPath ? <Capsule size="regular" onClick={() => window.palmier.app.showItemInFolder(done.screenshotPath!)}>{t('Show in Folder')}</Capsule> : undefined}>
            <Capsule size="regular" variant="prominent" onClick={closeDialog}>
              {t('Done')}
            </Capsule>
          </SheetFooter>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet width={480} onClose={closeDialog}>
      <div className="pp-dlg pp-fb" {...dialogKeys(() => void send())} data-testid="feedback">
        <span className="pp-dlg-title-lg">{t('Send feedback')}</span>
        <label className="pp-fb-field">
          <span className="pp-fb-label">{t('Describe the issue or feedback')}</span>
          <textarea className="pp-fb-text" value={message} maxLength={FEEDBACK_MAX_CHARS} autoFocus onChange={(e) => setMessage(e.target.value)} />
        </label>
        {screenshot && (
          <div className="pp-fb-shot">
            <Checkbox checked={includeShot} onChange={setIncludeShot} label={t('Include screenshot')} />
            <img className="pp-fb-thumb" src={screenshot} alt="" style={{ opacity: includeShot ? 1 : 0.35 }} />
          </div>
        )}
        {screenshot && includeShot && <span className="pp-fb-note">{t('You’ll choose where to save the screenshot, then attach it to the issue.')}</span>}
        <span className="pp-fb-note">
          <Icon sf="info.circle" size={10} />
          {info ? t('App version {0} and {1} are included.', info.appVersion, `${info.distro} ${info.kernel}`) : ' '}
        </span>
        <SheetFooter>
          <Capsule size="regular" onClick={closeDialog}>
            {t('Cancel')}
          </Capsule>
          <Capsule size="regular" variant="prominent" disabled={!canSend} onClick={() => void send()} data-tip={t('Ctrl+Enter')}>
            {busy ? <Spinner size={10} /> : null}
            {busy ? t('Opening…') : t('Open Issue')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}
