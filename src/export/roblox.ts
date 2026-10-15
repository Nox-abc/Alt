/**
 * Roblox Studio exporters.
 *
 *  - `.rbxmx` XML model (drag into Studio / Insert from File)
 *  - Luau script that builds the same hierarchy with Instance.new
 *
 * Frames / rectangles / ellipses → Frame (+ UICorner, UIStroke, UIGradient),
 * text → TextLabel with FontFace, auto layout → UIListLayout + UIPadding,
 * images & anything Roblox can't draw (vectors, radial gradients, masks) →
 * ImageLabel with an empty Image plus a PNG file to upload as a decal (the
 * file name is stored in the `AltImage` attribute).
 */
import type { Doc, GradientPaint, ID, ImagePaint, SceneNode, TextNode } from '../core/types';
import { localMatrix, transformRect } from '../core/geometry';
import { applyCase } from '../core/text';
import type { ExportContext, ExportFile, Exporter, ExportOption } from './types';
import {
  bytesToBase64,
  childNodes,
  cornerRadii,
  cssLinear,
  dataUrlToBytes,
  FileNamer,
  isGradient,
  isPlainEllipse,
  isVectorNode,
  MIME,
  num,
  r2,
  resolveRoots,
  rgb01,
  sampleStops,
  sanitizeFileName,
  sortedStops,
  uniformRadius,
  utf8,
  visibleEffects,
  visiblePaints,
  xmlEscape,
} from './util';

/* ------------------------------------------------------------------ model */

type Value =
  | { t: 'string'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'int'; v: number }
  | { t: 'float'; v: number }
  | { t: 'token'; v: number; enum: string; item: string }
  | { t: 'Color3'; r: number; g: number; b: number }
  | { t: 'UDim'; s: number; o: number }
  | { t: 'UDim2'; xs: number; xo: number; ys: number; yo: number }
  | { t: 'Vector2'; x: number; y: number }
  | { t: 'ColorSequence'; keys: { time: number; r: number; g: number; b: number }[] }
  | { t: 'NumberSequence'; keys: { time: number; value: number }[] }
  | { t: 'Font'; family: string; weight: number; italic: boolean }
  | { t: 'Content'; url: string | null };

export interface RbxInstance {
  className: string;
  /** layer the instance came from (for comments) */
  comment?: string;
  props: [string, Value][];
  attributes: [string, string][];
  children: RbxInstance[];
}

interface RasterJob {
  id: ID;
  file: string;
  /** 'asset' writes the original image, 'raster' renders the node */
  kind: 'asset' | 'raster';
  assetId?: ID;
}

export interface RobloxOptions {
  container: 'ScreenGui' | 'SurfaceGui' | 'Frame';
  units: 'offset' | 'scale';
}

/* ---------------------------------------------------------------- values */

const str = (v: string): Value => ({ t: 'string', v });
const bool = (v: boolean): Value => ({ t: 'bool', v });
const int = (v: number): Value => ({ t: 'int', v: Math.round(v) });
const float = (v: number): Value => ({ t: 'float', v: r2(v, 3) });
const token = (en: string, item: string, v: number): Value => ({ t: 'token', v, enum: en, item });
const color3 = (hex: string): Value => {
  const c = rgb01(hex);
  return { t: 'Color3', r: r2(c.r, 4), g: r2(c.g, 4), b: r2(c.b, 4) };
};
const udim = (s: number, o: number): Value => ({ t: 'UDim', s: r2(s, 4), o: Math.round(o) });
const udim2 = (xs: number, xo: number, ys: number, yo: number): Value => ({ t: 'UDim2', xs: r2(xs, 4), xo: Math.round(xo), ys: r2(ys, 4), yo: Math.round(yo) });
const vec2 = (x: number, y: number): Value => ({ t: 'Vector2', x: r2(x, 4), y: r2(y, 4) });

const TEXT_X: Record<string, [string, number]> = { left: ['Left', 0], right: ['Right', 1], center: ['Center', 2], justify: ['Left', 0] };
const TEXT_Y: Record<string, [string, number]> = { top: ['Top', 0], middle: ['Center', 1], bottom: ['Bottom', 2] };
const H_ALIGN: Record<string, [string, number]> = { center: ['Center', 0], start: ['Left', 1], end: ['Right', 2], 'space-between': ['Left', 1], stretch: ['Left', 1] };
const V_ALIGN: Record<string, [string, number]> = { center: ['Center', 0], start: ['Top', 1], end: ['Bottom', 2], 'space-between': ['Top', 1], stretch: ['Top', 1] };
const FONT_WEIGHTS: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Heavy' };

