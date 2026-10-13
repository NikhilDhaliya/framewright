// Port of the Mac Tests/PalmierProTests/Export/FCPXMLExporterTests.swift (suites "FCPXMLExporter" and
// "FCPXMLExporter — nested timelines"); tests named `mac: …` keep the Mac's fixtures and expected strings.
import { describe, expect, it } from 'vitest'
import { bundledFontInfo, exportFCPXML, fcpxmlNumber, formatRateSuffix, frameDuration, rationalSpeed, rationalTime, videoFormatName } from '../../src/core/interchange'
import { defaultTextStyle, type MediaManifestEntry, type TextStyle } from '../../src/core/model'
import { audioTrack, between, carrier, clip, count, entry, fcpxml, kf, pair, timeline, tf, TMP, track, videoTrack, type Fixture } from './fixtures'

/** Mac `videoEntry(id:in:duration:sourceWidth:sourceHeight:hasAudio:)`. */
const videoEntry = (id: string, o: { duration?: number; sourceWidth?: number; sourceHeight?: number; hasAudio?: boolean } = {}): MediaManifestEntry =>
  entry({ id, type: 'video', path: `${TMP}/${id}.mp4`, duration: o.duration ?? 5, sourceWidth: o.sourceWidth ?? 1920, sourceHeight: o.sourceHeight ?? 1080, ...(o.hasAudio !== undefined ? { hasAudio: o.hasAudio } : {}) })
const audioEntry = (id: string, duration = 5): MediaManifestEntry => entry({ id, type: 'audio', path: `${TMP}/${id}.m4a`, duration })
const style = (p: Partial<TextStyle> = {}): TextStyle => ({ ...defaultTextStyle(), ...p })
const textClip = (content: string, p: { start?: number; duration?: number; style?: TextStyle } = {}) => ({
  ...clip({ id: 'title', mediaRef: 'text', mediaType: 'text', start: p.start ?? 0, duration: p.duration ?? 60 }),
  textContent: content,
  ...(p.style ? { textStyle: p.style } : {}),
})
const one = (c: ReturnType<typeof clip>, fx: Fixture, t: { width?: number; height?: number } = {}) => fcpxml(timeline({ tracks: [c.mediaType === 'audio' ? audioTrack([c]) : videoTrack([c])], ...t }), fx)

