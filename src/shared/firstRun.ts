/** Pure first-run and Help logic: What's New gating, the Cursor install deeplink, the feedback issue URL (spec 05 §8.6, §10.4–10.5; 07 §7.2–7.5). */
import { APP_SLUG } from './brand'

/** `resources/changelog.json`, the Mac `Resources/Changelog/changelog.json` format (`App/Changelog.swift`). */
export interface ChangelogSection {
  heading?: string
  items: string[]
}

export interface ChangelogEntry {
  version: string
  date?: string
  sections: ChangelogSection[]
}

export interface ChangelogFeed {
  /** "Full changelog" link; absent = `RELEASES_URL` from brand.ts. */
  changelogURL?: string
  entries: ChangelogEntry[]
}

/**
 * Mac `ChangelogStore.checkForWhatsNew` (run when Home appears): the caller always records `current` as
 * `lastSeenVersion`; the entry is returned only on a genuine version change, never on a fresh install
 * (no previous `lastSeenVersion`). Onboarding takes precedence: What's New waits until it is complete.
 */
export function whatsNewEntry(feed: ChangelogFeed | null | undefined, lastSeen: string | undefined, current: string): ChangelogEntry | null {
  if (!feed || !lastSeen || lastSeen === current) return null
  return feed.entries.find((e) => e.version === current) ?? null
}

const toBase64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

/**
 * Help ▸ MCP ▸ "Install in Cursor ↗" (05 §10.4), byte-identical to the Mac apart from the server name: `JSONSerialization` with sorted keys
 * (which escapes "/" as "\/"), base64, then `.urlQueryAllowed` percent-encoding, which leaves base64's `+/=` as is.
 */
export function cursorInstallUrl(mcpUrl: string): string {
  const config = JSON.stringify({ type: 'http', url: mcpUrl }).replace(/\//g, '\\/')
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${APP_SLUG}&config=${toBase64(config)}`
}

export const FEEDBACK_MAX_CHARS = 10_000
const TITLE_MAX = 80

export interface FeedbackSystemInfo {
  appVersion: string
  /** e.g. "Ubuntu 24.04.1 LTS"; "Linux" when /etc/os-release is unreadable. */
  distro: string
  kernel: string
  electron: string
}

/** PRETTY_NAME from an os-release file's text; "Linux" when absent. */
export function osReleaseName(text: string): string {
  const m = /^PRETTY_NAME=(?:"([^"]*)"|'([^']*)'|(.*))$/m.exec(text)
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim() || 'Linux'
}

/** First non-empty line, collapsed, at most 80 characters (ellipsis when cut). */
export function feedbackTitle(message: string): string {
  const line = message.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).find((l) => l) ?? ''
  if (!line) return 'Feedback'
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

export const systemLine = (i: FeedbackSystemInfo): string => `App ${i.appVersion} · ${i.distro} ${i.kernel} · Electron ${i.electron}`

/** Issue body: the message, an optional saved-screenshot note, then the system line (07 §7.4). */
export function feedbackBody(message: string, info: FeedbackSystemInfo, screenshotName?: string | null): string {
  const parts = [message.trim().slice(0, FEEDBACK_MAX_CHARS)]
  if (screenshotName) parts.push(`Screenshot saved as “${screenshotName}”. Drag it into this issue to attach it.`)
  return `${parts.join('\n\n')}\n\n---\n${systemLine(info)}`
}

/** GitHub rejects very long issue URLs; longer messages are cut (with a note) to stay under this. */
export const ISSUE_URL_MAX = 7500
const CUT_NOTE = '\n\n[Message shortened to fit the link. Paste the rest here.]'

/** `<issuesNewUrl>?title=…&body=…` with both values percent-encoded, at most `ISSUE_URL_MAX` characters. */
export function feedbackIssueUrl(issuesNewUrl: string, message: string, info: FeedbackSystemInfo, screenshotName?: string | null): string {
  const build = (msg: string) =>
    `${issuesNewUrl}${issuesNewUrl.includes('?') ? '&' : '?'}title=${encodeURIComponent(feedbackTitle(message))}&body=${encodeURIComponent(feedbackBody(msg, info, screenshotName))}`
  let url = build(message)
  if (url.length <= ISSUE_URL_MAX) return url
  let lo = 0
  let hi = message.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (build(message.slice(0, mid).trimEnd() + CUT_NOTE).length <= ISSUE_URL_MAX) lo = mid
    else hi = mid - 1
  }
  url = build(message.slice(0, lo).trimEnd() + CUT_NOTE)
  return url
}
