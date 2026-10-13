# 02 — MCP server and tool contracts

Status: port contract for the Linux (Electron + TypeScript) build of Palmier Pro.
Source of truth: `palmier-pro/Sources/PalmierPro/Agent/MCP/*.swift`, `Agent/Tools/*.swift`, `Agent/Skills/*.swift`, `mcpb/`, plus the MCP Swift SDK `modelcontextprotocol/swift-sdk` 0.12.0 (resolved in `Package.resolved`), whose HTTP transports Palmier uses.

This document specifies the **agent-facing contract**: transport, tool names, descriptions, schemas, validation rules, result shapes, and error texts. The internals of the domain operations it names (`placeClip`, `clearRegion`, `rippleDeleteRangesOnTrack`, `applyTimelineSettings`, the compositor, the export queue, and so on) belong to the sibling specs: `01-data-model.md` (models), `03-editor-ops.md` (editing operations and undo), and `04-rendering-export.md` (compositing and export).

How the verbatim parts were produced: every tool description, input schema, and the server instructions were obtained by evaluating the Swift literals with Swift's own rules (escape processing, multiline-string indentation stripping, `\` line continuations, string interpolation, and the constants the schemas reference such as `VolumeScale.floorDb`, `BlendMode.allCases`, and `EffectRegistry`). Treat the fenced blocks below as the contract. A machine-readable copy of all 52 tool definitions (50 MCP + 2 in-app-only) and the instruction strings is in `02-mcp-tools.tools.json`, next to this file.

Conventions in this document:

- "Error" means a tool result with `isError: true` and one text block holding the message. It is not a JSON-RPC error.
- Error strings are quoted as Swift builds them. `\(x)` placeholders are written as `<x>`. Swift prints a `Double` with a trailing `.0`, for example `-60.0`.
- "Mutation delta" means the shared receipt shape in §2.3.
- Key order in JSON does not matter. The Swift server serializes every JSON-RPC message, and every tool payload, with sorted keys.

---

## 1. Transport and protocol

### 1.1 Endpoint

| Item | Value |
|---|---|
| Bind address | `127.0.0.1` only (IPv4 loopback; never the LAN). `allowLocalEndpointReuse = true`. |
| Port | `19789` (`MCPService.port`). Fixed, not configurable. |
| MCP path | `POST/GET/DELETE /mcp`. `/` is accepted as an alias. The query string is ignored. |
| Advertised URL | `http://127.0.0.1:19789/mcp` |
| Enabled preference | UserDefaults key `io.palmier.pro.mcp.enabled` (default **true** when unset). The server starts at app launch when enabled. |
| Transport | MCP "Streamable HTTP": stateful sessions with SSE responses, plus a stateless JSON fallback for clients that send no session header. |
| Auth | None. `GET /.well-known/oauth-protected-resource` returns `200 {"resource":"http://127.0.0.1:19789"}` (`Content-Type: application/json`, keep-alive), so OAuth-probing clients find no authorization server and continue without auth. |
| Other paths | `404 Not Found` with an empty body, and the connection closes. |

HTTP/1.1 framing, which a hand-rolled server must reproduce. In Node, `http.createServer` already covers most of it.

- The server reads until it has `\r\n\r\n` plus `Content-Length` bytes. A missing `Content-Length` means a body length of 0.
- The total request limit is 16 MiB (16,777,216 bytes). Headers without a terminating blank line beyond 64 KiB are rejected. A malformed or oversized request gets `400 Bad Request`, `Content-Length: 0`, and the connection closes.
- The request line is `METHOD PATH ...`. Header names are matched case-insensitively. The body is decoded as UTF-8.
- Non-SSE responses carry `Content-Length` and `Connection: keep-alive`, and the connection keeps reading further requests.
- SSE responses send `HTTP/1.1 200 OK`, the transport headers, and then `Connection: close`. The server streams events until the stream finishes and then closes the TCP connection. No chunked encoding is used: the connection close delimits the body.
- Status texts are 200 OK, 202 Accepted, 400 Bad Request, 404 Not Found, 405 Method Not Allowed, 409 Conflict, and 500 Internal Server Error. Any other code gets "Unknown". The SDK also emits 403, 406, 415, and 421, which get "Unknown" as their reason phrase.

### 1.2 Routing and sessions (`MCPHTTPServer.handle`)

Routing for a request on `/mcp` or `/`:

1. **The request has an `Mcp-Session-Id` header** (case-insensitive; the server emits it as `MCP-Session-Id`).
   - **The ID is unknown or expired:** the server returns `404 Not Found` with an empty body and keeps the connection alive. The client must re-initialize, which also refreshes its tool inventory.
   - **The ID is known:** the server updates the session's `lastUsed` and passes the request to that session's stateful transport.
     - A `DELETE` that returns 200 removes the session.
     - A `GET` that returns 200 opens the standalone SSE stream. The first time a session opens this stream, the server sends one `notifications/tools/list_changed` on it. If that send fails, it is retried on the next GET attach.
2. **There is no session header, and the request is a `POST` whose JSON body has `"method":"initialize"`.**
   - The server creates a new session: a fresh `Server` and `ToolExecutor`, and a `StatefulHTTPServerTransport` with the validators `[Origin(localhost, port 19789), ContentType, ProtocolVersion, Session]`.
   - The initialize response carries the new `MCP-Session-Id` (a UUID). If the response does not include one (validation failed), the transport is discarded and the error response is returned.
   - Before a new session is stored, the server prunes sessions idle for more than **3600 s**, then evicts the least-recently-used sessions until fewer than **32** remain. Evicted clients get 404 on their next request and re-initialize.
3. **Anything else without a session header** (for example plain `curl`, or a sessionless client) goes to a single shared **stateless** pair: one `Server`, one `ToolExecutor`, and one `StatelessHTTPServerTransport` with validators `[Origin, ContentType, ProtocolVersion]`.
   - Responses are plain `application/json`.
   - The Server runs non-strict, so `tools/list` and `tools/call` work without a prior `initialize`.
   - The fallback executor binds to the frontmost project at the moment the fallback is first created (see §1.6).

Per-session behaviour of the stateful transport (SDK 0.12.0):

| Request | Behaviour |
|---|---|
| `POST` JSON-RPC **request** (has `id`) | `200`, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `MCP-Session-Id`. If the negotiated protocol version is ≥ `2025-03-26`, a priming event comes first: `id: <requestId>_<n>\ndata: \n\n`. The response follows as `id: <requestId>_<n>\nevent: message\ndata: <json>\n\n`, and the stream closes. |
| `POST` notification or response | `202 Accepted`, no body, with `MCP-Session-Id`. |
| `POST` initialize on an already-initialized session | `400`, "Bad Request: Session already initialized". |
| `GET` | Standalone SSE stream for server-initiated messages (`tools/list_changed`), with the same priming rule. A second concurrent GET gets `409` ("Conflict: Only one SSE stream is allowed per session"). `Last-Event-ID` replays stored events; an unknown ID gets 400. |
| `DELETE` | Terminates the session and returns `200` with no body. |
| Other methods | `405` with `Allow: GET, POST, DELETE`. |
| Empty or invalid body | `400` (JSON-RPC parse error body). |

Validation errors return a JSON body `{"jsonrpc":"2.0","error":{"code":<int>,"message":"<text>"},"id":null}` and include `MCP-Session-Id` when one is known:

| Validator | Failure |
|---|---|
| Host | If a `Host` header is present, it must match `127.0.0.1:19789`, `localhost:19789`, or `[::1]:19789`. Otherwise `421` "Misdirected Request: Host header not allowed". |
| Origin | If an `Origin` header is present, it must be `http://127.0.0.1:19789`, `http://localhost:19789`, or `http://[::1]:19789`. Otherwise `403` "Forbidden: Origin not allowed". |
| Content-Type | Applies to POST only. The main type must be `application/json`, otherwise `415`. |
| Protocol version | Skipped for initialize. If an `MCP-Protocol-Version` header is present, it must be one of the supported versions, otherwise `400`. An absent header is accepted. |
| Session | Stateful transport only. A missing header gets `400`; a mismatched one gets `404`. |
| Accept | **Not validated.** Palmier deliberately omits the SDK's Accept validator. |

### 1.3 Protocol version and lifecycle

