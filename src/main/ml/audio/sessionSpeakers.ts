/**
 * Session speaker state in main (Mac `EditorViewModel.speakerAssignments` + masks; spec 07 §3.5): the masks of the
 * last Identify / auto run per project session, so `get_transcript` labels speakers project-wide the way the
 * timeline tints them. Session-only, like the Mac.
 */
import type { SpeakerRuns } from '../../../core/audio/speakers'
import type { ProjectSession } from '../../project/session'
import type { SpeakerFile, SpeakerService } from './speakers'

export type SessionMasks = Record<string, { count: number; runs: [number, number, number][] }>

export class SessionSpeakers {
  private readonly masks = new WeakMap<ProjectSession, SessionMasks>()

  constructor(private readonly speakers: SpeakerService) {}

  /** Merges an identify result (the renderer merges the same way). */
  set(s: ProjectSession, masks: SessionMasks): void {
    this.masks.set(s, { ...this.masks.get(s), ...masks })
  }

  /** `removeSpeaker`: that id's cells become −1. */
  removeSpeaker(s: ProjectSession, id: number): void {
    const m = this.masks.get(s)
    if (!m) return
    const out: SessionMasks = {}
    for (const [ref, v] of Object.entries(m)) out[ref] = { count: v.count, runs: v.runs.filter((r) => r[2] !== id) }
    this.masks.set(s, out)
  }

  get(s: ProjectSession): SessionMasks | undefined {
    return this.masks.get(s)
  }

  /**
   * Speaker runs per mediaRef for `get_transcript` (`alignedSpeakerLabels`): the session's identify result when there is
   * one; otherwise a cache-only clustering of `files` against the registry (cached turns + voice fingerprints, nothing
   * persisted). [Linux] the fallback never diarizes or downloads models — a read-only tool stays fast and offline.
   */
  async runsFor(s: ProjectSession, files: SpeakerFile[]): Promise<Record<string, SpeakerRuns>> {
    const have = this.masks.get(s)
    const pick = (m: SessionMasks) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.runs]))
    if (have && Object.keys(have).length) return pick(have)
    if (!files.length || this.speakers.inFlight) return {}
    try {
      const r = await this.speakers.identify(files, s.doc.file.speakers ?? [], { cacheOnly: true })
      return pick(r.masks)
    } catch {
      return {}
    }
  }
}
