/**
 * High-fidelity SVG exporter.
 *
 * Every node becomes a <g> carrying its parent-relative transform, opacity,
 * blend mode and effect filter. Paints are emitted as paint servers in <defs>
 * (gradients, image / pattern tiles, conic & diamond approximations), strokes
 * honour inside / outside alignment via clip-path / mask, masks become <mask>
 * groups and text is laid out with the same line breaker as the canvas.
 */
import type {
  AdjustEffect,
  Doc,
  GradientPaint,
  ID,
  ImageFilters,
  ImagePaint,
  NoisePaint,
  Paint,
  PathNode,
  PatternPaint,
  SceneNode,
  TextNode,
  Vec,
} from '../core/types';
import { localMatrix, mul, transformRect, translate, worldMatrix, type Mat } from '../core/geometry';
import { cmdsToSvgD } from '../core/path';
import { markerCmds, nodeCmds } from '../core/shapes';
import { geometryOf } from '../core/boolean';
import { layoutText } from '../core/text';
import type { ExportContext, ExportFile, Exporter } from './types';
import {
  assetSize,
  el,
  expand,
  effectOutset,
  FileNamer,
  fontStack,
  gradientGeom,
  isPlainEllipse,
  localVisualBounds,
  MIME,
  NameRegistry,
  num,
  r2,
  resolveRoots,
  sampleStops,
  serializeXml,
  sortedStops,
  uniformRadius,
  union,
  visibleEffects,
  visiblePaints,
  cssColor,
  type XEl,
} from './util';

/* ------------------------------------------------------------- helpers */

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/** Compact SVG transform: translate / rotate / flip when possible, matrix() otherwise. */
export function svgTransform(m: Mat): string | undefined {
  const [a, b, c, d, e, f] = m;
  const tr = !near(e, 0, 1e-4) || !near(f, 0, 1e-4) ? `translate(${num(e)} ${num(f)})` : '';
  if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)) return tr || undefined;
  const ortho = Math.abs(a * c + b * d) < 1e-6;
  if (ortho && near(Math.hypot(a, b), 1, 1e-5) && near(Math.hypot(c, d), 1, 1e-5)) {
    const rot = r2((Math.atan2(b, a) * 180) / Math.PI, 3);
    const flip = a * d - b * c < 0;
    return [tr, rot ? `rotate(${rot})` : '', flip ? 'scale(1 -1)' : ''].filter(Boolean).join(' ') || undefined;
  }
  return `matrix(${[a, b, c, d].map((v) => num(v, 5)).join(' ')} ${num(e)} ${num(f)})`;
}

const opacityAttr = (v: number) => (v >= 0.999 ? undefined : r2(Math.max(0, v), 3));

const blendStyle = (mode: string | undefined) => (mode && mode !== 'normal' ? `mix-blend-mode:${mode}` : undefined);

function isClosedShape(n: SceneNode): boolean {
  if (n.type === 'path') return n.paths.length > 0 && n.paths.every((p) => p.closed);
  return n.type !== 'text';
}

/** Children that SVG renders for a mask-aware sibling list. */
interface RenderOpts {
  /** render paints as white (luminance == alpha) for <mask> content */
  maskMode?: boolean;
  /** render even if the node is hidden (explicit export roots) */
  force?: boolean;
  /** skip the node's mix-blend-mode (handled by the embedding page) */
  omitBlend?: boolean;
  /** don't add a layer-name id */
  noId?: boolean;
}

interface PaintRef {
  value: string;
  opacity: number;
  filter?: string;
  background?: string;
}

export interface SvgRendererOptions {
  /** add ids derived from layer names (default true) */
  layerIds?: boolean;
  /** shared id registry (when several SVGs live in one HTML document) */
  ids?: NameRegistry;
  /** coordinate precision for path data */
  precision?: number;
}

/* ---------------------------------------------------------------- renderer */

export class SvgRenderer {
  readonly defs: XEl[] = [];
  readonly ids: NameRegistry;
  usesXlink = false;
  private counters = new Map<string, number>();
  private clipCache = new Map<ID, string>();
  private dCache = new Map<ID, string>();
  private layerIds: boolean;
  private precision: number;

  constructor(
    readonly doc: Doc,
    opts: SvgRendererOptions = {},
  ) {
    this.ids = opts.ids ?? new NameRegistry('kebab');
    this.layerIds = opts.layerIds ?? true;
    this.precision = opts.precision ?? 2;
  }

  /** Unique id for a definition, e.g. `linear-0`. */
  defId(kind: string): string {
    let n = this.counters.get(kind) ?? 0;
    let id = `${kind}-${n}`;
    while (this.ids.has(id)) id = `${kind}-${++n}`;
    this.counters.set(kind, n + 1);
    this.ids.reserve(id);
    return id;
  }

  private href(url: string): Record<string, string> {
    this.usesXlink = true;
    return { 'xlink:href': url };
  }

  /* ----------------------------------------------------------- geometry */

  private pathData(n: SceneNode): string {
    let d = this.dCache.get(n.id);
    if (d === undefined) {
      const cmds = n.type === 'boolean' || n.type === 'group' ? geometryOf(this.doc, n) : nodeCmds(n);
      d = cmdsToSvgD(cmds, this.precision);
      this.dCache.set(n.id, d);
    }
    return d;
  }

