import { useEffect } from 'react'
import { mediaBridge } from '../editor/bridges'
import { editor } from '../state/editor'
import { Icon, type SFName } from '../ui/Icon'
import { TitleTabBar, type TitleTab } from '../ui/panels'
import { beginRename, goToParentFolder, moveSelection, openItem, revealKey, selectAll } from './interactions'
import { mediaView, parseKey, resetMediaView, setMediaView, useMediaView, type MediaSection } from './model'
import { MediaTab } from './MediaTab'
import { CaptionsTab } from './captions/CaptionsTab'
import { IndexTab } from './index/IndexTab'
import { MusicSection } from '../generation/MusicSection'
import { SpeechSections } from '../audio/SpeechSections'
import './media.css'
import { t } from '../i18n'

const TABS: TitleTab<MediaSection>[] = [
  { id: 'media', title: t('Media'), icon: 'folder' },
  { id: 'index', title: t('Index'), icon: 'list.bullet.rectangle' },
  { id: 'captions', title: t('Captions'), icon: 'captions.bubble' },
  { id: 'audio', title: t('Audio'), icon: 'waveform' },
]

function collapseSearch(): boolean {
  if (!mediaView().searchExpanded) return false
  setMediaView({ searchExpanded: false, query: '' })
  return true
}

function handleKey(e: KeyboardEvent): boolean {
  if (mediaView().section !== 'media') return false
  const mod = e.ctrlKey || e.metaKey
  switch (e.key) {
    case 'Escape':
      return collapseSearch()
    case 'ArrowLeft':
    case 'ArrowRight':
      if (mod || e.altKey) return false
      moveSelection(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey)
      return true
    case 'ArrowUp':
      if (mod || e.altKey) {
        goToParentFolder()
        return true
      }
      moveSelection(-mediaView().columns, e.shiftKey)
      return true
    case 'ArrowDown':
      if (mod || e.altKey) return false
      moveSelection(mediaView().columns, e.shiftKey)
      return true
    case 'Enter': {
      const sel = editor().mediaSelection
      if (sel.length !== 1 || parseKey(sel[0]).kind !== 'folder') return false
      openItem(sel[0])
      return true
    }
  }
  return false
}

function NotAvailable({ icon }: { icon: SFName }) {
  return (
    <div className="pp-media-unavailable">
      <Icon sf={icon} size={18} className="tone-muted" />
      <span>{t('Not available on Linux yet')}</span>
    </div>
  )
}

export function MediaPanel() {
  const section = useMediaView((s) => s.section)
  useEffect(() => {
    resetMediaView()
    mediaBridge.current = {
      handleKey,
      selectAll,
      collapseSearch,
      openSearch: () => setMediaView({ section: 'media', searchExpanded: true }),
      reveal: (key) => {
        setMediaView({ section: 'media', ...(mediaView().searchExpanded ? { searchExpanded: false, query: '' } : null) })
        revealKey(key)
      },
      beginRename: (key) => {
        setMediaView({ section: 'media' })
        beginRename(key)
        revealKey(key)
      },
    }
    return () => {
      mediaBridge.current = null
    }
  }, [])
  return (
    <div className="pp-media-panel">
      <TitleTabBar tabs={TABS} active={section} onSelect={(id) => setMediaView({ section: id, searchExpanded: false, query: '' })} />
      {section === 'media' ? (
        <MediaTab />
      ) : section === 'captions' ? (
        <CaptionsTab />
      ) : section === 'index' ? (
        <IndexTab />
      ) : section === 'audio' ? (
        // Audio tab: Music (spec 06 §B8); Speaker/Silence Detection sections belong to the audio-analysis UI.
        <div className="pp-media-audio-tab" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <MusicSection />
          <SpeechSections />
        </div>
      ) : (
        <NotAvailable icon={TABS.find((t) => t.id === section)!.icon} />
      )}
    </div>
  )
}
