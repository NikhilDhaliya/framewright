// Port of the Mac Tests/PalmierProTests/Export/XMLExporterTests.swift (suites "XMLExporter" and
// "XMLExporter — nested timelines"); tests named `mac: …` keep the Mac's fixtures and expected strings.
import { describe, expect, it } from 'vitest'
import { newClip } from '../../src/core/model'
import { totalFrames } from '../../src/core/timeline'
import {
  audioManifestEntry,
  audioTrack,
  carrier,
  clip,
  count,
  entry,
  kf,
  pair,
  timeline,
  tf,
  TMP,
  track,
  videoManifestEntry,
  videoTrack,
  xmeml,
  type Fixture,
} from './fixtures'

/** Mac `fixture(width:height:sourceFPS:)`: a 5 s "media-1" video with source dimensions. */
const kfFixture = (o: { width?: number; height?: number; sourceFPS?: number } = {}): Fixture => ({
  entries: [
    entry({ id: 'media-1', name: 'Clip', type: 'video', path: `${TMP}/kf.mov`, duration: 5, sourceWidth: o.width ?? 3840, sourceHeight: o.height ?? 2160, ...(o.sourceFPS !== undefined ? { sourceFPS: o.sourceFPS } : {}) }),
  ],
})

/** Mac `export(_:resolver:)`: one clip on a video or audio track of a 30 fps timeline. */
const exportOne = (c: ReturnType<typeof clip>, fx: Fixture) => xmeml(timeline({ tracks: [c.mediaType === 'audio' ? audioTrack([c]) : videoTrack([c])] }), fx)

