/**
 * Keys that reach `t()` only as values from modules that stay i18n-free (src/core/**), so the extractor
 * (scripts/i18n/build-locales.mjs) sees them here. Keep each list in step with its source table.
 */
import { tk } from '../../shared/i18n'

/** src/core/generation/status.ts `STATUS_LABELS`. */
export const GENERATION_STATUS_KEYS = [tk('Preparing…'), tk('Generating…'), tk('Downloading…'), tk('Rendering…')]

/** src/core/generation/edit.ts: VIDEO_TO_AUDIO / AUDIO_TRANSFORMS titles and tileState / audioTileState reasons. */
export const AI_EDIT_KEYS = [
  tk('Generate Music'), tk('Generate Music…'), tk('Generate music that fits the video'), tk('Add Music'),
  tk('Generate SFX'), tk('Generate SFX…'), tk('Create matching sound for the video'), tk('Add Sound Effects'),
  tk('Voice Cleanup'), tk('Remove background sound and keep speech'), tk('Clean Up Voice…'), tk('Add Cleaned Voice'),
  tk('Dubbing'), tk('Translate speech into another language'), tk('Dub…'), tk('Add Dubbed Voice'),
  tk('Loading video metadata…'), tk('Draft already enhanced or cache unavailable'), tk('Upscale only works on video or images'),
  tk('Generation in progress'), tk('Reframe only works on video'), tk('Reframe model not available'), tk('Lip Sync only works on video'),
  tk('Lip Sync model not available'), tk('Edit model not available'), tk('Create Video only works on images'),
  tk('Only available for AI-generated media'), tk('Model no longer available'), tk('Voice Cleanup requires audio or video'),
  tk('Dubbing requires audio or video'), tk('Video has no audio track'), tk('Voice Cleanup model not available'),
  tk('Dubbing model not available'), tk('Loading media metadata…'), tk('No video model supports first and last frames.'),
  tk('Add an API key for a video model that supports first and last frames.'),
]

/** resources/generation-catalog.json `promptLabel` values and the default in src/core/generation/models.ts. */
export const PROMPT_LABEL_KEYS = [
  tk('Describe the audio scene'), tk('Describe the music style or mood'), tk('Describe the sound'), tk('Describe the sound (optional)'), tk('Text to speak'),
]
