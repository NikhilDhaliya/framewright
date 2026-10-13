# 01 — Persisted Data Model (`.palmier` packages)

Source of truth for reading and writing Palmier Pro project packages from the Linux (Electron + TypeScript) port, byte-compatible with the macOS app (`io.palmier.pro`, v0.7.6, Swift sources under `Sources/PalmierPro`).

Everything here was derived from the Swift `Codable` conformances, not from documentation. Where Swift behaviour is surprising (silent data loss on decode, strict vs lenient keys), it is called out explicitly because the TS writer must not trip it.

Primary Swift sources:

| Area | File(s) |
|---|---|
| Package read/write | `Project/VideoProject.swift`, `Project/ProjectPackageCoordinator.swift`, `Utilities/FileIO.swift`, `Export/PalmierProjectExporter.swift` |
| Registry | `Project/ProjectRegistry.swift`, `App/AppState.swift` |
| Constants | `Utilities/Constants.swift` (`enum Project`, `Defaults`, `TrackSize`, `Zoom`) |
| Root JSON | `Models/ProjectFile.swift`, `Editor/ViewModel/EditorViewModel+Timelines.swift` |
| Timeline/Track/Clip/Transform/Crop | `Models/Timeline.swift` |
| Keyframes | `Models/Keyframe.swift`, `Models/ClipEffectKeyframes.swift` |
| Effects | `Models/Effect.swift`, `Compositing/EffectRegistry.swift`, `Models/GradeCurve.swift`, `Models/HueCurves.swift`, `Compositing/LUTLoader.swift` |
| Text | `Models/TextStyle.swift`, `Models/TextAnimation.swift`, `Models/TextFillMode.swift`, `Models/TextLayout.swift` |
| Markers | `Models/TimelineMarker.swift` |
| Multicam | `Models/MulticamSource.swift`, `Editor/ViewModel/EditorViewModel+Multicam.swift` |
| Speakers | `Editor/ViewModel/EditorViewModel+Speakers.swift` |
| Media | `Models/MediaManifest.swift`, `Models/MediaAsset.swift`, `Models/MediaFolder.swift`, `Models/MediaResolver.swift`, `Models/ClipType.swift` |
| Chat | `Agent/Chat/ChatSessionStore.swift`, `Agent/Chat/AgentService.swift`, `Agent/Tools/ToolResult.swift`, `Agent/Chat/AgentMentionContext.swift` |
| Settings presets | `Project/Settings/ProjectSettingsPresets.swift`, `Editor/ViewModel/EditorViewModel+ProjectSettings.swift`, `Inspector/InspectorView.swift` |

---

## 0. How to read this spec

### 0.1 Swift decode semantics used in the tables

Every field in section 5 is tagged with one of these decode behaviours. They are exact descriptions of what the Mac app does when it reads a file the Linux app wrote.

| Tag | Meaning on the Mac when the key is… absent / `null` / wrong type |
|---|---|
| **required** | Throws. The error propagates to the parent object (see the blast-radius table in section 8). |
| **lenient(default)** | Field-level `try?`: absent, `null`, or wrong type all silently become `default`. |
| **optional** | Absent or `null` becomes nil. **A present value of the wrong type throws** (Swift `decodeIfPresent`). |
| **all-or-nothing** | An array decoded leniently as a whole: one bad element replaces the **entire array** with the default (usually `[]` or nil). |

> **Gotcha: synthesized `Codable` ignores Swift default values.** If a Swift struct has `var x: Int = 0` and no custom `init(from:)`, the key is **required**. That's why, for example, `Keyframe.interpolationOut`, all `MulticamSource` keys, `TimelineViewState` keys, `TextStyle.RGBA.{r,g,b,a}`, and `GradeCurve.{master,red,green,blue}` are all required even though they have defaults in Swift.

### 0.2 Encoding as written by the Mac (canonical form)

- Non-optional Swift properties are **always written**. Optional properties are **omitted when nil** (never written as `null`).
- The Linux writer should produce the same canonical form: write every non-optional key, and omit keys rather than writing `null`.

---

## 1. On-disk layout of a `.palmier` package

### 1.1 What a package is

- A `.palmier` project is a **directory** with the extension `palmier` (UTI `io.palmier.project`, conforms to `com.apple.package`, `LSTypeIsPackage = true`). macOS Finder shows it as a single file. On Linux it is a plain directory.
- The default new-project location is `~/Documents/Palmier Pro/<Name>.palmier` (`Project.storageDirectory`). The default name is `Untitled Project`. Names may not contain `/` or `\`, and may not be `.` or `..`. Creating a project whose path already exists is refused (`nameTaken`).
- The display name is the package's file name without the extension. The name is **not** stored in the JSON.

### 1.2 Package tree

```
<Name>.palmier/
├── project.json        REQUIRED  ProjectFile (timelines, view state, speakers, multicam)
├── media.json          optional  MediaManifest (media library: assets + folders)
├── thumbnail.jpg       optional  JPEG project poster for the Home screen
├── chat/               always created on save (may be empty)
│   └── <UUID>.json     one ChatSession per non-empty agent chat (UUID upper-case)
└── media/              always created on save (may be empty)
    └── <files>         media owned by the project (generated, pasted, captured, consolidated…)
```

| Constant (`enum Project`) | Value |
|---|---|
| `fileExtension` | `palmier` |
| `typeIdentifier` | `io.palmier.project` |
| `timelineFilename` | `project.json` |
| `manifestFilename` | `media.json` |
| `thumbnailFilename` | `thumbnail.jpg` |
| `mediaDirectoryName` | `media` |
| `registryFilename` | `project-registry.json` |
| `ChatSessionStore.dirName` | `chat` |

**No other files survive a Mac save.** The Mac uses NSDocument "safe save": it writes a fresh package and copies forward only `media.json` (when it is being preserved), `thumbnail.jpg`, and `media/`. Any extra file the Linux app puts in the package root will be lost the next time the Mac saves. (The LUT code comments on this: "project packages drop unknown files".) Do not store Linux-only state inside the package unless losing it is acceptable.

### 1.3 `project.json`

- UTF-8 JSON produced by a plain `JSONEncoder()`: no pretty-printing, no sorted keys, default strategies. See section 3 for number, date, and URL rules.
- Root object: `ProjectFile` (section 5.1).
- **Legacy form.** Older projects stored a bare `Timeline` object at the root. Decode algorithm, which the TS reader must replicate:
  1. Try to decode as `ProjectFile`. If that succeeds and `timelines` is non-empty, use it.
  2. Otherwise (decode error, or `timelines: []`), try to decode the same bytes as a bare `Timeline`. If that works, wrap it as `{timelines:[t], activeTimelineId:t.id, openTimelineIds:[t.id]}`.
  3. If both fail, rethrow the **first** error. The project cannot be opened.
- A missing or unreadable `project.json` means the project fails to open (`CocoaError.fileReadCorruptFile`). It is never degraded.

### 1.4 `media.json`

- Root object: `MediaManifest` (section 5.14). Plain `JSONEncoder()`.
- Missing file: the project opens with an empty library, and the file is not flagged as unreadable.
- **File present but undecodable:** the project still opens, with an empty library, and is flagged `manifestUnreadable`. While the in-memory library stays empty (no entries and no folders), **every save preserves the original bytes**: no `media.json` is written in place, and on Save-As the original is copied verbatim. As soon as the library has at least one entry or folder, a real manifest is written and the old file is replaced. The Linux port must implement the same rule so it never clobbers a recoverable manifest.

### 1.5 `thumbnail.jpg`

- JPEG with quality 0.7 and a longest edge of at most 640 px (aspect preserved).
- Source: the first candidate clip found by scanning **tracks of type `video` in array order, then clips in array order**, in the **active** timeline, whose `mediaType` is `video` or `image` and whose media resolves to a URL.
  - For a video clip, the frame is taken at source time `trimStartFrame / fps` (via a `CMTime` with value `trimStartFrame` and timescale `fps`), with the track's preferred transform applied.
  - For an image clip, the image is downscaled.
  - If a candidate fails, the next one is tried.
- It is generated lazily and asynchronously, then cached for the rest of the session. The first save after opening a project may not write one. When a save has no thumbnail, an existing `thumbnail.jpg` is carried forward (Save-As copies it from the source package).
- Sample projects use a downloaded poster image as `thumbnail.jpg`.
- The Home screen reads `<package>/thumbnail.jpg` directly.

### 1.6 `chat/`

- On every Mac save, `chat/` is **deleted and recreated** from the in-memory agent sessions. Sessions with no messages are not written.
- File name: `<ChatSession.id.uuidString>.json` (upper-case UUID). Encoded with **pretty-printed, sorted keys, and ISO-8601 dates** (unlike every other file). See section 5.15.
- On load, every `*.json` in `chat/` is decoded. Files that fail to decode are skipped silently.
- **Linux requirement:** if the Linux build does not implement agent chat, it must copy `chat/` through verbatim on save. It must not delete the directory or rewrite it from an empty state.

### 1.7 `media/` and media copy/reference rules

Media in the library is either **referenced** (an absolute path anywhere on disk) or **owned** (inside the package). A manifest entry records which one it is with `source` (section 5.14). The rule used when an asset is serialized (`MediaAsset.toManifestEntry`) is:

```
if projectURL != nil && asset.path.hasPrefix(projectURL.path):
    source = { project: { relativePath: asset.path.dropFirst(projectURL.path.length + 1) } }   // e.g. "media/gen-1A2B3C4D.mp4"
else:
    source = { external: { absolutePath: asset.path } }