describe('XMLExporter (Mac XMLExporterTests)', () => {
  it('mac: headerHasXmemlVersionAndSequenceShell', () => {
    const xml = xmeml(timeline())
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<xmeml version="4">')
    expect(xml).toContain('<sequence id="sequence-1">')
    expect(xml).toContain('<timebase>30</timebase>')
    expect(xml).toContain('<width>1920</width>')
    expect(xml).toContain('<height>1080</height>')
    expect(xml).toContain('</xmeml>')
  })

  it('mac: headerReportsTimelineFpsAndCanvasDimensions', () => {
    const xml = xmeml(timeline({ fps: 24, width: 1280, height: 720 }))
    expect(xml).toContain('<timebase>24</timebase>')
    expect(xml).toContain('<width>1280</width>')
    expect(xml).toContain('<height>720</height>')
  })

  it('mac: emptyTimelineProducesZeroDuration', () => {
    expect(xmeml(timeline())).toContain('<duration>0</duration>')
  })

  it('mac: videoClipEmitsClipitemWithStartAndEnd', () => {
    const fx = { entries: [entry({ id: 'media-video', name: 'MyVideo', type: 'video', path: `${TMP}/video.mp4`, duration: 5 })] }
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'clip-1', mediaRef: 'media-video', start: 30, duration: 60 })])] }), fx)
    expect(xml).toContain('<clipitem id="clipitem-clip-1">')
    expect(xml).toContain('<name>MyVideo</name>')
    expect(xml).toContain('<start>30</start>')
    expect(xml).toContain('<end>90</end>')
  })

  it('mac: clipsReferencingUnresolvableMediaAreSkipped', () => {
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'ghost-clip', mediaRef: 'missing-media', start: 0, duration: 30 })])] }))
    expect(xml).not.toContain('ghost-clip')
    expect(xml).not.toContain('clipitem')
  })

  it('mac: repeatedMediaRefEmitsFileOnceThenReferences', () => {
    const fx = { entries: [entry({ id: 'shared-media', name: 'Shared', type: 'video', path: `${TMP}/video.mp4`, duration: 10 })] }
    const t = timeline({ tracks: [videoTrack([clip({ id: 'c1', mediaRef: 'shared-media', start: 0, duration: 30 }), clip({ id: 'c2', mediaRef: 'shared-media', start: 60, duration: 30 })])] })
    const xml = xmeml(t, fx)
    expect(count(xml, '<file id="file-shared-media-video">')).toBe(1)
    expect(count(xml, '<file id="file-shared-media-video"/>')).toBe(1)
  })

  it('mac: audioClipAppearsInAudioSectionOnly', () => {
    const xml = xmeml(timeline({ tracks: [audioTrack([clip({ id: 'audio-clip', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 30 })])] }), { entries: [audioManifestEntry('media-a')] })
    const audioSec = xml.indexOf('<audio>')
    const videoSecEnd = xml.indexOf('<video>') + '<video>'.length
    const r = xml.indexOf('audio-clip')
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeGreaterThan(audioSec)
    expect(r).toBeGreaterThan(videoSecEnd)
  })

  it('mac: linkedClipsEmitCrossReferences', () => {
    const fx = {
      entries: [
        entry({ id: 'media-v', name: 'v', type: 'video', path: `${TMP}/v.mp4`, duration: 1 }),
        entry({ id: 'media-a', name: 'a', type: 'audio', path: `${TMP}/a.m4a`, duration: 1 }),
      ],
    }
    const v = { ...clip({ id: 'vc', mediaRef: 'media-v', start: 0, duration: 30 }), linkGroupId: 'group-1' }
    const a = { ...clip({ id: 'ac', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 30 }), linkGroupId: 'group-1' }
    const xml = xmeml(timeline({ tracks: [videoTrack([v]), audioTrack([a])] }), fx)
    expect(xml).toContain('<linkclipref>clipitem-vc</linkclipref>')
    expect(xml).toContain('<linkclipref>clipitem-ac</linkclipref>')
    expect(xml).toContain('<mediatype>video</mediatype>')
    expect(xml).toContain('<mediatype>audio</mediatype>')
  })

  it('mac: unlinkedClipsEmitNoLinkBlocks', () => {
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'lone', mediaRef: 'media-v', start: 0, duration: 30 })])] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml).not.toContain('<link>')
    expect(xml).not.toContain('<linkclipref>')
  })

  it('mac: speedNotOneEmitsTimeRemapFilter', () => {
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'c1', mediaRef: 'media-v', start: 0, duration: 60, speed: 2 })])] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml).toContain('<effectid>timeremap</effectid>')
    expect(xml).toContain('<value>200.0000</value>')
  })

  it('mac: speedOneEmitsNoTimeRemapFilter', () => {
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'c1', mediaRef: 'media-v', start: 0, duration: 60, speed: 1 })])] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml).not.toContain('timeremap')
  })

  it('mac: volumeNotOneEmitsAudioLevelsFilter', () => {
    const xml = xmeml(timeline({ tracks: [audioTrack([clip({ id: 'c1', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 60, volume: 0.5 })])] }), { entries: [audioManifestEntry('media-a')] })
    expect(xml).toContain('<effectid>audiolevels</effectid>')
    expect(xml).toContain('<value>0.5000</value>')
  })

  it('mac: volumeAtUnityEmitsNoAudioLevelsFilter', () => {
    const xml = xmeml(timeline({ tracks: [audioTrack([clip({ id: 'c1', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 60, volume: 1 })])] }), { entries: [audioManifestEntry('media-a')] })
    expect(xml).not.toContain('audiolevels')
  })

  it('mac: opacityNotOneEmitsDedicatedOpacityEffect', () => {
    const c = { ...clip({ id: 'c1', mediaRef: 'media-v', start: 0, duration: 30 }), opacity: 0.5 }
    const xml = xmeml(timeline({ tracks: [videoTrack([c])] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml).toContain('<effectid>opacity</effectid>')
    expect(xml).toContain('<parameterid>opacity</parameterid>')
    expect(xml).toContain('<value>50.0</value>')
  })

  it('mac: nonDefaultTransformEmitsMotionFilterWithMatchingParams', () => {
    const c = { ...clip({ id: 'c1', mediaRef: 'media-v', start: 0, duration: 30 }), transform: tf({ centerX: 0.6, centerY: 0.4, width: 0.5, height: 0.5, rotation: 45 }) }
    const xml = xmeml(timeline({ tracks: [videoTrack([c])] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml).toContain('<effectid>basic</effectid>')
    expect(xml).toContain('<parameterid>scale</parameterid>')
    expect(xml).toContain('<parameterid>rotation</parameterid>')
    expect(xml).toContain('<parameterid>center</parameterid>')
    expect(xml).toContain('<value>-45.00</value>')
    expect(xml).toContain('<value>50.00</value>')
  })

  it('mac: defaultClipEmitsNoMotionFilter', () => {
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'c1', mediaRef: 'media-v', start: 0, duration: 30 })])] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml).not.toContain('<effectid>basic</effectid>')
  })

  it('mac: textClipsAreNotEmitted', () => {
    const t = timeline({ tracks: [videoTrack([clip({ id: 'vc', mediaRef: 'media-v', start: 0, duration: 30 }), clip({ id: 'tc', mediaRef: 'text-no-manifest', mediaType: 'text', start: 0, duration: 30 })])] })
    const xml = xmeml(t, { entries: [videoManifestEntry('media-v')] })
    expect(xml).not.toContain('clipitem-tc')
    expect(xml).toContain('clipitem-vc')
  })

  it('mac: mutedAudioTrackEmitsEnabledFalse', () => {
    const tr = { ...audioTrack([clip({ id: 'ac', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 30 })]), muted: true }
    const xml = xmeml(timeline({ tracks: [tr] }), { entries: [audioManifestEntry('media-a')] })
    expect(xml.slice(xml.indexOf('<audio>'))).toContain('<enabled>FALSE</enabled>')
  })

  it('mac: hiddenVideoTrackEmitsEnabledFalse', () => {
    const tr = { ...videoTrack([clip({ id: 'vc', mediaRef: 'media-v', start: 0, duration: 30 })]), hidden: true }
    const xml = xmeml(timeline({ tracks: [tr] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml.slice(xml.indexOf('<video>'), xml.indexOf('</video>') + '</video>'.length)).toContain('<enabled>FALSE</enabled>')
  })

  it('mac: specialCharsInClipNameAreXMLEscaped', () => {
    const fx = { entries: [entry({ id: 'media-v', name: 'A & B < C > "D" \'E\'', type: 'video', path: `${TMP}/v.mp4`, duration: 1 })] }
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'c1', mediaRef: 'media-v', start: 0, duration: 30 })])] }), fx)
    expect(xml).toContain('A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;')
    expect(xml).not.toContain('A & B')
  })

  it('mac: trimStartIsReflectedInInOutPoints', () => {
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'c1', mediaRef: 'media-v', start: 0, duration: 60, trimStart: 10 })])] }), { entries: [videoManifestEntry('media-v')] })
    expect(xml).toContain('<in>10</in>')
    expect(xml).toContain('<out>70</out>')
  })

  it('mac: sequenceDurationEqualsTimelineTotalFrames', () => {
    const t = timeline({ tracks: [videoTrack([clip({ id: 'a', mediaRef: 'media-v', start: 0, duration: 50 }), clip({ id: 'b', mediaRef: 'media-v', start: 100, duration: 80 })])] })
    expect(xmeml(t, { entries: [videoManifestEntry('media-v')] })).toContain('<duration>180</duration>')
  })

  it('mac: multipleClipsOnSameTrackAreSortedByStartFrame', () => {
    const t = timeline({ tracks: [videoTrack([clip({ id: 'later', mediaRef: 'media-v', start: 100, duration: 30 }), clip({ id: 'earlier', mediaRef: 'media-v', start: 0, duration: 30 })])] })
    const xml = xmeml(t, { entries: [videoManifestEntry('media-v')] })
    expect(xml.indexOf('earlier')).toBeLessThan(xml.indexOf('later'))
  })

  it('mac: videoTracksAreReversedForFCPConvention', () => {
    const fx = { entries: [entry({ id: 'media-v', name: 'v', type: 'video', path: `${TMP}/v.mp4`, duration: 5 })] }
    const t = timeline({ tracks: [videoTrack([clip({ id: 'top-clip', mediaRef: 'media-v', start: 0, duration: 30 })]), videoTrack([clip({ id: 'bottom-clip', mediaRef: 'media-v', start: 0, duration: 30 })])] })
    const xml = xmeml(t, fx)
    expect(xml.indexOf('bottom-clip') >= 0 && xml.indexOf('top-clip') >= 0).toBe(true)
    expect(xml.indexOf('bottom-clip')).toBeLessThan(xml.indexOf('top-clip'))
  })

  // Keyframes, crop, transitions, NTSC

  it('mac: positionKeyframesEmitVaryingCenter', () => {
    const c = { ...clip({ start: 0, duration: 200 }), positionTrack: track(kf(0, pair(0, 0)), kf(100, pair(0.5, 0.5))) }
    const xml = exportOne(c, kfFixture())
    expect(xml).toContain('<parameterid>center</parameterid>')
    expect(xml).toContain('<horiz>0.50000</horiz>')
    expect(xml).toContain('<vert>0.50000</vert>')
  })

  it('mac: opacityKeyframesEmittedWithClipRelativeWhen', () => {
    const c = { ...clip({ start: 100, duration: 200 }), opacityTrack: track(kf(30, 1.0), kf(150, 0.5)) }
    const xml = exportOne(c, kfFixture())
    expect(xml).toContain('<effectid>opacity</effectid>')
    expect(xml).toContain('<when>30</when>')
    expect(xml).toContain('<value>100.0</value>')
    expect(xml).toContain('<when>150</when>')
    expect(xml).toContain('<value>50.0</value>')
  })

  it('mac: volumeKeyframesEmittedOnAudioClip', () => {
    const c = { ...clip({ mediaType: 'audio', start: 0, duration: 100 }), volumeTrack: track(kf(0, 0), kf(50, -6)) }
    const xml = exportOne(c, kfFixture())
    expect(xml).toContain('<effectid>audiolevels</effectid>')
    expect(xml).toContain('<when>0</when>')
    expect(xml).toContain('<when>50</when>')
    expect(xml).toContain('<keyframe>')
  })

  it('mac: fadesEmitSingleSidedCrossDissolveTransitions', () => {
    const c = { ...clip({ start: 100, duration: 200 }), fadeInFrames: 30, fadeOutFrames: 20 }
    const xml = exportOne(c, kfFixture())
    expect(xml).toContain('<effectid>Cross Dissolve</effectid>')
    expect(xml).toContain('<alignment>start-black</alignment>')
    expect(xml).toContain('<start>100</start>')
    expect(xml).toContain('<end>130</end>')
    expect(xml).toContain('<alignment>end-black</alignment>')
    expect(xml).toContain('<start>280</start>')
    expect(xml).toContain('<end>300</end>')
    expect(xml.indexOf('start-black')).toBeLessThan(xml.indexOf('<clipitem'))
  })

  it('mac: audioClipFadesEmitCrossFadeTransitions', () => {
    const c = { ...clip({ mediaType: 'audio', start: 0, duration: 100 }), fadeInFrames: 10, fadeOutFrames: 15 }
    const xml = exportOne(c, kfFixture())
    expect(xml).toContain('<effectid>KGAudioTransCrossFade0dB</effectid>')
    expect(xml).toContain('<mediatype>audio</mediatype>')
    expect(xml).not.toContain('Cross Dissolve')
    expect(xml).not.toContain('<wipecode>')
    expect(xml).toContain('<start>0</start>')
    expect(xml).toContain('<end>10</end>')
    expect(xml).toContain('<start>85</start>')
    expect(xml).toContain('<end>100</end>')
  })

  it('mac: noFadeEmitsNoTransition', () => {
    expect(exportOne(clip({ start: 0, duration: 100 }), kfFixture())).not.toContain('<transitionitem>')
  })

  it('mac: staticCropEmitsCropFilterAsPercentages', () => {
    const c = { ...clip({ start: 0, duration: 100 }), crop: { left: 0.1, top: 0.25, right: 0.2, bottom: 0.05 } }
    const xml = exportOne(c, kfFixture())
    expect(xml).toContain('<effectid>crop</effectid>')
    expect(xml).toContain('<parameterid>left</parameterid>')
    expect(xml).toContain('<value>10.00</value>')
    expect(xml).toContain('<value>25.00</value>')
    expect(xml).not.toContain('<keyframe>')
  })

  it('mac: cropKeyframesEmitClipRelativeWhen', () => {
    const c = { ...clip({ start: 40, duration: 200 }), cropTrack: track(kf(0, { left: 0, top: 0, right: 0, bottom: 0 }), kf(60, { left: 0.5, top: 0, right: 0, bottom: 0 })) }
    const xml = exportOne(c, kfFixture())
    expect(xml).toContain('<effectid>crop</effectid>')
    expect(xml).toContain('<when>0</when>')
    expect(xml).toContain('<when>60</when>')
    expect(xml).toContain('<value>50.00</value>')
  })

  it('mac: identityCropEmitsNoFilter', () => {
    expect(exportOne(clip({ start: 0, duration: 100 }), kfFixture())).not.toContain('<effectid>crop</effectid>')
  })

  it('mac: ntscSourceMarksFileRateTrue', () => {
    const xml = exportOne(clip({ start: 0, duration: 100 }), kfFixture({ sourceFPS: 30000 / 1001 }))
    expect(xml).toContain('<ntsc>TRUE</ntsc>')
    expect(xml).toContain('<ntsc>FALSE</ntsc>')
  })

  it('mac: cleanFpsSourceStaysNtscFalse', () => {
    expect(exportOne(clip({ start: 0, duration: 100 }), kfFixture({ sourceFPS: 30 }))).not.toContain('<ntsc>TRUE</ntsc>')
  })

  it('mac: noKeyframesStillEmitsStaticValueOnly', () => {
    const xml = exportOne({ ...clip({ start: 0, duration: 100 }), opacity: 0.5 }, kfFixture())
    expect(xml).toContain('<effectid>opacity</effectid>')
    expect(xml).not.toContain('<keyframe>')
  })

  // File-rate in/out (Resolve rejected timeline-rate in/out)

  it('mac: slowerSourceEmitsFileRateInOutAndDuration', () => {
    const fx = { entries: [entry({ id: 'rx', type: 'video', path: `${TMP}/rx.mp4`, duration: 15.2, sourceFPS: 29.97 })] }
    const xml = xmeml(timeline({ fps: 60, tracks: [videoTrack([clip({ id: 'c', mediaRef: 'rx', start: 300, duration: 300, trimStart: 240 })])] }), fx)
    expect(xml).toContain('<in>120</in>')
    expect(xml).toContain('<out>270</out>')
    expect(xml).toContain('<start>300</start>')
    expect(xml).toContain('<end>600</end>')
    expect(xml).toContain('<duration>456</duration>')
  })

  it('mac: matchingRateKeepsTimelineFrameInOut', () => {
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ id: 'c', mediaRef: 'same', start: 0, duration: 30, trimStart: 12 })])] }), { entries: [videoManifestEntry('same')] })
    expect(xml).toContain('<in>12</in>')
    expect(xml).toContain('<out>42</out>')
  })
})

