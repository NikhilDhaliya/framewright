# BYOK video generation APIs — research for spec 06

Checked against live provider docs on 2026-10-13 (fal schemas via `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`). [U] = could not confirm.

## Findings that change the plan

1. **Palmier's backend looks like a fal proxy** (inference): prompt tags `@Image1`/`@Video1`/`@Audio1`/`@Element1` are fal syntax; `flux-3` draft assets store `resultURLs:["video","cache"]` matching fal/BFL `video` + `draft_cache`; models declare `allowedEndpoints:["opaque"]`. So fal with one `FAL_KEY` is the closest drop-in. Other providers need prompt-tag rewriting (§0.3).
2. **Gemini API Veo 3.1 ids shut down 2026-10-22** (`veo-3.1-generate-preview`, `-fast-`, `-lite-`; replacement `gemini-omni-1.1-flash`, https://ai.google.dev/gemini-api/docs/deprecations). Use fal for Veo.
3. **`kling-reframe` is not a real Kling endpoint.** It's a "Legacy Reframe" test fixture (`Tests/PalmierProTests/Generation/ReframeSeedTests.swift`: source video ≤10 s, prompt allowed, durations 5/10, 1080p, 16:9 or 9:16). The live reframe (`Sources/PalmierPro/Generation/Edit/EditSubmitter+Seeds.swift`) uses **MiniMax H3 reference-to-video** with the source as `@Video1` and prompt "The exact same video as @Video1 but fill in to match the output aspect ratio…". `VideoModelConfig.isReframeModel` matches `minimax-h3` and `hailuo-03`.
4. **`hailuo-03` is MiniMax's internal name for H3** (v2 OpenAPI titled "Hailuo-03"; fal groups it as `hailuo-03-new`; no public `hailuo-03` model string). [U] whether it means H3 or H3 Max.
5. **`flux-3` is BFL FLUX 3 Video** (announced 2026-07-23), with exactly Palmier's draft (720p) → enhance flow, on fal and api.bfl.ai.

**Deprecations:** LTX-2 removed upstream 2026-08-16; LTX synchronous V1 endpoints stop 2026-10-26; Runway removed `gen4_aleph` 2026-07-30 (replacement `aleph2`); fal deprecates Luma Ray 2 endpoints 2026-10-25.

## 0. Common mechanics

### 0.1 fal queue
Docs: https://fal.ai/docs/documentation/model-apis/inference/queue.md, https://fal.ai/docs/documentation/model-apis/fal-cdn.md
- Submit `POST https://queue.fal.run/{endpoint_id}`, headers `Authorization: Key $FAL_KEY`, `Content-Type: application/json`, body = input JSON → `{request_id, response_url, status_url, cancel_url, queue_position}`.
- Status `GET {status_url}` (`?logs=1`) → `{status: IN_QUEUE|IN_PROGRESS|COMPLETED}`; failure = `COMPLETED` with `error`, `error_type`.
- Result `GET {response_url}`; cancel `PUT {cancel_url}`; webhook `?fal_webhook=<url>` on submit.
- Always use the returned URLs (for nested ids fal-js builds them from the app id only, e.g. `queue.fal.run/fal-ai/veo3.1/requests/{id}/status`).
- Inputs: URL or `data:` URI (small files).
- Upload (from fal-js `storage.ts`, not formally documented): `POST https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3` with Key header and `{"content_type","file_name"}` → `{upload_url, file_url}`; `PUT` bytes to `upload_url`; use `file_url`. Over 90 MB use `initiate-multipart`.
- Outputs: `{"video":{"url",...}}`.

### 0.2 Modes
fal splits modes into endpoints (image-to-video, first-last-frame, reference-to-video); vendor APIs use one endpoint with roles. Frames and references are mutually exclusive on MiniMax H3, Seedance and Veo (matches Palmier's `framesAndReferencesExclusive`).

### 0.3 Reference tag syntax
| Provider | Syntax |
|---|---|
| fal Seedance, fal Kling, fal Grok legacy reference-to-video | `@Image1` (same as Palmier) |
| xAI official, fal Grok v1.5 reference-to-video | `<IMAGE_0>`, `<AUDIO_0>` (0-based); pinned first frame takes `<IMAGE_0>` |
| BytePlus | `@Image 1` or `[Image 1]` |
| Replicate Seedance | `[Image1]` |
| MiniMax | "Image 1", "reference video 1" |
| Kling official | `@<content id>` (new API) or `<<<image_1>>>` (legacy) |

## 1. Veo 3.1 (`veo3.1-fast`)

| fal endpoint | Duration | Aspect | Resolution | Key inputs |
|---|---|---|---|---|
| `fal-ai/veo3.1[/fast]` (t2v) | "4s"/"6s"/"8s" | 16:9, 9:16 | 720p, 1080p, 4k | `generate_audio` (default true), `negative_prompt`, `seed` |
| `…/image-to-video` | same | +auto | same | `image_url` |
| `…/first-last-frame-to-video` | same | +auto | same | `first_frame_url`, `last_frame_url` |
| `…/reference-to-video` | "8s" only | 16:9, 9:16 | same | `image_urls[]` (≤3); no seed/negative prompt |
| `…/extend-video` | "7s" only | +auto | 720p only | `video_url` |
| `fal-ai/veo3.1/lite[/image-to-video\|/first-last-frame-to-video]` | 4/6/8 s | same | 720p, 1080p | as above |

Shared: `prompt` ≤20000, `auto_fix`, `safety_tolerance` "1"–"6"; input images ≤8 MB.
```json
POST https://queue.fal.run/fal-ai/veo3.1/fast/first-last-frame-to-video
{"prompt":"…","first_frame_url":"…","last_frame_url":"…","duration":"8s","aspect_ratio":"auto","resolution":"1080p","generate_audio":true,"seed":42}
→ {"video":{"url":"…mp4"}}
```
Gemini API (until 2026-10-22, https://ai.google.dev/gemini-api/docs/video): `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning`, header `x-goog-api-key`; `instances[{prompt, image:{bytesBase64Encoded,mimeType}, lastFrame, referenceImages[{image,referenceType:"asset"}] ≤3, video:{uri}}]`, `parameters{aspectRatio, resolution, durationSeconds 4|6|8, negativePrompt, personGeneration}`; 8 s required for 1080p/4k/references/extend. Poll `GET …/v1beta/{name}` until `done`; video at `response.generateVideoResponse.generatedSamples[0].video.uri` (download with `-L` + key). No `seed`/`generateAudio`. Extend +7 s ×20, Veo 720p input only; outputs kept 2 days. [U] `inlineData` vs `bytesBase64Encoded`; reference images on Fast reportedly unsupported.

## 2. Seedance 2.0 / 2.5

| fal endpoint | Duration | Aspect | Resolution | Refs (img/vid/aud) |
|---|---|---|---|---|
| `bytedance/seedance-2.0/{text-to-video,image-to-video,reference-to-video}` | "auto", "4"–"15" | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 480p–4k | 9/3/3, ≤12 total |
| `…/seedance-2.0/fast/*`, `/mini/*` | same | same | 480p, 720p | same |
| `…/seedance-2.0/us/*` | same | same | 480p–4k | same |
| `bytedance/seedance-2.5/{text-to-video,image-to-video,reference-to-video}` | "auto", "4"–"30" | same | 480p, 720p, 1080p | 30/10/10, ≤50 total |

2.0 i2v: `image_url` + `end_image_url`. 2.5: `draft` (480p preview → `draft_id`, complete with `bytedance/seedance-2.5/draft/complete {draft_id}`), `seed` (r2v only), `task` = reference|editing|extension. Common `generate_audio` (default true); most 2.x have no seed. Limits: images ≤30 MB; videos combined 2–15 s, <50 MB; audio ≤15 s total and needs an image or video.
```json
POST https://queue.fal.run/bytedance/seedance-2.0/reference-to-video
{"prompt":"@Image1 in the scene of @Video1, music like @Audio1","image_urls":["…"],"video_urls":["…"],"audio_urls":["…"],"resolution":"1080p","duration":"auto","aspect_ratio":"16:9","generate_audio":true}
→ {"video":{"url":"…"},"seed":123}
```
BytePlus ModelArk (https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api): `POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks`, `Authorization: Bearer $ARK_API_KEY`; models `dreamina-seedance-2-0-260128` (+`-fast-260128`, `-mini-260615`), `dreamina-seedance-2-5-260628`; body `{model, content:[{type:"text",text},{type:"image_url",image_url:{url},role:first_frame|last_frame|reference_image},{type:"video_url",…,role:"reference_video"},{type:"audio_url",…,role:"reference_audio"}], resolution, ratio, duration (4–15 or -1; 2.5: 4–30), generate_audio, watermark, return_last_frame}` → `{id}`. Poll `GET …/tasks/{id}` (queued/running/succeeded/failed/cancelled); video `content.video_url` (24 h). Video refs URL or `asset://` only; real human faces in refs rejected; `seed` only documented for 1.x [U]. Volcengine: `ark.cn-beijing.volces.com`, `doubao-` ids.

## 3. Kling

| fal endpoint | Key inputs | Audio |
|---|---|---|
| `fal-ai/kling-video/v3/{standard\|pro\|4k}/text-to-video` | `duration` "3"–"15", `aspect_ratio` 16:9/9:16/1:1, `negative_prompt`, `cfg_scale`, `multi_prompt` (≤6 shots) | `generate_audio` (default true) |
| `…/v3/{tier}/image-to-video` | `start_image_url` (req), `end_image_url`, `elements[]` | `generate_audio` (default true) |
| `fal-ai/kling-video/o3/{tier}/reference-to-video` | `image_urls` (`@Image1`) + `elements` (`@Element1`), ≤7 total or ≤4 with a video element; optional start/end frames | `generate_audio` (default false) |
| `…/o3/{tier}/video-to-video/edit` and `/reference` | `video_url` = `@Video1` (3–15 s, ≤200 MB) | `keep_audio` |
| `fal-ai/kling-video/v3/{standard\|pro}/motion-control` | `image_url` + `video_url`, `character_orientation` (`image` ≤10 s source, `video` ≤30 s) | `keep_original_sound` |
| `fal-ai/kling-video/lipsync/audio-to-video` | `video_url` (2–10 s, 720–1920 px), `audio_url` (2–60 s, ≤5 MB) | – |

Element shape `{frontal_image_url, reference_image_urls[1..3]}`.
Kling official (https://app.klingai.com/global/dev/document-api): base `https://api-singapore.klingai.com`; auth API key as Bearer, or legacy JWT HS256 with SK, payload `{iss:AK, exp:now+1800, nbf:now-5}`. New: `POST /text-to-video/kling-3.0`, `/image-to-video/kling-3.0`, `/omni-video/kling-3.0-omni`, `/motion-control/kling-3.0`, body `{contents:[{type,url|text|element_id,id}], settings:{audio, resolution 720p|1080p|4k, aspect_ratio, duration 3–15}}`, poll `GET /tasks?task_ids=` → `outputs[].url`. Legacy `/v1/videos/{text2video,image2video,omni-video,motion-control}` with `model_name` `kling-v3`/`kling-v3-omni`; images raw base64 (no `data:`) or URL ≤10 MB; poll for `data.task_status:"succeed"`, video `data.task_result.videos[0].url`. Elements pre-created via `POST /v1/general/advanced-custom-elements`. Lip sync: `identify-face` then `advanced-lip-sync` ([U] whether `/v1/videos/lip-sync` still works). Extend: V1.x only.
Reframe: no Kling endpoint. Closest Kling-shaped `fal-ai/kling-video/o1/video-to-video/reference` (3–10 s, "3"–"10", 16:9/9:16); purpose-built `fal-ai/ltx-2.3/reframe`, LTX `/v2/video-to-video-reframe`, Luma `luma/agent/ray/v3.2/reframe`, Runway `aleph2` + `targetAspectRatio`.

## 4. xAI Grok Imagine
Docs: https://docs.x.ai/developers/model-capabilities/video/overview (append `.md`), https://docs.x.ai/developers/rest-api-reference/inference/videos

| Model | Modes | Refs | Resolution | Price |
|---|---|---|---|---|
| `grok-imagine-video-1.5` | t2v/i2v native 1080p; first, last, keyframes (≤4) | ≤14 images + ≤3 voices (≤720p in reference mode) | 480p/720p/1080p | $0.08/s |
| `grok-imagine-video-1.5-lite` | t2v/i2v | none | ≤1080p | $0.02/s |
| `grok-imagine-video` (legacy) | ≤720p; edit, extend | ≤7 images, ≤10 s | ≤720p | $0.05/s |

Duration 1–15 s (default 8). Aspects 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9, 5:2. **Default resolution 480p.**
```
POST https://api.x.ai/v1/videos/generations   (Authorization: Bearer $XAI_API_KEY)
{"model":"grok-imagine-video-1.5","prompt":"…","image":{"url":"https://…|data:image/png;base64,…"},"last_frame":{"url":"…"},
 "keyframes":[{"image":{"url":"…"},"timestamp_s":2.0}],"reference_images":[{"url":"…"}],"reference_audios":[{"voice_id":"eve"}],
 "duration":8,"aspect_ratio":"16:9","resolution":"720p","generate_audio":true}
→ {"request_id":"…"}
GET https://api.x.ai/v1/videos/{request_id}
→ {"status":"pending|done|failed","progress":…,"video":{"url":"https://vidgen.x.ai/…mp4","duration":8,"respect_moderation":true},"error":{"code","message"}}
```
Images: URL, data URI or `{file_id}`; JPEG/PNG/WebP; size limits [U]. i2v ignores `aspect_ratio`. Video URLs temporary. `generate_audio`/`last_frame` only in guides, not the REST reference [U]. Edit (legacy): `POST /v1/videos/edits {model:"grok-imagine-video",prompt,video:{url}}`, source ≤8.7 s, ≤720p. Extend (legacy): `POST /v1/videos/extensions {…,video:{url},duration 2–10}`, source 2–15 s, returns original + extension.
fal: `xai/grok-imagine-video/v1.5/{text-to-video,image-to-video,reference-to-video}`, `v1.5/lite/{text-to-video,image-to-video}` (r2v ≤7 images, 480p/720p, `<IMAGE_0>` tags); legacy `xai/grok-imagine-video/{text-to-video,image-to-video,reference-to-video (@Image1),edit-video,extend-video}`. No fal version has `last_frame`, keyframes, voices or an audio flag.

## 5. MiniMax H3 / `hailuo-03` / Hailuo 02 and 2.3
fal `minimax/h3/{text-to-video,image-to-video,reference-to-video}`: `duration` int 5–15; `resolution` 480P/768P/2K/4K; aspects 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 (+adaptive for r2v); i2v `image_url`, `end_image_url`; r2v `reference_image_urls` ≤9, `reference_video_urls` ≤3, `reference_audio_urls` ≤3, ≤12 total (matches Palmier's fixture limits). `minimax/h3-max[/turbo]/*`: 480P/768P/1080P + extend-video, recast, lip-sync. Hailuo: `fal-ai/minimax/hailuo-02/{standard,pro}/*` (supports `end_image_url`), `fal-ai/minimax/hailuo-2.3/*` (first frame only); duration "6"/"10".
MiniMax v2 (https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md): `POST https://api.minimax.io/v2/video_generation`, Bearer; `{model:"MiniMax-H3"|"MiniMax-H3-Max", content:[text, image_url role first_frame|last_frame|reference_image, video_url role reference_video, audio_url role reference_audio], resolution 768P|2K (Max: 480P|768P), duration 4–15, ratio}` → `{task_id}`; poll `GET /v2/query/video_generation/{task_id}` → `task.status` succeeded, `task.content.url`. Inputs URL, `mm_file://` or data URI; images ≤30 MB, videos ≤50 MB.
MiniMax v1 (Hailuo): `POST /v1/video_generation {model:"MiniMax-Hailuo-02", prompt, first_frame_image, last_frame_image, duration 6|10, resolution 512P|768P|1080P}`; poll `GET /v1/query/video_generation?task_id=` → `file_id`; download `GET /v1/files/retrieve?file_id=` → `file.download_url` (1 h).

## 6. FLUX 3 (`flux-3`)
Docs: https://docs.bfl.ml/flux_3/flux3_video.md, https://api.bfl.ai/openapi.json

| fal endpoint | Key inputs |
|---|---|
| `blackforestlabs/flux-3/text-to-video` | `prompt`*, `duration` "auto" or 5–20, `aspect_ratio` auto/21:9/2:1/16:9/4:3/1:1/3:4/9:16, `resolution` 720p/1080p, `generate_audio` (default true), `safety_tolerance` 0–4 |
| `…/image-to-video` | + `image_url` |
| `…/first-last-frame-to-video` | `start_image_url`, `end_image_url`, `duration` int 5–20 |
| `…/keyframes-to-video` | ≤10 `{image_url, frame_index}` at 24 fps |
| `…/extend-video` | `video_url` (MP4 <50 MB, <15 s) |
| each of the above + `/draft` | same inputs, no `resolution` (draft = 720p) |
| `blackforestlabs/flux-3/draft-enhance` | `{draft_cache_url, safety_tolerance}` |

Outputs: full `{video, seed}`; drafts `{video, draft_cache:{url}}`. No seed input, negative prompt or reference images on fal.
```json
POST https://queue.fal.run/blackforestlabs/flux-3/image-to-video/draft
{"prompt":"…","image_url":"…","duration":8,"aspect_ratio":"16:9"}
→ {"video":{"url":"…"},"draft_cache":{"url":"…bin"}}
POST https://queue.fal.run/blackforestlabs/flux-3/draft-enhance
{"draft_cache_url":"…bin"}
→ {"video":{"url":"…"}}
```
BFL official: `POST https://api.bfl.ai/v1/flux-3-video`, header `x-key`, strict schema (unknown fields → 422): `mode` t2v|i2v|v2v|draft_enhance, `prompt`, `keyframes` (i2v: one image = first frame; `[a,b]` = first+last; `[[seconds,img],…]` pins times; ≤10; URL or base64), `start_video` (v2v 5–15 s), `aspect_ratio` (as fal + 9:21), `duration` 5–20|"auto", `resolution` hd (1280x704)|fhd|qhd|uhd, `generate_audio`, `safety_tolerance`, `draft: true` (hd only) → `{id, polling_url}`. Enhance: `{"mode":"draft_enhance","draft_cache":"<base64 or URL>","resolution":"fhd"}`. Poll `GET {polling_url}` or `/v1/get_result?id=`: Pending, Reasoning, Generating, Ready, Request Moderated, Content Moderated, Error; video at `result.sample` (expires ~2 h); draft cache key [U]. Pricing hd $0.17/s, draft $0.06/s. Video edit `POST /v1/flux-tools/video-edit-v1 {video, prompt}` ≤15 s. Older cookbook's `flux-3-preview-high`/`reference_images` are not in the live OpenAPI.

## 7. LTX, Runway, Wan, Luma
- **LTX** (https://docs.ltx.io/llms.txt): base `https://api.ltx.io`, Bearer; models `ltx-2-5-{fast,pro}`, `ltx-2-3-{fast,pro}`; `POST /v2/{text-to-video|image-to-video|audio-to-video|retake|extend|video-to-video-reframe}` → 202 `{id}`; poll `GET /v2/<endpoint>/{id}` → `result.video_url`. `duration` pro 6/8/10, fast 6–20, `null` = auto; `resolution` WxH (e.g. `1920x1080`); `fps` 24/25/48/50; `generate_audio`, `image_uri`, `last_frame_uri`, `camera_motion`. Inputs URL (image ≤15 MB, video ≤32 MB), data URI, or `POST /v1/upload` → `ltx://`. fal: `lightricks/ltx-2.5/{text-to-video,image-to-video,audio-to-video}/{fast,pro}`, `fal-ai/ltx-2.3/{text-to-video,image-to-video,extend-video,retake-video,reframe}`.
- **Runway** (https://docs.dev.runwayml.com/api.md): base `https://api.dev.runwayml.com`, Bearer + `X-Runway-Version: 2024-11-06`; `/v1/image_to_video` (`promptImage` string or `[{uri, position:first|last}]`, `promptText`, `ratio` e.g. `1280:720`, `duration`, `seed`), `/v1/text_to_video`, `/v1/video_to_video` with `aleph2` (`videoUri` 2–30 s, `keyframes`, `targetAspectRatio`); poll `GET /v1/tasks/{id}` → `SUCCEEDED`, `output[]`. Inputs URL (16/32 MB), data URI (5 MB safe), or `/v1/uploads` → `runway://`. Also serves veo3.1, seedance2/2_5, hailuo3, grok_imagine_1_5, wan3.
- **Wan / DashScope** (https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference): `POST {base}/api/v1/services/aigc/video-generation/video-synthesis`, Bearer + `X-DashScope-Async: enable`, base `https://dashscope-intl.aliyuncs.com`; poll `GET /api/v1/tasks/{id}` → `output.task_status`, `output.video_url` (24 h). 2.5/2.6: `input{prompt, img_url, audio_url, negative_prompt}`, `parameters{size|resolution, duration, audio, seed}`. 2.7/wan3.0-video: `input.media[]` (`first_frame`, `last_frame`, `reference_image` ≤10, `reference_video` ≤5, `reference_audio`), `resolution` 480P–1080P, `ratio`, `duration` 2–30. fal: `alibaba/wan-3.0/*`, `wan/v2.6/*`, `fal-ai/wan/v2.7/*`. [U] whether dashscope-intl serves Wan 3.0.
- **Luma**: Agents API `POST https://agents.lumalabs.ai/v1/generations {model:"ray-3.2", type:"video"|"video_edit"|"video_reframe", …}`; fal `luma/agent/ray/v3.2/{text-to-video,image-to-video,video-to-video,reframe}` (reframe: source ≤10 s, prompt required).

## 8. Lip sync and extend

| Lip-sync endpoint | Inputs | Notes |
|---|---|---|
| fal `veed/lipsync/v2` | `video_url`, `audio_url` | $0.07/s; limits [U] |
| fal `fal-ai/sync-lipsync/v2` | + `model` lipsync-2 \| lipsync-2-pro, `sync_mode` cut_off/loop/bounce/silence/remap | |
| fal `fal-ai/sync-lipsync/v2/pro` | same, no `model` | $5/min |
| fal `fal-ai/sync-lipsync/v3` (sync-3) | same | $8/min |
| fal `fal-ai/sync-lipsync/react-1` | + `emotion` | inputs ≤15 s |
| fal `fal-ai/kling-video/lipsync/audio-to-video` | `video_url`, `audio_url` | video 2–10 s |
| fal `veed/fabric-1.0[/fast]` | `image_url` + `audio_url`, 480p/720p | image-driven, not lip sync on a source video |

Sync.so: `POST https://api.sync.so/v2/generate`, `x-api-key`, `{"model":"lipsync-2"|"lipsync-2-pro"|"sync-3","input":[{"type":"video","url"},{"type":"audio","url"}],"options":{"sync_mode":"bounce"}}`; poll `GET /v2/generate/{id}` → `COMPLETED`, `outputUrl` (https://sync.so/docs/api-reference/api/generate-api/create.md).

| Extend | Endpoint | Adds |
|---|---|---|
| Veo | fal `veo3.1/*/extend-video` | +7 s |
| Grok | xAI `/v1/videos/extensions` | +2–10 s |
| FLUX 3 | BFL v2v or fal `flux-3/extend-video` | |
| LTX | `/v2/extend` or `fal-ai/ltx-2.3/extend-video` | |
| Seedance 2.5 | `task:"extension"` | |
| MiniMax | `minimax/h3-max/extend-video` | |
| Wan 2.7 | `first_clip` | |
| Kling | `video-extend` (V1.x only) | |

## Summary: Palmier model → BYOK endpoint

| Palmier model | Recommended endpoint | Confidence | Notes |
|---|---|---|---|
| `veo3.1-fast` | fal `fal-ai/veo3.1/fast/*` (5 endpoints) | confirmed | Gemini preview ids end 2026-10-22 |
| `seedance-2.0` | fal `bytedance/seedance-2.0/*`; alt BytePlus `dreamina-seedance-2-0-260128` | confirmed | BytePlus needs tag rewrite |
| Seedance 2.5 | fal `bytedance/seedance-2.5/*` + `/draft/complete` | confirmed | 1080p on fal [U] |
| Kling V3 | fal `fal-ai/kling-video/v3/pro/{text-to-video,image-to-video}` | confirmed | |
| Kling O3 | fal `fal-ai/kling-video/o3/pro/reference-to-video` (+ v2v edit/reference) | confirmed | official API needs elements pre-created |
| Kling V3 Motion Control | fal `fal-ai/kling-video/v3/pro/motion-control` | confirmed | |
| Kling lip sync | fal `fal-ai/kling-video/lipsync/audio-to-video` | confirmed | video 2–10 s |
| `kling-reframe` | fal `fal-ai/ltx-2.3/reframe`, or `fal-ai/kling-video/o1/video-to-video/reference`, or H3 r2v (what Palmier does now) | partial | no Kling reframe exists |
| Grok Imagine | xAI `grok-imagine-video-1.5`, or fal `xai/grok-imagine-video/v1.5/*` | confirmed | fal has fewer features |
| `minimax-h3` | fal `minimax/h3/*`; alt MiniMax v2 `MiniMax-H3` | confirmed | |
| `hailuo-03` | same as H3 (or `minimax/h3-max/*`) | partial | alias |
| Hailuo 02 / 2.3 | fal `fal-ai/minimax/hailuo-02\|hailuo-2.3/*`, or MiniMax v1 | confirmed | |
| `flux-3` | fal `blackforestlabs/flux-3/*` + `/draft` + `/draft-enhance`; alt BFL `/v1/flux-3-video` | confirmed | exact draft/enhance match |
| LTX | fal `lightricks/ltx-2.5/*` or LTX `/v2/*` | confirmed | LTX-2 removed |
| Runway | official `gen4.5` / `aleph2` | confirmed | no fal equivalent |
| Wan | fal `alibaba/wan-3.0/*` or `wan/v2.6/*`; DashScope | confirmed | |
| Luma | fal `luma/agent/ray/v3.2/*` | confirmed | |
| Lip sync | fal `veed/lipsync/v2` or `fal-ai/sync-lipsync/v2`; Sync.so | confirmed | |

Open items: the Palmier ids for the Grok and lip-sync models were not found in the local source.
