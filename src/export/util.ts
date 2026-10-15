/**
 * Shared helpers for the exporters: number formatting, identifiers, colours,
 * gradient maths, bounds, bytes / base64 and small XML / code writers.
 */
import type { Doc, Effect, GradientPaint, GradientStop, ID, Paint, Rect, SceneNode, SolidPaint, Vec } from '../core/types';
import { invert, localMatrix, mul, transformRect, worldMatrix, IDENTITY, type Mat } from '../core/geometry';
import { getPage, hexToRgb, isContainer, sortByZ, topLevelOnly } from '../core/doc';

/* ---------------------------------------------------------------- numbers */

/** Round to at most `p` decimals (default 2) and normalise -0. */
export function r2(n: number, p = 2): number {
  if (!isFinite(n)) return 0;
  const f = 10 ** p;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? 0 : v;
}

/** Number → shortest string with ≤ p decimals. */
export function num(n: number, p = 2): string {
  return String(r2(n, p));
}

export const px = (n: number) => (r2(n) === 0 ? '0' : `${num(n)}px`);

/** Float literal that always carries a decimal point (Dart / Kotlin / GDScript friendly). */
export function flt(n: number, p = 2): string {
  const s = num(n, p);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* -------------------------------------------------------------- roots */

/**
 * Resolve the nodes to export: the selection (top-level only, back → front)
 * or every visible child of the page when nothing is selected.
 */
export function resolveRoots(doc: Doc, pageId: ID, ids: ID[]): ID[] {
  const existing = ids.filter((id) => doc.nodes[id]);
  if (existing.length) return sortByZ(doc, topLevelOnly(doc, existing));
  const page = getPage(doc, pageId) ?? doc.pages[0];
  return (page?.children ?? []).filter((id) => doc.nodes[id]?.visible);
}

/* --------------------------------------------------------------- nodes */

export function visiblePaints<T extends Paint>(paints: T[] | undefined): T[] {
  return (paints ?? []).filter((p) => p.visible !== false && p.opacity > 0);
}

export function visibleEffects(effects: Effect[] | undefined): Effect[] {
  return (effects ?? []).filter((e) => e.visible !== false);
}

export function childNodes(doc: Doc, n: SceneNode, includeHidden = false): SceneNode[] {
  if (!isContainer(n)) return [];
  return n.children.map((id) => doc.nodes[id]).filter((k): k is SceneNode => !!k && (includeHidden || k.visible));
}

export function isGradient(p: Paint): p is GradientPaint {
  return p.type === 'linear' || p.type === 'radial' || p.type === 'angular' || p.type === 'diamond';
}

export function hasRotation(n: Pick<SceneNode, 'rotation'>): boolean {
  return Math.abs(r2(n.rotation, 3)) > 0;
}

/** True when an ellipse node is a plain, full ellipse (no arc / donut). */
export function isPlainEllipse(n: SceneNode): boolean {
  return n.type === 'ellipse' && Math.abs(n.arcSweep) >= 359.999 && n.innerRadius <= 0;
}

/** Shapes that need real vector geometry (no box primitive in most UI toolkits). */
export function isVectorNode(n: SceneNode): boolean {
  switch (n.type) {
    case 'path':
    case 'polygon':
    case 'star':
    case 'brush':
    case 'boolean':
      return true;
    case 'ellipse':
      return !isPlainEllipse(n);
    default:
      return false;
  }
}

/** Uniform corner radius, or null when corners differ. */
export function uniformRadius(n: SceneNode): number | null {
  if (n.type !== 'rect' && n.type !== 'frame') return 0;
  const r = n.cornerRadii ?? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius];
  const max = Math.min(n.width, n.height) / 2;
  const c = r.map((v) => Math.max(0, Math.min(v, max)));
  return c.every((v) => Math.abs(v - c[0]) < 1e-6) ? c[0] : null;
}

/** Clamped [tl, tr, br, bl] radii. */
export function cornerRadii(n: SceneNode): [number, number, number, number] {
  if (n.type !== 'rect' && n.type !== 'frame') return [0, 0, 0, 0];
  const r = n.cornerRadii ?? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius];
  const max = Math.min(n.width, n.height) / 2;
  return r.map((v) => Math.max(0, Math.min(v, max))) as [number, number, number, number];
}

