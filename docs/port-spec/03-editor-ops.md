# 03 — Editor Domain Operations (Timeline Editing Engine)

Implementation-ready spec of Palmier Pro's timeline editing engine, derived from the Swift source
(`Sources/PalmierPro`, read-only reference). It is UI-toolkit independent: everything here must be
implemented as pure TypeScript domain code plus a thin input layer.

Source map (all paths relative to `Sources/PalmierPro/`):

| Area | Files |
|---|---|
| Undo | `Editor/EditorUndo.swift`, `Editor/ViewModel/EditorViewModel+Timelines.swift` (`registerTimelineUndo`), `+ClipMutations.swift` (`withTimelineSwap`, swaps) |
| Pure engines | `Editor/OverwriteEngine.swift`, `Editor/RippleEngine.swift`, `Timeline/SnapEngine.swift`, `Timeline/MulticamEngine.swift`, `Preview/NestFlattener.swift` |
| Clip ops | `+ClipMutations`, `+Ripple`, `+Linking`, `+Clipboard`, `+ClipSettings`, `+Keyframes`, `+Selection`, `+Sync`, `+MediaSwap` |
| Track / timeline / project | `+Tracks`, `+Timelines`, `+TimelineMarkers`, `+TimelineRange`, `+Nesting`, `+ProjectSettings`, `+Multicam`, `+Layout` |
| Media | `+MediaLibrary`, `+Folders`, `+Relink`, `+MediaPanel` (delete) |
| Models | `Models/Timeline.swift` (Timeline/Track/Clip/Transform/Crop), `Models/Keyframe.swift`, `Models/ClipEffectKeyframes.swift`, `Models/TimelineMarker.swift`, `Models/MulticamSource.swift`, `Models/VideoLayout.swift`, `Models/ClipType.swift` |
| Input / geometry | `Timeline/TimelineInputController.swift`, `Timeline/TimelineGeometry.swift`, `Timeline/DragState.swift`, `Timeline/TimelineRangeSelection.swift`, `Timeline/TimelineView.swift` (context menus, drops), `Timeline/TimelineHeaderView.swift` |
| Shortcuts | `Editor/EditorWindowController.swift` (key monitor), `App/MainMenu.swift`, `Help/ShortcutsPane.swift`, `Toolbar/ToolbarView.swift` |
| Constants | `Utilities/Constants.swift`, `UI/AppTheme.swift`, `Timeline/ClipRenderer.swift`, `Inspector/InspectorView.swift` (`VolumeScale`) |

Sections marked **[QUIRK]** describe source behaviour that is surprising or buggy. Port it faithfully
unless the port explicitly decides to fix it (§17 lists recommended fixes). Sections marked
**[NOT IN SOURCE]** answer requested features that Palmier Pro does not implement.

---

## 0. Conventions

### 0.1 Units

- All timeline positions/lengths are **integer frames at the project fps** (`timeline.fps`, default 30).
- `trimStartFrame` / `trimEndFrame` are **source frames measured at the timeline fps** (not the media's
  native fps). Source length of an asset in these units = `secondsToFrame(asset.duration, fps)`.
- Intervals are half-open: a clip occupies `[startFrame, endFrame)` with `endFrame = startFrame + durationFrames`.
- `speed` is a playback-rate multiplier (`1.0` normal, `2.0` = twice as fast; source consumed per timeline frame).

### 0.2 Rounding helpers (must match Swift exactly)

| Swift | Meaning | TypeScript |
|---|---|---|
| `x.rounded()` / `Int(x.rounded())` | round half **away from zero** | `roundHalfAway(x) = Math.sign(x) * Math.round(Math.abs(x))` (NOT `Math.round`, which rounds -2.5 → -2) |
| `Int(x)` | truncate toward zero | `Math.trunc(x)` |
| `x.rounded(.down)` | floor | `Math.floor(x)` |

```ts
const secondsToFrame = (seconds: number, fps: number) => Math.trunc(seconds * fps); // truncation!
```

Below, `round(x)` always means `roundHalfAway(x)`.

### 0.3 Glossary

- **Link group**: clips sharing `linkGroupId` (typically a video clip and its audio). They select, move, trim,
  slip, split and delete together.
- **Sync-locked track**: `track.syncLocked == true` (**default true** for every new track). Ripple edits shift
  sync-locked tracks too.
- **Zones**: visual tracks occupy indices `[0, firstAudioIndex)`, audio tracks `[firstAudioIndex, trackCount)`.
  `firstAudioIndex = index of first track with type == audio, or trackCount`.
- **Carrier**: a clip with `sourceClipType == 'sequence'` whose `mediaRef` is a child timeline id (nested timeline).
- **Program track** (multicam): the bottom-most video track holding the group's camera fragments.

---

## 1. Minimal model recap (fields the operations touch)

Canonical model and serialization: `01-data-model.md`. UI rendering/layout: `05-ui.md`. This recap only lists
what the operations below read or write.

```ts
interface Timeline {
  id: string; name: string /* "Timeline 1" */; fps: number /* 30 */; width: number /* 1920 */; height: number /* 1080 */;
  settingsConfigured: boolean /* false */; folderId?: string; tracks: Track[]; markers: TimelineMarker[];
}
// derived
totalFrames   = max(0, ...tracks.map(t => max(0, ...t.clips.map(c => c.endFrame))))
displayFrames = markers.reduce((r, m) => max(r, m.startFrame + max(1, m.durationFrames)), totalFrames)

interface Track {
  id: string; type: ClipType /* in practice 'video' | 'audio' */; name?: string;
  muted = false; hidden = false; syncLocked = true; clips: Clip[];
  displayHeight = 44 /* clamped [32, 200] on decode */;
}

interface Clip {
  id: string; mediaRef: string /* asset id, child timeline id, or "" for text */;
  mediaType: ClipType = 'video'; sourceClipType: ClipType = 'video';
  startFrame: number; durationFrames: number; trimStartFrame = 0; trimEndFrame = 0;
  speed = 1.0; volume = 1.0 /* linear gain */;
  fadeInFrames = 0; fadeOutFrames = 0; fadeInInterpolation = 'linear'; fadeOutInterpolation = 'linear';
  opacity = 1.0; transform: Transform; crop: Crop; edgeRounding = 0; edgeSoftness = 0;
  linkGroupId?: string; captionGroupId?: string; multicamGroupId?: string;
  textContent?; textStyle?; textAnimation?; wordTimings?: {text, startFrame, endFrame}[]; textFillMode?;
  opacityTrack?: KeyframeTrack<number>; positionTrack?: KeyframeTrack<AnimPair>; scaleTrack?: KeyframeTrack<AnimPair>;
  rotationTrack?: KeyframeTrack<number>; cropTrack?: KeyframeTrack<Crop>; volumeTrack?: KeyframeTrack<number /* dB */>;
  effects?: Effect[] /* blur keyframes live in effect "blur.gaussian" param "radius".track */; blendMode?;
}
// derived
endFrame              = startFrame + durationFrames
supportsRetiming      = sourceClipType !== 'sequence'
sourceFramesConsumed  = round(durationFrames * speed)
sourceDurationFrames  = sourceFramesConsumed + trimStartFrame + trimEndFrame
contains(f)           = f >= startFrame && f < endFrame

interface Transform { centerX = .5; centerY = .5; width = 1; height = 1; rotation = 0 /*deg, +cw*/;
  rotationX = 0; rotationY = 0; flipHorizontal = false; flipVertical = false }   // normalized canvas units
  topLeft = (centerX - width/2, centerY - height/2)
interface Crop { left = 0; top = 0; right = 0; bottom = 0 }  // normalized source insets; min visible fraction 0.05

type ClipType = 'video'|'audio'|'image'|'text'|'lottie'|'sequence'|'subtitle'
isVisual(t)          = t !== 'audio' && t !== 'subtitle'
isCompatible(a, b)   = a === b || (isVisual(a) && isVisual(b))
```

`TimelineMarker { id; name; startFrame; durationFrames = 0; color: RGBA (default r0 g0.478 b1 a1); comment = ""; status: 'open'|'review'|'resolved' = 'open' }`,
`endFrame = start + duration`, `isRange = durationFrames > 0`.

### 1.1 Invariants maintained by the engine

1. Clips within a track are sorted by `startFrame` after every mutation (`sortClips`).
2. Clips within a track do not overlap — guaranteed by `clearRegion` (overwrite) before placement. Exceptions
   (**[QUIRK]**): speed change with ripple only pushes the *contiguous* chain (§4.13); `MulticamEngine` overlays.
3. Visual tracks are always above audio tracks (`partitionedInsertionIndex`, `reorderTrackLive` clamp).
4. Most clip-placing ops end with `pruneEmptyTracks()` which removes **every** empty track of the active
   timeline (including pre-existing empty ones).
5. Ids are unique project-wide (duplicate timeline / paste / nest regenerate ids).

### 1.2 Non-persisted editor state used by operations

`currentFrame` (playhead, committed) and `activeFrame` (`playheadState.timelineFrame`, live during scrub),
`selectedClipIds: Set`, `selectedGap?: {trackIndex, range}`, `selectedTimelineRange?: {startFrame, endFrame}`,
`selectedTimelineMarkerIds`, `timelineMarkerPreview?`, `clipClipboard: ClipClipboardEntry[]`,
`zoomScale` (pixels/frame), `toolMode`, `dragBefore: Map<clipId, Clip>`, `preDragTimeline?: Timeline`,
`pendingDebouncedCommits`, `rippleTimelineMarkers` (user default, **true**), `markBeats` (default true),
`focusedPanel`, `activePreviewTab`.

`seekToFrame(f) = clamp(f, 0, max(0, totalFrames))`. Step = ±1 frame, skip = ±5 frames.

---

## 2. Undo / redo model

### 2.1 Architecture

Palmier uses **NSUndoManager with inverse closures** ("command" style), but almost every closure is a
**state swap** (restore a snapshot, then register the opposite swap so redo works). The snapshots are of
varying granularity: whole active `Timeline`, a list of `Clip` values, marker list, whole media library,
project-settings snapshot. A few closures are true inverse commands (trim, split, track flag toggles,
renames).

The port should implement an NSUndoManager-equivalent:

```ts
class UndoManager {
  undoStack: Group[] = []; redoStack: Group[] = [];
  isUndoing = false; isRedoing = false; registrationDisabled = 0;
  private open: Group | null = null; groupingLevel = 0;

  beginGroup() { if (this.groupingLevel++ === 0) this.open = { name: '', actions: [] }; }
  endGroup()   { if (--this.groupingLevel === 0) { const g = this.open!; this.open = null;
                   if (g.actions.length) { this.pushTarget().push(g); } } }
  register(fn: () => void) {
    if (this.registrationDisabled) return;
    if (this.isUndoing || this.isRedoing) { this.collecting!.actions.push(fn); return; } // goes to the opposite stack
    this.open!.actions.push(fn);
    this.redoStack.length = 0;                          // a fresh edit clears redo
  }
  undo() { const g = this.undoStack.pop(); if (!g) return;
    this.isUndoing = true; this.collecting = { name: g.name, actions: [] };
    for (const a of [...g.actions].reverse()) a();      // LIFO inside the group
    this.isUndoing = false; if (this.collecting.actions.length) this.redoStack.push(this.collecting); }
  redo() { /* symmetric: pops redoStack, collects into undoStack */ }
}
```

