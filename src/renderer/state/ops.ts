import { produce } from 'immer'
import { OPS, type OpArgs, type OpName, type OpResult } from '@core/ops'
import type { Doc } from '@core/ops/context'
import { beep, toast } from '../ui/toast'
import { useProject } from './project'

interface RunOptions {
  /** Suppress the refusal toast (no-op commits). */
  quiet?: boolean
}

/** Sends an op to main; refusals surface as a toast (+ beep when the domain asks for one). */
export async function runOp<N extends OpName>(name: N, args: OpArgs<N>, opts: RunOptions = {}): Promise<OpResult<N> | undefined> {
  const out = await window.palmier.project.op(name, args)
  if (out.ok) return out.result
  if (!opts.quiet) toast(out.error, 'error')
  if (out.beep) beep()
  return undefined
}

/** Applies `fn` to a draft of the authoritative doc and shows the result live. Returns false on refusal. */
export function previewWith(fn: (draft: Doc) => void): boolean {
  const base = useProject.getState().snapshot?.doc
  if (!base) return false
  try {
    useProject.setState({ preview: produce(base, fn) })
    return true
  } catch {
    return false
  }
}

/** Runs the same op main will run, locally, for a live preview. */
export function previewOp<N extends OpName>(name: N, args: OpArgs<N>): boolean {
  const def = OPS[name] as unknown as { run: (d: Doc, a: OpArgs<N>) => unknown }
  return previewWith((d) => {
    def.run(d, args)
  })
}

export function clearPreview(): void {
  if (useProject.getState().preview) useProject.setState({ preview: null })
}

/** Commits an op and drops the live preview once main has answered. */
export async function commitOp<N extends OpName>(name: N, args: OpArgs<N>, opts: RunOptions = {}): Promise<OpResult<N> | undefined> {
  try {
    return await runOp(name, args, opts)
  } finally {
    clearPreview()
  }
}
