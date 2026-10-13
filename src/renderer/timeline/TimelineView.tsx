import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { MediaManifestEntry, MulticamSource, Timeline } from '@core/model'
import { projectOps } from '@core/ops'
import { linkTargets } from '@core/ops/agent'
import { gapAt, rippleDeleteGapRefusal, type DropTarget } from '@core/ops/clips'
import type { Doc } from '@core/ops/context'
import { displayFrames, expandToLinkGroup } from '@core/timeline'
import { propertyTrack } from '@core/ops/properties'
import { askSettingsMismatch } from '../state/dialogs'
import { editor, selectClips, setEditor, useEditor } from '../state/editor'
import { clearPreview, previewOp, runOp } from '../state/ops'
import { playheadFrame, usePlayhead } from '../state/playback'
import { timelineOf, useProject } from '../state/project'
import { rippleMarkersEnabled } from '../state/settings'
import { openMenu, tidy, type MenuItem } from '../ui/Menu'
import { activeDrag, decodeDragItems, droppedPaths, isFileDrag, type DragItem } from '../media/drag'
import { importMedia } from '../media/actions'
import { pasteAt, rippleDeleteSelection, selectForward, nestSelection, linkSelection, unlinkSelection, copySelection } from './actions'
import { onPaletteChange, palette } from './colors'
import { TimelineController, type TimelineModel } from './controller'
import { drawContent, drawOverlay, linkOffsets, type Scene } from './draw'
import { contentBottom, dropTargetAt, frameAtX, insertionLineY, layoutsFor } from './geometry'
import { onMediaCacheChange } from './mediaCache'
import { useAudio } from '../audio/store'
import { Snapper, snapTargets } from './snap'
import { activateTimeline } from './tabs'
import { TrackHeaders } from './TrackHeaders'
import { setScroll, setViewport, setZoom, useTimelineView } from './view'
import { MarkerEditor } from './MarkerEditor'
import { addClipsToChat, addRangeToChat } from '../agent/store'
import { isSubtitleAsset, placeSubtitleAssets } from '../media/captions/subtitles'
import { clipAIEditMenuItem, transitionMenuItem } from '../generation/aiEdit'
import { clipMediaMenuItems, saveRangeMenuItem } from '../extras/menus'
import { clipSyncMenuItems, deadAirSpanMenu } from '../audio/menus'
import { clearAgentActivity, isEmpty as agentIdle, timingOf as agentTiming, useAgentActivity } from './agentActivity'
import { drawAgentGlows } from './agentGlow'
import { syncPendingReplacements, usePendingReplacements } from '../generation/pendingReplacements'
import { useOffline } from '../media/offline'
import { clipSwapMenuItem, decomposeMenuItem, multicamMenuItems, pasteSettingsMenuItem, switchAngleInRangeItem } from './clipMenus'
import { t, tk, tx } from '../i18n'

const INTERP_LABEL = { linear: tk('Linear'), smooth: tk('Smooth'), hold: tk('Hold') }

const memo = <A extends object, R>(fn: (a: A) => R) => {
  let key: A | null = null
  let value: R
  return (a: A): R => {
    if (a !== key) {
      key = a
      value = fn(a)
    }
    return value
  }
}

const assetsOf = memo((m: Doc['manifest']) => new Map<string, MediaManifestEntry>(m.entries.map((e) => [e.id, e])))
const timelinesOf = memo((tl: Timeline[]) => new Map(tl.map((t) => [t.id, t])))
const offsetsOf = memo((t: Timeline) => linkOffsets(t))
const multicamOf = memo((groups: MulticamSource[]) => new Map(groups.map((g) => [g.id, g])))
const NO_GROUPS: MulticamSource[] = []

