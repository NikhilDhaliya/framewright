/**
 * Export audio mix as an FFmpeg filtergraph (spec 04 §10, §10.7 FFmpeg alternative): per clip
 * seek/trim, atempo for speed, the piecewise-linear gain envelope as a `volume` expression, adelay, then
 * `amix normalize=0`, padded/trimmed to exactly the exported duration (48 kHz stereo).
 */
import { pieceEnvelope, type AudioPiece, type GainEnvelope } from '../../renderer/render/audioPlan'

export const MIX_RATE = 48000

export interface MixInput {
  path: string
  seekSec: number
  durSec: number
}

export interface MixGraph {
  inputs: MixInput[]
  /** `-filter_complex` value; output label `[aout]`. */
  filter: string
  totalSamples: number
}

const num = (v: number) => {
  const r = Number(v.toFixed(9))
  return Object.is(r, -0) ? '0' : String(r)
}

/** `t − a` without a double minus. */
const minus = (a: number) => (a >= 0 ? `t-${num(a)}` : `t+${num(-a)}`)

/** Linear gain envelope over local time t (s): g0 + Σ Δg·clip((t − tᵢ)/Δt, 0, 1). */
export function volumeExpression(env: GainEnvelope, fps: number, headSkipSec: number): string {
  const g = env.gains
  if (g.every((v) => v === g[0])) return num(g[0])
  const times = env.offsets.map((o) => o / fps - headSkipSec)
  let expr = num(g[0])
  for (let i = 0; i + 1 < g.length; i++) {
    const dg = g[i + 1] - g[i]
    if (dg === 0) continue
    const dt = times[i + 1] - times[i]
    const term = dt > 0 ? `clip((${minus(times[i])})/${num(dt)},0,1)` : `gte(${minus(times[i])},0)`
    expr += `${dg < 0 ? '-' : '+'}${num(Math.abs(dg))}*${term}`
  }
  return expr
}

/** atempo accepts 0.5…100 per instance; slower rates chain 0.5 stages. */
export function tempoChain(rate: number): string[] {
  if (!(rate > 0) || Math.abs(rate - 1) < 1e-9) return []
  const out: string[] = []
  let r = rate
  while (r < 0.5) {
    out.push('atempo=0.5')
    r /= 0.5
  }
  while (r > 100) {
    out.push('atempo=100')
    r /= 100
  }
  if (Math.abs(r - 1) > 1e-9) out.push(`atempo=${num(r)}`)
  return out
}

export interface MixRange {
  /** Timeline frames [start, end). */
  start: number
  end: number
  fps: number
  /** Exact output length in seconds. */
  durationSec: number
}

/**
 * Filtergraph for the audible pieces inside `range`; `channels(path)` = source channel count (0 = no audio).
 * Returns null when nothing is audible.
 */
export function buildMixGraph(pieces: AudioPiece[], range: MixRange, channels: (path: string) => number): MixGraph | null {
  const inputs: MixInput[] = []
  const chains: string[] = []
  const labels: string[] = []
  const { fps } = range
  for (const piece of pieces) {
    const c = piece.clip
    const s = c.startFrame
    const e = c.startFrame + c.durationFrames
    const lo = Math.max(s, range.start)
    const hi = Math.min(e, range.end)
    if (hi <= lo) continue
    const ch = channels(piece.path)
    if (ch <= 0) continue
    const t = piece.timing
    const headSkip = (lo - s) / fps
    const playSec = (hi - lo) / fps
    const rate = t.speedOne ? 1 : t.rate
    const seek = t.trimSec + headSkip * rate
    const srcAvail = t.srcDurSec - headSkip * rate
    if (!(srcAvail > 0)) continue
    const idx = inputs.length
    inputs.push({ path: piece.path, seekSec: seek, durSec: Math.min(playSec * rate, srcAvail) })
    const env = pieceEnvelope(piece)
    const delaySamples = Math.round(((lo - range.start) / fps) * MIX_RATE)
    const playSamples = Math.round(playSec * MIX_RATE)
    const steps = [
      'asetpts=PTS-STARTPTS',
      // Mono duplicates to both channels at unity (AVFoundation), not FFmpeg's −3 dB upmix.
      ...(ch === 1 ? ['pan=stereo|c0=c0|c1=c0'] : []),
      `aresample=${MIX_RATE}`,
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      ...tempoChain(rate),
      'asetpts=N/SR/TB',
      'asetnsamples=n=256:p=0',
      `volume=volume='${volumeExpression(env, fps, headSkip)}':eval=frame:precision=float`,
      `atrim=end_sample=${playSamples}`,
      ...(delaySamples > 0 ? [`adelay=delays=${delaySamples}S:all=1`] : []),
    ]
    chains.push(`[${idx}:a:0]${steps.join(',')}[a${idx}]`)
    labels.push(`[a${idx}]`)
  }
  if (!labels.length) return null
  const totalSamples = Math.round(range.durationSec * MIX_RATE)
  const tail = `apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},aformat=sample_fmts=flt:channel_layouts=stereo[aout]`
  const mix = labels.length === 1 ? `${labels[0]}${tail}` : `${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,${tail}`
  return { inputs, filter: [...chains, mix].join(';'), totalSamples }
}

/** FFmpeg arguments that render a graph (or silence) to `output` with `codecArgs`. */
export function mixArgs(graph: MixGraph | null, durationSec: number, codecArgs: string[], output: string): string[] {
  const args = ['-y']
  if (!graph) {
    args.push('-f', 'lavfi', '-i', `anullsrc=r=${MIX_RATE}:cl=stereo`, '-t', num(durationSec))
  } else {
    for (const i of graph.inputs) args.push('-ss', num(i.seekSec), '-t', num(i.durSec), '-i', i.path)
    args.push('-filter_complex', graph.filter, '-map', '[aout]')
  }
  args.push('-ar', String(MIX_RATE), '-ac', '2', ...codecArgs, output)
  return args
}
