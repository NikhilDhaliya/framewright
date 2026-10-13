# 07 — Media Intelligence, Interchange and Extras

Source of truth: `palmier-pro` v0.7.6, `Sources/PalmierPro` (Swift 6.2, macOS 26). Every `file:line` citation is relative to `Sources/PalmierPro/` unless it starts with `models/`, `scripts/` or `Package.swift`, which are repo-root paths.

This document covers what specs 01–06 do not fully specify (the in-app agent and AI generation are in `06-agent-and-generation.md`):
1. transcription and captions;
2. smart search;
3. audio analysis (VAD/dead air, beats, speakers, denoise, sync DSP, meters);
4. Lottie;
5. multicam analysis;
6. interchange exports (XMEML, FCPXML) and media-producing extras (save as media, frame capture, mattes, chroma sampling);
7. Home samples, onboarding, tour, Help, Feedback.

It ends with a parity checklist covering every user-visible feature.

Conventions, as in 01–05:
- Swift `.rounded()` = round half away from zero (`roundHalfAway`, 03 §0.2).
- Times are seconds (`Double`) unless named `…Frame`.
- **[UNVERIFIED]** marks values not confirmed against the Mac binary or a live source.
- **[NOT IN SOURCE]** marks things that do not exist in v0.7.6.
- Research for model ids, file sizes, hashes and library APIs was done on 2026-10-13 against GitHub, Hugging Face and npm. The whisper.cpp binary and the `deep-filter` CLI were smoke-tested on Linux x64 during research (results quoted inline).
- Re-verified at assembly (2026-10-13): whisper.cpp release `v1.9.5` / prerelease `b5454` and its `whisper-bin-ubuntu-x64.tar.gz` byte count (GitHub API); byte counts and sha256 (HF `x-linked-etag`) of `ggml-large-v3-turbo-q5_0.bin`, `ggml-small.bin`, `ggml-base.bin`; byte counts of `silero_vad.onnx` v5.1.2, the pinned SigLIP 2 ONNX files and the WeSpeaker ONNX; npm `latest` of `onnxruntime-node` (1.30.0), `sherpa-onnx-node` (1.13.8), `lottie-web` (5.13.0), `@lottiefiles/dotlottie-web` (0.81.0), `@huggingface/transformers` (4.3.1), `fflate` (0.8.3). Values that were not re-checked keep their inline marks.
- ~40 `file:line` citations were spot-checked against the v0.7.6 source at assembly; four wrong ranges were corrected.

Linux classes used throughout:
- **(a)** portable as-is;
- **(b)** needs a Linux replacement;
- **(c)** needs Palmier's cloud account;
- **(d)** telemetry/updater/account, drop.

## Contents

0. Linux architecture for ML and media work
1. Transcription and captions
2. Smart search
3. Audio analysis
4. Lottie animations
5. Multicam
6. Interchange exports and media-producing extras
7. Home samples, onboarding, tour, Help, Feedback, What's New, updates
8. Parity checklist
9. Open questions
10. Quirk register (Mac behaviour reproduced on purpose)

---

## 0. Linux architecture for ML and media work

### 0.1 Model and binary inventory

What the Mac uses, and what the Linux port uses instead. "Bundled" = shipped inside the app (`resources/…`, listed in `asarUnpack`). "Download" = fetched on first use through §0.2 into `$XDG_DATA_HOME/palmier-pro/Models/<subdir>/`.

| Purpose | Mac (v0.7.6) | Linux replacement | File(s) | Bytes | sha256 | License | Delivery |
|---|---|---|---|---|---|---|---|
| Speech-to-text (Local) | Apple `SpeechAnalyzer`/`SpeechTranscriber`; OS-managed locale assets (`Transcription.swift:167-196`) | whisper.cpp **v1.9.5** `whisper-cli` (official `whisper-bin-ubuntu-x64.tar.gz`, release `b5454`; glibc ≥ 2.34) | `whisper-bin-ubuntu-x64.tar.gz` | 10,364,195 | `a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c` | MIT | bundled |
| | | default model `ggml-large-v3-turbo-q5_0.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin` | 574,041,195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` | MIT | download → `Models/whisper/` |
| | | option "small" `ggml-small.bin` | same pattern | 487,601,967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` | MIT | download |
| | | option "base" `ggml-base.bin` | same pattern | 147,951,465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` | MIT | download |
| Speech-to-text (Cloud) | Palmier Convex `transcriptions:*` (25 credits/h) | BYOK: ElevenLabs Scribe v2 (default), Deepgram nova-3, OpenAI whisper-1 (§1.6) | — | — | — | provider ToS | network |
| Voice activity | speech-swift 0.0.21 `SileroVADModel` (HF `aufklarer/Silero-VAD-v5-MLX`, fetched by speech-swift at runtime) | Silero VAD **v5.1.2** ONNX | `https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx` | 2,327,524 | `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` | MIT | bundled |
| Speaker embedding | speech-swift `WeSpeakerModel` (HF `aufklarer/WeSpeaker-ResNet34-LM-MLX`, 256-d) | WeSpeaker ResNet34-LM ONNX via sherpa-onnx | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx` | 26,530,550 | `e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012` | CC-BY-4.0 (WeSpeaker VoxCeleb weights; attribute) | download → `Models/speaker/` |
| Speaker diarization (labels) | Palmier Cloud transcripts only | pyannote segmentation-3.0 ONNX via sherpa-onnx `OfflineSpeakerDiarization` | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2` (use `model.onnx`) | 6,958,444 | `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488` | MIT | download → `Models/speaker/` |
| Speech enhancement | speech-swift `SpeechEnhancer` = DeepFilterNet3 (HF `aufklarer/DeepFilterNet3-CoreML`) | `deep-filter` CLI **0.5.6** + DeepFilterNet3 ONNX archive | `deep-filter-0.5.6-x86_64-unknown-linux-musl` (GitHub release v0.5.6) | 36,417,296 | `70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da` | MIT/Apache-2.0 | bundled |
| | | | `https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3_onnx.tar.gz` | 7,983,136 | `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616` | MIT/Apache-2.0 | bundled |
| Beat tracking | `Resources/Models/BeatThis.mlmodelc` (Beat This **small0**, mel folded in, FP16, 6.6 MB) | Beat This small0 → ONNX, **self-exported** (§3.4) from `small0.ckpt` (8,451,101 B, `https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/small0.ckpt`) | `BeatThis.onnx` | ≈13 MB fp32 [estimate] | pin at export | MIT | bundled |
| Visual search | SigLIP 2 B/16-256 Core ML, 8-bit palettized, from `huggingface.co/palmier-io/siglip2-base-coreml` (350.3 MB) | SigLIP 2 B/16-256 ONNX int8 from `onnx-community/siglip2-base-patch16-256-ONNX` @ `d1114256522a37ffa257a0a58017348ab0058db2` | vision 94,737,653 + text 283,438,275 + tokenizer.json 34,363,039 | 412,538,967 total | §2.7 table | Apache-2.0 | download → `Models/search/` |
| Lottie | `airbnb/lottie-ios` ≥ 4.6.1, baked to ProRes 4444 | `lottie-web` 5.13.0 (+ `fflate` 0.8.3 for `.lottie`); alternative `@lottiefiles/dotlottie-web` 0.81.0 | npm | — | — | MIT | bundled (npm) |

npm runtime packages added by this spec:
- `onnxruntime-node@1.30.0` (MIT). Install with `ONNXRUNTIME_NODE_INSTALL=skip` to avoid the CUDA download; asarUnpack.
- `sherpa-onnx-node@1.13.8` (Apache-2.0; pulls `sherpa-onnx-linux-x64`, bundles its own ORT 1.28.2; asarUnpack both).
- `@huggingface/transformers@4.3.1` (Apache-2.0), used for the tokenizer only. `@huggingface/tokenizers@0.2.0` is the lighter alternative.
- `lottie-web@5.13.0` and `fflate@0.8.3` (MIT).

Rejected options:
- **faster-whisper** needs Python + CTranslate2.
- Maintained Node whisper addons lose per-token data (`@fugood/whisper.node` exposes only segment t0/t1), or ship no Linux prebuilds (`whisper-cpp-node`), or build at install time (`nodejs-whisper`).
- **sherpa-onnx Whisper**: its published ONNX exports have no attention outputs, so no token timestamps **[UNVERIFIED]**.
- **sherpa's `silero_vad.onnx`**: a re-export with different IO.
- **gtcrn** (16 kHz) as the denoiser: DeepFilterNet3 is the Mac's actual model.
- **Existing Beat This ONNX exports** (`aaatmy/beat-this-onnx`, `musetric/beat-this-onnx`): they are `final0`, not the Mac's `small0`.

### 0.2 Model download manager (Linux; generalizes the Mac `ModelDownloader`)

Mac behaviour (`Search/Models/ModelDownloader.swift`), to mirror for every downloadable model:
- Idempotent `install()`: if installed, return.
- Stage in `tmp/palmier-model-<UUID>/`. Download each file with progress weighted by bytes (`progress = (doneBytes + fraction·fileBytes)/totalBytes`). Verify sha256 (1 MiB chunks). Unzip. Move into the final directory (remove any old one first). Write `spec.json`.
- Errors:
  - `httpError(status, file)`: non-2xx;
  - `checksumMismatch(file)`;
  - `unzipFailed`;
  - `missingPackage(file)` (zip without exactly one top-level entry).
- No resume, no retry; the UI offers "Retry".

Linux module `src/main/ml/models.ts`:

```ts
type ModelId = 'whisper-large-v3-turbo-q5_0' | 'whisper-small' | 'whisper-base' | 'speaker-wespeaker-r34lm'
             | 'speaker-pyannote-seg30' | 'search-siglip2-b16-256-int8';
type ModelState = { kind: 'unknown' } | { kind: 'notInstalled' } | { kind: 'downloading'; fraction: number }
                | { kind: 'preparing' } | { kind: 'ready' } | { kind: 'failed'; message: string };
interface ModelManifest { id: ModelId; dir: string /* Models/<dir> */; files: { url: string; path: string; bytes: number; sha256: string;
                          extract?: 'tar.bz2' | 'tar.gz' }[]; spec?: object }
models.state(id): ModelState                // observable; mirrored to renderers via IPC 'models:state'
models.ensure(id, { userInitiated }): Promise<string /* install dir */>   // download if missing, dedupe concurrent callers
models.remove(id): Promise<void>
```

- Download with Node `fetch` (Electron `net.fetch` to honour system proxies) streaming to `<dir>.partial-<uuid>/`. Hash while writing. Extract `.tar.bz2` with the system `tar -xjf` (always present on Linux), or `unbzip2-stream` + `tar-stream`. Then `rename()` atomically into place.
- When a model is needed:
  - Smart search: only on explicit user action or agent `search_media` (Mac parity, §2.1).
  - Whisper and speaker models: **on first use**. For whisper, the Captions tab overlay label becomes `Downloading speech model NN%`, then `Transcribing…` (a Linux addition; the Mac shows only "Transcribing…" while the OS installs its asset).
  - The download error maps to `TranscriptionError.modelInstallFailed(reason)`.
- Bundled resources (VAD, Beat This, deep-filter, whisper binary) are never downloaded. They are resolved with `process.resourcesPath` in production and `<repo>/resources` in dev, a single shared lookup helper (the Mac repo's `AGENTS.md` "Resources and configuration" rule: one resolver, verified for both layouts).

### 0.3 Processes and IPC

```
renderer (editor window)        ── React UI, WebGL2 compositor, lottie-web sources, AudioWorklet meter
main process                    ── project/media services, FFmpeg spawns, caches, model manager, ML job scheduler, MCP server
 ├─ utilityProcess "ml"         ── onnxruntime-node: SigLIP (image/text), Silero VAD, Beat This
 ├─ utilityProcess "speech"     ── sherpa-onnx-node: OfflineSpeakerDiarization, SpeakerEmbeddingExtractor
 ├─ child: whisper-cli          ── one at a time ("transcribe" lane)
 ├─ child: deep-filter          ── one at a time ("analysis" lane)
 └─ child: ffmpeg/ffprobe       ── decode/encode; pipeline gates of 2
```

- Scheduler lanes, thread budget and cancellation: §3.9.
- All jobs take a `jobId` and an `AbortSignal`. A cancelled job never writes caches (AGENTS.md cancellation rules).
- On `before-quit`: stop admitting jobs, cancel, wait ≤ 3 s, kill children.

IPC surface (types in `src/shared/api.ts`; the renderer never touches files or models directly):

```ts
interface MediaIntelligenceApi {
  transcribe(req: { mediaRef: string; url: string; isVideo: boolean; range?: [number, number]; provider: 'local' | 'cloud';
                    locale?: string; censorProfanity: boolean }): Promise<TranscriptionResult>;   // §1.3–1.6
  cachedTranscript(url: string, range?: [number, number]): Promise<TranscriptionResult | null>;
  cachedCloudTranscript(url: string, range: [number, number] | null, language: string | null): Promise<TranscriptionResult | null>;
  vad(mediaRef: string, url: string): Promise<{ chunkCount: number; segments: { start: number; end: number }[] }>;   // §3.2
  beats(mediaRef: string, url: string, force: boolean): Promise<BeatAnalysis>;              // §3.4
  cachedBeats(mediaRef: string, url: string): Promise<{ analysis: BeatAnalysis; fileTag: string } | null>;
  speakerTurns(mediaRef: string, url: string): Promise<{ speaker: string; start: number; end: number }[]>;   // local diarization §3.5
  speakerFingerprints(mediaRef: string, url: string, turns: Turn[]): Promise<Record<string, number[]>>;
  denoise(mediaRef: string, url: string): Promise<string /* wet file path */>;            // §3.6
  envelope(url: string, range?: [number, number]): Promise<Float32Array>;                 // §3.1 (2.5 ms hop)
  waveform(url: string, range?: [number, number]): Promise<Float32Array>;                 // §3.1
  indexAsset(asset: AssetSnapshot): AsyncIterable<{ fraction: number }>;                  // §2.4
  searchVisual(query: string, candidates: { id: string; url: string }[], limit: number): Promise<VisualHit[]>;   // §2.5
  models: { state(id: ModelId): ModelState; ensure(id: ModelId): Promise<void>; remove(id: ModelId): Promise<void> };
  cancel(jobId: string): void;
}
```

### 0.4 Cache and model directories

| Mac | Linux | Contents | Cleared by "Clear cache" |
|---|---|---|---|
| `~/Library/Caches/PalmierPro/MediaVisualCache/` | `$XDG_CACHE_HOME/palmier-pro/MediaVisualCache/` | `<key>.waveform2`, `<key>.thumbs.jpg/.json` | yes |
| `…/PalmierPro/ImageVideos/` | — (not needed: images are textures on Linux, 04 §3.2) | — | yes (Mac) |
| `…/PalmierPro/LottieVideos/` | — (not needed, §4.2) | — | **no** (Mac) |
| `…/PalmierPro/AudioAnalysis/` | same name | `<ref>_<size>_<mtime>_vad.json` | yes |
| `…/PalmierPro/BeatAnalysis/` | same name | `<ref>_<tag>_beats.json` | **no** (Mac quirk; keep) |
| `…/PalmierPro/EnhancedAudio/` | same name | `<ref>_<tag>_wet.caf` → Linux `.wav` | yes |
| `…/PalmierPro/SpeakerVoices/` | same name | `<ref>_<tag>_voices.json` (+ Linux `_turns.json`) | yes |
| `~/Library/Caches/io.palmier.pro/Transcripts/` | `$XDG_CACHE_HOME/palmier-pro/Transcripts/` | `<sha32>.json` | yes (+ memory) |
| `~/Library/Caches/io.palmier.pro/Embeddings/` | `$XDG_CACHE_HOME/palmier-pro/Embeddings/` | `<sha32>.embed` | no ("Clear index") |
| `~/Library/Application Support/PalmierPro/Models/` | `$XDG_DATA_HOME/palmier-pro/Models/{search,whisper,speaker}/` | downloadable models | "Remove model" (search only on Linux) |
| `~/Library/Application Support/PalmierPro/Samples/` | `$XDG_DATA_HOME/palmier-pro/Samples/` | materialized samples | no |

The Storage pane's displayed path (05 §11.8) must use the **lower-case** `palmier-pro` directory from 01 §2.2. 05 currently says `$XDG_CACHE_HOME/PalmierPro`; that line should be corrected.

`DiskCache.sizeMtimeTag(url)` = `"<size>_<Int(mtimeSeconds)>"` (truncated toward zero). Missing file → `"0_0"`.

### 0.5 Preferences used by these features (`$XDG_CONFIG_HOME/palmier-pro/settings.json`)

| Key | Default | Mac source |
|---|---|---|
| `markDeadAir`, `markBeats`, `markSpeakers` | true, true, true | `EditorViewModel.swift:255-292` |
| `searchIndexEnabled` | true | `SearchIndexConfig.swift:4-11` |
| `samplesSectionExpanded` | true | `SampleProjectsStrip.swift:6` |
| `hasSeenWelcome` | false | `OnboardingStore.swift:105` |
| `lastSeenVersion` | — | `App/Changelog.swift` |
| `transcription.localModel` *(Linux)* | `"large-v3-turbo-q5_0"` | — |
| `transcription.localAutoDetect` *(Linux)* | false | — |
| `transcription.cloudProvider` *(Linux)* | `"elevenlabs"` when a key exists | — |

Session-only (not persisted, as on the Mac): `silenceRemovalSettings`, `captionPreviewEnabled`, the Captions tab form state, speaker masks/assignments, and the beat/VAD in-memory stores.

---

## 1. Transcription and captions

Sources: `Transcription/*.swift`, `MediaPanel/CaptionsTab/*.swift`, `MediaPanel/IndexTab/*.swift`, `Editor/ViewModel/EditorViewModel+Captions.swift`, `UI/AppTheme.swift:496-502` (caption constants).

### 1.1 Transcript data model (cached JSON, agent tools, captions)

`Transcription/Transcription.swift:17-70`. Plain `Codable` structs. The Mac caches them with `JSONEncoder()` defaults (keys in declaration order, `nil` optionals **omitted**).

```ts
export type TranscriptionProvider = 'local' | 'cloud';           // UI labels "Local" / "Cloud"

export interface TranscriptionWord {      // one token/word run with its own audio range
  text: string;                           // trimmed of whitespace/newlines, never empty
  start?: number;                         // seconds in SOURCE media time (may be absent)
  end?: number;                           // seconds, exclusive
  speaker?: string;                       // file-local diarization label (cloud only on the Mac)
}
export interface TranscriptionSegment {   // one endpointed utterance ("result")
  text: string;                           // trimmed, never empty
  start: number;                          // seconds, source time
  end: number;
  speaker?: string;
}
export interface TranscriptionResult {
  text: string;                           // full text, trimmed
  language?: string;                      // BCP-47 of the locale actually used (local) or provider code (cloud)
  words: TranscriptionWord[];
  segments: TranscriptionSegment[];
}
```

Helpers that must be ported exactly:

```ts
// Transcription.swift:52-69 — shift a result transcribed from an extracted range back to source time.
function offsetting(r: TranscriptionResult, offset: number): TranscriptionResult {
  if (offset === 0) return r;
  return { text: r.text, language: r.language,
    words: r.words.map(w => ({ ...w, start: w.start === undefined ? undefined : w.start + offset,
                                     end:   w.end   === undefined ? undefined : w.end + offset })),
    segments: r.segments.map(s => ({ ...s, start: s.start + offset, end: s.end + offset })) };
}
// TranscriptCache.swift:58-70 — window a full transcript to a source range (closed range [lo, hi]).
function filterToRange(r: TranscriptionResult, lo: number, hi: number): TranscriptionResult {
  const segments = r.segments.filter(s => s.end > lo && s.start < hi);
  const words = r.words.filter(w => w.start !== undefined && w.end !== undefined && w.end > lo && w.start < hi);
  return { text: segments.map(s => s.text).join(' '), language: r.language, words, segments };
}
```

Error type (`Transcription.swift:72-93`), user-facing strings (localized again in `CaptionTab.swift:653-667`):

| Case | String |
|---|---|
| `unsupportedLocale(id)` | `On-device transcription is not available for <id>.` |
| `modelInstallFailed(reason)` | `Could not install the on-device speech model: <reason>` |
| `decodeFailed` | `Could not parse transcription result.` |
| `audioExtractionFailed(reason)` | `Audio extraction failed: <reason>` |
| `analysisFailed(reason)` | `Transcription failed: <reason>` |

Cancellation is never converted into one of these (`failurePreservingCancellation`, `Transcription.swift:98-104`): if the task was cancelled the cancellation propagates instead.

### 1.2 Audio extraction for speech (Mac)

`Transcription.extractAudioTrack` (`Transcription.swift:254-306`):

- Output: temp file `$TMPDIR/palmier-stt-<UUID>.<ext>`, ext `caf` (local) or `wav` (cloud upload).
- Format: **16 kHz, mono, 16-bit signed little-endian PCM, interleaved**, decoded from the file's **first audio track** (`AudioTrackReader.read`, `Audio/AudioTrackReader.swift:36-91`), optionally limited to a source time range (`CMTimeRange` at timescale 600).
- At most **2 extractions run concurrently** (`audioExtractionGate = AsyncSemaphore(2)`).
- No samples → `audioExtractionFailed("No audio samples in <file name>")`. No audio track → `audioExtractionFailed("No audio track in <file name>")`.
- The temp file is always deleted after use.

**Linux:** one shared helper in the main-process media service (it already owns `ffmpeg-static`):

```ts
// decodePcm(url, { rate, channels, format, range? }) → Float32Array[] | path
ffmpeg -nostdin -v error [-ss <lo>] -i <src> [-t <hi-lo>] -map 0:a:0 -vn -ac <ch> -ar <rate> \
       -f s16le|f32le -acodec pcm_s16le|pcm_f32le <out|pipe:1>
```

- Put `-ss` **before** `-i` (fast, sample-accurate for audio with modern FFmpeg).
- Missing audio stream: FFmpeg exits with "Stream map '0:a:0' matches no streams". Map that to the "No audio track in <name>" error. Probe first with `ffprobe` (already in the repo) to avoid string matching.
- Limit concurrency to 2 with a semaphore, exactly like the Mac.
- For whisper write `-f wav -acodec pcm_s16le -ar 16000 -ac 1` to `os.tmpdir()/palmier-stt-<uuid>.wav`.

### 1.3 Transcript cache (`Transcription/TranscriptCache.swift`)

Actor-isolated memory + disk cache, shared by captions, search indexing, agent tools and speaker identification.

- **Directory:** Mac `~/Library/Caches/io.palmier.pro/Transcripts/<key>.json` (`TranscriptCache.swift:7-9`). Linux `$XDG_CACHE_HOME/palmier-pro/Transcripts/<key>.json` (01 §2.2).
- **Key** (`:128-135`): `SHA-256(utf8(identity))`, lowercase hex, **first 32 hex chars**.
  - local variant: `identity = "<absolute path>|<mtime seconds since 1970 as Double>|<size bytes>"`.
  - cloud variant: `identity = "<prefix>|<base>"` where prefix is `cloud|<lang or "auto">|full` with no range, or `cloud|<lang>|<lo %.3f>...<hi %.3f>` with a range (`String(format: "cloud|%@|%.3f...%.3f")`).
  - If `stat` fails the key is `nil` → no caching at all (transcribe every time).
- **Memory:** a dictionary of at most **4** results. On insert when full, the whole dictionary is cleared (`remember`, `:119-122`). Disk reads populate memory.
- **Local lookups** (`transcript(for:isVideo:range:preferredLocale:)`, `:14-36`):
  1. If `preferredLocale` is set: **bypass the cache entirely** (transcribe the range directly, never store). Locale variants must not overwrite the auto entry.
  2. Otherwise the cache holds only **full-file** transcripts. Read cached full → else transcribe the whole file and store. Then, if a range was requested, return `filterToRange(full, range)`.
- **Cloud lookups** store exactly the requested range (no windowing) under the cloud key.
- `hasCachedOnDisk(url)` / `cachedOnDisk(url)` read only the **local full** entry. They are used by search preflight (§2.1) and spoken search (§1.12).
- `clearMemory()` is called after Settings ▸ Storage ▸ Clear cache.

**Linux:** port 1:1 as a main-process (or ML-utility-process) module with the same JSON. Add the speech model id to the local identity (`local|<modelId>|<path>|…`) so switching Whisper models invalidates transcripts. This is a deliberate deviation; the Mac's Apple model is versionless. Write files atomically (temp + rename).

### 1.4 Mac local engine (Apple SpeechAnalyzer) — behaviour to reproduce

`Transcription.transcribe(fileURL:censorProfanity:preferredLocale:sourceRange:)` (`Transcription.swift:139-251`):

1. If `sourceRange` is given, extract that range (§1.2), transcribe the temp file, and `offsetting(by: range.lowerBound)`.
2. **Locale choice** (`:148-156`):
   - Supported locales come from `SpeechTranscriber.supportedLocales`.
   - With `preferredLocale`: `matchLocale([preferred], supported)`.
   - Otherwise `bestSupportedLocale` uses the macOS preferred languages, then `Locale.current`.
   - `matchLocale` strips any `-u-…` extension from the BCP-47 id, matches on language code, prefers the same region, else the first supported locale with that language.
   - No match → `unsupportedLocale(<preferred or current>.bcp47)`.
   - **"Auto" on the Mac's Local mode therefore means "the user's system language", not language detection.** Only Cloud auto-detects (`CaptionTab.swift:364`).
3. `SpeechTranscriber(locale, transcriptionOptions: censorProfanity ? [.etiquetteReplacements] : [], reportingOptions: [], attributeOptions: [.audioTimeRange])`.
4. If the OS speech asset for that locale is missing, it is downloaded (`AssetInventory…downloadAndInstall`). Failure → `modelInstallFailed`. The UI shows only the generic "Transcribing…" overlay during this download.
5. Decode (`decodeResults`, `:310-349`):
   - Every `SpeechTranscriber.Result` becomes one **segment** (text trimmed; skipped if empty; `start/end` = result range).
   - Every attributed **run** of the result text with non-empty trimmed text becomes one **word**, with `start = run.audioTimeRange.start`, `end = start + duration`. The time is absent if the run has no range.
   - `text` = concatenation of all result texts, trimmed. `language` = chosen locale BCP-47 (e.g. `en-US`). `speaker` is always nil locally.

### 1.5 Linux local engine: whisper.cpp

**Choice.** `whisper.cpp`'s `whisper-cli`, spawned as a child process from the ML utility process (see §0.3). Do not use faster-whisper: it needs a Python runtime and CTranslate2 wheels, which is too heavy for an AppImage/deb.

**Binary.** Vendor the official prebuilt **`whisper-bin-ubuntu-x64.tar.gz`** published with whisper.cpp **v1.9.5** (release `b5454`). Details:
- 10,364,195 B, sha256 `a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c`.
- It contains `whisper-cli`, `libwhisper.so.1.9.5`, `libggml*.so`, and CPU-variant backends `libggml-cpu-{x64,sse42,sandybridge,haswell,skylakex,icelake,zen4,…}.so` that load dynamically. `RUNPATH $ORIGIN`.
- Requires **glibc ≥ 2.34** (Ubuntu 22.04+, Debian 12+, Fedora 35+).

Packaging and fallback:
- Copy the whole directory to `resources/bin/whisper/` and list it in `asarUnpack`.
- For older distros, CI builds from the `v1.9.5` tag with `cmake -B build -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_NATIVE=OFF && cmake --build build -j --config Release` on an older glibc image. Use that build as the AppImage payload.
- Optional later: a Vulkan build (`-DGGML_VULKAN=1`) used when `vulkaninfo` succeeds. Not required for parity.

Smoke-tested on this machine with `ggml-tiny.en.bin` + `samples/jfk.wav`: exit 0, JSON as described below.

**Model.** See §0.1 for exact files and sizes. Default: **`ggml-large-v3-turbo-q5_0.bin`** (574,041,195 B). It gives near-large-v3 accuracy with only 4 decoder layers, and runs roughly 3–6× faster than real time on a modern 8-core CPU **[estimate; benchmark]**.
- Setting `transcription.localModel` (Settings ▸ Storage ▸ Speech model, a Linux addition): `large-v3-turbo-q5_0` (default) | `small` | `base`, for slow machines.
- Location: `$XDG_DATA_HOME/palmier-pro/Models/whisper/<file>`.
- Downloaded on first local transcription through the model download manager (§0.2).

**Invocation** (one process per file; at most **one** concurrent whisper process — the "transcribe" lane in §3.9; the Mac runs several SpeechAnalyzer jobs concurrently behind an extraction gate of 2, but each whisper process already saturates the CPU):

```bash
whisper-cli -m <model> -f <palmier-stt-uuid.wav> \
  -l <lang|auto> -t <max(1, min(8, cpus-2))> -bs 5 -bo 5 \
  -ojf -of <tmpbase> -pp -np
```

- `-ojf` (output JSON **full**) writes `<tmpbase>.json` with per-token data. Token timestamps (`offsets` per token) are enabled automatically with `-ojf`.
- `-l` defaults to **`en`** in whisper-cli, so always pass it explicitly (`auto` for detection).
- `-pp` prints `whisper_print_progress_callback: progress = NN%` on stderr. Parse it for UI progress.
- `-np` suppresses the other prints.
- Optional `--dtw <preset> -nfa` (DTW token alignment; presets `tiny … large.v3.turbo`; it **requires `-nfa`** because flash attention disables DTW). In the smoke test, DTW `t_dtw` values differed by +0.3–0.4 s from the timestamp-token offsets. Do **not** enable it until it is validated against a forced-alignment reference. Default off.
- Kill the process (SIGTERM, then SIGKILL after 2 s) on cancellation. Delete `<tmpbase>.json` and the WAV in `finally`.

**JSON → `TranscriptionResult` mapping** (pure TS, unit-tested):

```ts
// json.transcription[i] = { timestamps:{from,to}, offsets:{from,to} /*ms*/, text, tokens:[{text, timestamps, offsets:{from,to}, id, p, t_dtw}] }
function fromWhisper(json, chosenLang: string): TranscriptionResult {
  const segments: TranscriptionSegment[] = []; const words: TranscriptionWord[] = []; let full = '';
  for (const seg of json.transcription) {
    full += seg.text;
    const t = seg.text.trim();
    if (t) segments.push({ text: t, start: seg.offsets.from / 1000, end: seg.offsets.to / 1000 });
    let cur: { text: string; start: number; end: number } | null = null;
    for (const tok of seg.tokens) {
      if (/^\[_.*\]$/.test(tok.text) || tok.text.startsWith('<|')) continue;   // [_BEG_], [_TT_123], specials
      const s = tokStart(tok), e = tokEnd(tok);
      const startsWord = cur === null || /^\s/.test(tok.text);
      if (startsWord) { if (cur && cur.text.trim()) words.push(close(cur)); cur = { text: tok.text, start: s, end: e }; }
      else { cur!.text += tok.text; cur!.end = e; }
    }
    if (cur && cur.text.trim()) words.push(close(cur));
  }
  return { text: full.trim(), language: chosenLang ?? json.result?.language, words, segments };
  function close(c) { return { text: c.text.trim(), start: c.start, end: Math.max(c.end, c.start + 0.01) }; }
}
// tokStart = tok.offsets.from/1000, tokEnd = tok.offsets.to/1000 (tokens without `offsets` — written only when
// both t0,t1 > -1 — inherit the previous token's end). Clamp each word to [seg.start, seg.end].
// Observed (tiny.en, jfk.wav): ' And' {320,400} ' so' {400,520} ' my' {690,940} ' fellow' {940,1750} …,
// first token '[_BEG_]' and last '[_TT_398]' (filtered); result.language "en"; segments 0–7960, 7960–10760 ms.
```

- Punctuation tokens ("," ".") carry no leading space, so they attach to the preceding word, as Apple's runs do.
- CJK output has no spaces. Each token then continues the current word, giving one "word" per segment. For languages in `{zh, ja, th, lo, km, my}`, start a new word at **every** token instead. `CaptionBuilder` matches by alphanumeric count, so timings still distribute correctly (§1.7.4).
- `language`: with an explicit language, use the BCP-47 tag the user chose (Mac parity). With auto, use whisper's detected code (`json.result.language`, e.g. `"en"`).

**Locale menu (Linux).** Supported list = whisper's language table (~99 codes; emit `whisper-cli --help` codes into a TS constant at build time). Sort by display name: `new Intl.DisplayNames([uiLocale], {type: 'language'}).of(code)`. "Auto" behaviour, matching the Mac:
- **Default (parity):** resolve to the first of `app.getPreferredSystemLanguages()` whose language subtag is in whisper's list. If none match, throw `unsupportedLocale(<first system locale>)`.
- Setting `transcription.localAutoDetect` (default **false**): pass `-l auto` instead. See open questions.

**Censor profanity.** Apple's `.etiquetteReplacements` has no whisper equivalent. Linux post-processes words and segment texts:
- Use a bundled per-language profanity list (start with LDNOOBW lists, CC-BY-4.0). Run it only when the language has a list.
- Each matched word becomes its first letter followed by `*` for the remaining letters, keeping trailing punctuation.
- This form is **[UNVERIFIED]** against Apple's exact redaction form. Verify on a Mac and adjust the mask.
- Like the Mac, a censored or locale-forced request **bypasses the cache** (`EditorViewModel+Captions.swift:493-497`).

**Model install errors.**
- Download failure → `modelInstallFailed("<http status or network message>")`.
- Spawn failure or non-zero exit → `analysisFailed("<last stderr line>")`.
- Unparsable JSON → `decodeFailed`.

### 1.6 Cloud mode (Mac) and its Linux replacement

Mac (`Transcription/CloudTranscription.swift`, `TranscriptionBackend.swift`):
1. Check the cloud cache (§1.3) for `(url, range, language)`. `language = preferredLocale.languageCode ?? bcp47` or nil for auto (`CloudTranscription.swift:46-50`).
2. Extract the range to a 16 kHz mono 16-bit **WAV**.
3. Upload via `uploads:generateUploadTicket` (Convex) + HTTP POST → `storageId`.
4. Convex action `transcriptions:submit` `{storageId, durationSeconds (≥0.01), model:"cloud", languageMode:"auto"|"specific", language, projectId}` → `{jobId}`.
5. Subscribe to `transcriptions:byId {id}`. Status `queued|running|succeeded|failed`. On success call `transcriptions:result` → `{resultUrl}` and download `TranscriptionResult` JSON. On failure: `job.errorMessage ?? "Transcription failed"`. A stream end throws "Transcription status stream ended".
6. `offsetting(by: range.lowerBound)` and store in the cloud cache.
- Billing: 25 credits/hour when not cached (`CaptionTab.swift:364`). Only Cloud yields `speaker` labels, which feed speaker identification (§3.5).
- Gating: signed out → "Sign in to use Cloud." Zero credits → "Add credits to use Cloud." Insufficient → `CostEstimator.localizedInsufficientCredits`.

**Linux (class c → b replacement).** Palmier's backend cannot be used. Replace "Cloud" with a **BYOK cloud speech provider** configured in Settings ▸ Models & API Keys (05 §11.5):
- Provider adapter interface: `transcribe(wavPath, {language?}) → TranscriptionResult` (source-relative seconds; the caller applies `offsetting`). Adapters, in recommended order:
  1. **ElevenLabs Scribe** (default; word times + diarization + language detection in one call):
     - `POST https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key`, multipart fields `model_id=scribe_v2`, `file=<wav>`, `diarize=true`, `timestamps_granularity=word`, `tag_audio_events=false`, `language_code` only when not Auto. Limit 5 GB.
     - Map `words[]` with `type == "word"` → `{text, start, end, speaker: speaker_id}`; skip `spacing` and `audio_event`. `language = language_code`.
  2. **Deepgram** `POST https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true&diarize=true`, header `Authorization: Token <key>`, raw WAV body.
     - Map `results.channels[0].alternatives[0].words[]` → `{text: punctuated_word ?? word, start, end, speaker: "speaker_" + speaker}`. `language = results.channels[0].detected_language`.
  3. **OpenAI** `POST https://api.openai.com/v1/audio/transcriptions` `model=whisper-1, response_format=verbose_json, timestamp_granularities[]=word`.
     - Word times but **no speakers**. 25 MB upload limit: chunk longer audio at silences.
     - `segments[]` map 1:1.
  - Segments for adapters 1–2: group consecutive words into a segment; start a new segment when the speaker changes, after a word ending in `.`, `?` or `!`, or at a gap ≥ 1.5 s. Text = the words joined with spaces.
