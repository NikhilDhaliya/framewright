/**
 * FCPXML 1.10–1.14 for DaVinci Resolve / Final Cut Pro — a port of the Mac `Export/FCPXMLExporter.swift`
 * (spec 07 §6.2, 04 §11.8). Pure: media paths, canonical paths, timecodes, nested timelines and font names come in
 * through the input.
 *
 * `<fcpxml>` → `<resources>` (formats, assets, compound clips for one-sided use of A/V sources, one `<media>` per
 * nested timeline) → `<library><event><project><sequence><spine><gap>` with every clip connected on a lane.
 * Not transported: keyframed audio volume and audio fades, text background boxes, crop keyframes, title rotation,
 * colour/effects, edge softness/rounding, Lottie, subtitles, multicam structure.
 */
import { rawOpacityAt, rotationAt, sizeAt, sourceDurationFrames, textScaleAt, transformAt } from '../clip'
import { swiftRound } from '../keyframes'
import { defaultTextStyle, isVisualType, type Clip, type MediaManifestEntry, type RGBA, type TextStyle, type Timeline, type Transform } from '../model'
import { keyframeFrames, propertyTrack, type AnimatableProperty } from '../ops/properties'
import { secondsToFrame } from '../time'
import { reachableTimelineIds, totalFrames } from '../timeline'
import { fcpxmlMediaSrc, lastPathComponent } from './fileUrl'
import { fallbackFontFace, fallbackFontFamily } from './fonts'
import { formatFixed, pad2 } from './printf'
import { rationalSeconds } from './timecode'
import { DEFAULT_FCPXML_TARGET, DEFAULT_FCPXML_VERSION, mediaLookup, type FCPXMLOptions, type FCPXMLTarget, type InterchangeInput, type MediaLookup } from './types'
import { el, node, renderDocument, textEl, type XmlChild, type XmlNode } from './xml'

/** FCPXML `<event name>` (Mac: "Palmier Export"); product name, keep in step with src/shared/brand.ts APP_NAME. */
export const FCPXML_EVENT_NAME = 'Framewright Export'

/** Mac `NestFlattener.maxDepth`. */
export const NEST_MAX_DEPTH = 8

const SEQUENCE_FORMAT_ID = 'r1'
const TITLE_EFFECT_ID = 'titleBasic'
const TITLE_EFFECT_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti'
const COLOR_SPACE = '1-1-1 (Rec. 709)'

interface Rational {
  num: number
  den: number
}

interface EmittableClip {
  clip: Clip
  lane: number
  enabled: boolean
}

interface MediaResource {
  mediaRef: string
  assetId: string
  formatId?: string
  compoundId?: string
  entry: MediaManifestEntry
  path: string
  durationFrames: number
  hasVideo: boolean
  hasAudio: boolean
  startTimecode: Rational
}

interface Nest {
  mediaId: string
  timeline: Timeline
}

export function exportFCPXML(input: InterchangeInput, options: FCPXMLOptions = {}): string {
  return new FcpxmlBuilder(input, options).build()
}

// ---------- Number and time encodings ----------

/** Rounded to 4 places; integers print bare, otherwise trailing zeros are trimmed. */
export function fcpxmlNumber(value: number): string {
  const rounded = swiftRound(value * 10000) / 10000
  if (rounded === swiftRound(rounded)) return String(Math.trunc(rounded) + 0)
  let s = formatFixed(rounded, 4)
  while (s.endsWith('0')) s = s.slice(0, -1)
  if (s.endsWith('.')) s = s.slice(0, -1)
  return s
}

export function gcd(a: number, b: number): number {
  let x = a
  let y = b
  while (y !== 0) {
    const r = x % y
    x = y
    y = r
  }
  return Math.max(1, x)
}

/** `num/den` seconds, gcd-reduced: "0s", "Ns" or "N/Ds". */
export function rationalTime(num: number, den: number): string {
  if (num === 0) return '0s'
  const g = gcd(Math.abs(num), Math.abs(den))
  const n = Math.trunc(num / g)
  const d = Math.trunc(den / g)
  return d === 1 ? `${n}s` : `${n}/${d}s`
}

/** Best small fraction p/q (q ≤ 1000) for a user speed. */
export function rationalSpeed(speed: number): { p: number; q: number } {
  let best = { p: 1, q: 1 }
  let bestErr = Infinity
  for (let q = 1; q <= 1000; q++) {
    const p = swiftRound(speed * q)
    if (!(p > 0)) continue
    const err = Math.abs(speed - p / q)
    if (err < bestErr) {
      best = { p, q }
      bestErr = err
      if (err === 0) break
    }
  }
  return best
}