/** Local → root-space matrix of a node relative to an export root (root placed at its own origin). */
export function matrixRelativeTo(doc: Doc, id: ID, rootId: ID): Mat {
  if (id === rootId) return [...IDENTITY];
  return mul(invert(worldMatrix(doc, rootId)), worldMatrix(doc, id));
}

/** Axis-aligned bounds of a node in an export root's local space. */
export function boundsRelativeTo(doc: Doc, id: ID, rootId: ID): Rect {
  const n = doc.nodes[id];
  if (!n) return { x: 0, y: 0, width: 0, height: 0 };
  return transformRect(matrixRelativeTo(doc, id, rootId), { x: 0, y: 0, width: n.width, height: n.height });
}

/** How far a node's stroke reaches outside its box. */
export function strokeOutset(n: SceneNode): number {
  if (!visiblePaints(n.strokes).length || n.strokeWidth <= 0) return 0;
  let w = n.strokeWidth;
  if (n.type === 'path' && (n.startMarker !== 'none' || n.endMarker !== 'none')) w = Math.max(w, 6 * w + 6);
  const closed = n.type !== 'path' || n.paths.every((p) => p.closed);
  const align = closed ? n.strokeAlign : 'center';
  const miter = n.strokeJoin === 'miter' && n.type !== 'rect' && n.type !== 'frame' && n.type !== 'ellipse' ? 2 : 1;
  if (align === 'inside') return 0;
  return (align === 'outside' ? w : w / 2) * miter;
}

/** Symmetric padding needed to contain a node's effects. */
export function effectOutset(n: SceneNode): number {
  let pad = 0;
  for (const e of visibleEffects(n.effects)) {
    if (e.type === 'drop-shadow') pad = Math.max(pad, Math.max(Math.abs(e.x), Math.abs(e.y)) + e.blur * 1.5 + Math.max(0, e.spread));
    else if (e.type === 'glow') pad = Math.max(pad, e.blur * 1.5 + Math.max(0, e.spread));
    else if (e.type === 'layer-blur') pad = Math.max(pad, e.radius * 1.5);
  }
  return pad;
}

