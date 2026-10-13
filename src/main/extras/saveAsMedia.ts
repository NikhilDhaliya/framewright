/**
 * Save as Media / Save as Audio / Extract Audio / Save Range as Media (spec 07 §6.3,
 * `EditorViewModel+SaveAsMedia.swift`). Common flow: placeholder asset (generating / rendering) at the final
 * `media/clip-<8 hex>.<ext>` path → render into a $TMPDIR staging file → commit into the package → finalize
 * metadata (status none) or mark it failed. No undo entry; the staging file is always deleted.
 */
import { existsSync } from 'node:fs'
import { newId, type ClipType, type MediaManifestEntry } from '../../core/model'
import { sourceFramesConsumed } from '../../core/clip'
import { addMediaEntries, updateMediaEntry } from '../../core/ops/project'
import { activeTimeline } from '../../core/ops/context'
import { totalFrames } from '../../core/timeline'
import { failedStatus } from '../../core/generation/status'
import { audioClipForExtraction, canExtractAudio, canSaveClipAsMedia } from '../../shared/extras'
import { ffmpeg } from '../media/ffmpeg'
import { ffprobeJson } from '../media/probe'
import { sourceForPath } from '../project/packageIO'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { clipRangeArgs, extractAudioArgs } from './ffmpegArgs'
import { commitStaged, hex8, removeQuietly, stagePath, writeQuietly } from './stage'

type Kind = 'video' | 'audio'

interface Placeholder {
  name: string
  type: Kind
  folderId?: string
  status: 'generating' | 'rendering'
}