  /** The node's outline as the simplest SVG primitive. */
  shape(n: SceneNode, extra: XEl['attrs'] = {}, rule: 'fill-rule' | 'clip-rule' = 'fill-rule'): XEl {
    const w = n.width;
    const h = n.height;
    if (n.type === 'text' || n.type === 'bitmap') return el('rect', { width: w, height: h, ...extra });
    if ((n.type === 'rect' || n.type === 'frame') && n.cornerSmoothing <= 0) {
      const r = uniformRadius(n);
      if (r !== null) return el('rect', { width: w, height: h, rx: r > 0 ? r : undefined, ...extra });
    }
    if (isPlainEllipse(n)) {
      if (near(w, h, 1e-3)) return el('circle', { cx: w / 2, cy: h / 2, r: w / 2, ...extra });
      return el('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...extra });
    }
    const evenodd = (n.type === 'path' && n.fillRule === 'evenodd') || n.type === 'boolean';
    return el('path', { d: this.pathData(n), [rule]: evenodd ? 'evenodd' : undefined, ...extra });
  }

  /** clipPath with the node's own outline (cached). */
  clipFor(n: SceneNode): string {
    const hit = this.clipCache.get(n.id);
    if (hit) return hit;
    const id = this.defId('clip');
    this.defs.push(el('clipPath', { id }, [this.shape(n, {}, 'clip-rule')]));
    this.clipCache.set(n.id, id);
    return id;
  }

  /* --------------------------------------------------------------- paints */

  private stops(p: GradientPaint, maskMode: boolean): XEl[] {
    return sortedStops(p).map((s) =>
      el('stop', {
        offset: r2(Math.max(0, Math.min(1, s.offset)), 4),
        'stop-color': maskMode ? '#fff' : cssColor(s.color),
        'stop-opacity': opacityAttr(s.opacity),
      }),
    );
  }

  /** Resolve a paint to a fill / stroke value (adding defs as needed). */
  paint(p: Paint, n: SceneNode, maskMode = false): PaintRef | null {
    const w = Math.max(n.width, 0.01);
    const h = Math.max(n.height, 0.01);
    switch (p.type) {
      case 'solid':
        return { value: maskMode ? '#fff' : cssColor(p.color), opacity: p.opacity };
      case 'linear':
      case 'radial':
      case 'angular':
      case 'diamond':
        return this.gradient(p, w, h, maskMode);
      case 'image':
        return this.imagePaint(p, w, h);
      case 'pattern':
        return this.patternPaint(p, maskMode);
      case 'noise':
        return this.noisePaint(p, n, maskMode);
    }
  }

  private gradient(p: GradientPaint, w: number, h: number, maskMode: boolean): PaintRef {
    const g = gradientGeom(p, w, h);
    const stops = sortedStops(p);
    if (g.length < 1e-6 || (p.type !== 'linear' && p.type !== 'angular' && g.radius < 1e-6)) {
      const last = stops[stops.length - 1];
      return { value: maskMode ? '#fff' : cssColor(last.color), opacity: p.opacity * last.opacity };
    }
    if (p.type === 'linear') {
      const id = this.defId('linear');
      this.defs.push(
        el('linearGradient', { id, x1: g.from.x, y1: g.from.y, x2: g.to.x, y2: g.to.y, gradientUnits: 'userSpaceOnUse' }, this.stops(p, maskMode)),
      );
      return { value: `url(#${id})`, opacity: p.opacity };
    }
    if (p.type === 'radial') {
      // elliptical in box space: unit circle scaled by the box
      const id = this.defId('radial');
      const transform = `matrix(${num(g.rx, 4)} 0 0 ${num(g.ry, 4)} ${num(g.from.x)} ${num(g.from.y)})`;
      this.defs.push(el('radialGradient', { id, cx: 0, cy: 0, r: 1, gradientUnits: 'userSpaceOnUse', gradientTransform: transform }, this.stops(p, maskMode)));
      return { value: `url(#${id})`, opacity: p.opacity };
    }
    // Conic & diamond gradients have no SVG equivalent: approximate them with a
    // pattern tile larger than the node so strokes are covered too.
    const id = this.defId(p.type);
    const content = p.type === 'angular' ? this.conicWedges(p, g, w, h, maskMode) : this.diamondQuads(p, g, w, h, maskMode);
    this.defs.push(
      el('pattern', { id, patternUnits: 'userSpaceOnUse', x: -w, y: -h, width: w * 3, height: h * 3 }, [
        el('g', { transform: `translate(${num(w)} ${num(h)})` }, content),
      ]),
    );
    return { value: `url(#${id})`, opacity: p.opacity };
  }

  /** Conic gradient as thin solid wedges around the centre. */
  private conicWedges(p: GradientPaint, g: ReturnType<typeof gradientGeom>, w: number, h: number, maskMode: boolean): XEl[] {
    const stops = sortedStops(p);
    const N = 90;
    const R = Math.hypot(w * 3, h * 3);
    const out: XEl[] = [];
    const c = g.from;
    const eps = (0.6 * Math.PI) / 180;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      const a0 = g.angle + (i / N) * Math.PI * 2 - (i ? eps : 0);
      const a1 = g.angle + ((i + 1) / N) * Math.PI * 2 + eps;
      const s = sampleStops(stops, t);
      out.push(
        el('path', {
          d: `M${num(c.x)} ${num(c.y)}L${num(c.x + Math.cos(a0) * R)} ${num(c.y + Math.sin(a0) * R)}L${num(c.x + Math.cos(a1) * R)} ${num(c.y + Math.sin(a1) * R)}Z`,
          fill: maskMode ? '#fff' : cssColor(s.color),
          'fill-opacity': opacityAttr(s.opacity),
        }),
      );
    }
    return out;
  }

