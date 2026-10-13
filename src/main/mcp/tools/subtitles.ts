/** SRT / WebVTT files for the MCP tools; the pure parser lives in core/captions/subtitleFileParser. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseSubtitleBytes, SubtitleParseError, subtitleFormat, type SubtitleCue } from '../../../core/captions/subtitleFileParser'

export { parseSubtitles, type SubtitleCue } from '../../../core/captions/subtitleFileParser'

export async function parseSubtitleFile(file: string): Promise<SubtitleCue[]> {
  const ext = path.extname(file).slice(1)
  if (!subtitleFormat(ext)) throw SubtitleParseError.unsupportedFileType(ext)
  return parseSubtitleBytes(await fs.readFile(file), ext)
}
