/**
 * Native UI exporters: SwiftUI, Flutter and Jetpack Compose.
 *
 * Auto-layout frames map to the platform stacks (VStack / Column / …) with
 * spacing, padding, alignment and fill / hug sizing; other containers use an
 * absolute stack with per-child offsets. Every element keeps its own
 * rotation relative to its parent. Vectors become native path builders.
 */
import type { AutoLayout, Doc, Effect, GlowEffect, GradientPaint, ShadowEffect, ID, ImagePaint, Paint, SceneNode, TextNode } from '../core/types';
import type { PathCmd } from '../core/path';
import { geometryOf } from '../core/boolean';
import { applyCase } from '../core/text';
import type { ExportContext, ExportFile, Exporter, ExportOption } from './types';
import {
  argbHex,
  assetBaseName,
  childNodes,
  CodeWriter,
  cornerRadii,
  dataUrlToBytes,
  extForMime,
  FileNamer,
  flt,
  gradientGeom,
  isGradient,
  isPlainEllipse,
  isVectorNode,
  MIME,
  NameRegistry,
  num,
  pascalCase,
  r2,
  resolveRoots,
  rgb01,
  snakeCase,
  sortedStops,
  uniformRadius,
  visibleEffects,
  visiblePaints,
} from './util';

/* ------------------------------------------------------------------ shared */

type Mode = 'root' | 'abs' | 'flow';

interface Ctx {
  mode: Mode;
  /** the auto layout of the parent (flow items only) */
  layout?: AutoLayout;
}

/** Text the node will display (text case applied). */
const textOf = (n: TextNode) => applyCase(n.text, n.textCase);

/** Flow + absolute children of an auto-layout frame (null when not a stack). */
function stackChildren(doc: Doc, n: SceneNode): { layout: AutoLayout; flow: SceneNode[]; abs: SceneNode[] } | null {
  if (n.type !== 'frame' || !n.layout) return null;
  const kids = childNodes(doc, n);
  if (kids.some((k) => k.isMask)) return null;
  return { layout: n.layout, flow: kids.filter((k) => k.layoutPositioning !== 'absolute'), abs: kids.filter((k) => k.layoutPositioning === 'absolute') };
}

function hugs(n: SceneNode, axis: 'h' | 'v'): boolean {
  if (n.type === 'text') return axis === 'h' ? n.autoResize === 'width' : n.autoResize !== 'none';
  if (n.type === 'frame' && n.layout) return (axis === 'h' ? n.sizingH : n.sizingV) === 'hug';
  return false;
}

type AxisSize = { kind: 'fixed'; value: number } | { kind: 'fill' } | { kind: 'hug' };

/** How a node is sized on each axis in its context. */
function axisSizes(n: SceneNode, ctx: Ctx): { h: AxisSize; v: AxisSize } {
  const size = (axis: 'h' | 'v'): AxisSize => {
    const value = axis === 'h' ? n.width : n.height;
    if (ctx.mode === 'flow' && ctx.layout) {
      const main = ctx.layout.mode === 'horizontal' ? 'h' : 'v';
      const sizing = axis === 'h' ? n.sizingH : n.sizingV;
      if (sizing === 'fill' && !(axis === main && ctx.layout.wrap)) return { kind: 'fill' };
      if (axis !== main && ctx.layout.align === 'stretch') return { kind: 'fill' };
    }
    if (hugs(n, axis)) return { kind: 'hug' };
    return { kind: 'fixed', value };
  };
  return { h: size('h'), v: size('v') };
}

function vectorCmds(doc: Doc, n: SceneNode): PathCmd[] {
  return geometryOf(doc, n);
}

/** Notes collected while generating (shown as comments at the top of the file). */
class Notes {
  private set = new Set<string>();
  add(s: string) {
    this.set.add(s);
  }
  lines(prefix: string): string[] {
    return [...this.set].map((s) => `${prefix} ${s}`);
  }
}

function effectNotes(n: SceneNode, notes: Notes, supported: Effect['type'][]) {
  for (const e of visibleEffects(n.effects)) {
    if (!supported.includes(e.type)) notes.add(`"${n.name}": ${e.type.replace('-', ' ')} is not supported and was skipped.`);
  }
}

/** Assets referenced by an export, written as image files. */
class ImageAssets {
  readonly names = new Map<ID, string>();
  private files = new FileNamer();
  constructor(
    private doc: Doc,
    private naming: (base: string) => string,
  ) {}
  /** File name (with extension) for an asset. */
  file(id: ID): string {
    let name = this.names.get(id);
    if (!name) {
      const a = this.doc.assets[id];
      const ext = extForMime(a?.mime ?? 'image/png');
      name = this.files.get(this.naming(assetBaseName(this.doc, id)), ext === 'bin' ? 'png' : ext);
      this.names.set(id, name);
    }
    return name;
  }
  base(id: ID): string {
    return this.file(id).replace(/\.[a-z0-9]+$/i, '');
  }
  out(dir = ''): ExportFile[] {
    const files: ExportFile[] = [];
    for (const [id, name] of this.names) {
      const decoded = dataUrlToBytes(this.doc.assets[id]?.data ?? '');
      if (decoded) files.push({ name: dir + name, mime: decoded.mime, data: decoded.bytes });
    }
    return files;
  }
}

const imagePaint = (paints: Paint[]): ImagePaint | undefined => visiblePaints(paints).filter((p): p is ImagePaint => p.type === 'image').at(-1);

/* =============================================================== SwiftUI */

const SWIFT_RESERVED = ['View', 'Text', 'Image', 'Color', 'Shape', 'Path', 'Group', 'Button', 'Label', 'List', 'Form', 'Section', 'Spacer', 'Divider', 'Circle', 'Ellipse', 'Rectangle', 'Capsule', 'Self', 'Type', 'Protocol', 'Any', 'App', 'Scene'];

const SWIFT_WEIGHT: Record<number, string> = { 100: 'ultraLight', 200: 'thin', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'heavy', 900: 'black' };

const SWIFT_BLEND: Record<string, string> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'colorDodge',
  'color-burn': 'colorBurn',
  'soft-light': 'softLight',
  'hard-light': 'hardLight',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'plus-lighter': 'plusLighter',
};

const swiftString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;

function swiftColor(hex: string, alpha = 1): string {
  const h = hex.toLowerCase();
  const a = r2(alpha, 3);
  if (a >= 1 && (h === '#000000' || h === '#000')) return 'Color.black';
  if (a >= 1 && (h === '#ffffff' || h === '#fff')) return 'Color.white';
  if (a <= 0) return 'Color.clear';
  const c = rgb01(hex);
  return `Color(red: ${num(c.r, 3)}, green: ${num(c.g, 3)}, blue: ${num(c.b, 3)}${a < 1 ? `, opacity: ${num(a, 3)}` : ''})`;
}

const UNIT_POINTS: Record<string, string> = {
  '0,0': '.topLeading',
  '0.5,0': '.top',
  '1,0': '.topTrailing',
  '0,0.5': '.leading',
  '0.5,0.5': '.center',
  '1,0.5': '.trailing',
  '0,1': '.bottomLeading',
  '0.5,1': '.bottom',
  '1,1': '.bottomTrailing',
};

const unitPoint = (x: number, y: number) => UNIT_POINTS[`${r2(x, 3)},${r2(y, 3)}`] ?? `UnitPoint(x: ${num(x, 3)}, y: ${num(y, 3)})`;

class SwiftGen {
  readonly shapes: string[] = [];
  readonly notes = new Notes();
  private shapeNames = new NameRegistry('pascal', SWIFT_RESERVED);
  constructor(
    readonly doc: Doc,
    readonly images: ImageAssets,
  ) {}

  private stops(p: GradientPaint): string {
    return `[${sortedStops(p)
      .map((s) => `.init(color: ${swiftColor(s.color, s.opacity * p.opacity)}, location: ${num(s.offset, 3)})`)
      .join(', ')}]`;
  }

  /** ShapeStyle expression for a paint. */
  paint(p: Paint, n: SceneNode): string {
    switch (p.type) {
      case 'solid':
        return swiftColor(p.color, p.opacity);
      case 'linear':
        return `LinearGradient(stops: ${this.stops(p)}, startPoint: ${unitPoint(p.from.x, p.from.y)}, endPoint: ${unitPoint(p.to.x, p.to.y)})`;
      case 'angular': {
        const g = gradientGeom(p, n.width, n.height);
        return `AngularGradient(stops: ${this.stops(p)}, center: ${unitPoint(p.from.x, p.from.y)}, angle: .degrees(${num((g.angle * 180) / Math.PI)}))`;
      }
      case 'radial':
      case 'diamond': {
        if (p.type === 'diamond') this.notes.add(`"${n.name}": diamond gradient approximated with an elliptical gradient.`);
        const g = gradientGeom(p, n.width, n.height);
        return `EllipticalGradient(stops: ${this.stops(p)}, center: ${unitPoint(p.from.x, p.from.y)}, startRadiusFraction: 0, endRadiusFraction: ${num(g.radius, 3)})`;
      }
      case 'pattern':
      case 'noise':
        this.notes.add(`"${n.name}": ${p.type} paint exported as a flat colour.`);
        return swiftColor(p.background ?? p.color, p.opacity);
      case 'image':
        return 'Color.clear';
    }
  }

  /** Shape expression for a box-like node. */
  shape(n: SceneNode): string {
    if (isPlainEllipse(n)) return Math.abs(n.width - n.height) < 0.01 ? 'Circle()' : 'Ellipse()';
    const u = uniformRadius(n);
    const smooth = (n.type === 'rect' || n.type === 'frame') && n.cornerSmoothing > 0 ? ', style: .continuous' : '';
    if (u === 0) return 'Rectangle()';
    if (u !== null) return `RoundedRectangle(cornerRadius: ${num(u)}${smooth})`;
    const [tl, tr, br, bl] = cornerRadii(n);
    return `UnevenRoundedRectangle(topLeadingRadius: ${num(tl)}, bottomLeadingRadius: ${num(bl)}, bottomTrailingRadius: ${num(br)}, topTrailingRadius: ${num(tr)}${smooth})`;
  }

