/** Tool name → handler for every MCP tool except manage_project (which the executor runs before binding checks). */
import { addClips, copyClipSettings, insertClips, manageClipLinks, moveClipsTool, removeClipsTool, rippleDeleteRangesTool, setClipProperties, setKeyframes, splitClipsTool, swapClipMediaTool } from './clips'
import { applyColor, applyEffect, inspectColor } from './color'
import type { ToolHandler } from './context'
import { exportProject, manageExports } from './export'
import { sendFeedback } from './feedback'
import { generateAudio, generateImage, generateVideo, listModels, upscaleMedia } from './generation'
import { importMedia } from './import'
import { captureFrame, inspectMedia, inspectTimeline } from './inspect'
import { applyLayout } from './layout'
import { getMedia, organizeMedia } from './media'
import { changeCam, getMulticam } from './multicam'
import { addTexts, updateText } from './text'
import { createTimelineTool, getTimeline, manageMarkers, setActiveTimeline, setProjectSettings, undoTool } from './timeline'
import { manageTracks } from './tracks'
import { addCaptions, getTranscript, removeWords } from './transcription'
import { searchMedia } from './search'
import { denoiseAudio, detectBeats, removeSilence, syncClips } from './audio'
import { manageMulticam } from './unavailable'

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_timeline: getTimeline,
  inspect_timeline: inspectTimeline,
  create_timeline: createTimelineTool,
  set_active_timeline: setActiveTimeline,
  manage_markers: manageMarkers,
  set_project_settings: setProjectSettings,
  export_project: exportProject,
  manage_exports: manageExports,
  get_media: getMedia,
  inspect_media: inspectMedia,
  search_media: searchMedia,
  import_media: importMedia,
  capture_frame: captureFrame,
  organize_media: organizeMedia,
  add_clips: addClips,
  insert_clips: insertClips,
  move_clips: moveClipsTool,
  remove_clips: removeClipsTool,
  manage_clip_links: manageClipLinks,
  manage_tracks: manageTracks,
  split_clips: splitClipsTool,
  ripple_delete_ranges: rippleDeleteRangesTool,
  swap_clip_media: swapClipMediaTool,
  set_clip_properties: setClipProperties,
  copy_clip_settings: copyClipSettings,
  set_keyframes: setKeyframes,
  apply_layout: applyLayout,
  sync_clips: syncClips,
  manage_multicam: manageMulticam,
  change_cam: changeCam,
  get_multicam: getMulticam,
  undo: (env) => undoTool(env),
  get_transcript: getTranscript,
  remove_words: removeWords,
  remove_silence: removeSilence,
  detect_beats: detectBeats,
  add_texts: addTexts,
  update_text: updateText,
  add_captions: addCaptions,
  apply_color: applyColor,
  apply_effect: applyEffect,
  inspect_color: inspectColor,
  denoise_audio: denoiseAudio,
  list_models: listModels,
  generate_video: generateVideo,
  generate_image: generateImage,
  generate_audio: generateAudio,
  upscale_media: upscaleMedia,
  send_feedback: sendFeedback,
}
