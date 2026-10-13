/**
 * Main-process localization: resolves the UI language once at startup (the Mac applies a new choice only after a
 * restart, `AppLocalization.requiresRestart`) and translates menus, dialogs and notifications with the same tables
 * the renderer uses (`resources/locales/<id>.json`).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import { createTranslator, isLocaleId, keyMatcher, resolveSystemLocale, type FormatArg, type I18nPayload, type LocaleId, type StringTable } from '../shared/i18n'

let payload: I18nPayload = { active: 'en', system: 'en', selection: 'system', strings: {} }
let translator = createTranslator('en', {})

export function localesDir(): string {
  return path.join(__dirname, '../../resources/locales')
}

export function readLocaleTable(id: LocaleId, dir = localesDir()): StringTable {
  if (id === 'en') return {}
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object') return {}
    const out: StringTable = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && v) out[k] = v
    return out
  } catch (e) {
    console.error(`[i18n] couldn't read ${id}.json: ${e instanceof Error ? e.message : String(e)}`)
    return {}
  }
}

/** Call once after settings load. `PALMIER_LANG` overrides the stored choice (headless checks). */
export function initI18n(stored: string | undefined, preferred: readonly string[]): I18nPayload {
  const env = process.env.PALMIER_LANG
  const selection = isLocaleId(env) ? env : isLocaleId(stored) ? stored : 'system'
  const system = resolveSystemLocale(preferred)
  const active = selection === 'system' ? system : selection
  payload = { active, system, selection, strings: readLocaleTable(active) }
  translator = createTranslator(active, payload.strings)
  patterns = null
  return payload
}

export const activeLocale = (): LocaleId => payload.active

/** Translate in main (menus, dialogs, notifications). */
export const tm = (key: string, ...args: FormatArg[]): string => translator.t(key, ...args)
export const tmPlural = (n: number, one: string, other: string, ...rest: FormatArg[]): string => translator.plural(n, one, other, ...rest)

let patterns: { key: string; match: (s: string) => string[] | null }[] | null = null

/** Translates a finished English message (e.g. a generation `readyMessage`): exact key, else a `{0}` key of the same shape. */
export function tmx(message: string): string {
  const strings = payload.strings
  if (!message || strings[message]) return message ? translator.t(message) : message
  patterns ??= Object.keys(strings)
    .filter((k) => /\{\d+\}/.test(k))
    .map((key) => ({ key, match: keyMatcher(key) }))
  for (const p of patterns) {
    const args = p.match(message)
    if (args) return translator.t(p.key, ...args)
  }
  return message
}

let restartRequested = false

export function registerI18nIpc(): void {
  ipcMain.handle('i18n:get', () => payload)
  ipcMain.on('app:restart', () => {
    restartRequested = true
    app.quit()
  })
  // Relaunch only once every project saved and the quit went through (Mac: terminate, then reopen).
  app.on('will-quit', () => {
    if (restartRequested) app.relaunch()
  })
}

/** A failed save cancels the quit; forget the restart so a later plain quit doesn't relaunch. */
export function cancelRestart(): void {
  restartRequested = false
}
