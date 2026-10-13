import { EventEmitter } from 'node:events'
import path from 'node:path'
import { produce } from 'immer'
import type { MediaManifestEntry } from '../../core/model'
import { OPS, opLabel, type OpArgs, type OpName, type OpResult } from '../../core/ops'
import { activeTimeline, type Doc } from '../../core/ops/context'
import { EditRefusal } from '../../core/timeline'
import { UndoHistory } from '../../core/undo'
import { structurallyEqual } from '../../core/util'
import { readPackage, resolveMediaPath, writePackage } from './packageIO'
import { registerProject } from './registry'
import { mergeManifest } from './undoMerge'
import { isAgentOrigin } from './editOrigin'
import { applyPlaceholderPatches, stalePlaceholderPatches } from './restorePlaceholders'

export interface UiState {
  playheadFrame: number
  selectedClipIds: string[]
  selectedMediaIds: string[]
  rangeIn: number | null
  rangeOut: number | null
}

export interface SessionSnapshot {
  doc: Doc
  version: number
  path: string
  name: string
  dirty: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export type OpOutcome<R> = { ok: true; result: R; changed: boolean } | { ok: false; error: string; beep: boolean }

const AUTOSAVE_DELAY_MS = 2000

/** One open .palmier package: the authoritative document, its undo history and persistence. */
export class ProjectSession extends EventEmitter {
  private _doc: Doc
  private _version = 0
  private _nonAgentTimelineRevision = 0
  private history = new UndoHistory<Doc>(300)
  private dirty = false
  private saveChain: Promise<void> = Promise.resolve()
  private autosaveTimer: NodeJS.Timeout | null = null
  private preservedManifest: Buffer | null
  private thumbnail: Buffer | null = null
  closed = false
  ui: UiState = { playheadFrame: 0, selectedClipIds: [], selectedMediaIds: [], rangeIn: null, rangeOut: null }

  private constructor(
    private _path: string,
    doc: Doc,
    preserved: Buffer | null,
  ) {
    super()
    this._doc = doc
    this.preservedManifest = preserved
  }

  static async open(dir: string): Promise<ProjectSession> {
    const pkg = await readPackage(dir)
    const s = new ProjectSession(dir, { file: pkg.file, manifest: pkg.manifest }, pkg.preservedManifest)
    const vs = pkg.file.viewStates?.[pkg.file.activeTimelineId ?? '']
    s.ui.playheadFrame = vs?.playheadFrame ?? 0
    // Placeholders whose job died with a previous process (Mac `finishRestoredMediaScan`).
    const stale = await stalePlaceholderPatches(s._doc.manifest.entries, (e) => resolveMediaPath(e, dir))
    if (stale.size && s.transact('Update Media', (d) => applyPlaceholderPatches(d, stale), false).ok) void s.save().catch(() => undefined)
    await registerProject(dir)
    return s
  }

  static async create(dir: string, doc: Doc, register = true): Promise<ProjectSession> {
    const s = new ProjectSession(dir, doc, null)
    await writePackage(dir, { file: doc.file, manifest: doc.manifest, preservedManifest: null })
    if (register) await registerProject(dir)
    return s
  }

  get doc(): Doc {
    return this._doc
  }
  get version(): number {
    return this._version
  }
  /** Bumped by every timeline change made outside an agent/MCP tool call (see editOrigin.ts). */
  get nonAgentTimelineRevision(): number {
    return this._nonAgentTimelineRevision
  }
  get path(): string {
    return this._path
  }
  get name(): string {
    return path.basename(this._path).replace(/\.palmier$/i, '')
  }
  get isDirty(): boolean {
    return this.dirty
  }

  snapshot(): SessionSnapshot {
    return {
      doc: this._doc,
      version: this._version,
      path: this._path,
      name: this.name,
      dirty: this.dirty,
      undoLabel: this.history.undoLabel ?? null,
      redoLabel: this.history.redoLabel ?? null,
    }
  }

  /** Runs a registered op. Refusals and no-ops leave the document and history untouched. */
  apply<N extends OpName>(name: N, args: OpArgs<N>): OpOutcome<OpResult<N>> {
    const def = OPS[name] as unknown as { run: (d: Doc, a: OpArgs<N>) => OpResult<N>; history?: boolean }
    return this.transact(opLabel(name, args), (d) => def.run(d, args), def.history !== false)
  }