  private strokeMods(n: SceneNode, shape: string, insettable: boolean): string[] {
    const paints = visiblePaints(n.strokes).filter((p) => p.type !== 'image');
    if (!paints.length || n.strokeWidth <= 0) return [];
    const w = n.strokeWidth;
    const dash = n.dash.filter((d) => d > 0);
    const caps: Record<string, string> = { butt: '.butt', round: '.round', square: '.square' };
    const joins: Record<string, string> = { miter: '.miter', round: '.round', bevel: '.bevel' };
    const styleArgs = [`lineWidth: ${num(w)}`];
    if (n.strokeCap !== 'butt') styleArgs.push(`lineCap: ${caps[n.strokeCap]}`);
    if (n.strokeJoin !== 'miter') styleArgs.push(`lineJoin: ${joins[n.strokeJoin]}`);
    if (dash.length) styleArgs.push(`dash: [${dash.map((d) => num(d)).join(', ')}]`);
    const style = styleArgs.length > 1 ? `style: StrokeStyle(${styleArgs.join(', ')})` : `lineWidth: ${num(w)}`;
    return paints.map((p) => {
      const paint = this.paint(p, n);
      if (insettable && n.strokeAlign === 'inside') return `.overlay(${shape}.strokeBorder(${paint}, ${style}))`;
      if (insettable && n.strokeAlign === 'outside') return `.overlay(${shape}.inset(by: ${num(-w / 2)}).stroke(${paint}, ${style}))`;
      return `.overlay(${shape}.stroke(${paint}, ${style}))`;
    });
  }

  private effectMods(n: SceneNode, kind: 'box' | 'text' | 'vector'): string[] {
    const mods: string[] = [];
    for (const e of visibleEffects(n.effects)) {
      if (e.type === 'drop-shadow' || e.type === 'glow') {
        const x = e.type === 'glow' ? 0 : e.x;
        const y = e.type === 'glow' ? 0 : e.y;
        mods.push(`.shadow(color: ${swiftColor(e.color, e.opacity)}, radius: ${num(e.blur / 2)}${x ? `, x: ${num(x)}` : ''}${y ? `, y: ${num(y)}` : ''})`);
      } else if (e.type === 'layer-blur' && e.radius > 0) mods.push(`.blur(radius: ${num(e.radius / 2)})`);
      else if (e.type === 'adjust') {
        if (e.brightness) mods.push(`.brightness(${num(e.brightness, 3)})`);
        if (e.contrast) mods.push(`.contrast(${num(1 + e.contrast, 3)})`);
        if (e.saturation) mods.push(`.saturation(${num(Math.max(0, 1 + e.saturation), 3)})`);
        if (e.hue) mods.push(`.hueRotation(.degrees(${num(e.hue)}))`);
        if (e.grayscale) mods.push(`.grayscale(${num(e.grayscale, 3)})`);
        if (e.invert >= 0.5) mods.push('.colorInvert()');
      }
    }
    effectNotes(n, this.notes, ['drop-shadow', 'glow', 'layer-blur', 'adjust', 'background-blur']);
    return mods;
  }

  /** frame / fixedSize modifiers for the node's sizing in its context. */
  private frameMods(n: SceneNode, ctx: Ctx, alignment?: string): string[] {
    const s = axisSizes(n, ctx);
    const align = alignment && alignment !== '.center' ? `, alignment: ${alignment}` : '';
    const fixed: string[] = [];
    if (s.h.kind === 'fixed') fixed.push(`width: ${num(s.h.value)}`);
    if (s.v.kind === 'fixed') fixed.push(`height: ${num(s.v.value)}`);
    const fill: string[] = [];
    if (s.h.kind === 'fill') fill.push('maxWidth: .infinity');
    if (s.v.kind === 'fill') fill.push('maxHeight: .infinity');
    const mods: string[] = [];
    if (fixed.length) mods.push(`.frame(${fixed.join(', ')}${fill.length ? '' : align})`);
    if (fill.length) mods.push(`.frame(${fill.join(', ')}${align})`);
    if (n.type === 'text' && s.h.kind === 'hug') mods.push('.fixedSize()');
    return mods;
  }

  private placeMods(n: SceneNode, ctx: Ctx): string[] {
    const mods: string[] = [];
    if (n.opacity < 0.999) mods.push(`.opacity(${num(n.opacity, 3)})`);
    if (n.blendMode !== 'normal') mods.push(`.blendMode(.${SWIFT_BLEND[n.blendMode] ?? 'normal'})`);
    if (ctx.mode !== 'root') {
      if (r2(n.rotation, 3)) mods.push(`.rotationEffect(.degrees(${num(n.rotation, 3)}))`);
      if (n.flipX || n.flipY) mods.push(`.scaleEffect(x: ${n.flipX ? -1 : 1}, y: ${n.flipY ? -1 : 1})`);
    }
    if (ctx.mode === 'abs' && (r2(n.x) || r2(n.y))) mods.push(`.offset(x: ${num(n.x)}, y: ${num(n.y)})`);
    return mods;
  }

  /** Emit a view expression for a node. */
  view(n: SceneNode, ctx: Ctx, out: CodeWriter) {
    out.line(`// ${n.name}`);
    if (n.type === 'text') return this.text(n, ctx, out);
    if (n.type === 'bitmap') {
      const mods = ['.resizable()'];
      if (!n.smoothing) mods.push('.interpolation(.none)');
      mods.push(...this.frameMods(n, ctx), ...this.effectMods(n, 'box'), ...this.placeMods(n, ctx));
      return this.emit(out, [`Image(${swiftString(this.doc.assets[n.assetId] ? this.images.base(n.assetId) : 'missing')})`], mods);
    }
    if (isVectorNode(n)) return this.vector(n, ctx, out);
    const kids = n.type === 'frame' || n.type === 'group' ? childNodes(this.doc, n) : [];
    if (!kids.length) return this.box(n, ctx, out);
    return this.container(n, kids, ctx, out);
  }

  private emit(out: CodeWriter, base: string[], mods: string[]) {
    base.forEach((l) => out.line(l));
    const block = base.length > 1;
    if (block) mods.forEach((m) => out.line(m));
    else out.indent(() => mods.forEach((m) => out.line(m)));
  }

  private box(n: SceneNode, ctx: Ctx, out: CodeWriter) {
    const shape = this.shape(n);
    const fills = visiblePaints(n.fills);
    const img = imagePaint(fills);
    const others = fills.filter((p) => p.type !== 'image');
    const mods: string[] = [];
    let base: string;
    if (img && this.doc.assets[img.assetId]) {
      // image fill: a resizable Image clipped to the shape
      base = `Image(${swiftString(this.images.base(img.assetId))})`;
      mods.push('.resizable()');
      if (img.fit !== 'stretch') mods.push(`.aspectRatio(contentMode: ${img.fit === 'fit' ? '.fit' : '.fill'})`);
      if (img.opacity < 0.999) mods.push(`.opacity(${num(img.opacity, 3)})`);
      mods.push(...this.frameMods(n, ctx));
      for (const p of others) mods.push(`.background(${shape}.fill(${this.paint(p, n)}))`);
      mods.push(`.clipShape(${shape})`);
    } else if (others.length) {
      const [first, ...rest] = others;
      base = shape;
      mods.push(`.fill(${this.paint(first, n)})`, ...rest.map((p) => `.overlay(${shape}.fill(${this.paint(p, n)}))`), ...this.frameMods(n, ctx));
    } else {
      base = 'Color.clear';
      mods.push(...this.frameMods(n, ctx));
    }
    mods.push(...this.strokeMods(n, shape, true), ...this.effectMods(n, 'box'), ...this.placeMods(n, ctx));
    this.emit(out, [base], mods);
  }

  private vector(n: SceneNode, ctx: Ctx, out: CodeWriter) {
    const name = this.shapeNames.get(`${n.name} shape`, 'VectorShape');
    this.shapes.push(this.shapeStruct(name, vectorCmds(this.doc, n), n.width, n.height));
    const evenOdd = (n.type === 'path' && n.fillRule === 'evenodd') || n.type === 'boolean';
    const fills = visiblePaints(n.fills).filter((p) => p.type !== 'image');
    const mods: string[] = [];
    const call = `${name}()`;
    if (fills.length) {
      const [first, ...rest] = fills;
      const style = evenOdd ? ', style: FillStyle(eoFill: true)' : '';
      mods.push(`.fill(${this.paint(first, n)}${style})`, ...rest.map((p) => `.overlay(${call}.fill(${this.paint(p, n)}${style}))`));
    } else mods.push('.fill(Color.clear)');
    mods.push(...this.strokeMods(n, call, false), ...this.frameMods(n, ctx), ...this.effectMods(n, 'vector'), ...this.placeMods(n, ctx));
    this.emit(out, [call], mods);
  }

  private shapeStruct(name: string, cmds: PathCmd[], w: number, h: number): string {
    const c = new CodeWriter('    ');
    const pt = (x: number, y: number) => `CGPoint(x: ${num(x)}, y: ${num(y)})`;
    c.block(`private struct ${name}: Shape {`, () => {
      c.block('func path(in rect: CGRect) -> Path {', () => {
        c.line('var path = Path()');
        for (const k of cmds) {
          if (k.c === 'M') c.line(`path.move(to: ${pt(k.x, k.y)})`);
          else if (k.c === 'L') c.line(`path.addLine(to: ${pt(k.x, k.y)})`);
          else if (k.c === 'C') c.line(`path.addCurve(to: ${pt(k.x, k.y)}, control1: ${pt(k.x1, k.y1)}, control2: ${pt(k.x2, k.y2)})`);
          else c.line('path.closeSubpath()');
        }
        c.line(`return path.applying(CGAffineTransform(scaleX: rect.width / ${num(Math.max(w, 0.01))}, y: rect.height / ${num(Math.max(h, 0.01))}))`);
      });
    });
    return c.toString();
  }

