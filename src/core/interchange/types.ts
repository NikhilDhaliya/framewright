import type { MediaManifest, MediaManifestEntry, TextStyle, Timeline } from '../model'
import type { SourceTimecode } from './timecode'

/** The `version` attribute Resolve/FCP gate import on; the body is identical for every version. */
export type FCPXMLVersion = '1.10' | '1.11' | '1.12' | '1.13' | '1.14'
export const FCPXML_VERSIONS: readonly FCPXMLVersion[] = ['1.10', '1.11', '1.12', '1.13', '1.14']
export const DEFAULT_FCPXML_VERSION: FCPXMLVersion = '1.10'
export const FCPXML_VERSION_NOTES: Readonly<Record<FCPXMLVersion, string>> = {
  '1.10': 'DaVinci Resolve 18+, Final Cut Pro 10.6+',
  '1.11': 'DaVinci Resolve 21+, Final Cut Pro 10.7+',
  '1.12': 'DaVinci Resolve 21+, Final Cut Pro 10.8+',
  '1.13': 'DaVinci Resolve 21+, Final Cut Pro 11+',
  '1.14': 'DaVinci Resolve 21+, Final Cut Pro 12+',
}

/** Resolve reads trim-rect units and positions off-spec; Final Cut is spec-literal. */
export type FCPXMLTarget = 'resolve' | 'fcp'
export const FCPXML_TARGETS: readonly FCPXMLTarget[] = ['resolve', 'fcp']
export const DEFAULT_FCPXML_TARGET: FCPXMLTarget = 'resolve'
export const FCPXML_TARGET_NAMES: Readonly<Record<FCPXMLTarget, string>> = { resolve: 'DaVinci Resolve', fcp: 'Final Cut Pro' }

/** A resolved font's family/face and the traits it actually has (Mac `resolvedFont` + symbolic traits). */
export interface FontInfo {
  family: string
  face: string
  bold: boolean
  italic: boolean
}

export type FontInfoResolver = (style: Pick<TextStyle, 'fontName' | 'isBold' | 'isItalic'>) => FontInfo | undefined

/** Everything an interchange exporter reads; the exporters themselves never touch the file system. */
export interface InterchangeInput {
  timeline: Timeline
  /** Every timeline of the project, for nested-timeline (carrier) resolution. */
  timelines?: readonly Timeline[]
  manifest: MediaManifest | { entries: readonly MediaManifestEntry[] }
  /** mediaRef → absolute path, only for media whose file exists (Mac `MediaResolver.resolveURL`). */
  mediaPaths: Readonly<Record<string, string>>
  /** Absolute path → canonical (symlink-resolved) path; FCPXML merges assets by it. Defaults to the path. */
  canonicalPaths?: Readonly<Record<string, string>>
  /** mediaRef → embedded start timecode. */
  timecodes?: Readonly<Record<string, SourceTimecode>>
}

export interface FCPXMLOptions {
  version?: FCPXMLVersion
  target?: FCPXMLTarget
  fontInfo?: FontInfoResolver
}

/** Shared lookups over an `InterchangeInput` (Mac `MediaResolver`). */
export interface MediaLookup {
  entry(ref: string): MediaManifestEntry | undefined
  path(ref: string): string | undefined
  timeline(id: string): Timeline | undefined
}

export function mediaLookup(input: InterchangeInput): MediaLookup {
  const entries = new Map<string, MediaManifestEntry>()
  for (const e of input.manifest.entries) if (!entries.has(e.id)) entries.set(e.id, e)
  const timelines = new Map<string, Timeline>()
  for (const t of input.timelines ?? []) timelines.set(t.id, t)
  timelines.set(input.timeline.id, input.timeline)
  return {
    entry: (ref) => entries.get(ref),
    path: (ref) => (entries.has(ref) ? input.mediaPaths[ref] : undefined),
    timeline: (id) => timelines.get(id),
  }
}
