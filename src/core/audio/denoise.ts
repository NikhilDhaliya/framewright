/** Denoise effect edits (`audio.denoise {amount}`, spec 07 §3.6 / 01 §5.8.1) and bake targets. Pure. */
import type { Clip } from '../model'
import { activeTimeline, type Doc } from '../ops/context'
import { addEffect, mutateClips, removeEffect, setEffectEnabled, setEffectParam } from '../ops/properties'
import { EditRefusal, findClip } from '../timeline'

export const DENOISE = 'audio.denoise'
export const DEFAULT_DENOISE_AMOUNT = 0.6

export function denoiseOf(c: Clip): { enabled: boolean; amount: number } | null {
  const e = c.effects?.find((x) => x.type === DENOISE)
  if (!e) return null
  return { enabled: e.enabled, amount: e.params.amount?.value ?? DEFAULT_DENOISE_AMOUNT }
}

/** `setDenoise(clipIds, enabled, amount)`: adds/updates the effect, or removes it when disabled. */
export function setDenoise(doc: Doc, clipIds: string[], enabled: boolean, amount: number = DEFAULT_DENOISE_AMOUNT): string[] {
  const t = activeTimeline(doc)
  for (const id of clipIds) {
    const loc = findClip(t, id)
    if (!loc) throw new EditRefusal(`Clip not found: ${id}`)
    if (loc.clip.mediaType !== 'audio') throw new EditRefusal(`Clip ${id} is a ${loc.clip.mediaType} clip; denoise_audio needs an audio clip.`)
  }
  return mutateClips(doc, clipIds, (c) => {
    const has = c.effects?.some((e) => e.type === DENOISE)
    if (!enabled) {
      if (has) removeEffect(c, DENOISE)
      return
    }
    if (!has) addEffect(c, DENOISE, { amount })
    else {
      setEffectParam(c, DENOISE, 'amount', amount)
      setEffectEnabled(c, DENOISE, true)
    }
  })
}

/** Media refs with an enabled denoise and amount > 0 on any timeline (what needs a baked wet file). */
export function denoiseTargets(doc: Doc): string[] {
  const refs = new Set<string>()
  for (const t of doc.file.timelines)
    for (const tr of t.tracks)
      for (const c of tr.clips) {
        const d = denoiseOf(c)
        if (d?.enabled && d.amount > 0) refs.add(c.mediaRef)
      }
  return [...refs]
}