  private text(n: TextNode, ctx: Ctx, out: CodeWriter) {
    const mods: string[] = [];
    const generic = /^(sf pro|system-ui|-apple-system|san francisco)/i.test(n.fontFamily);
    mods.push(generic ? `.font(.system(size: ${num(n.fontSize)}))` : `.font(.custom(${swiftString(n.fontFamily)}, size: ${num(n.fontSize)}))`);
    const weight = SWIFT_WEIGHT[Math.round(n.fontWeight / 100) * 100] ?? 'regular';
    if (weight !== 'regular') mods.push(`.fontWeight(.${weight})`);
    if (n.italic) mods.push('.italic()');
    if (n.letterSpacing) mods.push(`.kerning(${num(n.letterSpacing)})`);
    if (n.textDecoration === 'underline') mods.push('.underline()');
    if (n.textDecoration === 'strikethrough') mods.push('.strikethrough()');
    const fill = visiblePaints(n.fills).filter((p) => p.type !== 'image').at(-1);
    if (fill) mods.push(`.foregroundStyle(${this.paint(fill, n)})`);
    const extra = (n.lineHeight - 1.2) * n.fontSize;
    if (extra > 0.5) mods.push(`.lineSpacing(${num(extra)})`);
    if (n.textAlign === 'center') mods.push('.multilineTextAlignment(.center)');
    else if (n.textAlign === 'right') mods.push('.multilineTextAlignment(.trailing)');
    const h = n.textAlign === 'center' ? '' : n.textAlign === 'right' ? 'Trailing' : 'Leading';
    const v = n.autoResize !== 'none' || n.verticalAlign === 'top' ? 'top' : n.verticalAlign === 'bottom' ? 'bottom' : '';
    const alignment = v ? `.${v}${h}` : h ? `.${h.toLowerCase()}` : '.center';
    mods.push(...this.frameMods(n, ctx, alignment));
    if (visiblePaints(n.strokes).length && n.strokeWidth > 0) this.notes.add(`"${n.name}": text strokes are not supported in SwiftUI.`);
    mods.push(...this.effectMods(n, 'text'), ...this.placeMods(n, ctx));
    this.emit(out, [`Text(verbatim: ${swiftString(textOf(n))})`], mods);
  }

  private container(n: SceneNode, kids: SceneNode[], ctx: Ctx, out: CodeWriter) {
    const stack = stackChildren(this.doc, n);
    const useStack = stack && !(stack.layout.wrap && stack.layout.mode === 'horizontal');
    if (stack && !useStack) this.notes.add(`"${n.name}": wrapping auto layout exported with absolute positions.`);
    if (kids.some((k) => k.isMask)) this.notes.add(`"${n.name}": masks are not exported to SwiftUI; masked layers are shown unmasked.`);
    const shape = this.shape(n);
    const mods: string[] = [];
    let alignment = '.topLeading';
    if (useStack && stack) {
      const L = stack.layout;
      const horiz = L.mode === 'horizontal';
      const cross = horiz
        ? { start: '.top', center: '.center', end: '.bottom', stretch: '.top' }[L.align]
        : { start: '.leading', center: '.center', end: '.trailing', stretch: '.leading' }[L.align];
      const spacing = L.justify === 'space-between' ? 0 : L.gap;
      out.line(`${horiz ? 'HStack' : 'VStack'}(alignment: ${cross}, spacing: ${num(spacing)}) {`);
      out.indent(() => {
        stack.flow.forEach((k, i) => {
          if (i && L.justify === 'space-between') out.line(`Spacer(minLength: ${num(L.gap)})`);
          this.view(k, { mode: 'flow', layout: L }, out);
        });
      });
      out.line('}');
      const [t, r, b, l] = L.padding;
      if (t || r || b || l) mods.push(t === r && r === b && b === l ? `.padding(${num(t)})` : `.padding(EdgeInsets(top: ${num(t)}, leading: ${num(l)}, bottom: ${num(b)}, trailing: ${num(r)}))`);
      const main = { start: horiz ? 'leading' : 'top', center: 'center', end: horiz ? 'trailing' : 'bottom', 'space-between': horiz ? 'leading' : 'top' }[L.justify];
      const crossName = cross.slice(1);
      const v = horiz ? crossName : main;
      const h = horiz ? main : crossName;
      alignment = v === 'center' && h === 'center' ? '.center' : v === 'center' ? `.${h}` : h === 'center' ? `.${v}` : `.${v}${h.charAt(0).toUpperCase()}${h.slice(1)}`;
    } else {
      out.line('ZStack(alignment: .topLeading) {');
      out.indent(() => kids.filter((k) => !k.isMask).forEach((k) => this.view(k, { mode: 'abs' }, out)));
      out.line('}');
    }
    mods.push(...this.frameMods(n, ctx, alignment));
    if (useStack && stack?.abs.length) {
      mods.push('.overlay(alignment: .topLeading) {');
      const inner = new CodeWriter('    ');
      inner.indent(() => stack.abs.forEach((k) => this.view(k, { mode: 'abs' }, inner)));
      mods.push(...inner.toString().trimEnd().split('\n'), '}');
    }
    if (n.type === 'frame') {
      const fills = visiblePaints(n.fills);
      const img = imagePaint(fills);
      for (const p of fills.filter((x) => x.type !== 'image')) mods.push(`.background(${shape}.fill(${this.paint(p, n)}))`);
      if (img && this.doc.assets[img.assetId])
        mods.push(`.background(Image(${swiftString(this.images.base(img.assetId))}).resizable().aspectRatio(contentMode: ${img.fit === 'fit' ? '.fit' : '.fill'}))`);
      if (n.clipContent || img) mods.push(`.clipShape(${shape})`);
      mods.push(...this.strokeMods(n, shape, true));
    }
    mods.push(...this.effectMods(n, 'box'), ...this.placeMods(n, ctx));
    mods.forEach((m) => out.line(m));
  }
}

function buildSwiftUI(doc: Doc, rootId: ID, name: string, images: ImageAssets): string {
  const g = new SwiftGen(doc, images);
  const body = new CodeWriter('    ');
  body.indent(() => body.indent(() => g.view(doc.nodes[rootId], { mode: 'root' }, body)));
  const out = new CodeWriter('    ');
  out.line(`// ${doc.nodes[rootId].name} — exported from Alt.`);
  const notes = g.notes.lines('//');
  if (notes.length) {
    out.line('//');
    notes.forEach((l) => out.line(l));
  }
  if (images.names.size) out.line(`// Add the exported images to your asset catalog: ${[...images.names.values()].join(', ')}.`);
  out.blank();
  out.line('import SwiftUI');
  out.blank();
  out.line(`struct ${name}: View {`);
  out.indent(() => out.line('var body: some View {'));
  out.lines_(body.toString().trimEnd());
  out.indent(() => out.line('}'));
  out.line('}');
  for (const s of g.shapes) {
    out.blank();
    out.lines_(s.trimEnd());
  }
  out.blank();
  out.line('#Preview {');
  out.indent(() => out.line(`${name}()`));
  out.line('}');
  return out.toString();
}

/* =============================================================== Flutter */

/** Dart / Kotlin expression tree with dart-format-like printing. */
type Expr = string | { call: string; args: [string | null, Expr][] } | { list: Expr[] };

const call = (name: string, args: [string | null, Expr | undefined | null | false][]): Expr => ({
  call: name,
  args: args.filter((a): a is [string | null, Expr] => a[1] !== undefined && a[1] !== null && a[1] !== false),
});

function printExpr(e: Expr, level: number, sep: string, width = 80): string {
  const pad = '  '.repeat(level);
  if (typeof e === 'string') return e;
  const inline = printInline(e, sep);
  if (inline.length + level * 2 <= width && !inline.includes('\n')) return inline;
  if ('list' in e) {
    if (!e.list.length) return '[]';
    return `[\n${e.list.map((x) => `${pad}  ${printExpr(x, level + 1, sep, width)},`).join('\n')}\n${pad}]`;
  }
  if (!e.args.length) return `${e.call}()`;
  return `${e.call}(\n${e.args.map(([k, v]) => `${pad}  ${k ? k + sep : ''}${printExpr(v, level + 1, sep, width)},`).join('\n')}\n${pad})`;
}

function printInline(e: Expr, sep: string): string {
  if (typeof e === 'string') return e;
  if ('list' in e) return `[${e.list.map((x) => printInline(x, sep)).join(', ')}]`;
  return `${e.call}(${e.args.map(([k, v]) => `${k ? k + sep : ''}${printInline(v, sep)}`).join(', ')})`;
}

const dartString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
const dartColor = (hex: string, alpha = 1) => `Color(0x${argbHex(hex, alpha)})`;
const dartAlign = (x: number, y: number) => `Alignment(${num(x * 2 - 1, 3)}, ${num(y * 2 - 1, 3)})`;

const DART_RESERVED = ['Card', 'Container', 'Text', 'Row', 'Column', 'Stack', 'Image', 'Icon', 'Scaffold', 'Material', 'Color', 'Colors', 'Paint', 'Path', 'Canvas', 'Size', 'Offset', 'Widget', 'State', 'Center', 'Align', 'Padding', 'Positioned', 'Expanded', 'Opacity', 'Transform', 'Wrap', 'Flex', 'Divider', 'Chip', 'Tab', 'Banner', 'Badge', 'Dialog', 'Drawer', 'Table', 'Title', 'Tooltip', 'Theme', 'Form', 'Switch', 'Slider', 'Radio', 'Checkbox', 'Spacer', 'Placeholder', 'Visibility', 'Builder', 'Navigator', 'Overlay', 'Border', 'Gradient', 'Shadow', 'Key', 'Page', 'Route', 'Frame', 'Rect', 'Radius', 'Alignment', 'Clip', 'Shape', 'Main', 'App'];

class FlutterGen {
  readonly painters: string[] = [];
  readonly notes = new Notes();
  usesUi = false;
  private painterNames = new NameRegistry('pascal', DART_RESERVED);
  constructor(
    readonly doc: Doc,
    readonly images: ImageAssets,
    readonly assetDir: string,
  ) {}

