# 04 — Rendering, Compositing, Effects, Text, Audio Mix & Export

Implementation-ready spec of how Palmier Pro turns a `Timeline` into pixels and samples, derived from the
Swift source (`Sources/PalmierPro` in palmier-io/palmier-pro at tag `last-gpl-source`, read-only reference). The Linux
target is **WebGL2 / GLSL ES 3.00** in Chromium for the preview, the **same renderer offscreen** feeding
**FFmpeg** for export, **Canvas2D** for text rasterisation, and Web Audio / an in-app mixer for audio.

Source map (paths relative to `Sources/PalmierPro/`, repo-root `Metal/` and `Plugins/`):

| Area | Files |
|---|---|
| Frame compositor | `Compositing/FrameRenderer.swift`, `Compositing/CustomVideoCompositor.swift`, `Compositing/CompositorInstruction.swift` |
| Composition / timing / audio mix | `Preview/CompositionBuilder.swift`, `Preview/NestFlattener.swift`, `Preview/VideoEngine.swift` |
| Source normalisation | `Preview/ImageVideoGenerator.swift`, `Preview/AlphaVideoNormalizer.swift`, `Preview/LottieVideoGenerator.swift` |
| Effects | `Compositing/EffectRegistry.swift`, `Compositing/ColorWheels.swift`, `Compositing/LUTLoader.swift`, `Compositing/Kernels/*.swift`, `Metal/*.metal`, `Plugins/MetalCIKernelPlugin` |
| Text | `Compositing/TextFrameRenderer.swift`, `Compositing/TextAnimator.swift`, `Compositing/TextTiltGeometry.swift`, `Models/TextStyle.swift`, `Models/TextLayout.swift`, `Models/TextAnimation.swift`, `Models/TextFillMode.swift` |
| Models | `Models/Timeline.swift` (Clip/Transform/Crop), `Models/Keyframe.swift`, `Models/Effect.swift`, `Models/ClipEffectKeyframes.swift`, `Models/BlendMode.swift`, `Models/GradeCurve.swift`, `Models/HueCurves.swift`, `Models/VideoLayout.swift`, `Models/Matte.swift` |
| Overlays / hit testing | `Preview/TransformOverlayView.swift`, `Preview/CropOverlayView.swift`, `Preview/PreviewHitTester.swift` |
| Export | `Export/ExportOptions.swift`, `Export/ExportService.swift`, `Export/HDRVideoExporter.swift`, `Export/ExportQueue.swift`, `Export/ExportView.swift`, `Export/XMLExporter.swift`, `Export/FCPXMLExporter.swift`, `Export/PalmierProjectExporter.swift`, `Preview/TimelineRenderer.swift`, `Preview/FrameCaptureRenderer.swift` |
| Audio | `Audio/AudioEnvelope.swift` (analysis only), `Audio/AudioEnhancer.swift` (denoise), `Inspector/InspectorView.swift:1139` (`VolumeScale`) |

Markers (same convention as `03-editor-ops.md`):
- **[QUIRK]** — surprising/buggy source behaviour. Port faithfully unless §14 says otherwise.
- **[NOT IN SOURCE]** — requested feature that Palmier Pro does not implement.
- **[APPROX]** — macOS uses a closed-source Core Image filter; the math given is an equivalent
  reconstruction that must be calibrated against reference frames rendered on macOS (§13).

---

## 0. Conventions

### 0.1 Coordinate spaces

| Name | Origin / axis | Units | Used for |
|---|---|---|---|
| **canvas px** | top-left, +y **down** | output pixels, `W × H` = render size | layer placement, text layout |
| **normalized canvas** | top-left, +y down | `0…1` of `W`/`H` | `Transform.centerX/Y/width/height` |
| **source px** | top-left of the *display-oriented* source (rotation metadata already applied), +y down | source pixels, `natW × natH` | crop rect, effects, edge rounding |
| **reference points** | — | points on a 1080-px-high canvas | text sizes, paddings, shadow, stroke |

Core Image on macOS is y-up (bottom-left origin); the Swift code conjugates every transform with
`flipY(h) = [1 0; 0 −1] + (0, h)` (`FrameRenderer.swift:466-468`). Everything below is already converted
to the y-down convention. **Store every working texture top-row-first** (texel row 0 = top of the image),
so that in a fragment shader `gl_FragCoord.xy` is a y-down pixel coordinate (pixel centres at `+0.5`).
`gl.readPixels` then returns the top row first, which is the order FFmpeg expects.

### 0.2 Time

- Timeline positions are integer frames at `timeline.fps` (integer, default 30). `trimStartFrame` is in
  **timeline frames**, not source frames (see `03-editor-ops.md §0.1`).
- `round(x)` = round half away from zero; `trunc(x)` = toward zero (Swift `Int(x)`); see `03 §0.2`.
- Keyframe offsets are **clip-relative**: `offset = timelineFrame − clip.startFrame`.

### 0.3 Colour values

- All colour math operates on **gamma-encoded code values in 0…1** (no linear-light conversion),
  because Core Image colour management is disabled (§7). Intermediates may leave 0…1 (half-float).
- "straight" = un-premultiplied RGBA; "premul" = RGB already multiplied by A.
- `LUMA709 = (0.2126, 0.7152, 0.0722)`.
- `smoothstep(t) = t·t·(3 − 2t)` (`Models/Keyframe.swift:79`) for the 1-argument form used by animation
  code; the 3-argument GLSL form is the usual one.

---

## 1. Architecture: macOS → Linux mapping

| macOS (source) | Linux port |
|---|---|
| `CompositionBuilder.build` → `AVMutableComposition` + one `CompositorInstruction` per segment | `FramePlanner.layersAt(timeline, f)` (§2) evaluated per frame |
| `CustomVideoCompositor` (`AVVideoCompositing`) → `FrameRenderer.render` with a shared `CIContext` | `WebGL2Renderer.renderFrame(plan, f)` — one GL context per window (preview) and one offscreen (export) |
| `CIContext(workingColorSpace: NSNull, outputColorSpace: NSNull)` | No colour conversion anywhere in the GL pipeline (§7) |
| Metal CI kernels (`Metal/*.metal`, compiled by `MetalCIKernelPlugin` with `xcrun metal -fcikernel`) | GLSL ES 3.00 fragment shaders (§8) |
| Built-in `CIFilter`s | GLSL reconstructions (§8, some **[APPROX]**) |
| CoreText into a `CGContext` | Canvas2D into an `OffscreenCanvas`, uploaded as a texture (§9) |
| `AVMutableAudioMix` volume ramps | Web Audio `GainNode` ramps (preview) / `OfflineAudioContext` or in-app mixer (export) (§10) |
| `AVAssetExportSession` presets / `AVAssetWriter` HEVC HDR | `ffmpeg` child process fed raw RGBA frames + PCM audio (§11) |

Recommended GL frame pipeline (all render targets `RGBA16F`; requires `EXT_color_buffer_float`, which
Chromium exposes on all desktop GPUs):

```
canvasA (W×H, cleared to opaque black (0,0,0,1))
for layer in plan (bottom → top):
    src  = sourceTexture(layer)              // video frame / image / Lottie / nested group FBO / text raster (straight alpha)
    work = cropToRect(src, cropRectPx)       // FBO sized to the crop rect, source px            §5.2
    work = runEffects(work, clip, f)         // ping-pong FBOs at source resolution              §8
    work = edgeRounding(work)                // alpha only                                       §5.4
    canvasB = placeAndBlend(canvasA, work)   // inverse transform, bilinear, premultiply, blend  §5.5, §6
    swap(canvasA, canvasB)                   // normal blend can draw straight into canvasA with GL blending
present(canvasA) / readPixels(canvasA → RGBA8, clamped)
```

CI's default working format on Apple GPUs is half-float, so `RGBA16F` intermediates reproduce macOS
precision (8-bit sources, half-float maths, 8-bit output).

---

## 2. Frame plan: which layers, in what order

### 2.1 Track order

`timeline.tracks[0]` is the **topmost** layer. The compositor walks `timeline.tracks.reversed()` so the
layer list is bottom → top (`CompositionBuilder.swift:725-756`). Text clips are ordinary entries in the
same walk: **text layers follow track order** (they are not forced above video). [QUIRK] The comment in
`PreviewHitTester.swift:13` ("Text draws above all video") is stale; the compositor is authoritative,
so the port's hit tester should test layers in true compositor order (top track first).

### 2.2 Layer list algorithm

Port of `compositorInstructions` (`CompositionBuilder.swift:634-827`) flattened to a per-frame query
(macOS precomputes segments between clip boundaries; the result per frame is identical):

```ts
type LayerPlan =
  | { kind: 'media'; clip: Clip; natW: number; natH: number; sourceId: string }   // video/image/lottie
  | { kind: 'text'; clip: Clip; canvasW: number; canvasH: number }
  | { kind: 'group'; clip: Clip; children: LayerPlan[]; canvasW: number; canvasH: number };

function layersAt(tl: Timeline, f: number, env: Env, depth = 0): LayerPlan[] {
  const out: LayerPlan[] = [];
  for (const track of [...tl.tracks].reverse()) {          // bottom → top
    if (track.hidden) continue;                             // hidden tracks drop media AND text
    let prevEnd = -Infinity;
    for (const clip of [...track.clips].sort((a, b) => a.startFrame - b.startFrame)) {
      if (clip.durationFrames <= 0) continue;
      const active = f >= clip.startFrame && f < clip.startFrame + clip.durationFrames;
      if (clip.mediaType === 'text') {                       // never gated by overlap
        if (!clip.textContent) continue;
        if (active) out.push({ kind: 'text', clip, canvasW: env.W, canvasH: env.H });
        continue;
      }
      if (clip.mediaType === 'sequence') {
        if (clip.startFrame < prevEnd) continue;            // overlapping carrier dropped
        prevEnd = clip.startFrame + clip.durationFrames;
        if (active) { const g = groupPlan(clip, f, env, depth); if (g) out.push(g); }
        continue;
      }
      if (clip.mediaType === 'audio' || clip.mediaType === 'subtitle') continue;  // never visual
      if (clip.startFrame < prevEnd) continue;              // overlap: later clip loses for its WHOLE duration
      if (!env.isInsertable(clip)) continue;                // offline / unprocessable / zero source: does NOT advance prevEnd
      prevEnd = clip.startFrame + clip.durationFrames;
      if (active) out.push({ kind: 'media', clip, ...env.natSize(clip), sourceId: clip.mediaRef });
    }
  }
  return out;
}
```

- `env.isInsertable(clip)` = media resolves, decodes, and `sourceDurationSec > 0` after the clamp in §3.1.
  [QUIRK] An overlapping clip is excluded even in frames where the earlier clip has already ended.