export function expand(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * Visual bounds of a node in its own local space: the box plus stroke
 * overflow, unclipped children and (optionally) effects.
 */
export function localVisualBounds(doc: Doc, n: SceneNode, withEffects = true): Rect {
  let r: Rect = expand({ x: 0, y: 0, width: n.width, height: n.height }, strokeOutset(n));
  if (isContainer(n) && n.type !== 'boolean' && !(n.type === 'frame' && n.clipContent)) {
    for (const k of childNodes(doc, n)) r = union(r, transformRect(localMatrix(k), localVisualBounds(doc, k, true)));
  }
  return withEffects ? expand(r, effectOutset(n)) : r;
}

/* ------------------------------------------------------------ identifiers */

const STRIP_ACCENTS = /[̀-ͯ]/g;

/** Split a layer name into lowercase ASCII words. */
export function words(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(STRIP_ACCENTS, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

export const camelCase = (s: string) => words(s).map((w, i) => (i ? cap(w) : w)).join('');
export const pascalCase = (s: string) => words(s).map(cap).join('');
export const snakeCase = (s: string) => words(s).join('_');
export const kebabCase = (s: string) => words(s).join('-');

export type IdentStyle = 'camel' | 'pascal' | 'snake' | 'kebab';

const STYLES: Record<IdentStyle, (s: string) => string> = { camel: camelCase, pascal: pascalCase, snake: snakeCase, kebab: kebabCase };

/** Hands out unique, valid identifiers derived from layer names. */
export class NameRegistry {
  private used = new Set<string>();
  constructor(
    private style: IdentStyle,
    reserved: Iterable<string> = [],
    private opts: { prefixDigits?: string; separator?: string; caseInsensitive?: boolean } = {},
  ) {
    for (const r of reserved) this.used.add(this.key(r));
  }
  private key(s: string) {
    return this.opts.caseInsensitive ? s.toLowerCase() : s;
  }
  /** Mark a name as taken. */
  reserve(name: string) {
    this.used.add(this.key(name));
  }
  has(name: string) {
    return this.used.has(this.key(name));
  }
  get(name: string, fallback = 'layer'): string {
    let base = STYLES[this.style](name) || STYLES[this.style](fallback) || 'layer';
    if (/^[0-9]/.test(base)) {
      const pre = this.opts.prefixDigits ?? (this.style === 'pascal' ? 'Layer' : this.style === 'kebab' ? 'layer-' : this.style === 'snake' ? 'layer_' : 'layer');
      base = pre + base;
    }
    const sep = this.opts.separator ?? (this.style === 'kebab' ? '-' : this.style === 'snake' ? '_' : '');
    let out = base;
    let i = 2;
    while (this.used.has(this.key(out))) out = `${base}${sep}${i++}`;
    this.used.add(this.key(out));
    return out;
  }
}

/** Safe file name (keeps spaces & case, strips path separators / reserved chars). */
export function sanitizeFileName(name: string, fallback = 'Untitled'): string {
  const s = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return s || fallback;
}

/** Gives every file a unique name within one export. */
export class FileNamer {
  private used = new Set<string>();
  get(base: string, ext: string): string {
    const clean = sanitizeFileName(base);
    let name = `${clean}.${ext}`;
    let i = 2;
    while (this.used.has(name.toLowerCase())) name = `${clean} ${i++}.${ext}`;
    this.used.add(name.toLowerCase());
    return name;
  }
}

/* ---------------------------------------------------------------- colours */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** #rrggbb + alpha → 0..255 channels + 0..1 alpha. */
export function rgba(hex: string, alpha = 1): RGBA {
  const { r, g, b } = hexToRgb(hex || '#000000');
  return { r, g, b, a: clamp01(alpha) };
}

const h2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();

/** '#RRGGBB' or '#RRGGBBAA' when translucent. */
export function hexColor(hex: string, alpha = 1): string {
  const c = rgba(hex, alpha);
  const base = `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
  return c.a >= 0.999 ? base : base + h2(c.a * 255);
}

/** 'AARRGGBB' – Flutter / Compose / Android. */
export function argbHex(hex: string, alpha = 1): string {
  const c = rgba(hex, alpha);
  return `${h2(c.a * 255)}${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
}

/** CSS colour: #rrggbb when opaque, rgba() otherwise. */
export function cssColor(hex: string, alpha = 1): string {
  const c = rgba(hex, alpha);
  if (c.a >= 0.999) return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`.toLowerCase();
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${num(c.a, 3)})`;
}

/** 0..1 float channels. */
export function rgb01(hex: string): { r: number; g: number; b: number } {
  const { r, g, b } = hexToRgb(hex || '#000000');
  return { r: r / 255, g: g / 255, b: b / 255 };
}

/** Linear interpolation between two hex colours. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const m = (p: number, q: number) => p + (q - p) * t;
  return `#${h2(m(x.r, y.r))}${h2(m(x.g, y.g))}${h2(m(x.b, y.b))}`;
}

/* -------------------------------------------------------------- gradients */

export function sortedStops(p: GradientPaint): GradientStop[] {
  const s = [...p.stops].sort((a, b) => a.offset - b.offset);
  return s.length ? s : [{ offset: 0, color: '#000000', opacity: 1 }];
}

/** Colour + opacity of a gradient at t (0..1). */
export function sampleStops(stops: GradientStop[], t: number): { color: string; opacity: number } {
  if (!stops.length) return { color: '#000000', opacity: 1 };
  if (t <= stops[0].offset) return { color: stops[0].color, opacity: stops[0].opacity };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.offset) {
      const k = b.offset - a.offset > 1e-9 ? (t - a.offset) / (b.offset - a.offset) : 1;
      return { color: mixHex(a.color, b.color, k), opacity: a.opacity + (b.opacity - a.opacity) * k };
    }
  }
  const last = stops[stops.length - 1];
  return { color: last.color, opacity: last.opacity };
}

export interface GradientGeom {
  /** handles in local px */
  from: Vec;
  to: Vec;
  /** to − from in px */
  dx: number;
  dy: number;
  /** handle distance in px (linear length) */
  length: number;
  /** direction of from → to in px space, radians (0 = +x, clockwise) */
  angle: number;
  /** handle distance in normalised box units (radial / diamond radius) */
  radius: number;
  /** elliptical radii in px of radial / diamond fills (radius × box size) */
  rx: number;
  ry: number;
}

/**
 * Gradient handle geometry in a w×h box, matching the canvas renderer:
 * linear and angular gradients live in pixel space, radial and diamond fills
 * are elliptical in normalised box space (radius = handle distance × w / h).
 */
export function gradientGeom(p: GradientPaint, w: number, h: number): GradientGeom {
  const from = { x: p.from.x * w, y: p.from.y * h };
  const to = { x: p.to.x * w, y: p.to.y * h };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const radius = Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y);
  return { from, to, dx, dy, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx), radius, rx: radius * w, ry: radius * h };
}