const isNtscLike = (rawFps: number, rounded: number) => Math.abs(rawFps - (rounded * 1000) / 1001) < Math.abs(rawFps - rounded)

/** `frameDuration`: `1001/(r·1000)s` for NTSC-like rates, else `1/r s`. */
export function frameDuration(rawFps: number): string {
  const rounded = Math.max(1, swiftRound(rawFps))
  return isNtscLike(rawFps, rounded) ? `1001/${rounded * 1000}s` : `1/${rounded}s`
}

/** Final Cut rate suffix: 29.97 → "2997", 23.976 → "2398", 25 → "25". */
export function formatRateSuffix(rawFps: number): string {
  const rounded = Math.max(1, swiftRound(rawFps))
  if (isNtscLike(rawFps, rounded)) {
    const fps100 = swiftRound(((rounded * 1000) / 1001) * 100)
    return `${Math.trunc(fps100 / 100)}${pad2(fps100 % 100)}`
  }
  return `${rounded}`
}

function recognizedVideoFormatName(width: number, height: number, rawFps: number): string | undefined {
  const rate = formatRateSuffix(rawFps)
  if (width === 1280 && height === 720) return `FFVideoFormat720p${rate}`
  if (width === 1920 && height === 1080) return `FFVideoFormat1080p${rate}`
  if (width === 3840 && height === 2160) return `FFVideoFormat3840x2160p${rate}`
  if (width === 4096 && height === 2160) return `FFVideoFormat4096x2160p${rate}`
  return undefined
}

export const videoFormatName = (width: number, height: number, rawFps: number): string =>
  recognizedVideoFormatName(width, height, rawFps) ?? `FFVideoFormat${width}x${height}p${formatRateSuffix(rawFps)}`

export const sequenceFormatName = (width: number, height: number, rawFps: number): string =>
  recognizedVideoFormatName(width, height, rawFps) ?? 'FFVideoFormatRateUndefined'

const keyframeInterpolation = (clip: Clip, property: AnimatableProperty, frame: number) =>
  propertyTrack(clip, property)?.keyframes.find((k) => k.frame === frame - clip.startFrame)?.interpolationOut

class FcpxmlBuilder {
  private readonly media: MediaLookup
  private readonly timeline: Timeline
  private readonly target: FCPXMLTarget
  private readonly fps: number
  private readonly seqWidth: number
  private readonly seqHeight: number
  private resourceIndex = new Map<string, number>()
  private resources: MediaResource[] = []
  private nextTextStyleId = 1
  // Synced A/V pairs export as one asset clip carrying the audio's volume.
  private linkedAudioForVideo = new Map<string, Clip>()
  private redundantAudioClipIds = new Set<string>()
  private usedCompoundIds = new Set<string>()
  private nests: Nest[] = []
  private nestIndex = new Map<string, string>()

  constructor(
    private readonly input: InterchangeInput,
    private readonly options: FCPXMLOptions,
  ) {
    this.media = mediaLookup(input)
    this.timeline = input.timeline
    this.target = options.target ?? DEFAULT_FCPXML_TARGET
    this.fps = Math.max(1, input.timeline.fps)
    this.seqWidth = input.timeline.width
    this.seqHeight = input.timeline.height
  }

  build(): string {
    this.collectNests()
    const clips = this.emittableClips(this.timeline)
    const nestedClips = this.nests.flatMap((n) => this.emittableClips(n.timeline))
    const all = [...clips, ...nestedClips]
    this.collectResources(all)
    this.indexLinkedPairs(all)
    this.markUsedCompounds(all)
    const hasTitles = all.some((c) => c.clip.mediaType === 'text')
    const resources = this.resourcesNode(hasTitles)
    const library = this.libraryNode(clips)
    return renderDocument('fcpxml', el('fcpxml', [['version', this.options.version ?? DEFAULT_FCPXML_VERSION]], [resources, library]))
  }

  /** Nonempty, resolvable nested timelines in breadth-first discovery order. */
  private collectNests(): void {
    const timelines = [...(this.input.timelines ?? []), this.timeline]
    for (const id of reachableTimelineIds(timelines, this.timeline.id, NEST_MAX_DEPTH)) {
      const child = this.media.timeline(id)
      if (!child || totalFrames(child) <= 0) continue
      const mediaId = `nest${this.nests.length + 1}`
      this.nestIndex.set(child.id, mediaId)
      this.nests.push({ mediaId, timeline: child })
    }
  }

