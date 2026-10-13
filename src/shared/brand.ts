/**
 * Product identity. Keep every name, id and repo/website URL here so a rename is one edit.
 *
 * Framewright is derived from Palmier Pro v0.7.6 (GPLv3) by Palmier, Inc.; the attribution constants below feed
 * the About dialog, README and NOTICE. "Palmier" stays in the code base only as attribution or as a compatibility
 * identifier (the `.palmier` project package, `PALMIER_*` env aliases, the MCP `palmier` export mode and
 * `palmier://models/*` resources, which are part of the Mac MCP contract).
 */
export const APP_NAME = 'Framewright'

/** Lower-case id: XDG directory names, executable, MCP server name, external skill folder prefix. */
export const APP_SLUG = 'framewright'

/** Reverse-DNS application id (electron-builder appId, desktop file, WM_CLASS-adjacent identifiers). */
export const APP_ID = 'io.github.nikhildhaliya.framewright'

/** Pre-rebrand XDG directory name; migrated once on startup (src/main/paths.ts). */
export const LEGACY_SLUG = 'palmier-pro'

export const REPO_URL = 'https://github.com/NikhilDhaliya/aieditor'

/** Help ▸ Send Feedback opens a prefilled issue here (spec 07 §7.4 `feedbackIssueURL`). */
export const FEEDBACK_ISSUE_URL = `${REPO_URL}/issues/new`
/** What's New ▸ "Full changelog" (spec 07 §7.5). */
export const RELEASES_URL = `${REPO_URL}/releases`
/** Tour outro ▸ Documentation (spec 07 §7.3: the Linux README). */
export const DOCS_URL = `${REPO_URL}#readme`

/** GPLv3 attribution (About, README, NOTICE). Not localized: proper names and a legal notice. */
export const UPSTREAM_NAME = 'Palmier Pro'
export const UPSTREAM_AUTHOR = 'Palmier, Inc.'
export const UPSTREAM_URL = 'https://github.com/palmier-io/palmier-pro'
export const UPSTREAM_COPYRIGHT = 'Copyright (C) 2026 Palmier, Inc.'
export const ATTRIBUTION = `Based on ${UPSTREAM_NAME} (GPLv3) by ${UPSTREAM_AUTHOR}`
export const LICENSE_NAME = 'GPL-3.0-only'
export const LICENSE_URL = 'https://www.gnu.org/licenses/gpl-3.0.html'
/** GPLv3 §5(a): the modified work carries a notice that it was changed, and when. */
export const MODIFICATIONS_NOTICE = 'Linux port and modifications Copyright (C) 2026 Nikhil Dhaliya'