/** Common font names → Roblox built-in families. */
const ROBLOX_FONTS: [RegExp, string][] = [
  [/gotham/i, 'GothamSSm'],
  [/montserrat/i, 'Montserrat'],
  [/roboto mono|jetbrains|fira code|source code|menlo|monaco|consolas|courier|mono/i, 'RobotoMono'],
  [/inconsolata/i, 'Inconsolata'],
  [/roboto/i, 'Roboto'],
  [/source sans/i, 'SourceSansPro'],
  [/ubuntu/i, 'Ubuntu'],
  [/arial|helvetica|arimo/i, 'Arial'],
  [/oswald/i, 'Oswald'],
  [/nunito/i, 'Nunito'],
  [/merriweather|georgia|times|playfair|garamond|serif/i, 'Merriweather'],
  [/press start|pixel/i, 'PressStart2P'],
  [/fredoka/i, 'FredokaOne'],
  [/luckiest/i, 'LuckiestGuy'],
  [/bangers/i, 'Bangers'],
  [/titillium/i, 'TitilliumWeb'],
  [/josefin/i, 'JosefinSans'],
  [/patrick hand/i, 'PatrickHand'],
  [/permanent marker/i, 'PermanentMarker'],
  [/indie flower/i, 'IndieFlower'],
  [/amatic/i, 'AmaticSC'],
  [/michroma/i, 'Michroma'],
  [/kalam/i, 'Kalam'],
  [/special elite/i, 'SpecialElite'],
  [/creepster/i, 'Creepster'],
  [/comic/i, 'ComicNeueAngular'],
  [/builder/i, 'BuilderSans'],
];

export function robloxFontFamily(family: string): string {
  const hit = ROBLOX_FONTS.find(([re]) => re.test(family));
  return `rbxasset://fonts/families/${hit ? hit[1] : 'BuilderSans'}.json`;
}

/** Roblox AttributesSerialize blob for string attributes. */
function attributesBlob(attrs: [string, string][]): string {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const s = (v: string) => {
    const b = utf8(v);
    u32(b.length);
    parts.push(...b);
  };
  u32(attrs.length);
  for (const [k, v] of attrs) {
    s(k);
    parts.push(0x02); // String
    s(v);
  }
  return bytesToBase64(new Uint8Array(parts));
}

/* --------------------------------------------------------------- builder */

class RobloxBuilder {
  readonly jobs: RasterJob[] = [];
  readonly notes = new Set<string>();
  private files = new FileNamer();

  constructor(
    readonly doc: Doc,
    readonly opts: RobloxOptions,
  ) {}

  private note(n: SceneNode, msg: string) {
    this.notes.add(`"${n.name}": ${msg}`);
  }

  /** Position / Size relative to a parent box (scale or offset units). */
  private place(x: number, y: number, w: number, h: number, parent: { width: number; height: number } | null): [string, Value][] {
    if (this.opts.units === 'scale' && parent && parent.width > 0 && parent.height > 0) {
      return [
        ['Position', udim2(x / parent.width, 0, y / parent.height, 0)],
        ['Size', udim2(w / parent.width, 0, h / parent.height, 0)],
      ];
    }
    return [
      ['Position', udim2(0, x, 0, y)],
      ['Size', udim2(0, w, 0, h)],
    ];
  }

  /** Whether Roblox can't draw the node natively. */
  private needsRaster(n: SceneNode): boolean {
    if (isVectorNode(n)) return true;
    if ((n.type === 'frame' || n.type === 'group') && childNodes(this.doc, n).some((k) => k.isMask)) return true;
    if (n.type === 'frame' || n.type === 'group') return false;
    const top = visiblePaints(n.fills).filter((p) => p.type !== 'image').at(-1);
    return !!top && isGradient(top) && top.type !== 'linear';
  }

  build(rootId: ID): RbxInstance {
    const root = this.doc.nodes[rootId];
    const frame = this.node(root, null, 0, false)!;
    if (this.opts.container === 'Frame') return frame;
    if (this.opts.container === 'ScreenGui') {
      // centre the design on screen
      frame.props = frame.props.filter(([k]) => k !== 'Position');
      frame.props.unshift(['AnchorPoint', vec2(0.5, 0.5)], ['Position', udim2(0.5, 0, 0.5, 0)]);
      return {
        className: 'ScreenGui',
        comment: root.name,
        props: [
          ['Name', str(root.name)],
          ['ResetOnSpawn', bool(false)],
          ['ZIndexBehavior', token('ZIndexBehavior', 'Sibling', 1)],
        ],
        attributes: [],
        children: [frame],
      };
    }
    frame.props = frame.props.filter(([k]) => k !== 'Position' && k !== 'Size');
    frame.props.unshift(['Position', udim2(0, 0, 0, 0)], ['Size', udim2(1, 0, 1, 0)]);
    return {
      className: 'SurfaceGui',
      comment: root.name,
      props: [
        ['Name', str(root.name)],
        ['SizingMode', token('SurfaceGuiSizingMode', 'FixedSize', 0)],
        ['CanvasSize', vec2(Math.round(root.width), Math.round(root.height))],
        ['Face', token('NormalId', 'Front', 5)],
        ['LightInfluence', float(0)],
        ['ZIndexBehavior', token('ZIndexBehavior', 'Sibling', 1)],
      ],
      attributes: [],
      children: [frame],
    };
  }