  private indexLinkedPairs(clips: EmittableClip[]): void {
    const byGroup = new Map<string, { videos: EmittableClip[]; audios: EmittableClip[] }>()
    for (const item of clips) {
      const group = item.clip.linkGroupId
      if (!group) continue
      const t = item.clip.mediaType
      const kind = t === 'video' || t === 'image' || t === 'sequence' ? 'videos' : t === 'audio' ? 'audios' : null
      if (!kind) continue
      let g = byGroup.get(group)
      if (!g) byGroup.set(group, (g = { videos: [], audios: [] }))
      g[kind].push(item)
    }
    for (const pair of byGroup.values()) {
      if (pair.videos.length !== 1 || pair.audios.length !== 1) continue
      const v = pair.videos[0]
      const a = pair.audios[0]
      if (
        v.clip.mediaRef !== a.clip.mediaRef ||
        v.enabled !== a.enabled ||
        v.clip.startFrame !== a.clip.startFrame ||
        v.clip.durationFrames !== a.clip.durationFrames ||
        v.clip.trimStartFrame !== a.clip.trimStartFrame ||
        !(Math.abs(v.clip.speed - a.clip.speed) < 0.0001)
      )
        continue
      this.linkedAudioForVideo.set(v.clip.id, a.clip)
      this.redundantAudioClipIds.add(a.clip.id)
    }
  }

  /** Compound resources are emitted only when some clip plays one side of an A/V source. */
  private markUsedCompounds(clips: EmittableClip[]): void {
    for (const item of clips) {
      if (this.redundantAudioClipIds.has(item.clip.id)) continue
      const i = this.resourceIndex.get(item.clip.mediaRef)
      if (i === undefined) continue
      const compoundId = this.resources[i].compoundId
      if (!compoundId || this.linkedAudioForVideo.has(item.clip.id)) continue
      this.usedCompoundIds.add(compoundId)
    }
  }

  // ---------- Resources ----------

  private resourcesNode(hasTitles: boolean): XmlNode {
    const children: XmlChild[] = [
      el('format', [
        ['id', SEQUENCE_FORMAT_ID],
        ['name', sequenceFormatName(this.seqWidth, this.seqHeight, this.fps)],
        ['frameDuration', frameDuration(this.fps)],
        ['width', `${this.seqWidth}`],
        ['height', `${this.seqHeight}`],
        ['colorSpace', COLOR_SPACE],
      ]),
    ]
    if (hasTitles) children.push(el('effect', [['id', TITLE_EFFECT_ID], ['name', 'Basic Title'], ['uid', TITLE_EFFECT_UID]]))
    children.push(...this.resources.map((r) => this.formatNode(r)))
    children.push(...this.resources.map((r) => this.assetNode(r)))
    children.push(...this.resources.map((r) => this.compoundClipNode(r)))
    children.push(...this.nests.map((n) => this.nestFormatNode(n)))
    children.push(...this.nests.map((n) => this.nestMediaNode(n)))
    return node('resources', children)
  }

  private nestFormatId(nest: Nest): string {
    return nest.timeline.width === this.seqWidth && nest.timeline.height === this.seqHeight ? SEQUENCE_FORMAT_ID : `${nest.mediaId}Format`
  }

  private nestFormatNode(nest: Nest): XmlNode | null {
    const formatId = this.nestFormatId(nest)
    if (formatId === SEQUENCE_FORMAT_ID) return null
    return el('format', [
      ['id', formatId],
      ['name', sequenceFormatName(nest.timeline.width, nest.timeline.height, this.fps)],
      ['frameDuration', frameDuration(this.fps)],
      ['width', `${nest.timeline.width}`],
      ['height', `${nest.timeline.height}`],
      ['colorSpace', COLOR_SPACE],
    ])
  }

  private nestMediaNode(nest: Nest): XmlNode {
    const duration = this.time(totalFrames(nest.timeline))
    const gap = el('gap', [['name', 'Timeline'], ['offset', '0s'], ['start', '0s'], ['duration', duration]], this.storyNodes(this.emittableClips(nest.timeline)))
    const sequence = el(
      'sequence',
      [['format', this.nestFormatId(nest)], ['duration', duration], ['tcStart', '0s'], ['tcFormat', 'NDF'], ['audioLayout', 'stereo'], ['audioRate', '48k']],
      [node('spine', [gap])],
    )
    return el('media', [['id', nest.mediaId], ['name', nest.timeline.name]], [sequence])
  }

