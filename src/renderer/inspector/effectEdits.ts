import type { Clip, Effect } from '@core/model'
import { effectDescriptor } from '@core/ops/effects'
import type { EffectEdit } from '@core/ops/ui'
import { clearPreview, commitOp, previewOp } from '../state/ops'
import { authoritativeClip } from './model'

export const specOf = (type: string, key: string) => effectDescriptor(type)!.params.find((p) => p.key === key)!
export const effectOf = (c: Clip, type: string): Effect | undefined => c.effects?.find((e) => e.type === type)
export const paramOf = (c: Clip, type: string, key: string): number => effectOf(c, type)?.params[key]?.value ?? specOf(type, key).default

/** Upsert/remove semantics: the edit removes the effect when every param of the first clip returns to its default. */
export function editFor(ids: string[], type: string, key: string, v: number): EffectEdit {
  const first = authoritativeClip(ids[0])
  const desc = effectDescriptor(type)!
  const allDefault = desc.params.every((p) => Math.abs((p.key === key ? v : first ? paramOf(first, type, p.key) : p.default) - p.default) < 1e-6)
  return allDefault ? { type, remove: true } : { type, params: { [key]: v } }
}

export function effectHandlers(ids: string[], label: string, build: (v: number) => EffectEdit[]) {
  return {
    onChange: (v: number) => {
      if (!previewOp('editEffects', { ids, edits: build(v) })) clearPreview()
    },
    onCommit: (v: number) => void commitOp('editEffects', { ids, edits: build(v), label }, { quiet: true }),
    onCancel: clearPreview,
  }
}