  private gradient(p: GradientPaint, n: SceneNode): Expr {
    const stops = sortedStops(p);
    const colors: Expr = { list: stops.map((s) => dartColor(s.color, s.opacity * p.opacity)) };
    const at: Expr = { list: stops.map((s) => num(s.offset, 3)) };
    if (p.type === 'linear') return call('LinearGradient', [['begin', dartAlign(p.from.x, p.from.y)], ['end', dartAlign(p.to.x, p.to.y)], ['colors', colors], ['stops', at]]);
    const g = gradientGeom(p, n.width, n.height);
    if (p.type === 'angular') {
      return call('SweepGradient', [['center', dartAlign(p.from.x, p.from.y)], ['colors', colors], ['stops', at], ['transform', `GradientRotation(${num(g.angle, 4)})`]]);
    }
    if (p.type === 'diamond') this.notes.add(`"${n.name}": diamond gradient approximated with a radial gradient.`);
    const radius = g.radius * (Math.max(n.width, n.height) / Math.max(0.01, Math.min(n.width, n.height)));
    return call('RadialGradient', [['center', dartAlign(p.from.x, p.from.y)], ['radius', num(radius, 3)], ['colors', colors], ['stops', at]]);
  }

  private color(p: Paint, n: SceneNode): string {
    if (p.type === 'solid') return dartColor(p.color, p.opacity);
    if (isGradient(p)) return dartColor(sortedStops(p)[0].color, p.opacity);
    if (p.type === 'pattern' || p.type === 'noise') {
      this.notes.add(`"${n.name}": ${p.type} paint exported as a flat colour.`);
      return dartColor(p.background ?? p.color, p.opacity);
    }
    return 'Colors.transparent';
  }

  private radius(n: SceneNode): Expr | undefined {
    if (isPlainEllipse(n)) return `BorderRadius.all(Radius.elliptical(${num(n.width / 2)}, ${num(n.height / 2)}))`;
    const u = uniformRadius(n);
    if (u === 0) return undefined;
    if (u !== null) return `BorderRadius.circular(${num(u)})`;
    const [tl, tr, br, bl] = cornerRadii(n);
    const r = (v: number) => `Radius.circular(${num(v)})`;
    return call('BorderRadius.only', [['topLeft', r(tl)], ['topRight', r(tr)], ['bottomRight', r(br)], ['bottomLeft', r(bl)]]);
  }

  private decoration(n: SceneNode): Expr | undefined {
    const fills = visiblePaints(n.fills);
    const top = fills.filter((p) => p.type !== 'image').at(-1);
    const img = imagePaint(fills);
    const stroke = visiblePaints(n.strokes).filter((p) => p.type !== 'image').at(-1);
    const shadows = visibleEffects(n.effects).filter((e) => e.type === 'drop-shadow' || e.type === 'glow') as (ShadowEffect | GlowEffect)[];
    const args: [string | null, Expr | undefined][] = [];
    if (top && !isGradient(top)) args.push(['color', this.color(top, n)]);
    if (top && isGradient(top)) args.push(['gradient', this.gradient(top, n)]);
    if (img && this.doc.assets[img.assetId]) {
      const fit = { fill: 'BoxFit.cover', crop: 'BoxFit.cover', fit: 'BoxFit.contain', stretch: 'BoxFit.fill', tile: 'BoxFit.none' }[img.fit];
      args.push([
        'image',
        call('DecorationImage', [
          ['image', `AssetImage(${dartString(this.assetDir + this.images.file(img.assetId))})`],
          ['fit', fit],
          ['repeat', img.fit === 'tile' ? 'ImageRepeat.repeat' : undefined],
          ['opacity', img.opacity < 0.999 ? num(img.opacity, 3) : undefined],
        ]),
      ]);
    }
    args.push(['borderRadius', this.radius(n)]);
    if (stroke && n.strokeWidth > 0) {
      const align = { inside: 'BorderSide.strokeAlignInside', center: 'BorderSide.strokeAlignCenter', outside: 'BorderSide.strokeAlignOutside' }[n.strokeAlign];
      args.push(['border', call('Border.all', [['color', this.color(stroke, n)], ['width', num(n.strokeWidth)], ['strokeAlign', n.strokeAlign === 'inside' ? undefined : align]])]);
      if (n.dash.some((d) => d > 0)) this.notes.add(`"${n.name}": dashed borders are not supported by BoxDecoration.`);
    }
    if (shadows.length) {
      args.push([
        'boxShadow',
        {
          list: shadows.map((e) =>
            call('BoxShadow', [
              ['color', dartColor(e.color, e.opacity)],
              ['offset', e.type === 'drop-shadow' && (e.x || e.y) ? `Offset(${num(e.x)}, ${num(e.y)})` : undefined],
              ['blurRadius', num(e.blur)],
              ['spreadRadius', e.spread ? num(e.spread) : undefined],
            ]),
          ),
        },
      ]);
    }
    const real = args.filter(([, v]) => v !== undefined);
    return real.length ? call('BoxDecoration', real) : undefined;
  }

  /** Wrap with opacity / blur / rotation / flip. */
  private wrap(n: SceneNode, child: Expr, ctx: Ctx): Expr {
    let e = child;
    for (const fx of visibleEffects(n.effects)) {
      if (fx.type === 'layer-blur' && fx.radius > 0) {
        this.usesUi = true;
        e = call('ImageFiltered', [['imageFilter', `ImageFilter.blur(sigmaX: ${num(fx.radius / 2)}, sigmaY: ${num(fx.radius / 2)})`], ['child', e]]);
      } else if (fx.type === 'background-blur' && fx.radius > 0) {
        this.usesUi = true;
        const r = this.radius(n);
        e = call(r ? 'ClipRRect' : 'ClipRect', [
          ['borderRadius', r],
          ['child', call('BackdropFilter', [['filter', `ImageFilter.blur(sigmaX: ${num(fx.radius / 2)}, sigmaY: ${num(fx.radius / 2)})`], ['child', e]])],
        ]);
      }
    }
    effectNotes(n, this.notes, ['drop-shadow', 'glow', 'layer-blur', 'background-blur']);
    if (n.blendMode !== 'normal') this.notes.add(`"${n.name}": blend mode ${n.blendMode} is not applied (Flutter has no per-widget blend mode).`);
    if (n.opacity < 0.999) e = call('Opacity', [['opacity', num(n.opacity, 3)], ['child', e]]);
    if (ctx.mode !== 'root') {
      if (n.flipX || n.flipY) e = call('Transform.flip', [['flipX', n.flipX ? 'true' : undefined], ['flipY', n.flipY ? 'true' : undefined], ['child', e]]);
      if (r2(n.rotation, 3)) e = call('Transform.rotate', [['angle', num((n.rotation * Math.PI) / 180, 4)], ['child', e]]);
    }
    return e;
  }

  /** Size arguments for a node in its context (`double.infinity` for cross fill). */
  private sizeArgs(n: SceneNode, ctx: Ctx): [string, Expr | undefined][] {
    const s = axisSizes(n, ctx);
    const main = ctx.layout?.mode === 'horizontal' ? 'h' : 'v';
    const val = (axis: 'h' | 'v', a: AxisSize) => (a.kind === 'fixed' ? num(a.value) : a.kind === 'fill' && axis !== main ? 'double.infinity' : undefined);
    return [
      ['width', val('h', s.h)],
      ['height', val('v', s.v)],
    ];
  }

  private placed(n: SceneNode, e: Expr, ctx: Ctx): Expr {
    const wrapped = this.wrap(n, e, ctx);
    if (ctx.mode === 'abs') return call('Positioned', [['left', num(n.x)], ['top', num(n.y)], ['child', wrapped]]);
    if (ctx.mode === 'flow' && ctx.layout) {
      const main = ctx.layout.mode === 'horizontal' ? 'h' : 'v';
      if (axisSizes(n, ctx)[main].kind === 'fill') return call('Expanded', [['child', wrapped]]);
    }
    return wrapped;
  }

  widget(n: SceneNode, ctx: Ctx): Expr {
    if (n.type === 'text') return this.placed(n, this.text(n, ctx), ctx);
    if (n.type === 'bitmap') {
      const img = this.doc.assets[n.assetId]
        ? call('Image.asset', [
            [null, dartString(this.assetDir + this.images.file(n.assetId))],
            ...this.sizeArgs(n, ctx),
            ['fit', 'BoxFit.fill'],
            ['filterQuality', n.smoothing ? undefined : 'FilterQuality.none'],
          ])
        : call('SizedBox', this.sizeArgs(n, ctx));
      return this.placed(n, img, ctx);
    }
    if (isVectorNode(n)) return this.placed(n, this.vector(n, ctx), ctx);
    const kids = n.type === 'frame' || n.type === 'group' ? childNodes(this.doc, n) : [];
    const deco = n.type === 'group' ? undefined : this.decoration(n);
    let child: Expr | undefined;
    let padding: Expr | undefined;
    if (kids.length) {
      if (kids.some((k) => k.isMask)) this.notes.add(`"${n.name}": masks are not exported to Flutter; masked layers are shown unmasked.`);
      const stack = stackChildren(this.doc, n);
      if (stack) {
        const L = stack.layout;
        const [t, r, b, l] = L.padding;
        if (t || r || b || l) padding = t === r && r === b && b === l ? `EdgeInsets.all(${num(t)})` : `EdgeInsets.fromLTRB(${num(l)}, ${num(t)}, ${num(r)}, ${num(b)})`;
        const flowKids: Expr = { list: stack.flow.map((k) => this.widget(k, { mode: 'flow', layout: L })) };
        const horiz = L.mode === 'horizontal';
        let flow: Expr;
        if (L.wrap && horiz) {
          flow = call('Wrap', [
            ['spacing', num(L.gap)],
            ['runSpacing', num(L.gap)],
            ['alignment', { start: undefined, center: 'WrapAlignment.center', end: 'WrapAlignment.end', 'space-between': 'WrapAlignment.spaceBetween' }[L.justify]],
            ['crossAxisAlignment', { start: undefined, center: 'WrapCrossAlignment.center', end: 'WrapCrossAlignment.end', stretch: undefined }[L.align]],
            ['children', flowKids],
          ]);
        } else {
          const hugMain = (horiz ? n.sizingH : n.sizingV) === 'hug';
          flow = call(horiz ? 'Row' : 'Column', [
            ['mainAxisSize', hugMain ? 'MainAxisSize.min' : undefined],
            ['mainAxisAlignment', { start: undefined, center: 'MainAxisAlignment.center', end: 'MainAxisAlignment.end', 'space-between': 'MainAxisAlignment.spaceBetween' }[L.justify]],
            ['crossAxisAlignment', { start: 'CrossAxisAlignment.start', center: undefined, end: 'CrossAxisAlignment.end', stretch: 'CrossAxisAlignment.stretch' }[L.align]],
            ['spacing', L.gap && L.justify !== 'space-between' ? num(L.gap) : undefined],
            ['children', flowKids],
          ]);
        }
        child = stack.abs.length
          ? call('Stack', [
              ['clipBehavior', 'Clip.none'],
              ['children', { list: [flow, ...stack.abs.map((k) => this.widget(k, { mode: 'abs' }))] }],
            ])
          : flow;
      } else {
        child = call('Stack', [
          ['clipBehavior', 'Clip.none'],
          ['children', { list: kids.filter((k) => !k.isMask).map((k) => this.widget(k, { mode: 'abs' })) }],
        ]);
      }
    }
    const clip = n.type === 'frame' && n.clipContent && kids.length;
    const e = deco || padding || clip
      ? call('Container', [
          ...this.sizeArgs(n, ctx),
          ['padding', padding],
          ['clipBehavior', clip ? 'Clip.antiAlias' : undefined],
          ['decoration', deco ?? (clip ? 'BoxDecoration()' : undefined)],
          ['child', child],
        ])
      : call('SizedBox', [...this.sizeArgs(n, ctx), ['child', child]]);
    return this.placed(n, e, ctx);
  }