Redo exists **only** if the undo closure registers its own inverse while undoing (see §2.6 for the ops that don't).

### 2.2 `EditorUndo` façade (exact semantics)

```ts
perform(name, work):
  if (!manager || manager.isUndoing || manager.isRedoing) return work();
  if (transactionActive) return work();                  // nested perform coalesces into the outer one
  transactionActive = true; groupOpened = false;
  try { return work(); }
  finally {
    transactionActive = false;
    if (groupOpened) { manager.setActionName(name); manager.endGroup(); onActionCommitted(); }
  }
  // (AppKit "groupsByEvent" is disabled for the duration if groupingLevel==0, so an explicit
  //  transaction is never merged into an implicit per-event group.)

register(name, handler):
  if (!manager || registrationDisabled) return;
  if (!transactionActive && !isUndoing && !isRedoing)
     return perform(name, () => register(name, handler));   // standalone registration = its own undo step
  if (transactionActive && !groupOpened) { manager.beginGroup(); groupOpened = true; }   // lazy
  manager.registerUndo(handler);

withoutRegistration(work): disable registration for the duration of work (nestable).
isRegistrationEnabled: !disabled.
```

Consequences:
- **One `perform` → at most one undo step.** If nothing registered inside, no step is created (no empty steps).
- The group's name is the name passed to the **outermost** `perform`; names of inner registrations are ignored.
- Every registration outside a `perform` becomes its own step.

### 2.3 Registration primitives

`registerTimelineUndo(name, handler)`: captures `tid = activeTimelineId`; the registered closure first does
`if (activeTimelineId !== tid && timelines.has(tid)) activateTimeline(tid)` and then runs `handler`.
Every timeline-scoped undo therefore re-activates (switches tab to) the timeline it belongs to.

**Whole-timeline swap** (the workhorse):
```ts
withTimelineSwap(name, work, refreshVisuals = true):
  const before = deepCopy(activeTimeline);
  undo.withoutRegistration(work);           // ALL nested registrations inside are suppressed
  const after = activeTimeline;
  if (deepEqual(before, after)) return;     // no-op → no undo step
  if (!undo.isRegistrationEnabled) return;  // we are nested inside another withTimelineSwap
  registerTimelineSwap(before, after, name); notifyTimelineChanged(refreshVisuals);

registerTimelineSwap(undoState, redoState, name):
  registerTimelineUndo(name, vm => { vm.setTimeline(undoState); vm.notify();
                                      vm.registerTimelineSwap(redoState, undoState, name); });
```
`setTimeline(t)` replaces `timelines[i]` where `timelines[i].id === t.id` and activates it.

**Clip-state swap** (`mutateClips`, `commitClipProperties`): snapshot `[(id, Clip)]` before and after; the undo
closure writes each stored clip back by id (missing ids skipped) and registers the reverse swap.
`mutateClips(ids, name, modify)` applies `modify` to every clip whose id ∈ ids (all tracks), and registers only
if at least one clip matched (even if `modify` changed nothing — callers guard no-ops themselves).

**Single-clip property swap** (`commitClipProperty`): same, for one clip.

**Marker swap**: whole `timeline.markers` array before/after (`registerTimelineMarkerSwap`), also clears
`timelineMarkerPreview` and intersects `selectedTimelineMarkerIds` with the restored ids.

**Media-library snapshot** (`mediaLibraryUndoSnapshot`): `{timelines (all), activeTimelineId, openTimelineIds,
mediaManifest, mediaAssets, selectedClipIds, selectedMediaAssetIds, selectedFolderIds, previewTabs,
activePreviewTabId, sourcePlayheadFrame}`. Restore = assign all (activate timeline if different), register
reverse restore, refresh. Used for import, media delete, folder delete, "Add Media" drops.

**Project-settings snapshot**: `{timelines (all), currentFrame, sourcePlayheadFrame, liveViewStates}`.

**Parent-change swap** (folders): list of `(id, newParent)`; applying records the inverse list and registers it.

### 2.4 Live-edit (drag / scrub) protocol

Continuous gestures mutate the model **without undo**, then commit one step at the end:

```ts
applyClipProperty(id, modify):            // called on every drag tick / slider change
  if (!dragBefore.has(id)) dragBefore.set(id, copy(clip));   // first tick snapshots the original
  modify(clip) in place; refresh preview (debounced rebuild 120 ms when rebuild=true)

commitClipProperty(id, name, modify):     // mouse-up / slider release / text field commit
  const current = clip; const next = modify(copy(current));
  const before = dragBefore.take(id) ?? current;
  if (current == next && before == next) return;            // nothing changed at all
  write next; if (before != next) registerClipPropertySwap(id, before, next, name);

revertClipProperty(ids): write dragBefore.take(id) back (no undo).
debouncedCommitClipProperties(ids, key, modify, 400ms): apply now, commit after 400 ms of inactivity
  (pending task keyed "clipId:property"; a new call cancels the previous task).
```

Whole-timeline live edits (speed scrub) use `preDragTimeline` (snapshot at first tick) and register one
`registerTimelineSwap(preDragTimeline, current)` at commit.

Switching the active timeline mid-gesture (`activateTimeline`) first reverts: `timeline = preDragTimeline`
if set, else writes every `dragBefore` clip back; then clears `dragBefore`, `preDragTimeline`, selection,
gap, range, marker selection, marker preview, pending media swap.

### 2.5 Grouping rules (what one undo step covers)

1. A user intent wrapped in `perform` or `withTimelineSwap` = one step.
2. `withTimelineSwap` inside `withTimelineSwap` (e.g. `insertTrack` inside `moveClips`) contributes nothing;
   the outer snapshot covers it.
3. `perform` inside `perform` coalesces (e.g. `placeDroppedAssets` = track creation + clip placement).
4. **[QUIRK]** Operations that loop over the selection *outside* a transaction create **one step per
   clip**: `splitAtPlayhead`, `trimStartToPlayhead`, `trimEndToPlayhead` (each iteration calls an op that
   performs its own transaction). Linked partners make this visible: Q on a selected V+A pair creates two
   "Trim Clip" steps. (Split at playhead on a linked pair is one step, because the first split also splits
   the partner and the second iteration becomes a no-op.)
5. Validation/refusals happen before any mutation → no step on refusal.
6. Undo does **not** restore clip/marker selection for timeline/clip swaps (selection may hold stale ids;
   `notifyTimelineChanged` intersects marker selection with existing markers). Media-library snapshots do
   restore selections.

### 2.6 Inverse-command ops and their asymmetries

| Op | Undo closure | Redo? |
|---|---|---|
| `trimClipInternal` | calls `trimClipInternal(prevTrimStart, prevTrimEnd)` (which re-registers) | yes (**[QUIRK]** inverse recomputes timeline deltas through `round(Δsource / speed)`; with speed ≠ 1 the restored `startFrame/durationFrames` can drift by ±1 frame) |
| `splitSingleClip` | remove right half by id, write original clip at left id | **no** — closure does not re-register (**[QUIRK]**); in a split group the only redo action is the link-id swap of right halves, which no longer exist → redo is a no-op |
| `toggleTrackFlag` (mute/hide/sync-lock) | sets the flag back by track id | **no** (**[QUIRK]**) |
| `setTrackHeight`, `applyTrackName`, `renameTimeline`, `renameFolder`, `renameMediaAsset` | call the setter with the old value (re-registers) | yes |
| `createTimeline`/`duplicateTimeline` | `deleteTimeline(id)` (which registers re-insert) | yes |
| `deleteTimeline` | `reinsertTimeline(...)` (registers delete) | yes |
| `createFolder` | `deleteFolders([id])` | yes |
| multicam group metadata insert/remove | symmetric | yes |

Not undoable at all: `relinkAsset`, `relinkOfflineAssets`, single `addMediaAsset`/`importMediaAsset`
(paste-image path), timeline activation, tab open/close, zoom, selection, tool mode, keyframe-lane
expansion, `rippleTimelineMarkers` toggle.

### 2.7 Action-name catalogue

| Operation | Action name(s) | Mechanism |
|---|---|---|
| addClips | "Add Clips" | timeline swap |
| placeDroppedAssets | "Add Clips" (outer perform) | perform{track swaps, timeline swaps} |
| Finder drop onto timeline | "Add Media" | perform{media snapshot + placement} |
| rippleInsertClips (UI) | "Ripple Insert Clips" | timeline swap |
| rippleInsertClips (specs, agent) | "Ripple Insert Clip (Agent)" / "…Clips (Agent)" | timeline swap |
| moveClips | "Move Clip" / "Move Clips" | timeline swap |
| move to new track | "Move Clip to New Track", "Duplicate Clip(s) to New Track" | perform{Add Track swap, move/duplicate swap} |
| duplicate (⌥-drag) | "Duplicate Clip" / "Duplicate Clips" | timeline swap |
| paste | "Paste Clip" / "Paste Clips" | timeline swap |
| removeClips | "Remove Clip" / "Remove Clips" | timeline swap |
| ripple delete clips / gap / ranges | "Ripple Delete" | timeline swap |
| split | "Split Clip" / "Split Clips" | perform{split inverses + clip swap} |
| trim | "Trim Clip" / "Trim Clips" | perform{trim inverses, clearRegion swaps} |
| ripple trim | "Ripple Trim" | timeline swap |
| slip | "Slip Clip" / "Slip Clips" | clip swap |
| speed | "Change Speed" | timeline swap (`preDragTimeline`) |
| link / unlink | "Link" / "Unlink" | clip swap |
| clip properties | "Change Opacity", "Change Blur", "Change Rotation", "Change Volume", "Change Fade In", "Change Fade Out", "Change Fade Interpolation", "Change Position", "Change Scale", "Change Text Size", "Reset Text Size", "Change Transform" (overridable), "Change Crop", "Change Text", "Change Clip Property" (default) | clip swap |
| keyframes | "Add Keyframe", "Delete Keyframe", "Change Interpolation", "Move Keyframe" | clip swap |
| paste settings | "Paste Clip Settings" | clip swap |
| replace / swap media | "Replace Clip Source" | clip swap |
| tracks | "Add Track", "Remove Track(s)", "Reorder Track", "Mute/Unmute Track", "Hide/Show Track", "Sync Lock Track"/"Unlock Track Sync", "Resize Track", "Rename Track" | swap / inverse |
| markers | "Add Marker", "Delete Marker(s)", "Move Marker", "Change Marker Duration", "Edit Marker" | marker swap |
| text clip | "Add Text" | timeline swap |
| nesting | "Nest Timeline", "Nest Clips", "Decompose Nested Timeline" | swap / perform |
| timelines | "New Timeline", "Duplicate Timeline", "Rename Timeline", "Delete Timeline" | inverse |
| media | "Import Media", "Delete Media", "Rename Asset", "New Folder", "Rename Folder", "Delete Folder", "Move to Folder", "Move Folder", media-panel combined delete names | snapshot / inverse |
| project settings | "Change Project Settings" | settings snapshot |
| multicam | "Create Multicam", "Switch Angle", "Switch Mic", "Ungroup Multicam" | perform / swaps |
| sync | "Synchronize" | perform{speed swaps, move swap} |

---

## 3. Pure engines and shared primitives

### 3.1 Overwrite engine (`OverwriteEngine.computeOverwrite`)

Clears `[regionStart, regionEnd)` on one track's clip list.

```ts
type OverwriteAction =
  | { kind: 'remove', clipId }
  | { kind: 'trimEnd', clipId, newDuration }
  | { kind: 'trimStart', clipId, newStartFrame, newTrimStart, newDuration }
  | { kind: 'split', clipId, leftDuration, rightId, rightStartFrame, rightTrimStart, rightDuration };

function computeOverwrite(clips: Clip[], regionStart: number, regionEnd: number): OverwriteAction[] {
  if (regionEnd <= regionStart) return [];
  const out = [];
  for (const c of clips) {                         // track order
    const cs = c.startFrame, ce = c.endFrame;
    if (ce <= regionStart || cs >= regionEnd) continue;              // no overlap
    if (cs >= regionStart && ce <= regionEnd) out.push({ kind: 'remove', clipId: c.id });
    else if (cs < regionStart && ce > regionEnd) out.push({ kind: 'split', clipId: c.id,
        leftDuration: regionStart - cs, rightId: uuid(), rightStartFrame: regionEnd,
        rightTrimStart: c.trimStartFrame + round((regionEnd - cs) * c.speed), rightDuration: ce - regionEnd });
    else if (cs < regionStart) out.push({ kind: 'trimEnd', clipId: c.id, newDuration: regionStart - cs });
    else out.push({ kind: 'trimStart', clipId: c.id, newStartFrame: regionEnd,
        newTrimStart: c.trimStartFrame + round((regionEnd - cs) * c.speed), newDuration: ce - regionEnd });
  }
  return out;
}
```

### 3.2 `clearRegion(trackIndex, start, end, prune = true, excluding = Set())`

Applies `computeOverwrite(track.clips.filter(c => !excluding.has(c.id)), start, end)`:

| Action | Applied as |
|---|---|
| remove | `removeClips([id], prune)` (also removes id from `selectedClipIds`; prunes empty tracks if `prune`) |
| trimEnd | `src = round((c.durationFrames - newDuration) * c.speed)`; `mutateClips([id], "Trim Clip", c => { c.trimEndFrame += src; c.setDuration(newDuration) })` |
| trimStart | `mutateClips([id], "Trim Clip", c => { c.startFrame = newStartFrame; c.trimStartFrame = newTrimStart; c.setDuration(newDuration) })` |
| split | **precomputed values ignored**: `splitClip(id, start)`; `right = track.clips.find(c => c.startFrame === start && c.id !== id)`; if `right.endFrame > end` then `splitClip(right.id, end)`; `removeClips([right.id], prune)` |

**[QUIRK]** Because the split branch uses `splitClip`, it also splits the straddling clip's **linked partners**
(on other tracks) at `start` and `end` without removing them. E.g. overwriting the middle of a linked video
leaves its audio cut into three pieces, the middle one still present.

`Clip.setDuration(n)`: `old = durationFrames; durationFrames = n; rescaleWordTimings(old); clampKeyframesToDuration(); clampFadesToDuration()`.
**[QUIRK]** Head cuts (`trimStart`) do **not** rebase keyframes: keyframe offsets are clip-relative, so moving
`startFrame` right moves all keyframes right in absolute time (only keyframes now past the end are dropped).

Sub-registrations made by `clearRegion` are suppressed when called inside `withTimelineSwap`, and become part
of the surrounding group when called inside `perform` (trim).

### 3.3 Ripple engine (`RippleEngine`)

```ts
interface FrameRange { start: number; end: number }  // length = end - start
interface ClipShift { clipId: string; newStartFrame: number }

function mergeRanges(ranges): FrameRange[] {           // touching ranges merge
  const sorted = [...ranges].sort((a, b) => a.start - b.start); const m = [];
  for (const r of sorted) {
    const last = m[m.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end); else m.push({ ...r });
  }
  return m;
}

// close gaps: each clip moves left by the total length of merged ranges lying entirely before it
function computeRippleShiftsForRanges(clips, removedRanges): ClipShift[] {
  const merged = mergeRanges(removedRanges); if (!merged.length) return [];
  return clips.sort(byStart).flatMap(c => {
    const shift = merged.filter(r => r.end <= c.startFrame).reduce((s, r) => s + (r.end - r.start), 0);
    return shift > 0 ? [{ clipId: c.id, newStartFrame: c.startFrame - shift }] : [];
  });
}
computeRippleShifts(clips, removedIds) =
  computeRippleShiftsForRanges(clips.filter(c => !removedIds.has(c.id)),
                               clips.filter(c => removedIds.has(c.id)).map(c => ({start: c.startFrame, end: c.endFrame})));

// open (or with negative push, close) a gap: every clip starting at/after insertFrame moves by pushAmount
computeRipplePush(clips, insertFrame, pushAmount, excludeIds = new Set()) =
  clips.filter(c => !excludeIds.has(c.id) && c.startFrame >= insertFrame)
       .map(c => ({ clipId: c.id, newStartFrame: c.startFrame + pushAmount }));
```

A clip that *straddles* a removed range is not moved by `computeRippleShiftsForRanges` (only ranges ending
at/before its start count) — callers detect the resulting overlap with `validateShifts`.

**Marker ripple** — applied only when `rippleTimelineMarkers` is on (default on) and the result differs; it
also clears `timelineMarkerPreview`:

```ts
function mapFrame(f, ranges /*merged, sorted*/) {
  let m = f;
  for (const r of ranges) { if (r.end <= f) m -= r.end - r.start; else if (r.start < f) m -= f - r.start; }
  return Math.max(0, m);
}
// trackRanges: one range list per shifting track
function rippleMarkersClosing(markers, trackRanges: FrameRange[][]) {
  const tracks = trackRanges.map(rs => mergeRanges(rs.filter(r => r.end > r.start))).filter(rs => rs.length);
  if (!tracks.length) return markers;
  return markers.flatMap(mk => {
    const surviving = tracks.flatMap(rs => {
      const s = mapFrame(mk.startFrame, rs);
      if (!mk.isRange) return rs.some(r => mk.startFrame >= r.start && mk.startFrame < r.end) ? [] : [[s, s]];
      const e = mapFrame(mk.endFrame, rs);
      return e > s ? [[s, e]] : [];
    });
    if (!surviving.length) return [];                         // marker deleted
    const start = Math.min(...surviving.map(x => x[0]));
    if (!mk.isRange) return [{ ...mk, startFrame: start }];
    const end = Math.min(...surviving.map(x => x[1]));
    return end > start ? [{ ...mk, startFrame: start, durationFrames: end - start }] : [];
  });
}
function rippleMarkersOpening(markers, insertFrame, push) {
  if (push === 0) return markers;
  if (push < 0) return rippleMarkersClosing(markers, [[{ start: insertFrame + push, end: insertFrame }]]);
  return markers.map(mk => mk.startFrame >= insertFrame ? { ...mk, startFrame: mk.startFrame + push }
       : (mk.isRange && mk.endFrame > insertFrame) ? { ...mk, durationFrames: mk.durationFrames + push } : mk);
}
```

### 3.4 `validateShifts(trackIndex, shifts)` (dry run for sync-locked followers)

```ts
if (!shifts.length) return null;
const starts = new Map(shifts.map(s => [s.clipId, s.newStartFrame]));
const iv = track.clips.map(c => { const s = starts.get(c.id) ?? c.startFrame; return { s, e: s + c.durationFrames }; });
if (iv.some(x => x.s < 0)) return `Sync-locked track "${label}" would move past the timeline start.`;
iv.sort((a, b) => a.s - b.s);
for (let i = 1; i < iv.length; i++) if (iv[i].s < iv[i - 1].e) return `Sync-locked track "${label}" doesn't have room to ripple.`;
return null;
```

`label` = `timelineTrackDisplayLabel` (§5.7). Refusals (`refuseRipple`) show the reason as a toast and beep.

### 3.5 Multicam guards (used by edit ops)

```ts
anchorFrame(member, clip, fps) = clip.startFrame - clip.trimStartFrame - round(member.sync.offsetSeconds * fps)

multicamAtomicityViolation(shiftingTrackIds):
  for each multicam group gid present on the timeline: trackIds = tracks holding a clip with that gid
    moving = trackIds ∩ shiftingTrackIds
    if (moving.size && moving.size !== trackIds.size)
      return `Can't shift part of multicam group "${name}" — ${strandedLabels.join(", ")} would stay behind and desync.`

multicamManualRippleViolation(shiftingTrackIds, frame):
  atomicity violation ?? for each shifting track: a clip with multicamGroupId and start < frame < end →
  `Can't ripple through multicam group "${name}" — split its clips at the edit point, or remove silence/words to cut time.`

multicamMoveViolation(moves):                          // moves = [{clipId, toTrack, toFrame}]
  horizontal = some clip.startFrame !== toFrame
  laneChange = some (clip.multicamGroupId && clip.mediaType !== 'audio' && currentTrack !== toTrack)
  if (!horizontal && !laneChange) return null
  if (laneChange) return "Can't move a multicam camera clip to another track — the group's program track stays fixed."
  for each group touched: if any group clip is not in moves →
     `Can't move part of multicam group "${name}" — its clips stay in sync and move together.`

multicamTrimBounds(clip): null unless clip in a group with a member for its mediaRef
  own = anchorFrame(clip); left = clip.trimStartFrame; right = clip.trimEndFrame
  for other group clips with anchorFrame(other) !== own:
    if (other.endFrame <= clip.startFrame) left = min(left, clip.startFrame - other.endFrame)
    if (other.startFrame >= clip.endFrame) right = min(right, other.startFrame - clip.endFrame)
  return { left: max(0, left), right: max(0, right) }

multicamRippleCohort(clip, edge) = clip has no group ? [clip]
  : group clips whose startFrame (left edge) / endFrame (right edge) equals the clip's same edge
```

### 3.6 Split values (`splitValues(clip, atFrame)`) — shared by split, overwrite, multicam

```ts
if (!(atFrame > c.startFrame && atFrame < c.endFrame)) return null;
const off = atFrame - c.startFrame;
const leftSource  = round(off * c.speed);
const rightSource = round((c.durationFrames - off) * c.speed);
left  = { ...c, durationFrames: off, trimEndFrame: c.trimEndFrame + rightSource, fadeOutFrames: 0 };
right = { ...c, id: uuid(), startFrame: atFrame, durationFrames: c.durationFrames - off,
          trimStartFrame: c.trimStartFrame + leftSource, fadeInFrames: 0 };
// keyframe tracks: [left, right] = splitKeyframeTrack(track, off, fallback) for
//   opacity (fallback c.opacity), volume (c.volume — NB linear value used as dB fallback, only matters for empty tracks),
//   position (AnimPair(0,0)), scale (AnimPair(1,1)), rotation (0), crop (c.crop), blur (c.staticBlurRadius via setBlurKeyframeTrack)
left.clampFadesToDuration(); right.clampFadesToDuration();
// wordTimings, linkGroupId, captionGroupId, multicamGroupId are copied unchanged to both halves
```

```ts
function splitKeyframeTrack(track, off, fallback) {
  if (!track || track.keyframes.length === 0) return [track, track];
  const boundary = sample(track, off, fallback);
  const leftK = track.keyframes.filter(k => k.frame <= off);
  if (leftK.at(-1)?.frame !== off) leftK.push({ frame: off, value: boundary, interpolationOut: 'smooth' });
  return [leftK.length ? { keyframes: leftK } : undefined, rebased(track, off, fallback)];
}
function rebased(track, off, fallback) {        // keep keyframes at/after off, shift to 0-based
  if (!track.keyframes.length) return undefined;
  const boundary = sample(track, off, fallback);
  const k = track.keyframes.filter(x => x.frame >= off).map(x => ({ ...x, frame: x.frame - off }));
  if (k[0]?.frame !== 0) {
    const interp = [...track.keyframes].reverse().find(x => x.frame < off)?.interpolationOut ?? 'smooth';
    k.unshift({ frame: 0, value: boundary, interpolationOut: interp });
  }
  return k.length ? { keyframes: k } : undefined;
}
```

Note the left half keeps a boundary keyframe at offset `off == left.durationFrames` (one past its last frame);
it is not clamped, so the value at the cut is continuous.

---

## 4. Clip operations

### 4.1 Placement primitives

**`fitTransform(sourceW, sourceH, canvasW, canvasH)`** (default transform of a placed visual clip):
```ts
if (sw <= 0 || sh <= 0 || cw <= 0 || ch <= 0) return identityTransform;
const canvasAspect = cw / ch, relative = (sw / sh) / canvasAspect;
if (Math.abs(canvasAspect - sw / sh) < 0.02) return identityTransform;     // Defaults.aspectTolerance
return relative > 1 ? { ...identity, width: 1, height: 1 / relative }       // letterbox
                    : { ...identity, width: relative, height: 1 };          // pillarbox
```
Unknown source dimensions → identity. For carriers the "source" is the child timeline's width/height.

**`clipDurationFrames(asset, segment?)`** = `max(1, secondsToFrame(segment ? hi - lo : asset.duration, fps))`
(images: `asset.duration` = 5 s default; text clips use 3 s).

**`placeClip(asset, trackIndex, startFrame, durationFrames, addLinkedAudio = true, linkedAudioTrackIndex?, sourceSegment?, trimStartFrame?, trimEndFrame?)`** → created ids:
```ts
if (!tracks[trackIndex]) return [];
const shouldLink = addLinkedAudio && tracks[trackIndex].type === 'video' && asset.hasAudio
                   && (asset.type === 'video' || asset.type === 'sequence');
const gid = shouldLink ? uuid() : undefined;
const segTrimStart = sourceSegment ? secondsToFrame(sourceSegment.lower, fps) : 0;
const total = secondsToFrame(asset.duration, fps);
function applyTrim(c) {
  const consumed = round(durationFrames * c.speed);
  if (sourceSegment) { c.trimStartFrame = segTrimStart; c.trimEndFrame = Math.max(0, total - segTrimStart - consumed); }
  else {
    const s = Math.max(0, trimStartFrame ?? 0); c.trimStartFrame = s;
    if (total > 0) { const tail = Math.max(0, total - s - consumed); c.trimEndFrame = Math.min(trimEndFrame ?? tail, tail); }
    else if (trimEndFrame !== undefined) c.trimEndFrame = trimEndFrame;
  }
}
const v = newClip({ mediaRef: asset.id, mediaType: asset.type, sourceClipType: asset.type, startFrame, durationFrames,
                    transform: fitTransform(asset, timeline.width, timeline.height), linkGroupId: gid });
applyTrim(v); tracks[trackIndex].clips.push(v); sortClips(trackIndex);
if (gid) {
  const a = validIndex(linkedAudioTrackIndex) ?? resolveOrCreateAudioTrack(startFrame, durationFrames);
  const ac = newClip({ mediaRef: asset.id, mediaType: 'audio', sourceClipType: asset.type, startFrame, durationFrames, linkGroupId: gid });
  applyTrim(ac); tracks[a].clips.push(ac); sortClips(a);
}
```
Linked audio is a second clip with identical timing/trim and the same `linkGroupId`.

`resolveOrCreateAudioTrack(start, dur)`: first track index in `[firstAudioIndex, count)` with no clip where
`!(c.endFrame <= start || c.startFrame >= start + dur)`; else `insertTrack(count, 'audio')`.

`createClips(assets, trackIndex, startFrame, …)`: places assets back-to-back (`cursor += duration`), no clearing.

### 4.2 Add / overwrite edit — `addClips(assets, trackIndex, startFrame, linkedAudioTrackIndex?, segments)`

One `withTimelineSwap("Add Clips")`:
```ts
const vId = tracks[trackIndex].id, aId = linkedAudioTrackIndex != null ? tracks[linkedAudioTrackIndex]?.id : undefined;
const total = Σ clipDurationFrames(asset, segments[asset.id]);
clearRegion(trackIndex, startFrame, startFrame + total, /*prune*/ false);
if (aId) clearRegion(indexOf(aId), startFrame, startFrame + total, false);
const vi = indexOf(vId); if (vi < 0) { pruneEmptyTracks(); return; }
createClips(assets, vi, startFrame, { linkedAudioTrackIndex: indexOf(aId), segments });
sortClips(vi); pruneEmptyTracks();
```
(When no audio track is pinned, linked audio goes to the first free audio track — it never overwrites.)

### 4.3 Drops onto the timeline

**Drop plan** (`resolveDropPlan(cursor, assets, atFrame, segments)`): subtitles excluded; each asset gets
`startFrame = cursor` (sequential), `hasVisual = isVisual(asset.type)`,
`hasAudio = asset.type === 'audio' || (asset.type === 'video' && asset.hasAudio)`.
`visualAssets` = placements with `hasVisual`; `audioOnlyAssets` = `!hasVisual && hasAudio`.
`visualTarget = anyVisual ? resolveVisualDropTarget(cursor) : null`; `audioTarget = anyAudio ? resolveAudioDropTarget(cursor) : null`.

`TrackDropTarget = { existing: index } | { newAt: index }` (insert before index).

```ts
resolveVisualDropTarget(cursor):
  if (count === 0) return newAt(0)
  existing(i): if (!valid(i)) return newAt(0)
               if (tracks[i].type !== 'audio') return existing(i)
               mirrored = firstAudio - 1 - (i - firstAudio)              // A1↔V1, A2↔V2 across the divider
               if (0 <= mirrored < firstAudio) return existing(mirrored)
               return firstAudio > 0 ? existing(0) : newAt(0)
  newAt(k):    return k <= firstAudio ? newAt(k) : newAt(max(0, firstAudio - (k - firstAudio)))

resolveAudioDropTarget(cursor):
  if (count === 0) return newAt(1)
  newAt(k):    return k > firstAudio ? newAt(k) : newAt(firstAudio + min(firstAudio - k, audioCount))
  existing(i): if (audioCount === 0) return newAt(count)
               if (tracks[i].type === 'audio') return existing(i)
               mirrored = firstAudio + (firstAudio - 1 - i)
               return existing(firstAudio <= mirrored < count ? mirrored : firstAudio)

shiftAfterVisualInsertion(audio, visual): if visual is newAt(v): (existing|newAt)(i) with i >= v → i + 1
```

**`placeDroppedAssets(assets, cursor, atFrame, segments, ripple)`** — one `perform("Add Clips")`:
```ts
plan = resolveDropPlan(...)
vIdx = plan.visualTarget && materialize(plan.visualTarget, 'video')     // existing → index; newAt → insertTrack (partition-clamped)
aIdx = audioTargetAfterVisualInsertion(plan) && materialize(that, 'audio')
if (visualAssets.length && vIdx != null) ripple ? rippleInsertClips(visualAssets, vIdx, atFrame, segments)
                                                : addClips(visualAssets, vIdx, atFrame, aIdx, segments)
if (audioOnlyAssets.length && aIdx != null) ripple ? rippleInsertClips(audioOnly, aIdx, atFrame, segments)
                                                  : addClips(audioOnly, aIdx, atFrame, null, segments)
```
Both visual and audio-only groups start at `atFrame` (they go to different tracks).

**Drop UI** (`TimelineView`): `ripple = ⌘ held at drop` (Cmd+drag = ripple insert, else overwrite).
Frame: `candidate = frameAt(x)`; snapped with probes `[0, totalDur]` against markers + all clip edges + beats
(**no playhead target** for external drops); `atFrame = snap.frame - snap.probeOffset`. Track target:
`geometry.dropTargetAt(y)`. Before running, `addClipsWithSettingsCheck(media, op)` (§11.2) may first apply or
ask about project settings. Media-panel timeline items dropped → `nestTimeline` for each id in order, with
`frame += child.totalFrames` after each. Subtitle assets → caption placement (separate feature).
Finder files → `importFinderItemsToTimeline` (§10.3).

### 4.4 Ripple insert

**UI path — `rippleInsertClips(assets, trackIndex, atFrame, segments)`** (`withTimelineSwap("Ripple Insert Clips")`):
```ts
shifting = tracks where i === trackIndex || syncLocked
if (multicamManualRippleViolation(shifting ids, atFrame)) refuse
totalPush = Σ clipDurationFrames
for (ti of shifting) applyShifts(computeRipplePush(tracks[ti].clips, atFrame, totalPush))
applyRippledMarkers(rippleMarkersOpening(markers, atFrame, totalPush))
created = createClips(assets, trackIndex, atFrame, { segments })    // linked audio → first free audio track
sortClips(trackIndex)
```
Clips that straddle `atFrame` are **not split** here: a straddler stays, later clips move right, and the new
clip is placed into a region that may overlap the straddler's tail (**[QUIRK]**; the agent path fixes it).

**Agent path — `rippleInsertClips(specs, trackIndex, atFrame)`** (`"Ripple Insert Clip(s) (Agent)"`): pins the
linked-audio track first (`first audio track ?? insertTrack(count, 'audio')` when any spec is video/sequence
with audio and target is video); `pushTracks = trackIndex ∪ linkedAudioTrack ∪ syncLocked`; for each push track
split the clip straddling `atFrame` (via `splitClip`, which also splits partners); push; ripple markers; place
specs sequentially with `placeClip(..., trimStartFrame, trimEndFrame)`.

**Preview** (`planRippleInsertPreview`) draws a gap band `[atFrame, atFrame + push)` on affected tracks
(target + sync-locked) and draws clips at their pushed positions; `newAt` targets show the band on the ghost row.

### 4.5 Move

**Domain — `moveClips(moves: {clipId, toTrack, toFrame}[])`**:
```ts
infos = moves.flatMap(m => {
  loc = findClip(m.clipId); if (!loc || !validTrack(m.toTrack)) return [];
  if (!isCompatible(tracks[m.toTrack].type, tracks[loc.track].type)) return [];   // track TYPE compat, silently skipped
  return [{ clip, toTrackId: tracks[m.toTrack].id, toFrame: max(0, m.toFrame) }];
});
if (!infos.length) return;
if (reason = multicamMoveViolation(infos)) return refuseWithToast(reason);
withTimelineSwap(moves.length === 1 ? "Move Clip" : "Move Clips", () => {
  remove all moved clips from every track;
  for (info of infos) clearRegion(indexOf(info.toTrackId), info.toFrame, info.toFrame + info.clip.durationFrames, false);
  for (info of infos) append { ...info.clip, startFrame: info.toFrame } to indexOf(info.toTrackId);
  sort all tracks; pruneEmptyTracks();
});
```
Moved clips never overwrite each other (removed first, cleared regions only hit non-moved clips). Linked
partners only move if they are in `moves` — the UI always includes them via selection expansion (§4.17).

**UI drag (pointer tool, clip body)** — `MoveClipDrag { lead, companions, grabOffsetFrames, deltaFrames, dropTarget, isDuplicate }`:
- mouse-down: `lead` = clicked clip; `companions` = all other selected clips (with original track index/id/frame);
  `grabOffsetFrames = frameAt(x) - lead.startFrame`; `isDuplicate = ⌥ held`.
- drag:
  ```ts
  candidate = frameAt(x) - grabOffsetFrames
  targets = snapTargets(playhead ✓, markers, clip edges excluding all dragged clips, beats excluding dragged)
  probes = for each participant p: [p.origFrame - lead.origFrame, p.origFrame - lead.origFrame + p.duration]
  delta = snap ? (snap.frame - snap.probeOffset) - lead.origFrame : candidate - lead.origFrame
  delta = max(-min(all origFrames), delta)                 // nobody before frame 0
  cursorTarget = dropTargetAt(y)
  dropTarget = cursorTarget is existing(i) ? existing(lead.origTrack + clampedTrackDelta(i - lead.origTrack)) : cursorTarget
  ```
- **pinned companions** = clips sharing the lead's `linkGroupId` + clips whose `mediaType` is incompatible with the
  lead's track type. Pinned clips move in time only, never change row.
- `clampedTrackDelta(proposed)`: starting at `proposed`, step toward 0 until every non-pinned participant's
  `origTrack + d` is a valid track whose type `isCompatible` with the clip's `mediaType`; 0 if none.
- ghost: originals drawn at 30 % opacity (100 % for duplicate), ghosts at 70 % at `max(0, start + delta)` on
  `track + trackDelta` (pinned: own row; lead-row clips on a `newAt` target: at the insertion line).
- mouse-up:
  ```ts
  if (dropTarget is existing(lead.origTrack) && delta === 0) return;          // click, no-op
  resolved = participants with their *current* track/frame
  frameDelta = max(-min(resolved frames), delta)
  existing(i): d = i - leadCurrentTrack
     moves = resolved.map(p => ({ clipId, toTrack: pinned(p) ? p.track : p.track + d, toFrame: p.frame + frameDelta }))
     isDuplicate ? duplicateClipsToPositions(moves) : moveClips(moves)
  newAt(k):  if (!isDuplicate && multicamMoveViolation(moves at current tracks)) refuse
     perform(isDuplicate ? "Duplicate Clip(s) to New Track" : "Move Clip to New Track", () => {
       newIdx = insertTrack(k, leadTrackType)                // partition-clamped
       moves = resolved.map(p => ({ clipId, toFrame: p.frame + frameDelta,
                 toTrack: (!pinned(p) && p.track === leadTrack) ? newIdx : (p.track >= newIdx ? p.track + 1 : p.track) }))
       commit as above
     })
  ```
- Escape does **not** cancel a move/trim drag (only slip, keyframe and marker drags are cancellable).

### 4.6 Duplicate, copy, cut, paste

**Clone core — `cloneClipsAt(placements: {source: Clip, trackId, dstStart}[], name)`** (`withTimelineSwap`):
```ts
groupCounts = count of placements per source.linkGroupId; groups = new Map();   // old group id → new
for (p of placements) clearRegion(indexOf(p.trackId), p.dstStart, p.dstStart + p.source.durationFrames, false);
for (p of placements) {
  clone = { ...p.source, startFrame: p.dstStart };
  clone.freshenIds(groups);     // new id; linkGroupId and captionGroupId remapped consistently within this op
  clone.multicamGroupId = undefined;
  if (p.source.linkGroupId && groupCounts[p.source.linkGroupId] <= 1) clone.linkGroupId = undefined;  // lone member → unlinked
  append to track;
}
sort all; pruneEmptyTracks(); return new ids  → caller sets selectedClipIds = new ids (if any)
```

**Duplicate (⌥-drag)** — `duplicateClipsToPositions(moves)`: placements from the moves (skip invalid tracks and
`!isCompatible(dstTrack.type, src.mediaType)`), `dstStart = max(0, toFrame)`. Name "Duplicate Clip(s)".

**Copy** — `copySelectedClipsToClipboard()` (no undo):
```ts
captures = selected clips with (trackIndex, trackId, trackType), sorted by (trackIndex, startFrame, id)
minTrack = captures[0].trackIndex; minStart = min(startFrame)
clipboard = captures.map(c => ({ clip: copy, trackOffset: c.trackIndex - minTrack,
                                 frameOffset: c.clip.startFrame - minStart, sourceTrackId, sourceTrackType }))
```
**Cut** = copy then `deleteSelectedClips()` (one undo step "Remove Clip(s)").

**Paste at playhead** (⌘V, timeline focused): `anchor = clipboard[0]`; destination track = the anchor's source
track if it still exists and `isCompatible(track.type, anchor.clip.mediaType)`, else the first compatible track,
else abort; `pasteClips(dest, activeFrame)`.

**Paste at pointer** (context menu): `pasteClips(trackUnderPointer, clickFrame)`:
```ts
base = max(0, frame)
placements = clipboard.flatMap(e => {
  dst = trackIndex + e.trackOffset
  if (!validTrack(dst) || !isCompatible(tracks[dst].type, e.clip.mediaType)) return [];
  if (e.clip.sourceClipType === 'sequence' && wouldCreateNestCycle(e.clip.mediaRef, activeTimelineId))
    { toast(`Can't paste "${label}" here — it would nest this timeline inside itself.`); return []; }
  return [{ source: e.clip, trackId: tracks[dst].id, dstStart: base + e.frameOffset }];
});
cloneClipsAt(placements, placements.length === 1 ? "Paste Clip" : "Paste Clips")
```
The clipboard is per-editor, in-memory, and survives timeline switches (paste into another timeline works).

### 4.7 Delete, ripple delete, gaps, range removal

**Delete** — `removeClips(ids, prune = true)` (`withTimelineSwap("Remove Clip"|"Remove Clips")`): no-op if no id
matches; removes ids from selection; removes the clips from all tracks; `pruneEmptyTracks()` if `prune`.
Delete/Backspace on the timeline = `removeClips(selectedClipIds)` (selection already contains link partners).
**[NOT IN SOURCE]** "lift" as a named op: this *is* lift for whole clips (leaves a gap).

**Ripple delete selected clips** (⇧⌫) — `rippleDeleteSelectedClips()`:
```ts
ids = selectedClipIds; if empty return
global = all selected clips' ranges (unmerged list)
shiftingIds = tracks where syncLocked || has a selected clip
for (r of global) if (reason = multicamManualRippleViolation(shiftingIds, r.end)) return refuseRipple(reason)
shiftsByTrack = {}; markerRanges = []
for each track ti:
  if (track has selected clips) { shiftsByTrack[ti] = computeRippleShifts(track.clips, ids);   // own removals only
                                  markerRanges.push(own removed ranges) }
  else if (track.syncLocked)    { shiftsByTrack[ti] = computeRippleShiftsForRanges(track.clips, global);
                                  if (reason = validateShifts(ti, shiftsByTrack[ti])) return refuseRipple(reason);
                                  markerRanges.push(global) }
withTimelineSwap("Ripple Delete", refreshVisuals=false, () => {
  removeClips(ids)                      // prunes empty tracks
  for (s of shiftsByTrack) applyShifts(s)   // by clip id, so index changes from pruning are harmless
  applyRippledMarkers(rippleMarkersClosing(markers, markerRanges))
})
```
Non-sync-locked tracks without selected clips do not move.

**Gap selection**: clicking empty space on a track (`hitTestGap`): `frame = frameAt(x)`; must not be inside a
clip; `nextStart = min(c.startFrame > frame)` (required — trailing space is not a gap);
`prevEnd = max(c.endFrame <= frame) ?? 0`; gap = `[prevEnd, nextStart)` on that track.

**Ripple delete gap** (⇧⌫ with a gap selected, or context menu "Ripple Delete Gap"):
```ts
rippleDelete(gap):
  if (!validTrack || gap.length <= 0) return
  if (any clip on gap track overlaps gap) { selectedGap = null; return }
  if (reason = rippleDeleteGapRefusal(gap)) return refuseRipple(reason)
  withTimelineSwap("Ripple Delete", () => {
    for each track ti where ti === gap.track || syncLocked: applyShifts(computeRippleShiftsForRanges(clips, [gap.range]))
    applyRippledMarkers(rippleMarkersClosing(markers, [[gap.range]]))
  }); selectedGap = null

rippleDeleteGapRefusal(gap):                        // also used to disable the menu item (tooltip = reason)
  shifting = {gap track} ∪ syncLocked tracks
  multicamManualRippleViolation(shifting, gap.range.end)
  ?? first validateShifts failure among other sync-locked tracks
```

**Range ripple delete ("extract") — `rippleDeleteRangesOnTrack(trackIndex, ranges, ignoreSyncLockTrackIndices = ∅)`**
(used by dead-air removal, word deletion and agent tools; no direct UI shortcut):
```ts
merged = mergeRanges(ranges.filter(len > 0)); if empty → refused("No non-empty ranges to delete")
clearIds = {anchor track} ∪ {syncLocked tracks not ignored}
// pull in link partners' tracks transitively: any clip on a clear track that has a linkGroupId and overlaps a merged range
repeat until stable: clearIds ∪= tracks of linkedPartnerIds(clip)
shifting = clearIds ∪ syncLocked-not-ignored
if (reason = multicamAtomicityViolation(shifting)) → toast + refused(reason)
for each syncLocked-not-ignored track NOT in clearIds: validateShifts(computeRippleShiftsForRanges(clips, merged)) → refused
withTimelineSwap("Ripple Delete", () => {
  for (tid of clearIds) for (r of merged) clearRegion(indexOf(tid), r.start, r.end, false)
  for each track in clearIds ∪ syncLocked-not-ignored: applyShifts(computeRippleShiftsForRanges(clips, merged)); sort
  applyRippledMarkers(rippleMarkersClosing(markers, [merged]))
})
→ ok({ removedFrames: Σ len, clearedTracks, shiftedClips, anchorTrackIndex, resultingFragments (anchor track clips), removedClipIds })
```
**[NOT IN SOURCE]** lift/extract of the I/O range: no UI exists. A faithful port can define
*Lift range* = `perform{ for each track: clearRegion(t, in, out, false) }` and *Extract range* =
`rippleDeleteRangesOnTrack(anchorTrack, [{in, out}])`, both built only from the primitives above.

### 4.8 Split / blade

```ts
splitClip(clipId, atFrame): clip must exist and startFrame < atFrame < endFrame → splitClips([{trackIndex, atFrame}])

splitClips(points) = perform(points.length > 1 ? "Split Clips" : "Split Clip", () => {
  rightIds = []
  for (p of points) {
    clip = first clip on tracks[p.trackIndex] with start < p.atFrame < end; if none continue
    group = clip.linkGroupId ? {clip.id, ...linkedPartnerIds(clip.id)} : {clip.id}
    rights = group.flatMap(id => splitSingleClip(id, p.atFrame) ?? [])     // partners not spanning atFrame are skipped
    if (group.size > 1 && rights.length) mutateClips(rights, "Split Clip", c => c.linkGroupId = uuid_once)  // right halves form a NEW link group
    rightIds.push(...rights)
  }
  return rightIds
})

splitSingleClip(id, atFrame):
  [left, right] = splitValues(clip, atFrame) ?? return null
  replace clip with left (left keeps the original id); append right; sortClips
  registerTimelineUndo("Split Clip", vm => { vm.removeClipInternal(right.id); write original clip at left.id })  // no redo, see §2.6
```
Entry points: razor tool click (§15.3), ⌘K "Split at Playhead" (`for id of selectedClipIds: splitClip(id, currentFrame)`
— one step per selected clip that is still straddled), `clearRegion`, agent tools.

### 4.9 Trim (in/out)

**`trimValues(clip, edge, delta)`** (delta in timeline frames; positive = edge moves right):
```ts
src = round(delta * clip.speed)
unbounded = clip.mediaType === 'image' || clip.mediaType === 'text'    // may go negative
left:  trimStart' = clip.trimStartFrame + src;  return [unbounded ? trimStart' : max(0, trimStart'), clip.trimEndFrame]
right: trimEnd'   = clip.trimEndFrame - src;    return [clip.trimStartFrame, unbounded ? trimEnd' : max(0, trimEnd')]
```

**`commitTrim(clipId, edge, deltaFrames, propagateToLinked)`**:
```ts
targets = [lead, ...(propagateToLinked ? linkedPartners : [])]
for (t of targets) if (b = multicamTrimBounds(t)) delta = edge === 'left' ? max(delta, -b.left) : min(delta, b.right)
trimClips(targets.map(t => ({ clipId: t.id, ...trimValues(t, edge, delta) })))
```

**`trimClips(edits)`** = `perform(edits.length === 1 ? "Trim Clip" : "Trim Clips", () => edits.forEach(e => trimClipInternal(e, protecting = all edit ids)))`.

**`trimClipInternal(clipId, newTrimStart, newTrimEnd, protecting)`**:
```ts
c = clip; dS = newTrimStart - c.trimStartFrame; dE = newTrimEnd - c.trimEndFrame
dSt = round(dS / c.speed); dEt = round(dE / c.speed)
newDuration = c.durationFrames - dSt - dEt;  newStart = c.startFrame + dSt;  newEnd = newStart + newDuration
perform("Trim Clip", () => {
  protected = protecting ∪ {clipId}
  if (newStart < c.startFrame) clearRegion(track, newStart, c.startFrame, false, protected)   // extending head overwrites
  if (newEnd > c.endFrame)     clearRegion(track, c.endFrame, newEnd, false, protected)     // extending tail overwrites
  set trimStartFrame, trimEndFrame, startFrame = newStart; setDuration(newDuration); sortClips
  registerTimelineUndo("Trim Clip", vm => vm.trimClipInternal(clipId, prevTrimStart, prevTrimEnd, protecting))
})
```
No guard keeps `newDuration ≥ 1` here (UI clamps prevent it at speed 1; port should clamp — §17).

**Trim drag clamps (UI)** — `TrimDrag` captures `headroom` at mouse-down:
```ts
clips = ripple ? rippleTrimTargets(...) : [clip, ...(linked ? partners : [])]
left = right = +∞
for (c of clips) {
  if (!ripple && (b = multicamTrimBounds(c))) { left = min(left, b.left); right = min(right, b.right) }
  else { left = min(left, c.trimStartFrame); right = min(right, effectiveTrimEnd(c)) }
}
headroom = { left: left === ∞ ? clip.trimStartFrame : left, right: right === ∞ ? effectiveTrimEnd(clip) : right }
hasNoSourceMedia = mediaType in {image, text}
```
- **left edge**: `snapped = snap(frameAt(x))` (targets: playhead, markers, all clip edges except this clip, beats incl.
  this clip's); `delta = snapped - origStart`; `delta = clamp(delta, hasNoSourceMedia ? -origStart : -headroom.left, origDuration - 1)`.
- **right edge**: `candidateEnd = max(origStart + 1, frameAt(x))`; snapped; `delta = snappedEnd - origEnd`;
  `delta = max(-(origDuration - 1), delta)`; unless `hasNoSourceMedia`: `delta = min(delta, headroom.right)`.
- Headroom is in source frames but compared against timeline deltas (**[QUIRK]** exact only at speed 1;
  `trimValues` still clamps trims at ≥ 0).
- preview: the dragged clip and its linked partners are drawn resized (left: `start += Δ, trimStart += round(Δ·speed), dur -= Δ`;
  right: `dur += Δ, trimEnd -= round(Δ·speed)`).
- mouse-up: if `delta !== 0`: `isRipple ? rippleTrimClip(...) : commitTrim(...)`.
- `effectiveTrimEnd(clip)` = carriers: `max(0, child.totalFrames - trimStart - duration)` (live child length); else `trimEndFrame`.

**Trim to playhead** (Q or `[` / W or `]`), for each selected clip containing `currentFrame` strictly inside:
- start: `src = round((currentFrame - start) * speed)`; `trimClips([{id, trimStart + src, trimEnd}])`
- end:   `src = round((end - currentFrame) * speed)`; `trimClips([{id, trimStart, trimEnd + src}])`
No link propagation beyond the selection itself; one undo step per clip (§2.5).

### 4.10 Ripple trim (⇧ + drag edge)

```ts
rippleTrimTargets(clipId, edge, linked):        // transitive closure
  ids = {clipId}; frontier = {clipId}
  while (frontier.size) { added = ∅
    for (id of frontier) { for (c of multicamRippleCohort(clip(id), edge)) add; if (linked) for (p of linkedPartnerIds(id)) add }
    frontier = added }
  return all clips with id ∈ ids (track order)

rippleTrimRefusal(lead, edge, targetIds) =
  multicamManualRippleViolation({syncLocked tracks} ∪ {lead track} ∪ {target tracks}, edge === 'left' ? lead.start : lead.end)

planRippleTrim(clipId, edge, delta, linked):
  if (delta === 0) return null
  leadEnd = lead.endFrame; targets = rippleTrimTargets(...); if (refusal) return null
  durationDelta(c) = -round(((tS' - c.trimStartFrame) + (tE' - c.trimEndFrame)) / c.speed)  where [tS', tE'] = trimValues(c, edge, delta)
  dd = the per-target durationDelta with the smallest |value|        // tightest source headroom wins
  blockedAt = null
  if (dd < 0) {
    dd = max(dd, -min(targets.map(c => c.durationFrames > 1 ? c.durationFrames - 1 : 0)))
    for each syncLocked track with no target clip: room = syncLockedLeftRoom(track, leadEnd)
      // first = min start of clips with start >= leadEnd (none → skip track); prevEnd = max end of clips with start < leadEnd, or 0
      // room = max(0, first - prevEnd); obstacle = prevEnd
    tightest = min room; if (dd < -tightest.room) { dd = -tightest.room; blockedAt = tightest.obstacle }
  }
  if (dd === 0 && blockedAt == null) return null
  resizes = targets.map(c => { [tS, tE] = trimValues(c, edge, edge === 'right' ? dd : -dd);
                               return { clipId: c.id, trimStart: tS, trimEnd: tE, duration: c.durationFrames + dd } })
  shifts = for each track: targetEnd = endFrame of the first target clip on that track
           if (targetEnd == null && !track.syncLocked) skip
           computeRipplePush(track.clips, targetEnd ?? leadEnd, dd, excludeIds = targetIds)
  return { durationDelta: dd, resizes, shifts, blockedAtFrame: blockedAt }
```
Semantics: the clip's **startFrame never moves**, for either edge. Dragging the left edge right trims source
head (`trimStart += …`) and the clip gets shorter; everything after it (on target tracks and sync-locked
tracks) moves left. Dragging right edge right extends and pushes everything after it right. The live preview
redraws resized targets and shifted clips each tick and draws a red vertical "wall" at `blockedAtFrame`.

Commit — `rippleTrimClip(...)`: re-check refusal (toast + beep), re-plan, then
`withTimelineSwap("Ripple Trim")`: apply resizes (`trimStartFrame`, `trimEndFrame`, `setDuration`), `applyShifts`,
`applyRippledMarkers(rippleMarkersOpening(markers, leadEnd, dd))`, sort touched tracks.

### 4.11 Slip (Trim tool `T`, drag clip body)

Eligibility `isSlipEligible(c) = c.mediaType ∉ {image, text} && !c.multicamGroupId`.
Multicam clip → toast "Can't slip a multicam clip — it would go out of sync with the group."; image/text → ignored.

```ts
// mouse-down: headroom over [clip, ...(linked ? partners : [])].filter(isSlipEligible)
maxRight = min(floor(c.trimStartFrame / max(c.speed, 0.001)))          // drag right reveals earlier material
maxLeft  = min(floor(effectiveTrimEnd(c) / max(c.speed, 0.001)))
// drag: delta = clamp(frameAt(x) - grabFrame, -maxLeft, maxRight)   (no snapping); viewer shows in/out two-up
// mouse-up: if (delta) commitSlip(clipId, delta, linked)

commitSlip(clipId, delta, linked):
  targets = [lead, ...(linked ? partners.filter(isSlipEligible) : [])].filter(isSlipEligible); if empty return
  for (t of targets) { s = max(t.speed, 0.001); delta = min(delta, floor(t.trimStartFrame / s)); delta = max(delta, -floor(effectiveTrimEnd(t) / s)) }
  if (delta === 0) return
  applied(c) = clamp(round(delta * c.speed), -effectiveTrimEnd(c), c.trimStartFrame)
  if (targets.every(t => applied(t) === 0)) return
  mutateClips(targets, targets.length === 1 ? "Slip Clip" : "Slip Clips", c => { a = applied(c); c.trimStartFrame -= a; c.trimEndFrame += a })
```
Start/duration never change. Slip preview (`SlipPreviewState`): shown for the video clip (or its linked video
partner when grabbing audio): `inFrame = trimStart - applied`, `outFrame = inFrame + max(0, sourceFramesConsumed - 1)`.

### 4.12 Not implemented: roll, slide, solo, track lock, generic grouping **[NOT IN SOURCE]**

- **Roll** and **slide** edits do not exist. If added, compose them from `trimClipInternal` pairs inside one `perform`.
- **Solo** and **track (edit) lock** do not exist. Track flags are only `muted`, `hidden`, `syncLocked`.
- **Group** = link groups only (§4.16). `captionGroupId` groups caption text clips (remapped on copy, not an
  editing group). Multicam groups are §12.

### 4.13 Speed (retime)

UI: Inspector "Speed" field, range **0.25–4.0×**, applies to selected visual + audio clips that
`supportsRetiming` (not carriers). Multicam clips refused: "Can't change speed on a multicam clip — it would slip
out of sync with the group." (silent during live scrub).

```ts
retimedDurationFrames(dur, speed, newSpeed) = max(1, round(dur * speed / newSpeed))

applyClipSpeed(id, newSpeed):                 // live, no undo
  if multicam (quiet) or !supportsRetiming return
  preDragTimeline ??= copy(timeline); dragBefore[id] ??= copy(clip)
  setClipSpeed(loc, newSpeed, ripple = true)

commitClipSpeed(ids, newSpeed, ripple = true):
  if refusesMulticamRetime(ids) return (toast)
  before = preDragTimeline ?? copy(timeline)
  for id: if supportsRetiming && clip.speed !== newSpeed: setClipSpeed(loc, newSpeed, ripple)
  preDragTimeline = null; dragBefore.delete(ids)
  if (before != timeline) registerTimelineSwap(before, timeline, "Change Speed")

setClipSpeed(loc, newSpeed, ripple):
  c = clip; basis = dragBefore[c.id] ?? c
  newDur = retimedDurationFrames(basis.durationFrames, basis.speed, newSpeed)
  oldDur = c.durationFrames; oldEnd = c.endFrame
  c.speed = newSpeed; c.durationFrames = newDur
  c.rescaleWordTimings(from: oldDur); c.rescaleKeyframes(by: newDur / oldDur); c.clampKeyframesToDuration(); c.clampFadesToDuration()
  rippleDelta = (c.startFrame + newDur) - oldEnd
  if (ripple && rippleDelta) for (id of track.contiguousClipIds(oldEnd, exclude c.id)) clip(id).startFrame += rippleDelta
  sortClips
```
- `trimStartFrame` / `trimEndFrame` are unchanged (source span stays ≈ constant).
- `contiguousClipIds(fromEnd, exclude)`: walk clips sorted by start with `start >= fromEnd`; collect while
  `c.startFrame === chainEnd` (chainEnd starts at `fromEnd`, then `= c.endFrame`); stop at first gap.
- **[QUIRK]** Only the contiguous chain on the **same track** ripples; sync-locked tracks and linked partners
  are not rippled (partners are retimed only if they are in `ids`). Slowing down a clip that is followed by a
  gap and then another clip can create an overlap.
- `rescaleKeyframes(by s)`: each keyframe `frame = min(max(0, dur - 1), round(frame * s))` re-upserted (collisions
  overwrite); `rescaleWordTimings(from old)`: `s = dur/old`; `start = clamp(round(ws*s), 0, max(0, dur-1))`,
  `end = min(max(start + 1, round(we*s)), dur)` (text clips only).
- Sync (§12.4) uses `commitClipSpeed(..., ripple: false)`.

### 4.14 Clip property edits (live/commit pairs)

All use §2.4. Keyframe-aware writers are in §7.5. Others:
- **Fade**: `setFade(edge, frames)`: `v = max(0, frames)`; set fadeIn/fadeOut; `clampFadesToDuration()` =
  `fadeIn = clamp(fadeIn, 0, dur)`; `fadeOut = clamp(fadeOut, 0, dur - fadeIn)`. Fade-knee drag:
  `proposed = orig ± (frameAt(x) - grabFrame)` (+ for left knee, − for right); `cap = max(0, dur - otherEdgeFade)`;
  `clamp(proposed, 0, cap)`; live `applyFade`, commit "Change Fade In"/"Change Fade Out" if changed else revert.
  Fade interpolation (`linear` | `smooth`) via knee context menu → "Change Fade Interpolation".
- **Text**: `applyTextContent`/`commitTextContent` ("Change Text") then `fitTextClipToContentIfNeeded`
  (resize the box to the laid-out natural size, anchored per text alignment; scale keyframes rescaled by the size ratio).
- **Replace clip source** (`replaceClipMediaRef`): for every clip with the same `linkGroupId` **and** same
  `mediaRef` as the anchor: `mediaRef = newAssetId`; `resetTrim ? trims = 0 : trimEnd = trimEndFrames[id]` → "Replace Clip Source".

### 4.15 Copy / paste clip settings

`copiedClipSettings(type)` = the clipboard's clips of that `mediaType`; valid only if **exactly one**.
"Paste Settings" (context menu; targets = selected clips of the same type, excluding the source) →
`applyClipSettings(snapshot, targets)` (validates all first: non-empty, exist, same mediaType → else throws), one
"Paste Clip Settings" clip swap over changed clips:
```ts
result = copy(target)
result.effects = source.effects (minus gaussian blur for text sources) with every param.track removed; [] → undefined
switch (source.mediaType) {
  audio: volume
  text: opacity, textStyle, textAnimation, textFillMode; fitTextClipToContent; transform.centerX/centerY/rotation/flipH/flipV
  video|image|lottie|sequence: opacity, transform (whole), crop, edgeRounding, edgeSoftness, blendMode
}
if (target had a blur keyframe track) restore it (setBlurKeyframeTrack)
// keyframe tracks of the target (other than effects params) are untouched
```

### 4.16 Link / unlink and linked-clip behaviour

```ts
linkTargets(ids): ids = expandToLinkGroup(ids)
  require ids.size >= 2, all exist, ≥ 2 distinct mediaTypes, and NOT (exactly one existing group and no ungrouped clip)
linkClips(ids):   mutateClips(linkTargets(ids), "Link", c => c.linkGroupId = newUuid)   // merges sub-groups
unlinkClips(ids): mutateClips(expandToLinkGroup(ids).filter(hasLinkGroupId), "Unlink", c => c.linkGroupId = undefined); selectedClipIds = ∅
expandToLinkGroup(ids) = ids ∪ all members of any link group containing an id
linkedPartnerIds(id)   = other members of id's group
```

How link groups propagate (Option/⌥ is the per-gesture "unlinked" override):

| Gesture | Linked behaviour |
|---|---|
| click select / marquee / context-menu select | selection expanded to link group (not with ⌥) |
| move drag | partners move because they are selected; they keep their rows (pinned) |
| trim drag | `propagateToLinked = !⌥`; partners receive the same timeline delta (clamped to tightest headroom) |
| ripple trim | partners (and multicam cohort) are targets |
| slip | eligible partners slip by the same timeline delta |
| split / razor / ⌘K | always splits partners spanning the frame; right halves get a fresh shared group |
| delete / ripple delete | partners deleted because selected |
| speed | partners retimed only if selected (inspector includes selected audio) |
| copy/duplicate | group preserved if ≥ 2 members copied, else member unlinked |

**Out-of-sync badge** (`linkGroupOffsets`): per link group with > 1 member, `anchor = startFrame - trimStartFrame`,
`ref = min(anchor)`; each clip with `anchor !== ref` shows offset `anchor - ref` frames. Multicam: per group,
clusters of overlapping clips (sorted by start; new cluster when `start >= clusterEnd`) compare
`anchorFrame(member, clip)` the same way.

### 4.17 Selection

Click on a clip (pointer/trim tools; `linkedOn = !⌥`; `onHandle` = within a trim handle):
```ts
if (⇧ && onHandle)        { if (!selected(c)) sel = linkedOn ? linkGroup(c) : {c} }       // ripple trim keeps selection
else if (⇧)               { selected(c) ? sel -= (linkedOn ? linkGroup(c) : {c}) : sel ∪= (linkedOn ? linkGroup(c) : {c}) }
else if (⌥ && !selected(c)) sel = {c}
else if (!⌥ && !selected(c)) sel = linkedOn ? linkGroup(c) : {c}
// clicking an already-selected clip keeps the whole selection (multi-clip drag)
```
- Click empty track area: unless ⇧, clears clip + marker selection; selects the gap under the cursor; starts a
  marquee. Marquee: `selected = base ∪ {clips whose rect intersects marquee}`; expanded to link groups unless ⌥
  is held during the drag; markers whose flag rects intersect are added to marker selection. A marquee larger
  than 3 px clears the gap selection.
- **Select forward** (A / ⇧A, timeline focused, requires a selection): anchor = earliest selected clip (by
  start, then track index); select every clip with `startFrame >= anchor.startFrame` on the anchor's track (A) or
  all tracks (⇧A), expanded to link groups; clears gap, range, marker selection. Also on the clip context menu
  (anchor = right-clicked clip).
- **Select all clips on track** (track header context menu).
- Right-click on an unselected clip selects its link group before showing the menu.
- **[NOT IN SOURCE]** ⌘A does nothing on the timeline (it selects all in the media panel only).
- Escape: cancel media swap → cancel chroma sampling → exit crop → un-maximize panel → collapse media search →
  otherwise cancel cancellable drag, clear slip preview, clear clip selection, clear range, clear marker
  selection, tool = pointer.

---

## 5. Tracks

### 5.1 Insert — `insertTrack(at, type) → index`
```ts
partitionedInsertionIndex(type, requested):
  bounded = clamp(requested, 0, trackCount)
  return type === 'audio' ? max(bounded, firstAudioIndex) : min(bounded, firstAudioIndex)
insertTrack(at, type): idx = partitionedInsertionIndex(type, at); withTimelineSwap("Add Track", () => tracks.splice(idx, 0, newTrack(type))); return idx
```
There is no explicit "Add Track" button: tracks are created by drops on insertion lines (`newAt`), move-to-new-
track, linked-audio placement, "Add Text" (always a new **top** video track: `insertTrack(0, 'video')`),
nesting/decompose, multicam creation, and agent tools.

### 5.2 Remove / prune
- `removeTracks(ids)` (`withTimelineSwap("Remove Track"|"Remove Tracks")`) removes tracks with their clips (agent only).
- `pruneEmptyTracks()` removes every track with no clips (no own undo; always inside a swap).

### 5.3 Reorder (track header drag handle)
```ts
reorderTrackLive(id, targetIndex):              // every drag tick, no undo; target = geometry.trackAt(y)
  from = indexOf(id); isAudio = tracks[from].type === 'audio'
  lower = isAudio ? firstAudio : 0; upper = isAudio ? count - 1 : firstAudio - 1
  dest = clamp(targetIndex, lower, upper); if (dest !== from) move track from → dest
commitTrackReorder(before /* timeline snapshot at mouse-down */):
  if (before != timeline) { registerTimelineSwap(before, timeline, "Reorder Track"); notify }
```

### 5.4 Flags
`toggleTrackMute(i)` ("Mute Track"/"Unmute Track"), `toggleTrackHidden(i)` ("Hide Track"/"Show Track"),
`toggleTrackSyncLock(i)` ("Sync Lock Track"/"Unlock Track Sync"). Implementation: flip the boolean, register
an inverse that sets the old value by track id (no redo — §2.6), notify.
Refusal: turning sync-lock **off** on a track containing a multicam clip → toast
`Can't unlock sync on a multicam track — "<group>" stays aligned through it.` + beep.
`muted` silences audio output; `hidden` hides visual output (and excludes the track when flattening nests).

### 5.5 Height
Header bottom edge (±6 px of the track block bottom): live `displayHeight = clamp(y - trackTop - expandedLanes*24, 32, 200)`;
on mouse-up restore the original then `setTrackHeight(i, final)` (clamped [32, 200]; inverse re-registers) → "Resize Track".

### 5.6 Rename
`setTrackName(id, raw)`: `TrackName.normalized(raw)`: trim spaces/tabs; throw if the raw string contains control
characters or newlines or the trimmed length > 80; empty → `undefined` (falls back to the default label).
Unchanged → no-op. "Rename Track" (inverse).

### 5.7 Display label (`timelineTrackDisplayLabel(i)`)
`prefix = first letter of trackLabel(type)` (video/sequence "V", audio "A", image "I", text "T", lottie "L", subtitle "S").
- audio: `n = count of audio tracks in [0, i]` → A1 is the top-most audio track.
- visual: `n = count of same-type tracks in [i, max(i + 1, firstAudio))` → V1 is the visual track nearest the
  divider (lowest on screen), numbers grow upward.

### 5.8 Solo / lock — **[NOT IN SOURCE]**

---

## 6. Markers and timeline range

### 6.1 Validation (`validatedTimelineMarker`)
`name = trim(whitespace+newlines)`; require non-empty, `≤ 120` chars, no control characters/newlines →
else `invalidName`; `comment.length ≤ 4000` → else `invalidComment`; `startFrame ≥ 0`, `durationFrames ≥ 0`,
`start + duration` does not overflow, color components finite in `[0, 1]` → else `invalidRange`.

### 6.2 `changeTimelineMarkers({creates, updates, deleteIds}, actionName)` — the single marker mutation API
```ts
deleteSet = new Set(deleteIds); if (deleteSet.size !== deleteIds.length) throw invalidRange       // duplicate ids
before = markers; next = [...before]
if (![...deleteSet].every(id => next.has(id))) throw invalidRange
updated = []
for (m of updates.map(validate)) { if (deleteSet.has(m.id)) throw invalidRange; i = indexOf(m.id) ?? throw invalidRange
                                   if (m != next[i]) { next[i] = m; updated.push(m) } }
next = next.filter(m => !deleteSet.has(m.id)); created = creates.map(validate); next.push(...created)
next.sort((a, b) => a.startFrame - b.startFrame || compare(a.id, b.id))
if (timelineMarkerPreview && (deleteSet ∪ updateIds).has(preview.id)) timelineMarkerPreview = null
if (next == before) return { created: [], updated: [], deletedIds: [] }          // no undo step
markers = next; registerTimelineMarkerSwap(before, next, actionName); selectedMarkerIds -= deleteSet
return { created, updated, deletedIds }
```

### 6.3 Marker operations
- **Add** (M key, toolbar flag button): requires the timeline preview tab active, else toast
  "Select the timeline to add a marker.". `range = validSelectedTimelineRange`;
  `marker = { name: "Marker N" (lowest N ≥ 1 not used), startFrame: range?.start ?? activeFrame, durationFrames: range ? end - start : 0 }`
  → "Add Marker"; then select only it, clear clip selection, gap and range, open the marker editor.
- **Delete** (⌫ when markers are selected — takes precedence over clip delete; editor "Remove Marker") →
  "Delete Marker" / "Delete Markers".
- **Edit** (popover; double-click marker): name, comment, color (13 presets
  `#4094FF #40CCE6 #40BF5C #F2C72E #FF8C26 #E64040 #F259A6 #A666F2 #8CBFFF #73E6B8 #A6D936 #C79E6B #D1D1D1`),
  status, start/duration frame fields. Edits update `timelineMarkerPreview` live; Done → `changeTimelineMarkers(updates: [draft], "Edit Marker")`.
- **Drag in ruler**: hit areas: point marker = 10×12 flag centred on `x(start)` at the ruler top; range marker =
  two 5×12 half-flags (start half `[x(start) - 5, x(start)]`, end half `[x(end), x(end) + 5]`); each inflated by 3 px;
  last-drawn (latest start) wins. Mouse-down selects only that marker (clears clip selection, gap, range).
  Targets: playhead, other markers' starts/ends, clip edges, beats.
  - move: `raw = orig.start + frameAt(x) - grabFrame`; `start = max(0, snap(raw, probes [0, duration]))` where a snap yields `frame - probeOffset`.
  - ⌥-drag adjusts duration: `end = max(orig.start, snap(frameAt(x)))`; `duration = end - orig.start` (0 = point marker).
  - mouse-up: if changed → "Move Marker" / "Change Marker Duration"; error → toast "Couldn't change marker.".
- Marker snap frames = sorted unique set of all starts and range ends.
- Markers ripple with edits when `rippleTimelineMarkers` (Edit ▸ Ripple Timeline Markers, default on) — §3.3.
- On FPS change markers rescale: `scaledEnd = round(end*s)`; `start = max(0, round(start*s))`; `duration = isRange ? max(1, scaledEnd - start) : 0`.

### 6.4 Timeline range (In/Out)
```ts
TimelineRangeSelection { startFrame, endFrame }; normalized = start <= end ? self : swap; valid = normalized.end > normalized.start
contains(f) = normalized.start <= f < normalized.end
markRangeStart(f = activeFrame) (I):  s = max(0, f); setRange(s, current?.endFrame ?? s)
markRangeEnd(f = activeFrame)   (O):  e = max(0, f); setRange(current?.startFrame ?? e, e)
setRange(s, e): clears marker selection; stores max(0, s), max(0, e) (may be inverted until committed)
```
I/O only fire with no ⌘/⌥/⌃ modifier. Ruler interactions: ⇧-click/drag starts a range at the click frame
(clears clip selection and gap) and drags its end (snapped; targets include playhead); dragging within 8 px of
an existing valid range edge (nearest edge, tie → start) re-anchors at the opposite edge; on mouse-up
`keepValidTimelineRangeOrClear()` (invalid → cleared, valid → normalized). Range context menu: Add Range to
Chat, Save Range as Media, Switch Angle in Range (only if exactly one multicam group overlaps), Clear Range.

---

## 7. Keyframes

### 7.1 Storage
```ts
type Interpolation = 'linear' | 'hold' | 'smooth'
interface Keyframe<V> { frame: number /* clip-relative offset: timelineFrame - clip.startFrame */; value: V; interpolationOut: Interpolation /* default 'smooth' */ }
interface KeyframeTrack<V> { keyframes: Keyframe<V>[] }   // sorted by frame, unique frames; empty track stored as undefined
```

| Property | Storage | Value | Supported `mediaType` |
|---|---|---|---|
| opacity | `opacityTrack` | number (raw opacity, before fades) | visual (video, image, text, lottie, sequence) |
| position | `positionTrack` | `AnimPair{a: topLeft.x, b: topLeft.y}` normalized canvas | visual |
| scale | `scaleTrack` | `AnimPair{a: width, b: height}` normalized canvas | video, image, lottie, sequence, text |
| rotation | `rotationTrack` | degrees (clockwise +) | visual |
| crop | `cropTrack` | `Crop` | video, image, lottie, sequence |
| blur | `effects[type "blur.gaussian"].params["radius"].track` | radius px, static clamp [0, 100] | visual |
| volume | `volumeTrack` | **dB** | audio |

Track ops: `upsert(kf)` replaces a keyframe at the same frame (whole object, interpolation included) or inserts
sorted; `remove(at f)`; `move(from, to)`: no-op if `from` missing or `to` occupied (`to ≠ from`); keeps
`interpolationOut`. Blur track writes go through `setBlurKeyframeTrack(track)`: an active track is stored on the
blur effect (creating it with the static radius if missing; text clips keep `param.value = null`); a nil track
clears it and removes the effect when `value` is 0/absent or the clip is text.

### 7.2 Evaluation — `sample(track, frame /*offset*/, fallback)`
```ts
function sample<V>(track, f, fallback) {
  const k = track.keyframes;
  if (k.length === 0) return fallback;
  if (k.length === 1) return k[0].value;
  if (f <= k[0].frame) return k[0].value;                    // hold first value before the first key
  if (f >= k[k.length - 1].frame) return k[k.length - 1].value;   // hold last value after the last key
  const bi = k.findIndex(x => x.frame > f); const a = k[bi - 1], b = k[bi];
  const t = (f - a.frame) / (b.frame - a.frame);
  switch (a.interpolationOut) {                              // the LEFT key's interpolationOut governs the segment
    case 'hold':   return a.value;
    case 'linear': return lerp(a.value, b.value, t);
    case 'smooth': return lerp(a.value, b.value, smoothstep(t));
  }
}
smoothstep(t) = t * t * (3 - 2 * t)
lerp(a, b, t) = a + (b - a) * t           // numbers; AnimPair and Crop component-wise (left, top, right, bottom)
```
- **Easing curves exactly**: `linear` = identity; `hold` = step (value jumps at `b.frame`);
  `smooth` = cubic Hermite with zero end tangents = `3t² − 2t³`, which is **exactly** CSS
  `cubic-bezier(1/3, 0, 2/3, 1)` (x control points linear, y control points 0,0,1,1). There are no per-key
  tangents/handles, no ease-in vs ease-out split, no overshoot.
- Rotation lerps numerically (no shortest-arc wrap). Volume lerps in **dB**, then converts to linear.
- Evaluation is at integer frame offsets (renderer samples per frame).

### 7.3 Property resolution at timeline frame `f`
```ts
off = f - c.startFrame
rawOpacityAt(f)  = c.opacityTrack ? sample(c.opacityTrack, off, c.opacity) : c.opacity
opacityAt(f)     = c.mediaType !== 'audio' && (c.fadeInFrames > 0 || c.fadeOutFrames > 0) ? rawOpacityAt(f) * fadeMultiplier(f) : rawOpacityAt(f)
sizeAt(f)        = c.scaleTrack ? sample(c.scaleTrack, off, {a: w, b: h}) : {w: transform.width, h: transform.height}
topLeftAt(f)     = c.positionTrack?.keyframes.length ? sample(c.positionTrack, off, {0,0})
                 : { x: transform.centerX - sizeAt(f).w / 2, y: transform.centerY - sizeAt(f).h / 2 }   // static centre, animated size
rotationAt(f)    = c.rotationTrack ? sample(..., transform.rotation) : transform.rotation
transformAt(f)   = { ...transform, centerX: tl.x + sz.w/2, centerY: tl.y + sz.h/2, width: sz.w, height: sz.h, rotation: rotationAt(f) }
cropAt(f)        = c.cropTrack ? sample(..., c.crop) : c.crop
blurRadius(f)    = blurTrack ? sample(blurTrack, off, staticBlurRadius) : staticBlurRadius
staticBlurRadius = text ? (textStyle.blur ?? 0) : (blur effect param "radius".value ?? 0)
volumeAt(f)      = c.volume * (volumeTrack?.keyframes.length ? linearFromDb(sample(volumeTrack, off, 0)) : 1) * fadeMultiplier(f)
textScaleAt(f)   = base = textStyle.fontScale ?? default; non-text → base; invalid transform → default fontScale;
                   ratio = min(sizeAt(f).w / transform.width, sizeAt(f).h / transform.height); invalid ratio → base; else base * ratio

fadeMultiplier(f) {                      // applies to opacity (visual) and volume (all)
  rel = f - c.startFrame; if (rel < 0 || rel > c.durationFrames) return 0;
  inMul  = c.fadeInFrames  > 0 ? shape(min(1, rel / c.fadeInFrames), c.fadeInInterpolation) : 1;
  outMul = c.fadeOutFrames > 0 ? shape(min(1, (c.durationFrames - rel) / c.fadeOutFrames), c.fadeOutInterpolation) : 1;
  return min(inMul, outMul);             // shape(t, 'smooth') = smoothstep(t), otherwise t
}
VolumeScale: floorDb = -60, ceilingDb = +15
  linearFromDb(db) = db <= -60 ? 0 : 10 ** (min(db, 15) / 20)
  dbFromLinear(x)  = x <= 0 ? -60 : clamp(20 * log10(x), -60, 15)
```

### 7.4 Keyframe mutations
- **Stamp** (`stampKeyframe(clipId, property, frame = currentFrame)`): requires `clip.contains(frame)`; upserts at
  `frame - start` the *current resolved* value: opacity → `rawOpacityAt`, position → `topLeftAt`, scale →
  `sizeAt`, rotation → `rotationAt`, crop → `cropAt`, blur → `blurRadius`, volume →
  `volumeTrack?.sample(off, 0) ?? 0` dB (ignores static volume). "Add Keyframe" (no step if nothing changed).
- **Toggle** (inspector diamond button / audio header button): keyframe exists at frame ? remove : stamp.
- **Remove**: `removeKeyframe(property, frame)` → empty track becomes `undefined` → "Delete Keyframe".
- **Set interpolation** (keyframe context menu Linear / Smooth / Hold, current one checked; missing → smooth)
  → "Change Interpolation".
- **Animation-aware writes** (inspector/canvas edits), all with live `apply…` and committing `commit…`:
  if the property's track is active → if `contains(activeFrame)` upsert a keyframe at `activeFrame` with the new
  value, else **silently ignore**; if not active → write the static field.
  **[QUIRK]** upsert replaces the whole keyframe, so editing a value at an existing keyframe resets its
  `interpolationOut` to `smooth`.
  - opacity → `opacity`; rotation → `transform.rotation`; crop → `crop`; blur → `setStaticBlurRadius`
    (finite only, clamp [0, 100]; 0 removes the effect; keeps the effect's enabled flag); volume (dB) →
    `volume = linearFromDb(db)` (keyframe value stays dB).
  - position (`setX?`, `setY?` = new top-left): `tl = topLeftAt(f)`; `new = (setX ?? tl.x, setY ?? tl.y)`;
    static: `centerX = new.x + sizeAt(f).w/2`, `centerY = new.y + sizeAt(f).h/2`.
  - scale (non-text, uniform `s`): `aspect = mediaCanvasAspect(clip) ?? 1` (= `(srcW/srcH)/(canvasW/canvasH)`);
    `w = s, h = s / aspect`. Text: only when the scale track is active and the playhead is inside:
    `ratio = s / fontScale`, keyframe `(transform.width*ratio, transform.height*ratio)`.
  - text size `v`: scale track active → `writeScale(v / style.fontSize)`; else `style.fontSize = v / fontScale`,
    then refit the text box. "Reset Text Size" clears the scale track then writes the default size.
  - whole transform (canvas gizmo): position (top-left of new transform), scale (width/height) and rotation are
    each keyframed or written statically independently.
- Blur style change on text (`style.blur` differs) clears the blur keyframe track.

### 7.5 Keyframe drags
**Keyframe lanes** (expanded non-audio tracks, 24 px per lane below the track row, lane order
position, scale, rotation, opacity, blur, crop — only properties some clip on the track supports):
- hit: diamond within ±7 px of `x(frame)`; nearest wins; tie → a selected clip's keyframe.
- mouse-down on a diamond: pause playback, `seekToFrame(kf)`, select only that clip, start drag.
  Mouse-down elsewhere on a lane: seek there and select the clip under that frame supporting the property.
- drag:
  ```ts
  proposed = origFrame + (frameAt(x) - grabFrame)
  targets  = [clip.startFrame, max(start, end - 1)] ∪ keyframe frames of the clip's OTHER properties   // 8 px threshold
  bounds   = [max(start, prevKeyOfSameProperty + 1), min(max(start, end - 1), nextKey - 1)]
  next = clamp(snapped ?? proposed, bounds)     // snap indicator hidden if clamping changed it
  if (next !== current) { playhead (live) = next; applyMoveKeyframe(property, current → next) }
  ```
- mouse-up: moved → `currentFrame = final`, `commitMoveKeyframe` ("Move Keyframe"); not moved → revert.
  Escape → playhead and keyframe restored.

**Audio volume rubber band** (on audio clip bodies when the clip is selected and ≥ 48 px wide):
- geometry: body = clip rect below a 16 px label bar (`height - 16 - 1`); diamond x = `clipX + offset * pxPerFrame`;
  `y(dB) = body.minY + ((6 - clamp(dB, -60, 6)) / 66) * body.height`; hit box 14×14.
- `dB(y) = 6 - clamp01((y - body.minY) / body.height) * 66`, then clamped to [-60, +15].
- drag: frame bounded between neighbouring volume keys within the clip, dB from y; live
  `applyMoveVolumeKeyframe` (remove + upsert, interpolation preserved); commit "Move Keyframe" if frame or dB changed.
- ⌘-click on the body: add a key at `offset = clamp(round(xInClip / pxPerFrame), 0, dur - 1)` with `dB(y)` → "Add Keyframe".

**Navigation**: per lane, all `(frame, clipId)` targets of that track/property sorted by `(frame, clipId)`;
previous = last with `frame < current`, next = first with `frame > current` (binary search). Per clip:
`previousKeyframeFrame` = max frame < f, `nextKeyframeFrame` = min frame > f.

### 7.6 Keyframes under timing operations

| Operation | Keyframe effect |
|---|---|
| split | `splitKeyframeTrack` (§3.6) |
| `setDuration` (trims, overwrite trims, ripple trim, multicam) | `clampKeyframesToDuration`: keep keys with `0 ≤ frame ≤ dur`, then `frame = min(frame, max(0, dur - 1))`, re-upserted in order (a key at `dur` replaces one at `dur - 1`); empty → undefined |
| head trim / overwrite `trimStart` | offsets unchanged → keys move with the new start (**[QUIRK]**), then clamp |
| ripple trim | start fixed, offsets unchanged, clamp |
| move, slip | unchanged |
| speed | `rescaleKeyframes(newDur / oldDur)` then clamp |
| FPS change | `rescaleKeyframes(newFps / oldFps)` then clamp |
| decompose nest | children keys rebased by the head cut, clamped |
| text box refit | scale key values multiplied by `needW/currentW`, `needH/currentH` |
| canvas resolution change | non-default-fit clips: scale key `b` multiplied by `heightScale` (§11.1) |

---

## 8. Nested timelines

```ts
wouldCreateNestCycle(childId, hostId) = childId === hostId || reachableTimelines(child).has(hostId)
reachableTimelines(t) = BFS over carriers (sourceClipType 'sequence') of t and descendants, deduped, excluding t
nestBlockReason(childId) = child.totalFrames === 0 ? `"${name}" is empty. Add clips before nesting it.`
                         : wouldCreateNestCycle(childId, activeId) ? `Can't nest "${name}" — it would contain itself.` : null
```

**Carriers** (`insertNestCarriers(child, start, duration, videoIdx?, audioIdx?)`): `linkGroupId = both ? uuid : none`;
video carrier: `clearRegion(videoIdx, start, start+duration, false)`, clip `{mediaRef: child.id, mediaType: 'sequence', sourceClipType: 'sequence', transform: fitTransform(child.width, child.height, canvas)}`;
audio carrier: `clearRegion(audioIdx, …)`, clip `{mediaRef: child.id, mediaType: 'audio', sourceClipType: 'sequence'}`.
Carriers cannot be retimed; their trim tail is live (`effectiveTrimEnd`); double-click opens the child timeline.

**Nest timeline (drag a timeline from the media panel)** — `nestTimeline(childId, cursor, atFrame)` →
`withTimelineSwap("Nest Timeline")`: block reason → toast; `videoTarget = cursor is existing(i) && tracks[i].type === 'video' ? cursor : (cursor is existing ? newAt(0) : cursor)`;
`videoIdx = materialize(videoTarget, 'video')`; `audioIdx = child.hasAudioClips ? resolveOrCreateAudioTrack(start, dur) : null`;
`start = max(0, atFrame)`, `dur = child.totalFrames`; insert carriers.

**Create nested timeline from selection** — `nestSelectedClips()` (context menu):
```ts
lanes = tracks (in order) that contain selected clips → { index, type, clips: selected clips on it }
start = min(start of all); duration = max(end) - start
child = Timeline{ name: "Nest N" (unique from 1), fps/width/height/settingsConfigured of the active timeline,
                  tracks: lanes.map(l => Track{ type: l.type, clips: l.clips shifted by -start }) }
child.regenerateIds()                                      // new track/clip/marker ids, link & caption groups remapped
perform("Nest Clips", () => {
  timelines.push(child); registerRemoveUndo(child.id); selectedClipIds = ∅
  withTimelineSwap("Nest Clips", () => {
    remove the selected clips
    span = [start, start + duration)
    v = first non-audio lane index; a = first audio lane index
    if (v != null && track v still has a clip overlapping span) { v = insertTrack(v, 'video'); if (a != null && a >= v) a++ }
    if (a != null && track a overlaps span) a = insertTrack(a + 1, 'audio')
    carriers = insertNestCarriers(child, start, duration, v, a); pruneEmptyTracks(); selectedClipIds = carriers
  })
  open a tab for child; request inline rename of the tab; expand the tab bar
})
```

**Decompose** — `decomposeNest(clipId)` (context menu, only when the selection is exactly one link group):
```ts
clicked must be a carrier with an existing child
carriers = members of clicked's link group that are carriers of the same child: video carrier / audio carrier
selectedClipIds -= group
withTimelineSwap("Decompose Nested Timeline", () => {
  video: lanes = NestFlattener.flatten(videoCarrier, child, visual=true).videoTracks;  place(lanes, carrier, 'video', volumeScale 1)
  audio: lanes = flatten(audioCarrier, child, visual=false).audioTracks;             place(lanes, carrier, 'audio', volumeScale = audioCarrier.volume)
  pruneEmptyTracks()
})
place(lanes, carrier, type, vs): remove the carrier; idx = its track
  for (lane of lanes) { free = track idx exists && type matches && no clip overlaps the carrier span
                        if (!free) idx = insertTrack(idx, type)
                        append lane clips with fresh ids (link/caption groups remapped once per decompose), volume *= vs; sort; idx++ }
flatten(carrier, child, visual):     // window = [carrier.trimStart, carrier.trimStart + carrier.duration); shift = carrier.start - carrier.trimStart
  child tracks: visual → type video && !hidden; audio → type audio && !muted
  remap(clip): s = max(clip.start, window.lo); e = min(clip.end, window.hi); skip if e <= s
               headCut = s - clip.start; if (headCut > 0) { trimStart += round(headCut * speed); fadeIn = 0; rebase all keyframe tracks by headCut }
               if (e < clip.end) fadeOut = 0
               start = s + shift; duration = e - s; clampFades; clampKeyframes
```
Afterwards, if the video carrier had a "group look" (opacity ≠ 1, crop, edge rounding/softness, effects, fades,
blend mode, any keyframe track, or transform ≠ default fit) or the audio carrier had fades/volume keyframes,
toast "Nest settings discarded. Undo to restore." Carrier speed is never applied (carriers can't be retimed).

---

## 9. Timelines (multiple per project)

- **Create** (`createTimeline(name?, activate = true)`): new timeline with the active one's `fps`, `width`,
  `height`, `settingsConfigured`; name `"Timeline N"`, N starting at `timelines.length + 1`, incremented until
  unused; append; undo = delete ("New Timeline"); activate.
- **Duplicate** (`duplicateTimeline(id)`): deep copy, new id, name `"<name> copy"` then `"<name> copy 2"`, …;
  `regenerateIds()` (new track ids, clip ids via `freshenIds` with consistent link/caption remap, new marker
  ids); copies the view state; undo = delete ("Duplicate Timeline").
- **Rename** (`renameTimeline(id, name)`): `trim(whitespace+newlines)`; ignore empty or unchanged; inverse undo.
- **Delete** (`deleteTimeline(id)`): refuse if it's the last one (toast "Can't delete every timeline — the
  project needs at least one."). If active: activate the first other open tab, else the first other timeline.
  Remove it, its view state, its tab and selection entry; undo re-inserts at the same index (and same tab index,
  re-activating if it was active). Carriers referencing it become offline (`isClipMediaOffline` → child missing).
- **Activate** (`activateTimeline(id)`): revert in-flight drag (§2.4), stash view state
  `{playheadFrame, zoomScale, scrollOffsetX}`, pause, clear timeline-scoped state, set active, open its tab,
  restore its view state (`currentFrame = clamp(vs.playheadFrame, 0, totalFrames)`), rebuild. Not undoable.
- Tabs: close (keeps ≥ 1 open; activates the left neighbour, or the next if closing the first), close others,
  open all; Tab / ⇧Tab cycles open timeline tabs when the timeline panel is focused. Not undoable.
- Moving timelines into media folders: §10.2.

---

## 10. Media library: import, folders, delete, relink, swap

### 10.1 Import (Finder items / open panel, ⌘I)
`importFinderItems(urls, intoFolderId)` — imports are serialized (each waits for the previous one).
1. **Scan** (off the UI thread): per root URL: directory → planned folder (name = directory name, parent = target
   folder) and recurse into its entries sorted Finder-style (`localizedStandardCompare`), skipping hidden files;
   file → type by lower-cased extension:
   `video: mov mp4 m4v` · `audio: mp3 wav aac m4a aiff aif aifc caf flac` · `image: png jpg jpeg tiff heic webp` ·
   `lottie: json lottie` (must validate as Lottie, else rejected) · `subtitle: srt vtt`.
   Unsupported **root** files are rejected (toast for the last one: `Can't import "<name>" — unsupported file type.`
   / `… — not a Lottie animation.`); unsupported nested files are skipped silently. Empty folders are still created.
2. **Apply** with registration disabled: create folders in plan order (resolving planned parents), create
   assets (`name` = filename without extension, `folderId`), append to `mediaAssets` and manifest.
3. If nothing was added → no undo step. Else register **"Import Media"** = restore the media-library snapshot
   taken before the import (§2.3).
4. Finalize each asset asynchronously (load duration, dimensions, fps, hasAudio, thumbnails; mark
   missing/unprocessable). Finalization is not part of undo.

Single-file `addMediaAsset(url)` (paste image, generated media) appends without an undo step.

### 10.2 Folders (`MediaFolder { id, name, parentFolderId? }`)
- `createFolder(name, parent?)` → append; undo = `deleteFolders([id])` ("New Folder").
- `renameFolder(id, name)` → no-op if unchanged; inverse undo ("Rename Folder"). (No trimming/validation.)
- `deleteFolders(ids)`: `all = ids ∪ descendants`; snapshot; delete **all assets inside those folders**, remove
  every clip referencing them on every timeline (every empty track of each touched timeline is then removed); timelines
  whose `folderId ∈ all` are re-parented to root (never deleted); remove folders; prune selections, close
  previews; undo = restore snapshot ("Delete Folder").
- `moveAssetsToFolder`, `moveTimelinesToFolder` ("Move to Folder"), `moveFoldersToFolder` ("Move Folder"):
  skip unchanged items; folder moves skip a target that is the folder itself or one of its descendants
  (cycle guard). Applied as a parent-change list with an inverse list as undo.
- Folder lists are shown sorted by `localizedCaseInsensitiveCompare(name)`.

### 10.3 Finder files dropped on the timeline
`importFinderItemsToTimeline(urls, cursor, atFrame, ripple)`: capture `before` snapshot; import into the media
panel's current folder **with registration disabled** and no auto-finalize; finalize each asset (await);
`placeable` = assets whose metadata loaded; pre-parse subtitle files into caption specs; bail if any imported
asset was replaced meanwhile. Then
`op = perform("Add Media", { register(restore(before)); placeDroppedAssets(placeable, cursor, atFrame, ripple); place captions })`,
run through `addClipsWithSettingsCheck(placeable, op)` (§11.2) when there are placeable assets.
One undo step removes both the imported media and the placed clips.

### 10.4 Delete media / rename
- `deleteMediaAssets(ids)`: snapshot; `removeClipsReferencingAssets(ids)` across **all** timelines (all empty tracks
  of each touched timeline removed); remove assets + manifest entries; close their preview tabs; clear asset selection;
  undo = restore ("Delete Media").
- Media-panel delete (⌫ with media panel focused, or context menu) = one `perform(<name>)` that registers a
  selection restore, then `deleteFolders`, `deleteMediaAssets` (assets not already inside deleted folders),
  `deleteTimeline` for selected timelines (always leaving at least one; toast if some were kept).
- `renameMediaAsset(id, name)` → inverse ("Rename Asset").

### 10.5 Relink (offline media) — **not undoable**
- `relinkAsset(id, newURL)`: if the new file's extension maps to a type different from the asset's type → toast
  `Can't relink "<file>". Required media type: <X>. Selected media type: <Y>.`; else set `asset.url`, drop
  derived caches (denoise state, visuals, speaker assignments), update the manifest source, re-finalize, rebuild.
- `relinkOfflineAssets(fromFolder)`: index every regular file under the folder (recursive) by lower-cased file
  name (first match wins); relink each offline asset whose lower-cased `url.lastPathComponent` matches;
  returns `(relinked, totalOffline)`.

### 10.6 Swap clip media ("Swap Media" context item → pick an asset in the media panel)
```ts
mediaSwapTargetClipIds(clipId): clip must not be text, nor have sourceClipType text/sequence
  ids = linkedClipIdsSharingMedia(clip)   // clip + link-group members with the SAME mediaRef
  refuse if any id is a multicam clip ("Use change_cam for multicam clips.")
swapClipMedia(clipId, replacement):
  targets must all exist; every target.sourceClipType === replacement.type, else error
  if replacement.id === anchor.mediaRef → no-op
  if replacement is video without audio and a target is an audio clip → error
  if replacement.type !== 'image':
    available = floor(replacement.resolvedDuration * fps) (must be > 0)
    for t: required = t.trimStartFrame + round(t.durationFrames * t.speed); require 0 ≤ required ≤ available
           trimEndFrames[t.id] = available - required
  replaceClipMediaRef(clipId, replacement.id, trimEndFrames)   // "Replace Clip Source", one clip swap
```
The same validation (with `commit: false`) decides which assets are highlighted as compatible while the swap is
armed. Escape cancels; any timeline mutation also cancels a pending swap.

---

## 11. Project settings

### 11.1 `applyTimelineSettings(fps, width, height)` — "Change Project Settings"
```ts
before = { timelines (all), currentFrame, sourcePlayheadFrame, liveViewStates }
if (fps !== prevFps && prevFps > 0 && fps > 0) {        // FPS is project-wide
  s = fps / prevFps
  currentFrame = round(currentFrame * s); sourcePlayheadFrame = round(sourcePlayheadFrame * s)
  every timeline: rescaleFrames(s); every view state: playheadFrame = round(playheadFrame * s)
}
if (width !== prevW || height !== prevH) {               // resolution: ACTIVE timeline only
  for each clip with known source dims (and all sizes > 0):
    srcAspect = sw/sh; oldAspect = srcAspect / (prevW/prevH); newAspect = srcAspect / (width/height)
    oldFit = fitTransform(sw, sh, prevW, prevH)
    if (!scaleTrackActive && |transform.width - oldFit.width| < 1e-4 && |transform.height - oldFit.height| < 1e-4)  // still the default fit
      transform.width/height = fitTransform(sw, sh, width, height).width/height
    else { k = oldAspect / newAspect; transform.height *= k; scaleTrack keys: b *= k }
}
for all timelines: fps = fps; settingsConfigured = true
active timeline: width, height
if (snapshot changed) register restore (symmetric) and rebuild
```
`Timeline.rescaleFrames(s)`: markers rescale (§6.3); per track, clips in start order:
`scaledStart = round(start*s)`, `scaledEnd = round(end*s)`, `start = max(scaledStart, previousEnd)` (prevents
overlap), `duration = max(1, scaledEnd - start)`, `trimStart = round(trimStart*s)`, `trimEnd = round(trimEnd*s)`,
`rescaleKeyframes(s)`, `fadeIn = round(fadeIn*s)`, `fadeOut = round(fadeOut*s)`, clamp keyframes and fades.

### 11.2 Settings check when adding media — `checkProjectSettings(assets, adoptFPS = true)`
```ts
v = first asset of type video; if none → proceed
canAdoptFPS = adoptFPS && every timeline has no clips
if (!timeline.settingsConfigured) {                      // first media ever: adopt silently (own undo step)
  applyTimelineSettings(canAdoptFPS ? (round(v.sourceFPS) ?? fps) : fps, v.sourceWidth ?? width, v.sourceHeight ?? height)
  return proceed
}
if (active timeline has clips) return proceed
fpsMismatch = canAdoptFPS && v.sourceFPS != null && round(v.sourceFPS) !== fps
resMismatch = (v.sourceWidth != null && ≠ width) || (v.sourceHeight != null && ≠ height)
return (fpsMismatch || resMismatch) ? mismatch(canAdoptFPS ? round(sourceFPS) ?? fps : fps, w ?? width, h ?? height) : proceed
```
`addClipsWithSettingsCheck(assets, op)`: proceed → run `op`; mismatch → show dialog: "Change to Match" →
`applyTimelineSettings(clip values)` then `op`; "Keep Current" → `op`. The settings change and the placement are
separate undo steps.

---

## 12. Multicam and synchronization

### 12.1 Model
`MulticamSource { id, name, members: Member[], masterMemberId }`;
`Member { id, mediaRef, kind: 'angle'|'mic'|'both', angleLabel, sync: { offsetSeconds, confidence, locked } }`;
`providesVideo = kind !== 'mic'`, `providesAudio = kind !== 'angle'`, `usable = confidence > 0 || locked`;
`angles = members.filter(providesVideo && usable)`, `mics = members.filter(providesAudio && usable)`.
`offsetFrames = round(offsetSeconds * fps)`; `coverage(dur) = [round(off*fps), max(that, round((off+dur)*fps)))`;
`trimFrame(atGroupFrame g) = round((g/fps - offsetSeconds) * fps)`. Groups referenced by no clip are not saved.

### 12.2 Create — `createMulticamGroup(specs, syncMaps, masterRef, name?, startFrame?)` → "Create Multicam"
```ts
labels: uniqueAngleLabel(spec.angleLabel ?? asset.name ?? mediaRef): lowercase; non-alphanumerics → "-";
        collapse "--"; trim "-"; "" → "angle"; dedupe "x", "x-2", "x-3", …
master must exist; name ?? "Multicam N"; at = startFrame ?? totalFrames
angleRanges = angles with known duration → coverage; videoStart = min lo; videoEnd = max hi (must be <)
seed = first angle with a duration; groupOrigin = at - videoStart
program spans: holes = [[videoStart, videoEnd)]; for angle of [seed, ...other angles]:
  for each hole: filled = hole ∩ coverage(angle); if empty keep hole; else emit (angle, filled) and keep the
  uncovered left/right remainders; stop when no holes. Sort spans by start.
perform("Create Multicam", () => withTimelineSwap(() => {
  v = insertTrack(0, 'video')                      // new top track = program track
  for span: append memberClip(span.member, span.range, 'video')
  ai = trackCount; for mic of mics with duration: idx = insertTrack(ai, 'audio'); append memberClip(mic, coverage, 'audio'); ai = idx + 1
}); if no clip placed throw; insert group metadata (undoable))
memberClip(member, range, type): start = groupOrigin + range.lo; clamped = [max(0, start), groupOrigin + range.hi); empty → skip
  headCut = clamped.lo - start; clip{ mediaRef, startFrame: clamped.lo, durationFrames: |clamped|, mediaType: type,
  sourceClipType: asset.type, multicamGroupId, trimStartFrame: trimFrame(range.lo) + headCut,
  trimEndFrame: max(0, round(dur*fps) - trimStart - sourceFramesConsumed), transform: video ? fitTransform(asset) : identity }
```
Member clips are **not** link-grouped; the multicam group keeps them aligned.

### 12.3 Angle switching (`MulticamEngine.apply`, one "Switch Angle" swap per request batch)
For each `{range, slots: members, layout}`:
1. Program track = the **last** (bottom-most) video track with a program fragment (group clip, non-audio)
   overlapping the range; none → skipped "no multicam clip in this range".
2. For each program fragment overlapping the range: `wanted = range ∩ fragment`; clamp to the target angle's
   recorded coverage projected through the fragment:
   `groupStart = fragment.trimStart/fps + current.offsetSeconds`; `P(gs) = fragment.start + round((gs - groupStart)*fps)`;
   `coverage = [P(target.offset), P(target.offset + duration))`; empty → skipped "<label> wasn't recording here".
3. Remove overlays above the program track within the target (split group clips at the bounds, delete group clips
   fully inside); `hadLayout = removed > 0`.
4. For slots 2..n place overlay clips: `trimStart = (target.lo - anchorFrame(anchorMember, fragment)) - member.offsetFrames`,
   trimEnd from duration, transform/crop = `layoutPlacement(clip, slot.rect, fill)`; track = the nearest video track
   above the program track (highest index < program index) that is free over the range, else a new video track
   inserted at the program index (directly above it).
5. On the program track: split (any clip) at `target.lo` and `target.hi`; for each group fragment inside:
   `wasDefaultFit = transform == fitTransform(clip) && crop == identity`; `rewrite(clip → slot-1 member)`;
   layout ≠ full → transform/crop = placement in slot-1 rect; else if `wasDefaultFit || hadLayout` → fit transform
   (and reset crop if `hadLayout`).
6. Join through-edits whose seam lies within `[target.lo, target.hi]`: adjacent clips with same mediaRef,
   mediaType, group, `b.start == a.end`, `b.trimStart == a.trimStart + a.sourceFramesConsumed`, equal speed,
   volume, opacity, transform, crop, edge rounding/softness, effects, blend mode, `a.fadeOut == 0`,
   `b.fadeIn == 0`, no keyframes → `a.duration += b.duration; a.trimEnd = b.trimEnd; a.fadeOut = b.fadeOut`.

`rewrite(clip, group, member)`: no-op if same mediaRef or current member unknown; `Δ = round((cur.offset - member.offset)*fps)`;
`mediaRef = member.mediaRef; trimStart += Δ; trimEnd = known duration ? max(0, round(dur*fps) - trimStart - sourceFramesConsumed) : 0`.

`layoutPlacement(clip, rect, 'fill')`: `slotAspect = (rect.w/rect.h) * (canvasW/canvasH)`;
`crop = cropFittingAspect(clip, slotAspect, 0.5, 0.5)` (source wider: `total = 1 - target/source`, `left = total*ax`,
`right = total - left`; else `total = 1 - source/target`, `top = total*ay`, `bottom = total - top`);
`w = rect.w / visibleW`, `h = rect.h / visibleH`, `topLeft = (rect.x - crop.left*w, rect.y - crop.top*h)`.
Layout slot rects (normalized canvas): full `[0,0,1,1]`; side_by_side halves; top_bottom halves; PiP = main full +
inset `0.28×0.28` at margin `0.035` in the named corner; grid 2×2/3×3/4×4 (row-major `r{row}c{col}`);
main_sidebar `[0,0,.7,1]+[.7,0,.3,1]`; three_up thirds horizontally; three_stack thirds vertically.

UI: "Switch Angle"/"Switch Mic" submenu (clip context menu): audio clip or an overlay clip → single-clip `rewrite`
(mic must be an audio bearer: usable and providesAudio or asset has audio); program fragment → range switch over
the clip span. "Layout" submenu: current angle first, other angles fill remaining slots. "Switch Angle in Range"
(range menu). "Ungroup Multicam": clear `multicamGroupId` on the active timeline's clips (swap) and remove the
group metadata if no timeline references it — one perform.

Multicam restrictions elsewhere: no partial moves / lane changes (§3.5), trim limited by neighbouring angle
fragments (`multicamTrimBounds`), ripple must include all group tracks and cannot cut through a fragment, no
speed change, no slip, no sync-lock unlock, no media swap; copies drop `multicamGroupId`.

Member sync (`syncMulticamMembers`) computes `SyncMap`s by audio-envelope cross-correlation against the master
(seeded by capture dates, timecode fallback) and rebases offsets so the minimum usable offset is 0; it is an
analysis step, not an edit (the DSP lives in `AudioSyncCorrelator`, out of scope here).

### 12.4 Synchronize clips (context menu ▸ Synchronize ▸ Auto | Audio | Timecode)
Selection → `(reference, targets)`: selected non-multicam clips grouped into units by link group; per unit a
bearer = an audio clip that has transcribable audio ?? any clip with audio ?? a video clip; needs ≥ 2 units;
reference = best by rank `(linked ? 0 : 1, hasVisual ? 0 : 1, earliest start)`; targets = the rest sorted by start.
Timecode alignment:
```ts
refClock = refTC.seconds + ref.trimStartFrame / fps
tgtClock = tgtTC.seconds + tgt.trimStartFrame / fps
rawStart = round(ref.startFrame + (tgtClock - refClock) * fps / max(ref.speed, 0.0001))
```
Audio alignment: correlation lag (hops) → `rawStart = round(anchor.rawStart + lagHops * hop * fps / max(anchor.speed, 1e-4))`;
optional drift correction `speed = anchor.speed / (1 + driftRatio)` when within 0.1 % of the target's speed.
Placement: per accepted target, move it and all its link partners by the same delta (track unchanged); refuse a
target whose move would overlap the reference on its track ("Shares the reference's track — move it to its own
track first.") or another queued move ("Overlaps another clip being synced on the same track."); if any move
lands before frame 0, shift everything (reference included) right by `-min(toFrame)`; drop drift retimes whose
growth would overwrite an unmoved clip, re-plan until stable. Commit = `perform("Synchronize", { commitClipSpeed(unit, speed, ripple: false) per retime; moveClips(moves) })`.

---

## 13. Snapping

Constants: `Snap.thresholdPixels = 8`, `stickyMultiplier = 1.5`, `playheadMultiplier = 1.5`.

```ts
type SnapTarget = { frame: number; kind: 'playhead' | 'clipEdge' | 'beat' | 'marker' }
interface SnapState { currentlySnappedTo?: number; currentProbeOffset = 0 }   // reset at every mouse-down / drag start

findSnap(position, probeOffsets = [0], targets, state, baseThresholdPx = 8, ppf) {
  base = baseThresholdPx / ppf                                  // frames
  if (state.currentlySnappedTo != null) {                       // sticky hold
    p = position + state.currentProbeOffset
    if (|p - snapped| <= base * 1.5 && targets.some(t => t.frame === snapped))
      return { frame: snapped, probeOffset: state.currentProbeOffset, x: snapped * ppf }
    state.currentlySnappedTo = undefined; state.currentProbeOffset = 0
  }
  best = null
  for (o of probeOffsets) for (t of targets) {                  // order matters for ties: first strictly-closer wins
    thr = t.kind === 'playhead' ? base * 1.5 : base
    d = |position + o - t.frame|
    if (d <= thr && d < (best?.d ?? ∞)) best = { o, t, d }
  }
  if (!best) return null
  haptic tick; state = { currentlySnappedTo: best.t.frame, currentProbeOffset: best.o }
  return { frame: best.t.frame, probeOffset: best.o, x: best.t.frame * ppf }
}
// callers that move an object use (snap.frame - snap.probeOffset) as the new start
collectTargets(tracks, playhead, excludeClipIds, includePlayhead, markerFrames, beatFrames?, includeExcludedClipBeats):
  [playhead?] + markers + for each clip (track order): if !excluded → start, end; beats if (!excluded || includeExcludedClipBeats)
```

| Interaction | Playhead | Clip edges | Markers | Beats | Probes |
|---|---|---|---|---|---|
| Move clips | ✓ | all except dragged | ✓ | except dragged clips' | each participant's start & end offsets relative to lead |
| Trim left/right | ✓ | all except the trimmed clip (linked partners included) | ✓ | incl. trimmed clip | [0] |
| Razor hover | ✓ (separate sticky state) | all | ✓ | ✓ | [0] |
| Range drag | ✓ | all | ✓ | ✓ | [0] |
| Marker drag | ✓ | all | other markers | ✓ | move: [0, duration]; ⌥ duration: [0] |
| External media drop | ✗ | all | ✓ | ✓ | [0, total drop duration] |
| Keyframe lane drag | ✗ | clip start & last frame only | ✗ | ✗ | [0]; plus other-property keys of the clip |
| Playhead scrub, slip, fade knee, volume key | no snapping | | | | |

Beat targets (`beatSnapFrames(clip)`, only when `markBeats` and the clip's media has beat analysis, never for
carriers): for each beat/downbeat time `t` (seconds in source): `src = t*fps - trimStart`; skip if `< 0`;
`f = round(start + src / max(speed, 1e-4))`; keep if `start ≤ f < end`; deduplicated.

The snap indicator is a vertical line at `snap.x`.

---

## 14. Timeline geometry and zoom

### 14.1 Constants
| Name | Value |
|---|---|
| Default pixels per frame (`zoomScale`) | 4.0 |
| Zoom max | 40.0 px/frame |
| Zoom min (`minZoomScale`) | `clamp(visibleWidth / (displayFrames * 3.0), 0.0001, 40)`; `0.05` if `displayFrames == 0` or width unknown |
| Toolbar zoom step | ×/÷ 1.25; slider is logarithmic over `[ln(min), ln(40)]` |
| ⌥-scroll zoom | `factor = exp(scrollDeltaY * 0.04)`, anchored at cursor |
| Pinch zoom | `factor = 1 + magnification * 1.5`, anchored at cursor |
| ⌘-scroll pan | `scrollX = clamp(scrollX - delta * 5, 0, maxX)` (delta = deltaX, or deltaY when deltaX is 0) |
| Ruler height | 28 px |
| Top drop zone (between ruler and first track) | 32 px |
| Track height | default 44, min 32, max 200; resize handle ±6 px |
| Keyframe lane height | 24 px; diamond 8 px; hit 14 px |
| Track header width | default 160, min 112, max 320 (resize hit 8 px) |
| Insert threshold (new-track drop line) | 10 px |
| Drag threshold (marquee) | 3 px |
| Trim handle width | 4 px; trim handles, fade knees, volume keys need clip width ≥ 48 px |
| Clip label min width | 56 px (32 px when selected); compact rendering < 8 px |
| Clip label bar | 16 px |
| Auto-scroll (scrub) | edge zone `min(56, 0.5*visibleWidth)`, step `4 + (28 - 4) * clamp01(distanceIntoZone/zone)` px every 1/60 s |
| Timeline range edge hit | 8 px |
| Marker flag | 10×12 px, hit slop 3 px |

### 14.2 Formulas
```ts
trackY(i)         = 28 + 32 + Σ_{j<i} (trackHeight(j) + lanes(j) * 24)       // top of track row i
trackBlockBottom(i) = trackY(i) + trackHeight(i) + lanes(i) * 24
contentBottom     = trackBlockBottom(last) ?? 60
clipRect(c, i)    = { x: header + c.startFrame * ppf, y: trackY(i) + 2, w: c.durationFrames * ppf, h: trackHeight(i) - 4 }
frameAt(x)        = max(0, trunc((x - header) / ppf))        // header = 0 inside the scrolling clip canvas
xForFrame(f)      = header + f * ppf
trackAt(y)        = first i with y < trackBlockBottom(i), else max(0, count - 1)
rowLocation(y)    = track(i) if inside the row, keyframeLane(i, lanes(i)[floor((y - rowBottom)/24)]) if in its lanes
dropTargetAt(y):
  count === 0 → newAt(0); y < trackY(0) → newAt(0)
  for i in 0..count-2: if trackBlockBottom(i) - 10 <= y <= trackY(i+1) + 10 → newAt(i + 1)
  y >= trackBlockBottom(count-1) → newAt(count)
  else existing(trackAt(y))
ghostY(newAt(k))  = k < count ? lineY - 44 : lineY        // lineY = insertion line (trackY(k) or last block bottom)
contentWidth      = max(visibleWidth, ppf * displayFrames + 0.5 * visibleWidth)
contentHeight     = tracks.length ? max(visibleHeight, contentBottom + 32) : visibleHeight
```
Zoom anchoring: cursor zoom keeps the frame under the cursor fixed:
`frameUnderCursor = docX / oldPpf; scrollX = max(0, frameUnderCursor * newPpf - (docX - oldScrollX))`.
Any other zoom change (toolbar, slider, view-state restore) is **playhead-anchored**: if the playhead was visible,
keep its viewport x; else centre it (`anchor = visibleWidth/2`). First layout: `zoom = displayFrames == 0 ? 4.0 : minZoomScale`
(fit all); later, if zoom < min it is raised to min.

Ruler: major tick interval = first of `[1,2,5,10,15,30,60,120,300,600,1200,1800,3600] × fps` frames that is
`≥ 80 / ppf`; minor subdivisions = first of `[20,10,5,4,2]` with `majorPx / n ≥ 6`; labels `HH:MM:SS:FF`
(`formatTimecode`: `ff = |f| % fps`, `ss = (|f|/fps) % 60`, `mm = (|f|/fps/60) % 60`, `hh = |f|/fps/3600`, 2-digit pad, "-" sign).

---

## 15. Tool modes and mouse behaviour

### 15.1 Tools
| Tool | Key | Body drag | Edges | Click |
|---|---|---|---|---|
| Pointer (`pointer`, default) | V | move (⌥ = duplicate) | trim (⇧ = ripple trim) | select |
| Razor (`razor`) | C | — | — | split the clicked clip (and partners) at the hover frame (snapped) |
| Trim (`trim`) | T | **slip** | trim (same as pointer) | select |
Escape returns to pointer. Cursors: trim bracket cursors on handles, slip cursor (or "not allowed" on
multicam/image/text) in trim mode, crosshair in razor mode and for ⇧ over the ruler, open/closed hand on
markers and keyframes, resize-left-right on range edges, fade knees and ⌥ over markers.

### 15.2 Mouse-down decision tree (timeline canvas)
1. If the preview isn't on the timeline tab, switch to it.
2. **Marker flag hit** (ruler) → marker drag (⌥ = duration); double-click opens the editor. Stop.
3. **Double-click below the ruler on a clip**: carrier → open its timeline; otherwise select its asset in the
   media panel and reveal it. Stop.
4. **Ruler**: range-edge hit → range edge drag; ⇧ → new range; else clear marker selection and scrub the playhead
   (pauses playback, live `interactiveScrub` seeks, auto-scroll at edges, exact seek + resume on mouse-up).
5. **Keyframe lane** → keyframe hit / seek (§7.5).
6. Clear gap selection. **Razor tool**: clip hit → `splitClip(clip, razorPreviewFrame ?? frameAt(x))`. Stop.
7. **Clip hit**: clear marker selection; apply selection rules (§4.17); then in priority order:
   fade knee (visible when selected or hovered and ≥ 48 px) → fade drag; audio volume key → volume key drag;
   ⌘-click on audio body → add volume key; trim handle (`localX ≤ 4` left, `≥ width - 4` right, only ≥ 48 px wide,
   disabled when ⌥ held) → trim drag (ripple if ⇧, linked unless ⌥); trim tool → slip; else move drag.
8. **Empty area** → marquee (+ gap selection).

Mouse-up commits per §4.5, §4.9–4.11, §6.3, §7.5. Right-click menus: §15.3. Double-click is only checked on step 3.

### 15.3 Context menus
- **Clip** (selects its link group first if unselected): Select Forward on Track · Select Forward on All Tracks ·
  Copy · Paste (at click) · Paste Settings · Link · Unlink │ Add to Chat · AI Edit │ Create Nested Timeline ·
  Open Timeline · Decompose Nested Timeline │ Swap Media · Save as Media · Save as Audio │ Synchronize ▸
  (Auto/Audio/Timecode) · Detect/Redetect Beats · Mark Beats │ Switch Angle/Mic ▸ · Layout ▸ · Ungroup Multicam
  │ range items if the click is inside the selected range.
- **Fade knee**: Linear / Smooth. **Keyframe diamond / volume key**: Linear / Smooth / Hold, Delete Keyframe.
- **Audio dead-air span**: Remove Dead Air.
- **Empty track area**: Paste · Create AI Transition (video gap with start > 0) · Ripple Delete Gap (disabled with
  tooltip = refusal reason) · range items.
- **Track header**: Rename Track · Select All Clips on Track.

---

## 16. Keyboard shortcuts

### 16.1 Shortcuts pane (`Help/ShortcutsPane.swift`, verbatim)
| Group | Shortcut | Action |
|---|---|---|
| Playback | Space | Play / Pause |
| | ← | Step Backward |
| | → | Step Forward |
| | Shift + ← | Skip Backward |
| | Shift + → | Skip Forward |
| Tools | V | Selection Tool |
| | C | Razor Tool |
| Editing | A | Select Forward on Track |
| | Shift + A | Select Forward on All Tracks |
| | Cmd + K | Split at Playhead |
| | [ or Q | Trim Start to Playhead |
| | ] or W | Trim End to Playhead |
| | Backspace | Delete |
| | Shift + Backspace | Ripple Delete |
| | Shift + Drag Edge | Ripple Trim |
| | Cmd + Drag Media | Ripple Insert |
| | Opt + Drag | Duplicate Clip |
| Timeline | Shift + Drag Ruler | Select Range |
| | Drag Range Edge | Adjust Range |
| | I | Mark Range Start |
| | O | Mark Range End |
| | Opt + Scroll | Zoom to Cursor |
| | Pinch | Zoom to Cursor |
| | Cmd + Scroll | Scroll Horizontally |
| File | Cmd + N | New |
| | Cmd + Shift + N | New Folder |
| | Cmd + O | Open |
| | Cmd + S | Save |
| | Cmd + Shift + S | Save As |
| | Cmd + I | Import Media |
| | Cmd + E | Export |
| Edit | Cmd + Z | Undo |
| | Cmd + Shift + Z | Redo |
| | Cmd + X | Cut |
| | Cmd + C | Copy |
| | Cmd + V | Paste |
| | Cmd + A | Select All |
| View | Cmd + F | Full Screen |
| | ` | Maximize Focused Panel |
| | Cmd + Scroll | Zoom Preview to Cursor |
| | Esc | Deselect & Reset Tool |

### 16.2 Additional bindings not in the pane
| Key | Action | Condition |
|---|---|---|
| T | Trim (slip) tool | no ⌘ |
| M | Add marker (at selected range or playhead) | no ⌘⌥⌃ |
| Tab / ⇧Tab | next / previous open timeline tab (timeline focused) or preview tab (preview focused) | no ⌘⌥⌃ |
| Return | open selected folder (media panel) / finish crop editing | |
| ⌘, | Settings | menu |
| ⌘Q | Quit | menu |
| ⌘0 / ⌥⌘0 / ⌥⌘A | toggle Media / Inspector / Agent panel | menu |
| ⌘1 / ⌘2 / ⌘3 | layout preset Default / Media / Vertical | menu |
| ⌘? | Keyboard Shortcuts window | menu |
| ⌘K (media panel focused) | focus media search — **overrides Split at Playhead** while the media panel is focused | media panel |
| ⌘↑ / plain arrows (media panel focused) | navigate up a folder / move media selection (instead of stepping the playhead) | media panel |
| ⌘A (media panel focused) | select all media panel items | media panel |
| Edit ▸ Ripple Timeline Markers | toggle (checkmark) | menu, no key |

### 16.3 Dispatch rules (`EditorWindowController.handleKeyDown`)
- Ignored entirely while an editable text field/view has focus.
- Backspace precedence: media panel focused with selection → delete media items; else selected markers → delete
  markers; else ⇧ → ripple delete gap (if a gap is selected) else ripple delete clips; else delete clips.
  (Forward Delete is not bound.)
- A / ⇧A only when the timeline panel is focused and no ⌘⌥⌃; menu items enabled only with a selection.
- ⌘C / ⌘X / ⌘V act on clips only when the timeline panel is focused (⌘V with the media panel focused pastes
  files/images into the media panel). ⌘X = copy + delete.
- `[` / `]` and Q / W fire regardless of focused panel (menu key equivalents without modifiers).
- Space toggles playback; arrows step/skip unless the media panel is focused (then they move media selection).
- Toolbar mirrors: Undo, Redo, tool buttons, Split at Playhead, `[`, `]`, Add Text (T glyph), Add Marker,
  zoom −/slider/+, timeline tab bar toggle.

---

## 17. Port notes (quirks and recommended fixes)

Faithful-port defaults are described above; these are the deviations worth deciding on explicitly:

1. **Rounding**: use `roundHalfAway` everywhere Swift used `.rounded()`; `secondsToFrame` truncates.
2. **Missing redo** for split, mute/hide/sync-lock toggles (§2.6). Recommended: make split a `withTimelineSwap`
   and toggles symmetric swaps.
3. **Multiple undo steps** for ⌘K / Q / W / [ / ] over multi-clip selections (§2.5). Recommended: wrap the loop in
   one `perform`.
4. **Trim inverse drift** at speed ≠ 1 (§2.6). Recommended: clip-state swap instead of re-running the trim.
5. `trimClipInternal` has no `newDuration ≥ 1` guard; clamp.
6. Overwrite of a straddled clip splits its **linked partners** (§3.2) — decide whether to keep.
7. Head trims shift keyframes in absolute time (§3.2, §7.6).
8. UI ripple insert does not split straddlers (§4.4); the agent path does.
9. Speed ripple only pushes the contiguous same-track chain (§4.13).
10. `pruneEmptyTracks` deletes *all* empty tracks after most clip ops (§1.1).
11. Editing a value at an existing keyframe resets its interpolation to smooth (§7.4).
12. Relink and single-asset adds are not undoable (§2.6).
13. Trim headroom compares source frames with timeline frames (§4.9).
14. ⌘A is a no-op on the timeline; roll/slide/lift/extract/solo/lock don't exist (§4.12).
15. All validations run before mutation; refusals surface as a toast (+ beep for ripple/multicam refusals) and
    never create undo steps — keep this contract.
