import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cursorInstallUrl,
  feedbackBody,
  feedbackIssueUrl,
  feedbackTitle,
  ISSUE_URL_MAX,
  osReleaseName,
  type ChangelogFeed,
  whatsNewEntry,
  type FeedbackSystemInfo,
} from '../../src/shared/firstRun'
import { FEEDBACK_ISSUE_URL, RELEASES_URL } from '../../src/shared/brand'

const root = path.resolve(import.meta.dirname, '../..')
const changelog = JSON.parse(readFileSync(path.join(root, 'resources/changelog.json'), 'utf8')) as ChangelogFeed
const pkgVersion = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version

describe('changelog.json (Mac format)', () => {
  it('has a non-empty entry for the package version', () => {
    expect(changelog.entries.map((e) => e.version)).toContain(pkgVersion)
    const r = changelog.entries.find((e) => e.version === pkgVersion)!
    expect(r.sections.length).toBeGreaterThan(0)
    for (const s of r.sections) for (const item of s.items) expect(item.trim()).not.toBe('')
  })
  it('mentions no Palmier cloud features', () => {
    const text = JSON.stringify(changelog).toLowerCase()
    for (const word of ['credit', 'sign in', 'palmier.io', 'account', 'convex']) expect(text).not.toContain(word)
  })
})

describe('whatsNewEntry (Mac checkForWhatsNew)', () => {
  const feed: ChangelogFeed = { entries: [{ version: '1.2.0', sections: [{ heading: 'New', items: ['x'] }] }] }
  it('never shows on a fresh install', () => {
    expect(whatsNewEntry(feed, undefined, '1.2.0')).toBeNull()
    expect(whatsNewEntry(feed, '', '1.2.0')).toBeNull()
  })
  it('shows on a genuine version change with an entry', () => {
    expect(whatsNewEntry(feed, '1.1.0', '1.2.0')?.version).toBe('1.2.0')
    expect(whatsNewEntry(feed, '1.2.0', '1.2.0')).toBeNull()
    expect(whatsNewEntry(feed, '1.1.0', '1.3.0')).toBeNull()
    expect(whatsNewEntry(null, '1.1.0', '1.2.0')).toBeNull()
  })
})

describe('cursorInstallUrl', () => {
  it('matches the Mac: sorted keys, escaped slashes, base64 left unencoded (05 §10.4)', () => {
    const url = cursorInstallUrl('http://127.0.0.1:19789/mcp')
    const prefix = 'cursor://anysphere.cursor-deeplink/mcp/install?name=framewright&config='
    expect(url.startsWith(prefix)).toBe(true)
    const config = url.slice(prefix.length)
    expect(Buffer.from(config, 'base64').toString('utf8')).toBe('{"type":"http","url":"http:\\/\\/127.0.0.1:19789\\/mcp"}')
    expect(JSON.parse(Buffer.from(config, 'base64').toString('utf8'))).toEqual({ type: 'http', url: 'http://127.0.0.1:19789/mcp' })
  })
})

describe('feedback issue URL', () => {
  const info: FeedbackSystemInfo = { appVersion: '0.1.0', distro: 'Ubuntu 24.04 LTS', kernel: '6.8.0-45-generic', electron: '44.0.0' }
  it('titles with the first non-empty line, at most 80 chars', () => {
    expect(feedbackTitle('\n\n  Export   crashes \nmore detail')).toBe('Export crashes')
    const long = 'x'.repeat(200)
    expect(feedbackTitle(long)).toHaveLength(80)
    expect(feedbackTitle(long).endsWith('…')).toBe(true)
    expect(feedbackTitle('   ')).toBe('Feedback')
  })
  it('ends the body with the system line and mentions a saved screenshot', () => {
    expect(feedbackBody('Hello', info)).toBe('Hello\n\n---\nApp 0.1.0 · Ubuntu 24.04 LTS 6.8.0-45-generic · Electron 44.0.0')
    expect(feedbackBody('Hello', info, 'shot.png')).toContain('“shot.png”')
  })
  it('builds a prefilled issues/new URL', () => {
    const url = new URL(feedbackIssueUrl('https://github.com/a/b/issues/new', 'Crash on export\nSteps…', info))
    expect(url.origin + url.pathname).toBe('https://github.com/a/b/issues/new')
    expect(url.searchParams.get('title')).toBe('Crash on export')
    expect(url.searchParams.get('body')).toContain('Steps…\n\n---\nApp 0.1.0')
  })
  it('caps very long messages to fit the URL limit', () => {
    const url = feedbackIssueUrl('https://github.com/a/b/issues/new', 'é'.repeat(10_000), info)
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX)
    const body = new URL(url).searchParams.get('body')!
    expect(body).toContain('Message shortened')
    expect(body).toContain('Electron 44.0.0')
  })
  it('brand links derive from one repo constant', () => {
    expect(FEEDBACK_ISSUE_URL.endsWith('/issues/new')).toBe(true)
    expect(RELEASES_URL.endsWith('/releases')).toBe(true)
  })
})

describe('osReleaseName', () => {
  it('reads PRETTY_NAME in its quoting styles', () => {
    expect(osReleaseName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe('Ubuntu 24.04.1 LTS')
    expect(osReleaseName("PRETTY_NAME='Fedora Linux 41'")).toBe('Fedora Linux 41')
    expect(osReleaseName('PRETTY_NAME=Arch')).toBe('Arch')
    expect(osReleaseName('NAME=x')).toBe('Linux')
  })
})