  private text(n: TextNode, ctx: Ctx): Expr {
    const fill = visiblePaints(n.fills).filter((p) => p.type !== 'image').at(-1);
    if (fill && isGradient(fill)) this.notes.add(`"${n.name}": gradient text exported with its first colour.`);
    const weight = Math.min(900, Math.max(100, Math.round(n.fontWeight / 100) * 100));
    const shadows = visibleEffects(n.effects).filter((e) => e.type === 'drop-shadow' || e.type === 'glow') as (ShadowEffect | GlowEffect)[];
    const style = call('TextStyle', [
      ['fontFamily', dartString(n.fontFamily)],
      ['fontSize', num(n.fontSize)],
      ['fontWeight', weight !== 400 ? `FontWeight.w${weight}` : undefined],
      ['fontStyle', n.italic ? 'FontStyle.italic' : undefined],
      ['height', num(n.lineHeight, 3)],
      ['letterSpacing', n.letterSpacing ? num(n.letterSpacing) : undefined],
      ['color', fill ? this.color(fill, n) : undefined],
      ['decoration', n.textDecoration === 'underline' ? 'TextDecoration.underline' : n.textDecoration === 'strikethrough' ? 'TextDecoration.lineThrough' : undefined],
      [
        'shadows',
        shadows.length
          ? {
              list: shadows.map((e) =>
                call('Shadow', [
                  ['color', dartColor(e.color, e.opacity)],
                  ['offset', e.type === 'drop-shadow' && (e.x || e.y) ? `Offset(${num(e.x)}, ${num(e.y)})` : undefined],
                  ['blurRadius', num(e.blur)],
                ]),
              ),
            }
          : undefined,
      ],
    ]);
    const align = { left: undefined, center: 'TextAlign.center', right: 'TextAlign.right', justify: 'TextAlign.justify' }[n.textAlign];
    let e: Expr = call('Text', [
      [null, dartString(textOf(n))],
      ['textAlign', align],
      ['softWrap', n.autoResize === 'width' ? 'false' : undefined],
      ['style', style],
    ]);
    if (n.autoResize === 'none' && n.verticalAlign !== 'top') {
      const v = n.verticalAlign === 'middle' ? 'center' : 'bottom';
      const h = n.textAlign === 'center' ? 'Center' : n.textAlign === 'right' ? 'Right' : 'Left';
      e = call('Align', [['alignment', v === 'center' && h === 'Center' ? 'Alignment.center' : `Alignment.${v}${h}`], ['child', e]]);
    }
    const size = this.sizeArgs(n, ctx).filter(([, v]) => v !== undefined);
    return size.length ? call('SizedBox', [...size, ['child', e]]) : e;
  }

  private vector(n: SceneNode, ctx: Ctx): Expr {
    const name = `_${this.painterNames.get(`${n.name} painter`, 'VectorPainter')}`;
    this.painters.push(this.painter(name, n));
    return call('CustomPaint', [
      ['size', `Size(${num(n.width)}, ${num(n.height)})`],
      ['painter', `${name}()`],
    ]);
  }

  private painter(name: string, n: SceneNode): string {
    const c = new CodeWriter('  ');
    const cmds = vectorCmds(this.doc, n);
    const evenOdd = (n.type === 'path' && n.fillRule === 'evenodd') || n.type === 'boolean';
    c.block(`class ${name} extends CustomPainter {`, () => {
      c.line('@override');
      c.block('void paint(Canvas canvas, Size size) {', () => {
        c.line(`canvas.scale(size.width / ${flt(Math.max(n.width, 0.01))}, size.height / ${flt(Math.max(n.height, 0.01))});`);
        c.line('final path = Path()');
        c.indent(() => {
          const lines = cmds.map((k) =>
            k.c === 'M'
              ? `..moveTo(${num(k.x)}, ${num(k.y)})`
              : k.c === 'L'
                ? `..lineTo(${num(k.x)}, ${num(k.y)})`
                : k.c === 'C'
                  ? `..cubicTo(${num(k.x1)}, ${num(k.y1)}, ${num(k.x2)}, ${num(k.y2)}, ${num(k.x)}, ${num(k.y)})`
                  : '..close()',
          );
          if (evenOdd) lines.push('..fillType = PathFillType.evenOdd');
          lines.forEach((l, i) => c.line(i === lines.length - 1 ? `${l};` : l));
          if (!lines.length) c.line(';');
        });
        const bounds = `Offset.zero & Size(${num(n.width)}, ${num(n.height)})`;
        const paintExpr = (p: Paint) => (isGradient(p) ? `..shader = ${printInline(this.gradient(p, n), ': ')}.createShader(${bounds})` : `..color = ${this.color(p, n)}`);
        for (const p of visiblePaints(n.fills).filter((x) => x.type !== 'image')) c.line(`canvas.drawPath(path, Paint()${paintExpr(p)});`);
        if (n.strokeWidth > 0) {
          for (const p of visiblePaints(n.strokes).filter((x) => x.type !== 'image')) {
            const cap = n.strokeCap !== 'butt' ? `..strokeCap = StrokeCap.${n.strokeCap}` : '';
            const join = n.strokeJoin !== 'miter' ? `..strokeJoin = StrokeJoin.${n.strokeJoin}` : '';
            c.line(`canvas.drawPath(path, Paint()..style = PaintingStyle.stroke..strokeWidth = ${num(n.strokeWidth)}${cap}${join}${paintExpr(p)});`);
          }
        }
      });
      c.blank();
      c.line('@override');
      c.line('bool shouldRepaint(covariant CustomPainter oldDelegate) => false;');
    });
    return c.toString();
  }
}

function buildFlutter(doc: Doc, rootId: ID, name: string, images: ImageAssets): string {
  const g = new FlutterGen(doc, images, 'assets/');
  const root = g.widget(doc.nodes[rootId], { mode: 'root' });
  const out = new CodeWriter('  ');
  out.line(`// ${doc.nodes[rootId].name} — exported from Alt.`);
  const notes = g.notes.lines('//');
  if (notes.length) {
    out.line('//');
    notes.forEach((l) => out.line(l));
  }
  if (images.names.size) out.line(`// Add the exported images under assets/ and list them in pubspec.yaml.`);
  out.blank();
  if (g.usesUi) out.line("import 'dart:ui' show ImageFilter;");
  out.blank();
  out.line("import 'package:flutter/material.dart';");
  out.blank();
  out.block(`class ${name} extends StatelessWidget {`, () => {
    out.line(`const ${name}({super.key});`);
    out.blank();
    out.line('@override');
    out.block('Widget build(BuildContext context) {', () => {
      out.lines_(`return ${printExpr(root, 0, ': ', 76)};`);
    });
  });
  for (const p of g.painters) {
    out.blank();
    out.lines_(p.trimEnd());
  }
  return out.toString();
}

/* ================================================================ Compose */

const ktString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
const ktColor = (hex: string, alpha = 1) => `Color(0x${argbHex(hex, alpha)})`;
const dp = (v: number) => `${num(v)}.dp`;
const sp = (v: number) => `${num(v)}.sp`;
const ktFloat = (v: number) => `${num(v, 3)}f`;