  /** Diamond gradient: t = |u| + |v| is linear in each quadrant of gradient space. */
  private diamondQuads(p: GradientPaint, g: ReturnType<typeof gradientGeom>, w: number, h: number, maskMode: boolean): XEl[] {
    // gradient space → local px: scale(w, h) · translate(from) · rotate(handle) · scale(radius), in box units
    const dxn = p.to.x - p.from.x;
    const dyn = p.to.y - p.from.y;
    const m = [w * dxn, h * dyn, -w * dyn, h * dxn, g.from.x, g.from.y];
    const K = Math.hypot(w * 3, h * 3) / Math.max(1e-6, Math.min(g.rx, g.ry)) + 1;
    const quads: XEl[] = [];
    for (const [su, sv] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const gid = this.defId('diamond-q');
      this.defs.push(el('linearGradient', { id: gid, x1: 0, y1: 0, x2: su * 0.5, y2: sv * 0.5, gradientUnits: 'userSpaceOnUse' }, this.stops(p, maskMode)));
      quads.push(el('path', { d: `M0 0H${num(su * K)}V${num(sv * K)}H0Z`, fill: `url(#${gid})` }));
    }
    return [el('g', { transform: `matrix(${m.map((v) => num(v, 4)).join(' ')})` }, quads)];
  }

