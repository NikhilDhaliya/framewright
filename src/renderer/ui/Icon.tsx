import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown, ArrowLeftRight, ArrowUp, ArrowUpDown, ArrowUpRight, AudioWaveform, Bold, Book, Camera, Captions, Check, ChevronDown,
  ChevronLeft, ChevronRight, Circle, CircleArrowDown, CircleCheck, CircleUserRound, CircleX, Clapperboard, Clock, Copy, Crop, Diamond,
  Ellipsis, Eye, EyeOff, File, Film, Focus, Folder, FolderPlus, FolderX, GalleryVerticalEnd, Gauge, Globe, Grid2x2, GripHorizontal,
  HardDrive, Image, ImagePlus, Images, Info, Italic, KeyRound, Keyboard, Layers, LayoutGrid, Link, Link2Off, ListFilter, ListVideo,
  MessageSquare, Minus, MousePointer2, MoveHorizontal, MoveVertical, Music, Network, Package, Palette, PanelLeft, PanelRight, Pause,
  Pipette, Play, Plus, Ratio, Redo2, RotateCcw, RotateCw, Rows2, Ruler, Scan, ScanSearch, Scissors, Search, Send, Settings, Share,
  SkipBack, SkipForward, SlidersHorizontal, Sparkles, Square, SquareSplitHorizontal, Star, StepBack, StepForward, Strikethrough, Sun,
  TextAlignCenter, TextAlignEnd, TextAlignStart, Trash, TriangleAlert, Type, Underline, Undo2, Video, Volume2, VolumeX, WandSparkles,
  X, ZoomIn, ZoomOut, MessageSquareText, MessageSquareMore, Smile, LocateFixed, Library, Pencil,
  History, CircleArrowUp, CircleAlert, SquareArrowOutUpRight,
} from 'lucide-react'
import type { CSSProperties } from 'react'