- Cache under the same **cloud** cache variant (§1.3), so Mac semantics such as "Cached — no credits used" carry over (show "Cached" in the tooltip instead of credits).
- When no cloud key is configured:
  - Hide the Cloud radio, or show it disabled with the tooltip "Add a speech-to-text API key in Settings to use Cloud."
  - **Default the provider to Local.** The Mac defaults the picker to Cloud (`CaptionTab.swift:17`, reset `:215`).
- Remove the credit cost estimate, the "· N credits" button suffix and the credit messages.
- Speaker labels: map the provider's speaker ids (e.g. `speaker_0`) verbatim to `TranscriptionWord.speaker` / `TranscriptionSegment.speaker`. Segments: group consecutive words by speaker and by sentence end.

### 1.7 Caption generation pipeline (shared by the Captions tab and `add_captions`)

#### 1.7.1 Request

`EditorViewModel.CaptionRequest` (`EditorViewModel+Captions.swift:5-19`):

```ts
interface CaptionRequest {
  sourceClipIds: string[];      // [] = automatic
  autoDetect: boolean;          // pick the dominant speech track among all targets
  style: TextStyle;             // default TextStyle.caption = TextStyle({fontSize: 48}) (TextStyle.swift:158)
  center: { x: number; y: number };  // normalized canvas centre; default (0.5, 0.9)
  textCase: 'auto' | 'upper' | 'lower';   // auto = TextStyle.FontCase.mixed (agent only)
  censorProfanity: boolean;     // only honoured for Local
  locale?: string;              // undefined = Auto
  maxWords?: number;            // ≥1 or undefined ("None")
  maxCharacters?: number;
  gapSettings: { maximumGapSeconds: number };   // [0, 2], default 0.5 (CaptionGapSettings.swift)
  provider: TranscriptionProvider;              // default 'local' in the struct; Captions tab default 'cloud'
  animation: TextAnimation;     // applied only if preset ≠ none
}
```

#### 1.7.2 Choosing source clips (`captionTargets`, `:117-191`)

- `captionCanTranscribe(clip)`:
  - The clip's `mediaType` must be `video` or `audio`.
  - If the asset is known, it must be `audio`, or `video` with `hasAudio`.
  - An unknown asset counts as transcribable.
- Filtering (for `pool` = all timeline clips when `ids` is empty, otherwise the selected clips):
  - **Multicam clips:** only `audio` clips qualify. With an automatic pool, additionally only the **master member's** media (`clip.mediaRef == group.master.mediaRef`). Explicit selections and track picks may use any mic.
  - A **video** clip in a link group that also has an `audio` clip (in the pool for selections, timeline-wide for track/agent scopes) is skipped, so the A/V pair is transcribed once via its audio side.
  - Result sorted by `startFrame`.
- `captionTargets(trackIds)` uses the clips of the given tracks, link-group audio from the whole timeline, and any multicam mic.
- Tab source logic (`CaptionTab.swift:60-73, 319-353`):
  - **Auto** (no track and no remembered selection) → `autoDetect = true`.
  - **Selected Clips · N** → the remembered selection's targets. Remembered on appear and on selection change, unless the selection is empty while the Media panel is focused, or a marquee is in progress.
  - **`<track label> · N clips`** → `captionTargets(trackIds:[id])`.
  - The menu lists only tracks with ≥ 1 target. "No Tracks" when there are none. The summary is "No audio" when Auto has no targets.

#### 1.7.3 Transcription jobs (`transcribe`, `:475-531`)

- **One job per distinct `mediaRef`.** Range = `sourceUnion(mediaRef, targetClips, fps, padding 1.0)`: `[max(lo/fps − 1, 0), hi/fps + 1]`, where each clip spans source frames `[trimStart, trimStart + duration·max(speed, 1e-4)]` (`CaptionTranscriptMapper.swift:5-15`).
- `isVideo = asset.type == video` (or unknown asset with `clip.mediaType == video`).
- Local:
  - if `censorProfanity || locale` → direct transcription of the range (no cache);
  - else `TranscriptCache.transcript(url, isVideo, range)`, i.e. a **cached full-file** transcript windowed to the range.
- Cloud: `CloudTranscription.transcribe(url, range, locale, projectId)`.
- All jobs run concurrently (task group). Per-file failures are collected. Only if **every** job failed is the first error thrown. Otherwise the failed files are silently skipped.
- **Freshness check** (`:436-438`, `:461-466`): the active timeline id and the timeline value must be unchanged after the awaits. Otherwise throw `CaptionError.timelineChanged` ("The timeline changed while captions were being prepared. Try again."). No targets → `CaptionError.noSource` ("No audio clips to caption.").
- **Dominant speech track** (`:533-540`, autoDetect only):
  - For each target, count the transcript words whose midpoint `(start+end)/2·fps` lies in the clip's visible source span (`spokenWordCount`).
  - Sum per track and keep the track with the most words (> 0).
  - No track with words → no targets → the tab shows "No speech detected."

#### 1.7.4 Words → phrases (`CaptionTranscriptMapper.phrases`, `CaptionBuilder`)

Per target clip:
- `visibleStart = trimStart/fps`, `visibleEnd = (trimStart + duration·speed)/fps` (seconds).
- **If any word has timings** (`phrasesWithWordTimings`, `CaptionTranscriptMapper.swift:66-116`):
  - Iterate the segments (or a single fallback segment spanning all timed words).
  - For each segment, collect the words whose midpoint `m` satisfies `segment.start ≤ m < segment.end` and `visibleStart ≤ m < visibleEnd`. A word belongs to the first segment containing its midpoint; the scan index only moves forward.
  - Untimed words are skipped.
  - Build `phrases(fromTimedWords:)`: segment text = the timed words joined with single spaces, timing from the first/last word.
- **Else** (segment timings only): clip each segment to the visible window and split it.

`CaptionBuilder.phrases(segment, words, fits, maxWords, maxCharacters)` (`CaptionBuilder.swift:20-151`):

```ts
accept(text) = fits(text) && (maxWords == null || wordCount(text) <= max(1,maxWords))
                          && (maxChars == null || [...text].length <= max(1,maxChars))   // Swift Character count = grapheme clusters
split(text): t = text.trim(' ') ; if !t → [] ; if accept(t) → [t]
             parts = breakOnce(t); if parts.length <= 1 → [t]   // a single over-long word is kept
             return parts.flatMap(split)
breakOnce(t) = breakOn(t, ".!?") ?? breakOn(t, ",;:") ?? breakAtMidWord(t)
breakOn(t, set): walk chars; after a delimiter that is followed by ' ' or end-of-text, cut; trim pieces;
                 return pieces if > 1 else null      // keeps "U.S." and "3.14" intact
breakAtMidWord(t): words = t.split(' '); if < 2 → [t]; mid = floor(n/2); [words[0..mid).join(' '), words[mid..).join(' ')]
```

Timing of pieces (`time`, `:104-132`):
- `timed` = the words that have timings and ≥ 1 alphanumeric character (Unicode letter/number), each as `(text, count = alnumCount, start, end)`.
- For each piece in order, consume `timed` runs until `got ≥ alnumCount(piece)`. Phrase `start` = first consumed run start, `end` = last consumed run end. `words` = the consumed runs as `WordSpan` (text trimmed).
- If any piece got no runs (the loop broke) or there are no timed words → `distribute`: share `[segment.start, segment.end]` back-to-back in proportion to `max(len, 1)` of each piece (no word spans).

#### 1.7.5 Line fitting and box size (`CaptionSpecBuilder`)

- `fits(text)` = `TextLayout.naturalSize(text, style, maxWidth: ∞, canvasHeight: H).width ≤ 0.9 · canvasW` (`CaptionSpecBuilder.swift:263-276`; `captionPreviewMaxTextWidthRatio = 0.9`). So with no word or character caps, each caption is one line no wider than 90 % of the canvas. Use the same Canvas2D text-measuring code as the compositor (04 §9.12).
- Text case: `textCase.apply` on each phrase (`.auto` = unchanged).
- Transform (`:278-298`):
  - `natural = naturalSize(text, style, maxWidth: 0.9·W, canvasHeight: H)`;
  - `Transform{ center: (center.x, center.y), width: natural.w/W, height: natural.h/H }` (centre-based constructor; rotation 0).

#### 1.7.6 Phrase → text clip spec (`CaptionBuilder.specs`, `:153-209`)

For each phrase:
- `visibleStartSource = trimStart` (frames), `visibleEndSource = trimStart + duration·max(speed, 1e-4)`.
- Skip the phrase unless `p.end·fps > visibleStartSource && p.start·fps < visibleEndSource`.
- `s = clip.timelineFrame(sourceSeconds: p.start) ?? clip.startFrame`; `e = clip.timelineFrame(p.end) ?? clip.endFrame`.
  - `timelineFrame(t) = round(start + (t·fps − trimStart)/max(speed, 1e-4))`, or nil if `t·fps < trimStart` or the result is outside `[start, end)` (`Models/Timeline.swift:371-378`).
- `duration = max(1, min(clip.endFrame, e) − max(clip.startFrame, s))`.
- Word timings (clip-relative):
  - for each span that overlaps the visible window: `ws/we = clamp(round(start + (sec·fps − trimStart)/speed), clip.start, clip.end)`;
  - `rs = clamp(ws − s, 0, duration)`, `re = clamp(max(rs, we − s), …, duration)`; keep if `re > rs`;
  - `words = undefined` when empty.
- Spec `{trackIndex: 0, startFrame: s, durationFrames, content: p.text, style, transform, captionGroupId: <one new UUID per generation>, words, animation}`.

#### 1.7.7 Gap closing and overlap resolution (`adjustedCaptionTiming`, `CaptionSpecBuilder.swift:124-212`)

```ts
order specs by (startFrame, original index); keep originalDuration per caption
maxGapFrames = maximumGapSeconds > 0 ? floor(maximumGapSeconds * fps) : 0
for i in 1..n-1:  resolveOverlap(prev = c[i-1], next = c[i]):
    if next.start < prev.end:
      if next.start <= prev.start:                  // same quantized start: preserve transcript order
          prev.duration = 1; shiftStartPreservingEnd(next, prev.start + 1)
      else if (prev.end - next.start) == 1 && prev.originalDuration < next.originalDuration:
          shiftStartPreservingEnd(next, prev.end)   // the shorter caption keeps a 1-frame collision
      else prev.duration = next.start - prev.start  // wider overlap: prev ends at next's start
    if maxGapFrames > 0 && 0 < next.start - prev.end <= maxGapFrames:
      prev.duration = next.start - prev.start       // close the gap
if maxGapFrames > 0: last.duration += min(maxGapFrames, max(0, timelineEndFrame - last.end))  // hold the final caption
```

- `shiftStartPreservingEnd(spec, s)`: `offset = max(0, s − spec.start)`; keep the end; `duration = (end − s)` if > 0, else 1; shift word timings left by `offset`.
- `resized` clamps every word to `[0, duration]` and drops empty ones (nil if none remain).
- `timelineEndFrame` = the timeline's `totalFrames` captured at preparation time.

#### 1.7.8 Placement (`placeCaptionTrack`, `:544-560`)

One undoable action named **"Generate Captions"** (subtitle import: **"Add Captions"**; inside a timeline drop: part of "Add Media").
- Insert a new **video** track at index 0.
- `placeTextClips(specs, clearExistingRegions: false)` (`EditorViewModel+MediaLibrary.swift:723-…`): clips get `mediaRef ""`, `mediaType text`, `sourceClipType text`, `start = max(0, s)`, `duration = max(1, d)`, the transform, `textContent`, `textStyle`, `captionGroupId`, `wordTimings`, `textAnimation`.
- If no clip was placed, restore the previous timeline (no undo entry).
- Otherwise register a timeline swap.
- After success the tab sets `captionPreviewEnabled = false` and calls back with the group id. The media panel then switches to **Index ▸ Transcript** (05 §4.1).

Style edits later apply to the whole group: Inspector ▸ Text and Animate expand the selection with `captionGroupTextClipIds(expanding:)` (`EditorViewModel+Captions.swift:84-115`, `Inspector/Tabs/TextTab.swift:231`).

### 1.8 Subtitle files: import, preview and placement

**Import.**
- Extensions `srt` and `vtt` become a manifest entry of type `subtitle` (01 §5.14). It is never a clip.
- Metadata (`Models/MediaAsset.swift:247-253`): `duration = max(cue.end)`, or 0 if parsing fails.
- Media tile icon `captions.bubble`.

**Parser** (`MediaPanel/CaptionsTab/SubtitleFileParser.swift`; port verbatim, it is pure):

1. Decode UTF-8, else Latin-1. Strip a leading BOM `U+FEFF`. Normalize CRLF/CR → LF. Trim spaces/tabs on every line.
2. Group non-empty lines into blocks of consecutive lines, remembering the 0-based start line.
3. WebVTT: the first line of the first block must be `WEBVTT` exactly, or start with `WEBVTT ` or `WEBVTT\t`. Otherwise error `Not a WebVTT file — the WEBVTT header is missing.` Drop that block. Skip blocks whose first line is a `NOTE`, `STYLE` or `REGION` keyword line.
4. The timing line must be among the first two lines of the block (an SRT index or VTT cue id may precede it), i.e. contain `-->`. Otherwise `Malformed cue timing at line <block.start+1>.`
5. Split on `-->`; exactly 2 sides; each side parsed by the regex `^(?:(\d{1,4}):)?([0-5]?\d):([0-5]?\d)[.,](\d{1,3})(?=\s|$)` after trimming (prefix match, so cue settings after a space are ignored).
   - ms = fraction × [100, 10, 1][digits − 1].
   - `end > start` is required. Else `Malformed cue timing at line <block.start + timingIndex + 1>.`
6. Text lines after the timing line:
   - a line containing `-->` → malformed at that line (`block.start + offset + 1`);
   - otherwise strip `<…>` and `{…}` tags;
   - decode `&lt; &gt; &nbsp;(U+00A0) &lrm; &rlm;`, then `&amp;` **last**;
   - trim; keep non-empty lines; join with `\n`.
   - Cues with empty text are dropped.
7. No cues → `The file contains no captions.` Unsupported extension → `Unsupported subtitle file type “.<ext>”. Use SRT or WebVTT.`
8. Sort the cues by start (a stable sort is fine).

**Placement** (`CaptionSpecBuilder.build(cues:)`, `:90-117`, and `subtitleCaptionSpecs`):
- `startFrame = round(start·fps)`, `endFrame = round(end·fps)`, `duration = max(1, end − start)`.
- Style `TextStyle.caption`, centre `(0.5, 0.9)`, transform per §1.7.5, one new caption group id per file.
- Timing adjustment with `maximumGapSeconds = 0`: overlaps are resolved, gaps are never closed, no hold.
- Entry points:
  - Dragging subtitle assets from the Media panel onto the timeline → `placeCaptions(fromSubtitleAssets:)` (`Timeline/TimelineView.swift:2019-2023`). Each file goes on its **own new top track**, regardless of the drop position. Error toasts: `Can't add captions — "<name>" is offline.` / `Can't add captions from "<name>" — <error>`.
  - Dropping files from the file manager: imported and placed in the single "Add Media" undo group (`EditorViewModel+MediaLibrary.swift:413-441`).
  - Agent `add_captions {subtitleMediaRef}` (02 §3.39).

**Preview.** Selecting a subtitle asset opens a preview tab rendering `SubtitlePreviewView` (`MediaPanel/CaptionsTab/SubtitlePreviewView.swift`):
- a scrolling list on the preview-canvas colour, padding 14, row gap 12;
- each row: `<index>` (tertiary) and `HH:MM:SS,mmm --> HH:MM:SS,mmm` (timecode colour), 10 px medium monospaced, above the cue text (11 px, primary, selectable);
- errors: centred `captions.bubble` (26 px) + the message. A missing URL gives "Subtitle file is unavailable."

**SRT/VTT export:** **[NOT IN SOURCE]** v0.7.6 has no subtitle export. Do not add it to the parity scope. If product wants it later, write `captionGroupTextClipIds(groupId)` clips as SRT `HH:MM:SS,mmm` (frames → ms = round(frame·1000/fps)).

### 1.9 Captions tab UI (`MediaPanel/CaptionsTab/CaptionTab.swift`)

The same view in two modes:
- **captions** (Media panel ▸ Captions tab);
- **transcript-only** (the empty state of Index ▸ Transcript). Only the Source group is shown and the button reads "Transcribe" (`init(onGeneratedTranscript:)`).

Layout: a ScrollView of collapsible `EditorPanelGroup`s, then (captions mode) a footer `EditorActionFooter`. While generating, a surface @ 0.80 overlay with `GeneratingOverlay(label: "Transcribing…", size: .preview)` covers everything.

| Group (expanded default) | Row | Control | Values / help (verbatim) |
|---|---|---|---|
| **Source** (expanded) | header accessory | "Preview" label (10 px medium secondary) + mini switch bound to `captionPreviewEnabled` | captions mode only |
| | Source | menu (`EditorMenuValue`) | help "Uses selected clips when available, otherwise all captionable audio. Choose a track to limit captions."; reset → Auto |
| | Mode | two radio buttons "Local" / "Cloud" (12 px radio, 11 px label, semibold when selected) | help "Local runs with Apple's SpeechAnalyzer. Cloud uses credits and a more accurate model with more capabilities." Cloud tooltip: "Cloud auto-detects languages, produces more accurate transcripts, can identify speakers, and uses 25 credits/hr when a transcript is not cached." Local tooltip: "Local runs with Apple's SpeechAnalyzer." **Linux strings:** "Local runs on this computer with Whisper." / Cloud: "Cloud uses your speech-to-text provider. It auto-detects languages and can identify speakers." Reset → Cloud on the Mac; **Linux reset → Local** |
| **Settings** (expanded) | Language | menu: "Auto", divider, supported locales sorted by localized name | reset → Auto. The locale list loads once (`.task`) |
| | Max words | `ScrubbableNumberField` 0…50, integer drag, shows "None" below 1 | help "Cap the words shown per caption. None fits each line to the box." |
| | Max characters | 0…200, "None" below 1 | help "Cap characters per caption, including spaces and punctuation. A single word may exceed the limit." |
| | Close gaps | 0…2 s shown ×1000 `%.0f` + " ms", drag sensitivity 10, snaps to 0.05 s | help "Extends captions across short gaps and holds the final caption." default 500 ms |
| | Censor profanity | mini switch | **disabled and dimmed to 0.15 when Cloud** |
| **Style** (collapsed) | the shared `TextStyleControls` (font, size, colour, outline, shadow, background … 05 §7.5.4) with defaults `.caption`, groups collapsed by default, plus a **Position** row after Alignment | two `ScrubbableNumberField`s X and Y: value = normalized centre, range −10…10, displayed ×canvas width/height `%.0f`, compact width; values within **0.02** of 0.5 snap to 0.5 (`CaptionPreviewPlacement.snappedCoordinate`) | reset → (0.5, 0.9) |
| **Animation** (collapsed) | `CaptionPresetGallery` (05 §7.5.5) + "Highlight" `ColorField` when a per-word preset is chosen | help "Color for the active word."; default RGBA(1, 0.85, 0, 1) |

**Footer** (`generateBar`):
- note text (left): the last error, or the cloud-unavailable message;
- a prominent capsule button;
- (captions mode) the Agent menu.
- Button label:
  - Mac: `Generate`, or the cost label when Cloud has a known cost > 0;
  - transcript-only: `Transcribe`, `Transcribe · 1 credit` or `Transcribe · N credits`;
  - **Linux:** always `Generate` / `Transcribe`.
- Disabled when there are no effective targets, while generating, or when Cloud is unavailable.

**Generate flow** (`generate`, `:561-622`):
1. Clear the note. If a track was chosen but has no targets → note "No audio selected." and stop.
2. Build the request (censor = Local && toggle; gap settings validated, else default).
3. Cloud: re-check availability and cost (drop on Linux).
4. Captions mode → `generateCaptions`. If no clips were created → note "No speech detected." Otherwise turn the preview off and hand the group id to the media panel.
5. Transcript-only → `timelineTranscript(request)`. Empty → "No speech detected." Otherwise publish the document to Index (§1.11).
6. Errors → localized `TranscriptionError` text or `error.localizedDescription`.

**Agent menu** (`EditorAgentMenu`):
- Help: "Let Agent create captions for you. Choose a predefined task, or ask Agent in the chat."
- Each item opens a **new chat**, puts the draft in the composer and shows the agent panel. It does not auto-send.
- Draft = `"If the timeline has no captions yet, transcribe the spoken audio and add captions on word boundaries first. Then " + task` with:

| Item (icon) | task (verbatim) |
|---|---|
| Remove filler words (`text.badge.minus`) | `remove filler words (um, uh, er, like, you know) from the captions, keeping each caption's timing unchanged.` |
| Fix names & jargon (`checkmark.bubble`) | `fix any misspelled names, brand names, or technical jargon in the captions using the surrounding context, keeping timing unchanged.` |
| Add emoji (`face.smiling`) | `add relevant emoji to the captions, keeping the text and timing otherwise unchanged.` |
| Translate ▸ (`globe`) es, fr, de, it, pt, ja, ko, zh-Hans, hi, ar (names localized via `localizedString(forLanguageCode:)`) | `translate the captions to <Spanish/French/German/Italian/Portuguese/Japanese/Korean/Chinese/Hindi/Arabic>, keeping each caption's timing unchanged.` |

### 1.10 Caption preview overlay (`CaptionPreviewOverlay.swift`, `CaptionPreviewRender.swift`)

Shown over the timeline preview when the Captions tab is visible, the media panel is visible and the Preview switch is on. The switch is `editor.captionPreviewEnabled`: per editor session, default **true** (`EditorViewModel.swift:192`), and set to false after a successful generation. `editor.captionPreviewConfiguration = {text: "Captions will look like this", style, center, preset, highlight}`.

- Synthetic clip:
  - id `caption-preview`, text clip, `duration = loopFrames(preset)` = **28** for entrance presets (popIn, slideUp), else **54**;
  - transform centred at (0.5, 0.5) with `naturalSize(text, style, maxWidth: 0.9·canvasW, canvasHeight)`;
  - drawn offset by `((center.x − 0.5)·viewW, (center.y − 0.5)·viewH)`.
- Animation: a 30 fps loop `frame = floor(elapsed·30) % loopFrames`, rendered through the **same text renderer + text effects** as the compositor (04 §9). Preset `none` draws frame 0 once.
- Drag target: a clear rect of size `max(30, natural/canvas·view)` per axis at the centre. Grab cursor. Drag → `movedCenter = snapped(start + translation/viewSize)` per axis, live, committed to the tab's `center`. Snap: `|v − 0.5| < 0.02` → 0.5.
- Centre guides: 0.5 px lines (timecode colour @ 0.80) when x or y equals exactly 0.5.
- Tag top-left: `captions.bubble` + "Preview" (10 px medium), 24 px tall, surface @ 0.80, 0.5 px primary border, radius 6, inset 6.
- While shown, it takes precedence over the transform overlay and disables click-to-select (05 §5.3).

