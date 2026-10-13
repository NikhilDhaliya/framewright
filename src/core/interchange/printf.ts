/**
 * Number formatting with C `printf` semantics, as Swift's `String(format:)` produces on the Mac. `%.Nf` rounds the
 * exact binary value half-to-even (`Number.prototype.toFixed` rounds exact ties up and drops the sign of -0).
 */

const bits = new DataView(new ArrayBuffer(8))

/** The double as `mantissa · 2^exponent` with an integer mantissa. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  bits.setFloat64(0, x)
  const raw = bits.getBigUint64(0)
  const biased = Number((raw >> 52n) & 0x7ffn)
  const fraction = raw & 0xfffffffffffffn
  return biased === 0 ? { mantissa: fraction, exponent: -1074 } : { mantissa: fraction | (1n << 52n), exponent: biased - 1075 }
}

/** `String(format: "%.<digits>f", value)`. */
export function formatFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return 'nan'
  const negative = value < 0 || Object.is(value, -0)
  if (!Number.isFinite(value)) return negative ? '-inf' : 'inf'
  const { mantissa, exponent } = decompose(Math.abs(value))
  const scaled = mantissa * 10n ** BigInt(digits)
  let units: bigint
  if (exponent >= 0) {
    units = scaled << BigInt(exponent)
  } else {
    const divisor = 1n << BigInt(-exponent)
    units = scaled / divisor
    const twice = (scaled % divisor) * 2n
    if (twice > divisor || (twice === divisor && units % 2n === 1n)) units += 1n
  }
  let text = units.toString()
  if (digits > 0) {
    text = text.padStart(digits + 1, '0')
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`
  }
  return negative ? `-${text}` : text
}

/** `String(format: "%02d", value)`. */
export function pad2(value: number): string {
  const v = Math.trunc(value)
  return v < 0 ? `-${String(-v)}` : String(v).padStart(2, '0')
}
