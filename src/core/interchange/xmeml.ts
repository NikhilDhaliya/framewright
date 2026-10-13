/**
 * XMEML v4 ("Final Cut Pro 7 XML") for Premiere Pro / DaVinci Resolve — a port of the Mac `Export/XMLExporter.swift`
 * (spec 07 §6.1, 04 §11.7). Pure: media paths, timecodes and nested timelines come in through `InterchangeInput`.
 *
 * Transports placement/trims, speed (Time Remap), volume (Audio Levels, static + keyframes), opacity, transform
 * (Basic Motion) and crop (static + keyframes), fades (single-sided transitions), A/V links, per-file NTSC rates,
 * source timecode and nested timelines. Not transported: text, flips, interpolation curves, effects/colour,
 * edge rounding/softness, multicam structure, captions.
 */
import { cropAt, endFrame, rawOpacityAt, rawVolumeAt, rotationAt, sizeAt, sourceDurationFrames, sourceFramesConsumed, transformAt } from '../clip'
import { swiftRound } from '../keyframes'
import { isVisualType, type Clip, type Crop, type Timeline, type Track, type Transform } from '../model'
import { keyframeFrames } from '../ops/properties'
import { secondsToFrame } from '../time'
import { totalFrames } from '../timeline'
import { lastPathComponent, xmemlPathUrl } from './fileUrl'
import { formatFixed } from './printf'
import { rateTags, timecodeTags } from './timecode'
import { mediaLookup, type InterchangeInput, type MediaLookup } from './types'
import { bool, el, leaf, node, renderDocument, type XmlNode } from './xml'

interface ClipAddress {
  trackIndex: number
  clipIndex: number
  isAudio: boolean
}

interface ScalarKeyframe {
  when: number
  value: number
}

/** Premiere stores fade cut points in 254016000000 ticks per second. */
const TICKS_PER_SECOND = 254_016_000_000

export function exportXMEML(input: InterchangeInput): string {
  return new XmemlBuilder(input).build()
}

class XmemlBuilder {
  private readonly media: MediaLookup
  private readonly timeline: Timeline
  private readonly fps: number
  private readonly seqWidth: number
  private readonly seqHeight: number
  private curSeqWidth: number
  private emittedFiles = new Set<string>()
  private clipAddresses = new Map<string, ClipAddress>()
  private clipsByLinkGroup = new Map<string, Clip[]>()
  private sequenceIds = new Map<string, string>()
  private emittedSequences = new Set<string>()

  constructor(private readonly input: InterchangeInput) {
    this.media = mediaLookup(input)
    this.timeline = input.timeline
    this.fps = input.timeline.fps
    this.seqWidth = input.timeline.width
    this.seqHeight = input.timeline.height
    this.curSeqWidth = input.timeline.width
  }

  build(): string {
    this.sequenceIds.set(this.timeline.id, 'sequence-1')
    this.emittedSequences.add(this.timeline.id)
    const root = el('xmeml', [['version', '4']], [this.sequenceNode('sequence-1', this.timeline)])
    return renderDocument('xmeml', root)
  }

  // ---------- Document shell ----------

  /** Root or nested sequence; link state and the Basic Motion canvas width are isolated per sequence. */
  private sequenceNode(id: string, timeline: Timeline): XmlNode {
    const savedAddresses = this.clipAddresses
    const savedGroups = this.clipsByLinkGroup
    const savedSeqWidth = this.curSeqWidth
    this.clipAddresses = new Map()
    this.clipsByLinkGroup = new Map()
    this.curSeqWidth = timeline.width
    try {
      // FCP XML orders video tracks bottom→top; the model stores them top→bottom.
      const videoTracks = timeline.tracks.filter((t) => isVisualType(t.type)).reverse()
      const audioTracks = timeline.tracks.filter((t) => t.type === 'audio')
      const sortedVideo = videoTracks.map((t) => this.sortEmittable(t))
      const sortedAudio = audioTracks.map((t) => this.sortEmittable(t))

      this.indexAddresses(sortedVideo, false)
      this.indexAddresses(sortedAudio, true)
      this.indexLinkGroups(timeline)

      const videoTrackNodes = videoTracks.map((t, i) => this.trackNode(t, sortedVideo[i], false))
      const audioTrackNodes = audioTracks.map((t, i) => this.trackNode(t, sortedAudio[i], true))

      return el('sequence', [['id', id]], [
        leaf('name', timeline.name),
        leaf('duration', totalFrames(timeline)),
        this.rate(this.fps),
        this.timecodeNode(),
        node('media', [
          node('video', [this.videoFormatNode(timeline.width, timeline.height), ...videoTrackNodes]),
          node('audio', [leaf('numOutputChannels', 2), this.audioFormatNode(), this.audioOutputsNode(), ...audioTrackNodes]),
        ]),
      ])
    } finally {
      this.clipAddresses = savedAddresses
      this.clipsByLinkGroup = savedGroups
      this.curSeqWidth = savedSeqWidth
    }
  }