**Linux:** a React overlay. Render the sample caption to an `OffscreenCanvas` with the shared text rasterizer at `devicePixelRatio`. Throttle to the 30 fps loop with `requestAnimationFrame`.

### 1.11 Index ▸ Transcript (`MediaPanel/IndexTab/*`)

**Document model** (`EditorViewModel+Captions.swift:21-36`):

```ts
interface TimelineTranscriptRow { id: string; clipId: string; text: string; startFrame: number; endFrame: number }
interface TimelineTranscriptDocument { fps: number; rows: TimelineTranscriptRow[]; sourceTrackId?: string; sourceCaptionGroupId?: string }
```

- **Generated transcript** (`makeTimelineTranscriptDocument`, `:359-397`): for each target, phrases with **no** fit/word/char limits (one row per transcript sentence piece) → `CaptionBuilder.specs` → rows `{id: "<clipId>:<index>:<startFrame>", clipId: source clip, text, start, end}`, sorted by `(startFrame, id)`.
- **Cached transcript auto-load** (`cachedTimelineTranscript`, `:310-357`; runs on every `timelineRenderRevision` change while the Index tab is shown, and only fills an empty slot):
  - targets = auto targets;
  - try provider **cloud first, then local**. A provider is used only if **every** target mediaRef has a cached transcript (cloud: exact `sourceUnion` range key, language nil; local: full-file cache windowed);
  - then dominant speech track → document.
- **Caption fallbacks** (`TranscriptBrowserNavigation.captionFallbacks`):
  - one document per caption group per track, visible tracks first, then hidden tracks;
  - rows = that group's text clips on that track, sorted by `(start, id)`, `text = textContent ?? ""`.
- **Source menu** (`TranscriptSourceMenu`, max width 116):
  - "Transcript" ✓ when the shown document has no caption group;
  - divider; one item per caption document labelled `Caption <track display label>` (e.g. "Caption V1");
  - the menu is shown only when caption documents exist;
  - selection: `automatic` (transcript ?? first caption doc), `transcript`, `captions(groupId)`.
- **Empty state:** the mode tabs + optional source menu + expandable search, a hairline, then the transcript-only Captions tab (§1.9). A generated transcript is stored and the source switches to `transcript`.
- **Browser:**
  - a header with mode tabs, spacer, source menu, expandable search, and the "Jump to Playhead" button (`timeline.selection` icon, 22×22; disabled/muted when no row is current);
  - rows filtered with `localizedCaseInsensitiveContains(query)`. "No matches for “q”" when none.
- **Row:**
  - start timecode `formatTimecode(start, fps)` (tertiary, 68 px column) and duration `%.1fs` (muted, 28 px), 10 px medium monospaced digits;
  - the text (12 px), **timecode colour while the playhead is inside `[start, end)`**, else primary;
  - padding 6; hover highlight radius 3, active when the row's clip is selected.
- **Click a row:**
  - select the timeline preview tab;
  - clear the gap/range/marker selection;
  - select the clip plus its linked partners;
  - seek to `startFrame`.
- **Current row lookup** (`TranscriptBrowserTimelineIndex`): binary search for the last row with `start ≤ frame`. If `frame < its end` it is current. Else fall back to the row with the greatest `end` among the earlier rows (prefix max), if `frame < end`. Jump scrolls it to the centre (200 ms ease-out).

### 1.12 Spoken search (`Transcription/TranscriptSearch.swift`)

```ts
terms(q) = q.split(/\s+/).map(t => trimEdges(t, Unicode punctuation)).filter(Boolean)   // "budget," → "budget"
matches(text, terms) = terms.every(t => text includes t, case- AND diacritic-insensitive)
search(q, assets[{id,url}], limit = 20): for asset in order: tr = cachedOnDisk(url) (LOCAL full transcript only);
   for seg in tr.segments if matches(seg.text) → push {assetID, start: seg.start, end: seg.end, text: seg.text}; stop at limit
```

Linux: case- and diacritic-insensitive matching = compare `s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()`.

The Media tab runs it over **video and audio** assets in library order, limit 20 (`MediaTab+Search.swift:270-291`). `search_media` uses the caller's limit (02 §3.11).

Cloud-cached transcripts are **not** searched. That is a Mac quirk: keep it.

### 1.13 Word cut planner (`Transcription/WordCutPlanner.swift`) — used by `remove_words` (02 §3.34)

```ts
keptGapMs = { tight: 60, balanced: 150, loose: 320 }
cutRanges(words /*{startFrame,endFrame,selected}*/, clipStart, clipEnd, keepGapFrames):
  words = words.filter(w => w.end > w.start); if clipEnd <= clipStart || !words.length → []
  half = max(0, floor(keepGapFrames/2))
  for each maximal run k..l of selected words:
    left  = k>0 ? words[k-1].end : clipStart;  right = l+1<n ? words[l+1].start : clipEnd
    keepBefore = min(max(0, words[k].start - left), half); keepAfter = min(max(0, right - words[l].end), half)
    start = max(clipStart, min(left + keepBefore, words[k].start)); end = min(clipEnd, max(words[l].end, right - keepAfter))
    if end > start push [start, end)
  return mergeRanges(ranges)          // RippleEngine.mergeRanges (03 §3.3)
```

### 1.14 Linux wiring summary for §1

| Mac component | Linux module |
|---|---|
| `Transcription` (SpeechAnalyzer) | `ml/transcribe/whisper.ts` (spawn + parse) in the ML utility process |
| `CloudTranscription` / `TranscriptionBackend` | `ml/transcribe/cloud/<provider>.ts` (BYOK, main process `net.fetch`) |
| `TranscriptCache` | `ml/transcribe/cache.ts` (same keys/semantics + model id) |
| `TranscriptSearch`, `WordCutPlanner`, `CaptionBuilder`, `CaptionTranscriptMapper`, `CaptionSpecBuilder`, `SubtitleFileParser` | `src/core/captions/*.ts`. Pure, shared by the renderer and the MCP server; unit-test with Mac fixtures |
| `CaptionTab`, `CaptionPreviewOverlay`, `IndexTab`, `TranscriptBrowser`, `SubtitlePreviewView` | React components |

---

## 2. Smart search (visual "Moments" + spoken)

Sources: `Search/**`, `MediaPanel/MediaTab/MediaTab+Search.swift`, `MediaPanel/MediaTab/MediaTab+IndexStatus.swift`, `Settings/StoragePane.swift`, `models/siglip2/*` (the conversion scripts in the Mac repo).

### 2.1 What is indexed, and when

| Asset type | Visual index | Transcript |
|---|---|---|
| video | sampled frames (§2.3) | yes, if `hasAudio` (local full-file transcript, §1.3) |
| image | one embedding (§2.4) | — |
| audio | — | yes |
| lottie, subtitle, text, sequence | — | — |

