/**
 * Interchange export (XMEML "XML" for Premiere/Resolve, FCPXML for Resolve/Final Cut): snapshots the document,
 * resolves media paths, source timecodes and title fonts, renders with the pure core exporters and installs the file
 * atomically (temp file beside the destination + rename), like the Mac's staged output.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_FCPXML_TARGET,
  DEFAULT_FCPXML_VERSION,
  exportFCPXML,
  exportXMEML,
  interchangeMediaClips,
  interchangeTimelines,
  type FCPXMLTarget,
  type FCPXMLVersion,
  type FontInfoResolver,
  type InterchangeInput,
} from '../../core/interchange'
import { defaultTextStyle, type MediaManifest, type ProjectFile } from '../../core/model'
import { readSourceTimecodes, type ProbeRunner } from '../media/sourceTimecode'
import { fcMatch, fontInfoResolver, type FcMatchRunner } from './fontInfo'

export type InterchangeFormat = 'xml' | 'fcpxml'

export interface InterchangeExportRequest {
  timelineId: string
  format: InterchangeFormat
  outputPath: string
  fcpxmlVersion?: FCPXMLVersion
  fcpxmlTarget?: FCPXMLTarget
  signal?: AbortSignal
}

/** The slice of `ProjectSession` the export reads. */
export interface InterchangeSession {
  readonly doc: { file: ProjectFile; manifest: MediaManifest }
  resolveMedia(entryOrId: string): string | null
}

export interface InterchangeDeps {
  probe?: ProbeRunner
  fcMatch?: FcMatchRunner
}

export interface InterchangeResult {
  outputPath: string
  bytes: number
  /** Media refs whose files were missing; their clips are left out of the document. */
  missingMediaRefs: string[]
}

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  )

export async function exportInterchange(session: InterchangeSession, request: InterchangeExportRequest, deps: InterchangeDeps = {}): Promise<InterchangeResult> {
  const { signal } = request
  signal?.throwIfAborted()
  if (request.format !== 'xml' && request.format !== 'fcpxml') throw new Error(`Unsupported interchange format: ${String(request.format)}`)
  const { file, manifest } = session.doc
  const timeline = file.timelines.find((t) => t.id === request.timelineId)
  if (!timeline) throw new Error('The timeline to export no longer exists.')
  const timelines = file.timelines

  const clips = interchangeMediaClips(timeline, timelines)
  const refs = [...new Set(clips.map((c) => c.mediaRef))].filter((ref) => manifest.entries.some((e) => e.id === ref))
  const mediaPaths: Record<string, string> = {}
  const canonicalPaths: Record<string, string> = {}
  const missingMediaRefs: string[] = []
  await Promise.all(
    refs.map(async (ref) => {
      const p = session.resolveMedia(ref)
      if (!p || !(await exists(p))) {
        missingMediaRefs.push(ref)
        return
      }
      mediaPaths[ref] = p
      canonicalPaths[p] = await fs.realpath(p).catch(() => path.resolve(p))
    }),
  )
  signal?.throwIfAborted()

  // Only audio/video files carry timecode; skipping stills, Lottie and subtitles avoids pointless ffprobe runs.
  const avPaths = Object.fromEntries(Object.entries(mediaPaths).filter(([ref]) => /^(video|audio)$/.test(manifest.entries.find((e) => e.id === ref)?.type ?? '')))
  const timecodes = await readSourceTimecodes(avPaths, { probe: deps.probe, signal })
  const input: InterchangeInput = { timeline, timelines, manifest, mediaPaths, canonicalPaths, timecodes }

  let xml: string
  if (request.format === 'xml') {
    xml = exportXMEML(input)
  } else {
    const titles = interchangeTimelines(timeline, timelines).flatMap((t) => t.tracks.flatMap((tr) => tr.clips.filter((c) => c.mediaType === 'text' && c.textContent)))
    const fontInfo: FontInfoResolver = await fontInfoResolver(
      titles.map((c) => c.textStyle ?? defaultTextStyle()),
      deps.fcMatch ?? fcMatch,
    )
    xml = exportFCPXML(input, { version: request.fcpxmlVersion ?? DEFAULT_FCPXML_VERSION, target: request.fcpxmlTarget ?? DEFAULT_FCPXML_TARGET, fontInfo })
  }
  signal?.throwIfAborted()

  const data = Buffer.from(xml, 'utf8')
  await writeAtomically(request.outputPath, data, signal)
  return { outputPath: request.outputPath, bytes: data.length, missingMediaRefs: missingMediaRefs.sort() }
}

/** Stages the complete file beside the destination, then renames it into place; never leaves a partial file. */
export async function writeAtomically(destination: string, data: Buffer, signal?: AbortSignal): Promise<void> {
  const dir = path.dirname(destination)
  const temp = path.join(dir, `.${path.basename(destination)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temp, data, { flag: 'wx' })
    signal?.throwIfAborted()
    await fs.rename(temp, destination)
  } catch (e) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw e
  }
}
