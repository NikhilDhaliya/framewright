import { BRANDED_SPEC as spec } from '../brandedSpec'

export type ToolClass = 'CORE' | 'AI-GENERATION' | 'NEEDS-ML'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  class: ToolClass
}

/** The 50 MCP tools in `tools/list` order, verbatim from the Mac apart from product-name text (src/main/mcp/brandedSpec.ts); in-app-only skill tools are not exposed. */
export const MCP_TOOLS: ToolDefinition[] = spec.tools as ToolDefinition[]

export const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name))

export const SERVER_INFO = spec.serverInfo as { name: string; version: string }
export const SERVER_INSTRUCTIONS: string = spec.instructions
export const SERVER_CAPABILITIES = spec.capabilities

/** Tools that may run while the session's project is not the frontmost one. */
export const READ_ONLY_TOOLS = new Set([
  'get_timeline',
  'inspect_timeline',
  'get_media',
  'inspect_media',
  'search_media',
  'get_multicam',
  'get_transcript',
  'detect_beats',
  'inspect_color',
  'list_models',
  'send_feedback',
])

/** Mutating tools whose timeline changes are highlighted in the editor. */
export const CHANGE_PUBLISHERS = new Set([
  'set_project_settings',
  'manage_tracks',
  'manage_clip_links',
  'add_clips',
  'insert_clips',
  'move_clips',
  'remove_clips',
  'split_clips',
  'ripple_delete_ranges',
  'swap_clip_media',
  'set_clip_properties',
  'copy_clip_settings',
  'set_keyframes',
  'apply_layout',
  'sync_clips',
  'undo',
  'manage_multicam',
  'change_cam',
  'remove_words',
  'remove_silence',
  'add_texts',
  'update_text',
  'add_captions',
  'apply_color',
  'apply_effect',
  'denoise_audio',
  'generate_audio',
])
