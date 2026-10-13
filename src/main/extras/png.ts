/** Minimal PNG writer for solid-colour images (spec 07 §6.5): 8-bit RGBA, one IDAT, filter 0 on every row. */
import zlib from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** A `width`×`height` PNG filled with the opaque colour `rgb` (bytes 0–255), plus an sRGB chunk. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new Error('Invalid PNG size.')
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const rowLen = 1 + width * 4
  const row = Buffer.alloc(rowLen)
  for (let x = 0; x < width; x++) {
    const o = 1 + x * 4
    row[o] = rgb[0]
    row[o + 1] = rgb[1]
    row[o + 2] = rgb[2]
    row[o + 3] = 255
  }
  const raw = Buffer.alloc(rowLen * height)
  for (let y = 0; y < height; y++) row.copy(raw, y * rowLen)
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Buffer.from([0])),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