  private node(n: SceneNode, parent: SceneNode | null, index: number, inList: boolean): RbxInstance | null {
    if (!n.visible && parent) return null;
    const isRoot = !parent;
    const common = (cls: string, box?: { x: number; y: number; width: number; height: number }, rotation = n.rotation): RbxInstance => {
      const b = box ?? { x: isRoot ? 0 : n.x, y: isRoot ? 0 : n.y, width: n.width, height: n.height };
      const props: [string, Value][] = [
        ['Name', str(n.name)],
        ['BorderSizePixel', int(0)],
        ...this.place(b.x, b.y, b.width, b.height, parent),
        ['ZIndex', int(index + 1)],
      ];
      if (!isRoot && r2(rotation, 2)) props.push(['Rotation', float(rotation)]);
      if (inList) props.push(['LayoutOrder', int(index)]);
      return { className: cls, comment: n.name, props, attributes: [], children: [] };
    };
    if (!isRoot && (n.flipX || n.flipY) && n.type !== 'text') this.note(n, 'flips are not supported by Roblox GUI objects.');
    for (const e of visibleEffects(n.effects)) {
      if (e.type !== 'layer-blur' || !this.needsRaster(n)) this.note(n, `${e.type.replace('-', ' ')} effect is not supported and was skipped.`);
    }

    if (n.type === 'text') return this.text(n, common('TextLabel'));

    if (n.type === 'bitmap' || (imageFill(n) && n.type !== 'frame' && n.type !== 'group' && !isVectorNode(n))) {
      const img = common('ImageLabel');
      img.props.push(['BackgroundTransparency', float(1)], ['Image', { t: 'Content', url: null }]);
      const assetId = n.type === 'bitmap' ? n.assetId : imageFill(n)!.assetId;
      const paint = n.type === 'bitmap' ? null : imageFill(n)!;
      const asset = this.doc.assets[assetId];
      const ext = asset?.mime.includes('jpeg') ? 'jpg' : 'png';
      const file = this.files.get(sanitizeFileName(n.name), ext);
      this.jobs.push(asset && /png|jpe?g/.test(asset.mime) ? { id: n.id, file, kind: 'asset', assetId } : { id: n.id, file, kind: 'raster' });
      img.attributes.push(['AltImage', file]);
      const alpha = (paint?.opacity ?? 1) * n.opacity;
      if (alpha < 0.999) img.props.push(['ImageTransparency', float(1 - alpha)]);
      const scaleType = !paint || paint.fit === 'stretch' ? ['Stretch', 0] : paint.fit === 'fit' ? ['Fit', 3] : paint.fit === 'tile' ? ['Tile', 2] : ['Crop', 4];
      img.props.push(['ScaleType', token('ScaleType', scaleType[0] as string, scaleType[1] as number)]);
      if (n.type === 'bitmap' && !n.smoothing) img.props.push(['ResampleMode', token('ResamplerMode', 'Pixelated', 1)]);
      if (n.type !== 'bitmap') this.decorate(n, img, false);
      return img;
    }

    if (this.needsRaster(n) && !isRoot) {
      // drawn by Alt: the PNG already contains the node's rotation, so the
      // label covers its bounding box in the parent and isn't rotated again
      const box = transformRect(localMatrix(n), { x: 0, y: 0, width: n.width, height: n.height });
      const img = common('ImageLabel', box, 0);
      const file = this.files.get(sanitizeFileName(n.name), 'png');
      this.jobs.push({ id: n.id, file, kind: 'raster' });
      img.props.push(['BackgroundTransparency', float(1)], ['Image', { t: 'Content', url: null }], ['ScaleType', token('ScaleType', 'Stretch', 0)]);
      img.attributes.push(['AltImage', file]);
      return img;
    }

    const kids = n.type === 'frame' || n.type === 'group' ? childNodes(this.doc, n) : [];
    const groupFade = kids.length > 0 && n.opacity < 0.999;
    const inst = common(groupFade ? 'CanvasGroup' : 'Frame');
    if (groupFade) inst.props.push(['GroupTransparency', float(1 - n.opacity)]);
    if (n.type === 'group') inst.props.push(['BackgroundTransparency', float(1)]);
    else this.decorate(n, inst, !groupFade);
    if (n.type === 'frame' && n.clipContent && kids.length) {
      inst.props.push(['ClipsDescendants', bool(true)]);
      if (r2(n.rotation)) this.note(n, 'ClipsDescendants does not clip rotated frames in Roblox.');
    }

    // auto layout → UIListLayout (only when every child flows)
    const L = n.type === 'frame' ? n.layout : null;
    const listed = !!L && kids.every((k) => k.layoutPositioning !== 'absolute');
    if (L && !listed) this.note(n, 'auto layout with absolutely positioned children exported with fixed positions.');
    if (L && listed) {
      const horiz = L.mode === 'horizontal';
      const [pt, pr, pb, pl] = L.padding;
      let gap = L.gap;
      if (L.justify === 'space-between' && kids.length > 1 && !L.wrap) {
        const inner = (horiz ? n.width - pl - pr : n.height - pt - pb) - kids.reduce((a, k) => a + (horiz ? k.width : k.height), 0);
        gap = Math.max(0, inner / (kids.length - 1));
      }
      const [hName, hVal] = horiz ? H_ALIGN[L.justify] : H_ALIGN[L.align];
      const [vName, vVal] = horiz ? V_ALIGN[L.align] : V_ALIGN[L.justify];
      const list: RbxInstance = {
        className: 'UIListLayout',
        props: [
          ['FillDirection', token('FillDirection', horiz ? 'Horizontal' : 'Vertical', horiz ? 0 : 1)],
          ['Padding', udim(0, gap)],
          ['SortOrder', token('SortOrder', 'LayoutOrder', 2)],
          ['HorizontalAlignment', token('HorizontalAlignment', hName, hVal)],
          ['VerticalAlignment', token('VerticalAlignment', vName, vVal)],
        ],
        attributes: [],
        children: [],
      };
      if (L.wrap && horiz) list.props.push(['Wraps', bool(true)]);
      inst.children.push(list);
      if (pt || pr || pb || pl) {
        inst.children.push({
          className: 'UIPadding',
          props: [
            ['PaddingTop', udim(0, pt)],
            ['PaddingRight', udim(0, pr)],
            ['PaddingBottom', udim(0, pb)],
            ['PaddingLeft', udim(0, pl)],
          ],
          attributes: [],
          children: [],
        });
      }
    }
    kids.forEach((k, i) => {
      const c = this.node(k, n, i, listed);
      if (c) inst.children.push(c);
    });
    return inst;
  }

