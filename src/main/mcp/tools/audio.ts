/**
 * Audio-analysis agent tools (02 §3.28 sync_clips, §3.29 manage_multicam create, §3.35 remove_silence,
 * §3.36 detect_beats, §3.43 denoise_audio) over `env.app.audio` / `env.app.denoise` (spec 07 §3, §5).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { estimateBPM } from '../../../core/audio/beats'
import { applyClipSync, planClipSync, type SyncMode } from '../../../core/audio/clipSync'
import { removeAllDeadAir, removeDeadAirInClips, validSilenceSettings, type QuietMasks, type SilenceSettings } from '../../../core/audio/deadAir'
import { DEFAULT_DENOISE_AMOUNT, setDenoise } from '../../../core/audio/denoise'
import { createMulticamGroup, SYNC_DEFAULTS, syncMulticamMembers, type MemberKind, type MemberSpec } from '../../../core/audio/multicam'
import { activeTimeline, type Doc } from '../../../core/ops/context'
import { EditRefusal, findClip } from '../../../core/timeline'
import { correlateOffThread } from '../../ml/audio/correlate'
import type { AudioAnalysisService } from '../../ml/audio/service'
import { ToolError, isObj, lenient, validateUnknownKeys, type Obj } from './args'
import { mutate, okRawJson, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'

function audioService(env: ToolEnv, tool: string): AudioAnalysisService {
  const a = env.app.audio
  if (!a) throw new ToolError(`${tool} isn't available: the audio analysis service isn't running.`)
  return a
}

const resolver = (env: ToolEnv) => (ref: string) => {
  const f = env.session.resolveMedia(ref)
  return f && existsSync(f) ? f : null
}

// ---------- remove_silence ----------

/** Every mediaRef whose quiet mask can matter for `doc` (audio clips + multicam mics). */
function maskRefs(doc: Doc): string[] {
  const refs = new Set<string>()
  for (const tr of activeTimeline(doc).tracks) for (const c of tr.clips) if (c.mediaType === 'audio') refs.add(c.mediaRef)
  for (const g of doc.file.multicamGroups ?? []) for (const m of g.members) if (m.kind !== 'angle') refs.add(m.mediaRef)
  return [...refs]
}

export async function removeSilence(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['clipIds', 'minimumPauseSeconds', 'speechPaddingSeconds'], 'remove_silence')
  const audio = env.app.audio
  const base: SilenceSettings = audio ? audio.silenceSettings(env.session.path) : { minimumPause: 0.5, speechPadding: 0.15 }
  const num = (key: string, lo: number, hi: number, fallback: number) => {
    if (args[key] === undefined) return fallback
    const v = args[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new ToolError(`remove_silence: ${key} must be a finite number from ${lo} through ${hi}.`)
    return v
  }
  const minimumPause = num('minimumPauseSeconds', 0.25, 3, base.minimumPause)
  const speechPadding = num('speechPaddingSeconds', 0, 0.5, base.speechPadding)
  const settings = validSilenceSettings(minimumPause, speechPadding)
  if (!settings) throw new ToolError('remove_silence: invalid silence-removal settings.')
  let clipIds: string[] | undefined
  if (args.clipIds !== undefined) {
    if (!Array.isArray(args.clipIds) || !args.clipIds.length) throw new ToolError('remove_silence: clipIds must be a non-empty array of clip IDs.')
    args.clipIds.forEach((v, i) => {
      if (typeof v !== 'string' || !v.trim()) throw new ToolError(`remove_silence: clipIds[${i}] must be a non-empty string.`)
    })
    clipIds = [...new Set(args.clipIds as string[])]
    const t = activeTimeline(env.session.doc)
    for (const id of clipIds) if (!findClip(t, id)) throw new ToolError(`Clip not found: ${id}`)
  }
  const masks: QuietMasks = audio ? await audio.quietMasks(maskRefs(env.session.doc), resolver(env)) : {}
  const where = clipIds ? 'in the selected clips' : 'on the timeline'
  const before = snapshot(env.session.doc)
  let outcome: { sections: number; removedFrames: number; refusal?: string } | null = null
  const tx = env.session.transact('Remove Silence (Agent)', (d) => {
    try {
      outcome = clipIds ? removeDeadAirInClips(d, clipIds, masks, settings) : removeAllDeadAir(d, masks, settings)
    } catch (e) {
      if (!(e instanceof EditRefusal)) throw e
      if (/^No dead air/.test(e.message)) throw new EditRefusal(`No dead air ${where}. Speech analysis may still be running, or the audio has no quiet non-speech sections.`)
      if (/^Selected/.test(e.message)) throw new EditRefusal(`remove_silence: ${e.message}`)
      throw new EditRefusal(`Ripple delete refused: ${e.message}`)
    }
  })
  if (!tx.ok) throw new ToolError(tx.error)
  const o = outcome as unknown as { sections: number; removedFrames: number; refusal?: string }
  return mutationResult(env.session.doc, before, {
    extra: { sectionsRemoved: o.sections, removedFrames: o.removedFrames, minimumPauseSeconds: minimumPause, speechPaddingSeconds: speechPadding, ...(clipIds ? { clipIds } : {}) },
    ...(o.refusal ? { notes: [`A later track refused: ${o.refusal}. Earlier tracks were already edited.`] } : {}),
  })
}

