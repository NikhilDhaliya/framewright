/** Media-tab smart search formatting (spec 07 §2.6 tooltip size, 05 §4.10 time ranges). */
import { describe, expect, it } from 'vitest'
import { formatFileBytes, searchTimecode } from '../../src/renderer/media/search/status'
import { SEARCH_MODEL_DOWNLOAD_BYTES } from '../../src/main/ml/search/model'

describe('smart search UI helpers', () => {
  it('formats sizes like ByteCountFormatter(.file), decimal units', () => {
    expect(formatFileBytes(SEARCH_MODEL_DOWNLOAD_BYTES)).toBe('378.2 MB')
    expect(formatFileBytes(350_293_481)).toBe('350.3 MB')
    expect(formatFileBytes(0)).toBe('Zero KB')
    expect(formatFileBytes(999)).toBe('999 bytes')
    expect(formatFileBytes(13_400)).toBe('13 KB')
    expect(formatFileBytes(1_503_238_553)).toBe('1.50 GB')
  })

  it('formats hit times as M:SS or H:MM:SS (rounded seconds)', () => {
    expect(searchTimecode(0)).toBe('0:00')
    expect(searchTimecode(10.6)).toBe('0:11')
    expect(searchTimecode(125)).toBe('2:05')
    expect(searchTimecode(3725.2)).toBe('1:02:05')
  })
})