describe('FCPXMLExporter (Mac FCPXMLExporterTests)', () => {
  // Document structure

  it('mac: headerHasFcpxmlProjectSequenceAndResources', () => {
    const t = timeline()
    const xml = fcpxml(t)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<!DOCTYPE fcpxml>')
    expect(xml).toContain('<fcpxml version="1.10">')
    expect(xml).toContain('<resources>')
    expect(xml).toContain('<format id="r1"')
    expect(xml).toContain('name="FFVideoFormat1080p30"')
    expect(xml).toContain('colorSpace="1-1-1 (Rec. 709)"')
    expect(xml).toContain('<library>')
    expect(xml).toContain('<event name="Framewright Export">')
    expect(xml).toContain(`<project name="${t.name}">`)
    expect(xml).toContain('<sequence format="r1" duration="0s"')
    expect(xml).toContain('<spine/>')
  })

  it('mac: explicitVersionIsHonoredInHeader', () => {
    expect(fcpxml(timeline(), {}, { version: '1.14' })).toContain('<fcpxml version="1.14">')
  })

  it('mac: clipsReferencingUnresolvableMediaAreSkipped', () => {
    const xml = fcpxml(timeline({ tracks: [videoTrack([clip({ id: 'ghost', mediaRef: 'missing', start: 0, duration: 30 })])] }))
    expect(xml).not.toContain('<asset-clip')
    expect(xml).not.toContain('<ref-clip')
    expect(xml).not.toContain('<media id=')
    expect(xml).not.toContain('ghost')
  })

  it('mac: repeatedMediaRefEmitsOneAssetResource', () => {
    const xml = fcpxml(timeline({ tracks: [videoTrack([clip({ id: 'a', mediaRef: 'shared', start: 0, duration: 30 }), clip({ id: 'b', mediaRef: 'shared', start: 60, duration: 30 })])] }), { entries: [videoEntry('shared')] })
    expect(count(xml, '<asset id="asset')).toBe(1)
    expect(count(xml, '<media id="media')).toBe(0)
    expect(count(xml, '<asset-clip ref="asset1"')).toBe(2)
  })

  it('mac: distinctMediaRefsWithSameSourceFileEmitOneAssetResource', () => {
    const source = `${TMP}/shared-source-6F1C.mp4`
    const entries = [
      entry({ id: 'shared-a', name: 'A', type: 'video', path: source, duration: 5, sourceWidth: 1920, sourceHeight: 1080, hasAudio: true }),
      entry({ id: 'shared-b', name: 'B', type: 'video', path: source, duration: 5, sourceWidth: 1920, sourceHeight: 1080, hasAudio: true }),
    ]
    const xml = fcpxml(timeline({ tracks: [videoTrack([clip({ id: 'a', mediaRef: 'shared-a', start: 0, duration: 30 }), clip({ id: 'b', mediaRef: 'shared-b', start: 60, duration: 30 })])] }), { entries })
    expect(count(xml, '<asset id="asset')).toBe(1)
    expect(count(xml, '<media id="media')).toBe(1)
    expect(count(xml, '<ref-clip ref="media1" name="shared-source-6F1C.mp4"')).toBe(2)
    expect(xml).not.toContain('<asset id="asset2"')
  })

  it("mac: apostropheInSourcePathPercentEncodesInMediaRep", () => {
    const xml = fcpxml(timeline({ tracks: [videoTrack([clip({ id: 'c', mediaRef: "sam's clip", start: 0, duration: 30 })])] }), { entries: [videoEntry("sam's clip")] })
    const rep = between(xml, '<media-rep', '/>')
    expect(rep).toContain('%27')
    expect(rep).not.toContain('&apos;')
  })

  it('mac: stillImageEmitsVideoElementWithTransform', () => {
    const e = entry({ id: 'broll', type: 'image', path: `${TMP}/broll.png`, duration: 0, sourceWidth: 1920, sourceHeight: 1080 })
    const c = { ...clip({ id: 'c', mediaRef: 'broll', mediaType: 'image', start: 0, duration: 30 }), transform: tf({ centerX: 0.25, centerY: 0.75 }) }
    const xml = one(c, { entries: [e] })
    expect(xml).toContain('<video ref="asset1" name="broll.png" lane="1"')
    expect(xml).not.toContain('<ref-clip')
    expect(xml).not.toContain('<media id=')
    expect(xml).toContain('<adjust-transform scale="1 1" anchor="0 0" position="-44.4444 -25"/>')
  })

  it('mac: assetResourcesOmitSyntheticUID', () => {
    const xml = one(clip({ id: 'clip', mediaRef: 'media-v', start: 0, duration: 30 }), { entries: [videoEntry('media-v')] })
    const asset = between(xml, '<asset id="asset1"', '</asset>')
    expect(asset).not.toContain('uid=')
    expect(xml).not.toContain('io.palmier.media.asset')
  })

  it('mac: oneSidedAvClipWrapsAssetInFullMediaCompoundClip', () => {
    const xml = one(clip({ id: 'c', mediaRef: 'media-v', start: 0, duration: 30, trimStart: 20 }), { entries: [videoEntry('media-v', { hasAudio: true })] })
    const compound = between(xml, '<media id="media1"', '</media>')
    expect(compound).toContain('<sequence format="r2" duration="5s"')
    expect(compound).toContain('<asset-clip ref="asset1" name="media-v.mp4" duration="5s" start="0s" offset="0s" format="r2"/>')
    expect(xml).toContain('<ref-clip ref="media1"')
    expect(xml).toContain('srcEnable="video"')
    expect(xml).toContain('<adjust-conform type="fit"/>')
  })

  it('mac: audiolessVideoEmitsFlatAssetClipWithoutCompound', () => {
    const xml = one(clip({ id: 'c', mediaRef: 'media-v', start: 0, duration: 30, trimStart: 20 }), { entries: [videoEntry('media-v')] })
    expect(xml).not.toContain('<media id=')
    expect(xml).not.toContain('<ref-clip')
    expect(xml).toContain('<asset-clip ref="asset1" name="media-v.mp4" lane="1"')
    expect(xml).toContain('<adjust-conform type="fit"/>')
  })

  it('mac: sameMediaRefVideoAndAudioShareOneAsset', () => {
    const v = clip({ id: 'video', mediaRef: 'media-v', mediaType: 'video', start: 0, duration: 30 })
    const a = clip({ id: 'audio', mediaRef: 'media-v', mediaType: 'audio', start: 0, duration: 30 })
    const xml = fcpxml(timeline({ tracks: [videoTrack([v]), audioTrack([a])] }), { entries: [videoEntry('media-v', { hasAudio: true })] })
    expect(xml).not.toContain('<asset id="asset2"')
    const asset = between(xml, '<asset id="asset1"', '</asset>')
    expect(asset).toContain('hasVideo="1"')
    expect(asset).toContain('format="r2"')
    expect(asset).toContain('videoSources="1"')
    expect(asset).toContain('hasAudio="1"')
    expect(asset).toContain('audioSources="1"')
    expect(asset).toContain('audioChannels="2"')
    expect(asset).toContain('audioRate="48000"')
    expect(xml).toContain('<ref-clip ref="media1" name="media-v.mp4" lane="1"')
    expect(xml).toContain('srcEnable="video"')
    expect(xml).toContain('<ref-clip ref="media1" name="media-v.mp4" lane="-1"')
    expect(xml).toContain('srcEnable="audio"')
  })

  it('mac: linkedAvPairCollapsesToOneFlatAssetClip', () => {
    const v = { ...clip({ id: 'video', mediaRef: 'media-v', mediaType: 'video', start: 0, duration: 30 }), linkGroupId: 'pair' }
    const a = { ...clip({ id: 'audio', mediaRef: 'media-v', mediaType: 'audio', start: 0, duration: 30, volume: 0.5 }), linkGroupId: 'pair' }
    const xml = fcpxml(timeline({ tracks: [videoTrack([v]), audioTrack([a])] }), { entries: [videoEntry('media-v', { hasAudio: true })] })
    expect(xml).toContain('<asset-clip ref="asset1" name="media-v.mp4" lane="1"')
    expect(xml).not.toContain('<ref-clip')
    expect(xml).not.toContain('<media id=')
    expect(xml).not.toContain('lane="-1"')
    expect(xml).not.toContain('srcEnable=')
    expect(xml).toContain('<adjust-volume amount="-6.0206"/>')
  })

  it('mac: mutedAudioTrackKeepsLinkedPairSeparate', () => {
    const v = { ...clip({ id: 'video', mediaRef: 'media-v', mediaType: 'video', start: 0, duration: 30 }), linkGroupId: 'pair' }
    const a = { ...clip({ id: 'audio', mediaRef: 'media-v', mediaType: 'audio', start: 0, duration: 30 }), linkGroupId: 'pair' }
    const xml = fcpxml(timeline({ tracks: [videoTrack([v]), { ...audioTrack([a]), muted: true }] }), { entries: [videoEntry('media-v', { hasAudio: true })] })
    expect(xml).toContain('<ref-clip ref="media1" name="media-v.mp4" lane="1"')
    expect(xml).toContain('srcEnable="video"')
    expect(xml).toContain('<ref-clip ref="media1" name="media-v.mp4" lane="-1"')
    expect(xml).toContain('srcEnable="audio"')
    expect(xml).toContain('enabled="0"')
  })

  it('mac: visualTrackLanesPreserveTopOverBottom', () => {
    const t = timeline({ tracks: [videoTrack([clip({ id: 'top', mediaRef: 'media-v', start: 0, duration: 30 })]), videoTrack([clip({ id: 'bottom', mediaRef: 'media-v', start: 0, duration: 30 })])] })
    const xml = fcpxml(t, { entries: [videoEntry('media-v')] })
    expect(xml).toContain('name="media-v.mp4" lane="2" offset="0s"')
    expect(xml).toContain('name="media-v.mp4" lane="1" offset="0s"')
  })

  // Timing & speed

  it('mac: videoClipEmitsFlatAssetClipWithOffsetStartAndDuration', () => {
    const xml = one(clip({ id: 'clip-1', mediaRef: 'media-v', start: 30, duration: 60, trimStart: 10 }), { entries: [videoEntry('media-v')] })
    expect(xml).toContain('<asset-clip ref="asset1" name="media-v.mp4" lane="1"')
    expect(xml).toContain('offset="1s"')
    expect(xml).toContain('start="1/3s"')
    expect(xml).toContain('duration="2s"')
    expect(xml).not.toContain('<timeMap')
  })

  it('mac: speedChangeEmitsWholeMediaTimeMap', () => {
    const xml = one(clip({ id: 'fast', mediaRef: 'media-v', start: 0, duration: 60, trimStart: 10, speed: 2 }), { entries: [videoEntry('media-v')] })
    expect(xml).toContain('offset="0s" start="1/6s" duration="2s"')
    expect(xml).toContain('<timeMap frameSampling="floor">')
    expect(xml).toContain('<timept time="0s" value="0s" interp="linear"/>')
    expect(xml).toContain('<timept time="5/2s" value="5s" interp="linear"/>')
  })

  it('mac: slowMotionEmitsWholeMediaTimeMap', () => {
    const xml = one(clip({ id: 'slow', mediaRef: 'media-v', start: 0, duration: 60, trimStart: 30, speed: 0.5 }), { entries: [videoEntry('media-v')] })
    expect(xml).toContain('start="2s"')
    expect(xml).toContain('<timept time="10s" value="5s" interp="linear"/>')
  })

  it('mac: retimedKeyframeTimeIsOffsetByStart', () => {
    const c = { ...clip({ id: 'z', mediaRef: 'media-v', start: 0, duration: 60, trimStart: 10, speed: 2 }), scaleTrack: track(kf(0, pair(0.5, 0.5), 'linear'), kf(15, pair(1, 1), 'linear')) }
    const xml = one(c, { entries: [videoEntry('media-v')] })
    expect(xml).toContain('start="1/6s"')
    expect(xml).toContain('<keyframe time="1/6s"')
    expect(xml).toContain('<keyframe time="2/3s"')
  })

  // Source timecode

  it('mac: assetAndCompoundStartCarryEmbeddedTimecode', () => {
    const fx = { entries: [videoEntry('media-v', { hasAudio: true })], timecodes: { 'media-v': { frame: 744, quanta: 50, dropFrame: false } } }
    const xml = one(clip({ id: 'c', mediaRef: 'media-v', start: 0, duration: 30, trimStart: 10 }), fx)
    expect(xml).toContain('<asset id="asset1" name="media-v.mp4" start="372/25s"')
    expect(xml).toContain('start="372/25s" offset="0s"')
    expect(xml).toContain('<ref-clip ref="media1" name="media-v.mp4" lane="1" offset="0s" start="1/3s"')
  })

  it('mac: absentTimecodeKeepsZeroBasedStarts', () => {
    const xml = one(clip({ id: 'c', mediaRef: 'media-v', start: 0, duration: 30 }), { entries: [videoEntry('media-v', { hasAudio: true })] })
    expect(xml).toContain('<asset id="asset1" name="media-v.mp4" start="0s"')
  })

  it('mac: unspeededTrimmedKeyframeStaysClipRelative', () => {
    const c = { ...clip({ id: 't', mediaRef: 'media-v', start: 0, duration: 60, trimStart: 10 }), opacityTrack: track(kf(0, 0, 'linear'), kf(30, 1, 'linear')) }
    const xml = one(c, { entries: [videoEntry('media-v')] })
    expect(xml).not.toContain('<timeMap')
    expect(xml).toContain('<keyframe time="0s" curve="linear" value="0"/>')
    expect(xml).toContain('<keyframe time="1s" curve="linear" value="1"/>')
  })

  // Transform, scale, flip

  it('mac: fittedVideoEmitsNoTransform', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), transform: tf({ width: 1, height: 1920 / 1080 / (3413 / 607) }) }
    const xml = one(c, { entries: [videoEntry('media-v', { sourceWidth: 3413, sourceHeight: 607 })] })
    expect(xml).toContain('<format id="r2" name="FFVideoFormat3413x607p30" frameDuration="1/30s" width="3413" height="607" colorSpace="1-1-1 (Rec. 709)"/>')
    expect(xml).not.toContain('<adjust-transform')
  })

  it('mac: ntscSourceFormatUsesFinalCutRateSuffix', () => {
    const xml = one(clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), { entries: [{ ...videoEntry('media-v'), sourceFPS: 29.97 }] })
    expect(xml).toContain('<format id="r2" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>')
  })

  it('mac: customTimelineFormatUsesFinalCutGenericPresetName', () => {
    const xml = one(clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), { entries: [videoEntry('media-v')] }, { width: 1080, height: 1920 })
    expect(xml).toContain('<format id="r1" name="FFVideoFormatRateUndefined" frameDuration="1/30s" width="1080" height="1920" colorSpace="1-1-1 (Rec. 709)"/>')
    expect(xml).toContain('<sequence format="r1"')
  })

  it('mac: centeredUnrotatedVideoOmitsTransform', () => {
    expect(one(clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), { entries: [videoEntry('media-v')] })).not.toContain('<adjust-transform')
  })

  it('mac: videoTransformExportsPositionAndRotation', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), transform: tf({ centerX: 0.25, centerY: 0.75, rotation: 30 }) }
    expect(one(c, { entries: [videoEntry('media-v')] })).toContain('<adjust-transform scale="1 1" rotation="-30" anchor="0 0" position="-44.4444 -25"/>')
  })

  it('mac: scaledVideoExportsScaleRelativeToFit', () => {
    const fitHeight = 1920 / 1080 / (3413 / 607)
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), transform: tf({ width: 0.5, height: fitHeight * 0.5 }) }
    expect(one(c, { entries: [videoEntry('media-v', { sourceWidth: 3413, sourceHeight: 607 })] })).toContain('<adjust-transform scale="0.5 0.5" anchor="0 0" position="0 0"/>')
  })

  it('mac: matchedAspectScaleExportsFractionDirectly', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), transform: tf({ width: 0.5, height: 0.5 }) }
    expect(one(c, { entries: [videoEntry('media-v')] })).toContain('<adjust-transform scale="0.5 0.5" anchor="0 0" position="0 0"/>')
  })

  it('mac: horizontalFlipExportsNegativeScale', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), transform: tf({ flipHorizontal: true }) }
    expect(one(c, { entries: [videoEntry('media-v')] })).toContain('<adjust-transform scale="-1 1" anchor="0 0" position="0 0"/>')
  })

  it('mac: fittedClipPositionDividesOutConformFit', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), transform: tf({ centerX: 0.75, centerY: 0.75, width: 1, height: 81 / 256 }) }
    const xml = one(c, { entries: [videoEntry('media-v', { sourceWidth: 1280, sourceHeight: 720 })] }, { width: 1080, height: 1920 })
    expect(xml).toContain('<adjust-transform scale="1 1" anchor="0 0" position="14.0625 -79.0123"/>')
  })

  it('mac: fcpTargetWritesSpecLiteralPositionAndCrop', () => {
    const c = {
      ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }),
      transform: tf({ centerX: 0.75, centerY: 0.75, width: 1, height: 81 / 256 }),
      crop: { left: 0.2, top: 0.05, right: 0.1, bottom: 0.05 },
    }
    const xml = fcpxml(timeline({ width: 1080, height: 1920, tracks: [videoTrack([c])] }), { entries: [videoEntry('media-v', { sourceWidth: 1280, sourceHeight: 720 })] }, { target: 'fcp' })
    expect(xml).toContain('position="14.0625 -25"')
    expect(xml).toContain('<trim-rect top="5" right="10" bottom="5" left="20"/>')
  })

  it('mac: positionKeyframesExportAsParamAnimation', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), positionTrack: track(kf(0, pair(0, 0), 'linear'), kf(30, pair(0, 0.25), 'linear')) }
    const xml = one(c, { entries: [videoEntry('media-v')] })
    expect(xml).toContain('<param name="position" value="0 0">')
    expect(xml).toContain('<keyframeAnimation>')
    expect(xml).toContain('<keyframe time="0s" curve="linear" value="0 0"/>')
    expect(xml).toContain('<keyframe time="1s" curve="linear" value="0 -25"/>')
  })

  // Crop

  it('mac: cropExportsTrimRectInResolveUnits', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 } }
    const xml = one(c, { entries: [videoEntry('media-v')] })
    expect(xml).toContain('<adjust-crop mode="trim">')
    expect(xml).toContain('<trim-rect top="20" right="53.3333" bottom="40" left="17.7778"/>')
  })

  it('mac: cropOfWideSourceInPortraitSequenceMatchesResolveEncoding', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), crop: { left: 0.2, top: 0.05, right: 0.1, bottom: 0.05 } }
    const xml = one(c, { entries: [videoEntry('media-v', { sourceWidth: 1280, sourceHeight: 720 })] }, { width: 1080, height: 1920 })
    expect(xml).toContain('<trim-rect top="5.9259" right="6.6667" bottom="5.9259" left="13.3333"/>')
  })

  it('mac: identityCropOmitsAdjustCrop', () => {
    expect(one(clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), { entries: [videoEntry('media-v')] })).not.toContain('<adjust-crop')
  })

  // Opacity

  it('mac: clipOpacityExportsAdjustBlend', () => {
    expect(one({ ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), opacity: 0.25 }, { entries: [videoEntry('media-v')] })).toContain('<adjust-blend amount="0.25"/>')
  })

  it('mac: fullyOpaqueClipOmitsAdjustBlend', () => {
    expect(one(clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), { entries: [videoEntry('media-v')] })).not.toContain('<adjust-blend')
  })

  it('mac: opacityKeyframesExportInsideAdjustBlend', () => {
    const c = { ...clip({ id: 'clip-1', mediaRef: 'media-v', start: 0, duration: 60 }), opacityTrack: track(kf(0, 0, 'linear'), kf(30, 1, 'linear')) }
    const xml = one(c, { entries: [videoEntry('media-v')] })
    expect(xml).toContain('<adjust-blend amount="1">')
    expect(xml).toContain('<param name="amount" value="1">')
    expect(xml).toContain('<keyframe time="0s" curve="linear" value="0"/>')
    expect(xml).toContain('<keyframe time="1s" curve="linear" value="1"/>')
  })

  // Volume

  it('mac: reducedVolumeExportsAdjustVolumeInDecibels', () => {
    const c = { ...clip({ id: 'clip-a', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 60 }), volume: 0.5 }
    expect(one(c, { entries: [audioEntry('media-a')] })).toContain('<adjust-volume amount="-6.0206"/>')
  })

  it('mac: unityVolumeOmitsAdjustVolume', () => {
    expect(one(clip({ id: 'clip-a', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 60 }), { entries: [audioEntry('media-a')] })).not.toContain('<adjust-volume')
  })

  it('mac: volumeKeyframesCollapseToStaticLevel', () => {
    const c = { ...clip({ id: 'clip-a', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 60 }), volume: 0.5, volumeTrack: track(kf(0, 0, 'linear'), kf(30, -6, 'linear')) }
    expect(one(c, { entries: [audioEntry('media-a')] })).toContain('<adjust-volume amount="-6.0206"/>')
  })

  // Deliberately not exported

  it('mac: fadesAndChannelLayoutAreNotExported', () => {
    const c = { ...clip({ id: 'audio', mediaRef: 'media-a', mediaType: 'audio', start: 0, duration: 60 }), fadeInFrames: 15 }
    const xml = one(c, { entries: [audioEntry('media-a')] })
    expect(xml).toContain('<asset-clip ref="asset1"')
    expect(xml).not.toContain('srcEnable=')
    expect(xml).not.toContain('<fadeIn')
    expect(xml).not.toContain('<audio-channel-source')
  })

  // Titles

  it('mac: textClipEmitsTitleAndEscapedText', () => {
    const xml = one(textClip('A & B', { start: 30, style: style({ fontName: 'Helvetica', fontSize: 48, isBold: false, alignment: 'left' }) }), {})
    expect(xml).toContain('<effect id="titleBasic"')
    expect(xml).toContain('<title ref="titleBasic" name="A &amp; B"')
    expect(xml).toContain('<text-style ref="textStyle1">A &amp; B</text-style>')
    expect(xml).toContain('font="Helvetica"')
    expect(xml).toContain('fontFace="Regular"')
    expect(xml).toContain('fontSize="48"')
    expect(xml).toContain('alignment="left"')
  })

  it('mac: postScriptFontNameExportsFamilyAndFaceForResolveTitles', () => {
    const xml = one(textClip('Caption', { style: style({ fontName: 'Helvetica-Bold', isBold: true }) }), {})
    expect(xml).toContain('font="Helvetica"')
    expect(xml).toContain('fontFace="Bold"')
  })

  it('mac: explicitFontTraitsOverridePostScriptFontFaceForResolveTitles', () => {
    const xml = one(textClip('Caption', { style: style({ fontName: 'Helvetica-Bold', isBold: false, isItalic: false }) }), {})
    expect(xml).toContain('font="Helvetica"')
    expect(xml).toContain('fontFace="Regular"')
  })

  it('mac: textBorderExportsStrokeColorAndWidth', () => {
    const s = style({ fontSize: 96, border: { enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, width: 7 }, fontScale: 2 })
    const xml = one(textClip('HOOK', { style: s }), {})
    expect(xml).toContain('strokeColor="0 0 0 1"')
    expect(xml).toContain('strokeWidth="14"')
  })

  it('mac: disabledBorderOmitsStroke', () => {
    const xml = one(textClip('HOOK', { style: style() }), {})
    expect(xml).not.toContain('strokeColor=')
    expect(xml).not.toContain('strokeWidth=')
  })

  it('mac: textScaleExportsAsIndependentTitleTransform', () => {
    const c = { ...textClip('WIDE', { style: style({ widthScale: 1.5, heightScale: 0.75 }) }), transform: tf({ width: 0.2, height: 0.1 }), scaleTrack: track(kf(0, pair(0.2, 0.1), 'linear'), kf(30, pair(0.4, 0.2), 'linear')) }
    const xml = one(c, {})
    expect(xml).toContain('<param name="scale" value="1.5 0.75">')
    expect(xml).toContain('<keyframe time="0s" curve="linear" value="1.5 0.75"/>')
    expect(xml).toContain('<keyframe time="1s" curve="linear" value="3 1.5"/>')
  })

  it('mac: titleFontSizeDoesNotScaleWithSequenceHeight', () => {
    const xml = one(textClip('Caption', { style: style({ fontSize: 48 }) }), {}, { width: 720, height: 1280 })
    expect(xml).toContain('fontSize="48"')
    expect(xml).toContain('<adjust-transform scale="1 1" anchor="0 0" position="0 0"/>')
  })

  it('mac: textBoxTransformExportsTitlePositionAndOpacity', () => {
    const c = { ...textClip('Caption'), opacity: 0.5, transform: tf({ centerX: 0.25, centerY: 0.75, width: 0.2, height: 0.1, rotation: 15 }) }
    const xml = one(c, {})
    expect(xml).toContain('<title ref="titleBasic" name="Caption"')
    expect(xml).toContain('<text-style ref="textStyle1">Caption</text-style>')
    expect(xml).toContain('<adjust-conform type="fit"/>')
    expect(xml).toContain('<adjust-transform scale="1 1" anchor="0 0" position="-44.4444 -25"/>')
    expect(xml).not.toContain('<param name="Position"')
    expect(xml).toContain('<adjust-blend amount="0.5"/>')
  })
})