  private timecodeNode(): XmlNode {
    return node('timecode', [this.rate(this.fps), leaf('string', '00:00:00:00'), leaf('frame', 0), leaf('source', 'source'), leaf('displayformat', 'NDF')])
  }

  private videoFormatNode(width: number, height: number): XmlNode {
    return node('format', [
      node('samplecharacteristics', [
        leaf('width', width),
        leaf('height', height),
        bool('anamorphic', false),
        leaf('pixelaspectratio', 'square'),
        leaf('fielddominance', 'none'),
        this.rate(this.fps),
      ]),
    ])
  }

  private audioFormatNode(): XmlNode {
    return node('format', [node('samplecharacteristics', [leaf('samplerate', 48000), leaf('depth', 16)])])
  }

  private audioOutputsNode(): XmlNode {
    return node('outputs', [
      node('group', [leaf('index', 1), leaf('numchannels', 2), leaf('downmix', 0), node('channel', [leaf('index', 1)]), node('channel', [leaf('index', 2)])]),
    ])
  }

  // ---------- Tracks → clipitems ----------

  private trackNode(track: Track, sortedClips: Clip[], isAudio: boolean): XmlNode {
    const enabled = isAudio ? !track.muted : !track.hidden
    const children: XmlNode[] = [bool('enabled', enabled), bool('locked', false)]
    for (const clip of sortedClips) {
      const fadeIn = this.fadeTransition(clip, 'left', isAudio)
      if (fadeIn) children.push(fadeIn)
      children.push(this.clipItemNode(clip, isAudio))
      const fadeOut = this.fadeTransition(clip, 'right', isAudio)
      if (fadeOut) children.push(fadeOut)
    }
    return node('track', children)
  }

  private clipItemNode(clip: Clip, isAudio: boolean): XmlNode {
    if (clip.sourceClipType === 'sequence') return this.nestClipItemNode(clip, isAudio)
    // In/out/duration are in FILE-rate units (Resolve conforms them against the file's own rate); start/end stay sequence frames.
    const { timebase, ntsc } = rateTags(this.media.entry(clip.mediaRef)?.sourceFPS ?? this.fps)
    const fileFps = ntsc ? (timebase * 1000) / 1001 : timebase
    const scale = fileFps / this.fps
    const matchesTimeline = Math.abs(scale - 1) < 0.0001
    const fileFrames = (timelineFrames: number) => (matchesTimeline ? timelineFrames : swiftRound(timelineFrames * scale))
    const sourceDuration = this.sourceDurationFrames(clip.mediaRef) ?? sourceDurationFrames(clip)
    const inPoint = fileFrames(clip.trimStartFrame)
    const outPoint = fileFrames(clip.trimStartFrame + sourceFramesConsumed(clip))

    const children: XmlNode[] = [
      leaf('masterclipid', this.masterclipId(clip, isAudio)),
      leaf('name', this.media.entry(clip.mediaRef)?.name ?? 'Offline'),
      bool('enabled', true),
      leaf('duration', fileFrames(sourceDuration)),
      matchesTimeline ? this.rate(this.fps) : this.rate(timebase, ntsc),
      leaf('start', clip.startFrame),
      leaf('end', endFrame(clip)),
      leaf('in', inPoint),
      leaf('out', outPoint),
      this.fileNode(clip.mediaRef, isAudio),
    ]
    const remap = this.timeRemapFilter(clip.speed, isAudio)
    if (remap) children.push(remap)
    children.push(...(isAudio ? this.volumeFilters(clip) : this.videoFilters(clip)))
    children.push(...this.linkNodes(clip))
    return el('clipitem', [['id', `clipitem-${clip.id}`]], children)
  }