export interface ExtrasDeps {
  app: Pick<AppContext, 'media' | 'exporter'>
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `isMediaOffline`: the asset's file can't be resolved or doesn't exist. */
export function offlineCheck(session: ProjectSession): (id: string) => boolean {
  return (id) => {
    const p = session.resolveMedia(id)
    return !p || !existsSync(p)
  }
}

function displayName(session: ProjectSession, ref: string): string {
  return session.doc.manifest.entries.find((e) => e.id === ref)?.name ?? session.doc.file.timelines.find((t) => t.id === ref)?.name ?? ref
}

/** Runs one placeholder job to completion (or failure). Resolves with the asset id, or null when nothing was added. */
async function runJob(deps: ExtrasDeps, session: ProjectSession, ph: Placeholder, produce: (staged: string) => Promise<void>): Promise<string | null> {
  if (session.closed) return null
  const ext = ph.type === 'video' ? 'mp4' : 'm4a'
  const filename = `clip-${hex8()}.${ext}`
  const entry: MediaManifestEntry = {
    id: newId(),
    name: ph.name,
    type: ph.type,
    source: { project: { relativePath: `media/${filename}` } },
    duration: 0,
    hasAudio: ph.type === 'audio',
    generationStatus: ph.status,
  }
  if (ph.folderId) entry.folderId = ph.folderId
  if (!writeQuietly(session, (d) => addMediaEntries(d, [entry]))) return null
  const staged = stagePath(ext)
  const present = () => !session.closed && session.doc.manifest.entries.some((e) => e.id === entry.id)
  try {
    await produce(staged)
    if (!present()) return null
    const dest = await commitStaged(session, staged, filename)
    const p = await deps.app.media.probe(dest)
    const patch: Partial<MediaManifestEntry> = {
      source: sourceForPath(dest, session.path),
      duration: p.duration,
      hasAudio: ph.type === 'audio' ? true : p.hasAudio,
      sourceWidth: ph.type === 'video' ? p.width : undefined,
      sourceHeight: ph.type === 'video' ? p.height : undefined,
      sourceFPS: ph.type === 'video' ? p.fps : undefined,
      generationStatus: undefined,
    }
    writeQuietly(session, (d) => {
      if (d.manifest.entries.some((e) => e.id === entry.id)) updateMediaEntry(d, entry.id, patch)
    })
    return entry.id
  } catch (e) {
    if (present()) writeQuietly(session, (d) => updateMediaEntry(d, entry.id, { generationStatus: failedStatus(errorText(e)) }))
    return null
  } finally {
    await removeQuietly(staged)
  }
}

interface AudioInfo {
  hasVideo: boolean
  hasAudio: boolean
  sampleRate?: number
  audioCodec?: string
}

async function streams(file: string): Promise<AudioInfo> {
  const info = await ffprobeJson(file)
  const video = info.streams.find((s) => s.codec_type === 'video' && !(s as { disposition?: { attached_pic?: number } }).disposition?.attached_pic)
  const audio = info.streams.find((s) => s.codec_type === 'audio') as { codec_name?: string; sample_rate?: string } | undefined
  const sr = Number(audio?.sample_rate)
  return { hasVideo: !!video, hasAudio: !!audio, sampleRate: Number.isFinite(sr) && sr > 0 ? sr : undefined, audioCodec: audio?.codec_name }
}

/** `exportClipRange`: the clip's visible source range (trim + speed baked in) as mp4 (video) or m4a (audio). */
async function exportClipRange(source: string, staged: string, clip: { trimStartFrame: number; consumed: number; durationFrames: number; speed: number }, fps: number, mediaType: Kind): Promise<void> {
  const s = await streams(source)
  if (mediaType === 'video' ? !s.hasVideo : !s.hasAudio) throw new Error(`no ${mediaType} track in source`)
  await ffmpeg(
    clipRangeArgs({
      source,
      output: staged,
      fps,
      trimStartFrame: clip.trimStartFrame,
      sourceFramesConsumed: clip.consumed,
      durationFrames: clip.durationFrames,
      speed: clip.speed,
      mediaType,
      sampleRate: s.sampleRate,
      hasAudio: s.hasAudio,
    }),
  )
}

function findClip(session: ProjectSession, clipId: string) {
  for (const tr of activeTimeline(session.doc).tracks) {
    const c = tr.clips.find((x) => x.id === clipId)
    if (c) return c
  }
  return null
}

/** Clip ▸ Save as Media. Returns the job's promise (the placeholder is inserted synchronously before it awaits). */
export function saveClipAsMedia(deps: ExtrasDeps, session: ProjectSession, clipId: string): Promise<string | null> {
  const clip = findClip(session, clipId)
  if (!clip || !canSaveClipAsMedia(clip)) return Promise.resolve(null)
  const source = session.resolveMedia(clip.mediaRef)
  if (!source) return Promise.resolve(null)
  const t = activeTimeline(session.doc)
  const range = { trimStartFrame: clip.trimStartFrame, consumed: sourceFramesConsumed(clip), durationFrames: clip.durationFrames, speed: clip.speed }
  const type = clip.mediaType as Kind
  return runJob(deps, session, { name: `${displayName(session, clip.mediaRef)} (clip)`, type, status: 'generating' }, (staged) => exportClipRange(source, staged, range, t.fps, type))
}

/** Clip ▸ Save as Audio (`extractAudio(fromClipId:)`): placed in the source asset's folder. */
export function saveClipAsAudio(deps: ExtrasDeps, session: ProjectSession, clipId: string): Promise<string | null> {
  const t = activeTimeline(session.doc)
  const clip = audioClipForExtraction(t, session.doc.manifest.entries, clipId, offlineCheck(session))
  if (!clip) return Promise.resolve(null)
  const source = session.resolveMedia(clip.mediaRef)
  if (!source) return Promise.resolve(null)
  const folderId = session.doc.manifest.entries.find((e) => e.id === clip.mediaRef)?.folderId
  const range = { trimStartFrame: clip.trimStartFrame, consumed: sourceFramesConsumed(clip), durationFrames: clip.durationFrames, speed: clip.speed }
  return runJob(deps, session, { name: `${displayName(session, clip.mediaRef)} (audio)`, type: 'audio', folderId, status: 'generating' }, (staged) =>
    exportClipRange(source, staged, range, t.fps, 'audio'),
  )
}

/** Media ▸ Extract Audio: each eligible asset in turn, next to the asset (same folder). */
export async function extractAudio(deps: ExtrasDeps, session: ProjectSession, assetIds: string[]): Promise<string[]> {
  const done: string[] = []
  for (const id of assetIds) {
    const asset = session.doc.manifest.entries.find((e) => e.id === id)
    if (!asset || !canExtractAudio(asset, offlineCheck(session))) continue
    const source = session.resolveMedia(asset)
    if (!source) continue
    const out = await runJob(deps, session, { name: `${asset.name} (audio)`, type: 'audio', folderId: asset.folderId, status: 'generating' }, async (staged) => {
      const s = await streams(source)
      if (!s.hasAudio) throw new Error('no audio track in source')
      await ffmpeg(extractAudioArgs(source, staged, s.audioCodec))
    })
    if (out) done.push(out)
  }
  return done
}

/** Timeline range ▸ Save Range as Media: the full composite of `[start, end)` at canvas size, H.264 CRF 18. */
export function saveRangeAsMedia(deps: ExtrasDeps, session: ProjectSession, range: { start: number; end: number }): Promise<string | null> {
  const t = activeTimeline(session.doc)
  const start = Math.max(0, Math.trunc(Math.min(range.start, range.end)))
  const end = Math.min(totalFrames(t), Math.trunc(Math.max(range.start, range.end)))
  if (!(end - start > 0)) return Promise.resolve(null)
  const type: ClipType = 'video'
  return runJob(deps, session, { name: 'Timeline range', type, status: 'rendering' }, async (staged) => {
    const job = deps.app.exporter.start(session, { timelineId: t.id, format: 'mp4', codec: 'h264', quality: 'high', range: { start, end }, includeAudio: true, outputPath: staged })
    const done = await deps.app.exporter.wait(job.id)
    if (done.status !== 'completed') throw new Error(done.error ?? `Export ${done.status}.`)
  })
}