describe('FCPXMLExporter — nested timelines (Mac FCPXMLNestExportTests)', () => {
  const v1 = (hasAudio?: boolean) => videoEntry('v1', hasAudio === undefined ? {} : { hasAudio })
  const lineWith = (xml: string, needle: string) => xml.split('\n').find((l) => l.includes(needle)) ?? ''

  it('mac: nestEmitsCompoundResourceAndRefClip', () => {
    const child = timeline({ name: 'Intro', tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 60 })])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 30)])] })
    const xml = fcpxml(parent, { entries: [v1()], timelines: [child, parent] })
    expect(xml).toContain('<media id="nest1" name="Intro">')
    expect(xml).toContain('<ref-clip ref="nest1"')
    const line = lineWith(xml, '<ref-clip ref="nest1"')
    expect(line).toContain('srcEnable="video"')
    expect(line).toContain('offset="1s"')
    expect(line).toContain('duration="2s"')
    expect(xml).toContain('<asset-clip ref="asset1"')
  })

  it('mac: linkedCarrierPairCollapsesIntoOneRefClip', () => {
    const child = timeline({ tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 60 })]), audioTrack([clip({ mediaRef: 'v1', mediaType: 'audio', start: 0, duration: 60 })])] })
    const video = { ...carrier(child, 0), linkGroupId: 'g1' }
    const audio = { ...clip({ mediaRef: child.id, mediaType: 'audio', start: 0, duration: 60 }), sourceClipType: 'sequence' as const, linkGroupId: 'g1' }
    const xml = fcpxml(timeline({ tracks: [videoTrack([video]), audioTrack([audio])] }), { entries: [v1(true)], timelines: [child] })
    expect(count(xml, '<ref-clip ref="nest1"')).toBe(1)
    expect(lineWith(xml, '<ref-clip ref="nest1"')).not.toContain('srcEnable')
  })

  it('mac: twoLevelNestingEmitsBothCompounds', () => {
    const grandchild = timeline({ name: 'Deep', tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 30 })])] })
    const child = timeline({ tracks: [videoTrack([carrier(grandchild, 0)])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 0)])] })
    const xml = fcpxml(parent, { entries: [v1()], timelines: [grandchild, child, parent] })
    expect(xml).toContain('<media id="nest1"')
    expect(xml).toContain('<media id="nest2" name="Deep">')
    expect(xml).toContain('<ref-clip ref="nest2"')
  })

  it('mac: frozenCarrierClampsToChildContent', () => {
    const child = timeline({ tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 60 })])] })
    const parent = timeline({ tracks: [videoTrack([carrier(child, 0, { duration: 100, trimStart: 10 })])] })
    const line = lineWith(fcpxml(parent, { entries: [v1()], timelines: [child, parent] }), '<ref-clip ref="nest1"')
    expect(line).toContain('start="1/3s"')
    expect(line).toContain('duration="5/3s"')
  })

  it('mac: emptyOrMissingChildDropsCarrier', () => {
    const empty = timeline()
    const orphan = { ...clip({ mediaRef: 'no-such-timeline', start: 60, duration: 30 }), mediaType: 'sequence' as const, sourceClipType: 'sequence' as const }
    const xml = fcpxml(timeline({ tracks: [videoTrack([carrier(empty, 0, { duration: 30 }), orphan])] }), { timelines: [empty] })
    expect(xml).not.toContain('<media id="nest')
    expect(xml).not.toContain('<ref-clip')
  })
})

