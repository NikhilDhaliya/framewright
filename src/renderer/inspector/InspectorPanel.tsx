import './inspector.css'
import { useEditor } from '../state/editor'
import { useManifest } from '../state/project'
import { AssetInspector } from './AssetInspector'
import { ClipInspector } from './ClipInspector'
import { useSelectedClips } from './model'
import { ProjectSettings } from './ProjectSettings'

export function InspectorPanel() {
  const marquee = useEditor((s) => s.marqueeCount)
  const clips = useSelectedClips()
  const mediaSelection = useEditor((s) => s.mediaSelection)
  const manifest = useManifest()
  if (marquee !== null) return <div className="pp-insp-marquee">{`${marquee} selected`}</div>
  if (clips.length) return <ClipInspector clips={clips} />
  const asset = mediaSelection.length === 1 && mediaSelection[0].startsWith('asset:') ? manifest?.entries.find((e) => e.id === mediaSelection[0].slice(6)) : undefined
  if (asset) return <AssetInspector asset={asset} />
  return <ProjectSettings />
}