  private compoundClipNode(resource: MediaResource): XmlNode | null {
    if (!resource.compoundId || !this.usedCompoundIds.has(resource.compoundId)) return null
    const dur = this.time(resource.durationFrames)
    // Compound spines stay 0-based while reading from the asset's timecode origin.
    const tcStart = rationalTime(resource.startTimecode.num, resource.startTimecode.den)
    const format = resource.formatId ?? SEQUENCE_FORMAT_ID
    const name = lastPathComponent(resource.path)
    const inner = el('asset-clip', [['ref', resource.assetId], ['name', name], ['duration', dur], ['start', tcStart], ['offset', '0s'], ['format', format]])
    const sequence = el('sequence', [['format', format], ['duration', dur], ['tcStart', '0s'], ['tcFormat', 'NDF']], [node('spine', [inner])])
    return el('media', [['id', resource.compoundId], ['name', name]], [sequence])
  }

  private formatNode(resource: MediaResource): XmlNode | null {
    if (!resource.formatId) return null
    const width = resource.entry.sourceWidth ?? this.seqWidth
    const height = resource.entry.sourceHeight ?? this.seqHeight
    const rawFps = resource.entry.sourceFPS ?? this.fps
    return el('format', [
      ['id', resource.formatId],
      ['name', videoFormatName(width, height, rawFps)],
      ['frameDuration', frameDuration(rawFps)],
      ['width', `${width}`],
      ['height', `${height}`],
      ['colorSpace', COLOR_SPACE],
    ])
  }

  private assetNode(resource: MediaResource): XmlNode {
    const attrs: [string, string][] = [
      ['id', resource.assetId],
      // Resolve relinks by the full filename, including its extension.
      ['name', lastPathComponent(resource.path)],
      ['start', rationalTime(resource.startTimecode.num, resource.startTimecode.den)],
      ['duration', this.time(resource.durationFrames)],
    ]
    if (resource.hasVideo) {
      attrs.push(['hasVideo', '1'], ['videoSources', '1'])
      if (resource.formatId) attrs.push(['format', resource.formatId])
    }
    if (resource.hasAudio) attrs.push(['hasAudio', '1'], ['audioSources', '1'], ['audioChannels', '2'], ['audioRate', '48000'])
    return el('asset', attrs, [el('media-rep', [['kind', 'original-media'], ['src', fcpxmlMediaSrc(resource.path)]])])
  }

  /** One resource per canonical source file, in first-use order. */
  private collectResources(clips: EmittableClip[]): void {
    interface Caps {
      mediaRefs: string[]
      hasVideo: boolean
      hasAudio: boolean
      duration: number
      entry: MediaManifestEntry
      path: string
    }
    const order: string[] = []
    const caps = new Map<string, Caps>()
    for (const { clip } of clips) {
      if (clip.mediaType === 'text' || clip.mediaType === 'lottie') continue
      const entry = this.media.entry(clip.mediaRef)
      const path = this.media.path(clip.mediaRef)
      if (!entry || path === undefined) continue
      const key = this.input.canonicalPaths?.[path] ?? path
      const duration = Math.max(Math.max(0, secondsToFrame(entry.duration, this.fps)), sourceDurationFrames(clip))
      const isVisual = clip.mediaType !== 'audio'
      // Video resources include the source's audio when present.
      const isAudio = clip.mediaType === 'audio' || (clip.mediaType === 'video' && entry.hasAudio === true)
      let c = caps.get(key)
      if (!c) {
        order.push(key)
        caps.set(key, (c = { mediaRefs: [], hasVideo: false, hasAudio: false, duration: 0, entry, path }))
      }
      if (!c.mediaRefs.includes(clip.mediaRef)) c.mediaRefs.push(clip.mediaRef)
      c.hasVideo ||= isVisual
      c.hasAudio ||= isAudio
      c.duration = Math.max(c.duration, duration)
    }
    for (const key of order) {
      const c = caps.get(key)!
      const id = this.resources.length + 1
      for (const ref of c.mediaRefs) this.resourceIndex.set(ref, this.resources.length)
      const tc = c.mediaRefs.map((ref) => this.input.timecodes?.[ref]).find((t) => t !== undefined)
      this.resources.push({
        mediaRef: c.mediaRefs[0] ?? c.entry.id,
        assetId: `asset${id}`,
        formatId: c.hasVideo ? `r${id + 1}` : undefined,
        // Only A/V sources need srcEnable gating through a compound.
        compoundId: c.hasVideo && c.hasAudio ? `media${id}` : undefined,
        entry: c.entry,
        path: c.path,
        durationFrames: c.duration,
        hasVideo: c.hasVideo,
        hasAudio: c.hasAudio,
        startTimecode: tc ? rationalSeconds(tc) : { num: 0, den: 1 },
      })
    }
  }

