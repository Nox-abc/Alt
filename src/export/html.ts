/**
 * HTML / CSS exporter.
 *
 * The scene is first turned into a framework-neutral "web tree" (elements +
 * CSS declarations) that the React and Tailwind exporters reuse:
 *  - auto-layout frames → flexbox (gap, padding, align, justify, wrap, hug / fill)
 *  - everything else → absolutely positioned inside its parent
 *  - rect / frame / ellipse → <div> with backgrounds, radius, outline, shadows
 *  - text → real text with font CSS; vectors → inline SVG; bitmaps → <img>
 */
import type { Doc, Effect, FrameNode, ID, ImagePaint, Paint, SceneNode, TextNode } from '../core/types';
import { localMatrix } from '../core/geometry';
import { cmdsToSvgD, transformCmds } from '../core/path';
import { geometryOf } from '../core/boolean';
import type { ExportContext, ExportFile, Exporter } from './types';
import { nodeSvgElement, patternTileSvg } from './svg';
import {
  assetBaseName,
  assetSize,
  childNodes,
  cornerRadii,
  cssColor,
  cssGradient,
  dataUrlToBytes,
  extForMime,
  FileNamer,
  fontStack,
  isGradient,
  isPlainEllipse,
  isSystemFont,
  isVectorNode,
  MIME,
  NameRegistry,
  num,
  px,
  r2,
  resolveRoots,
  serializeXml,
  uniformRadius,
  visibleEffects,
  visiblePaints,
  xmlAttr,
  xmlEscape,
  type XEl,
} from './util';

/* ------------------------------------------------------------------ model */

/** A CSS declaration. A `/*` property is a comment. */
export type Decl = [prop: string, value: string];

export interface WebNode {
  /** scene node (null for synthetic wrappers such as mask groups) */
  node: SceneNode | null;
  kind: 'box' | 'text' | 'img' | 'svg';
  tag: string;
  /** unique kebab-case class derived from the layer name */
  className: string;
  css: Decl[];
  text?: string;
  /** image source (may contain an asset token) */
  src?: string;
  alt?: string;
  svg?: XEl;
  children: WebNode[];
}

export interface WebOptions {
  /** embed images as data URLs or write them as files */
  assets: 'inline' | 'files';
  /** folder for asset files */
  assetDir: string;
}

/** Asset references are written as tokens and resolved by each serializer. */
export const ASSET_TOKEN = /\{\{asset:([^}]+)\}\}/g;
const assetToken = (id: ID) => `{{asset:${id}}}`;

const RESERVED_CLASSES = ['root', 'container', 'flex', 'hidden', 'block', 'inline', 'absolute', 'relative', 'fixed', 'static', 'sticky', 'grid', 'table'];

type Mode = 'root' | 'flow' | 'absolute';

const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' };

/* ---------------------------------------------------------------- builder */

export class WebBuilder {
  readonly classes = new NameRegistry('kebab', RESERVED_CLASSES);
  /** ids used inside inline SVGs (shared so the page stays valid) */
  readonly svgIds = new NameRegistry('kebab');
  /** font family → set of "italic,weight" */
  readonly fonts = new Map<string, Set<string>>();
  /** referenced assets → suggested file name */
  readonly assets = new Map<ID, string>();
  private assetFiles = new FileNamer();

  constructor(
    readonly doc: Doc,
    readonly opts: WebOptions = { assets: 'inline', assetDir: 'assets' },
  ) {}

  build(rootId: ID): WebNode | null {
    const n = this.doc.nodes[rootId];
    if (!n) return null;
    return this.node(n, null, 'root', true);
  }

  /** Asset files referenced by the built trees (for `assets: 'files'`). */
  assetFilesOut(): ExportFile[] {
    const out: ExportFile[] = [];
    for (const [id, name] of this.assets) {
      const a = this.doc.assets[id];
      const decoded = a && dataUrlToBytes(a.data);
      if (decoded) out.push({ name: `${this.opts.assetDir}/${name}`, mime: decoded.mime, data: decoded.bytes });
    }
    return out;
  }