  /** Runs several ops (or custom logic) as one atomic, single-undo-step edit. */
  transact<R>(label: string, fn: (draft: Doc) => R, recordHistory = true): OpOutcome<R> {
    if (this.closed) return { ok: false, error: 'The project is closed.', beep: false }
    let result!: R
    let next: Doc
    try {
      next = produce(this._doc, (draft) => {
        result = fn(draft as Doc)
      })
    } catch (e) {
      if (e instanceof EditRefusal) return { ok: false, error: e.message, beep: e.beep }
      return { ok: false, error: e instanceof Error ? e.message : String(e), beep: false }
    }
    // Core ops may rebuild arrays (remove + re-add); an edit that lands where it started must not cost an undo step.
    const changed = next !== this._doc && !structurallyEqual(next, this._doc)
    if (changed) {
      if (recordHistory) this.history.record({ label, before: this._doc, after: next })
      this.commit(next, recordHistory)
    }
    return { ok: true, result, changed }
  }

  private commit(next: Doc, markDirty: boolean): void {
    // Mac `nonAgentTimelineMutationRevision`: timeline edits not made by an agent/MCP tool.
    if (next.file.timelines !== this._doc.file.timelines && !isAgentOrigin()) this._nonAgentTimelineRevision++
    this._doc = next
    this._version++
    if (markDirty) {
      this.dirty = true
      this.scheduleAutosave()
    }
    this.emit('change')
  }

  /** Restores `target` (the other side of an undo entry is `from`); non-undoable media-library writes survive. */
  private restore(target: Doc, from: Doc): void {
    const cur = this._doc.file
    const manifest = mergeManifest(this._doc.manifest, from.manifest, target.manifest)
    const active = target.file.activeTimelineId
    const open = [...new Set([...(cur.openTimelineIds ?? []), ...(active ? [active] : [])])].filter((id) => target.file.timelines.some((t) => t.id === id))
    this.commit({ ...target, manifest, file: { ...target.file, openTimelineIds: open, viewStates: { ...(cur.viewStates ?? {}) } } }, true)
  }

  undo(): string | null {
    const e = this.history.undo()
    if (!e) return null
    this.restore(e.before, e.after)
    return e.label
  }

  redo(): string | null {
    const e = this.history.redo()
    if (!e) return null
    this.restore(e.after, e.before)
    return e.label
  }

  setUi(patch: Partial<UiState>): void {
    this.ui = { ...this.ui, ...patch }
  }

  resolveMedia(entryOrId: MediaManifestEntry | string): string | null {
    const e = typeof entryOrId === 'string' ? this._doc.manifest.entries.find((x) => x.id === entryOrId) : entryOrId
    return e ? resolveMediaPath(e, this._path) : null
  }

  activeTimeline() {
    return activeTimeline(this._doc)
  }

  setThumbnail(jpeg: Buffer): void {
    this.thumbnail = jpeg
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null
      void this.save().catch((e) => this.emit('error', e))
    }, AUTOSAVE_DELAY_MS)
  }

  /** Serialized: saves never interleave with each other. */
  save(): Promise<void> {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer)
      this.autosaveTimer = null
    }
    const doc = this._doc
    const version = this._version
    const run = async () => {
      await writePackage(this._path, { file: doc.file, manifest: doc.manifest, preservedManifest: this.preservedManifest, thumbnail: this.thumbnail })
      if (doc.manifest.entries.length || doc.manifest.folders.length) this.preservedManifest = null
      if (this._version === version) {
        this.dirty = false
        this.emit('change')
      }
    }
    const next = this.saveChain.then(run, run)
    this.saveChain = next.catch(() => undefined)
    return next
  }

  async saveAs(dir: string): Promise<void> {
    await this.saveChain
    const doc = this._doc
    await writePackage(dir, { file: doc.file, manifest: doc.manifest, preservedManifest: this.preservedManifest, thumbnail: this.thumbnail, sourceDir: this._path })
    this._path = dir
    this.dirty = false
    await registerProject(dir)
    this.emit('change')
  }

  /** Waits for pending writes and flushes unsaved edits. */
  async close(): Promise<void> {
    if (this.closed) return
    if (this.dirty) await this.save()
    else await this.saveChain
    this.closed = true
    this.removeAllListeners()
  }
}
