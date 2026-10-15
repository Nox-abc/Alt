/**
 * Alt document model.
 *
 * The document is a flat map of nodes keyed by id. Every node stores its
 * parent id and containers store an ordered list of child ids (back-to-front).
 * Coordinates are parent-relative: a node's local box is [0, 0, width, height]
 * and it is placed into its parent with
 *
 *   M = translate(x + w/2, y + h/2) · rotate(rotation) · scale(flipX, flipY) · translate(-w/2, -h/2)
 *
 * so (x, y) is the top-left of the un-rotated box and rotation happens around
 * the centre.
 */

export type ID = string;

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'plus-lighter'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/* ------------------------------------------------------------------ paints */

export interface GradientStop {
  /** 0..1 */
  offset: number;
  /** #rrggbb */
  color: string;
  /** 0..1 */
  opacity: number;
}

export interface PaintBase {
  id: ID;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode?: BlendMode;
}

export interface SolidPaint extends PaintBase {
  type: 'solid';
  /** #rrggbb */
  color: string;
}

export type GradientType = 'linear' | 'radial' | 'angular' | 'diamond';

export interface GradientPaint extends PaintBase {
  type: GradientType;
  stops: GradientStop[];
  /**
   * Handle positions, normalised to the node box (0..1).
   *  - linear: start → end
   *  - radial / diamond: centre → point on the radius
   *  - angular: centre → start direction
   */
  from: Vec;
  to: Vec;
}

export type ImageFit = 'fill' | 'fit' | 'crop' | 'tile' | 'stretch';

export interface ImageFilters {
  exposure: number; // -1..1
  contrast: number; // -1..1
  saturation: number; // -1..1
  temperature: number; // -1..1
  tint: number; // -1..1
  highlights: number; // -1..1
  shadows: number; // -1..1
}

export interface ImagePaint extends PaintBase {
  type: 'image';
  assetId: ID;
  fit: ImageFit;
  /** tile scale (tile fit only) */
  scale: number;
  rotation: number;
  filters?: Partial<ImageFilters>;
}

export type PatternKind = 'dots' | 'grid' | 'lines' | 'diagonal' | 'checker' | 'cross' | 'waves' | 'zigzag' | 'triangles' | 'hexagons';

export interface PatternPaint extends PaintBase {
  type: 'pattern';
  pattern: PatternKind;
  color: string;
  background: string | null;
  /** cell size in px */
  scale: number;
  rotation: number;
  /** stroke / dot thickness factor 0..1 */
  weight: number;
}

export interface NoisePaint extends PaintBase {
  type: 'noise';
  color: string;
  background: string | null;
  /** 0..1 amount of grains */
  density: number;
  /** grain size in px */
  size: number;
  seed: number;
}

export type Paint = SolidPaint | GradientPaint | ImagePaint | PatternPaint | NoisePaint;
export type PaintType = Paint['type'];

/* ----------------------------------------------------------------- effects */

export interface ShadowEffect {
  id: ID;
  type: 'drop-shadow' | 'inner-shadow';
  visible: boolean;
  color: string;
  opacity: number;
  x: number;
  y: number;
  blur: number;
  spread: number;
}

export interface GlowEffect {
  id: ID;
  type: 'glow';
  visible: boolean;
  color: string;
  opacity: number;
  blur: number;
  spread: number;
}

export interface BlurEffect {
  id: ID;
  type: 'layer-blur' | 'background-blur';
  visible: boolean;
  radius: number;
}

export interface NoiseEffect {
  id: ID;
  type: 'noise';
  visible: boolean;
  /** 0..1 */
  amount: number;
  /** grain size in px */
  size: number;
  monochrome: boolean;
}

export interface AdjustEffect {
  id: ID;
  type: 'adjust';
  visible: boolean;
  brightness: number; // -1..1
  contrast: number; // -1..1
  saturation: number; // -1..1
  hue: number; // degrees
  grayscale: number; // 0..1
  sepia: number; // 0..1
  invert: number; // 0..1
}

