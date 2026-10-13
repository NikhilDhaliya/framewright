/** Track-header glow for tracks an agent edit changed (Mac `TimelineHeaderView.syncAgentTrackLayer`). */
import { useLayoutEffect, useRef } from 'react'
import { AGENT_TIMING, useAgentActivity } from './agentActivity'
import type { TrackLayout } from './geometry'

export function AgentTrackGlows({ layouts }: { layouts: TrackLayout[] }) {
  const ids = useAgentActivity((a) => a.mutatedTrackIds)
  const revision = useAgentActivity((a) => a.revision)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !ids.size) return
    const { changeHold: hold, changeDuration: duration } = AGENT_TIMING
    const anim = el.animate(
      [
        { opacity: 1, offset: 0, easing: 'linear' },
        { opacity: 1, offset: hold / duration, easing: 'ease-out' },
        { opacity: 0, offset: 1 },
      ],
      { duration: duration * 1000, fill: 'forwards' },
    )
    return () => anim.cancel()
  }, [revision, ids])
  if (!ids.size) return null
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      {layouts
        .filter((l) => ids.has(l.id))
        .map((l) => (
          <div
            key={l.id}
            style={{
              position: 'absolute',
              left: 0.5,
              right: 0.5,
              top: l.top + 0.5,
              height: l.height - 1,
              borderRadius: 3,
              border: '2px solid var(--pp-system-orange)',
              boxShadow: '0 0 8px color-mix(in srgb, var(--pp-system-orange) 80%, transparent)',
              boxSizing: 'border-box',
            }}
          />
        ))}
    </div>
  )
}