  /** Resolve an asset token to a data URL or relative file path. */
  resolveAsset(id: ID): string {
    if (this.opts.assets === 'files' && this.assets.has(id)) return `${this.opts.assetDir}/${this.assets.get(id)}`;
    return this.doc.assets[id]?.data ?? '';
  }

  private useAsset(id: ID): string {
    if (!this.assets.has(id)) {
      const a = this.doc.assets[id];
      const ext = extForMime(a?.mime ?? (a?.data.slice(5, a.data.indexOf(';')) || 'image/png'));
      const name = this.assetFiles.get(assetBaseName(this.doc, id), ext === 'bin' ? 'png' : ext);
      this.assets.set(id, name);
    }
    return assetToken(id);
  }

  private trackFont(n: TextNode) {
    const set = this.fonts.get(n.fontFamily) ?? new Set<string>();
    set.add(`${n.italic ? 1 : 0},${Math.round(n.fontWeight)}`);
    this.fonts.set(n.fontFamily, set);
  }

  /* ---------------------------------------------------------- tree walk */

  private node(n: SceneNode, parent: SceneNode | null, mode: Mode, force = false): WebNode | null {
    if (!n.visible && !force) return null;
    const className = this.classes.get(n.name, n.type);
    const css: Decl[] = [];
    let w: WebNode;

    if (n.type === 'text') {
      this.trackFont(n);
      css.push(...this.placement(n, parent, mode), ...this.transform(n, mode), ...this.textCss(n), ...this.effects(n, 'text'), ...this.layer(n));
      w = { node: n, kind: 'text', tag: 'p', className, css, text: n.text, children: [] };
    } else if (n.type === 'bitmap') {
      css.push(...this.placement(n, parent, mode), ...this.transform(n, mode));
      if (!n.smoothing) css.push(['image-rendering', 'pixelated']);
      css.push(...this.effects(n, 'img'), ...this.layer(n));
      w = { node: n, kind: 'img', tag: 'img', className, css, src: this.doc.assets[n.assetId] ? this.useAsset(n.assetId) : '', alt: n.name, children: [] };
    } else if (isVectorNode(n)) {
      css.push(...this.placement(n, parent, mode), ...this.transform(n, mode), ['overflow', 'visible']);
      if (n.blendMode !== 'normal') css.push(['mix-blend-mode', n.blendMode]);
      w = { node: n, kind: 'svg', tag: 'svg', className, css, svg: nodeSvgElement(this.doc, n, this.svgIds), children: [] };
    } else {
      // frame / group / rect / plain ellipse
      css.push(...this.placement(n, parent, mode));
      if (n.type === 'frame' && n.layout) css.push(...this.flex(n));
      css.push(...this.transform(n, mode));
      if (n.type !== 'group') css.push(...this.box(n));
      css.push(...this.effects(n, 'box'), ...this.layer(n));
      if (n.type === 'frame' && n.clipContent && n.children.length) css.push(['overflow', 'hidden']);
      w = { node: n, kind: 'box', tag: 'div', className, css, children: [] };
      if (n.type === 'frame' || n.type === 'group') w.children = this.children(n);
    }
    return w;
  }

  private children(p: SceneNode): WebNode[] {
    const out: WebNode[] = [];
    let target = out;
    let masked = false;
    for (const k of childNodes(this.doc, p)) {
      if (k.isMask) {
        // the mask's outline clips every sibling above it
        const d = cmdsToSvgD(transformCmds(geometryOf(this.doc, k), localMatrix(k)), 2);
        const rule = k.type === 'path' && k.fillRule === 'evenodd' ? 'evenodd, ' : '';
        const wrapper: WebNode = {
          node: null,
          kind: 'box',
          tag: 'div',
          className: this.classes.get(`${k.name} mask`),
          css: [
            ['position', 'absolute'],
            ['inset', '0'],
            ['clip-path', `path(${rule}'${d}')`],
          ],
          children: [],
        };
        out.push(wrapper);
        target = wrapper.children;
        masked = true;
        continue;
      }
      const flow = !masked && p.type === 'frame' && !!p.layout && k.layoutPositioning !== 'absolute';
      const c = this.node(k, p, flow ? 'flow' : 'absolute');
      if (c) target.push(c);
    }
    return out.filter((c) => c.node || c.children.length);
  }

  /* ---------------------------------------------------------- placement */