  // ---------- Library ----------

  private libraryNode(clips: EmittableClip[]): XmlNode {
    return node('library', [el('event', [['name', FCPXML_EVENT_NAME]], [this.projectNode(clips)])])
  }

  private projectNode(clips: EmittableClip[]): XmlNode {
    const total = totalFrames(this.timeline)
    const duration = this.time(total)
    const spine =
      total > 0
        ? node('spine', [el('gap', [['name', 'Timeline'], ['offset', '0s'], ['start', '0s'], ['duration', duration]], this.storyNodes(clips))])
        : node('spine')
    return el('project', [['name', this.timeline.name]], [
      el(
        'sequence',
        [['format', SEQUENCE_FORMAT_ID], ['duration', duration], ['tcStart', '0s'], ['tcFormat', 'NDF'], ['audioLayout', 'stereo'], ['audioRate', '48k']],
        [spine],
      ),
    ])
  }

  private storyNodes(clips: EmittableClip[]): XmlNode[] {
    return clips
      .filter((c) => !this.redundantAudioClipIds.has(c.clip.id))
      .sort((a, b) => (a.clip.startFrame !== b.clip.startFrame ? a.clip.startFrame - b.clip.startFrame : a.lane - b.lane))
      .map((item) => {
        switch (item.clip.mediaType) {
          case 'text':
            return this.titleNode(item)
          case 'audio':
          case 'video':
          case 'image':
          case 'sequence':
            return this.assetClipNode(item)
          default:
            return null
        }
      })
      .filter((n): n is XmlNode => n !== null)
  }

  private assetClipNode(item: EmittableClip): XmlNode | null {
    const { clip } = item
    const lane = `${item.lane}`
    const enabled = item.enabled ? '1' : '0'

    if (clip.sourceClipType === 'sequence') {
      const mediaId = this.nestIndex.get(clip.mediaRef)
      const child = this.media.timeline(clip.mediaRef)
      if (!mediaId || !child) return null
      // Frozen carriers may outlive the child timeline.
      const duration = Math.min(clip.durationFrames, Math.max(0, totalFrames(child) - clip.trimStartFrame))
      if (duration <= 0) return null
      const attrs: [string, string][] = [
        ['ref', mediaId],
        ['name', child.name],
        ['lane', lane],
        ['offset', this.time(clip.startFrame)],
        ['start', this.time(clip.trimStartFrame)],
        ['duration', this.time(duration)],
        ['enabled', enabled],
      ]
      if (clip.mediaType === 'audio') {
        attrs.push(['srcEnable', 'audio'])
        return el('ref-clip', attrs, [this.volumeNode(clip)])
      }
      const nestLinkedAudio = this.linkedAudioForVideo.get(clip.id)
      if (!nestLinkedAudio) attrs.push(['srcEnable', 'video'])
      return el('ref-clip', attrs, [
        el('adjust-conform', [['type', 'fit']]),
        this.cropNode(clip),
        this.transformNode(clip),
        this.blendNode(clip),
        nestLinkedAudio && this.volumeNode(nestLinkedAudio),
      ])
    }

    const i = this.resourceIndex.get(clip.mediaRef)
    if (i === undefined) return null
    const resource = this.resources[i]
    const linkedAudio = this.linkedAudioForVideo.get(clip.id)
    const name = lastPathComponent(resource.path)

    // Resolve honors srcEnable only on ref-clips.
    if (resource.compoundId && !linkedAudio) {
      const videoOnly = clip.mediaType !== 'audio'
      const attrs: [string, string][] = [
        ['ref', resource.compoundId],
        ['name', name],
        ['lane', lane],
        ['offset', this.time(clip.startFrame)],
        ['start', this.clipStart(clip)],
        ['duration', this.time(clip.durationFrames)],
        ['enabled', enabled],
        ['srcEnable', videoOnly ? 'video' : 'audio'],
      ]
      // Child order is fixed by the DTD.
      const children: XmlChild[] = videoOnly
        ? [this.timeMapNode(clip, resource.durationFrames), this.cropNode(clip), el('adjust-conform', [['type', 'fit']]), this.transformNode(clip), this.blendNode(clip)]
        : [this.timeMapNode(clip, resource.durationFrames), this.volumeNode(clip)]
      return el('ref-clip', attrs, children)
    }

    const origin = resource.startTimecode
    const visual = clip.mediaType !== 'audio'
    const attrs: [string, string][] = [
      ['ref', resource.assetId],
      ['name', name],
      ['lane', lane],
      ['offset', this.time(clip.startFrame)],
      ['start', this.clipStart(clip, origin)],
      ['duration', this.time(clip.durationFrames)],
      ['enabled', enabled],
    ]
    const children: XmlChild[] = [
      this.timeMapNode(clip, resource.durationFrames, origin),
      visual && this.cropNode(clip),
      visual && el('adjust-conform', [['type', 'fit']]),
      visual && this.transformNode(clip),
      visual && this.blendNode(clip),
      resource.hasAudio && this.volumeNode(linkedAudio ?? clip),
    ]
    // Final Cut writes stills as video elements.
    return el(clip.mediaType === 'image' ? 'video' : 'asset-clip', attrs, children)
  }

