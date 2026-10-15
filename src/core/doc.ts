import type {
  AdjustEffect,
  BaseNode,
  BitmapNode,
  BooleanNode,
  BrushNode,
  Doc,
  Effect,
  EffectType,
  EllipseNode,
  FrameNode,
  GradientPaint,
  GradientType,
  GroupNode,
  ID,
  NodeOfType,
  NodeType,
  Page,
  Paint,
  PathNode,
  PolygonNode,
  RectNode,
  SceneNode,
  SolidPaint,
  StarNode,
  TextNode,
} from './types';
import { DEFAULT_BRUSH } from './shapes';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function uid(len = 10): string {
  let s = '';
  const buf = new Uint8Array(len);
  (globalThis.crypto ?? ({ getRandomValues: (b: Uint8Array) => b.map(() => (Math.random() * 256) | 0) } as Crypto)).getRandomValues(buf);
  for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % 36];
  return s;
}

export function solid(color = '#D9D9D9', opacity = 1): SolidPaint {
  return { id: uid(), type: 'solid', color, opacity, visible: true };
}

export function gradient(type: GradientType = 'linear', a = '#FFFFFF', b = '#000000'): GradientPaint {
  const base = { id: uid(), type, opacity: 1, visible: true, stops: [
    { offset: 0, color: a, opacity: 1 },
    { offset: 1, color: b, opacity: 1 },
  ] };
  if (type === 'linear') return { ...base, from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } };
  return { ...base, from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } };
}

export function defaultEffect(type: EffectType): Effect {
  const id = uid();
  switch (type) {
    case 'drop-shadow':
      return { id, type, visible: true, color: '#000000', opacity: 0.25, x: 0, y: 4, blur: 12, spread: 0 };
    case 'inner-shadow':
      return { id, type, visible: true, color: '#000000', opacity: 0.25, x: 0, y: 2, blur: 6, spread: 0 };
    case 'glow':
      return { id, type, visible: true, color: '#8B7CFF', opacity: 0.8, blur: 24, spread: 0 };
    case 'layer-blur':
      return { id, type, visible: true, radius: 8 };
    case 'background-blur':
      return { id, type, visible: true, radius: 16 };
    case 'noise':
      return { id, type, visible: true, amount: 0.18, size: 1, monochrome: true };
    case 'adjust':
      return {
        id,
        type,
        visible: true,
        brightness: 0,
        contrast: 0,
        saturation: 0,
        hue: 0,
        grayscale: 0,
        sepia: 0,
        invert: 0,
      } satisfies AdjustEffect;
  }
}

const TYPE_NAMES: Record<NodeType, string> = {
  frame: 'Frame',
  group: 'Group',
  boolean: 'Boolean',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  polygon: 'Polygon',
  star: 'Star',
  path: 'Vector',
  text: 'Text',
  brush: 'Brush stroke',
  bitmap: 'Paint layer',
};

export function typeLabel(t: NodeType): string {
  return TYPE_NAMES[t];
}

function base(type: NodeType, parentId: ID): BaseNode {
  return {
    id: uid(),
    type,
    name: TYPE_NAMES[type],
    parentId,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    flipX: false,
    flipY: false,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    fills: [],
    strokes: [],
    strokeWidth: 1,
    strokeAlign: 'inside',
    strokeCap: 'butt',
    strokeJoin: 'miter',
    dash: [],
    effects: [],
    constraints: { h: 'left', v: 'top' },
    sizingH: 'fixed',
    sizingV: 'fixed',
    layoutPositioning: 'auto',
    isMask: false,
    exportSettings: [],
  };
}

export const DEFAULT_TEXT = {
  fontFamily: 'Inter',
  fontSize: 24,
  fontWeight: 400,
  italic: false,
  lineHeight: 1.25,
  letterSpacing: 0,
  paragraphSpacing: 0,
  textAlign: 'left' as const,
  verticalAlign: 'top' as const,
  textDecoration: 'none' as const,
  textCase: 'none' as const,
};