describe('XMLExporter — nested timelines (Mac XMEMLNestExportTests)', () => {
  const v1 = () => videoManifestEntry('v1')
  const clipitemWith = (xml: string, needle: string) => xml.split('<clipitem').find((s) => s.includes(needle)) ?? ''

  it('mac: nestEmitsInlineSequenceInsideClipitem', () => {
    const child = timeline({ name: 'Intro', tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 60 })])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 30)])] })
    const xml = xmeml(parent, { entries: [v1()], timelines: [child, parent] })
    expect(xml).toContain('<sequence id="sequence-2">')
    expect(xml).toContain('<name>Intro</name>')
    const item = clipitemWith(xml, 'sequence-2')
    expect(item).toContain('<start>30</start>')
    expect(item).toContain('<end>90</end>')
    expect(item).toContain('<in>0</in>')
    expect(item).toContain('<out>60</out>')
    expect(xml).toContain('<pathurl>')
  })

  it('mac: secondCarrierReferencesTheSequenceById', () => {
    const child = timeline({ tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 60 })])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 0), carrier(child, 60)])] })
    const xml = xmeml(parent, { entries: [v1()], timelines: [child, parent] })
    expect(count(xml, '<sequence id="sequence-2">')).toBe(1)
    expect(count(xml, '<sequence id="sequence-2"/>')).toBe(1)
  })

  it('mac: twoLevelNestingEmitsBothSequences', () => {
    const grandchild = timeline({ name: 'Deep', tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 30 })])] })
    const child = timeline({ tracks: [videoTrack([carrier(grandchild, 0)])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 0)])] })
    const xml = xmeml(parent, { entries: [v1()], timelines: [grandchild, child, parent] })
    expect(xml).toContain('<sequence id="sequence-2">')
    expect(xml).toContain('<sequence id="sequence-3">')
    expect(xml).toContain('<name>Deep</name>')
  })

  it('mac: frozenCarrierClampsToChildContent', () => {
    const child = timeline({ tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 60 })])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 0, { duration: 100, trimStart: 10 })])] })
    const item = clipitemWith(xmeml(parent, { entries: [v1()], timelines: [child, parent] }), 'sequence-2')
    expect(item).toContain('<in>10</in>')
    expect(item).toContain('<out>60</out>')
    expect(item).toContain('<end>50</end>')
  })

  it('mac: emptyOrMissingChildDropsCarrier', () => {
    const empty = timeline()
    const orphan = { ...clip({ mediaRef: 'no-such-timeline', start: 60, duration: 30 }), mediaType: 'sequence' as const, sourceClipType: 'sequence' as const }
    const parent = timeline({ tracks: [videoTrack([carrier(empty, 0, { duration: 30 }), orphan])] })
    const xml = xmeml(parent, { timelines: [empty, parent] })
    expect(xml).not.toContain('<clipitem')
    expect(xml).not.toContain('sequence-2')
  })

  it('mac: linkedCarrierPairEmitsLinkedClipitems', () => {
    const child = timeline({ tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 60 })]), audioTrack([clip({ mediaRef: 'v1', mediaType: 'audio', start: 0, duration: 60 })])] })
    const video = { ...carrier(child, 0), linkGroupId: 'g1' }
    const audio = { ...clip({ mediaRef: child.id, mediaType: 'audio', start: 0, duration: 60 }), sourceClipType: 'sequence' as const, linkGroupId: 'g1' }
    const parent = timeline({ tracks: [videoTrack([video]), audioTrack([audio])] })
    const xml = xmeml(parent, { entries: [v1()], timelines: [child, parent] })
    expect(count(xml, '<sequence id="sequence-2">')).toBe(1)
    expect(count(xml, '<sequence id="sequence-2"/>')).toBe(1)
    expect(xml).toContain(`<linkclipref>clipitem-${video.id}</linkclipref>`)
    expect(xml).toContain(`<linkclipref>clipitem-${audio.id}</linkclipref>`)
  })
})

