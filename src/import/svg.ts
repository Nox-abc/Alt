/**
 * SVG importer → ClipboardData (insert with `pasteNodes`).
 *
 * Parses with DOMParser when available (browser) and falls back to a small
 * built-in XML parser elsewhere (Node, MCP, tests). Supports shapes, paths,
 * text / tspan, images, <use> + <defs> / <symbol>, linear & radial gradients
 * (objectBoundingBox / userSpaceOnUse + gradientTransform), <style> sheets,
 * inline style and presentation attributes, clip-paths (as mask nodes) and
 * arbitrary transforms. Non-trivial transforms are baked into path geometry;
 * rotations / flips of rects, ellipses, text and images are kept as node
 * rotation. The viewBox becomes a root frame named after the file / <title>.
 */
import type { Asset, GradientPaint, GradientStop, ID, Paint, Rect, SceneNode, SolidPaint, Vec } from '../core/types';
import { apply, invert, IDENTITY, localMatrix, mul, placementFromMatrix, rotate, scale, transformRect, translate, type Mat } from '../core/geometry';
import { arcToCubics, cmdsBounds, cmdsToSubPaths, parseSvgPath, transformCmds, type PathCmd } from '../core/path';
import { createNode, normalizeHex, parseColor, uid } from '../core/doc';
import { layoutText, measureTextBox } from '../core/text';
import type { ClipboardData } from '../core/ops';

export interface SvgImportOptions {
  /** name of the root frame (defaults to the SVG <title> or "SVG") */
  name?: string;
}

/** Quick check whether a string looks like an SVG document. */
export function isSvgText(text: string): boolean {
  const head = text.slice(0, 4096).replace(/^﻿/, '');
  return /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>\s*)?(<!--[\s\S]*?-->\s*)*<(svg:)?svg[\s>]/i.test(head);
}

/* ================================================================ XML tree */

interface XNode {
  tag: string;
  attrs: Record<string, string>;
  /** mixed content: child elements and text */
  parts: (XNode | string)[];
}

const children = (n: XNode) => n.parts.filter((p): p is XNode => typeof p !== 'string');
const textContent = (n: XNode): string => n.parts.map((p) => (typeof p === 'string' ? p : textContent(p))).join('');

function fromDom(el: Element): XNode {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const parts: (XNode | string)[] = [];
  el.childNodes.forEach((c) => {
    if (c.nodeType === 1) parts.push(fromDom(c as Element));
    else if (c.nodeType === 3 || c.nodeType === 4) parts.push(c.nodeValue ?? '');
  });
  return { tag: el.localName, attrs, parts };
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string, custom: Record<string, string>): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z_][\w.-]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return custom[e] ?? XML_ENTITIES[e] ?? m;
  });
}