- A media layer whose source has no frame at `f` (past the end of a speed-1 clip's source, §3.1) is
  silently skipped for that frame (`FrameRenderer.swift:95`).
- `subtitle` clips are never composited (captions are text clips).

### 2.3 Nested timelines (groups)

A `sequence` clip ("carrier") composites its child timeline into a **child-canvas-sized, opaque black**
buffer, then runs the carrier's own clip pipeline on it (`FrameRenderer.swift:132-153`):

```ts
function groupPlan(carrier: Clip, f: number, env: Env, depth: number): LayerPlan | null {
  if (depth >= 8) return null;                               // NestFlattener.maxDepth
  const child = env.resolveTimeline(carrier.mediaRef); if (!child) return null;
  const tracks = flattenVisual(carrier, child);              // §2.3.1, child track order preserved
  const children: LayerPlan[] = [];
  for (const clips of [...tracks].reverse()) {               // child track 0 on top
    let prevEnd = -Infinity;
    for (const c of clips) {                                 // already start-sorted
      if (c.durationFrames <= 0) continue;
      const active = f >= c.startFrame && f < c.startFrame + c.durationFrames;
      if (c.mediaType === 'text') { if (active && c.textContent) children.push({ kind:'text', clip:c, canvasW: child.width, canvasH: child.height }); }
      else if (c.mediaType === 'sequence') {
        if (c.startFrame < prevEnd) continue; prevEnd = c.startFrame + c.durationFrames;
        if (active) { const g = groupPlan(c, f, env, depth + 1); if (g) children.push(g); }
      } else {
        if (c.startFrame < prevEnd || !env.isInsertable(c)) continue;
        prevEnd = c.startFrame + c.durationFrames;
        if (active) children.push({ kind:'media', clip:c, ...env.natSize(c), sourceId: c.mediaRef });
      }
    }
  }
  return { kind: 'group', clip: carrier, children, canvasW: child.width, canvasH: child.height };
}
```

- The group renders even with zero active children: **nest gaps are opaque black**, so a carrier always
  covers what is below it inside its rect (`CompositionBuilder.swift:681`).
- Children are composited at the child canvas size `child.width × child.height` (text inside a nest uses
  the child canvas height for its 1080-reference scaling), then the carrier pipeline treats the result
  as a source image with `natSize = child canvas`, identity orientation (§5).
- Child clip properties are evaluated at the **parent** frame `f` (they were re-timed into parent frames).

#### 2.3.1 `flattenVisual` / `flattenAudio` (`Preview/NestFlattener.swift:17-73`)

```
window = [carrier.trimStartFrame, carrier.trimStartFrame + carrier.durationFrames)   // child frames
shift  = carrier.startFrame − carrier.trimStartFrame
visual: child tracks with type == 'video' && !hidden ; audio: type == 'audio' && !muted
for each child clip (start-sorted):
  start = max(clip.startFrame, window.lo); end = min(clip.endFrame, window.hi); if end <= start: drop
  headCut = start − clip.startFrame
  if headCut > 0: trimStartFrame += round(headCut × speed); fadeInFrames = 0; rebase all keyframe tracks by headCut
  if end < clip.endFrame: fadeOutFrames = 0
  startFrame = start + shift; durationFrames = end − start
  clampFadesToDuration(); clampKeyframesToDuration()
  id = carrier.id + "/" + clip.id
```

`rebase(track, offset)`: sample the track at `offset` → new keyframe at 0 (with the interpolation of the
last keyframe before `offset`, default `smooth`) unless one already lands exactly on `offset`; keep
keyframes ≥ `offset` shifted by `−offset` (`Keyframe.swift:65-76`).

### 2.4 Composition length and background

- Output frame range is `[0, N)` with `N = max(timeline.totalFrames, end of last inserted video)`;
  `totalFrames` = max `endFrame` over all clips of all tracks (audio and text included).
- An opaque black background lies under everything (`CompositionBuilder.swift:83-94`), and the frame
  base is `CIImage(color: .black)` (`FrameRenderer.swift:18`). The canvas is therefore **always opaque**.

---

## 3. Source frame timing

### 3.1 Video and audio source time (`CompositionBuilder.swift:445-496`)

```ts
/** Seconds into the source asset for timeline frame f, or null when the track is empty there. */
function sourceTimeSec(clip: Clip, f: number, fps: number, assetDurSec: number): number | null {
  const trimFrames = clip.mediaType === 'image' ? Math.max(0, clip.trimStartFrame) : clip.trimStartFrame;
  const trimSec = trimFrames / fps;
  const sourceFrames = clip.speed === 1.0
    ? clip.durationFrames
    : Math.max(1, Math.trunc(clip.durationFrames * clip.speed));   // TRUNCATION (not round)
  const srcDurSec = Math.min(sourceFrames / fps, assetDurSec - trimSec); // "baked sources can be a hair shorter"
  if (!(srcDurSec > 0)) return null;                                // clip never inserted (no layer at all)
  const local = (f - clip.startFrame) / fps;                        // 0 ≤ local < durationFrames/fps
  if (clip.speed === 1.0) return local < srcDurSec ? trimSec + local : null;
  const clipDurSec = clip.durationFrames / fps;
  return trimSec + local * (srcDurSec / clipDurSec);                // scaleTimeRange(src → clip)
}
```

- Frame pick: the decoded frame whose presentation interval contains `t`, i.e. the **last frame with
  `pts ≤ t + 1e-6`** (pts measured from the first presented frame of the stream, edit lists applied).
- [QUIRK] `sourceFrames` truncates, while `Clip.sourceFramesConsumed` (editor) rounds; the renderer uses
  the truncated value. When the clamp `assetDur − trimSec` wins on a retimed clip, the remaining
  source is stretched over the whole clip (effective speed slightly lower); on a speed-1 clip, frames
  past the source end are empty → layer skipped → whatever is below (or black) shows.
- `trimStartFrame < 0` on video makes `insertTimeRange` fail → clip never renders.
- Speed range in the UI is `0.25…4.0` (`InspectorView.swift:449`); nested carriers cannot be retimed
  (`Clip.supportsRetiming`).
- [NOT IN SOURCE] Reverse playback and freeze-frame clips do not exist. The only "freeze" behaviours are:
  stills (an image is a 30-minute 2-frame movie, §3.2), Lottie (last frame held to 1800 s, §3.2), and
  nested carriers trimmed beyond the child timeline (renders the black group base).

### 3.2 Source kinds

| Kind | macOS normalisation | Port |
|---|---|---|
| Video, opaque | decoded to 8-bit `32BGRA` by AVFoundation (`CustomVideoCompositor.swift:27-30`) | FFmpeg/WebCodecs decode → RGBA8, matrix+range only (§7.2) |
| Video with alpha (codec flag `ContainsAlphaChannel`, identity orientation) | transcoded once to premultiplied ProRes 4444 (`AlphaVideoNormalizer.swift`), then unpremultiplied in the compositor | decode straight alpha directly (net effect identical up to 8-bit rounding) |
| Image (`png jpg jpeg tiff heic webp`) | drawn **stretched** into a buffer of the asset's pixel size (longest side clamped to 4096, each side floored to even ≥ 2), black-filled if opaque / cleared if alpha, written as a 2-frame 1800 s movie (`ImageVideoGenerator.swift:16-147`) | load once as a texture of its pixel size; constant for any `t` |
| Lottie (`json`, `lottie`) | baked to ProRes 4444 with alpha at the animation fps; last frame held until 1800 s (`LottieVideoGenerator.swift:14,218-221`) | render with lottie-web at `frame = min(floor(t·fps), frameCount−1)` |
| Nested timeline | group (§2.3) | group FBO |
| Rotated video (`preferredTransform`) | display size `natSize = abs(size(bbox(pt)))`; crop is defined in display space (`FrameRenderer.swift:290-301`) | decode with autorotate; then `natSize` = decoded size |

`natSize` used by the transform (§5.5) is the display-oriented source size (`CompositionBuilder.swift:415-422`).

### 3.3 Frame index

The compositor derives `f = round(compositionTimeSec × fps)` (`FrameRenderer.swift:16`); with the CFR
grid this is the integer frame. Preview and export use the same `f`.

---

## 4. Per-frame clip property evaluation (`Models/Timeline.swift`, `Models/Keyframe.swift`)

### 4.1 Keyframe sampling (`Keyframe.swift:328-345`)

```ts
function sample<V>(kfs: Keyframe<V>[], offset: number, fallback: V, lerp: (a: V, b: V, t: number) => V): V {
  if (kfs.length === 0) return fallback;
  if (kfs.length === 1) return kfs[0].value;
  if (offset <= kfs[0].frame) return kfs[0].value;
  if (offset >= kfs[kfs.length - 1].frame) return kfs[kfs.length - 1].value;
  const bi = kfs.findIndex(k => k.frame > offset), a = kfs[bi - 1], b = kfs[bi];
  const raw = (offset - a.frame) / (b.frame - a.frame);
  switch (a.interpolationOut) {          // default 'smooth'
    case 'hold':   return a.value;
    case 'linear': return lerp(a.value, b.value, raw);
    case 'smooth': return lerp(a.value, b.value, raw * raw * (3 - 2 * raw));
  }
}
```

Tracks (all clip-relative): `opacityTrack: number`, `positionTrack: {a,b}` (**top-left**, normalized),
`scaleTrack: {a,b}` (width, height normalized), `rotationTrack: number` (deg), `cropTrack: Crop`
(component-wise lerp), `volumeTrack: number` (**dB**), effect params `EffectParam.track: number`.

### 4.2 Transform at frame (`Timeline.swift:249-301`)

```ts
function transformAt(c: Clip, f: number): Transform {
  const o = f - c.startFrame;
  const size = c.scaleTrack?.keyframes.length ? sample(c.scaleTrack.keyframes, o, {a: c.transform.width, b: c.transform.height}, lerp2)
                                              : {a: c.transform.width, b: c.transform.height};
  const tl = c.positionTrack?.keyframes.length ? sample(c.positionTrack.keyframes, o, {a: 0, b: 0}, lerp2)
                                               : {a: c.transform.centerX - size.a / 2, b: c.transform.centerY - size.b / 2};
  const rotation = c.rotationTrack?.keyframes.length ? sample(c.rotationTrack.keyframes, o, c.transform.rotation, lerp1) : c.transform.rotation;
  return { ...c.transform, centerX: tl.a + size.a / 2, centerY: tl.b + size.b / 2, width: size.a, height: size.b, rotation };
}
```

- There is **no separate anchor point**. Rotation pivots on the clip-rect centre. Scale animation pivots
  on the **centre** when position is not keyframed, but on the **top-left** when it is (position keys
  store top-left). [QUIRK]
- `rotation` degrees, positive = clockwise on screen. `rotationX/rotationY` (tilt, −89…89) are used for
  text only (§9.10). `flipHorizontal/flipVertical` are used for media only.

### 4.3 Opacity and fades (`Timeline.swift:233-242, 353-368`)

```ts
function fadeMultiplier(c: Clip, f: number): number {
  const rel = f - c.startFrame;
  if (rel < 0 || rel > c.durationFrames) return 0;
  const ramp = (t: number, i: Interp) => (i === 'smooth' ? t * t * (3 - 2 * t) : t);   // fade interps: linear|smooth
  const inMul  = c.fadeInFrames  > 0 ? ramp(Math.min(1, rel / c.fadeInFrames), c.fadeInInterpolation) : 1;
  const outMul = c.fadeOutFrames > 0 ? ramp(Math.min(1, (c.durationFrames - rel) / c.fadeOutFrames), c.fadeOutInterpolation) : 1;
  return Math.min(inMul, outMul);
}
const rawOpacityAt = (c, f) => c.opacityTrack?.keyframes.length ? sample(c.opacityTrack.keyframes, f - c.startFrame, c.opacity, lerp1) : c.opacity;
const opacityAt = (c, f) => c.mediaType !== 'audio' && (c.fadeInFrames > 0 || c.fadeOutFrames > 0)
  ? rawOpacityAt(c, f) * fadeMultiplier(c, f) : rawOpacityAt(c, f);
// renderer uses alpha = clamp(opacityAt(c, f), 0, 1); a layer with alpha == 0 is skipped
```

Fade-in starts at 0 on the first frame (`rel = 0`); fade-out reaches `1/fadeOutFrames` on the last
visible frame.

### 4.4 Crop (`Timeline.swift:698-743`)

`Crop{left,top,right,bottom}` are insets as fractions of the **display-oriented source** (not of the
canvas rect). `cropAt(f)` samples `cropTrack` (component lerp) with fallback `clip.crop`. Editor limits keep
≥ 5 % visible per axis (`Crop.minimumVisibleFraction`). Crop masks the clip rect; it never rescales the
visible region to fill the rect (§5.2).

---

## 5. Visual layer pipeline (media and nested groups)

### 5.1 Order (`FrameRenderer.applyClipPipeline`, `FrameRenderer.swift:252-335`)

1. Source image → **straight alpha** (`unpremultiplyingAlpha`, line 267).
2. **Crop** in source px (line 287-302).
3. **Effects**, in stored array order, enabled only, at clip offset `f − startFrame` (line 305-311).
4. **Edge rounding** on the cropped extent (line 313-317).
5. **Transform** to canvas (line 319-325), bilinear resample.
6. **Premultiply** (line 326).
7. **Opacity** (line 328-333) — only for `normal` blend; other modes fade the blend result (§6.3).
8. **Blend** onto the accumulator (line 106-111).

Layers with `alpha = clamp(opacityAt, 0, 1) == 0` are skipped before step 1 (lines 259-260, 141-142).

### 5.2 Crop (step 2)

```
cropRectPx = { x: L·natW, y: T·natH, w: max(1, (1−L−R)·natW), h: max(1, (1−T−B)·natH) }   // source px, y-down
```

The cropped image **keeps its position** in source space (CI `cropped(to:)` does not translate), so after
the full-frame transform of step 5 the visible part lands exactly where it was inside the clip rect.
Port: allocate the working FBO with integer size `(round(w), round(h))` at origin `(round(x), round(y))`
and copy that region; remember `cropOriginPx` for the placement shader. Skip the crop entirely when
`crop.isIdentity` (all four insets exactly 0).

### 5.3 Effects stage (step 3)

- The **effect extent is the cropped source rect in source pixels**. Every spatial parameter of a media
  clip (blur radius, glow radius, grain size, clarity radius, vignette shape, motion blur) is therefore
  measured in **source pixels**, independent of the output resolution. [QUIRK] A 20 px blur on a 4K
  source is visually half as strong as on a 1080p source. (Text clips differ: §9.10.)
- Effects that need neighbours clamp at the extent edge (`clampedToExtent`) — sample with coordinates
  clamped to the crop FBO, never beyond.
- Full effect catalogue and shaders: §8.

### 5.4 Edge rounding (step 4; `Metal/EdgeRounding.metal`, `Kernels/EdgeRoundingKernel.swift`)

Clip properties `edgeRounding`, `edgeSoftness` ∈ 0…1 (decoder resets values outside 0…1 to 0,
`Timeline.swift:502-505`). Skipped when both are 0. Applied to the cropped extent, in source px:

```glsl
// edge_rounding.frag — uniforms from §8.1 header (uSrc, uExtent = crop FBO size)
uniform float uRounding;   // clamp(edgeRounding, 0, 1)
uniform float uSoftness;   // clamp(edgeSoftness, 0, 1)
void main() {
  vec4 s = src();
  float m = min(uExtent.x, uExtent.y);
  float radius  = uRounding * m * 0.5;
  float feather = uSoftness * m * 0.5;
  vec2 center = uExtent * 0.5;
  vec2 q = abs(gl_FragCoord.xy - center) - (uExtent * 0.5 - radius);
  float dist = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;   // rounded-box SDF
  float coverage = 1.0 - smoothstep(-0.5 - feather, 0.5, dist);
  fragColor = vec4(s.rgb, s.a * coverage);
}
```

Because it runs in source px before a (normally aspect-preserving) transform, the radius is circular on
screen for fit-placed clips and elliptical for non-uniformly stretched ones.

### 5.5 Placement transform (step 5; `CompositionBuilder.swift:972-990`)

Forward map, source px `(u, v)` → canvas px `p` (y-down), with `t = transformAt(clip, f)`:

```
tl  = (t.centerX − t.width/2, t.centerY − t.height/2)
sx  = (W / natW) · t.width  · (flipH ? −1 : 1)
sy  = (H / natH) · t.height · (flipV ? −1 : 1)
tx  = (flipH ? tl.x + t.width  : tl.x) · W
ty  = (flipV ? tl.y + t.height : tl.y) · H
c   = (t.centerX · W, t.centerY · H)
θ   = t.rotation · π / 180                    // y-down ⇒ positive θ is clockwise on screen
p   = c + R(θ) · ((sx·u + tx, sy·v + ty) − c),   R(θ) = [cosθ −sinθ; sinθ cosθ]
```

So the full display-oriented source (`natW × natH`) is stretched (non-uniformly if `width/height` are
not in source aspect) onto the normalized rect `tl…tl+(width,height)`, optionally mirrored inside that
rect, then rotated about the rect centre. Inverse used by the shader:

```ts
/** 3×3 (column-major, for gl.uniformMatrix3fv) mapping canvas px → source px. */
function canvasToSource(t: Transform, natW: number, natH: number, W: number, H: number): Float32Array {
  const tlx = t.centerX - t.width / 2, tly = t.centerY - t.height / 2;
  const sx = (W / natW) * t.width * (t.flipHorizontal ? -1 : 1);
  const sy = (H / natH) * t.height * (t.flipVertical ? -1 : 1);
  const tx = (t.flipHorizontal ? tlx + t.width : tlx) * W;
  const ty = (t.flipVertical ? tly + t.height : tly) * H;
  const cx = t.centerX * W, cy = t.centerY * H, th = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  // q = R(−θ)(p − c) + c ;  (u,v) = ((q.x − tx)/sx, (q.y − ty)/sy)
  const a = cos / sx,  b = sin / sx,  e = (-cos * cx - sin * cy + cx - tx) / sx;   // u = a·px + b·py + e
  const c2 = -sin / sy, d = cos / sy, g = (sin * cx - cos * cy + cy - ty) / sy;    // v = c2·px + d·py + g
  return new Float32Array([a, c2, 0,  b, d, 0,  e, g, 1]);
}
```

(`sx` or `sy` = 0 ⇒ zero-area layer ⇒ skip.)

### 5.6 Resampling and edge antialiasing

CI samples transformed images **bilinearly** and treats everything outside the image extent as
transparent black; interpolation happens on **straight** values (premultiply happens after the
transform). Port exactly that, so layer borders get the same one-source-pixel soft edge:

```glsl
vec4 fetchLayer(ivec2 i) {                       // transparent outside the crop FBO
  if (any(lessThan(i, ivec2(0))) || any(greaterThanEqual(i, ivec2(uLayerSize)))) return vec4(0.0);
  return texelFetch(uLayer, i, 0);
}
vec4 bilinearLayer(vec2 x) {                      // x in crop-FBO px (pixel centres at +0.5)
  x -= 0.5;
  ivec2 i = ivec2(floor(x)); vec2 f = x - floor(x);
  return mix(mix(fetchLayer(i), fetchLayer(i + ivec2(1, 0)), f.x),
             mix(fetchLayer(i + ivec2(0, 1)), fetchLayer(i + ivec2(1, 1)), f.x), f.y);
}
```

No mipmapping: large downscales alias exactly as on macOS (optional quality improvement for preview only).

### 5.7 Fit / fill (placement math, editor side)

There is no fit/fill *mode* in the renderer; the `Transform` already encodes it.

- **Default placement and "Reset Scale/Transform" = aspect fit** (`EditorViewModel.swift:681-711`):
  `rel = (srcW/srcH) / (W/H)`; if `|W/H − srcW/srcH| < 0.02` → `Transform()` (full frame);
  else if `rel > 1` → `width = 1, height = 1/rel`; else `width = rel, height = 1`; centred at (0.5, 0.5).
- **Layouts** (`Models/VideoLayout.swift`, `EditorViewModel+Layout.swift`, agent tool `apply_layout`):
  slot rects in normalized canvas units:

| Layout | Slots `id: (x, y, w, h)` |
|---|---|
| `full` | `main: (0,0,1,1)` |
| `side_by_side` | `left: (0,0,.5,1)`, `right: (.5,0,.5,1)` |
| `top_bottom` | `top: (0,0,1,.5)`, `bottom: (0,.5,1,.5)` |
| `pip_*` | `main: (0,0,1,1) z0`, `inset: (x,y,.28,.28) z1`; x = 0.035 (left) or 1−0.035−0.28 (right), y likewise |
| `grid_NxN` (2,3,4) | `r{row}c{col}: (col/N, row/N, 1/N, 1/N)` |
| `main_sidebar` | `main: (0,0,.7,1)`, `sidebar: (.7,0,.3,1)` |
| `three_up` | thirds horizontally `left/center/right` |
| `three_stack` | thirds vertically `top/middle/bottom` |

  - `fit`: draw size `drawH = h, drawW = rel·h` if `rel·h ≤ w` else `drawW = w, drawH = w/rel`;
    `x = slot.x + (w − drawW)·anchorX`, `y = slot.y + (h − drawH)·anchorY`; no crop.
  - `fill` (default): crop the source to the slot's pixel aspect `(w/h)·(W/H)` with anchor
    (`cropFittingAspect`: if `srcAspect > target`: `total = 1 − target/srcAspect`, `left = total·ax`,
    `right = total − left`; else vertical analogue), then oversize the transform so the visible part fills
    the slot: `tw = w / visW`, `th = h / visH`, `x = slot.x − crop.left·tw`, `y = slot.y − crop.top·th`.

### 5.8 Opacity (step 7)

Normal blend: `alpha' = a_layer · clamp(opacityAt, 0, 1)` on straight colour, i.e. premultiplied
`(C·a·α, a·α)`. (CI `CIColorMatrix` with `inputAVector = (0,0,0,α)`; Core Image's built-in colour filters
operate on unpremultiplied colour, hence "scaling RGB would double-fade", line 329.)

### 5.9 Overlay geometry (for the port's preview overlays)

- `videoContentRect(view)`: aspect-fit of `W×H` in the view, centred (`PreviewHitTester.swift:67-78`).
- Clip rect on screen = `videoRect.origin + (tl.x·vw, tl.y·vh, width·vw, height·vh)`, rotated by
  `rotation` about its centre. Crop rect = clip rect inset by `crop·size` **in the unrotated clip frame**
  (`CropOverlayView.swift:232-239`); drag deltas are rotated into clip-local axes by `R(−θ)`.
- Media hit test: rotate the point by `R(−θ)` about the clip centre and test against the cropped rect
  (flip ignored) (`PreviewHitTester.swift:45-65`); text hit test: point-in-quad of the tilt corners (§9.10).
- Opacity ≤ 0.01 is not hittable.

---

## 6. Compositing and blend modes

### 6.1 Accumulator

`canvas = opaque black`; layers composite bottom → top. The backdrop is therefore always opaque
(`αb = 1`), which simplifies every formula below. Store premultiplied colour (equal to straight since α=1).

### 6.2 Normal (source-over)

```
P = (C·a·α, a·α)                    // straight layer colour C, coverage a, clip opacity α
out = P.rgb + B.rgb · (1 − P.a)
```

GL fast path: `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`, shader outputs premultiplied `P`.

### 6.3 Other blend modes (`FrameRenderer.swift:83-111, 156-166`)

Modes (`Models/BlendMode.swift`, JSON raw values): `normal, darken, multiply, colorBurn, lighten,
screen, colorDodge, overlay, softLight, hardLight, difference, exclusion, hue, saturation, color,
luminosity`; `blendMode == null` ⇒ `normal`. For non-normal modes the layer is **not** opacity-baked;
the CI blend filter (`CI<Mode>BlendMode`, PDF/W3C compositing semantics) is composited over the
backdrop and the result is then **cross-dissolved** with the backdrop by the clip opacity
(`CIDissolveTransition`, linear):

```
cs = straight layer colour, as = layer coverage (incl. crop/rounding/key), Cb = backdrop (opaque)
blended = (1 − as)·Cb + as·Bmode(cs, Cb)          // W3C "separable/non-separable blend" with αb = 1
out     = mix(Cb, blended, clamp(opacityAt, 0, 1))
```

`Bmode` (W3C Compositing Level 1; non-separable modes use PDF luminosity weights 0.3/0.59/0.11):

| Mode | `B(cs, cb)` per channel |
|---|---|
| multiply | `cs·cb` |
| screen | `cs + cb − cs·cb` |
| overlay | `hardLight(cb, cs)` |
| darken / lighten | `min(cs,cb)` / `max(cs,cb)` |
| colorDodge | `cb == 0 ? 0 : cs ≥ 1 ? 1 : min(1, cb/(1−cs))` |
| colorBurn | `cb ≥ 1 ? 1 : cs ≤ 0 ? 0 : 1 − min(1, (1−cb)/cs)` |
| hardLight | `cs ≤ 0.5 ? cb·2cs : screen(cb, 2cs−1)` |
| softLight | `cs ≤ 0.5 ? cb − (1−2cs)·cb·(1−cb) : cb + (2cs−1)·(D(cb) − cb)`, `D(x) = x ≤ 0.25 ? ((16x−12)x+4)x : √x` |
| difference | `abs(cs − cb)` |
| exclusion | `cs + cb − 2·cs·cb` |
| hue | `SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb))` |
| saturation | `SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb))` |
| color | `SetLum(Cs, Lum(Cb))` |
| luminosity | `SetLum(Cb, Lum(Cs))` |

Notes: values are not clamped before blending (half-float intermediates may exceed 1); the CI blend
filters are assumed to follow the PDF/W3C definitions (soft light in particular has variants) — verify in §13.
Text in `inverted` fill mode always uses `difference` regardless of `clip.blendMode` (§9.11).

### 6.4 Place-and-blend shader (complete)

```glsl
#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uLayer;       // crop FBO, straight alpha, RGBA16F
uniform vec2  uLayerSize;       // crop FBO size (px)
uniform vec2  uCropOrigin;      // crop rect origin in source px
uniform mat3  uCanvasToSource;  // §5.5 (canvas px → source px), or the text/tilt variant (§9.10)
uniform bool  uProjective;      // true for tilted text: divide by z
uniform sampler2D uBackdrop;    // accumulator so far (opaque, premultiplied), canvas size
uniform int   uMode;            // 0 normal … 15 luminosity, in BlendMode order
uniform float uOpacity;         // clamp(opacityAt, 0, 1)
out vec4 fragColor;

vec4 fetchLayer(ivec2 i) {
  if (any(lessThan(i, ivec2(0))) || any(greaterThanEqual(i, ivec2(uLayerSize)))) return vec4(0.0);
  return texelFetch(uLayer, i, 0);
}
vec4 bilinearLayer(vec2 x) {
  x -= 0.5; ivec2 i = ivec2(floor(x)); vec2 f = x - floor(x);
  return mix(mix(fetchLayer(i), fetchLayer(i + ivec2(1, 0)), f.x),
             mix(fetchLayer(i + ivec2(0, 1)), fetchLayer(i + ivec2(1, 1)), f.x), f.y);
}

vec3 bScreen(vec3 s, vec3 b) { return s + b - s * b; }
vec3 bHardLight(vec3 s, vec3 b) { return mix(b * 2.0 * s, bScreen(2.0 * s - 1.0, b), step(0.5, s)); }
float dodge1(float s, float b) { if (b <= 0.0) return 0.0; if (s >= 1.0) return 1.0; return min(1.0, b / (1.0 - s)); }
float burn1(float s, float b)  { if (b >= 1.0) return 1.0; if (s <= 0.0) return 0.0; return 1.0 - min(1.0, (1.0 - b) / s); }
float soft1(float s, float b) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(max(b, 0.0));
  return b + (2.0 * s - 1.0) * (d - b);
}
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(c.r, min(c.g, c.b)), x = max(c.r, max(c.g, c.b));
  if (n < 0.0 && l - n > 1e-6) c = l + (c - l) * l / (l - n);
  if (x > 1.0 && x - l > 1e-6) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float satOf(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
vec3 blendFn(int m, vec3 s, vec3 b) {
  if (m == 1)  return min(s, b);                                            // darken
  if (m == 2)  return s * b;                                                // multiply
  if (m == 3)  return vec3(burn1(s.r, b.r), burn1(s.g, b.g), burn1(s.b, b.b));
  if (m == 4)  return max(s, b);                                            // lighten
  if (m == 5)  return bScreen(s, b);
  if (m == 6)  return vec3(dodge1(s.r, b.r), dodge1(s.g, b.g), dodge1(s.b, b.b));
  if (m == 7)  return bHardLight(b, s);                                     // overlay
  if (m == 8)  return vec3(soft1(s.r, b.r), soft1(s.g, b.g), soft1(s.b, b.b));
  if (m == 9)  return bHardLight(s, b);
  if (m == 10) return abs(s - b);                                           // difference
  if (m == 11) return s + b - 2.0 * s * b;                                  // exclusion
  if (m == 12) return setLum(setSat(s, satOf(b)), lum(b));                  // hue
  if (m == 13) return setLum(setSat(b, satOf(s)), lum(b));                  // saturation
  if (m == 14) return setLum(s, lum(b));                                    // color
  return setLum(b, lum(s));                                                 // 15 luminosity
}

void main() {
  vec2 p = gl_FragCoord.xy;                                    // canvas px, y-down (§0.1)
  vec3 q = uCanvasToSource * vec3(p, 1.0);
  vec2 srcPx = uProjective ? q.xy / q.z : q.xy;
  vec4 c = bilinearLayer(srcPx - uCropOrigin);                 // straight
  vec4 B = texelFetch(uBackdrop, ivec2(p), 0);
  if (uMode == 0) {
    float a = c.a * uOpacity;
    fragColor = vec4(c.rgb * a + B.rgb * (1.0 - a), 1.0);
  } else {
    vec3 blended = (1.0 - c.a) * B.rgb + c.a * blendFn(uMode, c.rgb, B.rgb);
    fragColor = vec4(mix(B.rgb, blended, uOpacity), 1.0);
  }
}
```

(The "projective" path is only used for tilted text; for it `uCanvasToSource` is the inverse homography
and `uCropOrigin = 0`.)

### 6.5 Mattes and transitions

- [NOT IN SOURCE] Track mattes / luma-alpha mattes. `Models/Matte.swift` only generates a **solid-colour
  PNG** ("colour matte" media: `#RRGGBB`, even-sized canvas, `MatteAspect` presets
  `Project, 16:9, 9:16, 1:1, 4:3, 9:14, 2.4:1`, sized by the timeline's short edge) which is then an
  ordinary image clip. The only stencil-like compositing is text **footage fill** (§9.11).
- [NOT IN SOURCE] Clip-to-clip transitions. Fades are per-clip opacity/volume envelopes (§4.3, §10.3).
  "AI transition" generates a new video clip into a gap (`EditorViewModel+AITransition.swift`), retimed
  with `speed = generatedFrames / gapFrames`; it renders like any clip.

---

## 7. Colour pipeline

### 7.1 No colour management

`CustomVideoCompositor.ciContext` uses `workingColorSpace = NSNull`, `outputColorSpace = NSNull`
(`CustomVideoCompositor.swift:11-21`). Core Image therefore performs **no colour conversion**: decoded
code values flow through every filter, blend and resample and are written back unchanged. All effects
operate on **gamma-encoded** values, except where an effect explicitly linearises (§7.4).

### 7.2 Decoding (inputs)

- macOS asks AVFoundation for 8-bit `32BGRA` frames: Y'CbCr → R'G'B' using the stream's matrix and
  range; **no transfer-function or primaries conversion**.
- Port requirement: decode to RGBA8 with the stream's matrix (`bt709` default when untagged HD,
  `bt601` for SD/tagged 601, `bt2020nc` when tagged) and range (limited→full), no transfer/primaries
  conversion, then upload with `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` and
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false`. Recommended FFmpeg decode filter for preview and export
  (same path ⇒ identical pixels):
  `-vf "scale=in_color_matrix=auto:in_range=auto:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgba"`.
  Do **not** route video through `<video>` → `texImage2D`: Chromium may colour-manage it.
- Images: decoded to sRGB 8-bit (`CGColorSpace.sRGB` context) — i.e. plain 8-bit code values; ICC
  profiles other than sRGB are converted to sRGB by ImageIO on macOS. Port: decode with
  `createImageBitmap(blob, { colorSpaceConversion: 'default', premultiplyAlpha: 'none' })`.
- Text rasters are drawn in sRGB code values (§9).

### 7.3 Output tagging

Each output frame is rendered with no conversion and **tagged with the colour attachments of the
topmost visible source frame** (`colorTagSource`: top→bottom, opacity > 0, text skipped, groups
recursed); if none, tagged BT.709 primaries/transfer/matrix (`FrameRenderer.swift:23-31, 168-250`).
Port: tag every SDR export `bt709/bt709/bt709, tv range`. [QUIRK] On macOS an HLG/PQ source on top of
the stack makes the *whole* frame (including SDR layers and text) be tagged HDR. The port should not
replicate per-frame tag switching (FFmpeg tags are per stream); treat it as out of scope (§14).

### 7.4 Linearising effects

`EffectDescriptor.linearizes == true` wraps the effect in `CISRGBToneCurveToLinear` …
`CILinearToSRGBToneCurve` (`EffectRegistry.swift:73-90`). Only **Exposure** sets it. The sRGB curves
(sign-mirrored for negatives) are given in §8.4.

### 7.5 HDR

- **Inputs:** no tone mapping. 10-bit HLG/PQ sources are decoded to 8-bit RGB with their transfer
  curve intact (they look flat/washed out next to SDR material) and only the output tag changes (§7.3).
  Port recommendation: identical pass-through in phase 1; optionally add an explicit "tone-map HDR
  sources to SDR" decode (`zscale`+`tonemap`) later.
- **"HEVC 10-bit HDR" export:** the SDR composite is treated as Rec.709 and colour-converted per frame
  to BT.2100 HLG (`HDRVideoExporter.swift:128-136, 251-290`): CIContext working space ITU-R 709, input
  space ITU-R 709, output space `itur_2100_HLG` (or PQ, unused). I.e. an SDR→HLG up-mapping
  (inverse 709 transfer → linear → 709→2020 primaries → HLG OETF) — see §11.6 for FFmpeg.

### 7.6 Scopes (for reference)

`ColorScopes.measure` and `VideoEngine.histogramYRGB/hueHistogram` analyse the composited frame
(RGBA8, no colour management): Rec.709 luma, HSV hue = standard hexcone formula, saturation
`(max−min)/max`. They are measurement tools for the Agent/curves UI, not part of rendering.

---

## 8. Effects

### 8.1 Data model and evaluation (`Models/Effect.swift`, `Compositing/EffectRegistry.swift:4-91`)

```jsonc
// Clip.effects: ordered array (null when empty)
{ "id": "UUID", "type": "color.exposure", "enabled": true,
  "params": {
    "ev":    { "value": 0.5, "track": { "keyframes": [ { "frame": 0, "value": 0.5, "interpolationOut": "smooth" } ] } },
    "path":  { "string": "/abs/path/to/look.cube" },       // string params: LUT path, curve JSON
  } }
```

Per frame, for clip offset `o = f − clip.startFrame`:

```ts
function resolveParams(desc: EffectDescriptor, e: Effect, o: number, spatialScale = 1) {
  const values: Record<string, number> = {};
  for (const spec of desc.params) {
    const p = e.params[spec.key];
    const raw = p?.track?.keyframes.length ? sample(p.track.keyframes, o, p.value ?? spec.defaultValue, lerp1)
                                           : (p?.value ?? spec.defaultValue);
    values[spec.key] = Math.min(spec.range[1], Math.max(spec.range[0], raw));   // clamped to the spec range
  }
  const strings = Object.fromEntries(Object.entries(e.params).filter(([, p]) => p.string != null).map(([k, p]) => [k, p.string]));
  return { values, strings, frame: o, spatialScale };   // missing numeric key reads as 0
}
```

- Effects run in **array order**; `enabled == false` and unknown `type`s are skipped
  (`FrameRenderer.swift:305-311`). The UI inserts new effects by `canonicalOrder` rank
  (`EffectRegistry.swift:380-391`): `color.exposure, color.contrast, color.highlightsShadows,
  color.blacksWhites, color.temperature, color.vibrance, color.saturation, color.wheels, color.curves,
  color.hueCurves, color.lut, detail.clarity, key.chroma, blur.gaussian, blur.sharpen,
  blur.noiseReduction, blur.motion, stylize.invert, stylize.grain, stylize.vignette, stylize.glow`
  (insert before the first existing effect with a higher rank; unknown types rank last).
- `frame` passed to effects (grain) is the **clip offset `o`**, not the timeline frame.
- `spatialScale` is 1 for media clips and `renderH / 1080` for text (§9.10); only `blur.gaussian` uses it.
- `audio.denoise` (param `amount`, default 0.6) also lives in `effects` of audio clips; it is not visual (§10.5).
- Effects receive **straight** colour (the pipeline unpremultiplies first). Note: Core Image's built-in
  filters internally unpremultiply again, so on macOS the CIFilter-based effects see `rgb/a` on
  semi-transparent pixels. The port evaluates every effect on straight colour (the intended behaviour);
  differences are confined to partially transparent pixels.

### 8.2 Registry

| id | Display name | Category | Params `key: range = default [unit]` | Skip when | macOS implementation |
|---|---|---|---|---|---|
| `color.exposure` | Exposure | Color | `ev: −3…3 = 0` | — (linearizes) | `CIExposureAdjust` |
| `color.contrast` | Contrast | Color | `amount: 0.5…1.5 = 1` | — | `CIColorControls.contrast` |
| `color.saturation` | Saturation | Color | `amount: 0…2 = 1` | — | `CIColorControls.saturation` |
| `color.temperature` | Temperature & Tint | Color | `temperature: 2000…11000 = 6500 [K]`, `tint: −100…100 = 0` | — | `CITemperatureAndTint` (neutral → target 6500/0) |
| `color.highlightsShadows` | Highlights & Shadows | Color | `highlights: −1…1 = 0`, `shadows: −1…1 = 0` | both 0 | `HighlightsShadows.metal` |
| `color.blacksWhites` | Levels | Color | `blacks: −1…1 = 0`, `whites: −1…1 = 0` | both 0 | `Levels.metal` |
| `color.vibrance` | Vibrance | Color | `amount: −1…1 = 0` | — | `CIVibrance` |
| `color.wheels` | Color Wheels | Color | `lift_x, lift_y: −1…1 = 0`, `lift_m: −0.5…0.5 = 0`, `gamma_x, gamma_y: −1…1 = 0`, `gamma_m: 0.5…2 = 1`, `gain_x, gain_y: −1…1 = 0`, `gain_m: 0.5…1.5 = 1` | all neutral | `Wheels.metal` |
| `color.curves` | Curves | Color | string `curve` (GradeCurve JSON) | missing/identity | `GradeCurves.metal` |
| `color.hueCurves` | Hue Curves | Color | string `curves` (HueCurves JSON) | missing/identity | `HueCurves.metal` |
| `color.lut` | LUT | Color | `intensity: 0…1 = 1`; string `path` (resourceKey) | no/invalid file | `LUTTetra.metal` |
| `detail.clarity` | Clarity & Haze | Detail | `clarity: −1…1 = 0`, `dehaze: −1…1 = 0` | both 0 | blur + `Clarity.metal` |
| `key.chroma` | Chroma Key | Key | `keyHue: 0…1 = 0.333`, `tolerance: 0…1 = 0`, `softness: 0…1 = 0.1`, `spill: 0…1 = 0.5` | `tolerance ≤ 0` | `ChromaKey.metal` |
| `blur.gaussian` | Gaussian Blur | Blur & Sharpen | `radius: 0…100 = 8 [px]` | `radius·spatialScale ≤ 0` | `CIGaussianBlur` (premultiplied) |
| `blur.sharpen` | Sharpen | Blur & Sharpen | `amount: 0…2 = 0.4` | — | `CISharpenLuminance` |
| `blur.noiseReduction` | Noise Reduction | Blur & Sharpen | `amount: 0…1 = 0` | `amount ≤ 0` | `CINoiseReduction(noiseLevel = amount·0.1, sharpness = 0.4)` |
| `blur.motion` | Motion Blur | Blur & Sharpen | `radius: 0…100 = 0 [px]`, `angle: −180…180 = 0 [°]` | `radius ≤ 0` | `CIMotionBlur(angle·π/180)` |
| `stylize.invert` | Invert | Stylize | — | — | `CIColorMatrix` |
| `stylize.grain` | Film Grain | Stylize | `amount: 0…1 = 0`, `size: 0.5…4 = 1.5` | `amount ≤ 0` | `Grain.metal` |
| `stylize.vignette` | Vignette | Stylize | `amount: −1…1 = 0`, `midpoint: 0…1 = 0.5`, `roundness: −1…1 = 0`, `feather: 0…1 = 0.5` | `amount == 0` | `Vignette.metal` |
| `stylize.glow` | Glow | Stylize | `intensity: 0…1 = 0`, `radius: 0…100 = 20 [px]`, `threshold: 0…1 = 0.6`, `warmth: 0…1 = 0` | `intensity ≤ 0` | `Glow.metal` ×2 + blur |

Note `EffectRegistry.all` order (for "Add Effect" menus) is: exposure, contrast, saturation,
temperature, highlightsShadows, blacksWhites, vibrance, wheels, hueCurves, lut, curves, clarity,
gaussian, sharpen, noiseReduction, motion, invert, grain, vignette, glow, chroma.

### 8.3 Common shader header and helper passes

Every effect is a full-screen pass over the working FBO (crop-rect size, `RGBA16F`, straight alpha).
Vertex shader (no buffers needed):

```glsl
#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));   // 3-vertex full-screen triangle
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
```

Fragment header (prepend to every effect shader below):

```glsl
#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

uniform sampler2D uSrc;     // working image, straight alpha, row 0 = top
uniform vec2 uExtent;       // working size in px (crop rect)
out vec4 fragColor;

const vec3 LUMA709 = vec3(0.2126, 0.7152, 0.0722);

vec4 src() { return texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }
vec4 srcClamped(ivec2 p) { return texelFetch(uSrc, clamp(p, ivec2(0), ivec2(uExtent) - 1), 0); }   // clampedToExtent
vec4 bilinearClamped(vec2 x) {
  x -= 0.5; ivec2 i = ivec2(floor(x)); vec2 f = x - floor(x);
  return mix(mix(srcClamped(i), srcClamped(i + ivec2(1, 0)), f.x),
             mix(srcClamped(i + ivec2(0, 1)), srcClamped(i + ivec2(1, 1)), f.x), f.y);
}
// Metal/GLSL smoothstep is undefined for e0 >= e1; this one is total.
float sstep(float e0, float e1, float x) { float t = clamp((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// 256-entry RGBA32F LUT (width 256, height 1), CI-style lookup at v*256 texels, linear, clamp-to-edge.
vec4 lut1D(sampler2D t, float v) {
  float x = clamp(v * 256.0 - 0.5, 0.0, 255.0);
  int i0 = int(floor(x)); int i1 = min(i0 + 1, 255);
  return mix(texelFetch(t, ivec2(i0, 0), 0), texelFetch(t, ivec2(i1, 0), 0), x - float(i0));
}
```

Helper passes:

```glsl
// premultiply.frag
void main() { vec4 s = src(); fragColor = vec4(s.rgb * s.a, s.a); }

// unpremultiply.frag
void main() { vec4 s = src(); fragColor = s.a > 0.0 ? vec4(s.rgb / s.a, s.a) : vec4(0.0); }

// gaussian1d.frag — run with uDir=(1,0) then (0,1). Edge = clamp to extent.
uniform vec2 uDir;
uniform float uSigma;       // px
uniform int uRadius;        // ceil(3*sigma)
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uSigma < 0.01) { fragColor = texelFetch(uSrc, p, 0); return; }
  float k = 1.0 / (2.0 * uSigma * uSigma);
  vec4 acc = texelFetch(uSrc, p, 0); float wsum = 1.0;
  for (int i = 1; i <= uRadius; ++i) {
    float w = exp(-float(i * i) * k);
    ivec2 d = ivec2(uDir) * i;
    acc += w * (srcClamped(p + d) + srcClamped(p - d));
    wsum += 2.0 * w;
  }
  fragColor = acc / wsum;
}
```

**Blur radius → σ [APPROX]:** use `σ = inputRadius` px (Core Image's `CIGaussianBlur` radius behaves as
the standard deviation; verify by matching a 1-px white line on macOS). For `σ > 8`, downsample by
`k = 2^ceil(log2(σ/8))` (box), blur with `σ/k`, upsample bilinearly — visually indistinguishable and
needed for real-time preview at σ up to ~100.

### 8.4 `color.exposure` (linearizes)

`CISRGBToneCurveToLinear` → `rgb · 2^ev` (`CIExposureAdjust`) → `CILinearToSRGBToneCurve`.

```glsl
uniform float uEV;
vec3 srgbToLinear(vec3 c) {
  vec3 a = abs(c);
  return sign(c) * mix(pow((a + 0.055) / 1.055, vec3(2.4)), a / 12.92, vec3(lessThanEqual(a, vec3(0.04045))));
}
vec3 linearToSrgb(vec3 c) {
  vec3 a = abs(c);
  return sign(c) * mix(1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055, a * 12.92, vec3(lessThanEqual(a, vec3(0.0031308))));
}
void main() {
  vec4 s = src();
  fragColor = vec4(linearToSrgb(srgbToLinear(s.rgb) * exp2(uEV)), s.a);   // no clamp: values > 1 survive
}
```

### 8.5 `color.contrast`, `color.saturation` (`CIColorControls`)

Apple-documented formulas: contrast `(c − 0.5)·contrast + 0.5`; saturation = linear interpolation
between a greyscale image and the colour (extrapolates above 1). The grey weights are not documented;
Rec.709 luminance (`0.2125, 0.7154, 0.0721`) is assumed (verify, §13). No clamping.

```glsl
// contrast.frag
uniform float uAmount;
void main() { vec4 s = src(); fragColor = vec4((s.rgb - 0.5) * uAmount + 0.5, s.a); }

// saturation.frag
uniform float uAmount;
void main() {
  vec4 s = src(); float l = dot(s.rgb, vec3(0.2125, 0.7154, 0.0721));
  fragColor = vec4(mix(vec3(l), s.rgb, uAmount), s.a);
}
```

### 8.6 `color.temperature` (`CITemperatureAndTint`) [APPROX]

Semantics: `inputNeutral = (temperature, tint)` is the white point **assumed in the source**; it is
mapped to `inputTargetNeutral = (6500, 0)`. Hence `temperature > 6500` ⇒ warmer output,
`< 6500` ⇒ cooler, `(6500, 0)` ⇒ identity. Reconstruction: von-Kries/Bradford chromatic adaptation
between the two Planckian white points, applied as a 3×3 matrix directly to the (gamma-encoded) RGB,
since Core Image colour management is off.

```ts
function cctToXy(T: number): [number, number] {          // Kim et al. 2002, valid 1667–25000 K
  T = Math.min(25000, Math.max(1667, T));
  const t = 1000 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000 ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.179910
                      : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.240390;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222 ? -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
          : T <= 4000 ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
          :              3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const xyToUv = ([x, y]: number[]) => { const d = -2 * x + 12 * y + 3; return [4 * x / d, 6 * y / d]; };
const uvToXy = ([u, v]: number[]) => { const d = 2 * u - 8 * v + 4; return [3 * u / d, 2 * v / d]; };
const TINT_UV_PER_UNIT = 1 / 3000;   // calibrate (§13): ±100 tint ≈ ±0.033 Δuv
function whiteXYZ(T: number, tint: number): number[] {
  const uv = xyToUv(cctToXy(T));
  const uv2 = xyToUv(cctToXy(T + 50));                         // locus tangent
  let nx = -(uv2[1] - uv[1]), ny = uv2[0] - uv[0];             // normal
  const len = Math.hypot(nx, ny); nx /= len; ny /= len;
  if (ny < 0) { nx = -nx; ny = -ny; }                          // +v side = green
  const [x, y] = uvToXy([uv[0] + tint * TINT_UV_PER_UNIT * nx, uv[1] + tint * TINT_UV_PER_UNIT * ny]);
  return [x / y, 1, (1 - x - y) / y];                          // +tint ⇒ source assumed greener ⇒ output magenta
}
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const RGB2XYZ  = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
function temperatureMatrix(T: number, tint: number): number[][] {   // rgb' = M · rgb
  const src = mul(BRADFORD, whiteXYZ(T, tint)), dst = mul(BRADFORD, whiteXYZ(6500, 0));
  const D = diag(dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]);
  return mul(inv(RGB2XYZ), mul(inv(BRADFORD), mul(D, mul(BRADFORD, RGB2XYZ))));
}
```

```glsl
uniform mat3 uM;   // temperatureMatrix (upload column-major)
void main() { vec4 s = src(); fragColor = vec4(uM * s.rgb, s.a); }
```

### 8.7 `color.highlightsShadows` (`Metal/HighlightsShadows.metal`)

```glsl
uniform float uHighlights, uShadows;
void main() {
  vec4 s = src();
  float y = dot(clamp(s.rgb, 0.0, 1.0), LUMA709);
  float hi = y * y * y;                       // peaks at white
  float lo = (1.0 - y) * (1.0 - y) * (1.0 - y); // peaks at black
  float dY = (uHighlights * hi + uShadows * lo) * 0.5;
  fragColor = vec4(clamp(s.rgb + dY, 0.0, 1.0), s.a);
}
```

### 8.8 `color.blacksWhites` — Levels (`Metal/Levels.metal`)

```glsl
uniform float uBlacks, uWhites;
void main() {
  vec4 s = src();
  float bp = -uBlacks * 0.4;          // blacks > 0 lifts the floor (bp < 0), < 0 crushes
  float wp = 1.0 - uWhites * 0.4;     // whites > 0 brightens/clips, < 0 recovers
  fragColor = vec4(clamp((s.rgb - bp) / max(0.05, wp - bp), 0.0, 1.0), s.a);
}
```

### 8.9 `color.vibrance` (`CIVibrance`) [APPROX]

Apple: "adjusts saturation while keeping pleasing skin tones"; muted colours move more than saturated
ones. Reconstruction (calibrate the curve exponent and an optional skin guard against macOS):

```glsl
uniform float uAmount;   // −1…1
void main() {
  vec4 s = src();
  float mx = max(s.r, max(s.g, s.b)), mn = min(s.r, min(s.g, s.b));
  float sat = clamp(mx - mn, 0.0, 1.0);
  float l = dot(s.rgb, vec3(0.2125, 0.7154, 0.0721));
  float k = 1.0 + uAmount * (1.0 - sat);           // saturated pixels barely change
  fragColor = vec4(mix(vec3(l), s.rgb, k), s.a);
}
```

### 8.10 `color.wheels` — Lift / Gamma / Gain (`ColorWheels.swift`, `Metal/Wheels.metal`)

Each wheel = a pad position `(x, y)` (angle = hue, radius = strength, radius clamped to 1) plus a master
scalar. Host-side coefficients:

```ts
const CHROMA_LIFT = 0.2, CHROMA_GAIN = 0.35, CHROMA_GAMMA = 0.35;
function hueRGB(h: number): [number, number, number] {          // fully saturated hue, h in turns
  const x = (h - Math.floor(h)) * 6, f = x - Math.floor(x);
  switch (Math.trunc(x) % 6) {
    case 0: return [1, f, 0];     case 1: return [1 - f, 1, 0];  case 2: return [0, 1, f];
    case 3: return [0, 1 - f, 1]; case 4: return [f, 0, 1];      default: return [1, 0, 1 - f];
  }
}
function chromaOffset(x: number, y: number): [number, number, number] {   // luma-neutral, sums to 0
  const r = Math.min(1, Math.hypot(x, y));
  if (r <= 1e-6) return [0, 0, 0];
  const [cr, cg, cb] = hueRGB(Math.atan2(y, x) / (2 * Math.PI));
  const m = (cr + cg + cb) / 3;
  return [(cr - m) * r, (cg - m) * r, (cb - m) * r];
}
function wheelCoefficients(v: Record<string, number>) {
  const L = chromaOffset(v.lift_x, v.lift_y), G = chromaOffset(v.gamma_x, v.gamma_y), K = chromaOffset(v.gain_x, v.gain_y);
  return {
    lift:     L.map(c => v.lift_m + c * CHROMA_LIFT),
    gain:     K.map(c => v.gain_m * (1 + c * CHROMA_GAIN)),
    invGamma: G.map(c => 1 / Math.max(0.01, v.gamma_m * (1 + c * CHROMA_GAMMA))),
  };
}
const isNeutral = (v) => v.lift_x === 0 && v.lift_y === 0 && v.lift_m === 0 && v.gamma_x === 0 && v.gamma_y === 0
  && v.gamma_m === 1 && v.gain_x === 0 && v.gain_y === 0 && v.gain_m === 1;
```

```glsl
uniform vec3 uLift, uGain, uInvGamma;
void main() {
  vec4 s = src();
  vec3 lit = max(s.rgb * (1.0 - uLift) + uLift, vec3(0.0)) * uGain;
  fragColor = vec4(clamp(pow(lit, uInvGamma), 0.0, 1.0), s.a);
}
```

Wheel-face display colour (UI only, `ColorWheels.displayColor`): `r = min(1,|p|)`, hue from angle,
`v = 0.08 + 0.5·r^1.7`, `s = r^1.4`, `body = v·((1−s) + h·s)`, `rim = smoothstep01((r − 0.86)/0.14)`,
`face = body + (h − body)·rim` per channel.

### 8.11 `color.curves` — RGB + master curves (`Models/GradeCurve.swift`, `Kernels/GradeCurveKernel.swift`, `Metal/GradeCurves.metal`)

JSON: `{"master":[{"x":0,"y":0},…],"red":[…],"green":[…],"blue":[…]}`; an empty array means identity.
Identity when every curve is empty or exactly `[(0,0),(1,1)]`.

```ts
function evalCurve(pts: {x: number; y: number}[], x: number): number {   // piecewise linear, flat outside
  const p = (pts.length ? pts : [{x: 0, y: 0}, {x: 1, y: 1}]).slice().sort((a, b) => a.x - b.x);
  if (x <= p[0].x) return p[0].y;
  if (x >= p[p.length - 1].x) return p[p.length - 1].y;
  for (let i = 1; i < p.length; i++) if (x <= p[i].x) {
    const a = p[i - 1], b = p[i], t = b.x - a.x === 0 ? 0 : (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  }
  return x;
}
// Two 256×1 RGBA32F textures, cached per curve JSON (cap 64 entries):
for (let i = 0; i < 256; i++) {
  const t = i / 255, cl = (v: number) => Math.min(1, Math.max(0, v));
  ch.set([cl(evalCurve(c.red, t)), cl(evalCurve(c.green, t)), cl(evalCurve(c.blue, t)), 1], i * 4);
  const m = cl(evalCurve(c.master, t)); ms.set([m, m, m, 1], i * 4);
}
```

```glsl
uniform sampler2D uCh;      // R=red curve, G=green, B=blue
uniform sampler2D uMaster;  // R=G=B=master (luma) curve
void main() {
  vec4 s = src();
  vec3 rgb = clamp(s.rgb, 0.0, 1.0);
  float y = dot(rgb, LUMA709);
  float yp = lut1D(uMaster, y).r;
  rgb = (y > 1e-4) ? rgb * min(yp / y, 8.0) : vec3(yp);   // luma-preserving rescale, gain capped at 8
  fragColor = vec4(lut1D(uCh, rgb.r).r, lut1D(uCh, rgb.g).g, lut1D(uCh, rgb.b).b, s.a);
}
```

[QUIRK] Table entries are built at `t = i/255` but looked up at `v·256` texels (CI pixel-space
sampling), a ≤ ½-texel shift; `lut1D` reproduces it. On macOS the edge behaviour of the CI sampler is
assumed clamp-to-edge; verify identity curves keep pure white at 1.0 (§13).

### 8.12 `color.hueCurves` (`Models/HueCurves.swift`, `Kernels/HueCurveKernel.swift`, `Metal/HueCurves.metal`)

JSON `{"hueVsHue":[…],"hueVsSat":[…],"hueVsLum":[…]}`; points `(x = hue 0…1, y)`, neutral `y = 0.5`;
an empty curve evaluates as six neutral points at `x = 0, 1/6, …, 5/6`. Identity when every curve is
empty or all `|y − 0.5| < 1e-4`.

```ts
function evalHue(pts: {x: number; y: number}[], x: number): number {   // cyclic piecewise linear
  const p = (pts.length ? pts : [0, 1, 2, 3, 4, 5].map(i => ({x: i / 6, y: 0.5}))).slice().sort((a, b) => a.x - b.x);
  const lerp = (a, b) => { const t = b.x - a.x === 0 ? 0 : (x - a.x) / (b.x - a.x); return a.y + (b.y - a.y) * t; };
  const first = p[0], last = p[p.length - 1];
  if (x < first.x) return lerp({x: last.x - 1, y: last.y}, first);
  for (let i = 1; i < p.length; i++) if (x <= p[i].x) return lerp(p[i - 1], p[i]);
  return lerp(last, {x: first.x + 1, y: first.y});
}
// 256×1 RGBA32F texture, cached per JSON (cap 64)
for (let i = 0; i < 256; i++) {
  const hue = (i + 0.5) / 256;
  lut.set([(evalHue(c.hueVsHue, hue) - 0.5) * 2 * (1 / 12),   // Δhue, ±30° max
           (evalHue(c.hueVsSat, hue) - 0.5) * 2,              // saturation scale delta
           (evalHue(c.hueVsLum, hue) - 0.5) * 2 * 0.5,        // Δvalue, ±0.5 max
           1], i * 4);
}
```

```glsl
uniform sampler2D uLut;
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
  vec4 s = src();
  vec3 hsv = rgb2hsv(clamp(s.rgb, 0.0, 1.0));
  vec4 L = lut1D(uLut, hsv.x);
  float gate = smoothstep(0.04, 0.18, hsv.y);       // near-greys stay neutral
  float h2 = fract(hsv.x + L.r * gate);
  float s2 = clamp(hsv.y * (1.0 + L.g * gate), 0.0, 1.0);
  float v2 = clamp(hsv.z + L.b * gate, 0.0, 1.0);
  fragColor = vec4(hsv2rgb(vec3(h2, s2, v2)), s.a);
}
```

(Clamp-to-edge at the red seam matches macOS; `REPEAT` would be marginally more correct, ≤ ½ texel.)

### 8.13 `color.lut` — `.cube` 3D LUT, tetrahedral (`Compositing/LUTLoader.swift`, `Metal/LUTTetra.metal`)

Storage: `LUTLoader.store` validates and copies the file into
`~/Library/Application Support/PalmierPro/luts/<projectId|default>/<filename>` and the effect stores the
absolute path in `params.path.string`. Port: `$XDG_DATA_HOME/palmier-pro/luts/<projectId|default>/`.

Parser — must reproduce the Swift acceptance rules exactly:

```ts
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(nan|inf|infinity)$/i;   // Swift Float(String)
function parseCube(text: string): { n: number; data: Float32Array } | null {
  let n = 0, dmin = [0, 0, 0], dmax = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r\n|[\n\r\v\f\u0085  ]/)) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, '');               // trims spaces/tabs only
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(' ').filter(s => s.length > 0);       // splits on SPACE only (tabs are not separators) [QUIRK]
    const kw = parts[0].toUpperCase();
    if (kw === 'TITLE') continue;
    if (kw === 'LUT_1D_SIZE') return null;                         // 1D LUTs rejected
    if (kw === 'LUT_3D_SIZE') { n = /^[+-]?\d+$/.test(parts[parts.length - 1]) ? parseInt(parts[parts.length - 1], 10) : 0; continue; }
    if (kw === 'DOMAIN_MIN') { dmin = parts.slice(1).filter(s => FLOAT.test(s)).map(Number); continue; }
    if (kw === 'DOMAIN_MAX') { dmax = parts.slice(1).filter(s => FLOAT.test(s)).map(Number); continue; }
    if (parts.length < 3) continue;                                // other short lines ignored
    const rgb = parts.slice(0, 3);
    if (!rgb.every(s => FLOAT.test(s))) return null;               // e.g. "LUT_3D_INPUT_RANGE 0 1" ⇒ whole file rejected [QUIRK]
    vals.push(...rgb.map(Number));
  }
  if (!(n > 1 && n <= 128) || vals.length !== n * n * n * 3 || dmin.length !== 3 || dmax.length !== 3) return null;
  const data = new Float32Array(n * n * n * 4);
  for (let i = 0; i < n * n * n; i++) {
    for (let c = 0; c < 3; c++) {
      const span = Math.max(0.0001, dmax[c] - dmin[c]);
      data[i * 4 + c] = Math.min(1, Math.max(0, (vals[i * 3 + c] - dmin[c]) / span));   // domain applied to OUTPUT values [QUIRK]
    }
    data[i * 4 + 3] = 1;
  }
  return { n, data };   // entry i = r + g·n + b·n² (red fastest)
}
```

Upload as a 3D texture: `texImage3D(TEXTURE_3D, 0, RGBA32F, n, n, n, 0, RGBA, FLOAT, data)` (x = r, y = g,
z = b; nearest fetch only — no float-linear extension needed). Cache per path (cap 16 textures; the
parsed LUT itself is cached per path forever on macOS).

```glsl
uniform highp sampler3D uLut;
uniform float uN;          // cube dimension
uniform float uIntensity;  // 0…1
vec3 L(vec3 idx) { return texelFetch(uLut, ivec3(idx), 0).rgb; }
void main() {
  vec4 s = src();
  vec3 rgb = clamp(s.rgb, 0.0, 1.0);
  vec3 p = rgb * (uN - 1.0);
  vec3 b0 = clamp(floor(p), 0.0, uN - 2.0);
  vec3 f = p - b0;
  vec3 c000 = L(b0), c111 = L(b0 + 1.0), o;
  if (f.r >= f.g) {
    if (f.g >= f.b)      o = (1.0 - f.r) * c000 + (f.r - f.g) * L(b0 + vec3(1, 0, 0)) + (f.g - f.b) * L(b0 + vec3(1, 1, 0)) + f.b * c111;
    else if (f.r >= f.b) o = (1.0 - f.r) * c000 + (f.r - f.b) * L(b0 + vec3(1, 0, 0)) + (f.b - f.g) * L(b0 + vec3(1, 0, 1)) + f.g * c111;
    else                 o = (1.0 - f.b) * c000 + (f.b - f.r) * L(b0 + vec3(0, 0, 1)) + (f.r - f.g) * L(b0 + vec3(1, 0, 1)) + f.g * c111;
  } else {
    if (f.b >= f.g)      o = (1.0 - f.b) * c000 + (f.b - f.g) * L(b0 + vec3(0, 0, 1)) + (f.g - f.r) * L(b0 + vec3(0, 1, 1)) + f.r * c111;
    else if (f.b >= f.r) o = (1.0 - f.g) * c000 + (f.g - f.b) * L(b0 + vec3(0, 1, 0)) + (f.b - f.r) * L(b0 + vec3(0, 1, 1)) + f.r * c111;
    else                 o = (1.0 - f.g) * c000 + (f.g - f.r) * L(b0 + vec3(0, 1, 0)) + (f.r - f.b) * L(b0 + vec3(1, 1, 0)) + f.b * c111;
  }
  fragColor = vec4(mix(s.rgb, o, uIntensity), s.a);     // mixes with the UNclamped input
}
```

### 8.14 `detail.clarity` — Clarity & Dehaze (`Kernels/ClarityKernel.swift`, `Metal/Clarity.metal`)

Pass 1–2: Gaussian blur of the **straight** working image (no premultiply), `σ = max(w, h) / 40`
(w, h = working extent), clamp-to-extent. Pass 3:

```glsl
uniform sampler2D uBlur;
uniform float uClarity, uDehaze;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, p, 0);
  vec3 b = texelFetch(uBlur, p, 0).rgb;
  vec3 rgb = s.rgb + (s.rgb - b) * uClarity;                         // local-contrast unsharp
  if (uDehaze != 0.0) {
    float dark = min(s.r, min(s.g, s.b));                            // dark-channel prior: high = hazy
    float w = uDehaze * (0.5 + 0.5 * smoothstep(0.05, 0.5, dark));
    rgb += (s.rgb - b) * (w * 0.6);                                  // more local contrast
    rgb = mix(vec3(0.45), rgb, 1.0 + w * 0.45);                      // contrast around a low pivot
    float yy = dot(rgb, LUMA709);
    rgb = mix(vec3(yy), rgb, 1.0 + w * 0.5);                         // re-saturate
  }
  fragColor = vec4(clamp(rgb, 0.0, 1.0), s.a);
}
```

### 8.15 `key.chroma` — Chroma key (`Kernels/ChromaKeyKernel.swift`, `Metal/ChromaKey.metal`)

`keyHue` is in turns (0.333 = green, ≈0.667 = blue). The preview "sample key colour" tool averages a
9×9 patch at the click, converts to HSB, and accepts the hue only if saturation ≥ 0.12
(`VideoEngine.swift:601-628`). Skipped while `tolerance ≤ 0` (the default).

```glsl
uniform float uKeyHue, uTolerance, uSoftness, uSpill;
void main() {
  vec4 s = src(); vec3 rgb = s.rgb;
  float mx = max(rgb.r, max(rgb.g, rgb.b)), mn = min(rgb.r, min(rgb.g, rgb.b));
  float dd = mx - mn;
  float sat = mx <= 1e-5 ? 0.0 : dd / mx;
  float hue = 0.0;
  if (dd > 1e-5) {
    if (mx == rgb.r)      hue = (rgb.g - rgb.b) / dd;
    else if (mx == rgb.g) hue = (rgb.b - rgb.r) / dd + 2.0;
    else                  hue = (rgb.r - rgb.g) / dd + 4.0;
    hue = fract(hue / 6.0);
  }
  float hd = abs(hue - uKeyHue); hd = min(hd, 1.0 - hd);           // circular distance 0…0.5
  float inner = uTolerance * 0.25;                                   // tolerance 1 ≈ ±90°
  float key = (1.0 - smoothstep(inner, inner + uSoftness * 0.3 + 0.02, hd))
            * smoothstep(0.12, 0.32, sat)
            * smoothstep(0.04, 0.12, dd);
  float y = dot(rgb, LUMA709);
  rgb = mix(rgb, vec3(y), uSpill * key);                             // spill suppression on edges
  fragColor = vec4(rgb, s.a * (1.0 - key));
}
```

### 8.16 `blur.gaussian`

`radius_px = radius · spatialScale` (media: 1; text: `H/1080`); skip if ≤ 0. Passes: premultiply →
gaussian1d (x) → gaussian1d (y) with `σ = radius_px` (§8.3) and clamp-to-extent edges → unpremultiply.
The output keeps the working extent (no growth). Text clips route their `TextStyle.blur` /
blur keyframes through this same effect (§9.10). Keyframed blur on media is the `radius` param track
(`Models/ClipEffectKeyframes.swift`).

### 8.17 `blur.sharpen` (`CISharpenLuminance`, default radius 1.69) [APPROX]

Luminance-only unsharp mask: chroma untouched.

```glsl
// pass A: luma.frag  → R16F/RGBA16F: fragColor = vec4(dot(src().rgb, LUMA709));
// pass B/C: gaussian1d on the luma texture, sigma = 1.69, clamp-to-extent
// pass D:
uniform sampler2D uLumaBlur;
uniform float uSharpness;            // 'amount' 0…2
void main() {
  vec4 s = src();
  float y = dot(s.rgb, LUMA709);
  float yb = texelFetch(uLumaBlur, ivec2(gl_FragCoord.xy), 0).r;
  fragColor = vec4(s.rgb + (y - yb) * uSharpness, s.a);
}
```

### 8.18 `blur.noiseReduction` (`CINoiseReduction`, `noiseLevel = amount·0.1`, `sharpness = 0.4`) [APPROX]

Apple: luminance differences below `noiseLevel` are treated as noise and locally blurred; larger
differences are edges and get sharpened.

```glsl
uniform float uNoise;      // amount * 0.1
uniform float uSharp;      // 0.4
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = srcClamped(p);
  float yc = dot(c.rgb, LUMA709);
  vec3 acc = vec3(0.0), box = vec3(0.0); float wsum = 0.0;
  for (int j = -2; j <= 2; ++j) for (int i = -2; i <= 2; ++i) {
    vec3 n = srcClamped(p + ivec2(i, j)).rgb;
    box += n;
    float w = 1.0 - sstep(uNoise, 2.0 * uNoise + 1e-4, abs(dot(n, LUMA709) - yc));
    acc += n * w; wsum += w;                       // centre weight is always 1
  }
  box /= 25.0;
  vec3 den = acc / wsum;
  float edge = sstep(uNoise, 2.0 * uNoise + 1e-4, abs(yc - dot(box, LUMA709)));
  fragColor = vec4(mix(den, c.rgb + (c.rgb - box) * uSharp, edge), c.a);
}
```

### 8.19 `blur.motion` (`CIMotionBlur`) [APPROX]

Directional blur of the straight image (no premultiply), clamp-to-extent. CI's angle is radians,
counter-clockwise in a y-up space ⇒ in y-down texture space the direction is `(cos θ, −sin θ)`.

```glsl
uniform float uRadius;    // px (source)
uniform float uAngle;     // radians = angle° · π/180
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 dir = vec2(cos(uAngle), -sin(uAngle));
  int n = int(ceil(uRadius));
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -n; i <= n; ++i) {
    float t = float(i);
    float w = 1.0 - abs(t) / (uRadius + 1.0);      // triangle weights over [−r, r]; calibrate vs macOS
    acc += w * bilinearClamped(p + dir * t); wsum += w;
  }
  fragColor = acc / wsum;
}
```

### 8.20 `stylize.invert` (`CIColorMatrix` R/G/B vectors −1, bias 1)

```glsl
void main() { vec4 s = src(); fragColor = vec4(1.0 - s.rgb, s.a); }
```

### 8.21 `stylize.grain` (`Metal/Grain.metal`)

Monochrome noise, seeded by position and the clip offset frame (animated), strongest in mid-tones.

```glsl
uniform float uAmount, uSize, uFrame;   // uFrame = f − clip.startFrame
uniform vec2 uOrigin;                   // crop origin in source px (CI dest.coord includes it); y-flip irrelevant for noise
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec4 s = src();
  vec2 co = (gl_FragCoord.xy + uOrigin) / max(uSize, 0.5);
  float n = hash13(vec3(co, uFrame)) - 0.5;
  float y = dot(s.rgb, LUMA709);
  float lumaMask = 4.0 * y * (1.0 - y);                  // peaks at mid grey
  fragColor = vec4(clamp(s.rgb + n * uAmount * 0.35 * lumaMask, 0.0, 1.0), s.a);
}
```

### 8.22 `stylize.vignette` (`Metal/Vignette.metal`)

Centred on the working extent (the cropped clip, or the whole canvas for text), multiplicative ⇒ hue-preserving.

```glsl
uniform float uAmount, uMidpoint, uRoundness, uFeather;
void main() {
  vec4 s = src();
  vec2 center = uExtent * 0.5;
  vec2 d = (gl_FragCoord.xy - center) / max(uExtent * 0.5, vec2(1.0));   // −1…1 across the frame
  float p = mix(6.0, 2.0, (uRoundness + 1.0) * 0.5);                      // −1 rectangular … +1 round
  float dist = pow(pow(abs(d.x), p) + pow(abs(d.y), p), 1.0 / p);         // superellipse
  float v = smoothstep(uMidpoint, uMidpoint + uFeather * 1.5 + 0.05, dist);
  fragColor = vec4(clamp(s.rgb * (1.0 + uAmount * v), 0.0, 1.0), s.a);     // amount < 0 darkens edges
}
```

### 8.23 `stylize.glow` (`Kernels/GlowKernel.swift`, `Metal/Glow.metal`)

Pass 1 bright-pass, pass 2–3 Gaussian blur (`σ = radius` px, **not** multiplied by `spatialScale`;
clamp-to-extent; straight values), pass 4 screen composite.

```glsl
// glow_bright.frag
uniform float uThreshold, uWarmth;
void main() {
  vec4 s = src();
  float y = dot(s.rgb, LUMA709);
  vec3 hi = s.rgb * sstep(uThreshold, 1.0, y);        // threshold 1 ⇒ nothing passes
  vec3 warm = hi * vec3(1.0, 0.7, 0.45);              // halation tint
  fragColor = vec4(mix(hi, warm, uWarmth), s.a);
}
// glow_composite.frag
uniform sampler2D uGlow;
uniform float uIntensity;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, p, 0);
  vec3 g = clamp(texelFetch(uGlow, p, 0).rgb * uIntensity, 0.0, 1.0);
  fragColor = vec4(1.0 - (1.0 - s.rgb) * (1.0 - g), s.a);   // screen
}
```

---

## 9. Text rendering (CoreText → Canvas2D)

### 9.1 Where text sits in the frame pipeline (`FrameRenderer.swift:338-416`)

```
alpha = clamp(opacityAt(clip, f), 0, 1); skip if 0
style = clip.textStyleAt(f)                      // fontScale modulated by scale keyframes (§9.2)
if fillMode == inverted: style.color = white; border.enabled = shadow.enabled = false; background.color.a = background.outlineColor.a = 0
raster = TextFrameRenderer.image(clip, f, W×H)   // canvas-positioned, premultiplied, entrance animation baked in
img = unpremultiply(raster)
img = applyTextEffects(img)                      // blur + other effects on a canvas-sized extent (§9.10)
if fillMode == inverted: img.rgb = 1             // white, glyph alpha kept
img = rotate/tilt(img)                           // about the clip centre (§9.10); flips ignored
img = premultiply(img); opacity / blend (§6) — inverted always blends with `difference`
```

`footage` fill takes a completely different path (§9.11). Text never uses crop, edge rounding or flips.

### 9.2 Units and scaling

- Reference canvas height `REF = 1080` (`TextLayout.referenceCanvasHeight`). Every size in `TextStyle`
  (font size, tracking, line spacing, stroke, shadow, background padding/radius/offset/outline) is in
  points of a 1080-px-high canvas. Render scale `s = H / 1080` where `H` is the canvas being rendered
  (timeline height, export height, or the child canvas inside a nest).
- `textStyleAt(f)`: `style.fontScale = textScaleAt(f)`:
  `base = style.fontScale`; if the clip has scale keyframes,
  `fontScale = base · min(sizeAt(f).w / transform.width, sizeAt(f).h / transform.height)`
  (guards: non-finite / ≤ 0 → base or 1) (`Timeline.swift:266-288`).
- `scaledVisualStyle` folds `fontScale` into every size: `fontSize, tracking, lineSpacing,
  shadow.offsetX/offsetY/blur, border.width, background.paddingX/paddingY/cornerRadius/offsetX/offsetY/
  outlineWidth` are multiplied by `fontScale`, then `fontScale = 1` (`TextStyle.swift:265-283`).
- Pixel sizes used by the renderer (after `scaledVisualStyle`): `fontPx = fontSize·s`,
  `trackingPx = tracking·s`, `lineSpacingPx = lineSpacing·s`, `strokePx = border.width·s`, etc.

### 9.3 `TextStyle` (`Models/TextStyle.swift`) — fields, defaults, UI ranges

| Field | Default | UI range | Notes |
|---|---|---|---|
| `fontName` | `"Helvetica"` | font picker | PostScript or family name |
| `fontSize` | 96 (captions 48) | 12…300 pt | |
| `fontScale` | 1 | (resize handles, min 0.05) | folded by `scaledVisualStyle` |
| `widthScale`, `heightScale` | 1, 1 | 0.1…10 (UI shows %) | font matrix `scale(w, h)` |
| `tracking` | 0 | −20…100 pt | `.kern` after every character |
| `lineSpacing` | 0 | −100…300 pt | extra space between lines |
| `fontCase` | `mixed` | `mixed / uppercase / lowercase` | applied before layout (`toUpperCase/toLowerCase`) |
| `isBold`, `isItalic` | inferred from font traits when missing in JSON | toggles | trait swap within the family |
| `isUnderlined`, `isStruckThrough`, `isOverlined` | false | toggles | |
| `color` | `RGBA(1,1,1,1)` | sRGB | footage mode default matte `(0,0,0,1)` |
| `alignment` | `center` | `left / center / right` | |
| `blur` | 0 | 0…100 px | applied as `blur.gaussian` (§9.10) |
| `shadow` | `{enabled:false, color:(0,0,0,0.6), offsetX:0, offsetY:−2, blur:6}` | offset −200…200, blur 0…100, opacity 0…1 | |
| `background` | `{enabled:false, color:(0,0,0,0.6), paddingX:0, paddingY:0, cornerRadius:0, offsetX:0, offsetY:0, outlineColor:(0,0,0,1), outlineWidth:0}` | padding 0…300, "Center" offset −500…500, radius 0…300, outline 0…40 | |
| `border` (outline) | `{enabled:false, color:(0,0,0,1), width:4}` | 0…40 pt | |

JSON decoding is missing-key tolerant (every field falls back to its default).

### 9.4 Fonts

- Resolution (`TextStyle.resolvedFont`, lines 285-299): `NSFont(name: fontName, size)`, else the system
  font; then request bold/italic **symbolic traits within the same family**
  (`CTFontDescriptorCreateCopyWithSymbolicTraits`); if the family has no such face the base face is kept
  — **no synthetic bold/italic**. Then, if `widthScale ≠ 1 || heightScale ≠ 1`, apply the font matrix
  `scale(widthScale, heightScale)` (glyph outlines *and* advances scale).
- Linux:
  1. Build a font index at startup: bundled fonts (`Resources/Fonts`: Inter, DM Sans, Geist, Geist
     Mono, Playfair Display, Poppins (4 faces), Space Grotesk, Caveat, Shrikhand, Bebas Neue, Anton,
     Permanent Marker, Basement Grotesque) plus `fc-list : family style weight slant postscriptname file`.
     Key by PostScript name and by family name → `{family, weight, style, file}`; register with
     `new FontFace(family, url, {weight, style})` in every renderer (preview **and** export).
  2. Bold = weight 700 face of the family, italic = italic/oblique face; if the face does not exist,
     keep the regular face (do not let Chromium synthesise faux bold/italic).
  3. Missing font → Inter (stand-in for the macOS system font, as in `05-ui.md`). Helvetica →
     metric-compatible substitute (Liberation Sans / Arimo / Nimbus Sans). Layout differences caused by
     substitution are expected and not a bug.
- Metrics: read `hhea.ascender/descender/lineGap`, `unitsPerEm`, `post.underlinePosition/Thickness`,
  `OS/2.yStrikeoutPosition/Size` from the font file (opentype.js / fontkit) and scale by
  `fontPx / unitsPerEm`. Do not rely on `measureText().fontBoundingBox*` (platform-dependent).
  Whether `heightScale` scales line metrics under CoreText must be confirmed on macOS (§13); default
  assumption: ascent/descent/leading are **multiplied by `heightScale`**.

### 9.5 Layout (`TextFrameRenderer.swift:62-84`, `Models/TextLayout.swift:47-67`, `TextStyle.swift:303-360`)

All in canvas px, y-down:

```ts
const t = transformAt(clip, f);
const box = { x: (t.centerX - t.width / 2) * W, y: (t.centerY - t.height / 2) * H,
              w: Math.max(1, t.width * W), h: Math.max(1, t.height * H) };          // clip rect = layout box
