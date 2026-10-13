export const ComponentSize = {
  timelineClipBorderMinWidth: 8,
  timelineClipDetailMinWidth: 32,
  timelineClipControlsMinWidth: 48,
  timelineClipLabelMinWidth: 56,
  timelineTabRenameWidth: 120,
  timelineKeyframeLaneHeight: 24,
  timelineKeyframeDiamondSize: 8,
  timelineKeyframeHitSize: 14,
  timelineKeyframeTrackHeaderMinimumWidth: 220,
  timelineKeyframeResizeHandleWidth: 31,
  timelineBadgePadH: 4,
  timelineBadgeMinWidth: 16,
  timelineDotSize: 5,
  projectCardWidth: 150,
  projectSearchWidth: 260,
} as const

export const EditorPanel = {
  labelColumnWidth: 88,
  rowMinHeight: 22,
  numericFieldWidth: 56,
  compactNumericFieldWidth: 36,
  fontMenuWidth: 160,
  textEditorMinHeight: 96,
  keyframeStripWidth: 34,
} as const

export const Layout = {
  mediaPanelDefault: 500,
  mediaPanelMin: 352,
  inspectorDefault: 340,
  inspectorMin: 300,
  panelHeaderHeight: 30,
  toolbarHeight: 36,
  timelineMinHeight: 100,
  timelineDefaultHeightFraction: 0.35,
  rulerHeight: 28,
  dropZoneHeight: 32,
  insertThreshold: 10,
  dragThreshold: 3,
  previewMinWidth: 400,
  previewMinHeight: 320,
  trackHeaderDefaultWidth: 160,
  trackHeaderMinimumWidth: 112,
  trackHeaderMaximumWidth: 320,
  trackHeaderResizeHitWidth: 8,
} as const

export const Snap = { thresholdPixels: 8, stickyMultiplier: 1.5, playheadMultiplier: 1.5 } as const
export const TrackSize = { defaultHeight: 44, minHeight: 32, maxHeight: 200, resizeHandleZone: 6 } as const
export const Zoom = { min: 0.05, floor: 0.0001, max: 40, toolbarStepFactor: 1.25, altScrollSensitivity: 0.04, pinchSensitivity: 0.01, panSpeed: 5, defaultPpf: 4 } as const
export const AutoScroll = { edgeZoneWidth: 56, maxZoneFraction: 0.5, minStep: 4, maxStep: 28 } as const
export const Trim = { handleWidth: 4, clipCornerRadius: 4 } as const
export const TimelineMarker = { flagWidth: 10, flagHeight: 12, rangeBarHeight: 4, hitSlop: 3, editorWidth: 320, timeFieldWidth: 82 } as const
export const AudioMeter = { panelWidth: 32, barWidth: 8, floorDb: -60, ceilingDb: 0, yellowDb: -20, redDb: -6, levelDecayDbPerSec: 24, peakDecayDbPerSec: 18, peakHoldSec: 1.5 } as const
export const PreviewZoom = { min: 0.1, max: 8 } as const

export const MARKER_COLORS = [
  '#4094FF', '#40CCE6', '#40BF5C', '#F2C72E', '#FF8C26', '#E64040', '#F259A6',
  '#A666F2', '#8CBFFF', '#73E6B8', '#A6D936', '#C79E6B', '#D1D1D1',
] as const
