/**
 * Downloadable models and binaries (spec 07 §0.1, §2.7). Byte counts and sha256 were re-checked on 2026-10-13 against
 * the GitHub releases API (whisper.cpp b5454 = v1.9.5) and Hugging Face `x-linked-size` / `x-linked-etag`.
 * Nothing here is bundled: every entry is fetched on first use into `$XDG_DATA_HOME/framewright/Models/<dir>/`.
 */

export type ModelId =
  | 'whisper-cli'
  | 'whisper-large-v3-turbo-q5_0'
  | 'whisper-small'
  | 'whisper-base'
  | 'whisper-tiny-q5_1'
  | 'speaker-wespeaker-r34lm'
  | 'speaker-pyannote-seg30'
  | 'search-siglip2-b16-256-int8'

export interface ManifestFile {
  url: string
  /** Path inside the install dir (the archive name for extracted files). */
  path: string
  bytes: number
  sha256: string
  /** Extracted into the install dir with the system `tar`, then the archive is deleted. */
  extract?: 'tar.gz' | 'tar.bz2'
}

export interface ModelManifest {
  id: ModelId
  /** Directory under Models/. */
  dir: string
  /** Shown in Settings ▸ Storage and in download errors. */
  label: string
  files: ManifestFile[]
  /** Written to `spec.json` with the file pins; a changed manifest reinstalls. */
  spec?: Record<string, unknown>
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

function whisperModel(id: ModelId, name: string, bytes: number, sha256: string): ModelManifest {
  return { id, dir: `whisper/${name}`, label: `Whisper ${name}`, files: [{ url: `${HF_WHISPER}/ggml-${name}.bin`, path: `ggml-${name}.bin`, bytes, sha256 }], spec: { engine: 'whisper.cpp', model: name } }
}

export const MANIFESTS: Record<ModelId, ModelManifest> = {
  'whisper-cli': {
    id: 'whisper-cli',
    dir: 'whisper/bin-v1.9.5',
    label: 'whisper.cpp v1.9.5',
    files: [
      {
        url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz',
        path: 'whisper-bin-ubuntu-x64.tar.gz',
        bytes: 10_364_195,
        sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
        extract: 'tar.gz',
      },
    ],
    spec: { engine: 'whisper.cpp', version: '1.9.5', release: 'b5454' },
  },
  'whisper-large-v3-turbo-q5_0': whisperModel('whisper-large-v3-turbo-q5_0', 'large-v3-turbo-q5_0', 574_041_195, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'),
  'whisper-small': whisperModel('whisper-small', 'small', 487_601_967, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'),
  'whisper-base': whisperModel('whisper-base', 'base', 147_951_465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'),
  /** Linux addition (not in the Settings menu): a 32 MB model for tests and very slow machines. */
  'whisper-tiny-q5_1': whisperModel('whisper-tiny-q5_1', 'tiny-q5_1', 32_152_673, '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7'),
  'speaker-wespeaker-r34lm': {
    id: 'speaker-wespeaker-r34lm',
    dir: 'speaker/wespeaker-r34lm',
    label: 'WeSpeaker ResNet34-LM',
    files: [
      {
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
        path: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
        bytes: 26_530_550,
        sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
      },
    ],
  },
  'speaker-pyannote-seg30': {
    id: 'speaker-pyannote-seg30',
    dir: 'speaker/pyannote-seg30',
    label: 'pyannote segmentation 3.0',
    files: [
      {
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
        path: 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
        bytes: 6_958_444,
        sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
        extract: 'tar.bz2',
      },
    ],
  },
  /** §2.7: the small tokenizer/config JSONs are pinned by the smart-search work after their first download. */
  'search-siglip2-b16-256-int8': {
    id: 'search-siglip2-b16-256-int8',
    dir: 'search/siglip2-base-patch16-256-v101',
    label: 'siglip2-base-patch16-256',
    files: [
      ['onnx/vision_model_quantized.onnx', 94_737_653, 'f2eb8ccfa3dc0b3761d9ea9a39554fe0f2be71b247ad7f68a80720ec88895650'],
      ['onnx/text_model_quantized.onnx', 283_438_275, '6f59b39d880c413042314b79302b74d0dd93b273caf8fbfdb1eb2df61a7fefd4'],
      ['tokenizer.json', 34_363_039, 'cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322'],
    ].map(([p, bytes, sha256]) => ({
      url: `https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/d1114256522a37ffa257a0a58017348ab0058db2/${p}`,
      path: p as string,
      bytes: bytes as number,
      sha256: sha256 as string,
    })),
    spec: { model: 'siglip2-base-patch16-256', version: 101, embeddingDim: 768, imageSize: 256, contextLength: 64 },
  },
}

/** `transcription.localModel` values (spec 07 §0.5) → model ids. */
export const WHISPER_MODELS = {
  'large-v3-turbo-q5_0': 'whisper-large-v3-turbo-q5_0',
  small: 'whisper-small',
  base: 'whisper-base',
  'tiny-q5_1': 'whisper-tiny-q5_1',
} as const satisfies Record<string, ModelId>

export type WhisperModelName = keyof typeof WHISPER_MODELS
export const DEFAULT_WHISPER_MODEL: WhisperModelName = 'large-v3-turbo-q5_0'
export const isWhisperModelName = (v: unknown): v is WhisperModelName => typeof v === 'string' && Object.hasOwn(WHISPER_MODELS, v)

export const manifestBytes = (m: ModelManifest): number => m.files.reduce((n, f) => n + f.bytes, 0)
