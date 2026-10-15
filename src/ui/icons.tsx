/**
 * Monochrome icon set: Lucide (ISC) plus a handful of custom glyphs drawn in
 * the same 24px / 1.75 stroke style.
 */
import type { SVGProps } from 'react';
export {
  MousePointer2,
  Hand,
  Frame,
  Square,
  Circle,
  Triangle,
  Star,
  Minus,
  MoveUpRight,
  PenTool,
  Pencil,
  Brush,
  Paintbrush,
  SprayCan,
  Eraser,
  PaintBucket,
  Type,
  Image,
  Pipette,
  Shapes,
  Layers,
  Plus,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  Search,
  Settings,
  Download,
  Upload,
  Play,
  Undo2,
  Redo2,
  Copy,
  Trash,
  Group,
  Ungroup,
  SquaresUnite,
  SquaresSubtract,
  SquaresIntersect,
  SquaresExclude,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  RotateCw,
  Blend,
  Droplet,
  Sun,
  Moon,
  Monitor,
  Command,
  Keyboard,
  Plug,
  Cpu,
  Code,
  FileBraces,
  Gamepad2,
  Sparkles,
  Wand,
  WandSparkles,
  Component,
  Diamond,
  Heart,
  Cloud,
  MessageSquare,
  Zap,
  Ruler,
  Scan,
  Scissors,
  Spline,
  SquareDashed,
  Maximize2,
  ZoomIn,
  ZoomOut,
  Columns3,
  Rows3,
  LayoutGrid,
  SlidersHorizontal,
  SlidersVertical,
  Grid2x2,
  Grip,
  GripVertical,
  Palette,
  SwatchBook,
  Presentation,
  PanelLeft,
  PanelRight,
  Info,
  X,
  Check,
  FolderOpen,
  Save,
  FilePlus,
  FileCode,
  FileImage,
  FileText,
  FileDown,
  Share2,
  ExternalLink,
  Clipboard,
  ClipboardPaste,
  Ellipsis,
  Highlighter,
  Feather,
  Stamp,
  Link,
  Unlink,
  Repeat,
  Repeat2,
  CopyPlus,
  Crosshair,
  Move,
  Expand,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  TextAlignStart as AlignLeft,
  TextAlignCenter as AlignCenter,
  TextAlignEnd as AlignRight,
  TextAlignJustify as AlignJustify,
  TextWrap,
  ArrowUpToLine,
  ArrowDownToLine,
  Baseline,
  CaseSensitive,
  BringToFront,
  SendToBack,
  WavesHorizontal as Waves,
  Dot,
  RectangleHorizontal,
  Pentagon,
  Hexagon,
  Octagon,
  Squircle,
  Signature,
  Rainbow,
  Contrast,
  Aperture,
  Focus,
  ScanEye,
  GitBranch,
  Box,
  Boxes,
  Hash,
  Percent,
  Ratio,
  Scaling,
  ArrowRight,
  ArrowLeftRight,
  ArrowUpDown,
  CornerUpLeft,
  Infinity as InfinityIcon,
  RefreshCw,
  Pin,
  Slash,
  Bolt,
  Film,
  Globe,
  Smartphone,
  Tablet,
  Laptop,
  Tv,
  Watch,
  BookOpen,
  Lightbulb,
} from 'lucide-react';

type P = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

function Svg({ size = 16, strokeWidth = 1.75, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SpiralIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 12.5a.5.5 0 1 1 1-.5 1.5 1.5 0 0 1-1.5 1.5A2.5 2.5 0 0 1 9 11a3.5 3.5 0 0 1 3.5-3.5A4.5 4.5 0 0 1 17 12a5.5 5.5 0 0 1-5.5 5.5A6.5 6.5 0 0 1 5 11a7.5 7.5 0 0 1 7.5-7.5" />
  </Svg>
);

export const PixelIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 4h5v5H4zM9 9h5v5H9zM14 14h5v5h-5zM14 4h5v5h-5z" />
  </Svg>
);

export const AutoLayoutIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M8 9v6M12 9v6M16 9v6" />
  </Svg>
);

export const HugIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 6 4 12l3 6M17 6l3 6-3 6" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
  </Svg>
);

export const FillIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 12h16M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3" />
  </Svg>
);

export const FixedIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7v10M20 7v10M7 12h10" />
  </Svg>
);

export const CornerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 19V11a6 6 0 0 1 6-6h8" />
  </Svg>
);

export const IndependentCornersIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9V7a3 3 0 0 1 3-3h2M15 4h2a3 3 0 0 1 3 3v2M20 15v2a3 3 0 0 1-3 3h-2M9 20H7a3 3 0 0 1-3-3v-2" />
  </Svg>
);

export const StrokeWeightIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h16" strokeWidth={1} />
    <path d="M4 12h16" strokeWidth={2} />
    <path d="M4 18h16" strokeWidth={3.2} />
  </Svg>
);

export const ArcIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3a9 9 0 1 0 9 9h-9z" />
  </Svg>
);

export const LineIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 19 19 5" />
  </Svg>
);

export const PolygonIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 4 20 18H4z" />
  </Svg>
);

export const BrushStrokeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 17c3-1 4-6 7-6s3 5 6 5 4-4 5-6" strokeWidth={2.4} />
  </Svg>
);

export const MaskIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
  </Svg>
);

export const RobloxIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 3 21 6.5 17.5 21 3 17.5z" />
    <path d="m10.6 9.4 4 1-1 4-4-1z" />
  </Svg>
);

export const AltLogo = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M5.2 20.5 12 3.5l6.8 17" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4.6 14.6h14.8" stroke="currentColor" strokeWidth="1.3" />
    <rect x="2.6" y="13.1" width="3" height="3" rx="0.6" fill="#141417" stroke="currentColor" strokeWidth="1.2" />
    <rect x="18.4" y="13.1" width="3" height="3" rx="0.6" fill="#141417" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="12" cy="14.6" r="1.7" fill="currentColor" />
  </svg>
);

export const ConstraintIcon = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Svg>
);
