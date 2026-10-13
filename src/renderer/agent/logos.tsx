import type { AgentProvider } from '../../shared/agent'

/** 14×14 provider marks for the model picker (simple generic glyphs, no bundled brand artwork). */
export function ProviderLogo({ provider, size = 14 }: { provider: AgentProvider; size?: number }) {
  if (provider === 'anthropic') {
    // Eight-ray spark in Claude orange.
    const rays = Array.from({ length: 8 }, (_, i) => i * 22.5 * 2)
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="pp-agent-logo">
        <g transform="translate(7 7)" stroke="#d97757" strokeWidth="1.7" strokeLinecap="round">
          {rays.map((a) => (
            <line key={a} x1="0" y1="1.2" x2="0" y2={a % 90 === 0 ? 6 : 5} transform={`rotate(${a})`} />
          ))}
        </g>
      </svg>
    )
  }
  // Six interlocking petals.
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="pp-agent-logo">
      <g transform="translate(7 7)" fill="none" stroke="currentColor" strokeWidth="1.1">
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <ellipse key={a} cx="0" cy="-2.6" rx="2.1" ry="3.3" transform={`rotate(${a})`} />
        ))}
      </g>
    </svg>
  )
}
