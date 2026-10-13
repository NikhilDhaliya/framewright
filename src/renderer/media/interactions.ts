import type { Doc } from '@core/ops/context'
import { editor, setEditor, type MediaKey } from '../state/editor'
import { runOp } from '../state/ops'
import { activatePreviewTab, assetTabId } from '../state/previewTabs'
import { getDoc, useProject } from '../state/project'
import { tidy, openMenu, type MenuItem } from '../ui/Menu'
import { toast } from '../ui/toast'
import { deleteMediaItems, importMedia, newFolder } from './actions'
import { activeDrag, beginInternalDrag, decodeDragItems, droppedPaths, isFileDrag, type DragItem } from './drag'
import { assetPath, byName, folderPath, mediaView, parseKey, setMediaView } from './model'
import { cachedThumbnail } from './thumbnails'
import { generationMenuItems } from '../generation/menu'
import { extractAudioMenuItem } from '../extras/menus'
import { tileOffline } from './mediaRules'
import { relinkAsset, useOffline } from './offline'
import { t } from '../i18n'

/** Visible item order, refreshed by the grid on every render (range selection, arrows, marquee). */
export const visibleOrder: { keys: MediaKey[] } = { keys: [] }
let anchor: MediaKey | null = null

const setSelection = (keys: MediaKey[]) => setEditor({ mediaSelection: keys })

function rangeKeys(from: MediaKey | null, to: MediaKey): MediaKey[] {
  const order = visibleOrder.keys
  const a = from ? order.indexOf(from) : -1
  const b = order.indexOf(to)
  if (a < 0 || b < 0) return [to]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export function openItem(key: MediaKey): void {
  const { kind, id } = parseKey(key)
  if (kind === 'folder') {
    setMediaView({ viewMode: 'folders', query: '', searchExpanded: false })
    setEditor({ mediaFolderId: id, mediaSelection: [] })
    anchor = null
  } else if (kind === 'timeline') {
    void runOp('activateTimeline', { id }, { quiet: true })
  } else {
    activatePreviewTab(assetTabId(id))
  }
}

/** Click selection (§4.8): plain replaces, Ctrl toggles, Shift selects a range, Ctrl+Shift adds a range. */
export function clickItem(key: MediaKey, e: React.MouseEvent): void {
  const sel = editor().mediaSelection
  const ctrl = e.ctrlKey || e.metaKey
  if (e.shiftKey) {
    const range = rangeKeys(anchor, key)
    setSelection(ctrl ? [...new Set([...sel, ...range])] : range)
    return
  }
  if (ctrl) {
    setSelection(sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key])
    anchor = key
    return
  }
  anchor = key
  if (e.detail >= 2 && parseKey(key).kind !== 'asset') return openItem(key)
  if (!(sel.length === 1 && sel[0] === key)) setSelection([key])
  if (parseKey(key).kind === 'asset') activatePreviewTab(assetTabId(parseKey(key).id))
}

export function selectKeys(keys: MediaKey[], additive: boolean): void {
  setSelection(additive ? [...new Set([...editor().mediaSelection, ...keys])] : keys)
}

export function selectAll(): void {
  setSelection([...visibleOrder.keys])
}

/** Arrow-key navigation; ↑/↓ move by the column count. */
export function moveSelection(delta: number, extend: boolean): void {
  const order = visibleOrder.keys
  if (!order.length) return
  const sel = editor().mediaSelection
  const current = anchor && sel.includes(anchor) ? anchor : sel[sel.length - 1]
  const i = current ? order.indexOf(current) : -1
  const next = order[i < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, i + delta))]
  if (extend) setSelection(rangeKeys(anchor ?? current ?? next, next))
  else {
    anchor = next
    setSelection([next])
  }
  revealKey(next)
}

export function goToParentFolder(): void {
  const doc = getDoc()
  const cur = editor().mediaFolderId
  if (!doc || !cur) return
  const parent = doc.manifest.folders.find((f) => f.id === cur)?.parentFolderId ?? null
  setEditor({ mediaFolderId: parent, mediaSelection: [`folder:${cur}`] })
  anchor = `folder:${cur}`
}