const KT_IMPORTS: Record<string, string> = {
  Box: 'androidx.compose.foundation.layout.Box',
  Row: 'androidx.compose.foundation.layout.Row',
  Column: 'androidx.compose.foundation.layout.Column',
  FlowRow: 'androidx.compose.foundation.layout.FlowRow',
  ExperimentalLayoutApi: 'androidx.compose.foundation.layout.ExperimentalLayoutApi',
  Arrangement: 'androidx.compose.foundation.layout.Arrangement',
  PaddingValues: 'androidx.compose.foundation.layout.PaddingValues',
  offset: 'androidx.compose.foundation.layout.offset',
  size: 'androidx.compose.foundation.layout.size',
  width: 'androidx.compose.foundation.layout.width',
  height: 'androidx.compose.foundation.layout.height',
  padding: 'androidx.compose.foundation.layout.padding',
  fillMaxWidth: 'androidx.compose.foundation.layout.fillMaxWidth',
  fillMaxHeight: 'androidx.compose.foundation.layout.fillMaxHeight',
  wrapContentSize: 'androidx.compose.foundation.layout.wrapContentSize',
  background: 'androidx.compose.foundation.background',
  border: 'androidx.compose.foundation.border',
  Image: 'androidx.compose.foundation.Image',
  Canvas: 'androidx.compose.foundation.Canvas',
  RoundedCornerShape: 'androidx.compose.foundation.shape.RoundedCornerShape',
  CircleShape: 'androidx.compose.foundation.shape.CircleShape',
  GenericShape: 'androidx.compose.foundation.shape.GenericShape',
  Text: 'androidx.compose.material3.Text',
  Composable: 'androidx.compose.runtime.Composable',
  Modifier: 'androidx.compose.ui.Modifier',
  Alignment: 'androidx.compose.ui.Alignment',
  clip: 'androidx.compose.ui.draw.clip',
  alpha: 'androidx.compose.ui.draw.alpha',
  rotate: 'androidx.compose.ui.draw.rotate',
  scale: 'androidx.compose.ui.draw.scale',
  blur: 'androidx.compose.ui.draw.blur',
  dropShadow: 'androidx.compose.ui.draw.dropShadow',
  innerShadow: 'androidx.compose.ui.draw.innerShadow',
  Shadow: 'androidx.compose.ui.graphics.shadow.Shadow',
  RectangleShape: 'androidx.compose.ui.graphics.RectangleShape',
  LocalTextStyle: 'androidx.compose.material3.LocalTextStyle',
  Color: 'androidx.compose.ui.graphics.Color',
  Brush: 'androidx.compose.ui.graphics.Brush',
  ShaderBrush: 'androidx.compose.ui.graphics.ShaderBrush',
  Shader: 'androidx.compose.ui.graphics.Shader',
  LinearGradientShader: 'androidx.compose.ui.graphics.LinearGradientShader',
  RadialGradientShader: 'androidx.compose.ui.graphics.RadialGradientShader',
  SweepGradientShader: 'androidx.compose.ui.graphics.SweepGradientShader',
  Path: 'androidx.compose.ui.graphics.Path',
  PathFillType: 'androidx.compose.ui.graphics.PathFillType',
  PathEffect: 'androidx.compose.ui.graphics.PathEffect',
  StrokeCap: 'androidx.compose.ui.graphics.StrokeCap',
  StrokeJoin: 'androidx.compose.ui.graphics.StrokeJoin',
  FilterQuality: 'androidx.compose.ui.graphics.FilterQuality',
  Stroke: 'androidx.compose.ui.graphics.drawscope.Stroke',
  withTransform: 'androidx.compose.ui.graphics.drawscope.withTransform',
  Offset: 'androidx.compose.ui.geometry.Offset',
  Size: 'androidx.compose.ui.geometry.Size',
  Rect: 'androidx.compose.ui.geometry.Rect',
  ContentScale: 'androidx.compose.ui.layout.ContentScale',
  painterResource: 'androidx.compose.ui.res.painterResource',
  FontFamily: 'androidx.compose.ui.text.font.FontFamily',
  FontStyle: 'androidx.compose.ui.text.font.FontStyle',
  FontWeight: 'androidx.compose.ui.text.font.FontWeight',
  TextAlign: 'androidx.compose.ui.text.style.TextAlign',
  TextDecoration: 'androidx.compose.ui.text.style.TextDecoration',
  Preview: 'androidx.compose.ui.tooling.preview.Preview',
  dp: 'androidx.compose.ui.unit.dp',
  sp: 'androidx.compose.ui.unit.sp',
  DpOffset: 'androidx.compose.ui.unit.DpOffset',
};

const KT_WEIGHT: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

class ComposeGen {
  readonly imports = new Set<string>(['Composable', 'Modifier', 'Preview', 'dp']);
  readonly notes = new Notes();
  readonly helpers = new Set<'linear' | 'radial' | 'sweep' | 'ellipse'>();
  readonly fonts = new Map<string, string>();
  optInFlow = false;
  private fontNames = new NameRegistry('pascal');
  constructor(
    readonly doc: Doc,
    readonly images: ImageAssets,
  ) {}

  private use(...names: string[]) {
    names.forEach((n) => this.imports.add(n));
  }

  private stops(p: GradientPaint): string {
    return sortedStops(p)
      .map((s) => `${ktFloat(s.offset)} to ${ktColor(s.color, s.opacity * p.opacity)}`)
      .join(', ');
  }

  /** Brush / Color expression for a paint. Box-relative gradients use small helper brushes. */
  brush(p: Paint, n: SceneNode): { expr: string; isColor: boolean } {
    this.use('Color');
    switch (p.type) {
      case 'solid':
        return { expr: ktColor(p.color, p.opacity), isColor: true };
      case 'linear':
        this.helpers.add('linear');
        this.use('Brush', 'ShaderBrush', 'Shader', 'Size', 'Offset', 'LinearGradientShader');
        return { expr: `relativeLinearGradient(${this.stops(p)}, start = Offset(${ktFloat(p.from.x)}, ${ktFloat(p.from.y)}), end = Offset(${ktFloat(p.to.x)}, ${ktFloat(p.to.y)}))`, isColor: false };
      case 'radial':
      case 'diamond': {
        if (p.type === 'diamond') this.notes.add(`"${n.name}": diamond gradient approximated with a radial gradient.`);
        this.helpers.add('radial');
        this.use('Brush', 'ShaderBrush', 'Shader', 'Size', 'Offset', 'RadialGradientShader');
        const g = gradientGeom(p, n.width, n.height);
        return { expr: `relativeRadialGradient(${this.stops(p)}, center = Offset(${ktFloat(p.from.x)}, ${ktFloat(p.from.y)}), radius = ${ktFloat(g.radius)})`, isColor: false };
      }
      case 'angular': {
        this.helpers.add('sweep');
        this.use('Brush', 'ShaderBrush', 'Shader', 'Size', 'Offset', 'SweepGradientShader');
        const g = gradientGeom(p, n.width, n.height);
        const deg = (g.angle * 180) / Math.PI;
        if (Math.abs(deg) > 0.5) this.notes.add(`"${n.name}": sweep gradient start angle (${num(deg)}°) is not applied.`);
        return { expr: `relativeSweepGradient(${this.stops(p)}, center = Offset(${ktFloat(p.from.x)}, ${ktFloat(p.from.y)}))`, isColor: false };
      }
      case 'pattern':
      case 'noise':
        this.notes.add(`"${n.name}": ${p.type} paint exported as a flat colour.`);
        return { expr: ktColor(p.background ?? p.color, p.opacity), isColor: true };
      case 'image':
        return { expr: 'Color.Transparent', isColor: true };
    }
  }

  shape(n: SceneNode): string | null {
    if (isPlainEllipse(n)) {
      if (Math.abs(n.width - n.height) < 0.01) {
        this.use('CircleShape');
        return 'CircleShape';
      }
      this.helpers.add('ellipse');
      this.use('GenericShape', 'Rect', 'Offset');
      return 'EllipseShape';
    }
    const u = uniformRadius(n);
    if (u === 0) return null;
    this.use('RoundedCornerShape');
    if (u !== null) return `RoundedCornerShape(${dp(u)})`;
    const [tl, tr, br, bl] = cornerRadii(n);
    return `RoundedCornerShape(topStart = ${dp(tl)}, topEnd = ${dp(tr)}, bottomEnd = ${dp(br)}, bottomStart = ${dp(bl)})`;
  }

  private sizeMods(n: SceneNode, ctx: Ctx): string[] {
    const s = axisSizes(n, ctx);
    const mods: string[] = [];
    const main = ctx.layout?.mode === 'horizontal' ? 'h' : 'v';
    if (s.h.kind === 'fixed' && s.v.kind === 'fixed') {
      this.use('size');
      mods.push(Math.abs(s.h.value - s.v.value) < 0.005 ? `size(${dp(s.h.value)})` : `size(${dp(s.h.value)}, ${dp(s.v.value)})`);
    } else {
      if (s.h.kind === 'fixed') this.use('width'), mods.push(`width(${dp(s.h.value)})`);
      if (s.v.kind === 'fixed') this.use('height'), mods.push(`height(${dp(s.v.value)})`);
    }
    for (const axis of ['h', 'v'] as const) {
      if (s[axis].kind !== 'fill') continue;
      if (ctx.mode === 'flow' && axis === main) mods.push('weight(1f)');
      else {
        const m = axis === 'h' ? 'fillMaxWidth' : 'fillMaxHeight';
        this.use(m);
        mods.push(`${m}()`);
      }
    }
    return mods;
  }

  private placeMods(n: SceneNode, ctx: Ctx): string[] {
    const mods: string[] = [];
    if (ctx.mode === 'abs' && (r2(n.x) || r2(n.y))) {
      this.use('offset');
      mods.push(`offset(x = ${dp(n.x)}, y = ${dp(n.y)})`);
    }
    if (ctx.mode !== 'root') {
      if (r2(n.rotation, 3)) this.use('rotate'), mods.push(`rotate(${ktFloat(n.rotation)})`);
      if (n.flipX || n.flipY) this.use('scale'), mods.push(`scale(scaleX = ${n.flipX ? '-1f' : '1f'}, scaleY = ${n.flipY ? '-1f' : '1f'})`);
    }
    if (n.opacity < 0.999) this.use('alpha'), mods.push(`alpha(${ktFloat(n.opacity)})`);
    if (n.blendMode !== 'normal') this.notes.add(`"${n.name}": blend mode ${n.blendMode} is not applied.`);
    return mods;
  }

  private effectMods(n: SceneNode, shape: string | null): string[] {
    const mods: string[] = [];
    const sh = shape ?? 'RectangleShape';
    if (!shape) this.imports.add('RectangleShape');
    for (const e of visibleEffects(n.effects)) {
      if (e.type === 'drop-shadow' || e.type === 'glow' || e.type === 'inner-shadow') {
        const fn = e.type === 'inner-shadow' ? 'innerShadow' : 'dropShadow';
        this.use(fn, 'Shadow', 'Color');
        const args = [`radius = ${dp(e.blur / 2)}`, `color = ${ktColor(e.color, e.opacity)}`];
        if (e.spread) args.push(`spread = ${dp(e.spread)}`);
        if (e.type !== 'glow' && (e.x || e.y)) {
          this.use('DpOffset');
          args.push(`offset = DpOffset(${dp(e.x)}, ${dp(e.y)})`);
        }
        mods.push(`${fn}(${sh}, Shadow(${args.join(', ')}))`);
      } else if (e.type === 'layer-blur' && e.radius > 0) {
        this.use('blur');
        mods.push(`blur(${dp(e.radius / 2)})`);
      }
    }
    effectNotes(n, this.notes, ['drop-shadow', 'glow', 'inner-shadow', 'layer-blur']);
    return mods;
  }