  /** Whether the node sizes to its content on an axis. */
  private hugs(n: SceneNode, axis: 'h' | 'v'): boolean {
    if (n.type === 'text') return axis === 'h' ? n.autoResize === 'width' : n.autoResize !== 'none';
    if (n.type === 'frame' && n.layout) return (axis === 'h' ? n.sizingH : n.sizingV) === 'hug';
    return false;
  }

  private placement(n: SceneNode, parent: SceneNode | null, mode: Mode): Decl[] {
    const d: Decl[] = [];
    if (mode === 'root') {
      d.push(['position', 'relative'], ['flex', 'none']);
      if (!this.hugs(n, 'h')) d.push(['width', px(n.width)]);
      if (!this.hugs(n, 'v')) d.push(['height', px(n.height)]);
      return d;
    }
    if (mode === 'absolute') {
      d.push(['position', 'absolute'], ['left', px(n.x)], ['top', px(n.y)]);
      if (!this.hugs(n, 'h')) d.push(['width', px(n.width)]);
      if (!this.hugs(n, 'v')) d.push(['height', px(n.height)]);
      return d;
    }
    // flow item of an auto-layout frame
    const L = (parent as FrameNode).layout!;
    const horiz = L.mode === 'horizontal';
    const mainAxis = horiz ? 'h' : 'v';
    const crossAxis = horiz ? 'v' : 'h';
    const sizing = (axis: 'h' | 'v') => (axis === 'h' ? n.sizingH : n.sizingV);
    const dim = (axis: 'h' | 'v') => (axis === 'h' ? 'width' : 'height');
    const val = (axis: 'h' | 'v') => px(axis === 'h' ? n.width : n.height);
    // containers anchor their absolutely positioned children
    if ((n.type === 'frame' || n.type === 'group') && n.children.length) d.push(['position', 'relative']);
    if (sizing(mainAxis) === 'fill' && !L.wrap) d.push(['flex', '1 1 0'], [`min-${dim(mainAxis)}`, '0']);
    else if (!this.hugs(n, mainAxis)) d.push([dim(mainAxis), val(mainAxis)], ['flex-shrink', '0']);
    if (sizing(crossAxis) === 'fill' || L.align === 'stretch') {
      if (L.align !== 'stretch') d.push(['align-self', 'stretch']);
    } else if (!this.hugs(n, crossAxis)) d.push([dim(crossAxis), val(crossAxis)]);
    return d;
  }

  private flex(f: FrameNode): Decl[] {
    const L = f.layout!;
    const d: Decl[] = [['display', 'flex']];
    if (L.mode === 'vertical') d.push(['flex-direction', 'column']);
    if (L.wrap && L.mode === 'horizontal') d.push(['flex-wrap', 'wrap'], ['align-content', 'flex-start']);
    if (L.justify !== 'start') d.push(['justify-content', JUSTIFY[L.justify]]);
    if (L.align !== 'stretch') d.push(['align-items', ALIGN[L.align]]);
    if (L.gap && L.justify !== 'space-between') d.push(['gap', px(L.gap)]);
    else if (L.gap && L.wrap) d.push(['row-gap', px(L.gap)]);
    const [t, r, b, l] = L.padding;
    if (t || r || b || l) d.push(['padding', paddingValue(t, r, b, l)]);
    return d;
  }

  private transform(n: SceneNode, mode: Mode): Decl[] {
    if (mode === 'root') return [];
    const parts: string[] = [];
    if (r2(n.rotation, 3)) parts.push(`rotate(${num(n.rotation, 3)}deg)`);
    if (n.flipX && n.flipY) parts.push('scale(-1)');
    else if (n.flipX) parts.push('scaleX(-1)');
    else if (n.flipY) parts.push('scaleY(-1)');
    return parts.length ? [['transform', parts.join(' ')]] : [];
  }

  /* ------------------------------------------------------------ visuals */

  private box(n: SceneNode): Decl[] {
    const d: Decl[] = [...this.backgrounds(n.fills, n.width, n.height)];
    if (isPlainEllipse(n)) d.push(['border-radius', '50%']);
    else if (n.type === 'rect' || n.type === 'frame') {
      const u = uniformRadius(n);
      if (u !== null) {
        if (u > 0) d.push(['border-radius', px(u)]);
      } else d.push(['border-radius', cornerRadii(n).map(px).join(' ')]);
    }
    d.push(...this.outline(n));
    return d;
  }