let textBox = box;
if (style.background.enabled) {
  const dx = Math.max(0, style.background.paddingX * s), dy = Math.max(0, style.background.paddingY * s);
  const inset = { x: box.x + dx, y: box.y + dy, w: box.w - 2 * dx, h: box.h - 2 * dy };
  textBox = inset.w >= 1 && inset.h >= 1 ? inset : { x: box.x + box.w / 2 - 0.5, y: box.y + box.h / 2 - 0.5, w: 1, h: 1 };
}
```

Paragraph/line model (CoreText `byWordWrapping` frame of width `textBox.w`):

1. `content = fontCase(clip.textContent)`; empty ⇒ no layer.
2. Paragraphs split at `\n`, `\r\n`, `\r`, ` `, ` `. A trailing newline produces a final empty
   line (CoreText measurement appends a zero-width space for this, `TextLayout.swift:73-83`).
3. Greedy line breaking at UAX-14 opportunities (practically: after whitespace and after hyphens);
   trailing whitespace hangs (never forces a break, excluded from the width used for alignment); a single
   word wider than the line breaks at grapheme boundaries.
4. Advance widths: `measureText(segment).width · widthScale`, with `trackingPx` added after **every**
   character (including the last one of the line) — Canvas `letterSpacing = trackingPx` gives the same.
5. Line metrics: `ascent, descent, leading` (hhea, × heightScale per §9.4). Line pitch
   `= ascent + descent + leading + max(0, lineSpacingPx)` (NSParagraphStyle line spacing is
   non-negative: negative UI values behave as 0 [QUIRK]).
6. `contentH = ceil(n·(ascent + descent + leading) + (n − 1)·max(0, lineSpacingPx))`
   (`CTFramesetterSuggestFrameSizeWithConstraints`; ±1 px vs CoreText, calibrate).
7. `frameH = min(textBox.h, contentH)`; `frameTop = textBox.y + textBox.h/2 − frameH/2`
   (**vertically centred**).
8. Baseline of line `i`: `frameTop + ascent + i·pitch`. Lines whose bottom (`baseline + descent`)
   exceeds `frameTop + frameH` are **not drawn** (CTFrame drops lines that do not fit) — overflowing text
   is cut at whole lines, keeping the top lines.
9. Horizontal: `lineX = textBox.x + {0, (textBox.w − lineW)/2, textBox.w − lineW}` for
   `left/center/right` (`lineW` without trailing whitespace).

`verticallySizedFor` (typewriter only): steps 6–7 use the **full** content's height while the visible
substring is laid out, so lines do not jump as text appears.

### 9.6 Raster bounds (clip region) (`TextFrameRenderer.swift:86-113`)

Drawing is clipped to this integral rect (overflowing glyphs are cut):

```ts
let r = union(textBox, box);
if (bg.enabled) r = union(r, outset(offset(box, bg.offsetX * s, bg.offsetY * s), Math.max(0, bg.outlineWidth) * s / 2));
if (border.enabled && border.width > 0) r = outset(r, Math.ceil(fontPx * Math.max(0, border.width) / Math.max(1, style.fontSize)));  // = ceil(border.width·s)
if (animActive && preset.renderMode !== 'entrance') r = outset(r, fontPx);                                                      // per-word / typewriter motion room
if (shadow.enabled) { const b = Math.max(0, shadow.blur * s), dx = shadow.offsetX * s, dy = shadow.offsetY * s;
  r = { x: r.x + Math.min(0, dx) - b, y: r.y + Math.min(0, dy) - b, w: r.w + Math.abs(dx) + 2 * b, h: r.h + Math.abs(dy) + 2 * b }; }