describe('XMEML (Linux additions)', () => {
  it('writes the exact document for a linked A/V pair with a fade, speed and NTSC source', () => {
    const fx = {
      entries: [entry({ id: 'm', name: 'Shot', type: 'video', path: '/media/My Shot #1.mov', duration: 2, sourceWidth: 1920, sourceHeight: 1080, sourceFPS: 30000 / 1001, hasAudio: true })],
      timecodes: { m: { frame: 107892, quanta: 30, dropFrame: true, tick: { num: 1001, den: 30000 } } },
    }
    const v = { ...clip({ id: 'V', mediaRef: 'm', start: 10, duration: 20, trimStart: 4, speed: 1.5 }), linkGroupId: 'L', fadeInFrames: 5 }
    const a = { ...clip({ id: 'A', mediaRef: 'm', mediaType: 'audio', start: 10, duration: 20, trimStart: 4, speed: 1.5, volume: 0.5 }), linkGroupId: 'L' }
    const t = { ...timeline({ name: 'Cut & Paste', tracks: [videoTrack([v]), audioTrack([a])] }) }
    expect(xmeml(t, fx)).toBe(GOLDEN_LINKED)
  })

  it('percent-encodes pathurl like Foundation (spaces, #, %, Unicode) and keeps sub-delimiters', () => {
    const path = "/home/u/Rough cut & B-roll/Café #2 50% (final)!$'*+,;=:@~.mov"
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ mediaRef: 'p', start: 0, duration: 10 })])] }), { entries: [entry({ id: 'p', type: 'video', path })] })
    expect(xml).toContain("<pathurl>file://localhost///home/u/Rough%20cut%20&amp;%20B-roll/Caf%C3%A9%20%232%2050%25%20(final)!$&apos;*+,;=:@~.mov</pathurl>")
    expect(xml).toContain("<name>Café #2 50% (final)!$&apos;*+,;=:@~.mov</name>")
  })

  it.each([
    [24000 / 1001, 24, 'TRUE'],
    [29.97, 30, 'TRUE'],
    [60000 / 1001, 60, 'TRUE'],
    [25, 25, 'FALSE'],
  ])('file rate for %f fps is timebase %i ntsc %s and in/out stay in file frames', (fps, timebase, ntsc) => {
    const fx = { entries: [entry({ id: 'n', type: 'video', path: '/m/n.mov', duration: 10, sourceFPS: fps })] }
    const xml = xmeml(timeline({ fps: 30, tracks: [videoTrack([clip({ mediaRef: 'n', start: 0, duration: 30, trimStart: 30 })])] }), fx)
    const file = xml.slice(xml.indexOf('<file id="file-n-video">'))
    expect(file).toContain(`<timebase>${timebase}</timebase>\n                <ntsc>${ntsc}</ntsc>`)
    const fileFps = ntsc === 'TRUE' ? (timebase * 1000) / 1001 : timebase
    const scale = fileFps / 30
    const ff = (x: number) => (Math.abs(scale - 1) < 1e-4 ? x : Math.round(x * scale))
    expect(xml).toContain(`<in>${ff(30)}</in>`)
    expect(xml).toContain(`<out>${ff(60)}</out>`)
    expect(file).toContain(`<duration>${Math.round(10 * fileFps)}</duration>`)
  })

  it('drop-frame source timecode at 59.94 formats with semicolons and DF display', () => {
    const fx = { entries: [entry({ id: 'd', type: 'video', path: '/m/d.mov', duration: 1, sourceFPS: 60000 / 1001 })], timecodes: { d: { frame: 215784, quanta: 60, dropFrame: true } } }
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ mediaRef: 'd', start: 0, duration: 10 })])] }), fx)
    expect(xml).toContain('<string>01;00;00;00</string>')
    expect(xml).toContain('<frame>215784</frame>')
    expect(xml).toContain('<displayformat>DF</displayformat>')
  })

  it('keyframed Basic Motion writes all three parameters, including -0.00 rotation like printf', () => {
    const c = { ...clip({ mediaRef: 'k', start: 5, duration: 50 }), scaleTrack: track(kf(0, pair(1, 1)), kf(10, pair(0.5, 0.5), 'linear')) }
    const xml = xmeml(timeline({ tracks: [videoTrack([c])] }), { entries: [entry({ id: 'k', type: 'video', path: '/m/k.mov', duration: 5, sourceWidth: 1920, sourceHeight: 1080 })] })
    const basic = xml.slice(xml.indexOf('<effectid>basic</effectid>'), xml.indexOf('</filter>', xml.indexOf('<effectid>basic</effectid>')))
    expect(basic).toContain('<when>0</when>\n')
    expect(basic).toContain('<value>50.00</value>')
    expect(basic).toContain('<value>-0.00</value>')
    expect(basic).toContain('<horiz>0.00000</horiz>')
    expect(count(basic, '<keyframe>')).toBe(6)
  })

  it('image file nodes carry duration 1 and a still-frame video media block', () => {
    const fx = { entries: [entry({ id: 'img', type: 'image', path: '/m/still.png', duration: 0, sourceWidth: 640, sourceHeight: 480 })] }
    const xml = xmeml(timeline({ tracks: [videoTrack([clip({ mediaRef: 'img', mediaType: 'image', start: 0, duration: 90 })])] }), fx)
    expect(xml).toContain('<video>\n                  <duration>1</duration>\n                  <samplecharacteristics>\n                    <width>640</width>')
  })

  it('nested sequences use their own canvas width for Basic Motion scale', () => {
    const fx = { entries: [entry({ id: 'w', type: 'video', path: '/m/w.mov', duration: 5, sourceWidth: 1920, sourceHeight: 1080 })] }
    const inner = { ...clip({ mediaRef: 'w', start: 0, duration: 30 }), transform: tf({ width: 0.5, height: 0.5 }) }
    const child = timeline({ width: 960, height: 540, tracks: [videoTrack([inner])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 0)])] })
    const xml = xmeml(parent, { ...fx, timelines: [child] })
    expect(xml).toContain('<value>25.00</value>')
    expect(totalFrames(child)).toBe(30)
  })

  it('carrier with an unresolvable child timeline is dropped, carriers reference the root id map', () => {
    const lone = newClip({ mediaRef: 'nope', mediaType: 'sequence', sourceClipType: 'sequence', startFrame: 0, durationFrames: 10 })
    expect(xmeml(timeline({ tracks: [videoTrack([lone])] }))).not.toContain('<clipitem')
  })
})

