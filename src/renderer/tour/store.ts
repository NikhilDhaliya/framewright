/** Tutorial tour state and step application (spec 07 §7.3, Mac `TourController`). */
import { create } from 'zustand'
import { showPanelFitting } from '../editor/panelFit'
import { closeGenerationPanel, currentModelSet, openGenerationPanel, useGeneration } from '../generation/store'
import { aiEditConfigured } from '../generation/AIEditTab'
import { setMediaView } from '../media/model'
import { useSearchStatus } from '../media/search/status'
import { selectClips, setEditor } from '../state/editor'
import { getDoc, getTimeline, useProject } from '../state/project'
import { findAIEditClip, hostPanel, linkGroupIds, makeSteps, type TourContext, type TourStep } from './logic'
import { t } from '../i18n'

interface TourState {
  steps: TourStep[]
  /** Index into `steps`; -1 = not running. */
  index: number
  /** Set by onboarding's Tutorial button: start once the tutorial project's editor is up. */
  pendingStart: boolean
}

export const useTour = create<TourState>(() => ({ steps: [], index: -1, pendingStart: false }))

const tour = () => useTour.getState()

/** Snapshot of what the tour can show right now. */
export function tourContext(): TourContext {
  const set = currentModelSet()
  const doc = getDoc()
  const entries = doc?.manifest.entries ?? []
  const status = useSearchStatus.getState().status
  const smartSearchOffered = !!status && status.model.kind === 'notInstalled' && status.enabled && entries.some((e) => e.type === 'video' || e.type === 'image')
  const t = getTimeline()
  const inLibrary = (ref: string) => entries.some((e) => e.id === ref)
  const hasAIEditClip = aiEditConfigured(set) && !!t && !!findAIEditClip(t.tracks, inLibrary)
  return { canGenerate: set.canGenerate, smartSearchOffered, hasAIEditClip }
}

/** Help ▸ Tutorial / onboarding: no-op without an open project. */
export function startTour(): void {
  if (!useProject.getState().snapshot) return
  const steps = makeSteps(tourContext())
  useTour.setState({ steps, index: 0, pendingStart: false })
  applyStep(steps[0])
}

export function requestTourOnOpen(): void {
  useTour.setState({ pendingStart: true })
}

export function endTour(): void {
  if (tour().index < 0) return
  useTour.setState({ steps: [], index: -1 })
}

export function goToStep(index: number): void {
  const { steps } = tour()
  if (index < 0) return
  if (index >= steps.length) return endTour()
  useTour.setState({ index })
  applyStep(steps[index])
}

export const nextStep = () => goToStep(tour().index + 1)
export const previousStep = () => goToStep(tour().index - 1)

/** Clicks an inspector title tab by its label once React has rendered the selection (Mac `inspectorClipTabRequest`). */
function requestInspectorTab(title: string): void {
  let tries = 0
  const attempt = () => {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-panel="inspectorPanel"] .pp-title-tab')]
    const tab = tabs.find((b) => b.textContent?.trim() === title)
    if (tab) {
      if (!tab.classList.contains('on')) tab.click()
      return
    }
    if (++tries < 20) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

function selectAIEditClip(): boolean {
  const t = getTimeline()
  const entries = getDoc()?.manifest.entries ?? []
  const clip = t ? findAIEditClip(t.tracks, (ref) => entries.some((e) => e.id === ref)) : null
  if (!t || !clip) return false
  setEditor({ range: null, selectedGap: null, selectedMarkerIds: [] })
  selectClips(linkGroupIds(t.tracks, clip))
  return true
}

/** Un-maximize, reveal the host panel, show the generation panel only for its own step, then run the prepare action. */
export function applyStep(step: TourStep): void {
  setEditor({ maximized: null })
  const host = hostPanel(step)
  if (host === 'media' || host === 'inspector' || host === 'agent') showPanelFitting(host)
  const wantsGeneration = step.kind === 'element' && step.element === 'generation'
  if (wantsGeneration) openGenerationPanel()
  else if (useGeneration.getState().open) closeGenerationPanel()
  if (step.kind === 'element' && host === 'media') setMediaView({ section: 'media', searchExpanded: false })
  const prepare = step.kind === 'panel' || step.kind === 'element' ? step.prepare : undefined
  switch (prepare) {
    case 'selectAIEditClip':
      selectAIEditClip()
      break
    case 'revealInspectorOverview':
      if (selectAIEditClip()) requestInspectorTab(t('Video'))
      break
    case 'revealAIEditTab':
      if (selectAIEditClip()) requestInspectorTab(t('AI Edit'))
      break
  }
}