r = integral(outset(r, 2));     // floor(min), ceil(max)
```

### 9.7 Drawing (static text) (`TextFrameRenderer.swift:150-219, 641-731`)

Order inside the raster (8-bit sRGB, antialiased, grayscale smoothing):

1. **Background box** (no shadow): `rect = box` offset by `(bg.offsetX·s, bg.offsetY·s)` (positive
   offsetY = down); `radius = min(max(0, bg.cornerRadius·s), min(rect.w, rect.h)/2)`; fill with
   `bg.color` if `a > 0`; stroke the same rounded rect with `bg.outlineColor`, line width
   `bg.outlineWidth·s` (centred on the path) if `outlineWidth > 0 && outlineColor.a > 0`.
2. **Shadow** is enabled for everything drawn after this point: colour `shadow.color` (its alpha is the
   opacity), blur `shadow.blur·s`, offset `(shadow.offsetX·s, shadow.offsetY·s)` in screen space
   (positive = right/down). [QUIRK] The default `offsetY = −2` therefore puts the default shadow 2 px
   **above** the text. Canvas2D: `shadowBlur = blur·s`, `shadowOffsetX/Y` as given (Canvas uses σ = shadowBlur/2;
   CG's blur parameter is comparable — calibrate in §13). Shadows are not affected by the CTM in either API.
3. **Glyphs**, two modes (`drawsGlyphOutline = border.enabled && border.width > 0 && color.a >= 1`):
   - *Opaque fill + outline* (two-pass, one transparency layer so the shadow is cast once):
     undercoat = stroke-only glyphs, `lineWidth = 2·border.width·s`, `lineJoin = round`, colour
     `border.color`; then the fill on top ⇒ visible outline of `border.width·s` outside the glyph.
   - Otherwise: fill (colour `style.color`), then — if `border.enabled && width > 0` (i.e. translucent
     fill) — stroke centred on the outline with `lineWidth = border.width·s`, miter join (limit 10),
     colour `border.color`, drawn over the fill.
4. **Underline / strikethrough** (CoreText, text colour): rects using the font's `post`/`OS/2` metrics
   (fallbacks: underline at `baseline + 0.1·fontPx`, strike at `baseline − 0.3·fontPx`, thickness
   `max(1, 0.05·fontPx)`); span = line typographic width.
5. **Overline** (custom): per laid-out line, a stroked segment from `x = lineX` to
   `lineX + (typographicWidth − trailingWhitespaceWidth)` at `y = baseline − ascent + th/2`,
   `th = max(1, underlineThickness)`, text colour (`TextFrameRenderer.swift:175-194`).

Canvas2D recipe (keeps "shadow applied once"): draw steps 3–5 into a scratch `OffscreenCanvas` without
shadow, then `drawImage(scratch)` onto the raster canvas with the shadow settings, after drawing step 1
on the raster canvas without shadow. Width/height scale: per line `ctx.translate(lineX, baseline);
ctx.scale(widthScale, heightScale); ctx.letterSpacing = trackingPx / widthScale + 'px'; fillText(line, 0, 0)`.

```ts
function drawStaticText(ctx: OffscreenCanvasRenderingContext2D, L: Layout, st: ScaledStyle, s: number) {
  ctx.save(); clipToRect(ctx, L.raster);
  drawBackgroundBox(ctx, L.box, st.background, s);                       // step 1, no shadow
  const layer = scratchCanvas(L.raster);                                  // same size/origin as raster
  const g = layer.ctx;
  for (const line of L.lines) {
    if (st.drawsGlyphOutline) {
      strokeLine(g, line, { width: 2 * st.border.width * s, join: 'round', color: st.border.color });
      fillLine(g, line, st.color);
    } else {
      fillLine(g, line, st.color);
      if (st.border.enabled && st.border.width > 0) strokeLine(g, line, { width: st.border.width * s, join: 'miter', color: st.border.color });
    }
    if (st.isUnderlined) underline(g, line); if (st.isStruckThrough) strike(g, line); if (st.isOverlined) overline(g, line);
  }
  if (st.shadow.enabled) setShadow(ctx, st.shadow, s);
  ctx.drawImage(layer.canvas, L.raster.x, L.raster.y);
  ctx.restore();
}
```

Colours are sRGB code values: use `color(srgb r g b / a)` strings (float precision).

### 9.8 Animation (`Models/TextAnimation.swift`, `Compositing/TextAnimator.swift`)

`TextAnimation { preset = none, perWordFrames = 6, highlight?: RGBA }`, active iff `preset ≠ none`.

| Preset | renderMode | Effect |
|---|---|---|
| `popIn` | entrance | whole raster: opacity `t`, scale `0.6 + 0.4t` about the clip-box centre |
| `slideUp` | entrance | whole raster: opacity `t`, offset down by `0.05·(1 − t)·H` |
| `typewriter` | typewriter | character reveal + blinking caret |
| `wordReveal` | perWord | word opacity `t_w`; optional active-word tint |
| `wordSlide` | perWord | word opacity `t_w`, offset down by `0.5·(1 − t_w)·fontPx`; optional tint |
| `highlightPop` | perWord | word colour → highlight (held until next word) |
| `highlightBlock` | perWord | rounded highlight block behind the word (held) |

Timing primitives (`rel = f − clip.startFrame`, integer):

```ts
const linear = (rel: number, start: number, dur: number) => rel <= start ? 0 : rel >= start + dur ? 1 : (rel - start) / dur;
const ss = (x: number) => x * x * (3 - 2 * x);
const progress = (rel, start, dur) => ss(linear(rel, start, dur));
const hand = Math.max(1, anim.perWordFrames);
const HIGHLIGHT_DEFAULT = { r: 1, g: 0.85, b: 0, a: 1 };
function rampDuration(w: WordTiming, max: number): number | null {      // null ⇒ no ramp
  const span = w.endFrame - w.startFrame;
  return span > 1 ? Math.min(Math.max(1, max), Math.max(1, Math.trunc(span / 2))) : null;
}
function activeRamp(rel, w, ramp) {                                      // 0 outside [start, end)
  if (rel < w.startFrame || rel >= w.endFrame) return 0;
  const r = rampDuration(w, ramp); if (r == null) return 1;
  return Math.min(ss(Math.min(1, (rel - w.startFrame) / r)), ss(Math.min(1, (w.endFrame - rel) / r)));
}
function heldHighlight(rel, w, next, ramp) {                             // stays on until the next word starts
  if (rel < w.startFrame) return 0;
  const d = rampDuration(w, ramp);
  const rampIn = d == null ? 1 : ss(Math.min(1, (rel - w.startFrame) / d));
  if (!next || rel < next.startFrame) return rampIn;
  const dn = rampDuration(next, ramp); if (dn == null) return 0;
  return Math.min(rampIn, ss(1 - Math.min(1, (rel - next.startFrame) / dn)));
}
```

Entrance (`clipEntry`): `t = progress(rel, 0, hand)`; popIn `{opacity: t, scale: 0.6 + 0.4t, dy: 0}`;
slideUp `{opacity: t, scale: 1, dy: 0.05(1 − t)}`. Applied to the static raster
(`TextFrameRenderer.swift:198-219`): `p' = c + scale·(p − c) + (0, scale·dy·H)`, `c` = clip-box centre;
opacity `k` is applied with `CIColorMatrix` diag(k,k,k,k), which (Core Image colour filters work on
straight colour) yields premultiplied `(C·a·k², a·k)`. [QUIRK] Text darkens slightly while fading in;
replicate with `globalAlpha = k` followed by a `source-atop` fill of black at alpha `1 − k`, or fix (§14).