  /** Embeds a nested sequence on first use, then references it by id. */
  private nestClipItemNode(clip: Clip, isAudio: boolean): XmlNode {
    const child = this.media.timeline(clip.mediaRef)!
    let seqId = this.sequenceIds.get(clip.mediaRef)
    if (!seqId) {
      seqId = `sequence-${this.sequenceIds.size + 1}`
      this.sequenceIds.set(clip.mediaRef, seqId)
    }
    let sequence: XmlNode
    if (!this.emittedSequences.has(clip.mediaRef)) {
      this.emittedSequences.add(clip.mediaRef)
      sequence = this.sequenceNode(seqId, child)
    } else {
      sequence = el('sequence', [['id', seqId]])
    }

    const childFrames = totalFrames(child)
    const inPoint = clip.trimStartFrame
    const outPoint = Math.min(inPoint + clip.durationFrames, childFrames)
    const children: XmlNode[] = [
      leaf('masterclipid', this.masterclipId(clip, isAudio)),
      leaf('name', child.name),
      bool('enabled', true),
      leaf('duration', childFrames),
      this.rate(this.fps),
      leaf('start', clip.startFrame),
      leaf('end', clip.startFrame + (outPoint - inPoint)),
      leaf('in', inPoint),
      leaf('out', outPoint),
      sequence,
    ]
    children.push(...(isAudio ? this.volumeFilters(clip) : this.videoFilters(clip)))
    children.push(...this.linkNodes(clip))
    return el('clipitem', [['id', `clipitem-${clip.id}`]], children)
  }

  private masterclipId(clip: Clip, isAudio: boolean): string {
    if (clip.linkGroupId) return `masterclip-${clip.linkGroupId}`
    return `masterclip-${clip.mediaRef}-${isAudio ? 'audio' : 'video'}`
  }

  // ---------- File elements ----------

  /** Full `<file>` on first use per (mediaRef, video|audio); later uses collapse to `<file id/>`. */
  private fileNode(mediaRef: string, isAudio: boolean): XmlNode {
    const fileId = `file-${mediaRef}-${isAudio ? 'audio' : 'video'}`
    const key = `${isAudio ? 'a' : 'v'}:${mediaRef}`
    if (this.emittedFiles.has(key)) return el('file', [['id', fileId]])
    this.emittedFiles.add(key)

    const entry = this.media.entry(mediaRef)
    const path = this.media.path(mediaRef)
    // Resolve matches media by exact filename + extension.
    const fileName = path !== undefined ? lastPathComponent(path) : (entry?.name ?? mediaRef)
    const pathUrl = path !== undefined ? xmemlPathUrl(path) : `media/${mediaRef}`
    const isImage = entry?.type === 'image'
    const { timebase, ntsc } = rateTags(entry?.sourceFPS ?? this.fps)
    const fileFps = ntsc ? (timebase * 1000) / 1001 : timebase
    const durationFrames = isImage ? 1 : entry ? Math.max(0, swiftRound(entry.duration * fileFps)) : 0

    const media = isAudio
      ? node('media', [node('audio', [node('samplecharacteristics', [leaf('samplerate', 48000), leaf('depth', 16)]), leaf('channelcount', 2)])])
      : node('media', [
          node('video', [
            isImage && leaf('duration', 1),
            node('samplecharacteristics', [
              leaf('width', entry?.sourceWidth ?? this.seqWidth),
              leaf('height', entry?.sourceHeight ?? this.seqHeight),
              bool('anamorphic', false),
              leaf('pixelaspectratio', 'square'),
              leaf('fielddominance', 'none'),
              this.rate(timebase, ntsc),
            ]),
          ]),
        ])

    // Resolve requires the timecode element.
    const tc = timecodeTags(this.input.timecodes?.[mediaRef], timebase, ntsc)
    const timecode = node('timecode', [this.rate(tc.base, tc.ntsc), leaf('string', tc.string), leaf('frame', tc.frame), leaf('displayformat', tc.dropFrame ? 'DF' : 'NDF')])
    return el('file', [['id', fileId]], [leaf('name', fileName), leaf('pathurl', pathUrl), this.rate(timebase, ntsc), leaf('duration', durationFrames), timecode, media])
  }