export type Effect = ShadowEffect | GlowEffect | BlurEffect | NoiseEffect | AdjustEffect;
export type EffectType = Effect['type'];

/* ------------------------------------------------------------------- nodes */

export type NodeType = 'frame' | 'group' | 'boolean' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'path' | 'text' | 'brush' | 'bitmap';

export type StrokeAlign = 'center' | 'inside' | 'outside';
export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';
export type Marker = 'none' | 'arrow' | 'triangle' | 'circle' | 'square' | 'diamond' | 'bar';

export type ConstraintH = 'left' | 'right' | 'center' | 'scale' | 'stretch';
export type ConstraintV = 'top' | 'bottom' | 'center' | 'scale' | 'stretch';
export type Sizing = 'fixed' | 'hug' | 'fill';

export interface ExportSetting {
  id: ID;
  format: 'png' | 'jpg' | 'webp' | 'svg' | 'pdf';
  scale: number;
  suffix: string;
}

export interface BaseNode {
  id: ID;
  type: NodeType;
  name: string;
  /** page id or container node id */
  parentId: ID;
  x: number;
  y: number;
  width: number;
  height: number;
  /** degrees, clockwise */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  fills: Paint[];
  strokes: Paint[];
  strokeWidth: number;
  strokeAlign: StrokeAlign;
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  dash: number[];
  effects: Effect[];
  constraints: { h: ConstraintH; v: ConstraintV };
  /** sizing behaviour inside / as an auto-layout container */
  sizingH: Sizing;
  sizingV: Sizing;
  /** 'absolute' children of auto-layout frames ignore the layout */
  layoutPositioning: 'auto' | 'absolute';
  /** when true the node masks the siblings above it */
  isMask: boolean;
  exportSettings: ExportSetting[];
  /** free-form data for plugins / scripts / MCP clients */
  meta?: Record<string, unknown>;
}

export interface CornerProps {
  /** uniform radius */
  cornerRadius: number;
  /** per-corner radii [tl, tr, br, bl]; when null the uniform radius is used */
  cornerRadii: [number, number, number, number] | null;
  /** 0..1, iOS-style continuous corners */
  cornerSmoothing: number;
}

export interface AutoLayout {
  mode: 'horizontal' | 'vertical';
  gap: number;
  /** [top, right, bottom, left] */
  padding: [number, number, number, number];
  /** cross-axis alignment */
  align: 'start' | 'center' | 'end' | 'stretch';
  /** main-axis distribution */
  justify: 'start' | 'center' | 'end' | 'space-between';
  wrap: boolean;
}

export interface LayoutGrid {
  id: ID;
  type: 'grid' | 'columns' | 'rows';
  visible: boolean;
  size: number;
  count: number;
  gutter: number;
  margin: number;
  color: string;
  opacity: number;
}

export interface FrameNode extends BaseNode, CornerProps {
  type: 'frame';
  children: ID[];
  clipContent: boolean;
  layout: AutoLayout | null;
  layoutGrids: LayoutGrid[];
  /** reusable component flag (shown with component styling in the UI) */
  isComponent: boolean;
}

export interface GroupNode extends BaseNode {
  type: 'group';
  children: ID[];
}

export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'exclude';

export interface BooleanNode extends BaseNode {
  type: 'boolean';
  children: ID[];
  op: BooleanOp;
}

export interface RectNode extends BaseNode, CornerProps {
  type: 'rect';
}

export interface EllipseNode extends BaseNode {
  type: 'ellipse';
  /** degrees, 0 = 3 o'clock */
  arcStart: number;
  /** degrees, 360 = full ellipse */
  arcSweep: number;
  /** 0..1 inner radius ratio (donut) */
  innerRadius: number;
}

export interface PolygonNode extends BaseNode {
  type: 'polygon';
  sides: number;
  cornerRadius: number;
}