/** Create a node with sensible defaults for its type. */
export function createNode<T extends NodeType>(type: T, props: Partial<NodeOfType<T>> & { parentId: ID }): NodeOfType<T> {
  const b = base(type, props.parentId);
  let n: SceneNode;
  switch (type) {
    case 'frame':
      n = {
        ...b,
        type: 'frame',
        fills: [solid('#FFFFFF')],
        strokeAlign: 'inside',
        children: [],
        clipContent: true,
        layout: null,
        layoutGrids: [],
        isComponent: false,
        cornerRadius: 0,
        cornerRadii: null,
        cornerSmoothing: 0,
      } satisfies FrameNode;
      break;
    case 'group':
      n = { ...b, type: 'group', children: [] } satisfies GroupNode;
      break;
    case 'boolean':
      n = { ...b, type: 'boolean', children: [], op: 'union', fills: [solid()] } satisfies BooleanNode;
      break;
    case 'rect':
      n = { ...b, type: 'rect', fills: [solid()], cornerRadius: 0, cornerRadii: null, cornerSmoothing: 0 } satisfies RectNode;
      break;
    case 'ellipse':
      n = { ...b, type: 'ellipse', fills: [solid()], arcStart: 0, arcSweep: 360, innerRadius: 0 } satisfies EllipseNode;
      break;
    case 'polygon':
      n = { ...b, type: 'polygon', fills: [solid()], sides: 3, cornerRadius: 0 } satisfies PolygonNode;
      break;
    case 'star':
      n = { ...b, type: 'star', fills: [solid()], points: 5, innerRadius: 0.382, cornerRadius: 0 } satisfies StarNode;
      break;
    case 'path':
      n = {
        ...b,
        type: 'path',
        strokes: [solid('#000000')],
        strokeAlign: 'center',
        strokeCap: 'round',
        strokeJoin: 'round',
        paths: [],
        fillRule: 'nonzero',
        startMarker: 'none',
        endMarker: 'none',
      } satisfies PathNode;
      break;
    case 'text':
      n = {
        ...b,
        type: 'text',
        fills: [solid('#000000')],
        strokeAlign: 'outside',
        text: '',
        autoResize: 'width',
        ...DEFAULT_TEXT,
      } satisfies TextNode;
      break;
    case 'brush':
      n = { ...b, type: 'brush', fills: [solid('#111111')], points: [], brush: { ...DEFAULT_BRUSH } } satisfies BrushNode;
      break;
    case 'bitmap':
      n = {
        ...b,
        type: 'bitmap',
        assetId: '',
        pixelWidth: 100,
        pixelHeight: 100,
        smoothing: true,
        pixelGrid: false,
      } satisfies BitmapNode;
      break;
    default:
      throw new Error(`Unknown node type ${type}`);
  }
  return { ...n, ...props, type } as NodeOfType<T>;
}

export function createPage(name = 'Page 1'): Page {
  return { id: 'page_' + uid(), name, children: [], background: '', guides: [] };
}

export function createDoc(name = 'Untitled'): Doc {
  const now = Date.now();
  return {
    format: 'alt',
    version: 1,
    id: uid(),
    name,
    pages: [createPage('Page 1')],
    nodes: {},
    assets: {},
    styles: { colors: [], text: [], effects: [] },
    createdAt: now,
    updatedAt: now,
  };
}

export function isContainer(n: SceneNode | undefined): n is FrameNode | GroupNode | BooleanNode {
  return !!n && (n.type === 'frame' || n.type === 'group' || n.type === 'boolean');
}

export function childrenOf(doc: Doc, parentId: ID): ID[] {
  const n = doc.nodes[parentId];
  if (n) return isContainer(n) ? n.children : [];
  return doc.pages.find((p) => p.id === parentId)?.children ?? [];
}

export function getPage(doc: Doc, pageId: ID): Page | undefined {
  return doc.pages.find((p) => p.id === pageId);
}

/** depth-first walk (back to front) */
export function walk(doc: Doc, ids: ID[], fn: (n: SceneNode, depth: number) => void | false, depth = 0) {
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    if (fn(n, depth) === false) continue;
    if (isContainer(n)) walk(doc, n.children, fn, depth + 1);
  }
}

export function descendants(doc: Doc, id: ID): ID[] {
  const out: ID[] = [];
  const n = doc.nodes[id];
  if (!isContainer(n)) return out;
  walk(doc, n.children, (c) => {
    out.push(c.id);
  });
  return out;
}

export function isAncestor(doc: Doc, ancestorId: ID, id: ID): boolean {
  let cur = doc.nodes[id];
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (cur.parentId === ancestorId) return true;
    cur = doc.nodes[cur.parentId];
  }
  return false;
}

