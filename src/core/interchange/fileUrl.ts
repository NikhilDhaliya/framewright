/**
 * File URLs as Foundation's `URL(fileURLWithPath:).absoluteString` writes them: RFC 3986 path characters
 * (unreserved, sub-delims, `:`, `@`, `/`) stay literal; everything else is UTF-8 percent-encoded with uppercase hex.
 */

const PATH_SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/

export function fileUrlString(absolutePath: string): string {
  let out = 'file://'
  for (const ch of absolutePath) {
    if (PATH_SAFE.test(ch)) {
      out += ch
      continue
    }
    for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** XMEML `<pathurl>`: Premiere/Resolve's extra-slash host form (`file://localhost///abs/path`). */
export const xmemlPathUrl = (absolutePath: string): string => fileUrlString(absolutePath).replaceAll('file://', 'file://localhost//')

/** FCPXML `media-rep src`: sub-delimiters percent-encoded too (Resolve cannot relink them as XML entities). */
export const fcpxmlMediaSrc = (absolutePath: string): string =>
  fileUrlString(absolutePath).replace(/['!$&()*+,;=]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

/** `url.lastPathComponent`. */
export function lastPathComponent(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '')
  if (!trimmed) return '/'
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}
