import { useEffect, useState } from 'react'
import { mediaUrl } from '../../shared/api'

/** Size of a local file via a one-byte range request on the media protocol; null when the file is missing. */
export async function statFile(path: string, signal?: AbortSignal): Promise<number | null> {
  const r = await fetch(mediaUrl(path), { headers: { Range: 'bytes=0-0' }, signal })
  void r.body?.cancel()
  if (!r.ok && r.status !== 416) return null
  const total = Number(r.headers.get('Content-Range')?.split('/')[1] ?? r.headers.get('Content-Length'))
  return Number.isFinite(total) && total >= 0 ? total : null
}

/** File size (bytes), `null` when missing, `undefined` while unknown. */
export function useFileSize(path: string | null): number | null | undefined {
  const [size, setSize] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    setSize(undefined)
    if (!path) return
    const ctl = new AbortController()
    statFile(path, ctl.signal).then(setSize, () => undefined)
    return () => ctl.abort()
  }, [path])
  return size
}