const MAP = {
  'sidebar.left': PanelLeft,
  'sidebar.right': PanelRight,
  'bubble.left': MessageSquare,
  'bubble.left.fill': MessageSquare,
  'square.and.arrow.up': Share,
  'arrow.down.circle.fill': CircleArrowDown,
  'film.stack': GalleryVerticalEnd,
  'film.stack.fill': GalleryVerticalEnd,
  film: Film,
  movieclapper: Clapperboard,
  'arrow.uturn.backward': Undo2,
  'arrow.uturn.forward': Redo2,
  cursorarrow: MousePointer2,
  scissors: Scissors,
  'arrow.left.and.right': MoveHorizontal,
  'arrow.up.and.down': MoveVertical,
  'square.split.2x1': SquareSplitHorizontal,
  'minus.magnifyingglass': ZoomOut,
  'plus.magnifyingglass': ZoomIn,
  magnifyingglass: Search,
  'sparkle.magnifyingglass': ScanSearch,
  'chevron.down': ChevronDown,
  'chevron.left': ChevronLeft,
  'chevron.right': ChevronRight,
  ellipsis: Ellipsis,
  plus: Plus,
  minus: Minus,
  xmark: X,
  'xmark.circle.fill': CircleX,
  checkmark: Check,
  'checkmark.circle.fill': CircleCheck,
  circle: Circle,
  'circle.fill': Circle,
  'exclamationmark.triangle': TriangleAlert,
  'exclamationmark.triangle.fill': TriangleAlert,
  'info.circle': Info,
  'info.circle.fill': Info,
  folder: Folder,
  'folder.fill': Folder,
  'folder.badge.plus': FolderPlus,
  'questionmark.folder': FolderX,
  'list.bullet.rectangle': ListVideo,
  'captions.bubble': Captions,
  waveform: AudioWaveform,
  photo: Image,
  'photo.badge.plus': ImagePlus,
  'photo.on.rectangle.angled': Images,
  video: Video,
  sparkles: Sparkles,
  'wand.and.stars': WandSparkles,
  'rectangle.grid.2x2': LayoutGrid,
  'square.grid.2x2': Grid2x2,
  'rectangle.split.1x2': Rows2,
  'arrow.up.arrow.down': ArrowUpDown,
  'line.3.horizontal.decrease': ListFilter,
  'line.3.horizontal': GripHorizontal,
  'square.fill': Square,
  paintpalette: Palette,
  aspectratio: Ratio,
  ruler: Ruler,
  link: Link,
  'personalhotspot.slash': Link2Off,
  diamond: Diamond,
  'diamond.fill': Diamond,
  'speaker.wave.2.fill': Volume2,
  'speaker.slash.fill': VolumeX,
  eye: Eye,
  'eye.slash': EyeOff,
  'play.fill': Play,
  'pause.fill': Pause,
  'backward.end.fill': SkipBack,
  'forward.end.fill': SkipForward,
  'backward.frame.fill': StepBack,
  'forward.frame.fill': StepForward,
  camera: Camera,
  viewfinder: Scan,
  'viewfinder.circle.fill': Focus,
  speedometer: Gauge,
  crop: Crop,
  eyedropper: Pipette,
  'slider.horizontal.3': SlidersHorizontal,
  'square.stack.3d.up': Layers,
  'text.alignleft': TextAlignStart,
  'text.aligncenter': TextAlignCenter,
  'text.alignright': TextAlignEnd,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  strikethrough: Strikethrough,
  textformat: Type,
  'arrow.clockwise': RotateCw,
  'arrow.counterclockwise': RotateCcw,
  'arrow.left.arrow.right': ArrowLeftRight,
  'arrow.up': ArrowUp,
  'arrow.down': ArrowDown,
  'arrow.up.right': ArrowUpRight,
  doc: File,
  'doc.on.doc': Copy,
  clock: Clock,
  'star.fill': Star,
  key: KeyRound,
  'person.crop.circle': CircleUserRound,
  gearshape: Settings,
  'sun.max': Sun,
  paperplane: Send,
  'book.closed': Book,
  internaldrive: HardDrive,
  keyboard: Keyboard,
  network: Network,
  trash: Trash,
  'trash.fill': Trash,
  shippingbox: Package,
  globe: Globe,
  'music.note': Music,
  // Captions tab Agent menu and Index ▸ Transcript (spec 07 §1.9, §1.11).
  'text.badge.minus': MessageSquareMore,
  'checkmark.bubble': MessageSquareText,
  'face.smiling': Smile,
  'timeline.selection': LocateFixed,
  // Settings ▸ Skills (05 §11.7).
  'books.vertical': Library,
  pencil: Pencil,
  // Export queue + Project Activity (05 §12 icon table).
  'clock.arrow.circlepath': History,
  'arrow.up.circle.fill': CircleArrowUp,
  'exclamationmark.circle.fill': CircleAlert,
  'xmark.circle': CircleX,
  'stop.fill': Square,
  'video.fill': Video,
  'photo.fill': Image,
  'arrow.up.right.square.fill': SquareArrowOutUpRight,
} satisfies Record<string, LucideIcon>

export type SFName = keyof typeof MAP

const FILLED = new Set<SFName>([
  'bubble.left.fill', 'circle.fill', 'diamond.fill', 'folder.fill', 'play.fill', 'pause.fill', 'star.fill', 'square.fill',
  'backward.end.fill', 'forward.end.fill', 'trash.fill', 'film.stack.fill', 'stop.fill',
])

interface IconProps {
  sf: SFName
  /** SF point size; Lucide renders at ≈1.15× with a weight-matched stroke. */
  size?: number
  className?: string
  style?: CSSProperties
  strokeWidth?: number
}

export function Icon({ sf, size = 11, className, style, strokeWidth }: IconProps) {
  const Cmp = MAP[sf]
  const px = Math.round(size * 1.15)
  const filled = FILLED.has(sf)
  return (
    <Cmp
      size={px}
      strokeWidth={strokeWidth ?? (filled ? 1.25 : size <= 13 ? 1.75 : 1.5)}
      fill={filled ? 'currentColor' : 'none'}
      className={className}
      style={{ flexShrink: 0, display: 'block', ...style }}
      aria-hidden
    />
  )
}