export function depthOf(doc: Doc, id: ID): number {
  let d = 0;
  let cur = doc.nodes[id];
  while (cur && doc.nodes[cur.parentId]) {
    d++;
    cur = doc.nodes[cur.parentId];
  }
  return d;
}

/** Sort ids by z-order (back to front) within the document tree. */
export function sortByZ(doc: Doc, ids: ID[]): ID[] {
  const order = new Map<ID, number>();
  let i = 0;
  for (const p of doc.pages) walk(doc, p.children, (n) => void order.set(n.id, i++));
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Remove ids whose ancestor is also in the list. */
export function topLevelOnly(doc: Doc, ids: ID[]): ID[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let cur = doc.nodes[id];
    while (cur) {
      const p = doc.nodes[cur.parentId];
      if (!p) return true;
      if (set.has(p.id)) return false;
      cur = p;
    }
    return true;
  });
}

export function uniqueName(doc: Doc, parentId: ID, base: string): string {
  const names = new Set(childrenOf(doc, parentId).map((id) => doc.nodes[id]?.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function paintToCss(p: Paint): string {
  if (p.type === 'solid') return hexToRgba(p.color, p.opacity);
  if (p.type === 'linear' || p.type === 'radial' || p.type === 'angular' || p.type === 'diamond') {
    const stops = p.stops.map((s) => `${hexToRgba(s.color, s.opacity * p.opacity)} ${Math.round(s.offset * 100)}%`).join(', ');
    if (p.type === 'linear') {
      const ang = (Math.atan2(p.to.y - p.from.y, p.to.x - p.from.x) * 180) / Math.PI + 90;
      return `linear-gradient(${Math.round(ang)}deg, ${stops})`;
    }
    if (p.type === 'angular') return `conic-gradient(from 90deg at ${p.from.x * 100}% ${p.from.y * 100}%, ${stops})`;
    return `radial-gradient(circle at ${p.from.x * 100}% ${p.from.y * 100}%, ${stops})`;
  }
  if (p.type === 'pattern' || p.type === 'noise') return p.background ? hexToRgba(p.background, p.opacity) : hexToRgba(p.color, p.opacity * 0.5);
  return 'transparent';
}

/* ------------------------------------------------------------- colours */

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '').trim();
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

export function hexToRgba(hex: string, a = 1): string {
  const { r, g, b } = hexToRgb(hex);
  if (a >= 1) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

export function normalizeHex(input: string): string | null {
  let h = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{1,2}$/i.test(h)) h = h.padStart(2, h).repeat(3).slice(0, 6);
  if (/^[0-9a-f]{8}$/i.test(h)) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return '#' + h.toUpperCase();
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const { h } = rgbToHsv(r, g, b);
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const v = l + c / 2;
  const sv = v ? c / v : 0;
  return hsvToRgb(h, sv, v);
}

/** Parse any CSS-ish colour into hex + alpha. */
export function parseColor(input: string): { hex: string; alpha: number } | null {
  const s = input.trim().toLowerCase();
  const hex = normalizeHex(s);
  if (hex && /^#?[0-9a-f]+$/i.test(s)) {
    const raw = s.replace('#', '');
    const alpha = raw.length === 8 ? parseInt(raw.slice(6), 16) / 255 : 1;
    return { hex, alpha };
  }
  let m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v)));
    const [r, g, b] = parts;
    let a = parts[3] ?? 1;
    if (m[1].includes('%') && parts[3] !== undefined && m[1].trim().endsWith('%')) a = parts[3] / 255;
    return { hex: rgbToHex(r, g, b), alpha: a > 1 ? a / 255 : a };
  }
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => parseFloat(v));
    const { r, g, b } = hslToRgb(p[0], p[1] / 100, p[2] / 100);
    return { hex: rgbToHex(r, g, b), alpha: p[3] ?? 1 };
  }
  if (typeof document !== 'undefined') {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000001';
      ctx.fillStyle = s;
      const v = ctx.fillStyle as string;
      if (v !== '#000001' || s === '#000001') {
        if (v.startsWith('#')) return { hex: v.toUpperCase(), alpha: 1 };
        return parseColor(v);
      }
    }
  }
  return null;
}

export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