- **Enabled flag:** `UserDefaults searchIndexEnabled` (default **true**, `SearchIndexConfig.swift:4-11`). Toggled in Settings ▸ Storage ▸ "Media indexing".
- **Model state machine** (`VisualModelLoader`, `Search/Models/VisualModelLoader.swift`): `unknown → notInstalled | preparing → ready | failed(msg)`, `downloading(fraction)`.
  - `prepare()` runs at project open and Home warm-up. It never downloads: no files → `notInstalled`; files → `preparing` → load + warm-up encode of the text "warm up" → `ready`, then `sweepAll()`.
  - `download()`: from `notInstalled`/`failed`/`unknown`, the explicit "Smart search" button (or the agent's `search_media`, 02 §3.11).
  - `setEnabled(false)` cancels all indexing and drops the embedder.
  - `remove()` resets every coordinator, sets `notInstalled` and **deletes the whole `Models` directory**.
- **Coordinator** (`Search/SearchIndexCoordinator.swift`, one per open project; a weak registry enables app-wide fan-out):
  - `projectOpened()` → `prepare()` then `sweep()`.
  - `sweep()` (needs enabled + ready) clears `failedIds` and `schedule`s every asset. Also called on model ready.
  - `schedule(asset)` is a no-op if cancelling, disabled, there is no embedder, the asset is generating, or it is already scheduled/failed. It appends `IndexWork{snapshot(id,url,type,duration,hasAudio,isGenerating), spec}`, increments `batchTotal` and starts the single worker. Called on import, frame capture, generation completion and relink.
  - The worker processes the FIFO **serially**:
    1. **preflight** off-main: `needsVisual = (video|image) && embedding file missing or header ≠ (model, version, samplerVersion)`; `needsTranscript = (audio | video&&hasAudio) && !TranscriptCache.hasCachedOnDisk(url)`.
    2. If the asset changed meanwhile (snapshot ≠ current) → requeue the current asset.
    3. **While an export is active, sleep 2 s and re-check** (`ExportQueue.isExportActive`).
    4. `indexOne`: the transcript runs concurrently with the visual pass (the transcript also waits for exports). Progress share = 0.5 visual + 0.5 transcript when both are needed, else 1.0 visual.
    5. Errors → `failedIds` (skip until the next sweep). Cancellation is silent.
  - `batchTotal` / `batchCompleted` reset when the queue drains. `indexingProgress = (completed + clamp(currentAssetFraction)) / total`.
- **Clear index:** `clearIndexGlobally()` = reset all coordinators, delete the `Embeddings` directory, sweep.

### 2.2 Model (Mac): SigLIP 2 B/16-256, Core ML

`SearchIndexConfig.swift:3-45`, `Search/Models/ModelDownloader.swift`, `models/siglip2/convert.py`.

- Manifest:
  - `model "siglip2-base-patch16-256"`, `version 1`, `embeddingDim 768`, `imageSize 256`, `contextLength 64`.
  - Files (zips) from `https://huggingface.co/palmier-io/siglip2-base-coreml/resolve/main/`:

    | Name | sha256 | Bytes |
    |---|---|---|
    | `ImageEncoder.mlpackage.zip` | `426115f2…b2fb` | 91,700,398 |
    | `TextEncoder.mlpackage.zip` | `48f80e35…7368` | 258,593,083 |
    | `tokenizer.zip` | `c37f2a8e…d1ef5` | 5,460,173 |

  - Weights are 8-bit palettized. Both towers output **L2-normalized** 768-d `embedding`. Similarity is a dot product.
- Install:
  - download each zip with progress weighted by bytes;
  - verify sha256;
  - unzip with `ditto`; compile the `.mlpackage`;
  - move into `~/Library/Application Support/PalmierPro/Models/siglip2-base-patch16-256-v1/{ImageEncoder.mlmodelc, TextEncoder.mlmodelc, tokenizer/, spec.json}`.
  - "Installed" = the three paths exist (`tokenizer/tokenizer.json`).
- Text input: Gemma SentencePiece tokenizer (`AutoTokenizer` from `tokenizer.json`).
  - `ids = encode(text)`, truncated to 64, **right-padded with pad id 0 to exactly 64, no attention mask** (`TextTokenizer.swift:12-20`). This must match Python `tokenizer([text], padding="max_length", truncation=True, max_length=64).input_ids` (golden tests generated by `models/siglip2/export_tokenizer.py`).
  - Text is **not** lower-cased.
- Image input (`VisualEmbedder.swift:59-83`):
  - draw the image **squash-resized** (no aspect crop) into a 256×256 sRGB BGRA buffer pre-filled opaque **black** (alpha sources blend over black), high-quality interpolation;
  - the model applies `x/127.5 − 1`.

### 2.3 Frame sampler (`Search/Indexing/FrameSampler.swift`) — `samplerVersion = 1`

```ts
opts = { candidateInterval: 2.0, coverageFloor: 8.0, promoteDiff: 12, maxSize: 512x512, highResEdge: 3000 }
interval = candidateInterval * (max(|natW|,|natH|) >= 3000 ? 2 : 1)
if duration <= 0 → no frames
times = [interval/2, interval/2 + interval, … < duration]  ||  [duration/2] if empty
decode each time with tolerance ±max(interval/2, 1.0) s (nearest sync frame), display-oriented, fit within 512×512
for each decoded frame in order (skip if actualTime <= previous actualTime):
   grid = LumaGrid(image)                           // 8×8 RGBA downsample, luma = .299R+.587G+.114B (0–255)
   isNewShot = first ? true : mean(|grid - lastGrid|) > 12
   lastGrid = grid
   if isNewShot || t - lastKeptTime >= 8.0 → emit {time: t, image, isNewShot}; lastKeptTime = t
```

**Linux:**
- Decode with FFmpeg (a single process per asset, seek per time: `-ss t -i src -frames:v 1 -vf "scale=w=512:h=512:force_original_aspect_ratio=decrease" -f rawvideo -pix_fmt rgb24 pipe:1`).
- Use **keyframe seeking without `-accurate_seek`** (`-noaccurate_seek`) to mimic the ±1 s tolerance. Report the frame's actual PTS (`-copyts` + `showinfo`, or ffprobe `-skip_frame nokey`) as `t`.
- Equivalent and faster: one pass `-skip_frame nokey -vf "select=…"`.
- The 8×8 grid: area-average (box) downscale of the 512 image. CoreGraphics "high" quality is approximately a box/Lanczos filter; parity within the 12-unit threshold is enough.

### 2.4 Indexing one asset and the embedding store

`VisualIndexer.swift`, `EmbeddingStore.swift`:

- Video:
  - for each sampled frame: if `isNewShot` push `shotStarts.append(first ? 0 : t)`; `vectors += encode(image)`; `times.append(t)`; `shotIndex = shotStarts.length − 1`; `progress = min(t/duration, 1)`;
  - before every frame, **wait while an export is active**;
  - row = `{time, shotStart: shotStarts[shot], shotEnd: shotStarts[shot+1] ?? duration}`.
- Image: thumbnail (EXIF-oriented) max 512 px → one row `{0, 0, 0}`. If decoding fails, save an **empty** index (count 0) so it is not retried.
- **File key:** `SHA-256("<path>|<mtime as Double>|<size>")` hex, first 32 chars. File `<Caches>/io.palmier.pro/Embeddings/<key>.embed`. Linux: `$XDG_CACHE_HOME/palmier-pro/Embeddings/<key>.embed`.
- **Binary format** (little-endian; port byte-exactly):

```
offset 0   : ASCII "PALMEMB1" (8 bytes)
offset 8   : uint32 LE  jsonLength
offset 12  : UTF-8 JSON header {"model":"siglip2-base-patch16-256","modelVersion":1,"samplerVersion":1,"dim":768,"count":N}
             (Swift JSONEncoder; key order not significant — parse as JSON)
then N rows, each 24 + dim*2 bytes:
             float64 LE time, float64 LE shotStart, float64 LE shotEnd, dim × float16 LE (IEEE half)
file size must equal 12 + jsonLength + N*(24+2*dim)  (else "corrupt")
```

- "Current" = the header's model, modelVersion and samplerVersion all match. Written atomically.
- On Linux use `model: "siglip2-base-patch16-256"` and `modelVersion: 101` for the ONNX build. A different numeric version makes Mac-vs-Linux origin explicit (caches never cross machines anyway).
- Float16 encode/decode in TS: `Float16Array` / `DataView.getFloat16` (shipped in V8 13.5 / Chrome 135, so present in Electron 44's Chromium and Node runtimes; keep a 10-line fallback helper for vitest on older Node).

### 2.5 Query and ranking

`SearchIndexCoordinator.search` + `Search/Query/VisualSearch.swift`:

1. Requires `ready`. Trim the query; empty → [].
2. Candidates = video + image assets (optionally restricted to ids). For each, compute the key. Use the in-memory `loadedIndexes[assetId]` if its key matches, else load the file (and remember it).
3. `q = encodeText(query)` (normalized 768-d).
4. Per asset: `scores = vectors · q`. Keep the **best row per `shotStart`**: one hit per shot, `{assetID, time, shotStart, shotEnd, score}`.
5. Sort all hits by score descending. Drop `score < 0.05` (`visualMatchCosineFloor`). If the top score ≤ 0 → []. Take the first `limit` (default 20) and then keep only `score ≥ top·0.85` (`relativeCutoff`).

UI (Media tab search, 05 §4.10):
- 250 ms debounce. Spoken (§1.12) and visual run in sequence.
- "Moments" cards show the frame at `hit.time` via a 240 px max thumbnail (±1 s tolerance), with the range `shotStart…max(shotEnd, shotStart+0.1)`.
- Dragging a Moment drags the asset with that source **segment**.
- Clicking selects the asset and seeks the source preview to the range start (`selectMediaPanelItem(atSourceFrame: secondsToFrame(start))`).

### 2.6 Index status control and strings (`MediaTab+IndexStatus.swift`)

| State | Control | Strings |
|---|---|---|
| `notInstalled` && enabled && ≥1 video/image | button `sparkle.magnifyingglass` + "Smart search" | tooltip `Downloads a <size> on-device model so you can search media visually.` where size = `ByteCountFormatter(image+text bytes, .file)` (Mac "350.3 MB"). Linux: use the ONNX byte total and the same decimal (1000-based) formatting |
| `downloading(f)` | progress ring + `Downloading NN%` | tooltip "Downloading the on-device model that powers visual search." |
| `preparing` | mini spinner + "Preparing…" | "Getting the search model ready." |
| `ready` && indexing | ring + `Indexing k/N` (k = min(completed+1, total)) | "Analyzing media so you can search it." |
| `failed` && enabled | `exclamationmark.triangle` + "Retry" | "Visual search model download failed. Check your connection and try again." |

The tour also shows a "Smart search" step only in the `notInstalled` state (§7.3). On Linux the tour copy "nothing leaves your Mac" becomes "nothing leaves your computer".

### 2.7 Linux implementation

**Runtime.** `onnxruntime-node` **1.30.0** (CPU EP) inside an Electron **utility process** ("ml", §0.3), so inference never blocks the main or renderer processes.
- Install with `ONNXRUNTIME_NODE_INSTALL=skip` (otherwise postinstall downloads CUDA EP libraries).
- `asarUnpack: node_modules/onnxruntime-node/**`.
- Tokenizer: `@huggingface/transformers` **4.3.1** `AutoTokenizer.from_pretrained(<local dir>)` with `env.allowRemoteModels = false`, or the lighter `@huggingface/tokenizers` package it depends on. The ONNX sessions are driven directly so pre/post-processing exactly matches §2.2.

**Model.** The same weights as the Mac: `google/siglip2-base-patch16-256` (Apache-2.0). Source: **`onnx-community/siglip2-base-patch16-256-ONNX`**, pinned at commit `d1114256522a37ffa257a0a58017348ab0058db2`. URL `https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/<commit>/<path>`.

| Path | Bytes | sha256 |
|---|---|---|
| `onnx/vision_model_quantized.onnx` | 94,737,653 | `f2eb8ccfa3dc0b3761d9ea9a39554fe0f2be71b247ad7f68a80720ec88895650` |
| `onnx/text_model_quantized.onnx` | 283,438,275 | `6f59b39d880c413042314b79302b74d0dd93b273caf8fbfdb1eb2df61a7fefd4` |
| `tokenizer.json` | 34,363,039 | `cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322` |
| `tokenizer_config.json`, `special_tokens_map.json`, `preprocessor_config.json`, `config.json` | small | pin after the first download |

- The **int8 (dynamic) quantized** pair (378 MB) is the closest to the Mac's 350 MB 8-bit palettized download, which keeps the tooltip size honest.
  - fp16 = 751 MB; fp32 = 1.50 GB.
- IO:
  - vision `pixel_values` float32 [1,3,256,256] → `pooler_output` [1,768] (also `last_hidden_state`);
  - text `input_ids` **int64** [1,64] (no attention_mask input) → `pooler_output` [1,768].
- **L2-normalize both outputs in TS.** The Mac graph normalizes inside the model.
- CI parity gate: cosine(ONNX-int8, PyTorch fp32) ≥ **0.99** on the Mac's fixtures (`models/siglip2/convert.py` fixture images/texts). If int8 fails the gate, fall back to the `_fp16` files.
- If the repo disappears, export ourselves: add `models/siglip2/export_onnx.py`; wrap `ImageTower`/`TextTower` exactly as `convert.py` does; `torch.onnx.export(opset=17)`; host on the project's own HF repo.
- **Pin sha256 + byte counts** in `src/main/ml/manifests.ts`. Install to `$XDG_DATA_HOME/palmier-pro/Models/search/siglip2-base-patch16-256-v101/` with `spec.json` = `{model, version:101, embeddingDim:768, imageSize:256, contextLength:64}`.

**Pre-processing.**
- Image: decode the RGB frame (from FFmpeg, ≤512 px) → composite over black if RGBA → **squash** resize to 256×256 (`sharp().resize(256,256,{fit:'fill'})`, or FFmpeg `scale=256:256:flags=bilinear` in the same decode) → `Float32Array` NCHW with `v/127.5 − 1`. The HF preprocessor uses bilinear; CoreGraphics "high" is closer to Lanczos. Both pass the cosine gate.
- Text (Mac parity, `TextTokenizer.swift`): `ids = tokenizer.encode(text)` **with special tokens**; the post-processor appends `<eos>` (id 1). If longer than 64, keep the first 64 (EOS may be cut, as on the Mac). Right-pad with **0** to exactly 64 → `BigInt64Array`.
  - **Do not lower-case.** The HF card says SigLIP 2 was trained on lower-cased text and `tokenizer_config` has `do_lower_case: true`, but the Mac's swift-transformers path does not lower-case, and its goldens (which include "A CAT") were generated from the same tokenizer.json.
  - Unit test: the Mac's 12 golden strings (`models/siglip2/export_tokenizer.py` → `Tests/PalmierProTests/Search/TextTokenizerGoldens.swift`) must produce identical ids.
  - Lower-casing could improve recall. Treat that as an **open question**, not a parity change.

**Threads.** `sessionOptions.intraOpNumThreads = max(1, cpus/2)`, `executionMode: 'sequential'`, `graphOptimizationLevel: 'all'`. One shared session per tower, serialized by the ML process (one inference at a time, like the Mac's `MLXRuntime` gate).

**Performance budget.** About 30–60 ms per image embed on an 8-core x86 CPU in fp32 **[estimate]**. A 1-hour video at a 2 s cadence yields at most 1,800 candidates, of which typically only 300–600 are kept.

**Storage pane (Linux).** Same rows and strings.
- "Model" shows `siglip2-base-patch16-256 · <size>`.
- **"Remove model" deletes only `Models/search/`.** The Mac deletes the whole Models dir; on Linux that would also wipe Whisper and the audio models.
- Add one extra row per downloaded speech/audio model ("Speech model `<id> · <size>`" with "Remove"). This is a Linux addition, needed because the Mac's speech models live in macOS-managed or bundled storage.

---

## 3. Audio analysis

Sources: `Audio/**`, `Timeline/MediaVisualCache.swift`, `Timeline/ClipRenderer.swift`, `Timeline/TimelineView+BeatsMenu.swift`, `Editor/ViewModel/EditorViewModel+{DeadAir,Speakers,AudioEnhance,Sync}.swift`, `MediaPanel/AudioPanelTab/*`, `Utilities/MLXRuntime.swift`, `models/beat_this/*`, and the Swift package `soniqo/speech-swift` **v0.0.21** (`SpeechVAD`, `SpeechEnhancement`; pinned in `Package.swift`).

Feature flags and preferences:

| Key | Default | Meaning |
|---|---|---|
| `markDeadAir` | **true** | draw the dead-air wash on audio waveforms (`EditorViewModel.swift:255-262`) |
| `markBeats` | **true** | draw beat ticks; beats become snap targets (`:276-283`) |
| `markSpeakers` | **true** | tint waveform bars by speaker (`:285-292`); also auto-runs cached-only identification at project open (`Project/VideoProject.swift:455`) |
| `silenceRemovalSettings` | `{minimumPause 0.5 s, speechPadding 0.15 s}` | **session only, not persisted** (`EditorViewModel.swift:269-273`) |

On the Mac, the VAD, speaker and denoise models exist only in builds with the `BundledSpeech` trait (`Package.swift` traits). Unbundled builds throw `MLXRuntime.Unavailable` ("MLX analysis is unavailable in unbundled builds (missing mlx.metallib)"). The Linux port always ships them, downloading on demand per §0.2.

### 3.1 Shared decoders

| Function | Mac | Output | Linux |
|---|---|---|---|
| `AudioTrackReader.readMonoFloats(url, rate, range?)` | first audio track → Float32 mono at `rate`, non-interleaved | `Float32Array` | `decodePcm(url, {rate, channels:1, format:'f32le', range})` via FFmpeg pipe |
| `AudioEnvelopeExtractor.extract(url, range?)` (`AudioEnvelope.swift`) | 16 kHz mono float; hop **2.5 ms = 40 samples**; per hop `log1p(sqrt(mean(x²))·100)`; trailing partial hop emitted | `{hopSeconds: 0.0025, samples}` | same math in TS over the f32 pipe (stream in chunks; do not buffer the whole file) |
| `WaveformExtractor.peakEnvelope(url, range?)` (`WaveformExtractor.swift`) | native rate mono; `rate = min(200, 240000/span)` peaks/s; per hop `max |x|` → dB, clamp to [−50, 0] → `db/−50` (**0 = loud, 1 = silent**); empty hop → 1 | `Float32Array` cached as `<MediaVisualCache>/<key>.waveform2` | FFmpeg f32 mono at the source rate (`-ac 1`; FFmpeg's downmix averages channels, as AVAssetReader's mono conversion does) |

### 3.2 Voice activity detection (Silero VAD v5)

`Audio/Analysis/VoiceActivity.swift` + speech-swift `SpeechVAD/SileroVAD.swift`, `VADPipeline.swift`, `Configuration.swift`.

**Mac algorithm:**
1. Cache hit → return it. Cache file: `<Caches>/PalmierPro/AudioAnalysis/<mediaRef>_<size>_<Int(mtime)>_vad.json` (`DiskCache.sizeMtimeTag`, `Utilities/DiskCache.swift:34-39`). Writing a new file deletes every other `<mediaRef>_*` file in that directory.
2. Decode mono float **16 kHz**. No audio track → cache and return `{chunkCount: 0, segments: []}`.
3. At most 2 files in the pipeline (decode can overlap with inference). The model is used serially (actor) under the global inference gate.
4. Model: `SileroVADModel.fromPretrained(engine: .mlx)` → HF `aufklarer/Silero-VAD-v5-MLX`.
   - Chunk = **512 samples** (32 ms), with **64 samples of context** from the previous chunk prepended (Silero v5 contract).
   - LSTM state reset per file. The last partial chunk is zero-padded.
   - One speech probability per chunk.
5. Binarize (`VADConfig.sileroDefault`): `onset 0.5`, `offset 0.35`, `minSpeechDuration 0.25 s`, `minSilenceDuration 0.1 s`; frame duration exactly **0.032 s**:

```ts
segments=[]; inSpeech=false; start=0
for i, p in probs: t = i*0.032
   if !inSpeech && p >= 0.5 { inSpeech=true; start=t }
   else if inSpeech && p < 0.35 { inSpeech=false; segments.push([start, t]) }
if inSpeech segments.push([start, probs.length*0.032])
segments = segments.filter(s => s.end - s.start >= 0.25)
merge consecutive segments whose gap (next.start - cur.end) < 0.1
```

6. Result `{chunkCount: ceil(samples/512), segments: [{start, end}]}`, cached as JSON.

`mask` (per 32 ms cell, `VoiceActivity.swift:25-34`): for each segment, mark cells `floor(start/0.032) ..< ceil(end/0.032)` (clamped to `[0, chunkCount)`).

**When it runs:** automatically for every audio asset and every video with audio, whenever its waveform is generated (`MediaVisualCache.generateWaveform` → `SpeechMaskStore.generate`), i.e. on import/open. It runs regardless of `markDeadAir`.
- `SpeechMaskStore` keeps per-session masks, in-flight sets with an epoch counter (stale completions are dropped) and a failed set.
- A non-empty mask triggers a timeline redraw.
- The in-flight count drives the Audio tab text: `Detecting speech…` / `Detecting speech in N files…`.
- Damaged-media detection: AVFoundation error −11829. On Linux, map FFmpeg "Invalid data found when processing input" to "damaged" (log only).

**Linux:** Silero VAD **v5** ONNX through `onnxruntime-node` in the ML process. Pin the upstream file at tag **v5.1.2** (MIT): `https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx`, 2,327,524 B, sha256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`.
- Do **not** take `master`: it is v6.2.x, the same size but different weights. The Mac's speech-swift 0.0.21 loads `aufklarer/Silero-VAD-v5-MLX`; later speech-swift versions moved to v6.2.1.
- Do not use sherpa-onnx's `silero_vad.onnx` either: it is a re-export with different IO.
- Bundle it in `resources/models/` (2.3 MB).
- Inputs: `input` [1, 576] float32 (64 context + 512 samples), `state` [2,1,128], `sr` int64 scalar = 16000.
- Outputs: `output` [1,1] probability, `stateN`.
- Keep the 64-sample context exactly like speech-swift. Then apply **the binarization above, not** `silero-vad`'s Python `get_speech_timestamps` defaults (those differ: speech_pad 30 ms, min_silence 100 ms with different semantics).
- Cache path `$XDG_CACHE_HOME/palmier-pro/AudioAnalysis/<mediaRef>_<size>_<floor(mtimeSec)>_vad.json`, same JSON.
- Parity: probabilities differ slightly between the MLX and ONNX ports. Accept segment boundaries within ±1 cell (32 ms).

### 3.3 Dead air ("Silence Detection")

**Quiet non-speech mask** (`SpeechMaskStore.buildQuietNonSpeechMask`, `Audio/Analysis/SpeechMaskStore.swift:129-157`). Needs the speech mask and the waveform samples (§3.1, 0 = loud … 1 = silent):

```ts
n = speech.length
cellPeak(c) = min over waveform samples [floor(c*S/n), max(s0+1, floor((c+1)*S/n))) (start value 1)   // loudest = smallest
median(v) = sorted(v)[floor(v.length/2)]
speechPeaks = cells where speech → cellPeak
quietFloor = speechPeaks.empty ? 0.56 /* ≈ −28 dBFS */ : min(0.8, max(0.44, median(speechPeaks) + 0.24 /* 12 dB */))
for each maximal run [i, j) of non-speech cells: dead = median(cellPeak over run) >= quietFloor
```

**Removable mask** (`SilenceRemovalPlanner.removableMask`, `SilenceRemovalSettings.swift:30-67`). Cell = 0.032 s:

```ts
cellCount(sec, max) = (c = ceil(sec/0.032)) finite && c < max ? max(0, c) : max
minCells = cellCount(minimumPause, n+1); pad = cellCount(speechPadding, n)
for each maximal run [i, j) of quiet cells with j - i >= minCells:
    start = i + (i > 0 ? pad : 0);  end = j - (j < n ? pad : 0);  mark [start, end)
```

Settings validation: `minimumPause ∈ [0.25, 3.0]`, `speechPadding ∈ [0, 0.5]`. Out of range → ignored.

**Visible ranges for a clip** (`visibleRemovableRanges`, `:71-150`), in **source-frame** coordinates:

```ts
cellFrames = 0.032 * max(1, fps)
visible = [trimStart, trimStart + sourceFramesConsumed)        // source frames
visCells = [visible.lo / cellFrames, visible.hi / cellFrames)   // fractional
edgePad = cellCount(speechPadding, mask.length)
scan cells [clamp(floor(visCells.lo - edgePad)), clamp(ceil(visCells.hi + edgePad)))
for each removable run [i, j):
   expanded.start = (j > visCells.lo && i <= visCells.lo + edgePad) ? visCells.lo : i      // exposed clip edges are removable unpadded
   expanded.end   = (i < visCells.hi && j >= visCells.hi - edgePad) ? visCells.hi : j
   if overlaps(visCells) → push [max(start, lo), min(end, hi)) * cellFrames
```

**Timeline ranges** (`EditorViewModel+DeadAir.swift:280-288`):
- `s0 = max(src.lo, trimStart)`, `s1 = min(src.hi, trimStart + consumed)`;
- `t = start + (s − trimStart)/speed`, rounded;
- keep if length > 0.

**Multicam audio clips** (`DeadAirMaskResolver`, `:3-48`):
- The group mask is computed over the **group clock**: a cell is quiet only if **every usable mic** is quiet there (cells outside a mic's coverage count as quiet for that mic). Mic offsets come from `sync.offsetSeconds/0.032` rounded.
- The member's view of it is shifted by its own offset (drop leading cells, or prepend `false` for a negative shift).
- Then `removableMask`. Results are cached in `DeadAirMaskCache`: FIFO, capacity 256, key = (group, member, mic offsets, settings), reset with the session.

**Drawing** (05 §6.5): a full-height `--pp-status-error` @ 0.35 wash on each 1 px waveform bar column whose source span intersects a dead-air range, drawn only when `markDeadAir`.

**Actions:**
- Audio tab ▸ Silence Detection ▸ **Remove** (`removeAllDeadAir`): one undo **"Remove Dead Air"**.
  - Repeat up to `trackCount` times: take the first audio track that still has dead air; `rippleDeleteRangesOnTrack(track, mergedRanges)` (03 §4.7).
  - On refusal: beep + stop.
  - Disabled when the total range count is 0. The count is shown left of the button.
  - Help "Ripple-deletes every silent section; downstream clips close the gaps."
- Timeline context menu on a dead-air span ▸ **Remove Dead Air** (`removeDeadAir(clipId:atTimelineFrame:)`): ripple-delete that one range; beep on refusal.
- Agent `remove_silence` (02 §3.35) → `removeDeadAir(clipIds:settings:)` with these validation messages:
  - "Selected clips could not be resolved."
  - "Selected clips must include at least one audio clip."
  - "Selected clips must share one track or belong to one linked A/V unit."
  - "Selected audio clips must come from one track."

**UI** (`SpeechTab.swift`, group "Silence Detection", collapsed by default):
- "Mark Silence" switch. Help "Speech is detected on-device in the background. Dims quiet, speech-free spans on timeline waveforms."
- "Minimum Pause" field: ms display, step 0.05 s, range 250–3000 ms. Help "Ignores speech-free pauses shorter than this."
- "Speech Padding" field: step 0.025 s, 0–500 ms. Help "Keeps this much audio before and after detected speech."
- Both are `ScrubbableNumberField` ×1000 `%.0f ms`, drag sensitivity 10.

### 3.4 Beat and downbeat detection (Beat This! `small0`)

`Audio/Beats/BeatDetector.swift`, `BeatStore.swift`, `models/beat_this/{README.md,convert.py}`.

**Model contract** (bundled `Resources/Models/BeatThis.mlmodelc`, 6.6 MB FP16, MIT):
- Checkpoint **`small0`** of CPJKU Beat This! with the **log-mel frontend folded into the graph**.
- Input `audio` = Float [661059] = `(1500−1)·441` samples at **22050 Hz mono**.
- Outputs `beat`, `downbeat` = logits [1, 1500] (50 fps, 20 ms/frame). The sum-head convention: `beat = beat_logit + downbeat_logit`.

**Inference** (`predictLogits`, `:185-213`):

```ts
hop=441, chunkFrames=1500, chunkSamples=661059, border=6, strideFrames=1488
totalFrames = max(1, floor(samples.length/441) + 1); beat = downbeat = Float32Array(totalFrames).fill(-Infinity)
for (chunkStart = -6; chunkStart + 6 < totalFrames; chunkStart += 1488):
   chunk = zeros(661059); copy samples[max(0, chunkStart*441) .. min(len, chunkStart*441 + 661059)) into place
   [b, d] = model(chunk)
   for i in 6 ..< 1494: g = chunkStart + i; if 0 <= g < totalFrames && beat[g] == -Infinity: beat[g]=b[i]; downbeat[g]=d[i]   // keep-first
```

**Post-processing:**

```ts
pickPeaks(logits): for i in 1..n-2: p = sigmoid(logits[i]); if p >= 0.5 && logits[i] >= logits[i-1] && logits[i] > logits[i+1] → time i*441/22050
bpm = beats.length > 2 ? 60 / median(sorted(diff(beats)))[floor(k/2)] : 0     // 0 = indeterminate
analysis = { bpm, beats: pickPeaks(beat), downbeats: pickPeaks(downbeat) }     // seconds in source media
```

- Decoding: the first audio track as 22050 Hz mono Float32. No track → `noAudioTrack(name)`.
- Cache: `<Caches>/PalmierPro/BeatAnalysis/<mediaRef>_<size>_<Int(mtime)>_beats.json` = `{"bpm":…, "beats":[…], "downbeats":[…]}`. Stale siblings are deleted.
- Concurrency: at most 2 detections and 2 cache lookups.

**BeatStore** (session):
- `hydrate(asset)` loads only from the disk cache, on waveform generation. **Detection never runs automatically.**
- `detect(asset, force)` dedupes in-flight work. If the asset URL changes mid-flight it loops. It compares the file tag so a replaced file is re-analysed.
- `invalidate` / `reset` on relink and cache clear.

**Triggers:**
- Timeline clip context menu ▸ **Detect Beats** (or **Redetect Beats** when an analysis exists → `force: true`). This also sets `markBeats = true`. Toasts:
  - "No beats detected." (warning)
  - `Detected <max(beats, downbeats)> beats at <round(bpm)> BPM.` / `Detected N beats.` (success)
  - failure: "Beat detection failed. Check that the media file is reachable, then retry." (warning)
- **Mark Beats** toggle in the same menu (shown when beats exist).
- Agent `detect_beats` (02 §3.36).

**Use:**
- Ticks on audio clips: 05 §6.5 item 19. Coincident beats within 30 ms of a downbeat render as the downbeat. Beats are skipped when < 4 px from the previous tick. Backing rect black @ 0.55.
- Snap targets `beatSnapFrames(clip)` = `clip.timelineFrame(sourceSeconds:)` of every beat and downbeat (deduplicated). Only when `markBeats` and the clip is not a nested carrier (03 §13).

**Linux:**
- Existing community ONNX exports are **`final0`**, not `small0`: `aaatmy/beat-this-onnx` `beat-this-final0.onnx` (82 MB, spectrogram input) and `musetric/beat-this-onnx` (190 MB). Using them would change results versus the Mac, and they are 12–30× larger. **Export `small0` ourselves.**
  - Checkpoint `small0.ckpt`: 8,451,101 B from `https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/small0.ckpt`, the URL `beat_this` uses.
- Export with the **same wrapper** as `convert.py`: `AudioToBeats` = `LogMelSpect` + patched model; fixed input `[661059]`.
  - Add `models/beat_this/export_onnx.py` to the Linux repo: `torch.onnx.export(wrapper, torch.zeros(661059), 'BeatThis.onnx', input_names=['audio'], output_names=['beat','downbeat'], opset_version=17)`. `torch.stft` exports at opset ≥ 17.
  - Same two parity gates against the 120 BPM click fixture: peaks identical to the patched torch model.
  - Ship it **bundled** in `resources/models/BeatThis.onnx` (fp32 ≈ 13 MB, or fp16 ≈ 6.6 MB; fp32 is simpler for the CPU EP).
- If an ONNX STFT export proves troublesome, export the network only (input = log-mel `[1, 1500, 128]`) and implement `LogMelSpect` in TS. Parameters, verified against `beat_this/preprocessing.py`:
  - `torchaudio MelSpectrogram(sample_rate 22050, n_fft 1024, hop_length 441, f_min 30, f_max 11000, n_mels 128, mel_scale 'slaney', norm None, normalized 'frame_length' (magnitude × 1/√1024), power 1, periodic Hann window, center=True, reflect padding)`, then `log1p(1000·x)`.
  - Generate the mel filter matrix with the same Slaney formula (or ship it as a 513×128 Float32 file).
- **Mono downmix:** Beat This averages channels. Decode with `-af "pan=mono|c0=0.5*c0+0.5*c1"` for stereo (n channels: weights 1/n each), not `-ac 1`, which some FFmpeg layouts scale differently. Whether AVAssetReader's mono conversion (Mac) is also a plain average is **[UNVERIFIED]**. Use the same explicit mean downmix for every mono decode in this document (VAD, speaker, envelopes) for consistency.
- Port the chunking, keep-first stitching and peak picking above verbatim. Same JSON cache under `$XDG_CACHE_HOME/palmier-pro/BeatAnalysis/`.

### 3.5 Speaker identification ("Speaker Detection")

`Audio/Analysis/SpeakerIdentity.swift`, `Editor/ViewModel/EditorViewModel+Speakers.swift`, `MediaPanel/AudioPanelTab/SpeechTab.swift`.

**Mac pipeline** (`identifySpeakers(transcribeMissing:)`, `EditorViewModel+Speakers.swift:72-170`):
1. Guard: not already in flight. With `transcribeMissing` (the button), require sign-in, else error "Sign in to use Cloud transcription.". Phase text "Transcribing…" (button) or "Identifying…" (auto).
2. Assets = audio assets + video assets with audio. For each **timeline caption target** (§1.7.2, automatic pool), compute the source range `[max(start/fps − 1, 0), end/fps + 1]` and union it per mediaRef (the same math as captions, so cloud cache keys match).
3. Per asset:
   - cached **cloud** transcript for that range (language nil), else the cloud full-file transcript;
   - else, if `transcribeMissing` and the asset has a range, run Cloud transcription. Errors are logged, and the first error is shown.
   - **Local transcripts are never used** (they carry no speaker labels).
4. **Turns** (`turns(from:)`): walk the words with speaker + timings and merge consecutive same-speaker words whose gap `start − last.end < 1.0 s`.
5. **Speech-confirmed turns** (`speechConfirmed`): keep the turns that overlap some VAD segment by ≥ 0.3 s. Empty VAD → no turns.
6. **Fingerprints** per file, cached at `<Caches>/PalmierPro/SpeakerVoices/<mediaRef>_<size>_<Int(mtime)>_voices.json` as `{ "<localLabel>": [Float × 256] }`. Only non-empty results are cached.
   - For each local speaker: its turns longer than 1.0 s, the **3 longest**.
   - For each such turn, snippet = `[start + 0.25, min(end, start + 6.0) − 0.25]` (skip if < 0.5 s), intersected with the VAD segments (keep pieces ≥ 0.3 s; with no VAD, use the whole snippet).
   - Read 16 kHz mono float for each piece and concatenate.
   - Skip if < **8000 samples** (0.5 s).
   - Embed with **WeSpeaker ResNet34-LM** (`aufklarer/WeSpeaker-ResNet34-LM-MLX`; 80-dim log-mel, n_fft 400, hop 160, Hamming window, pre-emphasis 0.97, HTK mel, fmin 20 Hz; output 256-d L2-normalized).
   - Sum the vectors and L2-normalize.
7. **Assignment** (`assignments`, `:59-93`) — greedy online clustering against the project registry:

```ts
clusters = registry.map(r => ({id: r.id, centroid: r.centroid, refs: new Set(), isNew: false}))
nextId = max(registry ids, 0) + 1
for item of vectors (files in order; within a file labels sorted ascending):
   best = -1; bestSim = 0.45
   for c, cluster in clusters where !cluster.refs.has(item.mediaRef):     // one cluster per speaker per file
       sim = cosine(item.vector, cluster.centroid); if sim >= bestSim { best = c; bestSim = sim }
   if best < 0: clusters.push({id: nextId++, centroid: item.vector, refs: {}, isNew: true}); best = last
   clusters[best].refs.add(item.mediaRef); byFileLocal[item.mediaRef][item.local] = clusters[best].id
newEntries = clusters.filter(isNew).map(({id, centroid}))         // centroids are NOT updated for existing clusters
```

8. **Apply** (`applySpeakerIdentity`):
   - New registry entries `{id, name: "Speaker <id>", color: palette[(id−1) % 8] as sRGB RGBA, centroid}`. Palette = SwiftUI `.blue, .green, .orange, .purple, .pink, .teal, .yellow, .indigo`. Use Apple's dark-mode system colours: blue `#0A84FF`, green `#30D158`, orange `#FF9F0A`, purple `#BF5AF2`, pink `#FF375F`, teal `#40C8E0`, yellow `#FFD60A`, indigo `#5E5CE6` **[the Mac stores whatever `NSColor(Color.x).usingColorSpace(.sRGB)` yields at runtime; these are the documented dark values]**.
   - Speaker masks (session only): cell count = VAD `chunkCount`, else `floor(duration/0.032) + 1`. Each turn paints cells `floor(start/0.032) ..< ceil(end/0.032)` with its global id (−1 = none).
   - `speakerAssignments[mediaRef] = byFileLocal` (session).
   - Checkpoint the project if new entries were added (the registry persists in `ProjectFile.speakers`, 01 §5.13). Push tint colours: alpha 0.80 when `markSpeakers`.
9. **UI** (Audio tab ▸ "Speaker Detection", collapsed):
   - "Mark Speakers" switch. Help "Tints waveforms by speaker. Voices are matched across clips using cloud transcripts."
   - Error text in red.
   - "Labels" grid (2 flexible columns, gap 6). Each label: colour picker (30×20) → `setSpeakerColor`; name text field (96 px, placeholder "Name") → `renameSpeaker` (persisted, no undo); `xmark.circle.fill` → `removeSpeaker`. Remove help: "Removes this label and tint. Identify recreates it if the voice is still present." It also sets mask cells of that id to −1.
   - Button "Identify" (no speakers yet) / "Refresh" (secondary capsule). Help "Matches voices across clips, transcribing untranscribed timeline clips first (uses credits). Transcripts and voice fingerprints are cached, so re-runs are fast."
   - While running: an overlay over the whole Audio tab with `GeneratingOverlay(label: phase)`.
10. The agent's `get_transcript` relabels speakers project-wide with the same assignments (02 §3.33).

**Linux** (class b: the Mac depends on Palmier Cloud for diarization; the Linux port replaces it with local diarization, so the feature works offline):
- **Speaker labels source:**
  1. a BYOK-cloud transcript (§1.6) if one is cached or the cloud provider is configured;
  2. **otherwise local diarization** with **sherpa-onnx-node 1.13.8** `OfflineSpeakerDiarization`:
     - `segmentation.pyannote.model` = `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` (archive 6,958,444 B);
     - `embedding.model` = `wespeaker_en_voxceleb_resnet34_LM.onnx` (26,530,550 B);
     - `clustering: {numClusters: -1, threshold: 0.5}` (tune; lower = more speakers), `minDurationOn 0.3`, `minDurationOff 0.5`;
     - input 16 kHz mono `Float32Array`; `process()` → `[{start, end, speaker}]`.
     - Model URLs, sizes and hashes are in §0.1.
  - Produce local turns `[{speaker: "S<k>", start, end}]` per file. Merge same-speaker gaps < 1.0 s, then speech-confirm exactly as in step 5.
  - Cache local diarization per file at `$XDG_CACHE_HOME/palmier-pro/SpeakerVoices/<mediaRef>_<tag>_turns.json`.
- **Embeddings:** the same WeSpeaker **ResNet34-LM** weights in ONNX (`wespeaker_en_voxceleb_resnet34_LM.onnx`, 256-d), through sherpa-onnx `SpeakerEmbeddingExtractor` (Kaldi fbank 80-dim internally). Its front-end is Povey-window Kaldi fbank, not speech-swift's Hamming variant, so vectors differ slightly from the Mac's.
  - **Centroid compatibility:** projects opened from a Mac keep their registry. The Linux port may match against Mac centroids (same model family; similarity typically still ≥ 0.45 for the same voice) **[UNVERIFIED — measure]**.
  - If `centroid.length !== 256`, ignore that entry for matching but keep it for display.
- Identify / Refresh never "uses credits" on Linux. Help text: "Matches voices across clips, transcribing and detecting speakers on this computer first. Transcripts and voice fingerprints are cached, so re-runs are fast." Mark Speakers help: "Tints waveforms by speaker. Voices are matched across clips."
- The auto-run at project open stays **cache-only**: it uses cached turns/fingerprints and never transcribes or diarizes.

### 3.6 Audio enhance ("Denoise", DeepFilterNet3)

`Audio/AudioEnhancer.swift`, `EditorViewModel+AudioEnhance.swift`. UI: Inspector ▸ Audio ▸ Enhance (05 §7.5.3). Mixing: 04 §10.5. Effect: `audio.denoise` `{amount: [0,1], default 0.6}` (01 §5.8.1).

**Mac:**
- Model: speech-swift `SpeechEnhancer` = **DeepFilterNet3** (`aufklarer/DeepFilterNet3-CoreML`, 48 kHz). `enhanceChunked(audio, 48000)` uses 45 s windows with a 500 ms crossfade and carries STFT/normalization state across chunks.
- Input: up to **2** channels (`min(2, source channels)`) at 48 kHz Float32 non-interleaved. Each channel is enhanced separately.
- Output: **fully wet** CAF Float32 48 kHz, written to a temp `.writing-<UUID>.caf` and atomically moved to `<Caches>/PalmierPro/EnhancedAudio/<mediaRef>_<size>_<Int(mtime)>_wet.caf`. Stale siblings are deleted.
- Scheduling (`enhanceAudioIfNeeded`):
  - When a clip has an enabled denoise with `amount > 0` and the mediaRef is not baked/in-flight/failed: a cached file means baked; otherwise bake in the background.
  - Success → `denoiseBaked` and an engine rebuild (playback continues). Failure → `denoiseFailed`, and the Inspector shows "Denoise failed. Playback uses the original audio — adjust Strength to retry."
  - Re-enabling clears `denoiseFailed` for that ref.
  - `enhancePendingDenoises()` runs on project open and after a cache clear.
  - Export bakes missing files first (04 §11.2).
- The dry/wet blend (`amount`) happens in the mixer, not in the file.

**Linux:** the official **`deep-filter` CLI** from `Rikorose/DeepFilterNet` v0.5.6.
- Binary: `deep-filter-0.5.6-x86_64-unknown-linux-musl`, 36,417,296 bytes, static, Rust + tract, MIT/Apache-2.0.
- Model: explicitly **`DeepFilterNet3_onnx.tar.gz`** (7,983,136 bytes, `https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3_onnx.tar.gz`).
- Bundle the binary in `resources/bin/` (asarUnpack) and the model in `resources/models/`. Both are small, so bundling avoids a first-use download.

- Hashes:
  - binary sha256 `70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da`;
  - model archive sha256 `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616` (contains `tmp/export/{enc,erb_dec,df_dec}.onnx` + `config.ini`).
- DF3 config: `sr 48000, fft_size 960, hop_size 480, nb_erb 32, nb_df 96, df_order 5, df_lookahead 2, conv_lookahead 2`.

```bash
ffmpeg -nostdin -v error -i <src> -map 0:a:0 -vn -ac <min(2,ch)> \
       -af "aresample=48000,apad=pad_len=1440" -c:a pcm_f32le <tmp>/in.wav   # resample first, then +1440 samples (−D trims that much from the head)
deep-filter -m DeepFilterNet3_onnx.tar.gz -D -a 100 -o <tmp>/out <tmp>/in.wav
mv <tmp>/out/in.wav  $XDG_CACHE_HOME/palmier-pro/EnhancedAudio/<mediaRef>_<size>_<mtime>_wet.wav   (atomic rename)
```

Smoke test on this machine (3 s stereo 44.1 kHz f32 WAV):
- exit 0; prints help with `-m, --pf, --pf-beta, -D, -a, --min-db-thresh, --max-db-erb-thresh, --max-db-df-thresh, --reduce-mask, -o`.
- **Output = `pcm_s16le` at the input sample rate, same channel count, and 30 ms shorter with `-D`.** The STFT + lookahead delay is `960 − 480 + 2·480 = 1440` samples at 48 kHz, trimmed from the start. Hence the `apad` above, so wet and dry have equal length and alignment.
- Feeding 48 kHz avoids deep-filter's internal resampling.
- The 16-bit output loses float headroom (wet > 0 dBFS clips). Acceptable: the Mac's wet file is float, but speech enhancement rarely raises peaks. Mixer code reads the WAV as int16 / 32768.

Other differences and rules:
- `deep-filter` processes channels with a shared mask (`--reduce-mask 1` = max, the default). This differs slightly from the Mac's per-channel independent enhancement; acceptable.
- Linux stores **`.wav`** instead of `.caf`. Only the format differs; the cache is not shared.
- Same bake scheduling, states and strings as the Mac. Run at most one bake at a time (inference gate). Cancel on project close (kill the process, delete partial output).
- Parity check: cross-correlate wet vs dry on a 10-minute file; the lag must be ≤ 1 ms.

### 3.7 Audio sync correlator (multicam and "Synchronize")

`Audio/AudioSyncCorrelator.swift` (pure DSP; port verbatim). Inputs are **envelopes** from §3.1 (hop 2.5 ms). Constants:

```ts
minOverlap = 16; pyramidStride = 2; maxExactLagCount = 4096; maxCandidates = 16
consensusChunkHops = 24000 /*60 s*/; consensusChunkCount = 5; consensusToleranceHops = 400 /*1 s*/
reacquireRadiusHops = 800; driftFitMinSpanHops = 60000 /*150 s*/; maxDriftRatio = 0.0005; minDriftRatio = 0.00002
interface Result { lagHops: int; confidence: number; driftRatio = 0; exactLagHops = lagHops }   // lag: target[i] aligns with reference[i + lag]
```

`correlate(ref, tgt, maxLag, centerLag = 0, minOverlapHops = 16)`:
```ts
if !ref.length || !tgt.length || maxLag < 0 → null
shorter = min(len); required = min(max(16, minOverlapHops), max(16, floor(shorter/2))); if shorter < required → null
valid = [required - tgt.length, ref.length - required]
lo = max(valid.lo, centerLag - maxLag); hi = min(valid.hi, centerLag + maxLag); if lo > hi → null
return correlateCandidates(ref, tgt, [lo, hi], required)[0] ?? null
```

`correlateCandidates(ref, tgt, range, minOverlap)`:
```ts
if range.count <= 4096 || ref.length < 32 || tgt.length < 32 → exactCandidates(ref, tgt, [range], minOverlap)
coarseTgt = downsample(tgt, 2)                                   // mean of pairs; trailing single kept
for phase in 0,1:
   cLo = ceil((range.lo - phase)/2); cHi = floor((range.hi - phase)/2); if cLo > cHi continue
   cands = correlateCandidates(downsample(ref, 2, phase), coarseTgt, [cLo, cHi], max(4, ceil(minOverlap/2)))   // recursive pyramid
   mapped += cands.map(c => ({lag: c.lag*2 + phase, confidence: c.confidence}))
coarse = ranked(mapped); if empty → []
ranges = coarse.map(c => [max(range.lo, c.lag - 4), min(range.hi, c.lag + 4)]) → merge overlapping/adjacent
return exactCandidates(ref, tgt, ranges, minOverlap)
```

`exactCandidates` computes the Pearson correlation in **float64** for each lag:
```ts
i in [max(0,-lag), min(tgt.length, ref.length - lag)); n = count; skip if n < minOverlap
x = tgt[i], y = ref[i + lag]; cov = Σxy - ΣxΣy/n; vx = Σx² - (Σx)²/n; vy = Σy² - (Σy)²/n
denom = sqrt(vx*vy); skip if denom <= 0; confidence = max(0, cov/denom)
peaks = results that are local maxima vs immediate neighbours (neighbour = adjacent lag present in the list; ties count as peak)
return ranked(peaks.length ? peaks : results)
ranked(c): sort by confidence desc, then |lag| asc, then lag asc; greedily keep candidates whose lag differs by > 2 from all kept; max 16
```

`seededCorrelate(ref, tgt, seedHops?, seedWindowHops, maxLagHops, minOverlapHops, minConfidence)` → `alignByConsensus` with `windows = [{center: 0, radius: maxLag}] + (seed ? [{center: seed, radius: seedWindow}] : [])`:
```ts
chunk = min(tgt.length, 24000)
starts = tgt.length > chunk ? unique([0..4].map(k => floor((tgt.length - chunk) * k / 4))).sort() : [0]
hits = []
for start of starts:
   c = tgt.slice(start, start + chunk); if min(c) == max(c) continue           // silent chunk
   overlap = min(max(minOverlapHops, floor(c.length/2)), c.length)
   best = hits.length ? correlate(ref, c, 800, hits.at(-1).clipLag + start, overlap) : null
   if best && best.confidence < minConfidence: best = null
   best ??= bestAcrossWindows(c, start, overlap)   // max confidence of correlate(ref, c, w.radius, w.center + start, overlap) over windows
   if !best || best.confidence < minConfidence continue
   hits.push({start, center: start + c.length/2, clipLag: best.lag - start, confidence: best.confidence})
if !hits.length: b = bestAcrossWindows(tgt, 0, minOverlapHops); return b && b.confidence >= minConfidence ? b : null
sorted = hits by clipLag; cluster = the window [i..j] (clipLag[j] - clipLag[i] <= 400) maximizing Σconfidence (first max wins)
confidence = mean(cluster confidences)
if cluster.size >= 3 && (max center - min center) >= 60000:
   least-squares slope of clipLag vs center; if 2e-5 <= |slope| <= 5e-4 && max residual <= 400:
       lagAtHead = meanY - slope*meanX; return {lagHops: round(lagAtHead), confidence, driftRatio: slope, exactLagHops: lagAtHead}
anchor = cluster member with the smallest start; return {lagHops: anchor.clipLag, confidence}
```

- Cancellation is checked inside every loop; a cancelled correlation returns null/[].
- Performance: an exact pass over 4096 lags × up to 24,000-sample chunks ≈ 10⁸ multiply-adds. Run it in a **worker thread** with `Float64Array` and tight loops (≈ 0.1–0.3 s in V8). Optional WASM SIMD later.

How callers use it (`EditorViewModel+Sync.swift`, `+Multicam.swift`, constants in `SyncDefaults`):
- `minConfidence 0.5` (overridable by the agent).
- Date seed window ±3 s → `seedWindowHops = round(3/0.0025) = 1200`.
- `minOverlapHops = max(16, round(3/0.0025) = 1200)`.
- Member search window **240 s**.
- `maxLagHops(window, hop, refCount, tgtCount) = max(1, min(round(window/hop), floor(min(refCount, tgtCount)/2)))` (`Timeline/MulticamEngine.swift:22-25`).
- Clip sync envelopes cover the clip's visible source span `[trim/fps, trim/fps + duration·max(speed, 1e-4)/fps]` (at least one hop).
- Multicam envelopes cover the **first `searchWindow + 300` s** of each file.
- Capture-date seed: `round(((targetDate − anchorDate) + (target.trimStart − anchor.trimStart)/fps) / hop)` (clip sync) or `round((date − anchorDate)/hop)` (multicam).
- **Linux capture date:** `ffprobe -show_entries format_tags=com.apple.quicktime.creationdate:format_tags=creation_time`. Prefer `com.apple.quicktime.creationdate` (recording start) like the Mac. Fall back to nothing: `creation_time` is the finalization time, which the Mac deliberately ignores (`SourceTimecode.swift:100-108`).

### 3.8 Master audio meter (algorithm; visuals in 05 §6.12)

`Audio/AudioMeter.swift`. Per channel (`AudioMeterChannelState`):

```ts
floor=-60, levelDecay=24 dB/s, peakDecay=18 dB/s, peakHold=1.5 s
dB(a) = a > 0 ? max(-60, 20*log10(a)) : -60
display(t): level = max(-60, levelDb - max(0, t - levelTime)*24); peak = max(-60, peakDb - max(0, t - peakHoldUntil)*18)
ingest(peakAmp, t): cur = display(t); inc = dB(peakAmp); levelDb = max(inc, cur.level); levelTime = t
                    if inc >= cur.peak { peakDb = inc; peakHoldUntil = t + 1.5 } else if t > peakHoldUntil { peakDb = cur.peak; peakHoldUntil = t }
                    clipped ||= peakAmp >= 1
```

- Sources: during playback at rates ½×–2× (`allowsAudioMetering`), the peak `max|x|` of **960 frames (20 ms @ 48 kHz)** of the pre-mixed stereo buffer at the playhead (Int16 peaks ÷ 32767). During scrubbing, the peak of each 2,400-frame scrub grain. At 4× and 10× there is no metering.
- **Linux:** an `AudioWorkletNode` on the master bus posts per-render-quantum (128-frame) L/R peaks. The UI thread reduces them to 20 ms windows at the 30 Hz redraw and feeds `ingest`. Keep the decay/hold maths above.

### 3.9 Concurrency and lifecycle (Mac `MLXRuntime`) → Linux ML process

- Mac:
  - one global **inference gate** (`AsyncSemaphore(1)`) serializes VAD, speaker embedding and denoise inference;
  - each model lives in its own actor and loads lazily (a load failure is remembered for VAD);
  - on app termination `beginTermination()` stops new work and `waitUntilIdle()` delays quit until in-flight inference ends (`App/AppDelegate.swift:71`).
- Linux:
  - Models run in Electron **utility processes** coordinated by a single main-process scheduler:
    - **"ml"**: `onnxruntime-node` 1.30 — SigLIP, Silero VAD, Beat This;
    - **"speech"**: `sherpa-onnx-node` 1.13.8 — diarization and speaker embeddings. It bundles its own `libonnxruntime.so` 1.28.2, which must not share a process with onnxruntime-node 1.30;
    - child processes for `whisper-cli` and `deep-filter`.
  - The scheduler mirrors the Mac's gates as **lanes**, each running one job at a time:
    - **analysis** = VAD + speaker embedding/diarization + denoise. This is exactly the Mac's `MLXRuntime` inference gate.
    - **beats**: the Mac's per-model actor, with a decode pipeline of 2.
    - **search**: the Mac's serial per-project worker.
    - **transcribe**: whisper. The Mac runs SpeechAnalyzer jobs concurrently with no inference gate, only an extraction gate of 2. On Linux one whisper process at a time, because each already uses all cores.
  - Lanes may run in parallel. Split threads so their sum ≤ `cpus`: whisper gets `cpus − 2`; the others 1–2 threads while whisper is running.
  - FFmpeg decodes may prefetch 1 ahead (pipeline gate 2).
  - Jobs are cancellable by id: the renderer sends `cancel(jobId)`; the ML process aborts loops and kills child processes.
  - On `before-quit`, send `shutdown`, wait at most 3 s, then kill.
  - CPU affinity: whisper and `deep-filter` get `-t = max(1, cpus − 2)` threads; ONNX intra-op threads `max(1, cpus/2)`.

---

## 4. Lottie animations

Sources: `Preview/LottieVideoGenerator.swift`, `Preview/CompositionBuilder.swift:196-207`, `Preview/VideoEngine.swift:155-167`, `Models/MediaAsset.swift:235-246`, `Models/ClipType.swift:49`, `Editor/ViewModel/EditorViewModel+MediaLibrary.swift:116,243`, `Agent/Tools/ToolExecutor+Media.swift:288-305`. Library: `airbnb/lottie-ios` ≥ 4.6.1 (`Package.swift`).

### 4.1 Mac behaviour

**Recognition** (`isLottie`, `LottieVideoGenerator.swift:27-41`):
- Extensions `json` and `lottie` map to `ClipType.lottie`.
- A `.lottie` file must start with the ZIP magic `50 4B 03 04` (dotLottie archive).
- A `.json` must:
  - have `{` as its first non-whitespace byte (space, tab, LF, CR), within the first **256 KiB**;
  - contain all of the keys `"layers"`, `"v"`, `"w"`, `"h"`, `"op"` as JSON keys (regex `"<key>"\s*:`) within those 256 KiB.
- A rejected import gives the toast: `Can't import "<file>" — not a Lottie animation.`
- Agent import errors: `Unsupported Lottie file: <name>` / `source.bytes is not a valid Lottie animation`.

**Loading** (`loadView`):
- `.lottie` → `DotLottieFile.loadedFrom(filepath:)` (first animation of the archive), otherwise `LottieAnimation.from(data:)`.
- Rendering engine `.mainThread`, `contentMode = .scaleToFill` (the animation is stretched to the target rect), transparent background.

**Metadata** (`metadata(for:)`) — becomes the media asset's fields:
- `size = animation.size` (comp `w × h`) → `sourceWidth/sourceHeight`;
- `framerate = fr` → `sourceFPS`;
- `frameCount = max(1, round(op − ip))`;
- `duration = animation.duration` (= `(op − ip)/fr`) → asset `duration`.
- The library thumbnail = frame `ip`, rendered fit-within 512 px (`inspect`).

**Baking to video for playback/export** (`lottieVideo(for:mediaRef:size:)`):
- Target size = the asset's native comp size (`resolveSourceSize(mediaRef)`, falling back to the render size), clamped so the longest side ≤ **4096**, then each side made **even** (`max(2, floor(v) − floor(v) % 2)`).
- Cache file: `<Caches>/PalmierPro/LottieVideos/<mediaRef>_<W>x<H>.mov`. Existing → reuse. **The key ignores file changes**: a replaced Lottie keeps the old bake until the cache is cleared — a Mac quirk.
- Encode: **ProRes 4444 with alpha**, BGRA input, sRGB attachment, temp `.writing-<UUID>.mov` then move.
- Frame schedule: frames `0 … frameCount−1` at `i / fps` seconds (`fps = max(1, fr)`), each rendering animation frame `ip + i`. Then **one extra sample of frame `frameCount−1` at `max(1800, duration + 1)` s**, so the last frame holds for 30 minutes and a clip can be extended past the animation (freeze-frame).
- Rendering per frame: set `currentFrame`, `forceDisplayUpdate()`, clear to transparent, flip the context to top-left, `layer.render(in:)`.
- Failure: the clip renders as `.unprocessable` if the source exists, else `.offline` (04 §3.2). Log `lottieVideo failed …`.

**Timeline semantics:** a Lottie clip is a visual clip whose "source" is the baked movie. Trims, speed, transforms, crop, effects, blend, opacity, keyframes and fades all apply as for video (04 §3). Source frame at timeline frame `f`: `srcSec = (trimStart + (f − start)·speed)/fps_timeline` (04 §3.1). The displayed animation frame is the movie sample at that time:

```ts
lottieFrameIndex(srcSec) = min(frameCount - 1, max(0, floor(srcSec * animFps + 1e-6)))   // last frame held forever
renderFrame = ip + lottieFrameIndex
```

**Preview tab for a Lottie asset:** bake at the native size, then play the movie in the source preview (`VideoEngine.previewAsset`, seeking to the remembered source playhead).

**Agent `inspect_media` on a Lottie:** samples `count` frames evenly, `index_i = round((frameCount−1)·i/(n−1))`, renders each fit-within 512 px, composites over grey, and reports `framerate`, `frameCount` and `durationSeconds` (02 §3.10).

**FCPXML/XMEML:** Lottie clips are not exported (§6.1, §6.2).

### 4.2 Linux implementation

**Do not bake to ProRes.** Render Lottie frames directly into the compositor as a texture source. This is frame-exact, avoids a 30-minute alpha movie, and the same code serves preview and export.

- **Library:** `lottie-web` (canvas renderer) as the primary renderer, because its Bodymovin feature coverage is closest to lottie-ios.
  - `.lottie` archives are unzipped with `fflate` in the main process: read `manifest.json` → `animations[0].id` → `animations/<id>.json`; inline `images/*` into the JSON `assets[].p` as data URIs (`e: 1`).
  - `@lottiefiles/dotlottie-web` **0.81.0** (ThorVG/WASM, MIT; supports `.lottie` and `.json`; `new DotLottie({canvas | OffscreenCanvas, data, autoplay: false, loop: false})`, `setUseFrameInterpolation(false)`, `setFrame(n)`) is the alternative if lottie-web cannot render in a worker or performs poorly.
    - Call `DotLottie.setWasmUrl(<file:// or app:// URL of the bundled dotlottie-player.wasm>)` before the first instance, or it fetches the WASM from a CDN.
    - Whether `setFrame` is relative to `ip` is **[UNVERIFIED]**.
  - Recognition: port `isLottie` exactly (ZIP magic / 256 KiB key sniff).
- **Renderer process (preview):** one `LottieSource` per Lottie media ref.
  - `lottie.loadAnimation({ renderer: 'canvas', loop: false, autoplay: false, animationData, rendererSettings: { context: offscreenCtx, clearCanvas: true, preserveAspectRatio: 'none' } })` with a canvas of `W×H` = the clamped/even native size (as the Mac). `preserveAspectRatio: 'none'` matches `.scaleToFill`.
  - Library version: **lottie-web 5.13.0** (MIT).
  - For a requested source time: `anim.setSubframe(false)` once, then `anim.goToAndStop(lottieFrameIndex(srcSec), true)`. The frame argument with `isFrame = true` is **relative to `ip`**: lottie-web renders `firstFrame + value`, so do not add `ip`. Then upload the canvas to the WebGL texture of that layer. Cache the last rendered frame index per source and skip re-rendering when unchanged.
  - `anim.totalFrames = floor(op − ip)`; the Mac uses `round(op − ip)`. Use the Mac formula for duration/frameCount and clamp the index to `totalFrames − 1` before calling lottie-web.
  - Deep-clone `animationData` per instance: lottie-web mutates it.
  - lottie-web needs a DOM-like canvas. In a renderer window it uses a regular `HTMLCanvasElement` (or `OffscreenCanvas` via `rendererSettings.context`). Run it on the compositor thread, which is already the renderer's main thread (04 §1).
- **Export path:** the export renderer is the same offscreen WebGL pipeline (04 §11.3), so Lottie sources render identically per frame. No temp video.
- **Metadata on import** (main process, no DOM): parse the JSON (or the archive's first animation) and read `w, h, fr, ip, op` → `sourceWidth = w`, `sourceHeight = h`, `sourceFPS = fr`, `duration = (op − ip)/fr`, `frameCount = max(1, round(op − ip))`.
  - The thumbnail is rendered in the renderer (hidden canvas, frame `ip`, fit-within 512) and sent back to be saved like other thumbnails.
- **Media preview tab:** play the Lottie live with the same `LottieSource`, driven by the source playhead at the timeline fps.
- **Agent `inspect_media`:** the main process asks the renderer to rasterize the sampled frames (IPC `lottie:sampleFrames(mediaRef, count) → PNG[]`), composited over `#808080`.
- **Cache directory `LottieVideos/`:** not needed on Linux. Keep the Storage "Clear cache" list free of it (the Mac's Clear cache does not clear `LottieVideos` or `BeatAnalysis` either, `Settings/StoragePane.swift:117`).
- **Fidelity:** lottie-ios and lottie-web differ on some features (expressions are unsupported in lottie-ios but supported in lottie-web; some text/mattes differ). Parity check: render frames 0, mid and last of 5 sample files on both platforms and compare SSIM ≥ 0.98.

---

## 5. Multicam (what 01/02/03/05 do not already cover)

Already specified elsewhere:
- data model (01 §5.12);
- creation layout, angle switching, layouts, ungroup, edit restrictions (03 §12.1–12.3);
- clip sync placement (03 §12.4);
- `manage_multicam` / `change_cam` / `get_multicam` / `sync_clips` contracts (02 §3.28–3.31);
- the inspector Multicam tab, the timeline angle chip and the context menus (05 §6.5 item 16, §6.14, §7.5.7).

This section adds the **analysis side** and the cross-feature rules.

### 5.1 Entry points

- **Creating a group is agent-only in v0.7.6.** The only caller of `syncMulticamMembers` + `createMulticamGroup` is `ToolExecutor+Multicam.swift:39-50` (undo name "Create Multicam (Agent)", wrapping "Create Multicam"). There is **no** "Create Multicam…" menu or sheet. The agent panel's starter prompt "Sync my multicam" is the user-facing path (05 §2.6).
- The user can, from the timeline UI: Switch Angle / Switch Mic / Layout / Switch Angle in Range / Ungroup Multicam (context menus), and read the Multicam inspector tab.

### 5.2 Member sync (`syncMulticamMembers`, `EditorViewModel+Multicam.swift:124-255`)

Input: `specs [{mediaRef, kind, angleLabel?, pinnedOffsetSeconds?}]`, `masterRef`, `searchWindowSeconds = 240`, `rebase = true`.

```ts
maps = {}; failures = []; pending = []
for spec: if spec.pinnedOffsetSeconds != null → maps[ref] = {offsetSeconds: pinned, confidence: 1, locked: true}
          else if ref == masterRef → maps[ref] = {offsetSeconds: 0, confidence: 1, locked: false}
          else pending.push(spec)
if !pending.length → return rebase(maps)
timing = SourceTimingReader.cache([master] + pending)            // {timecode?, captureDate?} per ref (§6.0)
masterOffset = maps[master].offsetSeconds ?? 0
resolveWithoutAudio(ref, reason): if timing[master].timecode && timing[ref].timecode
      → maps[ref] = {offsetSeconds: masterOffset + tc(ref).seconds - tc(master).seconds, confidence: 1}
      else maps[ref] = {0, 0, false}; failures.push([ref, reason])
span = [0, searchWindow + 300] s; masterEnv = envelope(master, span)
if !masterEnv?.samples.length: failures.push([master, "Master has no readable audio."]);
      pending.forEach(p => resolveWithoutAudio(p, "No audio to sync with and no shared timecode.")); return rebase(maps)
env[ref] = envelope(ref, span) for all pending, concurrently (null/empty → resolveWithoutAudio(ref, "No readable audio to sync with."))
anchors = [{offset: masterOffset, ref: master, samples: masterEnv}]
match(anchor, ref, samples): seed = both captureDates ? round((date(ref) - date(anchor))/0.0025) : null
      maxLag = maxLagHops(240, 0.0025, anchor.len, samples.len)
      r = seededCorrelate(anchor.samples, samples, seed, 1200, maxLag, 1200, 0.5)
      return r && {offset: anchor.offset + r.exactLagHops * 0.0025, confidence: r.confidence}
candidates = pending-with-audio.map(c => ({...c, direct: match(anchors[0], …)}))
sort candidates by direct.confidence desc (missing = 0)
for c of candidates:                                     // weaker members may align better to already-placed members
   best = c.direct; for a of anchors[1..]: h = match(a, c); if h && h.confidence > (best?.confidence ?? 0) best = h
   if !best → resolveWithoutAudio(c.ref, "No confident alignment — pin an offset or re-sync with a wider window.")
   else maps[c.ref] = {offsetSeconds: best.offset, confidence: round(best.confidence*1000)/1000}; anchors.push({best.offset, c.ref, c.samples})
rebase(maps): base = min offset over usable maps (confidence > 0 || locked); subtract base from every usable map
```

- Drift (`driftRatio`) is ignored for multicam members. Only clip "Synchronize" retimes (03 §12.4).
- Members whose sync failed stay in the group with `confidence 0`. They are **unusable**: not angles or mics, shown with a red warning triangle in the inspector, and they produce "<label> isn't synced — pin an offset or recreate the group." when switched to (`resolveMember`).

### 5.3 Cross-feature rules for multicam clips

| Feature | Rule | Source |
|---|---|---|
| Captions (auto source) | only **audio** member clips are captionable, and in the automatic pool only the **master's** mediaRef ("Master — defines the group's clock and transcript.") | `EditorViewModel+Captions.swift:183-186` |
| Speaker identification | uses caption targets → the same master-only rule for the automatic pool | `EditorViewModel+Speakers.swift:85` |
| Dead air | group-wide AND of all usable mics, projected per member (§3.3) | `EditorViewModel+DeadAir.swift:3-48` |
| Save as Media / Save as Audio | "Save as Media" is allowed (video/audio). "Save as Audio" and extract are **refused** for multicam clips (`multicamGroupId != nil`) | `EditorViewModel+SaveAsMedia.swift:65`, `TimelineView.swift:1523-1534` |
| Swap Media, slip, speed, lane change, partial move, sync-lock unlock | refused (03 §3.5, 05 §6.11) | |
| Synchronize (clip sync) | multicam clips are excluded from `syncSelection` | `EditorViewModel+Sync.swift:334` |
| FCPXML / XMEML | member clips export as ordinary clips (no multicam structure) | §6.1–6.2 |
| Timeline drawing | angle chip (05 §6.5 #16); colour `TrackColor.multicam` | `ClipRenderer.swift:200-204` |

### 5.4 Linux notes

- All of §5.2 is pure TS on top of the correlator (§3.7) and envelopes (§3.1). Run it in a worker thread. The 5 × 60 s consensus chunks × several windows per member take a few seconds for long files.
- Envelope decode: one FFmpeg process per member, concurrently (the Mac uses a task group without a limit). Cap at `min(4, cpus)`.

---

## 6. Interchange exports and media-producing extras

04 §11.7–11.9 summarize the exporters. This section gives the **exact documents** so a TS implementation can be golden-tested against Mac output.

Both XML exporters build an element tree and render it with the same rules:
- `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n` (or `<!DOCTYPE fcpxml>`).
- 2-space indentation, one element per line.
- Text-only elements on one line: `<name>text</name>`.
- Childless elements self-close: `<x/>`, or `<x a="1"/>`.
- Attributes in insertion order. No trailing newline after the root.
- Escaping of text and attributes: `&`→`&amp;` first, then `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&apos;`.

### 6.0 Shared helpers

**Source timecode reader** (`Utilities/SourceTimecode.swift`), used by both exporters, clip sync and multicam:

```ts
interface SourceTimecode { frame: number; quanta: number; dropFrame: boolean; tick?: { num: number; den: number } }
seconds(tc)         = rational(tc).num / rational(tc).den
rational(tc)        = tc.quanta <= 0 ? [0,1] : tc.tick?.num>0 && tc.tick.den>0 ? [tc.frame*tc.tick.num, tc.tick.den] : [tc.frame, tc.quanta]
framesAt(tc, fps)   = round(tc.frame / tc.quanta * fps)
read(url) = { timecode: tmcd(url) ?? rtmd(bytes) ?? bwf(bytes), captureDate: quicktime creationdate }
```

1. **tmcd** (QuickTime/MP4 timecode track): `quanta = numberOfFrames`, `dropFrame = flags & 0x1`, `tick = frameDuration/timescale`, `frame` = the big-endian `uint32` of the first sample. **Linux:** parse the boxes in TS (the same box walker as rtmd below):
   - find the `trak` whose `stsd` entry type (body+12) is `tmcd`;
   - `flags` = BE32 at stsd.body+28, `timescale` at +32, `frameDuration` at +36, `numberOfFrames` = byte at +40;
   - first sample offset from `stco`/`co64` → BE32.
   - Fallback: `ffprobe -select_streams d -show_entries stream_tags=timecode` (string `HH:MM:SS:FF`, `;` = drop frame) converted with the DF formula below.
2. **Sony rtmd** (`rtmdTimecode`, `:122-166`):
   - walk `moov → trak → mdia → minf → stbl → stsd`; the entry type at body+12 must be `rtmd`;
   - `timescale` = `mdhd` BE32 at body + (version==1 ? 20 : 12); `delta` = `stts` BE32 at body+12;
   - first sample offset from `stco` (BE32 at +8) or `co64` (BE64 at +8);
   - bytes at sample+13..17 = `hh, mm, ss, dropFlag, ff`;
   - `quanta = round(timescale/delta)`; require `hh<24, mm<60, ss<60, ff<quanta`;
   - `ntsc = delta==1001 && timescale%30000==0`; `dropFrame = drop!=0 || (ntsc && quanta%30==0)`;
   - `frame = (hh*3600+mm*60+ss)*quanta + ff`; if DF: `frame -= round(quanta*0.066666)*(mins - floor(mins/10))` with `mins = hh*60+mm`;
   - `tick = delta/timescale`.
   - Box walker: size32==1 → 64-bit size at +8 (body at +16); size32==0 → to the end of the parent.
3. **BWF** (`bwfTimecode`): `RIFF`/`RF64` + `WAVE`. Walk chunks from offset 12:
   - `fmt ` sample rate = LE32 at +12; `bext` (size ≥ 346) TimeReference = LE64 at chunk body + 338;
   - stop at size `0xFFFFFFFF`; chunks are padded to even sizes;
   - result `{frame: timeReference, quanta: sampleRate, dropFrame: false}` if reference > 0.
4. **Capture date:** QuickTime `com.apple.quicktime.creationdate` (ISO-8601 or `yyyy-MM-dd'T'HH:mm:ssZZZ`). Linux: `ffprobe -show_entries format_tags=com.apple.quicktime.creationdate`.

The Mac maps the whole file (`Data(contentsOf:options:.alwaysMapped)`) for rtmd/BWF. On Linux read only the needed boxes with positional `fs.read` (files can be tens of GB).

**XMEML timecode tags** (`XMLExporter.timecodeTags`, `:77-92`):

```ts
if source && source.quanta > 240:      // BWF sample-based → rescale to the video rate
   fps = ntsc ? base*1000/1001 : base; df = ntsc && base%30==0; frame = round(seconds(source)*fps)
   return {base, ntsc, frame, df, string: fmtTC(frame, base, df)}
base = source?.quanta ?? videoBase; df = source?.dropFrame ?? (ntsc && base%30==0); ntscOut = df ? true : ntsc
return {base, ntsc: ntscOut, frame: source?.frame ?? 0, df, string: fmtTC(frame, base, df)}
fmtTC(frame, fps, df): if fps<=0 → "00:00:00:00"
   if df: drop = round(fps*0.066666); perMin = fps*60 - drop; per10 = perMin*10 + drop
          d = floor(f/per10); m = f%per10; f += drop*9*d + (m > drop ? drop*floor((m-drop)/perMin) : 0)
   sep = df ? ';' : ':'; HH = floor(f/(fps*3600)), MM = floor(f/(fps*60))%60, SS = floor(f/fps)%60, FF = f%fps   // each %02d
rateTags(rawFps) = { timebase: max(1, round(rawFps)), ntsc: |rawFps - tb*1000/1001| < |rawFps - tb| }
```

### 6.1 XMEML v4 ("XML", Premiere Pro / Resolve) — `Export/XMLExporter.swift`

Exact skeleton (values in `{}`; elements appear only under the stated conditions):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>{timeline.name}</name>
    <duration>{timeline.totalFrames}</duration>
    <rate><timebase>{fps}</timebase><ntsc>FALSE</ntsc></rate>
    <timecode>
      <rate>…fps, FALSE…</rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <source>source</source>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format><samplecharacteristics>
          <width>{W}</width><height>{H}</height><anamorphic>FALSE</anamorphic>
          <pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>
          <rate>…fps, FALSE…</rate>
        </samplecharacteristics></format>
        {video <track>… — visual tracks in REVERSE model order (bottom track first)}
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format><samplecharacteristics><samplerate>48000</samplerate><depth>16</depth></samplecharacteristics></format>
        <outputs><group><index>1</index><numchannels>2</numchannels><downmix>0</downmix>
          <channel><index>1</index></channel><channel><index>2</index></channel></group></outputs>
        {audio <track>… — audio tracks in model order}
      </audio>
    </media>
  </sequence>
</xmeml>
```

(Shown compacted. The real output puts every element on its own line, e.g. `<rate>` → `<timebase>` / `<ntsc>` children on separate lines.)

**Track:** `<track><enabled>{video: !hidden, audio: !muted}</enabled><locked>FALSE</locked>` then, for each **emittable** clip sorted by `startFrame`:
1. the fade-in `transitionitem` (if any);
2. the `clipitem`;
3. the fade-out `transitionitem`.

- **Emittable:**
  - nested carriers (`sourceClipType == sequence`) with `trimStartFrame < child.totalFrames` (child resolved);
  - other clips whose media URL resolves.
  - **Text clips are not filtered here**, but they have no resolvable media URL (`mediaRef ""`), so they drop. Lottie clips do resolve: they are exported as files pointing at the `.json` (a Mac quirk; Premiere will show them offline).
- **Addresses for links:** `trackIndex` = 1-based position in the emitted video (reversed) or audio list; `clipIndex` = 1-based index within the sorted emittable clips.

**Media clipitem** (`clipItemNode`, `:243-276`):

```ts
(timebase, ntsc) = rateTags(entry.sourceFPS ?? fps); fileFps = ntsc ? tb*1000/1001 : tb
scale = fileFps/fps; matches = |scale-1| < 1e-4; ff(x) = matches ? x : round(x*scale)
srcDur = entry.duration ? max(0, secondsToFrame(duration, fps)) : clip.sourceDurationFrames     // secondsToFrame = round(sec*fps)
```

```xml
<clipitem id="clipitem-{clip.id}">
  <masterclipid>{linkGroupId ? "masterclip-"+linkGroupId : "masterclip-"+mediaRef+"-video|audio"}</masterclipid>
  <name>{resolver.displayName(mediaRef)}</name>
  <enabled>TRUE</enabled>
  <duration>{ff(srcDur)}</duration>
  <rate>{matches ? (fps, FALSE) : (timebase, ntsc)}</rate>
  <start>{clip.startFrame}</start>
  <end>{clip.endFrame}</end>
  <in>{ff(trimStartFrame)}</in>
  <out>{ff(trimStartFrame + sourceFramesConsumed)}</out>
  {file node}
  {Time Remap filter if speed ≠ 1}
  {audio: Audio Levels filter | video: Basic Motion, Crop, Opacity filters (each only if needed)}
  {<link> per member of the clip's link group (including itself) when the group has > 1 clip and the member is emitted}
</clipitem>
```

**File node** (`fileNode`, `:318-369`). The first occurrence per `(mediaRef, video|audio)` is full; later ones are `<file id="file-{ref}-{video|audio}"/>`.

```xml
<file id="file-{mediaRef}-{video|audio}">
  <name>{url.lastPathComponent ?? entry.name ?? mediaRef}</name>
  <pathurl>{url.absoluteString with "file://" → "file://localhost//"  e.g. file://localhost///home/u/a%20b.mov ; unresolved → "media/{mediaRef}"}</pathurl>
  <rate>{timebase, ntsc}</rate>
  <duration>{image ? 1 : max(0, round(entry.duration * fileFps))}</duration>
  <timecode><rate>{tc.base, tc.ntsc}</rate><string>{tc.string}</string><frame>{tc.frame}</frame><displayformat>{DF|NDF}</displayformat></timecode>
  <media>
    audio: <audio><samplecharacteristics><samplerate>48000</samplerate><depth>16</depth></samplecharacteristics><channelcount>2</channelcount></audio>
    video: <video>{image ? <duration>1</duration>}<samplecharacteristics><width>{srcW ?? seqW}</width><height>{srcH ?? seqH}</height>
             <anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>
             <rate>{timebase, ntsc}</rate></samplecharacteristics></video>
  </media>
</file>
```

Linux `pathurl`: build `file://` + an RFC-3986 percent-encoded absolute path (like Foundation's `URL.absoluteString`: encode spaces and non-ASCII; keep `/`, `-`, `_`, `.`, `~` and the sub-delims Foundation leaves unescaped), then apply the `file://localhost//` replacement. Golden-test against a Mac export containing spaces, `&`, `#`, and Unicode names.

**Nested carrier clipitem** (`nestClipItemNode`):
- `seqId` = `sequence-N`, numbered by first appearance (`sequence-1` is the root).
- The first use embeds the full `<sequence id>` (recursively built with isolated link state and its own canvas width for Basic Motion); later uses emit `<sequence id="…"/>`.
- `in = trimStartFrame`, `out = min(in + durationFrames, child.totalFrames)`.
- Children:
  - `masterclipid` (as above);
  - `<name>{child.name}</name>`, `<enabled>TRUE</enabled>`, `<duration>{child.totalFrames}</duration>`, `<rate>{fps, FALSE}</rate>`;
  - `<start>{start}</start>`, `<end>{start + (out − in)}</end>`, `<in>`, `<out>`;
  - the sequence;
  - filters (no Time Remap);
  - links.

**Fades** (`fadeTransition`) — one single-sided `transitionitem` per edge with `frames = clip.fadeFrames(edge) > 0`:

```xml
<transitionitem>
  <start>{left: start | right: end-frames}</start>
  <end>{left: start+frames | right: end}</end>
  <alignment>{start-black | end-black}</alignment>
  audio: <rate>{fps,FALSE}</rate>
         <effect><name>Cross Fade ( 0dB)</name><effectid>KGAudioTransCrossFade0dB</effectid><effecttype>transition</effecttype><mediatype>audio</mediatype></effect>
  video: <cutPointTicks>{cutFrames * floor(254016000000 / fps)}</cutPointTicks>   (cutFrames = 0 left, frames right)
         <rate>{fps,FALSE}</rate>
         <effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory>
           <effecttype>transition</effecttype><mediatype>video</mediatype>
           <wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse></effect>
</transitionitem>
```

Note the audio effect name has a space: `Cross Fade ( 0dB)`. Note also `254016000000 / fps` is **integer division** before multiplying.

**Effect / parameter grammar** (`effect`, `parameter`, `scalarParam`, `centerParam`):

```xml
<filter><effect><name>{name}</name><effectid>{id}</effectid>[<effectcategory>{cat}</effectcategory>]<effecttype>{type}</effecttype><mediatype>{mt}</mediatype>{params}</effect></filter>
<parameter><parameterid>{id}</parameterid><name>{name}</name>[<valuemin>{min}</valuemin>][<valuemax>{max}</valuemax>]<value>{v}</value>
           {<keyframe><when>{frame - clip.startFrame}</when><value>{v}</value></keyframe>…}</parameter>
center value = <value><horiz>{%.5f}</horiz><vert>{%.5f}</vert></value>
```

| Filter | When | Parameters (format) |
|---|---|---|
| **Time Remap** (`timeremap`, type `motion`, mediatype video/audio) | `speed != 1` (exact) | `variablespeed` (min 0, max 1, value `0`), `speed` (−100000…100000, `%.4f` of speed×100), `reverse` (`FALSE`), `frameblending` (`FALSE`) |
| **Audio Levels** (`audiolevels`, type `audio`) | static `volume != 1`, or volume keyframes | `level` "Level" 0…3.98107, `%.4f`, value `clamp(volume, 0, 3.98)`; keyframes at each volume keyframe frame with `clamp(rawVolumeAt(f))` (fades excluded) |
| **Basic Motion** (`basic`, type `motion`) | static: only the non-default params (`|scale%−100| > 0.1`, `|rot| > 0.05`, `|cx−0.5|` or `|cy−0.5| > 0.001`), in the order scale, rotation, center; keyframed (union of position/scale/rotation keyframe frames): **all three** with keyframes | `scale` "Scale" 0…1000 `%.2f` = `(curSeqWidth/srcW)·width·100` (srcW from the manifest; 0/unknown → `width·100`); `rotation` "Rotation" −100000…100000 `%.2f` = `−rotation`; `center` "Center" (no min/max) = `(cx−0.5, cy−0.5)` |
| **Crop** (`crop`, category `motion`, type `motion`) | crop not identity or crop keyframes | `left`, `right`, `top`, `bottom` (name = id) 0…100 `%.2f` = edge×100 (+ keyframes from `cropAt`) |
| **Opacity** (`opacity`, type `motion`) | `opacity != 1` or opacity keyframes | `opacity` "Opacity" 0…100 `%.1f` = opacity×100 (+ keyframes `rawOpacityAt`) |

Video filter order: Basic Motion, Crop, Opacity. Base values in keyframed parameters = the first keyframe's value. Number formatting: `String(format:)` → C `printf` semantics (round half to even on the binary value); use a `sprintf`-compatible formatter (`toFixed` differs for some halves — acceptable, but prefer a printf port for golden parity).

**Links:** `<link><linkclipref>clipitem-{partnerId}</linkclipref><mediatype>{video|audio}</mediatype><trackindex>{n}</trackindex><clipindex>{n}</clipindex></link>` for **every** clip in the group (including itself) that has an address in the current sequence.

**Not transported:** text, flips, interpolation curves, effects/colour, edge rounding/softness, multicam structure, captions/subtitles.

**Linux:** port as `src/core/interchange/xmeml.ts`, a pure function `(timeline, manifest, resolveTimeline, timecodes) → string`. The UI path writes atomically to the chosen file. Golden-test with the Mac's unit-test fixtures (`Tests/PalmierProTests` contain XMLExporter tests; copy their expected strings).

### 6.2 FCPXML 1.10–1.14 (DaVinci Resolve / Final Cut Pro) — `Export/FCPXMLExporter.swift`

Options: **version** `1.10` (default) | `1.11` | `1.12` | `1.13` | `1.14`, which only changes the `version` attribute. Compatibility notes:
- 1.10 "DaVinci Resolve 18+, Final Cut Pro 10.6+"
- 1.11 "DaVinci Resolve 21+, Final Cut Pro 10.7+"
- 1.12 "DaVinci Resolve 21+, Final Cut Pro 10.8+"
- 1.13 "DaVinci Resolve 21+, Final Cut Pro 11+"
- 1.14 "DaVinci Resolve 21+, Final Cut Pro 12+"

**target** `resolve` (default, "DaVinci Resolve") | `fcp` ("Final Cut Pro") changes only value encodings, as noted below.

**Build order** (`build`, `:170-183`):
1. `collectNests`: reachable nested timelines with `totalFrames > 0`, depth ≤ 8, BFS discovery order (`Timeline.reachableTimelines`), ids `nest1, nest2…`.
2. `emittableClips(root)` + `emittableClips(each nest)`.
3. `collectResources` over all of them.
4. `indexLinkedPairs`; `markUsedCompounds`.
5. `hasTitles` = any text clip.

**Emittable clips and lanes** (`emittableClips`, `isEmittable`, `:772-812`):
- Iterate the tracks in model order:
  - visual tracks get `lane = visualCount − visualOrdinal` (the top track has the highest lane, the bottom visual track lane 1), `enabled = !hidden`;
  - audio tracks get `lane = −1, −2, …`, `enabled = !muted`.
- Within a track, clips sorted by start.
- Emittable:
  - `durationFrames > 0`;
  - carriers need a nest id;
  - text needs non-empty content;
  - lottie, subtitle and raw `sequence` mediaType are excluded;
  - audio/video/image need a resolved URL.

**Resources** (`collectResources`, `:648-705`). Group clips by **canonical file path** (`standardized + symlinks resolved`; Linux `fs.realpathSync`):
- `hasVideo` |= clip is not audio;
- `hasAudio` |= audio clip, or video clip whose entry `hasAudio`;
- `duration` = max over clips of `max(round(entry.duration·fps), clip.sourceDurationFrames)`;
- `startTimecode` = the first referencing mediaRef's `rational(tc)`, or `0/1`.
- Resource `i` (1-based, in first-seen order): `assetId "asset{i}"`, `formatId "r{i+1}"` if hasVideo, `compoundId "media{i}"` if hasVideo && hasAudio.

**Linked pairs** (`indexLinkedPairs`): a link group with **exactly one** visual clip (video/image/sequence) and **exactly one** audio clip, with the same mediaRef, enabled, start, duration, trimStart and speed (±1e-4), exports as **one** visual element carrying the audio's volume. The audio clip is marked redundant. A compound `mediaN` is "used" only if some non-redundant clip without a linked audio references a resource with a compound id.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="{1.10…1.14}">
  <resources>
    <format id="r1" name="{seqFormatName}" frameDuration="{fd(fps)}" width="{W}" height="{H}" colorSpace="1-1-1 (Rec. 709)"/>
    [hasTitles] <effect id="titleBasic" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>
    {for each resource with video:} <format id="r{i+1}" name="{videoFormatName(srcW??W, srcH??H, srcFps??fps)}" frameDuration="{fd(srcFps??fps)}" width=… height=… colorSpace="1-1-1 (Rec. 709)"/>
    {for each resource:} <asset id="asset{i}" name="{file name}" start="{rt(tc)}" duration="{t(durFrames)}"
           [hasVideo] hasVideo="1" videoSources="1" format="r{i+1}"
           [hasAudio] hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">
        <media-rep kind="original-media" src="{url.absoluteString with each of ' ! $ & ( ) * + , ; = replaced by %XX (uppercase hex)}"/>
      </asset>
    {for each USED compound:} <media id="media{i}" name="{file name}">
        <sequence format="{r{i+1} ?? r1}" duration="{t(dur)}" tcStart="0s" tcFormat="NDF">
          <spine><asset-clip ref="asset{i}" name="{file name}" duration="{t(dur)}" start="{rt(tc)}" offset="0s" format="{r{i+1} ?? r1}"/></spine>
        </sequence></media>
    {for each nest whose W×H ≠ root:} <format id="{nestN}Format" name="{seqFormatName(nestW, nestH, fps)}" frameDuration="{fd(fps)}" width=… height=… colorSpace="1-1-1 (Rec. 709)"/>
    {for each nest:} <media id="nest{n}" name="{child.name}">
        <sequence format="{r1 or nestNFormat}" duration="{t(child.total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine><gap name="Timeline" offset="0s" start="0s" duration="{t(child.total)}">{story nodes of the child}</gap></spine>
        </sequence></media>
  </resources>
  <library>
    <event name="Palmier Export">
      <project name="{timeline.name}">
        <sequence format="r1" duration="{t(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="Timeline" offset="0s" start="0s" duration="{t(total)}">{story nodes}</gap>   (empty timeline → <spine/>)
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
```

**Time strings:**

```ts
t(frames)        = frames == 0 ? "0s" : reduce(frames / fps) → "N/Ds" or "Ns"          // gcd-reduced; fps = max(1, timeline.fps)
rt(num, den)     = num == 0 ? "0s" : reduce(num/den)
t(frames, origin)= origin.num == 0 ? t(frames) : rt(frames*origin.den + origin.num*fps, fps*origin.den)
fd(raw)          = ntscLike(raw) ? `1001/${round(raw)*1000}s` : `1/${round(raw)}s`        // ntscLike = |raw - r*1000/1001| < |raw - r|, r=max(1,round(raw))
rateSuffix(raw)  = ntscLike ? (x = round(r*1000/1001*100), `${floor(x/100)}${pad2(x%100)}`) : `${r}`   // 29.97 → "2997", 23.976 → "2398"
recognized(w,h)  = 1280×720 → FFVideoFormat720p{s} | 1920×1080 → FFVideoFormat1080p{s} | 3840×2160 → FFVideoFormat3840x2160p{s} | 4096×2160 → FFVideoFormat4096x2160p{s}
seqFormatName    = recognized ?? "FFVideoFormatRateUndefined";   videoFormatName = recognized ?? `FFVideoFormat${w}x${h}p${s}`
num(v)           = r = round(v, 4 places); integer → String(int); else "%.4f" trimmed of trailing zeros and "."
rationalSpeed(s) = best p/q, q in 1..1000, p = round(s*q) > 0, minimizing |s - p/q| (first minimum; stop at exact)
```

**Story nodes** (`storyNodes`): drop redundant audio; sort by `(startFrame, lane)` ascending; map text → `title`, audio/video/image/sequence → asset element; skip lottie/subtitle.

**Asset element** (`assetClipNode`, `:374-459`):
- Nested carrier → `<ref-clip ref="nest{n}" name="{child.name}" lane offset="t(start)" start="t(trimStart)" duration="t(min(dur, max(0, child.total − trimStart)))" enabled="1|0">` (skipped if the duration is ≤ 0):
  - audio clip: `srcEnable="audio"`, children `[adjust-volume]`;
  - visual: `srcEnable="video"` unless it has a linked audio; children `adjust-conform type="fit"`, `adjust-crop`, `adjust-transform`, `adjust-blend`, `adjust-volume` (of the linked audio).
  - Note this child order differs from the media case.
- Resource with a compound and no linked audio → `<ref-clip ref="media{i}" name lane offset start="{clipStart(clip)}" duration enabled srcEnable="{video|audio}">`:
  - video children `timeMap, adjust-crop, adjust-conform, adjust-transform, adjust-blend`;
  - audio children `timeMap, adjust-volume`.
  - `clipStart` here has **no timecode origin**: compounds are 0-based.
- Otherwise `<asset-clip>` (or `<video>` for images; FCP writes stills that way) `ref="asset{i}" name lane offset start="{clipStart(clip, origin=tc)}" duration enabled` with children `timeMap(origin), [visual] adjust-crop, adjust-conform fit, adjust-transform, adjust-blend, [resource.hasAudio] adjust-volume(linkedAudio ?? clip)`.

```ts
clipStart(clip, origin=0/1) = |speed-1| <= 0.001 ? t(trimStart, origin) : (p,q = rationalSpeed(speed)) rt(trimStart*q, fps*p)
timeMap (|speed-1| > 0.001 && mediaFrames > 0):
  <timeMap frameSampling="floor"><timept time="0s" value="{rt(origin)}" interp="linear"/>
                                 <timept time="{rt(mediaFrames*q, fps*p)}" value="{t(mediaFrames, origin)}" interp="linear"/></timeMap>
adjust-crop (crop ≠ identity): lr = tb = 100; if target==resolve && srcW,srcH > 0: fit = min(W/srcW, H/srcH); lr = srcW*100/H; tb = 100/fit
  <adjust-crop mode="trim"><trim-rect top="{num(top*tb)}" right="{num(right*lr)}" bottom="{num(bottom*tb)}" left="{num(left*lr)}"/></adjust-crop>
fitFractions(clip) = no src dims → (1,1); sa = srcW/srcH, fa = W/H; sa >= fa ? (1, fa/sa) : (sa/fa, 1)
scaleValue(w,h) = (w/fit.w)·(flipH ? −1 : 1), (h/fit.h)·(flipV ? −1 : 1)  → "num num"
position(t, fit) = unit = H/100; x = (cx−0.5)·W/unit/fit.w; y = (0.5−cy)·H/unit/fit.h → "num num"   (fit = (1,1) for target fcp)
adjust-transform when moved (|c−0.5| > 5e-4) || rotated (|rot| > 0.005) || scale ≠ "1 1" || any pos/rot/scale keyframes:
  attrs scale="{scaleValue(w,h)}" [rotation="{num(−rot)}" if rotated or rot keys] anchor="0 0" position="{position}"
  children in order: scale, position, rotation params when keyframed:
  <param name="{scale|position|rotation}" value="{base}"><keyframeAnimation>
     <keyframe time="{kt(f)}" [curve="linear" if the keyframe's interpolationOut == linear] value="{value at f}"/>…</keyframeAnimation></param>
kt(f) = |speed−1| <= 0.001 ? t(f − start) : rt(trimStart*q + (f − start)*p, fps*p)
adjust-blend when opacity < 0.9995 or opacity keys: <adjust-blend amount="{num(opacity)}">[<param name="amount" …keyframes rawOpacityAt>]</adjust-blend>
adjust-volume when |volume−1| > 5e-4: <adjust-volume amount="{num(volume > 0 ? 20·log10(volume) : −96)}"/>   (no keyframes, no fades)
```

**Title** (`titleNode`, `:461-487`, text clips with non-empty content). `textStyle{n}` ids are numbered in emission order across the document.

```xml
<title ref="titleBasic" name="{content}" lane="{lane}" offset="{t(start)}" start="0s" duration="{t(dur)}" enabled="{1|0}">
  <text><text-style ref="textStyle{n}">{style.displayText(content)  // fontCase applied}</text-style></text>
  <text-style-def id="textStyle{n}"><text-style font="{family}" fontFace="{face}" fontSize="{num(fontSize·fontScale)}"
       fontColor="{num r} {num g} {num b} {num a}" alignment="{left|center|right…raw value}"
       [border.enabled] strokeColor="{rgba}" strokeWidth="{num(max(0, border.width))}"/></text-style-def>
  <adjust-conform type="fit"/>
  <adjust-transform scale="{num widthScale} {num heightScale}" anchor="0 0" position="{position(clip.transform), fit (1,1)}">
     [scale keyframes: value = (widthScale·r, heightScale·r) with r = textScaleAt(f)/fontScale (fontScale ≤ 0/NaN → default)]</adjust-transform>
  [adjust-blend]
</title>
```

- The style is first `scaledVisualStyle` (fontSize, tracking, lineSpacing and shadow scaled by fontScale, which then resets `fontScale` to 1), so `fontSize·fontScale` applies the scale **once** (corrected 2026-10-13 from the Mac source and its test expecting `strokeWidth="14"`).
- `family` = the resolved font's family name, else `fontName.split('-')[0]`. `face` = the resolved font's face name when its bold/italic traits match the style, else "Bold Italic" | "Bold" | "Italic" | "Regular".
- **Linux:** resolve via the font registry built from the bundled fonts (05 §12.1: PostScript name → family + style) and `fc-match` for system fonts: `fc-match -f '%{family[0]}\n%{style[0]}' '<name>:weight=<200|80>:slant=<100|0>'`.

**Not transported:** keyframed audio volume and audio fades, text background boxes, crop keyframes, title rotation, colour/effects, edge softness/rounding, Lottie, subtitles, multicam structure.

**Linux:** `src/core/interchange/fcpxml.ts`, pure. The exporter collects timecodes for every media ref reachable through nests (BFS, `FCPXMLExporter.swift:82-99`) before rendering. Golden-test with Mac fixtures for both targets and NTSC rates (23.976, 29.97, 59.94).

### 6.3 Save as Media / Save as Audio / Extract Audio / Save Range as Media

`Editor/ViewModel/EditorViewModel+SaveAsMedia.swift`, menus `Timeline/TimelineView.swift:1515-1535, 1635`, `MediaPanel/MediaTab/AssetThumbnailView.swift:98`.

| Action | Where | Condition | Output | Placeholder name | Encode (Mac) | Linux FFmpeg |
|---|---|---|---|---|---|---|
| **Save as Media** | clip context menu | clip `mediaType` video or audio (multicam allowed) | `clip-<8 hex>.mp4` (video) / `.m4a` (audio) in `<package>/media/` | `"<source display name> (clip)"` | `AVMutableComposition`: insert source range `[trimStart, +sourceFramesConsumed]` (fps timescale) of the primary track (+ the video's first audio track at the same range), keep `preferredTransform`; if `speed ≠ 1` scale `[0, sourceFrames]` → `durationFrames` (time-stretch, audio pitch **not** preserved); `AVAssetExportPresetHighestQuality` → mp4 / `AppleM4A` → m4a | video: `-ss {trim/fps} -t {consumed/fps} -i src -map 0:v:0 -map 0:a:0? -vf setpts=PTS/{speed} -af "asetrate=SR*{speed},aresample=SR"` (pitch-shifting resample to mimic `scaleTimeRange`) `-c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -c:a aac -b:a 256k -movflags +faststart`; audio: `-vn -c:a aac -b:a 256k` → `.m4a` |
| **Save as Audio** | clip context menu (video clips) | `audioClipForExtraction`: not nested, not multicam; the linked audio partner if it exists (must be online and not generating), else the video itself when the asset has audio | `clip-<8hex>.m4a` | `"<display name> (audio)"` | same `exportClipRange` with mediaType audio | as above, audio only |
| **Extract Audio** | Media tab asset context menu (multi-select) | `video && hasAudio && !generating && online` | `clip-<8hex>.m4a` in the **same folder** as the asset | `"<asset name> (audio)"` | whole file, first audio track → `AppleM4A` | `-map 0:a:0 -vn -c:a aac -b:a 256k` (or `-c:a copy` when the source codec is AAC) |
| **Save Range as Media** | timeline range context menu | a valid selected range with > 0 frames | `clip-<8hex>.mp4` | `"Timeline range"` (status `rendering`) | `TimelineRenderer.render(startFrame, frameCount, preset HighestQuality)` = full composite (04 §11.6) | the export pipeline (04 §11.3) for `[start, start+count)` at canvas size, H.264 CRF 18 |

Common flow:
1. `projectPackageCoordinator.beginMutation()`. If refused, silently do nothing.
2. Insert a placeholder `MediaAsset` (`generationStatus = generating`, or `rendering` for ranges) at the final URL, shown in the media grid as generating.
3. Render to a temp staging file.
4. `commitStagedProjectMedia(staged, filename)` moves it into the package (01 §1.7).
5. `generationStatus = none`, `finalizeImportedAsset` (metadata, thumbnail, waveform, search indexing).
6. On error, `generationStatus = failed(message)` and the manifest is updated. No undo entry: the asset appears as an ordinary import.
7. Always `endMutation`. Temp files are deleted.

### 6.4 Capture frame to media

`Editor/ViewModel/EditorViewModel+FrameCapture.swift`, `Preview/FrameCaptureRenderer.swift`. Button: preview transport `camera` "Capture Frame to Media" (timeline tab and video asset tabs, 05 §5.5). Also the agent `capture_frame` (02 §3.13).

- Source:
  - timeline tab → `.timeline(frame: currentFrame)`;
  - video asset tab → `.media(ref, sourceSeconds = relative source playhead seconds)`.
  - Other tabs do nothing. One capture at a time per editor (`frameCaptureTask`). The destination is the media panel's current folder.
- Validation errors (verbatim):
  - "No project is open."
  - "The timeline is empty."
  - "Timeline frame N is outside 0..<T."
  - "Media asset not found: id"
  - "Media asset id is not a video."
  - "Media asset id is still preparing."
  - "Media asset id failed: reason"
  - "The destination media folder no longer exists."
- Timeline render: the full composite at **canvas size**, exact frame time (`frame/fps`, zero tolerance). At most **2** concurrent captures app-wide.
- Media render:
  - duration must be finite and > 0;
  - `sourceSeconds ∈ [0, duration + 0.001]`, else "Source time X.XXXs is outside 0…D.DDDs.";
  - if `sourceSeconds ≥ duration − minFrameDuration`, take the **last frame** (`end − minFrameDuration`, zero tolerance after); else the nearest frame within ±1 frame;
  - report the actual frame time.
- Output: PNG `frame-<8 hex>.png` in `media/`; library thumbnail 320 px; the asset `type image`, `duration 5 s` (`Defaults.imageDurationSeconds`).
  - Name: `Frame <n>` (timeline) or `<asset name> frame` (media), or the agent-supplied name.
  - `sourceWidth/Height` = the PNG size.
- Undo: **"Capture Frame"** restores the media library snapshot. It also schedules search indexing and visuals.
- Toasts:
  - `Captured <name>.` (success);
  - `Captured <name>. The destination folder was removed, so the frame was saved at the top level of Media.` (warning);
  - errors → the error text.
- **Linux:**
  - timeline → render one frame with the offscreen compositor (`renderer.renderFrame(f)` → RGBA → PNG via `canvas.convertToBlob` or `sharp`), at canvas size;
  - media → `ffmpeg -ss <t> -i src -frames:v 1 -update 1 out.png`, applying display rotation (FFmpeg autorotate is on by default). For last-frame requests use `-sseof -<1/fps>`. Read the actual PTS via `-vf showinfo` or ffprobe.

### 6.5 Solid mattes

`Models/Matte.swift`, `Editor/ViewModel/EditorViewModel+Matte.swift`, `MediaPanel/MatteSheet.swift` (UI in 05 §4.12). Entry: Media tab toolbar overflow `…` ▸ **Create Matte** (`square.fill`). Agent: `import_media {source: {matte: {...}}}` (02 §3.12).

```ts
even(w, h) = [max(2, floor(max(2, w)/2)*2), max(2, floor(max(2, h)/2)*2)]
fit(short e0, aw, ah): e = max(2, e0); aw >= ah ? even(round(e*aw/ah), e) : even(e, round(e*ah/aw))
pixelSize(aspect, W, H) = aspect == 'Project' ? even(W, H) : fit(min(W, H), ratio)    // 16:9, 9:16, 1:1, 4:3, 9:14, 2.4:1 (= 24:10)
```

- PNG: fills the whole canvas with the colour (alpha 1), sRGB, 8-bit RGBA (premultiplied last; opaque so irrelevant).
- Colour hex = `#RRGGBB` from sRGB components ×255 **truncated** (`Int(c*255)`).
- File `matte-<8 hex>.png`, committed to `media/`.
- Asset name `Matte · <W>×<H>` for Project, or `Matte · <aspect raw>` (e.g. `Matte · 9:16`), or the agent's name.
- Placed in the current folder.
- Errors: "Couldn't render matte image." / "Open a project before creating a matte."
- **No undo entry** (a checkpoint save is requested).
- Sheet default colour = `MediaOverlay.background` (black).
- **Linux:** generate the PNG with `sharp({create: {width, height, channels: 3, background}}).png()` or a tiny zlib PNG encoder in TS (a single-colour IDAT).

### 6.6 Chroma key sampler

`EditorViewModel+ChromaKey.swift`, `Preview/ChromaKeySamplerOverlayView.swift`, `Preview/VideoEngine.swift:601-628`. Entry: Inspector ▸ Adjust ▸ Effects ▸ Chroma Key eyedropper (05 §7.5.2).

1. `toggleChromaKeySampling(clipId)`:
   - if already sampling this clip → cancel;
   - else cancel any other; require the timeline preview tab and a visual clip;
   - **pause**; live-apply (no undo) "disable the existing `key.chroma` effect" so the sample sees the un-keyed colour; remember the clip.
2. Overlay: full-size transparent layer, `crosshair` cursor. A click outside the video rect, or with no engine → beep.
3. Normalized point → sample the **composited preview frame** at the current frame:
   - a 9×9 px patch centred at the point (clipped to the image; y flipped), area-averaged to RGB float;
   - → HSB via `NSColor.getHue` (standard HSV, hue 0…1);
   - **if saturation < 0.12 → no hue** (beep, stay in sampling mode).
4. `commitChromaKeySample(hue, clipId)` (undo **"Sample Key Color"**):
   - the effect (existing or registry default) is enabled with `keyHue = hue`, `tolerance = 0.15`, `softness = 0.1`;
   - it is reinserted at the registry insert index (01 §5.8).
5. Cancel (Esc, tab switch, toggling again) → `revertClipProperty` (restores the live-edited value).

**Linux:**
- Read pixels from the compositor's **last presented frame** FBO (`gl.readPixels` of the 9×9 region at canvas resolution: `x = nx·W`, `y = (1 − ny)·H` in GL's bottom-left origin).
- Average the values in the same (non-linear sRGB) space the Mac averages: Core Image's working space is disabled in this app (`workingColorSpace: NSNull`, 04 §7.1), so this is a plain average of the encoded values.
- Convert to HSV (`max/min` formula) with the 0.12 saturation gate.

### 6.7 Matte / segmentation

**There is no person-segmentation or background-removal model in v0.7.6.** No Vision framework imports exist; `grep` finds no `VNGeneratePersonSegmentation`. "Matte" in the Mac app means only:
1. **solid colour mattes** (§6.5);
2. **chroma key** (`key.chroma`, 04 §8.15) with the sampler (§6.6);
3. text **fill mode "footage matte"** (`TextFillMode`, 04 §9.11).

Background *audio* removal ("Voice Cleanup") is a cloud AI edit (05 §7.5.6), class (c). No Linux work is required for parity. A future local "Remove Background" would need a person-segmentation model run through the same `onnxruntime-node` process (§0.3); it is out of scope and no model is proposed here.

---

## 7. Home samples, onboarding, tutorial tour, Help, Feedback, What's New, updates

05 §8 and §10.4–10.5 already cover the visual specs of Home, onboarding, Help and Feedback. This section adds the behaviour, the server dependencies and the Linux decisions.

### 7.1 Sample projects (`Home/SampleProjectsStrip.swift`, `Project/SampleProjectService.swift`, `App/AppState.swift:352-360`)

**Mac — needs Palmier's servers (class c):**
- Base URL = `BackendConfig.convexHttpURL` (Info.plist `PalmierConvexHttpURL`, injected at build time by `scripts/bundle.sh:131` from `CONVEX_HTTP_URL`; empty in open-source builds → `notConfigured`, and the strip is hidden).
- **List:** `GET {base}/v1/samples` → `[{slug, title, posterUrl?}]`. Errors are swallowed and the strip stays hidden when the list is empty.
- **Materialize:** `GET {base}/v1/samples/resolve?slug=<slug>` → `{title, project: <project.json object>, manifest: <media.json object>, downloads: [{id, relativePath, url}], chat?: [{name, url}], posterUrl?}`.
  1. Delete `~/Library/Application Support/PalmierPro/Samples/<safe slug>/` and create `<safe title>.palmier/media/`. `safeName` replaces `/ : \` with spaces and trims; empty → "Sample".
  2. Write `project.json` and `media.json` (re-serialized with `JSONSerialization`).
  3. Download the poster to `thumbnail.jpg` (best effort).
  4. Download every file concurrently to `relativePath` (chat files → `chat/<name>`). Progress = completed/total.
  5. Any failure deletes the slug directory and rethrows.
- **Cache:** if `Samples/<slug>/` contains a `.palmier`, open it directly.
- **Open:** `openProjectAsync(at:, register: false, options: {startTutorial: true})`. Samples never appear in My Projects. Then `editor.tour.start(in:)` on the next run loop.
- **Card UI** (05 §8.4): 150×120 poster; while downloading, blur 4 + black @ 0.08 overlay + a linear progress bar; failure → `arrow.clockwise` + "Retry" (click retries). Expanded state key `samplesSectionExpanded` (default true).

**Linux — class (b), replaced with bundled local samples (optional; omit the strip when none are bundled):**
- `resources/samples/index.json` = `[{slug, title, poster: "posters/<slug>.jpg", package: "<slug>.palmier"}]`. Ship 0–1 small sample packages with license-clean media (CC0/CC-BY with attribution in the About box).
- "Materialize" = copy the bundled package to `$XDG_DATA_HOME/palmier-pro/Samples/<slug>/<title>.palmier` (progress = bytes copied), then open with `register: false` and start the tour.
- Same cache, retry and expanded-state behaviour. If `index.json` is empty or missing, hide the strip, exactly like the Mac when the backend returns nothing.

### 7.2 Onboarding (`Home/Onboarding/*`) — first launch overlay on Home

- Shown while `UserDefaults hasSeenWelcome != true`.
- Steps `welcome → discovery → profile → account`; "Back" from any step after the first.
- Selections (`OnboardingStore.toggle`):
  - single-choice questions (acquisitionSource): toggling the selected option clears it;
  - multi-choice questions;
  - an exclusive option id (`none` for previousEditors) clears the others, and selecting another option removes it.
- `submitSurvey()` (on leaving *profile*) sends PostHog `onboarding_completed` **once per session** with `{survey_version: 2, roles[], video_types[], interests[], acquisition_source: first || "not_provided", previous_editors[]}`, then advances.
- Account step:
  - signed out: "Sign In", "Sign in to receive 250 free credits for AI chat and generation.", [Skip] [Sign in with Google] ("Opening Google…" while signing in).
  - signed in (or backend misconfigured): "Welcome, <first name>" / "Welcome" with "Watch the tutorial or start creating.", [Skip] [Tutorial].
  - **Tutorial** = `openSampleProject()`: fetch the first sample, open it with the tour, then `complete()`. Failure → "Sample project couldn’t be opened. Try again." Sign-in failure → "Sign-in couldn’t be completed. Try again."
  - `skip()` cancels the sample load and completes. Completion sets `hasSeenWelcome = true`.

**Linux:**
- Keep the steps welcome, discovery and profile.
- **Do not send the survey anywhere** (class d). Either drop the two question steps, or keep them purely cosmetic and store nothing. 05 §8.6 recommends keeping them.
- Replace *account* with **"Add API keys"** (05 §8.6) plus a [Tutorial] button. With a bundled sample (§7.1) it opens it with the tour. Without one, it creates an untitled project in a temp location (`os.tmpdir()/palmier-tutorial/Tutorial.palmier`, not registered) and starts the tour there.
- Persist `hasSeenWelcome` in `settings.json`.

### 7.3 Tutorial tour (`Editor/Tour/*`)

**Start:**
- Help ▸ Tutorial (`AppDelegate.swift:165`; no-op without an active project);
- opening a sample with `startTutorial` (§7.1);
- the onboarding Tutorial button.

**Steps** (`TourController.makeSteps`, `:164-227`). Title and instruction strings are verbatim. "Spotlight" steps highlight a panel or a tagged control.

| # | Kind / target | Title | Instruction | Condition / prepare |
|---|---|---|---|---|
| 1 | intro | Tutorial | Let's take a quick tour of the workspace and what you can do. | — |
| 2 | panel media | Media panel | This is where all your footage and assets live. | |
| 3 | element importButton | Import footage | Import your footage here, or drag and drop, or copy-paste, into the media panel. | |
| 4 | element generateButton | Generate | Click Generate to open the generation panel. | |
| 5 | element generation (opens the generation panel) | Generation panel | Generate video, image, or audio with different models and settings. Drag assets from the media panel above into the reference frame. | `showGenerationPanel = true` only for this step |
| 6 | element smartSearch | Smart search | Download a local model to index your media, so you or your agent can search any clips by describing them. The model runs on-device and nothing leaves your Mac. | only if the search model is `notInstalled`, enabled, and ≥1 video/image asset |
| 7 | panel preview | Preview | This is your preview panel to play a selected media or the whole timeline. | |
| 8 | element screenshotButton | Screenshot a frame | Take a screenshot of the preview and use it as a reference for generation. Particularly useful for creating AI transitions. | |
| 9 | panel timeline | Timeline | with an AI-edit clip: "Your timeline: the top half is video, the bottom half is audio. Click a clip to inspect it — we've selected one for you." else "… This is where you edit." | prepare `selectAIEditClip` when such a clip exists |
| 10a | panel inspector | Inspector | Your inspector for the selected clip — transform, adjust, audio, and more. | with an AI-edit clip: prepare `revealInspectorOverview` (select it, request the **Video** tab) |
| 10b | element aiEditPanel | AI Edit | Open the AI Edit tab to upscale, prompt-edit, create video from a frame, or generate music, SFX, cleanup, and dubbing from the clip. | only with an AI-edit clip; prepare `revealAIEditTab` (request the **AI** tab) |
| 11 | panel agent | AI agent | Chat with your agent! It can generate content, edit clips, organize your assets, and much more. Start by signing in, or bring your own Anthropic API key. | |
| 12 | element skillsButton | Skills | Open Skills to browse community playbooks, create your own, or add them to other agents. | |
| 13 | outro | You're all set | Start creating, or explore these to get the most out of Palmier Pro. | |

- "AI-edit clip" = the first visual non-text clip (track order) whose media is in the library, and only when the backend is configured (`!AccountService.isMisconfigured`).
- **Apply a step:**
  - un-maximize any panel;
  - for spotlight steps, make the host panel visible (media/agent/inspector; timeline and preview are always visible) and set `showGenerationPanel = (target == generation)`; otherwise hide the generation panel;
  - run the prepare action (select the clip: clear gap/range selection, select its link group; set `inspectorClipTabRequest`).
  - `end()` clears the step, the frame and the tab request.
- **Target frame:**
  - panels → the split-view leaf's frame in window coordinates (top-left origin), clipped below the title bar;
  - elements → the registered anchor view's frame (anchors are invisible background views; frames update on layout through `anchorRevision`).
  - No frame (anchor missing or hidden) → no cutout, and the callout is centred.
- **Overlay** (`TourOverlay.swift`):
  - scrim black @ 0.55 with a rounded (radius 6) **cutout** around the target;
  - a 2 px gradient stroke ring (`#FF574D → #F22647 → #FF7A38`, top-left → bottom-right) with a red glow (`#FF4545` @ 0.55, radius 10);
  - clicking the scrim on a spotlight step **ends the tour**.
- **Callout card:**
  - 320 wide, padding 14, surface fill, radius 12, hairline border, shadow lg;
  - `Step <index> of <spotlightCount>` (10 px medium tertiary; index = the step's position in the full list, so the intro is 0 and the first spotlight is "Step 1");
  - title 13 px semibold; instruction 12 px secondary;
  - buttons [Skip] (Esc) … [Back] [Next] (Return, prominent).
- **Placement** (`calloutPosition`), with margin 24 and an estimated card height of 220:
  - right of the frame if it fits;
  - else left;
  - else above the frame (centred at midX) if `minY > 220 + 48`;
  - else below.
  - x and y are clamped so the card stays inside the window with the margin.
- **Intro card:** 600 wide, padding 28, material, radius 12; title 28 px light (tracking −0.5); a hero `Images/tour-hero.jpg` 300 tall (radius 10); [Skip] (secondary) … [Next].
- **Outro card:** title 22 px semibold. Link rows (12 px, an accent icon in an 18 px frame, `arrow.up.right` muted), each 8 px vertical padding:
  - Skills (`book.closed.fill`) → Settings ▸ Skills;
  - MCP Setup (`puzzlepiece.extension.fill`) → Help ▸ MCP;
  - Keyboard Shortcuts (`keyboard`) → Help ▸ Shortcuts;
  - Documentation (`book.fill`) → `https://palmier.io/docs`;
  - Settings (`gearshape.fill`) → Settings;
  - then [Start creating].

**Linux:**
- React overlay at the editor-window root. Anchors are `ref`-registered DOM elements; frames from `getBoundingClientRect()`, recomputed with a `ResizeObserver` and on layout changes. The cutout is an SVG mask or `clip-path: path(evenodd)`.
- Copy changes:
  - step 6: "…nothing leaves your computer.";
  - step 11: "…Start by adding your Anthropic or OpenAI API key in Settings.";
  - Documentation link: keep `https://palmier.io/docs` or point at the Linux README (configurable).
- **Skip steps 4–5 when generation is unavailable** (no provider key, so the Generate button is hidden). The Mac would show them with a centred callout and nothing highlighted.
- Show the AI Edit steps (10a with Video tab, 10b) only when AI Edit is available on Linux (05 §7.5.6).

### 7.4 Help window and Feedback

- **Help window** (05 §10.4): panes **Shortcuts** and **MCP**. Fully local, class (a). Help ▸ Keyboard Shortcuts (`⌘?`) and Help ▸ MCP Instructions open it on the given tab. The MCP pane shows `http://127.0.0.1:19789/mcp` and connector install actions.
- **Feedback window** (05 §10.5; `Help/FeedbackView.swift`, `Help/FeedbackScreenshot.swift`):
  - The key window is captured before the window opens (PNG, longest side ≤ 1920).
  - Submission goes to the Convex action `feedback:send` (`Account/AccountService.swift:418`) with the message (≤ 10,000 chars), optional email, the reply-consent flag, the optional screenshot, the app version/build and the OS version. **Needs Palmier's servers (class c).**
  - Also reachable from the offline-media overlay ("Report a Problem", pre-filled) and the account popover ("Feedback"). The agent's `send_feedback` tool posts the same.
  - **Linux:**
    - The menu item "Send Feedback…" opens the same window. "Send" becomes **"Open Issue"**: it opens `<feedbackIssueURL>?title=<first line, ≤ 80 chars>&body=<message + "\n\n---\nApp <version> · <distro> <kernel> · Electron <v>">` in the browser. `feedbackIssueURL` is a build-time constant: the Linux fork's GitHub repo `/issues/new`.
    - The screenshot cannot be attached through a URL. Offer "Save Screenshot…" (writes the PNG to a chosen path) and mention it in the body.
    - The agent's `send_feedback` returns a tool error: "Feedback submission isn't available in this build. Ask the user to open an issue." (see 02 §3.49).

### 7.5 What's New, updates, account, telemetry

| Feature | Mac | Linux |
|---|---|---|
| What's New overlay (`Home/UpdateOverlay.swift`, `App/Changelog.swift`) | bundled `Resources/Changelog/changelog.json`. Shown after onboarding when the bundle version ≠ `lastSeenVersion`, not on a fresh install. Link "Full changelog" → `https://github.com/palmier-io/palmier-pro/releases` | keep (a). Ship the Linux changelog JSON in the same format, and point the link at the Linux repo's releases |
| Sparkle updater ("Check for Updates…", title-bar "Update" badge, Home "Click to install update" card; feed `https://raw.githubusercontent.com/palmier-io/palmier-pro/main/appcast.xml`, EdDSA-signed) | (d) drop | drop Sparkle. AppImage: optional `electron-updater` against the Linux repo's GitHub releases, or nothing; deb: the distro package manager. Hide the badge and the card |
| Account (Clerk Google sign-in, plans, credits, Stripe checkout/top-off/portal, avatar, credit chips, Project Activity) | Palmier backend | (c)/(d) remove (05 §11.2) |
| Sentry crash reports and PostHog analytics (only with the `ProductionTelemetry` trait) | telemetry | (d) drop. The local crash log stays (`$XDG_STATE_HOME/palmier-pro/crash.log`) |

---

## 8. Parity checklist (every user-visible feature of v0.7.6)

Legend for **Class**:
- **(a)** portable as-is (pure logic or UI over local data);
- **(b)** needs a Linux replacement (named);
- **(c)** needs Palmier's cloud account and cannot be replicated as-is (a BYOK substitute is noted where one is specified);
- **(d)** telemetry, updater or account — drop.

**Spec** names the document and section that specifies the feature (`01`…`07`). Paths are relative to `Sources/PalmierPro/`. §8.12 adds the internal modules that have no menu or button of their own, and §8.13 maps **every** source directory to the rows and spec sections that cover it.

### 8.1 App, menus, windows

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| App menu: About, Settings… (⌘,), Quit (saves all projects) | `App/MainMenu.swift:22-31`, `App/AppDelegate.swift:52-103` | 05 §9 | (b) | Electron `Menu`; Ctrl shortcuts; `before-quit` saves all |
| Check for Updates… / Sparkle background checks / title-bar Update badge / Home update card | `App/Updater.swift`, `App/UpdateBadgeView.swift` | 07 §7.5 | (d) | drop (optional electron-updater) |
| File: New (⌘N), New Folder (⇧⌘N), Open… (⌘O), Save, Save As…, Import Media… (⌘I), Export… (⌘E) | `App/MainMenu.swift:40-59`, `App/AppState.swift:196-369` | 05 §9, 01 §1.8, 03 §10.1 | (b) | Electron dialogs (`showSaveDialog`/`showOpenDialog` for `.palmier` directories) |
| Edit: Undo/Redo, Cut/Copy/Paste, Select All, Select Forward (A / ⇧A), Split at Playhead (⌘K), Trim Start/End (Q/W), Delete, Ripple Delete, Ripple Timeline Markers toggle | `App/MainMenu.swift:71-113` | 03 §2, §4, §16; 05 §9 | (a) | |
| View: Media/Inspector/Agent panel toggles, Maximize Focused Panel (`), Layout ▸ Default/Media/Vertical (⌘1–3), Enter Full Screen | `App/MainMenu.swift:127-169`, `UI/WorkspaceLayout.swift` | 05 §2.3, §9 | (a) | |
| Help: Tutorial, Keyboard Shortcuts (⌘?), MCP Instructions, Send Feedback… | `App/MainMenu.swift:179-185` | 07 §7.3–7.4, 05 §10 | (a)/(c) | Feedback → issue link (07 §7.4) |
| Startup: fonts registration, appearance, MCP server start, skills sync, Home window | `App/main.swift`, `App/AppDelegate.swift:15-39` | 05 §12, 02 §1 | (a) | |
| Telemetry bootstrap, "app opened" analytics | `App/main.swift:3-19`, `Telemetry/*` | — | (d) | drop |
| OAuth URL callback `palmier://callback` | `App/AppDelegate.swift:105-124` | — | (d) | drop |
| Local notifications: generation complete, export complete/failed, permission | `App/AppNotifications.swift` | 05 §11.3, 06 §B4.5 | (b) | Electron `Notification` (libnotify) |
| What's New overlay (changelog.json) | `App/Changelog.swift`, `Home/UpdateOverlay.swift` | 05 §8.6, 07 §7.5 | (a) | Linux changelog + releases link |
| Crash log | `Utilities/Log.swift:5-44` | 01 §2.2 | (b) | `$XDG_STATE_HOME/palmier-pro/crash.log`, `process.on('uncaughtException')` + `crashReporter` (local only) |
| UI language selection (28 locales, restart) | `Localization/*`, `Settings/GeneralPane.swift` | 05 §11.3 | (a) | reuse `.lproj` strings converted to JSON |

### 8.2 Home, onboarding, tour, Help, Feedback

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Home window, sidebar (New Project, Open Project, Settings), header | `Home/HomeView.swift` | 05 §8.1–8.3 | (a) | |
| Sign in with Google / identity strip / welcome name | `Home/HomeView.swift:91-104`, `Account/IdentityViews.swift` | 05 §8.2 | (d) | omit |
| Sample Projects strip (download + tutorial) | `Home/SampleProjectsStrip.swift`, `Project/SampleProjectService.swift` | 07 §7.1, 05 §8.4 | (c) | (b) optional bundled local samples |
| My Projects: search, select, multi-delete (Trash), card menu (Open, Reveal in Finder, Remove from Recents, Delete Project), "File missing" | `Home/MyProjectsSection.swift`, `Home/ProjectCard.swift`, `Project/ProjectRegistry.swift` | 05 §8.5, 01 §2.1 | (b) | `shell.trashItem`, `shell.showItemInFolder` |
| Onboarding survey (welcome / quick questions / work) | `Home/Onboarding/*` | 05 §8.6, 07 §7.2 | (a) UI, (d) analytics | keep UI, send nothing |
| Onboarding account step (Google sign-in, 250 credits) | `Home/Onboarding/OnboardingSteps.swift:125-169` | 07 §7.2 | (d) | replace with "Add API keys" + Tutorial |
| Tutorial tour (13 steps, spotlight, callouts, outro links) | `Editor/Tour/*` | 07 §7.3 | (a) | React overlay; copy tweaks; skip Generate steps without a provider |
| Help window: Shortcuts pane | `Help/HelpView.swift`, `Help/ShortcutsPane.swift` | 05 §10.4, 03 §16 | (a) | Linux key names |
| Help window: MCP pane (URL copy, Claude Desktop .mcpb, Claude Code/Codex commands, Cursor deeplink + manual JSON) | `Help/MCPInstructionsPane.swift` | 05 §10.4, 02 §1.11 | (a)/(b) | `.mcpb` platform list; Claude Desktop has no official Linux build |
| Send Feedback window (screenshot, email, consent) | `Help/FeedbackView.swift`, `Help/FeedbackScreenshot.swift` | 05 §10.5, 07 §7.4 | (c) | (b) GitHub issue prefill + save screenshot |

### 8.3 Editor window, toolbar, keyboard

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Title bar: panel toggles, Export button with pulsing job dot | `Editor/TitleBarView.swift` | 05 §2.2 | (a) | |
| Title bar account avatar / popover | `Editor/TitleBarView.swift:71`, `Account/AccountPopoverCard.swift` | 05 §2.2 | (d) | omit |
| Project Activity popover (generation history with credits) | `Editor/ProjectActivityView.swift` | 06 §B11, 05 §2.2 | (c) | (b) local list built from `generationInput` in the manifest; no credit totals |
| Split-view layout, collapse/maximize, persisted divider positions | `Editor/EditorSplitViewController*.swift` | 05 §2.3 | (a) | |
| Toolbar: timeline tabs toggle, undo/redo, Pointer/Razor/Trim tools, Split, Trim [ ], Add Text, Add Marker + Ripple Markers dropdown, zoom −/slider/+ | `Toolbar/ToolbarView.swift` | 05 §2.5, 03 §15 | (a) | |
| Keyboard dispatcher (Space, ←/→, ⌫, M, C/V/T, I/O, [ ], Tab, `, Return, Esc chain; media-panel ⌘K/⌘↑/arrows/⌘A) | `Editor/EditorWindowController.swift:71-243` | 03 §16, 05 §10 | (a) | Ctrl for ⌘ |
| Undo engine shared by UI and agent | `Editor/EditorUndo.swift` | 03 §2 | (a) | |
| Ripple / overwrite engines | `Editor/RippleEngine.swift`, `Editor/OverwriteEngine.swift` | 03 §3 | (a) | |
| Agent activity highlight on timeline | `Editor/ViewModel/EditorViewModel+AgentActivity.swift`, `Timeline/AgentActivityLayerSupport.swift` | 05 §6.5, 02 | (a) | |
| Project autosave / checkpoints / close-with-save / offline scan | `Project/VideoProject.swift` | 01 §1.8–1.9 | (a) | |
| Package coordinator (serialized media installs) | `Project/ProjectPackageCoordinator.swift` | 01 §1.7 | (a) | |
| Clip Settings Mismatch sheet | `Project/Settings/ProjectSettingsMismatchView.swift` | 03 §11.2, 05 §7.2 | (a) | |
| Custom Aspect Ratio sheet, resolution/fps/aspect presets | `Project/Settings/*`, `Inspector/InspectorView.swift:155-305` | 05 §7.2, 03 §11 | (a) | |

### 8.4 Timeline

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Ruler, playhead, scrub, ⇧-drag range, I/O range | `Timeline/TimelineRuler.swift`, `TimelineInputController.swift`, `TimelineRangeSelection.swift` | 05 §6.3, 03 §6.4 | (a) | |
| Track headers: rename, select all on track, mute, hide, sync-lock, keyframe lanes, reorder, resize | `Timeline/TimelineHeaderView.swift` | 05 §6.4, 03 §5 | (a) | |
| Clip rendering: filmstrips, waveforms, fades, volume band, keyframe diamonds, offset badge, angle chip | `Timeline/ClipRenderer.swift`, `MediaVisualCache.swift` | 05 §6.5 | (a) | thumbnails/waveforms via FFmpeg |
| Speaker tint on waveforms | `Timeline/ClipRenderer.swift:399-428` | 07 §3.5 | (b) | local diarization |
| Dead-air wash on waveforms | `Timeline/ClipRenderer.swift:410-433` | 07 §3.3 | (b) | Silero ONNX |
| Beat ticks + beat snapping | `Timeline/ClipRenderer.swift:216-313`, `Audio/Beats/BeatStore.swift:123-131` | 07 §3.4, 05 §6.5, 03 §13 | (b) | Beat This ONNX |
| Clip moves/trims/slip/ripple/duplicate drags, modifiers, ghosts | `Timeline/TimelineInputController.swift`, `DragState.swift` | 03 §4, 05 §6.11 | (a) | |
| Snapping (playhead, edges, markers, beats) | `Timeline/SnapEngine.swift` | 03 §13 | (a) | |
| Zoom/scroll (⌥scroll, pinch, ⌘scroll) | `Timeline/TimelineInputController.swift:1275-1300` | 03 §14, 05 §6.10 | (a) | |
| Timeline tab bar (+, rename, duplicate, close, close others, delete, show all, close all) | `Timeline/TimelineTabBar.swift` | 05 §6.1, 03 §9 | (a) | |
| Markers: add, drag, ⌥-drag duration, editor popover, colors, statuses | `Timeline/MarkerEditorPopover.swift`, `TimelineMarkerRenderer.swift` | 03 §6, 05 §6.8 | (a) | |
| Clip menu: Select Forward, Copy, Paste, Paste Settings, Link/Unlink, Add to Chat | `Timeline/TimelineView.swift:1445-1486` | 03 §4.6, §4.15–4.16, 05 §6.14, 06 §A12.2 | (a) | |
| Clip menu: AI Edit ▸ (FLUX Enhance, Upscale, Reframe, Lip Sync, Edit, Generate Music/SFX, Rerun, Create Video, Clean Up Voice, Dub) | `Timeline/TimelineView+AIEditMenu.swift` | 06 §B9.1–B9.3, 05 §6.14, §7.5.6 | (c) | (b) BYOK providers (06 §B12); FLUX Enhance kept via the public FLUX.3 / Seedance 2.5 draft-enhance APIs (06 §B9.6) |
| Clip menu: Create Nested Timeline / Open Timeline / Decompose | `Timeline/TimelineView.swift:1498-1507` | 03 §8 | (a) | |
| Clip menu: Swap Media | `Timeline/TimelineView.swift:1518` | 03 §10.6 | (a) | |
| Clip menu: Save as Media / Save as Audio | `Timeline/TimelineView.swift:1524-1534` | 07 §6.3 | (b) | FFmpeg |
| Clip menu: Synchronize ▸ Auto/Audio/Timecode | `Timeline/TimelineView+SyncMenu.swift` | 03 §12.4, 07 §3.7, §6.0 | (b) | TS correlator + TS timecode reader |
| Clip menu: Detect/Redetect Beats, Mark Beats | `Timeline/TimelineView+BeatsMenu.swift` | 07 §3.4 | (b) | Beat This ONNX |
| Clip menu: Switch Angle/Mic, Layout ▸ (13 layouts), Ungroup Multicam | `Timeline/TimelineView.swift:1573,1648-1676` | 03 §12.3, 07 §5 | (a) | |
| Range menu: Add Range to Chat, Save Range as Media, Switch Angle in Range, Clear Range | `Timeline/TimelineView.swift:1631-1704` | 03 §6.4, 06 §A12.3, 07 §6.3 | (a)/(b) | Save Range uses the export pipeline |
| Gap menu: Create AI Transition | `Timeline/TimelineView.swift:1606`, `Editor/ViewModel/EditorViewModel+AITransition.swift` | 06 §B10, 05 §6.14 | (c) | (b) BYOK first+last-frame video model |
| Gap menu: Ripple Delete Gap | `Timeline/TimelineView.swift:1615` | 03 §4.7 | (a) | |
| Keyframe menu (Linear/Smooth/Hold, Delete), fade-knee menu (Linear/Smooth) | `Timeline/TimelineView.swift:1331-1409` | 03 §7, 05 §6.6 | (a) | |
| Dead-air span menu: Remove Dead Air | `Timeline/TimelineView.swift:1425` | 07 §3.3 | (b) | |
| External/internal drops (Finder files, subtitles → captions, ⌘ ripple insert) | `Timeline/TimelineView.swift:1914-2041` | 03 §4.3, 05 §6.13, 07 §1.8 | (b) | HTML5 DnD |
| Master audio meter | `Audio/AudioMeterView.swift`, `Audio/AudioMeter.swift` | 05 §6.12, 07 §3.8 | (b) | AudioWorklet peaks |
| Generating-clip shimmer, generating clips placed on the timeline, replace-in-place | `Timeline/ClipGeneratingOverlay.swift`, `Editor/ViewModel/EditorViewModel+GeneratedClips.swift` | 05 §6.5, 06 §B6.2 | (a) | |

### 8.5 Preview

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Transport (start, ±1 frame, play/pause, end), scrub bar | `Preview/PreviewContainerView.swift:148-161` | 05 §5.4–5.5 | (a) | |
| Playback speed menu (0.5×–10×; meter off at 4×/10×) | `Preview/PreviewPlaybackRate.swift` | 05 §5.6 | (a) | |
| Canvas zoom menu, ⌘-scroll zoom | `Preview/PreviewContainerView.swift:342-362`, `PreviewView.swift` | 05 §5.6 | (a) | |
| Canvas Guides (grids, safe zones, format references) | `Preview/CanvasViewingOverlay.swift` | 05 §5.6 | (a) | |
| Preview tabs with back/forward, Close All Tabs | `Preview/PreviewContainerView.swift:714-789`, `EditorViewModel+PreviewTabs.swift` | 05 §5.2 | (a) | |
| Capture Frame to Media | `Preview/PreviewContainerView.swift:205-218`, `EditorViewModel+FrameCapture.swift` | 07 §6.4 | (b) | GL readback / FFmpeg |
| Offline media overlay (Relink…, Relink Folder…, Report a Problem) | `Preview/PreviewContainerView.swift:605-645` | 03 §10.5, 05 §5.3 | (a)/(c) | "Report a Problem" → issue link |
| Generation Failed overlay (Retry Download) | `Preview/PreviewContainerView.swift:661-690` | 06 §B4.5, 05 §4.13 | (c) | (b) BYOK generation |
| Transform overlay, crop overlay, click-to-select hit testing | `Preview/TransformOverlayView.swift`, `CropOverlayView.swift`, `PreviewHitTester.swift` | 05 §5.7–5.8, 04 §5.9 | (a) | |
| Chroma key sampler | `Preview/ChromaKeySamplerOverlayView.swift`, `VideoEngine.swift:601-628` | 07 §6.6 | (b) | GL readback |
| Slip two-up | `Preview/SlipTwoUpView.swift` | 05 §5.9 | (a) | |
| Caption preview overlay | `MediaPanel/CaptionsTab/CaptionPreviewOverlay.swift` | 07 §1.10 | (a) | |
| Scrub audio | `Preview/ScrubAudioEngine.swift` | 05 §5, 04 §12 | (b) | Web Audio grains |
| Compositor (CompositionBuilder, FrameRenderer, effects, text, blend) | `Preview/*`, `Compositing/*` | 04 | (b) | WebGL2 |
| Lottie playback | `Preview/LottieVideoGenerator.swift` | 07 §4 | (b) | lottie-web |
| Still image → video, alpha normalizer, nest flattener | `Preview/ImageVideoGenerator.swift`, `AlphaVideoNormalizer.swift`, `NestFlattener.swift` | 04 §2.3, §3.2 | (b) | |
| Subtitle preview tab | `MediaPanel/CaptionsTab/SubtitlePreviewView.swift` | 07 §1.8 | (a) | |

### 8.6 Inspector

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Project Settings (Resolution, Frame Rate, Aspect, Custom…) | `Inspector/InspectorView.swift:155-305` | 05 §7.2, 03 §11 | (a) | |
| Media-asset inspector (Show Info: Type, Dimensions, Duration, Size, Path) | `Inspector/InspectorView.swift:906-971` | 05 §7.2b | (a) | |
| Generation Input section (prompt, copy, Draft, references strip) | `Inspector/InspectorView.swift:985-1166`, `Components/GenerationReferencesStrip.swift` | 05 §7.6, 06 §B5 | (a) display / (c) data origin | Linux jobs add `generationInput.byokJob` (06 §B5.2) |
| Video tab: Transform (Position, Scale, Rotation, Opacity + keyframes), Crop, Flip, Blend, Image Adjustment (Edge Softness/Rounding), Playback Speed | `Inspector/InspectorView.swift:442-854` | 05 §7.5.1, 03 §4.13–4.14 | (a) | |
| Adjust tab: Basic Correction, Curves, Color Wheels, Hue Curves, LUTs, Effects (Detail, Blur, Motion Blur, Vignette, Film Grain, Glow, Chroma Key, Invert) | `Inspector/Tabs/AdjustTab.swift`, `Components/Adjust/*` | 05 §7.5.2, 04 §8 | (a)/(b) | shaders per 04 |
| Adjust: Sample Key Color | `Inspector/Tabs/AdjustTab.swift:246-258` | 07 §6.6 | (b) | |
| Audio tab: Levels (Volume, Fade In/Out) | `Inspector/Tabs/AudioTab.swift:20-34` | 05 §7.5.3, 04 §10 | (a) | |
| Audio tab: Enhance ▸ Denoise (strength, states, failure text) | `Inspector/Tabs/AudioTab.swift:56-110`, `Audio/AudioEnhancer.swift` | 05 §7.5.3, 04 §10.5, 07 §3.6 | (b) | deep-filter (DFN3) |
| Text Content tab (content, font picker, traits, case, alignment, size/width/height/tracking/line spacing/color/blur, outline, shadow, background, fill mode, tilt) | `Inspector/Tabs/TextTab.swift`, `Components/TextStyleControls.swift`, `FontPickerField.swift` | 05 §7.5.4, 04 §9 | (a)/(b) | fontconfig font list |
| Text Animate tab (presets gallery, highlight; applies to the caption group) | `Inspector/Tabs/TextTab.swift:225-258` | 05 §7.5.5, 04 §9.8, 07 §1.7.8 | (a) | |
| Multicam tab (members, master star, sync %, unsynced warning) | `Inspector/Tabs/MulticamTab.swift` | 05 §7.5.7, 07 §5 | (a) | |
| AI Edit tab (Upscale, Edit, Rerun, Lip Sync, Reframe, Create Video, FLUX Enhance, Generate Music/SFX, Voice Cleanup, Dubbing; options) | `Inspector/Tabs/AIEditTab.swift` | 06 §B9.3, 05 §7.5.6 | (c) | (b) BYOK; disabled reason `Add a <Provider> API key to use this` |
| Keyframe controls, scrubbable fields, color field, crop aspect fields, reset rows | `Inspector/Components/*`, `UI/KeyframeControlStrip.swift` | 05 §7.6 | (a) | |

### 8.7 Media panel

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Tabs Media / Index / Captions / Audio | `MediaPanel/MediaPanelView.swift` | 05 §4.1 | (a) | |
| Import (button, panel, drag-drop, paste images/files) | `MediaPanel/MediaTab/MediaTab.swift:307,790-799`, `MediaPanelDropArea.swift`, `MediaTab+Drag.swift` | 03 §10.1, 05 §4.3, §4.9 | (b) | Electron dialogs / clipboard |
| View (Folders/Flat/Grouped), thumbnail size, sort, filter, breadcrumbs, item count, empty state | `MediaPanel/MediaTab/MediaTab.swift` | 05 §4.2–4.4 | (a) | |
| Asset/folder/timeline tiles and context menus (Move to Folder, Relink…, Rename, Reveal in Finder, Copy Path, Delete, Open, Duplicate, Expand/Collapse) | `MediaTab/AssetThumbnailView.swift`, `FolderTileView.swift`, `TimelineTileView.swift`, `MediaTab+Grids.swift` | 05 §4.5–4.7, 03 §10 | (a) | Reveal = `showItemInFolder` |
| Asset menu: Extract Audio | `MediaTab/AssetThumbnailView.swift:98` | 07 §6.3 | (b) | FFmpeg |
| Asset menu: AI Edit ▸ … (Paid) | `Generation/Edit/AIEditMenu.swift` | 06 §B9.3, 05 §4.5 | (c) | (b) BYOK; no "(Paid)" labels |
| Overflow ▸ New Folder, Create Matte (sheet) | `MediaTab/MediaTab.swift:597-612`, `MediaPanel/MatteSheet.swift` | 05 §4.12, 07 §6.5 | (b) | PNG writer |
| Overflow ▸ Organize with Agent | `MediaTab/MediaTab.swift:606` | 06 §A14, 05 §4.3 | (a) with a BYOK agent | |
| Swap-media banner | `MediaTab/MediaTab.swift:183-189` | 05 §4.12 | (a) | |
| Toasts | `MediaPanel/MediaPanelToast.swift` | 05 §4.12 | (a) | |
| Search: Moments (visual) | `MediaTab+Search.swift`, `Search/*` | 07 §2, 05 §4.10 | (b) | SigLIP2 ONNX |
| Search: Spoken (transcripts), Timelines, Files | `MediaTab+Search.swift`, `Transcription/TranscriptSearch.swift` | 07 §1.12, 05 §4.10 | (a)/(b) | needs local transcripts (whisper) |
| Smart search status (download/preparing/indexing/retry) | `MediaTab+IndexStatus.swift` | 07 §2.6 | (b) | model download from HF (onnx-community) |
| Index ▸ Transcript browser (source menu, search, jump to playhead, row click) | `IndexTab/IndexTab.swift`, `TranscriptBrowser.swift` | 07 §1.11 | (a) | |
| Index ▸ Transcript empty state → Transcribe | `IndexTab/IndexTab.swift:102-134` | 07 §1.9, §1.11 | (b) | whisper |
| Index ▸ Markers browser (status filter, color, status, delete, time/duration edit, comment, thumbnails) | `IndexTab/MarkerBrowser.swift` | 05 §4.14, 03 §6 | (a) | |
| Captions: Source, Mode Local/Cloud, Language, Max words/characters, Close gaps, Censor profanity | `CaptionsTab/CaptionTab.swift` | 07 §1.9 | (b) | Local = whisper; Cloud = BYOK STT (07 §1.6) |
| Captions: Style (shared text controls) + Position | `CaptionsTab/CaptionTab.swift:408-460` | 07 §1.9, 05 §7.5.4 | (a) | |
| Captions: Animation presets + Highlight | `CaptionsTab/CaptionPresetGallery.swift` | 07 §1.9, 05 §7.5.5 | (a) | |
| Captions: Generate (pipeline, gap closing, placement) | `EditorViewModel+Captions.swift`, `CaptionBuilder.swift`, `CaptionSpecBuilder.swift`, `CaptionTranscriptMapper.swift` | 07 §1.7 | (a) logic, (b) STT | |
| Captions: Agent menu (filler words, names, emoji, translate) | `CaptionsTab/CaptionTab.swift:506-538` | 07 §1.9, 06 §A14 | (a) with a BYOK agent | |
| Captions: cloud credit cost / "Transcribe · N credits" | `CaptionsTab/CaptionTab.swift:80-106,489-499` | 07 §1.9 | (d) | drop |
| Subtitle import (.srt/.vtt), drop → captions | `CaptionsTab/SubtitleFileParser.swift`, `EditorViewModel+Captions.swift:253-294` | 07 §1.8 | (a) | |
| Audio ▸ Music (Video/Text to Music, model, prompt, Generate, agent moods) | `MediaPanel/AudioPanelTab/MusicTab.swift`, `Generation/Submission/MusicGenerationSubmission.swift` | 06 §B8, 05 §4.14 | (c) | (b) BYOK music provider |
| Audio ▸ Speaker Detection (Mark Speakers, labels rename/color/remove, Identify/Refresh) | `MediaPanel/AudioPanelTab/SpeechTab.swift:16-106`, `EditorViewModel+Speakers.swift` | 07 §3.5 | (c) on Mac (cloud transcripts) | (b) local diarization (sherpa-onnx) |
| Audio ▸ Silence Detection (Mark Silence, Minimum Pause, Speech Padding, Remove) | `MediaPanel/AudioPanelTab/SpeechTab.swift:108-218` | 07 §3.3 | (b) | Silero ONNX |
| Generation panel (types, models, references, prompt, settings, Draft, submit, cost) | `Generation/UI/*` | 06 §B7, 05 §4.13 | (c) | (b) BYOK (06 §B12); drop credits; keep Draft where the bound provider has a draft flow (06 §B9.6) |

### 8.8 Export

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Export sheet: destination Video/Timeline/Palmier Project, timeline picker | `Export/ExportView.swift` | 04 §11.1, 05 §2.2 | (a) | |
| Video: H.264, H.265, ProRes, HEVC 10-bit HDR; resolutions; read-only fps; size estimate | `Export/ExportOptions.swift`, `ExportService.swift`, `HDRVideoExporter.swift` | 04 §11 | (b) | FFmpeg encoders |
| Timeline: XMEML (.xml) | `Export/XMLExporter.swift` | 07 §6.1, 04 §11.7 | (a) | pure TS |
| Timeline: FCPXML (.fcpxml) with For (Resolve/FCP) and Version (1.10–1.14) | `Export/FCPXMLExporter.swift` | 07 §6.2, 04 §11.8 | (a)/(b) | font family via fontconfig |
| Source timecode reading (tmcd, Sony rtmd, BWF) | `Utilities/SourceTimecode.swift` | 07 §6.0 | (b) | TS box parser |
| Palmier Project export (bundled media) | `Export/PalmierProjectExporter.swift` | 04 §11.9, 01 §1.10 | (a) | |
| Export queue (statuses, cancel, remove, clear finished, reveal) | `Export/ExportQueue.swift`, `ExportView.swift:308-452` | 04 §11.2, 05 | (a) | |
| Export analytics snapshot | `Export/ExportTimelineAnalyticsSnapshot.swift` | — | (d) | drop |

### 8.9 Settings

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Account pane (plans, credits, top-off, portal, sign out) | `Settings/AccountPane.swift`, `Account/*` | 05 §11.2 | (d) | remove |
| General: Language, restart prompt | `Settings/GeneralPane.swift` | 05 §11.3 | (a) | `app.relaunch()` |
| General: Notifications | `Settings/NotificationsPane.swift` | 05 §11.3 | (b) | Electron Notification |
| General: Privacy & Diagnostics (usage data, crash reports) | `Settings/PrivacyPane.swift` | 05 §11.3 | (d) | remove |
| Appearance: Theme, Workspace layout, Timeline colors | `Settings/AppearancePane.swift`, `TimelineColorsPane.swift` | 05 §11.4 | (a) | |
| Models pane (server catalog, enable switches) | `Settings/ModelsPane.swift` | 05 §11.5, 06 §B1.4, §B12.3 | (c) | (b) "Models & API Keys" over the bundled catalog (`06-generation-catalog.json`) |
| Agent pane: AI Chat BYOK keys | `Settings/AgentPane.swift:131-259` | 05 §11.5, 06 §A1.3 | (b) | `safeStorage` instead of Keychain |
| Agent pane: MCP server toggle/status | `Settings/AgentPane.swift:40-100` | 05 §11.6, 02 §1 | (a) | |
| Skills pane (installed/community, new, edit, install/update, delete, add to external agent) | `Settings/Skill/*`, `Agent/Skills/*` | 05 §11.7, 02 §5 | (a) | GitHub raw fetch is third-party, allowed |
| Storage: Temporary files (Clear cache) | `Settings/StoragePane.swift:22-54` | 05 §11.8, 07 §0.4 | (a) | Linux cache dirs |
| Storage: Media indexing toggle, Clear index, Remove model | `Settings/StoragePane.swift:56-107` | 07 §2.7 | (b) | ONNX model dir only |
| Storage: speech/audio model rows (Linux addition) | — | 07 §2.7, §0.2 | (b) | new |

### 8.10 Agent and MCP

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Agent panel: chat tabs, history, starter prompts, model + reasoning pickers, input with @mentions, drops, message view, stop | `Agent/Panel/*` | 06 §A11–A12, 05 §2.6 | (a) UI | |
| Hosted agent (Palmier `/v1/agent/stream`, sign-in, credits) | `Agent/Clients/PalmierClient.swift` | 06 §A1.3, §A10, 05 §11.5 | (c) | BYOK only |
| BYOK agent (Anthropic Messages / OpenAI Responses) | `Agent/Clients/BYOKClient.swift`, `AnthropicProvider.swift`, `OpenAIProvider.swift`, `AgentClientTypes.swift` | 06 §A1, §A6–A7 | (a) | |
| Agent run loop, system prompt + skills index, mention context, inline images, stream presentation buffer | `Agent/Chat/AgentService.swift`, `AgentMentionContext.swift`, `AgentStreamPresentationBuffer.swift`, `Agent/Tools/AgentInstructions.swift`, `Utilities/ImageEncoder.swift` | 06 §A3–A5, §A9 | (a) | |
| Chat persistence in package | `Agent/Chat/ChatSessionStore.swift` | 06 §A2, 01 §5.15 | (a) | |
| MCP HTTP server 127.0.0.1:19789 + tools (all 50) | `Agent/MCP/*`, `Agent/Tools/*` | 02 | (a)/(b)/(c) per tool | NEEDS-ML tools → 07 replacements; generation tools → BYOK (06 §B13); in-app executor mode 06 §A8 |
| Skills catalog sync (GitHub raw) / store `~/.palmier/skills` | `Agent/Skills/SkillCatalog.swift`, `SkillStore.swift` | 02 §5, 05 §11.7, 06 §A13 | (a) | |

### 8.11 Media intelligence, analysis and extras (this document)

| Feature | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Local transcription (SpeechAnalyzer) | `Transcription/Transcription.swift` | 07 §1.4–1.5 | (b) | whisper.cpp v1.9.5 + large-v3-turbo-q5_0 |
| Cloud transcription (Convex) | `Transcription/CloudTranscription.swift`, `TranscriptionBackend.swift` | 07 §1.6 | (c) | (b) BYOK ElevenLabs/Deepgram/OpenAI |
| Transcript cache | `Transcription/TranscriptCache.swift` | 07 §1.3 | (a) | |
| Word cut planner (remove_words) | `Transcription/WordCutPlanner.swift` | 07 §1.13, 02 §3.34 | (a) | |
| Visual search index (SigLIP2, frame sampler, embedding store) | `Search/*` | 07 §2 | (b) | ONNX |
| Search model download (HF palmier-io CoreML) | `Search/Models/ModelDownloader.swift` | 07 §2.2, §0.2 | (b) | HF onnx-community, pinned |
| VAD (Silero v5 MLX) | `Audio/Analysis/VoiceActivity.swift` | 07 §3.2 | (b) | Silero v5.1.2 ONNX |
| Speaker fingerprints (WeSpeaker MLX) | `Audio/Analysis/SpeakerIdentity.swift` | 07 §3.5 | (b) | WeSpeaker ONNX via sherpa-onnx |
| Denoise (DeepFilterNet3 CoreML/MLX) | `Audio/AudioEnhancer.swift` | 07 §3.6 | (b) | deep-filter CLI |
| Beat detection (Beat This small0 CoreML) | `Audio/Beats/BeatDetector.swift` | 07 §3.4 | (b) | self-exported ONNX |
| Audio sync correlator, envelopes, waveform extractor | `Audio/AudioSyncCorrelator.swift`, `AudioEnvelope.swift`, `WaveformExtractor.swift` | 07 §3.1, §3.7 | (a) | TS DSP |
| Multicam member sync | `EditorViewModel+Multicam.swift:124-255` | 07 §5.2 | (a) | |
| Multicam creation (agent only) | `Agent/Tools/ToolExecutor+Multicam.swift` | 02 §3.29, 03 §12.2 | (a) | |
| Lottie import/inspect/render | `Preview/LottieVideoGenerator.swift` | 07 §4 | (b) | lottie-web |
| Save as Media / Audio / Extract Audio / Save Range | `EditorViewModel+SaveAsMedia.swift` | 07 §6.3 | (b) | FFmpeg |
| Capture frame | `EditorViewModel+FrameCapture.swift`, `Preview/FrameCaptureRenderer.swift` | 07 §6.4 | (b) | |
| Solid mattes | `Models/Matte.swift`, `EditorViewModel+Matte.swift` | 07 §6.5 | (b) | |
| Chroma key sampler | `EditorViewModel+ChromaKey.swift` | 07 §6.6 | (b) | |
| Person segmentation / background removal | — | 07 §6.7 | n/a | **not in source** |
| SRT/VTT export | — | 07 §1.8 | n/a | **not in source** |

### 8.12 Internal modules and resources (no menu item of their own)

| Feature / module | Mac source | Spec | Class | Linux note |
|---|---|---|---|---|
| Model catalog subscription, capability decoding, derived flags, validation messages, model enable switches | `Generation/Catalog/ModelCatalog.swift`, `VideoModelConfig.swift`, `ImageModelConfig.swift`, `AudioModelConfig.swift`, `UpscaleModelConfig.swift`, `ModelPreferences.swift` | 06 §B1–B2, §B12.5 | (c) catalog source | (b) bundled `06-generation-catalog.json`; the config logic itself is (a) |
| Credit cost estimates and affordability gate | `Generation/Catalog/CostEstimator.swift` | 06 §B11 | (c) | drop |
| Generation job service: placeholders, upload, submit, monitor, download/install, resume | `Generation/GenerationService.swift`, `Generation/GenerationBackend.swift` | 06 §B0, §B4–B6 | (c) | (b) provider adapters (06 §B12) + `generationInput.byokJob` resume (06 §B5.2) |
| Submission builders (video, image, audio, music; reference slots and validation) | `Generation/Submission/*` | 06 §B1.3, §B3, §B4.3, §B8 | (a) | uploads go through the provider adapter |
| Reference preprocessing (trim extract, reference downscale, H.264 transcode, HEIC/TIFF → JPEG, audio-track extract) | `Generation/Preprocessing/*` | 06 §B4.6 | (b) | FFmpeg / `sharp` |
| AI Edit actions, availability, seeds, upscale/audio-transform submitters | `Generation/Edit/*`, `Editor/ViewModel/EditorViewModel+AIEdit.swift` | 06 §B9 | (c) | (b) BYOK |
| Generate panel views (drop zones, reference controls, prompt tags, settings popover, upscale settings) | `Generation/UI/*` | 06 §B7, 05 §4.13 | (c) | (b) BYOK |
| Backend configuration (Convex/Clerk URLs), staged uploads, backend errors | `Backend/BackendConfig.swift`, `Backend/BackendStorage.swift`, `Backend/BackendError.swift` | 06 §B0, 07 §7.1 | (c) | drop; provider uploads replace `BackendStorage` (06 §B12.2); samples come from bundled packages (07 §7.1) |
| Compositor, effect registry, colour wheels/scopes, LUT loader, text renderer/animator, text tilt | `Compositing/*.swift` | 04 §2–§9 | (b) | WebGL2 + Canvas2D (04 §1) |
| Core Image / Metal kernels: chroma key, clarity, edge rounding, glow, grade curves, grain, highlights/shadows, hue curves, levels, tetrahedral LUT, vignette, wheels; `CIKernelLoader` | `Compositing/Kernels/*` (+ repo-root `Metal/*.metal`) | 04 §8.3–§8.23 | (b) | GLSL ports |
| Editor-panel primitives (`EditorPanelGroup`, `EditorActionFooter` incl. the "Agent Mode" menu, panel controls) | `UI/EditorPanel/*` | 05 §3.4, 06 §A14 | (a) | |
| Shared UI primitives (hover highlight, tooltips, capsule buttons, tab strip, search field, provider logos, inline rename, radio, timeline clip colours, theme) | `UI/*` | 05 §1, §3 | (a) | |
| Disk-cache helpers, file IO, async semaphore, JSON number formatting, constants | `Utilities/DiskCache.swift`, `FileIO.swift`, `AsyncSemaphore.swift`, `JSONNumberFormatting.swift`, `Constants.swift` | 01 §2.2, §3, 07 §0.4 | (a) | |
| Timecode formatting | `Utilities/TimeFormatting.swift` | 05 §5.5 | (a) | |
| Keychain store for API keys | `Utilities/KeychainStore.swift` | 05 §11.5 | (b) | Electron `safeStorage` (`src/main/settings.ts`) |
| MLX inference gate and termination wait | `Utilities/MLXRuntime.swift` | 07 §3.9 | (b) | ML utility processes + scheduler lanes |
| Inline-image encoder for the agent | `Utilities/ImageEncoder.swift` | 06 §A5.3 | (b) | `sharp` |
| Bundled font registration and resource lookup | `Utilities/BundledFonts.swift`, `Utilities/BundledResource.swift` | 05 §12.1, 07 §0.2 | (b) | fontconfig/`FontFace`; one resource resolver (`process.resourcesPath`) |
| `AVVideoComposition` configuration | `Utilities/AVVideoComposition+Configuration.swift` | 04 §1 | (b) | WebGL2 compositor |
| Persisted data model | `Models/*` | 01 §5 | (a) | |
| Runtime language selection and string lookup | `Localization/*` | 05 §11.3 | (a) | |
| Bundled fonts (13 families) | `Resources/Fonts/*` | 05 §12.1 | (a) | ship the same font files (check each licence) |
| Localized strings (28 `.lproj`: `Localizable.strings`, `InfoPlist.strings`) | `Resources/Localization/*` | 05 §11.3 | (a) | convert to JSON at build time |
| Images: tour hero, welcome illustration, agent logos (Claude, Codex, Cursor), 21 provider lab logos | `Resources/Images/*` | 05 §12.2, 07 §7.3 | (a) | |
| What's New data | `Resources/Changelog/changelog.json` | 07 §7.5 | (a) | Linux changelog in the same format |
| Claude Desktop extension bundle | `Resources/MCPB/palmier-pro.mcpb` | 02 §1.11, 05 §10.4 | (b) | rebuild; Claude Desktop has no official Linux build |
| Beat This model | `Resources/Models/BeatThis.mlmodelc` | 07 §3.4 | (b) | self-exported ONNX |
| App icon | `Resources/AppIcon.icon` | 05 §12.2 | (b) | PNG hicolor set for the `.desktop` file |

### 8.13 Directory coverage index

Every directory under `Sources/PalmierPro/` (v0.7.6), and where its user-visible features are listed. Deeper `Resources/` sub-folders (font families, `.lproj` folders, icon assets, the compiled model bundle) are covered by their parent row.

| Directory | Checklist rows | Main specs |
|---|---|---|
| `Account/` | 8.2 (sign-in strip), 8.3 (avatar), 8.9 (Account pane) | 05 §11.2 — (d) |
| `Agent/` (root), `Agent/Chat/`, `Agent/Clients/`, `Agent/Panel/` | 8.10 | 06 Part A, 01 §5.15 |
| `Agent/MCP/`, `Agent/Tools/` | 8.10, 8.4 (Add to Chat), 8.7 (agent hand-offs) | 02, 06 §A8, §B13 |
| `Agent/Skills/` | 8.9 (Skills pane), 8.10 | 02 §5, 05 §11.7, 06 §A13 |
| `App/` | 8.1 | 05 §9, §12; 07 §7.5 |
| `Audio/`, `Audio/Analysis/`, `Audio/Beats/` | 8.4 (meter, beats, dead air, speakers), 8.6 (Denoise), 8.7 (Speech tab), 8.11 | 07 §3 |
| `Backend/` | 8.12 | 06 §B0, 07 §7.1 — (c) |
| `Compositing/`, `Compositing/Kernels/` | 8.5 (compositor), 8.6 (Adjust), 8.12 | 04 §2–§9 |
| `Editor/`, `Editor/ViewModel/` | 8.3, and the feature rows that cite `EditorViewModel+*.swift` | 03, 06, 07 |
| `Editor/Tour/` | 8.2 | 07 §7.3 |
| `Export/` | 8.8 | 04 §11, 07 §6.1–6.2 |
| `Generation/`, `Generation/Catalog/`, `Generation/Edit/`, `Generation/Preprocessing/`, `Generation/Submission/`, `Generation/UI/` | 8.4 (AI Edit, AI Transition), 8.6 (AI Edit tab), 8.7 (Generation panel, Music), 8.12 | 06 Part B |
| `Help/` | 8.1, 8.2 | 05 §10, 07 §7.4 |
| `Home/`, `Home/Onboarding/` | 8.2 | 05 §8, 07 §7.1–7.2 |
| `Inspector/`, `Inspector/Components/`, `Inspector/Components/Adjust/`, `Inspector/Tabs/` | 8.6 | 05 §7, 04 §8–§10 |
| `Localization/` | 8.1, 8.12 | 05 §11.3 |
| `MediaPanel/` (root, incl. `MatteSheet.swift`, toasts) | 8.7 | 05 §4, 07 §6.5 |
| `MediaPanel/AudioPanelTab/` | 8.7 (Audio ▸ Music, Speaker Detection, Silence Detection) | 06 §B8, 07 §3.3, §3.5 |
| `MediaPanel/CaptionsTab/` | 8.5 (caption preview, subtitle preview), 8.7 (Captions rows) | 07 §1.7–1.10 |
| `MediaPanel/IndexTab/` | 8.7 (Index ▸ Transcript, Markers browser) | 07 §1.11, 05 §4.14 |
| `MediaPanel/MediaTab/` | 8.7 | 05 §4, 07 §2.5–2.6 |
| `Models/` | 8.12 | 01 |
| `Preview/` | 8.5 | 04, 05 §5, 07 §4, §6.4, §6.6 |
| `Project/`, `Project/Settings/` | 8.2 (samples, recents), 8.3 (autosave, settings sheets) | 01 §1–§2, 03 §11, 07 §7.1 |
| `Resources/` (`AppIcon.icon`, `Changelog`, `Fonts`, `Images`, `Localization`, `MCPB`, `Models`) | 8.12 | 05 §11.3, §12; 02 §1.11; 07 §3.4, §7.5 |
| `Search/`, `Search/Indexing/`, `Search/Models/`, `Search/Query/` | 8.7 (Moments search, status), 8.9 (Storage), 8.11 | 07 §2 |
| `Settings/`, `Settings/Skill/` | 8.9 | 05 §11 |
| `Telemetry/` | 8.1 | — (d) drop |
| `Timeline/` | 8.4 | 03, 05 §6 |
| `Toolbar/` | 8.3 | 05 §2.5, 03 §15 |
| `Transcription/` | 8.7 (Spoken search, Captions), 8.11 | 07 §1 |
| `UI/`, `UI/EditorPanel/` | 8.12 | 05 §1, §3 |
| `Utilities/` | 8.1 (crash log), 8.8 (timecode reader), 8.12 | 01 §2.2, 07 §0.4, §3.9, §6.0 |

---

## 9. Open questions

1. **Local "Auto" language.**
   - On the Mac, Local + Auto = the OS preferred language (no detection).
   - Whisper can auto-detect, which is strictly more useful, but differs from the Mac.
   - This spec defaults to parity (`transcription.localAutoDetect = false`). Product should confirm.
2. **Whisper model default and footprint.**
   - `large-v3-turbo-q5_0` (574 MB download, ~1 GB RAM) vs `small` (488 MB, faster on weak CPUs, noticeably worse accuracy).
   - Needs a CPU benchmark on target hardware: real-time factor ≤ 0.5 on a 4-core laptop?
   - Decide whether to expose the model picker in Settings ▸ Storage.
3. **Word timing accuracy.**
   - Whisper timestamp-token offsets are coarser than Apple's per-run audio ranges. This affects per-word caption animations.
   - Decide whether to enable `--dtw` (needs `-nfa`, slower). In the smoke test, DTW times sat 0.3–0.4 s after the offsets.
   - Validate against a forced-alignment reference before choosing.
4. **Profanity redaction format.** The exact output of Apple's `.etiquetteReplacements` (e.g. `f***` vs `****`) is unverified. Check on a Mac and match it.
5. **Cloud provider choice for BYOK.**
   - ElevenLabs Scribe (word times + speakers + language) is the recommended default.
   - Confirm acceptable provider(s) and where keys live (05 §11.5 "Generation Providers" vs a new "Speech" row).
6. **Speaker centroid compatibility.**
   - Mac WeSpeaker MLX (Hamming-window fbank) vs Linux sherpa WeSpeaker ONNX (Kaldi Povey fbank).
   - Measure cosine between the two for the same snippets.
   - If below ~0.8, add a `model` tag to new registry entries. This needs a data-model change; 01 says the registry has no model field.
7. **Local diarization quality** (sherpa pyannote-3.0 + WeSpeaker, threshold 0.5) vs Palmier Cloud's labels. Tune the threshold on podcast/interview fixtures.
8. **SigLIP 2 int8 vs Mac 8-bit palettized.** Both should pass cosine ≥ 0.99 vs fp32. Verify; the fallback is fp16 (751 MB). Separately, decide whether to lower-case queries (better recall per HF guidance) at the cost of Mac parity.
9. **Beat This ONNX export.** Confirm that `torch.onnx.export` handles the folded `LogMelSpect` (STFT) at opset 17 and that the patched model passes the two parity gates. Otherwise ship the TS mel frontend.
10. **AVAssetReader mono downmix.** Is it a plain channel mean? It affects VAD, beats and envelopes slightly. The spec uses an explicit mean (`pan`) everywhere.
11. **`deep-filter` output is 16-bit.** Acceptable, or should the port use the DFN3 ONNX graphs directly (enc/erb_dec/df_dec) with a TS DSP front end to keep float output and per-channel processing?
12. **Bundled sample project.** Is there license-clean media for one Linux sample (§7.1), or should the strip be hidden entirely?
13. **Feedback destination.** Set the GitHub repo URL for `feedbackIssueURL` (§7.4).
14. **glibc floor.** The official whisper binary needs glibc ≥ 2.34. Is Ubuntu 20.04 / Debian 11 support required? If so, CI builds whisper on an older image.
15. **Speech-to-text keys.** `AppSettings.apiKeys` currently holds `fal, replicate, openai, anthropic, elevenlabs`. ElevenLabs Scribe and OpenAI `whisper-1` reuse existing keys; Deepgram needs a new key slot. Decide whether Deepgram ships in v1.
16. **Order of work.** §1 (whisper + captions) unlocks the agent tools `get_transcript`, `add_captions`, `remove_words` and spoken search; §3.2 (VAD) unlocks dead air, `remove_silence` and speaker masks. Build those before SigLIP search, beats and denoise.

## 10. Quirk register (Mac behaviour reproduced on purpose)

| # | Quirk | Where | Port decision |
|---|---|---|---|
| Q1 | Local "Auto" language = system language, not detection | `Transcription.swift:148-156` | reproduce (default) |
| Q2 | Forced locale or censor bypasses the transcript cache and never stores | `TranscriptCache.swift:16-21`, `EditorViewModel+Captions.swift:493-497` | reproduce |
| Q3 | Transcript memory cache clears **all** entries when full (4) | `TranscriptCache.swift:119-122` | reproduce |
| Q4 | Spoken search reads only **local full** transcripts, never cloud ones | `TranscriptSearch.swift:18` | reproduce |
| Q5 | Captions tab defaults to Cloud | `CaptionTab.swift:17,215` | **deviate**: default Local on Linux |
| Q6 | A caption job silently skips files that failed, unless all failed | `EditorViewModel+Captions.swift:521-530` | reproduce |
| Q7 | Search tooltip size = image+text encoder bytes only (tokenizer excluded) | `MediaTab+IndexStatus.swift:38-41` | reproduce with ONNX bytes |
| Q8 | "Remove model" deletes the entire Models directory | `VisualModelLoader.swift:88-94` | **deviate**: search subdir only |
| Q9 | Clear cache skips `BeatAnalysis` (and `LottieVideos`) | `StoragePane.swift:117` | reproduce for BeatAnalysis |
| Q10 | Lottie bake cache key ignores file changes | `LottieVideoGenerator.swift:80-82` | n/a (no bake on Linux) |
| Q11 | XMEML exports Lottie clips as files (they resolve) and drops text (no URL) | `XMLExporter.swift:534-543` | reproduce |
| Q12 | FCPXML title `fontSize` applies `fontScale` twice (`scaledVisualStyle` then ×fontScale) | `FCPXMLExporter.swift:876-885` | reproduce (golden parity) |
| Q13 | XMEML fade `cutPointTicks` uses integer `254016000000 / fps` | `XMLExporter.swift:411` | reproduce |
| Q14 | Speaker centroids are never updated after creation | `SpeakerIdentity.swift:73-92` | reproduce |
| Q15 | Speaker identification uses only cloud transcripts | `EditorViewModel+Speakers.swift:97-118` | **deviate**: local diarization fallback |
| Q16 | Multicam creation has no UI (agent only) | `ToolExecutor+Multicam.swift` | reproduce |
| Q17 | Save as Media time-stretches without pitch preservation | `EditorViewModel+SaveAsMedia.swift:276-296` | reproduce (`asetrate`) |
| Q18 | Mattes and Save-as-Media assets create no undo entry; Capture Frame does ("Capture Frame") | §6.3–6.5 | reproduce |
| Q19 | Beat detection never runs automatically; only cached results hydrate | `BeatStore.swift:34-61` | reproduce |
| Q20 | VAD runs automatically for every audio-bearing asset even when Mark Silence is off | `MediaVisualCache.swift:82-85` | reproduce (needed for speakers and dead air) |