Per-word states (`wordState`), `base = style.color`, `hl = anim.highlight ?? HIGHLIGHT_DEFAULT`:

```ts
switch (preset) {
  case 'wordReveal': { const t = progress(rel, w.startFrame, hand); return { opacity: t, scale: 1, dy: 0, color: tint() }; }
  case 'wordSlide':  { const t = progress(rel, w.startFrame, hand); return { opacity: t, scale: 1, dy: 0.5 * (1 - t), color: tint() }; }
  case 'highlightPop':   return { opacity: 1, scale: 1, dy: 0, color: lerpRGBA(base, hl, heldHighlight(rel, w, next, Math.min(hand, 4))) };
  case 'highlightBlock': return { opacity: 1, scale: 1, dy: 0, color: base, bg: { ...hl, a: hl.a * heldHighlight(rel, w, next, Math.min(hand, 4)) } };
}
// tint(): anim.highlight == null ? base : lerpRGBA(base, anim.highlight, activeRamp(rel, w, hand))   (lerp t clamped 0…1)
```

**Words and timings** (`TextFrameRenderer.swift:467-639`):
- Tokens = maximal runs of non-whitespace UTF-16 code units (`whitespacesAndNewlines`; an unpaired
  surrogate counts as non-space), with their UTF-16 ranges.