describe('FCPXML (Linux additions)', () => {
  it('writes the exact document for a linked NTSC A/V pair with source timecode and a title', () => {
    const cam = entry({ id: 'cam', type: 'video', path: '/m/cam a.mov', duration: 4, sourceWidth: 1920, sourceHeight: 1080, sourceFPS: 24000 / 1001, hasAudio: true })
    const v = { ...clip({ id: 'V', mediaRef: 'cam', start: 0, duration: 60, trimStart: 15 }), linkGroupId: 'L' }
    const a = { ...clip({ id: 'A', mediaRef: 'cam', mediaType: 'audio', start: 0, duration: 60, trimStart: 15, volume: 2 }), linkGroupId: 'L' }
    const title = { ...clip({ id: 'T', mediaRef: '', mediaType: 'text', start: 0, duration: 30 }), textContent: 'Hello' }
    const t = timeline({ name: 'Edit', tracks: [videoTrack([title]), videoTrack([v]), audioTrack([a])] })
    const xml = fcpxml(t, { entries: [cam], timecodes: { cam: { frame: 86400, quanta: 24, dropFrame: false, tick: { num: 1001, den: 24000 } } } }, { version: '1.11' })
    expect(xml).toBe(GOLDEN_FCPXML)
  })

  it('percent-encodes media-rep src (sub-delimiters, spaces, #, Unicode)', () => {
    const path = "/home/u/B-roll & co/Ünïcode #1 (take 2)!$'*+,;=@.mov"
    const xml = one(clip({ mediaRef: 'p', start: 0, duration: 10 }), { entries: [entry({ id: 'p', type: 'video', path })] })
    expect(xml).toContain('src="file:///home/u/B-roll%20%26%20co/%C3%9Cn%C3%AFcode%20%231%20%28take%202%29%21%24%27%2A%2B%2C%3B%3D@.mov"')
    expect(xml).toContain('name="Ünïcode #1 (take 2)!$&apos;*+,;=@.mov"')
  })

  it.each([
    [24000 / 1001, 'FFVideoFormat1080p2398', '1001/24000s'],
    [23.976, 'FFVideoFormat1080p2398', '1001/24000s'],
    [29.97, 'FFVideoFormat1080p2997', '1001/30000s'],
    [60000 / 1001, 'FFVideoFormat1080p5994', '1001/60000s'],
    [25, 'FFVideoFormat1080p25', '1/25s'],
  ])('source rate %f → %s with frameDuration %s', (fps, name, fd) => {
    const xml = one(clip({ mediaRef: 'n', start: 0, duration: 10 }), { entries: [entry({ id: 'n', type: 'video', path: '/m/n.mov', duration: 2, sourceWidth: 1920, sourceHeight: 1080, sourceFPS: fps })] })
    expect(xml).toContain(`<format id="r2" name="${name}" frameDuration="${fd}" width="1920" height="1080"`)
  })

  it('names, rates and time encodings match the Mac helpers', () => {
    expect(videoFormatName(1280, 720, 59.94)).toBe('FFVideoFormat720p5994')
    expect(videoFormatName(4096, 2160, 24)).toBe('FFVideoFormat4096x2160p24')
    expect(videoFormatName(1000, 1000, 30)).toBe('FFVideoFormat1000x1000p30')
    expect(formatRateSuffix(50)).toBe('50')
    expect(frameDuration(0)).toBe('1001/1000s')
    expect(rationalTime(0, 7)).toBe('0s')
    expect(rationalTime(90, 30)).toBe('3s')
    expect(rationalTime(-10, 30)).toBe('-1/3s')
    expect(rationalSpeed(1.5)).toEqual({ p: 3, q: 2 })
    expect(rationalSpeed(1 / 3)).toEqual({ p: 1, q: 3 })
    expect(rationalSpeed(0.0001)).toEqual({ p: 1, q: 1 })
    expect(fcpxmlNumber(-0)).toBe('0')
    expect(fcpxmlNumber(0.33333)).toBe('0.3333')
    expect(fcpxmlNumber(2.00004)).toBe('2')
    expect(fcpxmlNumber(-6.020599913)).toBe('-6.0206')
    expect(fcpxmlNumber(0.123456)).toBe('0.1235')
  })

  it('merges assets by canonical path (symlinks) and keeps the first path for name/src', () => {
    const entries = [entry({ id: 'a', type: 'video', path: '/m/link.mov', duration: 2 }), entry({ id: 'b', type: 'video', path: '/m/real.mov', duration: 3 })]
    const t = timeline({ tracks: [videoTrack([clip({ mediaRef: 'a', start: 0, duration: 10 }), clip({ mediaRef: 'b', start: 10, duration: 10 })])] })
    const xml = exportFCPXML({ timeline: t, manifest: { entries }, mediaPaths: { a: '/m/link.mov', b: '/m/real.mov' }, canonicalPaths: { '/m/link.mov': '/m/real.mov', '/m/real.mov': '/m/real.mov' } })
    expect(count(xml, '<asset id=')).toBe(1)
    expect(xml).toContain('<asset id="asset1" name="link.mov" start="0s" duration="3s"')
    expect(count(xml, '<asset-clip ref="asset1"')).toBe(2)
  })

  it('titles use resolved bundled font names and fall back when traits are missing', () => {
    const at = (s: Partial<TextStyle>) => {
      const xml = fcpxml(timeline({ tracks: [videoTrack([textClip('T', { style: style(s) })])] }), {}, { fontInfo: bundledFontInfo })
      return between(xml, '<text-style font=', '/>')
    }
    expect(at({ fontName: 'Poppins', isBold: true, isItalic: true })).toContain('"Poppins" fontFace="Bold Italic"')
    expect(at({ fontName: 'Inter-SemiBold' })).toContain('"Inter" fontFace="SemiBold"')
    expect(at({ fontName: 'Inter', isItalic: true })).toContain('"Inter" fontFace="Italic"')
    expect(at({ fontName: 'Basement Grotesque' })).toContain('"Basement Grotesque" fontFace="Regular"')
    expect(at({ fontName: 'Comic Neue-Bold', isBold: true })).toContain('"Comic Neue" fontFace="Bold"')
  })

  it('applies the font case to the displayed title text but not the title name', () => {
    const xml = one(textClip('Hello World', { style: style({ fontCase: 'uppercase' }) }), {})
    expect(xml).toContain('<title ref="titleBasic" name="Hello World"')
    expect(xml).toContain('<text-style ref="textStyle1">HELLO WORLD</text-style>')
  })

  it('numbers text styles in emission order: nested titles first, then the root', () => {
    const child = timeline({ name: 'Lower third', tracks: [videoTrack([{ ...textClip('Inner'), id: 'inner' }])] })
    const parent = timeline({ tracks: [videoTrack([{ ...textClip('Outer', { start: 0, duration: 30 }), id: 'outer' }]), videoTrack([carrier(child, 0)])] })
    const xml = fcpxml(parent, { timelines: [child] })
    expect(xml).toContain('<text-style ref="textStyle1">Inner</text-style>')
    expect(xml).toContain('<text-style ref="textStyle2">Outer</text-style>')
    expect(xml.indexOf('<media id="nest1" name="Lower third">')).toBeLessThan(xml.indexOf('<library>'))
  })

  it('gives differently sized nests their own format and keeps root-sized nests on r1', () => {
    const e = videoEntry('v1')
    const square = timeline({ name: 'Square', width: 1080, height: 1080, tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 30 })])] })
    const same = timeline({ name: 'Same', tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 30 })])] })
    const parent = timeline({ tracks: [videoTrack([carrier(square, 0), carrier(same, 30)])] })
    const xml = fcpxml(parent, { entries: [e], timelines: [square, same] })
    expect(xml).toContain('<format id="nest1Format" name="FFVideoFormatRateUndefined" frameDuration="1/30s" width="1080" height="1080" colorSpace="1-1-1 (Rec. 709)"/>')
    expect(xml).toContain('<sequence format="nest1Format" duration="1s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">')
    expect(xml).toContain('<media id="nest2" name="Same">\n      <sequence format="r1"')
    expect(xml).not.toContain('nest2Format')
  })

  it('caps nest discovery at depth 8', () => {
    const e = videoEntry('v1')
    let inner = timeline({ name: 'L10', tracks: [videoTrack([clip({ mediaRef: 'v1', start: 0, duration: 30 })])] })
    const all = [inner]
    for (let level = 9; level >= 1; level--) {
      inner = timeline({ name: `L${level}`, tracks: [videoTrack([carrier(inner, 0)])] })
      all.push(inner)
    }
    const root = timeline({ tracks: [videoTrack([carrier(inner, 0)])] })
    const xml = fcpxml(root, { entries: [e], timelines: all })
    expect(xml).toContain('<media id="nest8" name="L8">')
    expect(xml).not.toContain('<media id="nest9"')
    expect(xml).not.toContain('<asset id=')
  })

  it('retimed clips at 1.5× use rational speed in start, time map and keyframe times', () => {
    const c = { ...clip({ mediaRef: 'r', start: 30, duration: 40, trimStart: 9, speed: 1.5 }), rotationTrack: track(kf(0, 0), kf(10, 45, 'linear')) }
    const xml = one(c, { entries: [videoEntry('r', { duration: 4 })] })
    // start = 9·2/(30·3) = 1/5s; media 120f → output 120·2/(30·3) = 8/3s.
    expect(xml).toContain('offset="1s" start="1/5s" duration="4/3s"')
    expect(xml).toContain('<timept time="8/3s" value="4s" interp="linear"/>')
    expect(xml).toContain('<param name="rotation" value="0">')
    expect(xml).toContain('<keyframe time="1/5s" value="0"/>')
    expect(xml).toContain('<keyframe time="8/15s" curve="linear" value="-45"/>')
  })
})