  /** CSS backgrounds for a paint stack (paints are bottom → top, CSS is top → bottom). */
  backgrounds(paints: Paint[], w: number, h: number): Decl[] {
    const vis = visiblePaints(paints);
    if (!vis.length) return [];
    if (vis.length === 1 && vis[0].type === 'solid') return [['background-color', cssColor(vis[0].color, vis[0].opacity)]];
    const layers: string[] = [];
    vis.forEach((p, i) => {
      const bottom = i === 0;
      switch (p.type) {
        case 'solid': {
          const c = cssColor(p.color, p.opacity);
          layers.push(bottom ? c : `linear-gradient(${c}, ${c})`);
          break;
        }
        case 'linear':
        case 'radial':
        case 'angular':
        case 'diamond':
          layers.push(cssGradient(p, w, h));
          break;
        case 'image': {
          const layer = this.imageLayer(p);
          if (layer) layers.push(layer);
          break;
        }
        case 'pattern': {
          const tile = patternTileSvg({ ...p, background: p.background });
          const size = /width="([\d.]+)" height="([\d.]+)"/.exec(tile);
          layers.push(`url("data:image/svg+xml,${encodeURIComponent(tile)}") 0 0 / ${size ? `${size[1]}px ${size[2]}px` : 'auto'} repeat`);
          break;
        }
        case 'noise': {
          const c = cssColor(p.background ?? p.color, p.opacity * (p.background ? 1 : 0.5));
          layers.push(bottom ? c : `linear-gradient(${c}, ${c})`);
          break;
        }
      }
    });
    if (!layers.length) return [];
    const d: Decl[] = [['background', layers.reverse().join(', ')]];
    const blends = vis.map((p) => p.blendMode ?? 'normal').reverse();
    if (blends.some((b) => b !== 'normal')) d.push(['background-blend-mode', blends.join(', ')]);
    return d;
  }

  private imageLayer(p: ImagePaint): string | null {
    if (!this.doc.assets[p.assetId]) return null;
    const url = `url("${this.useAsset(p.assetId)}")`;
    switch (p.fit) {
      case 'fit':
        return `${url} center / contain no-repeat`;
      case 'stretch':
        return `${url} 0 0 / 100% 100% no-repeat`;
      case 'tile': {
        const s = assetSize(this.doc, p.assetId);
        const k = p.scale > 0 ? p.scale : 1;
        return `${url} 0 0 / ${s ? `${px(s.width * k)} ${px(s.height * k)}` : 'auto'} repeat`;
      }
      default:
        return `${url} center / cover no-repeat`;
    }
  }

  /** Strokes as an outline (follows border-radius, never affects layout). */
  private outline(n: SceneNode): Decl[] {
    const p = visiblePaints(n.strokes).at(-1);
    if (!p || n.strokeWidth <= 0) return [];
    const color = paintColor(p);
    if (!color) return [];
    const style = n.dash.some((v) => v > 0) ? 'dashed' : 'solid';
    const d: Decl[] = [['outline', `${px(n.strokeWidth)} ${style} ${color}`]];
    const offset = n.strokeAlign === 'inside' ? -n.strokeWidth : n.strokeAlign === 'center' ? -n.strokeWidth / 2 : 0;
    if (offset) d.push(['outline-offset', px(offset)]);
    return d;
  }

