import { create } from 'zustand'
import type { Timeline } from '@core/model'
import type { Doc } from '@core/ops/context'
import type { ProjectState } from '../../shared/api'

interface ProjectStore {
  /** Last authoritative snapshot from main. */
  snapshot: ProjectState | null
  /** Locally produced document shown while an interaction is live; cleared on commit or cancel. */
  preview: Doc | null
}

export const useProject = create<ProjectStore>(() => ({ snapshot: null, preview: null }))

export const getBaseDoc = (): Doc | null => useProject.getState().snapshot?.doc ?? null
export const getDoc = (): Doc | null => {
  const s = useProject.getState()
  return s.preview ?? s.snapshot?.doc ?? null
}

export function timelineOf(doc: Doc | null | undefined): Timeline | null {
  if (!doc) return null
  const id = doc.file.activeTimelineId
  return doc.file.timelines.find((t) => t.id === id) ?? doc.file.timelines[0] ?? null
}

export const getTimeline = (): Timeline | null => timelineOf(getDoc())

/** The displayed document (live preview if any). */
export const useDoc = (): Doc | null => useProject((s) => s.preview ?? s.snapshot?.doc ?? null)
export const useTimeline = (): Timeline | null => useProject((s) => timelineOf(s.preview ?? s.snapshot?.doc))
export const useManifest = () => useProject((s) => (s.preview ?? s.snapshot?.doc)?.manifest ?? null)

/**
 * Resolves once every id in `ids` is in the authoritative manifest (main pushes the doc after an IPC call returns),
 * or `false` after `timeoutMs` / when the project closes. Subscribes to the store; no polling.
 */
export function whenMediaPresent(ids: string[], timeoutMs = 10_000): Promise<boolean> {
  const present = (s: ProjectStore) => {
    const entries = s.snapshot?.doc.manifest.entries
    return !!entries && ids.every((id) => entries.some((e) => e.id === id))
  }
  if (present(useProject.getState())) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      unsub()
      window.clearTimeout(timer)
      resolve(ok)
    }
    const unsub = useProject.subscribe((s) => {
      if (present(s)) done(true)
      else if (!s.snapshot) done(false)
    })
    const timer = window.setTimeout(() => done(false), timeoutMs)
  })
}