  /** Background, corner radius, stroke and gradient of a box-like node. */
  private decorate(n: SceneNode, inst: RbxInstance, applyOpacity: boolean) {
    const opacity = applyOpacity ? n.opacity : 1;
    const fills = visiblePaints(n.fills).filter((p) => p.type !== 'image');
    const top = fills.at(-1);
    const isImage = inst.className === 'ImageLabel';
    if (!isImage) {
      if (!top) inst.props.push(['BackgroundTransparency', float(1)]);
      else if (top.type === 'solid') {
        inst.props.push(['BackgroundColor3', color3(top.color)], ['BackgroundTransparency', float(1 - top.opacity * opacity)]);
      } else if (isGradient(top)) {
        inst.props.push(['BackgroundColor3', color3('#ffffff')], ['BackgroundTransparency', float(1 - top.opacity * opacity)]);
        inst.children.push(this.gradient(top, n));
        if (top.type !== 'linear') this.note(n, `${top.type} gradient approximated with a linear UIGradient.`);
      } else {
        inst.props.push(['BackgroundColor3', color3(top.background ?? top.color)], ['BackgroundTransparency', float(1 - top.opacity * opacity)]);
        this.note(n, `${top.type} paint exported as a flat colour.`);
      }
      if (fills.length > 1) this.note(n, 'only the top fill is exported.');
    }
    // corners
    if (isPlainEllipse(n)) {
      inst.children.push({ className: 'UICorner', props: [['CornerRadius', udim(0.5, 0)]], attributes: [], children: [] });
      if (Math.abs(n.width - n.height) > 1) this.note(n, 'non-circular ellipse rendered as a pill (UICorner).');
    } else if (n.type === 'rect' || n.type === 'frame') {
      const u = uniformRadius(n);
      const r = u ?? Math.max(...cornerRadii(n));
      if (u === null) this.note(n, 'per-corner radii are not supported; the largest radius is used.');
      if (r > 0) inst.children.push({ className: 'UICorner', props: [['CornerRadius', udim(0, r)]], attributes: [], children: [] });
    }
    // stroke
    const stroke = visiblePaints(n.strokes).filter((p) => p.type !== 'image').at(-1);
    if (stroke && n.strokeWidth > 0) {
      const color = stroke.type === 'solid' ? stroke.color : isGradient(stroke) ? sortedStops(stroke)[0].color : stroke.color;
      const s: RbxInstance = {
        className: 'UIStroke',
        props: [
          ['ApplyStrokeMode', token('ApplyStrokeMode', 'Border', 1)],
          ['Color', color3(color)],
          ['Thickness', float(n.strokeWidth)],
          ['LineJoinMode', token('LineJoinMode', n.strokeJoin === 'round' ? 'Round' : n.strokeJoin === 'bevel' ? 'Bevel' : 'Miter', n.strokeJoin === 'round' ? 0 : n.strokeJoin === 'bevel' ? 1 : 2)],
        ],
        attributes: [],
        children: [],
      };
      const alpha = stroke.opacity * opacity;
      if (alpha < 0.999) s.props.push(['Transparency', float(1 - alpha)]);
      if (isGradient(stroke)) s.children.push(this.gradient(stroke, n));
      inst.children.push(s);
      if (n.dash.some((d) => d > 0)) this.note(n, 'dashed strokes are not supported.');
    }
  }