function currentModel(): TimelineModel | null {
  const { snapshot, preview } = useProject.getState()
  if (!snapshot) return null
  const doc = preview ?? snapshot.doc
  const t = timelineOf(doc)
  const base = timelineOf(snapshot.doc)
  if (!t || !base) return null
  const v = useTimelineView.getState()
  return { doc, baseDoc: snapshot.doc, t, base, layouts: layoutsFor(t, v.lanes), ppf: v.zoom, scrollX: v.scrollX, scrollY: v.scrollY, width: v.viewportWidth, height: v.viewportHeight }
}

export function contentSize(m: TimelineModel): { w: number; h: number } {
  return {
    w: Math.max(m.width, m.ppf * displayFrames(m.t) + 0.5 * m.width),
    h: m.t.tracks.length ? Math.max(m.height, contentBottom(m.layouts) + 32) : m.height,
  }
}

function sizeCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1
  const bw = Math.max(1, Math.round(w * dpr))
  const bh = Math.max(1, Math.round(h * dpr))
  if (c.width !== bw || c.height !== bh) {
    c.width = bw
    c.height = bh
    c.style.width = `${w}px`
    c.style.height = `${h}px`
  }
  const ctx = c.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

interface DropState {
  key: string
  target: DropTarget
  frame: number
  ripple: boolean
}

