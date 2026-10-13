/** Asset inspector "Generation Input" group (Mac `InspectorView.inputSection`; spec 05 inspector). */
import { useEffect, useState } from 'react'
import type { GenerationInput, MediaManifestEntry } from '@core/model'
import { setEditor } from '../state/editor'
import { useProject } from '../state/project'
import { revealKey } from '../media/interactions'
import { loadThumbnail } from '../media/thumbnails'
import { Icon } from '../ui/Icon'
import { Group } from '../ui/panels'
import { TYPE_ICON } from '../inspector/AssetInspector'
import { ProviderMark } from './GeneratePanel'
import { inputMetadataSummary, referenceSlots } from './generationInputInfo'
import { currentModelSet } from './store'
import { t } from '../i18n'

function RefThumb({ label, asset }: { label: string; asset: MediaManifestEntry }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setUrl(null)
    if (asset.type === 'image' || asset.type === 'video') void loadThumbnail(asset.id).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [asset.id, asset.type])
  const select = () => {
    setEditor({ mediaSelection: [`asset:${asset.id}`], focusedPanel: 'mediaPanel' })
    revealKey(`asset:${asset.id}`)
  }
  return (
    <div className="pp-gen-input-ref" data-tip={`${label} · ${asset.name}`} onClick={select}>
      <div className="pp-gen-input-thumb">{url ? <img src={url} alt="" draggable={false} /> : <Icon sf={TYPE_ICON[asset.type]} size={14} />}</div>
      <span className="pp-gen-input-ref-label ellipsis">{label}</span>
    </div>
  )
}

function CopyPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className={`pp-gen-input-copy${copied ? ' copied' : ''}`}
      data-tip={copied ? t('Copied') : t('Copy prompt')}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      <Icon sf={copied ? 'checkmark' : 'doc.on.doc'} size={11} />
    </button>
  )
}

export function GenerationInputGroup({ gen }: { gen: GenerationInput }) {
  const entries = useProject((s) => s.snapshot?.doc.manifest.entries)
  const model = currentModelSet().find(gen.model)
  const slots = referenceSlots(gen, model, entries ?? [])
  const metadata = inputMetadataSummary(gen, model)
  const prompt = typeof gen.prompt === 'string' ? gen.prompt : ''
  const cost = typeof gen.costCredits === 'number' ? gen.costCredits : null
  return (
    <Group title={t('Generation Input')}>
      {slots.length > 0 && (
        <div className="pp-gen-input-refs">
          {slots.map((s, i) => (
            <RefThumb key={`${s.asset.id}-${i}`} label={s.label} asset={s.asset} />
          ))}
        </div>
      )}
      {(prompt || metadata) && (
        <div className="pp-gen-input-box" style={{ marginTop: slots.length ? 12 : 0 }}>
          {prompt && (
            <div className="pp-gen-input-prompt">
              <div className="pp-gen-input-prompt-head">
                <span>{t('Prompt')}</span>
                <span style={{ flex: 1 }} />
                <CopyPromptButton text={prompt} />
              </div>
              <div className="pp-gen-input-prompt-text">{prompt}</div>
            </div>
          )}
          {prompt && metadata && <div className="pp-gen-input-sep" />}
          {metadata && (
            <div className="pp-gen-input-meta">
              {model ? <ProviderMark model={model} size={12} /> : <Icon sf="sparkles" size={10} />}
              <span className="pp-gen-input-meta-text ellipsis" data-tip={metadata}>
                {metadata}
              </span>
              {cost !== null && (
                <span className="pp-gen-input-cost tnum" data-tip={`${cost.toLocaleString()} credits used (Palmier Cloud)`}>
                  {cost.toLocaleString()} cr
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Group>
  )
}