```

The relative path uses `/` separators and is relative to the package root. It is not restricted to `media/`, although every writer uses `media/`. The Mac check is a plain string prefix. The Linux port should add a path-separator check (`path === root || path.startsWith(root + '/')`), which gives identical results in practice.

Where each kind of media lives. "8 hex" means the first 8 characters of a fresh upper-case UUID, unrelated to the asset id unless noted.

| Origin | Location | File name pattern | Manifest `source` |
|---|---|---|---|
| Finder / Open-panel import, drag-drop of files or folders (incl. folder trees → `MediaFolder`s) | **left in place, not copied** | original | `external(absolutePath)` |
| AI generation (video/image/audio) | `media/` | `gen-<first 8 of asset id>.<ext>`; the extension may change to the real downloaded type | `project` |
| Agent import (URL or bytes) | `media/` | `imported-<8 hex>.<ext>` | `project` |
| Paste image | `media/` | `pasted-<8 hex>.<ext>` (default `png`) | `project` |
| Frame capture | `media/` | `frame-<8 hex>.png` | `project` |
| Solid matte | `media/` | `matte-<8 hex>.png` (PNG of solid colour, even dimensions) | `project` |
| "Save clip as media" (render range) | `media/` | `clip-<8 hex>.mp4` (video) or `.m4a` (audio) | `project` |
| Consolidating export ("palmier" export mode) | `media/` of the new package | internal files keep their name; external ones become `import-<first 8 of entry id>.<ext>`; collisions get `-1`, `-2`, … | all `project` |

Rules for writing owned media (`commitStagedProjectMedia`):

1. Stage the complete file outside the package: `$TMPDIR/palmier-stage-<UUID>.<ext>`.
2. Copy it next to the package, on the same volume: `<parent>/.palmier-stage-<UUID>`.
3. Install it into `<package>/media/<filename>` with an atomic replace or move. All installs are serialized against saves (`ProjectPackageCoordinator`): a mutation requested during a save waits until the save finishes and is cancelled if the save fails.
4. With no package (the project has never been saved), the file is moved to `$TMPDIR/<filename>`. That path is then recorded as `external`.

**Missing media is never fatal.** A manifest entry whose file does not exist is marked offline. Clips keep referencing it and render as offline. The editor offers relink, which rewrites `source` using the same prefix rule.

### 1.8 Save algorithm (Mac behaviour to mirror)

`VideoProject.writeProjectPackage(snapshot, to: packageURL, sourceURL)`:

1. Create the package directory. If a **file** (not a directory) exists at that path, delete it first.
2. Write `project.json` atomically (temp file plus rename).
3. Write `media.json` atomically, **or**, if the manifest is being preserved (section 1.4), copy `media.json` from `sourceURL` when `sourceURL != packageURL`.
4. Write `thumbnail.jpg` atomically if a thumbnail is available. Otherwise copy it from `sourceURL` when the destination differs.
5. Delete and recreate `chat/`, then write each session file.
6. If `sourceURL != packageURL` (Save-As, or NSDocument's safe-save temp location): delete the destination `media/` and copy `media/` from the source.
7. Ensure `media/` exists.

The Mac autosaves in place: after many edits, after media installs (a "checkpoint autosave"), and when the project closes. Close waits for all in-flight package mutations, then saves until nothing is unsaved.

**Linux recommendation:** write each JSON file to `<file>.tmp-<uuid>` in the same directory, `fsync`, then `rename`. Serialize saves and media installs per package through one queue, mirroring `ProjectPackageCoordinator`.

### 1.9 Load algorithm (Mac behaviour to mirror)

1. Read and decode `project.json` (section 1.3). Read `media.json` (section 1.4).
2. Apply `ProjectFile`:
   - `activeTimelineId := file.activeTimelineId` if it names an existing timeline, else `timelines[0].id`.
   - `openTimelineIds := (file.openTimelineIds ?? []).filter(existing)`. Append `activeTimelineId` if missing.
   - `viewStates := file.viewStates ?? {}`. Entries for missing timelines are ignored and are pruned on the next save.
   - `speakers := file.speakers ?? []`. `multicamGroups := file.multicamGroups ?? []`.
   - The playhead is restored as `clamp(viewState.playheadFrame, 0, totalFrames)`. A missing view state uses `{playheadFrame:0, zoomScale:4, scrollOffsetX:0}`.
3. Build library assets from manifest entries and resolve their URLs. Then check for missing files in the background:
   - **File missing, `importInput` present:** set `generationStatus` to `failed: Import interrupted` (unless it is already `failed: …`).
   - **File missing, generation recoverable** (`generationInput.backendJobId` is non-empty, and either the status is in progress or it is `failed` with `resultURLs` non-empty): set the status to `generating` and resume.
   - **File missing, otherwise:** mark the asset offline.
   - **File present:** clear `importInput` and reset the status to none unless it is `failed`. Any status other than none on an asset that cannot resume becomes none.
   - A restored `preparing` status becomes none unless the generation can resume.

### 1.10 Consolidated ("palmier") export

`PalmierProjectExporter` writes a self-contained package:

- Every resolvable entry is copied into `media/` and rewritten to `project(relativePath)`. Duplicate source paths are copied once.
- Missing entries are kept as they are (dangling).
- `project.json` is written unchanged. `thumbnail.jpg` and `chat/` are copied over if present.
- The package is built in `<parent>/.palmier-export-<UUID>.partial/`, then moved or replace-swapped into place.

This is the recommended way to move a project between macOS and Linux (section 9).

### 1.11 Sample projects

Samples are downloaded to `~/Library/Application Support/PalmierPro/Samples/<safe slug>/<safe title>.palmier`. `project.json` and `media.json` are written from the server's JSON objects with `JSONSerialization`. Downloaded files land at each `relativePath` (media and `chat/<name>`). Here "safe" means `/`, `:` and `\` are replaced by spaces and the result is trimmed (empty becomes `Sample`).

---

## 2. Project registry and app-level storage

### 2.1 Registry file

- **macOS path:** `~/Documents/Palmier Pro/project-registry.json`. This is in Documents, not Application Support.
- Content: a JSON **array** of `ProjectEntry` (section 5.16). Plain `JSONEncoder()`, written atomically. Write errors are ignored.
- **Semantics:**
  - `register(url)` (open, create, or Save-As): if an entry with a matching `standardizedFileURL` exists, set its `lastOpenedDate = now`. Otherwise append `{id: new UUID, url, createdDate: now, lastOpenedDate: now}`.
  - `updateURL(old, new)`: called on rename, move, or Save-As. It rewrites `url` and bumps `lastOpenedDate`.
  - `remove(url)` drops the entry. "Delete project" moves the package to the Trash and drops the entry if that succeeds.
  - The Home screen lists entries sorted by `lastOpenedDate` descending. An entry is "inaccessible" when the path no longer exists. Nothing scans the projects folder; only registered projects appear.
- `projectId`, used for LUT storage and telemetry, is `ProjectEntry.id.uuidString` of the open project. It is **machine-local**: the same package has different ids on different machines.

### 2.2 App storage paths: macOS vs proposed Linux (XDG)

Resolve with `XDG_*` environment variables when set and absolute, otherwise use the defaults. The app slug on Linux is `palmier-pro`.

| Purpose | macOS | Linux proposal |
|---|---|---|
| Default projects folder | `~/Documents/Palmier Pro/` | `$(xdg-user-dir DOCUMENTS)/Palmier Pro/` (fallback `~/Documents/Palmier Pro/`) |
| Project registry | `~/Documents/Palmier Pro/project-registry.json` | `$XDG_DATA_HOME/palmier-pro/project-registry.json` (default `~/.local/share/palmier-pro/`). Same JSON format. On first run, optionally import entries from `<Documents>/Palmier Pro/project-registry.json` if present and paths are local. Keeping it out of Documents avoids a Mac and Linux sharing a synced folder fighting over absolute paths. |
| LUT store (per project) | `~/Library/Application Support/PalmierPro/luts/<projectId>/<name>.cube` (`default` when no id) | `$XDG_DATA_HOME/palmier-pro/luts/<projectId>/` |
| Sample projects | `~/Library/Application Support/PalmierPro/Samples/` | `$XDG_DATA_HOME/palmier-pro/Samples/` |
| Search/ML models | `~/Library/Application Support/PalmierPro/Models/<model>-v<version>/` | `$XDG_DATA_HOME/palmier-pro/Models/` |
| Disk caches (`DiskCache`) | `~/Library/Caches/PalmierPro/{MediaVisualCache, LottieVideos, ImageVideos, AudioAnalysis, BeatAnalysis, EnhancedAudio, SpeakerVoices}/`, `skills-catalog.json` | `$XDG_CACHE_HOME/palmier-pro/<same names>/` (default `~/.cache/palmier-pro/`) |
| Transcript and embedding caches | `~/Library/Caches/io.palmier.pro/{Transcripts, Embeddings}/` | `$XDG_CACHE_HOME/palmier-pro/{Transcripts, Embeddings}/` |
| Crash log | `~/Library/Logs/PalmierPro/crash.log` | `$XDG_STATE_HOME/palmier-pro/crash.log` (default `~/.local/state/palmier-pro/`) |
| Preferences | `UserDefaults` domain `io.palmier.pro` (keys incl. `agentPanelVisible`, `mediaPanelVisible`, `inspectorPanelVisible`, `markBeats`, `markDeadAir`, `markSpeakers`, `rippleTimelineMarkers`, `searchIndexModelBaseURL`, `generationPromptExtra`, `samplesSectionExpanded`) | `$XDG_CONFIG_HOME/palmier-pro/settings.json`. Set Electron `app.setPath('userData', …)` explicitly so Chromium state does not land in `~/.config/<productName>`. |
| Agent skills | `~/.palmier/skills/<id>/SKILL.md` | same path |
| Staging temp files | `$TMPDIR/palmier-stage-<UUID>.<ext>`, `<pkg parent>/.palmier-stage-<UUID>`, `<parent>/.palmier-export-<UUID>.partial/` | `os.tmpdir()` and the same sibling-file patterns |

Cache keys are derived from file paths, sizes, and modification times (e.g. `DiskCache.sizeMtimeTag = "<size>_<Int(mtime)>"`, SHA-256 of `path|mtime|size`). Caches never need to be shared with the Mac, and the Linux port may use its own formats.

---

## 3. JSON encoding conventions (all files except `chat/*.json`)

| Aspect | Rule |
|---|---|
| Encoder | `JSONEncoder()` defaults. **Key order is unspecified** (not sorted). Readers must not depend on order, and Linux may write in any order (prefer the CodingKeys order used in this doc). No pretty-printing. |
| Missing optionals | Omitted. Never write `null`. Swift accepts `null` for optional and lenient keys, but **`null` for a required key throws**. |
| Integers (Swift `Int`) | Must be JSON integers (`30`, never `30.0` or `3e1`). Writing a non-integer into an `Int` field is a decode failure on the Mac. In TS, guard with `Number.isSafeInteger`. |
| Doubles | Full precision, shortest round-trip form. Swift writes whole values without a fraction (`1`, not `1.0`). JS `JSON.stringify` output is compatible. |
| Non-finite numbers | The Mac's encoder **throws** on NaN or ±Infinity (the save fails). JS writes `null`, which then fails to decode as required. **The Linux writer must reject or clamp non-finite values before saving.** |
| Floats (`[Float]` in speaker centroids) | Decoded with float precision. Writing a JS double is accepted. Prefer `Math.fround` to avoid drift on round-trip. |
| Booleans | `true` / `false` only (no `0` / `1`). |
| Dates | Swift `Date` with `.deferredToDate`: a **number of seconds since 2001-01-01T00:00:00Z** (Apple reference date), may be fractional. `unix = ref + 978307200`. TS: `toRef(d) = d.getTime()/1000 - 978307200`. Example: 2026-10-13T00:00:00Z → `813542400`. |
| UUID-typed fields (`ProjectEntry.id`, chat ids) | String `uuidString`: upper-case `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`. Decoding is case-insensitive. |
| String ids (timelines, tracks, clips, effects, markers, media, folders, groups) | Arbitrary strings, generated as `UUID().uuidString` (upper-case). Tests use ids like `"c1"`, so any non-empty string works. **Linux should generate `crypto.randomUUID().toUpperCase()`.** |
| URL-typed fields (`ProjectEntry.url`) | `URL.absoluteString`, e.g. `file:///Users/me/Documents/Palmier%20Pro/My%20Film.palmier/` (percent-encoded; may or may not have a trailing `/`). Decode with `new URL()` and compare after normalising (decode the percent-encoding, strip any trailing `/`, resolve `.` and `..`). |
| Paths inside manifests | Plain POSIX path strings (not URLs). `external.absolutePath` is absolute. `project.relativePath` is relative to the package root with `/` separators. |
| Enums without payload | Raw string values (tables in section 5). Unknown raw value: **required** → throws; **lenient** → default. |
| Enums with payload (`MediaSource`) | Swift synthesized form: `{"<caseName>": {"<label>": value}}`. The outer object must contain **exactly one** key. |
| Dictionaries with `String` keys | JSON objects (`viewStates`, `Effect.params`, `UpscaleSettings.*`). |
| Unknown keys | Ignored by the Mac on read **and dropped on the Mac's next save**. Linux should still round-trip unknown keys it reads (keep a passthrough bag per object) so files from newer Mac versions are not damaged when Linux saves them. |

`Utilities/JSONNumberFormatting.swift` (`roundJSONFloatingPointNumbers`, 3 decimal places, NaN → `null`) is used **only for Agent/MCP tool responses**, never for persistence. Do not round persisted numbers.

---

## 4. Units and coordinate conventions (global)

| Quantity | Unit / convention |
|---|---|
| Timeline time | **Integer frames** at the timeline's `fps` (an integer; there are no fractional or NTSC rates such as 29.97). Frame `f` ↔ seconds `f / fps`. There is no separate persisted timescale. The Mac builds `CMTime(value: frame, timescale: fps)`. |
| Project fps | Stored per timeline but **project-wide by invariant**: changing fps rewrites every timeline (section 7). The UI offers 24, 25, 30, 50, and 60. The Agent allows any integer (commonly 24, 25, 30, 48, 50, 60). New timelines default to 30. |
| Clip placement | `startFrame` and `durationFrames` are timeline frames. `endFrame = startFrame + durationFrames` (exclusive). A clip covers frames `[startFrame, endFrame)`. |
| Source trims | `trimStartFrame` / `trimEndFrame` are **source time expressed in frames at the project fps** (source seconds × fps), not source-native frames. For nested-timeline carriers they are child-timeline frames. |
| Speed | Source frames consumed per timeline frame (1 = normal, 2 = twice as fast). `sourceFramesConsumed = round(durationFrames × speed)`. |
| Keyframe `frame` | **Clip-relative** timeline-frame offset: 0 is the clip's `startFrame`. Values lie in `[0, durationFrames-1]` after normalisation. |
| `wordTimings` frames | Clip-relative timeline frames. |
| Fades | Lengths in timeline frames from the clip head and tail. |
| Marker frames | Absolute timeline frames. |
| Media durations (`MediaManifestEntry.duration`, `GenerationInput.duration`) | Seconds (Double; `GenerationInput.duration` is an Int). |
| Multicam sync offsets | Seconds (Double). |
| Canvas position and size (`Transform`, `AnimPair`) | **Normalized canvas coordinates**: x ∈ [0,1] across the canvas width, y ∈ [0,1] down the canvas height. **Origin at the top-left, y increases downward.** Width and height are each normalized to the canvas width and height respectively. Values outside 0–1 are allowed (off-canvas). |
| Crop | Edge insets as fractions (0–1) of the source frame's display-oriented width or height. |
| Rotation (`Transform.rotation`, rotation keyframes, `blur.motion` angle) | **Degrees.** `rotation` is **clockwise on screen** (y-down), pivoting on the clip box centre. |
| Tilt (`rotationX`, `rotationY`) | Degrees in `[-89, 89]`, applied as a projective 3D tilt. **Currently rendered only for text clips.** |
| Opacity | 0–1 (clamped at render). |
| Static volume (`Clip.volume`) | **Linear** gain multiplier (1 = 0 dB; maximum about 5.623 = +15 dB; 0 = mute). |
| Volume keyframes (`volumeTrack`) | **Decibels**, range [-60, +15]. Any value ≤ -60 dB means silence (linear 0). `linear = 10^(min(dB, 15)/20)`. |
| Colours (`RGBA`, speaker colours) | sRGB components 0–1, non-premultiplied alpha. |
| Text sizes (`fontSize`, shadow, border, padding, offsets, corner radius, outline width) | Points on a **1080-px-tall reference canvas**. Render size is `value × fontScale × canvasHeightPx / 1080`. |
| Text style offsets (`shadow.offsetX/Y`, `background.offsetX/Y`) | Reference points, **y-down** (positive `offsetY` moves down on screen). |
| Effect radii in `px` | Source pixels for video, image, and Lottie clips. For text clips, reference-canvas pixels (scaled by `canvasHeight / 1080`). |
| Timeline UI | `TimelineViewState.zoomScale` = points per frame (default 4, range 0.05–40). `scrollOffsetX` and `Track.displayHeight` are points (CSS px on Linux). |
| Timecode display | `HH:MM:SS:FF`, non-drop, at the project fps (`formatTimecode`). Display only; persisted solely inside chat mention metadata. |
| Seconds → frames (import) | `secondsToFrame(s, fps) = Int(s × fps)` (**truncation**, not rounding). |

---

## 5. Persisted types (TypeScript)

The TypeScript below describes the **JSON wire shape**. `?` marks keys the Mac may omit. Comments give the decode tag (section 0.1), the default applied when the tag is lenient, and units.

```ts
type Id = string;        // usually upper-case UUID string; any non-empty string accepted
type Int = number;       // MUST be an integer in JSON
type Double = number;    // MUST be finite
type RefDate = number;   // seconds since 2001-01-01T00:00:00Z (see section 3)
```

### 5.1 `ProjectFile` (`project.json` root)

```ts
interface ProjectFile {
  timelines: Timeline[];                              // required; must be non-empty (empty → legacy fallback → error)
  activeTimelineId?: Id;                              // optional; Mac always writes it
  openTimelineIds?: Id[];                             // optional; Mac always writes it (tab order)
  viewStates?: Record<Id, TimelineViewState>;         // optional; keyed by timeline id; Mac always writes it (pruned to existing timelines)
  speakers?: SpeakerRegistryEntry[];                  // optional; Mac omits when empty
  multicamGroups?: MulticamSource[];                  // optional; Mac writes only groups referenced by ≥1 clip in any timeline, omits when none
}
```

All optional keys use `decodeIfPresent`. **If any present value is malformed (e.g. one view state missing a key), the whole `ProjectFile` fails** and the project cannot be opened.

### 5.2 `TimelineViewState`

Written when the active timeline switches and on save. Not live. All three keys are **required** (synthesized Codable).

```ts
interface TimelineViewState {
  playheadFrame: Int;    // required; absolute frame (restored clamped to [0, totalFrames])
  zoomScale: Double;     // required; points per frame; Defaults.pixelsPerFrame = 4; UI range [0.05, 40]
  scrollOffsetX: Double; // required; horizontal scroll in points
}
```

### 5.3 `Timeline`

```ts
interface Timeline {
  id: Id;                    // lenient(new random UUID). ALWAYS write it: open tabs, view states, and nest carriers reference it
  name: string;              // lenient("Timeline 1"). New timelines are named "Timeline N", duplicates "<name> copy", nests "Nest N"
  fps: Int;                  // REQUIRED. Project-wide (section 7)
  width: Int;                // REQUIRED. Canvas pixels (≥2, ≤8192 per edge via the UI)
  height: Int;               // REQUIRED. Canvas pixels
  settingsConfigured: boolean; // lenient(false). false = the first imported video adopts its fps and size silently
  folderId?: Id;             // lenient optional (try?). MediaFolder the timeline appears in on the media panel
  tracks: Track[];           // REQUIRED. Each element is strict: one bad Track fails the whole project
  markers: TimelineMarker[]; // all-or-nothing, lenient([]). One bad marker drops ALL markers of this timeline
}
```

Defaults for a new timeline: `{name:"Timeline 1", fps:30, width:1920, height:1080, settingsConfigured:false, tracks:[], markers:[]}`. A brand-new project contains exactly one such timeline. Timelines created later copy fps, width, height, and `settingsConfigured` from the active timeline.

Derived values (not persisted):

- `totalFrames = max over tracks of max over clips of endFrame` (0 if the timeline is empty).
- `displayFrames = max(totalFrames, max over markers of (startFrame + max(1, durationFrames)))`.

### 5.4 `Track`

```ts
type ClipType = "video" | "audio" | "image" | "text" | "lottie" | "sequence" | "subtitle";

interface Track {
  id: Id;                   // lenient(new UUID)
  type: ClipType;           // REQUIRED and must be a valid raw value. In practice only "video" (all visual content) and "audio" are created
  name?: string;            // lenient optional; normalized on decode: whitespace-trimmed; empty → omitted;
                            //   >80 chars or containing control/newline characters → dropped (nil)
  muted: boolean;           // lenient(false). Audio tracks only (muted tracks are skipped in the mix)
  hidden: boolean;          // lenient(false). Hidden visual tracks are not composited
  syncLocked: boolean;      // lenient(true). Multicam tracks cannot be unlocked
  clips: Clip[];            // all-or-nothing, lenient([]). ⚠ ONE bad clip silently empties the whole track
  displayHeight: Double;    // lenient(44); clamped to [32, 200] on decode (TrackSize). Points
}
```

Legacy keys such as `"label"` are ignored.

### 5.5 `Clip` (all clip kinds share one struct)

```ts
type Interpolation = "linear" | "hold" | "smooth";

interface Clip {
  id: Id;                           // lenient(new UUID). Always write it
  mediaRef: string;                 // REQUIRED (may be ""). Manifest entry id; Timeline.id for nest carriers; "" for text clips
  mediaType: ClipType;              // lenient("video"). What this clip renders as (see section 6)
  sourceClipType: ClipType;         // lenient("video"). Original media type (colour coding; "sequence" = nest carrier)
  startFrame: Int;                  // REQUIRED. Timeline frame ≥ 0
  durationFrames: Int;              // REQUIRED. Timeline frames ≥ 1
  trimStartFrame: Int;              // lenient(0). Head trim (source time in project-fps frames)
  trimEndFrame: Int;                // lenient(0). Tail trim, same units
  speed: Double;                    // lenient(1). Must be 1 for "sequence" carriers (no retiming); >0
  volume: Double;                   // lenient(1). Linear gain (audio clips; ignored for picture)
  fadeInFrames: Int;                // lenient(0)
  fadeOutFrames: Int;               // lenient(0). Invariant: fadeIn + fadeOut ≤ durationFrames
  fadeInInterpolation: Interpolation;  // lenient("linear"). Only "smooth" changes the curve; "hold" behaves like linear
  fadeOutInterpolation: Interpolation; // lenient("linear")
  opacity: Double;                  // lenient(1). 0–1
  transform: Transform;             // lenient(default Transform) — malformed transform → identity
  crop: Crop;                       // lenient(default Crop)
  edgeRounding: Double;             // lenient(0); any value outside [0,1] → 0. 1 = corner radius of half the shorter visible edge
  edgeSoftness: Double;             // lenient(0); any value outside [0,1] → 0. Edge feather amount
  linkGroupId?: Id;                 // lenient optional. Clips sharing it move/trim/select/delete together
  captionGroupId?: Id;              // lenient optional. Text clips produced by one caption/subtitle generation
  multicamGroupId?: Id;             // lenient optional. → ProjectFile.multicamGroups[].id

  // Text clips (mediaType "text") only:
  textContent?: string;             // lenient optional. The text; empty/absent text clips are not rendered
  textStyle?: TextStyle;            // lenient optional (malformed → nil → renderer uses TextStyle defaults)
  textAnimation?: TextAnimation;    // lenient optional
  wordTimings?: WordTiming[];       // all-or-nothing → nil
  textFillMode?: "footage" | "inverted"; // lenient optional; absent = "color" ("color" decodes too but is never written)

  // Keyframe tracks, absent when not animated (each lenient optional: malformed → nil):
  opacityTrack?: KeyframeTrack<Double>;   // 0–1
  positionTrack?: KeyframeTrack<AnimPair>; // {a: topLeftX, b: topLeftY}, normalized — TOP-LEFT, not centre
  scaleTrack?: KeyframeTrack<AnimPair>;    // {a: width, b: height}, normalized
  rotationTrack?: KeyframeTrack<Double>;   // degrees clockwise
  cropTrack?: KeyframeTrack<Crop>;
  volumeTrack?: KeyframeTrack<Double>;     // dB [-60, +15]

  effects?: Effect[];               // all-or-nothing → nil. ⚠ one malformed effect drops every effect on the clip. Mac writes nil (omits) when empty
  blendMode?: BlendMode;            // lenient optional; absent = "normal" (source-over)
}
```

Written key order (Swift CodingKeys): `id, mediaRef, mediaType, sourceClipType, startFrame, durationFrames, trimStartFrame, trimEndFrame, speed, volume, fadeInFrames, fadeOutFrames, fadeInInterpolation, fadeOutInterpolation, opacity, transform, crop, edgeRounding, edgeSoftness, linkGroupId, captionGroupId, multicamGroupId, textContent, textStyle, textAnimation, wordTimings, textFillMode, opacityTrack, positionTrack, scaleTrack, rotationTrack, cropTrack, volumeTrack, effects, blendMode`.

The **blur** animation track is not a top-level clip key. It lives inside `effects` (section 5.8.3).

### 5.6 `Transform` and `Crop`

```ts
interface Transform {        // custom codec; ALL 9 keys always written
  centerX: Double;           // default 0.5. Box centre, normalized canvas x (0 = left edge)
  centerY: Double;           // default 0.5. Box centre, normalized canvas y (0 = TOP edge)
  width: Double;             // default 1. Box width as a fraction of canvas width
  height: Double;            // default 1. Box height as a fraction of canvas height
  rotation: Double;          // default 0. Degrees, clockwise, about the box centre
  rotationX: Double;         // default 0. Tilt degrees [-89, 89] (text only at render)
  rotationY: Double;         // default 0. Tilt degrees [-89, 89] (text only at render)
  flipHorizontal: boolean;   // default false. Mirror within the box
  flipVertical: boolean;     // default false
}
```

Decoding (`Transform.init(from:)`):

- Every key uses `decodeIfPresent`, with the defaults above. A wrong type throws. Because `Clip` decodes `transform` with `try?`, the clip then gets the identity `Transform`.
- **Legacy keys `x` / `y`.** These are used only when `centerX` / `centerY` are absent: `centerX = x + width − 0.5` and `centerY = y + height − 0.5`. This is the exact legacy formula; replicate it as written.

Semantics:

- The box is the footprint of the **uncropped** source (or of the text box for text clips). The renderer scales the source **non-uniformly** to fill the box:
  - `sx = canvasW/natW × width`, `sy = canvasH/natH × height`
  - The box is translated to the top-left `(centerX − width/2, centerY − height/2)` in canvas pixels.
  - Rotation is then applied about the centre.
- Keeping the aspect ratio is the editor's job. A clip placed on the canvas gets a **fit transform**:

```ts
function fitTransform(srcW: Int, srcH: Int, canvasW: Int, canvasH: Int): Transform {
  if (srcW <= 0 || srcH <= 0 || canvasW <= 0 || canvasH <= 0) return defaultTransform();
  const canvasAspect = canvasW / canvasH;
  const relative = (srcW / srcH) / canvasAspect;          // source aspect relative to canvas
  if (Math.abs(canvasAspect - relative * canvasAspect) < 0.02) return defaultTransform(); // Defaults.aspectTolerance
  return relative > 1
    ? { ...defaultTransform(), width: 1, height: 1 / relative }  // letterbox
    : { ...defaultTransform(), width: relative, height: 1 };     // pillarbox
}
// e.g. 1080×1920 source on a 1920×1080 canvas → width 0.31640625, height 1
```

```ts
interface Crop {             // synthesized: ALL 4 keys required when the object is present
  left: Double;              // default 0. Fraction of source width hidden from the left edge
  top: Double;               // default 0. Fraction of source height hidden from the top
  right: Double;             // default 0
  bottom: Double;            // default 0
}
```

- Inside `Clip.crop`, a malformed crop falls back to `{0,0,0,0}`. Inside `cropTrack` keyframes, a malformed crop invalidates the whole track (it becomes nil).
- The UI enforces each inset ≥ 0 and a visible fraction (`1 − left − right`, `1 − top − bottom`) of at least 0.05.
- The crop is applied in source pixel space, after display orientation (the preferred transform), **before** effects. The crop **does not move or shrink the transform box**: hidden areas simply disappear from inside the box.
- Crop presets used by the UI (not persisted): Freeform, Original, 16:9, 9:16, 1:1, 4:3, 3:4, 21:9.

### 5.7 Keyframes

```ts
interface Keyframe<V> {          // synthesized: ALL keys required
  frame: Int;                    // clip-relative offset (0 = clip start)
  value: V;
  interpolationOut: Interpolation; // REQUIRED (Swift default "smooth" is NOT applied on decode). Curve from this keyframe to the next
}
interface KeyframeTrack<V> {     // synthesized
  keyframes: Keyframe<V>[];      // required within the track object; sorted ascending by frame, unique frames
}
interface AnimPair { a: Double; b: Double; }   // both required
```

- An absent track or an empty `keyframes` array means "not animated" (the static property is used). The editor deletes a track when its last keyframe is removed. Do not write empty tracks.
- New keyframes created by the UI use `interpolationOut: "smooth"`.

Sampling (identical for every value type; `lerp` is component-wise for `AnimPair` and `Crop`):

```ts
function sample<V>(track: KeyframeTrack<V> | undefined, offset: Int, fallback: V): V {
  const k = track?.keyframes ?? [];
  if (k.length === 0) return fallback;
  if (k.length === 1) return k[0].value;
  if (offset <= k[0].frame) return k[0].value;
  if (offset >= k[k.length - 1].frame) return k[k.length - 1].value;
  const bi = k.findIndex(x => x.frame > offset);
  const a = k[bi - 1], b = k[bi];
  const t = (offset - a.frame) / (b.frame - a.frame);
  switch (a.interpolationOut) {
    case "hold":   return a.value;
    case "linear": return lerp(a.value, b.value, t);
    case "smooth": return lerp(a.value, b.value, t * t * (3 - 2 * t)); // smoothstep
  }
}
```

Resolving a clip's transform at timeline frame `f` (`offset = f − startFrame`):

```ts
size   = sample(scaleTrack, offset, {a: transform.width, b: transform.height});
topLeft = positionTrack?.keyframes.length
          ? sample(positionTrack, offset, {a:0,b:0})                       // stored as TOP-LEFT
          : { a: transform.centerX - size.a/2, b: transform.centerY - size.b/2 }; // scale about static centre
centerX = topLeft.a + size.a/2;  centerY = topLeft.b + size.b/2;
rotation = sample(rotationTrack, offset, transform.rotation);
crop     = sample(cropTrack, offset, clip.crop);
opacity  = sample(opacityTrack, offset, clip.opacity) * (mediaType !== "audio" ? fadeMultiplier(f) : 1);
volume   = clip.volume * (volumeTrack active ? dbToLinear(sample(volumeTrack, offset, 0)) : 1) * fadeMultiplier(f);
```

```ts
function fadeMultiplier(clip: Clip, f: Int): Double {
  const rel = f - clip.startFrame;
  if (rel < 0 || rel > clip.durationFrames) return 0;
  const shape = (t: number, i: Interpolation) => i === "smooth" ? t*t*(3-2*t) : t;
  const inMul  = clip.fadeInFrames  > 0 ? shape(Math.min(1, rel / clip.fadeInFrames), clip.fadeInInterpolation) : 1;
  const outMul = clip.fadeOutFrames > 0 ? shape(Math.min(1, (clip.durationFrames - rel) / clip.fadeOutFrames), clip.fadeOutInterpolation) : 1;
  return Math.min(inMul, outMul);
}
const dbToLinear = (db: number) => db <= -60 ? 0 : Math.pow(10, Math.min(db, 15) / 20);
const linearToDb = (l: number) => l <= 0 ? -60 : Math.min(15, Math.max(-60, 20 * Math.log10(l)));
```

Text clips scale their font with the box: `effectiveFontScale = textStyle.fontScale × min(size.a / transform.width, size.b / transform.height)`. Use `TextStyle` defaults if a value is non-finite or ≤ 0.

Normalisation the editor applies when a clip's duration changes (not on load, but Linux edit operations should match): drop keyframes with `frame < 0` or `frame > durationFrames`, clamp `frame` to `max(0, durationFrames − 1)`, and keep the last keyframe on a frame collision. When fps changes, frames are rescaled with `round(frame × scale)` and then clamped the same way.

### 5.8 Effects

```ts
interface Effect {
  id: Id;                              // lenient(new UUID)
  type: string;                        // REQUIRED (missing → this Effect fails → ALL clip effects dropped)
  enabled: boolean;                    // lenient(true). Disabled effects are skipped at render but kept
  params: Record<string, EffectParam>; // lenient({}) as a WHOLE: one malformed param → params becomes {}
}
interface EffectParam {                // synthesized; all optional (wrong type throws → params {})
  value?: Double;                      // static numeric value
  string?: string;                     // string payload (LUT path, curve JSON)
  track?: KeyframeTrack<Double>;       // animation of this numeric param (clip-relative frames)
}
```

- The array order is the **render order**. Effects apply after crop and before edge rounding, transform, and opacity, in source-pixel space.
- Unknown `type`s are skipped by the renderer but preserved in the file. The Linux port must preserve them as well.
- **Resolved value of a numeric param at clip offset `o`:**
  ```
  raw = (param.track has keyframes) ? sample(param.track, o, param.value ?? spec.default) : (param.value ?? spec.default)
  value = clamp(raw, spec.range)
  ```
  A param missing from `params` uses `spec.default`.
- The code assumes **at most one effect of each type** per clip (it looks effects up with `first(where:)`).
- New always-on adjustment effects are inserted in **canonical order**:
  ```
  color.exposure, color.contrast, color.highlightsShadows, color.blacksWhites, color.temperature,
  color.vibrance, color.saturation, color.wheels, color.curves, color.hueCurves, color.lut,
  detail.clarity, key.chroma, blur.gaussian, blur.sharpen, blur.noiseReduction, blur.motion,
  stylize.invert, stylize.grain, stylize.vignette, stylize.glow
  ```
  The insert index is the first existing effect whose rank (unknown = +∞) is greater than the new effect's rank, else the end. Every UI and Agent insertion of a visual effect uses this rule. `audio.denoise` is the exception: it is appended to the end.

#### 5.8.1 Effect registry (`type` ids, params, ranges, defaults)

| `type` | Display | Params (`key`: range, default, unit) | Notes |
|---|---|---|---|
| `color.exposure` | Exposure | `ev`: [-3, 3], 0 | Applied in linear light |
| `color.contrast` | Contrast | `amount`: [0.5, 1.5], 1 | |
| `color.saturation` | Saturation | `amount`: [0, 2], 1 | |
| `color.temperature` | Temperature & Tint | `temperature`: [2000, 11000], 6500, K; `tint`: [-100, 100], 0 | Neutral is 6500 K, tint 0 |
| `color.highlightsShadows` | Highlights & Shadows | `highlights`: [-1, 1], 0; `shadows`: [-1, 1], 0 | |
| `color.blacksWhites` | Levels | `blacks`: [-1, 1], 0; `whites`: [-1, 1], 0 | |
| `color.vibrance` | Vibrance | `amount`: [-1, 1], 0 | |
| `color.wheels` | Color Wheels | `lift_x`, `lift_y`: [-1, 1], 0; `lift_m`: [-0.5, 0.5], 0; `gamma_x`, `gamma_y`: [-1, 1], 0; `gamma_m`: [0.5, 2], 1; `gain_x`, `gain_y`: [-1, 1], 0; `gain_m`: [0.5, 1.5], 1 | `_x`/`_y` = wheel puck position, `_m` = master |
| `color.curves` | Curves | none numeric. **`curve`.string** = JSON of `GradeCurve` | |
| `color.hueCurves` | Hue Curves | none numeric. **`curves`.string** = JSON of `HueCurves` | Removed when the curves are an identity |
| `color.lut` | LUT | `intensity`: [0, 1], 1. **`path`.string** = absolute path of the `.cube` file | See 5.8.4 |
| `detail.clarity` | Clarity & Haze | `clarity`: [-1, 1], 0; `dehaze`: [-1, 1], 0 | |
| `key.chroma` | Chroma Key | `keyHue`: [0, 1], 0.333; `tolerance`: [0, 1], 0; `softness`: [0, 1], 0.1; `spill`: [0, 1], 0.5 | The eyedropper writes `keyHue` = picked hue, `tolerance` 0.15, `softness` 0.1 |
| `blur.gaussian` | Gaussian Blur | `radius`: [0, 100], 8, px | Also the blur animation carrier (5.8.3) |
| `blur.sharpen` | Sharpen | `amount`: [0, 2], 0.4 | |
| `blur.noiseReduction` | Noise Reduction | `amount`: [0, 1], 0 | |
| `blur.motion` | Motion Blur | `radius`: [0, 100], 0, px; `angle`: [-180, 180], 0, degrees | |
| `stylize.invert` | Invert | none | |
| `stylize.grain` | Film Grain | `amount`: [0, 1], 0; `size`: [0.5, 4], 1.5 | Animated by the frame offset |
| `stylize.vignette` | Vignette | `amount`: [-1, 1], 0; `midpoint`: [0, 1], 0.5; `roundness`: [-1, 1], 0; `feather`: [0, 1], 0.5 | |
| `stylize.glow` | Glow | `intensity`: [0, 1], 0; `radius`: [0, 100], 20, px; `threshold`: [0, 1], 0.6; `warmth`: [0, 1], 0 | |
| `audio.denoise` | Denoise (audio clips) | `amount`: [0, 1], **0.6** | Not in the visual registry. Active when `enabled && amount > 0`. The Mac bakes a denoised copy into `Caches/PalmierPro/EnhancedAudio` |

"Add Effect" creates `{type, enabled:true, params: {each key: {value: default}}}`.

#### 5.8.2 Curve payloads (JSON strings inside `EffectParam.string`)

Both are encoded with a plain `JSONEncoder` into a compact JSON string, stored as a string inside the outer JSON (so it is double-encoded).

```ts
interface CurvePoint { x: Double; y: Double; }   // both required; 0–1
interface GradeCurve {          // synthesized: ALL 4 keys required (else the string is ignored → effect no-op)
  master: CurvePoint[];         // Rec.709 luma curve
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}
// An empty array or [{0,0},{1,1}] = identity. Evaluation: piecewise-linear over points sorted by x,
// flat outside the first/last point.

interface HueCurves {           // synthesized: ALL 3 keys required
  hueVsHue: CurvePoint[];       // x = source hue (0–1, cyclic); y: 0.5 neutral → hue rotation (y−0.5)·2·maxHueShift
  hueVsSat: CurvePoint[];       // y: 0.5 neutral → saturation scale term (y−0.5)·2
  hueVsLum: CurvePoint[];       // y: 0.5 neutral → luminance shift (y−0.5)·2·maxLumShift
}
// An empty array behaves like the default 6 points at x = 0, 1/6, …, 5/6 with y 0.5.
// Evaluation is cyclic piecewise-linear (wraps across 0/1).
// Identity: every array is empty or has |y − 0.5| < 1e-4 → the effect is removed rather than persisted.
```

Example param: `"curve": {"string": "{\"master\":[{\"x\":0,\"y\":0},{\"x\":0.5,\"y\":0.6},{\"x\":1,\"y\":1}],\"red\":[],\"green\":[],\"blue\":[]}"}`.

#### 5.8.3 Blur (static vs animated; text special case)

- **Non-text clips.**
  - Static blur: an effect `blur.gaussian` with `params.radius.value = r` (clamped 0–100). The effect is removed when `r = 0`.
  - Animated blur: the same effect's `params.radius.track` (keyframes in px). `value` stays as the fallback.
  - When the track is removed and `value` is 0 or absent, the effect is removed.
- **Text clips.**
  - Static blur lives in **`textStyle.blur`**, not in an effect.
  - Animated blur uses a `blur.gaussian` effect whose `radius` param has **no `value`** (it is omitted) and a `track`. The fallback is `textStyle.blur`.
  - When the track is removed, that effect is removed.
  - Text blur radii are reference-canvas px (× canvasHeight/1080).

#### 5.8.4 LUT path portability

- `color.lut` stores an **absolute machine-local path**: the `.cube` file is copied into the app-support LUT store, `…/PalmierPro/luts/<projectId>/<file>.cube`, and that destination path is stored.
- The LUT file is **not inside the package**. Opened on another machine, the path will not resolve, and the effect silently no-ops: the renderer returns the image unchanged.
- **Linux:**
  - Preserve the string unchanged.
  - When resolution fails, optionally fall back to `<linux luts dir>/<projectId>/<basename>`, then to a user relink.
  - When the user picks a LUT, store it with the same copy-then-store rule under the XDG data dir.

### 5.9 `BlendMode`

```ts
type BlendMode =
  | "normal" | "darken" | "multiply" | "colorBurn" | "lighten" | "screen" | "colorDodge"
  | "overlay" | "softLight" | "hardLight" | "difference" | "exclusion"
  | "hue" | "saturation" | "color" | "luminosity";
```

- Absent means normal (source-over). The Mac writes an explicit value only when one is set; `"normal"` may still appear.
- The modes map to the Core Image filters `CI<Name>BlendMode` (e.g. `CIColorBurnBlendMode`). The renderer spec maps these to WebGL or ffmpeg equivalents.
- Applies to visual clips: the clip composites over the tracks below it.

### 5.10 Text

#### 5.10.1 `TextStyle`

This uses a custom lenient decoder: **every key is lenient**, so an old file picks up defaults for missing fields. Encoding is synthesized, so all keys are always written.

```ts
interface RGBA { r: Double; g: Double; b: Double; a: Double; }  // synthesized: ALL 4 required; sRGB 0–1. Default {1,1,1,1}

interface TextStyle {
  fontName: string;        // lenient("Helvetica"). PostScript font name (e.g. "Helvetica-Bold"); unknown → system font
  fontSize: Double;        // lenient(96). Reference points @1080p canvas height (captions default 48)
  fontScale: Double;       // lenient(1). Visual multiplier on every size-like field (set by resizing the text box)
  widthScale: Double;      // lenient(1). Horizontal glyph stretch; UI range [0.1, 10]
  heightScale: Double;     // lenient(1). Vertical glyph stretch; UI range [0.1, 10]
  tracking: Double;        // lenient(0). Letter spacing in reference points
  lineSpacing: Double;     // lenient(0). Extra line spacing in reference points
  fontCase: "mixed" | "uppercase" | "lowercase"; // lenient("mixed"). Display transform only; textContent is stored as typed
  isBold: boolean;         // lenient(INFERRED from the font's traits, e.g. true for "Helvetica-Bold") — always write it
  isItalic: boolean;       // lenient(INFERRED from the font's traits) — always write it
  isUnderlined: boolean;   // lenient(false)
  isStruckThrough: boolean;// lenient(false)
  isOverlined: boolean;    // lenient(false)
  color: RGBA;             // lenient(white {1,1,1,1}). Fill colour; for textFillMode "footage" this is the matte colour
  alignment: "left" | "center" | "right"; // lenient("center")
  blur: Double;            // lenient(0). Static text blur radius, reference px, [0, 100]
  shadow: Shadow;          // lenient(default Shadow) — malformed (any key missing) → whole default shadow
  background: Background;  // lenient(default)
  border: Outline;         // lenient(default). Glyph outline
}

interface Shadow {         // synthesized: ALL 5 keys required
  enabled: boolean;        // default false
  color: RGBA;             // default {0,0,0,0.6}; alpha is the shadow opacity
  offsetX: Double;         // default 0, reference points, +x right
  offsetY: Double;         // default -2, reference points, +y DOWN
  blur: Double;            // default 6, reference points
}

interface Outline {        // lenient decoder (each key)
  enabled: boolean;        // default false
  color: RGBA;             // default {0,0,0,1}
  width: Double;           // default 4, reference points (grows outward when the fill is opaque)
}

interface Background {     // lenient decoder (each key)
  enabled: boolean;        // default false
  color: RGBA;             // default {0,0,0,0.6}
  paddingX: Double;        // default 0, reference points (text inset inside the box)
  paddingY: Double;        // default 0
  cornerRadius: Double;    // default 0
  offsetX: Double;         // default 0, reference points, +x right
  offsetY: Double;         // default 0, +y down
  outlineColor: RGBA;      // default {0,0,0,1}
  outlineWidth: Double;    // default 0
}
```

**Linux font mapping.** Resolve `fontName` as a PostScript name via fontconfig (`fc-match "postscriptname=<name>"`), then apply `isBold` and `isItalic` as weight and slant. When reading a file that lacks `isBold` or `isItalic`, approximate the Mac's trait inference from the PostScript name: Bold, Black, Heavy, or Semibold implies bold; Italic or Oblique implies italic. Always write both keys.

Text box geometry:

- Text clips use `Transform` like any visual clip. The box is normalized to the canvas.
- Its "natural" size is computed by the editor: the layout width is capped at 0.9 × canvas width, padding is added for shadow, border, and background, plus a 4-reference-px slack. The box is placed centred: `topLeft = ((1−w)/2, (1−h)/2)`.
- Text is laid out inside the box, vertically centred, with word wrapping, and drawn with `alignment`.

#### 5.10.2 `TextAnimation` and `WordTiming`

```ts
type TextAnimationPreset =
  | "none"                                       // no animation
  | "popIn" | "slideUp" | "typewriter"           // whole clip / per line
  | "wordReveal" | "wordSlide" | "highlightPop" | "highlightBlock"; // per word (needs wordTimings)

interface TextAnimation {          // lenient decoder
  preset: TextAnimationPreset;     // lenient("none"); unknown value → "none"
  perWordFrames: Int;              // lenient(6). Per-word ramp length; also the entrance duration of popIn/slideUp (min 1)
  highlight?: RGBA;                // lenient optional. Active-word colour; renderer default {1, 0.85, 0, 1}
}

interface WordTiming {             // synthesized: all required
  text: string;
  startFrame: Int;                 // clip-relative
  endFrame: Int;                   // clip-relative, exclusive; start ≥ 0, end ≤ durationFrames, end ≥ start+1
}
```

The Agent exposes `"off"` for `none`. The persisted raw value is always `"none"`.

Entrance semantics: `popIn` ramps opacity 0→1 and scale 0.6→1 over `perWordFrames`. `slideUp` ramps opacity and moves y by 0.05 of the render height. The per-word presets are defined in `Compositing/TextAnimator.swift` (renderer spec).

#### 5.10.3 `TextFillMode`

| Stored value | Meaning |
|---|---|
| absent (or `"color"`) | Normal fill with `textStyle.color` |
| `"footage"` | Text acts as a matte revealing the footage below. When this mode is switched on, `textStyle.color` is set to the matte colour (default opaque black `{0,0,0,1}`) |
| `"inverted"` | Inverted matte. Rendered white with border and shadow disabled and the background alpha zeroed, then alpha-inverted |

### 5.11 `TimelineMarker`

Uses a **strict** custom decoder. **Any bad marker drops all markers of the timeline**.

```ts
interface TimelineMarker {
  id: Id;                 // REQUIRED
  name: string;           // REQUIRED. Editor: trimmed, non-empty, ≤120 chars, no control/newline characters
  startFrame: Int;        // REQUIRED. Absolute frame ≥ 0
  durationFrames: Int;    // REQUIRED. 0 = point marker; >0 = range [startFrame, startFrame+durationFrames)
  color: RGBA;            // REQUIRED (all 4 components). Editor validates 0–1. Default {0, 0.478, 1, 1}
  comment: string;        // REQUIRED (may be ""). ≤4000 chars
  status?: "open" | "review" | "resolved"; // optional, default "open" (wrong value throws → markers dropped). Mac always writes it
}
```

Markers are kept sorted by `(startFrame, id)`. When fps changes they are rescaled: `start' = max(0, round(start×s))`, and a range marker gets `duration' = max(1, round(end×s) − start')`.

### 5.12 `MulticamSource` (`ProjectFile.multicamGroups[]`)

Every key is **required** (synthesized). A malformed group fails the whole project.

```ts
interface MulticamSource {
  id: Id;                       // referenced by Clip.multicamGroupId
  name: string;                 // "Multicam N" by default
  members: MulticamMember[];
  masterMemberId: Id;           // id of the master member (sync reference)
}
interface MulticamMember {
  id: Id;
  mediaRef: Id;                 // manifest entry id of the camera or mic file
  kind: "angle" | "mic" | "both"; // angle = picture only, mic = audio only, both = picture + audio
  angleLabel: string;           // unique within the group, lower-case slug ("cam-a", "angle-2"); matched case-insensitively
  sync: SyncMap;
}
interface SyncMap {
  offsetSeconds: Double;        // member source t=0 sits at group time offsetSeconds (rebased so min usable offset = 0)
  confidence: Double;           // 0–1, rounded to 3 dp; 0 = unsynced
  locked: boolean;              // true = user-pinned offset
}
```

- Usable member: `confidence > 0 || locked`. Angles are usable members with `kind ≠ "mic"`. Mics are usable members with `kind ≠ "angle"`.
- Frame math, where `fps` is the project fps:
  - `offsetFrames = round(offsetSeconds × fps)`
  - The group origin on the timeline for a member clip is `anchorFrame = clip.startFrame − clip.trimStartFrame − offsetFrames`. All clips of one member share it.
  - `trimFrame(groupFrame) = round((groupFrame/fps − offsetSeconds) × fps)`
  - A member's coverage in group frames is `[round(off×fps), round((off+dur)×fps))`.
- Timeline layout on creation:
  - A new **video** track at index 0 holds the program, as consecutive member clips (`mediaType "video"`, `sourceClipType` = asset type, `multicamGroupId` set, fit transform).
  - One **audio** track per usable mic, appended after the existing tracks, holds `mediaType "audio"` clips.
  - Multicam tracks stay sync-locked.
- A group is saved only while at least one clip in any timeline references it.

### 5.13 `SpeakerRegistryEntry` (`ProjectFile.speakers[]`)

All keys are **required**.

```ts
interface SpeakerRegistryEntry {
  id: Int;          // 1-based speaker number
  name: string;     // default "Speaker <id>"
  color: Double[];  // [r, g, b, a] sRGB 0–1 (exactly 4; otherwise rendered blue)
  centroid: number[]; // Float32 voice-embedding centroid (model-specific length); used to re-identify voices
}
```

The per-asset speaker assignments and masks are **not** persisted. They are recomputed from caches.

### 5.14 Media library: `MediaManifest` (`media.json`)

```ts
interface MediaManifest {
  version: Int;                 // optional on decode → 1 if absent. Mac writes 2 for new manifests but RE-WRITES the decoded value (1 stays 1). Not used for branching
  entries: MediaManifestEntry[];// optional → []. ⚠ one malformed entry → whole manifest unreadable (section 1.4)
  folders: MediaFolder[];       // optional → []
}

interface MediaManifestEntry {  // synthesized
  id: Id;                       // REQUIRED. Referenced by Clip.mediaRef, MulticamMember.mediaRef, GenerationInput.*AssetIds
  name: string;                 // REQUIRED. Display name (import: file name without extension)
  type: ClipType;               // REQUIRED. "video" | "audio" | "image" | "lottie" | "subtitle" (never "text"/"sequence")
  source: MediaSource;          // REQUIRED
  duration: Double;             // REQUIRED. Seconds; 0 when unknown. Images: 5 (Defaults.imageDurationSeconds). Subtitles: last cue end
  generationInput?: GenerationInput;   // optional. Present = AI-generated asset
  sourceWidth?: Int;            // optional. Display-oriented pixel width (rotation applied)
  sourceHeight?: Int;           // optional
  sourceFPS?: Double;           // optional. Nominal frame rate (video, lottie)
  hasAudio?: boolean;           // optional on decode (→ false); Mac ALWAYS writes it. Video with audio track(s)
  folderId?: Id;                // optional. → MediaFolder.id
  cachedRemoteURL?: string;     // optional. Signed remote URL; written only while unexpired
  cachedRemoteURLExpiresAt?: RefDate; // optional; written only together with cachedRemoteURL
  generationStatus?: string;    // optional; see below
  importInput?: MediaImportInput; // optional. Present while an import/download is in flight
}

type MediaSource =
  | { external: { absolutePath: string } }   // anywhere on disk, absolute POSIX path
  | { project:  { relativePath: string } };  // relative to package root, "/" separators, e.g. "media/gen-1A2B3C4D.mp4"

interface MediaFolder {         // synthesized
  id: Id;                       // REQUIRED
  name: string;                 // REQUIRED
  parentFolderId?: Id;          // optional; absent = library root. Tree (no cycles)
}

interface MediaImportInput {    // all optional
  sourceURL?: string;
  sourcePath?: string;
  createdAt?: RefDate;
}

interface GenerationInput {     // synthesized
  prompt: string;               // REQUIRED
  model: string;                // REQUIRED. Model id in the generation catalog
  duration: Int;                // REQUIRED. Seconds requested
  aspectRatio: string;          // REQUIRED. e.g. "16:9"
  resolution?: string;
  upscaleSettings?: UpscaleSettings;
  upscaleSourceWidth?: Int;
  upscaleSourceHeight?: Int;
  upscaleSourceFPS?: Double;
  quality?: string;
  imageURLs?: string[];
  numImages?: Int;              // image only
  voice?: string;               // audio only
  lyrics?: string;
  styleInstructions?: string;
  instrumental?: boolean;
  targetLanguage?: string;
  multilingual?: boolean;
  audioInput?: string;
  generateAudio?: boolean;      // video only
  draft?: boolean;
  usesSourceVideo?: boolean;
  referenceImageURLs?: string[];
  referenceVideoURLs?: string[];
  referenceAudioURLs?: string[];
  imageURLAssetIds?: Id[];      // library asset ids for the references above
  referenceImageAssetIds?: Id[];
  referenceVideoAssetIds?: Id[];
  referenceAudioAssetIds?: Id[];
  createdAt?: RefDate;
  backendJobId?: string;        // non-empty = generation can be resumed/recovered
  outputIndex?: Int;
  resultURLs?: string[];
  costCredits?: Int;
  refundedCredits?: Int;
}

interface UpscaleSettings {     // synthesized: ALL 3 keys required when present
  selections: Record<string, string>;
  numbers: Record<string, Double>;
  toggles: Record<string, boolean>;
}
```

`generationStatus` values that are persisted (`MediaAsset.GenerationStatus.manifestValue`):

| Value | Meaning |
|---|---|
| absent | none (idle). `preparing` is transient and is never written |
| `"generating"` | Remote job running |
| `"downloading"` | Result downloading |
| `"rendering"` | Local render (e.g. save-clip-as-media) |
| `"failed: <message>"` | Failed. The message follows the literal prefix `"failed: "` |

Other rules:

- Supported import extensions (`ClipType(fileExtension:)`, lower-cased):

  | Extensions | Type |
  |---|---|
  | `mov`, `mp4`, `m4v` | video |
  | `mp3`, `wav`, `aac`, `m4a`, `aiff`, `aif`, `aifc`, `caf`, `flac` | audio |
  | `png`, `jpg`, `jpeg`, `tiff`, `heic`, `webp` | image |
  | `json`, `lottie` | lottie (validated as Lottie) |
  | `srt`, `vtt` | subtitle |

- Entry `id`s are unique. The resolver uses the first match.
- `folderId`s on entries and timelines should reference existing folders. A dangling id effectively puts the item nowhere, so treat it as root.

### 5.15 Chat sessions (`chat/<UUID>.json`)

Encoded with `JSONEncoder` using `outputFormatting = [.prettyPrinted, .sortedKeys]` and `dateEncodingStrategy = .iso8601`. **Dates are ISO-8601 strings without fractional seconds** (`2026-10-13T09:41:00Z`). A fractional-seconds string fails to decode, and the session is dropped.

```ts
interface ChatSession {
  id: string;            // REQUIRED, UUID (upper-case when written); also the file name stem
  title: string;         // REQUIRED. Default "New chat"; set from the first user text (≤40 chars)
  updatedAt: string;     // REQUIRED, ISO-8601 (no fractional seconds)
  messages: AgentMessage[]; // REQUIRED
  isOpen?: boolean;      // optional → true. Mac always writes it
}
interface AgentMessage {   // synthesized
  id: string;              // REQUIRED UUID
  role: "user" | "assistant" | "system"; // REQUIRED
  blocks: AgentContentBlock[];           // REQUIRED
  mentions: AgentMention[];              // REQUIRED (may be [])
  contextHint?: string;
}
type AgentContentBlock =   // discriminated by "kind"; custom codec
  | { kind: "thinking"; text: string; signature: string }
  | { kind: "redactedThinking"; data: string }
  | { kind: "openAIReasoning"; summary: string; encryptedContent: string; itemID?: string; model: AgentModel }
  | { kind: "text"; text: string }
  | { kind: "toolUse"; id: string; name: string; input: string /* JSON text of the tool input */ }
  | { kind: "toolResult"; toolUseId: string; content: ToolResultBlock[]; isError: boolean };
type ToolResultBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mediaType: string };
type AgentModel = "claude-sonnet-5" | "claude-opus-5" | "claude-fable-5" | "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol";
interface AgentMention {   // synthesized
  id: string;              // REQUIRED UUID
  displayName: string;     // REQUIRED
  mediaRef?: Id;
  type?: ClipType;
  clipId?: Id;
  timelineRange?: AgentTimelineRangeMention;
}
interface AgentTimelineRangeMention { // all REQUIRED
  startFrame: Int; endFrame: Int; durationFrames: Int; fps: Int;
  startTimecode: string; endTimecode: string; durationTimecode: string; // "HH:MM:SS:FF"
  rangeSemantics: string;
}
```

An unknown `AgentModel` value or an unknown `kind` makes that session file undecodable on the Mac. It is skipped, not fatal.

### 5.16 `ProjectEntry` (registry array element)

```ts
interface ProjectEntry {   // synthesized: all REQUIRED
  id: string;              // UUID string, upper-case
  url: string;             // file URL absoluteString, percent-encoded, e.g. "file:///Users/me/Documents/Palmier%20Pro/Demo.palmier/"
  createdDate: RefDate;    // seconds since 2001-01-01
  lastOpenedDate: RefDate;
}
// File = ProjectEntry[]. A malformed file → registry treated as empty (and overwritten on next mutation).
```

### 5.17 Project settings presets (not persisted as presets, only as `fps`, `width`, `height`)

| Aspect preset | Label | Width × Height |
|---|---|---|
| sixteenNine | `16:9` | 1920 × 1080 |
| nineByFourteen | `9:14` | 1080 × 1680 |
| nineSixteen | `9:16` | 1080 × 1920 |
| oneOne | `1:1` | 1080 × 1080 |
| fourThree | `4:3` | 1440 × 1080 |
| twoPointFourOne | `2.4:1` | 2592 × 1080 |

A preset "matches" when width and height are exactly equal.

| Quality preset | Short edge | Resolution rule (`resolution(currentWidth:currentHeight:)`) |
|---|---|---|
| `720p` | 720 | portrait or square (w ≤ h): `(720, Int(720·h/w))`; else `(Int(720·w/h), 720)` |
| `1080p` | 1080 | same with 1080 |
| `2K` | 1440 | same with 1440 |
| `4K` | 2160 | same with 2160 |

A quality preset "matches" when `min(w, h) == shortEdge`. Note the `Int()` truncation, which can produce odd sizes.

FPS menu: 24, 25, 30, 50, 60.

Custom aspect ratio (`CanvasAspectRatio`):

- Input is `"H:V"`, two positive finite numbers.
- The new resolution keeps the current short edge, bumped to an even number if odd: `long = round(short × max(r, 1/r) / 2) × 2`, where `r = H/V`.
- Errors: a short edge below 2 is `resolutionTooSmall`; a long edge above 8192 is `resolutionTooLarge`.
- The display label reduces `w:h` by their GCD when both terms are ≤ 100. Otherwise it is `"<ratio rounded to 2 dp>:1"` (or `"1:<…>"` for portrait).

Matte aspects (used only to size generated matte PNGs; not persisted):

| Matte aspect | Size |
|---|---|
| `Project` | canvas size, rounded down to even numbers |
| `16:9`, `9:16`, `1:1`, `4:3`, `9:14`, `2.4:1` (24:10) | `short = min(canvas w, h)`; the long edge is derived from the ratio; both even |

Multicam/agent `VideoLayout` raw values (protocol only, not persisted; the layout is baked into clip transforms and crops): `full`, `side_by_side`, `top_bottom`, `pip_bottom_right`, `pip_bottom_left`, `pip_top_right`, `pip_top_left`, `grid_2x2`, `grid_3x3`, `grid_4x4`, `main_sidebar`, `three_up`, `three_stack`.

`SourceTimecode` and `SourceTiming` (embedded SMPTE timecode or capture date) are **never persisted**. They are read from media on demand (tmcd, Sony rtmd, BWF bext).

---

## 6. Clip kinds: how each is represented

There is one `Clip` struct. The combination of `mediaType`, `sourceClipType`, `mediaRef`, and the track type determines the kind.

| Kind | Track `type` | `mediaType` | `sourceClipType` | `mediaRef` | Relevant fields / notes |
|---|---|---|---|---|---|
| Video (picture) | `video` | `video` | `video` | manifest id | transform (fit), crop, opacity, effects, blend, keyframes (pos/scale/rot/opacity/crop/blur), fades on opacity. **No audio from this clip.** Audio comes only from audio-track clips |
| Linked audio of a video | `audio` | `audio` | `video` | same manifest id | Same `linkGroupId`, timing, and trims as its video partner. `volume`, `volumeTrack`, fades on gain, `audio.denoise` |
| Audio file | `audio` | `audio` | `audio` | manifest id | Same as above, without a link |
| Image | `video` | `image` | `image` | manifest id | Default duration 5 s × fps (truncated). Trims are usually 0. Visual fields as for video |
| Lottie | `video` | `lottie` | `lottie` | manifest id | Visual fields. Duration comes from the animation |
| Text / title | `video` | `text` | `text` | `""` (key must be present) | `textContent`, `textStyle`, `textAnimation`, `textFillMode`, `transform` (text box), opacity, rotation, tilt, blur (5.8.3). Crop is not supported. `speed`/`trim` are ignored |
| Caption (from transcript/subtitles) | `video` (a new track inserted at index 0) | `text` | `text` | `""` | As text, plus `captionGroupId` (shared per generation) and `wordTimings`. Default caption font size 48, centre y about 0.9 |
| Nested timeline (picture carrier) | `video` | `sequence` | `sequence` | child `Timeline.id` | `speed` must be 1. Trims are child-timeline frames. Transform = fit of child w×h onto host canvas. Linked to the audio carrier when the child has audio clips |
| Nested timeline (audio carrier) | `audio` | `audio` | `sequence` | child `Timeline.id` | Same `linkGroupId` as the picture carrier. The carrier's `volume` scales the child mix |
| Multicam member (picture) | `video` | `video` | asset type | member `mediaRef` | `multicamGroupId`, fit transform. Timing is driven by the group sync map. Timing edits are refused |
| Multicam member (mic) | `audio` | `audio` | asset type | member `mediaRef` | `multicamGroupId` |
| Matte | `video` | `image` | `image` | manifest id of the generated `media/matte-*.png` | A plain image clip |
| Subtitle file (`.srt`/`.vtt`) | none | none | none | none | Exists only as a manifest entry of `type "subtitle"`. Placing it on the timeline creates caption **text clips**. No clip has `mediaType "subtitle"` in practice |

Creating a clip from a library asset (`placeClip`):

- `trimStartFrame` is the segment start (0 by default).
- `trimEndFrame = max(0, Int(assetDuration×fps) − trimStart − round(duration×speed))`.
- `transform = fitTransform(asset)`.
- A video asset with `hasAudio` dropped on a video track also creates the linked audio clip on an audio track.

---

## 7. Invariants

The editor maintains these. **The Mac does not re-validate most of them on load**, so the Linux reader must tolerate violations, but the Linux writer must preserve them.

1. **At least one timeline.** Timeline ids are unique. The last timeline cannot be deleted.
2. **Project-wide fps.** Every timeline has the same `fps`. Changing fps sets all of them, sets `settingsConfigured = true` on all of them, and rescales every frame quantity in every timeline by `s = new/old` using round-half-away-from-zero (Swift `.rounded()`):
   - clips are walked per track in start order: `start = max(round(start×s), previousEnd)`, `duration = max(1, round(end×s) − start)`;
   - trims, fades, keyframe frames, marker frames, and `viewStates.playheadFrame` are rescaled;
   - keyframes and fades are then clamped.

   `wordTimings` are **not** rescaled by an fps change (a known Mac behaviour; replicate it). Width and height are per-timeline. Changing the canvas re-fits clips whose transform equals the old fit transform. For other clips, it scales `transform.height` (and `scaleTrack.b`) by `oldAspect/newAspect`.
3. **Track zones.** Every non-`audio` track comes **before** every `audio` track. Index 0 is the **topmost** visual layer: compositing walks the tracks in reverse, bottom to top. Labels: video tracks are numbered upward from the zone boundary (the track just above the first audio track is V1), and audio tracks are numbered downward (A1 is the first audio track).
4. **Track/clip compatibility.** Audio tracks hold `mediaType "audio"` clips. Video tracks hold visual clips (`video`, `image`, `text`, `lottie`, `sequence`).
5. **Clips sorted by `startFrame`** within a track. The editor sorts after every mutation, and the renderer re-sorts, so an unsorted file still works. Write sorted.
6. **No overlaps within a track.** Placement clears the target region first (overwrite semantics). Overlapping clips are not rejected on load, but the renderer skips a nested carrier that overlaps its predecessor. Never write overlaps.
7. **Clip ranges.**
   - `startFrame ≥ 0`, `durationFrames ≥ 1`, `trimStartFrame ≥ 0`, `trimEndFrame ≥ 0`, `speed > 0`.
   - `fadeInFrames = clamp(fadeIn, 0, duration)` and `fadeOutFrames = clamp(fadeOut, 0, duration − fadeIn)`.
   - `edgeRounding` and `edgeSoftness` are in [0, 1]. Values outside that are reset to 0 on load.
   - Keyframe frames are in `[0, duration − 1]`, strictly increasing.
   - Track `displayHeight` is in [32, 200].
8. **Source extent.** `sourceFramesConsumed + trimStartFrame + trimEndFrame` ≈ the asset length in project frames (`round(durationFrames × speed)` + trims). This is not enforced exactly.
9. **Link groups.** Clips sharing a `linkGroupId` act as one unit (select, move, trim, delete). Typically there is one visual clip plus one audio clip with the same `mediaRef`, start, and duration. An existing offset between partners is preserved on move. Timing edits (trims, duration, speed) propagate to partners, except trim and speed for text partners. Group ids are remapped consistently when clips are duplicated.
10. **Caption groups.** `captionGroupId` groups the text clips from one captioning pass.
11. **Multicam.** Every `multicamGroupId` should resolve to a group in `ProjectFile.multicamGroups`. Groups without clips are not saved. A camera clip cannot be moved to another track, and a group's clips move together. Multicam tracks stay sync-locked.
12. **Nesting.**
    - A `sequence` carrier's `mediaRef` must be an existing timeline id. A missing child renders as offline.
    - There must be **no cycles**: a timeline may not (transitively) contain itself.
    - A child must be non-empty when nested.
    - Nested timelines share the project fps.
13. **Media references.**
    - Non-text, non-sequence clips reference a manifest entry id. A missing entry or file means the clip is offline (kept, not deleted).
    - Removing an asset removes every clip referencing it in all timelines and prunes tracks left empty.
14. **Identifier uniqueness.** Track, clip, effect, and marker ids are unique project-wide. Duplicating a timeline regenerates track, clip, marker, link-group, and caption-group ids.
15. **Markers** are sorted by `(startFrame, id)`, with the validity rules from 5.11.
16. **Effects.** At most one effect per `type` per clip. The array order is the render order.
17. **`viewStates` keys** are a subset of the timeline ids. **`openTimelineIds`** contains `activeTimelineId` and only existing ids, in tab order.
18. **Track names** are trimmed, ≤80 chars, and contain no control characters. An empty name is omitted.
19. **Manifest.** Entry ids are unique. The folder graph is a tree. `source.project.relativePath` resolves inside the package.

---

## 8. Decode blast radius (what a bad value destroys on the Mac)

| Malformed thing | Effect on the Mac |
|---|---|
| `project.json` missing or invalid JSON | Project fails to open |
| `ProjectFile.timelines` missing, empty, or containing a bad `Timeline` | Project fails to open (after the legacy fallback also fails) |
| `Timeline.fps`, `width`, `height`, or `tracks` missing or wrong type | Project fails to open |
| Any `Track.type` missing or unknown | Project fails to open |
| Any malformed value in `viewStates`, `speakers`, `multicamGroups`, `activeTimelineId`, or `openTimelineIds` | Project fails to open |
| One `Clip` missing `mediaRef`, `startFrame`, or `durationFrames`, or with a non-integer or non-numeric `startFrame`/`durationFrames` | **All clips of that track silently vanish** (`clips: []`) |
| One malformed `TimelineMarker` (incl. a missing `comment` or `color`, or an invalid `status`) | **All markers of that timeline vanish** |
| One malformed `Effect` (missing or non-string `type`; a bad `id` or `enabled` is tolerated) | **All effects of that clip vanish** |
| One malformed `EffectParam` | That effect's `params` become `{}` (defaults) |
| Malformed `wordTimings` element | `wordTimings` becomes nil |
| Malformed `KeyframeTrack` (e.g. a keyframe without `interpolationOut`) | That property becomes un-animated |
| Malformed `textStyle` sub-object (`shadow` missing a key, RGBA missing a component) | That sub-object resets to its default |
| `media.json` invalid, or one malformed entry or folder | Library opens empty; the original file is preserved until the library changes |
| `chat/<x>.json` malformed | That session is skipped |
| Registry file malformed | Registry treated as empty |

**Linux writer rule:** validate every object against section 5 before serializing. A save must never produce a file that hits a row in this table.

---

## 9. Linux port implementation checklist

1. **Reader.** Implement section 5 decoders with the exact tags: required, lenient, optional, all-or-nothing. Include the legacy bare-`Timeline` root, legacy `Transform.x/y`, track-name normalization, `displayHeight` clamping, `edgeRounding`/`edgeSoftness` range resets, and `TextStyle` trait inference.
2. **Writer.** Emit the canonical form:
   - all non-optional keys; omit absent optionals (no `null`);
   - integers for `Int` fields; finite numbers only;
   - RefDate numbers for dates (ISO-8601 strings only in `chat/`);
   - upper-case UUIDs for new ids.
3. **Round-trip unknown keys.** Keep unknown JSON keys at every object level and re-emit them. The Mac ignores them, but newer Mac versions may rely on them.
4. **Package I/O.**
   - Write each file atomically, and serialize saves and media installs per package.
   - Always create `media/` and `chat/`.
   - Preserve an unreadable `media.json` until the library is non-empty.
   - Carry `thumbnail.jpg` forward when no new thumbnail exists.
   - Copy `chat/` through verbatim if chat is not implemented.
   - Never put Linux-only files in the package root.
5. **Media sources.** Use the prefix rule in 1.7. Finder-style imports stay external. Generated, pasted, captured, and matte media go into `media/` with the filename patterns above.
6. **Cross-OS portability.**
   - External absolute paths (`/Users/…`, `/Volumes/…`, `/home/…`) will not resolve across machines; such media shows as offline. Offer relink by basename search, and the consolidated export (1.10) so all media becomes `project`-relative.
   - LUT paths are machine-local (5.8.4).
   - `projectId` is per-machine (2.1).
7. **Fonts.** Map PostScript names through fontconfig. Bundle the same fonts the Mac bundles (`Utilities/BundledFonts.swift`) so text renders identically.
8. **Directory packages on Linux.**
   - File dialogs must allow selecting a directory ending in `.palmier`. Electron: `showOpenDialog({properties:['openDirectory']})`, then validate that `project.json` exists. Also accept a path to `project.json` and use its parent.
   - New-project and Save-As create the directory.

---

## 10. Examples

### 10.1 Smallest `project.json` the Mac accepts

```json
{"timelines":[{"fps":30,"width":1920,"height":1080,"tracks":[]}]}
```

With no `media.json`, `thumbnail.jpg`, `chat/`, or `media/` present, the Mac opens this package and creates the missing pieces on its first save. The timeline gets a random id and the name "Timeline 1". **Always write `id` in practice**: view state and tabs key on it.

### 10.2 Canonical package (what the Mac would write)

`Demo.palmier/project.json` (pretty-printed here for readability; the Mac writes it compact):

```json
{
  "timelines": [
    {
      "id": "50151447-0653-41BD-B551-9E16549094E9",
      "name": "Timeline 1",
      "fps": 30,
      "width": 1920,
      "height": 1080,
      "settingsConfigured": true,
      "tracks": [
        {
          "id": "52A49CFD-421A-4C1A-B44F-8EC5A8E403B5",
          "type": "video",
          "muted": false,
          "hidden": false,
          "syncLocked": true,
          "clips": [
            {
              "id": "32FF0286-0709-4676-941A-C21D82ECE7E5",
              "mediaRef": "",
              "mediaType": "text",
              "sourceClipType": "text",
              "startFrame": 30,
              "durationFrames": 90,
              "trimStartFrame": 0,
              "trimEndFrame": 0,
              "speed": 1,
              "volume": 1,
              "fadeInFrames": 0,
              "fadeOutFrames": 0,
              "fadeInInterpolation": "linear",
              "fadeOutInterpolation": "linear",
              "opacity": 1,
              "transform": {
                "centerX": 0.5, "centerY": 0.85, "width": 0.18, "height": 0.12,
                "rotation": 0, "rotationX": 0, "rotationY": 0,
                "flipHorizontal": false, "flipVertical": false
              },
              "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 },
              "edgeRounding": 0,
              "edgeSoftness": 0,
              "textContent": "Hello",
              "textStyle": {
                "fontName": "Helvetica",
                "fontSize": 96,
                "fontScale": 1,
                "widthScale": 1,
                "heightScale": 1,
                "tracking": 0,
                "lineSpacing": 0,
                "fontCase": "mixed",
                "isBold": false,
                "isItalic": false,
                "isUnderlined": false,
                "isStruckThrough": false,
                "isOverlined": false,
                "color": { "r": 1, "g": 1, "b": 1, "a": 1 },
                "alignment": "center",
                "blur": 0,
                "shadow": {
                  "enabled": true,
                  "color": { "r": 0, "g": 0, "b": 0, "a": 0.6 },
                  "offsetX": 0, "offsetY": -2, "blur": 6
                },
                "background": {
                  "enabled": false,
                  "color": { "r": 0, "g": 0, "b": 0, "a": 0.6 },
                  "paddingX": 0, "paddingY": 0, "cornerRadius": 0,
                  "offsetX": 0, "offsetY": 0,
                  "outlineColor": { "r": 0, "g": 0, "b": 0, "a": 1 },
                  "outlineWidth": 0
                },
                "border": {
                  "enabled": false,
                  "color": { "r": 0, "g": 0, "b": 0, "a": 1 },
                  "width": 4
                }
              },
              "textAnimation": { "preset": "popIn", "perWordFrames": 6 },
              "opacityTrack": {
                "keyframes": [
                  { "frame": 0,  "value": 0, "interpolationOut": "smooth" },
                  { "frame": 15, "value": 1, "interpolationOut": "smooth" }
                ]
              }
            }
          ],
          "displayHeight": 44
        },
        {
          "id": "AFB9A400-A12F-4DB1-A349-FBF0EFF5FED1",
          "type": "video",
          "name": "A-roll",
          "muted": false,
          "hidden": false,
          "syncLocked": true,
          "clips": [
            {
              "id": "E6F51F42-BD9E-49D3-94E3-B2134CEBCD22",
              "mediaRef": "C342880C-0A3E-4960-9E5E-B9973A2FBAE2",
              "mediaType": "video",
              "sourceClipType": "video",
              "startFrame": 0,
              "durationFrames": 150,
              "trimStartFrame": 30,
              "trimEndFrame": 120,
              "speed": 1,
              "volume": 1,
              "fadeInFrames": 0,
              "fadeOutFrames": 0,
              "fadeInInterpolation": "linear",
              "fadeOutInterpolation": "linear",
              "opacity": 1,
              "transform": {
                "centerX": 0.5, "centerY": 0.5, "width": 1, "height": 1,
                "rotation": 0, "rotationX": 0, "rotationY": 0,
                "flipHorizontal": false, "flipVertical": false
              },
              "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 },
              "edgeRounding": 0,
              "edgeSoftness": 0,
              "linkGroupId": "F70968A8-06CA-4CA2-A7DE-64E4A645BC0C",
              "effects": [
                {
                  "id": "DECC94A9-A7EE-4D99-8D00-2C68AD3E3A0F",
                  "type": "color.saturation",
                  "enabled": true,
                  "params": { "amount": { "value": 1.2 } }
                }
              ]
            }
          ],
          "displayHeight": 44
        },
        {
          "id": "B1D71130-2681-428D-A550-B145AFA7F246",
          "type": "audio",
          "muted": false,
          "hidden": false,
          "syncLocked": true,
          "clips": [
            {
              "id": "D686FC77-E74B-4CFD-B3A0-A0984688D43B",
              "mediaRef": "C342880C-0A3E-4960-9E5E-B9973A2FBAE2",
              "mediaType": "audio",
              "sourceClipType": "video",
              "startFrame": 0,
              "durationFrames": 150,
              "trimStartFrame": 30,
              "trimEndFrame": 120,
              "speed": 1,
              "volume": 1,
              "fadeInFrames": 0,
              "fadeOutFrames": 15,
              "fadeInInterpolation": "linear",
              "fadeOutInterpolation": "smooth",
              "opacity": 1,
              "transform": {
                "centerX": 0.5, "centerY": 0.5, "width": 1, "height": 1,
                "rotation": 0, "rotationX": 0, "rotationY": 0,
                "flipHorizontal": false, "flipVertical": false
              },
              "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 },
              "edgeRounding": 0,
              "edgeSoftness": 0,
              "linkGroupId": "F70968A8-06CA-4CA2-A7DE-64E4A645BC0C"
            }
          ],
          "displayHeight": 44
        }
      ],
      "markers": [
        {
          "id": "D7F28441-2D1F-4968-9C67-2DF1AC75DF02",
          "name": "Review this",
          "startFrame": 60,
          "durationFrames": 0,
          "color": { "r": 0, "g": 0.478, "b": 1, "a": 1 },
          "comment": "",
          "status": "open"
        }
      ]
    }
  ],
  "activeTimelineId": "50151447-0653-41BD-B551-9E16549094E9",
  "openTimelineIds": ["50151447-0653-41BD-B551-9E16549094E9"],
  "viewStates": {
    "50151447-0653-41BD-B551-9E16549094E9": { "playheadFrame": 0, "zoomScale": 4, "scrollOffsetX": 0 }
  }
}
```

Consistency of this example:

- The asset is 10 s at 30 fps, so it spans 300 source frames.
- The clips start 1 s in: `trimStartFrame` 30.
- They show 150 frames: `trimEndFrame = 300 − 30 − 150 = 120`.
- The text track (index 0) is drawn above the video track (index 1). The audio track comes last.

`Demo.palmier/media.json`:

```json
{
  "version": 2,
  "entries": [
    {
      "id": "C342880C-0A3E-4960-9E5E-B9973A2FBAE2",
      "name": "interview",
      "type": "video",
      "source": { "external": { "absolutePath": "/Users/alex/Movies/interview.mp4" } },
      "duration": 10,
      "sourceWidth": 1920,
      "sourceHeight": 1080,
      "sourceFPS": 30,
      "hasAudio": true
    },
    {
      "id": "74BC5EF8-5C6E-47D1-A15B-95FEBC955A89",
      "name": "Matte · 1920×1080",
      "type": "image",
      "source": { "project": { "relativePath": "media/matte-1F0C9A2B.png" } },
      "duration": 5,
      "sourceWidth": 1920,
      "sourceHeight": 1080,
      "hasAudio": false,
      "folderId": "75793273-D834-4F3F-B4A9-B598E8AE77BF"
    }
  ],
  "folders": [
    { "id": "75793273-D834-4F3F-B4A9-B598E8AE77BF", "name": "Mattes" }
  ]
}
```

Package tree for this example:

```
Demo.palmier/
├── project.json
├── media.json
├── thumbnail.jpg          (once generated)
├── chat/                  (empty)
└── media/
    └── matte-1F0C9A2B.png
