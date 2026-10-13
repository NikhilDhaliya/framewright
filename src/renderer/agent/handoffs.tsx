/** Agent hand-offs from the rest of the app (spec 06 §A12, §A14). */
import { MessageSquare } from 'lucide-react'
import { editor } from '../state/editor'
import { getDoc } from '../state/project'
import type { MenuItem } from '../ui/Menu'
import { addAssetToChat, handOff, useAgent } from './store'
import { t } from '../i18n'

export const ORGANIZE_PROMPT =
  "Organize my media library. Review the assets, group related ones into clearly named folders, and give generically-named assets short descriptive names — inspect an asset when its name is unclear. Don't delete anything or change the timeline."

/** Captions tab ▸ Agent Mode tasks (for the captions panel when it lands). */
export const CAPTION_TASKS = {
  removeFillers: "remove filler words (um, uh, er, like, you know) from the captions, keeping each caption's timing unchanged.",
  fixNames: 'fix any misspelled names, brand names, or technical jargon in the captions using the surrounding context, keeping timing unchanged.',
  addEmoji: 'add relevant emoji to the captions, keeping the text and timing otherwise unchanged.',
  translate: (language: string) => `translate the captions to ${language}, keeping each caption's timing unchanged.`,
} as const
export const captionPrompt = (task: string) => `If the timeline has no captions yet, transcribe the spoken audio and add captions on word boundaries first. Then ${task}`

/** Audio ▸ Music ▸ Agent Mode prompts (for the music panel when it lands). */
export const MUSIC_SCORE_PROMPT = 'Score my timeline with music that matches the visuals. Use a video-to-music model on the full timeline span so the music follows the edit, and place it on an audio track.'
export const musicMoodPrompt = (mood: string) => `Generate ${mood.toLowerCase()} music for my timeline and place it on an audio track aligned to the edit.`

/** Media ⋯ ▸ Organize with Agent: shown when the library is non-empty and the selected model has a key. */
export function organizeWithAgentItem(): MenuItem[] {
  const hasAssets = (getDoc()?.manifest.entries.length ?? 0) > 0
  const canStream = useAgent.getState().state?.canStream ?? false
  if (!hasAssets || !canStream) return []
  return [
    {
      label: t('Organize with Agent'),
      icon: 'wand.and.stars',
      onSelect: () => handOff(ORGANIZE_PROMPT + (editor().mediaFolderId ? ' Work within the current folder.' : '')),
    },
  ]
}

/** Media tile hover "Add to chat" (05 §4.5): 20×20 dark circle, top-right, inset 4. */
export function AddToChatButton({ assetId }: { assetId: string }) {
  return (
    <button
      type="button"
      className="pp-agent-addchat"
      data-tip={t('Add to chat')}
      aria-label={t('Add to chat')}
      draggable={false}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        addAssetToChat(assetId)
      }}
    >
      <MessageSquare size={11} strokeWidth={2.4} />
    </button>
  )
}
