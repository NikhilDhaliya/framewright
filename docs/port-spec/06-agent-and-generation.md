# 06 — In-app Agent and AI Generation

Status: port contract for the Linux (Electron 44 + TypeScript + React) build of Palmier Pro.
Source of truth: `palmier-pro/Sources/PalmierPro` v0.7.6: `Agent/Chat`, `Agent/Clients`, `Agent/Panel`, `Agent/Skills`, `Agent/Tools/{AgentInstructions,ToolExecutor,ToolExecutor+AgentActivity,ToolResult}.swift`, `Generation/**`, plus the generation glue that lives outside those folders (`Editor/ViewModel/EditorViewModel+{AIEdit,AITransition,GeneratedClips,ClipMutations,MediaLibrary}.swift`, `Inspector/Tabs/AIEditTab.swift`, `Timeline/TimelineView+AIEditMenu.swift`, `MediaPanel/**` agent hand-offs, `Models/MediaAsset.swift`, `Models/MediaManifest.swift`, `Editor/ProjectActivityView.swift`, `App/AppNotifications.swift`, `Project/VideoProject.swift`).
Citations are `path:line` relative to `Sources/PalmierPro/`.

This spec covers what the sibling specs do not:

| Already specified elsewhere (do not re-implement from here) | Where |
|---|---|
| Every tool's name, description, schema, validation, result shape, errors; MCP transport; short IDs; mutation delta; MCP `initialize.instructions` verbatim; skills storage/catalog/ledger; `read_skill` / `manage_skills` contracts | `02-mcp-tools.md` (§1–§7, Appendix A) and `02-mcp-tools.tools.json` |
| `chat/<UUID>.json` schema, `media.json` `generationInput` / `generationStatus` schema, media install rules (`commitStagedProjectMedia`), load/resume rules | `01-data-model.md` §1.6, §1.7, §1.9, §5.14, §5.15 |
| Undo engine, `EditorUndo.perform`, `placeClip`, track creation, swap/replace media | `03-editor-ops.md` §2, §4, §10 |
| Timeline span render used by video-to-audio scoring | `04-rendering-export.md` §11.6 |
| Visual styling of the agent column, Generate panel, AI Edit tab, generating overlays, Settings ▸ Models & API Keys, Settings ▸ Skills, context menus, agent-activity glows | `05-ui.md` §1, §2.6, §3.7, §4.5, §4.13, §4.14, §5.3, §6.5, §6.14, §7.5.6, §11.5, §11.7 |

Assembled 2026-10-13 from the round-1 drafts. Verification done at assembly: `serverInstructions` re-derived from the Swift literal (byte-identical); ~35 `file:line` citations spot-checked against the source (four wrong ranges corrected); Gemini deprecation dates, Anthropic and OpenAI model ids re-checked on the web; the fal OpenAPI schemas of `minimax/h3/text-to-video`, `bytedance/seedance-2.0/reference-to-video`, `fal-ai/veo3.1/fast/first-last-frame-to-video` and `blackforestlabs/flux-3/draft-enhance` re-fetched (field names match §B12.4 and §B9.6). The video provider research behind §B12.4.1 is in [`research/byok-video-apis.md`](research/byok-video-apis.md); the machine-readable catalog is [`06-generation-catalog.json`](06-generation-catalog.json). Transcription, captions, search and audio analysis are in `07-media-intelligence-and-extras.md`.

Legend used throughout:

- **[LOCAL]** works with no account and no key.
- **[BYOK]** works with the user's own provider API key (keys live in the main-process settings store, `src/main/settings.ts`, `AppSettings.apiKeys`).
- **[CLOUD]** needs a Palmier account / Palmier's backend (Convex + Clerk). **Cannot be replicated** on Linux. Each such item states the Linux replacement or says to drop it.

---

## 0. Architecture summary and Linux placement

```
 Renderer (React)                         Main process (Node)
 ───────────────────────────────          ─────────────────────────────────────────────
 AgentPanel  ── ipc agent.* ──────────▶   AgentService (sessions, run loop, routing)
   ▲  state snapshots (≤ 20 Hz)            ├─ providers/anthropic.ts  (Messages API SSE)
   └──────────────── agent.onState ◀────── ├─ providers/openai.ts     (Responses API SSE)
                                           ├─ StreamPresentationBuffer (50 ms coalescing)
                                           ├─ MentionContext (hint text, inline images)
                                           └─ ToolExecutor (same class the MCP server uses,
                                              in "in-app" mode; src/main/mcp/tools/executor.ts)
 GeneratePanel ── ipc generation.* ─────▶  GenerationService (placeholders, jobs, resume)
                                           ├─ Catalog (local JSON, §B2)
                                           ├─ Provider adapters (fal, Replicate, OpenAI,
                                           │  Google, ElevenLabs, … §B12)
                                           └─ media install (01 §1.7) + manifest updates
```

Rules for the port:

1. API keys never leave the main process. The renderer only sees masked keys (`settings.get()` already masks them).
2. The agent loop, both SSE parsers, tool execution, and all generation network I/O run in the main process. The renderer is a view: it renders snapshots and sends intents.
3. **BYOK only.** There is no hosted Palmier route (`PalmierClient`, `Agent/Clients/PalmierClient.swift`) and no Convex backend. Everything in this spec that depends on Clerk sign-in, credits, plans or Convex is [CLOUD] and is replaced as stated.

Proposed IPC surface (add to `PalmierApi` in `src/shared/api.ts`; names are a proposal, behaviour is the contract):

```ts
agent: {
  getState(): Promise<AgentPanelState>
  onState(cb: (s: AgentPanelState) => void): Unsubscribe   // coalesced, see §A9
  send(text: string, mentions: AgentMention[]): void
  cancel(): void
  newChat(seedDraft?: string): void                        // seedDraft = hand-offs, §A14
  selectSession(id: string): void
  closeTab(id: string): void
  deleteSession(id: string): void
  setModel(model: AgentModelId): void
  setEffort(effort: AgentReasoningEffort): void
  setDraft(draft: string, mentions: AgentMention[]): void
  attachAssetMention(assetId: string): void                // §A12
  attachClipMentions(clipIds: string[]): void
  attachRangeMention(): void
}
generation: {
  catalog(): Promise<CatalogState>                          // §B2
  submit(req: GenerationPanelSubmit): Promise<{ placeholderId: string } | { error: string }>
  seedPanel(seed: PanelSeed): void                          // §B9
  onPanelSeed(cb: (seed: PanelSeed) => void): Unsubscribe
  retryDownload(assetId: string): void
  activity(): Promise<ActivityEntry[]>                      // §B11
}
```

---

# Part A — The in-app AI agent

## A1. Models, providers, reasoning effort, routing

### A1.1 Model table (`Agent/Clients/AgentClientTypes.swift:72-119`)

| `AgentModel` raw value (persisted) | Display name | Provider | Max output tokens | Mac "paid hosted plan" flag |
|---|---|---|---|---|
| `claude-sonnet-5` | Sonnet 5 | anthropic | 64000 | no |
| `claude-opus-5` | Opus 5 | anthropic | 64000 | no |
| `claude-fable-5` | Fable 5 | anthropic | 64000 | **yes** (ignored on Linux) |
| `gpt-5.6-luna` | GPT-5.6 Luna | openAI | 64000 | no |
| `gpt-5.6-terra` | GPT-5.6 Terra | openAI | 64000 | no |
| `gpt-5.6-sol` | GPT-5.6 Sol | openAI | 64000 | **yes** (ignored on Linux) |