- `tokenTimings(tokens, clip.wordTimings, clip.durationFrames)`:
  - no word timings → even split: `start_i = trunc(D·i/n)`, `end_i = trunc(D·(i+1)/n)`;
  - same count → zip, each clamped: `start = clamp(start, 0, D)`, `end = clamp(end, start, D)`;
  - otherwise greedy alignment on normalised text (`lowercase(alphanumerics only)`): grow the token
    group when `tokenText.length ≤ wordText.length` (or words exhausted) else grow the word group, until
    both concatenations are equal and non-empty; equal-size groups zip+clamp, unequal groups split the
    span `[clamp(words[first].start), clamp(words[last].end)]` evenly (`start + trunc(span·k/count)`,
    last token ends at `end`); any failure → even split.

**Per-word rendering** (`renderPerWord`, `drawWordPlacements`):
1. Lay out the **full** text once (§9.5); for each token find the line containing its first UTF-16
   index, `penX = lineX + offsetOf(token.start)`, `penW = offsetOf(token.end) − offsetOf(token.start)`,
   baseline = line baseline. Tokens on no line (overflow) are skipped; words with opacity 0 are skipped.
2. Each word is drawn **as its own text run** (no kerning across words) at `(penX, baseline)` with
   colour `state.color`, inside one shadowed layer, with per-word transform:
   `alpha = opacity`; `p' = c_w + scale·(p − c_w) + (0, dy·fontPx)`,
   `c_w = (penX + penW/2, baseline − 0.35·fontPx)`.
3. Layer order: all highlight blocks (`bg.a > 0.001`), then all undercoats (outline mode), then all
   fills + overlines (overline colour = word colour).
4. Highlight block: rounded rect `x = penX − 0.18·fontPx`, `y = baseline − ascent − 0.10·fontPx`,
   `w = penW + 0.36·fontPx`, `h = ascent + descent + 0.20·fontPx`, radius `0.12·fontPx`, colour `bg`.
5. The clip's background box (§9.7 step 1) is still drawn underneath, unshadowed.

**Typewriter** (`renderTypewriter`, `TextFrameRenderer.swift:407-465`), `HOLD = 18`, `D = durationFrames`:

```ts
let visLen = 0;
for (let i = 0; i < tokens.length; i++) {
  const tok = tokens[i], tm = timings[i];
  let revealEnd = tm.endFrame;
  if (i === tokens.length - 1 && tm.endFrame > tm.startFrame) {
    const desiredHold = Math.min(HOLD, Math.max(1, Math.trunc(D / 3)));
    const existingHold = Math.max(1, D - tm.endFrame + 1);
    const span = tm.endFrame - tm.startFrame;
    const minReveal = Math.min(span - 1, tok.length) + 1;
    const extraHold = Math.min(Math.max(0, desiredHold - existingHold), span - minReveal);
    revealEnd = Math.max(tm.startFrame + 1, tm.endFrame - extraHold);
  }
  if (rel >= revealEnd) { visLen = tok.start + tok.length; continue; }
  if (rel >= tm.startFrame) {
    const span = revealEnd - tm.startFrame;
    const p = span === 1 ? 1 : (rel - tm.startFrame) / (span - 1);
    visLen = tok.start + Math.floor(tok.length * p);
    break;
  }
  break;
}
let visible = content.slice(0, visLen);                  // UTF-16 units: may split a surrogate pair [QUIRK]
const doneAt = timings.length ? timings[timings.length - 1].endFrame : D;
if (rel <= doneAt + HOLD && Math.trunc(rel / 15) % 2 === 0) visible += '|';   // caret blinks every 15 frames
// draw `visible` LEFT-aligned (alignment override), vertically sized for the full content (§9.5)
```