  /** UIGradient for a gradient paint (linear mapping across the box). */
  private gradient(p: GradientPaint, n: SceneNode): RbxInstance {
    const stops = sortedStops(p);
    let rotation = 0;
    // original offset ↔ Roblox time (0..1 across the box along the gradient direction)
    let fwd = (t: number) => t;
    let inv = (t: number) => t;
    if (p.type === 'linear') {
      const { angle, map } = cssLinear(p, n.width, n.height);
      rotation = angle - 90;
      const a = map(0);
      const b = map(1);
      fwd = map;
      inv = (t) => (Math.abs(b - a) < 1e-9 ? 0 : (t - a) / (b - a));
    }
    const times = new Set<number>([0, 1]);
    for (const s of stops) {
      const t = r2(fwd(s.offset), 4);
      if (t > 0 && t < 1) times.add(t);
    }
    const sorted = [...times].sort((x, y) => x - y);
    if (sorted.length > 20) sorted.splice(19, sorted.length - 20);
    const samples = sorted.map((t) => ({ t, s: sampleStops(stops, Math.max(0, Math.min(1, inv(t)))) }));
    const props: [string, Value][] = [
      ['Color', { t: 'ColorSequence', keys: samples.map(({ t, s }) => ({ time: t, ...rgbRound(s.color) })) }],
    ];
    if (samples.some(({ s }) => s.opacity < 0.999)) props.push(['Transparency', { t: 'NumberSequence', keys: samples.map(({ t, s }) => ({ time: t, value: r2(1 - s.opacity, 4) })) }]);
    if (r2(rotation, 2)) props.push(['Rotation', float(((rotation % 360) + 360) % 360)]);
    return { className: 'UIGradient', props, attributes: [], children: [] };
  }

  private text(n: TextNode, inst: RbxInstance): RbxInstance {
    const fills = visiblePaints(n.fills).filter((p) => p.type !== 'image');
    const top = fills.at(-1);
    const raw = applyCase(n.text, n.textCase);
    const rich = n.textDecoration !== 'none';
    const text = rich ? `<${n.textDecoration === 'underline' ? 'u' : 's'}>${xmlEscape(raw)}</${n.textDecoration === 'underline' ? 'u' : 's'}>` : raw;
    inst.props.push(['BackgroundTransparency', float(1)], ['Text', str(text)]);
    if (rich) inst.props.push(['RichText', bool(true)]);
    const color = !top ? '#000000' : top.type === 'solid' ? top.color : isGradient(top) ? '#ffffff' : top.color;
    inst.props.push(['TextColor3', color3(color)]);
    const alpha = (top?.opacity ?? 0) * n.opacity;
    if (alpha < 0.999) inst.props.push(['TextTransparency', float(1 - alpha)]);
    if (top && isGradient(top)) inst.children.push(this.gradient(top, n));
    inst.props.push(
      ['FontFace', { t: 'Font', family: robloxFontFamily(n.fontFamily), weight: Math.min(900, Math.max(100, Math.round(n.fontWeight / 100) * 100)), italic: n.italic }],
      ['TextSize', float(n.fontSize)],
      ['LineHeight', float(n.lineHeight)],
      ['TextWrapped', bool(n.autoResize !== 'width')],
      ['TextXAlignment', token('TextXAlignment', TEXT_X[n.textAlign][0], TEXT_X[n.textAlign][1])],
      ['TextYAlignment', token('TextYAlignment', TEXT_Y[n.verticalAlign][0], TEXT_Y[n.verticalAlign][1])],
    );
    if (n.autoResize !== 'none' && this.opts.units === 'offset') {
      const xy = n.autoResize === 'width';
      inst.props.push(['AutomaticSize', token('AutomaticSize', xy ? 'XY' : 'Y', xy ? 3 : 2)]);
    }
    if (n.letterSpacing) this.note(n, 'letter spacing is not supported.');
    const stroke = visiblePaints(n.strokes).filter((p) => p.type === 'solid').at(-1);
    if (stroke && stroke.type === 'solid' && n.strokeWidth > 0) {
      inst.children.push({
        className: 'UIStroke',
        props: [
          ['ApplyStrokeMode', token('ApplyStrokeMode', 'Contextual', 0)],
          ['Color', color3(stroke.color)],
          ['Thickness', float(n.strokeWidth)],
          ...(stroke.opacity < 0.999 ? ([['Transparency', float(1 - stroke.opacity)]] as [string, Value][]) : []),
        ],
        attributes: [],
        children: [],
      });
    }
    return inst;
  }
}