  private titleNode(item: EmittableClip): XmlNode | null {
    const { clip } = item
    const content = clip.textContent
    if (!content) return null
    const style = clip.textStyle ?? defaultTextStyle()
    const styleId = `textStyle${this.nextTextStyleId}`
    this.nextTextStyleId += 1
    const display = style.fontCase === 'uppercase' ? content.toUpperCase() : style.fontCase === 'lowercase' ? content.toLowerCase() : content
    const children: XmlChild[] = [
      node('text', [textEl('text-style', [['ref', styleId]], display)]),
      el('text-style-def', [['id', styleId]], [el('text-style', this.textStyleAttributes(style))]),
      ...this.titleTransformNodes(clip, style),
      this.blendNode(clip),
    ]
    return el(
      'title',
      [
        ['ref', TITLE_EFFECT_ID],
        ['name', content],
        ['lane', `${item.lane}`],
        ['offset', this.time(clip.startFrame)],
        ['start', '0s'],
        ['duration', this.time(clip.durationFrames)],
        ['enabled', item.enabled ? '1' : '0'],
      ],
      children,
    )
  }

  // ---------- Adjustments ----------

  private blendNode(clip: Clip): XmlNode | null {
    const frames = keyframeFrames(clip, 'opacity')
    if (!(clip.opacity < 0.9995) && frames.length === 0) return null
    const children: XmlChild[] = []
    if (frames.length) {
      children.push(this.keyframeParam('amount', fcpxmlNumber(clip.opacity), clip, 'opacity', frames, (f) => fcpxmlNumber(rawOpacityAt(clip, f))))
    }
    return el('adjust-blend', [['amount', fcpxmlNumber(clip.opacity)]], children)
  }

  private transformNode(clip: Clip): XmlNode | null {
    const t = clip.transform
    const posFrames = keyframeFrames(clip, 'position')
    const rotFrames = keyframeFrames(clip, 'rotation')
    const scaleFrames = keyframeFrames(clip, 'scale')
    const base = this.scaleValue(t.width, t.height, clip)
    const moved = Math.abs(t.centerX - 0.5) > 0.0005 || Math.abs(t.centerY - 0.5) > 0.0005
    const rotated = Math.abs(t.rotation) > 0.005
    const scaled = base !== '1 1'
    if (!moved && !rotated && !scaled && !posFrames.length && !rotFrames.length && !scaleFrames.length) return null

    const fit = this.target === 'resolve' ? this.fitFractions(clip) : { w: 1, h: 1 }
    const attrs: [string, string][] = [['scale', base]]
    if (rotated || rotFrames.length) attrs.push(['rotation', fcpxmlNumber(-t.rotation)])
    attrs.push(['anchor', '0 0'])
    attrs.push(['position', this.positionValue(t, fit)])

    const params: XmlNode[] = []
    if (scaleFrames.length) {
      params.push(
        this.keyframeParam('scale', base, clip, 'scale', scaleFrames, (f) => {
          const s = sizeAt(clip, f)
          return this.scaleValue(s.a, s.b, clip)
        }),
      )
    }
    if (posFrames.length) {
      params.push(this.keyframeParam('position', this.positionValue(t, fit), clip, 'position', posFrames, (f) => this.positionValue(transformAt(clip, f), fit)))
    }
    if (rotFrames.length) {
      params.push(this.keyframeParam('rotation', fcpxmlNumber(-t.rotation), clip, 'rotation', rotFrames, (f) => fcpxmlNumber(-rotationAt(clip, f))))
    }
    return el('adjust-transform', attrs, params)
  }

  /** User scale with the aspect-fit divided out; flips as negative scale. */
  private scaleValue(width: number, height: number, clip: Clip): string {
    const fit = this.fitFractions(clip)
    let sx = width / fit.w
    let sy = height / fit.h
    if (clip.transform.flipHorizontal) sx = -sx
    if (clip.transform.flipVertical) sy = -sy
    return `${fcpxmlNumber(sx)} ${fcpxmlNumber(sy)}`
  }