// ---------- detect_beats ----------

const r2 = (v: number) => Math.round(v * 100) / 100

export async function detectBeats(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['endSeconds', 'mediaRef', 'startSeconds'], 'detect_beats')
  const mediaRef = lenient.requireString(args, 'mediaRef')
  const entry = env.session.doc.manifest.entries.find((e) => e.id === mediaRef)
  if (!entry) throw new ToolError(`Media asset not found: ${mediaRef}`)
  if (!(entry.type === 'audio' || (entry.type === 'video' && entry.hasAudio))) throw new ToolError(`detect_beats needs audio: ${mediaRef} is ${entry.type}${entry.type === 'video' ? ' with no audio track' : ''}.`)
  const file = env.session.resolveMedia(entry)
  if (!file || !existsSync(file)) throw new ToolError(`Media file not on disk: ${path.basename(file ?? entry.name)}`)
  const startArg = lenient.double(args, 'startSeconds')
  const endArg = lenient.double(args, 'endSeconds')
  const windowed = startArg !== undefined || endArg !== undefined
  const s = Math.max(startArg ?? 0, 0)
  const e = Math.min(endArg ?? entry.duration, entry.duration)
  if (windowed && !(s < e)) throw new ToolError(`Invalid time range [${s}, ${e}] for media of duration ${entry.duration}s`)
  const a = await audioService(env, 'detect_beats').beats(mediaRef, file)
  if (!a.beats.length && !a.downbeats.length) return okRawJson({ beats: [], note: 'No beats found — the audio may lack rhythmic content.' })
  const inWin = (t: number) => !windowed || (t >= s && t <= e)
  const beats = a.beats.filter(inWin)
  const downbeats = a.downbeats.filter(inWin)
  if (!beats.length && !downbeats.length) return okRawJson({ beats: [], note: 'No beats in the requested window; the track has beats elsewhere — widen or drop startSeconds/endSeconds.' })
  const bpm = windowed ? estimateBPM(beats) : a.bpm
  return okRawJson({
    mediaRef,
    units: 'source seconds — multiply by fps for frame values',
    beats: beats.map(r2),
    ...(downbeats.length ? { downbeats: downbeats.map(r2) } : {}),
    ...(bpm > 0 ? { bpm: Math.round(bpm * 10) / 10 } : {}),
  })
}

// ---------- sync_clips ----------