- Supported versions are `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`. If the client requests a supported version, the server echoes it; otherwise it answers with `2025-11-25`.
- Supported JSON-RPC methods are `initialize`, `ping`, `notifications/initialized`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`. Anything else (`prompts/*`, `resources/templates/list`, `logging/*`, `completion/*`) gets JSON-RPC error `-32601` "Unknown method: <method>".
- A second `initialize` on the same Server gets an error ("Server is already initialized").
- Client info (`name`, `title`, `version`, `description`, `websiteUrl`) is captured at initialize, but only for analytics. It has no functional effect.

**`initialize` result:**

```json
{
  "protocolVersion": "<negotiated>",
  "capabilities": {
    "resources": { "subscribe": false, "listChanged": false },
    "tools": { "listChanged": true }
  },
  "serverInfo": { "name": "palmier-pro", "version": "1.0.0" },
  "instructions": "<AgentInstructions.serverInstructions + AgentInstructions.projectNavigation — verbatim in §4.1>"
}
```

No `prompts`, `logging`, or `completions` capability is declared. `serverInfo.title` is not set.

### 1.4 Resources

Two static resources are listed by `resources/list`. There are no resource templates and no subscriptions.

| name | uri | description | mimeType |
|---|---|---|---|
| `Video Models` | `palmier://models/video` | `Available AI video generation models and their capabilities` | `application/json` |
| `Image Models` | `palmier://models/image` | `Available AI image generation models and their capabilities` | `application/json` |

`resources/read` returns `{contents:[{uri, mimeType:"application/json", text:"<JSON array>"}]}`.

- The array holds `videoModelInfo` or `imageModelInfo` objects (shapes in `list_models`, §3.44), but **without** the `type` key.
- It covers **all** catalog models. Unlike `list_models`, it does not filter by plan.
- The JSON uses sorted keys and **no** 3-decimal rounding.
- An unknown URI is not an error: the server returns `{contents:[{uri, text:"Unknown resource: <uri>"}]}` with no mimeType.

### 1.5 Tools: listing and call mapping

`tools/list` returns 50 tools in this order: `ToolDefinitions.all` (49 tools, in the order of §3), followed by `manage_project`.

- Each tool is `{name, description, inputSchema}`. There are no `annotations`, `title`, `outputSchema`, or `_meta` fields, and no pagination cursor.
- `read_skill` and `manage_skills` exist only for the in-app agent and are **not** exposed. Calling them over MCP returns the error `Unknown tool: read_skill`.
- `tools/list_changed` is only the one-time announce on GET-stream attach. The list never actually changes at runtime.

`tools/call` (`MCPService.dispatchCall` → `ToolExecutor.execute(name:args:source:"mcp")` → `ToolResult.toMCPResult()`):

- `params.arguments` defaults to `{}` when absent. MCP values convert to plain JSON values: int → Int, double → Double, bool, string, null → NSNull, array, object.
- The result is a `CallToolResult` with `content` only: an ordered list of blocks, each either `{type:"text", text}` or `{type:"image", data:<base64>, mimeType}`.
- `isError: true` is present only on failure; on success the field is **omitted**, not `false`. There is **no `structuredContent`**: every structured payload is a JSON string inside a text block.
- Every tool failure is returned as a successful JSON-RPC response with `isError: true` and a single text block. The executor never throws a JSON-RPC error for tool-level problems.

### 1.6 Per-session executor state and the project-focus guard

Every MCP session, and the shared stateless fallback, owns one `ToolExecutor` holding:

- `boundProject`: the frontmost open project when the session was created. It can be `nil`, and `manage_project open|create|close` rebinds it.
- `lastTranscriptSession`: used by `remove_words` (see `get_transcript`). It is reset on rebind.
- `feedbackState`: the last 15 tool names, the last error text, and the de-duplication keys for `send_feedback`.
- The analytics session ID, and the client info.

The session's editor is the bound project's editor. It is resolved on every call and must still be in `AppState.openProjects`; a project that was closed resolves to `nil`.

Order of execution (`executeWithOrigin`):

1. **Drop blank arguments.** Every **top-level** argument whose value is JSON `null` or the empty string `""` is removed. Nested values are left untouched. This makes `"name": ""` mean "absent".
2. **Check the tool name.** The name must be a known tool in the MCP list; otherwise the result is the error `Unknown tool: <name>`.
3. **`manage_project` short-circuits.** It runs immediately, with no focus guard, no ID-prefix expansion, and no post-shortening (the `open` and `create` actions shorten their own output).
4. **Project-focus guard.** If the tool is not read-only (list below) and the session's project is not the frontmost project window (`sessionProject !== frontmostProject`, which includes the case where both sides are nil-versus-something), the call fails with:
   `This session is on '<sessionName>', but '<frontmostName>' is active in Palmier Pro. Activate '<sessionName>' or call manage_project with action='open' before making changes.`
   - `<sessionName>` and `<frontmostName>` fall back to `no project`.
   - Tools allowed on an inactive project: `get_timeline`, `inspect_timeline`, `get_media`, `inspect_media`, `search_media`, `get_multicam`, `get_transcript`, `detect_beats`, `inspect_color`, `list_models`, `send_feedback`.
   - On Linux, "frontmost project" means the focused project window. If the port has a single window with tabs, it means the active project tab.
5. **Editor check.** With no editor (no project bound), the call fails with `Editor not available`.
6. **Expand ID prefixes** (§1.7). An ambiguous prefix fails the call.
7. **Run the tool.** A thrown `ToolError` becomes the error with its message; any other thrown error becomes `error.localizedDescription`.
8. **Change highlight (UI only).** On success, when the active timeline changed through a mutating tool (the "publisher" set below) and no user edit interleaved, the UI highlights added and mutated clips and tracks. This has no effect on the contract.
   - Publisher set: `set_project_settings`, `manage_tracks`, `manage_clip_links`, `add_clips`, `insert_clips`, `move_clips`, `remove_clips`, `split_clips`, `ripple_delete_ranges`, `swap_clip_media`, `set_clip_properties`, `copy_clip_settings`, `set_keyframes`, `apply_layout`, `sync_clips`, `undo`, `manage_multicam`, `change_cam`, `remove_words`, `remove_silence`, `add_texts`, `update_text`, `add_captions`, `apply_color`, `apply_effect`, `denoise_audio`, `generate_audio`.
   - Read tools similarly flash a read-range highlight. That is UI only too.
9. **Record feedback state.** The tool name and the last error are recorded. `send_feedback` itself is excluded.
10. **Shorten IDs** in all text blocks (§1.7), using the ID universe from before **and** after the call, so IDs that were just removed are also shortened.

### 1.7 Short-ID scheme (`ToolExecutor+ShortId.swift`)

IDs are UUID strings: uppercase hex as produced by `UUID().uuidString`, for example `3F2A9C1E-...`. The agent sees short unique prefixes, and accepts either short or full IDs.

**ID universe** (`currentIdUniverse`) is the union of:

- the IDs of all timelines in the project;
- for the **active** timeline only: track IDs, clip IDs, `captionGroupId`s, `linkGroupId`s, and marker IDs;
- all media asset IDs;
- multicam group IDs and multicam member IDs.

**Output shortening** (after every tool):

- Applies only when the result has at least one text block. Image blocks are untouched.
- Universe = universe before the call ∪ universe after the call.
- Sort the universe lexicographically. For each ID, compute the longest common prefix it shares with its sorted neighbour before and its sorted neighbour after. The short form is `id.prefix(min(len(id), max(8, sharedLen + 1)))`. So the floor is 8 characters, and the short form is always unique within the universe.
- Every substring of the text that matches `/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/` and is a key in the map is replaced by its short form. Other UUIDs are left alone, for example export `jobId`s and project registry IDs, which are not in the universe.
- Because 8 hex characters usually suffice, short IDs typically look like `3F2A9C1E`. A prefix can run past the first `-` when needed, for example `3F2A9C1E-4`.

**Input expansion** (before every tool except `manage_project`):

- Walk the argument object recursively (dicts and arrays).
- For a dict key in the **scalar ID keys** with a string value, or in the **array ID keys** with string elements, expand each value as follows:
  - The value is an exact member of the universe: keep it as is.
  - The value is shorter than 8 characters: leave it unchanged. The tool will then report its own not-found error.
  - Exactly one universe ID starts with the value (case-sensitive `hasPrefix`): replace the value with that full ID.
  - More than one ID starts with the value: fail with `Ambiguous id '<ref>' matches <n> items; re-read with get_timeline or get_media for current ids.`
  - No ID starts with the value: leave it unchanged.
- Scalar ID keys: `clipId, sourceClipId, referenceClipId, targetClipId, mediaRef, startFrameMediaRef, endFrameMediaRef, sourceVideoMediaRef, videoSourceMediaRef, sourceMediaRef, subtitleMediaRef, captionGroupId, timelineId, trackId, item, from, reference, groupId, memberId, markerId`.
- Array ID keys: `clipIds, targetClipIds, items, ids, deletes, referenceMediaRefs, referenceImageMediaRefs, referenceVideoMediaRefs, referenceAudioMediaRefs`.
- Keys not in these sets are **not** expanded. Notable examples: `enhanceDraftMediaRef`, `master` (manage_multicam expands this one itself), `angle`, `slots[].clipIds`. `clipIds` is matched at any depth, so `apply_layout` `slots[].clipIds` **is** expanded.

### 1.8 Argument parsing conventions (behaviour to replicate)

There are two parsing styles.

1. **Strict** (`decodeToolArgs`, Swift `Decodable`):
   - Top-level unknown keys are rejected with `<path>: unknown field(s) '<a>', '<b>'. Allowed: <sorted allowed list>.`, where `<path>` is the tool name.
   - Any non-finite number anywhere in the arguments fails with `<path><trail>: value must be finite`.
   - Types are strict. For example, an `Int` field rejects `2.5` and `"2"`, but an integral float `2.0` is accepted.
   - Decoding errors are formatted as:
     - `<path><.key|[i]...>: missing required field '<key>'`
     - `<path><trail>: expected <Type>, got something else`
     - `<path><trail>: missing required <Type> value`
     - `<path><trail>: <debugDescription>`
   - Nested unknown keys are checked separately where noted (for example `entries[i]`).
   - Tools using this style: add_clips, insert_clips, move_clips, manage_clip_links, split_clips, set_clip_properties, copy_clip_settings, ripple_delete_ranges, set_keyframes, capture_frame, denoise_audio, apply_color, inspect_color, apply_effect, apply_layout, manage_markers, set_project_settings, export_project, manage_exports.
2. **Lenient** (`[String: Any]` accessors), usually combined with an unknown-key check (`validateUnknownKeys`):
   - `string(k)`: a non-empty string, otherwise absent.
   - `int(k)`: accepts an Int; a Double truncated toward zero (overflow or NaN gives absent); an NSNumber; a **numeric string**. Booleans are rejected.
   - `double(k)`: accepts Double, Int, NSNumber, or a numeric string. Booleans are rejected.
   - `bool(k)`: accepts Bool, NSNumber, or the strings `"true"`/`"false"`.
   - `stringArray(k)`: keeps only the string elements and silently drops the others.
   - `requireString` / `requireInt` fail with `Missing required argument: <key>`.
   - `exactJSONInt` (used for track indexes and caption limits) rejects booleans, fractional numbers, and strings.
   - Tools with an unknown-key check: get_timeline, create_timeline, set_active_timeline, get_media, inspect_media, search_media, import_media, organize_media, remove_clips, swap_clip_media, manage_tracks, sync_clips, manage_multicam, change_cam, get_multicam, get_transcript, remove_words, remove_silence, detect_beats, update_text, add_captions, manage_project (also per action).
   - Tools with **no** top-level unknown-key check: add_texts (only `entries[i]` are checked), generate_video, generate_image, generate_audio, upscale_media, list_models, send_feedback, undo (arguments ignored).

Color strings are parsed by `TextStyle.RGBA(hex:)`, which accepts `#RGB`, `#RRGGBB`, and `#RRGGBBAA`. A bad value fails with `<path>: invalid color '<hex>'. Expected '#RGB', '#RRGGBB', or '#RRGGBBAA'.` Colors are emitted as `#RRGGBBAA`, uppercase.

### 1.9 JSON output conventions

- Payloads are produced by `JSONSerialization` with `.sortedKeys`, compact, no whitespace.
- Most payloads pass through `roundJSONFloatingPointNumbers(…, 3)`: every floating-point number is rounded half-up ("plain") to 3 decimals, and non-finite values become `null`. Integers and booleans are untouched. Tools that skip rounding are noted.
- Some fields use fixed-decimal numbers: transcript seconds use 2 decimals, beats 2 decimals, bpm 1 decimal, and color scopes 3 decimals. JSON has no trailing zeros, so `1.50` is emitted as `1.5`.

### 1.10 Undo model (shared with the UI)

- Every mutating tool runs inside `EditorUndo.perform("<Action Name>")`, so the tool's whole intent is **one** undo step, shared with the user's own undo history (Cmd-Z).
- Nested `perform` calls coalesce into the outer group.
- The undo group opens lazily, on the first registered change, so a no-op creates **no** undo step.
- Validation happens before mutation, so failed calls leave neither state changes nor undo entries.
- `undo` (§3.32) pops the latest step regardless of whether the user or the agent created it.
- Action names are listed per tool. They are UI-visible strings, not part of the contract.

### 1.11 mcpb bridge (`mcpb/`)

`mcpb/manifest.json` (manifest_version `0.4`) packages a Claude Desktop extension:

- name `palmier-pro`, display name "Palmier Pro", version `0.2.0`.
- `compatibility.platforms: ["darwin"]`, Node ≥ 18.
- The server is of type `node`, launched as `node ${__dirname}/server/index.js`.
- The port must add `"linux"` to `platforms`.

`mcpb/server/index.js` is a **stdio↔HTTP shim** that proxies newline-delimited JSON-RPC on stdin/stdout to `http://127.0.0.1:19789/mcp`:

- **Request headers:** `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version` (default `2025-06-18`, then whatever initialize returned), and `Mcp-Session-Id` once a session has been assigned.
- **Client `initialize`:** the shim stores the params for replay, then establishes a session. To do that it:
  1. POSTs `initialize` with id `shim-init-<n>`, and takes `protocolVersion` from the result;
  2. POSTs `notifications/initialized`;
  3. opens the standalone **GET** SSE stream with `node:http`, not `fetch`, because undici kills idle bodies after 300 s. Only messages carrying a `method` (for example `tools/list_changed`) are forwarded to stdout.

  The shim then answers the client's `initialize` with the server's result. It swallows the client's own `notifications/initialized`, because it sends one itself for every session.
- **POST handling:** a `404` means the session expired, and triggers a reconnect. Any other status that is not ok and not 202 throws. The response is parsed as SSE (`data:` lines joined, the empty priming event skipped) or as JSON. Only messages with an `id` or a `method` are written to stdout.
- **Reconnect:** there is one shared reconnect promise. Retries back off from 500 ms, doubling, up to 5000 ms, indefinitely. A failure on the GET stream (error, end, or non-200) also triggers a reconnect.
- **Request replay:**
  - A failed request is replayed after reconnecting, until **25 s** have passed since it arrived.
  - It is never replayed if any response was already delivered (`err.delivered`).
  - Notifications are never retried.
  - On final failure the shim writes `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,"message":"Palmier Pro unreachable: <message>"}}`.
- **Logging:** logs go to stderr with the prefix `[palmier-shim]`. stdin EOF exits the process.

The shim is client-agnostic: any stdio-only MCP client can use it. Claude Code, Codex, and Cursor can use HTTP directly (`http://127.0.0.1:19789/mcp`).

---

## 2. Shared payload shapes

### 2.1 Timeline read shape (`get_timeline`, also reused by the mutation delta)

The payload starts as `JSONEncoder` output of the active `Timeline` model and is then compacted.

**Top level** (sorted keys, floats rounded to 3 decimals):

| key | notes |
|---|---|
| `id`, `name`, `fps`, `width`, `height` | from the model. `settingsConfigured` is removed. |
| `folderId` | present only if the timeline is in a folder (a raw folder ID). |
| `tracks` | compacted tracks (below), in index order (index 0 renders on top). |
| `markers` | omitted when no markers, or none in the window. Sorted by (startFrame, id). Marker shape is in §2.2. |
| `totalFrames` | the maximum clip end over all tracks. |
| `durationSeconds` | `totalFrames / max(fps, 1)`. |
| `window` | only for windowed reads: `[start, min(end, totalFrames)]`. |
| `currentFrame` | the playhead frame. |
| `canGenerate` | `isSignedIn && hasCredits` (Palmier account). |
| `multicamGroups` | only groups referenced by clips in the active timeline: `[{groupId, name, angles:[angleLabel], mics:[angleLabel]}]`. |
| `timelines` | only when the project has more than one timeline: `[{timelineId, name, active?:true}]`. |

**Window rules** (`frameWindow`, shared by get_timeline, get_transcript, and get_multicam):

- `endFrame == 0` counts as absent.
- If both are absent, or `startFrame` is absent or 0 with no `endFrame`, there is no window.
- Otherwise the window is `[startFrame ?? 0, endFrame ?? ∞)`, and `start < end` is required. A violation fails with `Invalid window [<s>, <e>): startFrame must be less than endFrame`. `<e>` prints as `9223372036854775807` when open-ended.

**Track compaction:**

- `id` is renamed to `trackId`. `displayHeight` is dropped.
- `muted:false`, `hidden:false`, and `syncLocked:true` are omitted. `name` appears only when the user named the track (one line, at most 80 characters).
- `index` is the current 0-based index.
- `label` is the generated label (`V1`, `V2`, …, `A1`, …):
  - Audio tracks are numbered top-down among audio tracks.
  - Video-zone tracks are numbered bottom-up within the video zone, so the lowest video track is V1.
  - The prefix is the first letter of the type's label: `V` for video, image, and sequence, `A` for audio, and similarly `T`, `L`, `S` for other types. In practice, tracks are `video` or `audio`.
- `type` is the `ClipType` raw value. Tracks are `video` or `audio`.
- `clips`: loose (non-caption) clips plus caption deviants, sorted by `frames[0]`. With a window, only clips intersecting it are included, and `totalClips` gives the total when the window hid some. The key is omitted when empty.
- `captionGroups`: see below.
- `linkedClips`: the number of linked audio clips folded away from this (audio) track.
- `gaps`: `[[start, end], …]`, the empty spans between consecutive non-caption clips. There is no leading gap from frame 0 and no trailing gap. The key is omitted when there are no gaps.

**Clip compaction** (starting from the `Clip` model's Codable shape):

- **Model keys:** `id, mediaRef, mediaType, sourceClipType, startFrame, durationFrames, trimStartFrame, trimEndFrame, speed, volume, fadeInFrames, fadeOutFrames, fadeInInterpolation, fadeOutInterpolation, opacity, transform{centerX,centerY,width,height,rotation,rotationX,rotationY,flipHorizontal,flipVertical}, crop{left,top,right,bottom}, edgeRounding, edgeSoftness, linkGroupId?, captionGroupId?, multicamGroupId?, textContent?, textStyle?, textAnimation?, wordTimings?, textFillMode?, opacityTrack?, positionTrack?, scaleTrack?, rotationTrack?, cropTrack?, volumeTrack?, effects?, blendMode?`. Nil optionals are omitted.
- **Volume:** `volume` (linear) becomes `volumeDb` via `20·log10`, clamped to [−60, 15]. A level of 0 or below becomes −60. `volumeDb` is omitted when it is within 0.0005 of 0 dB.
- **Keyframe tracks:** each `{keyframes:[{frame, value, interpolationOut}]}` track becomes `keyframes.<prop>: [[frame, …values, interp?]]`. The `interp` element is omitted when it is `smooth`.
  - Properties: `volumeDb` (scalar dB), `opacity`, `rotation`, `position` `[a,b]` (top-left x,y), `scale` `[a,b]` (width,height), and `crop` `[top,right,bottom,left]`.
  - `blur` is read from the `blur.gaussian` effect's `radius` param track.
- **Constant tracks** (all values equal within 0.0005):
  - An identity track is dropped: volume 0 dB, opacity 1, rotation 0, position (0,0), scale (1,1), crop all zeros.
  - A constant `volumeDb` or `opacity` becomes the static field, but only if the static value is at its default.
  - A constant `crop` becomes `crop:{top,right,bottom,left}`, but only if the static crop is all zeros.
  - Otherwise the track stays as rows.
- **Defaults stripped.** Defaults come from `Clip(mediaRef:"",startFrame:0,durationFrames:0)` with `textStyle = TextStyle()`, excluding `id`, `mediaRef`, `startFrame`, `durationFrames`, and `sourceClipType`. Keys equal to the default are removed, recursively for objects, and an object left empty is removed. In particular:
  - `mediaType:"video"`, `speed:1`, `opacity:1`, `edgeRounding:0`, `edgeSoftness:0`, trims and fades 0, `fadeIn/OutInterpolation:"linear"`;
  - identity transform fields, zero crop, and the default `TextStyle` fields.
- `sourceClipType` is removed when it equals `mediaType`.
- **Text clips:**
  - `trimStartFrame` and `trimEndFrame` are removed.
  - The transform is reshaped: `centerX`, `centerY`, `width`, and `height` are removed, and `x` (the alignment anchor: left edge, center, or right edge depending on `textStyle.alignment`) and `y` (= centerY) are added. Non-default `rotation`, `rotationX`, `rotationY`, and flips stay.
  - `textStyle` stays in **model** shape, with only the deviating fields: `fontName, fontSize, fontScale, widthScale, heightScale, tracking, lineSpacing, fontCase, isBold, isItalic, isUnderlined, isStruckThrough, isOverlined, color{r,g,b,a}, alignment, blur, shadow{enabled,color,offsetX,offsetY,blur}, background{enabled,color,paddingX,paddingY,cornerRadius,offsetX,offsetY,outlineColor,outlineWidth}, border{enabled,color,width}`.
  - Note that this differs from the `style` input vocabulary used by add_texts and update_text.
- **`color`:** if any `color.*` effect exists, a grade object in `apply_color` vocabulary is added (see apply_color, §3.40).
- **`effects`:** the non-`color.*` effects become `[{type, params?:{key: value | string | "animated"}, enabled?:false}]`, with no IDs. For text clips, `blur.gaussian` is hidden here, because it is surfaced as `textStyle.blur` plus `keyframes.blur`. The key is omitted when empty.
- **`frames`:** `[startFrame, startFrame+durationFrames]` replaces `startFrame` and `durationFrames`.
- **Linked-audio fold.** It applies to every link group with **exactly 2** members where one member is `audio` and the other is not.
  - The visual clip gets `audio: {id, track:<audio track index>, frames? (only if start or duration differ), trimStartFrame?/trimEndFrame?/speed? (only if they differ from the visual), volumeDb?, fadeInFrames?, fadeOutFrames?, fadeInInterpolation?, fadeOutInterpolation?, keyframes?, effects?}`, with the default-stripped values.
  - The visual clip's `linkGroupId` is removed.
  - The audio clip is omitted from its own track, and that track's `linkedClips` is incremented.

**Caption groups.** Clips sharing a `captionGroupId` collapse per track, in the order of first appearance:

- Each member's "residual" is the clip minus `id, frames, textContent, captionGroupId, wordTimings`, and minus `transform.width/height`.
- The modal (most frequent) residual becomes `shared`. Members whose residual differs are emitted as normal clips in `clips` (the deviants).
- Group object: `{captionGroupId, clipCount, frameRange:[minStart, maxEnd], shared?}`, plus one of:
  - **Summary** (default): `textPreview` is `"<first>"`, or `"<first> … <last>"`, where each part is truncated to 60 characters with `…` appended. Then `clipsNote: "Per-clip rows omitted — re-read with captionDetail:true for [\"clipId\", \"startFrame\", \"endFrame\", \"text\"] rows; get_transcript has the spoken words."` The inner quotes are literal; this is a Swift array description.
  - **Detail** (`captionDetail:true`): `clipFormat:["clipId","startFrame","endFrame","text"]`, and `clips:[[id,start,end,text],…]`, filtered to the window, sorted by start, and capped at **200**. When capped, `clipsNote: "Showing <n> of <total> caption clips. Page with startFrame/endFrame."`

### 2.2 Small shared shapes

- **Marker** (`timelineMarkerDict`): `{markerId, name, startFrame, endFrame, durationFrames, color:"#RRGGBBAA", comment, status:"open"|"review"|"resolved"}`.
  - Point markers have `durationFrames: 0` and `endFrame == startFrame`.
  - A marker intersects a window when it is a range overlapping `[s, e)`, or a point with `s ≤ start < e`.
- **Timeline entry** (`timelineEntries`): `{timelineId, name, active?:true}`. The detailed form, used by get_media, adds `durationSeconds` and `folder?` (a path).
- **Folder path:** folder names joined by `/`, for example `B-roll/Sunset`.
  - Resolution is case-insensitive per segment; when duplicates differ in case, an exact-case match wins.
  - Segments are trimmed. Empty segments fail with `Invalid folder path '<p>'. Use segment names joined by '/', e.g. 'B-roll/Sunset'.`
  - Ambiguity fails with `Folder path '<p>' is ambiguous at '<seg>' (<n> matches). Rename one of the duplicates first.`
  - A strict lookup failure gives `Folder not found: '<p>'. Folders: <comma list | (none yet)>`.
  - The tools that take a `folder` argument (import and generation) **create** any missing segments.

### 2.3 Mutation delta (`mutationResult`)

Most mutating tools return a single text block containing this JSON (sorted keys, floats rounded to 3 decimals). It describes the difference between a snapshot taken just before the mutation and the state after it, in get_timeline vocabulary.

The algorithm, with placement = (trackId, start, duration):

1. `changed` starts as the tool's `touched` clip IDs that still exist, plus every clip ID that is new since the snapshot.
2. For every surviving clip whose placement changed and that is not already in `changed`:
   - If it stayed on the same track with the same duration, it is a **pure shift** (delta = new start − old start).
   - Otherwise it goes into `changed`.
3. Pure shifts are grouped by (current track index, delta).
   - A group with **3 or more** clips becomes one `shifted` rule: `{track, fromFrame:<min original start>, by:<delta>, count}`.
   - Smaller groups are added to `changed`.
   - Rules are sorted by (track, fromFrame).
4. If **3 or more** changed clips share a `captionGroupId`, they collapse into `captionGroups`: the get_timeline summary group (non-detail) with an added `track`. Those clips are removed from `changed`.
5. `clips` holds the changed clips in get_timeline clip shape with an added `track` (index):
   - An audio partner that is folded into a visual clip is reported through that visual clip (with `audio:{…}`).
   - Caption members appear as `{id, track, frames, textContent, captionGroupId}`.
   - Clips are de-duplicated and sorted by (track, frames[0]).
   - The list is capped at **30**, with `clipsNote: "Showing 30 of <n> changed clips — re-read get_timeline for the rest."`
6. `removedClipIds`: the sorted IDs present before and absent after.
7. `markers` holds markers that are new or changed, as marker dicts. `removedMarkerIds` is sorted.
8. `createdTracks`: `[{index, label, type}]` for track IDs that are new since the snapshot.
9. If any track was removed or any surviving track changed index, and the payload has no `tracks` key, the note `Track indices shifted — re-read get_timeline before the next index-based call.` is appended.
10. `notes` (array of strings) is present only when non-empty. Tool-specific `extra` keys are merged in (listed per tool).

Empty keys are omitted, so a no-op mutation returns `{}` plus any extra keys.

---

## 3. Tool reference (MCP surface, in `tools/list` order)

Classification key:

- **CORE**: needed for milestone 1. Pure timeline, model, render, or export work with no ML or cloud dependency.
- **AI-GENERATION**: submits jobs to the Palmier cloud generation backend.
- **NEEDS-ML**: needs on-device ML models, DSP analysis, or cloud transcription.

Section numbers follow the `tools/list` order.

### 3.1 `get_timeline` — CORE

**Description (verbatim):**

~~~text
Always call at the start of a session. Returns project settings (fps, resolution, totalFrames, durationSeconds), tracks with a stable trackId, their current index (what every trackIndex parameter takes), type, and clips, plus canGenerate (if false, generation/upscale tools will fail — tell the user to sign in to Palmier and subscribe before attempting them). Clip ids are accepted by clip mutation tools; trackId is accepted by manage_tracks.

Every clip occupies frames: [start, end) — timeline frames, end exclusive, duration = end − start. gaps on a track lists its empty [start, end) spans; no gaps key means contiguous. A video clip's linked audio partner is folded into it as audio: {id, track, …} carrying only what deviates (volumeDb, effects, differing trims); the partner is not repeated on its own track, which instead reports linkedClips (its folded count). Address the audio side by its nested id.

Fields equal to their defaults are omitted: mediaType 'video', sourceClipType = mediaType, speed 1, volumeDb 0, opacity 1, edgeRounding 0, edgeSoftness 0, trims/fades 0, identity transform/crop, default textStyle, track muted/hidden false. Text clips never report trims. Keyframe tracks that animate nothing are shown as what they are: identity tracks are dropped, constant ones appear as the static field (e.g. crop: {left: 0.31}). A graded clip carries `color` — its grade in apply_color's own vocabulary, pasteable to other clips via apply_color's color parameter. Other effects appear as effects: [{type, params}], the exact shape apply_effect accepts.

Caption clips (sharing a captionGroupId) come back per track as captionGroups summaries: clipCount, frameRange, shared style, and a textPreview — individual caption clips and their ids are NOT listed. That summary is all you need to restyle (update_text with captionGroupId) or judge coverage; the spoken words live in get_transcript. Only when you must touch individual caption clips (retime one, delete one, fix one word's style), re-read with captionDetail:true — ideally windowed — to get [clipId, startFrame, endFrame, text] rows, capped at 200 per group. Caption clips whose properties deviate from the group always appear individually in clips.

markers contains persistent review notes with markerId, name, comment, color, startFrame, endFrame, and durationFrames. Point markers have durationFrames 0; range markers use half-open [startFrame, endFrame). Windowed reads include only markers in or intersecting the window.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "startFrame": {
      "type": "integer",
      "description": "Optional. Window start (inclusive); only clips intersecting [startFrame, endFrame) are returned. Omit both startFrame and endFrame for the whole timeline — never pass a zero-width window. Tracks report totalClips when the window hides some."
    },
    "endFrame": {
      "type": "integer",
      "description": "Optional. Window end (exclusive); must be greater than startFrame. Omit for the whole timeline."
    },
    "captionDetail": {
      "type": "boolean",
      "description": "Optional. true expands captionGroups into per-clip [clipId, startFrame, endFrame, text] rows. Combine with a window; only needed to edit individual caption clips."
    }
  }
}
```

**Arguments.** Allowed keys: `captionDetail, endFrame, startFrame`. Lenient parsing: the frames use `int()`, so numeric strings work. `captionDetail` counts only when it is a JSON boolean; anything else means `false`.

**Execution.** Read-only, and allowed on an inactive project. Reads the session project's **active** timeline. Window rules are in §2.1.

**Result.** One text block in the §2.1 shape: sorted keys, floats rounded to 3 decimals.

**Errors.**
- Unknown keys: `get_timeline: unknown field(s) '<k>'. Allowed: captionDetail, endFrame, startFrame.`
- A bad window (§2.1).
- `Failed to encode timeline`

### 3.2 `inspect_timeline` — CORE

**Description (verbatim):**

~~~text
See the composited timeline — what the user actually sees in the preview at a given frame: all video tracks stacked with their transforms, opacity, crop, edge softness, edge rounding, and keyframes applied, plus text and caption overlays baked in. Use this to verify your edits landed (a PIP's position, a title's placement, layer order) — inspect_media shows the raw source asset, not the cut.

Frames are project frames (from get_timeline). Pass a single startFrame for one composited frame; add endFrame to sample maxFrames evenly across [startFrame, endFrame) for a transition or sequence. Frames past content render black. Each image carries a 0–1 coordinate grid over the canvas (origin top-left) and its frame number burned into the top-left (f157). Metadata lists, per rendered frame, the clip ids visible on screen top-down (caption clips as their captionGroupId) — so what you see maps straight back to the clips to edit.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "startFrame": {
      "type": "integer",
      "description": "Project frame to render (default 0). With no endFrame, a single frame is returned."
    },
    "endFrame": {
      "type": "integer",
      "description": "Optional. Sample maxFrames evenly across [startFrame, endFrame) instead of one frame."
    },
    "maxFrames": {
      "type": "integer",
      "description": "Frames to sample when endFrame is set (default 6, max 12)."
    }
  }
}
```

**Arguments.** Allowed keys: `endFrame, maxFrames, startFrame` (lenient ints).

**Validation.** In order:
- The timeline must have content (`totalFrames > 0`), otherwise `Timeline is empty — nothing to render.`
- `startFrame` defaults to 0 and must lie in `[0, totalFrames)`, otherwise `startFrame <s> out of range [0, <total>).`
- A non-zero `endFrame` is clamped to `totalFrames` and must exceed the start, otherwise `endFrame must be greater than startFrame (<s>).`

**Sampling.**
- No `endFrame` (or 0): exactly `[startFrame]`.
- Otherwise: `span = end − start` and `count = max(1, min(maxFrames ?? 6, 12, span))`. Frame `i` is `start + floor(span·(i+0.5)/count)`.

**Rendering.**
- Builds the full composition of the active timeline: transforms, opacity, crop, edge softness and rounding, keyframes, blend modes, effects and color, text and caption overlays, and nested timelines. Missing media renders as missing.
- Each sampled frame is rendered **exactly**, with zero time tolerance, at the canvas aspect ratio, scaled so the longest edge is at most **512 px** (rounded).
- Each frame is overlaid with the 0–1 grid and the caption `f<frame>` in the top-left (`InspectFrameOverlay`), then JPEG-encoded at quality 0.7.
- The grid has minor lines every 0.05 and major lines at 0, 0.5, and 1, with labels 0, 0.1, …, 1 along the bottom and right edges. Origin is top-left.
- Frames that fail to decode are skipped.

**Result.**
- One `image/jpeg` block per rendered frame, followed by a text JSON (not rounded): `{fps, width, height, totalFrames, coordinateGrid:"0-1, origin top-left", frames:[{frame, clips:[id…]}]}`.
- `width` and `height` are the rendered pixel size.
- `clips` lists the clips covering the frame (`start ≤ frame < end`) on every **non-hidden video-type** track, walking from track 0 (top) downward. Caption clips are listed once, as their `captionGroupId`. Opacity is not considered.

**Errors.** `No video track available in timeline.`, `Failed to render timeline frames.`, `Failed to encode metadata`. Read-only.

### 3.3 `create_timeline` — CORE

**Description (verbatim):**

~~~text
Creates a timeline and switches to it — every read and edit tool now targets it. Without 'from', the new timeline is empty and inherits fps/resolution from the previously active one. With 'from', it's a full copy of that timeline — the versioning primitive: copy, then edit the copy ("a tighter cut", "a 9:16 version") while the original stays intact; every clip and track id in the copy is NEW, so re-read get_timeline before editing. Undoable.

Use timelines to organize a project: alternate versions, sections assembled separately, or reusable groups. A timeline can be placed inside another as a single clip (add_clips with the timelineId as mediaRef); it then appears as a clip with mediaType 'sequence'.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Optional display name. Defaults to 'Timeline N', or '<source> copy' when duplicating."
    },
    "from": {
      "type": "string",
      "description": "Optional timelineId to duplicate instead of creating empty."
    }
  }
}
```

**Arguments.** Allowed keys: `from, name`.
- `from` is ID-expanded and must name a timeline in the project, otherwise `No timeline with id '<from>'. get_media lists the project's timelines.`
- `name: ""` is dropped (§1.6), so it counts as absent.

**Execution.**
- **With `from`**, one undo group "Duplicate Timeline (Agent)":
  - `duplicateTimeline(from)` makes a deep copy where **every track and clip gets a new ID**. The default name is `<source> copy`.
  - It is renamed if `name` was given.
  - The copy becomes the active timeline.
  - Failure: `Couldn't duplicate "<source name>".`
- **Without `from`**, undo group "Create Timeline (Agent)":
  - `createTimeline(name:)` creates an empty timeline (default name `Timeline N`) that inherits fps and resolution from the previously active timeline, and makes it active.
- The UI reveals the timeline tab bar when more than one timeline exists.

**Result.** Text JSON (not rounded): `{timelineId, name, active:true, note}`. The note is one of:
- `Duplicated "<source>" and switched to the copy. Its clip and track ids are new — re-read get_timeline before editing.`
- `Empty and now active; all edit tools target it.`

### 3.4 `set_active_timeline` — CORE

**Description (verbatim):**

~~~text
Switches the active timeline — the one every read and edit tool targets and the one the user sees. get_media lists the project's timelines (with timelineId). Always re-read get_timeline after switching; clip and track ids from the previous timeline are no longer valid targets.

To edit the contents of a nested timeline (a clip with mediaType 'sequence'), switch to its mediaRef.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "timelineId": {
      "type": "string",
      "description": "Timeline id from get_media's timelines list (or a sequence clip's mediaRef)."
    }
  },
  "required": [
    "timelineId"
  ]
}
```

**Arguments.** Allowed keys: `timelineId` (required, ID-expanded).
- Missing: `timelineId is required`.
- Unknown: `No timeline with id '<id>'. get_media lists the project's timelines.`

**Execution.** Calls `activateTimeline(id)` (navigation), unless the timeline is already active. Reveals the tab bar if there is more than one timeline. The tool opens no undo group.

**Result.** Text JSON: `{timelineId, name, active:true, totalFrames, fps, trackCount, note}`. The note is one of:
- `Already the active timeline.`
- `Re-read get_timeline — clip and track ids from the previous timeline no longer apply.`

### 3.5 `manage_markers` — CORE

**Description (verbatim):**

~~~text
Creates, updates, or deletes one persistent timeline marker. A zero duration marks one frame; a positive duration is half-open. Status tracks the review workflow: open is awaiting work, review is ready for user approval, and resolved is accepted. Set review only after applying and verifying the requested edit. Set resolved only when the user explicitly approves or requests it.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "create",
        "update",
        "delete"
      ]
    },
    "markerId": {
      "type": "string",
      "description": "Required for update/delete. From get_timeline."
    },
    "name": {
      "type": "string"
    },
    "startFrame": {
      "type": "integer",
      "description": "Timeline frame."
    },
    "durationFrames": {
      "type": "integer",
      "description": "0 for a point; positive for a range."
    },
    "color": {
      "type": "string",
      "description": "#RGB, #RRGGBB, or #RRGGBBAA."
    },
    "comment": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "open",
        "review",
        "resolved"
      ]
    }
  },
  "required": [
    "action"
  ]
}
```

**Arguments.** Strict decode. Keys: `action` (String, required), `markerId`, `name`, `startFrame` (Int), `durationFrames` (Int), `color`, `comment`, `status`. `markerId` is ID-expanded.

**Execution.** Markers belong to the **active** timeline.
- `status` is validated first: `status must be open, review, or resolved.`
- **create**
  - Requires `name` and `startFrame`: `create requires name and startFrame.`
  - Defaults: `durationFrames` 0, `color` `#007AFFFF` (r0, g0.478, b1, a1), `comment` `""`, `status` `open`.
  - Undo group "Add Marker (Agent)".
- **update**
  - Requires `markerId` and at least one of name, startFrame, durationFrames, color, comment, status: `update requires markerId and at least one field to change.`
  - Unknown ID: `Unknown markerId '<id>'.`
  - Patches the given fields. Undo group "Change Marker (Agent)".
- **delete**
  - Requires `markerId`: `delete requires markerId.`
  - Undo group "Delete Marker (Agent)".
- Any other action: `action must be create, update, or delete.`

**Validation** (`changeTimelineMarkers`):
- Name must be a non-empty single line of at most 120 characters: `Marker names must be non-empty single lines of at most 120 characters.`
- Comment must be at most 4000 characters: `Marker comments must be at most 4000 characters.`
- Any other failure (negative frames, missing ID): `Marker frames must be non-negative integer ranges and every ID must exist.`
- A bad color: `color: invalid color '<hex>'. Expected '#RGB', '#RRGGBB', or '#RRGGBBAA'.`

**Result.** Text JSON: `{created?: <marker>, updated?: <marker>, deletedMarkerId?: <id>}`. When nothing changed: `{noOp:true}`. Marker shape is in §2.2.

### 3.6 `set_project_settings` — CORE

**Description (verbatim):**

~~~text
Change the project's frame rate, resolution, or aspect ratio. Pass fps, explicit width+height, aspectRatio, or quality. aspectRatio accepts presets or a custom width:height value and preserves the current short-edge resolution unless quality is also supplied. Explicit width/height can't be combined with aspectRatio or quality. The timeline's existing clips are re-fitted automatically: auto-fit transforms recalculate for the new canvas size, and all frame positions/durations rescale when fps changes. Undoable.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "fps": {
      "type": "integer",
      "description": "Frame rate in frames per second. Common values: 24, 25, 30, 48, 50, 60."
    },
    "width": {
      "type": "integer",
      "description": "Canvas width in pixels. Requires height for an exact resolution. Mutually exclusive with aspectRatio and quality."
    },
    "height": {
      "type": "integer",
      "description": "Canvas height in pixels. Requires width for an exact resolution. Mutually exclusive with aspectRatio and quality."
    },
    "aspectRatio": {
      "type": "string",
      "description": "Canvas aspect ratio as width:height, such as '16:9', '3:2', or '2.39:1'. Preserves the current short edge, or uses quality when supplied. Mutually exclusive with width/height."
    },
    "quality": {
      "type": "string",
      "enum": [
        "720p",
        "1080p",
        "2K",
        "4K"
      ],
      "description": "Resolution quality preset — scales the short edge to the target while preserving the current (or specified) aspect ratio."
    }
  }
}
```

**Arguments.** Strict decode. Keys: `aspectRatio, fps, height, quality, width`.

**Validation.** In order:
- At least one key: `Provide at least one of: fps, width, height, aspectRatio, quality`.
- `width` and `height` together: `Provide both width and height`.
- Explicit dimensions exclude `aspectRatio` and `quality`: `Explicit dimensions can't be combined with aspectRatio or quality`.
- `fps` in 1…120: `fps must be between 1 and 120 (got <n>)`.
- `aspectRatio` is parsed as `W:H`: decimals are allowed, both parts must be finite and greater than 0, and whitespace is trimmed. A parse error passes through the localized `AspectRatioError` message.
- `quality` must be one of `720p`→720, `1080p`→1080, `2K`→1440, `4K`→2160, otherwise `Unknown quality '<q>'. Use one of: 720p, 1080p, 2K, 4K`.

**Resolution math.**
- **With `aspectRatio`:**
  - The short edge is the quality's short edge, or `min(currentW, currentH)` when no quality is given, rounded **up to an even number**.
  - `long = round(short·max(r, 1/r) / 2)·2`.
  - `long` must be at most 8192, and the short edge at least 2.
  - The result is `(long, short)` when `r ≥ 1`, otherwise `(short, long)`.
- **With `quality` alone:** the short edge becomes the target and the long edge is `Int(target·long/short)`, truncated.
- **Final check:** the size must be positive, and at most 8192 per edge when the resolution changes, otherwise `Resolution must be positive and no larger than 8192 pixels on either edge`.

**Execution.**
- Undo group "Set Project Settings (Agent)".
- `applyTimelineSettings(fps, width, height)` updates the **active timeline's** settings.
- Auto-fit transforms are recomputed for the new canvas.
- When fps changes, every frame position and duration is rescaled, markers included.

**Result.** Text JSON. This is **not** a mutation delta: `{fps, resolution:"<W>x<H>", aspectRatio:<label>, changed:["fps"?, "resolution"?], note?}`.
- The label is the reduced `W:H` if both terms are at most 100, otherwise `"<ratio rounded to 2dp>:1"` or `"1:<…>"`.
- The note is `Settings already matched.` when nothing changed, or `Clip frames rescaled to <fps>fps — re-read get_timeline before frame-based edits.` when fps changed.

### 3.7 `export_project` — CORE

**Description (verbatim):**

~~~text
Queues an export from the current project using the same modes as the Export dialog. mode defaults to video. video renders H.264, H.265, or ProRes; xml writes XMEML timeline XML; fcpxml writes FCPXML; palmier writes a self-contained .palmier project package. For timeline interchange, pick the format by the target editor: Premiere Pro -> xml; DaVinci Resolve or Final Cut Pro -> fcpxml (fcpxml also carries text, transforms, crop, opacity, and keyframes that xml cannot). Video exports render edge softness and edge rounding, Palmier project exports preserve them, and xml/fcpxml interchange omits them. Omit outputPath to write a unique file to ~/Downloads. Existing direct outputPath files are overwritten by default to match the UI save flow; pass overwrite=false to refuse. Every mode returns status=started or status=queued with a jobId and destination path. Use manage_exports to check progress, warnings/results, or cancel by jobId; agent exports post a system notification on completion or failure.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "video",
        "xml",
        "fcpxml",
        "palmier"
      ],
      "description": "Optional. Default video. Use xml for Premiere Pro, fcpxml for DaVinci Resolve or Final Cut Pro."
    },
    "codec": {
      "type": "string",
      "enum": [
        "H.264",
        "H.265",
        "ProRes"
      ],
      "description": "Video mode only. Optional. Default H.264."
    },
    "resolution": {
      "type": "string",
      "enum": [
        "720p",
        "1080p",
        "2K",
        "4K",
        "Match Timeline"
      ],
      "description": "Video mode only. Optional. Default Match Timeline."
    },
    "outputPath": {
      "type": "string",
      "description": "Optional. Absolute destination path. If omitted, a unique project-named file is written to ~/Downloads. If no extension is provided, the mode's extension is appended."
    },
    "overwrite": {
      "type": "boolean",
      "description": "Optional. Default true, matching the UI save flow. false refuses when outputPath already exists."
    },
    "fcpxmlTarget": {
      "type": "string",
      "enum": [
        "resolve",
        "fcp"
      ],
      "description": "fcpxml mode only. Optional, default resolve. Davinci Resolve and Final Cut interpret crop and position values differently; pick the app the file will be imported into."
    },
    "timelineId": {
      "type": "string",
      "description": "Optional. Timeline to export (from get_timeline's timelines list). Defaults to the active timeline. Not valid for palmier mode, which packages every timeline."
    }
  }
}
```

**Arguments.** Strict decode. Keys: `codec, fcpxmlTarget, mode, outputPath, overwrite, resolution, timelineId`.
- Option strings are normalized before matching: trimmed, lowercased, and stripped of whitespace, `-`, and `_`.
- `mode`:
  - Accepted: `video` (default), `xml`, `fcpxml`, `palmier`.
  - Otherwise: `export_project: mode must be video, xml, fcpxml, or palmier`.
- `codec`:
  - Accepted: `h.264|h264` (default), `h.265|h265|hevc`, `prores`.
  - Otherwise: `export_project: codec must be H.264, H.265, or ProRes`.
- `resolution`:
  - Accepted: `720p`, `1080p`, `2k`, `4k`, `matchtimeline` (default).
  - Otherwise: `export_project: resolution must be 720p, 1080p, 2K, 4K, or Match Timeline`.
- `codec` and `resolution` are video-only:
  - `export_project: codec only applies to video mode`
  - `export_project: resolution only applies to video mode`
- `fcpxmlTarget` must be `resolve` (default) or `fcp`: `export_project: fcpxmlTarget must be 'resolve' or 'fcp'`.
- `timelineId`:
  - Not allowed with `palmier`: `export_project: timelineId doesn't apply to palmier mode — the package carries every timeline`.
  - Must exist: `export_project: no timeline with id '<id>'. get_timeline lists the project's timelines.`
  - The default is the active timeline.

**Destination.**
- **Extensions:** mp4 for H.264 and H.265, mov for ProRes, `xml`, `fcpxml`, `palmier`.
- **`outputPath` omitted:** the file goes to `~/Downloads/<project package stem | "Untitled Project">.<ext>`, made unique as `"<base> 2.<ext>"`, `"<base> 3.<ext>"`, and so on. The uniqueness check covers both existing files and destinations reserved by queued jobs.
- **`outputPath` given:**
  - `~` is expanded, and the path must be absolute: `export_project: outputPath must be absolute`.
  - A missing extension is appended. A different extension fails with `export_project: <H.264|H.265|ProRes|XML|FCPXML|Palmier Project> exports must use .<ext>`.
  - An existing directory fails with `export_project: outputPath must include a filename`. The exception is a `.palmier` package path in palmier mode.
  - The parent directory must exist: `export_project: output directory does not exist`.
  - With `overwrite:false`, an existing file fails with `export_project: output file already exists`. By default, files are overwritten.
- On Linux, use the XDG download directory for the default location.

**Execution.**
- Video mode requires a non-empty timeline: `export_project: timeline is empty`.
- **xml and fcpxml** add a warning when nested-timeline clips (non-audio) reference an empty or missing timeline: `<n> nested timeline clip was skipped because the source timeline is empty or missing.` The plural form reads `<n> nested timeline clips were skipped because the source timeline is empty or missing.`
- The job is enqueued in the global `ExportQueue` with source "agent", scoped to the project. It renders in the background and is cancelable.
- Completion and failure post a system notification.
- Not undoable.

**Result.**
- **video, xml, fcpxml.** Text JSON (not rounded): `{status:"started"|"queued", jobId:<UUID>, queuePosition, mode, path, format:"H.264"|"H.265"|"ProRes"|"XML"|"FCPXML", timeline:<name>, durationFrames, durationSeconds, fps, note:"The export is available in the Export dialog.", warnings?}`.
- **palmier.** `{status, jobId, queuePosition, mode:"palmier", path, note}`.
- Job IDs are not in the short-ID universe, so they stay full UUIDs.

### 3.8 `manage_exports` — CORE

**Description (verbatim):**

~~~text
Lists or cancels exports for the current project. action=list returns newest first with jobId, filename, path, status, progress percent, and any warnings/result. action=cancel requires the exact jobId returned by export_project or list; a waiting job is removed from the queue and an active job begins canceling. Cancel only when the user asks, or to undo an export just queued with incorrect settings. Never infer that an export is stuck from elapsed time alone.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "list",
        "cancel"
      ]
    },
    "jobId": {
      "type": "string",
      "description": "Required for cancel. Exact jobId from export_project or manage_exports list."
    }
  },
  "required": [
    "action"
  ]
}
```

**Arguments.** Strict decode. Keys: `action` (String, required) and `jobId`. Only jobs of the **current project** are visible.

**list**
- A `jobId` is not allowed: `manage_exports: jobId only applies to cancel`.
- Returns `{exports:[row…]}`, newest first. Each row is `{jobId, filename, path, status, progress, queuePosition?, error?, warnings?, result?}`:
  - `status` is one of `queued|preparing|rendering|canceling|completed|failed|canceled`.
  - `progress` is an integer 0–100.
  - `queuePosition` is the 1-based position among all waiting jobs.
  - `result` exists for palmier exports: `{collectedMediaRefs, copiedInternalMediaCount, missingMedia:[{id,name}], totalBytes}`.

**cancel**
- The `jobId` must be a valid UUID: `manage_exports: cancel requires a valid jobId`.
- It must belong to this project: `manage_exports: export not found in the current project`.
- Outcome by job state:
  - waiting: removed from the queue, status `removed`;
  - preparing or rendering: `canceling` if cancellation was accepted, otherwise the current status;
  - already canceling: `canceling`;
  - terminal states: the status is unchanged and `cancellationRequested:false`.
- Returns `{jobId, filename, status, cancellationRequested}`.

Any other action: `manage_exports: action must be list or cancel`. Neither action is undoable.

### 3.9 `get_media` — CORE

**Description (verbatim):**

~~~text
The library inventory: media assets, folders, and timelines. Call before referencing any asset — every mediaRef in other tools comes from the asset ids returned here. Assets report name, type, durationSeconds, width/height/fps, hasAudio, folder path, and (for AI-generated assets) the generation prompt as a content hint. generationStatus appears only while an async generation/import is unresolved (preparing | generating | downloading | failed) — its absence means the asset is ready.

Filters: ids (poll specific placeholders cheaply), folder (a path; includes subfolders), pending:true (only unresolved generations/imports). Filtered reads return just the matching assets; unfiltered reads also include folders (as paths) and timelines.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional. Return only these asset ids — the cheap way to poll a generation placeholder."
    },
    "folder": {
      "type": "string",
      "description": "Optional folder path filter, e.g. 'B-roll/Sunset'. Includes subfolders."
    },
    "pending": {
      "type": "boolean",
      "description": "Optional. true returns only assets with an unresolved generationStatus."
    }
  }
}
```

**Arguments.** Allowed keys: `folder, ids, pending`.
- `ids` is a string array, ID-expanded; non-strings are dropped.
- `folder` is a strict path lookup, see §2.2. On failure: `Folder not found: …`.
- `pending` must be a JSON boolean.

**Execution.** Iterates the media manifest entries in library order. Read-only.

Asset filtering:
- `ids` keeps only the listed assets.
- `pending:true` keeps only assets that have a non-`none` generation status.
- `folder` keeps assets in that folder or any descendant folder. Assets at the root are excluded.

Asset row: `{id, name, type, durationSeconds?, width?, height?, fps?, hasAudio?, folder?, generationStatus?, draft?, canEnhanceDraft?, prompt?}`.
- `type` is one of `video|audio|image|lottie|subtitle`.
- `durationSeconds` is included only when greater than 0. `width` and `height` are the source dimensions.
- `hasAudio` is included only for video that has audio. `folder` is the folder path.
- `generationStatus` is included only while pending. Values: `generating`, `downloading`, `rendering`, or `failed: <message>`.
  - The persisted `none` and `preparing` states are not reported, despite the description.
  - With an `ids` filter, a `failed: …` status is also recorded as the session's last error, for `send_feedback`.
- `draft:true` for draft generations. `canEnhanceDraft:true` is added when the draft is not pending, has a backend job ID, and has at least 2 result URLs.
- `prompt` is the generation prompt, truncated to 100 characters plus `…`.

**Result.** Text JSON, rounded: `{assets:[…]}`. An **unfiltered** read also includes `folders` (all folder paths, sorted case-insensitively, omitted if there are none) and `timelines` (the detailed timeline entries, §2.2).

### 3.10 `inspect_media` — CORE

**Description (verbatim):**

~~~text
Look at a media asset before referencing or editing it. Images: the image plus dimensions and EXIF. Video: sample frames plus a transcription of the audio track. Audio: transcription. Lottie: frames sampled evenly across the animation (over gray), plus framerate and duration — use this to verify a Lottie you wrote looks and moves right. Sampled frames and stills overlay a 0–1 coordinate grid (origin top-left). Overview storyboards do not include the grid. Transcription is sentence-level segments — [text, start, end] tuples, capped at 400 — in source seconds, or project frames when clipId is set. When capped, pass the returned nextStartSeconds as startSeconds for the next page.

Long media: pass overview=true for a one-image storyboard, read the segments, then re-call with startSeconds/endSeconds to zoom — windowed calls only transcribe that span, so they are fast.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "mediaRef": {
      "type": "string",
      "description": "Asset ID from get_media."
    },
    "clipId": {
      "type": "string",
      "description": "Optional. A clip referencing this mediaRef; transcript times come back as project frames for that clip (out-of-range entries dropped)."
    },
    "maxFrames": {
      "type": "integer",
      "description": "Video and Lottie. Sample frame count (default 6, max 12)."
    },
    "startSeconds": {
      "type": "number",
      "description": "Video/audio. Source-time window start; scopes frames and transcription."
    },
    "endSeconds": {
      "type": "number",
      "description": "Video/audio. Window end (default: asset duration)."
    },
    "wordTimestamps": {
      "type": "boolean",
      "description": "Video/audio. Add word-level [text, start, end] tuples (capped at 10000 — most clips return all words at once; narrow with startSeconds/endSeconds only for very long media). Use for word-boundary edits like filler-word removal."
    },
    "overview": {
      "type": "boolean",
      "description": "Video only. One storyboard grid of visually distinct, timestamped moments instead of frames — far more coverage per token; few tiles means static footage. maxFrames ignored."
    },
    "language": {
      "type": "string",
      "description": "Optional BCP-47 language tag of the spoken audio (e.g. 'es', 'fr', 'ja', 'zh-Hans'). Defaults to the system language. Specify when the spoken language differs from the system locale — on-device models are language-specific and will produce garbled output if the wrong language is used."
    }
  },
  "required": [
    "mediaRef"
  ]
}
```

**Arguments.** Allowed keys: `clipId, endSeconds, language, maxFrames, mediaRef, overview, startSeconds, wordTimestamps`. Parsing is lenient: doubles, ints, and bools accept numeric or boolean strings.

**Validation.**
- `mediaRef` is required: `Missing required argument: mediaRef`. It must exist: `Media asset not found: <id>`.
- The file must be on disk. If it is not, the error depends on the asset's status:
  - `Asset <id> is still preparing. Poll get_media and retry once generationStatus becomes 'none'.` (and the same with `downloading`, `generating`, or `rendering` in place of `preparing`)
  - `Asset <id> failed: <msg>`
  - `Media file not on disk: <filename>`
- `clipId`, if given, must exist (`Clip not found: <id>`) and reference this asset: `Clip <c> does not reference mediaRef <m> (it references <r>)`.
- `language` is resolved against the locales supported by on-device transcription, **for every asset type**: `inspect_media: on-device transcription does not support language '<lang>'.`
- The time range for video and audio:
  - `s = max(startSeconds ?? 0, 0)` and `e = min(endSeconds ?? duration, duration)`.
  - It requires `s < e`, otherwise `Invalid time range [<s>, <e>] for media of duration <d>s`.

**Base metadata** (`baseMeta`, shared by every type): `{id, name, type, durationSeconds (3dp), fileName, generationStatus? (only when not none), width?, height?, fps?, prompt? (truncated to 100)}`.

**By asset type:**
- **image**
  - The image is downscaled so the longest edge is at most 1568 and overlaid with the 0–1 grid (no caption).
  - Encoding: PNG if the source has alpha and the PNG is at most 3.5 MB; otherwise JPEG at decreasing qualities until it is at most 3.5 MB.
  - Blocks: `[image, text]`.
  - Metadata adds `mimeType`, `byteSize` (file size), `encodedByteSize`, `coordinateGrid`, and `imageProperties?:{pixelWidth, pixelHeight, orientation, depth, colorModel}`. Only these properties are reported, despite the "EXIF" wording.
  - Error: `Failed to read or decode image file`.
- **video**
  - The duration must be greater than 0: `Video has zero duration: <name>`.
  - Metadata adds `hasAudio`, and `timeRange:[s,e]` when windowed.
  - Visuals and transcription run concurrently.
  - Visuals:
    - **Frames mode** (default):
      - `count = clamp(maxFrames ?? 6, 1, 12)`. Frame `i` is at `s + (e−s)(i+0.5)/count`, with ±0.25 s tolerance.
      - Frames are at most 512 px on the longest edge, with the grid overlay and the preferred track transform applied, JPEG at quality 0.7.
      - Metadata adds `frameTimestamps` (3dp) and `coordinateGrid`.
      - Errors: `No video track available in <name>`, `Failed to extract frames from <name>`.
    - **Overview mode** (`overview` true): a single storyboard JPEG at quality 0.7, with no grid.
      - Candidate frames are taken every `max(1, span/120)` s, with tolerance of half that interval.
      - A tile is kept only when its 16×16 luma-grid mean difference from the last kept tile exceeds 12.
      - At most 36 tiles, subsampled evenly. Tiles are 160×90 in 6 columns, each with a time label (`m:ss` or `h:mm:ss`).
      - Metadata adds `overview:{tileTimestamps:[…]}`.
      - Errors: `Overview failed: <No video track available | Window too short for a overview | Could not decode frames for overview | Failed to compose overview>`.
  - Transcription runs only when the video has audio: local on-device ASR, cached per file, windowed to the time range, using `language` when given.
    - On success: `transcription:<transcriptionMeta>`.
    - On failure: `transcriptionError:<message>`. This is **not fatal**.
  - Blocks: `[images…, text]`.
- **audio**
  - Transcription is required: `Transcription failed: <msg>`.
  - The `transcriptionMeta` fields are merged into the top level of the metadata, plus `timeRange?`.
  - Text only.
- **lottie**
  - `count = clamp(maxFrames ?? 6, 1, 12)` frames, sampled evenly and composited over 50% gray, with the grid, JPEG at quality 0.7.
  - Metadata adds `framerate`, `frameCount`, `durationSeconds`, `sampledFrameIndices`, `coordinateGrid`, and `note:"Lottie frames sampled evenly across the animation; transparent areas composited over gray."`.
- **subtitle**
  - The SRT or WebVTT file is parsed.
  - Metadata adds `cueCount` and `cues:[{startSeconds, endSeconds, text}]`, capped at 500. Over the cap, `note:"Showing the first 500 of <n> cues."` is added.
  - Error: `Failed to parse subtitle file: <msg>`.
- `text` and `sequence` assets are refused: `Text clips are not stored as media assets.`, `Sequences are timelines, not media assets. Use get_timeline.`

**`transcriptionMeta`:** `{timing:"sourceSeconds"|"projectFrames", language?, segments:[[text,start,end]], totalSegments?, nextStartSeconds?, segmentsNote?, words?, totalWords?, wordsNote?}`.
- **Source-seconds timing:** values have 2 decimals, or `null` when missing.
- **Clip mapping** (`clipId` given): each span is clamped to the clip's visible source span, in project-fps source frames. The timeline frame is `round(clip.start + (srcFrame − visibleStart)/speed)`. Spans entirely outside the visible span are dropped.
  - Metadata adds `timelineMapping:{clipId, clipStartFrame, clipEndFrame, fps, note:"transcription segments/words are project frames for this clip; out-of-range entries are dropped."}`.
- **Segment cap:** 400. Beyond it, `segmentsNote:"First 400 of <n> segments. Continue with startSeconds = nextStartSeconds."`
- **Words** (only with `wordTimestamps`): `[text,start,end]` rows, capped at 10000. Beyond it, `wordsNote:"First 10000 of <n> words. Narrow with startSeconds/endSeconds."`

All metadata is rounded to 3 decimals. The tool is read-only.

### 3.11 `search_media` — NEEDS-ML

**Description (verbatim):**

~~~text
Search the media library by content: what's on screen (visual) and what's said (spoken). Visual matching is semantic and on-device — phrase the query like an image caption ('a wide shot of a harbor at sunset'), not keywords; covers videos and stills. A visual search automatically installs a missing on-device model. Spoken matching layers exact keywords over on-device semantic matching of transcript segments — quote the words said, or paraphrase them; transcripts are created automatically while indexing (and by inspect_media and add_captions), so coverage grows as indexing completes. The two groups rank independently and are never blended. Scores are uncalibrated — use them for ordering only.

Hits are source-second ranges (image hits have no time range). To place exactly that moment, pass [startSeconds, endSeconds] straight to add_clips as source — no unit conversion.

An `index` object appears only while it can explain missing results (status: indexing | downloadingModel | preparing | disabled | failed, with indexedAssets vs indexableAssets). modelDownloadProgress is 0...1 while downloading; modelDownloadError reports the current failure. When present, moments may be incomplete — report that instead of concluding the footage doesn't exist, and don't poll in a loop. No index key means visual search was complete. Spoken results work regardless.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "What to find. Visual: a caption-style scene description. Spoken: the words to match."
    },
    "scope": {
      "type": "string",
      "enum": [
        "visual",
        "spoken",
        "both"
      ],
      "description": "Optional. Default both."
    },
    "mediaRef": {
      "type": "string",
      "description": "Optional. Restrict the search to one asset from get_media."
    },
    "limit": {
      "type": "integer",
      "description": "Optional. Max hits per group (default 10, max 50)."
    }
  },
  "required": [
    "query"
  ]
}
```

**Arguments.** Allowed keys: `limit, mediaRef, query, scope`.
- `query` is required and trimmed: `search_media: query is empty`.
- `scope` defaults to `both`: `search_media: scope must be visual, spoken, or both (got '<s>')`.
- `limit` is clamped to 1…50 (default 10).
- `mediaRef` restricts the search to one existing asset: `Media asset not found: <id>`.

**Visual search** (when `scope ≠ spoken`):
- Indexable assets are the video and image assets, within the restriction.
- If any indexable asset exists and visual search is enabled:
  - an `unknown` model state triggers `prepare()`;
  - a `notInstalled` state triggers a background **auto-download** of the model.
- Status values:
  - `disabled` when visual search is turned off;
  - `ready`, or `indexing` while the indexer is active;
  - `modelNotInstalled`, `downloadingModel`, `preparing`, `failed`.
- The `index` object is included only when indexable assets exist and either the status is not `ready` or `indexedAssets < indexableAssets`: `{status, indexableAssets, indexedAssets?, modelDownloadProgress? (0…1), modelDownloadError?}`.
- Hits are text-to-image similarity over indexed shots:
  - `moments:[{mediaRef, name, score, startSeconds, endSeconds}]`;
  - an image hit is `{mediaRef, name, score, type:"image"}`.

**Spoken search** (when `scope ≠ visual`): `TranscriptSearch` over the video and audio assets with cached transcripts. Returns `spoken:[{mediaRef, name, startSeconds, endSeconds, text}]`.

**Result.** Text JSON, rounded: `{timelineFps, moments?, index?, spoken?}`. Read-only.

### 3.12 `import_media` — CORE

**Description (verbatim):**

~~~text
Imports external media into the project's library — the bridge for assets coming from other MCP servers (stock libraries, music services, web search) or local files the user already has. The 'source' object must set exactly one of: url (HTTPS only — downloaded in the background, the dominant case; max 1 GB), path (absolute local file path — referenced in place and not copied into the project; may also be a directory, which is imported recursively, mirroring its subfolder structure as media folders), bytes (base64-encoded inline data — max ~15 MB of base64 ≈ 11 MB binary; use url/path for anything larger), or matte (a generated solid-color PNG). For url, type is inferred from the URL path's file extension unless source.mimeType is set as an override (needed for signed URLs whose path has no usable extension). For bytes, source.mimeType is required.

Supported types and extensions: video (mov, mp4, m4v), audio (mp3, wav, aac, m4a, aiff, aifc, caf, flac), image (png, jpg, jpeg, tiff, heic), subtitle (srt, vtt — becomes a subtitle asset; place its cues as caption clips at their timecodes via add_captions subtitleMediaRef or a user drag onto the timeline; not placeable via add_clips). Anything else is rejected — the caller must transcode externally.

URL imports run in the background and return {mediaRef, status:'downloading'} — poll get_media with ids:[mediaRef] until generationStatus clears, then the asset is usable in add_clips. Path, directory, bytes, and matte imports finish inline with status:'ready'. Costs nothing.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "source": {
      "type": "object",
      "description": "Exactly one of url, path, bytes, or matte must be set. mimeType is required when bytes is set; for url it acts as a type-inference override.",
      "properties": {
        "url": {
          "type": "string",
          "description": "HTTPS URL. Pre-signed URLs are fine but must not expire mid-download."
        },
        "path": {
          "type": "string",
          "description": "Absolute local file or directory path, readable by the Palmier process. Files are referenced in place and must remain available. A directory is imported recursively and its folder structure is replicated as media folders."
        },
        "bytes": {
          "type": "string",
          "description": "Base64-encoded media data. Prefer url or path for anything over ~10MB."
        },
        "matte": {
          "type": "object",
          "description": "Generates a solid-color PNG matte instead of importing a file.",
          "properties": {
            "hex": {
              "type": "string",
              "description": "Hex color, e.g. '#000000' or '#FFFFFF'."
            },
            "aspectRatio": {
              "type": "string",
              "enum": [
                "Project",
                "16:9",
                "9:16",
                "1:1",
                "4:3",
                "9:14",
                "2.4:1"
              ],
              "description": "Defaults to Project (timeline resolution). Other values use the project's short edge."
            }
          },
          "required": [
            "hex"
          ]
        },
        "mimeType": {
          "type": "string",
          "description": "Required when bytes is set. Optional override for url when its path has no usable extension (e.g. signed URLs). Accepted: video/mp4, video/quicktime, audio/mpeg, audio/wav, audio/aac, audio/mp4, image/png, image/jpeg, image/tiff, image/heic, application/x-subrip, text/vtt."
        }
      }
    },
    "name": {
      "type": "string",
      "description": "Display name in the library. Defaults to the filename derived from url/path, or 'Imported asset' for bytes."
    },
    "folder": {
      "type": "string",
      "description": "Optional destination folder path, e.g. 'B-roll/Sunset'. Created if missing. Omit for the project root."
    }
  },
  "required": [
    "source"
  ]
}
```

**Arguments.** Allowed top-level keys: `folder, name, source`. Allowed `source` keys: `bytes, matte, mimeType, path, url`. Allowed `source.matte` keys: `aspectRatio, hex`.

**Validation.**
- A `source` object is required: `Missing required 'source' object`.
- Exactly one of url, path, bytes, or matte must be set: `source must set exactly one of 'url', 'path', 'bytes', or 'matte' (got <n>)`.
- `folder` is resolved **and created if missing** before the import runs. Creation happens outside the import's undo group.

**Modes:**
- **path**
  - **Missing:** `File not found: <path>`.
  - **Directory:** imported recursively, mirroring its subfolders as media folders under `folder`, as one undo group "Import Media (Agent)".
    - Returns `{status:"ready", imported:<assetCount>, folders:<folderCount>, note:"Imported from '<dirname>', mirroring its structure. See get_media."}`.
    - With no supported files: `No supported media found in folder: <path>`.
  - **File:**
    - The extension must map to a type. Supported: mov/mp4/m4v, mp3/wav/aac/m4a/aiff/aifc/caf/flac, png/jpg/jpeg/tiff/heic, **json (Lottie)**, srt/vtt.
    - Otherwise: `Unsupported file extension '.<ext>'. Supported: mov/mp4/m4v, mp3/wav/aac/m4a/aiff/aifc/caf/flac, png/jpg/jpeg/tiff/heic, json (Lottie), srt/vtt (subtitles).`
    - A json file must be a valid Lottie: `Unsupported Lottie file: <name>`.
    - A project must be open: `No project is open; cannot import from path`.
    - The file is **referenced in place**, not copied. The asset is registered under undo group "Import Media (Agent)", then finalized by reading its metadata (duration, dimensions, fps, audio).
    - Failures: `Failed to register imported asset`, `Could not read media file: <name>`.
    - Returns `{mediaRef, name, type, status:"ready"}`.
- **bytes**
  - `mimeType` is required: `source.mimeType is required when source.bytes is set`.
  - Size limit: at most 15,728,640 base64 characters, otherwise `source.bytes is too large (<n> chars; max 15728640). Use source.url or source.path for larger files.`
  - MIME-to-extension map:
    - video: `video/mp4|video/mpeg4`→mp4, `video/quicktime`→mov;
    - audio: `audio/mpeg|audio/mp3`→mp3, `audio/wav|audio/x-wav|audio/wave`→wav, `audio/aac`→aac, `audio/mp4|audio/m4a|audio/x-m4a`→m4a, `audio/aiff|audio/x-aiff`→aiff, `audio/aifc|audio/x-aifc`→aifc, `audio/caf|audio/x-caf`→caf, `audio/flac|audio/x-flac`→flac;
    - image: `image/png`→png, `image/jpeg|image/jpg`→jpg, `image/tiff`→tiff, `image/heic|image/heif`→heic;
    - Lottie: `application/json|application/vnd.lottie+json`→json;
    - subtitles: `application/x-subrip|text/srt`→srt, `text/vtt`→vtt.
  - Unknown MIME type: `Unsupported mimeType '<m>'. Accepted: video/mp4, video/quicktime, audio/mpeg, audio/wav, audio/aac, audio/mp4, audio/aiff, audio/x-caf, audio/flac, image/png, image/jpeg, image/tiff, image/heic, application/x-subrip, text/vtt.`
  - Base64 decoding ignores unknown characters, and the result must be non-empty: `source.bytes is not valid non-empty base64`.
  - The data is staged, then committed into the project package `media/` folder as `imported-<8 hex>.<ext>`, and added under "Import Media (Agent)".
  - Errors: `No project is open; cannot import bytes`, `source.bytes is not a valid Lottie animation`.
  - Returns `{mediaRef, name, type, status:"ready"}`.
  - The actual default name is derived from the staged filename, not "Imported asset" as the description says.
- **url**
  - URL validation:
    - `source.url is not a valid URL`
    - `source.url must use https`
    - `source.url must not embed credentials`
    - `source.url has no host`
  - The type comes from the `mimeType` override when given (same map; an unknown MIME type gives the error above). Otherwise it comes from the URL path extension, which must be supported: `Cannot infer media type from URL extension <.ext|(none)>. Set source.mimeType to disambiguate (e.g. 'video/mp4', 'image/png').`
  - A project must be open: `No project is open; cannot import from URL`.
  - The display name is `name`, or the URL's last path component stem, or `Imported asset`.
  - A **placeholder asset** is added at once:
    - ID is a new UUID; the file path is `<project>/media/imported-<id prefix 8>.<ext>`;
    - `generationStatus = downloading`, and `importInput = {sourceURL, createdAt}`;
    - it is placed in `folder`.
  - The download runs in the background:
    - the request timeout is 15 min, and the download is canceled beyond **5 GiB**, even though the description says 1 GB;
    - a response outside 2xx fails with `server returned HTTP <code>`;
    - on success the file is committed into the package and finalized, and the status clears;
    - on failure, `generationStatus = failed: <message>`.
  - Returns immediately: `{mediaRef, type, status:"downloading", note:"Downloading in the background. Poll get_media with ids:[\"<id>\"] until generationStatus clears."}`.
- **matte**
  - `hex` is required (trimmed): `source.matte requires 'hex'.`
  - `aspectRatio` must be one of `Project` (default; timeline resolution), `16:9`, `9:16`, `1:1`, `4:3`, `9:14`, `2.4:1`. The non-Project ratios use the project's short edge.
  - Otherwise: `source.matte: unknown aspectRatio '<a>'. Use one of Project, 16:9, 9:16, 1:1, 4:3, 9:14, 2.4:1.`
  - `createMatte` writes a solid-color PNG into the package and adds an image asset.
  - Returns `{mediaRef, name, type:"image", status:"ready"}`.

None of the import modes touches the timeline.

### 3.13 `capture_frame` — CORE

**Description (verbatim):**

~~~text
Capture one video frame as a full-resolution PNG media asset. Use timelineFrame to capture the active timeline's final composited image, including transforms, crop, edge softness, edge rounding, color, effects, text, and captions. Use mediaRef with sourceSeconds to capture an unedited frame directly from a source video instead. Pass the asset's durationSeconds as sourceSeconds to capture its final decodable frame. Exactly one mode is allowed. The returned mediaRef is ready for add_clips, generate_video startFrameMediaRef/endFrameMediaRef, generate_image references, or inspect_media. Every call creates one new undoable media asset.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "timelineFrame": {
      "type": "integer",
      "description": "Project frame in the active timeline. Use this alone for the composited timeline image."
    },
    "mediaRef": {
      "type": "string",
      "description": "Video asset ID from get_media. Use with sourceSeconds for a raw source frame."
    },
    "sourceSeconds": {
      "type": "number",
      "description": "Source time in seconds for mediaRef. May equal durationSeconds to select the final decodable frame."
    },
    "name": {
      "type": "string",
      "description": "Optional media-library name for the captured PNG."
    }
  }
}
```

**Arguments.** Strict decode. Keys: `mediaRef, name, sourceSeconds, timelineFrame`.

**Validation.**
- Exactly one mode: `timelineFrame` **xor** (`mediaRef` and/or `sourceSeconds`). Otherwise: `Provide exactly one capture mode: timelineFrame, or mediaRef with sourceSeconds.`
- Media mode needs both fields: `mediaRef and sourceSeconds are both required for a source-video capture.`
- `name` is trimmed. Errors: `name must not be empty.`, `name must be 200 characters or fewer.`
- Domain errors:
  - `No project is open.`
  - `The timeline is empty.`
  - `Timeline frame <f> is outside 0..<<total>.`
  - `Media asset not found: <ref>`
  - `Media asset <ref> is not a video.`
  - `Media asset <ref> is still preparing.` (for any generating, downloading, or other non-ready status)
  - `Media asset <ref> failed: <reason>`
  - `The destination media folder no longer exists.`

**Execution.**
- **Timeline mode:** renders the active timeline's composited frame at **full timeline resolution**. Default name: `Frame <f>`.
- **Media mode:** decodes the source video at `sourceSeconds`. A value equal to the duration selects the last decodable frame. Default name: `<media name> frame`.
- The PNG is staged, then committed into the package as `frame-<8 hex>.png`.
- An image asset is added (duration = the default image duration) under one undo group "Capture Frame". The asset is indexed for visual search.

**Result.** Text JSON, rounded: `{status:"ready", mediaRef, name, type:"image", mimeType:"image/png", width, height, capturedFrom}`, where `capturedFrom` is `{timelineFrame, timelineId}` or `{mediaRef, sourceSeconds, actualSourceSeconds?}`.

### 3.14 `organize_media` — CORE

**Description (verbatim):**

~~~text
Reorganizes the library in one undoable action: create folders, move items into folders, rename items, delete items. An item is a media asset id (from get_media), a timelineId, or a folder path like 'B-roll/Sunset' — the tool tells them apart. Folders are always addressed by path, never by id; destination paths are created if missing. Arrays apply in order (createFolders, moves, renames, deletes), but item references resolve against the library as it was before the call — only 'into' destinations may name folders the same call creates.

Deleting an asset also removes every clip referencing it (reported as clipsRemoved). Deleting a folder deletes its subfolders and assets; timelines inside move to the root instead. Deleting a timeline leaves nest clips referencing it rendering black (a warning reports how many); the last remaining timeline can't be deleted. Returns only what actually happened — createdFolders, moved, renamed, deleted, clipsRemoved, warnings.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "createFolders": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Folder paths to ensure exist, e.g. ['Hero shots/Takes']. Existing folders are left alone. Rarely needed — moves and generation 'folder' params create folders on their own."
    },
    "moves": {
      "type": "array",
      "description": "Each entry files items into one destination folder.",
      "items": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Asset ids, timeline ids, and/or folder paths to move."
          },
          "into": {
            "type": "string",
            "description": "Destination folder path; created if missing. Omit to move to the project root."
          }
        },
        "required": [
          "items"
        ]
      }
    },
    "renames": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "item": {
            "type": "string",
            "description": "Asset id, timeline id, or folder path."
          },
          "name": {
            "type": "string",
            "description": "New display name (a name, not a path — renaming never moves)."
          }
        },
        "required": [
          "item",
          "name"
        ]
      }
    },
    "deletes": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Asset ids, timeline ids, and/or folder paths to delete."
    }
  }
}
```

**Arguments.** Allowed top-level keys: `createFolders, deletes, moves, renames`.
- `moves[i]` allows `into` and `items`. `items` is required and non-empty: `moves[<i>]: items is required`.
- `renames[i]` allows `item` and `name`, both required strings: `Missing required argument: item|name`.
- `moves` and `renames`, when present, must be non-empty arrays of objects:
  - `'<key>' must be a non-empty array`
  - `<key>[<i>] must be an object`
- At least one operation: `Nothing to do — pass at least one of createFolders, moves, renames, deletes.`

**Resolving items.** Each item string is resolved against the library as it was **before** the call:
- an asset ID, otherwise
- a timeline ID, otherwise
- a folder path (strict lookup).
- Failure: `<path>: '<ref>' is not an asset id, timeline id, or folder path. Folders: <list>`. `items`, `item`, and `deletes` are ID-expanded.

**Further validation:**
- Folder-cycle check, done by path when parsing: `Can't move folder '<p>' into itself or its own subfolder.`
- The project must keep at least one timeline: `Can't delete every timeline — the project needs at least one.`
- All `createFolders` and `into` paths are validated (syntax and ambiguity) before any mutation.

**Execution.** One undo group "Organize Media", applied in this order:
1. Create the folders (missing segments are created; existing ones are untouched).
2. Apply the moves (create the `into` path if needed; an omitted `into` means the root). Assets, timelines, and folders move to the destination.
3. Apply the renames (a name only; renaming never moves anything).
4. Apply the deletes: assets first, then folders, then timelines.
   - Deleting an **asset** removes every clip that references it, in **all** timelines.
   - Deleting a **folder** deletes its subfolders and assets; timelines inside it move to the root.
   - Deleting a **timeline** leaves nest clips that reference it rendering black.

**Result.**
- If the active timeline is unchanged: a mutation delta (§2.3) with these extra keys: `createdFolders?:[paths]`, `moved?:<item count>`, `renamed?:<count>`, `deleted?:{assets?, folders?, timelines?}`, `clipsRemoved?` (count across timelines from asset and folder deletes), and `warnings?:["<n> nest clip(s) still reference deleted timeline(s) and will render black."]`.
- If deleting changed the active timeline: the plain payload with `notes:["Active timeline changed — re-read get_timeline."]`.

### 3.15 `add_clips` — CORE

**Description (verbatim):**

~~~text
Places one or more media assets on the timeline as a single undoable action. Each entry's asset type must be compatible with its target track (video/image are interchangeable across video/image tracks; audio requires an audio track). When a video asset with audio is placed on a video track, a linked audio clip is automatically created on an audio track (an existing one if available, otherwise a new one). The whole batch is one undo step.

trackIndex is optional. Omit it on all entries and the tool auto-creates the needed tracks — one shared video track for visual entries (above existing visuals) and one shared audio track for audio entries (appended below existing audio, so linked dialogue on A1 stays put and music/VO land on A2+). To target existing tracks, set trackIndex on every entry. Mixing (some entries specify, others omit) is rejected — split into two calls.

Tracks work as layers: clips on the SAME track are sequential — if a new clip's range overlaps an existing clip on that track, the existing clip is trimmed/split/removed to make room, matching the UI's drag-onto-track overwrite behavior.

NESTING: mediaRef may also be a timelineId — the timeline is placed as a single live nested clip (mediaType 'sequence'), with a linked audio clip when the child has audio. Duration defaults to the child's full length; source and endFrame work as for video. Cycles (a timeline containing itself) and empty timelines are rejected.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "entries": {
      "type": "array",
      "description": "Clips to add. Each entry is validated up front; one bad entry rejects the whole call with no partial state.",
      "items": {
        "type": "object",
        "properties": {
          "mediaRef": {
            "type": "string",
            "description": "ID of the media asset from get_media"
          },
          "trackIndex": {
            "type": "integer",
            "description": "Optional. Track index (0-based). Omit on every entry to auto-create one shared track per asset zone (video/audio)."
          },
          "startFrame": {
            "type": "integer",
            "description": "Timeline frame position to place the clip (project frames)."
          },
          "endFrame": {
            "type": "integer",
            "description": "Optional. Occupy timeline frames [startFrame, endFrame) — a gap from get_timeline copies straight in. For stills and frame-exact fills. Mutually exclusive with source."
          },
          "source": {
            "type": "array",
            "items": {
              "type": "number"
            },
            "description": "Optional. [startSeconds, endSeconds] — which span of the source to use, in the source seconds search_media hits and inspect_media segments speak. For stills this is the display length in seconds. Omit both for the whole asset. Mutually exclusive with endFrame."
          }
        },
        "required": [
          "mediaRef",
          "startFrame"
        ]
      }
    }
  },
  "required": [
    "entries"
  ]
}
```

**Arguments.** Strict decode. Top-level key: `entries`. Each entry allows `endFrame, mediaRef, source, startFrame, trackIndex`; unknown keys fail with `entries[<i>]: unknown field(s) …`.
- `entries` must be non-empty: `Missing or empty 'entries' array`.
- `startFrame` and `mediaRef` are required for every entry.

**Per-entry validation** (all entries are checked before any mutation):
- **`mediaRef` resolution (`clipSource`):**
  - A media asset ID resolves to that asset. A subtitle asset fails with `entries[<i>]: '<id>' is a subtitle file and can't be placed as a clip. Use add_captions with subtitleMediaRef to place its cues as captions.`
  - Otherwise it must be a **timeline ID**, which places a nested `sequence` clip. Unknown IDs fail with `entries[<i>]: media asset or timeline not found: <id>`.
  - Nesting errors: `entries[<i>]: "<name>" is empty. Add clips before nesting it.` and `entries[<i>]: Can't nest "<name>" — it would contain itself.`
  - A nested stand-in has duration `child.totalFrames / fps`, `hasAudio` if the child has audio clips, and the child's dimensions.
- **`trackIndex`:**
  - Must be in range: `entries[<i>]: track index <t> out of range (0..<n-1>)`.
  - Must be type-compatible: `entries[<i>]: asset type <t> is not compatible with <type> track at index <k>`. Video, image, lottie, text, and sequence go on video tracks; audio goes on audio tracks.
- **`startFrame ≥ 0`:** `entries[<i>]: startFrame must be >= 0 (got <n>)`.
- **All or none for `trackIndex`:** `Mixed trackIndex: <k> of <n> entries omitted trackIndex. Either set it on every entry or omit it on every entry (to auto-create shared tracks).`
- **`endFrame > startFrame`:** `entries[<i>]: endFrame (<e>) must be greater than startFrame (<s>)`.

**Placement** (`resolvePlacement`, at project fps):
- `source` and `endFrame` are mutually exclusive: `<path>: set source OR endFrame, not both — source picks a span of the asset, endFrame an exact timeline length.`
- **With `source: [a, b]`:**
  - It must have exactly 2 elements: `<path>: source must be [startSeconds, endSeconds] (got <n> element[s])`.
  - The asset needs a known duration, except stills: `<path>: source needs a known source length; this asset has none. Use endFrame.`
  - `start = max(a, 0)`. `end = b` for stills, otherwise `min(b, duration)`. It requires `end > start`, otherwise `<path>: source end (<b>) must be greater than start (<a>); source is <d>s.` (the `; source is <d>s` part is omitted for stills).
  - `trimStart = secondsToFrame(start)` and `duration = max(1, secondsToFrame(end) − trimStart)`.
- **With `endFrame`:**
  - `duration = end − start`, which must be at least 1.
  - For non-stills it must not exceed the source length: `<path>: endFrame spans <d> frames but the source is only <len>.` Placement starts at trim 0.
- **Neither:** the whole asset. A non-still needs a known length: `<path>: endFrame is required for this asset — its source length is unknown.`

**Execution.** One undo group, "Add Clip (Agent)" or "Add Clips (Agent)".
1. `applySettingsIfNeededForAgent` with the non-sequence assets:
   - The timeline adopts the first clip's resolution when the project settings were not configured yet, or when the resolution mismatches. This yields a note: `Set timeline to <W>×<H> to match clip.` or `Matched timeline resolution to clip: <W>×<H>.`
   - fps is **never** adopted. When the first video's rounded fps differs from the project fps, this note is added: `Clip is <n>fps but project is <p>fps; clips placed at <p>fps and frame counts are interpreted at <p>fps. To conform, call set_project_settings then re-read get_timeline.`
2. If every entry omits `trackIndex`, the needed tracks are created first:
   - one new **video** track at index 0 (on top), shared by all visual entries;
   - one new **audio** track appended at the bottom, shared by all audio entries.
3. Entries are placed with audio entries first, then by (trackId, startFrame). For each entry:
   - `clearRegion(track, [start, start+duration))` trims, splits, or removes overlapping clips: the overwrite behaviour.
   - `placeClip(...)` places the clip. A video, or a nested sequence with audio, placed on a video track **auto-creates a linked audio clip** on an existing compatible audio track if one is free, otherwise on a new audio track.
   - If placement fails: `entries[<i>]: failed to place clip on track <t> at frame <s>`.
4. Tracks that were non-empty before and became empty are removed.

**Result.** A mutation delta (§2.3), with the settings notes when present.

### 3.16 `insert_clips` — CORE

**Description (verbatim):**

~~~text
Inserts one or more media assets at a single point and RIPPLES: every clip at or after atFrame is pushed right to open a gap, so nothing is overwritten. This is the non-destructive counterpart to add_clips (which clears the landing region, trimming/splitting/removing whatever's there). Use insert_clips to splice footage in without losing existing clips; use add_clips to fill empty space or deliberately overwrite.

Entries are laid end-to-end starting at atFrame on the target track (entry[0] at atFrame, entry[1] immediately after, ...). The push equals the sum of the entries' durations and is applied to the target track, every sync-locked track, AND the audio track any auto-created linked audio lands on — so a clip and its linked audio stay aligned. As in add_clips, a video asset with audio spawns a linked audio clip. One undoable action; one bad entry rejects the whole call with no partial state.

trackIndex is required — ripple needs an existing track to push. For placement into empty space, use add_clips.

As in add_clips, mediaRef may be a timelineId to splice in a nested timeline.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "trackIndex": {
      "type": "integer",
      "description": "Track index (0-based, from get_timeline) to insert into and ripple."
    },
    "atFrame": {
      "type": "integer",
      "description": "Timeline frame (project frames) where insertion begins. Every clip at or after this frame on rippled tracks shifts right by the total inserted duration."
    },
    "entries": {
      "type": "array",
      "description": "Clips to insert, placed sequentially from atFrame. Validated up front; one bad entry rejects the whole call.",
      "items": {
        "type": "object",
        "properties": {
          "mediaRef": {
            "type": "string",
            "description": "ID of the media asset from get_media."
          },
          "source": {
            "type": "array",
            "items": {
              "type": "number"
            },
            "description": "Optional. [startSeconds, endSeconds] — which span of the source to use, in source seconds; for stills, the display length. Omit for the whole asset. Mutually exclusive with durationFrames."
          },
          "durationFrames": {
            "type": "integer",
            "description": "Optional. Exact length in project frames (entries stack end-to-end, so they have lengths, not positions). Mutually exclusive with source."
          }
        },
        "required": [
          "mediaRef"
        ]
      }
    }
  },
  "required": [
    "trackIndex",
    "atFrame",
    "entries"
  ]
}
```

**Arguments.** Strict decode. Top-level keys: `atFrame, entries, trackIndex`, all required. Each entry allows `durationFrames, mediaRef, source`.
- `entries` must be non-empty: `Missing or empty 'entries' array`.
- `trackIndex` must exist: `trackIndex <t> out of range (0..<n-1>)`.
- `atFrame ≥ 0`: `atFrame must be >= 0 (got <n>)`.
- Each entry's asset is resolved as in add_clips (timeline IDs nest) and must be compatible with the target track type: `entries[<i>]: asset type <t> is not compatible with <type> track at index <k>`.
- Placement uses add_clips' rules, with `durationFrames` in place of `endFrame`. The messages say `durationFrames`, for example `<path>: durationFrames must span at least 1 frame`.

**Execution.** One undo group, "Insert Clip(s) (Agent)":
- `applySettingsIfNeededForAgent` runs first (same notes as add_clips).
- `rippleInsertClips(specs, trackIndex, atFrame)`:
  - Entries are laid end to end starting at `atFrame`.
  - Every clip at or after `atFrame` shifts right by the total duration. This applies on the target track, on **every sync-locked track**, and on the audio track that receives auto-created linked audio.
  - A video with audio spawns linked audio, as in add_clips.
- No clip IDs back: `Insert failed on track <t> at frame <f>`.

**Result.** A mutation delta. Large ripples typically appear as `shifted` rules.

### 3.17 `move_clips` — CORE

**Description (verbatim):**

~~~text
Moves one or more clips to a new track and/or frame position. Single undoable action. Each move specifies the clip ID and at least one of toTrack (must be compatible with the clip's media type) and toFrame. Overlap on the destination is resolved as in add_clips (existing clips on the destination track are trimmed/split/removed). Linked partners follow the named clip: startFrame propagates as a delta to preserve l-cut / j-cut offsets; tracks stay with the named clip. Multicam clips must move as a whole group; partial group moves and camera lane changes are refused.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "moves": {
      "type": "array",
      "description": "Per-clip move requests. At least one of toTrack or toFrame is required per entry.",
      "items": {
        "type": "object",
        "properties": {
          "clipId": {
            "type": "string",
            "description": "The clip ID to move."
          },
          "toTrack": {
            "type": "integer",
            "description": "Destination track index (0-based). Omit to keep the clip on its current track."
          },
          "toFrame": {
            "type": "integer",
            "description": "Destination start frame. Omit to keep the clip at its current start."
          }
        },
        "required": [
          "clipId"
        ]
      }
    }
  },
  "required": [
    "moves"
  ]
}
```

**Arguments.** Strict decode. Top-level key: `moves` (non-empty: `Missing or empty 'moves' array`). Each move allows `clipId, toFrame, toTrack`.

**Per-move validation:**
- At least one target: `moves[<i>]: at least one of 'toTrack' or 'toFrame' is required`.
- The clip must exist: `moves[<i>]: clip not found: <id>`.
- `toTrack` must exist (`moves[<i>]: toTrack <t> out of range (0..<n-1>)`) and be compatible with the clip's current track type: `moves[<i>]: toTrack <t> (<type>) is incompatible with clip's <type> source track`.
- `toFrame ≥ 0`: `moves[<i>]: toFrame must be >= 0 (got <n>)`.

**Execution.**
- **Linked partners.** For each move with `toFrame`, the linked partners of the named clip move by the same frame delta (`partnerMoves`). This preserves J-cut and L-cut offsets. Partners stay on their own tracks.
- **Multicam guard.** Multicam clips must move as a whole group:
  - `Can't move a multicam camera clip to another track — the group's program track stays fixed.`
  - `Can't move part of multicam group "<name>" — its clips stay in sync and move together.`
- **Apply.** One undo group, "Move Clip(s) (Agent)", calls `moveClips(moves)`. Overlaps on the destination are resolved by overwrite, as in add_clips.

**Result.** A mutation delta, with the named clips and their partners as `touched`.

### 3.18 `remove_clips` — CORE

**Description (verbatim):**

~~~text
Removes one or more clips by ID as a single undoable action. Any clip that belongs to a link group (e.g. a video with its paired audio) takes its whole group with it, matching the UI's linked-delete behavior.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipIds": {
      "type": "array",
      "description": "Clip IDs to remove.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "clipIds"
  ]
}
```

**Arguments.** Allowed key: `clipIds`, a string array, ID-expanded.
- It must be non-empty: `Missing or empty 'clipIds' array`.
- Every ID must exist: `Clip not found: <id>`.

**Execution.**
- The selection expands to whole link groups (`expandToLinkGroup`): removing a video also removes its linked audio.
- One undo group, "Remove Clip(s) (Agent)", calls `removeClips`. Gaps are left; there is no ripple.

**Result.** A mutation delta, mainly `removedClipIds`.

### 3.19 `manage_clip_links` — CORE

**Description (verbatim):**

~~~text
Links or unlinks clips as one undoable action without moving, trimming, or aligning them. link merges the complete existing groups touched by clipIds and requires at least two clips of different media types. unlink accepts one or more members and dissolves each member's complete link group. Use unlink before independently trimming the audio or video side of a J-cut or L-cut; relink afterward when the clips should move together again.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "link",
        "unlink"
      ]
    },
    "clipIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "action",
    "clipIds"
  ]
}
```

**Arguments.** Strict decode. Keys: `action` (`link`|`unlink`) and `clipIds` (non-empty: `manage_clip_links.clipIds must be a non-empty array`).
- Every element must be non-empty (`manage_clip_links.clipIds[<i>] must be a non-empty clip ID`) and must exist (`Clip not found: <id>`).

**link**
- `linkTargets` requires at least 2 clips, at least 2 distinct media types, and not already exactly one complete group.
- It merges the complete existing groups that the clips touch.
- Otherwise: `Link requires at least two clips of different media types that are not already one link group`.

**unlink**
- `unlinkTargets` collects the complete groups of the given members, and all of those groups are dissolved.
- If none of the clips is linked: `None of the provided clips is linked`.

**Execution.** `linkClips` or `unlinkClips` runs via `mutateClips` with the undo action "Link" or "Unlink" (one undo step). The executor adds no wrapper. Clips are not moved or trimmed.

**Result.** A mutation delta, with `touched` = the target set. The clips are re-reported with or without folded `audio`.

### 3.20 `manage_tracks` — CORE

**Description (verbatim):**

~~~text
Reorders, names, configures, or removes tracks in one undoable action. Prefer stable trackId selectors; numeric indexes use the order at call time. Index 0 renders on top, and reorder destinations must stay within the track's video/audio zone. Arrays run reorder → set → remove. User-authored names are returned separately from generated V1/A1 labels. Returns receipts and the resulting track order. Tracks holding multicam clips can't be removed or sync-unlocked.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "reorder": {
      "type": "array",
      "description": "Moves, applied in order. Use to fix stacking, e.g. bring a PIP inset's track to index 0.",
      "items": {
        "type": "object",
        "properties": {
          "trackId": {
            "type": "string",
            "description": "Stable track ID from get_timeline."
          },
          "index": {
            "type": "integer",
            "description": "Track to move (0-based, current order)."
          },
          "to": {
            "type": "integer",
            "description": "Exact destination index in the same type zone."
          }
        },
        "required": [
          "to"
        ]
      }
    },
    "set": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "trackId": {
            "type": "string",
            "description": "Stable track ID from get_timeline."
          },
          "index": {
            "type": "integer",
            "description": "Track to change (0-based, current order)."
          },
          "muted": {
            "type": "boolean",
            "description": "Silence/unsilence the track's audio."
          },
          "hidden": {
            "type": "boolean",
            "description": "Exclude/include a video track in the render."
          },
          "syncLocked": {
            "type": "boolean",
            "description": "Whether ripple edits shift this track along."
          },
          "name": {
            "type": "string",
            "maxLength": 80,
            "description": "Prefer exactly one short word with no spaces. Avoid generic suffixes: use Main, Brand, Headline, Outro, Product, Dialogue, Music, SFX, Ambience, or Foley; not Main Video, Brand Text, Outro Video, or Audio Bed. Preserve an exact user-supplied name and pass an empty string to clear it."
          }
        }
      }
    },
    "remove": {
      "type": "array",
      "description": "Tracks to remove with all their clips. Prefer {trackId}; bare integers are legacy current indexes.",
      "items": {
        "type": [
          "integer",
          "object"
        ],
        "properties": {
          "trackId": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

**Arguments.** Allowed top-level keys: `remove, reorder, set`.
- **Track selectors.** An entry passes **either** `trackId` (an existing ID) **or** `index` (an exact integer). Otherwise: `<path>: pass one current trackId or index`.
  - Indexes refer to the order **at call time**: `<path>: track index <i> out of range (timeline has <n> tracks)`.
- **`reorder[i]`**
  - Keys: `index, to, trackId`. Each entry must be an object: `reorder[<i>] must be an object`.
  - `to` must be an exact integer: `<path>: 'to' is required and must be an integer`.
  - `to` must be within the same type zone: `<path>: destination index <to> is outside the track's type zone`.
- **`set[i]`**
  - Keys: `hidden, index, muted, name, syncLocked, trackId`. Each entry must be an object: `set[<i>] must be an object`.
  - `muted`, `hidden`, and `syncLocked` must be JSON booleans. Other types are silently ignored.
  - `name` must be a string (`<path>.name must be a string`):
    - it is trimmed;
    - it must have no control or newline characters and be at most 80 characters (`<path>.name must be one line of at most 80 characters`);
    - an empty string clears the name.
  - At least one field is required: `<path>: pass at least one of muted, hidden, syncLocked, name`.
- **`remove[i]`**
  - Either an integer index or a `{trackId|index}` object: `<path> must be an integer index or track selector object`.
- At least one of the three arrays must be non-empty: `Nothing to do — pass at least one of reorder, set, remove.`

**Multicam guards:**
- `A multicam group's track can't be removed — delete the group's clips first (remove_clips) and the empty track prunes itself.`
- `Sync lock stays on for a multicam group's tracks — unlocking would let ripples shift the group's members apart.`

**Execution.** One undo group, "Manage Tracks (Agent)":
1. **Reorder**, sequentially: `reorderTrackLive(id, to)` for each entry, then `commitTrackReorder`. The result records `(from, to)` per entry.
2. **Set**: mute, hidden, and sync-lock are toggled only when they differ from the current value. Names are applied with `setTrackName`, which reports whether the name changed.
3. **Remove**: the listed tracks and all their clips are removed.

**Result.** A mutation delta with these extra keys:
- `tracks`: the resulting order, `[{trackId, index, label, type, name?, muted?:true, hidden?:true, syncLocked?:false}]`. Because `tracks` is present, the "Track indices shifted" note is suppressed.
- `reordered?:[{trackId, from, to, changed}]`
- `renamed?:[{trackId, name|null, changed}]`
- `removedTracks?:[{trackId, index, label, type}]`, using pre-removal indexes.

### 3.21 `split_clips` — CORE

**Description (verbatim):**

~~~text
Splits clips into two at one or more cut points, all in a single undoable action. A split only inserts a boundary — it never trims media or moves clips, so unlike ripple_delete_ranges nothing shifts and there's no gap to close.

Two modes — pass exactly one:
• splits: an array of {clipId, atFrame} (project frames). Use when you know the clip IDs.
• trackIndex + frames: cut one track at the given project frames; each frame is matched to whichever clip on that track contains it. Pairs naturally with get_transcript / get_timeline project frames.

Every frame must fall strictly between a clip's start and end. Multiple cuts on the SAME clip are allowed — pass all the frames at once and each is resolved against the current sub-clips. Duplicate cut points are ignored. Linked audio/video partners are split at the same frame so A/V stays in sync, and the right halves are regrouped into their own link pair. One bad cut point rejects the whole call with no partial state.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "splits": {
      "type": "array",
      "description": "Explicit cuts. Each item is {clipId, atFrame}.",
      "items": {
        "type": "object",
        "properties": {
          "clipId": {
            "type": "string",
            "description": "The clip ID to split"
          },
          "atFrame": {
            "type": "integer",
            "description": "Project frame to split at (strictly between clip start and end)"
          }
        },
        "required": [
          "clipId",
          "atFrame"
        ]
      }
    },
    "trackIndex": {
      "type": "integer",
      "description": "Track to cut (use with 'frames')"
    },
    "frames": {
      "type": "array",
      "description": "Project frames to cut on trackIndex; each is matched to the clip containing it.",
      "items": {
        "type": "integer"
      }
    }
  }
}
```

**Arguments.** Strict decode. Keys: `frames` ([Int]), `splits` (`[{clipId, atFrame}]`, both required), `trackIndex`. Exactly one mode: `Provide exactly one of 'splits' (an array of {clipId, atFrame}) or 'trackIndex'+'frames' (project frames to cut on one track).`

**Cut resolution** (against the current timeline):
- **`splits` mode:** the clip must exist (`Clip not found: <id>`). Each frame must be strictly inside the clip: `Frame <f> is outside clip <id> range (<start>..<end>)`.
- **Track mode:**
  - `trackIndex is required and must be in 0..<n-1>`
  - `'frames' must be a non-empty array of project frames`
  - Each frame matches the clip that strictly contains it: `Frame <f> is not strictly inside any clip on track <t>`.
- Duplicate (track, frame) pairs are ignored. With no cut points left: `No valid split points`.

**Execution.**
- One undo group, "Split Clip(s) (Agent)", calls `splitClips(at: [(trackIndex, frame)])`.
- Several cuts on one clip are resolved progressively against the resulting sub-clips.
- Linked partners are split at the same frame, and the right halves are re-grouped as a new link pair.
- Nothing shifts.

**Result.** A mutation delta: new right-half clips appear in `clips`, and the left halves are reported as changed.

### 3.22 `ripple_delete_ranges` — CORE

**Description (verbatim):**

~~~text
Cuts one or more ranges out and closes the gaps in one undoable action — the fast path for filler-word/dead-air removal. Replaces hand-cranked split_clips → remove_clips → move_clips loops: pass every range at once.

Two modes — pass exactly one of clipId or trackIndex:
• trackIndex (preferred for transcript-driven cuts): ranges are PROJECT frames and may span any number of clips on that track. get_transcript returns a clips array with nested words in project frames — collect every cut across the whole timeline and pass them in ONE call, no per-clip splitting and no re-reading the timeline between cuts. units must be 'frames'.
• clipId: ranges are cut within that single clip only, clamped to its visible span. Allows units 'seconds' (source-media seconds, e.g. inspect_media WITHOUT a clipId or search_media hits); 'frames' = project frames. Use when you already have one clip's per-word timestamps.

Overlapping ranges merge. Linked audio/video partners of every touched clip are cut on the same span so A/V stays in sync. Remaining clips shift left to close every gap; sync-locked tracks shift along to preserve alignment (their content isn't cut). Refuses without changing anything if a sync-locked track can't absorb the shift (e.g. it would move past frame 0). The refusal names the blocking track (e.g. "V2") — map it to its index via get_timeline and pass that index in ignoreSyncLockedTracks to cut anyway, leaving that track's clips in place. Returns the anchor track's post-cut layout (clip ids/frames) so you don't need to re-read.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "trackIndex": {
      "type": "integer",
      "description": "Cut project-frame ranges spanning every clip they cross on this track, in one call. From get_transcript's clips array. Mutually exclusive with clipId; requires units 'frames'."
    },
    "clipId": {
      "type": "string",
      "description": "Cut ranges within this single clip only, clamped to its visible span. Mutually exclusive with trackIndex."
    },
    "ranges": {
      "type": "array",
      "description": "Ranges to remove, each a [start, end] pair (end > start). In the unit given by 'units'.",
      "items": {
        "type": "array",
        "items": {
          "type": "number"
        },
        "minItems": 2,
        "maxItems": 2
      }
    },
    "units": {
      "type": "string",
      "enum": [
        "seconds",
        "frames"
      ],
      "description": "Interpretation of range values. 'frames' (default) = project/timeline frames, matching get_transcript and inspect_media-with-clipId. 'seconds' = source-media seconds (clipId mode only)."
    },
    "ignoreSyncLockedTracks": {
      "type": "array",
      "items": {
        "type": "integer"
      },
      "description": "Track indices to exempt from sync-lock for this call only. Their clips stay put instead of shifting to close the gap. Use to get past a refusal naming a sync-locked overlay track (e.g. a text track that can't absorb the shift) when the cut doesn't touch that track's content."
    }
  },
  "required": [
    "ranges"
  ]
}
```

**Arguments.** Strict decode. Keys: `clipId, ignoreSyncLockedTracks` ([Int]), `ranges` ([[Double]], required), `trackIndex`, `units`.

**Validation.**
- `ranges` must be non-empty: `Missing or empty 'ranges' array`.
- `units` must be `frames` (default) or `seconds`: `units must be 'seconds' or 'frames' (got '<u>')`.
- Exactly one of `clipId` and `trackIndex`: `Provide exactly one of 'clipId' (cut within a single clip; allows 'seconds') or 'trackIndex' (cut project-frame ranges spanning a whole track in one call).`
- Each range is `[start, end]` with `end > start`:
  - `ranges[<i>]: expected [start, end] (got <n> element[s])`
  - `ranges[<i>]: end (<e>) must be greater than start (<s>)`

**Range resolution.**
- **clipId mode:**
  - In `frames` units, values are project frames as-is.
  - In `seconds` units, values are **source** seconds, mapped as `clip.start + (v·fps − trimStart)/max(speed, 0.0001)`.
  - Each end is clamped (rounded) to `[clip.start, clip.end]`. Empty ranges are dropped and counted.
  - If nothing remains: `No ranges fall within clip <id> (frames <s>..<e>). In '<units>' units, ranges must overlap the clip's visible span.`
- **trackIndex mode:**
  - `units 'seconds' requires a clipId for source-media mapping; with trackIndex, ranges are project frames.`
  - `Track index out of range: <t>`
  - Ranges are clamped (rounded) to `[0, totalFrames]`, and empty ones are dropped and counted.
  - If nothing remains: `No valid project-frame ranges to delete on track <t>.`

**Execution.** One undo group, "Ripple Delete (Agent)", calls `rippleDeleteRangesOnTrack(trackIndex, ranges, ignoreSyncLockTrackIndices)`:
- Overlapping ranges merge.
- Every clip on the anchor track that the ranges cross is cut, **and so are the linked A/V partners** of the touched clips, across the same spans.
- Remaining clips shift left to close the gaps.
- Sync-locked tracks that are not ignored shift along, without cutting their content.
- **Refusals** (no state change). The reason is returned as the error:
  - `Sync-locked track "<label>" would move past the timeline start.`
  - `Can't shift part of multicam group "<name>" — <labels> would stay behind and desync.`
  - `No non-empty ranges to delete`

**Result.** A mutation delta with the extra keys `removedFrames` and `rangesIgnored?` (the dropped-range count). `touched` = the resulting fragments on the anchor track.

### 3.23 `swap_clip_media` — CORE

**Description (verbatim):**

~~~text
Replace a clip's source with another library asset while preserving its edit, timing, framing, effects, and keyframes. Linked video/audio clips that share the source are updated together. The replacement must have the same source type, contain audio when a linked audio clip needs it, and cover the current source range; extra tail remains available for trimming. Text, nested timeline, and multicam clips are refused; use change_cam for multicam.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipId": {
      "type": "string",
      "description": "Clip ID from get_timeline."
    },
    "mediaRef": {
      "type": "string",
      "description": "Replacement asset ID from get_media."
    }
  },
  "required": [
    "clipId",
    "mediaRef"
  ]
}
```

**Arguments.** Allowed keys: `clipId` and `mediaRef`, both required strings (`Missing required argument: …`). The replacement must exist: `Replacement media not found: <id>`.

**Execution.** `editor.swapClipMedia(clipId, replacement)` validates the replacement, then commits the swap as one undo step that it registers internally. It keeps the edit (start, duration, trims, speed), framing, effects, and keyframes. Linked video and audio clips that share the source are swapped together.

**Errors:**
- `Clip not found: <id>`
- `Linked clip not found.`
- `Replacement must match the clip's source type.`
- `Replacement video has no audio for the linked clip.`
- `Replacement media has no valid duration.`
- `Clip has invalid source timing.`
- `Replacement media is too short for the clip's source range.`
- `This clip does not support media source swapping.` (text and nested timeline clips)
- `Use change_cam for multicam clips.`

**Result.** A mutation delta with extra keys `{changed, clipId, oldMediaRef, mediaRef, affectedClipIds}`. When `changed` is false, `touched` is empty, so the payload reports a no-op.

### 3.24 `set_clip_properties` — CORE

**Description (verbatim):**

~~~text
Apply the same generic clip property values to one or more clips in a single undoable action. Pass any combination of durationFrames, trimStartFrame, trimEndFrame, speed, volumeDb, opacity, fades, edgeRounding, edgeSoftness, transform, crop, or blendMode (video/image clips only). For text content, typography, captions, and text animation, use update_text.

NOT for preview layout — split screen, picture-in-picture, grid, sidebar, and any multi-clip canvas arrangement belong to apply_layout, which sets transform and crop together. Do not use transform or crop here (or set_keyframes position/scale/crop) to build those layouts.

All values apply to every clip in clipIds; for per-clip differences, make separate calls. trimStartFrame/trimEndFrame are offsets from the source media, not the timeline. speed 1.0 is normal, <1.0 slows (clip gets longer on the timeline), >1.0 speeds up. volumeDb is −60 through +15 dB; 0 dB keeps source level and −60 dB is mute. opacity is 0.0–1.0. fadeInFrames/fadeOutFrames are clip-relative lengths; 0 clears that fade, and their sum must fit within the resulting clip duration. Fades multiply existing opacity or volume keyframes instead of replacing them: visual/text clips fade opacity, while audio clips fade gain. Fades are per-clip and don't propagate to linked media — include both the visual clip id and its nested audio.id from get_timeline to fade picture and sound together. edgeRounding and edgeSoftness are 0.0–1.0, where 1 reaches half the shorter visible edge. transform is for rare single-clip tweaks only — 0–1 normalized canvas coords, partial merge; rotation is clockwise degrees; flipHorizontal/flipVertical mirror across the axis.

For moves and start-frame changes, use move_clips. For animated values (keyframes), use set_keyframes — setting volumeDb, opacity, transform.rotation, or crop here clears any existing keyframe track on that property.

Timing changes (durationFrames, trimStartFrame, trimEndFrame, speed) on a linked clip carry over to its linked partner so audio/video stay in sync — same as the timeline UI. Per-clip fields (volumeDb, opacity, fades, edgeRounding, edgeSoftness, transform, crop, blendMode) don't propagate. trim and speed are skipped for text partners.

Timing fields (trims, durationFrames, speed) are refused on multicam clips — they would slip the clip out of sync; property fields stay editable, and angle changes go through change_cam.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipIds": {
      "type": "array",
      "description": "Clip IDs to update. The property values below apply to every clip in this list.",
      "items": {
        "type": "string"
      }
    },
    "durationFrames": {
      "type": "integer",
      "description": "New duration in frames."
    },
    "trimStartFrame": {
      "type": "integer",
      "description": "SOURCE-media offset, NOT a timeline frame: frames trimmed off the start of the source — measured in PROJECT frames (the timeline's fps, same units as startFrame/durationFrames; never the source's own fps). To turn a get_transcript project frame P into this clip's source offset, use trimStartFrame + (P − startFrame) × speed; setting trimStartFrame to that value makes the clip begin at P's source content."
    },
    "trimEndFrame": {
      "type": "integer",
      "description": "SOURCE-media offset, NOT a timeline frame: frames trimmed off the end of the source, in PROJECT frames. Maps the same way as trimStartFrame via startFrame/speed."
    },
    "speed": {
      "type": "number",
      "description": "Playback speed multiplier (default 1.0). >1 speeds up, <1 slows down. The clip's timeline length is rescaled to keep the same source content (2x speed → half the frames), unless you also pass durationFrames to set the length explicitly."
    },
    "volumeDb": {
      "type": "number",
      "minimum": -60,
      "maximum": 15,
      "description": "Volume in decibels from −60 through +15. 0 dB keeps source level; −60 dB is mute. Clears existing volume keyframes."
    },
    "opacity": {
      "type": "number",
      "description": "Opacity 0.0-1.0. Clears any existing opacity keyframes."
    },
    "fadeInFrames": {
      "type": "integer",
      "minimum": 0,
      "description": "Fade length from the clip's first frame. 0 clears it. Multiplies existing opacity/volume keyframes."
    },
    "fadeOutFrames": {
      "type": "integer",
      "minimum": 0,
      "description": "Fade length ending at the clip's last frame. 0 clears it. fadeInFrames + fadeOutFrames must not exceed the resulting clip duration."
    },
    "fadeInInterpolation": {
      "type": "string",
      "enum": [
        "linear",
        "smooth"
      ],
      "description": "Curve for the fade in. Omit to keep the current curve."
    },
    "fadeOutInterpolation": {
      "type": "string",
      "enum": [
        "linear",
        "smooth"
      ],
      "description": "Curve for the fade out. Omit to keep the current curve."
    },
    "edgeRounding": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Video, image, Lottie, and nested timeline clips only. Uniform edge rounding from 0 (square) to 1 (half the shorter visible edge)."
    },
    "edgeSoftness": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Video, image, Lottie, and nested timeline clips only. Edge feathering from 0 (crisp) to 1 (half the shorter visible edge)."
    },
    "transform": {
      "type": "object",
      "description": "Single-clip only — not for split screen, PIP, or grid (use apply_layout). Partial transform; omitted fields keep current values. Static rotation uses clockwise degrees and clears rotation keyframes.",
      "properties": {
        "centerX": {
          "type": "number"
        },
        "centerY": {
          "type": "number"
        },
        "width": {
          "type": "number"
        },
        "height": {
          "type": "number"
        },
        "rotation": {
          "type": "number",
          "description": "Clockwise degrees."
        },
        "flipHorizontal": {
          "type": "boolean",
          "description": "Mirror across the vertical axis."
        },
        "flipVertical": {
          "type": "boolean",
          "description": "Mirror across the horizontal axis."
        }
      }
    },
    "crop": {
      "type": "object",
      "description": "Static source crop for video, image, Lottie, and nested timeline clips. Partial; omitted edges keep current values. Insets are 0–1 of the source (left/top/right/bottom). All zeros restore the full source. Clears crop keyframes. Not for split screen/PIP/grid — use apply_layout.",
      "properties": {
        "left": {
          "type": "number",
          "description": "Inset from the source left edge, 0–1."
        },
        "top": {
          "type": "number",
          "description": "Inset from the source top edge, 0–1."
        },
        "right": {
          "type": "number",
          "description": "Inset from the source right edge, 0–1."
        },
        "bottom": {
          "type": "number",
          "description": "Inset from the source bottom edge, 0–1."
        }
      }
    },
    "blendMode": {
      "type": "string",
      "enum": [
        "normal",
        "darken",
        "multiply",
        "colorBurn",
        "lighten",
        "screen",
        "colorDodge",
        "overlay",
        "softLight",
        "hardLight",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity"
      ],
      "description": "Video/image clips only. How the clip composites over the tracks below it (Premiere/Photoshop blend modes). 'normal' is the default (source-over) and clears any blend. Rejected on text/audio clips."
    }
  },
  "required": [
    "clipIds"
  ]
}
```

**Arguments.** Strict decode. Allowed keys: `blendMode, clipIds, crop, durationFrames, edgeRounding, edgeSoftness, fadeInFrames, fadeInInterpolation, fadeOutFrames, fadeOutInterpolation, opacity, speed, transform, trimEndFrame, trimStartFrame, volumeDb`.
- `transform` must be an object (`set_clip_properties.transform: expected object`). Its keys: `centerX, centerY, flipHorizontal, flipVertical, height, rotation, width`.
- `crop` must be an object. Its keys: `bottom, left, right, top`.

**Validation.** Everything happens before mutation:
- **Required inputs:**
  - `clipIds` must be non-empty: `Provide a non-empty 'clipIds' array`.
  - At least one property: `set_clip_properties needs at least one property to apply`.
- **Timing fields:**
  - `durationFrames ≥ 1`
  - `speed > 0`
  - `trimStartFrame ≥ 0` and `trimEndFrame ≥ 0`
- **Audio and opacity:**
  - `volumeDb` in [−60, 15]: `volumeDb must be between -60.0 and +15.0 dB (got <v>)`.
  - `opacity` in [0, 1].
- **Fades:**
  - `fadeIn/OutFrames ≥ 0`.
  - The interpolation must be `linear` or `smooth`: `<field> must be 'linear' or 'smooth' (got '<v>')`.
  - The fades must fit: `fadeIn ≤ duration` and `fadeOut ≤ duration − fadeIn`, computed against the duration *after* the timing changes in the same call. Otherwise: `Fades for clip <id> must fit within its resulting duration of <d> frames (fadeInFrames <a> + fadeOutFrames <b>)`.
- **Edges:** `edgeRounding` and `edgeSoftness` must be finite and in [0, 1]: `<name> must be between 0 and 1 (got <v>)`.
- **Clips:** every clip must exist: `Clip not found: <id>`.
- **Multicam:** timing fields are refused on multicam clips: `Timing fields would slip a multicam clip out of sync — switch angles with change_cam; split/delete and property fields (volumeDb, opacity, edgeRounding, edgeSoftness, transform, crop) stay editable.`
- **`blendMode`:**
  - Refused on text and audio clips: `blendMode only applies to video/image clips: <ids>`.
  - `normal` clears the blend mode.
  - An unknown mode: `invalid blendMode '<m>'. Valid: normal, darken, …`.
- **Text and audio clips:**
  - `edgeRounding` and `edgeSoftness` are refused: `edgeRounding and edgeSoftness only apply to non-text visual clips: <ids>`.
  - `crop` is refused: `crop only applies to non-text visual clips: <ids>`.
- **Crop:**
  - Each given inset must be ≥ 0: `set_clip_properties.crop.<edge> must be >= 0 (got <v>)`.
  - The insets are merged onto the clip's crop **as evaluated at the playhead** (`cropAt(activeFrame)`).
  - The visible fraction must be at least 0.05 on each axis: `set_clip_properties.crop must leave at least 0.05 of the source visible on each axis (got width <w>, height <h>)`.

**Execution.** One undo group, "Set Clip Property/Properties (Agent)". For each clip, via `commitClipProperty`:
- **Timing**, in this order:
  - `setDuration(durationFrames)`;
  - trims, set as given;
  - `speed`: if `durationFrames` was not given, the duration is rescaled to `max(1, round(duration·oldSpeed/newSpeed))`, then the speed is set.
  - Nested-sequence clips skip speed, with the note `<id>: speed skipped (nested timelines don't support retiming)`.
- **`volumeDb`** sets the linear volume `10^(dB/20)` and clears volume keyframes.
- **`opacity`** sets the value and clears opacity keyframes.
- **Fades:** `setFade` and `setFadeInterpolation`.
- **`edgeRounding` and `edgeSoftness`** are set as given.
- **`blendMode`** is set, or cleared by `normal`.
- **`transform`** is a partial merge. `rotation` clears rotation keyframes.
- **`crop`** sets the merged crop and clears crop keyframes.
- **Linked partners:** when any timing field is given, `timingPropagationPartners` apply the same `durationFrames`, trims, and speed to the linked partners. Text partners receive only `durationFrames`.
- **Notes:** `Setting a static value cleared existing keyframes on: <ids>.` plus any "skipped" notes.

**Result.** A mutation delta with the extra key `changed` (whether any target or partner clip differs after the call). `touched` = the clips and their partners.

### 3.25 `copy_clip_settings` — CORE

**Description (verbatim):**

~~~text
Copy one clip's static settings to one or more clips of the same media type in a single undoable action. Use for requests such as "make these shots look like that one," "use this title style," or "give these audio clips the same treatment."

Choose exactly one target mode. targetClipIds applies to an explicit list and refuses any mismatched media type. targetTrack selects every same-type clip on one stable trackId; add range [startFrame, endFrame) to limit it to clips intersecting that part of the timeline. Track mode excludes the source and mismatched clips, returns compact matched/changed/unchanged/incompatible counts instead of clip IDs, and refuses when no compatible clips match.

Video, image, Lottie, and nested-timeline clips copy transform, crop, opacity, edge rounding/softness, blend mode, and the complete effect stack including color. Text clips copy typography/style, text animation, fill mode, position, rotation, flips, opacity, and effects; target text, word timings, and caption membership stay intact, and the box is refit to the target content. Audio clips copy volume and effects, including denoise. Settings absent from the source clear the corresponding target setting.

This does NOT copy placement, duration, trims, speed, fades, top-level keyframes, media, links, caption groups, or multicam membership. Use set_clip_properties and set_keyframes for temporal changes. Linked audio is a separate audio clip: copy it explicitly using the nested audio.id from get_timeline.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "sourceClipId": {
      "type": "string",
      "description": "Clip whose current static settings are copied."
    },
    "targetClipIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Explicit destination clips. Every target must have the same mediaType as the source. Use this or targetTrack, not both."
    },
    "targetTrack": {
      "type": "object",
      "properties": {
        "trackId": {
          "type": "string",
          "description": "Stable trackId from get_timeline."
        },
        "range": {
          "type": "array",
          "items": {
            "type": "integer"
          },
          "minItems": 2,
          "maxItems": 2,
          "description": "Optional [startFrame, endFrame) timeline range. Only intersecting clips are considered; omit for the whole track."
        }
      },
      "required": [
        "trackId"
      ]
    }
  },
  "required": [
    "sourceClipId"
  ]
}
```

**Arguments.** Strict decode. Keys: `sourceClipId` (required), `targetClipIds`, and `targetTrack`. `targetTrack` must be an object (`copy_clip_settings.targetTrack: expected object`) whose keys are `range` and `trackId`.
- Exactly one of `targetClipIds` and `targetTrack`: `Provide exactly one of 'targetClipIds' or 'targetTrack'`.
- `clipSettingsSnapshot(source)` reads the source: `Clip not found: <id>`.

**Explicit targets** (`targetClipIds`):
- De-duplicated and non-empty: `Provide a non-empty 'targetClipIds' array`.
- Every target must exist and have the source's media type: `Clip <t> is <type>; copied settings require <type> clips.`

**Track targets** (`targetTrack`):
- The track must exist: `Track not found: <id>`.
- `range` must be `[s, e)` with `0 ≤ s < e`: `targetTrack.range must be [startFrame, endFrame) with 0 <= startFrame < endFrame`.
- The clips on the track that intersect the range are scoped in. Targets are the same-type clips among them, excluding the source.
- With no target: `No <type> clips matched targetTrack <trackId>`.

**Execution.** One undo group, "Copy Clip Settings (Agent)", calls `applyClipSettings`. What is copied depends on the media type:
- **Video, image, Lottie, and sequence clips:** transform, crop, opacity, edge rounding and softness, blend mode, and the complete effect stack, including color.
- **Text clips:** typography and style, animation, fill mode, position, rotation, flips, opacity, and effects. The target's text, word timings, and caption membership are preserved, and the box is refit to the target's content.
- **Audio clips:** volume and effects, including denoise.

Settings absent on the source clear the corresponding target setting. Placement, duration, trims, speed, fades, keyframes, media, links, and caption or multicam membership are never copied.

**Result.** A mutation delta with extra keys `{changed, sourceClipId, mediaType}`, plus:
- **Explicit mode:** `{targetClipIds, changedClipIds, unchangedClipIds}`. `touched` = the changed clips.
- **Track mode:** `{targetTrack:{trackId, range?}, matchedClipCount, changedClipCount, unchangedClipCount, incompatibleClipCount, sourceExcluded}`. `touched` is empty, so no clip list is sent.

### 3.26 `set_keyframes` — CORE

**Description (verbatim):**

~~~text
Set animated keyframes on one property of one clip. Replaces the existing keyframe track for that property (pass an empty array to clear). Frames are CLIP-RELATIVE offsets (0 = first frame of the clip), so keyframes follow the clip when it moves. Rows are sorted by frame internally and the LAST row for any duplicate frame wins. Values must be finite numbers. Each row is `[frame, ...values, interp?]` where interp ∈ {linear, hold, smooth} (default smooth).

Properties and their value layouts:
  • volumeDb `[frame, decibels]` — −60 through +15 dB; 0 dB keeps source level and −60 dB is mute
  • opacity `[frame, value]` — value 0.0–1.0
  • rotation `[frame, degrees]` — clockwise degrees
  • position `[frame, topLeftX, topLeftY]` — TOP-LEFT corner in 0–1 normalized canvas coords. NOT the center. (Default static transform centers a full-canvas clip, so top-left of the static is (0, 0); a centered half-size clip has top-left (0.25, 0.25).)
  • scale `[frame, width, height]` — clip's normalized width and height in 0–1 canvas coords (1.0 = fills the canvas axis), NOT a scale factor. Text clips use this same track; use matching width/height ratios for uniform text scale.
  • crop `[frame, top, right, bottom, left]` — animated side insets in 0–1 of the source media. Constant crop belongs on set_clip_properties.
  • blur `[frame, radius]` — whole-layer Gaussian blur from 0–100 px; supported by visual clips including video, images, text, and nested timelines.

Motion keyframes (position/scale/rotation) override the static `transform` value when active.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipId": {
      "type": "string",
      "description": "The clip ID."
    },
    "property": {
      "type": "string",
      "enum": [
        "volumeDb",
        "opacity",
        "rotation",
        "position",
        "scale",
        "crop",
        "blur"
      ],
      "description": "Which property's keyframe track to set."
    },
    "keyframes": {
      "type": "array",
      "description": "Replacement keyframe rows. Empty array clears the track. Row shape depends on property — see tool description.",
      "items": {
        "type": "array"
      }
    }
  },
  "required": [
    "clipId",
    "property",
    "keyframes"
  ]
}
```

**Arguments.** Strict decode. Keys: `clipId, keyframes, property`.
- `keyframes` must be an array: `Missing required field 'keyframes' (must be an array)`.
- `property` must be one of `blur, crop, opacity, position, rotation, scale, volumeDb`: `Unknown property '<p>'. Expected one of: blur, crop, opacity, position, rotation, scale, volumeDb`.
- The clip must exist: `Clip not found: <id>`.
- `blur` requires a visual clip that supports blur keyframes: `Clip <id> does not support blur keyframes.`

**Rows.** Each row is `[frame, …values, interp?]`.
- **Arity:** exactly `1 + n` or `2 + n` elements:
  - `keyframes[<i>]: expected array [frame, <labels>, interp?]`
  - `keyframes[<i>]: expected [frame, <labels>] or [frame, <labels>, interp] (got <k> elements)`
- **frame:** an integer; booleans are rejected, and a fractional value is truncated toward zero.
- **values:** finite numbers.
- **interp:** `linear`, `hold`, or `smooth` (default `smooth`): `<path>: expected one of 'linear', 'hold', 'smooth' (got <x>)`.
- **Ranges:**
  - `volumeDb` in [−60, 15] (value label `decibels`);
  - `opacity` in [0, 1];
  - `blur` in [0, 100];
  - rotation, position, scale, and crop are not range-checked.
  - Out of range: `keyframes[<i>][1] (<label>): must be between <lo> and <hi> (got <v>)`.
- **Value layouts:**
  - `position`: `[a,b]`, the top-left corner;
  - `scale`: `[a,b]`, width and height;
  - `crop`: `[top, right, bottom, left]`.
- Rows are sorted by frame. For duplicate frames, the **last** row wins.

**Execution.**
- One undo group, "Set Keyframes (Agent)", **replaces** the property's whole track.
- An empty array clears the track: the track becomes nil, and the note is `Cleared <property> keyframes.`
- `blur` writes the `blur.gaussian` effect's radius track.
- Frames are clip-relative.

**Result.** A mutation delta with `touched = [clipId]`.

### 3.27 `apply_layout` — CORE

**Description (verbatim):**

~~~text
Arrange multiple clips into a common multi-video layout (split screen, picture-in-picture, grid) in one undoable action — the fast path for composing several videos in one frame. Use this instead of hand-setting transforms and screenshot-checking alignment with inspect_timeline.

You pick a named layout and assign a clip to each of its slots; the tool computes every transform and crop so each clip FILLS its region edge-to-edge WITHOUT stretching — the source is cropped to the slot's shape (cover), like a layout template the videos are dropped into. Pass fit='fit' to letterbox the whole source inside its slot instead (no crop, may leave bars) — use only when the full frame must stay visible (e.g. a screen recording).

The crop is centered by default. When that chops off something important (a face cropped at the forehead, a subject off to one side), bias which part survives: 'anchor' is a coarse shortcut ('top' keeps the top, etc.), while anchorX/anchorY (0–1) give continuous control for in-between framing — e.g. anchorY 0.35 moves the crop only slightly toward the top, not all the way. To nudge framing after the fact, call apply_layout again with adjusted anchorX/anchorY (clipIds mode re-crops in place).

Two modes (don't mix across slots):
• Place new clips: give each slot a 'mediaRef' (media asset from get_media, or a timelineId to nest) plus top-level startFrame (default 0) and endFrame. Creates one stacked video track per slot at that time range; for PIP the inset is placed on top automatically. Video and nested-timeline clips bring their linked audio.
• Re-layout existing clips: give each slot 'clipIds' — one or more existing clips (video, image, or nested timeline / mediaType 'sequence'), all framed into that slot (handy when a track holds several sequential takes). Only transforms/crop change — timing and tracks are untouched (so existing track order decides stacking).

Every slot of the chosen layout must be filled. Layouts and their slot names:
  • full — main
  • side_by_side — left, right
  • top_bottom — top, bottom
  • pip_bottom_right / pip_bottom_left / pip_top_right / pip_top_left — main, inset
  • grid_2x2 / grid_3x3 / grid_4x4 — equal cells named rNcN, counting from the TOP-LEFT: row 1 is the top row, column 1 is the left column. So r1c1 is top-left, a 3x3's middle is r2c2, and a 3x3's bottom-right is r3c3
  • main_sidebar — main (70%), sidebar (30%)
  • three_up — left, center, right (three vertical columns)
  • three_stack — top, middle, bottom (three horizontal rows)
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "layout": {
      "type": "string",
      "enum": [
        "full",
        "side_by_side",
        "top_bottom",
        "pip_bottom_right",
        "pip_bottom_left",
        "pip_top_right",
        "pip_top_left",
        "grid_2x2",
        "grid_3x3",
        "grid_4x4",
        "main_sidebar",
        "three_up",
        "three_stack"
      ],
      "description": "Which layout template to apply."
    },
    "slots": {
      "type": "array",
      "description": "One entry per slot of the chosen layout. Each entry names a 'slot' and gives exactly one of 'mediaRef' (place a new clip) or 'clipIds' (re-layout existing clip(s) into that slot). Don't mix placement (mediaRef) with re-layout (clipIds) across slots.",
      "items": {
        "type": "object",
        "properties": {
          "slot": {
            "type": "string",
            "description": "Slot name for the chosen layout (e.g. 'left', 'inset', or 'r1c1' for the top-left grid cell)."
          },
          "mediaRef": {
            "type": "string",
            "description": "Asset ID from get_media, or a timelineId to nest as a sequence clip. Use this OR clipIds."
          },
          "clipIds": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Existing clip(s) to frame into this slot — video, image, or nested timeline (mediaType 'sequence'). Every listed clip gets this slot's transform/crop (pass one id for a single clip, or several when a track holds sequential takes). Use this OR mediaRef. Clips sharing a slot may sit on the same track; clips in DIFFERENT slots still must not overlap on one track."
          },
          "anchor": {
            "type": "string",
            "enum": [
              "center",
              "top",
              "bottom",
              "left",
              "right",
              "top_left",
              "top_right",
              "bottom_left",
              "bottom_right"
            ],
            "description": "Coarse shortcut for which part of the source to keep when cover-cropping (default center). For in-between framing use anchorX/anchorY instead — the named values are just shortcuts for them."
          },
          "anchorX": {
            "type": "number",
            "description": "Fine horizontal framing, 0–1: 0 keeps the left edge, 0.5 centers (default), 1 keeps the right. Only affects slots cropped horizontally. Overrides anchor's x."
          },
          "anchorY": {
            "type": "number",
            "description": "Fine vertical framing, 0–1: 0 keeps the top (e.g. a forehead), 0.5 centers (default), 1 keeps the bottom. Nudge by small amounts (e.g. 0.35) to move the crop gradually. Only affects slots cropped vertically. Overrides anchor's y."
          }
        },
        "required": [
          "slot"
        ]
      }
    },
    "startFrame": {
      "type": "integer",
      "description": "Placement mode only (mediaRef slots). Project frame where the layout begins. Default 0."
    },
    "endFrame": {
      "type": "integer",
      "description": "Placement mode only (mediaRef slots). The placed clips occupy [startFrame, endFrame). Required when placing new clips."
    },
    "fit": {
      "type": "string",
      "enum": [
        "fill",
        "fit"
      ],
      "description": "How each clip fills its slot. 'fill' (default) covers the slot and center-crops the source (no stretch). 'fit' letterboxes the whole source inside the slot."
    }
  },
  "required": [
    "layout",
    "slots"
  ]
}
```

**Arguments.** Strict decode. Top-level keys: `endFrame, fit, layout, slots, startFrame`. Each slot allows `anchor, anchorX, anchorY, clipIds, mediaRef, slot`.
- **Layout and fit:**
  - Layouts: `full, side_by_side, top_bottom, pip_bottom_right, pip_bottom_left, pip_top_right, pip_top_left, grid_2x2, grid_3x3, grid_4x4, main_sidebar, three_up, three_stack`. Otherwise: `unknown layout '<l>'. Valid: …`.
  - `fit` is `fill` (default) or `fit`: `invalid fit '<f>'. Valid: fill, fit`.
- **Slots:**
  - The array must be non-empty.
  - Each slot name must belong to the layout: `slots[<i>]: '<s>' is not a slot of layout '<l>'. Slots: …`.
  - No duplicates: `slots[<i>]: duplicate slot '<s>'`.
  - Exactly one of `mediaRef` and `clipIds`: `slots[<i>]: provide exactly one of 'mediaRef' or 'clipIds'`.
  - `clipIds` must be non-empty. A clip may fill only one slot: `slots[<i>]: clip '<c>' is assigned to more than one slot; each clip can fill only one.`
  - **Every** slot must be filled: `layout '<l>' needs every slot filled. Missing: …`.
  - Placement and re-layout cannot mix: `apply_layout: don't mix 'mediaRef' and 'clipIds' — either place new clips (all mediaRef) or re-layout existing clips (all clipIds).`
- **Anchors:**
  - Named anchors map to (x, y): `center (0.5,0.5)`, `top (0.5,0)`, `bottom (0.5,1)`, `left (0,0.5)`, `right (1,0.5)`, `top_left (0,0)`, `top_right (1,0)`, `bottom_left (0,1)`, `bottom_right (1,1)`.
  - `anchorX` and `anchorY` must be in [0, 1], and they override the named anchor's x or y.
  - Errors: `slots[<i>]: invalid anchor '<a>'. Valid: …, or anchorX/anchorY for in-between values.` and `slots[<i>]: anchorX must be between 0 and 1 (got <v>)`.

**Slot geometry.** Rects are `{x, y, w, h}` in canvas 0–1 coordinates with a top-left origin.

| Layout | Slots |
|---|---|
| `full` | `main` (0,0,1,1) |
| `side_by_side` | `left` (0,0,.5,1), `right` (.5,0,.5,1) |
| `top_bottom` | `top` (0,0,1,.5), `bottom` (0,.5,1,.5) |
| `pip_*` | `main` (0,0,1,1, z0) and `inset` (size 0.28×0.28, margin 0.035 from the named corner, z1). For `pip_bottom_right` the inset is (0.685, 0.685). |
| `grid_NxN` | `r<row>c<col>` (1-based, row 1 is the top), each cell 1/N × 1/N |
| `main_sidebar` | `main` (0,0,.7,1), `sidebar` (.7,0,.3,1) |
| `three_up` | `left`, `center`, `right`: columns of width 1/3 |
| `three_stack` | `top`, `middle`, `bottom`: rows of height 1/3 |

**Placement mode** (`mediaRef`):
- `startFrame` defaults to 0 and must be ≥ 0. `endFrame` is required, and `endFrame − startFrame ≥ 1`: `apply_layout placing new clips requires endFrame > startFrame.`
- Each `mediaRef` is resolved like add_clips (a timeline ID nests) and must be video, image, or sequence: `slot '<s>': <ref> is <type>; layout slots take video, image, or nested timeline.`
- `applySettingsIfNeededForAgent` runs first.
- One new video track is inserted at index 0 per slot, in ascending z order, so the PIP inset ends up on top.
- Each asset is placed for `[start, end)`. Linked audio is auto-created as in add_clips.

**Re-layout mode** (`clipIds`):
- Each clip must exist (`slot '<s>': clip not found: <c>`) and be video, image, or sequence: `slot '<s>': clip <c> is <type>; layout applies to video, image, and nested timeline clips.`
- Clips in *different* slots may not overlap in time on the same track: `clips in slots '<a>' and '<b>' are on the same track and their times overlap; only the first would render. Move them to separate tracks (or place new clips with mediaRef) so every region shows.`
- With more than one slot, at least one frame must be covered by every slot: `the selected clips never play at the same time, so no single frame shows every region. Overlap their timeline ranges (or place new clips with mediaRef) before laying them out.`
- Timing and tracks are untouched.

**Transform and crop math** (`layoutPlacement`, per clip). `canvasAspect = W/H`, and `slotPixelAspect = (rect.w/rect.h)·canvasAspect`.
- **`fill`:**
  - The crop is chosen so the visible source matches `slotPixelAspect` (cover), biased by the anchor; for example `anchorY` 0 keeps the top.
  - With visible fractions `vw` and `vh`, the transform is `w = rect.w/vw`, `h = rect.h/vh`, and top-left `(rect.x − crop.left·w, rect.y − crop.top·h)`. The crop is stored on the clip.
- **`fit`:**
  - Let `rel` be the media's canvas-relative aspect.
  - If `rel·rect.h ≤ rect.w`, the draw size is `(rel·rect.h, rect.h)`; otherwise it is `(rect.w, rect.w/rel)`.
  - The position is `rect.origin + (rect.size − draw)·anchor`, and the crop is zero.
- In both modes, any position, scale, rotation, or crop keyframes are **cleared**.

**Execution.** The outer undo group "Apply Layout (Agent)" wraps `withTimelineSwap`. If nothing was laid out: `apply_layout changed no clips.`

**Result.** A mutation delta with extra keys `{layout, slots:{<slot>:[clipIds]}}`. In re-layout mode, this note is added: `Stacking follows current track order (index 0 on top); fix with manage_tracks reorder if an inset isn't on top.`

### 3.28 `sync_clips` — NEEDS-ML

**Description (verbatim):**

~~~text
Align one or more clips to a reference clip by shifting targets on the timeline — use for dual-system sound (camera + external audio) or multicam. Default mode 'auto' aligns by embedded source timecode when both files carry one (exact, confidence 1.0), falling back to audio cross-correlation otherwise (seeded by capture dates when present); force a method with mode. referenceClipId stays put unless a target would land before frame 0, in which case the whole group shifts right together (reported as shiftedFrames). Returns offsetFrames, confidence (0–1), and method (timecode|audio) per target; refuses weak audio matches. Refused on multicam clips — a group's members are already aligned by its sync maps (manage_multicam).
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "referenceClipId": {
      "type": "string",
      "description": "Clip the others align to. Stays put."
    },
    "targetClipId": {
      "type": "string",
      "description": "Single clip to align. Use targetClipIds for several."
    },
    "targetClipIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Clips to align with the reference."
    },
    "mode": {
      "type": "string",
      "enum": [
        "auto",
        "audio",
        "timecode"
      ],
      "description": "auto (default): timecode when available, else audio. audio/timecode force that method."
    },
    "searchWindowSeconds": {
      "type": "number",
      "description": "Optional max ± offset to search in seconds. Omit to search the full feasible overlap."
    },
    "minConfidence": {
      "type": "number",
      "description": "Minimum audio correlation confidence 0–1 (default 0.5)."
    }
  },
  "required": [
    "referenceClipId"
  ]
}
```

**Arguments.** Allowed keys: `minConfidence, mode, referenceClipId, searchWindowSeconds, targetClipId, targetClipIds`.
- `referenceClipId` is required: `Missing required argument: referenceClipId`.
- Targets are `targetClipIds` plus `targetClipId`, and at least one is required: `sync_clips: provide targetClipId or targetClipIds.`
- Multicam clips are refused, as reference or target: `sync_clips: multicam clips are already aligned by their group's sync maps — re-syncing would move them out of the group.`
- `mode` is `auto` (default), `audio`, or `timecode`: `sync_clips: mode must be auto, audio, or timecode.`
- `searchWindowSeconds` must be finite and greater than 0: `sync_clips: searchWindowSeconds must be finite and > 0.`
- `minConfidence` defaults to 0.5.

**Execution.** `editor.syncClips(...)`, applied inside one undo group, "Synchronize Clips (Agent)":
- **Method:**
  - `auto` uses embedded source timecode when both files carry it (confidence 1.0).
  - Otherwise it falls back to audio cross-correlation, seeded by capture dates within ±3 s when they are present, with a minimum overlap of 3 s.
- **Matching and placement:**
  - Audio matches below `minConfidence` are refused.
  - The reference stays put. If a target would land before frame 0, the whole group shifts right (`shiftedFrames`).
  - Linked partners move with their clips.
- **Drift:** may be corrected by retiming (`driftCorrected`).
- **Failure:** if no target synced, the first failure's message is returned: `sync_clips: <message>`. The fallback text is `no clips aligned`.

**Result.** A mutation delta with these extra keys:
- `referenceClipId`
- `synced:[{clipId, offsetFrames, confidence (3dp), method:"timecode"|"audio"}]`
- `shiftedFrames?`
- `driftCorrected?:[{clipId, driftPpm (1dp)}]`
- `driftCorrectionSkipped?:[{clipId, reason}]`
- `failed?:[{clipId, reason}]`

`touched` = the synced clips.

### 3.29 `manage_multicam` — NEEDS-ML

**Description (verbatim):**

~~~text
Create or ungroup a multicam group. create syncs session media into ordinary stamped timeline clips: one program video track, one audio track per mic, and angle switches through change_cam. Use member kind angle for scratch-camera audio, mic for program audio, and both for a camera whose audio should play. Pin offsetSeconds when correlation cannot align a member. ungroup strips stamps and leaves clips in place.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "create": {
      "type": "object",
      "properties": {
        "members": {
          "type": "array",
          "description": "Session source files, at least two.",
          "items": {
            "type": "object",
            "properties": {
              "mediaRef": {
                "type": "string",
                "description": "Media asset id from get_media."
              },
              "kind": {
                "type": "string",
                "enum": [
                  "angle",
                  "mic",
                  "both"
                ],
                "description": "angle = camera scratch audio, mic = audio in the mix, both = camera plus program audio."
              },
              "angleLabel": {
                "type": "string",
                "description": "Handle used by change_cam. Default: file name."
              },
              "offsetSeconds": {
                "type": "number",
                "description": "Pin this member's group-clock offset instead of correlating."
              }
            },
            "required": [
              "mediaRef",
              "kind"
            ]
          }
        },
        "name": {
          "type": "string",
          "description": "Group name. Default: Multicam N."
        },
        "master": {
          "type": "string",
          "description": "angleLabel or mediaRef whose audio clock defines the group. Default: first mic/both member."
        },
        "startFrame": {
          "type": "integer",
          "description": "Timeline frame to place the group. Default: timeline end."
        },
        "searchWindowSeconds": {
          "type": "number",
          "description": "Max ± audio sync search window, seconds (default 240)."
        }
      },
      "required": [
        "members"
      ]
    },
    "ungroup": {
      "type": "object",
      "properties": {
        "groupId": {
          "type": "string",
          "description": "Group to dissolve; its clips stay put, unstamped."
        }
      },
      "required": [
        "groupId"
      ]
    }
  }
}
```

**Arguments.** Allowed keys: `create, ungroup`. `create` is handled before `ungroup`; with neither: `Pass create or ungroup.` Each must be an object: `manage_multicam.create must be an object.`

**create**
- Allowed keys: `master, members, name, searchWindowSeconds, startFrame`.
- `members` needs at least 2 objects: `create.members requires at least two entries (cameras and mics).`
- Each member allows `angleLabel, kind, mediaRef, offsetSeconds`:
  - `mediaRef` must exist and be unique: `create.members[<i>]: duplicate mediaRef <r>`.
  - `kind` is `angle`, `mic`, or `both`: `<path>: kind must be angle, mic, or both.`
  - An `angle` member must be video.
  - A `mic` member needs audio: an audio asset, or a video with audio.
  - A `both` member must be a video with audio.
- **`master`** is matched against a member's `angleLabel` (case-insensitive) or its `mediaRef` (ID-expanded).
  - Errors:
    - `master '<m>' doesn't match a member's angleLabel or mediaRef.`
    - `master '<m>' is an angle — its audio is scratch. Pick a mic/both member.`
  - Default: the first `mic` member, else the first `both`, else the first member. If that member is an angle: `No mic member to sync against — mark one member as mic/both, or pin offsets explicitly.`
- **Sync:** `syncMulticamMembers` correlates each member against the master. The search window defaults to 240 s. Members with `offsetSeconds` are pinned and skip correlation.
- **Group creation:** under undo group "Create Multicam (Agent)", `createMulticamGroup` is called with name `Multicam N` by default and `startFrame` defaulting to the timeline end. It creates:
  - one program video track (multicam-stamped clips);
  - one audio track per mic or both member.
  - Sync-lock stays enforced on these tracks.

**ungroup**
- Key: `groupId`, ID-expanded and required: `groupId is required.`
- Unknown group: `No multicam group '<g>'. get_timeline lists multicamGroups.`
- Under undo group "Ungroup Multicam (Agent)", the stamps are stripped and the clips stay in place.

**Result.**
- **create:** a mutation delta with `created:{groupId, members:[memberRow], clipIds, needsAttention?:[{mediaRef, reason}]}`.
- **ungroup:** a mutation delta with `ungrouped:<groupId>`.
- `memberRow` is `{angleLabel, kind, mediaRef, offsetSeconds, confidence, master?:true, pinned?:true, unsynced?:true}`.

### 3.30 `change_cam` — CORE

**Description (verbatim):**

~~~text
Switch a multicam group's camera angle over timeline frame ranges, full-frame or in a multi-angle layout. Batched entries are one undo step. Ranges where an angle was not recording clamp or skip. Returns switched count, optional clamps/skips/overlayClipIds, and program rows over the touched span.

Each entry is EITHER {range, angle} — full-frame switch — or {range, layout, angles} — PiP/split/grid: angles fill the layout's slots in order (first = the full-frame program slot; fewer angles than slots leaves cells empty), extra angles land as synced overlay clips above the program. A later full-frame entry over the same range clears the layout. Overlay clips are ordinary group clips — restyle with set_clip_properties/apply_layout, remove with remove_clips.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "groupId": {
      "type": "string",
      "description": "The multicam group (from manage_multicam create or get_timeline's multicamGroups). Or pass clipId."
    },
    "clipId": {
      "type": "string",
      "description": "Any clip of the group on the active timeline."
    },
    "entries": {
      "type": "array",
      "description": "Switches to apply, in order. Later entries win on overlap.",
      "items": {
        "type": "object",
        "properties": {
          "range": {
            "type": "array",
            "items": {
              "type": "integer"
            },
            "description": "[startFrame, endFrame) in timeline frames."
          },
          "angle": {
            "type": "string",
            "description": "angleLabel to show full-frame. Omit when using layout."
          },
          "layout": {
            "type": "string",
            "enum": [
              "side_by_side",
              "top_bottom",
              "pip_bottom_right",
              "pip_bottom_left",
              "pip_top_right",
              "pip_top_left",
              "grid_2x2",
              "grid_3x3",
              "grid_4x4",
              "main_sidebar",
              "three_up",
              "three_stack"
            ],
            "description": "Multi-angle layout. Grid cells are rNcN counting from the top-left (r1c1 is top-left, row 1 is the top row); shaped layouts name slots by role."
          },
          "angles": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "angleLabels in slot order for layout; [0] is the program slot."
          }
        },
        "required": [
          "range"
        ]
      }
    }
  },
  "required": [
    "entries"
  ]
}
```

**Arguments.** Allowed keys: `clipId, entries, groupId`.
- **Group.** It is resolved from `groupId` first, then `clipId`, which must be in a group:
  - `Clip '<c>' is not part of a multicam group.`
  - `Pass groupId or clipId.`
  - `No multicam group '<g>'. get_timeline lists multicamGroups.`
- **Entries.** `entries` must be a non-empty array of objects: `entries requires at least one {range, angle} entry.` Each entry allows `angle, angles, layout, range`:
  - `range` is `[a, b]` of numbers with `a < b`; the values are converted with `intValue`, which truncates: `<path>: range must be [startFrame, endFrame) with start < end.`
  - **With `layout`:**
    - `angle` must be absent: `<path>: pass angle for a full-frame switch OR layout + angles, not both.`
    - `layout` must be a non-`full` VideoLayout: `<path>: unknown layout '<l>'. Valid: <…>. For full frame, pass angle instead.`
    - `angles` must be a non-empty string array: `<path>: layout needs angles — angleLabels in slot order (<slots>); fewer than slots leaves cells empty.`
  - **Without `layout`:** `angle` is a required string: `Missing required argument: angle`.

**Execution.** One undo group, "Switch Angle (Agent)", calls `switchMulticamAngles`:
- Requests apply in order, and later ones win.
- A range where the angle was not recording is clamped or skipped.
- Layout entries put `angles[0]` in the program slot. Further angles become synced **overlay clips** above the program, with layout transforms.
- A later full-frame entry over the same range clears the layout.
- Adjacent identical cuts merge.

**Result.** A mutation delta with these extra keys:
- `groupId`
- `switched:<count>`
- `cutsMerged?`
- `overlayClipIds?`
- `program?`: `multicamProgramRows` over `[min, max)` of the applied ranges, as run-length `[angle, startFrame, endFrame]`
- `clamped?:[{requested:[a,b], applied:[a,b], culprit}]`
- `skipped?:[{range:[a,b], reason}]`

### 3.31 `get_multicam` — CORE

**Description (verbatim):**

~~~text
Read a multicam group: members (angleLabel, kind, offsetSeconds, confidence, which is master), the current program cut as run-length [angle, startFrame, endFrame) rows in timeline frames, and the track indexes the group occupies. Use it to learn angle labels before change_cam, or to review the cut as one program instead of piecing it together from get_timeline's clips. Window long timelines with startFrame/endFrame.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "groupId": {
      "type": "string",
      "description": "The multicam group id. Or pass clipId."
    },
    "clipId": {
      "type": "string",
      "description": "Any clip of the group on the active timeline."
    },
    "startFrame": {
      "type": "integer",
      "description": "Optional window start for program rows."
    },
    "endFrame": {
      "type": "integer",
      "description": "Optional window end (exclusive)."
    }
  }
}
```

**Arguments.** Allowed keys: `clipId, endFrame, groupId, startFrame`. The group is resolved as in change_cam. The window follows the `frameWindow` rules (§2.1).

**Result.** Text JSON, rounded: `{groupId, name, members:[memberRow], program:[[angleLabel, startFrame, endFrame]…], trackIndexes:[sorted ints]}`. The `program` rows are in timeline frames and windowed. Read-only.

### 3.32 `undo` — CORE

**Description (verbatim):**

~~~text
Reverts the latest action from the editor's shared undo history, whether the user or agent made it. Call only when that latest action should be reversed. For example, verify a cut with get_transcript, then undo if it overshot and retry with corrected ranges. After undoing, ids and frames returned by the reverted action may be invalid; re-read with get_timeline or get_transcript before editing again. Takes no arguments.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object"
}
```

**Arguments.** Ignored (the schema has none).

**Execution.** `editor.undo.undoLatest()` performs the most recent undo step in the project's shared undo history, whether the user or the agent created it. The step may also have come from a different MCP session.

**Result.**
- On success, the plain text `Undid the latest action. The timeline is restored to its state before that edit; re-read with get_timeline or get_transcript before editing again.`
- With nothing to undo, the error `Nothing to undo.`
- The change highlight compares timelines before and after.

### 3.33 `get_transcript` — NEEDS-ML

**Description (verbatim):**

~~~text
Returns the spoken transcript of the CURRENT timeline in project frames — the post-edit caption track in one call. Unlike inspect_media (which transcribes one source asset in isolation, in source seconds), this walks every audio/video clip on the timeline, maps each word through that clip's trim/speed/position, and concatenates in timeline order. Deleted ranges are gone by construction, so after cuts this always reflects what's actually audible — no stale results, no per-clip frame math. Pass trackIndex to isolate one dialogue or multicam mic track; omit it to read every eligible timeline source (multicam defaults to its master mic). The app chooses cloud only when the signed-in account has enough credits for the uncached request; otherwise it uses local transcription and reports the resolved transcriptionSource in the response.

Returns clips in timeline order, each with its words as compact [index, text, startFrame] rows (a word runs to the next word's start; the last word to its clip's end). Speakers, when identified, arrive as run-length turns: speakers = [[firstWordIndex, name], ...]. The index is a stable, 0-based position in the requested transcript; pass it straight to remove_words to cut that word (the intuitive path for text-based editing). Indices stay stable when paged with a window. Capped at 10000 words; page with startFrame/endFrame using nextStartFrame.

For comprehension rather than cutting — summarizing, finding a topic, take selection on long media — pass granularity='segments': sentence rows [firstWordIndex, text, start, end] at a fraction of the tokens, whose firstWordIndex jumps you back into word mode for the cut window.

Use for transcript-driven edits (filler-word / dead-air removal, locating a quote, take selection) and to verify what remains after cutting. To cut, prefer remove_words (give it the indices); drop to ripple_delete_ranges only for non-word-aligned spans.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "startFrame": {
      "type": "integer",
      "description": "Optional. Only return words ending after this project frame. Use with the returned nextStartFrame to page a long timeline."
    },
    "endFrame": {
      "type": "integer",
      "description": "Optional. Only return words starting before this project frame."
    },
    "clipId": {
      "type": "string",
      "description": "Scope the transcript to a single clip — returns only what that clip says, in project frames. Answers \"what's in clip X?\" without scanning the whole timeline."
    },
    "trackIndex": {
      "type": "integer",
      "description": "Scope transcription to one current timeline track from get_timeline. Use this to choose a dialogue or multicam mic lane. Mutually exclusive with clipId."
    },
    "granularity": {
      "type": "string",
      "enum": [
        "words",
        "segments"
      ],
      "description": "words (default) for cutting with remove_words; segments for cheap sentence-level reading — rows carry firstWordIndex to drill back into words."
    },
    "language": {
      "type": "string",
      "description": "Optional BCP-47 speech language. Applies to local only; cloud auto-detects."
    }
  }
}
```

**Arguments.** Allowed keys: `clipId, endFrame, granularity, language, startFrame, trackIndex, wordTimestamps`. `wordTimestamps` is accepted but ignored.
- `granularity` is `words` (default) or `segments`: `granularity must be 'words' or 'segments' (got '<g>')`.
- The window follows the `frameWindow` rules (§2.1).

**Scope** (`resolveTranscriptionScope`):
- **With neither `clipId` nor `trackIndex`:** automatic. Every eligible timeline audio source; a multicam group contributes its master mic.
- **With `clipId`:**
  - The clip must exist: `Clip <id> not found.`
  - Its own audio is used. If it has none, its linked audio partners are used.
  - Otherwise: `Clip <id> has no transcribable audio.`
- **With `trackIndex`:**
  - `clipId` must be absent: `get_transcript: pass either clipId or trackIndex, not both.`
  - The index must be an exact integer: `get_transcript: trackIndex must be an integer.`
  - It must be in range: `get_transcript: trackIndex <t> is out of range (valid range: 0..<n-1>).` For an empty timeline, the parenthetical reads `the timeline has no tracks`.
  - The track's clips are used, or else their linked audio: `get_transcript: track <t> has no transcribable audio.`

**Provider.**
- **cloud** when the account is signed in and either the estimated credit cost of the uncached request is 0 or the remaining credits cover it.
- Otherwise **local**, with `language` resolved against the on-device locales: `get_transcript: on-device transcription does not support language '<l>'.`
- Cloud access errors:
  - `Sign in to use Cloud transcription.`
  - `Add credits to use Cloud transcription.`
  - `<cost description> needed. Only <n> remaining.`

**Transcription.**
- Each distinct source file is transcribed once, in parallel:
  - **Local:** the whole file, cached.
  - **Cloud:** the union of the clips' visible source spans ±1 s.
- A failing file is reported in `skipped:[{file, reason}]` instead of failing the call.

**Mapping words to the timeline.**
- A word is kept when its midpoint (in source frames at project fps) falls inside the clip's visible source span. Its span is clamped, then mapped as `round(clip.start + (srcFrame − visibleStart)/speed)`.
- Clips are processed in order of start frame, and words are numbered with a **global 0-based index** in that order.
- Speaker labels are aligned project-wide:
  - The saved speaker registry and assignments are used when they exist.
  - Otherwise speakers are clustered by WeSpeaker voice fingerprint.
  - Labels are names, or `Speaker <n>`.

**Session.** The session (provider, locale, scope, a snapshot of the target clips) is stored as `lastTranscriptSession` for `remove_words`.

**Result.** Text JSON (not rounded):
- `{fps, timing:"projectFrames", transcriptionSource:"local"|"cloud", clips:[…], wordFormat|segmentFormat, speakers?, speakersNote?, totalWords?, nextStartFrame?, wordsNote?, skipped?}`.
- Each `clips[]` entry is `{clipId, trackIndex, startFrame, endFrame, words|segments}`.
- **`words` mode:**
  - Rows are `[index, text, startFrame]`, with `wordFormat:["index","text","start"]`.
  - A word runs until the next word's start; the last word runs until its clip ends.
- **`segments` mode:**
  - Rows are `[firstWordIndex, text, start, end]`, with `segmentFormat:["firstWordIndex","text","start","end"]`.
  - A segment breaks on a speaker change, on a gap larger than `fps` frames, after 48 words, or after a word ending in `.`, `!`, or `?`.
- **Windowing:** a window keeps words with `end > startFrame` and `start < endFrame`.
- **Speakers:** `speakers:[[firstWordIndex, name|null]…]` as run-length turns, with `speakersNote:"[firstWordIndex, speaker] — each run holds until the next entry."`
- **Cap:** 10000 words. Beyond it, the result has `totalWords`, `nextStartFrame` (the last returned word's end), and `wordsNote:"First 10000 of <n> words. Continue with startFrame = nextStartFrame."`

Read-only. It is allowed on an inactive project, but it does set `lastTranscriptSession`.

### 3.34 `remove_words` — NEEDS-ML

**Description (verbatim):**

~~~text
Cut speech by the word, Descript-style — the primary tool for text-based editing (filler words, flubbed sentences, dropped retakes, tightening a ramble). Pass words for precise get_transcript indices/ranges, or matches for exact filler tokens like "um" and "uh". This resolves them to frames, removes the surrounding pause so survivors don't end up double-spaced, merges adjacent removals, cuts linked A/V partners, and closes the gaps. You never deal in frame numbers — that's the whole point versus ripple_delete_ranges.

Workflow: call get_transcript, read it as prose, then pass the indices of the words to drop. Omit language by default; remove_words reuses the previous get_transcript provider and track selection so word indices stay aligned. Words across multiple clips on ONE track are handled in a single undoable action, and any linked A/V partner (e.g. the video paired with this audio) is cut automatically. Edit one track at a time: if your indices span multiple unlinked tracks (e.g. two separate mics), the call is refused — cut each track in its own call, or link the tracks into one unit first. After it runs, indices have shifted — re-read get_transcript before another remove_words.

When to use which: words for selective edits after reading the transcript; matches for removing every exact filler token; ripple_delete_ranges only for spans that aren't word-aligned. Verify reworded retakes and sub-frame seam fragments against the word list, not a summary.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "words": {
      "type": "array",
      "description": "Words to remove, by get_transcript index. Each element is either a single index (e.g. 42) or an inclusive [startIndex, endIndex] span (e.g. [12, 18]). Mutually exclusive with matches. Re-read after any edit.",
      "items": {
        "type": [
          "integer",
          "array"
        ]
      }
    },
    "matches": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Exact single-word tokens to remove everywhere, case-insensitive with surrounding punctuation ignored, e.g. [\"um\", \"uh\", \"hmm\"]. Mutually exclusive with words. Avoid broad words like \"like\" unless the user explicitly wants every occurrence removed."
    },
    "cutAggressiveness": {
      "type": "string",
      "enum": [
        "tight",
        "balanced",
        "loose"
      ],
      "description": "How much silence to leave between the words on either side of a cut. 'tight' butts them close (snappy, can feel clipped), 'balanced' (default) keeps a natural beat, 'loose' leaves more breathing room. The removed words' own frames always go regardless."
    },
    "language": {
      "type": "string",
      "description": "Optional BCP-47 speech language for local transcription. Omit to reuse the previous get_transcript language."
    }
  }
}
```

**Arguments.** Allowed keys: `cutAggressiveness, language, matches, words`.
- Empty arrays are refused: `remove_words: words or matches must not be empty.`
- One of the two is required: `Missing 'words' or 'matches'. Pass word indices from get_transcript, e.g. [5, [12, 18]], or exact words like ["um", "uh"].`
- But not both: `remove_words: pass either words or matches, not both.`
- `cutAggressiveness` is `tight`, `balanced` (default), or `loose`: `cutAggressiveness must be one of: tight, balanced, loose.`
- **`words`** elements are an integer or an `[a, b]` pair, inclusive: `words[<i>]: expected an integer index or an [start, end] pair.`
- **`matches`** elements are strings, normalized by trimming whitespace and punctuation and lowercasing. Each must stay non-empty:
  - `matches[<i>]: expected a string.`
  - `matches[<i>]: expected a non-empty word.`

**Session.**
- If `lastTranscriptSession` belongs to the active timeline, it is reused, keeping the same provider, locale, and scope.
  - With `words`, the target clips must be unchanged since then (clip ID, media, start, duration, trimStart, speed, fps): `The timeline sources from the previous get_transcript have changed. Call get_transcript again before remove_words.`
- If there is no session for this timeline:
  - With `words` and a session for a *different* timeline: `The previous get_transcript belongs to a different timeline. Call get_transcript again before remove_words.`
  - Otherwise an automatic-scope session is created, choosing the provider as in get_transcript.
- The transcript is rebuilt from the session, mostly from cache: `No transcribable speech on the timeline.`

**Selection.**
- Index spans are clamped to `0…maxIndex`. Out-of-range ends are reported in `indicesIgnored`.
- With nothing in range: `None of the requested word indices are in range 0...<max>. Re-read get_transcript.`
- With no match: `No transcript words matched: <sorted list>. Re-read get_transcript or pass exact word indices.`

**Cut planning** (`WordCutPlanner.cutRanges`, per clip):
- The kept gap is `round(keptGapMs/1000·fps)` frames, with `tight` 60 ms, `balanced` 150 ms, and `loose` 320 ms.
- Selected words and their surrounding pauses are removed, leaving about half the kept gap on each side. Adjacent removals merge, and ranges are clamped to the clip.
- If nothing is removable: `The selected words resolved to no removable frames. Re-read get_transcript.`

**One-track rule.**
- If the ranges span more than one track, every involved clip must share a single link group (for example, camera plus mic), and the cut is anchored on the lowest track index.
- Otherwise: `Selected words span multiple unlinked tracks (<list>). Remove words one track at a time — linked video/audio is cut automatically. If these tracks are the same source (e.g. camera + mic), link them into one unit first.`

**Execution.**
- One undo group, "Remove Words (Agent)", calls `rippleDeleteRangesOnTrack(primaryTrack, ranges)`, with the same semantics as ripple_delete_ranges.
- A refusal: `Ripple delete refused: <reason>`.

**Result.** A mutation delta with extra keys:
- `removedWords`, `removedFrames`, `cutAggressiveness`, `transcriptionSource`;
- `removedText?`: the first 24 removed words joined with spaces, plus ` …` when there are more;
- `indicesIgnored?`.

It always includes the note `Word indices shifted — re-read get_transcript before another remove_words.`

### 3.35 `remove_silence` — NEEDS-ML

**Description (verbatim):**

~~~text
Remove dead air — quiet, speech-free sections — from the timeline's audio, ripple-closing the gaps. Sections come from on-device speech detection (the same spans marked red on waveforms): non-speech runs whose level sits well below the recording's own speech level, so music beds and loud ambience are never cut. Cuts linked A/V partners and honors sync lock; the whole pass is one undoable action.

Omit clipIds to process the whole timeline, or pass clip IDs from get_timeline to process only those clips. A scoped selection must include audio from exactly one track, and all selected clips must share one track or belong to one linked A/V unit. By default, this uses the current Minimum Pause and Speech Padding controls. Pass either optional value as a one-shot override without changing those controls. Use this to tighten pacing (long pauses, dead space between takes) before or instead of word-level edits: remove_silence handles pauses, remove_words handles fillers and flubbed lines. No transcript needed. If it reports no dead air, speech analysis may still be running in the background — wait a moment and retry.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "description": "Optional timeline clip IDs from get_timeline. Restricts removal to these clips; linked A/V partners are cut with them. Include audio clips from exactly one track, and select clips from one track or one link group. Omit to process the whole timeline."
    },
    "minimumPauseSeconds": {
      "type": "number",
      "minimum": 0.25,
      "maximum": 3,
      "description": "Minimum quiet, speech-free pause to remove. Omit to use the current Minimum Pause control."
    },
    "speechPaddingSeconds": {
      "type": "number",
      "minimum": 0,
      "maximum": 0.5,
      "description": "Audio to keep before and after detected speech. Omit to use the current Speech Padding control."
    }
  }
}
```

**Arguments.** Allowed keys: `clipIds, minimumPauseSeconds, speechPaddingSeconds`.
- `minimumPauseSeconds` must be finite and in [0.25, 3]; it defaults to the current UI control (default 0.5).
- `speechPaddingSeconds` must be in [0, 0.5]; it defaults to the current UI control (default 0.15).
- Errors:
  - `remove_silence: <key> must be a finite number from <lo> through <hi>.`
  - `remove_silence: invalid silence-removal settings.`
- `clipIds`, if present, must be a non-empty array: `remove_silence: clipIds must be a non-empty array of clip IDs.`
  - Each element must be a non-blank string: `remove_silence: clipIds[<i>] must be a non-empty string.`
  - Each clip must exist: `Clip not found: <id>`.
  - Duplicates are removed.
- The overrides are one-shot: they do not change the UI controls.

**Execution.** One undo group, "Remove Silence (Agent)":
- **Detection.** Dead-air sections are non-speech runs, from the cached VAD speech mask, whose level sits well below the recording's own speech level. They must be at least `minimumPauseSeconds` long, and `speechPaddingSeconds` is kept around speech. Music beds and loud ambience survive.
- **Whole timeline** (`clipIds` omitted): `removeAllDeadAir` processes track by track.
- **Scoped:** `removeDeadAir(clipIds)` requires audio from exactly one track, and requires the clips to share one track or one link group. A violation fails with `remove_silence: <DeadAirSelectionError message>`.
- Linked A/V partners are cut, sync lock is honored, and the gaps are rippled closed.
- **Nothing found:** `No dead air on the timeline. Speech analysis may still be running, or the audio has no quiet non-speech sections.` For a scoped call, the text says `in the selected clips` instead of `on the timeline`.
- **Refusals:**
  - If the first track was refused and nothing was removed: `Ripple delete refused: <reason>`.
  - If a later track was refused, the earlier edits remain and this note is added: `A later track refused: <reason>. Earlier tracks were already edited.`

**Result.** A mutation delta with extra keys `{sectionsRemoved, removedFrames, minimumPauseSeconds, speechPaddingSeconds, clipIds?}`.

### 3.36 `detect_beats` — NEEDS-ML

**Description (verbatim):**

~~~text
Detect musical beats and downbeats in a media asset's audio, on-device. Returns beats and downbeats in SOURCE seconds (multiply by fps for frame values, same convention as search_media hits) plus estimated bpm. Downbeats mark bar starts — cut on downbeats for edits that land musically; beats are fine for faster montage rhythms.

Use for beat-synced editing: snapping cuts to a music bed, building montages where clip boundaries hit the beat, or timing text/caption entrances to the bar. To place a cut at a beat B on a clip, the timeline frame is startFrame + (B × fps − trimStartFrame) / speed. Works on music; speech or ambience returns few or no beats. Runs locally — no subscription needed.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "mediaRef": {
      "type": "string",
      "description": "Audio or video asset id from get_media."
    },
    "startSeconds": {
      "type": "number",
      "description": "Optional. Return only beats at or after this source-media second. The whole file is analyzed once and cached; windowing trims the response, not the work."
    },
    "endSeconds": {
      "type": "number",
      "description": "Optional. Return only beats at or before this source-media second."
    }
  },
  "required": [
    "mediaRef"
  ]
}
```

**Arguments.** Allowed keys: `endSeconds, mediaRef, startSeconds`.
- `mediaRef` is required and must exist.
- The asset must be audio, or video with audio: `detect_beats needs audio: <ref> is <type>[ with no audio track].`
- The file must be on disk: `Media file not on disk: <file>`.
- The window is `[max(start, 0), min(end, duration)]` and requires `s < e`: `Invalid time range [<s>, <e>] for media of duration <d>s`.

**Execution.**
- The whole file is analyzed once, with results cached and de-duplicated per asset (`mediaVisualCache.beats`). Windowing only filters the output.
- The model takes 22.05 kHz mono audio in 30 s windows, at 20 ms per frame, and outputs beat and downbeat activations.
- **bpm:** the analysis bpm for the whole file, or, when windowed, `estimateBPM(windowed beats)`. It is emitted with 1 decimal, and only when greater than 0.

**Result.** Text JSON: `{mediaRef, units:"source seconds — multiply by fps for frame values", beats:[2dp…], downbeats?:[2dp…], bpm?}`.

Special results:
- **No beats at all:** the literal `{"beats":[],"note":"No beats found — the audio may lack rhythmic content."}`
- **Window empty, beats elsewhere:** `{"beats":[],"note":"No beats in the requested window; the track has beats elsewhere — widen or drop startSeconds/endSeconds."}`

Read-only. Despite echoing the request, `mediaRef` in the result is shortened like any other ID.

### 3.37 `add_texts` — CORE

**Description (verbatim):**

~~~text
Adds text clips as timeline layers. Omit trackIndex on every entry to create one new top video track; otherwise set trackIndex on every entry. Text boxes auto-fit their content; transform optionally sets their alignment-relative horizontal anchor, vertical center, Z rotation, and static X/Y perspective tilt. Left-aligned text grows rightward from x, centered text grows around x, and right-aligned text grows leftward from x. Use style widthScale and heightScale to stretch glyphs. Use the nested style object for typography, outline, shadow, background, and whole-layer Gaussian blur. fillMode 'footage' stencils layers below through the letter shapes over a matte set by style.color; it defaults to black when color is omitted. 'inverted' renders white glyphs with Difference blending and ignores color, outline, shadow, and background while active. Use add_captions for spoken audio captions. Unknown fields are rejected.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "entries": {
      "type": "array",
      "description": "Text clips to add.",
      "items": {
        "type": "object",
        "properties": {
          "trackIndex": {
            "type": "integer",
            "description": "Existing non-audio track. Omit on all entries to create a new top track."
          },
          "startFrame": {
            "type": "integer",
            "description": "Timeline start frame."
          },
          "endFrame": {
            "type": "integer",
            "description": "Occupy timeline frames [startFrame, endFrame) — copy a clip's frames pair to title exactly that span."
          },
          "content": {
            "type": "string",
            "description": "Text. Supports \\n."
          },
          "transform": {
            "type": "object",
            "description": "Optional position and rotation. Omitted x or y uses the default centered position. Size always auto-fits the text.",
            "properties": {
              "x": {
                "type": "number",
                "description": "Normalized horizontal anchor of the unrotated text box: the left edge for left alignment, center for center alignment, or right edge for right alignment."
              },
              "y": {
                "type": "number",
                "description": "Normalized vertical center."
              },
              "rotation": {
                "type": "number",
                "description": "Clockwise Z-axis degrees."
              },
              "rotationX": {
                "type": "number",
                "minimum": -89,
                "maximum": 89,
                "description": "Static X-axis perspective rotation in degrees. Positive tips the top edge away from the viewer."
              },
              "rotationY": {
                "type": "number",
                "minimum": -89,
                "maximum": 89,
                "description": "Static Y-axis perspective rotation in degrees. Positive brings the right edge toward the viewer."
              }
            }
          },
          "style": {
            "type": "object",
            "description": "Same partial style patch as update_text. Omit entirely unless the user asked for specific styling; omitted = app default style.",
            "properties": {
              "fontName": {
                "type": "string"
              },
              "fontSize": {
                "type": "number",
                "minimum": 12,
                "maximum": 300
              },
              "widthScale": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 10
              },
              "heightScale": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 10
              },
              "bold": {
                "type": "boolean"
              },
              "italic": {
                "type": "boolean"
              },
              "underline": {
                "type": "boolean"
              },
              "strikethrough": {
                "type": "boolean"
              },
              "overline": {
                "type": "boolean"
              },
              "tracking": {
                "type": "number",
                "minimum": -20,
                "maximum": 100
              },
              "lineSpacing": {
                "type": "number",
                "minimum": -100,
                "maximum": 300
              },
              "fontCase": {
                "type": "string",
                "enum": [
                  "mixed",
                  "uppercase",
                  "lowercase"
                ]
              },
              "alignment": {
                "type": "string",
                "enum": [
                  "left",
                  "center",
                  "right"
                ]
              },
              "color": {
                "type": "string"
              },
              "blur": {
                "type": "number",
                "minimum": 0,
                "maximum": 100
              },
              "outline": {
                "type": "object",
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  },
                  "color": {
                    "type": "string"
                  },
                  "width": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 40
                  }
                }
              },
              "shadow": {
                "type": "object",
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  },
                  "color": {
                    "type": "string"
                  },
                  "opacity": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  "offset": {
                    "type": "object",
                    "properties": {
                      "x": {
                        "type": "number",
                        "minimum": -200,
                        "maximum": 200
                      },
                      "y": {
                        "type": "number",
                        "minimum": -200,
                        "maximum": 200
                      }
                    }
                  },
                  "blur": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100
                  }
                }
              },
              "background": {
                "type": "object",
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  },
                  "color": {
                    "type": "string"
                  },
                  "opacity": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  "padding": {
                    "type": "object",
                    "properties": {
                      "x": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 300
                      },
                      "y": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 300
                      }
                    }
                  },
                  "center": {
                    "type": "object",
                    "properties": {
                      "x": {
                        "type": "number",
                        "minimum": -500,
                        "maximum": 500
                      },
                      "y": {
                        "type": "number",
                        "minimum": -500,
                        "maximum": 500
                      }
                    }
                  },
                  "cornerRadius": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 300
                  },
                  "outline": {
                    "type": "object",
                    "properties": {
                      "color": {
                        "type": "string"
                      },
                      "width": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 40
                      }
                    }
                  }
                }
              }
            }
          },
          "animation": {
            "type": "string",
            "enum": [
              "off",
              "popIn",
              "slideUp",
              "typewriter",
              "wordReveal",
              "wordSlide",
              "highlightPop",
              "highlightBlock"
            ],
            "description": "Animation preset; off clears."
          },
          "highlightColor": {
            "type": "string",
            "description": "Active-word hex."
          },
          "fillMode": {
            "type": "string",
            "enum": [
              "color",
              "footage",
              "inverted"
            ],
            "description": "color = solid typography (default). footage = stencil layers below through the letter shapes over a matte set by style.color, defaulting to black when color is omitted. inverted = white Difference-blended glyphs; color, outline, shadow, and background are ignored while active."
          }
        },
        "required": [
          "startFrame",
          "endFrame",
          "content"
        ]
      }
    }
  },
  "required": [
    "entries"
  ]
}
```

**Arguments.** There is no top-level unknown-key check. `entries` must be a non-empty array of objects: `Missing or empty 'entries' array` and `entries[<i>] must be an object`.
- Each entry allows `animation, content, endFrame, fillMode, highlightColor, startFrame, style, trackIndex, transform`.
- `startFrame`, `endFrame` (lenient ints), and `content` are required.

**Per-entry validation:**
- **`trackIndex`:**
  - In range: `entries[<i>]: track index <t> out of range (0..<n-1>)`.
  - Not an audio track: `entries[<i>]: track <t> is an audio track; text requires a video/image/text track`.
- **Frames:**
  - `entries[<i>]: startFrame must be >= 0 (got <n>)`
  - `entries[<i>]: endFrame (<e>) must be greater than startFrame (<s>)`
- **`style`:**
  - It must be an object (`entries[<i>].style: expected object`) with keys `background, blur, bold, color, alignment, fontCase, fontName, fontSize, heightScale, italic, lineSpacing, outline, overline, shadow, strikethrough, tracking, underline, widthScale`.
  - Number errors: `<path>.<key>: expected finite number` and `<path>.<key>: must be between <lo> and <hi>`.
  - Ranges: fontSize 12–300; widthScale and heightScale 0.1–10; tracking −20–100; lineSpacing −100–300; blur 0–100.
  - `fontName` must be a non-blank string. The booleans must be JSON booleans. `fontCase` is `mixed|uppercase|lowercase`, and `alignment` is `left|center|right`.
  - `outline{enabled, color, width 0–40}`.
  - `shadow{enabled, color, opacity 0–1, offset{x,y −200–200}, blur 0–100}`.
  - `background{enabled, color, opacity 0–1, padding{x,y 0–300}, center{x,y −500–500}, cornerRadius 0–300, outline{color, width 0–40}}`.
  - Unknown keys are rejected at every level.
- **`transform`:**
  - Keys: `rotation, rotationX, rotationY, x, y`. `rotationX` and `rotationY` must be in [−89, 89].
  - An object with no fields counts as absent.
- **`animation`:** `off`, or one of `popIn|slideUp|typewriter|wordReveal|wordSlide|highlightPop|highlightBlock`: `entries[<i>]: animation must be one of off, popIn, …`.
  - `highlightColor` is honored only together with an animation.
- **`fillMode`:** `color|footage|inverted`: `entries[<i>].fillMode: expected color, footage, inverted`.
- **All or none for `trackIndex`:** `Mixed trackIndex: <k> of <n> entries omitted trackIndex. Either set it on every entry or omit it on every entry (to auto-create a shared new track).`

**Building each clip.**
- **Style:** start from the default `TextStyle()` (Helvetica, 96 pt, white, centered) and apply the patch.
  - A color in `#RRGGBB` form on shadow or background keeps the current alpha; `#RRGGBBAA` sets it. The `opacity` fields set the alpha.
  - `fillMode:"footage"` without a style color sets the color to black (`#000000FF`).
- **Transform:**
  - It is computed only when `transform` is given.
  - The size is the natural size of the text: max width 0.9 of the canvas, normalized to the canvas.
  - `centerX` is derived from the anchor: `x + w/2` for left alignment, `x` for center, `x − w/2` for right. The default is 0.5.
  - `centerY` is `y`, with a default of 0.5.
  - Rotations come from the transform.
  - Without a `transform`, the editor's default placement and auto-fit apply.

**Execution.** One undo group, "Add Text(s) (Agent)":
- If every entry omits `trackIndex`, one new video track is inserted at index 0.
- `placeTextClips(specs)` places the clips. If it fails, the created track is removed and the call fails: `Failed to place any text clips`.
- Overlaps on the target track follow the editor's placement rules.

**Result.** A mutation delta.

### 3.38 `update_text` — CORE

**Description (verbatim):**

~~~text
Updates text clips or a captionGroupId. The nested style object is a partial patch: omitted values stay unchanged. Use it for typography, color, outline, shadow, background, and whole-layer Gaussian blur. style.blur is measured in 1080p canvas pixels, scales with output resolution, and 0 removes it; setting it clears blur keyframes. Use style widthScale and heightScale to stretch glyphs. fillMode 'footage' stencils layers below through the glyphs over a matte set by style.color; entering it defaults to black when color is omitted. 'inverted' renders white glyphs with Difference blending and ignores color, outline, shadow, and background while active. Content and layout-affecting style changes auto-fit the box while preserving its alignment-relative x anchor. transform can reposition, rotate, or apply static X/Y perspective tilt without changing its size. Static Z rotation uses clockwise degrees and clears rotation keyframes. Unknown fields are rejected.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Text clip IDs. Optional if captionGroupId is given."
    },
    "captionGroupId": {
      "type": "string",
      "description": "Caption group id from get_timeline."
    },
    "content": {
      "type": "string",
      "description": "Replacement text. Supports \\n."
    },
    "transform": {
      "type": "object",
      "description": "Partial position and rotation; omitted fields keep current values. Size remains auto-fit.",
      "properties": {
        "x": {
          "type": "number",
          "description": "Normalized horizontal anchor of the unrotated text box: the left edge for left alignment, center for center alignment, or right edge for right alignment."
        },
        "y": {
          "type": "number",
          "description": "Normalized vertical center."
        },
        "rotation": {
          "type": "number",
          "description": "Clockwise Z-axis degrees."
        },
        "rotationX": {
          "type": "number",
          "minimum": -89,
          "maximum": 89,
          "description": "Static X-axis perspective rotation in degrees. Positive tips the top edge away from the viewer."
        },
        "rotationY": {
          "type": "number",
          "minimum": -89,
          "maximum": 89,
          "description": "Static Y-axis perspective rotation in degrees. Positive brings the right edge toward the viewer."
        }
      }
    },
    "style": {
      "type": "object",
      "description": "Partial text-style patch. Omitted properties keep existing values (updates) or the app's default style (new text and captions). Set only what the user asked for; omit the whole object when they didn't specify a look.",
      "properties": {
        "fontName": {
          "type": "string",
          "description": "Font PostScript name."
        },
        "fontSize": {
          "type": "number",
          "minimum": 12,
          "maximum": 300,
          "description": "Font size in canvas points."
        },
        "widthScale": {
          "type": "number",
          "minimum": 0.1,
          "maximum": 10,
          "description": "Glyph width multiplier. 1 preserves the font's original width."
        },
        "heightScale": {
          "type": "number",
          "minimum": 0.1,
          "maximum": 10,
          "description": "Glyph height multiplier. 1 preserves the font's original height."
        },
        "bold": {
          "type": "boolean",
          "description": "Bold font trait."
        },
        "italic": {
          "type": "boolean",
          "description": "Italic font trait."
        },
        "underline": {
          "type": "boolean",
          "description": "Draw a line below the text."
        },
        "strikethrough": {
          "type": "boolean",
          "description": "Draw a line through the text."
        },
        "overline": {
          "type": "boolean",
          "description": "Draw a line above the text."
        },
        "tracking": {
          "type": "number",
          "minimum": -20,
          "maximum": 100,
          "description": "Spacing between characters in canvas points."
        },
        "lineSpacing": {
          "type": "number",
          "minimum": -100,
          "maximum": 300,
          "description": "Additional spacing between lines in canvas points."
        },
        "fontCase": {
          "type": "string",
          "enum": [
            "mixed",
            "uppercase",
            "lowercase"
          ],
          "description": "Non-destructive display casing."
        },
        "alignment": {
          "type": "string",
          "enum": [
            "left",
            "center",
            "right"
          ],
          "description": "Text alignment."
        },
        "color": {
          "type": "string",
          "description": "Text color as #RGB, #RRGGBB, or #RRGGBBAA."
        },
        "blur": {
          "type": "number",
          "minimum": 0,
          "maximum": 100,
          "description": "Whole-layer Gaussian blur in 1080p canvas pixels. Blurs glyphs, outline, shadow, and background; 0 removes it."
        },
        "outline": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "color": {
              "type": "string",
              "description": "Outline color hex."
            },
            "width": {
              "type": "number",
              "minimum": 0,
              "maximum": 40,
              "description": "Width in canvas points."
            }
          }
        },
        "shadow": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "color": {
              "type": "string",
              "description": "Shadow color hex. Six-digit colors preserve the current opacity."
            },
            "opacity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "offset": {
              "type": "object",
              "properties": {
                "x": {
                  "type": "number",
                  "minimum": -200,
                  "maximum": 200
                },
                "y": {
                  "type": "number",
                  "minimum": -200,
                  "maximum": 200
                }
              }
            },
            "blur": {
              "type": "number",
              "minimum": 0,
              "maximum": 100,
              "description": "Blur radius in canvas points."
            }
          }
        },
        "background": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "color": {
              "type": "string",
              "description": "Background color hex. Six-digit colors preserve the current opacity."
            },
            "opacity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "padding": {
              "type": "object",
              "properties": {
                "x": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 300
                },
                "y": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 300
                }
              }
            },
            "center": {
              "type": "object",
              "properties": {
                "x": {
                  "type": "number",
                  "minimum": -500,
                  "maximum": 500
                },
                "y": {
                  "type": "number",
                  "minimum": -500,
                  "maximum": 500
                }
              }
            },
            "cornerRadius": {
              "type": "number",
              "minimum": 0,
              "maximum": 300,
              "description": "Corner radius in canvas points."
            },
            "outline": {
              "type": "object",
              "properties": {
                "color": {
                  "type": "string",
                  "description": "Background outline color hex."
                },
                "width": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 40,
                  "description": "Background outline width in canvas points."
                }
              }
            }
          }
        }
      }
    },
    "animation": {
      "type": "string",
      "enum": [
        "off",
        "popIn",
        "slideUp",
        "typewriter",
        "wordReveal",
        "wordSlide",
        "highlightPop",
        "highlightBlock"
      ],
      "description": "Animation preset; off clears."
    },
    "highlightColor": {
      "type": "string",
      "description": "Active-word hex."
    },
    "fillMode": {
      "type": "string",
      "enum": [
        "color",
        "footage",
        "inverted"
      ],
      "description": "color = solid typography. footage = stencil layers below through the letter shapes over a matte set by style.color, defaulting to black when entering without color. inverted = white Difference-blended glyphs; color, outline, shadow, and background are ignored while active."
    }
  }
}
```

**Arguments.** Allowed keys: `animation, captionGroupId, clipIds, content, fillMode, highlightColor, style, transform`. The style, transform, animation, and fillMode parsing is identical to add_texts, with paths prefixed `update_text`.
- `content` must be a string: `update_text.content: expected String`. An empty string `""` is dropped by the blank filter (§1.6).
- **Targets:**
  - The `captionGroupId` member clips are appended to `clipIds`, de-duplicated. Unknown group: `No caption clips found for captionGroupId: <id>`.
  - The targets must be non-empty: `Provide a non-empty 'clipIds' array or a 'captionGroupId'`.
  - Every target must exist and be text: `Clip not found: <id>`, `update_text only applies to text clips: <id> is <type>`.
- At least one property is required (content, a style field, transform, animation, a lone highlightColor, or fillMode): `update_text needs at least one text property to apply`.

**Execution.** One undo group, "Update Text(s) (Agent)", via `commitClipProperties`, per clip:
1. The original alignment anchor x is remembered.
2. **Content:** a changed `content` clears `wordTimings`.
3. **Style:** the patch is merged into the clip's style. A `style.blur` clears the blur keyframe track.
4. **Auto-fit:** if the content or a layout-affecting style field changed, the box is refit (`fitTextClipToContentIfNeeded`). Layout-affecting fields: font, size, scales, bold, italic, tracking, lineSpacing, fontCase, outline enabled or width, shadow enabled, offset, or blur, and background enabled or padding.
5. **Anchor:** when refit, the alignment changed, or `transform.x` was given, `centerX` is recomputed from the anchor, which is `transform.x`, or else the original anchor.
6. **Transform:** `y` sets `centerY`. `rotation` sets the rotation and clears rotation keyframes. `rotationX` and `rotationY` set the tilt.
7. **Animation:**
   - `off` clears it.
   - A preset sets it and keeps the existing per-word frames and highlight unless `highlightColor` is given.
   - A lone `highlightColor` sets only the highlight.
8. **Fill mode:** `fillMode` calls `setTextFillMode`. Entering `footage` without a color sets black. `color` clears the mode.

**Notes:**
- `Content change cleared word timings on <n> clip[s] — karaoke highlighting falls back to plain text there.`
- `Static rotation cleared existing rotation keyframes on: <ids>.`
- `Static blur cleared existing blur keyframes on: <ids>.`

**Result.** A mutation delta with the extra key `changed`. Three or more caption clips collapse into `captionGroups`.

### 3.39 `add_captions` — NEEDS-ML

**Description (verbatim):**

~~~text
Transcribes spoken audio and creates caption text clips on their own track. Style, animation, and transform are optional overrides: omit them ALL for the app's clean default captions (plain white Helvetica, lower-third) — do not invent fonts, colors, outlines, backgrounds, blur, or animations the user didn't ask for. style.blur adds whole-layer Gaussian blur. Pass trackIndex to caption one dialogue or multicam mic track; omit it to automatically choose the timeline track with the most speech. The app uses cloud only when the signed-in account has enough credits for the uncached request; otherwise it uses local transcription. Cloud auto-detects language. Per-word animations are timed from the transcript. Alternatively, pass subtitleMediaRef (a subtitle asset from import_media/get_media) to place that SRT/WebVTT file's cues as captions at their authored timecodes — no transcription; the file's text, timing, and default styling are used as-is (overlapping cues are trimmed so clips never overlap on the track), so subtitleMediaRef can't be combined with any other parameter. Returns the caption group summary (captionGroupId, clipCount, frameRange, shared style, textPreview) — restyle it later with update_text and that captionGroupId.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "subtitleMediaRef": {
      "type": "string",
      "description": "Subtitle asset id (type 'subtitle'). Places the file's cues at their timecodes instead of transcribing. Mutually exclusive with every other parameter."
    },
    "language": {
      "type": "string",
      "description": "BCP-47 speech language. Applies to local only; cloud auto-detects."
    },
    "trackIndex": {
      "type": "integer",
      "description": "Caption one current timeline track from get_timeline. Omit to auto-detect the dominant speech track."
    },
    "transform": {
      "type": "object",
      "description": "Caption position and rotation; size is auto-fit per caption. x uses the selected text alignment edge.",
      "properties": {
        "x": {
          "type": "number",
          "description": "Normalized horizontal anchor of the unrotated text box: the left edge for left alignment, center for center alignment, or right edge for right alignment."
        },
        "y": {
          "type": "number",
          "description": "Normalized vertical center."
        },
        "rotation": {
          "type": "number",
          "description": "Clockwise Z-axis degrees."
        },
        "rotationX": {
          "type": "number",
          "minimum": -89,
          "maximum": 89,
          "description": "Static X-axis perspective rotation in degrees. Positive tips the top edge away from the viewer."
        },
        "rotationY": {
          "type": "number",
          "minimum": -89,
          "maximum": 89,
          "description": "Static Y-axis perspective rotation in degrees. Positive brings the right edge toward the viewer."
        }
      }
    },
    "censorProfanity": {
      "type": "boolean",
      "description": "Mask profanity."
    },
    "maxWords": {
      "type": "integer",
      "minimum": 1,
      "description": "Max words per caption."
    },
    "maxCharacters": {
      "type": "integer",
      "minimum": 1,
      "description": "Max characters per caption, including spaces and punctuation. A single word may exceed this limit."
    },
    "maximumGapSeconds": {
      "type": "number",
      "minimum": 0,
      "maximum": 2,
      "description": "Extend captions to close shorter gaps and hold the final caption for up to this duration. Default 0.5 seconds; 0 disables."
    },
    "style": {
      "type": "object",
      "description": "Same partial style patch as update_text. Omit entirely unless the user asked for specific styling; omitted = app default style.",
      "properties": {
        "fontName": {
          "type": "string"
        },
        "fontSize": {
          "type": "number",
          "minimum": 12,
          "maximum": 300
        },
        "widthScale": {
          "type": "number",
          "minimum": 0.1,
          "maximum": 10
        },
        "heightScale": {
          "type": "number",
          "minimum": 0.1,
          "maximum": 10
        },
        "bold": {
          "type": "boolean"
        },
        "italic": {
          "type": "boolean"
        },
        "underline": {
          "type": "boolean"
        },
        "strikethrough": {
          "type": "boolean"
        },
        "overline": {
          "type": "boolean"
        },
        "tracking": {
          "type": "number",
          "minimum": -20,
          "maximum": 100
        },
        "lineSpacing": {
          "type": "number",
          "minimum": -100,
          "maximum": 300
        },
        "fontCase": {
          "type": "string",
          "enum": [
            "mixed",
            "uppercase",
            "lowercase"
          ]
        },
        "alignment": {
          "type": "string",
          "enum": [
            "left",
            "center",
            "right"
          ]
        },
        "color": {
          "type": "string"
        },
        "blur": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "outline": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "color": {
              "type": "string"
            },
            "width": {
              "type": "number",
              "minimum": 0,
              "maximum": 40
            }
          }
        },
        "shadow": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "color": {
              "type": "string"
            },
            "opacity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "offset": {
              "type": "object",
              "properties": {
                "x": {
                  "type": "number",
                  "minimum": -200,
                  "maximum": 200
                },
                "y": {
                  "type": "number",
                  "minimum": -200,
                  "maximum": 200
                }
              }
            },
            "blur": {
              "type": "number",
              "minimum": 0,
              "maximum": 100
            }
          }
        },
        "background": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "color": {
              "type": "string"
            },
            "opacity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "padding": {
              "type": "object",
              "properties": {
                "x": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 300
                },
                "y": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 300
                }
              }
            },
            "center": {
              "type": "object",
              "properties": {
                "x": {
                  "type": "number",
                  "minimum": -500,
                  "maximum": 500
                },
                "y": {
                  "type": "number",
                  "minimum": -500,
                  "maximum": 500
                }
              }
            },
            "cornerRadius": {
              "type": "number",
              "minimum": 0,
              "maximum": 300
            },
            "outline": {
              "type": "object",
              "properties": {
                "color": {
                  "type": "string"
                },
                "width": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 40
                }
              }
            }
          }
        }
      }
    },
    "animation": {
      "type": "string",
      "enum": [
        "off",
        "popIn",
        "slideUp",
        "typewriter",
        "wordReveal",
        "wordSlide",
        "highlightPop",
        "highlightBlock"
      ],
      "description": "Caption animation preset. Omit for static captions; set only when the user asks for animation."
    },
    "highlightColor": {
      "type": "string",
      "description": "Active-word hex."
    }
  }
}
```

**Arguments.** Allowed keys: `animation, censorProfanity, highlightColor, language, maxCharacters, maximumGapSeconds, maxWords, style, subtitleMediaRef, trackIndex, transform`.

**Subtitle path** (`subtitleMediaRef` present):
- It must be a non-empty string: `add_captions: subtitleMediaRef must be a non-empty media asset id string.`
- No other key is allowed: `add_captions: subtitleMediaRef uses the file's text, timing, and default styling as-is; remove <keys>.`
- The asset must exist (`add_captions: media asset not found: <id>`), be a subtitle (`add_captions: '<id>' is <type>, not a subtitle file. Omit subtitleMediaRef to caption spoken audio.`), and be online (`add_captions: the subtitle file for '<id>' is offline.`).
- `importCaptions(from: url)` parses the SRT or WebVTT file and places the cues at their timecodes on a new caption track with default caption styling. Overlapping cues are trimmed.
- With no cues: `The subtitle file contains no captions.` A parse error: `add_captions: <parse error>`.

**Spoken path.**
- **Style:** `style` is patched onto `TextStyle.caption` (the default caption font size).
- **Position:** the center defaults to `(centerSnapValue, 0.9)` from `AppTheme.Caption.defaultCenter`, overridden by `transform.x` and `transform.y`.
- **Animation:** the default is none.
- **Limits:**
  - `maxWords` and `maxCharacters` must be exact integers ≥ 1: `add_captions: <key> must be an integer >= 1.`
  - `maximumGapSeconds` must be a number in [0, 2], defaulting to 0.5: `add_captions: maximumGapSeconds must be a finite number from 0.0 through 2.0.`
- **Scope:** as in get_transcript, but automatic mode picks **the track with the most speech**.
- **Provider:** as in get_transcript. With cloud, `censorProfanity` is refused: `add_captions: censorProfanity is only available with local transcription.` Cloud access is validated (same errors).
- **Execution:** `generateCaptions(request)`. Inside the undo group "Generate Captions (Agent)":
  - The captions are created on their **own new track** as one caption group.
  - Per-word animations get word timings.
  - If `transform.x`, `rotation`, `rotationX`, or `rotationY` was given, each caption clip's transform is adjusted. Alignment-anchored x is computed per clip width.
- With no speech: `No speech detected to caption.`

**Result.** A mutation delta. The new caption clips collapse to a `captionGroups` summary `{captionGroupId, clipCount, frameRange, shared, textPreview, clipsNote, track}`, plus `createdTracks`.

### 3.40 `apply_color` — CORE

**Description (verbatim):**

~~~text
Author/refine a color grade on video/image clips with named controls — the colorist path, distinct from apply_effect (looks/FX). Returns the clips with their resulting grade as a `color` object — the same object get_timeline shows; pass one back via the `color` parameter to copy a grade between clips (replaces the whole grade). MERGES with the clip's current grade: only the params you pass change, the rest are preserved, so you can nudge one knob at a time (pass reset:true to start from neutral). Applies as live, editable color.* effects; non-color effects untouched. Iterate: apply_color → inspect_color(clipId, reference) → read the gap → adjust → repeat. Undoable. All knobs optional. Color WHEELS use HUE (0–360°, standard) + AMOUNT per tonal zone — to push shadows teal, set shadowsHue 180 and shadowsAmount ~0.15. CURVES (master + per-channel R/G/B) give precise tone shaping — per-channel curves are tone-selective (e.g. pull the blue curve down in the highlights to tame a bright sky). HUE CURVES do secondary/qualified correction — target a source hue and shift its hue/saturation/lightness (e.g. desaturate greens, warm the skin) without a mask; pair with inspect_color's hueHistogram to find which hues are present. LUT applies a .cube film-look pack on top of the grade.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Clip ids from get_timeline."
    },
    "reset": {
      "type": "boolean",
      "description": "Start from neutral instead of merging onto the clip's current grade. Default false."
    },
    "color": {
      "type": "object",
      "description": "A complete grade object as read from a clip's `color` key (get_timeline or an apply_color echo). Replaces the target clips' grade — the grade-copy path. Mutually exclusive with reset and individual knobs."
    },
    "exposure": {
      "type": "number",
      "description": "-3…3 EV. Overall brightness in linear light."
    },
    "contrast": {
      "type": "number",
      "description": "0.5…1.5 (1 = neutral)."
    },
    "saturation": {
      "type": "number",
      "description": "0…2 (1 = neutral; <1 mutes)."
    },
    "vibrance": {
      "type": "number",
      "description": "-1…1 (protects skin tones)."
    },
    "temperature": {
      "type": "number",
      "description": "2000…11000 K. HIGHER = WARMER, lower = cooler/bluer (6500 = neutral)."
    },
    "tint": {
      "type": "number",
      "description": "-100…100. Positive = green, negative = magenta."
    },
    "highlights": {
      "type": "number",
      "description": "-1…1. Recover (<0) or lift (>0) highlights."
    },
    "shadows": {
      "type": "number",
      "description": "-1…1. Lift (>0) or deepen (<0) shadows."
    },
    "blacks": {
      "type": "number",
      "description": "-1…1. Black point. Negative deepens, positive lifts (faded look)."
    },
    "whites": {
      "type": "number",
      "description": "-1…1. White point."
    },
    "shadowsHue": {
      "type": "number",
      "description": "Shadow color-push hue 0–360° (0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta). Use with shadowsAmount."
    },
    "shadowsAmount": {
      "type": "number",
      "description": "0…1 strength of the shadow color push (0 = neutral)."
    },
    "shadowsLum": {
      "type": "number",
      "description": "-0.5…0.5 shadow lift (brightness)."
    },
    "midsHue": {
      "type": "number",
      "description": "Midtone color-push hue 0–360° (see shadowsHue). Use with midsAmount."
    },
    "midsAmount": {
      "type": "number",
      "description": "0…1 strength of the midtone color push."
    },
    "midsGamma": {
      "type": "number",
      "description": "0.5…2 midtone brightness (gamma; 1 = neutral)."
    },
    "highsHue": {
      "type": "number",
      "description": "Highlight color-push hue 0–360° (see shadowsHue). Use with highsAmount."
    },
    "highsAmount": {
      "type": "number",
      "description": "0…1 strength of the highlight color push."
    },
    "highsGain": {
      "type": "number",
      "description": "0.5…1.5 highlight brightness (gain; 1 = neutral)."
    },
    "masterCurve": {
      "type": "array",
      "items": {
        "type": "array",
        "items": {
          "type": "number"
        }
      },
      "description": "Luma tone curve as [x,y] control points in 0–1 (input→output), preserves chroma. E.g. [[0,0.06],[1,0.95]] = lifted/faded film toe."
    },
    "redCurve": {
      "type": "array",
      "items": {
        "type": "array",
        "items": {
          "type": "number"
        }
      },
      "description": "Red-channel tone curve, [x,y] points 0–1."
    },
    "greenCurve": {
      "type": "array",
      "items": {
        "type": "array",
        "items": {
          "type": "number"
        }
      },
      "description": "Green-channel tone curve, [x,y] points 0–1."
    },
    "blueCurve": {
      "type": "array",
      "items": {
        "type": "array",
        "items": {
          "type": "number"
        }
      },
      "description": "Blue-channel tone curve, [x,y] points 0–1. Tone-selective: e.g. [[0,0],[0.7,0.7],[1,0.85]] pulls blue only in the highlights (tames a sky) and leaves shadows."
    },
    "hueCurves": {
      "type": "object",
      "description": "Secondary/qualified correction (Resolve-style Hue-vs-Hue/Sat/Lum). Targets replace any existing hue curve. Selectivity is ~±22° around each target hue.",
      "properties": {
        "targets": {
          "type": "array",
          "description": "One or more source-hue regions to adjust (e.g. skin at 30, sky at 210).",
          "items": {
            "type": "object",
            "properties": {
              "targetHue": {
                "type": "number",
                "description": "Source hue to act on, 0–360° (0 red, 30 orange/skin, 60 yellow, 120 green, 180 cyan, 210 sky-blue, 240 blue, 300 magenta)."
              },
              "hueShift": {
                "type": "number",
                "description": "Rotate that hue by -30…30°."
              },
              "satScale": {
                "type": "number",
                "description": "Saturation multiplier for that hue, 0–2 (1 = neutral; 1.3 pops it, 0.6 mutes it, 0 fully desaturates)."
              },
              "lumShift": {
                "type": "number",
                "description": "Lightness shift for that hue, -0.5…0.5."
              }
            },
            "required": [
              "targetHue"
            ]
          }
        }
      }
    },
    "lut": {
      "type": "object",
      "description": "Apply a .cube 3D LUT (e.g. a film-look pack) on top of the primary grade; replaces any prior LUT. The agent does not author LUT data — pass a real file path.",
      "properties": {
        "path": {
          "type": "string",
          "description": "Absolute path to a .cube file (~ is expanded). Copied into project storage so it survives saves."
        },
        "strength": {
          "type": "number",
          "description": "Dry/wet mix 0-1 (default 1)."
        }
      }
    }
  },
  "required": [
    "clipIds"
  ]
}
```

**Arguments.** Strict decode. The `color` key is removed before decoding. Allowed knob keys: `blacks, blueCurve, clipIds, contrast, exposure, greenCurve, highlights, highsAmount, highsGain, highsHue, hueCurves{targets[{targetHue, hueShift?, satScale?, lumShift?}]}, lut{path?, strength?}, masterCurve, midsAmount, midsGamma, midsHue, redCurve, reset, saturation, shadows, shadowsAmount, shadowsHue, shadowsLum, temperature, tint, vibrance, whites`.
- `clipIds` must be non-empty: `clipIds is empty.`
- **With `color`** (paste a grade):
  - It cannot be combined with knobs or `reset:true`: `'color' pastes a complete grade — don't combine it with individual knobs or reset.`
  - Its keys are checked against `blacks, blueCurve, contrast, exposure, greenCurve, highlights, highsAmount, highsGain, highsHue, hueCurvesRaw, lut, masterCurve, midsAmount, midsGamma, midsHue, redCurve, saturation, shadows, shadowsAmount, shadowsHue, shadowsLum, temperature, tint, vibrance, whites`, with error path `apply_color.color`.
- **Without `color`:** at least one knob, or `reset`, is required: `No grade parameters provided.` A `hueCurves` with empty targets does not count.
- Every clip must exist and be video or image: `Clip <id> is a <type> clip; apply_color needs a video or image clip.`
- **LUT.** A `lut.path` (`~` expanded) is validated and **copied into project storage** up front (`LUTLoader.store`). An error returns the store error's message, or `Invalid LUT.`

**Execution.** One undo group, "Color Grade (Agent)" or "Color Grade ×N (Agent)". For each clip:
1. Split the effect stack into non-color effects (kept untouched) and `color.*` effects.
2. **Paste** (`color` given): replace the color effects with the pasted stack. The pasted `lut.path` is re-stored, and `strength` is clamped to 0–1.
3. **Merge** (otherwise): rebuild a GradeState from the existing color effects, or from neutral when `reset`. Overlay the given knobs. Rebuild the color stack, preserving the **disabled** flag of color effect types that were disabled.

Knob values are **not clamped** by the tool; the renderer clamps them to the effect ranges. They are stored rounded to 3 decimals.

**Effect stack.** Effects are emitted in this canonical order, each only when relevant:

| Effect | Params |
|---|---|
| `color.exposure` | `{ev}` (range −3…3) |
| `color.contrast` | `{amount}` (0.5…1.5) |
| `color.highlightsShadows` | `{highlights, shadows}`; a missing one is 0 (−1…1) |
| `color.blacksWhites` | `{blacks, whites}`; a missing one is 0 (−1…1) |
| `color.temperature` | `{temperature (2000…11000, default 6500), tint (−100…100, default 0)}` |
| `color.vibrance` | `{amount}` (−1…1) |
| `color.saturation` | `{amount}` (0…2) |
| `color.wheels` | `{lift_x, lift_y, lift_m, gamma_x, gamma_y, gamma_m, gain_x, gain_y, gain_m}` (see below) |
| `color.curves` | string param `curve` = JSON of `{master, red, green, blue}` points; omitted if identity |
| `color.hueCurves` | string param `curves` = JSON of `{hueVsHue, hueVsSat, hueVsLum}`; omitted if identity |
| `color.lut` | string `path` + `intensity` (0…1) |

`color.wheels` details:
- `x = amount·cos(hue°)`, `y = amount·sin(hue°)`.
- `lift_m = shadowsLum` (default 0), `gamma_m = midsGamma` (default 1), `gain_m = highsGain` (default 1).
- Ranges: x and y −1…1; lift_m −0.5…0.5; gamma_m 0.5…2; gain_m 0.5…1.5.

**Curves.** Points are `[x, y]` rows rounded to 3 decimals. Rows with fewer than 2 numbers are dropped. A given channel replaces only that channel.

**Hue curves.** Each target compiles into bumps:
- The center is `targetHue/360`, wrapped. The band is ±0.06 (about 22°), and the band edges sit at neutral y.
- hue: y = `neutral + clamp(hueShift, ±30)/60`.
- sat: y = `neutral + (clamp(satScale, 0, 2) − 1)/2`.
- lum: y = `neutral + clamp(lumShift, ±0.5)`.
- Colliding x positions keep the more extreme point.
- The targets **replace** any existing hue curves.

**LUT strength.**
- A new path sets the intensity to the clamped strength, default 1.
- A strength alone re-blends the existing LUT.

**Grade object** (`colorObject`, read side, shown by get_timeline):
- The knobs are read back from the effects. Wheel values that are neutral are omitted, and a zone's hue is omitted when its amount is absent.
- Curves are `[[x,y]…]`. Hue curves come back raw as `hueCurvesRaw:{hueVsHue?, hueVsSat?, hueVsLum?}`; the compile step is one-way. The LUT is `{path, strength}`.
- This object round-trips through `color`.

**Result.** A mutation delta with `touched = clipIds`. Each clip shows its `color` object.

### 3.41 `apply_effect` — CORE

**Description (verbatim):**

~~~text
Apply non-color effects (blur, sharpen, stylize, detail, key) to video/image clips as a live, editable effect stack — the looks/FX path, distinct from apply_color (grading). MERGES: each effect you pass is added or updated by type; effects you don't mention are left in place. Pass enabled:false to bypass one without removing it, or list its type in `remove` to delete it. Out-of-range params are clamped; params you omit keep their current (or default) value. Effects render in a fixed canonical order regardless of the order you pass them. Setting blur.gaussian.radius clears blur keyframes. Undoable. Returns the clips with their resulting effects as [{type, params}] — the same shape this tool accepts, so copying effects between clips is passing a clip's effects array back in.

Available effects — type: param (range, default):
• detail.clarity — Clarity & Haze: clarity (-1…1, default 0), dehaze (-1…1, default 0)
• blur.gaussian — Gaussian Blur: radius (0…100px, default 8)
• blur.sharpen — Sharpen: amount (0…2, default 0.4)
• blur.noiseReduction — Noise Reduction: amount (0…1, default 0)
• blur.motion — Motion Blur: radius (0…100px, default 0), angle (-180…180°, default 0)
• stylize.invert — Invert: no params
• stylize.grain — Film Grain: amount (0…1, default 0), size (0.5…4, default 1.5)
• stylize.vignette — Vignette: amount (-1…1, default 0), midpoint (0…1, default 0.5), roundness (-1…1, default 0), feather (0…1, default 0.5)
• stylize.glow — Glow: intensity (0…1, default 0), radius (0…100px, default 20), threshold (0…1, default 0.6), warmth (0…1, default 0)
• key.chroma — Chroma Key: keyHue (0…1, default 0.333), tolerance (0…1, default 0), softness (0…1, default 0.1), spill (0…1, default 0.5)
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Clip ids from get_timeline."
    },
    "effects": {
      "type": "array",
      "description": "Effects to add or update on the clips.",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "description": "Effect type id, e.g. stylize.glow (see list above)."
          },
          "params": {
            "type": "object",
            "description": "Param values keyed by name. Out-of-range values are clamped; omitted params keep their current/default value."
          },
          "enabled": {
            "type": "boolean",
            "description": "Default true. false bypasses the effect without removing it."
          }
        },
        "required": [
          "type"
        ]
      }
    },
    "remove": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Effect type ids to remove from the clips."
    }
  },
  "required": [
    "clipIds"
  ]
}
```

**Arguments.** Strict decode. Keys: `clipIds` (required, non-empty: `clipIds is empty.`), `effects:[{type, params?:{name: number}, enabled?}]`, and `remove:[type]`.
- At least one effect or removal: `Provide effects to add/update or remove types to delete.`
- Each effect `type` must exist in the registry: `Unknown effect '<t>'. See the apply_effect description for available types.`
- Color effects belong to apply_color: `'<t>' is a color grade — use apply_color, not apply_effect.`
- Param names must belong to the descriptor: `<t>: unknown param(s) '<p>'. Allowed: <list>.`
- Param values must be numbers. A string fails to decode.
- Every clip must exist and be video or image: `Clip <id> is a <type> clip; apply_effect needs a video or image clip.`

**Execution.** One undo group, "Apply Effect (Agent)" or "Apply Effect ×N (Agent)". For each clip:
1. Remove all effects whose type is listed in `remove`.
2. For each entry, take the existing effect of that type, or a new one with all params at their defaults.
3. Set `enabled` if given.
4. Clamp each given param to its range and round it to 3 decimals. Setting a param replaces any keyframe track on that param.
5. Re-insert the effect at its canonical index (`EffectRegistry.canonicalOrder`). An empty stack becomes nil.

If `blur.gaussian.radius` was set, the note `Static blur cleared existing blur keyframes on: <ids>.` is added.

**Effect catalog.** The registry, embedded in the description, uses this canonical order: `color.exposure, color.contrast, color.highlightsShadows, color.blacksWhites, color.temperature, color.vibrance, color.saturation, color.wheels, color.curves, color.hueCurves, color.lut, detail.clarity, key.chroma, blur.gaussian, blur.sharpen, blur.noiseReduction, blur.motion, stylize.invert, stylize.grain, stylize.vignette, stylize.glow`.

**Result.** A mutation delta with `touched = clipIds`. The clips show `effects:[{type, params}]`.

### 3.42 `inspect_color` — CORE

**Description (verbatim):**

~~~text
Measure color scopes of a timeline clip's current graded look (clipId) OR a raw media asset (mediaRef) — black/white points, % clipping, mean & per-channel levels, shadow/mid/highlight color tilt, saturation, warm-cool / green-magenta balance, and a saturation-weighted hueHistogram (12 bins of 30° from 0°/red — shows which hues are present, e.g. an orange cluster = skin, a cyan/blue cluster = sky) — and return the rendered frame too. Use this to grade by the numbers instead of eyeballing, to find hues to target with apply_color's hueCurves, or to measure footage/references before grading. clipId applies the clip's effects (graded look); mediaRef measures the raw asset. Pass a reference image/video id to also measure it and get the subject−reference GAP plus hints that map onto apply_color knobs. The loop: apply_color → inspect_color(clipId, reference) → read the gap → adjust → repeat until the gap is small.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipId": {
      "type": "string",
      "description": "Timeline clip to measure — returns its current GRADED look (effects applied). Provide this or mediaRef."
    },
    "mediaRef": {
      "type": "string",
      "description": "Media asset id from get_media to measure RAW (no grade). Provide this or clipId."
    },
    "atFrame": {
      "type": "integer",
      "description": "Optional project frame to sample a clip. Defaults to the clip's midpoint. Ignored for mediaRef."
    },
    "reference": {
      "type": "string",
      "description": "Optional image/video asset id from get_media to compare against; returns its scopes + the subject−reference gap."
    }
  }
}
```

**Arguments.** Strict decode. Keys: `atFrame, clipId, mediaRef, reference`.
- `clipId` takes precedence over `mediaRef`. With neither: `Provide either clipId (measures the graded clip) or mediaRef (measures the raw asset).`

**Subject.**
- **`clipId`** (the clip's graded look):
  - The clip must be video or image: `Clip <id> is a <type> clip; inspect_color needs a video or image clip.`
  - Its asset must exist: `Clip source not found: <ref>`. The URL must resolve: `Could not resolve a source URL for clip <id>.`
  - **Frame selection.** With `atFrame`, the offset is `clamp(atFrame − start, 0, duration−1)` and the source frame is `trimStart + offset·speed`. Otherwise the offset is `duration/2` and the source frame is `trimStart + sourceFramesConsumed/2`. The frame is decoded at `sourceFrame / timelineFps` seconds, ±1 s tolerance.
  - The clip's crop (at that frame) is applied, then every **enabled** effect, color and non-color, at that offset.
- **`mediaRef`** (raw): the asset must be video or image. Its frame at `duration/2` is used, or the image itself.
- **`reference`:** measured raw, the same way as `mediaRef`.
- Decode or measure errors:
  - `Could not decode a frame for clip <id>.`
  - `Could not measure the clip frame.`
  - `Could not measure <ref>.`
  - `<Label> <ref> is a <type> asset; inspect_color needs a video or image asset.`
  - `Could not resolve a URL for <ref>.`

**Scopes** (`ColorScopes.measure`).
- The image is resampled to a 256×256 RGBA8 grid with no color management.
- Per pixel, luma is `y = 0.2126r + 0.7152g + 0.0722b` and saturation is `(max−min)/max`.
- Statistics:
  - `lumaBlack` and `lumaWhite`: the 2nd and 98th percentiles of y.
  - `clipLow` and `clipHigh`: the fraction of pixels with y < 0.02 and y > 0.98.
  - `histogram16`: 16 luma bins, normalized to fractions.
  - `meanRGB`.
  - `blackRGB` and `whiteRGB`: per-channel 2nd and 98th percentiles.
  - Zone means: shadows (y < 1/3), mids, and highs (y > 2/3).
  - `saturation`: the mean saturation.
  - `warmCool = meanR − meanB`.
  - `greenMagenta = meanG − (meanR+meanB)/2`.
  - `hueHistogram12`: 12 bins of 30°, saturation-weighted, over pixels with saturation > 0.15, normalized.
  - `colorfulPct`: the fraction of pixels with saturation > 0.15.

**Readout.** All values are 3-decimal numbers. Percentages are ×100.
`{luma:{black, white, mean, clipLowPct, clipHighPct, histogram16}, meanRGB:[r,g,b], blackRGB, whiteRGB, zones:{shadows, mids, highs}, saturation, balance:{warmCool, greenMagenta}, hueHistogram12, colorfulPct}`

**Gap** (subject minus reference): `{lumaBlack, lumaWhite, lumaMean, warmCool, greenMagenta, saturation, shadowsRGB, midsRGB, highsRGB, hints}`. The hints, verbatim, by threshold:
- **|Δblack| > 0.03:**
  - `blacks higher than ref → lower 'blacks' / deepen shadows`
  - `blacks lower than ref → raise 'blacks'`
- **|ΔwarmCool| > 0.03:**
  - `warmer than ref → cooler 'temperature'`
  - `cooler than ref → warmer 'temperature'`
- **|ΔgreenMagenta| > 0.02:**
  - `greener than ref → 'tint' toward magenta`
  - `more magenta than ref → 'tint' toward green`
- **|Δsat| > 0.03:**
  - `more saturated than ref → lower 'saturation'`
  - `less saturated than ref → raise 'saturation'`

**Result.** `[subject image (JPEG q0.8, decoded resolution, no downscale), reference image?, text JSON {clip|media: readout, reference?: readout, gap?}]`. The subject's key is `clip` or `media`. Read-only.

### 3.43 `denoise_audio` — NEEDS-ML

**Description (verbatim):**

~~~text
Remove background noise from audio clips using an on-device speech-enhancement model (DeepFilterNet3). strength is a dry/wet mix 0-1: 0 leaves the audio untouched, 1 is fully denoised. Full strength can sound thin or over-gated on real-world recordings, so the default is 0.6. The bake runs in the background — the timeline updates automatically when it finishes; no need to poll. Pass enabled:false to turn denoise off. Undoable.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "clipIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Audio clip ids from get_timeline."
    },
    "strength": {
      "type": "number",
      "description": "Dry/wet mix, 0–1 (default 0.6). Lower it if voices sound thin or over-compressed."
    },
    "enabled": {
      "type": "boolean",
      "description": "Default true. false removes the denoise effect from the clips."
    }
  },
  "required": [
    "clipIds"
  ]
}
```

**Arguments.** Strict decode. Keys: `clipIds` (required, non-empty: `clipIds is empty.`), `enabled`, `strength`.
- `strength` must be in [0, 1]: `strength must be 0–1 (got <v>)`.
- Every clip must exist and be audio: `Clip <id> is a <type> clip; denoise_audio needs an audio clip.`

**Execution.** One undo group, "Denoise Audio (Agent)" or, with `enabled:false`, "Disable Denoise (Agent)":
- `setDenoise(clipIds, enabled, amount: strength)` adds or updates the clip's denoise effect. The default strength is 0.6.
- The enhanced audio is **baked asynchronously** and the preview picks it up when done. `enabled:false` removes the effect.

**Result.** A mutation delta with `touched = clipIds`. When enabled, it adds the note `Denoise bakes in the background; the preview picks it up automatically when it finishes.`

### 3.44 `list_models` — AI-GENERATION

**Description (verbatim):**

~~~text
Lists AI models with their capabilities (durations, aspect ratios, resolutions, draft mode, first/last frame support, reference support, voices/category for audio, and configurable settings for upscalers). Always call before generate_video, generate_image, generate_audio, or upscale_media so the model you pick actually supports the constraints you need. Returns { models, loaded } — if loaded=false the catalog hasn't synced yet (e.g. user not signed in); the models array may be empty even when models exist, so do not conclude no models are available. Retry after the user signs in.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "video",
        "image",
        "audio",
        "upscale"
      ],
      "description": "Filter by type. Omit to list all models."
    }
  }
}
```

**Arguments.** No unknown-key check. `type` is one of `video|image|audio|upscale`. An unrecognized value matches nothing and returns empty `models`.

**Execution.** Reads the synced catalog. Models marked `paidOnly` are **hidden** unless the account is on a paid plan. Works on an inactive project and without a project, but still needs a bound editor.

**Result.** Text JSON, rounded: `{models:[…], loaded:<catalog synced>}`.

**`video` row:** `{type:"video", id, displayName, durations, aspectRatios, supportsFirstFrame, supportsLastFrame, supportsReferences, supportsPrompt, resolutions?}`, plus these conditional keys:
- when `supportsReferences`: `maxReferenceImages?`, `maxReferenceVideos?`, `maxReferenceAudios?`, `maxTotalReferences?`, `maxCombinedVideoRefSeconds?`, `maxCombinedAudioRefSeconds?`, `framesAndReferencesExclusive?`, `referenceTagNoun`;
- `requiresSourceVideo?`, `supportsSourceVideo?`, `maxSourceVideoSeconds?`;
- `requiresReferenceImage?`, `requiresReferenceAudio?`;
- `usesOutputDuration?`;
- draft support: `supportsDraft:true`, `draftResolution`, `draftCreditsPerSecond`, `draftEnhanceCreditsPerSecond?`.

**`image` row:** `{type:"image", id, displayName, aspectRatios, supportsImageReference, resolutions?, qualities?}`.

**`audio` row:** `{id, displayName, type:"audio", category, inputs:[text|audio|video|image…], minPromptLength, supportsMultilingual, supportsLyrics, supportsInstrumental, supportsStyleInstructions}`, plus these conditional keys:
- `voicesSample?` (the first 3 voices), `voiceCount?`, `defaultVoice?`;
- `durations?`;
- `maxReferenceImages?`, `maxReferenceAudios?`, `maxReferenceAudioSeconds?`, `referenceAudioExtensions?`, `referenceImagesAndAudiosExclusive?`;
- `minSeconds` and `maxSeconds`, when the model accepts source media;
- `targetLanguages?`.

**`upscale` row:** `{id, displayName, type:"upscale", speed, supportedTypes:[sorted], description?, maximumUpscaleFactor?, settings:[…]}`. Each setting is one of:
- `{id, label, type:"select", default, options:[{value, label, description?, group?, groupDescription?}]}`
- `{id, label, type:"number", minimum, maximum, step}`
- `{id, label, type:"boolean", default}`

The catalog content itself (model IDs, capabilities, pricing) is server data. It is not in the repository.

### 3.45 `generate_video` — AI-GENERATION

**Description (verbatim):**

~~~text
Starts an async AI video generation. Returns a placeholder asset ID immediately; generation runs in the background and the asset becomes usable in add_clips once ready. Costs real money and is not undoable.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "Text description of the video to generate. Optional for transforms such as lip sync that do not use a prompt."
    },
    "name": {
      "type": "string",
      "description": "Display name for the asset in the media library. Defaults to first 30 chars of prompt."
    },
    "model": {
      "type": "string",
      "description": "Model ID (e.g. 'veo3.1-fast'). Use list_models to see options. Defaults to first available model."
    },
    "duration": {
      "type": "integer",
      "description": "Duration in seconds. Valid values depend on model."
    },
    "aspectRatio": {
      "type": "string",
      "description": "Aspect ratio (e.g. '16:9', '9:16', '1:1')"
    },
    "resolution": {
      "type": "string",
      "description": "Resolution (e.g. '720p', '1080p', '4k')"
    },
    "draft": {
      "type": "boolean",
      "description": "Generate a lower-cost 720p preview when list_models reports supportsDraft=true. The resulting media can be enhanced later without changing its motion."
    },
    "enhanceDraftMediaRef": {
      "type": "string",
      "description": "Completed draft asset ID to render at full quality without changing its motion. Use alone instead of prompt/model/input parameters."
    },
    "startFrameMediaRef": {
      "type": "string",
      "description": "Media asset ID to use as the first frame (image-to-video)"
    },
    "endFrameMediaRef": {
      "type": "string",
      "description": "Media asset ID to use as the last frame (supported by some models)"
    },
    "sourceVideoMediaRef": {
      "type": "string",
      "description": "Media asset ID of a source video required by video-to-video models. Pass duration when the selected model lists output durations; otherwise the source duration determines billing."
    },
    "sourceClipId": {
      "type": "string",
      "description": "Optional. Clip id (from get_timeline) referencing sourceVideoMediaRef. When set and the clip is trimmed, only the clip's visible range is sent to the model, not the full source — matches the UI's 'Use trimmed portion only'."
    },
    "referenceImageMediaRefs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Media asset IDs of image references. Covers both reference-to-video generation (Seedance, Kling V3/O3 elements, Grok — refer as @Image1/@Element1 in prompt) and the single-image ref used by video-to-video edit models (Kling V3 Motion Control). See list_models maxReferenceImages for per-model cap."
    },
    "referenceVideoMediaRefs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Media asset IDs of video references (Seedance only). Refer to them as @Video1, @Video2. See maxReferenceVideos and maxCombinedVideoRefSeconds."
    },
    "referenceAudioMediaRefs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Media asset IDs of audio references. Lip-sync models use this as the replacement audio track; prompt-driven models refer to them as @Audio1, @Audio2. See maxReferenceAudios, requiresReferenceAudio, and maxCombinedAudioRefSeconds."
    },
    "folder": {
      "type": "string",
      "description": "Optional destination folder path, e.g. 'Hero shots/Takes'. Created if missing. Omit for the project root."
    }
  }
}
```

**Arguments.** No unknown-key check; lenient accessors. `prompt`, if present, must be a string: `Missing required argument: prompt`.

**Gates:**
- `Generation requires signing in to Palmier. Tell the user to sign in.`
- `Out of credits. Tell the user to add credits or subscribe to keep generating.`

**Enhance-draft path.** `enhanceDraftMediaRef` takes priority over every other argument. It is **not** ID-expanded, so pass the full ID or the exact short form.
- The asset must exist (`Draft not found: <id>`) and be a completed, enhanceable draft (`Asset '<id>' is not a completed enhanceable draft.`).
- Returns `Draft enhancement started. Placeholder asset ID: <id>`.

**Model selection.**
- `model`, or the first catalog model available on the plan:
  - `Model catalog not loaded yet. Try again in a moment.`
  - `No video model is available on the current plan. Tell the user to subscribe.`
- An unknown model: `Unknown model '<m>'. Available: <ids>`.
- A paid model on a free plan: `Model '<m>' requires a paid plan. Pick a free model from list_models, or tell the user to subscribe.`
- `sourceVideoMediaRef` on a model that does not support it: `Model '<m>' does not accept a source video.`

**Video-to-video** (the model requires a source video, or one is given):
- `sourceVideoMediaRef` is required: `Model '<m>' requires 'sourceVideoMediaRef' pointing to a video asset.`
- Optional `sourceClipId` sends only the trimmed range. The clip must exist (`sourceClipId not found: <id>`), reference the source (`sourceClipId <id> references a different asset than the source`), and the source must be video (`sourceClipId only applies to video sources`). An untrimmed clip is treated as the full source.
- Reference images, videos, and audio are resolved (`<Label> not found: <id>`) and validated per model (caps, required references, total and combined seconds).
- **Duration:** with `usesOutputDuration`, it is `duration ?? model.durations[0]`. Otherwise it is the billing duration from the source video length (or, for lip-sync, the replacement audio length): `Replacement audio has an invalid duration.` / `Source video has an invalid duration.`
- **Settings:** `aspectRatio ?? first`. `resolution` is the draft resolution when drafting, else `resolution ?? first`. `draft` is refused when unsupported: `Model '<m>' does not support draft generation.`
- These are validated against the model.
- The placeholder goes in **the source asset's folder**; `folder` is ignored on this path.
- Returns `Edit started. Placeholder asset ID: <id>. Model: <displayName>, source: <source name>[, draft: true]`.

**Text, image, or reference-to-video:**
- A prompt is required: `Empty prompt`.
- Duration, aspect, resolution, and draft are resolved and validated against the model.
- `startFrameMediaRef` and `endFrameMediaRef` must exist (`Start frame not found: …`). The references are resolved and validated.
- **Folder:** `folder` is resolved or created. Without it, the last reference asset's folder is used.
- **Submission:** `VideoGenerationSubmission.submit` creates a placeholder asset (generationStatus `generating`, duration = the requested duration) and runs the job in the background with `generateAudio: true`.
- Returns `Generation started. Placeholder asset ID: <id>. Model: <displayName>, duration: <n>s, aspect: <ar>[, refs: <i>img/<v>vid/<a>aud][, draft: true]`.

**Result.** Plain text, not JSON. Costs money. Not undoable: the placeholder is not an undo step. Poll with get_media `ids`.

### 3.46 `generate_image` — AI-GENERATION

**Description (verbatim):**

~~~text
Starts an async AI image generation. Returns a placeholder asset ID immediately; generation runs in the background. Costs real money and is not undoable.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "Text description of the image to generate"
    },
    "name": {
      "type": "string",
      "description": "Display name for the asset in the media library. Defaults to first 30 chars of prompt."
    },
    "model": {
      "type": "string",
      "description": "Model ID (e.g. 'nano-banana-pro'). Use list_models to see options. Defaults to first available model."
    },
    "aspectRatio": {
      "type": "string",
      "description": "Aspect ratio (e.g. '16:9', '9:16')"
    },
    "resolution": {
      "type": "string",
      "description": "Resolution (e.g. '2K', '4K')"
    },
    "quality": {
      "type": "string",
      "description": "Image quality (e.g. 'low', 'medium', 'high'). Only supported by some models — see list_models."
    },
    "referenceMediaRefs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Media asset IDs to use as reference images"
    },
    "folder": {
      "type": "string",
      "description": "Optional destination folder path, e.g. 'Hero shots/Takes'. Created if missing. Omit for the project root."
    }
  },
  "required": [
    "prompt"
  ]
}
```

**Arguments.** No unknown-key check. `prompt` is required. An absent prompt becomes `""` and is refused with `Empty prompt` after the model checks. A non-string prompt fails with `Missing required argument: prompt`.

**Gates:** sign-in and credits, as in generate_video.

**Execution.**
- **Model:** `model`, or the first available on the plan, as in generate_video. Unknown or paid-only models are refused the same way.
- **Settings:**
  - `aspectRatio ?? first`, `resolution ?? first`, and `quality ?? last` of the model's qualities.
  - They are validated together with the reference count and `numImages: 1`. A model error is returned as the message.
- **References:** `referenceMediaRefs` must exist and be images: `referenceMediaRefs entry '<id>' must be an image asset (got <type>)`.
- **Folder:** `folder` is resolved or created; otherwise the folder of the last reference is used.
- **Submission:** `ImageGenerationSubmission.submit` creates a placeholder image asset and submits the job.
- An empty prompt is refused: `Empty prompt`.

**Result.** Plain text: `Generation started. Placeholder asset ID: <id>. Model: <displayName>, aspect: <ar>`. Not undoable.

### 3.47 `generate_audio` — AI-GENERATION

**Description (verbatim):**

~~~text
Starts an async AI audio generation or transformation. Returns a placeholder asset ID immediately; the asset appears in get_media and becomes usable in add_clips once ready. TTS converts text into speech. Generative audio models create dialogue, music, or sound effects from a prompt, video, or supported image/audio references. Voice Cleanup isolates speech from background audio. Dubbing translates source speech while preserving speaker delivery; pass targetLanguage. For models whose inputs include audio or video, provide sourceMediaRef. Video-to-audio scoring models also accept videoSourceStartFrame+videoSourceEndFrame and place the result on the timeline automatically. Other results land in the media library for placement with add_clips. Use list_models with type='audio' to inspect inputs, category, voices, reference caps, and limits. Costs real money and is not undoable.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "Required for text-driven models. TTS uses it as spoken text; generative audio models use it as the scene, music, or sound description. Omit for Voice Cleanup and Dubbing."
    },
    "name": {
      "type": "string",
      "description": "Display name for the asset in the media library. Defaults to first 30 chars of prompt."
    },
    "model": {
      "type": "string",
      "description": "Model ID. Use list_models with type='audio' to see options and their 'inputs'. Defaults to the first model."
    },
    "voice": {
      "type": "string",
      "description": "TTS only. Voice preset name. list_models shows voicesSample (first 3) + voiceCount; any voice supported by the model is accepted. Defaults to the model's defaultVoice. Ignored by music models."
    },
    "lyrics": {
      "type": "string",
      "description": "MiniMax Music only. Lyrics with optional [Verse]/[Chorus] section tags. If omitted and instrumental=false, MiniMax auto-writes lyrics from the prompt."
    },
    "styleInstructions": {
      "type": "string",
      "description": "Gemini TTS only. Optional delivery instructions (e.g. 'warm and slow', 'British accent')."
    },
    "instrumental": {
      "type": "boolean",
      "description": "Music models only. true = no vocals when the selected model supports it. Defaults to false."
    },
    "duration": {
      "type": "integer",
      "description": "Length in seconds. ElevenLabs Music: 3–600. Sonilo text-to-music: up to 600. Video-to-audio models default to the source span; pass a value to request a different output length. Voice Cleanup and Dubbing always preserve the source length. Ignored by TTS, MiniMax, and Lyria 3 Pro."
    },
    "sourceMediaRef": {
      "type": "string",
      "description": "Source audio or video asset ID for models whose inputs include audio or video. Required for Voice Cleanup and Dubbing."
    },
    "targetLanguage": {
      "type": "string",
      "description": "Required for Dubbing. ISO language code such as 'es', 'fr', 'de', or 'ja'."
    },
    "referenceImageMediaRefs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Image asset IDs for audio models that support image references. See list_models for the count limit. Mutually exclusive with referenceAudioMediaRefs when list_models reports referenceImagesAndAudiosExclusive."
    },
    "referenceAudioMediaRefs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Audio asset IDs for audio models that support audio references. Refer to them in the prompt as @Audio1, @Audio2, and @Audio3. See list_models for the count, duration, and file-type limits."
    },
    "multilingual": {
      "type": "boolean",
      "description": "Enable multilingual generation when supported by the selected model. Defaults to false."
    },
    "videoSourceStartFrame": {
      "type": "integer",
      "description": "Video-to-audio models only. Start frame (timeline) of a span to render and score — pair with videoSourceEndFrame. Use get_timeline for frame numbers; for the whole timeline use 0 to the timeline's end frame."
    },
    "videoSourceEndFrame": {
      "type": "integer",
      "description": "Video-to-audio models only. End frame (exclusive) of the span to score. Must be > videoSourceStartFrame."
    },
    "videoSourceMediaRef": {
      "type": "string",
      "description": "Video-to-audio models only. Score this existing video asset instead of a timeline span. Mutually exclusive with the videoSource frames."
    },
    "folder": {
      "type": "string",
      "description": "Optional destination folder path, e.g. 'Hero shots/Takes'. Created if missing. Omit for the project root."
    }
  }
}
```

**Arguments.** No unknown-key check.

**Gates:** sign-in and credits.

**Model.** `model`, or the first available audio model. Unknown or paid-only models are refused as above.

**Inputs.**
- **References:** `referenceImageMediaRefs` and `referenceAudioMediaRefs` are resolved and validated per model (counts, seconds, extensions, mutual exclusivity).
- **Source:** `sourceMediaRef`, or `videoSourceMediaRef`, which must be a video: `videoSourceMediaRef must be a video asset (got <type>).`
  - The model must accept the source type: `Model '<m>' does not accept <type> source media.`
  - For source-URL models (voice cleanup and dubbing), a video source must have audio: `<displayName> requires source video with an audio track.`
  - The span length is validated.
- **Timeline span** (`videoSourceStartFrame` and `videoSourceEndFrame`, used only when no source asset is given):
  - The model must accept video input: `Model '<m>' does not accept a video input (see list_models 'inputs').`
  - It must not be a source-URL model: `Use sourceMediaRef for <displayName>.`
  - It requires `0 ≤ start < end`: `videoSourceEndFrame must be greater than videoSourceStartFrame (>= 0).`
  - The span is validated, then **rendered** as a silent, low-quality MP4 at 240 px on the short side, uploaded as a reference, and the result is **auto-placed on the timeline** at `start`.
- A model that requires source media but got none: `Model '<m>' needs source media. Provide sourceMediaRef.`

**Parameters.**
- `voice` (`?? defaultVoice`) is used only by models with voices.
- `lyrics`, `styleInstructions`, `instrumental`, and `multilingual` are used only when the model supports them.
- `targetLanguage` is used only by models with target languages.
- **Duration:** source-URL models use the source length. Other models use `duration ?? source span`.
- All parameters are validated by the model, and a validation error is returned as the message.
- **Folder:** `folder`, or the folder of the source or reference media.

**Execution.**
- **Timeline span:** inside undo group "Add <category label> (Agent)", the job is submitted **and** a generating audio clip is placed at `start`, spanning the requested duration or the source span. The clip is finalized when the job completes.
- **Otherwise:** the job is submitted, and the result lands in the library.

**Result.** Plain text:
- **Timeline span:** `Generation started and placed on the timeline at frame <s>. Placeholder asset ID: <id>. Model: <displayName>, <category label> (scored from video).`
- **Otherwise:** `Generation started. Placeholder asset ID: <id>. Model: <displayName>, <category label>[ (from source media)]. Place it with add_clips.`

This tool is in the change-highlight publisher set.

### 3.48 `upscale_media` — AI-GENERATION

**Description (verbatim):**

~~~text
Enhances an existing video or image with an AI upscaler. It can change resolution, interpolate video frame rate, or apply model-specific restoration settings. Returns a placeholder asset ID immediately; the result appears in get_media once ready. Call list_models with type='upscale' first and use its exact setting IDs and values. Costs real money and is not undoable.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "mediaRef": {
      "type": "string",
      "description": "ID of the video or image asset to upscale"
    },
    "model": {
      "type": "string",
      "description": "Upscaler model ID (e.g. 'bytedance-upscaler', 'seedvr-image-upscaler'). Defaults to the first model that supports the asset's type."
    },
    "sourceClipId": {
      "type": "string",
      "description": "Optional. Video clip id (from get_timeline) referencing mediaRef. When set and the clip is trimmed, only the clip's visible range is upscaled, not the full source."
    },
    "settings": {
      "type": "object",
      "description": "Optional flat map of setting ID to value from list_models. Select settings take strings, numeric settings take numbers, and toggle settings take booleans. Omitted settings use model defaults. Example: {\"targetResolution\":\"4k\",\"targetFPS\":\"60\",\"enhancementModel\":\"Proteus\",\"noise\":0.2}."
    }
  },
  "required": [
    "mediaRef"
  ]
}
```

**Arguments.** No unknown-key check. `mediaRef` is required.

**Validation.**
- The asset must be video or image: `Upscale supports video and image assets only (got <type>)`.
- Dimensions must be known: `Source dimensions are not available yet. Poll get_media until the asset is ready.`
- A video's fps must be known: `Source FPS is not available yet. Poll get_media until the asset is ready.`
- Sign-in and credits: `Upscale requires signing in to Palmier. Tell the user to sign in.`, and the out-of-credits message.

**Model.**
- An explicit `model` must support the asset type: `Model '<m>' does not support <type>. Available: <ids>`.
- It must be allowed on the plan, and compatible with the source's resolution and frame rate: `Model '<m>' is not compatible with this source's resolution or frame rate.`
- The default is the first model available on the plan that is compatible: `No compatible upscaler is available for this <type> on the current plan.`

**Settings.**
- `settings` must be an object: `settings must be an object`.
- It starts from the model defaults, normalized for the source.
- **Select** settings take a string from the available options for this source: `Unsupported <id>. Available: <values>`.
- **Numeric** settings take a finite number within min…max: `<id> must be between <min> and <max>`.
- **Toggle** settings take a JSON boolean: `<id> must be true or false`.
- Unknown IDs: `Unknown upscale setting '<id>'. Available: <ids>`.
- `sourceClipId` trims the source, as in generate_video.

**Execution.** `EditSubmitter.submitUpscale` creates a placeholder and submits the job. If it fails: `Failed to start upscale`.

**Result.** Plain text: `Upscale started. Placeholder asset ID: <id>. Model: <displayName>, source: <name>[ (trimmed range)]`. Not undoable.

### 3.49 `send_feedback` — CORE

**Description (verbatim):**

~~~text
Report an agent limitation or bug to the Palmier team so they can improve the product. Use when you can't do what the user asked because a capability or tool is missing or behaves wrong, the result is clearly off, or the user is plainly hitting a rough edge. This sends directly — there is no user confirmation step — so write the report in English and PARAPHRASE in your own words: translate non-English user text to English, and never include verbatim user messages, prompts, file paths, media, transcript text, or any project content. App/OS version and your recent tool names are attached automatically. Use sparingly: at most once per distinct issue.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "category": {
      "type": "string",
      "enum": [
        "missing_capability",
        "wrong_result",
        "confusing_ux",
        "failure",
        "suggestion"
      ],
      "description": "What kind of problem this is."
    },
    "summary": {
      "type": "string",
      "description": "One-line paraphrased summary of the issue. Becomes the report's subject."
    },
    "details": {
      "type": "string",
      "description": "Optional. Paraphrased explanation of what the user was trying to do and what went wrong or was missing. No verbatim content."
    },
    "severity": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high"
      ],
      "description": "Optional. How much this blocked the user."
    }
  },
  "required": [
    "category",
    "summary"
  ]
}
```

**Arguments.** No unknown-key check.
- `category` is required, trimmed, and must be one of the enum values: `Invalid category '<c>'. Expected one of: confusing_ux, failure, missing_capability, suggestion, wrong_result.`
- `summary` is required and non-empty after trimming: `summary must not be empty.`
- `details` is optional.
- `severity` must be `low|medium|high`: `Invalid severity '<s>'. Expected low, medium, or high.`

**De-duplication.** The key `category|summary` is checked per session.
- A repeat returns the **success** text `Already flagged this to the team this session — not sending a duplicate.`
- At most 8 reports are sent per session. After that, the success text is `Feedback limit reached for this session. Summarize any remaining issues to the user instead of sending more.`

**Message format.** The body is:
```text
[Agent] <summary>

Category: <category>[ · <severity>]

Details:
<details>

Diagnostics (auto-collected):
- Recent tools: <last 15 tool names | none>
- Last error: <text | none>
- Project: <projectId prefix 8>
```
The `Details:` block is present only when `details` was given. It is sent with the app and OS versions, with no email and no screenshot.

**Result.**
- On success: `Flagged this to the Palmier team. Thanks — this helps us improve the agent.`
- On a send failure, the error `Couldn't send feedback: <message>`.

Allowed on an inactive project.

### 3.50 `manage_project` — CORE

**Description (verbatim):**

~~~text
List, open, create, or close Palmier projects for this MCP session. Set `action` to: `list` for known projects plus session-active and visible state; `open` with a name, id from list, or .palmier path; `create` with an optional name and initial fps/aspectRatio/quality; or `close` to save and close the session project, optionally targeting another open project by name/id/path. Opening or creating changes only this session's target. Closing always completes a final save first. This tool never deletes projects or files.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "list",
        "open",
        "create",
        "close"
      ],
      "description": "Project operation."
    },
    "name": {
      "type": "string",
      "description": "Project name. For open/close, matched case-insensitively; for create, defaults to 'Untitled Project'."
    },
    "id": {
      "type": "string",
      "description": "Project id returned by action='list'. Used by open or close."
    },
    "path": {
      "type": "string",
      "description": "Filesystem path to a .palmier package. Used by open or close."
    },
    "fps": {
      "type": "integer",
      "description": "Create only. Optional timeline frame rate (1-120)."
    },
    "aspectRatio": {
      "type": "string",
      "description": "Create only. Optional canvas aspect ratio as width:height, such as '16:9', '3:2', or '2.39:1'."
    },
    "quality": {
      "type": "string",
      "enum": [
        "720p",
        "1080p",
        "2K",
        "4K"
      ],
      "description": "Create only. Optional resolution preset applied to the aspect ratio."
    }
  },
  "required": [
    "action"
  ]
}
```

**MCP only.** It runs before any focus guard, editor check, or ID expansion, and never touches undo.

**Arguments.** Allowed keys: `action, aspectRatio, fps, id, name, path, quality`.
- `action` is required: `manage_project requires an 'action'.`
- Unknown actions: `Unknown project action '<a>'. Use one of: list, open, create, close.`
- Each action re-checks its own allowed keys, with path `manage_project action='<a>'`. A key that is not allowed fails with `manage_project action='<a>': unknown field(s) … Allowed: …`.

**Selector** (`name` | `id` | `path`, used by `open` and `close`):
- At most one key: `<path>: provide only one of: name, id, path.`
- The value must be a non-empty string: `<path>: '<key>' must be a non-empty string.`
- **`path`:** `~` is expanded.
- **`id`:** must be a UUID from the registry:
  - `<path>: 'id' must be a project id returned by action='list'.`
  - `No project with id <id>. Call manage_project with action='list' for valid ids.`
- **`name`:** a case-insensitive exact match over the registry:
  - No match: `No project named '<n>'. Known projects: <up to 15 names>. Call manage_project with action='list' for the full list.`
  - Several matches: `<k> projects are named '<n>'. Pick one by path: <paths>`.

**Actions:**
- **list** (no other keys allowed)
  - Returns `{openCount, projects:[{id, name, path, isOpen, isActive, isVisible, isAccessible}], active?:{name, path}, visible?:{name, path}}`.
  - Projects come from the registry of known projects, most recently opened first.
  - `isActive` means this session's bound project. `isVisible` means the frontmost project.
- **open** (`name`, `id`, or `path`)
  - A selector is required: `manage_project action='open' needs a name, an id from action='list', or a path.`
  - The project must exist on disk: `No project at <path>.`
  - The project is opened, or focused if already open. The session is bound to it, and the system notice `Now editing: <name>` is posted in that project's in-app chat.
  - Returns `projectSnapshot(status:"active")`, with IDs shortened.
- **create** (`name`, `fps`, `aspectRatio`, `quality`)
  - `name` must be a string: `manage_project action='create': 'name' must be a string.` The default is `Untitled Project`.
  - The settings are validated with set_project_settings' rules (§3.6) and resolved against a default timeline (30 fps, 1920×1080). `width` and `height` are not accepted.
  - A new project is created (the AppState default location and naming apply) and bound to the session.
  - The settings are applied directly, not as an undo step. The notice is posted.
  - Returns `projectSnapshot(status:"created")`.
- **close** (optional selector)
  - **Target:**
    - With a selector, the target must be open: `Project at <path> isn't open.`
    - Without one, the target is the session project: `No project is open.`
  - A final save runs, then the project closes. A save failure leaves the project open: `Couldn't save '<name>' — project left open. <error>`.
  - If it was the session's project, the session is unbound.
  - Returns `{status:"closed", name, openCount, active?:{name, path}, visible?:{name, path}}`.

**`projectSnapshot`:** `{status, name, path, fps, resolution:"<W>x<H>", mediaCount, canGenerate, timelines:[{timelineId, name, active?}], openCount}`.

---

## 4. Agent instructions (verbatim)

### 4.1 MCP `initialize.instructions`

This is `AgentInstructions.serverInstructions + AgentInstructions.projectNavigation`, exactly as the Swift compiler builds the string. Swift multiline literals strip only the closing-delimiter indentation (8 spaces). Continuation lines that were indented 10 spaces therefore keep 2 leading spaces after the `\` line join, which produces runs such as `gaps,   ranges` (three spaces). These runs are present in the shipping binary. Reproduce them byte-for-byte if exact parity matters; collapsing them is harmless for model behaviour. The final heading is preceded by exactly one `\n`.

~~~text
You are a creative AI assistant connected to palmier-pro, an AI-native video editor. Help the user build and edit their project by calling the tools this server exposes.

# Core model
- Timing: TIMELINE positions are project frames (startFrame, frames pairs, gaps,   ranges); SOURCE positions are seconds (source spans, search hits, asset transcripts   and durations). Tools convert between them — never multiply by fps yourself.
- Tracks are ordered and typed (video or audio); index 0 renders on top. For manage_tracks,   use stable trackId values because indexes change. Video, images, and text use video tracks.
- A clip occupies frames [start, end). Placement takes startFrame + endFrame or   source: [startSeconds, endSeconds]; lengths elsewhere are durationFrames. A video   clip's linked audio is folded into it as audio: {id, track, …} — use that nested id   to edit the audio side.
- A project can hold several timelines; exactly one is active and every read/edit   tool targets it (get_media lists them; switch with set_active_timeline, then   re-read). create_timeline makes a new empty timeline or duplicates via from= — use   that for alternate versions instead of editing over the original. A nested timeline   appears as a clip with mediaType 'sequence'.
- Markers are persistent timeline notes. Use manage_markers and stable markerId values;   point markers have zero duration and ranges are half-open. Ripple edits may move or   remove them — patch positions from the mutation delta. Leave failed or ambiguous   work open, set review only after applying and verifying the edit, and set resolved only   when the user explicitly approves or requests it.
- IDs are short prefixes — pass them back exactly as given, never padded or completed.   Folders have no ids: they are paths ('B-roll/Sunset'), created on demand.

# Session
- Call get_timeline once per session (or after an out-of-band change). Don't re-read   between your own edits — every mutation returns a delta in get_timeline vocabulary:   clips (resulting state, with track), shifted rules ({track, fromFrame, by, count}),   removedClipIds, markers, removedMarkerIds, createdTracks, and notes. Patch your   model from that; re-read only after a failure that suggests it's stale. Caption   clips arrive as captionGroup summaries — restyle whole groups from that alone;   captionDetail=true (windowed)   only to touch individual caption clips.
- After a batch of edits, spot-check the result: get_timeline for structure,   inspect_timeline when placement, layout, captions, or stacking matter.   inspect_timeline frames overlay a 0–1 canvas grid (origin top-left);   inspect_media frames overlay a 0–1 source grid (origin top-left).
- Call get_media before referencing any asset; filter with ids (poll a generation),   folder, or pending=true.
- Call list_models before any generate_* or upscale call. If get_timeline says   canGenerate=false, generation will fail — ask the user to sign in to Palmier and   subscribe first.
- Never describe an asset from its filename — inspect_media first. On long media work   coarse to fine: overview=true storyboard, then transcript segments, then zoom with   startSeconds/endSeconds.
- To find a moment ("the sunset shot", "where she mentions the budget"): search_media   first. Use scope='spoken' for dialogue-only requests so visual search is not installed   unnecessarily, then pass hits straight to add_clips as source: [startSeconds, endSeconds].

# Editing
- Edits are undoable and effectively free — don't ask permission for individual   edits; just say what changed.
- When an edit adds a track with one clear role, name it via manage_tracks with one short filmmaking word; leave mixed or unclear tracks unnamed.
- Composition on the current canvas (split screen, PIP, grid, position/size) is   apply_layout's job: pick a layout, fill every slot, nudge framing with   anchorX/anchorY. Nested timelines (mediaType 'sequence') stack the same way as video   clips — pass their timelineId as mediaRef or their carrier clipIds. Never build   layouts from set_clip_properties transform/crop or set_keyframes. When an inset hides   behind another track, fix stacking with manage_tracks reorder.
- Static source crop is set_clip_properties crop (0–1 insets; omitted edges keep   current values; all zeros restore the source). That writes clip.crop and clears crop   keyframes. Animated crop is set_keyframes. Not for split/PIP/grid (apply_layout).
- Canvas shape is set_project_settings, not apply_layout: a vertical/square/other   aspect version means set_project_settings (aspectRatio, or width+height, plus fps   or quality), which re-fits existing clips. Duplicate first with   create_timeline(from=) when the original aspect must survive, then reframe the   re-fitted clips with apply_layout.
- Cutting, in order of preference: remove_silence for pauses and dead air (no   transcript needed — run it first when tightening pacing; override with   minimumPauseSeconds / speechPaddingSeconds when the user wants tighter or looser   silence removal); remove_words for fillers and flubbed lines — read the word-level   transcript as prose once, then pass indices; it maps words to frames and closes the   gaps. After a cut, indices shift — re-read get_transcript before the next   remove_words. ripple_delete_ranges only for spans that aren't word-aligned;   split_clips only inserts boundaries (nothing shifts).
- When the user asks to trim or tighten: ask one or two focused clarifying questions   if goals are vague, then be thorough — cut fillers, false starts, repeated beats,   and dead space between sentences, not only obvious ums. After cutting, re-read the   transcript and confirm it still reads as continuous sense (no orphan mid-thoughts,   no leftover repeated takes, no awkward jumps). Prefer a coherent spoken arc over   maximum shortness.
- Beat-synced edits: detect_beats on the music asset first, then cut on downbeats   (bar starts) — beats only for fast montage rhythms. Times are source seconds.
- Text: add_texts for authored overlays; add_captions transcribes the timeline's   spoken audio (no targeting) — restyle with update_text and the returned   captionGroupId. Style covers typography, outline, shadow, background,   widthScale/heightScale, and style.blur (whole-layer Gaussian blur). fillMode   'footage' stencils layers below through the letter shapes over a matte set by   style.color (black when omitted); 'inverted' uses white Difference-blended glyphs   to invert those layers. Transform sets alignment-relative x, vertical y, Z   rotation, and static perspective tilt (rotationX/rotationY).   Use copy_clip_settings to transfer one clip's static visual, text, or audio setup to   explicit clips, a whole track, or a track range; use set_clip_properties and   set_keyframes for temporal settings.   Color: apply_color (knobs merge; pass a clip's `color` object to   copy a whole grade); video/image FX: apply_effect; iterate grades against inspect_color.
- Transcription language: omit unless the user names the spoken language. Cloud   auto-detects; local is language-specific — pass BCP-47 (language='es') for   non-English local runs, and if local output looks wrong, ask for the language and   retry.
- A transcript summary is lossy: it hides reworded retakes and zero-width seam   fragments (a word whose start equals the next word's start) — verify suspected   fragments against the words, not the summary.

# Export
- export_project modes: video (default — H.264/H.265/ProRes, 720p–4K or Match   Timeline), xml (Premiere), fcpxml (Resolve / Final Cut), palmier (self-contained   package). Omit outputPath unless the user named a destination (default   ~/Downloads). Every mode is queued in the background. Report whether it started or   is waiting. Use manage_exports to list progress and read warnings/results, or   cancel an exact jobId when the user asks; never infer that an export is stuck from   elapsed time alone. The user can also manage the queue in the Export dialog.

# Generation
- Costs real money and is not undoable. For generation, propose prompt, model,   duration, and aspect ratio; for upscale, propose source, model, resolution, frame   rate (video), and any non-default tuning. Wait for confirmation before submitting.
- Flow: images first — iterate stills until the user approves the look, then use the   approved image as the video's startFrameMediaRef. Straight text-to-video only when   asked or when no frame anchors the shot.
- For video models that report supportsDraft=true, draft=true creates a lower-cost   720p approval preview from text, frames, or source video. Use it when auditioning   alternatives, not when the user asked for a final render; approved drafts can be   enhanced later without changing their motion. To enhance an approved draft, call   generate_video with enhanceDraftMediaRef set to that draft's media ID.
- General recommendation (resolve via list_models): images — GPT Image and Seedream 5.0. Video —   MiniMax H3 for cheap text-to-video, Grok Imagine for first-frame and simple low-motion shots;   Seedance 2.5 for overall quality and references (720p; 1080p is the best available but   extremely expensive — do not use it by default).
- Generation and url/path imports return a placeholder id and run in the background.   Do not busy-poll long jobs (video/image/upscale) — fire and move on. Audio is   usually fast: one or two get_media ids:[placeholder] checks are fine. Never promise   to notify, resume, or keep working once generation finishes — this turn cannot   re-trigger itself; tell the user the placeholder id and that they can ask you to   continue when it's ready. On generationStatus 'failed', tell the user and ask   before re-firing.
- Consistency: reuse referenceMediaRefs on images; startFrameMediaRef /   endFrameMediaRef and the per-model reference*MediaRefs on video. Build base shots   before derived ones; parallelize independent generations; organize related   generations with a `folder` path on the call.
- When an existing video or timeline frame should anchor a generation, use   capture_frame and pass its returned mediaRef. Never approximate that frame with   generate_image.
- Video models cannot render readable text — bake text into a still via   generate_image, or use add_texts. Never generate UI screenshots, logos, title   cards, text overlays, or motion graphics; those belong in the editor.
- import_media bridges external assets (url, path, or bytes) and makes solid-color   mattes (source.matte with hex).
- Audio models (list_models type='audio'): TTS — the prompt is the exact words to   speak; pass a supported voice, styleInstructions where offered. Music — the prompt   describes style/mood/genre; lyrics with [Verse]/[Chorus] tags where supported (for   Lyria 3 Pro, fold lyrics/tempo/language/vocal style into the prompt); instrumental   only where supported.
- Upscaling (list_models type='upscale'): inspect the source's width, height, and fps   with get_media. Use the model and family descriptions; call inspect_media when the   source's visual condition determines the choice. Pass a flat settings object using   the listed IDs and values. targetFPS='source' preserves frame rate; a higher numeric   target interpolates. Omit restoration tuning unless requested or clearly needed.

# Prompt craft
- Images, 15–30 words: subject + setting + shot type + lighting/mood. Concrete nouns   beat adjectives.
- Videos, 8–20 words: camera movement + subject action. With a startFrameMediaRef,   don't re-describe the frame — spend the words on motion and sound. State dialogue,   VO, SFX, and music explicitly; silent video is usually a bug.

# Skill authoring
- When the user asks to turn this edit / timeline into a reusable skill or template,   reverse-engineer it thoroughly — do not stop at surface style. Use chat/tool   history when available, then get_timeline, get_transcript, inspect_media on the   raw sources, and inspect_timeline on key frames. Compare library footage to what   landed on the timeline and infer selection criteria.
- Capture both recipe and judgment: exact numeric values (transform x/y, layout   slots/anchors, caption/text style, color/effects, track names) hard-coded so a   stranger can recreate the piece with no prior context; plus editorial rules —   structure (hook/body/summary), what to keep vs cut, pacing, where text lands, when   keyframes fire, and multicam cadence (speaker, sentence, mid-thought — never only   at every sentence end). Prefer the same tool path the original used   (set_project_settings for canvas shape, apply_layout for composition and framing,   caption templates/skills when they match). Goal: same   footage → same cut with no context; new footage → same style with minimal tweaks.   If a create-skill-from-timeline skill is available, read it and follow it.

# Feedback
- When a capability is missing or broken, a result is clearly wrong, or the user is   plainly hitting a limitation, call send_feedback once with a paraphrased summary —   never verbatim user content. Send workflow improvements as `suggestion`. One per   distinct issue; mention it to the user briefly.

# Communication
- One or two sentences; lead with the outcome. The user watches the timeline change —   never narrate steps, never recap what a tool returned. No preamble, no play-by-play.   Match the app's calm, terse, HIG-style voice: never chatty, never marketing. When   the user is vague about aesthetic direction, ask one focused question instead of   guessing.
# Projects (MCP)
This session may start with no project open. Before get_timeline / edits / export, call manage_project: action='list' to see known projects and which is session-active or visible; action='open' (name, id, or .palmier path) to bind the session; action='create' for a fresh project (optional fps / aspectRatio / quality); action='close' to save and close. It never deletes projects.
The session stays on its project if the user activates another project window. Reads still inspect the session project, but changes pause until that project is visible again or action='open' selects the visible project. Other MCP sessions and in-app chats keep their own project context.
Timelines and export work inside the bound project: create_timeline / set_active_timeline for versions and nests; export_project / manage_exports for delivery. If a client searches tools by keyword, use those exact names.
~~~

### 4.2 In-app agent only (not sent over MCP)

The in-app agent's system prompt uses `serverInstructions` (above, without `projectNavigation`) plus `AgentInstructions.skillsSection(index)` when at least one skill is installed. That section evaluates to the following, where `<index>` is `SkillStore.skillIndex`, one `- <id>: <description>` line per skill, sorted by ID:

~~~text

# Skills
Playbooks for specific tasks. Before a task that matches one, call read_skill(id) to load its full procedure, then follow it.
<index>
~~~

The in-app agent's tool list is `ToolDefinitions.all + [read_skill, manage_skills]`, so it has no `manage_project`. The definitions of the two in-app-only tools are in Appendix A.

---

## 5. Skills (`Agent/Skills`)

**No skill content ships in the repository.** `Agent/Skills` contains only code:

- **Storage.** Each skill is a folder `~/.palmier/skills/<id>/SKILL.md` and is the single source of truth.
  - The ledger file `~/.palmier/skills/.installed.json` holds `{version:1, installed:{id:sha12}, suppressed:[id]}`. The legacy format is a bare `{id:sha}` map.
  - Skill IDs are folder names: a single path component, not `.` or `..`, with no `/` or `\`.
- **SKILL.md format.** The file starts with a frontmatter block:
  ```text
  ---
  name: <one line>
  description: <one line>
  ---

  <markdown instructions>
  ```
  - Only `key: value` frontmatter lines are parsed, with surrounding double quotes stripped.
  - `name` and `description` are required and must be non-blank; otherwise the skill is ignored.
  - The body is everything after the closing `---`, trimmed.
  - `sha12` = the first 12 hex characters of SHA-256 over the raw file bytes.
- **Limits:** name ≤ 120 characters, description ≤ 500, instructions ≤ 50,000. Name and description must be single lines.
- **Created IDs:** `suggestedID(name)` lowercases the name, splits it on non-alphanumerics, joins the parts with `-`, truncates to 64 characters, and trims `-`. An empty result becomes `new-skill`.
- **Community catalog** (`SkillCatalog`).
  - Fetched from `${PALMIER_SKILLS_BASE:-https://raw.githubusercontent.com/palmier-io/palmier-skills/main}/catalog.json`, which is an array of `{id, name, description, sha, path}`. It is cached as `skills-catalog.json` in the app disk cache.
  - The body URL is `<base>/<path>`. An install verifies the body's `sha12` against `sha` before writing.
  - **Auto-install rule** (`shouldAutomaticallyInstall`):
    - Never install a suppressed skill.
    - If the skill is not present locally, install it only when it was never installed before.
    - If it is present locally, update it only when the local sha equals the installed sha (the user has not modified it) and the catalog sha differs.
  - Deleting a skill suppresses it, so it is not re-installed.
- **Catalog contents** as published on 2026-10-13. This is remote data, fetched at runtime and **not** part of the repository: `caption-templates`, `character-pipeline`, `cinematic-motion`, `color-grading`, `create-skill-from-timeline`, `motion-graphics`, `multi-cam-editing`, `podcast-ad`, `timeless-love-story`, `ugc-editing`, `ugc-photo-prompts`, `ugc-video-prompts`, `video-prompting`. Each lives at `skills/<id>/SKILL.md`.
- **Exporting to external agents.** The UI can copy a skill to `~/.claude/skills/palmier-<id>/`, `~/.codex/skills/palmier-<id>/`, or `~/.cursor/skills/palmier-<id>/`. This is how MCP clients get Palmier skills; the skills are **not** served over MCP.
- **Over MCP:** no prompts or resources expose skills, and `read_skill` and `manage_skills` are in-app only.

---

## 6. Classification summary and external dependencies

| # | Tool | Class | External service / model on macOS (what the port needs) |
|---|---|---|---|
| 1 | `get_timeline` | CORE | None (model read) |
| 2 | `inspect_timeline` | CORE | Compositor/renderer (same as preview/export) + JPEG encode |
| 3 | `create_timeline` | CORE | None |
| 4 | `set_active_timeline` | CORE | None |
| 5 | `manage_markers` | CORE | None |
| 6 | `set_project_settings` | CORE | None (applyTimelineSettings re-fit/rescale) |
| 7 | `export_project` | CORE | Export pipeline (H.264/H.265/ProRes encode, XMEML, FCPXML, .palmier package) |
| 8 | `manage_exports` | CORE | Export queue |
| 9 | `get_media` | CORE | None (library read) |
| 10 | `inspect_media` | CORE | Frame extraction/thumbnails/Lottie render = CORE; the audio transcription part needs local ASR (NEEDS-ML: Apple SpeechAnalyzer on macOS) |
| 11 | `search_media` | NEEDS-ML | Visual: SigLIP 2 B/16-256 image/text embeddings (on-device, auto-downloaded) + shot indexer; Spoken: transcript keyword + on-device semantic matching over cached transcripts |
| 12 | `import_media` | CORE | HTTPS downloader (url mode); none otherwise |
| 13 | `capture_frame` | CORE | Compositor (timeline mode) / video frame decode (media mode); PNG encode |
| 14 | `organize_media` | CORE | None |
| 15 | `add_clips` | CORE | None |
| 16 | `insert_clips` | CORE | None |
| 17 | `move_clips` | CORE | None |
| 18 | `remove_clips` | CORE | None |
| 19 | `manage_clip_links` | CORE | None |
| 20 | `manage_tracks` | CORE | None |
| 21 | `split_clips` | CORE | None |
| 22 | `ripple_delete_ranges` | CORE | None (RippleEngine) |
| 23 | `swap_clip_media` | CORE | None |
| 24 | `set_clip_properties` | CORE | None |
| 25 | `copy_clip_settings` | CORE | None |
| 26 | `set_keyframes` | CORE | None |
| 27 | `apply_layout` | CORE | None |
| 28 | `sync_clips` | NEEDS-ML | Audio cross-correlation (DSP, no neural model; seeded by capture dates) + embedded timecode reader; drift correction |
| 29 | `manage_multicam` | NEEDS-ML | Audio cross-correlation per member vs master (DSP; skipped for members with pinned offsetSeconds) |
| 30 | `change_cam` | CORE | None once a group exists (pure timeline edit); deferrable with multicam |
| 31 | `get_multicam` | CORE | None (read); deferrable with multicam |
| 32 | `undo` | CORE | None (shared undo stack) |
| 33 | `get_transcript` | NEEDS-ML | Local ASR (Apple SpeechAnalyzer/SpeechTranscriber on macOS) or Palmier cloud transcription (Convex transcriptions:*); speaker labels via WeSpeaker embeddings |
| 34 | `remove_words` | NEEDS-ML | Same transcription stack as get_transcript (WordCutPlanner itself is pure) |
| 35 | `remove_silence` | NEEDS-ML | Silero VAD speech detection (on-device; MLX on macOS) + audio level analysis (SpeechMaskStore) |
| 36 | `detect_beats` | NEEDS-ML | Beat This! small0 (CPJKU, ISMIR 2024) neural beat/downbeat tracker; bundled Core ML on macOS — use ONNX/PyTorch on Linux |
| 37 | `add_texts` | CORE | Text layout/measurement (CoreText on macOS → port's text engine) |
| 38 | `update_text` | CORE | Text layout/measurement |
| 39 | `add_captions` | NEEDS-ML | Transcription (local ASR or Palmier cloud) for spoken captions; the subtitleMediaRef path is pure parsing (CORE-able) |
| 40 | `apply_color` | CORE | None (CIFilter/kernel color pipeline → port to GPU shaders); LUT .cube parser |
| 41 | `apply_effect` | CORE | None (CIFilter/kernel effects → port to GPU shaders) |
| 42 | `inspect_color` | CORE | Frame decode + effect render + scopes (pure image math) |
| 43 | `denoise_audio` | NEEDS-ML | DeepFilterNet3 speech enhancement (on-device, baked to a sidecar in the background) |
| 44 | `list_models` | AI-GENERATION | Palmier backend model catalog (Convex `models:list` subscription) |
| 45 | `generate_video` | AI-GENERATION | Palmier backend `generations:submit` / `generations:enhanceDraft` (+ `uploads:commitUpload` for reference media); providers behind the backend (Veo, Seedance, Kling, MiniMax/Hailuo, Grok, …) |
| 46 | `generate_image` | AI-GENERATION | Palmier backend `generations:submit` (image providers: GPT Image, Seedream, Nano Banana, …) |
| 47 | `generate_audio` | AI-GENERATION | Palmier backend `generations:submit` (TTS, music, SFX, video-to-audio scoring, voice cleanup, dubbing providers) + `uploads:commitUpload` for rendered timeline spans |
| 48 | `upscale_media` | AI-GENERATION | Palmier backend upscale job (EditSubmitter → GenerationService → `generations:submit`); catalog upscalers such as `bytedance-upscaler` and `seedvr-image-upscaler` |
| 49 | `send_feedback` | CORE | Palmier backend `feedback:send` (stub or redirect on Linux) |
| 50 | `manage_project` | CORE | Project registry + open/create/save/close (AppState) |

Counts on the MCP surface (50 tools): **CORE 36, AI-GENERATION 5, NEEDS-ML 9**. In-app only, not on MCP: `read_skill` and `manage_skills`, both local file I/O.

Notes on the dependencies:

- **Palmier cloud backend.** The Swift app talks to a Convex deployment (`BackendConfig.convexDeploymentURL`/`convexHttpURL` from Info.plist) after Clerk sign-in. The functions it uses:
  - generation: `models:list` (catalog subscription), `generations:submit`, `generations:enhanceDraft`, `generations:byId`, `generations:projectActivity`, `uploads:commitUpload`;
  - transcription: `transcriptions:submit`, `transcriptions:byId`, `transcriptions:result`;
  - feedback: `feedback:send`;
  - account: `account:get`, `users:upsertFromAuth`.

  All AI-GENERATION tools, cloud transcription, `canGenerate`, and `send_feedback` depend on this backend.
- **On-device models used on macOS**, and their Linux replacement candidates:

  | Purpose | macOS implementation | Linux candidate |
  |---|---|---|
  | Local transcription | Apple `SpeechAnalyzer`/`SpeechTranscriber` (OS speech framework, locale-specific) | whisper.cpp, faster-whisper, or Parakeet |
  | Visual search | SigLIP 2 B/16-256 via Core ML, downloaded at runtime from `huggingface.co/palmier-io/siglip2-base-coreml` | ONNX export of `google/siglip2-base-patch16-256` |
  | Beat and downbeat detection | Beat This! `small0`, Core ML, bundled (`BeatThis.mlmodelc`, 6.6 MB; 22.05 kHz mono, 30 s windows) | ONNX or PyTorch |
  | Speech activity for remove_silence | Silero VAD (MLX) | ONNX Silero |
  | Speaker labels in transcripts | WeSpeaker embeddings | ONNX |
  | Denoise | DeepFilterNet3 (`SpeechEnhancement`) | libDF / ONNX |
  | sync_clips and manage_multicam | Audio cross-correlation, plain DSP with no model; timecode mode needs none | Same DSP |
- **Spoken search.** `search_media` spoken matching is keyword matching plus on-device semantic matching over cached transcripts (`TranscriptSearch`).

---

## 7. Porting checklist (contract-level gotchas)

1. Return **every** structured payload as a JSON **string** in a text block. Do not add `structuredContent`. Omit `isError` on success.
2. Implement both short-ID shortening of every text output and prefix expansion of the listed argument keys, with the ambiguity error. Clients rely on 8-character IDs round-tripping.
3. Drop top-level `null` and `""` arguments before validation.
4. Keep the project-focus guard and the read-only allowlist. "Frontmost" maps to the focused project window or tab.
5. Use the lenient-versus-strict parsing split (§1.8). Several tools accept numeric strings, and others reject them; matching these quirks keeps client behaviour identical.
6. Keep unknown-key rejection, with the exact `Allowed:` lists. The lists are given per tool.
7. Apply the mutation-delta algorithm (§2.3) everywhere it is used, including the 30-clip cap, the shift grouping threshold (3), and the caption collapse threshold (3).
8. Round floats to 3 decimals in the tools that do so. JSON key sorting is optional; clients do not depend on it.
9. Serve `tools/list` in the documented order. Serve the 2 resources. Send `tools/list_changed` once per GET-stream attach.
10. Accept sessionless calls (stateless fallback) and return `404` for unknown session IDs. Cap sessions at 32, with 1 h idle eviction.
11. Keep `serverInfo` as `{name:"palmier-pro", version:"1.0.0"}` and the instructions string verbatim. Client configurations (Claude Code: `claude mcp add --transport http palmier-pro http://127.0.0.1:19789/mcp`) depend only on the URL and these strings.
12. Bind only to 127.0.0.1:19789, and keep the Host and Origin validation, because it is DNS-rebinding protection.

---

## Appendix A — in-app-only tools (not exposed over MCP)

### `read_skill` (in-app agent only)

**Description (verbatim):**

~~~text
Load the full instructions for one of the skills listed under # Skills in your system prompt. Call this before starting a task that matches a skill's description, then follow the returned procedure. Pass the id exactly as listed.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The skill id, exactly as listed under # Skills."
    }
  },
  "required": [
    "id"
  ]
}
```

**Execution.**
- `id` is required: `read_skill requires an 'id'.`
- The ID must be installed: `Unknown skill: <id>`.
- Returns the skill's Markdown body as plain text, with the frontmatter removed and the body trimmed.
- Skill-read analytics record the ID, the sha12, and the origin (`community`, `community_modified`, or `local`).
- Read-only.

### `manage_skills` (in-app agent only)

**Description (verbatim):**

~~~text
Create, update, or permanently remove reusable skills for the in-app assistant. Set `action` to: `create` with name, description, and complete Markdown instructions; `update` with an exact skill id and at least one field to replace; or `remove` with an exact skill id. Updates are partial patches, but `instructions`, when present, replaces the complete Markdown body, so call read_skill first when preserving existing instructions. Use remove only when the user explicitly asks to delete that skill. The app generates and returns a stable id for created skills.
~~~

**Input schema (verbatim):**

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "create",
        "update",
        "remove"
      ],
      "description": "Skill operation."
    },
    "id": {
      "type": "string",
      "description": "Update/remove only. Exact skill id listed under # Skills."
    },
    "name": {
      "type": "string",
      "maxLength": 120,
      "description": "Create/update. Concise skill display name on one line."
    },
    "description": {
      "type": "string",
      "maxLength": 500,
      "description": "Create/update. One-line trigger description explaining when the assistant should use the skill."
    },
    "instructions": {
      "type": "string",
      "maxLength": 50000,
      "description": "Create/update. Complete replacement Markdown instructions without YAML frontmatter."
    }
  },
  "required": [
    "action"
  ]
}
```

**Execution.**
- `action` is required: `manage_skills.action: expected one of: create, update, remove`. Any other value: `Unknown skill action '<a>'. Expected one of: create, update, remove.`
- **Allowed keys:**
  - create: `action, description, instructions, name`;
  - update: `action, description, id, instructions, name`;
  - remove: `action, id`.
- **Text fields** are trimmed and must be non-empty strings within the limits (name 120, description 500, instructions 50,000). Name and description must be single lines.
  - `manage_skills.<key>: expected string`
  - `…: expected non-empty string`
  - `…: maximum length is <n> characters`
  - `…: expected one line`
- **create**
  - Requires name, description, and instructions.
  - The ID is `suggestedID(name)`.
  - If that ID exists with identical content, the receipt is `unchanged`. If it exists with different content: `A skill with id '<id>' already exists. Use manage_skills with action='update'.`
  - Otherwise `~/.palmier/skills/<id>/SKILL.md` is written with frontmatter. Receipt status `created`.
  - On failure: `Could not create skill '<name>'.`
- **update**
  - Requires `id` (`manage_skills.id: expected non-empty string for update`) and at least one field: `manage_skills update requires at least one of: name, description, instructions.`
  - Unknown ID: `Unknown skill: <id>`.
  - Frontmatter fields are patched in place. `instructions` replaces the whole body.
  - The receipt lists `changed` fields, or reports `unchanged`. On failure: `Could not update skill '<id>'.`
- **remove**
  - The skill folder is deleted, and the ID is added to the ledger's `suppressed` list so the catalog does not reinstall it.
  - Returns `{status:"removed", id, name}`. On failure: `Could not remove skill '<id>'.`
- **Receipt:** `{status:"created"|"updated"|"unchanged", skill:{id, name, description}, changed?:[…]}`.