```

`~/Documents/Palmier Pro/project-registry.json` (macOS):

```json
[{"id":"4B978589-5BA3-42E9-B801-0FB214B02E5C","url":"file:///Users/alex/Documents/Palmier%20Pro/Demo.palmier/","createdDate":813542400,"lastOpenedDate":813542400}]
```

### 10.3 Nested-timeline carrier pair (fragment)

The child timeline `"9F0…"` has 120 frames including audio. The carriers are inserted into the host at frame 300:

```json
{ "id": "…", "mediaRef": "9F0…", "mediaType": "sequence", "sourceClipType": "sequence",
  "startFrame": 300, "durationFrames": 120, "trimStartFrame": 0, "trimEndFrame": 0, "speed": 1, "volume": 1,
  "fadeInFrames": 0, "fadeOutFrames": 0, "fadeInInterpolation": "linear", "fadeOutInterpolation": "linear",
  "opacity": 1, "transform": { "centerX": 0.5, "centerY": 0.5, "width": 1, "height": 1, "rotation": 0,
  "rotationX": 0, "rotationY": 0, "flipHorizontal": false, "flipVertical": false },
  "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 }, "edgeRounding": 0, "edgeSoftness": 0,
  "linkGroupId": "L1" }
```

The audio-track twin is identical except for `"mediaType": "audio"` and its own `id`, and it carries the same `"linkGroupId": "L1"`.

### 10.4 Animated blur on a text clip (effects fragment)

```json
"textStyle": { "...": "...", "blur": 4 },
"effects": [
  { "id": "…", "type": "blur.gaussian", "enabled": true,
    "params": { "radius": { "track": { "keyframes": [
      { "frame": 0,  "value": 20, "interpolationOut": "linear" },
      { "frame": 10, "value": 0,  "interpolationOut": "smooth" } ] } } } }
]
```

The `radius` param deliberately has no `value` for text clips. The static fallback is `textStyle.blur`.