  // ---------- Links ----------

  /** One `<link>` per emitted member of the clip's link group (itself included) so Premiere rebuilds the A/V pair. */
  private linkNodes(clip: Clip): XmlNode[] {
    if (!clip.linkGroupId) return []
    const partners = this.clipsByLinkGroup.get(clip.linkGroupId)
    if (!partners || partners.length <= 1) return []
    const out: XmlNode[] = []
    for (const partner of partners) {
      const addr = this.clipAddresses.get(partner.id)
      if (!addr) continue
      out.push(
        node('link', [
          leaf('linkclipref', `clipitem-${partner.id}`),
          leaf('mediatype', addr.isAudio ? 'audio' : 'video'),
          leaf('trackindex', addr.trackIndex),
          leaf('clipindex', addr.clipIndex),
        ]),
      )
    }
    return out
  }

  // ---------- Transitions (fades) ----------

  /** A fade exports as a single-sided dissolve to black/silence. */
  private fadeTransition(clip: Clip, edge: 'left' | 'right', isAudio: boolean): XmlNode | null {
    const frames = edge === 'left' ? clip.fadeInFrames : clip.fadeOutFrames
    if (!(frames > 0)) return null
    const left = edge === 'left'
    const start = left ? clip.startFrame : endFrame(clip) - frames
    const end = left ? clip.startFrame + frames : endFrame(clip)
    const cutFrames = left ? 0 : frames
    const children: XmlNode[] = [leaf('start', start), leaf('end', end), leaf('alignment', left ? 'start-black' : 'end-black')]
    if (isAudio) {
      children.push(this.rate(this.fps))
      children.push(this.effect('Cross Fade ( 0dB)', 'KGAudioTransCrossFade0dB', 'transition', 'audio'))
    } else {
      children.push(leaf('cutPointTicks', String(BigInt(cutFrames) * (BigInt(TICKS_PER_SECOND) / BigInt(this.fps)))))
      children.push(this.rate(this.fps))
      children.push(
        this.effect('Cross Dissolve', 'Cross Dissolve', 'transition', 'video', 'Dissolve', [
          leaf('wipecode', 0),
          leaf('wipeaccuracy', 100),
          leaf('startratio', 0),
          leaf('endratio', 1),
          bool('reverse', false),
        ]),
      )
    }
    return node('transitionitem', children)
  }

  // ---------- Filters ----------

  /** Premiere needs Time Remap to apply speed; it won't infer it from in/out vs start/end. */
  private timeRemapFilter(speed: number, isAudio: boolean): XmlNode | null {
    if (speed === 1) return null
    return this.filter(
      this.effect('Time Remap', 'timeremap', 'motion', isAudio ? 'audio' : 'video', undefined, [
        this.parameter('variablespeed', 'variablespeed', '0', '1', leaf('value', 0)),
        this.parameter('speed', 'speed', '-100000', '100000', leaf('value', formatFixed(speed * 100, 4))),
        this.parameter('reverse', 'reverse', undefined, undefined, bool('value', false)),
        this.parameter('frameblending', 'frameblending', undefined, undefined, bool('value', false)),
      ]),
    )
  }