const GOLDEN_LINKED = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>Cut &amp; Paste</name>
    <duration>30</duration>
    <rate>
      <timebase>30</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <timecode>
      <rate>
        <timebase>30</timebase>
        <ntsc>FALSE</ntsc>
      </rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <source>source</source>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>1920</width>
            <height>1080</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
            <rate>
              <timebase>30</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
          </samplecharacteristics>
        </format>
        <track>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
          <transitionitem>
            <start>10</start>
            <end>15</end>
            <alignment>start-black</alignment>
            <cutPointTicks>0</cutPointTicks>
            <rate>
              <timebase>30</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <effect>
              <name>Cross Dissolve</name>
              <effectid>Cross Dissolve</effectid>
              <effectcategory>Dissolve</effectcategory>
              <effecttype>transition</effecttype>
              <mediatype>video</mediatype>
              <wipecode>0</wipecode>
              <wipeaccuracy>100</wipeaccuracy>
              <startratio>0</startratio>
              <endratio>1</endratio>
              <reverse>FALSE</reverse>
            </effect>
          </transitionitem>
          <clipitem id="clipitem-V">
            <masterclipid>masterclip-L</masterclipid>
            <name>Shot</name>
            <enabled>TRUE</enabled>
            <duration>60</duration>
            <rate>
              <timebase>30</timebase>
              <ntsc>TRUE</ntsc>
            </rate>
            <start>10</start>
            <end>30</end>
            <in>4</in>
            <out>34</out>
            <file id="file-m-video">
              <name>My Shot #1.mov</name>
              <pathurl>file://localhost///media/My%20Shot%20%231.mov</pathurl>
              <rate>
                <timebase>30</timebase>
                <ntsc>TRUE</ntsc>
              </rate>
              <duration>60</duration>
              <timecode>
                <rate>
                  <timebase>30</timebase>
                  <ntsc>TRUE</ntsc>
                </rate>
                <string>01;00;00;00</string>
                <frame>107892</frame>
                <displayformat>DF</displayformat>
              </timecode>
              <media>
                <video>
                  <samplecharacteristics>
                    <width>1920</width>
                    <height>1080</height>
                    <anamorphic>FALSE</anamorphic>
                    <pixelaspectratio>square</pixelaspectratio>
                    <fielddominance>none</fielddominance>
                    <rate>
                      <timebase>30</timebase>
                      <ntsc>TRUE</ntsc>
                    </rate>
                  </samplecharacteristics>
                </video>
              </media>
            </file>
            <filter>
              <effect>
                <name>Time Remap</name>
                <effectid>timeremap</effectid>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>
                <parameter>
                  <parameterid>variablespeed</parameterid>
                  <name>variablespeed</name>
                  <valuemin>0</valuemin>
                  <valuemax>1</valuemax>
                  <value>0</value>
                </parameter>
                <parameter>
                  <parameterid>speed</parameterid>
                  <name>speed</name>
                  <valuemin>-100000</valuemin>
                  <valuemax>100000</valuemax>
                  <value>150.0000</value>
                </parameter>
                <parameter>
                  <parameterid>reverse</parameterid>
                  <name>reverse</name>
                  <value>FALSE</value>
                </parameter>
                <parameter>
                  <parameterid>frameblending</parameterid>
                  <name>frameblending</name>
                  <value>FALSE</value>
                </parameter>
              </effect>
            </filter>
            <link>
              <linkclipref>clipitem-V</linkclipref>
              <mediatype>video</mediatype>
              <trackindex>1</trackindex>
              <clipindex>1</clipindex>
            </link>
            <link>
              <linkclipref>clipitem-A</linkclipref>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
              <clipindex>1</clipindex>
            </link>
          </clipitem>
        </track>
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format>
          <samplecharacteristics>
            <samplerate>48000</samplerate>
            <depth>16</depth>
          </samplecharacteristics>
        </format>
        <outputs>
          <group>
            <index>1</index>
            <numchannels>2</numchannels>
            <downmix>0</downmix>
            <channel>
              <index>1</index>
            </channel>
            <channel>
              <index>2</index>
            </channel>
          </group>
        </outputs>
        <track>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
          <clipitem id="clipitem-A">
            <masterclipid>masterclip-L</masterclipid>
            <name>Shot</name>
            <enabled>TRUE</enabled>
            <duration>60</duration>
            <rate>
              <timebase>30</timebase>
              <ntsc>TRUE</ntsc>
            </rate>
            <start>10</start>
            <end>30</end>
            <in>4</in>
            <out>34</out>
            <file id="file-m-audio">
              <name>My Shot #1.mov</name>
              <pathurl>file://localhost///media/My%20Shot%20%231.mov</pathurl>
              <rate>
                <timebase>30</timebase>
                <ntsc>TRUE</ntsc>
              </rate>
              <duration>60</duration>
              <timecode>
                <rate>
                  <timebase>30</timebase>
                  <ntsc>TRUE</ntsc>
                </rate>
                <string>01;00;00;00</string>
                <frame>107892</frame>
                <displayformat>DF</displayformat>
              </timecode>
              <media>
                <audio>
                  <samplecharacteristics>
                    <samplerate>48000</samplerate>
                    <depth>16</depth>
                  </samplecharacteristics>
                  <channelcount>2</channelcount>
                </audio>
              </media>
            </file>
            <filter>
              <effect>
                <name>Time Remap</name>
                <effectid>timeremap</effectid>
                <effecttype>motion</effecttype>
                <mediatype>audio</mediatype>
                <parameter>
                  <parameterid>variablespeed</parameterid>
                  <name>variablespeed</name>
                  <valuemin>0</valuemin>
                  <valuemax>1</valuemax>
                  <value>0</value>
                </parameter>
                <parameter>
                  <parameterid>speed</parameterid>
                  <name>speed</name>
                  <valuemin>-100000</valuemin>
                  <valuemax>100000</valuemax>
                  <value>150.0000</value>
                </parameter>
                <parameter>
                  <parameterid>reverse</parameterid>
                  <name>reverse</name>
                  <value>FALSE</value>
                </parameter>
                <parameter>
                  <parameterid>frameblending</parameterid>
                  <name>frameblending</name>
                  <value>FALSE</value>
                </parameter>
              </effect>
            </filter>
            <filter>
              <effect>
                <name>Audio Levels</name>
                <effectid>audiolevels</effectid>
                <effecttype>audio</effecttype>
                <mediatype>audio</mediatype>
                <parameter>
                  <parameterid>level</parameterid>
                  <name>Level</name>
                  <valuemin>0</valuemin>
                  <valuemax>3.98107</valuemax>
                  <value>0.5000</value>
                </parameter>
              </effect>
            </filter>
            <link>
              <linkclipref>clipitem-V</linkclipref>
              <mediatype>video</mediatype>
              <trackindex>1</trackindex>
              <clipindex>1</clipindex>
            </link>
            <link>
              <linkclipref>clipitem-A</linkclipref>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
              <clipindex>1</clipindex>
            </link>
          </clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>`