  private keyframeParam(name: string, base: string, clip: Clip, property: AnimatableProperty, frames: number[], value: (frame: number) => string): XmlNode {
    const keyframes = [...frames]
      .sort((a, b) => a - b)
      .map((f) => {
        const attrs: [string, string][] = [['time', this.keyframeTime(f, clip)]]
        if (keyframeInterpolation(clip, property, f) === 'linear') attrs.push(['curve', 'linear'])
        attrs.push(['value', value(f)])
        return el('keyframe', attrs)
      })
    return el('param', [['name', name], ['value', base]], [node('keyframeAnimation', keyframes)])
  }

  /** Retimed keyframes sit on the time map's output axis (offset by the clip's output-axis start). */
  private keyframeTime(f: number, clip: Clip): string {
    if (!(Math.abs(clip.speed - 1) > 0.001)) return this.time(f - clip.startFrame)
    const { p, q } = rationalSpeed(clip.speed)
    return rationalTime(clip.trimStartFrame * q + (f - clip.startFrame) * p, this.fps * p)
  }

  /** `<trim-rect>` in Resolve's units when source dimensions are known; percent otherwise and for Final Cut. */
  private cropNode(clip: Clip): XmlNode | null {
    const c = clip.crop
    if (c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0) return null
    let lr = 100
    let tb = 100
    const entry = this.media.entry(clip.mediaRef)
    const sw = entry?.sourceWidth
    const sh = entry?.sourceHeight
    if (this.target === 'resolve' && sw !== undefined && sh !== undefined && sw > 0 && sh > 0) {
      const fit = Math.min(this.seqWidth / sw, this.seqHeight / sh)
      lr = (sw * 100) / this.seqHeight
      tb = 100 / fit
    }
    return el('adjust-crop', [['mode', 'trim']], [
      el('trim-rect', [
        ['top', fcpxmlNumber(c.top * tb)],
        ['right', fcpxmlNumber(c.right * lr)],
        ['bottom', fcpxmlNumber(c.bottom * tb)],
        ['left', fcpxmlNumber(c.left * lr)],
      ]),
    ])
  }

  /** Static level only (Resolve drops keyframed volume on round-trip). */
  private volumeNode(clip: Clip): XmlNode | null {
    if (!(Math.abs(clip.volume - 1) > 0.0005)) return null
    const db = clip.volume > 0 ? 20 * Math.log10(clip.volume) : -96
    return el('adjust-volume', [['amount', fcpxmlNumber(db)]])
  }

  /** Output-axis start for retimed clips; the source in-point (plus timecode origin) otherwise. */
  private clipStart(clip: Clip, origin: Rational = { num: 0, den: 1 }): string {
    if (!(Math.abs(clip.speed - 1) > 0.001)) return this.timeFrom(clip.trimStartFrame, origin)
    const { p, q } = rationalSpeed(clip.speed)
    return rationalTime(clip.trimStartFrame * q, this.fps * p)
  }

  /** Maps the whole asset so retimed clips do not end on black frames. */
  private timeMapNode(clip: Clip, mediaFrames: number, origin: Rational = { num: 0, den: 1 }): XmlNode | null {
    if (!(Math.abs(clip.speed - 1) > 0.001) || !(mediaFrames > 0)) return null
    const { p, q } = rationalSpeed(clip.speed)
    return el('timeMap', [['frameSampling', 'floor']], [
      el('timept', [['time', '0s'], ['value', rationalTime(origin.num, origin.den)], ['interp', 'linear']]),
      el('timept', [['time', rationalTime(mediaFrames * q, this.fps * p)], ['value', this.timeFrom(mediaFrames, origin)], ['interp', 'linear']]),
    ])
  }

  // ---------- Titles ----------

  private textStyleAttributes(style: TextStyle): [string, string][] {
    const info = this.options.fontInfo?.(style)
    const family = info?.family ?? fallbackFontFamily(style.fontName)
    const face = info && info.bold === style.isBold && info.italic === style.isItalic ? info.face : fallbackFontFace(style.isBold, style.isItalic)
    // `scaledVisualStyle` folds fontScale into the size and stroke width once.
    const attrs: [string, string][] = [
      ['font', family],
      ['fontFace', face],
      ['fontSize', fcpxmlNumber(style.fontSize * style.fontScale)],
      ['fontColor', this.colorString(style.color)],
      ['alignment', style.alignment],
    ]
    if (style.border.enabled) {
      attrs.push(['strokeColor', this.colorString(style.border.color)])
      attrs.push(['strokeWidth', fcpxmlNumber(Math.max(0, style.border.width * style.fontScale))])
    }
    return attrs
  }