  /** Fade-independent linear gain, clamped to Premiere's maximum. */
  private volumeFilters(clip: Clip): XmlNode[] {
    const clampLevel = (v: number) => Math.max(0, Math.min(v, 3.98))
    const frames = keyframeFrames(clip, 'volume')
    let level: XmlNode
    if (frames.length === 0) {
      if (clip.volume === 1) return []
      level = this.scalarParam('level', 'Level', '0', '3.98107', clampLevel(clip.volume), [], 4)
    } else {
      const kfs = frames.map((f) => ({ when: f - clip.startFrame, value: clampLevel(rawVolumeAt(clip, f)) }))
      level = this.scalarParam('level', 'Level', '0', '3.98107', kfs[0].value, kfs, 4)
    }
    return [this.filter(this.effect('Audio Levels', 'audiolevels', 'audio', 'audio', undefined, [level]))]
  }

  private videoFilters(clip: Clip): XmlNode[] {
    return [this.motionFilter(clip), this.cropFilter(clip), this.opacityFilter(clip)].filter((n): n is XmlNode => n !== null)
  }

  /** Basic Motion with only the non-default parameters (all three when keyframed). */
  private motionFilter(clip: Clip): XmlNode | null {
    const sourceWidth = this.media.entry(clip.mediaRef)?.sourceWidth ?? 0
    // Nested transforms use the child sequence canvas.
    const scalePct = (width: number) => (sourceWidth > 0 ? (this.curSeqWidth / sourceWidth) * width * 100 : width * 100)
    // FCP7 center is normalized (0 = frame center).
    const center = (t: Transform) => ({ x: t.centerX - 0.5, y: t.centerY - 0.5 })
    const frames = [...new Set([...keyframeFrames(clip, 'position'), ...keyframeFrames(clip, 'scale'), ...keyframeFrames(clip, 'rotation')])].sort((a, b) => a - b)

    let params: XmlNode[] = []
    if (frames.length === 0) {
      const t = clip.transform
      const c = center(t)
      const scaled = scalePct(t.width)
      const rotated = -t.rotation
      const needsCenter = Math.abs(c.x) > 0.001 || Math.abs(c.y) > 0.001
      const needsScale = Math.abs(scaled - 100) > 0.1
      const needsRotation = Math.abs(rotated) > 0.05
      if (!needsCenter && !needsScale && !needsRotation) return null
      if (needsScale) params.push(this.scalarParam('scale', 'Scale', '0', '1000', scaled))
      if (needsRotation) params.push(this.scalarParam('rotation', 'Rotation', '-100000', '100000', rotated))
      if (needsCenter) params.push(this.centerParam(c))
    } else {
      const scaleKfs = frames.map((f) => ({ when: f - clip.startFrame, value: scalePct(sizeAt(clip, f).a) }))
      const rotationKfs = frames.map((f) => ({ when: f - clip.startFrame, value: -rotationAt(clip, f) }))
      const centerKfs = frames.map((f) => ({ when: f - clip.startFrame, ...center(transformAt(clip, f)) }))
      params = [
        this.scalarParam('scale', 'Scale', '0', '1000', scaleKfs[0].value, scaleKfs),
        this.scalarParam('rotation', 'Rotation', '-100000', '100000', rotationKfs[0].value, rotationKfs),
        this.centerParam(centerKfs[0], centerKfs),
      ]
    }
    return this.filter(this.effect('Basic Motion', 'basic', 'motion', 'video', undefined, params))
  }

  /** Crop fractions → FCP7 percentages. */
  private cropFilter(clip: Clip): XmlNode | null {
    const frames = keyframeFrames(clip, 'crop')
    const c = clip.crop
    if (frames.length === 0 && c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0) return null
    const edge = (id: keyof Crop): XmlNode => {
      if (frames.length === 0) return this.scalarParam(id, id, '0', '100', clip.crop[id] * 100)
      const kfs = frames.map((f) => ({ when: f - clip.startFrame, value: cropAt(clip, f)[id] * 100 }))
      return this.scalarParam(id, id, '0', '100', kfs[0].value, kfs)
    }
    return this.filter(this.effect('Crop', 'crop', 'motion', 'video', 'motion', [edge('left'), edge('right'), edge('top'), edge('bottom')]))
  }