- Order in every picker is the table order (`AgentModel.allCases`).
- Default model: `gpt-5.6-terra` (`AgentClientTypes.swift:80`).
- Persisted preference key `agentModel` (app-level, not in the project). On read, the legacy value `claude-opus-4-8` maps to `claude-opus-5`; any other unknown value falls back to the default (`AgentClientTypes.swift:106-108`, `AgentService.swift:15-17`).
- The raw value is also written into project files, inside `openAIReasoning` content blocks (`model` field, `01` §5.15). **Do not add new model ids for OpenAI** unless you accept that the Mac will drop any chat session containing a reasoning block from that model (an unknown `AgentModel` makes the whole session file undecodable on the Mac). Adding Anthropic models is file-safe (Anthropic thinking blocks do not record the model), but keep the six for parity. If you do add Claude Opus 5.5, Sonnet 5.5 or Fable 5.1: those models enforce "preserved thinking" (edits to earlier turns invalidate thinking blocks; accounts created on/after 2026-08-31 get a 400), and two Palmier paths edit history — the orphan repair that inserts synthetic results into an existing user message (§A3.6) and the per-send re-derivation of mention context (§A5). Make both append-only first.
- All six ids are live provider ids as of 2026-10-13: `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5` (Anthropic model table cached 2026-09-25; newer `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1` exist and are the ones that enforce preserved thinking, see above) and `gpt-5.6-luna|terra|sol` (OpenAI GPT-5.6 tiers, API GA 2026-07-09; [LiteLLM day-0 notes](https://docs.litellm.ai/blog/gpt_5_6), re-checked by web search 2026-10-13).

### A1.2 Reasoning effort (`AgentClientTypes.swift:50-70,110-142`)

| Raw value | Label | Anthropic models | OpenAI models |
|---|---|---|---|
| `none` | None | – | ✓ |
| `minimal` | Minimal | – | ✓ |
| `low` | Low | ✓ | ✓ |
| `medium` | Medium | ✓ | ✓ |
| `high` | High | ✓ | ✓ |
| `xhigh` | X High | ✓ | ✓ |
| `max` | Max | ✓ | ✓ |

- Stored per model under `agentReasoning.effort.<modelRawValue>`; default `medium`; a stored value the model does not support reads back as `medium` (`AgentClientTypes.swift:127-133`).
- Setting an unsupported effort is ignored (`AgentService.swift:71-78`).
- The effort is snapshotted at send time together with the model (`AgentRunSettings`, `AgentService.swift:80-82`); changing either mid-run affects only the next send.

Linux settings additions (proposal, `AppSettings`): `agentModel: AgentModelId`, `agentReasoningEffort: Partial<Record<AgentModelId, AgentReasoningEffort>>`.

### A1.3 Routing (`AgentClientTypes.swift:144-161`, `AgentService.swift:46-105`)

Mac rule: `direct` if the selected model's provider has a key; else `unavailable` for paid-only models without a paid plan; else `hosted` if signed in with credits; else `unavailable`.

**Linux rule [BYOK]:** `route = key(provider) non-empty ? 'direct' : 'unavailable'`. There is no hosted route.

- Keys are re-read from the settings store at the start of every run (`selectClient`, `AgentService.swift:84-105`), so a key added mid-session is used by the next send without restarting.
- `canStream = route !== 'unavailable'`.
- `canSelectModel` (Mac: paid-plan gate) → **Linux: every model is always selectable.**
- When `model` changes: if the new route is unavailable, set `streamError = unavailable(model)`; else if the current error is `unavailable`, clear it (`AgentService.swift:107-116`).
- `activeBYOKProvider = route === 'direct' ? provider : null` drives the key indicator (§A11.6). On Linux it is non-null whenever streaming is possible.
- Env override (Mac DEBUG builds only): `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` take precedence over the keychain (`AgentClientTypes.swift:25-32`). Optional on Linux (useful for dev); never in production builds.

---

## A2. Chat sessions: model, lifecycle and persistence

### A2.1 In-memory model (`Agent/Chat/ChatSessionStore.swift:3-28`, `AgentService.swift:723-826`)

```ts
interface ChatSession { id: string /*UUID upper*/; title: string; updatedAt: Date; messages: AgentMessage[]; isOpen: boolean }
interface AgentMessage { id: string; role: 'user'|'assistant'|'system'; blocks: AgentContentBlock[]; mentions: AgentMention[]; contextHint?: string }
type AgentContentBlock =
  | { kind: 'thinking'; text: string; signature: string }          // Anthropic thinking (summary text)
  | { kind: 'redactedThinking'; data: string }                     // Anthropic redacted_thinking
  | { kind: 'openAIReasoning'; summary: string; encryptedContent: string; itemID?: string; model: AgentModelId }
  | { kind: 'text'; text: string }
  | { kind: 'toolUse'; id: string; name: string; input: string /* JSON text */ }
  | { kind: 'toolResult'; toolUseId: string; content: ToolResultBlock[]; isError: boolean }
type ToolResultBlock = { kind: 'text'; text: string } | { kind: 'image'; base64: string; mediaType: string }
```

The on-disk shape is exactly `01` §5.15. Additional facts the port needs:

- `contextHint` is omitted when absent; `itemID` is omitted when absent. `mentions` is always written (may be `[]`).
- Tool-result blocks live in a **`user`** message that follows the assistant message holding the `toolUse` blocks. Synthetic "Cancelled" results also live there (§A3.6).
- `system` messages are UI notices (never sent to the model). The only producer is `postSystemNotice` (`AgentService.swift:380-384`), called with `Now editing: <project name>` when MCP `manage_project open|create` binds a project (`Agent/Tools/ToolExecutor+Projects.swift:78,97,213-216`). They are persisted.
- `updatedAt` is written as ISO-8601 **without fractional seconds** (`new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')`).

### A2.2 Lifecycle operations

| Operation | Behaviour (Mac) | Source |
|---|---|---|
| **Load** (project window opens) | Read `chat/*.json` (undecodable files skipped silently) → drop sessions with no messages → set `isOpen = false` on every loaded session → sort by `updatedAt` desc → insert a fresh empty session (`title "New chat"`, `isOpen true`) at index 0 and make it current. Clear draft, mentions, error, and the executor's feedback state. | `AgentService.swift:261-279`, `VideoProject.swift:441-444` |
| **New chat** (+ button, hand-offs) | Cancel the running task. Sync current messages into its session. If the current session is empty, remove it. Insert a fresh session at index 0, make it current, clear messages and error, reset feedback state, mark document dirty. The draft is **not** cleared. | `AgentService.swift:281-296` |
| **Select** (tab click, history row) | Cancel the running task. Sync current. Mark the target `isOpen = true` (dirty if it changed). Make it current; show its messages; clear error. | `:300-311` |
| **Close tab** (× on a tab) | Set `isOpen = false`. If it was current: switch to the first open session, or create a new chat if none is open. Mark dirty. Does **not** cancel a running task (see quirk Q-A1). | `:313-326` |
| **Delete** (history trash) | Remove the session. If it was current, switch to the first open session (or `[]`). If no session is open, create a new chat. Mark dirty. Not offered for the current session in the UI. | `:328-338` |
| **Sync** | Copy `messages` into the current session, set `updatedAt = now`, and if the title is still `New chat` set it to the first non-empty user text block, trimmed, first 40 characters (grapheme clusters). | `:648-657`, `:712-720` |
| **Mark dirty** | `onSessionsChanged` → `updateChangeCount(.changeDone)` → the normal autosave path writes the package. | `VideoProject.swift:442-444` |

Persistence on save (`VideoProject.swift:269-280,317,334-342`): `chat/` is deleted and recreated; every session with ≥1 message (open, closed and history alike) is written as `chat/<UPPER-UUID>.json`. See `01` §1.6 for the "copy through verbatim if chat is not implemented" rule; with this spec implemented, the Linux writer replaces that rule.

Ordering facts for the UI: `sessions` is ordered newest-first by insertion (new chats go to index 0; loaded ones are sorted by `updatedAt` desc). The tab strip shows `sessions.filter(isOpen)` in that order; the history popover shows all sessions sorted by `updatedAt` desc.

**Q-A1 (Mac bug, fix on Linux).** The Mac keeps one global `messages` array for the *current* session. Closing or deleting the active tab while a run is streaming does not cancel the run; the loop then keeps running against the newly selected session's array. Linux: bind each run to its session id and mutate `sessions[id].messages` directly; the UI renders `sessions[currentId].messages`. Observable behaviour is otherwise identical.

---

## A3. Send pipeline and the run loop

### A3.1 `send(text, mentions)` (`AgentService.swift:340-378`)

1. If `!canStream`: `streamError = unavailable(model)`; return.
2. `trimmed = text.trim()` (whitespace and newlines); return if empty.
3. `referencedMentions = mentions.filter(m => trimmed.includes('@' + m.displayName))` (`AgentMentionContext.swift:10-12`).
4. `contextHint = referencedMentions.length ? hint(referencedMentions) : undefined` (frozen now so the cached prompt prefix stays byte-stable; §A5.2).
5. Snapshot `{model, reasoningEffort}`.
6. `resolveOrphanToolUses()` (§A3.6).
7. Append `{role:'user', blocks:[{kind:'text', text: trimmed}], mentions: referencedMentions, contextHint}`.
8. Clear `streamError`; `kickOffStream(conversationId = currentSessionId, traceId = uuid())`.

The panel's submit handler then clears the draft and the draft mentions (`AgentPanelView.swift:511-516`).

### A3.2 `kickOffStream` (`AgentService.swift:392-411`)

Cancel any running task; `isStreaming = true`; start the task. On completion (normal, error or cancel): `isStreaming = false`, sync messages into the current session, mark dirty.

### A3.3 `runLoop` (`AgentService.swift:413-494`)

```
client = selectClient(settings)            // §A1.3; null → streamError = unavailable(model); return
await skills.waitForSkillSync()            // §A13; returns immediately if no sync is running
await skills.reloadSkills()                // rescan ~/.palmier/skills once per run
tools = ToolDefinitions.inAppAgent         // computed once per run (§A8.1)
loop while !cancelled:
    resolveOrphanToolUses()
    apiMsgs = apiMessages()                // §A5
    inputMessageID = last user message id  // none → streamError = upstream("The agent request has no user message.")
    append empty assistant message A
    system = AgentInstructions.serverInstructions + skillsSection(skillIndex)   // §A4; recomputed every iteration
    final = presentAgentStream(client.stream(system, tools, apiMsgs), onSnapshot → A.blocks = snapshot.blocks)
    dropEmptyAssistantTurn(A)              // §A3.5
    if final.stopReason == refusal: streamError = refusal(model); break
    if final.stopReason == toolUse: runPendingToolUses(A); if cancelled break; continue
    break                                   // end_turn, max_tokens, stop_sequence, pause_turn, other
on CancellationError: dropEmptyAssistantTurn(A); break (no error shown)
on AgentServiceError e: drop…; streamError = e; break
on any other error: drop…; streamError = upstream(error.message); break
```

- There is **no iteration cap** and no token budget on the loop. The loop ends only on a non-tool stop reason, an error, or cancel.
- `pause_turn` and `max_tokens` simply end the turn (no continuation). With no server tools `pause_turn` does not occur in practice.
- Snapshots are applied to the session identified by `conversationId` even when the user has switched sessions (`applyStreamSnapshot`, `AgentService.swift:507-524`; non-current sessions also get `updatedAt = now`).

### A3.4 Tool execution step (`AgentService.swift:557-601`)

1. Collect the assistant message's `toolUse` blocks in order.
2. Skip any whose id already has a result in the next non-system message (if that message is a user message).
3. Execute **sequentially**, in block order: `executor.execute(name, args = JSON.parse(input) ?? {}, sessionID = conversationId)` (§A8).
   - If the run was cancelled before a call starts, that call (and every later one) gets `{toolResult, content:[{text:"Cancelled"}], isError:true}` without running. A call already running is not interrupted.
4. Append **one** user message holding all results in the same order.
5. If no executor exists (no editor), append a user message with the text `Tool executor unavailable.` (Mac quirk; this is a plain text block, not tool results; the next iteration's orphan pass then adds "Cancelled" results).

### A3.5 Dropping incomplete blocks (`AgentService.swift:500-555`)

After every stream (success, error or cancel) remove from the assistant message every block that is not "complete": thinking without signature, redacted thinking with empty data, OpenAI reasoning with empty `encryptedContent`, empty text. `toolUse`/`toolResult` are always complete. If nothing remains, remove the assistant message. Partial **text** survives a cancel.

### A3.6 Orphan tool uses (`AgentService.swift:603-640`)

Before each send and each loop iteration, for every assistant message with `toolUse` blocks: find the next non-system message. If it is a user message containing tool results, the resolved set is its result ids; otherwise empty. For each unresolved id, create `{kind:'toolResult', toolUseId, content:[{kind:'text', text:'Cancelled'}], isError:true}`; insert them at the start of that user message, or insert a new user message holding them right after the assistant message. This keeps the transcript valid for both APIs after a cancel.

### A3.7 Cancellation

- Stop button → `cancel()`: cancel the task, `isStreaming = false` immediately (`AgentService.swift:386-390`).
- New chat and select-session also cancel (Q-A1 for close/delete).
- On Linux use one `AbortController` per run; abort the fetch, stop the SSE reader, and let the loop see `cancelled`. An aborted fetch must surface as cancellation (no error banner), matching `CancellationError`.

### A3.8 Undo grouping

There is no turn-level undo group. Each mutating tool call is its own undo step, named by the tool (`02` §1.10; several end in ` (Agent)`), on the same stack as the user's own edits. A five-edit agent turn therefore needs five Ctrl+Z presses. The `undo` tool pops the latest step whatever its origin. Generation placeholders are not undo steps; timeline placements of generating clips are (§B6).

Every mutation made while executing an agent or MCP tool runs with origin `agent`/`mcp`; such mutations do not bump `nonAgentTimelineMutationRevision` (`Editor/ViewModel/EditorViewModel.swift:35-41`), which is how the change-highlight step knows the user did not interleave an edit (`ToolExecutor.swift:181-193`). Linux: thread an `origin` through the executor into the editor-op layer.

---

## A4. System prompt (verbatim) and context assembly

### A4.1 The system prompt

```
system = AgentInstructions.serverInstructions + AgentInstructions.skillsSection(SkillStore.skillIndex)
```
(`AgentService.swift:444`, `Agent/Tools/AgentInstructions.swift:4-202,223-232`)

- `serverInstructions` is **byte-identical** to the `serverInstructions` string in `02-mcp-tools.tools.json` (re-verified 2026-10-13 by evaluating the Swift multi-line literal at `AgentInstructions.swift:4-203`: same 13 568 characters, no interpolation) (13 568 characters; it is also the first part of the text block in `02` §4.1, up to and including `…instead of   guessing.` — note the three spaces). It has **no trailing newline**. The in-app agent never gets `projectNavigation` (the `# Projects (MCP)` section).
- `skillsSection(index)` is the empty string when no skill is installed. Otherwise it is exactly:

```text
\n# Skills\nPlaybooks for specific tasks. Before a task that matches one, call read_skill(id) to load its full procedure, then follow it.\n<index>
```
  where `\n` is a newline and `<index>` is one line per installed skill, sorted by skill id (folder name), joined with `\n`, no trailing newline:
```text
- <id>: <description>
```
  (`Agent/Skills/SkillStore.swift:384-386`.) So the prompt reads `…guessing.` newline `# Skills` newline `Playbooks…` newline `- caption-templates: …`.

- The skill index is re-read every loop iteration (the store is reloaded once at run start; `manage_skills` can change it mid-run, which changes the system prompt and costs one cache miss).

Linux note (product decision, not parity): the instructions mention Palmier sign-in in two places (`# Session`: "ask the user to sign in to Palmier and subscribe first"; tool errors). Keep the text byte-identical for parity; §B13 changes only the tool error strings and the meaning of `canGenerate`.

### A4.2 What else reaches the model

Nothing else is injected: no project summary, no timeline dump, no date, no OS info. The model learns state only through tools and through the per-message mention context (§A5). Telemetry headers (`X-Palmier-Conversation-Id`, `-Trace-Id`, `-Span-Id`, `-Input-Message-Id`, `-Output-Message-Id`, `-Project-Id`, `-Agent-Telemetry`; `AgentClientTypes.swift:209-228`) are sent **only** on the hosted route [CLOUD]; BYOK requests carry none of them. Drop them on Linux.

---

## A5. Transcript → API messages

### A5.1 `apiMessages()` (`AgentService.swift:659-675`)

For each stored message in order:

1. Skip `system` messages.
2. `content = message.blocks` (as `AgentRequestBlock.content`).
3. If role is `user` and `mentions` is non-empty:
   - `inlined = inlineImageBlocks(mentions)` (§A5.3).
   - `hint = message.contextHint ?? hint(message.mentions)`; if `inlineNote(inlined)` is non-null, `hint += ' ' + note`.
   - Final content = `[ {text: hint}, ...inlined.images, ...message.blocks ]`.
4. Skip messages whose content is empty.
5. Role: `user` stays `user`; everything else becomes `assistant`.

The provider adapters (§A6, §A7) then drop blocks that the target API cannot take.

### A5.2 Mention hint text (verbatim; `AgentMentionContext.swift:16-99`)

```
Referenced assets and timeline context in this message: <JSON>.<NOTES>
```
- `<JSON>` is a compact JSON array with **sorted keys** (one entry per mention, mention order):
  - Timeline range: `{"kind":"timelineRange","mention":"@<name>","timelineRange":{"durationFrames":N,"durationTimecode":"HH:MM:SS:FF","endFrame":N,"endTimecode":"…","fps":N,"rangeSemantics":"startInclusiveEndExclusive","startFrame":N,"startTimecode":"…"}}`
  - Media asset: `{"kind":"mediaAsset","mediaRef":"<FULL asset id>","mention":"@<name>","type":"video|audio|image|…"}`
  - Timeline clip: `{"clip":{…},"clipId":"<full id>","kind":"timelineClip","mediaRef":"<id>","mention":"@<name>","type":"<mediaType>"}` where `clip` is `{"clipId","durationFrames","endFrame","label","mediaRef","mediaType","sourceClipType","speed","startFrame","trackIndex","trackType","trimEndFrame","trimStartFrame"}` read live from the editor at hint time, or `{"clipId":…,"error":"clip not found"}` / `{"clipId":…,"error":"editor unavailable"}`.
  - IDs in the hint are **full** UUIDs (not short IDs). The executor accepts both.
- `<NOTES>` is empty, or a space followed by these sentences joined with a single space, in this order:
  - when any entry has a clip: `Entries with "clipId" refer to timeline clips; use clipId for timeline edits and pass it to inspect_media when inspecting visible source media.`
  - when any entry has a range: `Entries with "timelineRange" refer to selected timeline time spans; their frame ranges are half-open: startFrame inclusive, endFrame exclusive.`
- Inline note (appended after a space by `apiMessages`, never stored):
  - `These mentioned images are attached inline as image blocks — do not call inspect_media for them: <ids sorted, ", ">.`
  - `These images could not be attached; tell the user the image could not be read rather than describing it: <"id (reason)" sorted by id, ", ">.`
  - both sentences joined by one space when both apply. Reasons: `asset not in media library`, `could not read or decode image file`, `editor unavailable`.

### A5.3 Inline images (`AgentService.swift:677-710`, `Utilities/ImageEncoder.swift`)

Only mentions whose `type == "image"` and that have a `mediaRef`. Each is encoded:

1. **Pass-through** when the real container type (sniffed, not the extension) is PNG, JPEG, GIF or WebP, the file is ≤ 3 500 000 bytes, and the longest edge is ≤ 1568 px: send the original bytes with that MIME.
2. Otherwise decode, apply EXIF orientation, downscale to longest edge 1568, encode JPEG at quality 0.85, then 0.7, 0.55, 0.4; use the first result ≤ 3 500 000 bytes; if none fits → failure.
3. Memoize by `(path, size, mtime)`; at most 32 entries (clear all when full). `apiMessages` runs on every loop iteration, so the cache matters.

Linux: use `sharp` (or ffmpeg for HEIC) in the main process; keep the thresholds identical. Re-encoding nondeterminism would break prompt caching, so the cache must return the same bytes for an unchanged file.

---

## A6. Anthropic provider (Messages API) [BYOK]

Sources: `Agent/Clients/BYOKClient.swift`, `AnthropicProvider.swift`, `AgentClientTypes.swift:285-302`.

### A6.1 Request

- `POST https://api.anthropic.com/v1/messages`
- Headers: `content-type: application/json`, `accept: text/event-stream`, `x-api-key: <key>`, `anthropic-version: 2023-06-01`. No `anthropic-beta`.
- Body (serialized with **sorted keys**, compact; reproduce a deterministic order on Linux so the cached prefix stays byte-stable):

```json
{
  "max_tokens": 64000,
  "messages": [ … ],
  "model": "claude-sonnet-5",
  "output_config": { "effort": "medium" },
  "stream": true,
  "system": [ { "cache_control": { "type": "ephemeral" }, "text": "<system prompt §A4>", "type": "text" } ],
  "thinking": { "display": "summarized", "type": "adaptive" },
  "tools": [
    { "description": "…", "input_schema": { … }, "name": "get_timeline" },
    …,
    { "cache_control": { "type": "ephemeral" }, "description": "…", "input_schema": { … }, "name": "manage_skills" }
  ]
}
```

- `tools` is omitted when empty. Tool entries are `{name, description, input_schema}` built from `02-mcp-tools.tools.json` (`tools` minus `manage_project`, plus `inAppOnlyTools`), in the order of §A8.1.
- **Prompt caching — three breakpoints:** last tool, the system block, and the **last content block of the last message**. (API maximum is 4.)
- Effort goes in `output_config.effort` (GA). Valid on all three models: `low`…`max`.
- `thinking: {type:"adaptive", display:"summarized"}` makes thinking blocks stream readable summary text (the API default display on these models is `omitted`, i.e. empty text). Fable 5 always thinks; it rejects `{type:"disabled"}` but accepts `adaptive`. No `temperature`/`top_p` are sent (they 400 on these models).

### A6.2 Content block conversion

| Stored block | Sent as |
|---|---|
| `image` (inline mention image) | `{"type":"image","source":{"type":"base64","media_type":M,"data":B}}` |
| `thinking` | `{"type":"thinking","thinking":text,"signature":sig}` — **only if `signature` non-empty**, else dropped |
| `redactedThinking` | `{"type":"redacted_thinking","data":d}` if `d` non-empty |
| `openAIReasoning` | dropped |
| `text` | `{"type":"text","text":t}` if non-empty |
| `toolUse` | `{"type":"tool_use","id":id,"name":name,"input":<JSON.parse(input) as object, else {}>}` |
| `toolResult` | `{"type":"tool_result","tool_use_id":id,"content":[text→{"type":"text","text"} / image→image block],"is_error":bool}` (`is_error` always present) |

Messages whose converted content is empty are omitted. Thinking blocks are replayed whatever model produced them; Anthropic silently drops blocks produced by a different model (no error, unbilled), so switching between Sonnet/Opus/Fable inside one chat is safe.

### A6.3 SSE parsing (`AnthropicProvider.swift:16-93`)

Read the body line by line. Use only lines starting with `data:`; strip the prefix and whitespace; parse JSON; ignore unparsable lines silently. Dispatch on `type`:

| Event | Action |
|---|---|
| `message_start` | (debug only) log `message.usage` cache stats |
| `content_block_start` | `tool_use` → remember `{index → id, name, json:""}`; `redacted_thinking` → emit `redactedThinking(data)` |
| `content_block_delta` `text_delta` | emit `textDelta(text)` if non-empty |
| `content_block_delta` `thinking_delta` | emit `thinkingDelta(thinking)` if non-empty |
| `content_block_delta` `signature_delta` | emit `thinkingSignature(signature)` if non-empty |
| `content_block_delta` `input_json_delta` | append `partial_json` to the pending tool at `index` |
| `content_block_stop` | if a pending tool exists at `index`: emit `toolUseComplete(id, name, json \|\| "{}")` |
| `message_delta` | if `delta.stop_reason` present: emit `messageStop(reason)`; unknown values map to `other` |
| `error` | throw `Anthropic stream error: <error.message>` |
| anything else (`ping`, `message_stop`) | ignore |

Stop reasons understood: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`. A stream that ends without `message_delta` yields `end_turn` (reducer default). No terminal-event check for Anthropic.

### A6.4 HTTP errors

Status ≥ 400: read the whole body, throw `Anthropic API error (<status>): <first 500 chars of body>` (`AgentClientTypes.swift:241-256,295-301`). It reaches the user as an `upstream` error banner (§A10). The request's idle timeout is **600 s** (`URLRequest.timeoutInterval`, i.e. maximum silence between bytes); on Linux arm a 600 s inactivity timer reset on every chunk and surface `The request timed out.`

---

## A7. OpenAI provider (Responses API) [BYOK]

Sources: `Agent/Clients/BYOKClient.swift`, `OpenAIProvider.swift`.

### A7.1 Request

- `POST https://api.openai.com/v1/responses`
- Headers: `content-type: application/json`, `accept: text/event-stream`, `Authorization: Bearer <key>`.
- Body (sorted keys):

```json
{
  "input": [ … ],
  "instructions": "<system prompt §A4>",
  "max_output_tokens": 64000,
  "model": "gpt-5.6-terra",
  "reasoning": { "effort": "medium", "summary": "auto" },
  "store": false,
  "stream": true,
  "tools": [ { "description": "…", "name": "get_timeline", "parameters": { … }, "strict": false, "type": "function" }, … ]
}
```

- No `include`. With `store:false` the API returns `encrypted_content` on reasoning items automatically (OpenAI reasoning guide; the legacy `include:["reasoning.encrypted_content"]` is accepted but not required). No `previous_response_id`: the full transcript is re-sent every iteration.
- No explicit caching (OpenAI caches prefixes automatically).

### A7.2 Input item conversion (`OpenAIProvider.swift:36-129`)

Walk each message's blocks, buffering consecutive text/image blocks into one `message` item:

| Block | Item |
|---|---|
| `image` | buffered `{"type":"input_image","image_url":"data:<M>;base64,<B>"}` |
| `text` (user) | buffered `{"type":"input_text","text":t}` |
| `text` (assistant) | buffered `{"type":"output_text","text":t,"annotations":[]}` |
| `thinking`, `redactedThinking` | dropped |
| `openAIReasoning` | only if `block.model === current model` and `encryptedContent` non-empty: flush, then `{"type":"reasoning","encrypted_content":E,"summary":[{"type":"summary_text","text":S}] or [] when S empty, "id":itemID (only if non-empty)}` |
| `toolUse` | flush, then `{"type":"function_call","call_id":id,"name":name,"arguments":<input re-serialized compact with sorted keys, or "{}" if unparsable>}` |
| `toolResult` | flush, then `{"type":"function_call_output","call_id":id,"output":[ (isError ? {"type":"input_text","text":"Tool error"} : nothing), …text→input_text / image→input_image ]}` |

A flushed buffer becomes `{"type":"message","role":"user"|"assistant","content":[…]}`. Empty text is skipped.

### A7.3 SSE parsing (`OpenAIProvider.swift:132-277`)

Lines starting with `data:`; strip; ignore `[DONE]`. A payload that is not a JSON object throws `OpenAI stream error: Invalid event payload.`; a JSON syntax error also fails the run.

| `type` | Action |
|---|---|
| `response.output_text.delta` | `textDelta(delta)` if non-empty |
| `response.reasoning_summary_text.delta` | `reasoningSummaryDelta(delta)` |
| `response.refusal.delta` | `textDelta(delta)` (refusal text shows as normal text) |
| `response.output_item.done` | item `function_call` with non-empty `call_id` and `name` → `toolUseComplete(call_id, name, arguments \|\| "{}")`; item `reasoning` with non-empty `encrypted_content` → `reasoningComplete(item.id, summary = join of summary[].text, encrypted)` |
| `response.completed` / `response.incomplete` / `response.failed` / `response.cancelled` | terminal (below) |
| `error` | throw `OpenAI stream error: <error.message ?? message ?? "Unknown stream error.">` |

Terminal handling: `failed` (event or `response.status`) → throw `OpenAI stream error: <response.error.message ?? "The response failed.">`; `cancelled` → cancellation (silent); `incomplete` → `messageStop(incomplete_details.reason == "max_output_tokens" ? max_tokens : other)`; `completed` → `messageStop(tool_use` if any output item is a `function_call`, `refusal` if any output message content item has type `refusal`, else `end_turn)`. If the byte stream ends without any terminal event → throw `OpenAI stream error: The stream ended before a terminal event.`

HTTP errors and timeout: as §A6.4 with `OpenAI API error (<status>): …`.

---

## A8. Tools: exposure and execution

### A8.1 Tool list sent to the model

`ToolDefinitions.inAppAgent = ToolDefinitions.all + [read_skill, manage_skills]` (`Agent/Tools/ToolDefinitions.swift:1255-1256`): the 49 tools of `02` §3.1–§3.49 in `tools/list` order, then `read_skill`, then `manage_skills`. **`manage_project` is not offered.** Descriptions and schemas are the verbatim ones in `02-mcp-tools.tools.json`. The same JSON schema object is used for Anthropic `input_schema` and OpenAI `parameters` (`strict:false`).

### A8.2 Same executor as MCP, in "in-app" mode

The in-app agent and the MCP server share `ToolExecutor` (`Agent/Tools/ToolExecutor.swift`). The in-app instance is created per editor window (`AgentService.editor didSet`, `AgentService.swift:255-257`) with `init(editor:)`. Differences from an MCP session (`02` §1.6):

| Aspect | MCP session | In-app agent |
|---|---|---|
| Origin `source` | `mcp` | `agent` (default of `execute`, `ToolExecutor.swift:76-86`) |
| Analytics session id | per MCP session | the chat session UUID |
| Accepted tool names | the 50 MCP tools; others → `Unknown tool: <name>` | **any** `ToolName`, including `read_skill`, `manage_skills` and (unadvertised) `manage_project` (`ToolExecutor.swift:99-112`) |
| Bound project | `boundProject`, rebinds via `manage_project` | always the editor of the window that owns the panel |
| Project-focus guard | yes | **no** (`projectFocusError` returns nil without a frontmost provider, `:244-252`) — the agent edits its own window's project even when another window is frontmost |
| Blank-argument dropping, ID prefix expansion, ID shortening of results, read highlights, change highlights, feedback state | same | same |

Linux: reuse `src/main/mcp/tools/executor.ts` with a mode flag `{ source: 'agent', projectId, guard: false, extraTools: ['read_skill','manage_skills'] }`. Tool calls from the in-app agent and from MCP clients must be serialized per project (one promise queue), mirroring the Mac main-actor serialization.

### A8.3 Result mapping

`ToolResult {content: (text | image)[], isError}` is stored verbatim as a `toolResult` block (after ID shortening) and sent per §A6.2 / §A7.2. Tool errors are never transport errors.

---

## A9. Stream presentation buffer (`Agent/Chat/AgentStreamPresentationBuffer.swift`)

Purpose: coalesce token deltas so the UI is not re-laid-out per token.

### A9.1 Reducer (pure; `:10-79`)

State: `blocks: AgentContentBlock[] = []`, `stopReason = 'end_turn'`.

| Event | Effect |
|---|---|
| `thinkingDelta(t)` | if last block is `thinking` → append `t` to its text; else push `{thinking, text:t, signature:""}` |
| `thinkingSignature(s)` | if last block is `thinking` → append `s` to its signature; else push `{thinking, text:"", signature:s}` |
| `redactedThinking(d)` | push `{redactedThinking, data:d}` |
| `reasoningSummaryDelta(t)` | pop the last block if it is an `openAIReasoning` of the run's model and take its summary `S` (else `S = ""`); push `{openAIReasoning, summary: S + t, encryptedContent:"", model}` |
| `reasoningComplete(id, summary, enc)` | pop as above (`S`); push `{openAIReasoning, summary: summary \|\| S, encryptedContent: enc, itemID: id, model}` |
| `textDelta(t)` | if last block is `text` → append; else push `{text:t}` |
| `toolUseComplete(id,name,json)` | push `{toolUse,id,name,input:json}` |
| `messageStop(r)` | `stopReason = r`; **no revision bump** |

### A9.2 Buffer (`:81-165`)

- Every applied event (except `messageStop`) increments `revision` and marks dirty.
- The **first** dirty event publishes immediately; afterwards a single 50 ms timer publishes the latest snapshot when it fires (at most one timer pending).
- The consumer stream keeps only the newest snapshot (`bufferingNewest(1)`); the consumer skips snapshots whose revision equals the last applied one.
- `complete(error?)`: cancel the timer, publish if dirty, finish (or fail) the stream; returns the final snapshot. After completion further events are ignored.

### A9.3 `presentAgentStream` (`:167-212`)

A detached producer feeds provider events into the buffer and completes it (with the error if one occurred). The consumer applies snapshots to the assistant message. On consumer error or cancellation: cancel the producer, wait for it, complete the buffer, apply the final snapshot if it is newer, rethrow. Otherwise wait for the producer, apply the final snapshot if newer, return it (its `stopReason` drives the loop).

Linux: run the reducer in the main process; push `{sessionId, messageId, blocks, revision}` to the renderer at most every 50 ms (first one immediately). Sending whole `blocks` arrays is fine (the Mac does the same); send diffs only if profiling demands it.

---

## A10. Errors (`AgentPanelView.swift:323-387`, `PalmierClient.swift:61-89`)

| Error | Raised when | Mac banner text | Mac CTA | **Linux** |
|---|---|---|---|---|
| `unavailable(model)` | no route; also set when switching to a model without a route | paid-only & unpaid: `Subscribe or add your own API key to use this model.`; else Anthropic: `Add an Anthropic API key or credits to use this model.` / OpenAI: `Add an OpenAI API key or credits to use this model.` | "View plans" / "Open Settings" (Settings ▸ Agent) | `Add an Anthropic API key to use this model.` / `Add an OpenAI API key to use this model.` CTA **Open Settings** → Settings ▸ Models & API Keys (`05` §11.5) |
| `refusal(model)` | stop reason `refusal` | `The selected model refused this request. Revise the prompt and try again.` | none | same |
| `upstream(message)` | any transport/HTTP/stream error; `Chat session unavailable.`; `The agent request has no user message.` | the message (e.g. `Anthropic API error (401): {…}`) | none | same |
| `unauthenticated` | hosted 401 | `Sign in to use AI chat.` | "Sign in" | [CLOUD] never occurs |
| `insufficientCredits(msg)` | hosted 402 | msg | "View plans" | [CLOUD] never occurs |

Banner layout: HStack aligned to first text baseline, gap 6: message 10 px red, leading; optional capsule-secondary small button with 10 px medium title. It appears under the empty state, or after the last message (top padding 6). It is cleared on the next send, on session switch, and on new chat.

---

## A11. Agent panel UI

Visual tokens are from `05` §1. Only behaviour and exact strings/sizes not already in `05` §2.6 are listed. Source: `Agent/Panel/*.swift`.

### A11.1 Structure

VStack(spacing 0): floating tab bar → message list (flex) → footer. The column is 240–640 px wide (`05` §2.3).

### A11.2 Floating tab bar (`AgentPanelView.swift:68-138,589-614`)

- Glass rounded rect radius 14, height 30, inner HStack gap 4, inner padding-x 6, outer padding-x 12.
- Left: horizontally scrolling chat tabs (gap 4, no scrollbar) for open sessions; when the current session changes it scrolls the tab to center (150 ms ease-out).
  - Tab title: session title, truncated to 20 characters + `…` if longer; 10 px; active = semibold primary, inactive = medium secondary; one line. Chrome = the shared document-tab chrome with a close button (`05` §3.5). Click selects; × closes (§A2.2).
- `+` button: SF `plus` 11 px medium tertiary in 20×20; tooltip "New chat".
- History button: SF `clock.arrow.circlepath` 11 px medium tertiary 20×20; tooltip "Chat history"; toggles a popover (arrow on top):
  - Width 280; glass radius 10. Empty: `No conversations yet` (10 px muted, padding 10).
  - Else a scroll list (max height 360, no scrollbar) of all sessions sorted by `updatedAt` desc. Row: padding 10×6; title 10 px (semibold if current) primary, 1 line; below it the relative time (`RelativeDateTimeFormatter`, short style, e.g. "5 min. ago"; Linux `Intl.RelativeTimeFormat` short) 9 px tertiary; current row background accent @ 0.15; non-current rows show a `trash` button (10 px muted, tooltip "Delete from history"). Clicking a row selects it and closes the popover. Delete has no confirmation.
- "View Skills" button (SF `book.closed`) → Settings ▸ Skills (`05` §11.7).

### A11.3 Message list (`AgentPanelView.swift:250-321`, `AgentMessageView.swift`)

- Empty and not streaming → empty state (§A11.5). Otherwise a lazy vertical list, gap 20, padding-x 16, top 12, bottom 8, max width 640 centered, overlay scrollbars.
- Rows: each message via `AgentMessageView`; while streaming, a `ThinkingDots` row (three 5×5 circles, gap 5, tertiary; the active dot is opaque, others 0.25; advances every 0.28 s with 0.25 s ease); then the error banner.
- **Auto-scroll** (animated 150 ms) when the message count changes or `isStreaming` changes: to the dots row while streaming, else to the last message. Token growth inside one message does **not** auto-scroll (parity; consider following the bottom while the user is at the bottom).
- "Scroll to latest" button appears when the distance from the bottom exceeds 80 px: 28×28 glass circle, SF `arrow.down` 12 px semibold secondary, inset 12 from bottom-right, fade+scale(0.85) transition; tooltip "Scroll to latest".

Per role:

- **user**: only `text` blocks, joined with `\n`; right-aligned bubble (leading spacer min 48), body font, primary, line spacing 3, padding 14×8, fill `--pp-fill-faint`, radius 14 (continuous), selectable. A user message without text blocks (tool results) renders nothing — tool results appear inside the assistant row.
- **assistant**: VStack gap 10, blocks in order:
  - `thinking` with non-empty text and `openAIReasoning` with non-empty summary → **ThinkingSummaryView**: while incomplete (no signature / no encrypted content) the summary text shows live (10 px tertiary, leading inset 10 with a 1.5 px subtle-border rule on the left, selectable); once complete it collapses to a toggle icon (`brain.head.profile` / `.fill` when expanded, 9 px medium tertiary, 12×12; tooltip "Show reasoning" / "Hide reasoning"), expanding with a 150 ms fade.
  - `redactedThinking`, `toolResult` → nothing.
  - `text` → **MarkdownText** (§A11.7).
  - `toolUse` → **ToolRunRow** (§A11.4) with the result looked up by id across all user messages.
  - If any text exists: a **Copy** button (doc.on.doc + "Copy" → checkmark + "Copied" for 1.5 s; 10 px tertiary; tooltip "Copy message") visible only on hover (150 ms). It copies all text blocks joined with `\n\n`.
- **system**: centered text blocks joined with `\n`, 10 px tertiary.

### A11.4 Tool-call card (`AgentMessageView.swift:183-285`)

- Header button (toggles expansion, 150 ms ease-out): status (running = mini spinner 10×10; success = `checkmark.circle.fill` 10 px tertiary; error = `xmark.circle.fill` 10 px red @ 0.8), the tool name (11 px medium **monospace** tertiary; opacity 0.7 while running), `chevron.right` 8 px semibold rotating 90° when expanded.
- Expanded panel (fade + slide from top): 10 px monospace tertiary, padding 10, fill `--pp-fill-subtle`, radius 10, selectable.
  - `args` label (9 px muted) + the input JSON pretty-printed with floats rounded to 3 places; `(no args)` when empty or `{}`.
  - `result` / `error` label (9 px; error in red @ 0.8) + each content block: text as-is (this is the post-shortening text the model saw); image decoded and shown fit, max height 50 (`toolImagePreviewMaxHeight`), radius 6; `(image payload)` if undecodable.
- There is no per-tool friendly label and no progress beyond the spinner.

### A11.5 Empty state and starter prompts (`AgentPanelView.swift:7-50,389-471`)

When `canStream`: centered VStack gap 8, padding-x 16:
- `Ask anything, or start with:` (12 px medium secondary, centered)
- Starter rows (VStack gap 4). Row: icon 12 px medium tertiary in 20×20, title 12 px medium primary; padding 10×4; glass radius 14 with hover highlight; tooltip "Fill prompt". Click sets the draft to the prompt and clears draft mentions (no auto-send).

| id | Title | SF | Prompt (verbatim) |
|---|---|---|---|
| `keep_best_takes` | Keep the best takes | `scissors` | `Tighten this edit. Keep the strongest takes, cut filler words and long silences, and leave a clean continuous cut.` |
| `sync_multicam` | Sync my multicam | `rectangle.on.rectangle.angled` | `Set up my multicam. Group the matching camera angles with their audio, verify sync, and leave it ready to switch.` |
| `generate_broll` | Generate B-roll | `film` | `Generate B-roll that fits this edit. Find moments that need cutaways, create matching shots, and place them where they support the story.` |
| `score_timeline` | Score my timeline | `music.note` | `Generate music for this timeline. Match the mood and length, then place it on an audio track synced to the edit.` |
| `cut_to_beat` | Cut to the beat | `metronome` | `Assemble my clips to the beat of a song. Detect the beats and cut or place clips so the edit hits the rhythm.` |
| `add_captions` | Add captions | `captions.bubble` | `Add captions to this timeline. Transcribe the dialogue, phrase it for readability, and place text clips locked to the speech.` |
| `make_vertical_shorts` | Make vertical shorts | `rectangle.portrait` | `Find the strongest moments in this video and turn each into a short-form vertical clip. Create multiple 9:16 timelines, reframe for vertical, and keep every clip tight and self-contained.` |

When `!canStream` ("missing key state"; also shown above the composer when messages exist):
- Mac [CLOUD]: prominent capsule (`Log in for 250 free credits` + `gift.fill`, with `First-time sign-ups only` 11 px muted below; or `Subscribe`; or `Open Settings` + `gearshape`), then an underlined link `or add your own Anthropic key` / `or add your own OpenAI key` (12 px medium secondary) → Settings ▸ Agent.
- **Linux**: VStack gap 12: prominent capsule `Open Settings` with `gearshape` (14 px semibold, regular size), then the underlined link `Add your own Anthropic key` / `Add your own OpenAI key`. Both open Settings ▸ Models & API Keys.

### A11.6 Footer and composer (`AgentPanelView.swift:485-509`, `AgentInputBox.swift`, `MentionPopover.swift`)

- Footer: VStack gap 6 (`[missing-key state if !canStream && messages non-empty]`, composer); padding-x 12, bottom 12, top 4; max width 640 centered.
- Composer: glass rounded rect radius 20. Border: drop-target → `--pp-accent` @ 0.55, 1 px; focused → `--pp-accent` @ 0.35, 1 px; else `--pp-fill-hint`, 0.5 px (150 ms).
  - Text area: body font; padding-x 12, top 8, bottom 4; height grows 32 → 64 px then scrolls. Placeholder `Ask, or type @ to reference media` (muted, padding-x 16, top 12). When the draft goes from non-empty to empty (after send) the editor is recreated (resets undo/scroll) and keeps focus.
  - Bottom bar: HStack gap 10, padding 6: model picker, effort picker, key indicator, spacer, send/stop.
  - **Send**: circular prominent button tinted accent, `arrow.up` 11 px bold in 18×18; disabled at opacity 0.55 unless `canSend = !isStreaming && canStream && draft.trim() !== ''`. **Stop** (while streaming): circular glass button tinted secondary, `stop.fill` 10 px bold, tooltip "Stop". Morph with scale+fade.
  - **Model picker**: menu of the six models by display name (no checkmark on the current one); label = name (10 px medium secondary, 1 line, tail truncation) **followed by** the 14×14 logo (Claude logo `Resources/Images/Agents/claude.png` for Anthropic; OpenAI provider logo). Tooltip/a11y "Model".
  - **Effort picker**: the model's supported efforts, checkmark on the selected one; label = effort label + `brain.head.profile` 9 px medium tertiary (12×12). Tooltip "Reasoning effort".
  - **Key indicator**: `key` 10 px tertiary 14×14, shown when `activeBYOKProvider` is set; tooltip `Streaming through your Anthropic API key (BYOK)` / `Streaming through your OpenAI API key (BYOK)`; a11y `using Anthropic API key` / `using OpenAI API key`.
- **Keys**: with the mention picker open: ↑/↓ move the highlight (clamped, no wrap; held-key repeat allowed for arrows only), Return picks, Esc closes, Tab / Shift+Tab cycles the picker tab, other keys type normally. With the picker closed: Return (no Shift) sends when `canSend`; Shift+Return inserts a newline.
- **@ query** (recomputed on every edit): take the last `@` in the draft; the query is the text after it if that text has no whitespace/newline and the `@` is at the start or preceded by whitespace/newline; otherwise no query. Picker visible whenever a query exists.
- **Mention picker** (popover anchored at the composer's top-left; on Linux open it upward): width 260; tab strip `All | Video | Image | Audio` (equal widths, 10 px, selected = semibold primary on accent @ 0.18 radius 6, else regular tertiary, vertical padding 5, strip padding 4); 0.5 px divider; content height 280.
  - Candidates: library assets of the tab's type (All = every asset), whose `mentionDisplayName` lowercased contains the query; first 50, library order.
  - Row: thumbnail 28×20 radius 6 (fallback: quaternary fill + type icon 10 px tertiary), name 10 px medium primary, type label 9 px tertiary; padding 6×4; highlighted row accent @ 0.15; hover moves the highlight; click picks; keyboard moves scroll the row into view.
  - Empty: `No media` / `No video clips` / `No images` / `No audio`, or `No matches for "<query>"` (10 px muted).
  - **Pick**: replace everything from the last `@` to the end of the draft with `@<displayName> ` (displayName disambiguated, §A12), append `{displayName, mediaRef, type}` to the draft mentions, close the picker.
- **Drop** files onto the composer: import each (`03` §10.1 import path) and attach an asset mention (§A12.1).
- **Paste**: if the clipboard has file URLs → import + mention each; else if it has PNG or TIFF image data → save as `media/pasted-<8hex>.png|tiff` (`01` §1.7), import, mention; else paste text. (Mac appends pasted text at the **end** of the draft — a quirk; on Linux let the native paste insert at the caret and only intercept files/images.)

### A11.7 Markdown renderer (`Agent/Panel/MarkdownText.swift`)

Line-based parser, cached by text (512 entries):
- ` ``` ` fence (after trimming) starts a code block; the rest of the fence line is the language; ends at the next line whose trimmed text starts with ` ``` ` (or EOF). Rendered as: optional language label (9 px medium mono, muted, uppercase) and the code (11 px mono, primary, selectable) on `--pp-bg-base` @ 0.35, radius 10, padding 10.
- ATX heading `#`…`######` + space → bold (h1, 19 px) or semibold (h2 16, h3 14, h4–6 13).
- GFM table: a line containing `|` followed by a valid separator row (`---`, `:--`, `--:`, `:-:` cells) → header (semibold) + rows (padded/truncated to the header width); rows continue while lines contain `|` and are non-blank; `\|` escapes a pipe. Rendered as a grid (column gap 12, row gap 6) on `--pp-bg-base` @ 0.35, radius 10, padding 10, with a divider under the header.
- Everything else: consecutive lines form paragraphs rendered with inline-only Markdown (bold, italic, code spans, links, strikethrough), whitespace preserved; headings and paragraphs inside one prose run are separated by a blank line. Body font, primary, line spacing 4, selectable. Lists are not special-cased (they render as their literal text).

Linux: implement the same subset (e.g. `markdown-it` with only inline rules + custom block splitting) — do not render raw HTML.

### A11.8 Stop, retry and attachments (what does *not* exist)

- **Stop** is the only run control (§A11.6, §A3.7). A stopped turn keeps its partial text (§A3.5) and any unanswered tool calls get `Cancelled` results on the next send (§A3.6).
- There is **no Retry / Regenerate / Edit-message button** anywhere in `Agent/Panel/*` (v0.7.6). To retry, the user sends a new message; the error banner (§A10) has a CTA only for the key/sign-in cases. Do not add a "regenerate" that rewrites history: with the preserved-thinking models (§A1.1) edited history invalidates thinking blocks.
- **Attachments** are not files sent to the model: every drop/paste becomes a media-library import plus an asset mention (§A11.6, §A12.1). Only `image` mentions are inlined as image blocks (§A5.3); video/audio mentions reach the model as ids in the hint text, and the model inspects them with tools (`inspect_media`, `02` §3.10).

---

## A12. Mentions and @context

Display-name normalization (`AgentMentionContext.swift:132-145`): collapse every run of whitespace and/or `-` into a single `-`, then trim leading/trailing `-`. (`mentionDisplayName` of an asset = this applied to the asset name.)

### A12.1 Asset mention (media tile "Add to chat", composer drop/paste; `AgentService.swift:129-136`)

1. Show the agent panel (`agentPanelVisible = true`).
2. Prune draft mentions whose `@displayName` no longer occurs in the draft.
3. If an asset mention (no clip, no range) for this asset already exists, stop.
4. `name = mentionDisplayName`; if another mention already uses this name for a different asset, `name += '#' + assetId.slice(0,6)`.
5. Append token: `(draft non-empty and not ending in space/newline ? ' ' : '') + '@' + name + ' '`.
6. Push `{id: uuid, displayName: name, mediaRef: asset.id, type: asset.type}`.

### A12.2 Clip mentions (timeline clip menu "Add to Chat"; `:138-160,193-218`)

For the right-clicked clip set (`05` §6.14), in track order then clip order, skipping clips already mentioned:
- `label = clipDisplayLabel(clip)` (text clips: content with newlines → spaces, or `Text`; generating asset: asset name; nested: timeline name; else media name — `EditorViewModel+MediaLibrary.swift:501-517`).
- `short = displayName(label)`, cut to 24 characters and trimmed of `-`.
- `base = displayName(short + '-' + trackLabel + '-' + timecode(clip.startFrame, fps))` where `trackLabel` is `timelineTrackDisplayLabel` (`03` §5.7) and timecode is `HH:MM:SS:FF`. If empty, `Clip-<id.slice(0,6)>`.
- On a name clash with another clip: `base + '#' + id.slice(0,6)`.
- Mention `{displayName, mediaRef: clip.mediaRef, type: clip.mediaType, clipId}`.

### A12.3 Range mention (range menu "Add Range to Chat"; `:162-173,220-231`, `AgentMentionContext.swift:155-190`)

Requires a valid timeline in/out range. Build `{startFrame, endFrame, durationFrames = max(0,end-start), fps, startTimecode, endTimecode, durationTimecode, rangeSemantics:"startInclusiveEndExclusive"}` from the normalized range. Skip if an identical range mention exists. Name `displayName("Range-" + startTC + "-" + endTC)` (e.g. `Range-00:00:01:00-00:00:05:12`), fallback `Range-<s>-<e>`, clash suffix `#<s>-<e>`.

### A12.4 What is sent

Only mentions whose `@displayName` is still in the sent text are kept (`referencedMentions`). They are stored on the user message and turned into the hint and inline images every time the transcript is sent (§A5).

---

## A13. Skills in the agent

Storage, frontmatter, ledger, community catalog, auto-install rules and the two tools are in `02` §5 and Appendix A; the Settings UI is `05` §11.7. Runtime behaviour relevant to the agent:

- At launch the app starts one background sync (`AppDelegate.swift:24` → `SkillStore.startSkillSync`): rescan `~/.palmier/skills`, fetch the catalog (`https://raw.githubusercontent.com/palmier-io/palmier-skills/main/catalog.json`, override `PALMIER_SKILLS_BASE`), auto-install / auto-update per the ledger rule. [LOCAL + public GitHub; no account]
- Each agent run first **awaits** that sync if it is still running, then rescans the folder once (`AgentService.swift:424-426`). A skill dropped into the folder is visible from the next send.
- Only the index line (`- <id>: <description>`) enters the system prompt (§A4.1). Bodies enter the conversation only as `read_skill` tool results (frontmatter stripped, body trimmed).
- A skill is valid only if its `SKILL.md` frontmatter has non-blank `name` and `description` (`Agent/Skills/Skill.swift:55-61`); invalid folders are skipped silently.
- Mutations (install, create, rename, delete) are serialized through one queue (`SkillStore.swift:287-304`); Linux: one promise chain in the main process.

---

## A14. Agent hand-offs from the rest of the app [BYOK]

Every hand-off does: **new chat** (§A2.2) → set the draft to a fixed prompt (draft mentions untouched) → show the agent panel. Nothing is sent automatically.

| Entry point | Where it hooks in | Visible when | Prompt (verbatim) |
|---|---|---|---|
| Media panel ⋯ ▸ **Organize with Agent** (`wand.and.stars`) | `05` §4.3 | Mac: backend configured and library non-empty → **Linux: library non-empty and the selected agent model has a key** | `Organize my media library. Review the assets, group related ones into clearly named folders, and give generically-named assets short descriptive names — inspect an asset when its name is unclear. Don't delete anything or change the timeline.` + (inside a folder: ` Work within the current folder.`) (`MediaPanel/MediaTab/MediaTab.swift:598-630`) |
| Captions tab ▸ **Agent Mode** menu | `05` §4.14 | not shown in transcript-only mode | `If the timeline has no captions yet, transcribe the spoken audio and add captions on word boundaries first. Then <task>` with `<task>` one of: `remove filler words (um, uh, er, like, you know) from the captions, keeping each caption's timing unchanged.` (Remove filler words, `text.badge.minus`) · `fix any misspelled names, brand names, or technical jargon in the captions using the surrounding context, keeping timing unchanged.` (Fix names & jargon, `checkmark.bubble`) · `add relevant emoji to the captions, keeping the text and timing otherwise unchanged.` (Add emoji, `face.smiling`) · `translate the captions to <Language>, keeping each caption's timing unchanged.` (Translate ▸, `globe`; languages es Spanish, fr French, de German, it Italian, pt Portuguese, ja Japanese, ko Korean, zh-Hans Chinese, hi Hindi, ar Arabic — menu shows the localized language name, prompt uses the English name) (`MediaPanel/CaptionsTab/CaptionTab.swift:108-119,506-538`) |
| Audio tab ▸ Music ▸ **Agent Mode** menu | `05` §4.14 | always | `Score my timeline with music that matches the visuals. Use a video-to-music model on the full timeline span so the music follows the edit, and place it on an audio track.` (Generate music for the timeline, `music.note`) · Mood ▸ `Cinematic`/`Upbeat`/`Ambient`/`Tense`/`Lo-fi` → `Generate <mood lowercased> music for my timeline and place it on an audio track aligned to the edit.` (`MediaPanel/AudioPanelTab/MusicTab.swift:277-299`) |
| Media tile hover **Add to chat** (`bubble.left`) | `05` §4.5 | hover, not generating, not in swap mode | asset mention (§A12.1) |
| Timeline clip menu ▸ **Add to Chat** | `05` §6.14 | always | clip mentions (§A12.2) |
| Timeline range menu ▸ **Add Range to Chat** | `05` §6.14 | right-click inside the range | range mention (§A12.3) |

`EditorAgentMenu` ("Agent Mode" + `chevron.down` 10 px, capsule secondary, tooltip per menu: `Let Agent create captions for you. Choose a predefined task, or ask Agent in the chat.` / `Let Agent generate music for you. Choose a starter, or ask Agent in the chat.`) is defined in `UI/EditorPanel/EditorActionFooter.swift:23-47`.

---

## A15. Analytics and telemetry [CLOUD → drop]

The Mac captures PostHog events (`agentSessionStarted` on the first user message of a session with `{project_id, model}`, `agentStarterPromptClicked {starter_prompt}`, `agentToolCalled {tool_name, source, project_id, session_id, status, tool_duration_seconds, timeline_changed, failure_reason, error_message (2 048 chars, URLs and /Users… paths redacted)}`, skill-read events) and Sentry breadcrumbs. Linux: omit, or route to your own endpoint behind the opt-in switch in `05` §11.3. None of it affects behaviour.

---

## A16. Linux implementation checklist (agent)

1. Settings: `agentModel`, per-model effort, Anthropic/OpenAI keys (`AppSettings.apiKeys.anthropic|openai` already exist).
2. Session store with per-session message arrays (fixes Q-A1); `chat/*.json` reader/writer per `01` §5.15 with ISO dates without fractions and upper-case UUIDs.
3. Provider adapters with `fetch` + a line-based SSE reader (`eventsource-parser` or a 20-line splitter on `\n`), `AbortController`, 600 s inactivity timeout, error strings as in §A6.4/§A7.3.
4. Deterministic JSON serialization of request bodies (sorted keys) for prompt-cache stability.
5. Reducer + 50 ms presentation buffer; IPC snapshots.
6. Executor in in-app mode; per-project serialization with the MCP server.
7. Mention context, inline image encoder with cache.
8. Panel UI and hand-offs per §A11/§A14.

---

# Part B — AI generation

## B0. What the Mac depends on, and what the port replaces

Every generation on the Mac goes through Palmier's Convex backend after Clerk sign-in (`Generation/GenerationBackend.swift`):

| Mac call | Purpose | Linux |
|---|---|---|
| subscription `models:list {catalogVersion: 4}` | the **whole model catalog** (ids, capabilities, prices) — server data, not in the repo (`Generation/Catalog/ModelCatalog.swift:41-117`) | [CLOUD] → a **local, versioned catalog JSON** shipped with the app (§B2), filtered to providers that have a key |
| `BackendStorage.uploadStaged` + action `uploads:commitUpload {storageId}` → `{url}` | host reference media at a URL the backend can read | [CLOUD] → provider-specific upload (fal CDN, Replicate Files API, inline base64, multipart) (§B12.2) |
| mutation `generations:submit {model, params, projectId}` → `{jobId}` | start a job | [CLOUD] → provider adapter `submit` (§B12) |
| mutation `generations:enhanceDraft {sourceJobId}` → `{jobId}` | "FLUX Enhance" re-render of a draft | [CLOUD] → [BYOK] re-implemented with the providers' public draft APIs (fal/BFL FLUX.3 `draft-enhance`, fal Seedance 2.5 `draft/complete`; §B9.6) |
| subscription `generations:byId {id}` → `{_id, status: queued\|running\|succeeded\|failed, resultUrls?, errorMessage?, costCredits?, refundedCredits?, completedAt?}` | live job status | [CLOUD] → adapter `poll` loop (§B12.1) |
| subscription `generations:projectActivity {projectId}` → `[{id, kind: generation\|failed\|refund, model, credits, createdAt(ms)}]` | Project Activity popover | [CLOUD] → local activity list built from the manifest (§B11) |
| account: plan, credits, `paidOnly` gating, cost estimates | credits chip, "(Paid)" labels, cost label, "Out of credits" | [CLOUD] → drop (§B11) |

Everything else in this Part — placeholders, references, trimming, preprocessing, panel logic, AI Edit, transitions, placement, download/install, resume — is local logic and is ported 1:1.

---

## B1. Catalog schema (`Generation/Catalog/*.swift`)

The Linux catalog file uses **the same JSON shape the Mac receives** from `models:list`, so the panel logic, `list_models` output (`02` §3.44) and validation can be ported unchanged. Linux adds one key, `byok` (§B12.3), which the Mac never sees.

### B1.1 `CatalogEntry` (`ModelCatalog.swift:150-244`)

```ts
interface CatalogEntry {
  id: string;                         // required; persisted in GenerationInput.model
  kind: 'video' | 'image' | 'audio' | 'upscale';   // required
  displayName: string;                // required
  providerIconKey?: string;           // logo key; bundled keys: alibaba blackforestlabs bytedance elevenlabs fish google
                                      //   ideogram kling krea ltx microsoft minimax mirelo openai recraft reve runway sonilo topaz veed xai
  providerName?: string;              // video picker groups by this ("Other" when absent)
  description?: string;               // shown for upscalers
  allowedEndpoints: string[];         // required on the Mac, opaque there ("opaque" in fixtures); Linux: unused (keep [] or the provider endpoints)
  responseShape: 'video' | 'images' | 'audio' | 'upscaledImage';   // required
  uiCapabilities: VideoCaps | ImageCaps | AudioCaps | UpscaleCaps;  // required, decoded by kind
  creditsPerSecond?: Record<string, number>;   // pricing [CLOUD]; ignore on Linux
  audioDiscountRate?: Record<string, number>;  // presence ⇒ the "Generate audio" toggle is shown (§B7.6)
  creditsPerImage?: Record<string, number>;    // [CLOUD]
  qualities?: string[];
  audioPricing?: { mode: 'perThousandChars', rate } | { mode: 'perSecond', rate, textRate? } | { mode: 'flat', price };  // [CLOUD]
  creditsPerSecondUpscale?: number;            // [CLOUD]
  upscalePricing?: object;                     // [CLOUD]
  paidOnly?: boolean;                          // default false; [CLOUD] gating — ignore on Linux
  byok?: ByokBinding;                          // LINUX ONLY (§B12.3)
}

interface VideoCaps {
  supportsPrompt?: boolean;           // default true
  durations: number[];                // seconds; [] = no duration choice (source-length billing)
  resolutions?: string[] | null;      // e.g. ["720p","1080p"], ["768P","2K"]
  aspectRatios: string[];
  supportsFirstFrame: boolean; supportsLastFrame: boolean;
  maxReferenceImages: number; maxReferenceVideos: number; maxReferenceAudios: number;
  maxTotalReferences?: number | null;
  maxCombinedVideoRefSeconds?: number | null; maxCombinedAudioRefSeconds?: number | null;
  framesAndReferencesExclusive: boolean;
  referenceTagNoun: string;           // "Image" or "Element" (Kling) — tag prefix for image refs
  requiresSourceVideo: boolean;
  maxSourceVideoSeconds?: number | null;
  maxSourceVideoResolution?: '720p' | '1080p' | '4k' | null;
  requiredSourceVideoEncoding?: 'h264-mp4' | null;
  requiresReferenceImage: boolean;
  requiresReferenceAudio?: boolean | null;     // default false
  draftCreditsPerSecond?: number | null;       // presence ⇒ supportsDraft
  draftEnhanceCreditsPerSecond?: number | null;
  sourceVideoCreditsPerSecond?: Record<string, number> | null;  // presence ⇒ supportsSourceVideo ("Extend" mode)
  sourceVideoDraftCreditsPerSecond?: number | null;
}
interface ImageCaps { resolutions?: string[] | null; aspectRatios: string[]; qualities?: string[] | null; supportsImageReference: boolean; maxImages: number }
interface AudioCaps {
  category: 'general'|'tts'|'music'|'sfx'|'cleanup'|'dubbing';   // unknown → 'tts'
  voices?: string[] | null; defaultVoice?: string | null;
  supportsLyrics: boolean; supportsInstrumental: boolean; supportsStyleInstructions: boolean;
  durations?: number[] | null; durationRange?: { minimum: number; maximum: number; defaultValue: number } | null;
  minPromptLength: number;
  maxReferenceImages?: number | null; maxReferenceAudios?: number | null; maxReferenceAudioSeconds?: number | null;
  referenceAudioExtensions?: string[] | null; referenceImagesAndAudiosExclusive?: boolean | null;
  supportsMultilingual?: boolean | null;
  inputs?: ('text'|'audio'|'video')[] | null;  // default ["text"]; unknown values dropped
  promptLabel?: string | null;                 // default "Describe the sound"
  minSeconds?: number | null; maxSeconds?: number | null;       // source-media span limits; defaults 1 / 600
  targetLanguages?: string[] | null; defaultTargetLanguage?: string | null;
}
interface UpscaleCaps {
  speed: 'Fast' | 'Medium' | 'Slow'; p75DurationSeconds: number; maximumUpscaleFactor?: number | null;
  supportedTypes: ('video'|'image')[];
  selectSettings?: { id: string; label: string; options: { value: string; label: string; description?: string; group?: string; groupDescription?: string }[]; defaultValue: string }[] | null;
  numericSettings?: { id: string; label: string; minimum: number; maximum: number; step: number }[] | null;
  toggleSettings?: { id: string; label: string; defaultValue: boolean }[] | null;
}
```

Decode strictness to mirror (Swift `init(from:)`): a missing required key or a wrong type drops **the entire catalog update** on the Mac (the subscription fails). On Linux, validate the bundled file at build time (unit test) instead.

### B1.2 Derived properties (`VideoModelConfig.swift`, `ImageModelConfig.swift`, `AudioModelConfig.swift`, `UpscaleModelConfig.swift`)

Video:
- `supportsSourceVideo = requiresSourceVideo || sourceVideoCreditsPerSecond != null`
- `supportsDraft = draftCreditsPerSecond != null`; draft resolution constant `"720p"`.
- **Pricing fields double as feature flags.** `draftCreditsPerSecond` (drafts), `sourceVideoCreditsPerSecond` (Extend mode) and `audioDiscountRate` (the "Generate audio" toggle) are tested only for presence. The Linux catalog has no prices but must still set these keys (`0` or `{}`) on models that support the feature.
- `usesOutputDuration = supportsSourceVideo && durations.length > 0` (extension models bill on output length).
- `isEdit = supportsPrompt && requiresSourceVideo && !requiresReferenceImage && !requiresReferenceAudio`; `VideoModelConfig.edit` = first such model.
- `isLipSync = !supportsPrompt && requiresSourceVideo && requiresReferenceAudio`; `lipSync` = first such.
- `isReframeModel(m) = m.supportsPrompt && !m.requiresSourceVideo && m.maxReferenceVideos > 0 && (id.lower contains "minimax-h3" || "hailuo-03")`; `reframe` = first such (`VideoModelConfig.swift:28-34`).
- `firstAndLastFrame` = first model with `!requiresSourceVideo && supportsFirstFrame && supportsLastFrame` (AI transitions).
- `supportsReferences = any of maxReference{Images,Videos,Audios} > 0`.
- `nearestSupportedDuration(s) = argmin |d - s|` over durations (ties → first), or `max(1, round(s))` when empty.
- `supportedDuration(covering s) = min{d ≥ s}`, else `max(durations)`, else `max(1, ceil(s))`.
- `preferredHighResolution = "2K"` if listed, else `"1080p"` if listed, else first resolution.
- `billingDurationSeconds(sourceVideo, sourceAudio) = round(isLipSync ? sourceAudio : sourceVideo)`, min 1; null if not finite/positive.
- `audioDiscount(resolution) = audioDiscountRate[resolution] ?? audioDiscountRate[""]`.
- Limit label: `N seconds` / `1 second` / `N minutes` / `1 minute` (minutes when divisible by 60).

Image: `maxImages = clamp(caps.maxImages, 1, 4)`; `nanoBananaPro` = model with id `nano-banana-pro` (used by image **Edit**).
- `resolutionDisplayLabel(id)`: for `WxH` ids: square → `Square`; else `Landscape`/`Portrait` + tier by long edge (3840 `4K`, 2560 `2K`, 1920 `1080p`, 1024/1536 none, else `<long>p`), e.g. `Portrait 1080p`. Other ids shown as is.
- `aspectRatioDisplayLabel(id)`: ids containing `:` shown as is; enum ids like `landscape_16_9` → split on `_`, the last two numeric parts become `16:9`, other tokens capitalized except `hd uhd 1k 2k 4k 8k` uppercased → `Landscape 16:9`, `Square HD`.

Audio: `hasDurationControl = durations != null || durationRange != null`; `acceptsSourceMedia = inputs ∋ audio|video`; `usesSourceURL = category ∈ {cleanup, dubbing}`; `acceptsSource(type)`: audio needs `inputs ∋ audio`, video needs `inputs ∋ video`.
- `languageName(code)` = localized language name capitalized, or the code upper-cased; empty code → `Target Language`.

Upscale: `defaultSettings = {selections: each select's defaultValue, numbers: {}, toggles: each toggle's defaultValue}`.
- `availableOptions(setting, source)`:
  - `targetResolution`: with known source size, `edge = max(w,h)`; keep options whose target long edge (`1080p` → 1920, anything else → 3840) gives `factor = max(1, target/edge) ≤ maximumUpscaleFactor` (if set) and (`target ≥ edge` or the option is the largest one).
  - `targetFPS`: with known fps: if fps > 60 → only `"60"`; else keep `"source"` and numeric options `≥ fps` (strictly greater, `fps + 0.001`, when a `"source"` option exists).
  - others: all options.
- `supports(source)`: type supported; video with fps > 60 needs a `targetFPS` setting; every `targetResolution` setting must have ≥1 available option.
- `normalizedSettings`: for each select, if the current value (or default) is not available, use the **last** available option.

### B1.3 Validation messages (verbatim; used by the panel and by `02` tools)

- `unsupportedValue`: `<displayName> does not support <field> '<value>'. Valid: <a, b, c>.` with fields `duration` (values `5s`), `aspect ratio`, `resolution`, `quality`, `voice` (first 6 voices + `…`), `target language` (`VideoModelConfig.swift:3-5`).
- Video `validate(duration, aspect, resolution)`: duration checked only if `durations` non-empty; aspect only if both lists and value non-empty; resolution only if model lists resolutions and value non-empty.
- Source duration: `Loading video metadata…` (unknown) / `<displayName> supports source videos up to <limit>. Trim the clip to continue.`
- Image: plus `<displayName> does not accept reference images.` and `<displayName> supports 1…<max> image(s) per request (got <n>).`
- Audio params: `<displayName> requires prompt ≥ <n> characters (got <m>).` (only when inputs contain text); duration list/`<displayName> duration must be <min>-<max> seconds.`; target languages: `Choose a target language.` when empty.
- Audio span: `<displayName> needs at least <min>s of source media (selection is <s>s).` / `<displayName> accepts at most <max>s of source media (selection is <s>s).` (span rounded).
- Video references (`VideoGenerationSubmission.swift:214-348`): `Model '<id>' requires a source video.` · `sourceVideoMediaRef must reference a video asset` · `<name> does not accept frame references` · `<name> requires an image reference` · `<name> requires an audio reference` · `<name> does not accept a source video` · `<name> accepts at most 2 frame references` · `<name> does not accept a last frame` · `<name> uses frames OR references, not both. Clear one side.` · `<name> accepts at most <n> image|video|audio references` (edit path says `reference(s)`) · `<name> accepts at most <n> references total` · `Combined video reference duration exceeds <n>s` · `Combined audio reference duration exceeds <n>s` · `<label> entry '<id>' must be a <type> asset` (labels `frame references`, `referenceImageMediaRefs`, `referenceVideoMediaRefs`, `referenceAudioMediaRefs`). Combined durations use the trimmed duration for the first reference whose URL matches the pending trim.
- Audio references (`AudioGenerationSubmission.swift:132-160`): `<name> accepts at most <n> image reference(s).` · `<name> accepts at most <n> audio references.` · `<name> uses either image or audio references, not both.` · `Image references must be image assets.` · `Audio references must be audio assets.` · `<asset> must be valid audio no longer than <n> seconds.` · `<asset> must be a WAV or MP3 file.`

### B1.4 Model preferences (`Generation/Catalog/ModelPreferences.swift`)

`disabledModelIds: string[]` (app setting). Disabled models are hidden from the Generate panel pickers and skipped by default-model selection; Settings ▸ Models toggles them (`05` §11.5). Paid-only filtering is [CLOUD] → Linux: **instead filter out models whose `byok` provider has no key** (keep them listed but disabled in Settings ▸ Models, with "Add <provider> key").

---

## B2. Catalog content

### B2.1 What the Mac source and public material establish

The v0.7.6 catalog is server data. These ids/names are referenced by the source code and must keep working when they appear in old projects (`GenerationInput.model`, Rerun):

| Id (exact) | Kind | Where referenced | Known facts |
|---|---|---|---|
| `veo3.1-fast` | video | example in `generate_video` schema (`Agent/Tools/ToolDefinitions.swift:1078`) | Google Veo 3.1 Fast |
| `seedance-2.0` | video | `Tests/…/GenerationTelemetryTests.swift:10` | ByteDance Seedance 2.0; image/video/audio refs `@Image1/@Video1/@Audio1` |
| `minimax-h3` | video | `VideoModelConfig.swift:33`, `Tests/…/ReframeSeedTests.swift:153-184` | fixture: durations 5…15, resolutions `768P`,`2K`, aspects `16:9`,`9:16`,`1:1`, no frames, refs 9 img / 3 vid / 3 aud, 12 total, 15 s combined video & audio refs, `referenceTagNoun "Video"`; the **reframe** model |
| `hailuo-03` | video | `VideoModelConfig.swift:33` | MiniMax Hailuo 03; reframe-capable when it takes video refs |
| `kling-reframe` | video | `ReframeSeedTests.swift:186-215` ("Legacy Reframe") | source-video model, durations 5/10, `1080p`, `16:9`/`9:16`, max source 10 s |
| `flux-3` | video | `ToolExecutorTests.swift:603`, `ManifestMetadataTests.swift:32` | Black Forest Labs FLUX.3 video, draft (720p) + "Enhanced with FLUX.3 at 1080p." (`GenerationService.swift:343`), min duration 5 s |
| `nano-banana-pro` | image | `ImageModelConfig.swift:33` | Google Nano Banana Pro; the image **Edit** model |
| `sonilo-v1.1-video-to-music` | audio (music, video input) | `Generation/Edit/VideoToAudioEditKind.swift:58` | preferred **Generate Music** model |
| `mirelo-sfx-v1.5-video-to-audio` | audio (sfx, video input) | `VideoToAudioEditKind.swift:59` | preferred **Generate SFX** model |
| `bytedance-upscaler` | upscale | `upscale_media` schema example | ByteDance video upscaler |
| `seedvr-image-upscaler` | upscale | `upscale_media` schema example | SeedVR2 image upscaler |
| (Topaz) | upscale | settings example `enhancementModel: "Proteus"`, `noise: 0.2`, `targetResolution`, `targetFPS` | Topaz video upscaler |
| names only | — | `AgentInstructions.swift:132-158`, tool descriptions | GPT Image, Seedream 5.0, MiniMax H3, Grok Imagine, Seedance 2.5, Kling V3/O3 (elements), Kling V3 Motion Control, ElevenLabs Music (3–600 s), Sonilo text-to-music (≤ 600 s), MiniMax Music (lyrics), Lyria 3 Pro, Gemini TTS (style instructions), Voice Cleanup, Dubbing |

Palmier's public docs (palmier.io/docs/generative-ai, app v0.11.0, checked 2026-10-13) list the **current** catalog, which has drifted from v0.7.6:

- **Image:** GPT-2.5 Image, GPT Image 2 (OpenAI); Nano Banana Pro, Nano Banana 2, Nano Banana Lite (Google); Grok Imagine 2 (xAI); MAI Image 2.5 (Microsoft); Muse Image (Meta); Krea 2 Large; Ideogram V4; Seedream 5.0 Pro (ByteDance); Reve 2.1; Recraft V4.1.
- **Video:** MiniMax H3 / H3 Max; Seedance 2.5 / 2 / 2 Fast / 2 Mini; Wan 3.0 / 3.0 Prime; Happy Horse / Happy Horse Edit (Alibaba); FLUX.3; Gemini Omni Flash 1.1 / Edit; Kling O3 / V3 / O3 Edit / V3 Motion Control; LTX 2.5 Pro; Runway Aleph 2.0; VEED Lip Sync v2; Grok Imagine Video.
- **Audio:** ElevenLabs Dubbing; Seed Audio 1.0 (general); ElevenLabs Music, Lyria 3 Pro, MiniMax Music 2.6, Sonilo Music; ElevenLabs Sound Effects, Mirelo SFX v1.5, Sonilo Sound Effects; ElevenLabs v4 TTS, Gemini 3.1 Flash TTS; ElevenLabs Voice Isolator.
- **Upscale:** Topaz Upscale (video+image), Bytedance Upscaler (video), SeedVR2 (video+image), FLUX Video Upscale (video).
- Ids seen in the public `palmier-skills` repo: `seedance-2`, `seedance-2-mini`, `hailuo-03`, `hailuo-03-max`, `flux-3`, `grok-imagine`, `gpt-image-2`, `seedream-v5-pro` (aspect ids like `landscape_16_9`), `nano-banana-pro`, `elevenlabs-music`.

**No public source gives Palmier's per-model durations, resolutions or limits**; the Linux catalog therefore takes capabilities from the **provider's** documented limits (§B12), which is what actually constrains a BYOK request anyway.

### B2.2 Linux catalog policy

1. Ship `resources/generation-catalog.json` = `{ "catalogVersion": 4, "linuxRevision": <int>, "models": CatalogEntry[] }`.
2. Every entry has a `byok` binding (§B12.3). An entry is **available** when the binding's provider has a key and the id is not in `disabledModelIds`.
3. Keep the v0.7.6 ids from §B2.1 as entry ids where a BYOK equivalent exists, so Rerun/`list_models`/old projects keep resolving. Add current public models under the ids Palmier uses where known (`seedance-2`, `hailuo-03-max`, `gpt-image-2`, `seedream-v5-pro`, `grok-imagine`, `elevenlabs-music`), otherwise under a stable kebab-case id.
4. Order inside each kind = the order the pickers show and the "first available" default used by tools (`02` §3.45: "Defaults to first available model"). Put the instruction-recommended defaults first: image GPT Image / Seedream; video MiniMax H3 / Grok Imagine / Seedance (`AgentInstructions.swift:132-134`).
5. Models whose id the catalog no longer contains still display by id (`ModelRegistry.displayName` falls back to the id) and make Rerun unavailable (`Model no longer available`).

The concrete proposed catalog rows are in §B12.4 (mapping table) and §B12.5 (JSON).

---

## B3. Abstract job parameters (what the Mac sends to `generations:submit`)

These are the provider-neutral requests. On Linux they are the input of the provider adapter (§B12); keep these exact shapes in code so the adapters are testable against the Mac contract.

```ts
// Generation/Catalog/VideoModelConfig.swift:188-248 — keys present only when set; arrays omitted when empty
interface VideoGenerationParams { kind: 'video'; prompt: string; duration: number; sourceVideoDuration?: number;
  aspectRatio: string; resolution?: string; sourceVideoURL?: string; startFrameURL?: string; endFrameURL?: string;
  referenceImageURLs?: string[]; referenceVideoURLs?: string[]; referenceAudioURLs?: string[];
  generateAudio: boolean; draft?: boolean }
// ImageModelConfig.swift:3-25
interface ImageGenerationParams { kind: 'image'; prompt: string; aspectRatio: string; resolution?: string; quality?: string;
  imageURLs?: string[]; numImages: number }
// AudioModelConfig.swift:3-38
interface AudioGenerationParams { kind: 'audio'; prompt: string; voice?: string; lyrics?: string; styleInstructions?: string;
  instrumental: boolean; durationSeconds?: number; videoURL?: string; sourceURL?: string; targetLanguage?: string;
  referenceImageURL?: string; referenceAudioURLs?: string[]; multilingual?: boolean }
// UpscaleModelConfig.swift:8-30
interface UpscaleGenerationParams { kind: 'upscale'; sourceURL: string; durationSeconds: number; sourceWidth?: number;
  sourceHeight?: number; sourceFPS?: number; settings: { selections: Record<string,string>; numbers: Record<string,number>; toggles: Record<string,boolean> } }
```

URL slots are filled from the uploaded references in a fixed order (§B4.3). On Linux a "URL" slot may hold a provider URL, a `data:` URI, or a local file path the adapter streams as multipart — the adapter decides (§B12.2).

---

## B4. Job lifecycle (`Generation/GenerationService.swift`)

### B4.1 `generate(...)` (`:28-132`)

Inputs: `genInput` (the `GenerationInput` to persist), `assetType`, `placeholderDuration`, `references: MediaAsset[]`, `trimmedSourceOverride?`, `name?`, `numImages` (1–4), `folderId?`, `buildParams(uploadedURLs) → params`, `snapshotRefs?`, `preprocessRef?`, `preprocessSourceVideo?`, `fileExtension`, callbacks `onComplete(asset)` / `onFailure()`.

1. `count = clamp(numImages, 1, 4)`; `baseName = name ?? first 30 characters of genInput.prompt` (no trimming; an empty prompt gives an empty name).
2. Keep `folderId` only if that folder exists.
3. Destination directory: `<package>/media/`, or the OS temp dir when the project has never been saved.
4. For `outputIndex` 0…count−1 create a **placeholder** (§B6.1) whose `generationInput` is `genInput` with `outputIndex` set. Return the **first** placeholder's id immediately (this is the "Placeholder asset ID" the tools return).
5. In the background:
   1. Prepare references (§B4.2). On error: every placeholder → `failed("Upload failed: <message>")`, `onFailure()`, stop.
   2. `finalInput = genInput`; apply `snapshotRefs(finalInput, uploaded)` if given, else `finalInput.imageURLs = uploaded.length ? uploaded : undefined`; set `createdAt = now` if absent.
   3. Write `finalInput` (with each placeholder's own `outputIndex`) into every placeholder; update the manifest.
   4. `params = buildParams(uploaded)`; `runJob` (§B4.4).

### B4.2 Reference preparation (`:152-241,420-501`)

```
urls = references.map(a => a.url)
if trim && trim.hasTrim && urls.indexOf(trim.sourceURL) >= 0:     // first match only
    urls[i] = extractTrimmedRange(trim)                           // temp mp4, §B4.6
if preprocessSourceVideo: urls[0] = preprocessSourceVideo(urls[0]) ?? urls[0]   // edit models only
if preprocessRef: for each i in parallel: urls[i] = preprocessRef(i, references[i], urls[i]) ?? urls[i]
uploaded = upload all urls in parallel, results in input order
delete every temp file created above (also on error)
```

Upload rules per file:
- Image references whose extension is `heic`, `heif` or `tiff` are first converted to full-resolution JPEG (quality 0.92); converted files are never cached.
- **Upload cache (Mac):** when the reference is an untrimmed, unpreprocessed library asset and `asset.cachedRemoteURL` is unexpired, reuse it; after a fresh upload set `cachedRemoteURL = url`, `cachedRemoteURLExpiresAt = now + 6 days` (persisted in `media.json`, `01` §5.14).
- Content type by extension: `jpg/jpeg` image/jpeg, `png` image/png, `webp` image/webp, `heic` image/heic, `gif` image/gif, `mp4/m4v` video/mp4, `mov` video/quicktime, `mp3` audio/mpeg, `wav` audio/wav, `m4a` audio/mp4, `aiff/aif/aifc` audio/aiff, `caf` audio/x-caf, `flac` audio/flac; otherwise by type (image → image/jpeg, video/sequence → video/mp4, audio → audio/mpeg, lottie → application/json, else application/octet-stream).

**Linux:** the upload target is chosen by the model's provider (§B12.2). Do **not** write provider URLs into `cachedRemoteURL` (the Mac would send them to Palmier's backend); keep a Linux upload cache in the app cache dir keyed by `(absolutePath, size, mtime, provider)` with the provider's real expiry minus a safety margin (fal CDN ≥ 7 days → 6 days; Replicate files 1 h → don't cache). Preserve Mac-written `cachedRemoteURL` values untouched when saving.

### B4.3 Reference ordering and URL slots

| Flow | Upload order | Slot assignment (`buildParams`) | Persisted in `GenerationInput` |
|---|---|---|---|
| Text/image/reference-to-video (`VideoGenerationSubmission.swift:129-184`) | frames (first, last), image refs, video refs, audio refs | `startFrameURL = frames[0]`, `endFrameURL = frames[1]`, `referenceImageURLs`, `referenceVideoURLs`, `referenceAudioURLs`; `sourceVideoURL` absent | `imageURLAssetIds = frame ids`, `referenceImageAssetIds`, `referenceVideoAssetIds`, `referenceAudioAssetIds`; after upload `imageURLs = frame URLs`, `reference*URLs` |
| Video edit / extend / lip sync (`:58-127`) | source video, image refs, video refs, audio refs | `sourceVideoURL = uploaded[0]`, refs as above, `sourceVideoDuration = trimmed duration or source resolvedDuration`, no frame URLs | `imageURLAssetIds = [source id]`, refs as above |
| Image (`ImageGenerationSubmission.swift:37-65`) | reference images | `imageURLs = uploaded` | `imageURLAssetIds = ref ids`, `imageURLs` |
| Audio with references (`AudioGenerationSubmission.swift:104-131`) | image refs, audio refs | `referenceImageURL = uploaded[0]` if any image ref; `referenceAudioURLs = rest` | `referenceImageAssetIds`, `referenceAudioAssetIds`; `referenceImageURLs = [url]`, `referenceAudioURLs` |
| Audio from source media (`:88-123`) | the source asset | cleanup/dubbing: `sourceURL = uploaded[0]`; other models: `videoURL = uploaded[0]` | `referenceAudioAssetIds = [id]` (audio source) or `referenceVideoAssetIds = [id]` (video source) via `setAudioSourceAsset` |
| Upscale (`Edit/EditSubmitter+Upscale.swift:24-83`) | the source asset | `sourceURL = uploaded[0]` | `imageURLAssetIds = [source id]`, `imageURLs = [url]` |

Audio extraction: for cleanup/dubbing models without reference support, when the source is a **video** or a trim is pending, the first reference is replaced by its audio track (AAC `.m4a`, trimmed if needed) before upload (`AudioGenerationSubmission.swift:88-103`, `Preprocessing/AudioTrackExtractor.swift`; error `Audio extraction failed: source has no audio track`). Linux: `ffmpeg -ss <start> -t <dur> -i src -vn -c:a aac out.m4a`.

### B4.4 `runJob` and monitoring (`:505-692`)

1. `jobId = submit()`. On error: message (Convex error payload `message`, else the error text) → every placeholder `failed(<message>)`, `onFailure()`, stop.
2. Every placeholder → `generating`, `backendJobId = jobId`; request a checkpoint autosave (so a crash can resume).
3. Monitor until terminal:
   - `queued`/`running`: ensure `generating` + `backendJobId` (+ `costCredits`); checkpoint when something changed. Placeholders already `downloading` are left alone.
   - `succeeded`: record `costCredits`; `finalizeSuccess(resultUrls)`.
   - `failed`: every placeholder → `failed(errorMessage ?? "Generation failed")`, keep `backendJobId`, set `costCredits` (if any) and `refundedCredits`; checkpoint; `onFailure()`.
   - Monitoring stream ends without a terminal update: if any placeholder has persisted `resultURLs`, finalize from them; else leave it `generating` (resumed on the next open).
   - No backend at all: `failed("Backend not configured")` (only when the job was just submitted).

### B4.5 `finalizeSuccess` and download (`:278-310,694-740`)

1. No URLs → every placeholder `failed("No URL in response")`, `onFailure()`.
2. For each placeholder: `k = generationInput.outputIndex ?? position`; missing URL → `failed("No URL for placeholder")`; else status `downloading`, `resultURLs = all URLs`, then download:
   1. Download to a temp file.
   2. If the remote URL path has an extension that is a known media extension and differs from the placeholder's, change the placeholder file name's extension (e.g. `gen-1A2B3C4D.jpg` → `.png`).
   3. Install with `commitStagedProjectMedia` (`01` §1.7) under that file name; `asset.url` = installed path.
   4. `pendingDownloadURL = undefined`; re-register the asset; `finalizeImportedAsset` (`EditorViewModel+MediaLibrary.swift:621-660`): load metadata (duration, size, fps, audio, thumbnail). Unreadable → `failed("Could not read media file.")`. Readable → status none, offline flags cleared, search index scheduled, waveform/thumbnails prepared, preview refreshed if the asset is on the timeline.
   5. Download error → `pendingDownloadURL = remote`, `failed(<error text>)` (the Preview shows **Retry Download**, `05` §5.3; `retryDownload` repeats step 2 for that URL).
   6. Success → `onComplete(placeholder)`.
3. If at least one placeholder finalized: desktop notification `Generation complete` with body (`App/AppNotifications.swift:133-154`): count > 1 → `<n> videos|audio clips|images|text clips|Lottie animations|subtitle files are ready in Palmier Pro.`; else `<name> is ready.` or `Your video|audio clip|image|… is ready.`; gated by the "Show notifications" setting (`05` §11.3); clicking it opens the project and reveals the asset. If none finalized → `onFailure()`.

**Linux BYOK additions:** providers that return bytes (OpenAI Images `b64_json`, Gemini `inlineData`, ElevenLabs binary audio, Gemini TTS raw PCM) are written straight to the staging file; Gemini TTS PCM (24 kHz, 16-bit, mono) must be wrapped in a WAV header and the placeholder extension changed to `.wav`. For byte results set `resultURLs` to nothing (there is no URL to re-download); for URL results store the provider URLs (they expire: fal ≥ 7 days, Replicate 1 h, Google Veo 2 days).

### B4.6 Preprocessing (Linux = ffmpeg) (`Generation/Preprocessing/*.swift`)

| Step | Mac | Linux command sketch |
|---|---|---|
| Trim extract (`VideoTrimExtractor`) | frames `[trimStart, trimStart + sourceFramesConsumed)` at **timeline fps** (`TrimmedSource.timeRange`), video + first audio track, highest quality, output fps = round(source nominal fps) if 24…60 else 30; `trim-<UUID>.mp4` in temp | `ffmpeg -ss S -t D -i src -map 0:v:0 -map 0:a:0? -c:v libx264 -crf 16 -r F -c:a aac out.mp4` with `S = trimStartFrame/fps`, `D = sourceFramesConsumed/fps` |
| Reference-video downscale (text-to-video video refs) | long side > 1100 → scale to long side 1100 (even dims), MP4 | `-vf scale='if(gt(iw,ih),1100,-2)':'if(gt(iw,ih),-2,1100)'` only when needed |
| Source-video transcode (edit models with `maxSourceVideoResolution` / `requiredSourceVideoEncoding`) | if over the limit (720p 1280×720, 1080p 1920×1080, 4k 3840×2160 by long/short side) scale down; if `h264-mp4` required and the file is not an `.mp4` whose video is entirely H.264 → re-encode | probe codec with ffprobe; `-c:v libx264 -pix_fmt yuv420p` |
| HEIC/HEIF/TIFF → JPEG | full resolution, q 0.92 | `sharp(file).jpeg({quality: 92})` (HEIC via libheif or ffmpeg) |
| Audio extract | AAC m4a, optional trim | see §B4.3 |

`TrimmedSource = {sourceURL, trimStartFrame, trimEndFrame, sourceFramesConsumed, fps}`; `hasTrim = trimStartFrame > 0 || trimEndFrame > 0`; `durationSeconds = sourceFramesConsumed / fps`. It is built from a timeline clip by `aiEditTrimmedSource(clipId)` only for video/audio assets with a non-zero trim (`EditorViewModel+AIEdit.swift:165-176`).

---

## B5. Status, persistence and resume

### B5.1 Status model (`Models/MediaAsset.swift:43-130`)

Cross-check with `01`: the `GenerationInput` field list in `01` §5.14 matches `Models/MediaManifest.swift:44-85` field for field, the persisted status strings match `MediaAsset.GenerationStatus.manifestValue`, and the restore rules in `01` §1.9 match `MediaAsset.swift:145-157` plus the project-open media restore (`Project/VideoProject.swift:640-690`). Nothing in `01` needs correcting; §B5.2 proposes one addition.

| Status | Persisted (`generationStatus`) | Label | Meaning |
|---|---|---|---|
| none | absent | — | ready (or never generated) |
| preparing | **never written** | `Preparing…` | placeholder created; references uploading |
| generating | `generating` | `Generating…` | job submitted |
| downloading | `downloading` | `Downloading…` | result being fetched |
| rendering | `rendering` | `Rendering…` | local render (Save as Media) — not generation |
| failed(msg) | `failed: <msg>` | — | failed overlay shows msg |

Predicates: `isGenerated = generationInput != null`; `isGenerating = preparing|generating|downloading|rendering`; `canResumeGeneration = backendJobId non-empty`; `isRecoveringGeneration = canResume && (isGenerating || (failed && resultURLs non-empty))`; `wasGenerationRefunded = failed && refundedCredits > 0` (→ "You were not charged for this generation", [CLOUD], never on Linux); `canEnhanceDraft = status none && draft == true && backendJobId && resultURLs.length ≥ 2` (the Mac's draft jobs return two URLs: the video and a draft cache). Linux: `status none && draft == true && byokJob != null && resultURLs.length ≥ 2 && the model's route supports enhance` (§B9.6).

Restore rule (`MediaAsset.swift:145-157`, `01` §1.9): a restored `preparing` becomes none unless resumable. On project open, after media restore, `resumePendingGenerations` runs (`VideoProject.swift:689`, `GenerationService.swift:360-391`): group recovering assets by `backendJobId`, sort each group by `outputIndex`, monitor each job once (no `onComplete`/`onFailure` callbacks — so replacement swaps and timeline clip-length patches requested before the reopen are **not** re-applied; quirk Q-B1).

### B5.2 Linux job handle (proposal — needs a `01` addendum)

The Mac's `backendJobId` is a Convex document id. The Linux port must not write provider job ids there (a signed-in Mac would subscribe to a non-existent Convex id and show the asset as generating forever). Instead add one Linux-only optional key inside `GenerationInput`:

```ts
interface ByokJobHandle {          // GenerationInput.byokJob — ignored by the Mac decoder, dropped on a Mac re-save
  provider: ByokProvider;          // 'fal' | 'replicate' | 'openai' | 'google' | 'elevenlabs' | 'xai' | 'minimax' | 'bfl' | 'runway' | 'kling' | 'byteplus' | 'topaz' | 'fishaudio' | …
  endpoint: string;                // e.g. "fal-ai/veo3.1/fast/image-to-video", "models/veo-3.1-fast-generate-preview"
  requestId: string;               // fal request_id, Replicate prediction id, Google operation name, ElevenLabs dubbing_id, …
  statusUrl?: string; responseUrl?: string; cancelUrl?: string;   // as returned by the provider (fal: use verbatim)
  submittedAt: string;             // ISO-8601
}
```

- Linux `canResumeGeneration = backendJobId non-empty || byokJob != null`; Linux resumes only `byokJob` jobs.
- Assets carrying only a Mac `backendJobId` are **foreign jobs**: never rewrite their fields (skip them in the project-open restore pass that would set `generating`, `01` §1.9); show them in the UI as failed with the non-persisted message `Started on macOS. Open this project in Palmier Pro on macOS to finish it.` If `resultURLs` exist, offer **Retry Download** (the URLs may have expired; a successful download finalizes the asset normally).
- Writing `byokJob` keeps `media.json` decodable on the Mac (synthesized `Decodable` ignores unknown keys); on the Mac the asset appears offline until the Linux job finishes.

---

## B6. Placeholders and timeline placeholders

### B6.1 Placeholder asset (`GenerationService.swift:245-276`)

- `id = UUID().toUpperCase()`; file `media/gen-<first 8 chars of id>.<ext>` (`mp4` video, `jpg` image and image-upscale, `mp3` audio, `mp4` video-upscale); `name` per §B4.1 (video models without a prompt use the model display name; upscale `Upscaled <name>`; music `model.displayName`); `duration = placeholderDuration`; `generationInput`; status `preparing`; `folderId`.
- Placeholder durations: image 5 s; video = requested duration (edit models: output duration if `usesOutputDuration`, else the effective source seconds; trimmed text-to-video ref: trim seconds); audio = `durationSeconds` if set, else 60 s for music and 10 s otherwise (`Utilities/Constants.swift:43-45`, `AudioGenerationSubmission.swift:154-159`); upscale = trimmed seconds or source duration (image 5 s).
- Added to the library and manifest immediately (`importMediaAsset`). **Not an undo step.** Deleting a generating placeholder is allowed (normal Delete Media, which is undoable). The Mac does not cancel the job: when it finishes, the result is still downloaded into `media/` and `importMediaAsset(skipAppend:true)` **re-adds the manifest entry** of the deleted asset (quirk Q-B5). Linux: on delete, cancel the provider job if the adapter supports it and ignore late results for assets no longer in the library (keep the job running only while an undo could restore the asset).
- Visuals: generating tile/preview overlay with the first `imageURLAssetIds`/`referenceImageAssetIds` image blurred behind it; failed tile; "AI" badge on generated assets (`05` §3.7, §4.5, §5.3).

### B6.2 Clips that wait for a generation

| Case | What is placed | Undo | On completion |
|---|---|---|---|
| Audio placement (Music section, AI Audio "Place on timeline", agent `generate_audio` with a timeline span) — `placeGeneratingAudioClip` (`EditorViewModel+GeneratedClips.swift:20-48`) | a clip for the placeholder at `startFrame`, `durationFrames = max(1, round(spanSeconds·fps))`, on the first audio track free over that span or a **new audio track at the bottom** (`resolveOrCreateAudioTrack`, `EditorViewModel+Linking.swift:460-465`), no linked audio | one step named by the action (`Add Music`, `Add Sound Effects`, `Add Cleaned Voice`, `Add Dubbed Voice`, agent: `Add <Category label>` inside `Add <label> (Agent)`) | `finalizeGeneratingClip`: on **every** timeline, every clip with that `mediaRef` gets `durationFrames = max(1, round(asset.duration·fps))`, trims reset to 0; **not** an undo step |
| AI transition (§B10) | a clip filling the gap exactly (no linked audio) | one step `AI Transition` | `finalizeTransitionClip`: `speed = realFrames / clip.durationFrames`, trims 0 (the clip keeps filling the gap; the real media is retimed to fit) |
| Replace clip source (AI Edit with "Replace clip source", timeline AI Edit actions, Rerun on a clip) | nothing placed; the clip and its same-media linked partners are flagged `pendingReplacements` (generating overlay on those clips, `Timeline/TimelineView.swift:957-975`) | — | first successful output only (`FirstOnlyFlag`): `replaceClipMediaRef(clipId, newAssetId, resetTrim = trimmed source was used)` → one undo step `Replace Clip Source` (preserves speed, volume, transform; resets trims when the new media covers only the trimmed span); then clear the flag. On failure: clear the flag |

A clip whose media is generating renders the generating overlay (`EditorViewModel+MediaLibrary.swift:560-563`).

---

## B7. Generate panel behaviour (`Generation/UI/*.swift`)

Visual spec: `05` §4.13. This section is the behaviour.

### B7.1 State and defaults (`GenerationView.swift:3-79`)

`selectedType = video`; per-type model index 0; `selectedDuration 5`; `selectedAspectRatio "16:9"`; `selectedResolution "1080p"`; `selectedQuality "high"`; `selectedNumImages 1`; audio: `selectedVoice ""`, `lyrics ""`, `styleInstructions ""`, `instrumental false`, `selectedAudioDuration 30`, `selectedTargetLanguage ""`, `multilingual false`; `generateAudio true`; `videoDraft false`; `upscaleSettings {}`; references empty; `videoInputMode frames`; prompt-height extra persisted as `generationPromptExtra` (px, clamped so the panel fits its slot; drag the 10 px top strip up to grow).

The panel is shown with `showGenerationPanel` (toggled by the media toolbar's Generate button with a 200 ms ease-in-out, opened by every seed, §B9). Opening it switches the media panel to its Media tab; closing it (× or toggle) clears all pending seed state (`EditorViewModel.swift:172-175`) and `editFolderId`. Its max height is the media panel height minus 60 px (`mediaAreaMinHeight`), and it is hidden while the media panel is collapsed or another panel is maximized (`MediaPanel/MediaTab/MediaTab.swift:133,582-589`).

### B7.2 Catalog readiness

`catalogReady = video, image and audio lists all non-empty (and upscale non-empty when the Upscale tab is selected)`; otherwise the panel shows a spinner + `Loading models…` (`05` §4.13). **Linux:** the catalog is local, so instead show an empty state when no provider key is configured: `Add an API key to generate media.` + **Open Settings** (→ Settings ▸ Models & API Keys). If a kind has no available model, hide that tab (the Mac hides Upscale when no upscaler exists).

### B7.3 Model lists and selection

- Available models = catalog order, minus disabled, minus unavailable (Mac: paid-only for free users; Linux: no key).
- Pickers: video grouped by `providerName` (group order = first appearance; header shows the provider logo of the group's first model); image flat; audio grouped by category in the order General, Speech, Music, Sound Effects, Voice Cleanup, Dubbing; upscale grouped `Image` then `Video` (a model supporting both appears in both). Each item shows the provider logo + display name. A divider and **Add models…** (opens Settings ▸ Models) end the menu.
- `normalizeModelSelection`: if the selected index is not available, select the first available (index 0 if none). Runs on appear (unless a seed is pending), when disabled ids change, when (Mac) the plan changes, when the type changes, and when the upscale source changes.

### B7.4 Reset rules

- **Type change:** normalize model; `resetSettings`; clear all references; audio type → `resetAudioState`; clear `editFolderId`; clear pending panel state but keep a pending clip replacement.
- **Video model change:** `resetSettings`; `videoInputMode = frames`; clear `sourceVideo` unless the model requires one; clear reference pools.
- **Image model change:** `resetSettings`. **Audio model change:** clear ref pools, `resetAudioState`. **Upscale model change:** reset upscale settings to normalized defaults.
- `resetSettings`: aspect → first supported if current unsupported (fallback `16:9`); resolution → first if unsupported (fallback `1080p`); quality → **last** if unsupported (fallback `high`); video duration → first if unsupported (fallback 5); video: `generateAudio = true`, `videoInputMode = requiresSourceVideo ? sourceVideo : frames` (not while seeding), `videoDraft = false` (kept while seeding if the model supports drafts); image: clamp count to 1…maxImages; audio: normalize duration.
- `resetAudioState`: `multilingual false`; voice = `defaultVoice ?? ""`; target language = `defaultTargetLanguage` if listed, else first, else `""`; clear lyrics / style / instrumental when unsupported; normalize duration (range → `defaultValue` if outside; list → first if not in list; fallback 30).

### B7.5 Inputs by mode

| Type / mode | Inputs shown | Notes |
|---|---|---|
| Video, `frames` | First Frame slot, and Last Frame slot if `supportsLastFrame` | shown when `supportsFirstFrame` and not in source mode; if `framesAndReferencesExclusive`, only in `frames` mode |
| Video, references | "References" grid with counter; shown when `supportsReferences`, not source mode, and (not exclusive or mode = `references`) | |
| Video, source (`Extend`, or model requires source) | Source Video slot (video only), Reference Image slot if `maxReferenceImages > 0`, Replacement Audio slot if `maxReferenceAudios > 0` | `usesSourceVideoInput = requiresSourceVideo \|\| (supportsSourceVideo && mode == sourceVideo)` |
| Image | References grid of images (any count) when `supportsImageReference` | drop of non-image → `Drop image here.` |
| Audio, source models | one source slot accepting audio and/or video per `inputs` (label `Source Audio` / `Source Video` / `Source Media`) | `audioUsesSource = acceptsSourceMedia && (!inputs.includes('text') \|\| audioSource != null)` |
| Audio, reference models | references grid (images + audios) when `supportsReferences && !audioUsesSource` | image refs in audio get **no** tag |
| Upscale | Source Media slot (video or image) | |

Video input-mode menu (shown when > 1 mode): `First/Last` always; `References` when exclusive and refs supported; `Extend` when `supportsSourceVideo && !requiresSourceVideo`. Choosing a mode clears the others' inputs (frames → clear refs and source; references → clear frames and source; extend → clear frames and refs).

**Reference pools** (`GenerationView+References.swift:220-263`): adding an asset already present → `<name> is already a reference`; wrong type for audio models → `<model> only accepts image or audio references.`; for video → `<model> only accepts <image and video and audio> references.` (joined with ` and `); then the whole candidate selection is validated with §B1.3 rules and the error flashed. The drop zone hides once the cap is reached (`maxTotalReferences` reached, or every active type at its cap; for audio models with `referenceImagesAndAudiosExclusive`, the active type is whichever pool is non-empty).

Counter label: video with `maxTotalReferences`: `<total>/<cap> · <n> img · <n> vid · <n> aud` (only active types); otherwise `<total>/<max single cap>`.

Tags: `@<Noun><n>` with noun `referenceTagNoun` for images in video mode (`Image` or `Element`), `Video`, `Audio`; numbering per type, 1-based, in pool order. Prompt `@` autocomplete lists exactly these tags (audio mode: only `Audio<n>`), with the same query rules as §A11.6; picking inserts `@<Tag> `; ↑/↓/Return/Esc as in the agent composer; popover min width 180; empty → `No matches`.

Drop sources: assets dragged from the media panel (payload one `palmier-asset://<id>` per line; `05` §4.9). Wrong-type single-slot drops flash `Drop <types joined with " or "> here.`. Every flashed error disappears after 3 s.

### B7.6 Settings popover and summary (`GenerationView+Settings.swift:246-466`)

- Fields: video Duration (`<n>s`), audio Duration (list, or a scrub field `<min>-<max>` with suffix ` s` when a range; not shown when the audio model uses source media), Aspect Ratio (image ids via `aspectRatioDisplayLabel`, adaptive grid min 78 px for images), Resolution (hidden while Draft is on; image labels via `resolutionDisplayLabel`), Quality (capitalized), Count (images, 1…maxImages), Instrumental, Multilingual (tooltip `Use for non-English or mixed-language audio.`), Generate audio (when `audioDiscountRate` exists; tooltip `Turn off to save <n>% on generation cost.` or `Turn off to skip audio generation.` — Linux: the second text).
- Picker style: ≤ 5 options and no grid width → segmented; else a grid (6 options → 3 columns, else 5).
- Summary text (button label): upscale → labels of `targetResolution` and `targetFPS` (`"source"` → `<round(fps)> FPS` or `Original FPS`), else `Settings`; audio → `<n>s` (if duration control and not source), `Instrumental`, `Multilingual`, else `Settings`; video/image → resolution (unless draft), quality, `<n>s` (video), aspect label, `×<n>` (image count > 1), joined with ` · `. A speaker icon reflects `generateAudio` when the toggle exists.
- `hasAnySettings` hides the button when nothing is configurable.
- **Draft** checkbox (video, `supportsDraft`): when on, resolution becomes `720p` and the resolution field hides. Tooltip `Generate a lower-cost 720p preview that can be enhanced later.`

Upscale settings (`GenerationView+UpscaleSettings.swift`): selects with ≤ 4 available options → segmented picker; more → menu grouped by `group` (section header `<group>: <groupDescription>`), items `<label>: <description>`, selected description shown below (9 px muted). Numeric settings → scrub field snapped to `minimum + k·step`, format `%.0f` (step ≥ 1) / `%.1f` (≥ 0.1) / `%.2f`, a reset button removes the override (unset numbers are **not sent**). Toggles → switches.

### B7.7 Submit enablement (`GenerationView+Submit.swift:6-40`)

Upscale: source present with known size (and fps for video), selected model available for it, every select value available. Video source mode: source present; image ref present if required; audio ref present if required; lip sync needs a non-zero billing duration; prompt models without reference support need a prompt. Video exclusive references mode: at least one reference. Audio: source mode → source present and (if target languages) a listed language chosen; text mode → `prompt.trim().length ≥ max(1, minPromptLength)`. Otherwise: non-empty prompt (whitespace-trimmed). Mac also requires affordable credits [CLOUD; drop].

### B7.8 Submit (`GenerationView+Submit.swift:197-474`)

1. Preflight (`preflightValidation`, §B1.3 messages; `Add source media.`, `<model> does not support this media type.`, `Loading source dimensions…`, `Loading source frame rate…`, `This model cannot cap the output at 60 FPS.`); on error flash it and stop.
2. Build `GenerationInput`: `prompt` (untrimmed), `model`, `duration` (video: `effectiveVideoSeconds`; audio: source seconds or selected duration or 0; upscale: effective seconds; image 0), `aspectRatio` (selected, even for audio/upscale), `resolution` (draft → `720p`; null when the model has no resolutions), `quality` (image with qualities), `voice`, `lyrics`, `styleInstructions`, `instrumental`, `targetLanguage`, `multilingual` (only when supported/non-empty), `generateAudio` (only when the toggle exists), `draft` (only when supported), `usesSourceVideo` (video only), `numImages` (only when > 1), `audioInput` = `text|audio|video` (audio only).
   - `effectiveVideoSeconds`: source mode without output durations → `billingDurationSeconds(effective source seconds, first replacement-audio duration)`; else `selectedDuration`.
3. Pending context captured from the seed (§B9): `replacementClipId`, `pendingAudioPlacement` (audio only), `transitionPlacement` (video only), `pendingEditTrimmedSource`.
4. Folder: `editFolderId` (seed asset's folder) ?? (video source mode: source's folder ?? last image ref's folder; text-to-video: last reference's folder; image: last reference's folder; audio: source's folder ?? last reference's folder) ?? the media panel's current folder. Upscale always uses the **source asset's** folder.
5. Submit per type with `VideoGenerationSubmission` / `ImageGenerationSubmission` / `AudioGenerationSubmission` / `EditSubmitter.submitUpscale` and callbacks: replacement swap (§B6.2), transition finalize, audio-placement finalize.
6. Then: place the transition clip / generating audio clip if pending; if not a replacement, **select the new placeholder in the media panel** (scrolls to it; `selectMediaPanelItem`).
7. Clear pending panel state; clear prompt, lyrics, style, `editFolderId`, all references. Settings stay.

### B7.9 Seeding (`populatePanel`, `GenerationView+Submit.swift:478-594`)

A seed is `{asset, stored: GenerationInput}` plus editor-side pending context. On consume: find the model by `stored.model` in the catalog (unknown → ignore the seed); switch type and model without triggering resets; copy prompt, aspect (if non-empty), resolution, quality, duration (> 0; also audio duration), count, voice, target language (if listed; else the default), multilingual, lyrics, style, instrumental, `generateAudio` (default true), draft; upscale settings (or model defaults). Clear references, then rebuild them from asset ids that still exist:
- video source models (or `usesSourceVideo`): `sourceVideo = imageURLAssetIds[0]`; image/video/audio refs from `reference*AssetIds`; if no image refs but the model takes them and `imageURLAssetIds` has a second id, use it as the reference image; mode `Extend`.
- video otherwise: first/last frame from `imageURLAssetIds` (respecting support); ref pools from `reference*AssetIds`; mode = `references` when exclusive and any ref, else `frames`.
- image: references = `imageURLAssetIds`.
- audio: reference models → pools; else `audioSource = referenceAudioAssetIds[0] ?? referenceVideoAssetIds[0]`.
- upscale: `upscaleSource = imageURLAssetIds[0] ?? asset`.
Then `editFolderId = asset.folderId`; upscale settings normalized for the source; other types `resetSettings`.

---

## B8. Music section (Audio tab ▸ Music) (`MediaPanel/AudioPanelTab/MusicTab.swift`, `Generation/Submission/MusicGenerationSubmission.swift`)

Hooks into `05` §4.14 (layout). Behaviour:

- Models: audio models with `category == music` and `inputs ∋ video` (catalog order). Selected id is remembered for the session; default = first. Picker row `Model` (reset → first model). Empty → `None`.
- Mode (`Input` row, shown only when the selected model also accepts text): `Video to Music` (default) / `Text to Music`. Effective mode is video when the model lacks text input.
- Video mode: row `Video` shows `Whole timeline · m:ss – m:ss · 12.3s` or, with a marked range, just the range (`clock` = `m:ss` of frame/fps). Tooltip `Uses the whole timeline by default. Mark a range on the timeline to score only that span.` Source span = the valid in/out range, else `[0, totalFrames)`; none if the timeline is empty.
- Text mode: `Duration` scrub field (default 90 s or the model's `durationRange.defaultValue`; range from the model or 1…600; `%.0f` + ` s`); selecting a model snaps the duration into its range/list. Placement frame = range start, else the playhead. Tooltip `Length of the generated music. It's placed at the playhead, or at the marked range start.`
- Prompt field (2–5 lines, placeholder = `promptLabel`).
- Validation note (red, 10 px medium): `No music models available.` · text mode: `Describe the music to generate.` or the model's param validation · video mode: `Add video to the timeline, then mark a range to score only part of it.` or the model's span validation · Mac only: insufficient credits.
- Generate (prominent capsule; label `Generate` — Mac adds the credit cost [CLOUD]) → `MusicGenerationSubmission.run`:
  1. Video mode: phase `Exporting…`: render the timeline span to MP4 **without audio**, short side 240 px, low-quality preset (`04` §11.6); phase `Uploading…`: upload it.
  2. Phase `Generating…`: params `{prompt: prompt ?? "", instrumental: false, durationSeconds: max(1, round(spanSeconds)), videoURL?}`; `GenerationInput {prompt, model, duration, aspectRatio: "", audioInput: "text"|"video", createdAt: now}`; name = model display name.
  3. Submit as an audio generation and place a generating clip at the span start (`Add Music`, §B6.2); on success finalize the clip length.
  4. A full-panel overlay (`GeneratingOverlay` at preview size with the phase label) stays until the job finishes or fails; a thrown error shows as the note.
- Agent Mode menu: §A14.

---

## B9. AI Edit (Generation/Edit, Inspector AI Edit tab, context menus)

### B9.1 Actions and availability (`Generation/Edit/EditAction.swift`)

Candidates per asset type: image `upscale, edit, rerun, createVideo`; video `upscale, edit, rerun, lipSync, reframe, enhanceDraft, generateMusic, generateSFX`; audio and text `upscale, edit, rerun` (all three end up disabled for audio); lottie, sequence, subtitle none. A menu shows only **available** actions; the inspector shows fixed tiles and disables unavailable ones with the reason as tooltip.

| Action | Available when (else disabled reason, verbatim) | Mac paid-only |
|---|---|---|
| `upscale` | video or image (`Upscale only works on video or images`); not generating (`Generation in progress`) | yes |
| `edit` | video: an edit model exists (`Edit model not available`), duration known (`Loading video metadata…`), ≤ 10 s (`Edit supports up to 10s (this is <n>s)`); image: always; audio/text/lottie/sequence/subtitle: `Edit doesn't support audio\|text\|Lottie\|sequences\|subtitles`; not generating | yes |
| `rerun` | generated asset (`Only available for AI-generated media`); not generating; its model still in the catalog (`Model no longer available`) | no |
| `lipSync` | video (`Lip Sync only works on video`); not generating; lip-sync model exists (`Lip Sync model not available`); source duration within `maxSourceVideoSeconds` | yes |
| `reframe` | video (`Reframe only works on video`); not generating; reframe model exists (`Reframe model not available`); duration ≤ `maxCombinedVideoRefSeconds` (or max duration) → `<model> supports source videos up to <limit>. Trim the clip to continue.` | yes |
| `generateMusic` / `generateSFX` | video (`Generate Music only works on video` / `Generate SFX only works on video`); not generating; duration known; model exists (`Sonilo model not available` / `Mirelo model not available`); span within the model's min/max seconds | no |
| `createVideo` | image (`Create Video only works on images`); not generating | no |
| `enhanceDraft` (FLUX Enhance) | `canEnhanceDraft` (`Draft already enhanced or cache unavailable`) | no — Mac [CLOUD], Linux [BYOK] (§B9.6) |

Durations use the clip's trimmed duration when the action comes from a clip with a trim (inspector: only while "Use trimmed portion only" is on).

Audio transforms (`AudioTransformEditKind.swift`): `cleanup` (title `Voice Cleanup`, description `Remove background sound and keep speech`, menu `Clean Up Voice…`, icon `waveform`, timeline action `Add Cleaned Voice`) and `dubbing` (`Dubbing`, `Translate speech into another language`, `Dub…`, `globe`, `Add Dubbed Voice`). Model = first audio model of that category. Available when the asset is audio or video (`Voice Cleanup requires audio or video` / `Dubbing requires audio or video`), video has audio (`Video has no audio track`), not generating, model exists (`Voice Cleanup model not available` / `Dubbing model not available`), model accepts the type (`<model> does not accept this media`), duration known (`Loading media metadata…`), span valid.

Video-to-audio kinds (`VideoToAudioEditKind.swift`): `music` (title `Generate Music`, menu `Generate Music…`, icon `music.note`, description `Generate music that fits the video`, timeline action `Add Music`, preferred id `sonilo-v1.1-video-to-music`, provider name `Sonilo`) and `sfx` (`Generate SFX`, `Generate SFX…`, `waveform`, `Create matching sound for the video`, `Add Sound Effects`, `mirelo-sfx-v1.5-video-to-audio`, `Mirelo`). Model = the preferred id if it is a video-input model of that category, else the first video-input model of the category whose id or display name contains the provider name. **Linux:** bind these preferred ids in the catalog to the BYOK equivalents (§B12.4) or the lookup fails and the actions disappear.

### B9.2 Seeds (`Generation/Edit/EditSubmitter+Seeds.swift`, `+Upscale.swift`, `+AudioTransform.swift`)

Every action opens the Generate panel pre-filled (§B7.9); only FLUX Enhance submits directly.

| Seed | `GenerationInput` | Notes |
|---|---|---|
| Upscale | `{prompt:"", model: first upscaler for the type (clip flows: first that supports the source), duration: effective seconds (trim-aware, min 1), aspectRatio:"", upscaleSettings: model defaults, imageURLAssetIds:[asset], upscaleSourceWidth/Height/FPS}` | |
| Edit | video: `{model: VideoModelConfig.edit}`; image: `{model: "nano-banana-pro"}`; `prompt:"", duration:0, aspectRatio:"", imageURLAssetIds:[asset]` | **Linux:** image edit model = the catalog's designated image-edit model (keep id `nano-banana-pro` bound to a Gemini/fal Nano Banana Pro endpoint) |
| Reframe | `{prompt: REFRAME_PROMPT, model: reframe model, duration: supportedDuration(covering trimmed-or-full seconds), aspectRatio: portrait source ? "16:9" : "9:16", resolution: preferredHighResolution, referenceVideoAssetIds:[asset]}` | `REFRAME_PROMPT` = `The exact same video as @Video1 but fill in to match the output aspect ratio. Keep movement, details, and audio the same as the original audio` |
| Lip sync | `{prompt:"", model: lip-sync model, duration:0, aspectRatio:"", imageURLAssetIds:[asset]}` | user then drops the replacement audio |
| Create video | first non-source model supporting references (as reference) or first frame (as first frame): `{prompt:"", duration:0, aspectRatio:"", referenceImageAssetIds:[asset]}` or `{imageURLAssetIds:[asset]}` | |
| Generate music / SFX | `{prompt:"", model, duration: round(asset.duration), aspectRatio:""}` + `setAudioSourceAsset(asset)` (video → `referenceVideoAssetIds`) | |
| Voice cleanup / dubbing | `{prompt:"", model, duration: max(1, round(override ?? asset.duration)), aspectRatio:""}` + `setAudioSourceAsset` | |
| Rerun | the asset's stored `generationInput` as is | |
| AI transition | §B10 | |

`prefixedName("Upscaled", asset)` strips one leading `Upscaled `/`Edited `/`Rerun ` before prefixing (`EditSubmitter.swift:15-21`).

### B9.3 Entry points and their context

| Entry point | Hooks into | Context passed to the seed |
|---|---|---|
| Media panel asset context menu ▸ **AI Edit** (`AIEditMenu.swift`) | `05` §4.x asset menu | asset only; sections `AI Enhance` (Upscale…, Edit…, Rerun, Lip Sync…, Reframe…, Create Video ▸ Set as first frame / Set as reference, FLUX Enhance) and `AI Audio` (Rerun for audio, Clean Up Voice…, Dub…, Generate Music…, Generate SFX…). Mac: whole menu disabled when not signed in; paid-only items show `<title> (Paid)` with a lock and open Settings ▸ Account. **Linux: show when the relevant model's provider has a key; no "(Paid)".** |
| Timeline clip menu ▸ **AI Edit ▸** (`Timeline/TimelineView+AIEditMenu.swift`) | `05` §6.14 | header `AI Enhance` then the enhance actions in candidate order; separator; header `AI Audio`: Rerun (audio), audio transforms, then Generate Music…/SFX…. Clip-aware: Edit, Reframe, Lip Sync, Upscale, Rerun, Create Video **replace the clip's source** on completion; Edit/Reframe/Lip Sync/Upscale use the clip's **trimmed range**; Music/SFX/Cleanup/Dub use the trimmed range and **place** the result on a new/free audio track at the clip start (`EditorViewModel+AIEdit.swift:29-131`). |
| Inspector **AI Edit** tab (`Inspector/Tabs/AIEditTab.swift`) | `05` §7.5.6 | toggles: `Use trimmed portion only` (default on; shown only for a trimmed clip), `Replace clip source` (default **off**; clip context only; applies to Upscale/Edit/Reframe/Lip Sync/Rerun/Create Video), `Place on timeline` (default on; clip context; applies to Music/SFX/Cleanup/Dub). Tiles call the same seeds. Audio transforms without a clip context seed with no placement. Disabled reason precedence: Mac `AI is unavailable` → `Sign in to use AI` → `Requires a paid plan` → availability reason. **Linux:** `Add a <Provider> API key to use this` → availability reason. |
| Agent tools (`02` §3.45–3.48) | — | the tools call the same submission builders directly (no panel). |

Audio placement for clip flows: `startFrame = clip.startFrame`, `spanSeconds = trimmed seconds ?? asset.duration ?? clip frames/fps`, at least one frame (`EditorViewModel+AIEdit.swift:178-193`).

### B9.4 Seeding mechanics (`EditorViewModel+AIEdit.swift:133-157`)

`seedGenerationPanel(asset, stored, replacementClipId?, trimmedSource?, audioPlacement?, transitionPlacement?)` cancels any pending transition capture (unless this is one), stores the pending context, sets `pendingPanelSeed`, and opens the panel; the panel consumes the seed on appear or when the seed's asset id changes. `clearPendingGenerationPanelState(preservingReplacement)` clears it (on submit, and on type change keeping the replacement).

### B9.5 Edit max duration

`EditAction.editMaxDurationSeconds = 10` (video Edit), independent of the model.

### B9.6 FLUX Enhance (draft → full quality) — Mac [CLOUD], Linux [BYOK]

Mac (`GenerationService.swift:312-358`): creates a placeholder `<name> 1080p` (same folder, mp4, the draft's duration) whose input copies the draft's with `draft:false`, `resolution:"1080p"`, cleared `backendJobId`/`resultURLs`/`costCredits`/`refundedCredits` and a new `createdAt`, then calls `generations:enhanceDraft(sourceJobId)`; toast `Enhanced with FLUX.3 at 1080p.` on success, the failure message otherwise. It works because the draft job returned two URLs (the 720p video and a draft cache; the test fixtures store `resultURLs:["video","cache"]`).

The same flow is public, so the port keeps it [BYOK]:

| Draft model | Draft request | Stored after the draft | Enhance request |
|---|---|---|---|
| `flux-3` via fal | `blackforestlabs/flux-3/{text-to-video,image-to-video,first-last-frame-to-video,extend-video}/draft` (same inputs as the base endpoint, no `resolution`) → `{video:{url}, draft_cache:{url}\|null}` | `resultURLs = [video.url, draft_cache.url]` (fal CDN, ≥ 7 days) | `blackforestlabs/flux-3/draft-enhance` `{draft_cache_url: resultURLs[1]}` → `{video:{url}}` |
| `flux-3` via BFL | `POST https://api.bfl.ai/v1/flux-3-video` `{mode, …, draft:true}` (drafts are `hd`) | `[result.sample, <draft cache URL>]` (result key **[UNCONFIRMED]**; BFL URLs expire ~2 h → download the cache bytes and keep them in the app cache) | `{mode:"draft_enhance", draft_cache:<URL or base64 of the .bin>, resolution:"fhd"}` |
| `seedance-2.5` via fal | `bytedance/seedance-2.5/*` with `draft:true` (480p) → `{video, draft_id}` | `[video.url, "seedance-draft:" + draft_id]` | `bytedance/seedance-2.5/draft/complete` `{draft_id}` (1080p) |

If a draft returns no cache (`draft_cache: null`) store one URL, so `canEnhanceDraft` is false and the action reads `Draft already enhanced or cache unavailable`. The toast text `Enhanced with FLUX.3 at 1080p.` is FLUX-specific on the Mac; for Seedance use `Enhanced with Seedance 2.5 at 1080p.`.

---

## B10. Create AI Transition (`Editor/ViewModel/EditorViewModel+AITransition.swift`, `Timeline/TimelineView.swift:1600-1612`)

Hooks into `05` §6.14 (empty-area menu on a gap).

1. **Availability** (`aiTransitionAvailability`): the gap is on a **video** track, starts after frame 0, length > 0; else no item. `seconds = length / fps`; `> 15` → item disabled with tooltip `Transitions are limited to 15 seconds. This gap is <x.x> seconds.`; Mac not signed in → `Sign in to generate.` (**Linux:** first+last-frame model has no key → `Add an API key for a video model that supports first and last frames.`); no first+last-frame model → `No video model supports first and last frames.`
2. **Begin:** placement `{timelineId, trackIndex, gapStartFrame, gapLengthFrames}`. In a cancellable task: capture the **composited timeline frame** at `gapStart − 1` as a media asset named `Transition start (frame <n>)`, then the frame at `gapStart + gapLength` named `Transition end (frame <n>)` (`captureFrameToMedia`, PNG `media/frame-<8hex>.png`, `01` §1.7). Between steps abort silently if the active timeline changed or the gap is no longer empty. Errors → media panel toast with the error text.
3. **Seed:** `{prompt: TRANSITION_PROMPT, model: firstAndLastFrame model, duration: nearestSupportedDuration(gapSeconds), aspectRatio:"", resolution: null, imageURLAssetIds:[start, end]}` with the transition placement; the panel opens on that model in frames mode. `TRANSITION_PROMPT` = `Create a seamless transition between the first frame and the last frame, one continuous take. No weird movements, effects, or artifacts. Natural and consistent motion that makes sense. No music, just appropriate SFX.`
4. **Submit** (user presses Generate): after submission, if the gap is still empty on the same timeline, place a clip for the placeholder exactly filling the gap (one undo step `AI Transition`); otherwise toast `The gap is no longer available, so the transition will land in Media instead.`
5. **Complete:** retime the clip to fit the gap (`speed = round(asset.duration·fps) / gapFrames`, trims 0), not undoable (§B6.2).

---

## B11. Credits, cost, project activity [CLOUD]

| Mac feature | Source | Linux |
|---|---|---|
| Credits chip in the panel header, credit popover | `CreditSummaryView` | drop (`05` §4.13) |
| Cost estimate label + red when unaffordable, "Generate · N credits", affordability gate | `Generation/Catalog/CostEstimator.swift`, `GenerationView+Submit.swift:42-124` | drop the label and the gate. Optional: show the provider's list price as a tooltip if you maintain prices in the catalog; never block submission. |
| "(Paid)" labels, `paidOnly`, Subscribe / Sign in prompts | various | drop |
| "You were not charged for this generation" | `wasGenerationRefunded` | never shown |
| **Project Activity** popover (`clock.arrow.circlepath`): `generations:projectActivity` list (credits, model, relative time, total) | `Editor/ProjectActivityView.swift` | **Replace** with a local list built from the library: every asset with `generationInput` (including failed), sorted by `createdAt` desc; row = type icon (`video.fill`/`photo.fill`/`music.note`/`arrow.up.right.square.fill`, failed in error colour), model display name, status (`Generating…`, `Failed`, ready), relative time. Header `Project Activity`; empty `No generations yet`; unsaved project `Save this project to view activity`. Width 340, list height 420. No credit totals. |

---

## B12. BYOK provider layer (Linux replacement for `generations:*`) [BYOK]

Everything in this section is a **proposal** for the port, grounded in the providers' public docs as checked on 2026-10-13. Items marked **[UNCONFIRMED]** could not be verified against an official page; implement them behind a feature flag and test with a real key.

### B12.0 Design

```ts
type ByokProvider = 'fal' | 'replicate' | 'openai' | 'google' | 'elevenlabs'          // tier 1: ship
                  | 'xai' | 'bfl' | 'minimax' | 'byteplus' | 'kling' | 'runway'      // tier 2: optional keys
                  | 'topaz' | 'ltx' | 'fishaudio' | 'mirelo' | 'sonilo'
                  | 'ideogram' | 'recraft' | 'reve' | 'krea';                        // generic-json image vendors used by the catalog

interface ByokRoute {                // one way to run a catalog model
  provider: ByokProvider;
  protocol: 'fal-queue' | 'replicate' | 'openai-images' | 'openai-speech' | 'gemini-content' | 'gemini-interactions'
          | 'gemini-lro' | 'elevenlabs' | 'bfl' | 'xai' | 'minimax' | 'byteplus-task' | 'byteplus-images'
          | 'kling' | 'runway' | 'topaz' | 'generic-json';   // generic-json = simple vendor REST (Ideogram, Recraft, Reve, Krea, LTX, Sonilo)
  endpoints: Record<string, string>; // keyed by mode (below)
  limits?: Partial<VideoCaps & ImageCaps & AudioCaps>;   // provider limits that override/narrow uiCapabilities
}
interface ByokBinding { routes: ByokRoute[] }            // catalog entry key `byok`; first route whose provider has a key wins
```

Endpoint keys by kind: video `t2v`, `i2v`, `flf` (first+last), `ref`, `edit` (source video: edit, extend, lip sync, motion control), `enhance` (draft enhance), `draft_suffix` (appended to the mode endpoint for draft runs, fal FLUX.3); image `t2i`, `edit` (with references); audio `gen`, `tts`, `music`, `t2m`/`v2m` (text/video to music), `sfx`, `v2a` (video to SFX), `cleanup`, `dub`; upscale `video`, `image`. `{tier}` inside a fal Kling endpoint is replaced from the resolution (`720p` → `standard`, `1080p` → `pro`, `4k` → `4k`).

Adapter contract (main process):

```ts
interface ProviderAdapter {
  /** Make a local file usable as an input: returns a URL, a data: URI, or an opaque handle for multipart/inline use. */
  prepareInput(file: { path: string; mime: string; size: number }): Promise<InputRef>;
  /** Start the job. Returns a resumable handle, or the finished outputs for synchronous APIs. */
  submit(route: ByokRoute, mode: string, params: VideoGenerationParams | ImageGenerationParams | AudioGenerationParams | UpscaleGenerationParams,
         inputs: InputRef[]): Promise<{ handle: ByokJobHandle } | { outputs: Output[] }>;
  poll(handle: ByokJobHandle): Promise<{ state: 'queued' | 'running' } | { state: 'succeeded'; outputs: Output[] } | { state: 'failed'; message: string }>;
  cancel?(handle: ByokJobHandle): Promise<void>;
}
type Output = { url: string; headers?: Record<string, string> } | { bytes: Buffer; mime: string };
```

`GenerationService` (Linux) is §B4 with: `submit` = adapter submit (store `byokJob` and set `generating` exactly where the Mac stores `backendJobId`); `monitor` = a poll loop (every 2 s for the first minute, then every 5 s; no overall timeout — the job is persisted and resumes on reopen); success → `finalizeSuccess` with the outputs (URLs are downloaded with the given headers; byte outputs are written directly, §B4.5); failure → `failed(<provider message>)`. The Mac's error strings `No URL in response`, `No URL for placeholder`, `Upload failed: <msg>`, `Could not read media file.` are kept.

Mode selection for video (which endpoint of a route): `edit` when the request has `sourceVideoURL`; `ref` when any `referenceImageURLs`/`referenceVideoURLs`/`referenceAudioURLs`; `flf` when both start and end frames; `i2v` when a start frame; else `t2v`. For image: `edit` when `imageURLs` non-empty, else `t2i`. For audio: by category / presence of `videoURL` / `sourceURL`.

Parameter mapping rules shared by all adapters:
- Duration: send the catalog value; if the provider takes strings (`"8"`) or suffixes (`"8s"`), convert. Never send a duration a route's `limits.durations` does not list — the catalog must already constrain it.
- Aspect ratio: Palmier values are `W:H` (`16:9`) or fal enums (`landscape_16_9`); keep the catalog's values identical to what the route expects and convert per provider: Ideogram `16x9`, DashScope `W*H`, OpenAI/Seedream `WxH` sizes (table in §B12.4.2).
- Resolution: send as the provider spells it (`720p`, `1080p`, `768P`, `1K`, `2K`, `4k`).
- `generateAudio`: send only to routes that expose an audio toggle.
- Prompt `@Image1`/`@Video1`/`@Audio1`/`@Element1` tags: pass through unchanged; the route must accept that tag syntax (Seedance, Kling elements, MiniMax refs) — otherwise rewrite to the provider's syntax in the adapter (e.g. Kling `@Element1` stays; Gemini Omni uses the order of inputs).
- `numImages > 1` on APIs that return one image per call: issue N calls in parallel and map output *k* to `outputIndex` *k*.

### B12.1 Generic protocols

#### fal.ai queue (`fal-queue`) — the universal fallback

- Auth header `Authorization: Key <FAL_KEY>`.
- Submit `POST https://queue.fal.run/<endpoint>` with the model's input JSON as the body (no wrapper). Response: `{"request_id","response_url","status_url","cancel_url","queue_position"}`. **Store and reuse the three URLs verbatim** (endpoint ids with sub-paths are handled differently by fal's own client).
- Status `GET <status_url>` → `{"status":"IN_QUEUE","queue_position":n,…}` | `{"status":"IN_PROGRESS",…}` | `{"status":"COMPLETED",…}`. A failed run is also `COMPLETED` but carries `error` (text) and `error_type`.
- Result `GET <response_url>` → the model output JSON. Errors from model validation come back as HTTP 422/500 with `{"detail":[{"loc":[…],"msg":"…","type":"content_policy_violation|…"}]}`; infrastructure errors as `{"detail":"…","error_type":"request_timeout|…"}`. Show `detail[0].msg` (or `detail`) as the failure message.
- Cancel `PUT <cancel_url>` → 202 `{"status":"CANCELLATION_REQUESTED"}` / 400 `ALREADY_COMPLETED` / 404 `NOT_FOUND`.
- Inputs: public URLs. Upload local files with `POST https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3` body `{"content_type":"video/mp4","file_name":"clip.mp4"}` → `{"upload_url","file_url"}`, then `PUT <upload_url>` with the raw bytes and `Content-Type`; pass `file_url`. Multipart for > 90 MB: `…/initiate-multipart`, 10 MB parts `PUT <upload_url path>/<partNumber><query>`, then `POST <path>/complete<query>` with `{"parts":[{"partNumber":1,"etag":"…"}]}`. (Taken from fal's official JS client source; the route answers 401 without a key. The prose docs do not document the REST shape — **[UNCONFIRMED field names, verify]**.) Data URIs are accepted by some models but fal advises against them above a few KB.
- Outputs: `File = {url, content_type?, file_name?, file_size?}`; video `{"video": File}`, image `{"images":[File + width,height]}`, audio `{"audio": File}` (some audio models use `audio_url`). Generated and uploaded CDN files live **at least 7 days** (cache uploads for 6 days, §B4.2).
- Per-endpoint OpenAPI: `GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>` — use it in a build-time test to validate every catalog route's field names.
- Concurrency: new fal accounts get 2 concurrent requests; extra submissions queue on fal's side (they show as `IN_QUEUE`).

#### Replicate (`replicate`)

- Auth `Authorization: Bearer <REPLICATE_API_TOKEN>`.
- Submit `POST https://api.replicate.com/v1/models/<owner>/<name>/predictions` body `{"input":{…}}` (optionally `Prefer: wait=N`, `Cancel-After: 1h`). Response = prediction `{id, status: starting|processing|succeeded|failed|canceled|aborted, output, error, urls:{get,cancel}}`.
- Poll `GET urls.get`; cancel `POST urls.cancel`.
- Inputs: URL, or a data URI ≤ 256 KB, or upload via `POST https://api.replicate.com/v1/files` (multipart `content=@file`) → use `urls.get` (send the Bearer header when downloading). Files expire (`expires_at`, ~1 h in the example) → don't cache.
- Output files expire **1 hour** after the prediction; download immediately. `output` is a URL string or an array of URLs.

#### Google Gemini API (`gemini-*`)

- Auth header `x-goog-api-key: <GEMINI_API_KEY>`; base `https://generativelanguage.googleapis.com/v1beta`.
- **Long-running video (`gemini-lro`, Veo 3.1) — do not ship as the primary route:** Google shuts down the Gemini API ids `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview` and `veo-3.1-lite-generate-preview` on **2026-10-22** (deprecations page; replacement `gemini-omni-1.1-flash`); the GA Veo ids exist only on Vertex AI (OAuth). Route `veo3.1-fast` through fal. For reference, the protocol was: `POST /models/<model>:predictLongRunning` body `{"instances":[{"prompt", "image"?: {"inlineData":{"mimeType","data"}}, "lastFrame"?: {…}, "referenceImages"?: [{"image":{…},"referenceType":"asset"}], "video"?: {…}}], "parameters":{"aspectRatio":"16:9|9:16","resolution":"720p|1080p|4k","durationSeconds":"4|6|8","negativePrompt"?,"personGeneration"?}}` → operation `{name}`; poll `GET /<operation.name>` until `done`; result `response.generateVideoResponse.generatedSamples[0].video.uri`, downloaded with the same API key header following redirects; safety blocks reported in `raiMediaFilteredCount`/`raiMediaFilteredReasons`. Generated videos are kept 2 days. (The python SDK sends images as `{"bytesBase64Encoded","mimeType"}`; the REST docs show `inlineData` — **[UNCONFIRMED which is canonical; test both]**.)
- **Images (`gemini-content`):** `POST /models/<model>:generateContent` body `{"contents":[{"parts":[{"text":"…"},{"inline_data":{"mime_type":"image/png","data":"<b64>"}}…]}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"aspectRatio":"16:9","imageSize":"2K"}}}` → `candidates[0].content.parts[].inlineData{mimeType,data}` (skip text/thought parts). One image per call. (`imageConfig` spelling from earlier official docs — **[partially confirmed]**.) Google now documents the **Interactions API** first: `POST /interactions` `{"model","input":[{"type":"text","text"},{"type":"image","mime_type","data"}],"response_format":{"type":"image","mime_type":"image/jpeg","aspect_ratio":"16:9","image_size":"2K"}}` → images in `steps[].content[]` `{type:"image", mime_type, data}`; both are supported.
- **Gemini Omni Flash video (`gemini-interactions`):** `POST /interactions` `{"model":"gemini-omni-1.1-flash","input":<prompt or parts with images/videos>,"response_format":{"aspect_ratio":"9:16","resolution":"360p|720p|1080p"}}` → video in `steps[].content[]` `{type:"video", mime_type:"video/mp4", data:<base64>}` (use `delivery:"uri"` for outputs > 4 MB); edit/extend inputs ≤ 10 s.
- **Speech / music:** see §B12.4.3.

#### OpenAI Images (`openai-images`)

- `POST https://api.openai.com/v1/images/generations` (JSON) and `POST /v1/images/edits` (multipart `image[]=@…` up to 16 references, or JSON `images:[{image_url}]`), `Authorization: Bearer <OPENAI_API_KEY>`. Synchronous.
- Body: `{"model","prompt","n":1-10,"size":"1024x1024|1536x1024|1024x1536|auto" (gpt-image-2/2.5 also any WxH: multiples of 16, ratio 1:3…3:1, ≤ 3840 per edge),"quality":"low|medium|high|auto" (2.5 adds xhigh|max),"output_format":"png|jpeg|webp","background"?}`.
- Response `{"data":[{"b64_json"}],…}` — always base64.

#### Black Forest Labs (`bfl`)

- `x-key: <BFL_API_KEY>`; `POST https://api.bfl.ai/v1/<model>` → `{"id","polling_url"}`; `GET polling_url` (with `x-key`) until `status:"Ready"` → `result.sample` (signed URL valid **10 minutes** — download immediately). Other statuses: `Pending`, `Request Moderated`, `Content Moderated`, `Error`, `Task not found`. Always use the returned `polling_url`.

### B12.2 Upload strategy per provider

| Provider | How references reach it | Upload cache |
|---|---|---|
| fal | fal CDN upload → `file_url` | 6 days |
| Replicate | Files API `urls.get` (or data URI ≤ 256 KB) | none |
| OpenAI | multipart file parts / data URL | none |
| Google | base64 `inline_data` (images ≤ 7 MB inline); videos for Veo extension inline base64 | none |
| ElevenLabs | multipart file upload in the request | none |
| BFL, xAI, BytePlus, MiniMax, Kling, Runway | public URL or base64 per API (§B12.4); when only URLs are accepted and the user has a fal key, upload to fal CDN and pass that URL; otherwise use the provider's own upload API if it has one | per provider |

Reference preprocessing (§B4.6) happens before upload regardless of provider. Add provider-specific downscaling when a provider caps input size (e.g. Gemini 7 MB inline → JPEG re-encode).

### B12.3 Catalog `byok` binding

Each catalog entry carries `byok: { routes: ByokRoute[] }` (§B12.0). Rules:
- A model is **available** when at least one route's provider has a key (and the id is not disabled). The first such route is used. Settings ▸ Models shows unavailable models disabled with `Add a <Provider> key` (Linux replacement of the Mac's lock/Subscribe state).
- Linux-only optional `aliases: string[]` lets old ids resolve to an entry (e.g. `seedance-2` → `seedance-2.0`) for Rerun and `GenerationInput.model` lookups without duplicate picker rows.
- Prompt-tag rewriting per protocol (Palmier writes `@Image1`, `@Video1`, `@Audio1`, `@Element1`):

| Route | Tag syntax the provider expects | Rewrite |
|---|---|---|
| fal Seedance 2.x, fal Kling V3/O3, fal Veo reference, fal legacy Grok | `@Image1`, `@Video1`, `@Audio1`, `@Element1` | none |
| xAI direct, fal Grok v1.5 | `<IMAGE_0>`, `<AUDIO_0>` (zero-based) | `@Image<n>` → `<IMAGE_{n-1}>` |
| BytePlus Seedance | `[Image 1]` / `@Image 1` | `@Image<n>` → `[Image <n>]` |
| MiniMax direct (v2) | plain words "Image 1", "reference video 1", "reference audio 1" | `@Image<n>` → `Image <n>`, `@Video<n>` → `reference video <n>`, `@Audio<n>` → `reference audio <n>` |
| fal MiniMax H3 reference-to-video | **[UNCONFIRMED]** — test; fall back to the MiniMax rewrite | |
| Kling official | `<<<image_1>>>` | `@Image<n>` → `<<<image_<n>>>>` |

### B12.4 Mapping: every catalog model → BYOK endpoint

Confidence: **confirmed** = endpoint and fields read from the provider's official docs or machine-readable schema on 2026-10-13; **partially** = endpoint confirmed, some fields not; **unconfirmed** = could not be verified.

#### B12.4.1 Video

**Authoritative research: [`research/byok-video-apis.md`](research/byok-video-apis.md)** (fal OpenAPI schemas and vendor docs checked 2026-10-13: full field lists, request/response examples, limits, sources). The table below is the decision digest only; take field names and limits from that file (section numbers in brackets).

| Catalog id (proposed) | Display | Default route: fal | Vendor / other routes | Capabilities used in the catalog | Confidence / notes |
|---|---|---|---|---|---|
| `minimax-h3` | MiniMax H3 | `minimax/h3/{text-to-video,image-to-video,reference-to-video}` | MiniMax v2 `MiniMax-H3`; Replicate `minimax/h3` [§5] | durations 5…15; `768P`, `2K`; aspects 16:9 9:16 1:1 4:3 3:4 21:9; first+last; refs 9/3/3, ≤ 12, 15 s combined video/audio; frames **xor** refs | confirmed — fal's durations, resolutions and reference counts/caps equal the Mac test fixture (`Tests/PalmierProTests/Generation/ReframeSeedTests.swift:153-184`); the fixture itself has no first/last frame, only `16:9 9:16 1:1`, `framesAndReferencesExclusive:false` and `referenceTagNoun:"Video"` — the Linux entry follows fal (frames xor refs, `@Image<n>` tags). First video model: tools' default, the **reframe** model and the AI-transition model (§B1.2) |
| `hailuo-03-max` (alias `hailuo-03`) | MiniMax H3 Max | `minimax/h3-max/{…}` | MiniMax v2 `MiniMax-H3-Max` [§5] | durations 5…15; `768P`, `1080P`, `480P`; refs as H3 | confirmed; "Hailuo-03" is MiniMax's internal name for H3 — H3 vs H3 Max unconfirmed |
| `seedance-2.0` (alias `seedance-2`) | Seedance 2 | `bytedance/seedance-2.0/{text-to-video,image-to-video,reference-to-video}` | BytePlus `dreamina-seedance-2-0-260128`; Replicate [§2] | durations 4…15; `720p` (default per agent instructions), `1080p`, `480p`, `4k`; refs 9/3/3 ≤ 12; frames xor refs; audio toggle | confirmed |
| `seedance-2-fast`, `seedance-2-mini` | Seedance 2 Fast / Mini | `bytedance/seedance-2.0/{fast,mini}/…` | BytePlus `-fast-260128`, `-mini-260615` [§2] | as Seedance 2 with `720p`, `480p` | confirmed |
| `seedance-2.5` | Seedance 2.5 | `bytedance/seedance-2.5/{…}` + `/draft/complete` | BytePlus `dreamina-seedance-2-5-260628` [§2] | durations 4…30; `720p`, `1080p`, `480p`; refs 30/10/10 ≤ 50; **draft** (§B9.6) | confirmed (1080p on fal T2V/I2V unconfirmed) |
| `grok-imagine-video` | Grok Imagine Video | `xai/grok-imagine-video/v1.5/{text-to-video,image-to-video,reference-to-video}` — route `limits`: no last frame, no audio toggle, ≤ 7 refs at 480p/720p, tags `<IMAGE_0>` | xAI `grok-imagine-video-1.5` (adds last frame, keyframes, `generate_audio`, 14 refs) [§4] | durations 1…15; `720p`, `480p`, `1080p`; aspects 16:9 9:16 1:1 4:3 3:4 3:2 2:3 21:9; first(+last via xAI); 7 image refs | confirmed |
| `flux-3` | FLUX.3 | `blackforestlabs/flux-3/{text-to-video,image-to-video,first-last-frame-to-video,extend-video}` + `/draft`, `/draft-enhance` | BFL `POST /v1/flux-3-video` [§6] | durations 5,6,8,10,12,15,20; `720p`, `1080p`; aspects 16:9 9:16 1:1 4:3 3:4 21:9 2:1; first+last; **draft**; Extend (source < 15 s) | confirmed |
| `veo3.1-fast` | Veo 3.1 Fast | `fal-ai/veo3.1/fast` (+ `/image-to-video`, `/first-last-frame-to-video`, `/reference-to-video` 8 s only) | none usable after 2026-10-22 (Gemini API preview ids shut down; GA ids are Vertex/OAuth only) [§1] | durations 4,6,8; 16:9, 9:16; `720p`, `1080p`, `4k`; first+last; 3 image refs (adapter forces 8 s); audio toggle | confirmed |
| `kling-v3` | Kling V3 | `fal-ai/kling-video/v3/{tier}/{text-to-video,image-to-video}` | Kling official (elements pre-created) [§3] | durations 3…15; `1080p`→pro, `720p`→standard, `4k`; 16:9 9:16 1:1; first+last; 3 refs as elements (`referenceTagNoun:"Element"`; each ref → `{frontal_image_url, reference_image_urls:[url]}`) | confirmed (element packing is the port's choice) |
| `kling-o3` | Kling O3 | `fal-ai/kling-video/o3/{tier}/reference-to-video` (+ t2v/i2v) | Kling official omni [§3] | durations 3…15; 16:9 9:16 1:1; first+last; 7 image refs (`@Image1`); audio default off | confirmed |
| `ltx-2.5-pro` | LTX 2.5 Pro | `lightricks/ltx-2.5/{text-to-video,image-to-video}/pro` | LTX `/v2/*` `ltx-2-5-pro` [§7] | durations 6,8,10; `1080p`, `1440p`, `2160p`; 16:9 9:16; first+last | confirmed |
| `wan-3.0` | Wan 3.0 | `alibaba/wan-3.0/{text-to-video,image-to-video,reference-to-video}` | DashScope (Wan 3.0 on `dashscope-intl` unconfirmed) [§7] | durations 5,10,15; `720p`, `1080p`, `480p`; refs 10/5/5 | partially |
| `kling-o3-edit` | Kling O3 Edit | `fal-ai/kling-video/o3/pro/video-to-video/edit` | — [§3] | source video ≤ 15 s, prompt, ≤ 4 image refs | confirmed. **First edit model** → `VideoModelConfig.edit` |
| `runway-aleph-2` | Runway Aleph 2.0 | — (not on fal) | Runway `POST /v1/video_to_video` `aleph2` [§7] | source video ≤ 30 s, prompt | confirmed; tier-2 key |
| `kling-v3-motion-control` | Kling V3 Motion Control | `fal-ai/kling-video/v3/{standard,pro}/motion-control` | — [§3] | source video ≤ 30 s + 1 required image | confirmed |
| `veed-lipsync-v2` | VEED Lip Sync v2 | `veed/lipsync/v2`, then `fal-ai/sync-lipsync/v2` | Sync.so `POST /v2/generate` [§8] | no prompt; source video + 1 replacement audio → `VideoModelConfig.lipSync` | confirmed (VEED length limit unconfirmed) |
| `gemini-omni-flash-1.1` (optional) | Gemini Omni Flash 1.1 | — | Google Interactions `gemini-omni-1.1-flash` (§B12.1) | `360p`, `720p`, `1080p`; refs; durations undocumented | partially — not in the catalog JSON |
| Happy Horse / Happy Horse Edit | — | — | **no public API found** | — | omit |
| `kling-reframe` | ("Legacy Reframe" test fixture) | **do not add** — it satisfies `isEdit` and would take the Edit slot; Reframe uses H3 (§B9.2). Purpose-built alternatives if wanted: `fal-ai/ltx-2.3/reframe`, Luma `luma/agent/ray/v3.2/reframe`, Runway `aleph2` + `targetAspectRatio` [§3] | | | — |

Not reproducible with any key: whatever Palmier's backend adds around the provider call (content-policy retries, refunds, prompt rewriting, if any).

#### B12.4.2 Image

| Catalog id (proposed) | Display | Recommended route → endpoint | Fallback | Mapping notes | Confidence |
|---|---|---|---|---|---|
| `gpt-image-2` | GPT Image 2 | openai `POST /v1/images/generations` `model:"gpt-image-2"`; with refs `POST /v1/images/edits` (≤ 16 images) | fal `openai/gpt-image-2`, `openai/gpt-image-2/edit` (`image_size`, `quality`, `num_images` 1–4, `image_urls` ≤ 16) | Palmier models this one with **WxH resolutions** (skill example `resolution:"1024x1536"`): `size = resolution`; `quality`; `n = numImages`; result `b64_json` | confirmed |
| `gpt-image-2.5` | GPT-2.5 Image | openai, `gpt-image-2.5-flare` (generate) / `gpt-image-2.5-sunburst` (edits) | fal `openai/gpt-image-2.5/{flare,sunburst}/{text-to-image,edit}` | as above; qualities add `xhigh`, `max` | confirmed (released 2026-09-08) |
| `nano-banana-pro` | Nano Banana Pro | google `gemini-content`, model `gemini-3-pro-image` | fal `fal-ai/nano-banana-pro`, `/edit` (`aspect_ratio`, `resolution` 1K/2K/4K, `image_urls`) | `imageConfig.aspectRatio = aspectRatio`, `imageSize = resolution`; refs as `inline_data`; one image per call → loop `numImages` | ids confirmed; `imageConfig` spelling partially |
| `nano-banana-2` | Nano Banana 2 | google `gemini-3.1-flash-image` | fal `fal-ai/nano-banana-2`, `/edit` | adds aspects `1:4 4:1 1:8 8:1`; up to 14 refs | confirmed ids. Google's deprecations page (2026-10-13) lists `gemini-3.1-flash-image` with migration target `gemini-nano-banana-2.1` and **no shutdown date**; keep the 3.1 id, add 2.1 as a second Google route once tested |
| `nano-banana-lite` | Nano Banana Lite | google `gemini-3.1-flash-lite-image` | — | 1K only | confirmed id |
| `seedream-v5-pro` | Seedream 5.0 Pro | fal `bytedance/seedream/v5/pro/text-to-image` (`image_size` presets / `auto_2K`, `num_images` 1–6) | byteplus `POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations` `model:"seedream-5-0-pro-260628"`, `image:[urls]` ≤ 10, `size:"1K\|2K"`, **no** `sequential_image_generation` | Palmier aspect ids are fal enums (`landscape_16_9` …; plain `16:9` errors). For references use BytePlus `image[]`, or fal `fal-ai/bytedance/seedream/v5/lite/edit` (Pro edit id **[UNCONFIRMED]**) | fal t2i confirmed; BytePlus partially |
| `grok-imagine` | Grok Imagine 2 | xai `POST https://api.x.ai/v1/images/generations` `model:"grok-imagine-image-2.0"` (`aspect_ratio`, `resolution` 1k/1.5k/2k, `n` ≤ 10, `response_format`) | fal `xai/grok-imagine-image` | Palmier: no references "yet" (`supportsImageReference:false`); xAI edits exist (`/v1/images/edits`, ≤ 5 inputs) if you enable them | confirmed |
| `ideogram-v4` | Ideogram V4 | ideogram `POST https://api.ideogram.ai/v2/image/generate/ideogram-4` (JSON, `Api-Key` header) | fal `ideogram/v4`, `fal-ai/ideogram/v3` | aspect `16:9` → `16x9`; URLs expire quickly → download at once | confirmed (aspect enum partially) |
| `recraft-v4.1` | Recraft V4.1 | recraft `POST https://external.api.recraft.ai/v1/images/generations` `model:"recraftv4_1"` | fal `fal-ai/recraft/v4.1/text-to-image` | `size` `WxH`; `n` 1–6 | partially (size list) |
| `reve-2.1` | Reve 2.1 | fal `reve/2.1/remix` (refs) / Reve API `POST https://api.reve.com/v1/image/create` | `fal-ai/reve/edit` | Reve API returns base64 PNG; aspects `16:9 9:16 3:2 2:3 4:3 3:4 1:1` | partially (official docs need login) |
| `krea-2-large` | Krea 2 Large | krea `POST https://api.krea.ai/generate/image/krea/krea-2/large` → `job_id`; poll `GET /jobs/{id}` → `result.urls[]` | — | `aspect_ratio` `1:1 4:3 3:2 16:9 2.35:1 4:5 2:3 9:16`; `resolution` `1K`; one image → loop | confirmed |
| `mai-image-2.5` | MAI Image 2.5 | **no confirmed public API** | — | omit | unconfirmed |
| `muse-image` | Muse Image (Meta) | **no public API** | — | omit | — |

#### B12.4.3 Audio

| Catalog id (proposed) | Category / inputs | Recommended route | Fallback | Mapping notes | Confidence |
|---|---|---|---|---|---|
| `elevenlabs-v4-tts` | tts / text | elevenlabs `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128` body `{text, model_id:"eleven_v4"}`, header `xi-api-key` → binary MP3 | fal `elevenlabs/tts/eleven-v4` (`voice` name or id) | `voices` = names from `GET /v2/voices` (fetched at runtime; map name → `voice_id`; default voices expire 2026-12-31 — never hard-code ids); style = inline tags (`[whispers]`) → `supportsStyleInstructions:false`; 10 000-char limit | confirmed |
| `gemini-tts` | tts / text | google `POST /models/gemini-3.8-flash-tts:generateContent` `{"contents":[{"role":"user","parts":[{"text":prompt,"speechMetadata":{"style":styleInstructions}}]}],"generationConfig":{"responseModalities":["AUDIO"],"responseFormat":{"audio":{"mimeType":"AUDIO_WAV","sampleRate":24000}},"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":voice}}}}}` → `inlineData` base64 **WAV** (24 kHz mono) | fal `google/gemini-3.8-flash-tts` | voices: Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat; default `Kore`; `supportsStyleInstructions:true`; the 2.5/3.1 preview TTS models (`gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-tts-preview`) shut down 2026-11-17 — this is why the Linux entry binds 3.8 although Palmier's docs say "Gemini 3.1 Flash TTS" | confirmed (deprecations page re-read 2026-10-13) |
| `elevenlabs-music` | music / text | elevenlabs `POST /v1/music` `{prompt, music_length_ms: durationSeconds·1000, force_instrumental: instrumental, model_id:"music_v2_5"}` → binary MP3 | fal `elevenlabs/music/v2.5` | `durationRange {minimum:3, maximum:600, defaultValue:90}` (API 3 000–600 000 ms; FAQ says 5 min — keep 600 for parity with the tool text, surface API errors); free ElevenLabs keys have music concurrency 0 | confirmed |
| `minimax-music-2.6` | music / text | fal `fal-ai/minimax-music/v2.6` `{prompt (10–2000), lyrics (≤ 3500), is_instrumental, lyrics_optimizer}` | replicate `minimax/music-2.6`; fal `minimax/music-3` (open weights, `duration` 1–300) | `supportsLyrics:true`, `supportsInstrumental:true`, `minPromptLength:10`, no duration control. MiniMax's own music API is **closed to new users since 2026-08-20** | partially (fal upstream availability unconfirmed) |
| `lyria-3-pro` | music / text (+image) | google `POST /models/lyria-3-pro-preview:generateContent` `{"contents":[{"parts":[{"text":prompt},(image inline_data)]}],"generationConfig":{"responseModalities":["AUDIO","TEXT"]}}` → `inlineData` MP3 (+ lyric text parts) | fal `fal-ai/lyria3/pro`; GA `lyria-3.5` | instrumental, lyrics, tempo, language only via the prompt (matches Palmier's instruction text); no duration control (~184 s max) | confirmed |
| `sonilo-v1.1-video-to-music` | music / video + text | fal `sonilo/v1.1/video-to-music` `{video_url, prompt, prompt_influence, duration 1–600, num_samples:1}`; text mode `sonilo/v1.1/text-to-music` `{prompt, duration 1–600 (90)}` | Sonilo API `POST https://api.sonilo.com/v1/video-to-music` (multipart, `mode=async`, poll `GET /v1/tasks/{id}`) and `/v1/text-to-music` (5–360 s) | `inputs:["video","text"]`, `minSeconds:1`, `maxSeconds:600`, `durationRange {1,600,90}`; output AAC/m4a → keep extension from URL | confirmed |
| `sonilo-sfx` | sfx / video | fal `sonilo/v1.1/video-to-sound-effects` `{video_url, prompt, audio_format:"wav"}` | Sonilo `POST /v1/video-to-sfx` (≤ 480 s) | | confirmed |
| `mirelo-sfx-v1.5-video-to-audio` | sfx / video | fal `mirelo-ai/sfx-v1.5/video-to-audio` `{video_url, text_prompt?, duration 1–10, num_samples:2, start_offset:0}` → `audio[0]` | replicate `mirelo/video-to-sfx-v1.5` (muxed video → demux) | `maxSeconds:10` (longer input is truncated by the provider — Palmier's span validation must reject > 10 s), `minPromptLength:0`; take the first of ≥ 2 samples | confirmed |
| `elevenlabs-sfx` | sfx / text | elevenlabs `POST /v1/sound-generation` `{text, duration_seconds, prompt_influence:0.3, model_id:"eleven_text_to_sound_v2"}` | fal `fal-ai/elevenlabs/sound-effects/v2` (0.5–22 s) | `durationRange {1,30,5}` | confirmed |
| `elevenlabs-voice-isolator` | cleanup / audio, video | elevenlabs `POST /v1/audio-isolation` multipart `audio=@file` → MP3 | fal `fal-ai/elevenlabs/audio-isolation` (`audio_url`/`video_url`) | Mac extracts the audio track first for video sources (§B4.3); `maxSeconds:3600` | confirmed |
| `elevenlabs-dubbing` | dubbing / audio, video | elevenlabs legacy `POST /v1/dubbing` multipart `{file, source_lang:"auto", target_lang}` → `{dubbing_id}`; poll `GET /v1/dubbing/{id}` (`dubbing\|dubbed\|failed`); download `GET /v1/dubbing/{id}/audio/{lang}` | v2 project flow (`/v1/dubbing/project` → language → FLAC URL); fal `fal-ai/elevenlabs/dubbing` (returns video → extract audio) | send the extracted audio (§B4.3) so the result is MP3; `targetLanguages` = ElevenLabs dubbing codes (maintain the list from their docs — exact list **[UNCONFIRMED]**), `defaultTargetLanguage:"es"` | confirmed (flow) |
| `seed-audio-1.0` | general / text (+audio/image refs) | fal `bytedance/seed-audio-1.0` `{prompt, voice?, audio_urls ≤ 3, image_url?, multilingual}` | BytePlus `POST https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/create` (`X-Api-Key`) | Palmier's `referenceAudioURLs`/`referenceImageURL`/`multilingual`/`@Audio1..3` map 1:1: `maxReferenceAudios:3`, `maxReferenceAudioSeconds:30`, `referenceAudioExtensions:["wav","mp3"]`, `maxReferenceImages:1`, `referenceImagesAndAudiosExclusive:true`, `supportsMultilingual:true` | fal confirmed |
| `fish-s2.1-pro` (optional) | tts / text | fishaudio `POST https://api.fish.audio/v1/tts` header `model: s2.1-pro`, `{text, reference_id, format:"mp3"}` | — | voices from `GET https://api.fish.audio/model` | confirmed |
| `openai-gpt-4o-mini-tts` (Linux-only optional) | tts / text | openai `POST /v1/audio/speech` `{model:"gpt-4o-mini-tts", input, voice, instructions, response_format:"mp3"}` | — | 13 static voices (alloy ash ballad coral echo fable onyx nova sage shimmer verse marin cedar); `instructions` = style instructions | confirmed |

ElevenLabs has **no** public video-to-SFX endpoint; it does have `POST /v1/music/video-to-music` (multipart, ≤ 600 s) — usable as an alternative route for Generate Music when the user has only an ElevenLabs key.

#### B12.4.4 Upscale

Palmier's upscaler settings are generic `select`/`number`/`toggle` lists (§B1.1); the adapter translates them. `targetResolution` values must be `1080p` or `4k` (the availability filter maps any value other than `1080p` to a 3840-px long edge, `UpscaleModelConfig.swift:159-161`).

| Catalog id | Types | Route | Settings (proposed) → provider fields | Confidence |
|---|---|---|---|---|
| `topaz-video-upscaler` | video | fal `fal-ai/topaz/upscale/video` | `targetResolution` {1080p, 4k} → `upscale_factor = clamp(targetLongEdge / sourceLongEdge, 1, 4)`; `targetFPS` {source, 24, 30, 60} → `target_fps` (omit for `source`); `enhancementModel` {Proteus (default), Artemis HQ/MQ/LQ, Gaia HQ/CG, Nyx, Starlight variants} → `model`; numbers `noise`, `compression`, `halo`, `recover_detail` (0–1, step 0.01), `grain` (0–0.1) → same names; always `H264_output:true` | confirmed |
| `topaz-image-upscaler` | image | fal `fal-ai/topaz/upscale/image` | `targetResolution` → `upscale_factor`; `enhancementModel` {Standard V2, High Fidelity V2, Low Resolution V2, CGI, Text Refine, Redefine, Recovery V2} → `model` | confirmed |
| `bytedance-upscaler` | video | fal `fal-ai/bytedance-upscaler/upscale/video` | `targetResolution` {1080p, 4k} → `target_resolution`; `targetFPS` {source, 30, 60} → `target_fps` (**no "source" value — send the probed fps clamped to 24…120**); optional select `enhancementPreset` {general, ugc, short_series, aigc, old_film} → `enhancement_preset` | confirmed |
| `seedvr-image-upscaler` | image | fal `fal-ai/seedvr/upscale/image` | `targetResolution` {1080p, 4k} → `upscale_mode:"target"`, `target_resolution:"1080p"\|"2160p"`; number `noise` (0–1) → `noise_scale` | confirmed |
| `seedvr-video-upscaler` | video | fal `fal-ai/seedvr/upscale/video` | as image + `output_format:"X264 (.mp4)"` | confirmed |
| FLUX Video Upscale | video | **no public API found** | — | — |

Topaz's own API (`https://api.topazlabs.com/video/` create → accept → multipart S3 upload → complete-upload → poll; `X-API-Key`) is an alternative for users with a Topaz key; fal is far simpler (URL in, URL out).

### B12.5 Proposed Linux catalog (JSON)

The complete, machine-readable catalog (every `CatalogEntry` field from §B1.1 plus `byok` routes and `aliases`) is in **[`06-generation-catalog.json`](06-generation-catalog.json)** next to this file (46 models; generated and shape-checked against §B1.1's required keys). Ship it as `resources/generation-catalog.json`. The table below is a one-row-per-model digest of that file.

How to read it:
- `primary` = the first route's provider and endpoint ids; `fallbacks` = further routes tried in order when the primary provider has no key. `{tier}` in Kling endpoints is chosen from the resolution (`720p` → `standard`, `1080p` → `pro`, `4k` → `4k`).
- `defaults.panel` = what the Generate panel selects when it starts from its initial state (`selectedDuration 5`, `selectedAspectRatio "16:9"`, `selectedResolution "1080p"`, `selectedQuality "high"`, falling back to the first listed value, or the last quality; §B7.4). `defaults.tool` = what the agent tools use when the argument is omitted (`02` §3.45–3.46: first duration/aspect/resolution, last quality).
- List order matters: the first model of a kind is the tools' default; the first lip-sync, edit (`isEdit`), reframe (`isReframeModel`) and first+last-frame model drive AI Edit and AI Transition (§B1.2).
- Video `flags`: `framesXorRefs` = `framesAndReferencesExclusive`; `sourceVideo` = `requiresSourceVideo`; `draft` / `extend` / `audioToggle` = presence of `draftCreditsPerSecond` / `sourceVideoCreditsPerSecond` / `audioDiscountRate` (§B1.2); `tag@Element` = `referenceTagNoun`.
- Capabilities are the **providers'** documented limits (§B12.4), not Palmier's private catalog values (unknown, Part E #1). The only values known from Palmier's own code are the MiniMax H3 test fixture (fal matches its durations, resolutions and reference caps; frames/aspects differ, see §B12.4.1) and the "Legacy Reframe" fixture (deliberately not included).

```json
[
{"id": "minimax-h3", "kind": "video", "displayName": "MiniMax H3", "provider": "MiniMax", "primary": "fal:minimax/h3/image-to-video|minimax/h3/reference-to-video|minimax/h3/text-to-video", "fallbacks": ["minimax", "replicate"], "durations": [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "resolutions": ["768P", "2K"], "frames": "first+last", "refs": "9img/3vid/3aud (≤12)", "flags": ["framesXorRefs"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "768P"}, "tool": {"duration": 5, "aspectRatio": "16:9", "resolution": "768P"}}},
{"id": "hailuo-03-max", "kind": "video", "displayName": "MiniMax H3 Max", "provider": "MiniMax", "primary": "fal:minimax/h3-max/image-to-video|minimax/h3-max/reference-to-video|minimax/h3-max/text-to-video", "fallbacks": ["minimax"], "durations": [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "resolutions": ["768P", "1080P", "480P"], "frames": "first+last", "refs": "9img/3vid/3aud (≤12)", "flags": ["framesXorRefs"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "768P"}, "tool": {"duration": 5, "aspectRatio": "16:9", "resolution": "768P"}}},
{"id": "seedance-2.0", "kind": "video", "displayName": "Seedance 2", "provider": "ByteDance", "primary": "fal:bytedance/seedance-2.0/image-to-video|bytedance/seedance-2.0/reference-to-video|bytedance/seedance-2.0/text-to-video", "fallbacks": ["byteplus", "replicate"], "durations": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "resolutions": ["720p", "1080p", "480p", "4k"], "frames": "first+last", "refs": "9img/3vid/3aud (≤12)", "flags": ["framesXorRefs", "audioToggle"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 4, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "seedance-2-fast", "kind": "video", "displayName": "Seedance 2 Fast", "provider": "ByteDance", "primary": "fal:bytedance/seedance-2.0/fast/image-to-video|bytedance/seedance-2.0/fast/reference-to-video|bytedance/seedance-2.0/fast/text-to-video", "fallbacks": [], "durations": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "resolutions": ["720p", "480p"], "frames": "first+last", "refs": "9img/3vid/3aud (≤12)", "flags": ["framesXorRefs", "audioToggle"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "720p"}, "tool": {"duration": 4, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "seedance-2-mini", "kind": "video", "displayName": "Seedance 2 Mini", "provider": "ByteDance", "primary": "fal:bytedance/seedance-2.0/mini/image-to-video|bytedance/seedance-2.0/mini/reference-to-video|bytedance/seedance-2.0/mini/text-to-video", "fallbacks": [], "durations": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "resolutions": ["720p", "480p"], "frames": "first+last", "refs": "9img/3vid/3aud (≤12)", "flags": ["framesXorRefs", "audioToggle"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "720p"}, "tool": {"duration": 4, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "seedance-2.5", "kind": "video", "displayName": "Seedance 2.5", "provider": "ByteDance", "primary": "fal:bytedance/seedance-2.5/draft/complete|bytedance/seedance-2.5/image-to-video|bytedance/seedance-2.5/reference-to-video|bytedance/seedance-2.5/text-to-video", "fallbacks": ["byteplus"], "durations": [4, 5, 6, 8, 10, 12, 15, 20, 25, 30], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "resolutions": ["720p", "1080p", "480p"], "frames": "first+last", "refs": "30img/10vid/10aud (≤50)", "flags": ["framesXorRefs", "draft", "audioToggle"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 4, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "grok-imagine-video", "kind": "video", "displayName": "Grok Imagine Video", "provider": "xAI", "primary": "xai:grok-imagine-video-1.5", "fallbacks": ["fal"], "durations": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"], "resolutions": ["720p", "480p", "1080p"], "frames": "first+last", "refs": "7img/0vid/0aud", "flags": ["audioToggle"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 1, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "flux-3", "kind": "video", "displayName": "FLUX.3", "provider": "Black Forest Labs", "primary": "fal:blackforestlabs/flux-3/draft-enhance|blackforestlabs/flux-3/extend-video|blackforestlabs/flux-3/first-last-frame-to-video|blackforestlabs/flux-3/image-to-video|", "fallbacks": ["bfl"], "durations": [5, 6, 8, 10, 12, 15, 20], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "2:1"], "resolutions": ["720p", "1080p"], "frames": "first+last", "refs": "0img/0vid/0aud", "flags": ["draft", "extend", "audioToggle", "maxSource15s"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 5, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "veo3.1-fast", "kind": "video", "displayName": "Veo 3.1 Fast", "provider": "Google", "primary": "fal:fal-ai/veo3.1/fast|fal-ai/veo3.1/fast/first-last-frame-to-video|fal-ai/veo3.1/fast/image-to-video|fal-ai/veo3.1/fast/reference-to-video", "fallbacks": [], "durations": [4, 6, 8], "aspectRatios": ["16:9", "9:16"], "resolutions": ["720p", "1080p", "4k"], "frames": "first+last", "refs": "3img/0vid/0aud", "flags": ["framesXorRefs", "audioToggle"], "defaults": {"panel": {"duration": 4, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 4, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "kling-v3", "kind": "video", "displayName": "Kling V3", "provider": "Kling", "primary": "fal:fal-ai/kling-video/v3/{tier}/image-to-video|fal-ai/kling-video/v3/{tier}/text-to-video", "fallbacks": [], "durations": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1"], "resolutions": ["1080p", "720p", "4k"], "frames": "first+last", "refs": "3img/0vid/0aud", "flags": ["audioToggle", "tag@Element"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 3, "aspectRatio": "16:9", "resolution": "1080p"}}},
{"id": "kling-o3", "kind": "video", "displayName": "Kling O3", "provider": "Kling", "primary": "fal:fal-ai/kling-video/o3/{tier}/image-to-video|fal-ai/kling-video/o3/{tier}/reference-to-video|fal-ai/kling-video/o3/{tier}/text-to-video", "fallbacks": [], "durations": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "aspectRatios": ["16:9", "9:16", "1:1"], "resolutions": ["1080p", "720p", "4k"], "frames": "first+last", "refs": "7img/0vid/0aud", "flags": ["audioToggle"], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 3, "aspectRatio": "16:9", "resolution": "1080p"}}},
{"id": "ltx-2.5-pro", "kind": "video", "displayName": "LTX 2.5 Pro", "provider": "LTX", "primary": "fal:lightricks/ltx-2.5/image-to-video/pro|lightricks/ltx-2.5/text-to-video/pro", "fallbacks": ["ltx"], "durations": [6, 8, 10], "aspectRatios": ["16:9", "9:16"], "resolutions": ["1080p", "1440p", "2160p"], "frames": "first+last", "refs": "0img/0vid/0aud", "flags": ["audioToggle"], "defaults": {"panel": {"duration": 6, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 6, "aspectRatio": "16:9", "resolution": "1080p"}}},
{"id": "wan-3.0", "kind": "video", "displayName": "Wan 3.0", "provider": "Alibaba", "primary": "fal:alibaba/wan-3.0/image-to-video|alibaba/wan-3.0/reference-to-video|alibaba/wan-3.0/text-to-video", "fallbacks": [], "durations": [5, 10, 15], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4"], "resolutions": ["720p", "1080p", "480p"], "frames": "first+last", "refs": "10img/5vid/5aud", "flags": [], "defaults": {"panel": {"duration": 5, "aspectRatio": "16:9", "resolution": "1080p"}, "tool": {"duration": 5, "aspectRatio": "16:9", "resolution": "720p"}}},
{"id": "kling-o3-edit", "kind": "video", "displayName": "Kling O3 Edit", "provider": "Kling", "primary": "fal:fal-ai/kling-video/o3/pro/video-to-video/edit", "fallbacks": [], "durations": [], "aspectRatios": [], "resolutions": null, "frames": "none", "refs": "4img/0vid/0aud", "flags": ["sourceVideo", "maxSource15s"], "defaults": {"panel": {"duration": null, "aspectRatio": "", "resolution": null}, "tool": {"duration": null, "aspectRatio": null, "resolution": null}}},
{"id": "runway-aleph-2", "kind": "video", "displayName": "Runway Aleph 2.0", "provider": "Runway", "primary": "runway:aleph2", "fallbacks": [], "durations": [], "aspectRatios": [], "resolutions": null, "frames": "none", "refs": "0img/0vid/0aud", "flags": ["sourceVideo", "maxSource30s"], "defaults": {"panel": {"duration": null, "aspectRatio": "", "resolution": null}, "tool": {"duration": null, "aspectRatio": null, "resolution": null}}},
{"id": "kling-v3-motion-control", "kind": "video", "displayName": "Kling V3 Motion Control", "provider": "Kling", "primary": "fal:fal-ai/kling-video/v3/pro/motion-control", "fallbacks": [], "durations": [], "aspectRatios": [], "resolutions": null, "frames": "none", "refs": "1img/0vid/0aud", "flags": ["sourceVideo", "needsRefImage", "maxSource30s"], "defaults": {"panel": {"duration": null, "aspectRatio": "", "resolution": null}, "tool": {"duration": null, "aspectRatio": null, "resolution": null}}},
{"id": "veed-lipsync-v2", "kind": "video", "displayName": "VEED Lip Sync v2", "provider": "VEED", "primary": "fal:veed/lipsync/v2", "fallbacks": ["fal"], "durations": [], "aspectRatios": [], "resolutions": null, "frames": "none", "refs": "0img/0vid/1aud", "flags": ["sourceVideo", "needsRefAudio", "noPrompt"], "defaults": {"panel": {"duration": null, "aspectRatio": "", "resolution": null}, "tool": {"duration": null, "aspectRatio": null, "resolution": null}}},
{"id": "gpt-image-2", "kind": "image", "displayName": "GPT Image 2", "provider": "OpenAI", "primary": "openai:gpt-image-2", "fallbacks": ["fal"], "aspectRatios": [], "resolutions": ["1536x1024", "1024x1536", "1024x1024", "2048x1152", "1152x2048", "2048x2048", "3840x2160", "2160x3840"], "qualities": ["low", "medium", "high"], "refs": true, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "", "resolution": "1536x1024", "quality": "high"}, "tool": {"aspectRatio": null, "resolution": "1536x1024", "quality": "high"}}},
{"id": "gpt-image-2.5", "kind": "image", "displayName": "GPT-2.5 Image", "provider": "OpenAI", "primary": "openai:gpt-image-2.5-flare|gpt-image-2.5-sunburst", "fallbacks": ["fal"], "aspectRatios": [], "resolutions": ["1536x1024", "1024x1536", "1024x1024", "2048x1152", "1152x2048", "2048x2048", "3840x2160", "2160x3840"], "qualities": ["low", "medium", "high", "xhigh", "max"], "refs": true, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "", "resolution": "1536x1024", "quality": "high"}, "tool": {"aspectRatio": null, "resolution": "1536x1024", "quality": "max"}}},
{"id": "nano-banana-pro", "kind": "image", "displayName": "Nano Banana Pro", "provider": "Google", "primary": "google:gemini-3-pro-image", "fallbacks": ["fal"], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"], "resolutions": ["1K", "2K", "4K"], "qualities": null, "refs": true, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}}},
{"id": "nano-banana-2", "kind": "image", "displayName": "Nano Banana 2", "provider": "Google", "primary": "google:gemini-3.1-flash-image", "fallbacks": ["fal"], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1"], "resolutions": ["1K", "2K", "4K"], "qualities": null, "refs": true, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}}},
{"id": "nano-banana-lite", "kind": "image", "displayName": "Nano Banana Lite", "provider": "Google", "primary": "google:gemini-3.1-flash-lite-image", "fallbacks": [], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"], "resolutions": ["1K"], "qualities": null, "refs": true, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}}},
{"id": "seedream-v5-pro", "kind": "image", "displayName": "Seedream 5.0 Pro", "provider": "ByteDance", "primary": "fal:bytedance/seedream/v5/pro/text-to-image|fal-ai/bytedance/seedream/v5/lite/edit", "fallbacks": ["byteplus"], "aspectRatios": ["landscape_16_9", "portrait_16_9", "square_hd", "landscape_4_3", "portrait_4_3", "square"], "resolutions": null, "qualities": null, "refs": true, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "landscape_16_9", "resolution": null, "quality": null}, "tool": {"aspectRatio": "landscape_16_9", "resolution": null, "quality": null}}},
{"id": "grok-imagine", "kind": "image", "displayName": "Grok Imagine 2", "provider": "xAI", "primary": "xai:grok-imagine-image-2.0", "fallbacks": ["fal"], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "21:9"], "resolutions": ["1k", "1.5k", "2k"], "qualities": null, "refs": false, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": "1k", "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": "1k", "quality": null}}},
{"id": "ideogram-v4", "kind": "image", "displayName": "Ideogram V4", "provider": "Ideogram", "primary": "ideogram:v2/image/generate/ideogram-4", "fallbacks": ["fal"], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "16:10", "10:16", "2:1", "1:2", "3:1", "1:3"], "resolutions": null, "qualities": null, "refs": true, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": null, "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": null, "quality": null}}},
{"id": "recraft-v4.1", "kind": "image", "displayName": "Recraft V4.1", "provider": "Recraft", "primary": "recraft:recraftv4_1", "fallbacks": ["fal"], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"], "resolutions": null, "qualities": null, "refs": false, "maxImages": 4, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": null, "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": null, "quality": null}}},
{"id": "reve-2.1", "kind": "image", "displayName": "Reve 2.1", "provider": "Reve", "primary": "fal:reve/2.1/remix", "fallbacks": ["reve"], "aspectRatios": ["16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "1:1"], "resolutions": null, "qualities": null, "refs": true, "maxImages": 1, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": null, "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": null, "quality": null}}},
{"id": "krea-2-large", "kind": "image", "displayName": "Krea 2 Large", "provider": "Krea", "primary": "krea:generate/image/krea/krea-2/large", "fallbacks": [], "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:2", "2:3", "4:5", "2.35:1"], "resolutions": ["1K"], "qualities": null, "refs": true, "maxImages": 1, "defaults": {"panel": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}, "tool": {"aspectRatio": "16:9", "resolution": "1K", "quality": null}}},
{"id": "seed-audio-1.0", "kind": "audio", "displayName": "Seed Audio 1.0", "provider": "ByteDance", "primary": "fal:bytedance/seed-audio-1.0", "fallbacks": [], "category": "general", "inputs": ["text"], "minPromptLength": 1, "maxReferenceImages": 1, "maxReferenceAudios": 3, "maxReferenceAudioSeconds": 30, "flags": ["multilingual", "refsExclusive"]},
{"id": "elevenlabs-v4-tts", "kind": "audio", "displayName": "ElevenLabs v4 TTS", "provider": "ElevenLabs", "primary": "elevenlabs:eleven_v4", "fallbacks": ["fal"], "category": "tts", "inputs": ["text"], "voices": ["<fetched at runtime from GET /v2/voices>"], "minPromptLength": 1, "flags": []},
{"id": "gemini-tts", "kind": "audio", "displayName": "Gemini 3.8 Flash TTS", "provider": "Google", "primary": "google:gemini-3.8-flash-tts", "fallbacks": ["fal"], "category": "tts", "inputs": ["text"], "voices": ["Kore", "Zephyr", "Puck", "Charon", "…30 total"], "defaultVoice": "Kore", "minPromptLength": 1, "flags": ["style"]},
{"id": "elevenlabs-music", "kind": "audio", "displayName": "ElevenLabs Music", "provider": "ElevenLabs", "primary": "elevenlabs:music_v2_5", "fallbacks": ["fal"], "category": "music", "inputs": ["text"], "durationRange": {"minimum": 3, "maximum": 600, "defaultValue": 90}, "minPromptLength": 1, "flags": ["instrumental"]},
{"id": "minimax-music-2.6", "kind": "audio", "displayName": "MiniMax Music 2.6", "provider": "MiniMax", "primary": "fal:fal-ai/minimax-music/v2.6", "fallbacks": ["replicate"], "category": "music", "inputs": ["text"], "minPromptLength": 10, "flags": ["lyrics", "instrumental"]},
{"id": "lyria-3-pro", "kind": "audio", "displayName": "Lyria 3 Pro", "provider": "Google", "primary": "google:lyria-3-pro-preview", "fallbacks": ["fal"], "category": "music", "inputs": ["text"], "minPromptLength": 1, "flags": []},
{"id": "sonilo-v1.1-video-to-music", "kind": "audio", "displayName": "Sonilo Music", "provider": "Sonilo", "primary": "fal:sonilo/v1.1/text-to-music|sonilo/v1.1/video-to-music", "fallbacks": ["sonilo"], "category": "music", "inputs": ["video", "text"], "durationRange": {"minimum": 1, "maximum": 600, "defaultValue": 90}, "minPromptLength": 0, "minSeconds": 1, "maxSeconds": 600, "flags": []},
{"id": "elevenlabs-sfx", "kind": "audio", "displayName": "ElevenLabs Sound Effects", "provider": "ElevenLabs", "primary": "elevenlabs:eleven_text_to_sound_v2", "fallbacks": ["fal"], "category": "sfx", "inputs": ["text"], "durationRange": {"minimum": 1, "maximum": 30, "defaultValue": 5}, "minPromptLength": 1, "flags": []},
{"id": "mirelo-sfx-v1.5-video-to-audio", "kind": "audio", "displayName": "Mirelo SFX v1.5", "provider": "Mirelo", "primary": "fal:mirelo-ai/sfx-v1.5/video-to-audio", "fallbacks": [], "category": "sfx", "inputs": ["video"], "minPromptLength": 0, "minSeconds": 1, "maxSeconds": 10, "flags": []},
{"id": "sonilo-sfx", "kind": "audio", "displayName": "Sonilo Sound Effects", "provider": "Sonilo", "primary": "fal:sonilo/v1.1/video-to-sound-effects", "fallbacks": ["sonilo"], "category": "sfx", "inputs": ["video"], "minPromptLength": 0, "minSeconds": 1, "maxSeconds": 480, "flags": []},
{"id": "elevenlabs-voice-isolator", "kind": "audio", "displayName": "ElevenLabs Voice Isolator", "provider": "ElevenLabs", "primary": "elevenlabs:audio-isolation", "fallbacks": ["fal"], "category": "cleanup", "inputs": ["audio", "video"], "minPromptLength": 0, "minSeconds": 1, "maxSeconds": 3600, "flags": []},
{"id": "elevenlabs-dubbing", "kind": "audio", "displayName": "ElevenLabs Dubbing", "provider": "ElevenLabs", "primary": "elevenlabs:dubbing", "fallbacks": ["fal"], "category": "dubbing", "inputs": ["audio", "video"], "minPromptLength": 0, "minSeconds": 1, "maxSeconds": 3600, "targetLanguages": ["es", "fr", "de", "it", "pt", "ja", "ko", "zh", "hi", "ar", "ru", "nl", "pl", "tr", "en"], "defaultTargetLanguage": "es", "flags": []},
{"id": "openai-gpt-4o-mini-tts", "kind": "audio", "displayName": "OpenAI TTS", "provider": "OpenAI", "primary": "openai:gpt-4o-mini-tts", "fallbacks": [], "category": "tts", "inputs": ["text"], "voices": ["alloy", "ash", "ballad", "coral", "…13 total"], "defaultVoice": "marin", "minPromptLength": 1, "flags": ["style"]},
{"id": "topaz-video-upscaler", "kind": "upscale", "displayName": "Topaz Upscale", "provider": "Topaz", "primary": "fal:fal-ai/topaz/upscale/video", "fallbacks": [], "supportedTypes": ["video"], "speed": "Slow", "settings": {"targetResolution": {"default": "4k", "options": ["1080p", "4k"]}, "targetFPS": {"default": "source", "options": ["source", "24", "30", "60"]}, "enhancementModel": {"default": "Proteus", "options": ["Proteus", "Artemis HQ", "Artemis MQ", "Artemis LQ", "Gaia HQ", "Gaia CG", "Nyx", "Starlight Precise 2.5"]}, "noise": {"range": [0, 1], "step": 0.01}, "compression": {"range": [0, 1], "step": 0.01}, "halo": {"range": [0, 1], "step": 0.01}, "recover_detail": {"range": [0, 1], "step": 0.01}, "grain": {"range": [0, 0.1], "step": 0.01}}},
{"id": "topaz-image-upscaler", "kind": "upscale", "displayName": "Topaz Upscale (Image)", "provider": "Topaz", "primary": "fal:fal-ai/topaz/upscale/image", "fallbacks": [], "supportedTypes": ["image"], "speed": "Medium", "settings": {"targetResolution": {"default": "4k", "options": ["1080p", "4k"]}, "enhancementModel": {"default": "Standard V2", "options": ["Standard V2", "High Fidelity V2", "Low Resolution V2", "CGI", "Text Refine", "Redefine", "Recovery V2"]}}},
{"id": "bytedance-upscaler", "kind": "upscale", "displayName": "Bytedance Upscaler", "provider": "ByteDance", "primary": "fal:fal-ai/bytedance-upscaler/upscale/video", "fallbacks": [], "supportedTypes": ["video"], "speed": "Medium", "settings": {"targetResolution": {"default": "4k", "options": ["1080p", "4k"]}, "targetFPS": {"default": "source", "options": ["source", "30", "60"]}, "enhancementPreset": {"default": "general", "options": ["general", "ugc", "short_series", "aigc", "old_film"]}}},
{"id": "seedvr-image-upscaler", "kind": "upscale", "displayName": "SeedVR2 (Image)", "provider": "ByteDance", "primary": "fal:fal-ai/seedvr/upscale/image", "fallbacks": [], "supportedTypes": ["image"], "speed": "Fast", "settings": {"targetResolution": {"default": "4k", "options": ["1080p", "4k"]}, "noise": {"range": [0, 1], "step": 0.05}}},
{"id": "seedvr-video-upscaler", "kind": "upscale", "displayName": "SeedVR2 (Video)", "provider": "ByteDance", "primary": "fal:fal-ai/seedvr/upscale/video", "fallbacks": [], "supportedTypes": ["video"], "speed": "Slow", "settings": {"targetResolution": {"default": "4k", "options": ["1080p", "4k"]}, "noise": {"range": [0, 1], "step": 0.05}}}
]
```

---

## B13. Agent generation tools on Linux (deltas to `02` §3.44–3.48)

The tool contracts stay; only the gates and catalog semantics change.

| Mac behaviour | Linux replacement (exact strings proposed) |
|---|---|
| `canGenerate` in `get_timeline` / `manage_project` = signed in && has credits (`ToolExecutor+Timeline.swift:49`) | `canGenerate = at least one catalog model is available (its provider has a key)` |
| `Generation requires signing in to Palmier. Tell the user to sign in.` / `Upscale requires signing in to Palmier. Tell the user to sign in.` | `Generation requires an API key. Tell the user to add one in Settings ▸ Models & API Keys.` (upscale: same with `Upscale requires …`). Raised when **no** model of the requested kind is available. |
| `Out of credits. Tell the user to add credits or subscribe to keep generating.` | never raised |
| `Model catalog not loaded yet. Try again in a moment.`; `list_models` → `loaded:false` before sync | catalog is always loaded: `loaded:true` |
| default model = first catalog model allowed on the plan; `No video model is available on the current plan. Tell the user to subscribe.` | default = first **available** model; error `No <kind> model is available. Tell the user to add an API key for one in Settings ▸ Models & API Keys.` |
| `Model '<m>' requires a paid plan. …` | replaced by `Model '<m>' needs a <Provider> API key. Tell the user to add one in Settings ▸ Models & API Keys.` |
| `list_models` hides `paidOnly` models for free accounts | hides models whose provider has no key and models in `disabledModelIds`; rows otherwise identical (`02` §3.44) |
| `generate_video` with `enhanceDraftMediaRef` | same contract and errors (`Draft not found: <id>`, `Asset '<id>' is not a completed enhanceable draft.`); runs the §B9.6 enhance request. `list_models` reports `supportsDraft` only for models whose available route has a draft flow |
| Job failure surfaces via `get_media` `generationStatus: "failed: <msg>"` | same; the message is the provider's error (§B12.1) |

Keep the agent instruction text unchanged (§A4.1) for parity; the model sees `canGenerate` and these tool errors, which are enough.

---

# Part C — Hook map: every agent/generation feature and where it plugs in

| Feature | Behaviour spec | UI spec | Data spec | Engine spec | Class |
|---|---|---|---|---|---|
| Agent panel (tabs, history, messages, composer, pickers) | §A2, §A3, §A11 | `05` §2.6 | `01` §5.15 | — | [BYOK] Anthropic/OpenAI key |
| Agent tools | §A8 | — | — | `02` §3, Appendix A; `03` ops | [LOCAL] (generation tools [BYOK]) |
| System prompt | §A4 | — | — | `02` §4, `02-mcp-tools.tools.json#serverInstructions` | [LOCAL] |
| Skills in the agent | §A13 | `05` §11.7 | `~/.palmier/skills` (`02` §5) | — | [LOCAL] (+ public GitHub catalog) |
| Mentions (composer @, media tile "Add to chat", clip "Add to Chat", "Add Range to Chat") | §A12 | `05` §4.5, §6.14 | `01` §5.15 `AgentMention` | `03` §5.7 track labels | [LOCAL] |
| Agent hand-offs (Organize with Agent, Captions/Music "Agent Mode") | §A14 | `05` §4.3, §4.14 | — | — | [BYOK] |
| "Now editing" system notice | §A2.1 | — | `01` §5.15 (`role:"system"`) | `02` §3.50 `manage_project` | [LOCAL] |
| Change/read highlights after agent tools | `02` §1.6 step 8 | `05` §6.5, §1.1 agent glows | — | — | [LOCAL] |
| Hosted agent route, credits, "Log in for 250 free credits", PostHog/Sentry, `X-Palmier-*` headers | §A1.3, §A4.2, §A15 | — | — | — | [CLOUD] drop |
| Generate panel | §B7 | `05` §4.13 | `01` §5.14 `GenerationInput` | — | [BYOK] |
| Model catalog + Settings ▸ Models | §B1, §B2, §B12 | `05` §11.5 | app settings `disabledModelIds` | — | [BYOK] (Mac: [CLOUD]) |
| Placeholders, statuses, resume | §B4, §B5, §B6.1 | `05` §3.7, §4.5, §5.3 | `01` §1.7, §1.9, §5.14 (+ `byokJob` addendum, §B5.2) | — | [BYOK] |
| Generating clips on the timeline, replace-in-place | §B6.2 | `05` §6.5 | `01` §5.5 | `03` §2 undo, §4.1 `placeClip`, §10.6 swap | [BYOK] |
| Music section | §B8 | `05` §4.14 | — | `04` §11.6 span render | [BYOK] |
| AI Edit (media menu, timeline submenu, inspector tab) | §B9 | `05` §6.14, §7.5.6 | — | `03` §4.9 trims | [BYOK] |
| FLUX Enhance (draft → 1080p) | §B9.6 | `05` §7.5.6 | `GenerationInput.draft`, `resultURLs[1]` | — | Mac [CLOUD] → Linux [BYOK] (fal/BFL FLUX.3, fal Seedance 2.5) |
| Create AI Transition | §B10 | `05` §6.14 | `01` §1.7 frame captures | `04` §11.6 frame capture | [BYOK] |
| Project Activity popover | §B11 | `05` §4.13 | — | — | Mac [CLOUD] → Linux local list |
| Credits chip, costs, "(Paid)", refunds | §B11 | `05` §4.13 | `costCredits`/`refundedCredits` (preserve on save) | — | [CLOUD] drop |
| Generation-complete notification | §B4.5 | `05` §11.3 | — | — | [LOCAL] |
| Agent generation tools (`list_models`, `generate_*`, `upscale_media`) | §B13 | — | — | `02` §3.44–3.48 | [BYOK] |
| Reference upload hosting | §B4.2, §B12.2 | — | `cachedRemoteURL` (preserve, don't write) | — | Mac [CLOUD] → provider upload |
| Cloud transcription / speaker identify used by captions (not in this spec's folders) | `07` §1.6, §3.5 | `05` §4.14 | `07` §1.1, §1.3 | `07` §1.5 (whisper.cpp), §3.5 (sherpa-onnx diarization) | Mac [CLOUD]; Linux: local whisper.cpp + local diarization, optional BYOK speech-to-text (`07` §1.6) |

---

# Part D — Quirks to keep or fix

| Id | Quirk | Source | Port decision |
|---|---|---|---|
| Q-A1 | Closing/deleting the active chat tab during a run keeps the run going against the next session's message array | `AgentService.swift:313-338` | **Fix** (bind runs to session id) |
| Q-A2 | Pasted text is appended at the end of the draft, not at the caret | `AgentInputBox.swift:288-289` | Fix (native paste) |
| Q-A3 | Token growth inside a streaming message does not auto-scroll | `AgentPanelView.swift:295-296` | Keep, or follow the bottom only while the user is at the bottom |
| Q-A4 | No iteration cap on the tool loop | `AgentService.swift:431-493` | Keep (user has Stop); optionally warn after 100 iterations |
| Q-A5 | `Tool executor unavailable.` is appended as a user **text** message | `AgentService.swift:559-562` | Keep (practically unreachable) |
| Q-A6 | The model picker shows no checkmark for the current model (the effort picker does) | `AgentPanelView.swift:140-166` | Keep for parity or add a checkmark |
| Q-B1 | After reopening a project, resumed jobs no longer swap replacement clips or patch generating-clip lengths | `GenerationService.swift:360-391` | Fix on Linux: persist `pendingReplacement`/placement intent in memory keyed by placeholder id and re-derive on resume (clips that reference the placeholder are found by `mediaRef`, so patching lengths can always be re-applied) |
| Q-B2 | A Save-As or project move during a running job: the placeholder URL points into the old package path | `GenerationService.swift:256` | Linux: resolve the install path from the **current** package at download time |
| Q-B3 | `mirelo` returns ≥ 2 samples and truncates input to 10 s | provider | catalog `maxSeconds:10`, keep sample 0 |
| Q-B5 | Deleting a generating placeholder does not cancel the job; on completion the deleted asset's manifest entry is re-added | `GenerationService.swift:278-303`, `EditorViewModel+MediaLibrary.swift:189-205,577-592` | Fix (cancel + ignore late results) |
| Q-B4 | `canEnhanceDraft` depends on the draft job storing ≥ 2 result URLs (video + cache) | `MediaAsset.swift:85-90` | keep: Linux stores `[video, draft cache]` (§B9.6) |

---

# Part E — Open questions

1. **Exact v0.7.6 catalog.** Palmier's catalog is served by Convex (`models:list`, `catalogVersion 4`) and is not in the source; the public docs show the newer v0.11 list. The Linux catalog (§B12.5) is built from provider limits. If parity with a specific Mac catalog snapshot matters, someone with a Palmier account must dump `list_models` output from the Mac app (MCP `list_models` with no filter) and we reconcile ids and caps.
2. **`byokJob` addendum to `01`** (§B5.2): needs the data-model owner's sign-off (new optional key inside `generationInput`, ignored by the Mac).
3. **Instruction text.** Keep `serverInstructions` byte-identical (mentions signing in to Palmier) or ship a Linux variant of two sentences? Parity says keep; UX says change.
4. **Which provider keys ship in v1.** Current `AppSettings.apiKeys` has `fal, replicate, openai, anthropic, elevenlabs`. Google (Gemini/Veo/Lyria/TTS) is the most valuable addition; xAI, BFL, MiniMax, BytePlus, Kling, Runway, Topaz, Sonilo, Fish are optional because fal covers almost all of them.
5. **fal storage REST shape** (`/storage/upload/initiate`) is taken from fal's client source, not prose docs — verify with a real key before shipping.
6. **ElevenLabs dubbing language list** and **voice list** must be fetched/maintained at runtime; default voices expire 2026-12-31.
7. **MiniMax Music** direct API is closed to new users; fal/Replicate upstream availability is unconfirmed.
8. **Drafts.** FLUX.3 (fal and BFL) and Seedance 2.5 (fal) expose draft → enhance publicly, so FLUX Enhance is portable (§B9.6). The BFL result key for the draft cache is unconfirmed; fal's is documented (`draft_cache`).
9. **Models with no public API** (MAI Image 2.5, Muse Image, FLUX Video Upscale, possibly Happy Horse/Gemini Omni variants — see §B12.4.1) are omitted; confirm with product whether to show them disabled.