  private textCss(n: TextNode): Decl[] {
    const d: Decl[] = [['margin', '0'], ['font-family', fontStack(n.fontFamily)], ['font-size', px(n.fontSize)]];
    if (n.fontWeight !== 400) d.push(['font-weight', String(Math.round(n.fontWeight))]);
    if (n.italic) d.push(['font-style', 'italic']);
    d.push(['line-height', num(n.lineHeight, 3)]);
    if (n.letterSpacing) d.push(['letter-spacing', px(n.letterSpacing)]);
    if (n.textAlign !== 'left') d.push(['text-align', n.textAlign]);
    if (n.textDecoration !== 'none') d.push(['text-decoration', n.textDecoration === 'underline' ? 'underline' : 'line-through']);
    if (n.textCase !== 'none') d.push(['text-transform', n.textCase === 'upper' ? 'uppercase' : n.textCase === 'lower' ? 'lowercase' : 'capitalize']);
    d.push(['white-space', n.autoResize === 'width' ? 'pre' : 'pre-wrap']);
    if (n.autoResize === 'none' && n.verticalAlign !== 'top') {
      d.push(['display', 'flex'], ['flex-direction', 'column'], ['justify-content', n.verticalAlign === 'middle' ? 'center' : 'flex-end']);
    }
    const fills = visiblePaints(n.fills);
    const top = fills.at(-1);
    if (top && (isGradient(top) || top.type === 'image' || top.type === 'pattern')) {
      d.push(...this.backgrounds([top], n.width, n.height), ['-webkit-background-clip', 'text'], ['background-clip', 'text'], ['color', 'transparent']);
    } else if (top) {
      const c = paintColor(top);
      if (c) d.push(['color', c]);
    } else d.push(['color', 'transparent']);
    const stroke = visiblePaints(n.strokes).at(-1);
    if (stroke && n.strokeWidth > 0) {
      const c = paintColor(stroke);
      if (c) {
        const w = n.strokeAlign === 'center' ? n.strokeWidth : n.strokeWidth * 2;
        d.push(['-webkit-text-stroke', `${px(w)} ${c}`]);
        if (n.strokeAlign === 'outside') d.push(['paint-order', 'stroke fill']);
      }
    }
    return d;
  }

  private effects(n: SceneNode, kind: 'box' | 'text' | 'img'): Decl[] {
    const fx = visibleEffects(n.effects);
    if (!fx.length) return [];
    const d: Decl[] = [];
    const shadows: string[] = [];
    const filters: string[] = [];
    for (const e of fx) {
      switch (e.type) {
        case 'drop-shadow':
        case 'glow': {
          const x = e.type === 'glow' ? 0 : e.x;
          const y = e.type === 'glow' ? 0 : e.y;
          const c = cssColor(e.color, e.opacity);
          if (kind === 'box') shadows.push(`${px(x)} ${px(y)} ${px(e.blur)} ${e.spread ? px(e.spread) + ' ' : ''}${c}`);
          else if (kind === 'text') shadows.push(`${px(x)} ${px(y)} ${px(e.blur)} ${c}`);
          else filters.push(`drop-shadow(${px(x)} ${px(y)} ${px(e.blur / 2)} ${c})`);
          break;
        }
        case 'inner-shadow':
          if (kind === 'box') shadows.push(`inset ${px(e.x)} ${px(e.y)} ${px(e.blur)} ${e.spread ? px(e.spread) + ' ' : ''}${cssColor(e.color, e.opacity)}`);
          else d.push(['/*', 'inner shadow is not supported on this element in CSS']);
          break;
        case 'layer-blur':
          if (e.radius > 0) filters.push(`blur(${px(e.radius / 2)})`);
          break;
        case 'background-blur':
          if (e.radius > 0) d.push(['-webkit-backdrop-filter', `blur(${px(e.radius / 2)})`], ['backdrop-filter', `blur(${px(e.radius / 2)})`]);
          break;
        case 'adjust':
          filters.push(...adjustFilters(e));
          break;
        case 'noise':
          d.push(['/*', `noise effect (${Math.round(e.amount * 100)}%) has no CSS equivalent`]);
          break;
      }
    }
    if (shadows.length) d.unshift([kind === 'text' ? 'text-shadow' : 'box-shadow', shadows.join(', ')]);
    if (filters.length) d.push(['filter', filters.join(' ')]);
    return d;
  }

  private layer(n: SceneNode): Decl[] {
    const d: Decl[] = [];
    if (n.opacity < 0.999) d.push(['opacity', num(n.opacity, 3)]);
    if (n.blendMode !== 'normal') d.push(['mix-blend-mode', n.blendMode]);
    return d;
  }
}

/* ---------------------------------------------------------------- helpers */