/** Minimal, forgiving XML parser (elements, attributes, text, CDATA, entities). */
export function parseXml(src: string): XNode {
  const root: XNode = { tag: '#document', attrs: {}, parts: [] };
  const stack: XNode[] = [root];
  const entities: Record<string, string> = {};
  let i = 0;
  const s = src.replace(/^﻿/, '');
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    if (s[i] !== '<') {
      const j = s.indexOf('<', i);
      const end = j < 0 ? s.length : j;
      const text = s.slice(i, end);
      if (stack.length > 1) top().parts.push(decodeEntities(text, entities));
      i = end;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const j = s.indexOf('-->', i + 4);
      i = j < 0 ? s.length : j + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const j = s.indexOf(']]>', i + 9);
      top().parts.push(s.slice(i + 9, j < 0 ? s.length : j));
      i = j < 0 ? s.length : j + 3;
      continue;
    }
    if (s.startsWith('<?', i)) {
      const j = s.indexOf('?>', i + 2);
      i = j < 0 ? s.length : j + 2;
      continue;
    }
    if (s.startsWith('<!', i)) {
      // DOCTYPE (with optional internal subset declaring entities)
      let j = i + 2;
      let depth = 0;
      while (j < s.length) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') depth--;
        else if (s[j] === '>' && depth <= 0) break;
        j++;
      }
      const decl = s.slice(i, j);
      for (const m of decl.matchAll(/<!ENTITY\s+([\w.-]+)\s+(["'])([\s\S]*?)\2\s*>/g)) entities[m[1]] = m[3];
      i = j + 1;
      continue;
    }
    if (s[i + 1] === '/') {
      const j = s.indexOf('>', i);
      const name = s.slice(i + 2, j < 0 ? s.length : j).trim();
      const local = name.includes(':') ? name.split(':').pop()! : name;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === local) {
          stack.length = k;
          break;
        }
      }
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    // start tag
    const m = /^<([^\s/>]+)/.exec(s.slice(i, i + 256));
    if (!m) {
      top().parts.push('<');
      i++;
      continue;
    }
    const qname = m[1];
    let j = i + m[0].length;
    const attrs: Record<string, string> = {};
    const attrRe = /\s*([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
    while (j < s.length) {
      while (/\s/.test(s[j] ?? '')) j++;
      if (s[j] === '>' || s.startsWith('/>', j)) break;
      attrRe.lastIndex = j;
      const a = attrRe.exec(s);
      if (!a || a[0].length === 0) {
        j++;
        continue;
      }
      attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '', entities);
      j = attrRe.lastIndex;
    }
    const selfClose = s.startsWith('/>', j);
    const el: XNode = { tag: qname.includes(':') ? qname.split(':').pop()! : qname, attrs, parts: [] };
    top().parts.push(el);
    if (!selfClose) stack.push(el);
    i = j + (selfClose ? 2 : 1);
  }
  return root;
}

function parseDocument(text: string): XNode {
  if (typeof DOMParser !== 'undefined') {
    const dom = new DOMParser().parseFromString(text, 'image/svg+xml');
    const err = dom.getElementsByTagName('parsererror')[0];
    if (!err && dom.documentElement) return fromDom(dom.documentElement);
  }
  const doc = parseXml(text);
  const find = (n: XNode): XNode | null => {
    for (const c of children(n)) {
      if (c.tag === 'svg') return c;
      const f = find(c);
      if (f) return f;
    }
    return null;
  };
  const svg = find(doc);
  if (!svg) throw new Error('No <svg> element found');
  return svg;
}

/* ================================================================== CSS */

interface CssRule {
  tag?: string;
  id?: string;
  classes: string[];
  specificity: number;
  order: number;
  decls: Record<string, string>;
}

function parseDecls(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part
      .slice(i + 1)
      .replace(/!important/i, '')
      .trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function parseStylesheet(css: string, rules: CssRule[]) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[^{;]+;/g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const decls = parseDecls(m[2]);
    for (const raw of m[1].split(',')) {
      const sel = raw.trim();
      if (!sel || /[\s>+~:[]/.test(sel) || sel.startsWith('@')) continue;
      const parts = sel.match(/[#.]?[^#.]+/g) ?? [];
      const rule: CssRule = { classes: [], specificity: 0, order: rules.length, decls };
      for (const p of parts) {
        if (p.startsWith('#')) {
          rule.id = p.slice(1);
          rule.specificity += 100;
        } else if (p.startsWith('.')) {
          rule.classes.push(p.slice(1));
          rule.specificity += 10;
        } else if (p !== '*') {
          rule.tag = p;
          rule.specificity += 1;
        }
      }
      rules.push(rule);
    }
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

/* ================================================================ values */

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff',
  magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00',
  teal: '#008080', navy: '#000080', purple: '#800080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', crimson: '#dc143c', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', orangered: '#ff4500', khaki: '#f0e68c',
  beige: '#f5f5dc', ivory: '#fffff0', lavender: '#e6e6fa', turquoise: '#40e0d0', tan: '#d2b48c', chocolate: '#d2691e', darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', dimgray: '#696969', dimgrey: '#696969', gainsboro: '#dcdcdc',
  whitesmoke: '#f5f5f5', darkblue: '#00008b', darkred: '#8b0000', darkgreen: '#006400', lightblue: '#add8e6', skyblue: '#87ceeb',
  steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff', deepskyblue: '#00bfff', forestgreen: '#228b22', seagreen: '#2e8b57',
  limegreen: '#32cd32', hotpink: '#ff69b4', deeppink: '#ff1493', slategray: '#708090', slategrey: '#708090', firebrick: '#b22222',
  goldenrod: '#daa520', plum: '#dda0dd', orchid: '#da70d6', sienna: '#a0522d', peru: '#cd853f', wheat: '#f5deb3', aliceblue: '#f0f8ff',
  snow: '#fffafa', azure: '#f0ffff', linen: '#faf0e6', mintcream: '#f5fffa', honeydew: '#f0fff0', darkorange: '#ff8c00', midnightblue: '#191970',
  darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', lightgreen: '#90ee90', yellowgreen: '#9acd32', cornflowerblue: '#6495ed',
};

function color(value: string, current: string): { hex: string; alpha: number } | null {
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent') return null;
  if (v === 'currentcolor') return color(current, '#000000');
  if (NAMED[v]) return { hex: NAMED[v].toUpperCase(), alpha: 1 };
  if (/^#[0-9a-f]{4}$/i.test(v)) {
    return { hex: normalizeHex(v.slice(0, 4)) ?? '#000000', alpha: parseInt(v[4] + v[4], 16) / 255 };
  }
  return parseColor(v);
}

function parseNum(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}

/** Length in px (`ref` resolves percentages). */
function length(v: string | undefined, ref = 0, fallback = 0, fontSize = 16): number {
  if (v === undefined || v.trim() === '' || v === 'auto') return fallback;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case '%':
      return (n / 100) * ref;
    case 'pt':
      return (n * 4) / 3;
    case 'pc':
      return n * 16;
    case 'mm':
      return n * 3.7795275591;
    case 'cm':
      return n * 37.795275591;
    case 'in':
      return n * 96;
    case 'em':
      return n * fontSize;
    case 'ex':
      return n * fontSize * 0.5;
    default:
      return n;
  }
}

const numbers = (s: string | undefined) => (s ?? '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];

export function parseTransform(s: string | undefined): Mat {
  let m: Mat = [...IDENTITY];
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const a = numbers(t[2]);
    let k: Mat = [...IDENTITY];
    switch (t[1].toLowerCase()) {
      case 'matrix':
        if (a.length >= 6) k = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        k = translate(a[0] ?? 0, a[1] ?? 0);
        break;
      case 'scale':
        k = scale(a[0] ?? 1, a[1] ?? a[0] ?? 1);
        break;
      case 'rotate':
        k = a.length >= 3 ? mul(mul(translate(a[1], a[2]), rotate(a[0])), translate(-a[1], -a[2])) : rotate(a[0] ?? 0);
        break;
      case 'skewx':
        k = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewy':
        k = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, k);
  }
  return m;
}

/** True when a matrix is rotation / flip / per-axis scale only (no skew). */
const isOrthogonal = (m: Mat) => Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-6 * (Math.hypot(m[0], m[1]) * Math.hypot(m[2], m[3]) + 1e-12);
const meanScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/* ================================================================ styles */

const INHERITED = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-miterlimit',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'letter-spacing',
  'text-decoration',
  'visibility',
  'color',
  'clip-rule',
]);

const PRESENTATION = new Set([
  ...INHERITED,
  'opacity',
  'display',
  'clip-path',
  'mask',
  'stop-color',
  'stop-opacity',
  'font',
]);

type Style = Record<string, string>;

const DEFAULT_STYLE: Style = { fill: '#000000', stroke: 'none', 'stroke-width': '1', 'font-size': '16', 'font-family': 'Inter', color: '#000000' };

/* ============================================================== importer */

class Importer {
  readonly nodes: SceneNode[] = [];
  readonly assets: Record<ID, Asset> = {};
  private ids = new Map<string, XNode>();
  private rules: CssRule[] = [];
  private viewport = { width: 100, height: 100 };
  private useDepth = 0;

  constructor(svg: XNode) {
    const index = (n: XNode) => {
      if (n.attrs.id) this.ids.set(n.attrs.id, n);
      if (n.tag === 'style') parseStylesheet(textContent(n), this.rules);
      children(n).forEach(index);
    };
    index(svg);
  }

  /* ---------------------------------------------------------- styling */

  /** Cascaded style: presentation attributes < stylesheet rules < inline style. */
  styleOf(el: XNode, parent: Style): Style {
    const own: Style = {};
    for (const [k, v] of Object.entries(el.attrs)) if (PRESENTATION.has(k)) own[k] = v;
    const classes = (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
    for (const r of this.rules) {
      if (r.tag && r.tag !== el.tag) continue;
      if (r.id && r.id !== el.attrs.id) continue;
      if (r.classes.some((c) => !classes.includes(c))) continue;
      Object.assign(own, r.decls);
    }
    if (el.attrs.style) Object.assign(own, parseDecls(el.attrs.style));
    const out: Style = {};
    for (const [k, v] of Object.entries(parent)) if (INHERITED.has(k)) out[k] = v;
    for (const [k, v] of Object.entries(own)) if (v !== 'inherit') out[k] = v;
    return out;
  }

  /* ----------------------------------------------------------- paints */

  private gradientChain(el: XNode): { attrs: Record<string, string>; stops: XNode[] } {
    const attrs: Record<string, string> = {};
    let stops: XNode[] = [];
    let cur: XNode | undefined = el;
    const seen = new Set<XNode>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      for (const [k, v] of Object.entries(cur.attrs)) if (!(k in attrs)) attrs[k] = v;
      if (!stops.length) stops = children(cur).filter((c) => c.tag === 'stop');
      const href: string | undefined = cur.attrs.href ?? cur.attrs['xlink:href'];
      cur = href?.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
    }
    return { attrs, stops };
  }

  /**
   * Convert a gradient element into a paint normalised to a node box.
   * `bbox` is the element's bounds in its user space, `toNode` maps user
   * space → node-local space.
   */
  private gradient(el: XNode, opacity: number, bbox: Rect, toNode: Mat, w: number, h: number): Paint | null {
    const { attrs, stops: stopEls } = this.gradientChain(el);
    const stops: GradientStop[] = [];
    for (const s of stopEls) {
      const st = { ...s.attrs, ...parseDecls(s.attrs.style ?? '') };
      const off = st.offset?.trim().endsWith('%') ? parseNum(st.offset) / 100 : parseNum(st.offset);
      const c = color(st['stop-color'] ?? '#000000', '#000000') ?? { hex: '#000000', alpha: 0 };
      stops.push({ offset: Math.max(stops.at(-1)?.offset ?? 0, Math.min(1, Math.max(0, off))), color: c.hex, opacity: c.alpha * parseNum(st['stop-opacity'], 1) });
    }
    if (!stops.length) return null;
    if (stops.length === 1) return solidPaint(stops[0].color, stops[0].opacity * opacity);
    const obb = (attrs.gradientUnits ?? 'objectBoundingBox') !== 'userSpaceOnUse';
    const unit = (v: string | undefined, fallback: number, ref: number) => {
      if (v === undefined) return fallback;
      if (v.trim().endsWith('%')) return (parseFloat(v) / 100) * (obb ? 1 : ref);
      return parseNum(v, fallback);
    };
    const vw = this.viewport.width;
    const vh = this.viewport.height;
    let from: Vec;
    let to: Vec;
    const type: GradientPaint['type'] = el.tag === 'radialGradient' ? 'radial' : 'linear';
    if (type === 'linear') {
      from = { x: unit(attrs.x1, 0, vw), y: unit(attrs.y1, 0, vh) };
      to = { x: unit(attrs.x2, obb ? 1 : vw, vw), y: unit(attrs.y2, 0, vh) };
    } else {
      const cx = unit(attrs.cx, obb ? 0.5 : vw / 2, vw);
      const cy = unit(attrs.cy, obb ? 0.5 : vh / 2, vh);
      const r = unit(attrs.r, obb ? 0.5 : Math.hypot(vw, vh) / Math.SQRT2 / 2, Math.hypot(vw, vh) / Math.SQRT2);
      from = { x: cx, y: cy };
      to = { x: cx + r, y: cy };
    }
    let m = parseTransform(attrs.gradientTransform);
    if (obb) m = mul([bbox.width || 1, 0, 0, bbox.height || 1, bbox.x, bbox.y], m);
    const full = mul(toNode, m);
    const f = apply(full, from);
    const t = apply(full, to);
    const W = w || 1;
    const H = h || 1;
    return {
      id: uid(),
      type,
      visible: true,
      opacity: Math.max(0, Math.min(1, opacity)),
      stops,
      from: { x: f.x / W, y: f.y / H },
      to: { x: t.x / W, y: t.y / H },
    };
  }

  private paint(value: string | undefined, opacity: number, st: Style, bbox: Rect, toNode: Mat, w: number, h: number): Paint | null {
    if (!value || opacity <= 0) return null;
    const v = value.trim();
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i.exec(v);
    if (url) {
      const def = this.ids.get(url[1]);
      if (def && (def.tag === 'linearGradient' || def.tag === 'radialGradient')) return this.gradient(def, opacity, bbox, toNode, w, h);
      return url[2] ? this.paint(url[2], opacity, st, bbox, toNode, w, h) : null;
    }
    const c = color(v, st.color ?? '#000000');
    return c ? solidPaint(c.hex, c.alpha * opacity) : null;
  }

  /** Apply fill / stroke / opacity styling to a node. */
  private style(node: SceneNode, st: Style, bbox: Rect, toNode: Mat, m: Mat) {
    const fill = this.paint(st.fill, parseNum(st['fill-opacity'], 1), st, bbox, toNode, node.width, node.height);
    const stroke = this.paint(st.stroke, parseNum(st['stroke-opacity'], 1), st, bbox, toNode, node.width, node.height);
    node.fills = fill ? [fill] : [];
    node.strokes = stroke ? [stroke] : [];
    const k = meanScale(m);
    node.strokeWidth = Math.max(0, length(st['stroke-width'], 1, 1) * k);
    node.strokeAlign = node.type === 'text' ? 'outside' : 'center';
    const cap = st['stroke-linecap'];
    node.strokeCap = cap === 'round' || cap === 'square' ? cap : 'butt';
    const join = st['stroke-linejoin'];
    node.strokeJoin = join === 'round' || join === 'bevel' ? join : 'miter';
    const dash = st['stroke-dasharray'];
    node.dash = dash && dash !== 'none' ? numbers(dash).map((d) => Math.abs(d) * k) : [];
    if (node.dash.length % 2 === 1) node.dash = [...node.dash, ...node.dash];
    node.opacity = Math.max(0, Math.min(1, parseNum(st.opacity, 1)));
  }

  private name(el: XNode, fallback: string): string {
    return el.attrs['inkscape:label'] ?? el.attrs['data-name'] ?? el.attrs.id ?? fallback;
  }

  /* ------------------------------------------------------------ shapes */

  /** Place a box-like node (rect / ellipse / image / text) from its user-space box and CTM. */
  private placeBox<T extends SceneNode>(node: T, m: Mat, box: Rect): T {
    const local = mul(m, translate(box.x, box.y));
    const pl = placementFromMatrix(local, box.width, box.height);
    node.width = Math.max(0.01, box.width * pl.sx);
    node.height = Math.max(0.01, box.height * pl.sy);
    node.x = pl.x;
    node.y = pl.y;
    node.rotation = pl.rotation;
    node.flipX = pl.flipX;
    node.flipY = pl.flipY;
    return node;
  }

  private pathNode(el: XNode, st: Style, cmds: PathCmd[], m: Mat, fallback: string): SceneNode | null {
    if (!cmds.length) return null;
    const world = transformCmds(cmds, m);
    const b = cmdsBounds(world);
    if (!b) return null;
    const local = transformCmds(world, translate(-b.x, -b.y));
    const node = createNode('path', {
      parentId: '',
      name: this.name(el, fallback),
      x: b.x,
      y: b.y,
      width: Math.max(0.01, b.width),
      height: Math.max(0.01, b.height),
      paths: cmdsToSubPaths(local),
      fillRule: st['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
    });
    this.style(node, st, cmdsBounds(cmds) ?? b, mul(translate(-b.x, -b.y), m), m);
    if (el.tag === 'line' || el.tag === 'polyline') node.fills = [];
    return node;
  }

  private shape(el: XNode, st: Style, m: Mat): SceneNode | null {
    const vw = this.viewport.width;
    const vh = this.viewport.height;
    const diag = Math.hypot(vw, vh) / Math.SQRT2;
    const a = el.attrs;
    switch (el.tag) {
      case 'rect': {
        const box = { x: length(a.x, vw), y: length(a.y, vh), width: length(a.width, vw), height: length(a.height, vh) };
        if (box.width <= 0 || box.height <= 0) return null;
        let rx = length(a.rx ?? a.ry, vw, 0);
        let ry = length(a.ry ?? a.rx, vh, 0);
        rx = Math.min(rx, box.width / 2);
        ry = Math.min(ry, box.height / 2);
        const nonUniform = Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) > 1e-6 * meanScale(m);
        if (!isOrthogonal(m) || Math.abs(rx - ry) > 1e-6 || (rx > 0 && nonUniform)) {
          return this.pathNode(el, st, rectPath(box, rx, ry), m, 'Rectangle');
        }
        const node = this.placeBox(createNode('rect', { parentId: '', name: this.name(el, 'Rectangle') }), m, box);
        node.cornerRadius = rx * Math.hypot(m[0], m[1]);
        this.style(node, st, box, localFromBox(node, m), m);
        return node;
      }
      case 'circle':
      case 'ellipse': {
        const cx = length(a.cx, vw);
        const cy = length(a.cy, vh);
        const rx = el.tag === 'circle' ? length(a.r, diag) : length(a.rx ?? a.ry, vw);
        const ry = el.tag === 'circle' ? rx : length(a.ry ?? a.rx, vh);
        if (rx <= 0 || ry <= 0) return null;
        const box = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
        if (!isOrthogonal(m)) return this.pathNode(el, st, ellipsePath(cx, cy, rx, ry), m, 'Ellipse');
        const node = this.placeBox(createNode('ellipse', { parentId: '', name: this.name(el, 'Ellipse') }), m, box);
        this.style(node, st, box, localFromBox(node, m), m);
        return node;
      }
      case 'line': {
        const p = [
          { c: 'M' as const, x: length(a.x1, vw), y: length(a.y1, vh) },
          { c: 'L' as const, x: length(a.x2, vw), y: length(a.y2, vh) },
        ];
        return this.pathNode(el, st, p, m, 'Line');
      }
      case 'polyline':
      case 'polygon': {
        const n = numbers(a.points);
        if (n.length < 4) return null;
        const cmds: PathCmd[] = [{ c: 'M', x: n[0], y: n[1] }];
        for (let i = 2; i + 1 < n.length; i += 2) cmds.push({ c: 'L', x: n[i], y: n[i + 1] });
        if (el.tag === 'polygon') cmds.push({ c: 'Z' });
        return this.pathNode(el, st, cmds, m, el.tag === 'polygon' ? 'Polygon' : 'Polyline');
      }
      case 'path':
        return this.pathNode(el, st, parseSvgPath(a.d ?? ''), m, 'Vector');
      case 'text':
        return this.text(el, st, m);
      case 'image':
        return this.image(el, st, m);
    }
    return null;
  }

  private text(el: XNode, st: Style, m: Mat): SceneNode | null {
    // collect lines: a tspan with its own y / dy starts a new line
    const lines: string[] = [''];
    let x = length(el.attrs.x?.split(/[\s,]+/)[0], this.viewport.width);
    let y = length(el.attrs.y?.split(/[\s,]+/)[0], this.viewport.height);
    let started = false;
    let spanStyle: Style | null = null;
    const walk = (n: XNode, inherited: Style) => {
      for (const p of n.parts) {
        if (typeof p === 'string') {
          lines[lines.length - 1] += p.replace(/\s+/g, ' ');
          if (p.trim()) started = true;
          continue;
        }
        if (p.tag !== 'tspan' && p.tag !== 'a' && p.tag !== 'textPath') continue;
        const ps = this.styleOf(p, inherited);
        if (p.attrs.y !== undefined || (p.attrs.dy !== undefined && parseNum(p.attrs.dy) !== 0)) {
          if (!started) {
            // the first positioned tspan defines where the text starts
            if (p.attrs.x !== undefined) x = length(p.attrs.x.split(/[\s,]+/)[0], this.viewport.width);
            if (p.attrs.y !== undefined) y = length(p.attrs.y.split(/[\s,]+/)[0], this.viewport.height);
            else y += length(p.attrs.dy, 0, 0, parseNum(st['font-size'], 16));
          } else lines.push('');
        }
        spanStyle ??= ps;
        walk(p, ps);
      }
    };
    walk(el, st);
    const textLines = lines.map((l) => l.trim()).filter((l, i, arr) => l || (i > 0 && i < arr.length - 1));
    const text = textLines.join('\n');
    if (!text.trim()) return null;
    const s: Style = { ...st, ...((spanStyle as Style | null) ?? {}) };
    const fontSize = length(s['font-size'], 16, 16);
    const family = (s['font-family'] ?? 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    const fw = s['font-weight'];
    const weight = fw === 'bold' || fw === 'bolder' ? 700 : fw === 'lighter' ? 300 : fw === 'normal' || !fw ? 400 : parseNum(fw, 400);
    const deco = s['text-decoration'] ?? '';
    const node = createNode('text', {
      parentId: '',
      name: this.name(el, text.split('\n')[0].slice(0, 40) || 'Text'),
      text,
      fontFamily: /^(sans-serif|system-ui|-apple-system|helvetica|arial)$/i.test(family) ? 'Inter' : /^monospace$/i.test(family) ? 'JetBrains Mono' : family,
      fontSize,
      fontWeight: Math.max(100, Math.min(900, Math.round(weight / 100) * 100)),
      italic: /italic|oblique/.test(s['font-style'] ?? ''),
      letterSpacing: length(s['letter-spacing'], 0, 0, fontSize),
      textDecoration: /underline/.test(deco) ? 'underline' : /line-through/.test(deco) ? 'strikethrough' : 'none',
      lineHeight: 1.2,
      autoResize: 'width',
    });
    const size = measureTextBox(node);
    node.width = size.width;
    node.height = size.height;
    const baseline = layoutText(node).lines[0]?.baseline ?? fontSize * 0.8;
    const anchor = s['text-anchor'];
    const left = anchor === 'middle' ? x - node.width / 2 : anchor === 'end' ? x - node.width : x;
    if (anchor === 'middle') node.textAlign = 'center';
    else if (anchor === 'end') node.textAlign = 'right';
    const box = { x: left, y: y - baseline, width: node.width, height: node.height };
    // font size scales with the transform; keep the layout box in sync
    const k = isOrthogonal(m) ? Math.hypot(m[0], m[1]) : meanScale(m);
    this.placeBox(node, m, box);
    if (Math.abs(k - 1) > 1e-6) {
      node.fontSize = r3(fontSize * k);
      node.letterSpacing = r3(node.letterSpacing * k);
      const sz = measureTextBox({ ...node });
      const cx = node.x + node.width / 2;
      const cy = node.y + node.height / 2;
      node.width = sz.width;
      node.height = sz.height;
      node.x = cx - sz.width / 2;
      node.y = cy - sz.height / 2;
    }
    this.style(node, s, box, localFromBox(node, m), m);
    node.strokeWidth = node.strokes.length ? node.strokeWidth : 1;
    return node;
  }

  private image(el: XNode, st: Style, m: Mat): SceneNode | null {
    const href = el.attrs.href ?? el.attrs['xlink:href'];
    if (!href) return null;
    const box = { x: length(el.attrs.x, this.viewport.width), y: length(el.attrs.y, this.viewport.height), width: length(el.attrs.width, this.viewport.width), height: length(el.attrs.height, this.viewport.height) };
    const mime = /^data:([^;,]+)/.exec(href)?.[1] ?? (/\.jpe?g($|\?)/i.test(href) ? 'image/jpeg' : 'image/png');
    const assetId = uid();
    const asset: Asset = { id: assetId, mime, data: href, name: this.name(el, 'Image') };
    if (box.width <= 0 || box.height <= 0) return null;
    this.assets[assetId] = asset;
    const par = el.attrs.preserveAspectRatio ?? '';
    const fit = /none/.test(par) ? 'stretch' : /slice/.test(par) ? 'fill' : 'fit';
    const node = this.placeBox(createNode('rect', { parentId: '', name: this.name(el, 'Image') }), m, box);
    node.fills = [{ id: uid(), type: 'image', assetId, fit, scale: 1, rotation: 0, opacity: 1, visible: true }];
    node.opacity = Math.max(0, Math.min(1, parseNum(st.opacity, 1)));
    return node;
  }

  /* ---------------------------------------------------------- structure */

  /** Wrap nodes in a group (box = union of children, children made group-relative). */
  private group(kids: SceneNode[], name: string, opacity = 1): SceneNode | null {
    if (!kids.length) return null;
    let b: Rect | null = null;
    for (const k of kids) {
      const r = transformRect(localMatrix(k), { x: 0, y: 0, width: k.width, height: k.height });
      b = b ? unionRect(b, r) : r;
    }
    const g = createNode('group', { parentId: '', name, x: b!.x, y: b!.y, width: Math.max(0.01, b!.width), height: Math.max(0.01, b!.height), opacity });
    for (const k of kids) {
      k.x -= b!.x;
      k.y -= b!.y;
      k.parentId = g.id;
      g.children.push(k.id);
    }
    this.nodes.push(g);
    return g;
  }

  /** Clip-path / mask → a group whose first child is a mask node. */
  private clipped(el: XNode, st: Style, m: Mat, content: SceneNode[]): SceneNode[] {
    const ref = /url\(\s*['"]?#([^'")\s]+)/.exec(st['clip-path'] ?? st.mask ?? '')?.[1];
    const def = ref ? this.ids.get(ref) : undefined;
    if (!def || !content.length) return content;
    const units = def.attrs.clipPathUnits ?? def.attrs.maskContentUnits;
    let cm = mul(m, parseTransform(def.attrs.transform));
    if (units === 'objectBoundingBox') {
      let b: Rect | null = null;
      for (const k of content) {
        const r = transformRect(localMatrix(k), { x: 0, y: 0, width: k.width, height: k.height });
        b = b ? unionRect(b, r) : r;
      }
      cm = [b!.width, 0, 0, b!.height, b!.x, b!.y];
    }
    const shapes: SceneNode[] = [];
    for (const c of children(def)) {
      const cst = this.styleOf(c, { ...DEFAULT_STYLE, fill: '#000000', stroke: 'none' });
      const n = this.shape(c, { ...cst, fill: def.tag === 'mask' ? cst.fill : '#000000', opacity: '1' }, mul(cm, parseTransform(c.attrs.transform)));
      if (n) {
        this.nodes.push(n);
        shapes.push(n);
      }
    }
    if (!shapes.length) return content;
    const mask = shapes.length === 1 ? shapes[0] : this.group(shapes, 'Clip')!;
    mask.isMask = true;
    mask.name = def.attrs.id ? `${def.attrs.id}` : 'Mask';
    // fold the mask into a single content group instead of wrapping it again
    let members = content;
    let name = this.name(el, 'Group');
    let opacity = 1;
    const only = content.length === 1 ? content[0] : null;
    if (only && only.type === 'group') {
      members = only.children.map((id) => this.nodes.find((n) => n.id === id)!).filter(Boolean);
      for (const k of members) {
        k.x += only.x;
        k.y += only.y;
      }
      name = only.name;
      opacity = only.opacity;
      this.nodes.splice(this.nodes.indexOf(only), 1);
    }
    const g = this.group([mask, ...members], name, opacity);
    return g ? [g] : content;
  }

  /** Convert an element (and its subtree) to nodes in the current user space. */
  walk(el: XNode, parentStyle: Style, ctm: Mat): SceneNode[] {
    const st = this.styleOf(el, parentStyle);
    if (st.display === 'none') return [];
    const skip = new Set(['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern', 'marker', 'style', 'title', 'desc', 'metadata', 'script', 'symbol', 'filter', 'font', 'foreignObject']);
    if (skip.has(el.tag)) return [];
    let m = mul(ctm, parseTransform(el.attrs.transform));
    let out: SceneNode[] = [];
    switch (el.tag) {
      case 'g':
      case 'a':
      case 'switch':
      case 'svg': {
        if (el.tag === 'svg') m = mul(m, this.viewportTransform(el, true));
        const list = el.tag === 'switch' ? children(el).slice(0, 1) : children(el);
        const kids = list.flatMap((c) => this.walk(c, st, m));
        const opacity = Math.max(0, Math.min(1, parseNum(st.opacity, 1)));
        if (!kids.length) return [];
        if (kids.length === 1 && !el.attrs.id && !el.attrs['inkscape:label'] && !el.attrs['data-name']) {
          kids[0].opacity *= opacity;
          out = kids;
        } else out = [this.group(kids, this.name(el, 'Group'), opacity)!];
        break;
      }
      case 'use': {
        const href = el.attrs.href ?? el.attrs['xlink:href'];
        const ref = href?.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
        if (!ref || this.useDepth > 16) return [];
        this.useDepth++;
        const um = mul(m, translate(length(el.attrs.x, this.viewport.width), length(el.attrs.y, this.viewport.height)));
        let kids: SceneNode[];
        if (ref.tag === 'symbol') {
          const sym: XNode = { ...ref, tag: 'svg', attrs: { ...ref.attrs, width: el.attrs.width ?? ref.attrs.width ?? '100%', height: el.attrs.height ?? ref.attrs.height ?? '100%' } };
          kids = this.walk({ ...sym, attrs: { ...sym.attrs, id: el.attrs.id ?? ref.attrs.id ?? '' } }, st, um);
        } else kids = this.walk(ref, st, um);
        this.useDepth--;
        kids.forEach((k) => {
          if (el.attrs.id) k.name = el.attrs.id;
          k.opacity *= Math.max(0, Math.min(1, parseNum(st.opacity, 1)));
        });
        out = kids;
        break;
      }
      default: {
        if (st.visibility === 'hidden' || st.visibility === 'collapse') return [];
        const n = this.shape(el, st, m);
        if (!n) return [];
        this.nodes.push(n);
        out = [n];
      }
    }
    if (st['clip-path'] && st['clip-path'] !== 'none') out = this.clipped(el, st, m, out);
    else if (st.mask && st.mask !== 'none') out = this.clipped(el, st, m, out);
    return out;
  }

  /** viewBox → viewport transform of an <svg> / <symbol>. */
  viewportTransform(el: XNode, nested: boolean): Mat {
    const vb = numbers(el.attrs.viewBox);
    const x = nested ? length(el.attrs.x, this.viewport.width) : 0;
    const y = nested ? length(el.attrs.y, this.viewport.height) : 0;
    if (vb.length < 4 || vb[2] <= 0 || vb[3] <= 0) return translate(x, y);
    const w = length(el.attrs.width, this.viewport.width, vb[2]);
    const h = length(el.attrs.height, this.viewport.height, vb[3]);
    const par = el.attrs.preserveAspectRatio ?? 'xMidYMid meet';
    let sx = w / vb[2];
    let sy = h / vb[3];
    let tx = 0;
    let ty = 0;
    if (!/none/.test(par)) {
      const s = /slice/.test(par) ? Math.max(sx, sy) : Math.min(sx, sy);
      const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5;
      const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
      tx = (w - vb[2] * s) * ax;
      ty = (h - vb[3] * s) * ay;
      sx = sy = s;
    }
    return [sx, 0, 0, sy, x + tx - vb[0] * sx, y + ty - vb[1] * sy];
  }

  setViewport(w: number, h: number) {
    this.viewport = { width: w, height: h };
  }
}

/* ---------------------------------------------------------------- helpers */

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function solidPaint(hex: string, opacity: number): SolidPaint {
  return { id: uid(), type: 'solid', color: hex.toUpperCase(), opacity: Math.max(0, Math.min(1, opacity)), visible: true };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** user space → node-local space for a node placed in root space. */
function localFromBox(node: SceneNode, m: Mat): Mat {
  return mul(invert(localMatrix(node)), m);
}

function rectPath(b: Rect, rx: number, ry: number): PathCmd[] {
  const { x, y, width: w, height: h } = b;
  if (rx <= 0 || ry <= 0)
    return [
      { c: 'M', x, y },
      { c: 'L', x: x + w, y },
      { c: 'L', x: x + w, y: y + h },
      { c: 'L', x, y: y + h },
      { c: 'Z' },
    ];
  return [
    { c: 'M', x: x + rx, y },
    { c: 'L', x: x + w - rx, y },
    ...arcToCubics(x + w - rx, y, rx, ry, 0, false, true, x + w, y + ry),
    { c: 'L', x: x + w, y: y + h - ry },
    ...arcToCubics(x + w, y + h - ry, rx, ry, 0, false, true, x + w - rx, y + h),
    { c: 'L', x: x + rx, y: y + h },
    ...arcToCubics(x + rx, y + h, rx, ry, 0, false, true, x, y + h - ry),
    { c: 'L', x, y: y + ry },
    ...arcToCubics(x, y + ry, rx, ry, 0, false, true, x + rx, y),
    { c: 'Z' },
  ];
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  return [
    { c: 'M', x: cx + rx, y: cy },
    ...arcToCubics(cx + rx, cy, rx, ry, 0, false, true, cx, cy + ry),
    ...arcToCubics(cx, cy + ry, rx, ry, 0, false, true, cx - rx, cy),
    ...arcToCubics(cx - rx, cy, rx, ry, 0, false, true, cx, cy - ry),
    ...arcToCubics(cx, cy - ry, rx, ry, 0, false, true, cx + rx, cy),
    { c: 'Z' },
  ];
}

/* ------------------------------------------------------------------ entry */

/** Import SVG markup as clipboard data (a root frame containing the artwork). */
export function importSvg(svgText: string, opts: SvgImportOptions = {}): ClipboardData {
  const svg = parseDocument(svgText);
  if (svg.tag !== 'svg') throw new Error('Not an SVG document');
  const imp = new Importer(svg);
  const vb = numbers(svg.attrs.viewBox);
  const hasVb = vb.length >= 4 && vb[2] > 0 && vb[3] > 0;
  let width = length(svg.attrs.width, hasVb ? vb[2] : 300, hasVb ? vb[2] : 0);
  let height = length(svg.attrs.height, hasVb ? vb[3] : 150, hasVb ? vb[3] : 0);
  imp.setViewport(hasVb ? vb[2] : width || 300, hasVb ? vb[3] : height || 150);
  const m = hasVb && width && height ? imp.viewportTransform({ ...svg, attrs: { ...svg.attrs, width: String(width), height: String(height) } }, false) : ([...IDENTITY] as Mat);
  const rootStyle = imp.styleOf(svg, { ...DEFAULT_STYLE });
  const flat = children(svg).flatMap((c) => imp.walk(c, rootStyle, m));
  if (!width || !height) {
    let b: Rect | null = null;
    for (const k of flat) {
      const r = transformRect(localMatrix(k), { x: 0, y: 0, width: k.width, height: k.height });
      b = b ? unionRect(b, r) : r;
    }
    width = width || Math.max(1, (b?.x ?? 0) + (b?.width ?? 1));
    height = height || Math.max(1, (b?.y ?? 0) + (b?.height ?? 1));
  }
  const title = children(svg).find((c) => c.tag === 'title');
  const frame = createNode('frame', {
    parentId: '',
    name: opts.name || (title && textContent(title).trim()) || 'SVG',
    x: 0,
    y: 0,
    width,
    height,
    fills: [],
    clipContent: true,
  });
  for (const k of flat) {
    k.parentId = frame.id;
    frame.children.push(k.id);
  }
  return { app: 'alt', version: 1, roots: [{ id: frame.id, world: localMatrix(frame) }], nodes: [frame, ...imp.nodes], assets: imp.assets };
}
