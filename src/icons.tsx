import { HugeiconsIcon } from '@hugeicons/react'
import type { HugeiconsIconProps, IconSvgElement } from '@hugeicons/react'
import {
  AlertCircleIcon, ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowUp02Icon, Cancel01Icon, Copy01Icon,
  Delete02Icon, Download04Icon, DragDropVerticalIcon, File02Icon, FileCodeIcon, FileScriptIcon, Folder01Icon,
  GitForkIcon, GoogleDriveIcon, HistoryIcon, ImageAdd02Icon, Key01Icon, LinkSquare02Icon, Loading03Icon, Message01Icon, Moon02Icon,
  MoreHorizontalIcon, PaintBoardIcon, PencilEdit02Icon, PlusSignIcon, RefreshIcon, SidebarLeftIcon, SlidersHorizontalIcon, SourceCodeIcon,
  StopIcon, Sun03Icon, Tick02Icon, ViewIcon,
} from '@hugeicons/core-free-icons'

/**
 * 앱 전체 아이콘 (Hugeicons Stroke Rounded 무료 세트).
 * 쓰는 쪽은 이름만 불러와 일반 컴포넌트처럼 쓴다. 크기는 style/className 으로, 채움은 fill="currentColor" 로 정한다.
 */
type Props = Omit<HugeiconsIconProps, 'icon'>

const icon = (data: IconSvgElement) => (props: Props) => <HugeiconsIcon icon={data} strokeWidth={2} {...props} />

export const AlertCircle = icon(AlertCircleIcon)
export const ArrowUp = icon(ArrowUp02Icon)
export const Check = icon(Tick02Icon)
export const ChevronDown = icon(ArrowDown01Icon)
export const ChevronLeft = icon(ArrowLeft01Icon)
export const ChevronRight = icon(ArrowRight01Icon)
export const Code2 = icon(SourceCodeIcon)
export const Copy = icon(Copy01Icon)
export const Download = icon(Download04Icon)
export const Ellipsis = icon(MoreHorizontalIcon)
export const ExternalLink = icon(LinkSquare02Icon)
export const Eye = icon(ViewIcon)
export const FileCode2 = icon(FileCodeIcon)
export const FileJson = icon(FileScriptIcon)
export const FileText = icon(File02Icon)
export const FolderGit2 = icon(Folder01Icon)
export const GitFork = icon(GitForkIcon)
export const GoogleDrive = icon(GoogleDriveIcon)
export const SlidersHorizontal = icon(SlidersHorizontalIcon)
export const GripVertical = icon(DragDropVerticalIcon)
export const History = icon(HistoryIcon)
export const ImagePlus = icon(ImageAdd02Icon)
export const KeyRound = icon(Key01Icon)
export const Loader2 = icon(Loading03Icon)
export const MessageSquare = icon(Message01Icon)
export const Moon = icon(Moon02Icon)
export const Palette = icon(PaintBoardIcon)
export const PanelLeft = icon(SidebarLeftIcon)
export const Plus = icon(PlusSignIcon)
export const RefreshCw = icon(RefreshIcon)
export const Square = icon(StopIcon)
export const SquarePen = icon(PencilEdit02Icon)
export const Sun = icon(Sun03Icon)
export const Trash2 = icon(Delete02Icon)
export const X = icon(Cancel01Icon)