export function TimelineView() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const agentRef = useRef<HTMLCanvasElement>(null)
  const drawFlags = useRef({ content: false, overlay: false, agent: false, raf: 0 })
  const dropRef = useRef<DropState | null>(null)
  const dropSnap = useRef<Snapper | null>(null)

  const schedule = useMemo(() => {
    const flush = () => {
      const f = drawFlags.current
      f.raf = 0
      const m = currentModel()
      const scroller = scrollRef.current
      if (!m || !scroller || m.width <= 0) return
      const size = contentSize(m)
      const spacer = spacerRef.current!
      if (spacer.style.width !== `${size.w}px`) spacer.style.width = `${size.w}px`
      if (spacer.style.height !== `${size.h}px`) spacer.style.height = `${size.h}px`
      if (Math.abs(scroller.scrollLeft - m.scrollX) > 0.5) scroller.scrollLeft = m.scrollX
      if (Math.abs(scroller.scrollTop - m.scrollY) > 0.5) scroller.scrollTop = m.scrollY
      const sticky = stickyRef.current!
      sticky.style.width = `${m.width}px`
      sticky.style.height = `${m.height}px`
      if (f.content) {
        f.content = false
        const ed = editor()
        const scene: Scene = {
          t: m.t,
          layouts: m.layouts,
          ppf: m.ppf,
          scrollX: m.scrollX,
          scrollY: m.scrollY,
          width: m.width,
          height: m.height,
          selected: new Set(ed.selectedClipIds),
          selectedMarkers: new Set(ed.selectedMarkerIds),
          gap: ed.selectedGap,
          range: ed.range,
          hoverClipId: controller.hoverClipId,
          visual: controller.visual,
          palette: palette(),
          assets: assetsOf(m.doc.manifest),
          timelines: timelinesOf(m.doc.file.timelines),
          offsets: offsetsOf(m.t),
          pendingReplacements: usePendingReplacements.getState().byClip,
          multicam: multicamOf(m.doc.file.multicamGroups ?? NO_GROUPS),
          offline: useOffline.getState().offline,
        }
        drawContent(sizeCanvas(contentRef.current!, m.width, m.height), scene)
        f.agent = true
      }
      if (f.agent) {
        f.agent = false
        drawAgentGlows(sizeCanvas(agentRef.current!, m.width, m.height), m, useAgentActivity.getState())
      }
      if (f.overlay) {
        f.overlay = false
        drawOverlay(sizeCanvas(overlayRef.current!, m.width, m.height), { width: m.width, height: m.height, ppf: m.ppf, scrollX: m.scrollX, playhead: playheadFrame(), visual: controller.visual, palette: palette() })
      }
    }
    return (content: boolean, overlay: boolean) => {
      const f = drawFlags.current
      f.content ||= content
      f.overlay ||= overlay
      if (!f.raf) f.raf = requestAnimationFrame(flush)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const controller = useMemo(
    () =>
      new TimelineController({
        model: currentModel,
        rect: () => scrollRef.current!.getBoundingClientRect(),
        redraw: () => schedule(true, true),
        setCursor: (c) => {
          if (overlayRef.current && overlayRef.current.style.cursor !== c) overlayRef.current.style.cursor = c
        },
      }),
    [schedule],
  )

  useLayoutEffect(() => {
    const el = scrollRef.current!
    const ro = new ResizeObserver(() => {
      setViewport(el.clientWidth, el.clientHeight)
      schedule(true, true)
    })
    ro.observe(el)
    const subs = [
      useProject.subscribe((s, p) => {
        if (s.snapshot !== p.snapshot || s.preview !== p.preview) schedule(true, true)
      }),
      useEditor.subscribe((s, p) => {
        if (s.selectedClipIds !== p.selectedClipIds || s.selectedMarkerIds !== p.selectedMarkerIds || s.selectedGap !== p.selectedGap || s.range !== p.range) schedule(true, false)
      }),
      useTimelineView.subscribe(() => schedule(true, true)),
      usePlayhead.subscribe((s, p) => {
        if (s.frame === p.frame) return
        const v = useTimelineView.getState()
        if (s.playing && !controller.dragging) {
          const x = s.frame * v.zoom - v.scrollX
          if (x < 60 || x > v.viewportWidth - 60) setScroll(s.frame * v.zoom - 0.25 * v.viewportWidth)
        }
        schedule(false, true)
      }),
      onMediaCacheChange(() => schedule(true, false)),
      useAudio.subscribe((st, prev) => {
        if (st.quiet !== prev.quiet || st.beats !== prev.beats || st.silence !== prev.silence || st.markDeadAir !== prev.markDeadAir || st.markBeats !== prev.markBeats || st.speakerMasks !== prev.speakerMasks || st.markSpeakers !== prev.markSpeakers) schedule(true, false)
      }),
      onPaletteChange(() => schedule(true, true)),
      // Agent activity glows (Mac AgentActivityLayerSupport): repaint the rings; restart hold/fade per revision.
      useAgentActivity.subscribe((a, prev) => {
        drawFlags.current.agent = true
        schedule(false, false)
        const el = agentRef.current
        if (!el || a.revision === prev.revision) return
        el.getAnimations().forEach((x) => x.cancel())
        if (agentIdle(a)) el.style.opacity = '0'
        else if (a.isActive) el.style.opacity = '1'
        else {
          el.style.opacity = '0'
          const { hold, duration } = agentTiming(a)
          el.animate(
            [
              { opacity: 1, offset: 0, easing: 'linear' },
              { opacity: 1, offset: hold / duration, easing: 'ease-out' },
              { opacity: 0, offset: 1 },
            ],
            { duration: duration * 1000 },
          )
        }
      }),
      // Mac clearTimelineScopedState: switching timelines drops the highlight.
      useProject.subscribe((s, p) => {
        if (s.snapshot?.doc.file.activeTimelineId !== p.snapshot?.doc.file.activeTimelineId) clearAgentActivity()
        if (s.snapshot !== p.snapshot) syncPendingReplacements(s.snapshot?.doc ?? null)
      }),
      usePendingReplacements.subscribe(() => schedule(true, false)),
      useOffline.subscribe((s, p) => s.offline !== p.offline && schedule(true, false)),
    ]
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.altKey) return
      e.preventDefault()
      const v = useTimelineView.getState()
      const anchor = e.clientX - el.getBoundingClientRect().left
      const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / 40
      const factor = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : Math.exp(-lines * 0.1)
      setZoom(v.zoom * factor, anchor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && controller.cancel()) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    schedule(true, true)
    return () => {
      ro.disconnect()
      for (const u of subs) u()
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [schedule, controller])

  // ---------- External drops (§6.13) ----------

  const dropItems = (): DragItem[] => (activeDrag.items ?? []).filter((it) => it.kind !== 'folder')

  const clearDrop = () => {
    dropRef.current = null
    dropSnap.current = null
    controller.visual.insertionY = null
    controller.visual.ghostIds = undefined
    controller.visual.rippleInsert = null
    controller.visual.snapFrame = null
    clearPreview()
    schedule(true, true)
  }

  const onDragOver = (e: React.DragEvent) => {
    const items = dropItems()
    const files = isFileDrag(e)
    if (!items.length && !files) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const m = currentModel()
    if (!m) return
    const p = controller.pointer(e, m)
    const target = dropTargetAt(m.layouts, p.cy)
    const durations = items.map((it) => {
      const a = m.doc.manifest.entries.find((x) => x.id === it.id)
      const t = m.doc.file.timelines.find((x) => x.id === it.id)
      const seconds = it.kind === 'asset' && it.segment ? it.segment.upper - it.segment.lower : (a?.duration ?? (t ? displayFrames(t) / t.fps : 0))
      return Math.max(1, Math.trunc(seconds * m.t.fps))
    })
    const total = durations.reduce((s, d) => s + d, 0)
    dropSnap.current ??= new Snapper(snapTargets(m.base, {}))
    const f = frameAtX(p.cx, m.ppf)
    const s = dropSnap.current.find(f, [0, total], m.ppf)
    const frame = Math.max(0, s ? s.frame - s.probeOffset : f)
    const ripple = e.ctrlKey
    const key = `${JSON.stringify(target)}|${frame}|${ripple}`
    if (dropRef.current?.key === key) return
    dropRef.current = { key, target, frame, ripple }
    controller.visual.snapFrame = s?.frame ?? null
    controller.visual.insertionY = 'newAt' in target ? insertionLineY(m.layouts, target.newAt) : null
    controller.visual.rippleInsert = ripple && total ? { frame, push: total } : null
    if (items.length) {
      const baseIds = new Set(m.base.tracks.flatMap((tr) => tr.clips.map((c) => c.id)))
      const segments = Object.fromEntries(items.flatMap((it) => (it.kind === 'asset' && it.segment ? [[it.id, it.segment]] : [])))
      if (previewOp('dropAssets', { assetIds: items.map((it) => it.id), target, atFrame: frame, ripple, segments, rippleMarkers: rippleMarkersEnabled() })) {
        const t = currentModel()?.t
        controller.visual.ghostIds = new Set(t ? t.tracks.flatMap((tr) => tr.clips.filter((c) => !baseIds.has(c.id)).map((c) => c.id)) : [])
        controller.visual.ghostAlpha = 0.5
      } else clearPreview()
    }
    schedule(true, true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    clearDrop()
  }

  const onDrop = async (e: React.DragEvent) => {
    const state = dropRef.current
    const internal = decodeDragItems(e.dataTransfer.getData('text/plain')).filter((it) => it.kind !== 'folder')
    const paths = internal.length ? [] : droppedPaths(e)
    e.preventDefault()
    clearDrop()
    if (!state || (!internal.length && !paths.length)) return
    const imported = internal.length ? internal.map((it) => it.id) : await importMedia(paths)
    // Subtitle assets become caption groups on their own new top tracks (spec 07 §1.8), never clips.
    const subtitles = imported.filter(isSubtitleAsset)
    if (subtitles.length) void placeSubtitleAssets(subtitles)
    const assetIds = imported.filter((id) => !subtitles.includes(id))
    if (!assetIds.length) return
    const segments = Object.fromEntries(internal.flatMap((it) => (it.kind === 'asset' && it.segment ? [[it.id, it.segment]] : [])))
    const doc = useProject.getState().snapshot?.doc
    const check = doc ? projectOps.checkProjectSettings(doc, assetIds) : null
    if (check) {
      const change = check.adoptSilently ? true : await askSettingsMismatch(check.suggestion)
      if (change === null) return
      if (change) await runOp('applyProjectSettings', check.suggestion)
    }
    const ids = await runOp('dropAssets', { assetIds, target: state.target, atFrame: state.frame, ripple: state.ripple, segments, rippleMarkers: rippleMarkersEnabled() })
    if (ids?.length) selectClips(ids)
  }

  // ---------- Context menus (§6.14, local features only) ----------

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const m = currentModel()
    if (!m) return
    const p = controller.pointer(e, m)
    const hit = controller.hitTest(m, p)
    const frame = frameAtX(p.cx, m.ppf)
    const range = editor().range
    const inRange = range && range.start !== range.end && frame >= Math.min(range.start, range.end) && frame < Math.max(range.start, range.end)
    const rangeItems: MenuItem[] = inRange
      ? [{ kind: 'divider' }, { label: t('Add Range to Chat'), onSelect: () => addRangeToChat() }, saveRangeMenuItem(range), ...[switchAngleInRangeItem(m.doc, range)].filter((x): x is MenuItem => !!x), { label: t('Clear Range'), onSelect: () => setEditor({ range: null }) }]
      : []
    const hasClipboard = editor().clipboard.length > 0
    const interp = (current: string | undefined, set: (i: 'linear' | 'smooth' | 'hold') => void, withHold: boolean): MenuItem[] =>
      (withHold ? (['linear', 'smooth', 'hold'] as const) : (['linear', 'smooth'] as const)).map((i) => ({ label: t(INTERP_LABEL[i]), checked: (current ?? 'smooth') === i, onSelect: () => set(i) }))

    if (hit.kind === 'knee') {
      const key = hit.edge === 'in' ? 'fadeInInterpolation' : 'fadeOutInterpolation'
      openMenu(interp(hit.clip[key], (i) => void runOp('setClipProperties', { ids: [hit.clip.id], frame: 0, patch: { [key]: i }, label: 'Change Fade Interpolation' }), false), e.clientX, e.clientY)
      return
    }
    if (hit.kind === 'volumeKey' || (hit.kind === 'lane' && hit.clip && hit.keyframe !== null)) {
      const clip = hit.clip!
      const property = hit.kind === 'lane' ? hit.property : 'volume'
      const kfFrame = hit.kind === 'lane' ? hit.keyframe! : clip.startFrame + hit.frame
      const current = propertyTrack(clip, property)?.keyframes.find((k) => k.frame === kfFrame - clip.startFrame)?.interpolationOut
      openMenu(
        [
          ...interp(current, (i) => void runOp('setKeyframeInterpolation', { id: clip.id, property, frame: kfFrame, interpolation: i }), true),
          { kind: 'divider' },
          { label: t('Delete Keyframe'), onSelect: () => void runOp('deleteKeyframe', { id: clip.id, property, frame: kfFrame }) },
        ],
        e.clientX,
        e.clientY,
      )
      return
    }
    if (hit.kind === 'clip') {
      const deadAir = deadAirSpanMenu(m.doc, hit.clip, frame)
      if (deadAir) {
        openMenu(deadAir, e.clientX, e.clientY)
        return
      }
      if (!editor().selectedClipIds.includes(hit.clip.id)) selectClips(e.altKey ? [hit.clip.id] : [...expandToLinkGroup(m.t, [hit.clip.id])])
      const sel = editor().selectedClipIds
      const canLink = !!linkTargets(m.t, sel)
      const canUnlink = m.t.tracks.some((tr) => tr.clips.some((c) => sel.includes(c.id) && c.linkGroupId))
      const nested = hit.clip.sourceClipType === 'sequence'
      openMenu(
        tidy([
          { label: t('Select Forward on Track'), onSelect: () => selectForward(false, hit.clip.id) },
          { label: t('Select Forward on All Tracks'), onSelect: () => selectForward(true, hit.clip.id) },
          { label: t('Copy'), onSelect: () => void copySelection() },
          hasClipboard && { label: t('Paste'), onSelect: () => void pasteAt(hit.trackIndex, frame) },
          pasteSettingsMenuItem(m.t, hit.clip, sel),
          canLink && { label: t('Link'), onSelect: () => void linkSelection() },
          canUnlink && { label: t('Unlink'), onSelect: () => void unlinkSelection() },
          { kind: 'divider' },
          { label: t('Add to Chat'), onSelect: () => addClipsToChat(sel) },
          clipAIEditMenuItem(hit.clip.id),
          { kind: 'divider' },
          { label: t('Create Nested Timeline'), onSelect: () => void nestSelection() },
          nested && { label: t('Open Timeline'), onSelect: () => activateTimeline(hit.clip.mediaRef) },
          decomposeMenuItem(m.doc, m.t, hit.clip, sel),
          { kind: 'divider' },
          clipSwapMenuItem(m.doc, m.t, hit.clip, sel),
          ...clipMediaMenuItems(m.t, m.doc.manifest.entries, hit.clip),
          { kind: 'divider' },
          ...clipSyncMenuItems(m.doc, hit.clip, sel),
          { kind: 'divider' },
          ...multicamMenuItems(m.doc, m.t, hit.clip),
          ...rangeItems,
        ]),
        e.clientX,
        e.clientY,
      )
      return
    }
    const trackIndex = hit.kind === 'empty' ? hit.trackIndex : hit.kind === 'ruler' || hit.kind === 'marker' ? 0 : null
    const gap = editor().selectedGap
    const gapHere = gap && hit.kind === 'empty' && gap.trackIndex === hit.trackIndex && frame >= gap.start && frame < gap.end ? gap : null
    const refusal = gapHere ? rippleDeleteGapRefusal(m.baseDoc, gapHere) : null
    openMenu(
      tidy([
        { label: t('Paste'), disabled: !hasClipboard, onSelect: () => void pasteAt(trackIndex ?? 0, frame) },
        hit.kind === 'empty' && hit.trackIndex !== null && (() => {
          const g = gapAt(m.t, hit.trackIndex, frame)
          return g ? transitionMenuItem(m.t, g) : null
        })(),
        gapHere && { label: t('Ripple Delete Gap'), disabled: !!refusal, tip: refusal ? tx(refusal) : undefined, onSelect: () => void rippleDeleteSelection() },
        ...rangeItems,
      ]),
      e.clientX,
      e.clientY,
    )
  }

  return (
    <div className="pp-tl-body">
      <TrackHeaders />
      <div
        ref={scrollRef}
        className="pp-tl-scroll"
        onScroll={(e) => setScroll(e.currentTarget.scrollLeft, e.currentTarget.scrollTop)}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        <div ref={spacerRef} className="pp-tl-spacer">
          <div ref={stickyRef} className="pp-tl-sticky">
            <canvas ref={contentRef} className="pp-tl-canvas" />
            <canvas ref={agentRef} className="pp-tl-canvas" style={{ opacity: 0, pointerEvents: 'none' }} />
            <canvas
              ref={overlayRef}
              className="pp-tl-canvas"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.currentTarget.setPointerCapture(e.pointerId)
                controller.down(e.nativeEvent)
              }}
              onPointerMove={(e) => (controller.dragging ? controller.move(e.nativeEvent) : controller.hover(e.nativeEvent))}
              onPointerUp={(e) => void controller.up(e.nativeEvent)}
              onPointerCancel={(e) => void controller.up(e.nativeEvent)}
              onPointerLeave={() => controller.leave()}
              onContextMenu={onContextMenu}
            />
          </div>
        </div>
      </div>
      <MarkerEditor scrollEl={scrollRef} />
    </div>
  )
}