export async function syncClips(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['minConfidence', 'mode', 'referenceClipId', 'searchWindowSeconds', 'targetClipId', 'targetClipIds'], 'sync_clips')
  const referenceClipId = lenient.requireString(args, 'referenceClipId')
  const targets = [...lenient.stringArray(args, 'targetClipIds'), ...(lenient.string(args, 'targetClipId') ? [lenient.string(args, 'targetClipId')!] : [])]
  if (!targets.length) throw new ToolError('sync_clips: provide targetClipId or targetClipIds.')
  const t = activeTimeline(env.session.doc)
  if ([referenceClipId, ...targets].some((id) => findClip(t, id)?.clip.multicamGroupId)) throw new ToolError("sync_clips: multicam clips are already aligned by their group's sync maps — re-syncing would move them out of the group.")
  const mode = (args.mode ?? 'auto') as SyncMode
  if (!['auto', 'audio', 'timecode'].includes(mode)) throw new ToolError('sync_clips: mode must be auto, audio, or timecode.')
  let searchWindowSeconds: number | null = null
  if (args.searchWindowSeconds !== undefined) {
    const v = lenient.double(args, 'searchWindowSeconds')
    if (v === undefined || !Number.isFinite(v) || !(v > 0)) throw new ToolError('sync_clips: searchWindowSeconds must be finite and > 0.')
    searchWindowSeconds = v
  }
  const minConfidence = lenient.double(args, 'minConfidence') ?? SYNC_DEFAULTS.minConfidence
  const audio = audioService(env, 'sync_clips')
  const resolve = resolver(env)
  const plan = await planClipSync(
    env.session.doc,
    { referenceClipId, targetClipIds: targets, mode, searchWindowSeconds, minConfidence },
    {
      timing: (refs) => audio.timing(Object.fromEntries(refs.map((r) => [r, resolve(r)]))),
      envelope: async (ref, start, end) => {
        const f = resolve(ref)
        return f ? audio.envelope(f, start, end) : null
      },
      correlate: (a) => correlateOffThread(a),
    },
  )
  const r = plan.report
  if (!r.synced.length) throw new ToolError(`sync_clips: ${r.failures[0]?.message ?? 'no clips aligned'}`)
  const before = snapshot(env.session.doc)
  if (plan.moves.length || plan.retimes.length) mutate(env, 'Synchronize Clips (Agent)', (d) => applyClipSync(d, plan))
  return mutationResult(env.session.doc, before, {
    touched: r.synced.map((s) => s.clipId),
    extra: {
      referenceClipId,
      synced: r.synced.map((s) => ({ clipId: s.clipId, offsetFrames: s.offsetFrames, confidence: Math.round(s.confidence * 1000) / 1000, method: s.method })),
      ...(r.shiftedFrames ? { shiftedFrames: r.shiftedFrames } : {}),
      ...(r.retimed.length ? { driftCorrected: r.retimed.map((x) => ({ clipId: x.clipId, driftPpm: Math.round(x.driftPpm * 10) / 10 })) } : {}),
      ...(r.retimeSkipped.length ? { driftCorrectionSkipped: r.retimeSkipped.map((x) => ({ clipId: x.clipId, reason: x.message })) } : {}),
      ...(r.failures.length ? { failed: r.failures.map((f) => ({ clipId: f.clipId, reason: f.message })) } : {}),
    },
  })
}

// ---------- manage_multicam create ----------

