/** Former NEEDS-ML tools: every one is now ported; only manage_multicam's dispatcher lives here. */
import { ungroupMulticam } from '../../../core/ops/multicam'
import { ToolError, isObj, lenient, validateUnknownKeys, type Obj } from './args'
import { mutate, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { createMulticam } from './audio'

// search_media: spoken scope implemented in ./search (visual reports index status 'failed').
// get_transcript, remove_words and add_captions are implemented in ./transcription.
// sync_clips, remove_silence, detect_beats, denoise_audio and manage_multicam create are implemented in ./audio.

/** create syncs members by audio (./audio); ungroup is a plain timeline edit. */
export async function manageMulticam(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['create', 'ungroup'], 'manage_multicam')
  if (args.create !== undefined) {
    if (!isObj(args.create)) throw new ToolError('manage_multicam.create must be an object.')
    return createMulticam(env, args.create)
  }
  if (args.ungroup === undefined) throw new ToolError('Pass create or ungroup.')
  if (!isObj(args.ungroup)) throw new ToolError('manage_multicam.ungroup must be an object.')
  validateUnknownKeys(args.ungroup, ['groupId'], 'manage_multicam.ungroup')
  const groupId = lenient.string(args.ungroup, 'groupId')
  if (!groupId) throw new ToolError('groupId is required.')
  if (!env.session.doc.file.multicamGroups?.some((g) => g.id === groupId)) throw new ToolError(`No multicam group '${groupId}'. get_timeline lists multicamGroups.`)
  const before = snapshot(env.session.doc)
  mutate(env, 'Ungroup Multicam (Agent)', (d) => ungroupMulticam(d, groupId))
  return mutationResult(env.session.doc, before, { extra: { ungrouped: groupId } })
}