/**
 * CSS `linear-gradient` angle (deg, 0 = to top, clockwise) plus the stop
 * remapping from handle space to the CSS gradient line.
 */
export function cssLinear(p: GradientPaint, w: number, h: number): { angle: number; map: (t: number) => number } {
  const g = gradientGeom(p, w, h);
  if (g.length < 1e-6) return { angle: 180, map: (t) => t };
  const ux = g.dx / g.length;
  const uy = g.dy / g.length;
  const angle = (Math.atan2(ux, -uy) * 180) / Math.PI;
  const L = Math.abs(w * ux) + Math.abs(h * uy) || 1;
  // CSS start point = centre − u·L/2
  const sx = w / 2 - (ux * L) / 2;
  const sy = h / 2 - (uy * L) / 2;
  const base = (g.from.x - sx) * ux + (g.from.y - sy) * uy;
  return { angle: (angle + 360) % 360, map: (t) => (base + t * g.length) / L };
}

/** Full CSS gradient for a paint in a w×h box (opacity multiplies stop alpha). */
export function cssGradient(p: GradientPaint, w: number, h: number, opacity = 1): string {
  const stops = sortedStops(p);
  const a = p.opacity * opacity;
  const g = gradientGeom(p, w, h);
  const at = `${num(p.from.x * 100)}% ${num(p.from.y * 100)}%`;
  switch (p.type) {
    case 'linear': {
      const { angle, map } = cssLinear(p, w, h);
      return `linear-gradient(${num(angle)}deg, ${stops.map((s) => `${cssColor(s.color, s.opacity * a)} ${num(map(s.offset) * 100)}%`).join(', ')})`;
    }
    case 'angular': {
      const from = ((g.angle * 180) / Math.PI + 90 + 360) % 360;
      return `conic-gradient(from ${num(from)}deg at ${at}, ${stops.map((s) => `${cssColor(s.color, s.opacity * a)} ${num(s.offset * 100)}%`).join(', ')})`;
    }
    default:
      // radial (and diamond, approximated as radial): elliptical in box space
      return `radial-gradient(${px(Math.max(0.01, g.rx))} ${px(Math.max(0.01, g.ry))} at ${at}, ${stops.map((s) => `${cssColor(s.color, s.opacity * a)} ${num(s.offset * 100)}%`).join(', ')})`;
  }
}

/** A single representative colour for a paint list (top-most visible paint). */
export function representativeColor(paints: Paint[]): { color: string; opacity: number } | null {
  const vis = visiblePaints(paints);
  for (let i = vis.length - 1; i >= 0; i--) {
    const p = vis[i];
    if (p.type === 'solid') return { color: p.color, opacity: p.opacity };
    if (isGradient(p)) {
      const s = sortedStops(p)[0];
      return { color: s.color, opacity: s.opacity * p.opacity };
    }
    if (p.type === 'pattern' || p.type === 'noise') return { color: p.background ?? p.color, opacity: p.opacity };
  }
  return null;
}

export function topSolid(paints: Paint[]): SolidPaint | null {
  const vis = visiblePaints(paints);
  for (let i = vis.length - 1; i >= 0; i--) if (vis[i].type === 'solid') return vis[i] as SolidPaint;
  return null;
}

/* ------------------------------------------------------------------ bytes */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/_-]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    let v = B64.indexOf(ch);
    if (v < 0) v = ch === '-' ? 62 : ch === '_' ? 63 : 0;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < len) out[o++] = (buf >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Decode a data: URL into its mime type and bytes. */
export function dataUrlToBytes(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (m[3]) return { mime, bytes: base64ToBytes(m[4]) };
  return { mime, bytes: utf8(decodeURIComponent(m[4])) };
}

export function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('svg')) return 'svg';
  if (m.includes('avif')) return 'avif';
  return 'bin';
}