export async function createMulticam(env: ToolEnv, create: Obj): Promise<ToolResult> {
  validateUnknownKeys(create, ['master', 'members', 'name', 'searchWindowSeconds', 'startFrame'], 'manage_multicam.create')
  const raw = create.members
  if (!Array.isArray(raw) || raw.length < 2) throw new ToolError('create.members requires at least two entries (cameras and mics).')
  const doc = env.session.doc
  const specs: MemberSpec[] = []
  const seen = new Set<string>()
  raw.forEach((m, i) => {
    const p = `create.members[${i}]`
    if (!isObj(m)) throw new ToolError(`${p} must be an object.`)
    validateUnknownKeys(m, ['angleLabel', 'kind', 'mediaRef', 'offsetSeconds'], p)
    const ref = lenient.string(m, 'mediaRef')
    if (!ref) throw new ToolError(`${p}: mediaRef is required.`)
    const entry = doc.manifest.entries.find((e) => e.id === ref)
    if (!entry) throw new ToolError(`${p}: media asset not found: ${ref}`)
    if (seen.has(ref)) throw new ToolError(`${p}: duplicate mediaRef ${ref}`)
    seen.add(ref)
    const kind = m.kind as MemberKind
    if (!['angle', 'mic', 'both'].includes(kind)) throw new ToolError(`${p}: kind must be angle, mic, or both.`)
    const hasAudio = entry.type === 'audio' || (entry.type === 'video' && !!entry.hasAudio)
    if (kind === 'angle' && entry.type !== 'video') throw new ToolError(`${p}: an angle member must be a video.`)
    if (kind === 'mic' && !hasAudio) throw new ToolError(`${p}: a mic member needs audio.`)
    if (kind === 'both' && !(entry.type === 'video' && entry.hasAudio)) throw new ToolError(`${p}: a both member must be a video with audio.`)
    const offset = m.offsetSeconds === undefined ? undefined : lenient.double(m, 'offsetSeconds')
    if (m.offsetSeconds !== undefined && (offset === undefined || !Number.isFinite(offset))) throw new ToolError(`${p}: offsetSeconds must be a finite number.`)
    specs.push({ mediaRef: ref, kind, ...(lenient.string(m, 'angleLabel') ? { angleLabel: lenient.string(m, 'angleLabel') } : {}), ...(offset !== undefined ? { pinnedOffsetSeconds: offset } : {}) })
  })
  let master: MemberSpec | undefined
  const masterArg = lenient.string(create, 'master')
  if (masterArg) {
    master = specs.find((s) => s.angleLabel?.toLowerCase() === masterArg.toLowerCase() || s.mediaRef === masterArg)
    if (!master) throw new ToolError(`master '${masterArg}' doesn't match a member's angleLabel or mediaRef.`)
    if (master.kind === 'angle') throw new ToolError(`master '${masterArg}' is an angle — its audio is scratch. Pick a mic/both member.`)
  } else {
    master = specs.find((s) => s.kind === 'mic') ?? specs.find((s) => s.kind === 'both') ?? specs[0]
    if (master.kind === 'angle') throw new ToolError('No mic member to sync against — mark one member as mic/both, or pin offsets explicitly.')
  }
  let window: number = SYNC_DEFAULTS.memberSearchWindowSeconds
  if (create.searchWindowSeconds !== undefined) {
    const v = lenient.double(create, 'searchWindowSeconds')
    if (v === undefined || !Number.isFinite(v) || !(v > 0)) throw new ToolError('create.searchWindowSeconds must be finite and > 0.')
    window = v
  }
  const startFrame = create.startFrame === undefined ? undefined : lenient.int(create, 'startFrame')
  if (create.startFrame !== undefined && (startFrame === undefined || startFrame < 0)) throw new ToolError('create.startFrame must be a non-negative integer.')
  const needsAudio = specs.some((s) => s.pinnedOffsetSeconds === undefined && s.mediaRef !== master!.mediaRef)
  const audio = needsAudio ? audioService(env, 'manage_multicam create') : env.app.audio
  const resolve = resolver(env)
  const sync = await syncMulticamMembers(
    specs,
    master.mediaRef,
    {
      timing: async (refs) => (audio ? audio.timing(Object.fromEntries(refs.map((r) => [r, resolve(r)]))) : {}),
      envelope: async (ref, seconds) => {
        const f = resolve(ref)
        return f && audio ? audio.envelope(f, 0, seconds) : null
      },
      correlate: (a) => correlateOffThread(a),
    },
    window,
  )
  const before = snapshot(env.session.doc)
  const created = mutate(env, 'Create Multicam (Agent)', (d) => structuredClone(createMulticamGroup(d, specs, sync.maps, master!.mediaRef, lenient.string(create, 'name'), startFrame)))
  const masterMember = created.members.find((m) => m.mediaRef === master!.mediaRef)
  const rows = created.members.map((m) => ({
    angleLabel: m.angleLabel,
    kind: m.kind,
    mediaRef: m.mediaRef,
    offsetSeconds: Math.round(m.sync.offsetSeconds * 1000) / 1000,
    confidence: m.sync.confidence,
    ...(m === masterMember ? { master: true } : {}),
    ...(m.sync.locked ? { pinned: true } : {}),
    ...(!(m.sync.confidence > 0 || m.sync.locked) ? { unsynced: true } : {}),
  }))
  return mutationResult(env.session.doc, before, {
    touched: created.clipIds,
    extra: {
      created: {
        groupId: created.groupId,
        members: rows,
        clipIds: created.clipIds,
        ...(sync.failures.length ? { needsAttention: sync.failures.map(([mediaRef, reason]) => ({ mediaRef, reason })) } : {}),
      },
    },
  })
}

// ---------- denoise_audio ----------

export async function denoiseAudio(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['clipIds', 'enabled', 'strength'], 'denoise_audio')
  if (!Array.isArray(args.clipIds) || !args.clipIds.every((x) => typeof x === 'string')) throw new ToolError('denoise_audio: clipIds must be an array of strings.')
  const clipIds = args.clipIds as string[]
  if (!clipIds.length) throw new ToolError('clipIds is empty.')
  if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new ToolError('denoise_audio: enabled must be a boolean.')
  if (args.strength !== undefined && typeof args.strength !== 'number') throw new ToolError('denoise_audio: strength must be a number.')
  const enabled = args.enabled !== false
  const strength = (args.strength as number | undefined) ?? DEFAULT_DENOISE_AMOUNT
  if (!(strength >= 0 && strength <= 1)) throw new ToolError(`strength must be 0–1 (got ${strength})`)
  const before = snapshot(env.session.doc)
  mutate(env, enabled ? 'Denoise Audio (Agent)' : 'Disable Denoise (Agent)', (d) => setDenoise(d, clipIds, enabled, strength))
  if (enabled && env.app.denoise) {
    const t = activeTimeline(env.session.doc)
    const resolve = resolver(env)
    for (const id of clipIds) {
      const ref = findClip(t, id)?.clip.mediaRef
      if (!ref) continue
      env.app.denoise.clearFailure(ref)
    }
    env.app.denoise.schedule(env.session.doc, resolve)
  }
  return mutationResult(env.session.doc, before, { touched: clipIds, ...(enabled ? { notes: ['Denoise bakes in the background; the preview picks it up automatically when it finishes.'] } : {}) })
}