export function revealKey(key: MediaKey): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.querySelector(`[data-media-key="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })),
  )
}

export async function commitRename(key: MediaKey, name: string): Promise<void> {
  setMediaView({ renaming: null })
  const { kind, id } = parseKey(key)
  if (kind === 'asset') await runOp('renameMedia', { id, name })
  else if (kind === 'folder') await runOp('renameFolder', { id, name })
  else await runOp('renameTimeline', { id, name })
}

export const beginRename = (key: MediaKey) => setMediaView({ renaming: key })
export const cancelRename = () => setMediaView({ renaming: null })

// ---------- Context menus ----------

const targetsFor = (key: MediaKey): MediaKey[] => {
  const sel = editor().mediaSelection
  if (sel.includes(key)) return sel
  setSelection([key])
  anchor = key
  return [key]
}

const idsOf = (keys: MediaKey[], kind: 'asset' | 'folder' | 'timeline') => keys.filter((k) => k.startsWith(`${kind}:`)).map((k) => parseKey(k).id)

function moveItems(keys: MediaKey[], folderId: string | null): Promise<unknown> {
  return runOp('moveToFolder', { assets: idsOf(keys, 'asset'), timelines: idsOf(keys, 'timeline'), folders: idsOf(keys, 'folder'), folderId })
}

function moveToFolderMenu(doc: Doc, keys: MediaKey[]): MenuItem {
  const moving = new Set(idsOf(keys, 'folder'))
  const parentOf = (k: MediaKey): string | null => {
    const { kind, id } = parseKey(k)
    if (kind === 'asset') return doc.manifest.entries.find((e) => e.id === id)?.folderId ?? null
    if (kind === 'timeline') return doc.file.timelines.find((t) => t.id === id)?.folderId ?? null
    return doc.manifest.folders.find((f) => f.id === id)?.parentFolderId ?? null
  }
  const anyNested = keys.some((k) => parentOf(k) !== null) || editor().mediaFolderId !== null
  const folders = doc.manifest.folders.filter((f) => !moving.has(f.id)).sort(byName)
  return {
    label: t('Move to Folder'),
    submenu: tidy([
      {
        label: t('New Folder'),
        icon: 'folder.badge.plus',
        onSelect: async () => {
          const id = await newFolder(editor().mediaFolderId)
          if (id) await moveItems(keys, id)
        },
      },
      anyNested && { label: t('Library'), icon: 'folder', onSelect: () => void moveItems(keys, null) },
      folders.length > 0 && { kind: 'divider' },
      ...folders.map((f): MenuItem => ({ label: folderPath(doc.manifest.folders, f.id).map((x) => x.name).join(' / '), icon: 'folder', onSelect: () => void moveItems(keys, f.id) })),
    ]),
  }
}

export function itemContextMenu(key: MediaKey, e: React.MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const doc = getDoc()
  if (!doc) return
  const keys = targetsFor(key)
  const { kind, id } = parseKey(key)
  const single = keys.length === 1
  let items: (MenuItem | false)[]
  if (kind === 'folder' && single) {
    items = [
      { label: t('Open'), onSelect: () => openItem(key) },
      { label: t('Rename'), onSelect: () => beginRename(key) },
      { kind: 'divider' },
      { label: t('Delete'), destructive: true, onSelect: () => void deleteMediaItems(keys) },
    ]
  } else if (kind === 'timeline' && single) {
    items = [
      { label: t('Open'), onSelect: () => openItem(key) },
      { label: t('Rename'), onSelect: () => beginRename(key) },
      { label: t('Duplicate'), onSelect: () => void runOp('duplicateTimeline', { id }) },
      { kind: 'divider' },
      { label: t('Delete'), destructive: true, disabled: doc.file.timelines.length <= 1, onSelect: () => void deleteMediaItems(keys) },
    ]
  } else {
    const project = useProject.getState().snapshot?.path ?? ''
    const assets = idsOf(keys, 'asset')
      .map((aid) => doc.manifest.entries.find((x) => x.id === aid))
      .filter((x) => !!x)
    const paths = assets.map((a) => assetPath(a, project))
    items = [
      moveToFolderMenu(doc, keys),
      { kind: 'divider' },
      ...(single && kind === 'asset' && assets[0] && tileOffline(assets[0], useOffline.getState().offline)
        ? [{ label: t('Relink…'), onSelect: () => void relinkAsset(id) }, { kind: 'divider' } as const]
        : []),
      single && kind === 'asset' && { label: t('Rename'), onSelect: () => beginRename(key) },
      ...(single && kind === 'asset' && assets[0] ? generationMenuItems(assets[0]) : []),
      single && kind === 'asset' && { kind: 'divider' },
      // `canExtractAudio` excludes offline sources.
      extractAudioMenuItem(assets.filter((x) => !useOffline.getState().offline.has(x.id))),
      paths.length === 1 && { label: t('Show in Folder'), onSelect: () => window.palmier.app.showItemInFolder(paths[0]) },
      paths.length > 0 && {
        label: t('Copy Path'),
        onSelect: () => {
          void navigator.clipboard.writeText(paths.join('\n')).catch(() => toast(t("Couldn't copy the path."), 'error'))
        },
      },
      { kind: 'divider' },
      { label: t('Delete'), destructive: true, onSelect: () => void deleteMediaItems(keys) },
    ]
  }
  openMenu(tidy(items), e.clientX, e.clientY)
}

export function backgroundContextMenu(e: React.MouseEvent): void {
  e.preventDefault()
  openMenu(
    [
      { label: t('New Folder'), icon: 'folder.badge.plus', onSelect: () => void newFolder() },
      { label: t('Import Media…'), onSelect: () => void importMedia() },
    ],
    e.clientX,
    e.clientY,
  )
}

// ---------- Drag sources ----------

/** The dragged set: every selected item if the tile is selected (assets in library order), else the tile. */
function dragItemsFor(key: MediaKey): DragItem[] {
  const doc = getDoc()
  const sel = editor().mediaSelection
  const keys = sel.includes(key) ? sel : [key]
  if (!sel.includes(key)) {
    setSelection([key])
    anchor = key
  }
  const set = new Set(keys)
  const assets = (doc?.manifest.entries ?? []).filter((e) => set.has(`asset:${e.id}`)).map((e): DragItem => ({ kind: 'asset', id: e.id }))
  const timelines = (doc?.file.timelines ?? []).filter((t) => set.has(`timeline:${t.id}`)).map((t): DragItem => ({ kind: 'timeline', id: t.id }))
  const folders = keys.filter((k) => k.startsWith('folder:')).map((k): DragItem => ({ kind: 'folder', id: parseKey(k).id }))
  return [...assets, ...timelines, ...folders]
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function thumbImage(src: string | null): HTMLImageElement | null {
  if (!src) return null
  const img = document.querySelector<HTMLImageElement>(`img[src="${CSS.escape(src)}"]`)
  return img?.complete && img.naturalWidth ? img : null
}

/** Offscreen drag image: 80×60 fit thumbnail with accent border (+count pill), or a name pill for folders/timelines. */
function dragImage(items: DragItem[], doc: Doc): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const accent = cssVar('--pp-accent') || '#ececec'
  const lead = items[0]
  if (lead.kind === 'asset') {
    const W = 96
    const H = 72
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    ctx.scale(dpr, dpr)
    const x = 4
    const y = 8
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = 8
    ctx.shadowOffsetY = 2
    roundRect(ctx, x, y, 80, 60, 6)
    ctx.fillStyle = '#000'
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.save()
    roundRect(ctx, x, y, 80, 60, 6)
    ctx.clip()
    const img = thumbImage(cachedThumbnail(lead.id))
    if (img) {
      const s = Math.min(80 / img.naturalWidth, 60 / img.naturalHeight)
      const w = img.naturalWidth * s
      const h = img.naturalHeight * s
      ctx.drawImage(img, x + (80 - w) / 2, y + (60 - h) / 2, w, h)
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.62)'
      ctx.font = '500 10px Inter'
      ctx.textAlign = 'center'
      const name = doc.manifest.entries.find((e) => e.id === lead.id)?.name ?? ''
      ctx.fillText(name.length > 14 ? `${name.slice(0, 13)}…` : name, x + 40, y + 34)
    }
    ctx.restore()
    roundRect(ctx, x + 0.75, y + 0.75, 78.5, 58.5, 6)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = accent
    ctx.stroke()
    if (items.length > 1) {
      const label = String(items.length)
      ctx.font = '700 11px Inter'
      const tw = ctx.measureText(label).width
      const pw = Math.max(18, tw + 12)
      roundRect(ctx, x + 80 + 4 - pw, y - 4 - 2, pw, 17, 8.5)
      ctx.fillStyle = accent
      ctx.fill()
      ctx.fillStyle = cssVar('--pp-bg-base') || '#18191c'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x + 80 + 4 - pw / 2, y - 4 - 2 + 8.5)
    }
    return canvas
  }
  const name = lead.kind === 'folder' ? (doc.manifest.folders.find((f) => f.id === lead.id)?.name ?? '') : (doc.file.timelines.find((t) => t.id === lead.id)?.name ?? '')
  ctx.font = '500 11px Inter'
  const W = Math.ceil(Math.min(220, ctx.measureText(name).width) + 16 + 18 + 12)
  canvas.width = W * dpr
  canvas.height = 34 * dpr
  canvas.style.width = `${W}px`
  canvas.style.height = '34px'
  ctx.scale(dpr, dpr)
  roundRect(ctx, 4, 4, W - 8, 26, 6)
  ctx.fillStyle = cssVar('--pp-bg-prominent') || '#303137'
  ctx.fill()
  ctx.strokeStyle = cssVar('--pp-border-primary') || 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = accent
  if (lead.kind === 'folder') {
    ctx.beginPath()
    ctx.roundRect(12, 12, 13, 10, 1.5)
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(12, 10.5, 6, 3, 1)
    ctx.fill()
  } else {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 1 - i * 0.3
      ctx.fillRect(12 + i, 11 + i * 4, 13 - i * 2, 2.5)
    }
    ctx.globalAlpha = 1
  }
  ctx.font = '500 11px Inter'
  ctx.fillStyle = cssVar('--pp-text-primary') || '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, 32, 17.5, 220)
  return canvas
}

export function dragStartItem(key: MediaKey, e: React.DragEvent): void {
  const doc = getDoc()
  if (!doc || mediaView().renaming === key) {
    e.preventDefault()
    return
  }
  const items = dragItemsFor(key)
  if (!items.length) return e.preventDefault()
  beginInternalDrag(e, items)
  const img = dragImage(items, doc)
  img.style.position = 'fixed'
  img.style.left = '-1000px'
  img.style.top = '-1000px'
  document.body.appendChild(img)
  e.dataTransfer.setDragImage(img, items[0].kind === 'asset' ? 44 : 18, items[0].kind === 'asset' ? 38 : 17)
  setTimeout(() => img.remove(), 0)
}

// ---------- Drop targets (folders, breadcrumbs, grouped sections) ----------

/** True when the drag can land in `folderId`: OS files, or internal items not moving a folder into itself. */
export function acceptsFolderDrop(e: React.DragEvent, folderId: string | null): boolean {
  if (isFileDrag(e)) return true
  const items = activeDrag.items
  if (!items?.length) return false
  if (folderId && items.some((it) => it.kind === 'folder' && it.id === folderId)) return false
  return true
}

export async function dropIntoFolder(e: React.DragEvent, folderId: string | null): Promise<void> {
  e.preventDefault()
  e.stopPropagation()
  if (isFileDrag(e)) {
    const paths = droppedPaths(e)
    if (paths.length) await importMedia(paths, folderId)
    return
  }
  const items = decodeDragItems(e.dataTransfer.getData('text/plain'))
  if (!items.length) return
  const ids = (kind: DragItem['kind']) => items.filter((it) => it.kind === kind).map((it) => it.id)
  await runOp('moveToFolder', { assets: ids('asset'), timelines: ids('timeline'), folders: ids('folder').filter((id) => id !== folderId), folderId }, { quiet: true })
}