function imageFill(n: SceneNode): ImagePaint | undefined {
  return visiblePaints(n.fills).filter((p): p is ImagePaint => p.type === 'image').at(-1);
}

function rgbRound(hex: string) {
  const c = rgb01(hex);
  return { r: r2(c.r, 4), g: r2(c.g, 4), b: r2(c.b, 4) };
}

/* ------------------------------------------------------------- serialisers */

function xmlValue(name: string, v: Value, pad: string): string {
  const n = ` name="${name}"`;
  switch (v.t) {
    case 'string':
      return `${pad}<string${n}>${xmlEscape(v.v)}</string>`;
    case 'bool':
      return `${pad}<bool${n}>${v.v}</bool>`;
    case 'int':
      return `${pad}<int${n}>${v.v}</int>`;
    case 'float':
      return `${pad}<float${n}>${num(v.v, 4)}</float>`;
    case 'token':
      return `${pad}<token${n}>${v.v}</token>`;
    case 'Color3':
      return `${pad}<Color3${n}>\n${pad}\t<R>${num(v.r, 4)}</R>\n${pad}\t<G>${num(v.g, 4)}</G>\n${pad}\t<B>${num(v.b, 4)}</B>\n${pad}</Color3>`;
    case 'UDim':
      return `${pad}<UDim${n}>\n${pad}\t<S>${num(v.s, 4)}</S>\n${pad}\t<O>${v.o}</O>\n${pad}</UDim>`;
    case 'UDim2':
      return `${pad}<UDim2${n}>\n${pad}\t<XS>${num(v.xs, 4)}</XS>\n${pad}\t<XO>${v.xo}</XO>\n${pad}\t<YS>${num(v.ys, 4)}</YS>\n${pad}\t<YO>${v.yo}</YO>\n${pad}</UDim2>`;
    case 'Vector2':
      return `${pad}<Vector2${n}>\n${pad}\t<X>${num(v.x, 4)}</X>\n${pad}\t<Y>${num(v.y, 4)}</Y>\n${pad}</Vector2>`;
    case 'ColorSequence':
      return `${pad}<ColorSequence${n}>${v.keys.map((k) => `${num(k.time, 4)} ${num(k.r, 4)} ${num(k.g, 4)} ${num(k.b, 4)} 0 `).join('')}</ColorSequence>`;
    case 'NumberSequence':
      return `${pad}<NumberSequence${n}>${v.keys.map((k) => `${num(k.time, 4)} ${num(k.value, 4)} 0 `).join('')}</NumberSequence>`;
    case 'Font':
      return `${pad}<Font${n}>\n${pad}\t<Family><url>${xmlEscape(v.family)}</url></Family>\n${pad}\t<Weight>${v.weight}</Weight>\n${pad}\t<Style>${v.italic ? 'Italic' : 'Normal'}</Style>\n${pad}</Font>`;
    case 'Content':
      return v.url ? `${pad}<Content${n}><url>${xmlEscape(v.url)}</url></Content>` : `${pad}<Content${n}><null></null></Content>`;
  }
}

/** Properties with Name first. */
function orderedProps(inst: RbxInstance): [string, Value][] {
  return [...inst.props.filter(([k]) => k === 'Name'), ...inst.props.filter(([k]) => k !== 'Name')];
}

export function toRbxmx(root: RbxInstance): string {
  let ref = 0;
  const lines: string[] = [
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    '\t<Meta name="ExplicitAutoJoints">true</Meta>',
    '\t<External>null</External>',
    '\t<External>nil</External>',
  ];
  const item = (inst: RbxInstance, level: number) => {
    const pad = '\t'.repeat(level);
    const referent = `RBX${(ref++).toString(16).toUpperCase().padStart(32, '0')}`;
    lines.push(`${pad}<Item class="${inst.className}" referent="${referent}">`);
    lines.push(`${pad}\t<Properties>`);
    const props = orderedProps(inst);
    if (!props.some(([k]) => k === 'Name')) props.unshift(['Name', str(inst.className)]);
    for (const [k, v] of props) lines.push(xmlValue(k, v, `${pad}\t\t`));
    if (inst.attributes.length) lines.push(`${pad}\t\t<BinaryString name="AttributesSerialize">${attributesBlob(inst.attributes)}</BinaryString>`);
    lines.push(`${pad}\t</Properties>`);
    for (const c of inst.children) item(c, level + 1);
    lines.push(`${pad}</Item>`);
  };
  item(root, 1);
  lines.push('</roblox>', '');
  return lines.join('\n');
}

const luaString = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')}"`;

