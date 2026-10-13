/**
 * Gemma tokenizer parity with the Mac (spec 07 §2.7): the 12 goldens from `TextTokenizerGoldens.swift` must match id
 * for id, with no lower-casing. Needs the pinned `tokenizer.json` (34 MB, part of the search model download): it is
 * looked up in `PALMIER_SIGLIP_TOKENIZER`, else in the opt-in real-model cache (`realSiglip.test.ts`); skipped if absent.
 */
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTokenizer } from '../../src/main/ml/search/siglip'
import { TOKENIZER_GOLDENS } from './tokenizerGoldens'

const TEST_MODELS_ROOT = process.env.PALMIER_TEST_MODELS_ROOT ?? path.join(os.homedir(), '.cache', 'palmier-pro-tests', 'Models')

const candidates = [
  process.env.PALMIER_SIGLIP_TOKENIZER,
  path.join(TEST_MODELS_ROOT, 'search', 'siglip2-base-patch16-256-v101', 'tokenizer.json'),
  path.join(TEST_MODELS_ROOT, '.staging', 'search-siglip2-b16-256-int8', 'files', 'tokenizer.json'),
].filter((p): p is string => !!p)
const tokenizerFile = candidates.find((p) => existsSync(p))

describe.skipIf(!tokenizerFile)('SigLIP 2 tokenizer (Mac goldens)', () => {
  it('matches the Python/Swift goldens exactly', async () => {
    const tok = await loadTokenizer(tokenizerFile!)
    expect(TOKENIZER_GOLDENS.length).toBe(12)
    for (const [text, ids] of TOKENIZER_GOLDENS) expect(tok.tokenize(text), JSON.stringify(text)).toEqual(ids)
  }, 60_000)

  it('pads and truncates (Mac padsAndTruncates); no lower-casing', async () => {
    const tok = await loadTokenizer(tokenizerFile!)
    const short = tok.tokenize('a cat')
    expect(short.length).toBe(64)
    expect(short[63]).toBe(0)
    const long = tok.tokenize(Array(80).fill('establishing shot').join(' '))
    expect(long.length).toBe(64)
    expect(long.every((x) => x !== 0)).toBe(true)
    expect(tok.tokenize('A CAT')).not.toEqual(tok.tokenize('a cat'))
  }, 60_000)
})