const GOLDEN_FCPXML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
    <effect id="titleBasic" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>
    <format id="r2" name="FFVideoFormat1080p2398" frameDuration="1001/24000s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
    <asset id="asset1" name="cam a.mov" start="18018/5s" duration="4s" hasVideo="1" videoSources="1" format="r2" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="file:///m/cam%20a.mov"/>
    </asset>
  </resources>
  <library>
    <event name="Framewright Export">
      <project name="Edit">
        <sequence format="r1" duration="2s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="Timeline" offset="0s" start="0s" duration="2s">
              <asset-clip ref="asset1" name="cam a.mov" lane="1" offset="0s" start="36041/10s" duration="2s" enabled="1">
                <adjust-conform type="fit"/>
                <adjust-volume amount="6.0206"/>
              </asset-clip>
              <title ref="titleBasic" name="Hello" lane="2" offset="0s" start="0s" duration="1s" enabled="1">
                <text>
                  <text-style ref="textStyle1">Hello</text-style>
                </text>
                <text-style-def id="textStyle1">
                  <text-style font="Helvetica" fontFace="Regular" fontSize="96" fontColor="1 1 1 1" alignment="center"/>
                </text-style-def>
                <adjust-conform type="fit"/>
                <adjust-transform scale="1 1" anchor="0 0" position="0 0"/>
              </title>
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`
