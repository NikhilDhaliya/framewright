/** Transport of the media (source) tab currently shown, so Space and arrow keys can drive it. */
export interface SourcePlayer {
  toggle(): void
  step(frames: number): void
}

export const sourcePlayer: { current: SourcePlayer | null } = { current: null }