function luaValue(v: Value): string {
  switch (v.t) {
    case 'string':
      return luaString(v.v);
    case 'bool':
      return String(v.v);
    case 'int':
    case 'float':
      return num(v.v, 4);
    case 'token':
      return `Enum.${v.enum}.${v.item}`;
    case 'Color3':
      return `Color3.fromRGB(${Math.round(v.r * 255)}, ${Math.round(v.g * 255)}, ${Math.round(v.b * 255)})`;
    case 'UDim':
      return `UDim.new(${num(v.s, 4)}, ${v.o})`;
    case 'UDim2':
      if (!v.xs && !v.ys) return `UDim2.fromOffset(${v.xo}, ${v.yo})`;
      if (!v.xo && !v.yo) return `UDim2.fromScale(${num(v.xs, 4)}, ${num(v.ys, 4)})`;
      return `UDim2.new(${num(v.xs, 4)}, ${v.xo}, ${num(v.ys, 4)}, ${v.yo})`;
    case 'Vector2':
      return `Vector2.new(${num(v.x, 4)}, ${num(v.y, 4)})`;
    case 'ColorSequence':
      return `ColorSequence.new({ ${v.keys.map((k) => `ColorSequenceKeypoint.new(${num(k.time, 4)}, Color3.fromRGB(${Math.round(k.r * 255)}, ${Math.round(k.g * 255)}, ${Math.round(k.b * 255)}))`).join(', ')} })`;
    case 'NumberSequence':
      return `NumberSequence.new({ ${v.keys.map((k) => `NumberSequenceKeypoint.new(${num(k.time, 4)}, ${num(k.value, 4)})`).join(', ')} })`;
    case 'Font':
      return `Font.new(${luaString(v.family)}, Enum.FontWeight.${FONT_WEIGHTS[v.weight] ?? 'Regular'}, Enum.FontStyle.${v.italic ? 'Italic' : 'Normal'})`;
    case 'Content':
      return luaString(v.url ?? '');
  }
}

export function toLuau(root: RbxInstance, opts: { title: string; parent: 'playerGui' | 'script'; notes: string[]; images: string[] }): string {
  const lines: string[] = [];
  const header = [
    `--[[`,
    `\t${opts.title}`,
    `\tGenerated by Alt. Place this in a LocalScript${opts.parent === 'playerGui' ? ' (e.g. StarterPlayerScripts)' : ''}.`,
  ];
  if (opts.images.length) {
    header.push('', '\tImages: upload these files as decals and paste their asset ids into the', '\tImage property of the ImageLabel whose AltImage attribute matches:');
    for (const f of opts.images) header.push(`\t  • ${f}`);
  }
  if (opts.notes.length) {
    header.push('', '\tNotes:');
    for (const n of opts.notes) header.push(`\t  • ${n}`);
  }
  header.push(']]', '');
  lines.push(...header);
  if (opts.parent === 'playerGui') lines.push('local Players = game:GetService("Players")', '');
  lines.push(
    '--- Creates an instance, applies properties / attributes and parents its children.',
    'local function create(className: string, props: { [string]: any }, children: { Instance }?): Instance',
    '\tlocal instance = Instance.new(className)',
    '\tfor key, value in props do',
    '\t\tif key == "Attributes" then',
    '\t\t\tfor name, attribute in value do',
    '\t\t\t\tinstance:SetAttribute(name, attribute)',
    '\t\t\tend',
    '\t\telse',
    '\t\t\t(instance :: any)[key] = value',
    '\t\tend',
    '\tend',
    '\tfor _, child in children or {} do',
    '\t\tchild.Parent = instance',
    '\tend',
    '\treturn instance',
    'end',
    '',
  );
  const expr = (inst: RbxInstance, level: number): string[] => {
    const pad = '\t'.repeat(level);
    const props = orderedProps(inst).map(([k, v]) => `${k} = ${luaValue(v)}`);
    if (inst.attributes.length) props.push(`Attributes = { ${inst.attributes.map(([k, v]) => `${k} = ${luaString(v)}`).join(', ')} }`);
    const out: string[] = [];
    if (inst.comment && inst.children.length + props.length > 1) out.push(`${pad}-- ${inst.comment.replace(/\n/g, ' ')}`);
    const inline = `create(${luaString(inst.className)}, { ${props.join(', ')} })`;
    if (!inst.children.length && inline.length + pad.length * 4 <= 100) {
      out.push(`${pad}${inline}`);
      return out;
    }
    out.push(`${pad}create(${luaString(inst.className)}, {`);
    for (const p of props) out.push(`${pad}\t${p},`);
    if (!inst.children.length) {
      out.push(`${pad}})`);
      return out;
    }
    out.push(`${pad}}, {`);
    inst.children.forEach((c) => {
      const sub = expr(c, level + 1);
      sub[sub.length - 1] += ',';
      out.push(...sub);
    });
    out.push(`${pad}})`);
    return out;
  };
  const body = expr(root, 0);
  body[body.findIndex((l) => l.startsWith('create('))] = `local ui = ${body.find((l) => l.startsWith('create('))}`;
  lines.push(...body, '');
  lines.push(opts.parent === 'playerGui' ? 'ui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")' : 'ui.Parent = script.Parent', '');
  return lines.join('\n');
}