  private boxMods(n: SceneNode, shape: string | null, clip: boolean): string[] {
    const mods: string[] = [];
    if (clip && shape) this.use('clip'), mods.push(`clip(${shape})`);
    for (const p of visiblePaints(n.fills).filter((x) => x.type !== 'image')) {
      const b = this.brush(p, n);
      this.use('background');
      mods.push(`background(${b.expr}${shape ? `, ${shape}` : ''})`);
    }
    const stroke = visiblePaints(n.strokes).filter((p) => p.type !== 'image').at(-1);
    if (stroke && n.strokeWidth > 0) {
      this.use('border');
      const b = this.brush(stroke, n);
      mods.push(`border(${dp(n.strokeWidth)}, ${b.expr}${shape ? `, ${shape}` : ''})`);
      if (n.strokeAlign !== 'inside') this.notes.add(`"${n.name}": ${n.strokeAlign} stroke drawn inside (Modifier.border).`);
    }
    return mods;
  }

  private modifier(mods: string[], base = 'Modifier'): string {
    return mods.length ? `${base}\n${mods.map((m) => `    .${m}`).join('\n')}` : base;
  }

  /** Write `Name(args) { content }` with Kotlin formatting. */
  private callBlock(out: CodeWriter, name: string, args: [string, string][], content?: () => void) {
    const simple = args.length === 1 && !args[0][1].includes('\n') && args[0][1].length < 60;
    if (simple && !args[0][1].includes('\n')) {
      const head = `${name}(${args[0][0]} = ${args[0][1]})`;
      if (content) out.block(`${head} {`, content);
      else out.line(head);
      return;
    }
    if (!args.length) {
      if (content) out.block(`${name} {`, content);
      else out.line(`${name}()`);
      return;
    }
    out.line(`${name}(`);
    out.indent(() => {
      for (const [k, v] of args) {
        const lines = v.split('\n');
        out.line(`${k} = ${lines[0]}${lines.length === 1 ? ',' : ''}`);
        lines.slice(1).forEach((l, i) => out.line(`${l}${i === lines.length - 2 ? ',' : ''}`));
      }
    });
    if (content) out.block(') {', content);
    else out.line(')');
  }

  node(n: SceneNode, ctx: Ctx, out: CodeWriter, rootModifier = false) {
    const base = rootModifier ? 'modifier' : 'Modifier';
    out.line(`// ${n.name}`);
    if (n.type === 'text') return this.text(n, ctx, out, base);
    if (n.type === 'bitmap' || (imagePaint(n.fills) && n.type !== 'frame' && n.type !== 'group' && !isVectorNode(n))) return this.image(n, ctx, out, base);
    if (isVectorNode(n)) return this.vector(n, ctx, out, base);
    const kids = n.type === 'frame' || n.type === 'group' ? childNodes(this.doc, n) : [];
    const shape = n.type === 'group' ? null : this.shape(n);
    const clip = n.type === 'frame' && n.clipContent && kids.length > 0;
    const mods = [...this.placeMods(n, ctx), ...this.sizeMods(n, ctx), ...this.effectMods(n, shape), ...(n.type === 'group' ? [] : this.boxMods(n, shape, clip))];
    if (kids.some((k) => k.isMask)) this.notes.add(`"${n.name}": masks are not exported to Compose; masked layers are shown unmasked.`);
    const stack = kids.length ? stackChildren(this.doc, n) : null;
    if (!stack) {
      this.use('Box');
      this.callBlock(out, 'Box', [['modifier', this.modifier(mods, base)]], kids.length ? () => kids.filter((k) => !k.isMask).forEach((k) => this.node(k, { mode: 'abs' }, out)) : undefined);
      return;
    }
    const L = stack.layout;
    const [t, r, b, l] = L.padding;
    const padMods = t || r || b || l ? [t === r && r === b && b === l ? `padding(${dp(t)})` : `padding(start = ${dp(l)}, top = ${dp(t)}, end = ${dp(r)}, bottom = ${dp(b)})`] : [];
    if (padMods.length) this.use('padding');
    const horiz = L.mode === 'horizontal';
    const wrap = L.wrap && horiz;
    const comp = wrap ? 'FlowRow' : horiz ? 'Row' : 'Column';
    this.use(comp, 'Arrangement', 'Alignment');
    if (wrap) {
      this.use('ExperimentalLayoutApi');
      this.optInFlow = true;
    }
    const mainAlign = horiz
      ? { start: 'Alignment.Start', center: 'Alignment.CenterHorizontally', end: 'Alignment.End', 'space-between': '' }[L.justify]
      : { start: 'Alignment.Top', center: 'Alignment.CenterVertically', end: 'Alignment.Bottom', 'space-between': '' }[L.justify];
    const arrangement = L.justify === 'space-between' ? 'Arrangement.SpaceBetween' : L.gap ? `Arrangement.spacedBy(${dp(L.gap)}${L.justify !== 'start' ? `, ${mainAlign}` : ''})` : L.justify === 'start' ? '' : `Arrangement.${{ center: 'Center', end: horiz ? 'End' : 'Bottom' }[L.justify as 'center' | 'end']}`;
    const crossAlign = horiz
      ? { start: 'Alignment.Top', center: 'Alignment.CenterVertically', end: 'Alignment.Bottom', stretch: 'Alignment.Top' }[L.align]
      : { start: 'Alignment.Start', center: 'Alignment.CenterHorizontally', end: 'Alignment.End', stretch: 'Alignment.Start' }[L.align];
    const args: [string, string][] = [];
    const flowArgs = (): [string, string][] => {
      const a: [string, string][] = [];
      if (arrangement) a.push([horiz ? 'horizontalArrangement' : 'verticalArrangement', arrangement]);
      if (wrap && L.gap) a.push(['verticalArrangement', `Arrangement.spacedBy(${dp(L.gap)})`]);
      if (!wrap && L.align !== 'start' && L.align !== 'stretch') a.push([horiz ? 'verticalAlignment' : 'horizontalAlignment', crossAlign]);
      return a;
    };
    const writeFlow = () => stack.flow.forEach((k) => this.node(k, { mode: 'flow', layout: L }, out));
    if (stack.abs.length) {
      // absolute children overlay the stack inside a Box
      this.use('Box');
      this.callBlock(out, 'Box', [['modifier', this.modifier(mods, base)]], () => {
        this.callBlock(out, comp, [['modifier', this.modifier(padMods)], ...flowArgs()], writeFlow);
        stack.abs.forEach((k) => this.node(k, { mode: 'abs' }, out));
      });
      return;
    }
    args.push(['modifier', this.modifier([...mods, ...padMods], base)], ...flowArgs());
    this.callBlock(out, comp, args, writeFlow);
  }

  private fontFamily(family: string): string {
    let v = this.fonts.get(family);
    if (!v) {
      v = this.fontNames.get(`${family} family`, 'AppFontFamily');
      this.fonts.set(family, v);
    }
    return v;
  }

  private text(n: TextNode, ctx: Ctx, out: CodeWriter, base: string) {
    this.use('Text', 'FontFamily', 'sp');
    const fill = visiblePaints(n.fills).filter((p) => p.type !== 'image').at(-1);
    const args: [string, string][] = [['text', ktString(textOf(n))]];
    const mods = [...this.placeMods(n, ctx), ...this.sizeMods(n, ctx), ...this.effectMods(n, null).filter((m) => !m.startsWith('dropShadow') && !m.startsWith('innerShadow'))];
    if (mods.length) args.push(['modifier', this.modifier(mods, base)]);
    if (fill) {
      const b = this.brush(fill, n);
      if (b.isColor) args.push(['color', b.expr]);
      else args.push(['style', `LocalTextStyle.current.copy(brush = ${b.expr})`]), this.imports.add('LocalTextStyle');
    }
    args.push(['fontSize', sp(n.fontSize)]);
    const weight = Math.min(900, Math.max(100, Math.round(n.fontWeight / 100) * 100));
    if (weight !== 400) this.use('FontWeight'), args.push(['fontWeight', `FontWeight.${KT_WEIGHT[weight]}`]);
    if (n.italic) this.use('FontStyle'), args.push(['fontStyle', 'FontStyle.Italic']);
    args.push(['fontFamily', this.fontFamily(n.fontFamily)]);
    if (n.letterSpacing) args.push(['letterSpacing', sp(n.letterSpacing)]);
    args.push(['lineHeight', sp(n.fontSize * n.lineHeight)]);
    if (n.textAlign !== 'left') this.use('TextAlign'), args.push(['textAlign', `TextAlign.${{ center: 'Center', right: 'End', justify: 'Justify' }[n.textAlign as 'center']}`]);
    if (n.textDecoration !== 'none') this.use('TextDecoration'), args.push(['textDecoration', n.textDecoration === 'underline' ? 'TextDecoration.Underline' : 'TextDecoration.LineThrough']);
    if (n.autoResize === 'width') args.push(['softWrap', 'false']);
    if (n.autoResize === 'none' && n.verticalAlign !== 'top') this.notes.add(`"${n.name}": vertical text alignment is not applied.`);
    if (visibleEffects(n.effects).some((e) => e.type === 'drop-shadow')) this.notes.add(`"${n.name}": text shadows are not exported (use TextStyle.shadow).`);
    this.callBlock(out, 'Text', args);
  }

  private image(n: SceneNode, ctx: Ctx, out: CodeWriter, base: string) {
    const assetId = n.type === 'bitmap' ? n.assetId : imagePaint(n.fills)!.assetId;
    const fit = n.type === 'bitmap' ? 'stretch' : imagePaint(n.fills)!.fit;
    this.use('Image', 'painterResource', 'ContentScale');
    const shape = n.type === 'bitmap' ? null : this.shape(n);
    const mods = [...this.placeMods(n, ctx), ...this.sizeMods(n, ctx), ...this.effectMods(n, shape)];
    if (shape) this.use('clip'), mods.push(`clip(${shape})`);
    const args: [string, string][] = [
      ['painter', `painterResource(R.drawable.${this.doc.assets[assetId] ? this.images.base(assetId) : 'missing_image'})`],
      ['contentDescription', ktString(n.name)],
      ['modifier', this.modifier(mods, base)],
      ['contentScale', `ContentScale.${{ fill: 'Crop', crop: 'Crop', fit: 'Fit', stretch: 'FillBounds', tile: 'None' }[fit]}`],
    ];
    if (n.type === 'bitmap' && !n.smoothing) this.use('FilterQuality'), args.push(['filterQuality', 'FilterQuality.None']);
    this.callBlock(out, 'Image', args);
  }