/** Pixel size of a PNG / JPEG / GIF / WebP from its header bytes. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32(16), height: u32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1];
      const len = (b[o + 2] << 8) | b[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
      }
      o += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === 'VP8L') {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

/** Natural pixel size of an asset (stored size, or decoded from the header). */
export function assetSize(doc: Doc, assetId: ID): { width: number; height: number } | null {
  const a = doc.assets[assetId];
  if (!a) return null;
  if (a.width && a.height) return { width: a.width, height: a.height };
  const comma = a.data.indexOf(',');
  if (!a.data.startsWith('data:') || comma < 0 || !a.data.slice(0, comma).includes(';base64')) return null;
  // the header is almost always within the first 64 KB
  const head = a.data.slice(comma + 1, comma + 1 + 87384);
  const quick = imageSize(base64ToBytes(head.slice(0, head.length - (head.length % 4))));
  if (quick) return quick;
  const all = dataUrlToBytes(a.data);
  return all ? imageSize(all.bytes) : null;
}

/* ------------------------------------------------------------- XML / text */

export function xmlEscape(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function xmlAttr(s: string): string {
  return xmlEscape(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
}

/** Minimal XML element tree used by SVG / XML based exporters. */
export interface XEl {
  tag: string;
  attrs: Record<string, string | number | undefined | null>;
  children: (XEl | string)[];
  /** serialise children without whitespace (mixed content such as <text>) */
  inline?: boolean;
  /** emitted as an XML comment before the element */
  comment?: string;
}

export function el(tag: string, attrs: XEl['attrs'] = {}, children: (XEl | string | null | undefined | false)[] = []): XEl {
  return { tag, attrs, children: children.filter((c): c is XEl | string => !!c || c === '') };
}

function attrValue(v: string | number): string {
  return typeof v === 'number' ? num(v) : v;
}

export function serializeXml(e: XEl | string, indent = '  ', level = 0, inline = false): string {
  const pad = inline ? '' : indent.repeat(level);
  if (typeof e === 'string') return pad + xmlEscape(e);
  const attrs = Object.entries(e.attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${xmlAttr(attrValue(v as string | number))}"`)
    .join('');
  const comment = e.comment && !inline ? `${pad}<!-- ${e.comment.replace(/--/g, '—')} -->\n` : '';
  if (!e.children.length) return `${comment}${pad}<${e.tag}${attrs}/>`;
  if (e.inline || inline) {
    const inner = e.children.map((c) => serializeXml(c, indent, 0, true)).join('');
    return `${comment}${pad}<${e.tag}${attrs}>${inner}</${e.tag}>`;
  }
  const inner = e.children.map((c) => serializeXml(c, indent, level + 1)).join('\n');
  return `${comment}${pad}<${e.tag}${attrs}>\n${inner}\n${pad}</${e.tag}>`;
}

/* ------------------------------------------------------------------- JSX */

const JSX_ATTR: Record<string, string> = { class: 'className', for: 'htmlFor', 'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace', 'xmlns:xlink': 'xmlnsXlink' };

export function jsxAttrName(name: string): string {
  if (JSX_ATTR[name]) return JSX_ATTR[name];
  if (/^(data|aria)-/.test(name)) return name;
  return name.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** CSS declaration text → React style object literal. */
export function cssTextToJsxObject(css: string): string {
  const parts = css
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':');
      const k = d.slice(0, i).trim();
      const v = d.slice(i + 1).trim();
      const key = k.startsWith('--') ? `'${k}'` : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return `${key}: ${jsString(v)}`;
    });
  return `{ ${parts.join(', ')} }`;
}

export function jsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`;
}

/** Serialise an element tree as JSX. */
export function serializeJsx(e: XEl | string, indent = '  ', level = 0): string {
  const pad = indent.repeat(level);
  if (typeof e === 'string') return `${pad}{${jsString(e)}}`;
  const attrs = Object.entries(e.attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const name = jsxAttrName(k);
      if (k === 'style') return ` style={${cssTextToJsxObject(String(v))}}`;
      if (typeof v === 'number') return ` ${name}={${num(v)}}`;
      const s = String(v);
      return /["{}<>\n]/.test(s) || s.length > 300 ? ` ${name}={${jsString(s)}}` : ` ${name}="${s}"`;
    })
    .join('');
  if (!e.children.length) return `${pad}<${e.tag}${attrs} />`;
  if (e.inline) {
    const inner = e.children.map((c) => (typeof c === 'string' ? `{${jsString(c)}}` : serializeJsx(c, indent, 0))).join('');
    return `${pad}<${e.tag}${attrs}>${inner}</${e.tag}>`;
  }
  const inner = e.children.map((c) => serializeJsx(c, indent, level + 1)).join('\n');
  return `${pad}<${e.tag}${attrs}>\n${inner}\n${pad}</${e.tag}>`;
}

/* ------------------------------------------------------------ code writer */

/** Indentation-aware line builder for generated source code. */
export class CodeWriter {
  private lines: string[] = [];
  private level = 0;
  constructor(private unit = '  ') {}
  line(s = ''): this {
    this.lines.push(s ? this.unit.repeat(this.level) + s : '');
    return this;
  }
  /** Add several pre-formatted lines at the current indentation. */
  lines_(text: string): this {
    for (const l of text.split('\n')) this.line(l);
    return this;
  }
  indent(fn: () => void): this {
    this.level++;
    fn();
    this.level--;
    return this;
  }
  /** `open` line, indented body, `close` line. */
  block(open: string, fn: () => void, close = '}'): this {
    this.line(open);
    this.indent(fn);
    return this.line(close);
  }
  blank(): this {
    if (this.lines.length && this.lines[this.lines.length - 1] !== '') this.lines.push('');
    return this;
  }
  get depth() {
    return this.level;
  }
  toString(): string {
    return this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
}

/* ------------------------------------------------------------------ misc */

/** Common text MIME types. */
export const MIME = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  html: 'text/html',
  css: 'text/css',
  json: 'application/json',
  xml: 'application/xml',
  tsx: 'text/typescript',
  swift: 'text/x-swift',
  dart: 'text/x-dart',
  kotlin: 'text/x-kotlin',
  lua: 'text/x-lua',
  tscn: 'text/plain',
  rbxmx: 'application/xml',
  uxml: 'application/xml',
  uss: 'text/css',
} as const;

/** Collect every asset an export subtree references (image fills + bitmaps). */
export function collectAssets(doc: Doc, rootIds: ID[]): Set<ID> {
  const out = new Set<ID>();
  const visit = (id: ID) => {
    const n = doc.nodes[id];
    if (!n) return;
    for (const p of [...n.fills, ...n.strokes]) if (p.type === 'image' && doc.assets[p.assetId]) out.add(p.assetId);
    if (n.type === 'bitmap' && doc.assets[n.assetId]) out.add(n.assetId);
    if (isContainer(n)) n.children.forEach(visit);
  };
  rootIds.forEach(visit);
  return out;
}

/** Display / file name for an asset. */
export function assetBaseName(doc: Doc, assetId: ID, fallback = 'image'): string {
  const a = doc.assets[assetId];
  const raw = (a?.name ?? fallback).replace(/\.[a-z0-9]{2,5}$/i, '');
  return kebabCase(raw) || fallback;
}

/* ------------------------------------------------------------------ fonts */

const MONO = /mono|code|courier|consol|menlo|monaco|inconsolata|hack|fira code|jetbrains|source code/i;
const SERIF = /serif|times|georgia|garamond|baskerville|merriweather|playfair|lora|didot|bodoni|cambria|palatino|crimson|libre caslon|noto serif|pt serif/i;
const CURSIVE = /script|hand|brush|comic|cursive|dancing|pacifico|caveat|kalam|marker/i;

/** Generic CSS family that best matches a font name. */
export function genericFamily(family: string): 'sans-serif' | 'serif' | 'monospace' | 'cursive' {
  if (MONO.test(family)) return 'monospace';
  if (/sans/i.test(family)) return 'sans-serif';
  if (SERIF.test(family)) return 'serif';
  if (CURSIVE.test(family)) return 'cursive';
  return 'sans-serif';
}

/** CSS font stack: `"Inter", sans-serif` (quote char configurable for attributes). */
export function fontStack(family: string, quote = '"'): string {
  const name = family.trim() || 'sans-serif';
  const quoted = /^[a-z-]+$/i.test(name) && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(name) ? name : `${quote}${name}${quote}`;
  const generic = genericFamily(name);
  return /^(serif|sans-serif|monospace|cursive|system-ui)$/i.test(name) ? name : `${quoted}, ${generic}`;
}

const SYSTEM_FONTS = /^(arial|helvetica|helvetica neue|times|times new roman|georgia|verdana|tahoma|trebuchet ms|courier|courier new|system-ui|-apple-system|sf pro|sf pro text|sf pro display|segoe ui|menlo|monaco|consolas|impact|comic sans ms|sans-serif|serif|monospace|cursive)$/i;

export function isSystemFont(family: string): boolean {
  return SYSTEM_FONTS.test(family.trim());
}