/* --------------------------------------------------------------- exporters */

const options: ExportOption[] = [
  {
    key: 'container',
    label: 'Container',
    type: 'select',
    default: 'ScreenGui',
    options: [
      { value: 'ScreenGui', label: 'ScreenGui' },
      { value: 'SurfaceGui', label: 'SurfaceGui' },
      { value: 'Frame', label: 'Frame only' },
    ],
  },
  {
    key: 'units',
    label: 'Sizing',
    type: 'select',
    default: 'offset',
    options: [
      { value: 'offset', label: 'Offset (pixels)' },
      { value: 'scale', label: 'Scale (relative to parent)' },
    ],
  },
  { key: 'rasterScale', label: 'Image scale', type: 'number', default: 2, min: 1, max: 4, step: 1 },
];

function readOptions(o: Record<string, unknown>): RobloxOptions {
  const container = o.container === 'SurfaceGui' || o.container === 'Frame' ? o.container : 'ScreenGui';
  return { container, units: o.units === 'scale' ? 'scale' : 'offset' };
}

async function renderJobs(ctx: ExportContext, jobs: RasterJob[]): Promise<ExportFile[]> {
  const scale = Math.max(1, Math.min(4, Number(ctx.options.rasterScale ?? 2) || 2));
  const out: ExportFile[] = [];
  for (const job of jobs) {
    if (job.kind === 'asset' && job.assetId) {
      const decoded = dataUrlToBytes(ctx.doc.assets[job.assetId]?.data ?? '');
      if (decoded) {
        out.push({ name: job.file, mime: decoded.mime, data: decoded.bytes });
        continue;
      }
    }
    try {
      out.push({ name: job.file.replace(/\.[a-z]+$/i, '.png'), mime: 'image/png', data: await ctx.rasterize([job.id], { scale, format: 'png', background: null }) });
    } catch (e) {
      console.warn(`Couldn't rasterize ${job.file}`, e);
    }
  }
  return out;
}

function robloxExporter(id: string, label: string, ext: string, description: string, extra: ExportOption[], emit: (b: RobloxBuilder, tree: RbxInstance, ctx: ExportContext, rootId: ID) => string): Exporter {
  return {
    id,
    label,
    group: 'Game engines',
    extension: ext,
    description,
    textual: true,
    options: [...options, ...extra],
    async run(ctx) {
      const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
      const names = new FileNamer();
      const files: ExportFile[] = [];
      for (const rootId of roots) {
        const b = new RobloxBuilder(ctx.doc, readOptions(ctx.options));
        const tree = b.build(rootId);
        files.push({ name: names.get(ctx.doc.nodes[rootId].name, ext), mime: ext === 'rbxmx' ? MIME.rbxmx : MIME.lua, data: emit(b, tree, ctx, rootId) });
        files.push(...(await renderJobs(ctx, b.jobs)));
      }
      return files;
    },
  };
}

/** Build the Roblox instance tree for a node (exposed for tests / previews). */
export function buildRobloxTree(doc: Doc, rootId: ID, opts: Partial<RobloxOptions> = {}): { tree: RbxInstance; images: string[]; notes: string[] } {
  const b = new RobloxBuilder(doc, { container: opts.container ?? 'ScreenGui', units: opts.units ?? 'offset' });
  const tree = b.build(rootId);
  return { tree, images: b.jobs.map((j) => j.file), notes: [...b.notes] };
}

export const rbxmxExporter = robloxExporter(
  'roblox-rbxmx',
  'Roblox Studio model',
  'rbxmx',
  'An .rbxmx model with Frames, TextLabels, UICorner, UIStroke, UIGradient and UIListLayout — plus PNGs for decals.',
  [],
  (_b, tree) => toRbxmx(tree),
);

export const luauExporter = robloxExporter(
  'roblox-lua',
  'Roblox Luau script',
  'lua',
  'A Luau script that builds the UI with Instance.new — plus PNGs for decals.',
  [
    {
      key: 'parent',
      label: 'Parent to',
      type: 'select',
      default: 'playerGui',
      options: [
        { value: 'playerGui', label: 'LocalPlayer.PlayerGui' },
        { value: 'script', label: 'script.Parent' },
      ],
    },
  ],
  (b, tree, ctx, rootId) => {
    const container = readOptions(ctx.options).container;
    const parent = ctx.options.parent === 'script' || (ctx.options.parent === undefined && container !== 'ScreenGui') ? 'script' : 'playerGui';
    return toLuau(tree, { title: ctx.doc.nodes[rootId].name, parent, notes: [...b.notes], images: b.jobs.map((j) => j.file) });
  },
);