  /** Opacity in its own effect, not inside Basic Motion. */
  private opacityFilter(clip: Clip): XmlNode | null {
    const frames = keyframeFrames(clip, 'opacity')
    let opacity: XmlNode
    if (frames.length === 0) {
      if (clip.opacity === 1) return null
      opacity = this.scalarParam('opacity', 'Opacity', '0', '100', clip.opacity * 100, [], 1)
    } else {
      const kfs = frames.map((f) => ({ when: f - clip.startFrame, value: rawOpacityAt(clip, f) * 100 }))
      opacity = this.scalarParam('opacity', 'Opacity', '0', '100', kfs[0].value, kfs, 1)
    }
    return this.filter(this.effect('Opacity', 'opacity', 'motion', 'video', undefined, [opacity]))
  }

  // ---------- Indexing ----------

  /** Emittable clips sorted by start: resolvable media, or carriers whose trim lies inside the child timeline. */
  private sortEmittable(track: Track): Clip[] {
    return track.clips
      .filter((clip) => {
        if (clip.sourceClipType === 'sequence') {
          const child = this.media.timeline(clip.mediaRef)
          return clip.trimStartFrame < (child ? totalFrames(child) : 0)
        }
        return this.media.path(clip.mediaRef) !== undefined
      })
      .sort((a, b) => a.startFrame - b.startFrame)
  }

  private indexAddresses(sortedTracks: Clip[][], isAudio: boolean): void {
    sortedTracks.forEach((clips, ti) => clips.forEach((clip, ci) => this.clipAddresses.set(clip.id, { trackIndex: ti + 1, clipIndex: ci + 1, isAudio })))
  }

  private indexLinkGroups(timeline: Timeline): void {
    for (const track of timeline.tracks)
      for (const clip of track.clips) {
        if (!clip.linkGroupId) continue
        const group = this.clipsByLinkGroup.get(clip.linkGroupId)
        if (group) group.push(clip)
        else this.clipsByLinkGroup.set(clip.linkGroupId, [clip])
      }
  }

  private sourceDurationFrames(mediaRef: string): number | undefined {
    const entry = this.media.entry(mediaRef)
    if (!entry) return undefined
    return Math.max(0, secondsToFrame(entry.duration, this.fps))
  }

  // ---------- Effect & parameter builders ----------

  private rate(timebase: number, ntsc = false): XmlNode {
    return node('rate', [leaf('timebase', timebase), bool('ntsc', ntsc)])
  }

  private filter(effect: XmlNode): XmlNode {
    return node('filter', [effect])
  }

  private effect(name: string, id: string, type: string, mediatype: string, category?: string, body: XmlNode[] = []): XmlNode {
    return node('effect', [leaf('name', name), leaf('effectid', id), category !== undefined && leaf('effectcategory', category), leaf('effecttype', type), leaf('mediatype', mediatype), ...body])
  }

  private parameter(id: string, name: string, min: string | undefined, max: string | undefined, value: XmlNode, keyframes: { when: number; value: XmlNode }[] = []): XmlNode {
    return node('parameter', [
      leaf('parameterid', id),
      leaf('name', name),
      min !== undefined && leaf('valuemin', min),
      max !== undefined && leaf('valuemax', max),
      value,
      ...keyframes.map((k) => node('keyframe', [leaf('when', k.when), k.value])),
    ])
  }

  private scalarParam(id: string, name: string, min: string, max: string, base: number, keyframes: ScalarKeyframe[] = [], digits = 2): XmlNode {
    return this.parameter(
      id,
      name,
      min,
      max,
      leaf('value', formatFixed(base, digits)),
      keyframes.map((k) => ({ when: k.when, value: leaf('value', formatFixed(k.value, digits)) })),
    )
  }

  private centerParam(base: { x: number; y: number }, keyframes: { when: number; x: number; y: number }[] = []): XmlNode {
    const vec = (x: number, y: number) => node('value', [leaf('horiz', formatFixed(x, 5)), leaf('vert', formatFixed(y, 5))])
    return this.parameter('center', 'Center', undefined, undefined, vec(base.x, base.y), keyframes.map((k) => ({ when: k.when, value: vec(k.x, k.y) })))
  }
}