  private imagePaint(p: ImagePaint, w: number, h: number): PaintRef | null {
    const asset = this.doc.assets[p.assetId];
    if (!asset) return null;
    const id = this.defId('image');
    const filter = this.imageFilter(p.filters);
    if (p.fit === 'tile') {
      const size = assetSize(this.doc, p.assetId) ?? { width: w, height: h };
      const s = p.scale > 0 ? p.scale : 1;
      const tw = Math.max(1, size.width * s);
      const th = Math.max(1, size.height * s);
      this.defs.push(
        el('pattern', { id, patternUnits: 'userSpaceOnUse', width: tw, height: th, patternTransform: p.rotation ? `rotate(${num(p.rotation)})` : undefined }, [
          el('image', { width: tw, height: th, preserveAspectRatio: 'none', filter, ...this.href(asset.data) }),
        ]),
      );
      return { value: `url(#${id})`, opacity: p.opacity };
    }
    const rot = ((p.rotation % 360) + 360) % 360;
    const rad = (rot * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    const iw = w * c + h * s;
    const ih = w * s + h * c;
    const par = p.fit === 'stretch' ? 'none' : p.fit === 'fit' ? 'xMidYMid meet' : 'xMidYMid slice';
    this.defs.push(
      el('pattern', { id, patternUnits: 'userSpaceOnUse', width: w, height: h }, [
        el('image', {
          x: rot ? (w - iw) / 2 : undefined,
          y: rot ? (h - ih) / 2 : undefined,
          width: iw,
          height: ih,
          preserveAspectRatio: par,
          transform: rot ? `rotate(${num(rot)} ${num(w / 2)} ${num(h / 2)})` : undefined,
          filter,
          ...this.href(asset.data),
        }),
      ]),
    );
    return { value: `url(#${id})`, opacity: p.opacity };
  }

  /** Photo adjustments of an image paint as an SVG filter. */
  private imageFilter(f?: Partial<ImageFilters>): string | undefined {
    if (!f) return undefined;
    const v = (k: keyof ImageFilters) => Math.max(-1, Math.min(1, f[k] ?? 0));
    const [exp, con, sat, temp, tint, hi, sh] = [v('exposure'), v('contrast'), v('saturation'), v('temperature'), v('tint'), v('highlights'), v('shadows')];
    if (![exp, con, sat, temp, tint, hi, sh].some((x) => Math.abs(x) > 1e-3)) return undefined;
    const prims: XEl[] = [];
    if (exp || con) {
      const slope = Math.pow(2, exp) * (1 + con);
      const intercept = 0.5 - 0.5 * (1 + con);
      const fn = (tag: string) => el(tag, { type: 'linear', slope: r2(slope, 4), intercept: r2(intercept, 4) });
      prims.push(el('feComponentTransfer', {}, [fn('feFuncR'), fn('feFuncG'), fn('feFuncB')]));
    }
    if (hi || sh) {
      const table = [0 + sh * 0.15, 0.25 + sh * 0.1, 0.5, 0.75 + hi * 0.1, 1 + hi * 0.15].map((x) => num(Math.max(0, Math.min(1, x)), 3)).join(' ');
      const fn = (tag: string) => el(tag, { type: 'table', tableValues: table });
      prims.push(el('feComponentTransfer', {}, [fn('feFuncR'), fn('feFuncG'), fn('feFuncB')]));
    }
    if (sat) prims.push(el('feColorMatrix', { type: 'saturate', values: r2(Math.max(0, 1 + sat), 3) }));
    if (temp || tint) {
      const rr = 0.1 * temp + 0.05 * tint;
      const gg = -0.1 * tint;
      const bb = -0.1 * temp + 0.05 * tint;
      prims.push(el('feColorMatrix', { type: 'matrix', values: `1 0 0 0 ${num(rr, 3)} 0 1 0 0 ${num(gg, 3)} 0 0 1 0 ${num(bb, 3)} 0 0 0 1 0` }));
    }
    const id = this.defId('adjust');
    this.defs.push(el('filter', { id, 'color-interpolation-filters': 'sRGB' }, prims));
    return `url(#${id})`;
  }

  private patternPaint(p: PatternPaint, maskMode: boolean): PaintRef {
    const id = this.defId('pattern');
    const tile = patternTile(p, maskMode);
    this.defs.push(
      el(
        'pattern',
        { id, patternUnits: 'userSpaceOnUse', width: tile.width, height: tile.height, patternTransform: p.rotation ? `rotate(${num(p.rotation)})` : undefined },
        tile.children,
      ),
    );
    return { value: `url(#${id})`, opacity: p.opacity };
  }

  private noisePaint(p: NoisePaint, n: SceneNode, maskMode: boolean): PaintRef {
    const id = this.defId('noise');
    const pad = n.strokeWidth * 2 + 2;
    const tau = 0.75 - 0.5 * Math.max(0, Math.min(1, p.density));
    const A = 14;
    this.defs.push(
      el('filter', { id, filterUnits: 'userSpaceOnUse', x: -pad, y: -pad, width: n.width + pad * 2, height: n.height + pad * 2, 'color-interpolation-filters': 'sRGB' }, [
        el('feTurbulence', { type: 'fractalNoise', baseFrequency: r2(0.7 / Math.max(0.25, p.size), 4), numOctaves: 1, seed: Math.round(p.seed) || 0, stitchTiles: 'stitch', result: 'noise' }),
        el('feColorMatrix', { in: 'noise', type: 'matrix', values: `0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${A} 0 0 0 ${num(-A * tau, 3)}`, result: 'grain' }),
        el('feComposite', { in: 'SourceGraphic', in2: 'grain', operator: 'in' }),
      ]),
    );
    return {
      value: maskMode ? '#fff' : cssColor(p.color),
      opacity: p.opacity,
      filter: `url(#${id})`,
      background: p.background ? (maskMode ? '#fff' : cssColor(p.background)) : undefined,
    };
  }

  /* --------------------------------------------------------- fill / stroke */

  private fillEls(n: SceneNode, maskMode: boolean): XEl[] {
    const out: XEl[] = [];
    for (const p of visiblePaints(n.fills)) {
      const ref = this.paint(p, n, maskMode);
      if (!ref) continue;
      if (ref.background) out.push(this.shape(n, { fill: ref.background, 'fill-opacity': opacityAttr(ref.opacity), style: blendStyle(p.blendMode) }));
      out.push(this.shape(n, { fill: ref.value, 'fill-opacity': opacityAttr(ref.opacity), filter: ref.filter, style: blendStyle(p.blendMode) }));
    }
    return out;
  }

  private strokeAttrs(n: SceneNode, width: number, ref?: PaintRef): XEl['attrs'] {
    return {
      fill: 'none',
      stroke: ref?.value,
      'stroke-opacity': ref ? opacityAttr(ref.opacity) : undefined,
      'stroke-width': r2(width, 3),
      'stroke-linecap': n.strokeCap !== 'butt' ? n.strokeCap : undefined,
      'stroke-linejoin': n.strokeJoin !== 'miter' ? n.strokeJoin : undefined,
      'stroke-dasharray': n.dash.length && n.dash.some((d) => d > 0) ? n.dash.map((d) => num(d)).join(' ') : undefined,
    };
  }

  private strokeEls(n: SceneNode, maskMode: boolean): XEl[] {
    const paints = visiblePaints(n.strokes);
    if (!paints.length || n.strokeWidth <= 0) return [];
    const align = isClosedShape(n) ? n.strokeAlign : 'center';
    const width = align === 'center' ? n.strokeWidth : n.strokeWidth * 2;
    const els: XEl[] = [];
    const refs: PaintRef[] = [];
    for (const p of paints) {
      const ref = this.paint(p, n, maskMode);
      if (!ref) continue;
      refs.push(ref);
      els.push(this.shape(n, { ...this.strokeAttrs(n, width, ref), filter: ref.filter, style: blendStyle(p.blendMode) }));
    }
    if (!els.length) return [];
    const out: XEl[] = [];
    if (align === 'inside') out.push(el('g', { 'clip-path': `url(#${this.clipFor(n)})` }, els));
    else if (align === 'outside') out.push(el('g', { mask: `url(#${this.outsideMask(n)})` }, els));
    else out.push(...els);
    if (n.type === 'path' && refs.length) out.push(...this.markerEls(n, refs[refs.length - 1]));
    return out;
  }

  /** Mask that hides everything inside the node's outline (outside strokes). */
  private outsideMask(n: SceneNode): string {
    const id = this.defId('outside');
    const r = expand({ x: 0, y: 0, width: n.width, height: n.height }, n.strokeWidth * 2 + 2);
    this.defs.push(
      el('mask', { id, maskUnits: 'userSpaceOnUse', x: r.x, y: r.y, width: r.width, height: r.height }, [
        el('rect', { x: r.x, y: r.y, width: r.width, height: r.height, fill: '#fff' }),
        this.shape(n, { fill: '#000' }),
      ]),
    );
    return id;
  }

  private markerEls(n: PathNode, ref: PaintRef): XEl[] {
    const out: XEl[] = [];
    const open = n.paths.filter((p) => !p.closed && p.points.length >= 2);
    if (!open.length) return out;
    const add = (marker: PathNode['startMarker'], at: Vec, dir: Vec) => {
      if (marker === 'none') return;
      const { cmds, filled } = markerCmds(marker, at, Math.atan2(dir.y, dir.x), n.strokeWidth);
      if (!cmds.length) return;
      const d = cmdsToSvgD(cmds, this.precision);
      out.push(
        filled
          ? el('path', { d, fill: ref.value, 'fill-opacity': opacityAttr(ref.opacity) })
          : el('path', { d, fill: 'none', stroke: ref.value, 'stroke-opacity': opacityAttr(ref.opacity), 'stroke-width': r2(n.strokeWidth, 3), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
    };
    const first = open[0].points;
    const p0 = first[0];
    const p1 = first[1];
    const startFrom = p0.out ?? p1.in ?? p1;
    add(n.startMarker, p0, { x: p0.x - startFrom.x, y: p0.y - startFrom.y });
    const last = open[open.length - 1].points;
    const pn = last[last.length - 1];
    const pm = last[last.length - 2];
    const endFrom = pn.in ?? pm.out ?? pm;
    add(n.endMarker, pn, { x: pn.x - endFrom.x, y: pn.y - endFrom.y });
    return out;
  }

  /* ------------------------------------------------------------- effects */

  /** Build the effect filter of a node; returns its id or null. */
  private effectFilter(n: SceneNode): string | null {
    const fx = visibleEffects(n.effects).filter((e) => e.type !== 'background-blur');
    if (!fx.length) return null;
    const region = expand(localVisualBounds(this.doc, n, false), effectOutset(n) + 4);
    const prims: XEl[] = [];
    const below: string[] = [];
    const above: string[] = [];
    let k = 0;
    for (const e of fx) {
      if (e.type === 'drop-shadow' || e.type === 'glow' || e.type === 'inner-shadow') {
        const inner = e.type === 'inner-shadow';
        const dx = e.type === 'glow' ? 0 : e.x;
        const dy = e.type === 'glow' ? 0 : e.y;
        let src = 'SourceAlpha';
        if (e.spread) {
          const grow = inner ? e.spread < 0 : e.spread > 0;
          prims.push(el('feMorphology', { in: src, operator: grow ? 'dilate' : 'erode', radius: r2(Math.abs(e.spread)), result: `spread${k}` }));
          src = `spread${k}`;
        }
        if (dx || dy) {
          prims.push(el('feOffset', { in: src, dx: r2(dx), dy: r2(dy), result: `offset${k}` }));
          src = `offset${k}`;
        }
        if (e.blur > 0) {
          prims.push(el('feGaussianBlur', { in: src, stdDeviation: r2(e.blur / 2), result: `blur${k}` }));
          src = `blur${k}`;
        }
        if (inner) {
          prims.push(el('feComposite', { in: 'SourceAlpha', in2: src, operator: 'out', result: `cut${k}` }));
          src = `cut${k}`;
        }
        prims.push(el('feFlood', { 'flood-color': cssColor(e.color), 'flood-opacity': opacityAttr(e.opacity), result: `color${k}` }));
        prims.push(el('feComposite', { in: `color${k}`, in2: src, operator: 'in', result: `${inner ? 'inner' : 'shadow'}${k}` }));
        (inner ? above : below).push(`${inner ? 'inner' : 'shadow'}${k}`);
        k++;
      }
    }
    let result = 'SourceGraphic';
    if (below.length || above.length) {
      prims.push(el('feMerge', { result: 'composite' }, [...below, 'SourceGraphic', ...above].map((i) => el('feMergeNode', { in: i }))));
      result = 'composite';
    }
    for (const e of fx) {
      if (e.type === 'noise') {
        prims.push(el('feTurbulence', { type: 'fractalNoise', baseFrequency: r2(0.7 / Math.max(0.25, e.size), 4), numOctaves: 2, seed: k, stitchTiles: 'stitch', result: `grain${k}` }));
        let grain = `grain${k}`;
        if (e.monochrome) {
          prims.push(el('feColorMatrix', { in: grain, type: 'saturate', values: 0, result: `mono${k}` }));
          grain = `mono${k}`;
        }
        const amt = Math.max(0, Math.min(1, e.amount));
        prims.push(el('feComposite', { in: grain, in2: result, operator: 'arithmetic', k1: 0, k2: r2(amt, 3), k3: 1, k4: r2(-amt / 2, 3), result: `noisy${k}` }));
        prims.push(el('feComposite', { in: `noisy${k}`, in2: result, operator: 'in', result: `noise${k}` }));
        result = `noise${k}`;
        k++;
      } else if (e.type === 'adjust') {
        const out = adjustPrimitives(e, result, `adjust${k}`);
        if (out.prims.length) {
          prims.push(...out.prims);
          result = out.result;
        }
        k++;
      }
    }
    for (const e of fx) {
      if (e.type === 'layer-blur' && e.radius > 0) {
        prims.push(el('feGaussianBlur', { in: result, stdDeviation: r2(e.radius / 2), result: `layerBlur${k}` }));
        result = `layerBlur${k}`;
        k++;
      }
    }
    if (!prims.length) return null;
    const id = this.defId('filter');
    this.defs.push(
      el(
        'filter',
        { id, filterUnits: 'userSpaceOnUse', x: region.x, y: region.y, width: region.width, height: region.height, 'color-interpolation-filters': 'sRGB' },
        prims,
      ),
    );
    return id;
  }

  /* ---------------------------------------------------------------- text */

  private textEls(n: TextNode, maskMode: boolean): XEl[] {
    const layout = layoutText(n);
    const anchor = n.textAlign === 'center' ? 'middle' : n.textAlign === 'right' ? 'end' : undefined;
    const lineX = (x: number) => (n.textAlign === 'center' ? n.width / 2 : n.textAlign === 'right' ? n.width : x);
    const spans = () =>
      layout.lines
        .filter((l) => l.text.length)
        .map((l) => el('tspan', { x: r2(lineX(l.x)), y: r2(l.baseline), 'word-spacing': l.wordSpacing ? r2(l.wordSpacing) : undefined }, [l.text]));
    if (!layout.lines.some((l) => l.text.length)) return [];
    const base: XEl['attrs'] = {
      'xml:space': 'preserve',
      'font-family': fontStack(n.fontFamily, "'"),
      'font-size': r2(n.fontSize),
      'font-weight': n.fontWeight !== 400 ? n.fontWeight : undefined,
      'font-style': n.italic ? 'italic' : undefined,
      'letter-spacing': n.letterSpacing ? r2(n.letterSpacing) : undefined,
      'text-decoration': n.textDecoration === 'underline' ? 'underline' : n.textDecoration === 'strikethrough' ? 'line-through' : undefined,
      'text-anchor': anchor,
    };
    const text = (attrs: XEl['attrs']): XEl => ({ ...el('text', { ...base, ...attrs }, spans()), inline: true });
    const fills: XEl[] = [];
    for (const p of visiblePaints(n.fills)) {
      const ref = this.paint(p, n, maskMode);
      if (ref) fills.push(text({ fill: ref.value, 'fill-opacity': opacityAttr(ref.opacity), filter: ref.filter, style: blendStyle(p.blendMode) }));
    }
    // outside strokes sit behind the fill at double width; inside / centre strokes are drawn on top
    const outside = n.strokeAlign === 'outside';
    const strokes: XEl[] = [];
    if (n.strokeWidth > 0) {
      for (const p of visiblePaints(n.strokes)) {
        const ref = this.paint(p, n, maskMode);
        if (ref) strokes.push(text({ ...this.strokeAttrs(n, outside ? n.strokeWidth * 2 : n.strokeWidth, ref), 'stroke-linejoin': 'round', 'text-decoration': undefined }));
      }
    }
    return outside ? [...strokes, ...fills] : [...fills, ...strokes];
  }

  /* ---------------------------------------------------------------- nodes */

  private layerId(n: SceneNode): string {
    return this.ids.get(n.name, n.type);
  }

  /** Give an element an id so it can be referenced by <use>. */
  ensureId(e: XEl): string {
    if (!e.attrs.id) e.attrs.id = this.defId('layer');
    return String(e.attrs.id);
  }

  /** Render a node (and its subtree) into a <g>. `m` is its transform in the current user space. */
  node(n: SceneNode, m: Mat | null, opt: RenderOpts = {}): XEl | null {
    if (!n.visible && !opt.force) return null;
    const maskMode = !!opt.maskMode;
    const body: XEl[] = [];
    switch (n.type) {
      case 'frame': {
        body.push(...this.fillEls(n, maskMode));
        const kids = this.children(n.children, maskMode);
        if (kids.length) {
          if (n.clipContent) body.push(el('g', { 'clip-path': `url(#${this.clipFor(n)})` }, kids));
          else body.push(...kids);
        }
        body.push(...this.strokeEls(n, maskMode));
        break;
      }
      case 'group':
        body.push(...this.children(n.children, maskMode));
        break;
      case 'text':
        body.push(...this.textEls(n, maskMode));
        break;
      case 'bitmap': {
        const asset = this.doc.assets[n.assetId];
        if (asset)
          body.push(
            el('image', {
              width: n.width,
              height: n.height,
              preserveAspectRatio: 'none',
              'image-rendering': n.smoothing ? undefined : 'optimizeSpeed',
              style: n.smoothing ? undefined : 'image-rendering:pixelated',
              ...this.href(asset.data),
            }),
          );
        body.push(...this.strokeEls(n, maskMode));
        break;
      }
      default:
        body.push(...this.fillEls(n, maskMode));
        body.push(...this.strokeEls(n, maskMode));
    }
    if (!body.length) return null;
    const filter = this.effectFilter(n);
    const g = el(
      'g',
      {
        id: this.layerIds && !opt.noId && !maskMode ? this.layerId(n) : undefined,
        transform: m ? svgTransform(m) : undefined,
        opacity: opacityAttr(n.opacity),
        filter: filter ? `url(#${filter})` : undefined,
        style: opt.omitBlend ? undefined : blendStyle(n.blendMode),
      },
      body,
    );
    return compact(g);
  }

  /** Render a sibling list, handling masks and background blur. */
  children(ids: ID[], maskMode = false): XEl[] {
    const out: XEl[] = [];
    let target = out;
    let maskGroup: XEl | null = null;
    const maskGroups = new Set<XEl>();
    for (const id of ids) {
      const k = this.doc.nodes[id];
      if (!k || !k.visible) continue;
      const m = localMatrix(k);
      if (k.isMask) {
        // a mask clips every sibling above it (later masks nest inside); its
        // alpha is the mask and its opacity applies to the masked result
        const content = this.node({ ...k, opacity: 1 } as SceneNode, m, { maskMode: true, noId: true });
        if (!content) continue;
        const mid = this.defId('mask');
        const region = transformRect(m, localVisualBounds(this.doc, k, true));
        this.defs.push(
          el('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: region.x, y: region.y, width: region.width, height: region.height, style: 'mask-type:alpha' }, [content]),
        );
        maskGroup = el('g', { id: this.layerIds ? this.ids.get(`${k.name} mask group`) : undefined, mask: `url(#${mid})`, opacity: opacityAttr(k.opacity) });
        target.push(maskGroup);
        maskGroups.add(maskGroup);
        target = maskGroup.children as XEl[];
        continue;
      }
      const blur = maskMode ? undefined : visibleEffects(k.effects).find((e) => e.type === 'background-blur');
      if (blur && blur.type === 'background-blur' && blur.radius > 0) {
        // everything painted so far (mask groups are ancestors of `target`, so use their contents)
        const prev = paintedBefore(out, maskGroups);
        const backdrop = this.backdrop(k, m, prev, blur.radius);
        if (backdrop) target.push(backdrop);
      }
      const r = this.node(k, m, { maskMode });
      if (r) target.push(r);
    }
    return pruneEmpty(out, maskGroups);
  }

  /** Best-effort background blur: blurred copies of the siblings below, clipped to the node. */
  private backdrop(k: SceneNode, m: Mat, prev: XEl[], radius: number): XEl | null {
    if (!prev.length) return null;
    const clip = this.defId('backdrop-clip');
    this.defs.push(el('clipPath', { id: clip }, [this.shape(k, { transform: svgTransform(m) }, 'clip-rule')]));
    const region = expand(transformRect(m, { x: 0, y: 0, width: k.width, height: k.height }), radius * 1.5 + 2);
    const fid = this.defId('backdrop-blur');
    this.defs.push(
      el('filter', { id: fid, filterUnits: 'userSpaceOnUse', x: region.x, y: region.y, width: region.width, height: region.height, 'color-interpolation-filters': 'sRGB' }, [
        el('feGaussianBlur', { stdDeviation: r2(radius / 2), edgeMode: 'duplicate' }),
      ]),
    );
    const refs = prev.map((e) => el('use', this.href(`#${this.ensureId(e)}`)));
    return el('g', { 'clip-path': `url(#${clip})` }, [el('g', { filter: `url(#${fid})` }, refs)]);
  }
}

/** Sibling elements in paint order, looking through (nested) mask groups. */
function paintedBefore(list: (XEl | string)[], groups: Set<XEl>): XEl[] {
  const out: XEl[] = [];
  for (const e of list) {
    if (typeof e === 'string') continue;
    if (groups.has(e)) out.push(...paintedBefore(e.children, groups));
    else out.push(e);
  }
  return out;
}

function pruneEmpty(list: XEl[], groups: Set<XEl>): XEl[] {
  return list.filter((e) => {
    if (!groups.has(e)) return true;
    e.children = pruneEmpty(e.children.filter((c): c is XEl => typeof c !== 'string'), groups);
    return e.children.length > 0;
  });
}

/** Merge a <g> with a single child element when that is lossless. */
function compact(g: XEl): XEl {
  if (g.children.length !== 1 || typeof g.children[0] === 'string') return g;
  const child = g.children[0];
  const keys = ['id', 'transform', 'opacity', 'filter', 'style', 'mask', 'clip-path'];
  const gKeys = keys.filter((k) => g.attrs[k] !== undefined);
  if (!gKeys.length) return child;
  if (child.tag === 'text' && g.attrs.filter) return g;
  if (gKeys.some((k) => child.attrs[k] !== undefined)) return g;
  if (g.attrs.filter && (child.attrs['clip-path'] || child.attrs.mask || child.attrs.style)) return g;
  if (child.attrs.style) return g;
  const attrs: XEl['attrs'] = {};
  for (const k of gKeys) attrs[k] = g.attrs[k];
  return { ...child, attrs: { ...attrs, ...child.attrs } };
}

/** Colour-adjust effect as filter primitives. */
function adjustPrimitives(e: AdjustEffect, input: string, prefix: string): { prims: XEl[]; result: string } {
  const prims: XEl[] = [];
  let cur = input;
  let i = 0;
  const next = () => `${prefix}-${i++}`;
  if (e.brightness || e.contrast) {
    const slope = (1 + e.brightness) * (1 + e.contrast);
    const intercept = 0.5 - 0.5 * (1 + e.contrast);
    const fn = (tag: string) => el(tag, { type: 'linear', slope: r2(slope, 4), intercept: r2(intercept, 4) });
    const r = next();
    prims.push(el('feComponentTransfer', { in: cur, result: r }, [fn('feFuncR'), fn('feFuncG'), fn('feFuncB')]));
    cur = r;
  }
  const sat = Math.max(0, (1 + e.saturation) * (1 - Math.max(0, Math.min(1, e.grayscale))));
  if (Math.abs(sat - 1) > 1e-3) {
    const r = next();
    prims.push(el('feColorMatrix', { in: cur, type: 'saturate', values: r2(sat, 3), result: r }));
    cur = r;
  }
  if (e.hue) {
    const r = next();
    prims.push(el('feColorMatrix', { in: cur, type: 'hueRotate', values: r2(e.hue), result: r }));
    cur = r;
  }
  if (e.sepia > 0) {
    const s = Math.min(1, e.sepia);
    const S = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const M = S.map((v, j) => I[j] + (v - I[j]) * s);
    const r = next();
    prims.push(
      el('feColorMatrix', {
        in: cur,
        type: 'matrix',
        values: `${M.slice(0, 3).map((v) => num(v, 3)).join(' ')} 0 0 ${M.slice(3, 6).map((v) => num(v, 3)).join(' ')} 0 0 ${M.slice(6, 9).map((v) => num(v, 3)).join(' ')} 0 0 0 0 0 1 0`,
        result: r,
      }),
    );
    cur = r;
  }
  if (e.invert > 0) {
    const v = Math.min(1, e.invert);
    const fn = (tag: string) => el(tag, { type: 'table', tableValues: `${num(v, 3)} ${num(1 - v, 3)}` });
    const r = next();
    prims.push(el('feComponentTransfer', { in: cur, result: r }, [fn('feFuncR'), fn('feFuncG'), fn('feFuncB')]));
    cur = r;
  }
  return { prims, result: cur };
}

/* --------------------------------------------------------------- patterns */

/**
 * One tile of a pattern paint (also used for CSS backgrounds). Geometry
 * mirrors the canvas renderer: drawn in a 64-unit tile scaled to `scale` px.
 */
export function patternTile(p: PatternPaint, maskMode = false): { width: number; height: number; children: XEl[] } {
  const T = 64;
  const size = Math.max(1, p.scale || 16);
  const wt = Math.max(0.05, Math.min(1, p.weight ?? 0.3));
  const lw = Math.max(1, wt * 16);
  const color = maskMode ? '#fff' : cssColor(p.color);
  const shapes: XEl[] = [];
  const line = (d: string, extra: XEl['attrs'] = {}) =>
    el('path', { d, fill: 'none', stroke: color, 'stroke-width': r2(lw, 3), 'stroke-linecap': 'square', ...extra });
  const rect = (x: number, y: number, w: number, h: number) => el('rect', { x: r2(x), y: r2(y), width: r2(w), height: r2(h), fill: color });
  switch (p.pattern) {
    case 'dots':
      shapes.push(el('circle', { cx: T / 2, cy: T / 2, r: r2(Math.max(1.5, wt * 20)), fill: color }));
      break;
    case 'grid':
      shapes.push(rect(0, 0, T, lw / 2), rect(0, T - lw / 2, T, lw / 2), rect(0, 0, lw / 2, T), rect(T - lw / 2, 0, lw / 2, T));
      break;
    case 'lines':
      shapes.push(rect(0, T / 2 - lw / 2, T, lw));
      break;
    case 'diagonal':
      shapes.push(line('M-8 72L72 -8M-8 8L8 -8M56 72L72 56'));
      break;
    case 'checker':
      shapes.push(rect(0, 0, T / 2, T / 2), rect(T / 2, T / 2, T / 2, T / 2));
      break;
    case 'cross':
      shapes.push(rect(T / 2 - lw / 2, T / 4, lw, T / 2), rect(T / 4, T / 2 - lw / 2, T / 2, lw));
      break;
    case 'waves':
      shapes.push(line('M0 32C16 16 16 16 32 32C48 48 48 48 64 32', { 'stroke-linecap': 'round' }));
      break;
    case 'zigzag':
      shapes.push(line('M0 42L32 22L64 42'));
      break;
    case 'triangles':
      shapes.push(el('path', { d: 'M32 12.8L51.2 48L12.8 48Z', fill: color }));
      break;
    case 'hexagons': {
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        return `${num(T / 2 + Math.cos(a) * T * 0.38)} ${num(T / 2 + Math.sin(a) * T * 0.38)}`;
      });
      shapes.push(line(`M${pts.join('L')}Z`, { 'stroke-width': r2(Math.max(1, wt * 6), 3), 'stroke-linecap': undefined }));
      break;
    }
  }
  const bg = p.background ? [el('rect', { width: T, height: T, fill: maskMode ? '#fff' : cssColor(p.background) })] : [];
  const k = size / T;
  return { width: r2(size), height: r2(size), children: [el('g', { transform: `scale(${num(k, 5)})` }, [...bg, ...shapes])] };
}

/** Standalone SVG string of one pattern tile (CSS `background-image`). */
export function patternTileSvg(p: PatternPaint): string {
  const tile = patternTile(p);
  return serializeXml(el('svg', { xmlns: 'http://www.w3.org/2000/svg', width: tile.width, height: tile.height, viewBox: `0 0 ${tile.width} ${tile.height}` }, tile.children), '', 0, true);
}

/* --------------------------------------------------------------- documents */

export interface SvgDocument {
  svg: string;
  width: number;
  height: number;
}

/**
 * Render nodes into one SVG document. The viewBox covers the nodes' visual
 * bounds (strokes and effects included) with the top-left at 0,0.
 */
export function buildSvg(doc: Doc, rootIds: ID[], opts: { layerIds?: boolean; ids?: NameRegistry } = {}): SvgDocument {
  const r = new SvgRenderer(doc, { layerIds: opts.layerIds ?? true, ids: opts.ids });
  let bounds = null as ReturnType<typeof union> | null;
  for (const id of rootIds) {
    const n = doc.nodes[id];
    if (!n) continue;
    bounds = union(bounds, transformRect(worldMatrix(doc, id), localVisualBounds(doc, n, true)));
  }
  const b = bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  // snap to whole pixels when we're within rounding noise
  const snap = (v: number) => (Math.abs(v - Math.round(v)) < 0.01 ? Math.round(v) : v);
  const box = { x: snap(b.x), y: snap(b.y), width: snap(b.width), height: snap(b.height) };
  const content: XEl[] = [];
  for (const id of rootIds) {
    const n = doc.nodes[id];
    if (!n) continue;
    const g = r.node(n, mul(translate(-box.x, -box.y), worldMatrix(doc, id)), { force: true });
    if (g) content.push(g);
  }
  const w = r2(box.width);
  const h = r2(box.height);
  const svg = el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      'xmlns:xlink': r.usesXlink ? 'http://www.w3.org/1999/xlink' : undefined,
      width: w,
      height: h,
      viewBox: `0 0 ${w} ${h}`,
      fill: 'none',
    },
    [r.defs.length ? el('defs', {}, r.defs) : null, ...content],
  );
  return { svg: serializeXml(svg) + '\n', width: w, height: h };
}

/**
 * Inline SVG element for a single node drawn in its own local box (no
 * transform / blend: the embedding page positions it). Used by HTML / React.
 */
export function nodeSvgElement(doc: Doc, n: SceneNode, ids: NameRegistry): XEl {
  const r = new SvgRenderer(doc, { layerIds: false, ids });
  const g = r.node(n, null, { force: true, omitBlend: true, noId: true });
  return el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      'xmlns:xlink': r.usesXlink ? 'http://www.w3.org/1999/xlink' : undefined,
      width: r2(n.width),
      height: r2(n.height),
      viewBox: `0 0 ${r2(n.width)} ${r2(n.height)}`,
      fill: 'none',
    },
    [r.defs.length ? el('defs', {}, r.defs) : null, g],
  );
}

/* --------------------------------------------------------------- exporter */

export const svgExporter: Exporter = {
  id: 'svg',
  label: 'SVG',
  group: 'Vector',
  extension: 'svg',
  description: 'Scalable vector graphics with gradients, masks, effects and live text.',
  textual: true,
  options: [
    { key: 'combine', label: 'Combine into one file', type: 'boolean', default: false },
    { key: 'layerIds', label: 'Include layer names as ids', type: 'boolean', default: true },
  ],
  async run(ctx: ExportContext): Promise<ExportFile[]> {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    if (!roots.length) return [];
    const layerIds = ctx.options.layerIds !== false;
    const names = new FileNamer();
    if (ctx.options.combine && roots.length > 1) {
      const page = ctx.doc.pages.find((p) => p.id === ctx.pageId);
      const { svg } = buildSvg(ctx.doc, roots, { layerIds });
      return [{ name: names.get(page?.name || ctx.doc.name, 'svg'), mime: MIME.svg, data: svg }];
    }
    return roots.map((id) => ({ name: names.get(ctx.doc.nodes[id].name, 'svg'), mime: MIME.svg, data: buildSvg(ctx.doc, [id], { layerIds }).svg }));
  },
};