export function paddingValue(t: number, r: number, b: number, l: number): string {
  if (t === r && r === b && b === l) return px(t);
  if (t === b && r === l) return `${px(t)} ${px(r)}`;
  if (r === l) return `${px(t)} ${px(r)} ${px(b)}`;
  return `${px(t)} ${px(r)} ${px(b)} ${px(l)}`;
}

/** A flat CSS colour for a paint (gradients use their first stop). */
function paintColor(p: Paint): string | null {
  if (p.type === 'solid') return cssColor(p.color, p.opacity);
  if (isGradient(p)) {
    const s = [...p.stops].sort((a, b) => a.offset - b.offset)[0];
    return s ? cssColor(s.color, s.opacity * p.opacity) : null;
  }
  if (p.type === 'pattern' || p.type === 'noise') return cssColor(p.color, p.opacity);
  return null;
}

function adjustFilters(e: Extract<Effect, { type: 'adjust' }>): string[] {
  const f: string[] = [];
  if (e.brightness) f.push(`brightness(${num(1 + e.brightness, 3)})`);
  if (e.contrast) f.push(`contrast(${num(1 + e.contrast, 3)})`);
  if (e.saturation) f.push(`saturate(${num(Math.max(0, 1 + e.saturation), 3)})`);
  if (e.hue) f.push(`hue-rotate(${num(e.hue)}deg)`);
  if (e.grayscale) f.push(`grayscale(${num(e.grayscale, 3)})`);
  if (e.sepia) f.push(`sepia(${num(e.sepia, 3)})`);
  if (e.invert) f.push(`invert(${num(e.invert, 3)})`);
  return f;
}

/** Google Fonts stylesheet URL for the non-system fonts used. */
export function googleFontsUrl(fonts: Map<string, Set<string>>): string | null {
  const families: string[] = [];
  for (const [family, variants] of [...fonts].sort(([a], [b]) => a.localeCompare(b))) {
    if (isSystemFont(family) || !family.trim()) continue;
    const list = [...variants].map((v) => v.split(',').map(Number) as [number, number]);
    const hasItalic = list.some(([i]) => i === 1);
    const name = family.trim().replace(/\s+/g, '+');
    const tuples = [...new Set(list.map(([i, w]) => (hasItalic ? `${i},${w}` : `${w}`)))].sort((a, b) => {
      const [ai, aw] = a.includes(',') ? a.split(',').map(Number) : [0, +a];
      const [bi, bw] = b.includes(',') ? b.split(',').map(Number) : [0, +b];
      return ai - bi || aw - bw;
    });
    families.push(`family=${name}:${hasItalic ? 'ital,wght' : 'wght'}@${tuples.join(';')}`);
  }
  return families.length ? `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap` : null;
}

/* ------------------------------------------------------------ serializing */

export function cssRule(selector: string, decls: Decl[], indent = '  ', level = 0): string {
  const pad = indent.repeat(level);
  const body = decls.map(([k, v]) => (k === '/*' ? `${pad}${indent}/* ${v} */` : `${pad}${indent}${k}: ${v};`)).join('\n');
  return `${pad}${selector} {\n${body}\n${pad}}`;
}

function htmlNode(w: WebNode, b: WebBuilder, level: number, indent = '  '): string {
  const pad = indent.repeat(level);
  const cls = ` class="${w.className}"`;
  switch (w.kind) {
    case 'text':
      return `${pad}<p${cls}>${xmlEscape(w.text ?? '')}</p>`;
    case 'img':
      return `${pad}<img${cls} src="${xmlAttr(resolveTokens(w.src ?? '', b))}" alt="${xmlAttr(w.alt ?? '')}" />`;
    case 'svg': {
      const svg = { ...w.svg!, attrs: { class: w.className, ...w.svg!.attrs, xmlns: undefined, 'xmlns:xlink': undefined } };
      return serializeXml(svg, indent, level);
    }
    default: {
      if (!w.children.length) return `${pad}<div${cls}></div>`;
      const inner = w.children.map((c) => htmlNode(c, b, level + 1, indent)).join('\n');
      return `${pad}<div${cls}>\n${inner}\n${pad}</div>`;
    }
  }
}

export function resolveTokens(s: string, b: WebBuilder): string {
  return s.replace(ASSET_TOKEN, (_, id: string) => b.resolveAsset(id));
}

