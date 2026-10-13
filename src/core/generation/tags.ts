/**
 * Prompt reference tags (spec 06 §B12.3, research §0.3). Palmier writes `@Image1`, `@Video1`, `@Audio1`,
 * `@Element1`; routes that expect another syntax get the prompt rewritten in the adapter.
 */
import type { ByokRoute } from './catalog'

export type TagStyle = 'palmier' | 'xai' | 'byteplus' | 'minimax' | 'kling-official'

const TAG = /@(Image|Video|Audio|Element)(\d+)\b/g

export function rewritePromptTags(prompt: string, style: TagStyle): string {
  if (style === 'palmier') return prompt
  return prompt.replace(TAG, (whole, noun: string, digits: string) => {
    const n = Number(digits)
    switch (style) {
      case 'xai':
        if (noun === 'Image' || noun === 'Element') return `<IMAGE_${n - 1}>`
        if (noun === 'Audio') return `<AUDIO_${n - 1}>`
        return whole
      case 'byteplus':
        return noun === 'Element' ? `[Image ${n}]` : `[${noun} ${n}]`
      case 'minimax':
        if (noun === 'Image' || noun === 'Element') return `Image ${n}`
        return `reference ${noun.toLowerCase()} ${n}`
      case 'kling-official':
        return noun === 'Image' || noun === 'Element' ? `<<<image_${n}>>>` : whole
    }
  })
}

/** Which tag syntax a route's endpoint expects. */
export function tagStyleFor(route: ByokRoute, endpoint: string): TagStyle {
  switch (route.protocol) {
    case 'fal-queue':
      return endpoint.startsWith('xai/grok-imagine-video/v1.5/') ? 'xai' : 'palmier'
    case 'xai':
      return 'xai'
    case 'byteplus-task':
    case 'byteplus-images':
      return 'byteplus'
    case 'minimax':
      return 'minimax'
    case 'kling':
      return 'kling-official'
    default:
      return 'palmier'
  }
}

/** Tags a prompt may reference for a pool of references, numbered per type in pool order (§B7.5). */
export function referenceTags(noun: string, counts: { images: number; videos: number; audios: number }): string[] {
  const out: string[] = []
  for (let i = 1; i <= counts.images; i++) out.push(`${noun}${i}`)
  for (let i = 1; i <= counts.videos; i++) out.push(`Video${i}`)
  for (let i = 1; i <= counts.audios; i++) out.push(`Audio${i}`)
  return out
}