export interface StarNode extends BaseNode {
  type: 'star';
  points: number;
  /** 0..1 */
  innerRadius: number;
  cornerRadius: number;
}

export interface PathPoint {
  x: number;
  y: number;
  /** incoming control point (absolute, local coords) */
  in: Vec | null;
  /** outgoing control point (absolute, local coords) */
  out: Vec | null;
  /** handle behaviour while editing */
  mode?: 'corner' | 'mirrored' | 'asymmetric' | 'disconnected';
}

export interface SubPath {
  closed: boolean;
  points: PathPoint[];
}

export interface PathNode extends BaseNode {
  type: 'path';
  paths: SubPath[];
  fillRule: 'nonzero' | 'evenodd';
  startMarker: Marker;
  endMarker: Marker;
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type TextVAlign = 'top' | 'middle' | 'bottom';
export type TextAutoResize = 'width' | 'height' | 'none';
export type TextDecoration = 'none' | 'underline' | 'strikethrough';
export type TextCase = 'none' | 'upper' | 'lower' | 'title';

export interface TextStyleProps {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  /** multiplier of font size */
  lineHeight: number;
  /** px */
  letterSpacing: number;
  paragraphSpacing: number;
  textAlign: TextAlign;
  verticalAlign: TextVAlign;
  textDecoration: TextDecoration;
  textCase: TextCase;
}

export interface TextNode extends BaseNode, TextStyleProps {
  type: 'text';
  text: string;
  autoResize: TextAutoResize;
}

export interface BrushSettings {
  kind: 'pen' | 'marker' | 'highlighter' | 'calligraphy' | 'ink';
  size: number;
  /** -1..1 effect of pressure on size */
  thinning: number;
  smoothing: number;
  streamline: number;
  taperStart: number;
  taperEnd: number;
  simulatePressure: boolean;
  /** calligraphy nib angle, degrees */
  angle: number;
}

export interface BrushPoint {
  x: number;
  y: number;
  /** pressure 0..1 */
  p: number;
}

export interface BrushNode extends BaseNode {
  type: 'brush';
  points: BrushPoint[];
  brush: BrushSettings;
}

export interface BitmapNode extends BaseNode {
  type: 'bitmap';
  assetId: ID;
  pixelWidth: number;
  pixelHeight: number;
  /** false → nearest-neighbour (pixel art) */
  smoothing: boolean;
  /** show pixel grid when zoomed in */
  pixelGrid: boolean;
}

export type SceneNode =
  | FrameNode
  | GroupNode
  | BooleanNode
  | RectNode
  | EllipseNode
  | PolygonNode
  | StarNode
  | PathNode
  | TextNode
  | BrushNode
  | BitmapNode;

export type ContainerNode = FrameNode | GroupNode | BooleanNode;

export type NodeOfType<T extends NodeType> = Extract<SceneNode, { type: T }>;

/* --------------------------------------------------------------- document */

export interface Guide {
  id: ID;
  axis: 'x' | 'y';
  value: number;
}

export interface Page {
  id: ID;
  name: string;
  children: ID[];
  background: string;
  guides: Guide[];
}

export interface Asset {
  id: ID;
  mime: string;
  /** data: URL */
  data: string;
  width?: number;
  height?: number;
  name?: string;
}

export interface ColorStyle {
  id: ID;
  name: string;
  paint: Paint;
}

export interface TextStyle extends TextStyleProps {
  id: ID;
  name: string;
}

export interface EffectStyle {
  id: ID;
  name: string;
  effects: Effect[];
}

export interface Doc {
  format: 'alt';
  version: 1;
  id: ID;
  name: string;
  pages: Page[];
  nodes: Record<ID, SceneNode>;
  assets: Record<ID, Asset>;
  styles: {
    colors: ColorStyle[];
    text: TextStyle[];
    effects: EffectStyle[];
  };
  createdAt: number;
  updatedAt: number;
}