### 9.9 Caching

Static/per-word/typewriter rasters are cached (`NSCache`, 256 MB, 2048 entries) by a hash of
`content, style, text/background box relative to raster (quantised 1/64 px), raster size, renderSize,
state` where `state` = hash of all word states (per-word) or of the visible string (typewriter). Port:
LRU of `ImageBitmap`/textures with the same key and limits; entrance animation reuses the static raster.

### 9.10 Text effects, rotation and tilt (`FrameRenderer.swift:381-464`, `TextTiltGeometry.swift`)

**Effects.** `blurRadius = clip.blurRadius(f)`: the `radius` track of the clip's `blur.gaussian` effect
sampled at `f − start` with fallback `textStyle.blur`, else `textStyle.blur`. If `blurRadius > 0` or the
clip has any effect other than `blur.gaussian`:
1. Working extent = canvas rect `[0, W]×[0, H]` ∪ raster rect (the raster is composited over a clear
   canvas-sized image).
2. `blur.gaussian` with `radius = blurRadius` (clamped 0…100) × `spatialScale (= H/1080)` — applied
   even if the `blur.gaussian` entry in `effects` is disabled [QUIRK].
3. Every other **enabled** effect in order, with `spatialScale = H/1080` (only Gaussian uses it, so
   glow radius/grain size stay in canvas px), clip offset `f − start`.

**Rotation (no tilt).** About the clip centre `c = (centerX·W, centerY·H)`; sampling map
canvas→raster: `q = R(−θ)(p − c) + c` (`CompositionBuilder.canvasRotationTransform`).

**Tilt** (`rotationX` or `rotationY ≠ 0`, degrees, −89…89). Projective map of the raster plane; pivot
`P = (centerX·W, centerY·H)`; `E = max(W, H)`:

```ts
function tiltProject(pt: Pt, P: Pt, t: Transform, W: number, H: number): Pt {
  const rad = (d: number) => (d * Math.PI) / 180;
  const [sX, cX, sY, cY, sZ, cZ] = [Math.sin(rad(t.rotationX)), Math.cos(rad(t.rotationX)),
                                    Math.sin(rad(t.rotationY)), Math.cos(rad(t.rotationY)),
                                    Math.sin(rad(t.rotation)),  Math.cos(rad(t.rotation))];
  const E = Math.max(W, H);
  const maxHalfW = Math.max(Math.abs(t.width) * W / 2, Math.abs(P.x), Math.abs(W - P.x));
  const maxHalfH = Math.max(Math.abs(t.height) * H / 2, Math.abs(P.y), Math.abs(H - P.y));
  const maxDepth = maxHalfW * Math.abs(sY) + maxHalfH * Math.abs(sX * cY);
  const focal = Math.max(E * 2, maxDepth + E / 4);                // shared by every surface of the frame
  const x = pt.x - P.x, y = -(pt.y - P.y);                        // to y-up about the pivot
  const tx = x * cY + y * sX * sY, ty = y * cX;
  const depth = -x * sY + y * sX * cY;
  const k = focal / (focal + depth);
  const X = tx * k, Y = -ty * k;                                  // back to y-down
  return { x: P.x + X * cZ - Y * sZ, y: P.y + X * sZ + Y * cZ };  // then Z rotation (clockwise +)
}
```

macOS projects the 4 corners of the raster extent and applies `CIPerspectiveTransform` (a homography).
Because the projection of a plane is a single homography, the port can project the corners of **any**
rect covering the text layer (e.g. its texture rect), build the rect→quad homography, invert it and
sample with the projective path of §6.4 (`uProjective = true`):

```ts
function squareToQuad(q: [Pt, Pt, Pt, Pt]): number[] {   // (0,0)->TL,(1,0)->TR,(1,1)->BR,(0,1)->BL ; Heckbert
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, det = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / det; h = (dx1 * sy - sx * dy1) / det;
  }
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,     // row-major [a b c; d e f; g h 1]
          p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
          g, h, 1];
}
// H = squareToQuad(corners) · scale(1/rect.w, 1/rect.h) · translate(−rect.x, −rect.y);  shader uses inverse(H)
```

The same corners (computed on the clip rect with pivot = rect centre, `canvasSize` = preview video rect)
drive the tilt overlay and text hit-testing (`PreviewHitTester.swift:33-43`).

### 9.11 Fill modes (`Models/TextFillMode.swift`, `FrameRenderer.swift:47-88`)

`clip.textFillMode`: `null` = **color** (normal), `inverted`, `footage`.

- **inverted**: style forced to white fill, no outline/shadow, transparent background box & outline;
  after effects the RGB is set to 1 (alpha kept); blend mode forced to `difference`, opacity via
  dissolve (§6.3). Result inside glyphs: `(1 − a)·Cb + a·|1 − Cb|`. [QUIRK] the recolour runs on an
  already-unpremultiplied image through a colour filter that unpremultiplies again, so edge pixels end
  up `(a², a², a², a)` after premultiply (slightly thinner glyph edges).
- **footage** (cut-out reveal), only if `opacity > 0`:
  ```
  maskImg  = text raster rendered with style.color = white (other decorations as styled), rotated/tilted, premultiplied
  matte    = style.color (default (0,0,0,1) set when switching to footage) composited over accum
  m        = luminance of maskImg (premultiplied; = glyph coverage for white glyphs)
  stencil  = mix(matte, accum, m)                       // CIBlendWithMask: glyphs show the layers below
  stencil  = applyTextEffects(stencil)                  // effects apply to the WHOLE stencilled frame
  accum    = opacity < 1 ? mix(accum, stencil, opacity) : stencil
  ```
  The clip's blend mode is ignored. If the mask cannot be rendered (empty text), the layer is skipped.

### 9.12 Natural size / fit-to-content (`TextLayout.naturalSize`, `EditorViewModel+MediaLibrary.swift:462-490, 806-812`)

New text clips and style edits with `fitToContent` resize the box to:

```
vs = style.fontScale; st = scaledVisualStyle(style); cs = canvasH/1080; px = st.fontSize·cs
bounding = layoutSize(fontCase(content) || " ", st, px, maxWidth = 0.9·canvasW·vs)     // §9.5 without the box limit
slack    = max(0, vs)·4
shadowX  = st.shadow.enabled ? max(12·vs, st.shadow.blur + |st.shadow.offsetX|)·cs·2 : 0   (shadowY with offsetY)
borderP  = st.border.enabled ? ceil(px·max(0, st.border.width)/max(1, st.fontSize))·2 : 0
bgPadX   = st.background.enabled ? max(0, st.background.paddingX)·cs·2 : 0                 (bgPadY with paddingY)
natural  = (max(1, ceil(bounding.w) + shadowX + borderP + bgPadX + slack),
            max(1, ceil(bounding.h) + shadowY + borderP + bgPadY + slack))
transform.width = natural.w/canvasW, height = natural.h/canvasH; new clips are centred;
refits keep the vertical centre and anchor x by alignment (left edge / centre / right edge).
```

---

## 10. Audio mixing (`CompositionBuilder.swift:327-413, 541-631, 829-968`)

### 10.1 What is audible

- Only clips on tracks with `type == 'audio'`. A **muted** audio track contributes nothing. A video
  file's sound plays only through its linked audio clip (`linkGroupId`) on an audio track; video-track
  clips are never audible. `hidden` has no effect on audio. Text/subtitle clips are silent.
- Per track: clips sorted by `startFrame`; a clip with `durationFrames ≤ 0` or starting before the
  previous **gate-passing** clip's end is dropped (`prevEnd` advances before the source loads, so an
  offline clip still blocks overlaps). Offline/undecodable sources are silent.
- Nested carriers on audio tracks (`sourceClipType == 'sequence'`) expand the child's unmuted audio
  tracks (§10.4).

### 10.2 Timing

Identical to video (§3.1) using the asset's audio duration: `trimSec = trimStartFrame/fps`, retimed
clips are time-stretched to the clip length. AVFoundation's default time-pitch algorithm on macOS
(`spectral`) preserves pitch. Port: FFmpeg `atempo` (chain factors for `speed < 0.5`, e.g. 0.25 →
`atempo=0.5,atempo=0.5`) or `rubberband=tempo=<speed>` (closer to spectral quality).

### 10.3 Gain envelope

For clip `c` with `D = durationFrames`, gain at frame offset `o ∈ [0, D]`:

```ts
const linFromDb = (db: number) => db <= -60 ? 0 : Math.pow(10, Math.min(db, 15) / 20);   // VolumeScale
function G(c: Clip, o: number, carrier?: Clip, mixGain = 1): number {
  const f = c.startFrame + o;
  const kf = c.volumeTrack?.keyframes.length ? linFromDb(sample(c.volumeTrack.keyframes, o, 0, lerp1)) : 1;  // keys in dB, interpolated in dB
  const own = c.volume * kf * fadeMultiplier(c, f);                    // static volume is LINEAR (0 … 10^(15/20))
  const nest = carrier ? carrier.volume * carrierKf(carrier, f) * fadeMultiplier(carrier, f) : 1;   // carrier.volumeAt(f)
  return own * nest * mixGain;
}
```

The envelope is emitted as **piecewise-linear ramps (in linear amplitude)** between breakpoint offsets
(`emitEnvelopeRamps`):

```
O = {0, D}
  ∪ {k.frame : volume keyframes with 0 ≤ frame ≤ D (deduped by frame, last wins)}
  ∪ for consecutive keys (a,b): smooth → {a + round((b−a)·i/8) : i = 1…7};  hold and b−a > 1 → {b − 1}
  ∪ fadeIn  > 0 → {min(D, fadeIn)}  ∪ (smooth fade-in  → 7 subdivisions of [0, min(D,fadeIn)])
  ∪ fadeOut > 0 → {max(0, D−fadeOut)} ∪ (smooth fade-out → 7 subdivisions of [D−fadeOut, D])
  ∪ nested carrier breakpoints mapped to clip offsets (§10.4), restricted to (0, D)
for consecutive offsets oᵢ < oᵢ₊₁:  ramp G(oᵢ) → G(oᵢ₊₁) over [(start+oᵢ)/fps, (start+oᵢ₊₁)/fps)
```

If the clip has no volume keys, no fades and the carrier (if any) is constant, a single constant gain
`G(0)` is used for the whole clip. Smooth curves are therefore approximated by 8 linear segments and a
`hold` key gets a one-frame linear ramp at its end — reproduce exactly that, not the analytic curve.
Web Audio maps 1:1: `gain.setValueAtTime(G(o₀), t₀)` then `gain.linearRampToValueAtTime(G(oᵢ), tᵢ)`.

### 10.4 Nested audio (`expandNestAudio`, `NestFlattener.flatten(visual: false)`)

- Child audio clips are remapped exactly like video children (§2.3.1) — cut edges lose their fades.
- Intermediate carriers' **static** volumes fold into the child clip volume
  (`clip.volume *= Π intermediate carrier.volume`); only the **top** carrier's full envelope
  (`volumeAt`: static × keys × fades) multiplies in. [QUIRK] Keyframes/fades of intermediate carriers
  are ignored. Carrier breakpoints are converted with `clipOffset = carrier.startFrame + carrierOffset −
  clip.startFrame` for: fade-in end (+7 subdivisions if smooth), fade-out start (+7 if smooth), every
  carrier volume key frame, and `nextKey − 1` after each carrier `hold` key.
- The live top carrier on the parent track is used (edits apply on refresh); if the parent track is
  muted the nested contribution is 0. Nested clips never get the denoise blend.

### 10.5 Denoise blend

If a (top-level) audio clip has an enabled `audio.denoise` effect with `amount > 0` **and** a cached
denoised ("wet") rendering of its source exists (`AudioEnhancer`, ML speech enhancer, only in
`BundledSpeech` builds), the clip is played twice: dry with `mixGain = 1 − s` and wet with
`mixGain = s`, `s = clamp(amount, 0, 1)`, both with the full envelope. Video export bakes missing wet
files first (failure → original audio). Port: optional; substitute FFmpeg `arnndn`/`afftdn` for the wet
signal or play dry only.

### 10.6 Summing and output

- All contributions are **summed** (AVFoundation mixer): no normalisation, no limiter, no master gain.
  Values beyond ±1 clip at encode.
- Output: stereo. Mono sources are duplicated to L and R at unity gain and multichannel sources use the
  default stereo downmix (AVFoundation defaults; verify levels in §13). Sample rate: 48 kHz (HDR path explicit; use 48 kHz everywhere on Linux).
- [NOT IN SOURCE] Pan/balance, per-track faders, master bus, audio effects other than denoise,
  clip-to-clip crossfades (only per-clip fades).
- `Audio/AudioEnvelope.swift` is **analysis only** (16 kHz mono float, hop 2.5 ms = 40 samples,
  `sample = log1p(rms·100)`) feeding sync/beat detection; it does not affect playback or export.

### 10.7 Port implementation

- **Export (recommended):** an in-app float32 mixer in a worker. For each audible clip: decode the
  needed source range with FFmpeg to `f32le, 48 kHz, stereo`
  (`-ss trimSec -t srcDurSec -i src -af "atempo…,aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo"`),
  multiply sample-by-sample by the ramp envelope of §10.3 (evaluate the linear ramp at each sample's
  timeline time), accumulate into the output buffer of exactly `round(N·48000/fps)` frames, write a raw
  `f32le` file and hand it to the video FFmpeg as a second input. Emit an audio stream only if at least
  one audio clip was inserted (macOS omits the audio track otherwise).
- **Preview:** the same envelope builder driving Web Audio `GainNode`s (one per clip) fed by pre-decoded
  / pre-stretched PCM (`AudioBufferSourceNode` or an `AudioWorklet` ring buffer for long media).
- FFmpeg-only alternative (less exact: `volume` expressions step per audio frame): per clip
  `atrim,asetpts=PTS-STARTPTS,atempo…,volume=eval=frame:volume='<piecewise-linear expr of t>',adelay=<ms>:all=1`,
  then `amix=inputs=K:normalize=0:dropout_transition=0` (`normalize=0` is mandatory).

---

## 11. Export

### 11.1 User-facing options (`Export/ExportView.swift`, `Export/ExportOptions.swift`)

| Option | Values | Notes |
|---|---|---|
| Destination | **Video**, **Timeline** (interchange XML), **Palmier Project** | |
| Timeline | any timeline of the project (default: active) | picker shown only with > 1 timeline |
| Codec (Video) | `H.264` (MPEG-4 `.mp4`), `H.265` (`.mp4`), `ProRes` (QuickTime `.mov`), `HEVC 10-bit HDR` (`.mov`) | default H.264 |
| Resolution | `720p`, `1080p`, `2K` (1440), `4K` (2160), `Match Timeline` (default) | **short side** target; up- or down-scales |
| Frame rate | timeline fps (read-only) | CFR |
| Range | whole timeline `[0, N)` | [NOT IN SOURCE] in/out range for user export (only `TimelineRenderer`, §11.6) |
| Bitrate / quality | not exposed; preset-determined | |
| Timeline format | `XMEML` v4 (`.xml`, Premiere/Resolve), `FCPXML` (`.fcpxml`, Resolve/FCP) with **version** `1.10` (default) … `1.14` and **target** `DaVinci Resolve` (default) / `Final Cut Pro` | |

```ts
function exportRenderSize(res: '720p' | '1080p' | '2K' | '4K' | 'match', W: number, H: number) {
  const even = (v: number) => Math.max(2, Math.trunc(roundHalfAway(v) / 2) * 2);
  if (res === 'match') return { w: even(W), h: even(H) };
  const target = { '720p': 720, '1080p': 1080, '2K': 1440, '4K': 2160 }[res];
  const short = Math.min(W, H); if (short <= 0) return { w: W, h: H };
  const k = target / short;
  return { w: even(W * k), h: even(H * k) };
}
// File-size estimate shown in the dialog (bytes/s per output megapixel):
const BPS_PER_MP = { h264: 0.63e6, h265: 0.32e6, prores: 9.0e6, hdr: 0.45e6 };
const estimateBytes = (codec, w, h, seconds) => BPS_PER_MP[codec] * Math.max(0.1, (w * h) / 1e6) * seconds;
```

Summary line: duration timecode of `totalFrames`, `~size`, `W×H`, container label.

### 11.2 macOS pipeline (reference)

1. `ExportQueue` (one job at a time, FIFO; a destination path that is queued/in progress is rejected with
   "An export to <file> is already waiting or in progress."). Statuses:
   `queued → preparing → rendering → (canceling) → completed | failed | canceled`.
2. Video: bake missing denoise files → `CompositionBuilder.build(renderSize)` (same compositor as
   preview, §2–§10) → `AVAssetExportSession(preset)` with the audio mix and video composition
   (`frameDuration = 1/fps`):

| Codec \ Resolution | 720p | 1080p | 2K | 4K | Match |
|---|---|---|---|---|---|
| H.264 | `Preset1280x720` | `Preset1920x1080` | `HighestQuality` | `Preset3840x2160` | `HighestQuality` |
| H.265 | `HEVCHighestQuality` | `HEVC1920x1080` | `HEVCHighestQuality` | `HEVC3840x2160` | `HEVCHighestQuality` |
| ProRes | `AppleProRes422LPCM` (ProRes 422 + LPCM) for all | | | | |

   [QUIRK] Size-named presets clamp dimensions (e.g. a 9:16 timeline at "1080p"), so the real output
   size is read back from the file for the report (`ExportService.swift:479-488`).