  private vector(n: SceneNode, ctx: Ctx, out: CodeWriter, base: string) {
    this.use('Canvas', 'Path', 'withTransform');
    const mods = [...this.placeMods(n, ctx), ...this.sizeMods(n, ctx), ...this.effectMods(n, null).filter((m) => !m.includes('Shadow('))];
    const cmds = vectorCmds(this.doc, n);
    const evenOdd = (n.type === 'path' && n.fillRule === 'evenodd') || n.type === 'boolean';
    this.callBlock(out, 'Canvas', [['modifier', this.modifier(mods, base)]], () => {
      out.block('val path = Path().apply {', () => {
        if (evenOdd) this.use('PathFillType'), out.line('fillType = PathFillType.EvenOdd');
        for (const k of cmds) {
          if (k.c === 'M') out.line(`moveTo(${ktFloat(k.x)}, ${ktFloat(k.y)})`);
          else if (k.c === 'L') out.line(`lineTo(${ktFloat(k.x)}, ${ktFloat(k.y)})`);
          else if (k.c === 'C') out.line(`cubicTo(${ktFloat(k.x1)}, ${ktFloat(k.y1)}, ${ktFloat(k.x2)}, ${ktFloat(k.y2)}, ${ktFloat(k.x)}, ${ktFloat(k.y)})`);
          else out.line('close()');
        }
      });
      this.use('Offset');
      out.block(`withTransform({ scale(size.width / ${ktFloat(Math.max(n.width, 0.01))}, size.height / ${ktFloat(Math.max(n.height, 0.01))}, pivot = Offset.Zero) }) {`, () => {
        for (const p of visiblePaints(n.fills).filter((x) => x.type !== 'image')) {
          const b = this.brush(p, n);
          out.line(b.isColor ? `drawPath(path, color = ${b.expr})` : `drawPath(path, brush = ${b.expr})`);
        }
        if (n.strokeWidth > 0) {
          for (const p of visiblePaints(n.strokes).filter((x) => x.type !== 'image')) {
            this.use('Stroke');
            const b = this.brush(p, n);
            const style = [`width = ${ktFloat(n.strokeWidth)}`];
            if (n.strokeCap !== 'butt') this.use('StrokeCap'), style.push(`cap = StrokeCap.${n.strokeCap === 'round' ? 'Round' : 'Square'}`);
            if (n.strokeJoin !== 'miter') this.use('StrokeJoin'), style.push(`join = StrokeJoin.${n.strokeJoin === 'round' ? 'Round' : 'Bevel'}`);
            const dash = n.dash.filter((d) => d > 0);
            if (dash.length) this.use('PathEffect'), style.push(`pathEffect = PathEffect.dashPathEffect(floatArrayOf(${dash.map(ktFloat).join(', ')}))`);
            out.line(`drawPath(path, ${b.isColor ? 'color' : 'brush'} = ${b.expr}, style = Stroke(${style.join(', ')}))`);
          }
        }
      });
    });
  }
}

const KT_HELPERS: Record<string, string> = {
  linear: `private fun relativeLinearGradient(vararg stops: Pair<Float, Color>, start: Offset, end: Offset): Brush =
    object : ShaderBrush() {
        override fun createShader(size: Size): Shader = LinearGradientShader(
            from = Offset(start.x * size.width, start.y * size.height),
            to = Offset(end.x * size.width, end.y * size.height),
            colors = stops.map { it.second },
            colorStops = stops.map { it.first },
        )
    }`,
  radial: `private fun relativeRadialGradient(vararg stops: Pair<Float, Color>, center: Offset, radius: Float): Brush =
    object : ShaderBrush() {
        override fun createShader(size: Size): Shader = RadialGradientShader(
            center = Offset(center.x * size.width, center.y * size.height),
            radius = radius * maxOf(size.width, size.height),
            colors = stops.map { it.second },
            colorStops = stops.map { it.first },
        )
    }`,
  sweep: `private fun relativeSweepGradient(vararg stops: Pair<Float, Color>, center: Offset): Brush =
    object : ShaderBrush() {
        override fun createShader(size: Size): Shader = SweepGradientShader(
            center = Offset(center.x * size.width, center.y * size.height),
            colors = stops.map { it.second },
            colorStops = stops.map { it.first },
        )
    }`,
  ellipse: `private val EllipseShape = GenericShape { size, _ -> addOval(Rect(Offset.Zero, size)) }`,
};

function buildCompose(doc: Doc, rootId: ID, name: string, images: ImageAssets, pkg: string): string {
  const g = new ComposeGen(doc, images);
  const body = new CodeWriter('    ');
  body.indent(() => g.node(doc.nodes[rootId], { mode: 'root' }, body, true));
  const out = new CodeWriter('    ');
  out.line(`// ${doc.nodes[rootId].name} — exported from Alt.`);
  const notes = g.notes.lines('//');
  if (notes.length) {
    out.line('//');
    notes.forEach((l) => out.line(l));
  }
  if (images.names.size) out.line(`// Copy the exported images into res/drawable: ${[...images.names.values()].join(', ')}.`);
  out.blank();
  out.line(`package ${pkg}`);
  out.blank();
  [...new Set([...g.imports].map((i) => KT_IMPORTS[i]).filter(Boolean))].sort().forEach((i) => out.line(`import ${i}`));
  out.blank();
  for (const [family, ident] of g.fonts) out.line(`// TODO: replace with FontFamily(Font(R.font.…)) for "${family}"`), out.line(`private val ${ident} = FontFamily.Default`);
  if (g.fonts.size) out.blank();
  if (g.optInFlow) out.line('@OptIn(ExperimentalLayoutApi::class)');
  out.line('@Composable');
  out.line(`fun ${name}(modifier: Modifier = Modifier) {`);
  out.lines_(body.toString().trimEnd());
  out.line('}');
  out.blank();
  out.line('@Preview');
  out.line('@Composable');
  out.line(`private fun ${name}Preview() {`);
  out.indent(() => out.line(`${name}()`));
  out.line('}');
  for (const h of g.helpers) {
    out.blank();
    out.lines_(KT_HELPERS[h]);
  }
  return out.toString();
}

/* -------------------------------------------------------------- exporters */

const KT_RESERVED = ['Box', 'Row', 'Column', 'Text', 'Image', 'Canvas', 'Surface', 'Card', 'Button', 'Icon', 'Scaffold', 'Spacer', 'Divider', 'Modifier', 'Color', 'Brush', 'Shape', 'Path', 'Size', 'Offset', 'Shadow', 'Preview', 'Composable', 'Alignment', 'Arrangement'];

interface NativeSpec {
  id: string;
  label: string;
  extension: string;
  mime: string;
  description: string;
  options?: ExportOption[];
  reserved: string[];
  /** always appended (SwiftUI views) */
  suffix: string;
  /** appended when the layer name collides with a framework type */
  collisionSuffix: string;
  assetNaming: (base: string) => string;
  assetDir: string;
  build: (doc: Doc, rootId: ID, name: string, images: ImageAssets, options: Record<string, unknown>) => string;
}

function nativeExporter(spec: NativeSpec): Exporter {
  return {
    id: spec.id,
    label: spec.label,
    group: 'Native',
    extension: spec.extension,
    description: spec.description,
    textual: true,
    options: spec.options,
    async run(ctx: ExportContext): Promise<ExportFile[]> {
      const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
      const names = new NameRegistry('pascal', spec.reserved, { prefixDigits: 'Layer' });
      const files = new FileNamer();
      const images = new ImageAssets(ctx.doc, spec.assetNaming);
      const out: ExportFile[] = [];
      for (const id of roots) {
        const raw = ctx.doc.nodes[id].name;
        let base = pascalCase(raw) || 'Design';
        if (/^[0-9]/.test(base)) base = `Layer${base}`;
        if (spec.suffix && !base.endsWith(spec.suffix)) base += spec.suffix;
        else if (spec.reserved.includes(base)) base += spec.collisionSuffix;
        const name = names.get(base);
        out.push({ name: files.get(name, spec.extension), mime: spec.mime, data: spec.build(ctx.doc, id, name, images, ctx.options) });
      }
      return [...out, ...images.out(spec.assetDir)];
    },
  };
}

export const swiftUIExporter = nativeExporter({
  id: 'swiftui',
  label: 'SwiftUI',
  extension: 'swift',
  mime: MIME.swift,
  description: 'SwiftUI view: stacks for auto layout, shapes, gradients, shadows and native Path shapes.',
  reserved: SWIFT_RESERVED,
  suffix: 'View',
  collisionSuffix: 'View',
  assetNaming: (b) => b,
  assetDir: '',
  build: (doc, id, name, images) => buildSwiftUI(doc, id, name, images),
});

export const flutterExporter = nativeExporter({
  id: 'flutter',
  label: 'Flutter',
  extension: 'dart',
  mime: MIME.dart,
  description: 'Flutter widget: Row / Column / Stack / Container with BoxDecoration and CustomPainter vectors.',
  reserved: DART_RESERVED,
  suffix: '',
  collisionSuffix: 'Widget',
  assetNaming: (b) => snakeCase(b) || 'image',
  assetDir: 'assets/',
  build: (doc, id, name, images) => buildFlutter(doc, id, name, images),
});

export const composeExporter = nativeExporter({
  id: 'compose',
  label: 'Jetpack Compose',
  extension: 'kt',
  mime: MIME.kotlin,
  description: 'Compose function: Box / Row / Column with modifiers, Text and Canvas vectors.',
  options: [{ key: 'package', label: 'Package', type: 'text', default: 'com.example.ui' }],
  reserved: KT_RESERVED,
  suffix: '',
  collisionSuffix: 'View',
  assetNaming: (b) => snakeCase(b) || 'image',
  assetDir: 'drawable/',
  build: (doc, id, name, images, options) => {
    const pkg = typeof options.package === 'string' && /^[a-z_][\w]*(\.[a-z_][\w]*)*$/i.test(options.package.trim()) ? options.package.trim() : 'com.example.ui';
    return buildCompose(doc, id, name, images, pkg);
  },
});