export function flattenWeb(w: WebNode, out: WebNode[] = []): WebNode[] {
  out.push(w);
  for (const c of w.children) flattenWeb(c, out);
  return out;
}

export interface HtmlDocument {
  html: string;
  css: string;
  files: ExportFile[];
}

/** Build one HTML page (and its CSS) for a set of roots. */
export function buildHtml(doc: Doc, pageId: ID, rootIds: ID[], opts: Partial<WebOptions> & { googleFonts?: boolean; separateCss?: boolean; title?: string } = {}): HtmlDocument {
  const b = new WebBuilder(doc, { assets: opts.assets ?? 'inline', assetDir: opts.assetDir ?? 'assets' });
  const trees = rootIds.map((id) => b.build(id)).filter((t): t is WebNode => !!t);
  const page = doc.pages.find((p) => p.id === pageId);
  const bg = page?.background ? page.background : '#f5f5f5';
  const rules: string[] = [
    cssRule('*,\n*::before,\n*::after', [['box-sizing', 'border-box']]),
    cssRule('body', [
      ['margin', '0'],
      ['min-height', '100vh'],
      ['display', 'flex'],
      ['flex-wrap', 'wrap'],
      ['align-items', 'flex-start'],
      ['justify-content', 'center'],
      ['gap', '48px'],
      ['padding', '48px'],
      ['background', bg],
      ['-webkit-font-smoothing', 'antialiased'],
    ]),
  ];
  for (const t of trees) for (const w of flattenWeb(t)) rules.push(cssRule(`.${w.className}`, w.css.map(([k, v]) => [k, resolveTokens(v, b)] as Decl)));
  const css = rules.join('\n\n') + '\n';
  const fonts = opts.googleFonts === false ? null : googleFontsUrl(b.fonts);
  const head: string[] = ['<meta charset="utf-8" />', '<meta name="viewport" content="width=device-width, initial-scale=1" />', `<title>${xmlEscape(opts.title ?? doc.name)}</title>`];
  if (fonts) {
    head.push(
      '<link rel="preconnect" href="https://fonts.googleapis.com" />',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      `<link rel="stylesheet" href="${xmlAttr(fonts)}" />`,
    );
  }
  if (opts.separateCss) head.push('<link rel="stylesheet" href="styles.css" />');
  else head.push('<style>', ...css.trimEnd().split('\n').map((l) => (l ? `  ${l}` : '')), '</style>');
  const body = trees.map((t) => htmlNode(t, b, 2)).join('\n');
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    ...head.map((l) => `    ${l}`.trimEnd()),
    '  </head>',
    '  <body>',
    body,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
  return { html, css, files: b.assetFilesOut() };
}

/* --------------------------------------------------------------- exporter */

export const htmlExporter: Exporter = {
  id: 'html',
  label: 'HTML & CSS',
  group: 'Web',
  extension: 'html',
  description: 'A self-contained index.html: flexbox for auto layout, real text, inline SVG for vectors.',
  textual: true,
  options: [
    {
      key: 'assets',
      label: 'Images',
      type: 'select',
      default: 'inline',
      options: [
        { value: 'inline', label: 'Embed (data URLs)' },
        { value: 'files', label: 'Separate files' },
      ],
    },
    { key: 'separateCss', label: 'Separate styles.css', type: 'boolean', default: false },
    { key: 'googleFonts', label: 'Link Google Fonts', type: 'boolean', default: true },
  ],
  async run(ctx: ExportContext): Promise<ExportFile[]> {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    if (!roots.length) return [];
    const title = roots.length === 1 ? ctx.doc.nodes[roots[0]].name : ctx.doc.name;
    const out = buildHtml(ctx.doc, ctx.pageId, roots, {
      assets: ctx.options.assets === 'files' ? 'files' : 'inline',
      separateCss: !!ctx.options.separateCss,
      googleFonts: ctx.options.googleFonts !== false,
      title,
    });
    const files: ExportFile[] = [{ name: 'index.html', mime: MIME.html, data: out.html }];
    if (ctx.options.separateCss) files.push({ name: 'styles.css', mime: MIME.css, data: out.css });
    return [...files, ...out.files];
  },
};