  private colorString(c: RGBA): string {
    return `${fcpxmlNumber(c.r)} ${fcpxmlNumber(c.g)} ${fcpxmlNumber(c.b)} ${fcpxmlNumber(c.a)}`
  }

  private titleTransformNodes(clip: Clip, style: TextStyle): XmlNode[] {
    const baseScale = `${fcpxmlNumber(style.widthScale)} ${fcpxmlNumber(style.heightScale)}`
    const frames = keyframeFrames(clip, 'scale')
    const params: XmlNode[] = []
    if (frames.length) {
      const staticFontScale = Number.isFinite(style.fontScale) && style.fontScale > 0 ? style.fontScale : defaultTextStyle().fontScale
      params.push(
        this.keyframeParam('scale', baseScale, clip, 'scale', frames, (f) => {
          const ratio = textScaleAt(clip, f) / staticFontScale
          return `${fcpxmlNumber(style.widthScale * ratio)} ${fcpxmlNumber(style.heightScale * ratio)}`
        }),
      )
    }
    return [
      el('adjust-conform', [['type', 'fit']]),
      el('adjust-transform', [['scale', baseScale], ['anchor', '0 0'], ['position', this.positionValue(clip.transform)]], params),
    ]
  }

  // ---------- Geometry ----------

  /** Unit = 1% of frame height, origin at centre, +Y up; divided by the conform-fit fraction for Resolve. */
  private positionValue(t: Transform, fit = { w: 1, h: 1 }): string {
    const unit = this.seqHeight / 100
    const x = ((t.centerX - 0.5) * this.seqWidth) / unit / fit.w
    const y = ((0.5 - t.centerY) * this.seqHeight) / unit / fit.h
    return `${fcpxmlNumber(x)} ${fcpxmlNumber(y)}`
  }

  /** Per-axis conform-fit fractions, or 1×1 without source dimensions. */
  private fitFractions(clip: Clip): { w: number; h: number } {
    const entry = this.media.entry(clip.mediaRef)
    const sw = entry?.sourceWidth
    const sh = entry?.sourceHeight
    if (sw === undefined || sh === undefined || !(sw > 0) || !(sh > 0)) return { w: 1, h: 1 }
    const sourceAspect = sw / sh
    const frameAspect = this.seqWidth / this.seqHeight
    return sourceAspect >= frameAspect ? { w: 1, h: frameAspect / sourceAspect } : { w: sourceAspect / frameAspect, h: 1 }
  }

  // ---------- Clips and times ----------

  private emittableClips(timeline: Timeline): EmittableClip[] {
    const visualTrackCount = timeline.tracks.filter((t) => isVisualType(t.type)).length
    let visualOrdinal = 0
    let audioOrdinal = 0
    const out: EmittableClip[] = []
    for (const track of timeline.tracks) {
      let lane: number
      let enabled: boolean
      if (isVisualType(track.type)) {
        lane = visualTrackCount - visualOrdinal
        enabled = !track.hidden
        visualOrdinal += 1
      } else if (track.type === 'audio') {
        lane = -(audioOrdinal + 1)
        enabled = !track.muted
        audioOrdinal += 1
      } else {
        continue
      }
      out.push(
        ...track.clips
          .filter((c) => this.isEmittable(c))
          .sort((a, b) => a.startFrame - b.startFrame)
          .map((clip) => ({ clip, lane, enabled })),
      )
    }
    return out
  }

  private isEmittable(clip: Clip): boolean {
    if (!(clip.durationFrames > 0)) return false
    // Nest carriers require a collected compound resource.
    if (clip.sourceClipType === 'sequence') return this.nestIndex.has(clip.mediaRef)
    switch (clip.mediaType) {
      case 'text':
        return !!clip.textContent
      case 'audio':
      case 'video':
      case 'image':
        return this.media.path(clip.mediaRef) !== undefined
      default:
        return false
    }
  }

  private time(frames: number): string {
    if (frames === 0) return '0s'
    const divisor = gcd(Math.abs(frames), this.fps)
    const numerator = Math.trunc(frames / divisor)
    const denominator = Math.trunc(this.fps / divisor)
    return denominator === 1 ? `${numerator}s` : `${numerator}/${denominator}s`
  }

  /** Frame time added to an exact source origin without NTSC drift. */
  private timeFrom(frames: number, origin: Rational): string {
    if (origin.num === 0) return this.time(frames)
    return rationalTime(frames * origin.den + origin.num * this.fps, this.fps * origin.den)
  }
}