3. HEVC HDR (`HDRVideoExporter`): read the composition through `AVAssetReaderVideoCompositionOutput`
   (10-bit 4:2:0), convert each frame Rec.709 → BT.2100 HLG with Core Image, write HEVC **Main10**
   (`AutoLevel`), tags BT.2020 / HLG / BT.2020 matrix, `.mov`; audio via the audio mix → AAC-LC
   stereo 48 kHz 192 kbps. Progress = seconds written / duration.
4. Output is written to a staging file `<dir>/.<stem>-<UUID>.partial.<ext>` and atomically
   moved/replaced onto the destination after success (`withStagedOutput`); cancel or failure deletes it.
   Cancel is refused once the output has been committed. Report: encoded size + offline/unprocessable
   media refs (warning count). Failure reasons: `out_of_memory, media_decode, decoder_missing,
   video_composition, disk_full, other`.

### 11.3 Linux pipeline

```
ExportJob (queue, same states/semantics)
  ├─ 1. snapshot timeline + media map (immutable)
  ├─ 2. audio: in-app mixer → <tmp>/mix.f32 (48 kHz stereo float, exactly N/fps s)        §10.7
  ├─ 3. spawn ffmpeg (args §11.4) writing <dir>/.<stem>-<UUID>.partial.<ext>
  ├─ 4. offscreen WebGL2Renderer (hidden BrowserWindow or Worker+OffscreenCanvas, same code as preview)
  │      for f in 0..N-1: plan = layersAt(f); fetch source frames (§3.1, sequential decoders per source);
  │      render at exportRenderSize; readPixels RGBA8 (clamped, top row first) → main process → ffmpeg stdin
  │      (await 'drain' for backpressure); progress = f/N
  ├─ 5. ffmpeg exit 0 → ffprobe size → rename(partial, dest) (replace if exists)
  └─ cancel/failure: kill ffmpeg (SIGTERM, then SIGKILL after 2 s), unlink partial + temp audio
```

Decoding for export should be sequential and seek-free per source (one FFmpeg reader per active clip,
started at `trimSec − ε` with frame PTS reported), applying the §7.2 RGB conversion. Text rasters use the
same Canvas2D code path as the preview with fonts registered in the export renderer before frame 0.

### 11.4 FFmpeg mapping

Common prefix (video from stdin, audio from the mix file; drop the audio input and use `-an` when the
timeline has no inserted audio):

```bash
ffmpeg -hide_banner -y \
  -f rawvideo -pix_fmt rgba -video_size ${W}x${H} -framerate ${FPS} -i pipe:0 \
  -f f32le -ar 48000 -ac 2 -i "${MIX}" \
  -map 0:v:0 -map 1:a:0 -fps_mode cfr -r ${FPS} \
```

SDR colour conversion (full-range RGB → limited BT.709 Y'CbCr, no transfer change) — used by all SDR
codecs: `SDR_VF="scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int"`, plus
`-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv`.

Target bitrates mirror the dialog estimate (`MP = W·H/1e6`): H.264 `5040·MP` kbps, H.265 `2560·MP`,
HDR `3600·MP` (1080p ≈ 10.4 / 5.3 / 7.5 Mbps; 4K ≈ 41.8 / 21.2 / 29.9 Mbps).

| macOS | FFmpeg (Linux) |
|---|---|
| H.264 (`.mp4`) | `-vf "$SDR_VF,format=yuv420p" -c:v libx264 -preset slow -profile:v high -b:v ${B}k -maxrate $((B*3/2))k -bufsize $((B*2))k -x264-params "colorprim=bt709:transfer=bt709:colormatrix=bt709" <tags> -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart -f mp4` (alternative quality mode: `-crf 18` with the same `-maxrate/-bufsize` cap) |
| H.265 (`.mp4`) | `-vf "$SDR_VF,format=yuv420p" -c:v libx265 -preset medium -b:v ${B}k -tag:v hvc1 -x265-params "vbv-maxrate=$((B*3/2)):vbv-bufsize=$((B*2)):colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited" <tags> -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart -f mp4` |
| ProRes 422 + LPCM (`.mov`) | `-vf "$SDR_VF,format=yuv422p10le" -c:v prores_ks -profile:v 2 -vendor apl0 <tags> -c:a pcm_s16le -ar 48000 -ac 2 -f mov` (`profile 2` = ProRes 422 "standard", matching `AppleProRes422LPCM`) |
| HEVC 10-bit HDR HLG (`.mov`) | `-vf "format=gbrpf32le,zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t=arib-std-b67:p=bt2020:m=bt2020nc:r=limited:npl=203,format=yuv420p10le" -c:v libx265 -preset medium -profile:v main10 -b:v ${B}k -tag:v hvc1 -x265-params "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited" -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -color_range tv -c:a aac -b:a 192k -ar 48000 -ac 2 -f mov` |

Notes: all output dimensions are even by construction; `-movflags +faststart` only for MP4. For the HDR
recipe verify with a 100 % white SDR patch that the HLG signal lands at ≈ 75 % (10-bit narrow code ≈ 721);
tune `npl` if Core Image's mapping differs (§13).

### 11.5 Encoder-independent behaviours to keep

- Frame count `N` exactly (no `-shortest` truncation; the audio file has exactly `N/fps` seconds).
- Output tags SDR BT.709 limited (§7.3); timecode starts at 0.
- Missing/offline media render as absent layers; report them as warnings (offline vs unprocessable).

### 11.6 Selection render and frame capture

- `TimelineRenderer.render` (agent/AI features): frames `[start, start+count)`; render size = canvas scaled
  so the short side is `≤ shortSide` (**never upscales**, `scale = min(1, shortSide/short)`), even;
  preset `MediumQuality` H.264 `.mp4` into a temp file; audio optional. Linux: `libx264 -preset veryfast
  -crf 23`, AAC 128 kbps, same pipeline with `f ∈ [start, start+count)` and the audio mix sliced to that range.
- `FrameCaptureRenderer.timeline`: a single composited frame at full canvas size → PNG (+ library
  thumbnail); at most 2 concurrent captures. `FrameCaptureRenderer.media`: a raw source frame at
  `sourceSeconds ∈ [0, duration + 0.001]`, snapping to the last frame when within one frame duration of
  the end (`requestedTime = end − minFrameDuration`) → PNG, reporting the actual frame time.

### 11.7 XMEML v4 exporter (`Export/XMLExporter.swift`) — summary

`<?xml …?><!DOCTYPE xmeml><xmeml version="4"><sequence id="sequence-1">` with `name`, `duration =
totalFrames`, `rate{timebase=fps, ntsc=FALSE}`, `timecode` 00:00:00:00 NDF, `media/video/format`
(sequence W×H, square pixels) and `media/audio` (2 output channels, 48 kHz/16-bit).

- **Tracks:** video tracks bottom→top (reverse of model order), `enabled = !hidden`; audio tracks in model
  order, `enabled = !muted`. Clips whose media does not resolve are dropped (nest carriers kept only if
  `trimStartFrame < child.totalFrames`).
- **clipitem** `id="clipitem-<clipId>"`: `masterclipid` (`masterclip-<linkGroupId>` or
  `masterclip-<mediaRef>-video|audio`), `start/end` in sequence frames, `in/out` in **file-rate** frames
  (`in = trimStart`, `out = trimStart + sourceFramesConsumed`, scaled by `fileFPS/fps` when the rates
  differ), `duration` = source duration in file frames, `rate` = file rate.
- **file** `id="file-<mediaRef>-video|audio"` defined once then referenced; `pathurl` =
  `file://localhost//…` form; still images duration 1; per-file `rate` with NTSC detection
  (`timebase = round(fps)`, `ntsc = |fps − timebase·1000/1001| < |fps − timebase|`); `timecode` from the
  source's embedded timecode (BWF time references rescaled), drop-frame `;` formatting for 29.97/59.94.
- **Filters:** `Time Remap` (`speed·100`, only when speed ≠ 1); `Basic Motion` — `scale% =
  (seqW/srcW)·width·100`, `rotation = −rotation` (FCP7 is CCW-positive), `center = (centerX − 0.5,
  centerY − 0.5)` normalized; keyframed variants sample all three at the union of position/scale/rotation
  keyframe frames (`when` = clip-relative); `Crop` (percent per edge, keyframes); `Opacity` (percent,
  keyframes, fades excluded); `Audio Levels` (linear, clamped 0…3.98, keyframes; fades excluded).
- **Fades** → single-sided `transitionitem`s: video `Cross Dissolve` (`start-black`/`end-black`,
  `cutPointTicks = cutFrames·254016000000/fps`), audio `Cross Fade (0dB)`.
- **Links:** reciprocal `<link>` (linkclipref, mediatype, 1-based track/clip index) for clips sharing a
  `linkGroupId`.
- **Nests:** nested `<sequence>` embedded in the first carrier, referenced by id afterwards;
  `out = min(in + duration, child.totalFrames)`.
- Not exported: text, flips, interpolation curves, effects/colour, edge rounding/softness.

### 11.8 FCPXML exporter (`Export/FCPXMLExporter.swift`) — summary

`<fcpxml version="1.10…1.14">` → `<resources>` (sequence `format` `r1` with `FFVideoFormat…` name when
known else `FFVideoFormatRateUndefined`, `frameDuration` `1/fps` or `1001/(fps·1000)` for NTSC,
`colorSpace="1-1-1 (Rec. 709)"`; `Basic Title` effect when titles exist; one `format` + `asset`
(`media-rep src` = file URL with sub-delimiters `'!$&()*+,;=` percent-encoded, `start` = source
timecode, `hasVideo/hasAudio`, 2 ch 48 kHz) per unique resolved file; a compound `media`
(`<sequence><spine><asset-clip/>`) for sources that are both video and audio; one `media` per reachable
nested timeline) → `<library><event name="Palmier Export"><project><sequence><spine><gap>` containing
every clip as a **connected clip on a lane**:

- Lanes: visual tracks `lane = visualCount − ordinal` (top track highest), audio tracks `−1, −2, …`;
  `enabled = !hidden / !muted`. Story order: by `startFrame`, then lane.
- Times: rational `N/Ds` reduced by gcd, `"0s"` for zero. `offset = startFrame`, `duration`,
  `start = trimStart` (plus source timecode origin).
- Retime (`speed ≠ 1`): `<timeMap frameSampling="floor">` with `timept 0s → origin` and
  `timept (mediaFrames·q)/(fps·p) s → mediaFrames` where `speed ≈ p/q` (best fraction q ≤ 1000);
  `start = trimStart·q/(fps·p)`; keyframe times use the same output axis.
- Video adjustments (DTD order): `adjust-crop mode="trim"` (`trim-rect` — Resolve target: left/right =
  `crop·srcW·100/seqH`, top/bottom = `crop·100/fit`, `fit = min(seqW/srcW, seqH/srcH)`; FCP: percent),
  `adjust-conform type="fit"`, `adjust-transform` (`scale = (width/fitW, height/fitH)` with negative
  values for flips, where `fitW,fitH` = per-axis aspect-fit fractions; `rotation = −rotation`;
  `anchor="0 0"`; `position = ((cx−0.5)·seqW, (0.5−cy)·seqH) / (seqH/100)` divided by the fit fraction
  for the Resolve target; keyframes via `<param name="scale|position|rotation"><keyframeAnimation>`
  with `curve="linear"` for linear keys), `adjust-blend amount=opacity` (+ keyframes).
- Audio: `adjust-volume amount = 20·log10(volume)` dB (−96 for 0); keyframed volume and audio fades are
  not exported. Linked A/V pairs with identical placement export as one `asset-clip`; one-sided use of an
  A/V source goes through a `ref-clip` to the compound media with `srcEnable="video|audio"`.
- Titles: `<title ref="titleBasic">` with `text-style-def` (`font` family, `fontFace`, `fontSize =
  fontSize·fontScale`, `fontColor "r g b a"`, `alignment`, `strokeColor/strokeWidth` when outline
  enabled), `adjust-transform` with `scale = (widthScale, heightScale)` (+ scale keyframes as ratio of
  `textScaleAt`), position as above. Not exported: text background boxes, title rotation, crop keys,
  colour/effects, edge rounding/softness, Lottie, subtitles.

### 11.9 Palmier project export (`Export/PalmierProjectExporter.swift`) — summary

A `.palmier` package directory (UTI `io.palmier.project`):

```
<name>.palmier/
  project.json      ProjectFile { timelines[], activeTimelineId, openTimelineIds, viewStates, speakers, multicamGroups }
  media.json        MediaManifest { version: 2, entries[], folders[] } — entry.source = {"project":{"relativePath":"media/…"}}
  media/            every resolvable source copied here
  thumbnail.jpg     copied if present
  chat/             agent chat history, copied if present
```

- Built in `<parent>/.palmier-export-<UUID>.partial/` and atomically moved/replaced onto the target.
- `external` sources are copied as `media/import-<first 8 chars of entry id>.<ext>`; `project` sources keep
  their file name; duplicate source paths are copied once; name collisions get `-1`, `-2`, …; copying is
  chunked (4 MiB) and cancellable.
- Missing sources keep their original (dangling) manifest entry and are reported:
  "N media file(s) were missing and could not be included."

---

## 12. Preview engine notes (`Preview/VideoEngine.swift`)

- The preview renders at the **full timeline canvas size** (`renderSize = timeline.width×height`) and
  the view scales the result aspect-fit (`videoContentRect`). Because every spatial parameter is either
  source-relative (media effects) or canvas-relative (`H/1080` for text), the port may render at a lower
  resolution while scrubbing without changing the look.
- Rebuilds are cached per timeline by `(timelines stripped of text clips, totalFrames, media URLs, asset
  sizes, missing refs)`; text/visual-property edits only rebuild the frame plan (`refreshVisuals`).
- Interactive scrubbing coalesces seeks to ≥ 1/30 s apart with tolerance `min(0.75, 0.15·activeVideoLayers)` s;
  exact seeks otherwise. Playback rates and audio scrubbing are UI concerns (see `05-ui.md`).
- Playback ends at `N` (composition length) and pauses.

---

## 13. Parity verification (macOS reference renders)

Render these on macOS with Palmier Pro (PNG via frame capture, and short ProRes exports) and compare with
the port (ΔE / PSNR; text visually):

1. Identity pipeline: colour bars video, crop + flip + rotation 30°, opacity 0.5 over a gradient.
2. Every blend mode over a gradient backdrop with a half-transparent PNG layer (checks §6.3, soft light).
3. Each **[APPROX]** effect at 3 settings: temperature (2000/6500/11000 K, tint ±100), vibrance (±1),
   sharpen (0.4/2), noise reduction (0.5/1), motion blur (20 px at 0°/45°), Gaussian blur (σ mapping
   with a 1-px white line), CI sRGB curves round trip (exposure 0).
4. Curves identity (white must stay 1.0 → edge sampling), hue curves at the red seam, LUT with a
   `DOMAIN_MAX ≠ 1` file, tetrahedral vs a known 33³ LUT.
5. Text: Helvetica/Inter at 96 pt, 3 lines, each alignment, tracking 20, line spacing 20 and −20,
   width/height scale 1.5, outline opaque vs translucent fill, shadow default (check the 2 px upward
   offset), background box with padding/radius/offset/outline, underline/strike/overline; every
   animation preset at 5 frames; tilt X/Y 30°.
6. Audio: a 1 kHz tone with fades (linear/smooth), dB keyframes (smooth/hold), speed 0.5/2, nested
   carrier with fade; compare sample envelopes.
7. HDR export: SDR white/grey ramp → measure HLG code values.

---

## 14. Quirk register and port decisions

| # | Quirk | Where | Port decision |
|---|---|---|---|
| Q1 | Overlapping clip on a track is dropped for its whole duration | §2.2 | keep |
| Q2 | Retimed source length truncates; clamp stretches remaining source | §3.1 | keep |
| Q3 | Speed-1 clip longer than its source shows nothing past the end | §3.1 | keep |
| Q4 | Scale pivots on top-left when position is keyframed | §4.2 | keep (data semantics) |
| Q5 | Media effect sizes are in source pixels | §5.3 | keep |
| Q6 | Built-in CI filters double-unpremultiply semi-transparent pixels | §8.1 | **fix** (evaluate on straight colour) |
| Q7 | Output tagged with the top source's (possibly HDR) colour tags | §7.3 | **fix** (always BT.709 SDR) |
| Q8 | Curves LUT built at i/255, sampled at v·256 | §8.11 | keep (tiny) |
| Q9 | `.cube`: tabs not separators, unknown 3-token keywords reject the file, domain applied to outputs | §8.13 | keep (same acceptance set), consider accepting tabs later |
| Q10 | Default text shadow offset −2 points the shadow up | §9.7 | keep |
| Q11 | Negative line spacing behaves as 0 | §9.5 | keep |
| Q12 | Entrance opacity darkens colour (k²) | §9.8 | keep for parity; flag `fixEntranceFade` |
| Q13 | Typewriter can split a surrogate pair | §9.8 | **fix** (cut at grapheme boundary) |
| Q14 | Inverted text edge darkening (a²) | §9.11 | keep (sub-pixel) |
| Q15 | Text blur ignores the `enabled` flag of its `blur.gaussian` entry | §9.10 | keep |
| Q16 | Intermediate nest carriers contribute only static volume | §10.4 | keep |
| Q17 | Size-named H.264/HEVC presets may clamp output size | §11.2 | **fix** (always encode at `exportRenderSize`) |
| Q18 | Stale hit-test comment: text is not always on top | §2.1 | **fix** (hit-test in compositor order) |
