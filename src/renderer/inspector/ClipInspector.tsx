import { useEffect, useRef, useState } from 'react'
import type { Clip, MulticamSource } from '@core/model'
import { useProject } from '../state/project'
import { MulticamTab, selectedGroups } from './MulticamTab'
import { setEditor } from '../state/editor'
import { TitleTabBar, type TitleTab } from '../ui/panels'
import { AdjustTab } from './AdjustTab'
import { AnimateTab } from './AnimateTab'
import { AudioTab } from './AudioTab'
import { ContentTab } from './ContentTab'
import { VideoTab } from './VideoTab'
import { AIEditTab, useAIEditTarget } from '../generation/AIEditTab'
import { t } from '../i18n'

type TabId = 'text' | 'textAnimate' | 'video' | 'effects' | 'audio' | 'multicam' | 'ai'

const ALL_TABS: TitleTab<TabId>[] = [
  { id: 'text', title: t('Content'), icon: 'text.alignleft' },
  { id: 'textAnimate', title: t('Animate'), icon: 'diamond' },
  { id: 'video', title: t('Video'), icon: 'video' },
  { id: 'effects', title: t('Adjust'), icon: 'slider.horizontal.3' },
  { id: 'audio', title: t('Audio'), icon: 'waveform' },
  { id: 'multicam', title: t('Multicam'), icon: 'square.grid.2x2' },
  { id: 'ai', title: t('AI Edit'), icon: 'wand.and.stars' },
]

/** §7.3 availability: text-only → Content/Animate; non-text visual → Video/Adjust; audio → Audio; group member → Multicam. */
function availableTabs(clips: Clip[], groups: MulticamSource[] | undefined): TabId[] {
  const out: TabId[] = []
  const visual = clips.filter((c) => c.mediaType !== 'audio')
  if (visual.length && visual.length === clips.length && visual.every((c) => c.mediaType === 'text')) out.push('text', 'textAnimate')
  if (visual.some((c) => c.mediaType !== 'text')) out.push('video', 'effects')
  if (clips.some((c) => c.mediaType === 'audio')) out.push('audio')
  if (selectedGroups(groups, clips).length) out.push('multicam')
  return out
}

let preferred: TabId = 'video'

export function ClipInspector({ clips }: { clips: Clip[] }) {
  const aiTarget = useAIEditTarget(clips)
  const groups = useProject((st) => (st.preview ?? st.snapshot?.doc)?.file.multicamGroups)
  const base = availableTabs(clips, groups)
  const tabs = aiTarget ? [...base, 'ai' as const] : base
  const singleText = clips.length === 1 && clips[0].mediaType === 'text'
  const selectionKey = clips.map((c) => c.id).join(',')
  const lastKey = useRef('')
  const [, rerender] = useState(0)
  if (lastKey.current !== selectionKey) {
    lastKey.current = selectionKey
    if (singleText) preferred = 'text'
    else if (preferred === 'text') preferred = 'video'
  }
  const active: TabId | undefined = tabs.includes(preferred) ? preferred : tabs[0]
  useEffect(() => {
    if (active !== 'video') setEditor({ cropEditing: false })
  }, [active])
  if (!active) return null
  const select = (id: TabId) => {
    preferred = id
    rerender((n) => n + 1)
  }
  const hasVisual = clips.some((c) => c.mediaType !== 'audio' && c.mediaType !== 'text')
  return (
    <div className="pp-insp-root">
      {tabs.length > 1 && <TitleTabBar tabs={ALL_TABS.filter((t) => tabs.includes(t.id))} active={active} onSelect={select} />}
      <div className="pp-insp-scroll" key={active}>
        {active === 'video' && <VideoTab clips={clips.filter((c) => c.mediaType !== 'audio' && c.mediaType !== 'text')} allClips={clips} />}
        {active === 'effects' && <AdjustTab clips={clips.filter((c) => c.mediaType !== 'audio' && c.mediaType !== 'text')} />}
        {active === 'audio' && <AudioTab clips={clips.filter((c) => c.mediaType === 'audio')} showPlayback={!hasVisual} />}
        {active === 'text' && <ContentTab clips={clips} />}
        {active === 'textAnimate' && <AnimateTab clips={clips} />}
        {active === 'multicam' && <MulticamTab clips={clips} />}
        {active === 'ai' && aiTarget && <AIEditTab asset={aiTarget.asset} clipId={aiTarget.clipId} />}
      </div>
    </div>
  )
}
