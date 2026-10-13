/**
 * search_media (spec 02 §3.11). Spoken: `TranscriptSearch` over cached LOCAL full-file transcripts of video/audio
 * assets in library order (spec 07 §1.12). Visual: SigLIP "Moments" through the smart search service (spec 07 §2,
 * Mac `ToolExecutor+Search.swift`); contexts without the ML stack report the visual index as `failed`.
 */
import { searchTranscripts } from '../../../core/captions/transcriptSearch'
import type { MediaManifestEntry } from '../../../core/model'
import { activeTimeline } from '../../../core/ops/context'
import { ToolError, lenient, validateUnknownKeys, type Obj } from './args'
import { okJson, type ToolEnv, type ToolResult } from './context'

export const VISUAL_SEARCH_UNAVAILABLE = "Visual search isn't available on Linux yet."

export async function searchMedia(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['query', 'scope', 'mediaRef', 'limit'], 'search_media')
  const query = lenient.requireString(args, 'query').trim()
  if (!query) throw new ToolError('search_media: query is empty')
  const scope = lenient.string(args, 'scope') ?? 'both'
  if (!['visual', 'spoken', 'both'].includes(scope)) throw new ToolError(`search_media: scope must be visual, spoken, or both (got '${scope}')`)
  const limit = Math.min(Math.max(lenient.int(args, 'limit') ?? 10, 1), 50)
  const doc = env.session.doc
  let restrict: string | null = null
  const ref = lenient.string(args, 'mediaRef')
  if (ref) {
    if (!doc.manifest.entries.some((e) => e.id === ref)) throw new ToolError(`Media asset not found: ${ref}`)
    restrict = ref
  }
  const inScope = (id: string) => restrict === null || restrict === id
  const payload: Obj = { timelineFps: activeTimeline(doc).fps }
  if (scope !== 'spoken') {
    const indexable = doc.manifest.entries.filter((e) => (e.type === 'video' || e.type === 'image') && inScope(e.id))
    if (env.app.search) Object.assign(payload, await visualResults(env, query, limit, restrict, indexable))
    else {
      payload.moments = []
      if (indexable.length) payload.index = { status: 'failed', indexableAssets: indexable.length, indexedAssets: 0, modelDownloadError: VISUAL_SEARCH_UNAVAILABLE }
    }
  }
  if (scope !== 'visual') {
    const stt = env.app.transcription
    const candidates = doc.manifest.entries.filter((e) => (e.type === 'video' || e.type === 'audio') && inScope(e.id))
    const assets = await Promise.all(
      candidates.map(async (e) => {
        const file = env.session.resolveMedia(e)
        return { id: e.id, transcript: file && stt ? await stt.cachedTranscript(file).catch(() => null) : null }
      }),
    )
    const names = new Map(doc.manifest.entries.map((e) => [e.id, e.name]))
    payload.spoken = searchTranscripts(query, assets, limit).map((h) => ({ mediaRef: h.assetId, name: names.get(h.assetId) ?? '', startSeconds: h.start, endSeconds: h.end, text: h.text }))
  }
  return okJson(payload)
}

/** Index health rides along only while it can explain missing results. */
async function visualResults(env: ToolEnv, query: string, limit: number, restrict: string | null, indexable: MediaManifestEntry[]): Promise<Obj> {
  const search = env.app.search!
  const model = search.model
  const coordinator = search.coordinator(env.session)
  if (indexable.length && model.enabled && model.state.kind === 'unknown') await model.prepare()
  if (indexable.length && model.enabled && model.state.kind === 'notInstalled') void search.download()
  const status = search.statusName(env.session)
  const indexed = await coordinator.indexedCount(indexable.map((e) => e.id))
  const out: Obj = {}
  if (indexable.length && (status !== 'ready' || (indexed ?? indexable.length) < indexable.length)) {
    const info: Obj = { status, indexableAssets: indexable.length }
    if (indexed !== null) info.indexedAssets = indexed
    const st = model.state
    if (st.kind === 'downloading') info.modelDownloadProgress = st.fraction
    if (st.kind === 'failed') info.modelDownloadError = st.message
    out.index = info
  }
  const hits = await coordinator.search(query, limit, restrict === null ? null : new Set([restrict]))
  const entries = new Map(env.session.doc.manifest.entries.map((e) => [e.id, e]))
  out.moments = hits.map((h) => {
    const asset = entries.get(h.assetId)
    const m: Obj = { mediaRef: h.assetId, name: asset?.name ?? '', score: h.score }
    if (asset?.type === 'image') m.type = 'image'
    else {
      m.startSeconds = h.shotStart
      m.endSeconds = h.shotEnd
    }
    return m
  })
  return out
}
