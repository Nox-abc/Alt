/**
 * Renderer-side MCP tool execution.
 *
 * The Electron main process forwards `tools/call` requests here (see
 * registerMcp.ts). Every mutating tool goes through `useEditor.mutate` so it is
 * a single undoable step that selects what it touched.
 */
import type { McpContent, McpToolRequest, McpToolResult } from '../platform/native';
import { native } from '../platform/native';
import type {
  AutoLayout,
  Doc,
  Effect,
  EffectType,
  GradientPaint,
  GradientStop,
  ID,
  ImagePaint,
  NodeType,
  Paint,
  PathNode,
  SceneNode,
  ShadowEffect,
  Vec,
} from '../core/types';
import { useEditor } from '../core/store';
import {
  childrenOf,
  createNode,
  defaultEffect,
  getPage,
  gradient,
  isContainer,
  parseColor,
  solid,
  sortByZ,
  topLevelOnly,
  uid,
  walk,
} from '../core/doc';
import * as ops from '../core/ops';
import { apply, normalizeAngle, pageOf, selectionBounds, unionRects, worldBounds } from '../core/geometry';
import { cmdsBounds, cmdsToSubPaths, cmdsToSvgD, parseSvgPath, subPathsToCmds, transformCmds } from '../core/path';
import { measureTextBox } from '../core/text';
import { resizeContent } from '../core/layout';
import type { ClipboardData } from '../core/ops';
import type { Exporter } from '../export/types';
import { rasterize } from '../render/rasterize';
import { MCP_TOOLS, isScriptTool } from './mcpTools';

/* ================================================================ basics */

class ToolError extends Error {}

type Args = Record<string, unknown>;
type Spec = Record<string, unknown>;

const editor = () => useEditor.getState();
const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const okJson = (v: unknown): McpToolResult => ok(JSON.stringify(v));
const fail = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: true });
const r2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => o[k] !== undefined;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function num(v: unknown, name: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`"${name}" must be a number (got ${JSON.stringify(v)})`);
  return n;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function oneOf<T extends string>(v: unknown, values: readonly T[], name: string, aliases: Record<string, T> = {}): T {
  const s = typeof v === 'string' ? v.trim() : '';
  const key = s.toLowerCase();
  if ((values as readonly string[]).includes(s)) return s as T;
  if (aliases[key]) return aliases[key];
  const ci = values.find((x) => x.toLowerCase() === key);
  if (ci) return ci;
  throw new ToolError(`"${name}" must be one of ${values.map((x) => JSON.stringify(x)).join(', ')} (got ${JSON.stringify(v)})`);
}

function idList(v: unknown, name = 'ids', allowEmpty = false): ID[] {
  const arr = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) throw new ToolError(`"${name}" must be an array of node id strings`);
  if (!allowEmpty && !arr.length) throw new ToolError(`"${name}" must not be empty`);
  return [...new Set(arr as string[])];
}

function existingIds(doc: Doc, v: unknown, name = 'ids', allowEmpty = false): ID[] {
  const ids = idList(v, name, allowEmpty);
  const missing = ids.filter((id) => !doc.nodes[id]);
  if (missing.length) throw new ToolError(`Unknown node id${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use get_tree or find_nodes to look ids up.`);
  return ids;
}

function isPage(doc: Doc, id: ID) {
  return doc.pages.some((p) => p.id === id);
}

function pageIdOf(doc: Doc, id: ID): ID {
  if (isPage(doc, id)) return id;
  return pageOf(doc, id) ?? editor().pageId;
}

/** Validate a page or container id to insert into. */
function containerId(doc: Doc, v: unknown, name = 'parentId'): ID {
  if (v === undefined || v === null || v === '') return editor().pageId;
  if (typeof v !== 'string') throw new ToolError(`"${name}" must be a page or node id string`);
  if (isPage(doc, v)) return v;
  const n = doc.nodes[v];
  if (!n) throw new ToolError(`Unknown ${name} "${v}" — it must be a page id or the id of a frame / group / boolean.`);
  if (!isContainer(n)) throw new ToolError(`${name} "${v}" is a ${n.type} ("${n.name}"), which cannot have children. Use a frame, group or boolean (or a page).`);
  return v;
}

/** Bring the page the agent works on into view (clears selection when it changes). */
function showPage(pageId: ID) {
  const s = editor();
  if (s.pageId !== pageId && getPage(s.doc, pageId)) s.setPage(pageId);
}

function samePage(doc: Doc, ids: ID[]): ID {
  const pages = new Set(ids.map((id) => pageIdOf(doc, id)));
  if (pages.size > 1) throw new ToolError('All nodes must be on the same page for this tool.');
  return [...pages][0] ?? editor().pageId;
}

function boundsOf(doc: Doc, id: ID) {
  const b = worldBounds(doc, id);
  return { x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) };
}

function emitActivity(tool: string, phase: 'start' | 'end', ok?: boolean) {
  try {
    window.dispatchEvent(new CustomEvent('alt:mcp-activity', { detail: { tool, phase, ok } }));
  } catch {
    /* non-DOM environment */
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ============================================================ summaries */

function firstFill(n: SceneNode): string | undefined {
  const p = n.fills.find((f) => f.visible !== false);
  if (!p) return undefined;
  if (p.type === 'solid') return p.opacity < 1 ? `${p.color}@${r2(p.opacity)}` : p.color;
  if (p.type === 'image') return 'image';
  return `${p.type}-${p.type === 'pattern' || p.type === 'noise' ? 'paint' : 'gradient'}`;
}

function nodeSummary(doc: Doc, n: SceneNode): Record<string, unknown> {
  const o: Record<string, unknown> = { id: n.id, type: n.type, name: n.name, x: r2(n.x), y: r2(n.y), w: r2(n.width), h: r2(n.height) };
  if (n.rotation) o.r = r2(n.rotation);
  if (!n.visible) o.hidden = true;
  if (n.locked) o.locked = true;
  if (n.opacity < 1) o.opacity = r2(n.opacity);
  const fill = firstFill(n);
  if (fill) o.fill = fill;
  if (n.strokes.some((s) => s.visible !== false) && n.strokeWidth > 0) {
    const s = n.strokes.find((x) => x.visible !== false)!;
    o.stroke = `${s.type === 'solid' ? s.color : s.type} ${r2(n.strokeWidth)}`;
  }
  if (n.type === 'text') {
    o.text = trunc(n.text, 80);
    o.font = `${n.fontFamily} ${n.fontWeight} ${r2(n.fontSize)}`;
  }
  if ((n.type === 'frame' || n.type === 'rect') && (n.cornerRadius || n.cornerRadii)) o.radius = n.cornerRadii ?? r2(n.cornerRadius);
  if (n.type === 'frame') {
    if (n.layout) {
      const L = n.layout;
      o.layout = `${L.mode} gap ${r2(L.gap)} pad ${L.padding.map(r2).join(',')} align ${L.align} justify ${L.justify}${L.wrap ? ' wrap' : ''}`;
    }
    if (n.isComponent) o.component = true;
    if (!n.clipContent) o.clip = false;
  }
  if (n.type === 'boolean') o.op = n.op;
  if (n.sizingH !== 'fixed' || n.sizingV !== 'fixed') o.sizing = `${n.sizingH}/${n.sizingV}`;
  if (n.layoutPositioning === 'absolute') o.absolute = true;
  if (n.isMask) o.mask = true;
  return o;
}

function treeOf(doc: Doc, id: ID, depth: number, maxDepth: number, includeHidden: boolean): Record<string, unknown> | null {
  const n = doc.nodes[id];
  if (!n || (!includeHidden && !n.visible)) return null;
  const o = nodeSummary(doc, n);
  if (isContainer(n)) {
    if (depth < maxDepth) {
      o.children = n.children.map((c) => treeOf(doc, c, depth + 1, maxDepth, includeHidden)).filter(Boolean);
    } else if (n.children.length) o.childCount = n.children.length;
  }
  return o;
}

/** Full node JSON with large data elided. */
function nodeDetail(doc: Doc, n: SceneNode): Record<string, unknown> {
  const o = JSON.parse(JSON.stringify(n)) as Record<string, unknown>;
  if (n.type === 'path') {
    delete o.paths;
    o.d = cmdsToSvgD(subPathsToCmds(n.paths));
  }
  if (n.type === 'brush') {
    delete o.points;
    o.pointCount = n.points.length;
  }
  o.absoluteBounds = boundsOf(doc, n.id);
  o.pageId = pageIdOf(doc, n.id);
  const assetIds = new Set<ID>();
  for (const p of [...n.fills, ...n.strokes]) if (p.type === 'image') assetIds.add(p.assetId);
  if (n.type === 'bitmap' && n.assetId) assetIds.add(n.assetId);
  if (assetIds.size) {
    o.assets = [...assetIds].map((aid) => {
      const a = doc.assets[aid];
      return a ? { id: aid, mime: a.mime, width: a.width, height: a.height, name: a.name, bytes: Math.round((a.data.length * 3) / 4) } : { id: aid, missing: true };
    });
  }
  return o;
}

/* ========================================================== value parsing */

function colorOf(v: unknown, name: string): { hex: string; alpha: number } {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`"${name}" must be a colour string (e.g. "#1E293B")`);
  const c = parseColor(v);
  if (!c) throw new ToolError(`Invalid colour ${JSON.stringify(v)} for "${name}". Use hex (#RRGGBB / #RRGGBBAA), rgb(), hsl() or a CSS colour name.`);
  return { hex: c.hex.toUpperCase(), alpha: clamp(Number.isFinite(c.alpha) ? c.alpha : 1, 0, 1) };
}

const GRADIENT_TYPES = ['linear', 'radial', 'angular', 'diamond'] as const;
const BLEND_MODES = [
  'normal',
  'darken',
  'multiply',
  'color-burn',
  'lighten',
  'screen',
  'color-dodge',
  'plus-lighter',
  'overlay',
  'soft-light',
  'hard-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;
const IMAGE_FITS = ['fill', 'fit', 'crop', 'tile', 'stretch'] as const;
const PATTERNS = ['dots', 'grid', 'lines', 'diagonal', 'checker', 'cross', 'waves', 'zigzag', 'triangles', 'hexagons'] as const;
const EFFECT_TYPES = ['drop-shadow', 'inner-shadow', 'glow', 'layer-blur', 'background-blur', 'noise', 'adjust'] as const;
const MARKERS = ['none', 'arrow', 'triangle', 'circle', 'square', 'diamond', 'bar'] as const;
const SIZING = ['fixed', 'hug', 'fill'] as const;

interface ImageInfo {
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
}

/** Per-call context for building nodes. */
interface BuildCtx {
  d: Doc;
  images: Map<string, ImageInfo>;
  warnings: string[];
  assetByData?: Map<string, ID>;
}

function vecOf(v: unknown, name: string): Vec {
  if (Array.isArray(v) && v.length >= 2) return { x: num(v[0], name), y: num(v[1], name) };
  if (isObj(v)) return { x: num(v.x, `${name}.x`), y: num(v.y, `${name}.y`) };
  throw new ToolError(`"${name}" must be {x, y}`);
}

function paintCommon<T extends Paint>(p: T, o: Record<string, unknown>, alpha = 1): T {
  p.opacity = clamp((has(o, 'opacity') ? num(o.opacity, 'paint.opacity') : 1) * alpha, 0, 1);
  if (has(o, 'visible')) p.visible = !!o.visible;
  if (has(o, 'blendMode')) p.blendMode = oneOf(o.blendMode, BLEND_MODES, 'paint.blendMode');
  return p;
}

function ensureAsset(ctx: BuildCtx, info: ImageInfo): ID {
  const { d } = ctx;
  if (!ctx.assetByData) {
    ctx.assetByData = new Map();
    for (const a of Object.values(d.assets)) ctx.assetByData.set(a.data, a.id);
  }
  const existing = ctx.assetByData.get(info.dataUrl);
  if (existing && d.assets[existing]) return existing;
  const id = 'asset_' + uid();
  d.assets[id] = { id, mime: info.mime, data: info.dataUrl, width: info.width || undefined, height: info.height || undefined };
  ctx.assetByData.set(info.dataUrl, id);
  return id;
}

function imageInfoFor(ctx: BuildCtx, src: unknown): ImageInfo {
  if (typeof src !== 'string' || !src) throw new ToolError('Image source must be a URL, data: URL or absolute file path string');
  const info = ctx.images.get(src);
  if (!info) throw new ToolError(`Image ${trunc(src, 80)} could not be loaded`);
  return info;
}

function imagePaint(ctx: BuildCtx, src: unknown, fit?: unknown, o: Record<string, unknown> = {}): ImagePaint {
  const info = imageInfoFor(ctx, src);
  const p: ImagePaint = {
    id: uid(),
    type: 'image',
    assetId: ensureAsset(ctx, info),
    fit: fit !== undefined ? oneOf(fit, IMAGE_FITS, 'imageFit', { cover: 'fill', contain: 'fit' }) : 'fill',
    scale: has(o, 'scale') ? num(o.scale, 'paint.scale') : 1,
    rotation: has(o, 'rotation') ? num(o.rotation, 'paint.rotation') : 0,
    opacity: 1,
    visible: true,
  };
  if (isObj(o.filters)) p.filters = o.filters as ImagePaint['filters'];
  return paintCommon(p, o);
}

function gradientPaint(type: GradientPaint['type'], o: Record<string, unknown>): GradientPaint {
  let stops: GradientStop[];
  if (Array.isArray(o.stops) && o.stops.length) {
    stops = o.stops.map((s, i) => {
      if (typeof s === 'string') {
        const c = colorOf(s, `stops[${i}]`);
        return { offset: o.stops && (o.stops as unknown[]).length > 1 ? i / ((o.stops as unknown[]).length - 1) : 0, color: c.hex, opacity: c.alpha };
      }
      if (!isObj(s)) throw new ToolError(`stops[${i}] must be {offset, color, opacity?}`);
      const c = colorOf(s.color, `stops[${i}].color`);
      let off = num(s.offset ?? s.position ?? (i / Math.max(1, (o.stops as unknown[]).length - 1)), `stops[${i}].offset`);
      if (off > 1) off /= 100;
      return { offset: clamp(off, 0, 1), color: c.hex, opacity: clamp(c.alpha * (has(s, 'opacity') ? num(s.opacity, `stops[${i}].opacity`) : 1), 0, 1) };
    });
  } else if (Array.isArray(o.colors) && o.colors.length) {
    const cs = o.colors as unknown[];
    stops = cs.map((c, i) => {
      const k = colorOf(c, `colors[${i}]`);
      return { offset: cs.length > 1 ? i / (cs.length - 1) : 0, color: k.hex, opacity: k.alpha };
    });
  } else throw new ToolError('Gradients need `stops: [{offset, color}]` or `colors: [...]`');
  if (stops.length === 1) stops.push({ ...stops[0], offset: 1 });
  stops.sort((a, b) => a.offset - b.offset);
  const g = gradient(type);
  g.stops = stops;
  if (type === 'linear') {
    if (has(o, 'from') || has(o, 'to')) {
      g.from = has(o, 'from') ? vecOf(o.from, 'from') : g.from;
      g.to = has(o, 'to') ? vecOf(o.to, 'to') : g.to;
    } else {
      const a = ((has(o, 'angle') ? num(o.angle, 'angle') : 180) * Math.PI) / 180;
      const dx = Math.sin(a) / 2;
      const dy = -Math.cos(a) / 2;
      g.from = { x: r2(0.5 - dx), y: r2(0.5 - dy) };
      g.to = { x: r2(0.5 + dx), y: r2(0.5 + dy) };
    }
  } else {
    const c = has(o, 'from') ? vecOf(o.from, 'from') : has(o, 'center') ? vecOf(o.center, 'center') : { x: 0.5, y: 0.5 };
    g.from = c;
    if (has(o, 'to')) g.to = vecOf(o.to, 'to');
    else {
      const rad = has(o, 'radius') ? num(o.radius, 'radius') : 0.5;
      const a = ((has(o, 'angle') ? num(o.angle, 'angle') : 90) * Math.PI) / 180;
      g.to = { x: c.x + Math.sin(a) * rad, y: c.y - Math.cos(a) * rad };
    }
  }
  return paintCommon(g, o);
}

/** Parse one paint value. null → "no paint". */
function toPaint(ctx: BuildCtx, v: unknown, name: string): Paint | null {
  if (v === null || v === false || v === undefined) return null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'none' || s === 'transparent') return null;
    const c = colorOf(v, name);
    return solid(c.hex, c.alpha);
  }
  if (!isObj(v)) throw new ToolError(`Invalid paint for "${name}": ${JSON.stringify(v)}`);
  const o = v;
  const type =
    typeof o.type === 'string'
      ? o.type.toLowerCase()
      : o.stops || o.colors
        ? 'linear'
        : o.src || o.url || o.image
          ? 'image'
          : o.color
            ? 'solid'
            : '';
  if (type === 'solid') {
    const c = colorOf(o.color, `${name}.color`);
    return paintCommon(solid(c.hex, 1), o, c.alpha);
  }
  if ((GRADIENT_TYPES as readonly string[]).includes(type)) return gradientPaint(type as GradientPaint['type'], o);
  if (type === 'linear-gradient' || type === 'gradient') return gradientPaint('linear', o);
  if (type === 'radial-gradient') return gradientPaint('radial', o);
  if (type === 'image') return imagePaint(ctx, o.src ?? o.url ?? o.image, o.fit, o);
  if (type === 'pattern') {
    const c = colorOf(o.color ?? '#000000', `${name}.color`);
    return paintCommon(
      {
        id: uid(),
        type: 'pattern',
        pattern: has(o, 'pattern') ? oneOf(o.pattern, PATTERNS, `${name}.pattern`) : 'dots',
        color: c.hex,
        background: has(o, 'background') && o.background ? colorOf(o.background, `${name}.background`).hex : null,
        scale: has(o, 'scale') ? num(o.scale, 'scale') : 12,
        rotation: has(o, 'rotation') ? num(o.rotation, 'rotation') : 0,
        weight: has(o, 'weight') ? clamp(num(o.weight, 'weight'), 0, 1) : 0.3,
        opacity: 1,
        visible: true,
      },
      o,
      c.alpha,
    );
  }
  if (type === 'noise') {
    const c = colorOf(o.color ?? '#000000', `${name}.color`);
    return paintCommon(
      {
        id: uid(),
        type: 'noise',
        color: c.hex,
        background: has(o, 'background') && o.background ? colorOf(o.background, `${name}.background`).hex : null,
        density: has(o, 'density') ? clamp(num(o.density, 'density'), 0, 1) : 0.5,
        size: has(o, 'size') ? num(o.size, 'size') : 1,
        seed: has(o, 'seed') ? num(o.seed, 'seed') : Math.floor(Math.random() * 1e6),
        opacity: 1,
        visible: true,
      },
      o,
      c.alpha,
    );
  }
  throw new ToolError(`Unknown paint type ${JSON.stringify(o.type)} for "${name}" (use solid, linear, radial, angular, diamond, image, pattern or noise)`);
}

function paintList(ctx: BuildCtx, v: unknown, name: string): Paint[] {
  if (Array.isArray(v)) return v.map((p, i) => toPaint(ctx, p, `${name}[${i}]`)).filter((p): p is Paint => !!p);
  const p = toPaint(ctx, v, name);
  return p ? [p] : [];
}

function toEffect(v: unknown, name: string): Effect {
  if (!isObj(v)) throw new ToolError(`"${name}" must be an effect object with a "type"`);
  const type = oneOf(v.type, EFFECT_TYPES, `${name}.type`, { 'drop shadow': 'drop-shadow', shadow: 'drop-shadow', 'inner shadow': 'inner-shadow', blur: 'layer-blur' }) as EffectType;
  const e = defaultEffect(type) as unknown as Record<string, unknown>;
  for (const [k, val] of Object.entries(v)) {
    if (k === 'type' || k === 'id' || !(k in e) || val === undefined) continue;
    if (k === 'color') {
      const c = colorOf(val, `${name}.color`);
      e.color = c.hex;
      if (!has(v, 'opacity') && c.alpha < 1) e.opacity = c.alpha;
    } else if (typeof e[k] === 'number') e[k] = num(val, `${name}.${k}`);
    else if (typeof e[k] === 'boolean') e[k] = !!val;
  }
  return e as unknown as Effect;
}

function toShadow(v: unknown, name: string): ShadowEffect {
  if (v === true) return { ...(defaultEffect('drop-shadow') as ShadowEffect), y: 4, blur: 16, opacity: 0.12 };
  if (!isObj(v)) throw new ToolError(`"${name}" must be a shadow object {x, y, blur, spread, color}`);
  const inner = v.inner === true || v.type === 'inner-shadow';
  const e = defaultEffect(inner ? 'inner-shadow' : 'drop-shadow') as ShadowEffect;
  if (has(v, 'x') || has(v, 'offsetX')) e.x = num(v.x ?? v.offsetX, `${name}.x`);
  if (has(v, 'y') || has(v, 'offsetY')) e.y = num(v.y ?? v.offsetY, `${name}.y`);
  if (has(v, 'blur') || has(v, 'radius')) e.blur = Math.max(0, num(v.blur ?? v.radius, `${name}.blur`));
  if (has(v, 'spread')) e.spread = num(v.spread, `${name}.spread`);
  let alpha = 1;
  if (has(v, 'color')) {
    const c = colorOf(v.color, `${name}.color`);
    e.color = c.hex;
    alpha = c.alpha;
  }
  e.opacity = has(v, 'opacity') ? clamp(num(v.opacity, `${name}.opacity`), 0, 1) : alpha < 1 ? alpha : e.opacity;
  if (has(v, 'visible')) e.visible = !!v.visible;
  return e;
}

function parsePadding(v: unknown): [number, number, number, number] {
  if (typeof v === 'number' || typeof v === 'string') {
    const n = num(v, 'padding');
    return [n, n, n, n];
  }
  if (Array.isArray(v)) {
    const a = v.map((x, i) => num(x, `padding[${i}]`));
    if (a.length === 1) return [a[0], a[0], a[0], a[0]];
    if (a.length === 2) return [a[0], a[1], a[0], a[1]];
    if (a.length === 3) return [a[0], a[1], a[2], a[1]];
    if (a.length >= 4) return [a[0], a[1], a[2], a[3]];
  }
  if (isObj(v)) {
    const g = (k: string[], fb: number) => {
      for (const key of k) if (has(v, key)) return num(v[key], `padding.${key}`);
      return fb;
    };
    const vert = g(['vertical', 'y'], 0);
    const hor = g(['horizontal', 'x'], 0);
    return [g(['top'], vert), g(['right'], hor), g(['bottom'], vert), g(['left'], hor)];
  }
  throw new ToolError('"padding" must be a number, [v, h], [top, right, bottom, left] or {top, right, bottom, left}');
}

const ALIGN_ALIASES: Record<string, AutoLayout['align']> = { 'flex-start': 'start', left: 'start', top: 'start', 'flex-end': 'end', right: 'end', bottom: 'end', middle: 'center' };
const JUSTIFY_ALIASES: Record<string, AutoLayout['justify']> = {
  'flex-start': 'start',
  left: 'start',
  top: 'start',
  'flex-end': 'end',
  right: 'end',
  bottom: 'end',
  middle: 'center',
  between: 'space-between',
  spacebetween: 'space-between',
  'space between': 'space-between',
};

/** Merge an autoLayout spec into an existing layout (or defaults). */
function toLayout(v: Record<string, unknown>, existing: AutoLayout | null): AutoLayout {
  const L: AutoLayout = existing ? { ...existing, padding: [...existing.padding] as AutoLayout['padding'] } : { mode: 'vertical', gap: 0, padding: [0, 0, 0, 0], align: 'start', justify: 'start', wrap: false };
  if (has(v, 'mode') || has(v, 'direction')) L.mode = oneOf(v.mode ?? v.direction, ['horizontal', 'vertical'] as const, 'autoLayout.mode', { row: 'horizontal', column: 'vertical', h: 'horizontal', v: 'vertical' });
  if (has(v, 'gap') || has(v, 'spacing') || has(v, 'itemSpacing')) L.gap = num(v.gap ?? v.spacing ?? v.itemSpacing, 'autoLayout.gap');
  if (has(v, 'padding')) L.padding = parsePadding(v.padding);
  for (const [k, i] of [
    ['paddingTop', 0],
    ['paddingRight', 1],
    ['paddingBottom', 2],
    ['paddingLeft', 3],
  ] as const)
    if (has(v, k)) L.padding[i] = num(v[k], `autoLayout.${k}`);
  if (has(v, 'align') || has(v, 'alignItems')) L.align = oneOf(v.align ?? v.alignItems, ['start', 'center', 'end', 'stretch'] as const, 'autoLayout.align', ALIGN_ALIASES);
  if (has(v, 'justify') || has(v, 'justifyContent')) L.justify = oneOf(v.justify ?? v.justifyContent, ['start', 'center', 'end', 'space-between'] as const, 'autoLayout.justify', JUSTIFY_ALIASES);
  if (has(v, 'wrap')) L.wrap = !!v.wrap;
  return L;
}

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

function fontWeightOf(v: unknown): number {
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) {
    const w = FONT_WEIGHTS[v.toLowerCase().replace(/[\s_-]/g, '')];
    if (!w) throw new ToolError(`Unknown fontWeight ${JSON.stringify(v)} (use 100–900 or thin…black)`);
    return w;
  }
  return clamp(Math.round(num(v, 'fontWeight') / 100) * 100 || 400, 100, 900);
}

/* ======================================================== applying props */

const TEXT_PROPS = ['text', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'textAlign', 'verticalAlign', 'textDecoration', 'textCase', 'autoResize'];

/**
 * Apply convenience props to a node. Size (width/height) is handled by the
 * caller because creation and updates treat it differently.
 */
function applyProps(ctx: BuildCtx, n: SceneNode, p: Spec, creating: boolean) {
  const N = n as unknown as Record<string, unknown>;
  const where = `${n.name || n.type} (${n.id})`;
  const warn = (m: string) => ctx.warnings.push(`${where}: ${m}`);

  if (has(p, 'name')) N.name = String(p.name);
  if (has(p, 'x')) N.x = num(p.x, 'x');
  if (has(p, 'y')) N.y = num(p.y, 'y');
  if (has(p, 'rotation')) N.rotation = normalizeAngle(num(p.rotation, 'rotation'));
  if (has(p, 'opacity')) N.opacity = clamp(num(p.opacity, 'opacity'), 0, 1);
  for (const k of ['visible', 'locked', 'flipX', 'flipY', 'isMask'] as const) if (has(p, k)) N[k] = !!p[k];
  if (has(p, 'blendMode')) N.blendMode = oneOf(p.blendMode, BLEND_MODES, 'blendMode');

  // paints
  const fillInput = has(p, 'fill') ? p.fill : has(p, 'color') ? p.color : undefined;
  if (fillInput !== undefined || ('fill' in p && p.fill === null)) n.fills = paintList(ctx, fillInput ?? null, 'fill');
  if (has(p, 'fills')) {
    if (!Array.isArray(p.fills)) throw new ToolError('"fills" must be an array');
    n.fills = paintList(ctx, p.fills, 'fills');
  }
  if (has(p, 'image')) n.fills = [imagePaint(ctx, p.image, p.imageFit)];
  else if (has(p, 'imageFit')) {
    const fit = oneOf(p.imageFit, IMAGE_FITS, 'imageFit', { cover: 'fill', contain: 'fit' });
    n.fills = n.fills.map((f) => (f.type === 'image' ? { ...f, fit } : f));
  }
  if (has(p, 'stroke') || ('stroke' in p && p.stroke === null)) n.strokes = paintList(ctx, p.stroke ?? null, 'stroke');
  if (has(p, 'strokes')) {
    if (!Array.isArray(p.strokes)) throw new ToolError('"strokes" must be an array');
    n.strokes = paintList(ctx, p.strokes, 'strokes');
  }
  if (has(p, 'strokeWidth')) N.strokeWidth = Math.max(0, num(p.strokeWidth, 'strokeWidth'));
  if (has(p, 'strokeAlign')) N.strokeAlign = oneOf(p.strokeAlign, ['inside', 'center', 'outside'] as const, 'strokeAlign');
  if (has(p, 'strokeCap')) N.strokeCap = oneOf(p.strokeCap, ['butt', 'round', 'square'] as const, 'strokeCap');
  if (has(p, 'strokeJoin')) N.strokeJoin = oneOf(p.strokeJoin, ['miter', 'round', 'bevel'] as const, 'strokeJoin');
  if (has(p, 'dash')) {
    if (!Array.isArray(p.dash)) throw new ToolError('"dash" must be an array of numbers');
    N.dash = p.dash.map((x, i) => Math.max(0, num(x, `dash[${i}]`)));
  }

  // corners
  if (has(p, 'cornerRadius')) {
    const v = p.cornerRadius;
    if (n.type === 'frame' || n.type === 'rect') {
      if (Array.isArray(v)) {
        const a = v.map((x, i) => Math.max(0, num(x, `cornerRadius[${i}]`)));
        const radii: [number, number, number, number] = a.length === 4 ? [a[0], a[1], a[2], a[3]] : a.length === 2 ? [a[0], a[1], a[0], a[1]] : [a[0] ?? 0, a[0] ?? 0, a[0] ?? 0, a[0] ?? 0];
        n.cornerRadii = radii;
        n.cornerRadius = radii[0];
      } else {
        n.cornerRadius = Math.max(0, num(v, 'cornerRadius'));
        n.cornerRadii = null;
      }
    } else if (n.type === 'polygon' || n.type === 'star') n.cornerRadius = Math.max(0, num(Array.isArray(v) ? v[0] : v, 'cornerRadius'));
    else warn(`cornerRadius is not supported on ${n.type} nodes (ignored)`);
  }
  if (has(p, 'cornerSmoothing')) {
    if (n.type === 'frame' || n.type === 'rect') n.cornerSmoothing = clamp(num(p.cornerSmoothing, 'cornerSmoothing'), 0, 1);
    else warn('cornerSmoothing only applies to frames and rectangles (ignored)');
  }

  // effects
  if (has(p, 'effects')) {
    if (!Array.isArray(p.effects)) throw new ToolError('"effects" must be an array');
    n.effects = p.effects.map((e, i) => toEffect(e, `effects[${i}]`));
  }
  if ('shadow' in p) {
    const keep = n.effects.filter((e) => e.type !== 'drop-shadow' && e.type !== 'inner-shadow');
    const v = p.shadow;
    const shadows = v === null || v === false || v === undefined ? [] : Array.isArray(v) ? v.map((s, i) => toShadow(s, `shadow[${i}]`)) : [toShadow(v, 'shadow')];
    n.effects = [...shadows, ...keep];
  }
  for (const [key, type] of [
    ['blur', 'layer-blur'],
    ['backgroundBlur', 'background-blur'],
  ] as const) {
    if (!(key in p) || p[key] === undefined) continue;
    const r = p[key] === null || p[key] === false ? 0 : num(p[key], key);
    const keep = n.effects.filter((e) => e.type !== type);
    n.effects = r > 0 ? [...keep, { ...(defaultEffect(type) as Effect), radius: r } as Effect] : keep;
  }

  // text
  const textKeys = TEXT_PROPS.filter((k) => has(p, k));
  if (textKeys.length) {
    if (n.type !== 'text') warn(`text properties (${textKeys.join(', ')}) only apply to text nodes (ignored)`);
    else {
      if (has(p, 'text')) n.text = String(p.text);
      if (has(p, 'fontFamily')) n.fontFamily = String(p.fontFamily).replace(/^["']|["']$/g, '');
      if (has(p, 'fontSize')) n.fontSize = Math.max(1, num(p.fontSize, 'fontSize'));
      if (has(p, 'fontWeight')) n.fontWeight = fontWeightOf(p.fontWeight);
      if (has(p, 'italic')) n.italic = !!p.italic;
      if (has(p, 'lineHeight')) {
        let lh = num(p.lineHeight, 'lineHeight');
        if (lh > 4) lh = lh / n.fontSize; // px → multiplier
        n.lineHeight = Math.max(0.1, lh);
      }
      if (has(p, 'letterSpacing')) n.letterSpacing = num(p.letterSpacing, 'letterSpacing');
      if (has(p, 'paragraphSpacing')) n.paragraphSpacing = Math.max(0, num(p.paragraphSpacing, 'paragraphSpacing'));
      if (has(p, 'textAlign')) n.textAlign = oneOf(p.textAlign, ['left', 'center', 'right', 'justify'] as const, 'textAlign', { start: 'left', end: 'right' });
      if (has(p, 'verticalAlign')) n.verticalAlign = oneOf(p.verticalAlign, ['top', 'middle', 'bottom'] as const, 'verticalAlign', { center: 'middle' });
      if (has(p, 'textDecoration')) n.textDecoration = oneOf(p.textDecoration, ['none', 'underline', 'strikethrough'] as const, 'textDecoration', { 'line-through': 'strikethrough' });
      if (has(p, 'textCase')) n.textCase = oneOf(p.textCase, ['none', 'upper', 'lower', 'title'] as const, 'textCase', { uppercase: 'upper', lowercase: 'lower', capitalize: 'title' });
      if (has(p, 'autoResize')) n.autoResize = oneOf(p.autoResize, ['width', 'height', 'none'] as const, 'autoResize', { fixed: 'none', auto: 'width' });
    }
  }

  // shapes
  if (has(p, 'sides')) n.type === 'polygon' ? (n.sides = clamp(Math.round(num(p.sides, 'sides')), 3, 100)) : warn('sides only applies to polygons');
  if (has(p, 'points')) n.type === 'star' ? (n.points = clamp(Math.round(num(p.points, 'points')), 3, 100)) : warn('points only applies to stars');
  if (has(p, 'innerRadius')) {
    if (n.type === 'star' || n.type === 'ellipse') n.innerRadius = clamp(num(p.innerRadius, 'innerRadius'), 0, n.type === 'star' ? 1 : 0.999);
    else warn('innerRadius only applies to stars and ellipses');
  }
  if (has(p, 'arcStart')) n.type === 'ellipse' ? (n.arcStart = num(p.arcStart, 'arcStart')) : warn('arcStart only applies to ellipses');
  if (has(p, 'arcSweep')) n.type === 'ellipse' ? (n.arcSweep = clamp(num(p.arcSweep, 'arcSweep'), -360, 360)) : warn('arcSweep only applies to ellipses');
  if (has(p, 'op')) n.type === 'boolean' ? (n.op = oneOf(p.op, ['union', 'subtract', 'intersect', 'exclude'] as const, 'op')) : warn('op only applies to boolean nodes');

  // vector
  if (has(p, 'fillRule')) n.type === 'path' ? (n.fillRule = oneOf(p.fillRule, ['nonzero', 'evenodd'] as const, 'fillRule')) : warn('fillRule only applies to paths');
  if (has(p, 'startMarker')) n.type === 'path' ? (n.startMarker = oneOf(p.startMarker, MARKERS, 'startMarker')) : warn('startMarker only applies to paths / lines');
  if (has(p, 'endMarker')) n.type === 'path' ? (n.endMarker = oneOf(p.endMarker, MARKERS, 'endMarker')) : warn('endMarker only applies to paths / lines');
  if (has(p, 'd') && n.type !== 'path') warn('d only applies to path nodes (ignored)');

  // frames / layout
  if (has(p, 'clipContent')) n.type === 'frame' ? (n.clipContent = !!p.clipContent) : warn('clipContent only applies to frames');
  if (has(p, 'isComponent')) n.type === 'frame' ? (n.isComponent = !!p.isComponent) : warn('isComponent only applies to frames');
  if ('autoLayout' in p || 'layout' in p) {
    const v = 'autoLayout' in p ? p.autoLayout : p.layout;
    if (n.type !== 'frame') warn('autoLayout only applies to frames (use set_auto_layout to wrap other layers)');
    else if (v === null || v === false || (isObj(v) && v.mode === 'none')) n.layout = null;
    else if (isObj(v) || v === true) {
      const hadLayout = !!n.layout;
      n.layout = toLayout(isObj(v) ? v : {}, n.layout);
      if (!hadLayout) {
        if (!has(p, 'sizingH')) n.sizingH = has(p, 'width') ? 'fixed' : 'hug';
        if (!has(p, 'sizingV')) n.sizingV = has(p, 'height') ? 'fixed' : 'hug';
      }
    } else throw new ToolError('"autoLayout" must be an object, or null to remove it');
  }
  if (has(p, 'sizingH')) N.sizingH = oneOf(p.sizingH, SIZING, 'sizingH', { auto: 'hug', stretch: 'fill' });
  if (has(p, 'sizingV')) N.sizingV = oneOf(p.sizingV, SIZING, 'sizingV', { auto: 'hug', stretch: 'fill' });
  if (has(p, 'layoutPositioning')) N.layoutPositioning = oneOf(p.layoutPositioning, ['auto', 'absolute'] as const, 'layoutPositioning');
  if (has(p, 'constraints')) {
    if (!isObj(p.constraints)) throw new ToolError('"constraints" must be {h, v}');
    n.constraints = {
      h: has(p.constraints, 'h') ? oneOf(p.constraints.h, ['left', 'right', 'center', 'scale', 'stretch'] as const, 'constraints.h') : n.constraints.h,
      v: has(p.constraints, 'v') ? oneOf(p.constraints.v, ['top', 'bottom', 'center', 'scale', 'stretch'] as const, 'constraints.v') : n.constraints.v,
    };
  }
  if (has(p, 'meta')) {
    if (!isObj(p.meta)) throw new ToolError('"meta" must be an object');
    n.meta = { ...(creating ? {} : (n.meta ?? {})), ...(p.meta as Record<string, unknown>) };
  }
}

/** Parse `d` into node-local sub-paths fitted to their bounds. Returns the bounds offset. */
function pathFromD(n: PathNode, d: unknown, scale?: unknown): Vec {
  if (typeof d !== 'string' || !d.trim()) throw new ToolError('"d" must be a non-empty SVG path data string');
  let cmds;
  try {
    cmds = parseSvgPath(d);
  } catch (e) {
    throw new ToolError(`Invalid SVG path data: ${(e as Error).message}`);
  }
  if (scale !== undefined) {
    const s = num(scale, 'pathScale');
    cmds = transformCmds(cmds, [s, 0, 0, s, 0, 0]);
  }
  const b = cmdsBounds(cmds);
  if (!b) throw new ToolError('"d" contains no drawable segments');
  n.paths = cmdsToSubPaths(transformCmds(cmds, [1, 0, 0, 1, -b.x, -b.y]));
  n.width = Math.max(0.01, b.width);
  n.height = Math.max(0.01, b.height);
  return { x: b.x, y: b.y };
}

/* =============================================================== images */

function collectImageSources(v: unknown, out: Set<string>, depth = 0) {
  if (depth > 64) return;
  if (Array.isArray(v)) {
    for (const x of v) collectImageSources(x, out, depth + 1);
    return;
  }
  if (!isObj(v)) return;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && (k === 'image' || (v.type === 'image' && (k === 'src' || k === 'url')))) out.add(val);
    else if (typeof val === 'object') collectImageSources(val, out, depth + 1);
  }
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(b);
  });
}

function decodeSize(src: string): Promise<{ width: number; height: number }> {
  if (typeof Image === 'undefined') return Promise.resolve({ width: 0, height: 0 });
  return new Promise((resolve) => {
    const img = new Image();
    const done = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onload = done;
    img.onerror = () => resolve({ width: -1, height: -1 });
    img.src = src;
  });
}

async function prepareImages(v: unknown): Promise<Map<string, ImageInfo>> {
  const srcs = new Set<string>();
  collectImageSources(v, srcs);
  const out = new Map<string, ImageInfo>();
  await Promise.all(
    [...srcs].map(async (src) => {
      let dataUrl = src;
      if (!src.startsWith('data:')) {
        if (!/^(https?:|blob:)/i.test(src)) throw new ToolError(`Image source ${trunc(src, 80)} is not a URL or data: URL (local files are only supported through the desktop app's MCP server)`);
        try {
          const r = await fetch(src);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          dataUrl = await blobToDataUrl(await r.blob());
        } catch (e) {
          throw new ToolError(`Could not load image ${trunc(src, 80)}: ${(e as Error).message}`);
        }
      }
      const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
      if (!mime.startsWith('image/')) throw new ToolError(`${trunc(src, 80)} is not an image (${mime})`);
      const size = await decodeSize(dataUrl);
      if (size.width < 0) throw new ToolError(`Image ${trunc(src, 80)} could not be decoded`);
      out.set(src, { dataUrl, mime, width: size.width, height: size.height });
    }),
  );
  return out;
}

async function loadFonts(v: unknown) {
  if (typeof document === 'undefined' || !(document as Document & { fonts?: FontFaceSet }).fonts) return;
  const fams = new Map<string, Set<number>>();
  const visit = (x: unknown, depth: number) => {
    if (depth > 64) return;
    if (Array.isArray(x)) x.forEach((y) => visit(y, depth + 1));
    else if (isObj(x)) {
      if (typeof x.fontFamily === 'string') {
        const set = fams.get(x.fontFamily) ?? new Set<number>();
        try {
          set.add(x.fontWeight !== undefined ? fontWeightOf(x.fontWeight) : 400);
        } catch {
          set.add(400);
        }
        fams.set(x.fontFamily, set);
      }
      Object.values(x).forEach((y) => typeof y === 'object' && visit(y, depth + 1));
    }
  };
  visit(v, 0);
  if (!fams.size) return;
  const loads: Promise<unknown>[] = [];
  for (const [fam, weights] of fams) for (const w of weights) loads.push(document.fonts.load(`${w} 16px "${fam.replace(/"/g, '')}"`).catch(() => undefined));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2000))]);
}

/* ============================================================== creation */

const CREATE_TYPES = ['frame', 'rect', 'ellipse', 'text', 'path', 'line', 'image', 'polygon', 'star', 'group', 'boolean'] as const;
type CreateType = (typeof CREATE_TYPES)[number];

interface Created {
  id: ID;
  type: NodeType;
  name: string;
  children?: Created[];
}

function createFromSpec(ctx: BuildCtx, spec: unknown, parentId: ID, index: number | undefined, path: string): Created {
  if (!isObj(spec)) throw new ToolError(`${path} must be an object with a "type"`);
  const kind = oneOf(spec.type, CREATE_TYPES, `${path}.type`, {
    rectangle: 'rect',
    circle: 'ellipse',
    oval: 'ellipse',
    vector: 'path',
    svg: 'path',
    label: 'text',
    artboard: 'frame',
    container: 'frame',
    stack: 'frame',
  }) as CreateType;
  const { d } = ctx;
  const nodeType: NodeType = kind === 'line' ? 'path' : kind === 'image' ? 'rect' : kind;
  const n = createNode(nodeType, { parentId }) as SceneNode;
  if (kind === 'image') n.name = 'Image';
  if (kind === 'line') n.name = 'Line';

  // geometry that defines the node box
  let origin: Vec = { x: 0, y: 0 };
  if (kind === 'line') {
    const x1 = num(spec.x1 ?? 0, `${path}.x1`);
    const y1 = num(spec.y1 ?? 0, `${path}.y1`);
    const x2 = num(spec.x2 ?? (has(spec, 'width') ? x1 + num(spec.width, 'width') : x1 + 100), `${path}.x2`);
    const y2 = num(spec.y2 ?? y1, `${path}.y2`);
    const pn = n as PathNode;
    pn.paths = [{ closed: false, points: [{ x: x1, y: y1, in: null, out: null, mode: 'corner' }, { x: x2, y: y2, in: null, out: null, mode: 'corner' }] }];
    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    for (const pt of pn.paths[0].points) {
      pt.x -= minX;
      pt.y -= minY;
    }
    pn.x = minX;
    pn.y = minY;
    pn.width = Math.max(0.01, Math.abs(x2 - x1));
    pn.height = Math.max(0.01, Math.abs(y2 - y1));
  } else if (kind === 'path') {
    if (!has(spec, 'd')) throw new ToolError(`${path}: path nodes need "d" (SVG path data)`);
    origin = pathFromD(n as PathNode, spec.d, spec.pathScale);
  }

  const props: Spec = { ...spec };
  for (const k of ['type', 'children', 'pathScale', 'x1', 'y1', 'x2', 'y2', 'id', 'parentId', 'index']) delete props[k];
  delete props.d; // consumed above (path) — or meaningless for other types
  if (kind === 'line') {
    delete props.x;
    delete props.y;
  }
  // a fill without a stroke on a vector means "filled shape", not "outlined + filled"
  if (kind === 'path' && (has(spec, 'fill') || has(spec, 'fills') || has(spec, 'color')) && !has(spec, 'stroke') && !has(spec, 'strokes')) n.strokes = [];
  applyProps(ctx, n, props, true);
  if (kind !== 'line') {
    n.x = (has(spec, 'x') ? num(spec.x, 'x') : 0) + origin.x;
    n.y = (has(spec, 'y') ? num(spec.y, 'y') : 0) + origin.y;
  }

  // size
  let w = has(spec, 'width') && kind !== 'line' ? Math.max(0.01, num(spec.width, `${path}.width`)) : undefined;
  let h = has(spec, 'height') && kind !== 'line' ? Math.max(0.01, num(spec.height, `${path}.height`)) : undefined;
  if (kind === 'image' && (w === undefined || h === undefined)) {
    const info = ctx.images.get(String(spec.image ?? ''));
    const iw = info?.width || 100;
    const ih = info?.height || 100;
    if (w === undefined && h === undefined) {
      const k = Math.min(1, 1200 / Math.max(iw, ih));
      w = Math.round(iw * k);
      h = Math.round(ih * k);
    } else if (w === undefined) w = (h! * iw) / ih;
    else h = (w * ih) / iw;
  }
  if (kind === 'image' && !has(spec, 'image') && !has(spec, 'fill') && !has(spec, 'fills')) throw new ToolError(`${path}: image nodes need "image" (URL, data URL or file path)`);
  if (n.type === 'text') {
    if (!has(spec, 'autoResize')) n.autoResize = w !== undefined && h !== undefined ? 'none' : w !== undefined || n.sizingH === 'fill' ? 'height' : 'width';
    if (w !== undefined) n.width = w;
    if (h !== undefined) n.height = h;
  } else if (n.type === 'path' && (w !== undefined || h !== undefined)) {
    resizeContent(d, n, w ?? n.width, h ?? n.height);
  } else if (n.type !== 'group' && n.type !== 'boolean') {
    if (w !== undefined) n.width = w;
    if (h !== undefined) n.height = h;
  } else if (w !== undefined || h !== undefined) ctx.warnings.push(`${path}: ${n.type} nodes size themselves to their children (width/height ignored)`);

  ops.insertNode(d, n, parentId, index);

  if (n.type === 'text') {
    if (!n.text && !has(spec, 'text')) ctx.warnings.push(`${path}: text node created without "text"`);
    const s = measureTextBox(n);
    if (n.autoResize === 'width') {
      n.width = s.width;
      n.height = s.height;
    } else if (n.autoResize === 'height') n.height = s.height;
  }

  const out: Created = { id: n.id, type: n.type, name: n.name };
  if (has(spec, 'children')) {
    if (!Array.isArray(spec.children)) throw new ToolError(`${path}.children must be an array`);
    if (!isContainer(n)) {
      if (spec.children.length) throw new ToolError(`${path}: ${kind} nodes cannot have children — use a frame or group`);
    } else {
      out.children = spec.children.map((c, i) => createFromSpec(ctx, c, n.id, undefined, `${path}.children[${i}]`));
    }
  }
  if ((n.type === 'group' || n.type === 'boolean') && !n.children.length) throw new ToolError(`${path}: ${n.type} nodes need at least one child`);
  return out;
}

/* ================================================================ tools */

type Handler = (args: Args) => Promise<McpToolResult> | McpToolResult;

function pageInfo(doc: Doc, pageId: ID) {
  const page = getPage(doc, pageId);
  if (!page) return null;
  const s = editor();
  return { id: page.id, name: page.name, topLevelCount: page.children.length, current: page.id === s.pageId, ...(page.background ? { background: page.background } : {}) };
}

const getDocument: Handler = () => {
  const s = editor();
  const { doc } = s;
  const page = getPage(doc, s.pageId)!;
  const top = page.children
    .map((id) => doc.nodes[id])
    .filter(Boolean)
    .slice(0, 300)
    .map((n) => {
      const o = nodeSummary(doc, n);
      if (isContainer(n)) o.childCount = n.children.length;
      return o;
    });
  const content = unionRects(page.children.filter((id) => doc.nodes[id]).map((id) => worldBounds(doc, id)));
  return okJson({
    name: doc.name,
    filePath: s.filePath,
    unsavedChanges: s.dirty,
    units: 'px',
    pages: doc.pages.map((p) => pageInfo(doc, p.id)),
    currentPage: {
      id: page.id,
      name: page.name,
      contentBounds: content ? { x: r2(content.x), y: r2(content.y), width: r2(content.width), height: r2(content.height) } : null,
      topLevel: top,
      ...(page.children.length > top.length ? { truncated: page.children.length - top.length } : {}),
    },
    selection: s.selection.map((id) => doc.nodes[id]).filter(Boolean).map((n) => ({ id: n.id, type: n.type, name: n.name })),
    styles: {
      colors: doc.styles.colors.map((c) => ({ id: c.id, name: c.name, paint: c.paint.type === 'solid' ? c.paint.color : c.paint.type })),
      text: doc.styles.text.map((t) => ({ id: t.id, name: t.name, font: `${t.fontFamily} ${t.fontWeight} ${t.fontSize}`, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing })),
      effects: doc.styles.effects.map((e) => ({ id: e.id, name: e.name, effects: e.effects.map((x) => x.type) })),
    },
    nodeCount: Object.keys(doc.nodes).length,
    canUndo: s.past.length > 0,
    canRedo: s.future.length > 0,
  });
};

const getTree: Handler = (a) => {
  const s = editor();
  const { doc } = s;
  const depth = has(a, 'depth') ? clamp(Math.round(num(a.depth, 'depth')), 1, 50) : 4;
  const includeHidden = a.includeHidden !== false;
  if (has(a, 'nodeId')) {
    const [id] = existingIds(doc, [a.nodeId], 'nodeId');
    return okJson({ pageId: pageIdOf(doc, id), parentId: doc.nodes[id].parentId, tree: treeOf(doc, id, 0, depth, includeHidden) });
  }
  const pageId = has(a, 'pageId') ? String(a.pageId) : s.pageId;
  const page = getPage(doc, pageId);
  if (!page) throw new ToolError(`Unknown page "${pageId}". Pages: ${doc.pages.map((p) => `${p.id} (${p.name})`).join(', ')}`);
  return okJson({
    page: { id: page.id, name: page.name },
    children: page.children.map((id) => treeOf(doc, id, 1, depth, includeHidden)).filter(Boolean),
  });
};

const getNodes: Handler = (a) => {
  const { doc } = editor();
  const ids = existingIds(doc, a.ids);
  if (ids.length > 200) throw new ToolError('At most 200 ids per call');
  let all = ids;
  if (a.includeChildren) {
    const seen = new Set<ID>();
    all = [];
    walk(doc, ids, (n) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      all.push(n.id);
    });
    if (all.length > 1000) all = all.slice(0, 1000);
  }
  return okJson({ nodes: all.map((id) => nodeDetail(doc, doc.nodes[id])) });
};

const findNodes: Handler = (a) => {
  const s = editor();
  const { doc } = s;
  const limit = has(a, 'limit') ? clamp(Math.round(num(a.limit, 'limit')), 1, 1000) : 100;
  const mk = (v: unknown, name: string): ((x: string) => boolean) | null => {
    if (v === undefined || v === null || v === '') return null;
    const q = String(v);
    if (a.regex) {
      let re: RegExp;
      try {
        re = new RegExp(q, 'i');
      } catch (e) {
        throw new ToolError(`Invalid regular expression for "${name}": ${(e as Error).message}`);
      }
      return (x) => re.test(x);
    }
    const lq = q.toLowerCase();
    return (x) => x.toLowerCase().includes(lq);
  };
  const byName = mk(a.name, 'name');
  const byText = mk(a.text, 'text');
  const types = a.type === undefined ? null : new Set((Array.isArray(a.type) ? a.type : [a.type]).map((t) => String(t).toLowerCase()));
  let roots: { pageId: ID; ids: ID[] }[];
  if (has(a, 'withinId')) {
    const [w] = existingIds(doc, [a.withinId], 'withinId');
    roots = [{ pageId: pageIdOf(doc, w), ids: childrenOf(doc, w) }];
  } else if (a.allPages) roots = doc.pages.map((p) => ({ pageId: p.id, ids: p.children }));
  else {
    const pid = has(a, 'pageId') ? String(a.pageId) : s.pageId;
    const page = getPage(doc, pid);
    if (!page) throw new ToolError(`Unknown page "${pid}"`);
    roots = [{ pageId: page.id, ids: page.children }];
  }
  const out: Record<string, unknown>[] = [];
  let total = 0;
  for (const r of roots) {
    walk(doc, r.ids, (n) => {
      if (types && !types.has(n.type)) return;
      if (byName && !byName(n.name)) return;
      if (byText && (n.type !== 'text' || !byText(n.text))) return;
      total++;
      if (out.length >= limit) return;
      const o: Record<string, unknown> = { id: n.id, type: n.type, name: n.name, pageId: r.pageId, parentId: n.parentId, bounds: boundsOf(doc, n.id) };
      if (n.type === 'text') o.text = trunc(n.text, 80);
      if (!n.visible) o.hidden = true;
      out.push(o);
    });
  }
  return okJson({ count: total, returned: out.length, nodes: out });
};

const getSelection: Handler = () => {
  const s = editor();
  const { doc } = s;
  return okJson({
    pageId: s.pageId,
    selection: s.selection
      .map((id) => doc.nodes[id])
      .filter(Boolean)
      .map((n) => ({ ...nodeSummary(doc, n), parentId: n.parentId, absoluteBounds: boundsOf(doc, n.id), ...(isContainer(n) ? { childCount: n.children.length } : {}) })),
    bounds: (() => {
      const b = selectionBounds(doc, s.selection);
      return b ? { x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) } : null;
    })(),
  });
};

function zoomTo(ids: ID[], fit = false) {
  try {
    window.dispatchEvent(new CustomEvent('alt:zoom-to', { detail: { ids, fit } }));
  } catch {
    /* non-DOM */
  }
}

const setSelection: Handler = (a) => {
  const s = editor();
  const ids = existingIds(s.doc, a.ids, 'ids', true);
  if (ids.length) showPage(samePage(s.doc, ids));
  editor().setSelection(topLevelOnly(s.doc, ids));
  if (a.zoom && ids.length) zoomTo(ids);
  return okJson({ selected: editor().selection, pageId: editor().pageId });
};

const createNodes: Handler = async (a) => {
  if (!Array.isArray(a.nodes) || !a.nodes.length) throw new ToolError('"nodes" must be a non-empty array of node specs');
  const s = editor();
  const parentId = containerId(s.doc, a.parentId);
  const index = has(a, 'index') ? Math.max(0, Math.round(num(a.index, 'index'))) : undefined;
  const images = await prepareImages(a.nodes);
  await loadFonts(a.nodes);
  showPage(pageIdOf(editor().doc, parentId));
  const warnings: string[] = [];
  const created = editor().mutate(
    (d) => {
      const ctx: BuildCtx = { d, images, warnings };
      return (a.nodes as unknown[]).map((spec, i) => createFromSpec(ctx, spec, parentId, index === undefined ? undefined : index + i, `nodes[${i}]`));
    },
    { select: (r) => (a.select === false ? editor().selection : r.map((c) => c.id)), label: 'MCP: create' },
  );
  const doc = editor().doc;
  const withBounds = (c: Created): Record<string, unknown> => ({
    ...c,
    ...(doc.nodes[c.id] ? { x: r2(doc.nodes[c.id].x), y: r2(doc.nodes[c.id].y), width: r2(doc.nodes[c.id].width), height: r2(doc.nodes[c.id].height) } : {}),
    ...(c.children ? { children: c.children.map(withBounds) } : {}),
  });
  return okJson({
    created: created.map(withBounds),
    ...(warnings.length ? { warnings } : {}),
    hint: 'Positions are parent-relative. Call screenshot on the top-level frame to check the result.',
  });
};

const updateNodes: Handler = async (a) => {
  const s = editor();
  const list: { id: ID; props: Spec }[] = [];
  if (has(a, 'updates')) {
    if (!Array.isArray(a.updates)) throw new ToolError('"updates" must be an array of {id, ...props}');
    a.updates.forEach((u, i) => {
      if (!isObj(u) || typeof u.id !== 'string') throw new ToolError(`updates[${i}] must be an object with an "id"`);
      const { id, ...props } = u;
      list.push({ id: id as string, props });
    });
  }
  if (has(a, 'ids')) {
    if (!isObj(a.props)) throw new ToolError('"props" (object) is required together with "ids"');
    for (const id of idList(a.ids)) list.push({ id, props: a.props });
  }
  if (!list.length) throw new ToolError('Nothing to update: pass "updates" or "ids" + "props"');
  existingIds(
    s.doc,
    list.map((u) => u.id),
  );
  for (const u of list) {
    for (const k of ['type', 'children', 'parentId']) {
      if (has(u.props, k)) throw new ToolError(`Cannot change "${k}" with update_nodes (${k === 'parentId' ? 'use move_nodes' : k === 'children' ? 'use create_nodes with parentId' : 'delete and re-create the node'})`);
    }
  }
  const images = await prepareImages(list.map((u) => u.props));
  await loadFonts(list.map((u) => u.props));
  showPage(pageIdOf(s.doc, list[0].id));
  const warnings: string[] = [];
  const ids = [...new Set(list.map((u) => u.id))];
  editor().mutate(
    (d) => {
      const ctx: BuildCtx = { d, images, warnings };
      for (const { id, props } of list) {
        const n = d.nodes[id];
        if (!n) continue;
        // applyProps never touches width / height itself; it only reads them for sizing defaults
        applyProps(ctx, n, props, false);
        if (has(props, 'd')) {
          if (n.type === 'path') {
            // keep the current position unless x / y are given (then they are the origin of the d space)
            const o = pathFromD(n, props.d, props.pathScale);
            if (has(props, 'x')) n.x = num(props.x, 'x') + o.x;
            if (has(props, 'y')) n.y = num(props.y, 'y') + o.y;
          }
        }
        const size: Record<string, number> = {};
        if (has(props, 'width')) size.width = Math.max(0.01, num(props.width, 'width'));
        if (has(props, 'height')) size.height = Math.max(0.01, num(props.height, 'height'));
        if (n.type === 'text' && has(props, 'autoResize') && Object.keys(size).length) {
          // explicit autoResize wins over setProps' implicit switch
          const ar = n.autoResize;
          ops.setProps(d, id, size as Partial<SceneNode>);
          n.autoResize = ar;
        } else if (Object.keys(size).length) ops.setProps(d, id, size as Partial<SceneNode>);
        if (n.type === 'text' && TEXT_PROPS.some((k) => has(props, k))) {
          ops.fitText(d, id);
          // explicit coordinates win over the alignment anchor of auto-width text
          if (has(props, 'x')) n.x = num(props.x, 'x');
          if (has(props, 'y')) n.y = num(props.y, 'y');
        }
      }
    },
    { select: ids, label: 'MCP: update' },
  );
  const doc = editor().doc;
  return okJson({
    updated: ids.map((id) => nodeSummary(doc, doc.nodes[id])),
    ...(warnings.length ? { warnings } : {}),
  });
};

const deleteNodes: Handler = (a) => {
  const s = editor();
  const ids = existingIds(s.doc, a.ids);
  const count = new Set(ids.flatMap((id) => [id, ...(isContainer(s.doc.nodes[id]) ? walkIds(s.doc, id) : [])])).size;
  editor().mutate((d) => ops.deleteNodes(d, ids), { select: [], label: 'MCP: delete' });
  return okJson({ deleted: ids, nodesRemoved: count });
};

function walkIds(doc: Doc, id: ID): ID[] {
  const out: ID[] = [];
  walk(doc, childrenOf(doc, id), (n) => void out.push(n.id));
  return out;
}

const moveNodesTool: Handler = (a) => {
  const s = editor();
  const ids = existingIds(s.doc, a.ids);
  if (!has(a, 'parentId') && !has(a, 'order') && !has(a, 'index')) throw new ToolError('Pass parentId (re-parent), index (re-order) or order ("front" | "back" | "forward" | "backward")');
  if (has(a, 'parentId')) {
    const pid = containerId(s.doc, a.parentId);
    for (const id of ids) {
      if (id === pid) throw new ToolError(`Cannot move ${id} into itself`);
      let cur = s.doc.nodes[pid];
      while (cur) {
        if (cur.id === id) throw new ToolError(`Cannot move ${id} into its own descendant ${pid}`);
        cur = s.doc.nodes[cur.parentId];
      }
    }
  }
  const index = has(a, 'index') ? Math.max(0, Math.round(num(a.index, 'index'))) : undefined;
  showPage(pageIdOf(s.doc, has(a, 'parentId') ? String(a.parentId) : ids[0]));
  editor().mutate(
    (d) => {
      if (has(a, 'parentId') || index !== undefined) {
        const pid = has(a, 'parentId') ? (a.parentId as string) : d.nodes[ids[0]].parentId;
        ops.moveNodes(d, ids, pid, index);
        if (has(a, 'x') || has(a, 'y')) {
          const top = topLevelOnly(d, ids);
          const b = selectionBounds(d, top);
          if (b) {
            const target = apply(ops.containerMatrix(d, pid), { x: has(a, 'x') ? num(a.x, 'x') : 0, y: has(a, 'y') ? num(a.y, 'y') : 0 });
            ops.translateNodes(d, top, has(a, 'x') ? target.x - b.x : 0, has(a, 'y') ? target.y - b.y : 0);
          }
        }
      }
      if (has(a, 'order')) ops.reorderNodes(d, ids, oneOf(a.order, ['front', 'back', 'forward', 'backward'] as const, 'order', { top: 'front', bottom: 'back', up: 'forward', down: 'backward' }));
    },
    { select: ids, label: 'MCP: move' },
  );
  const doc = editor().doc;
  return okJson({ moved: ids.map((id) => ({ id, parentId: doc.nodes[id]?.parentId, index: childrenOf(doc, doc.nodes[id]?.parentId ?? '').indexOf(id), bounds: boundsOf(doc, id) })) });
};

const duplicateNodesTool: Handler = (a) => {
  const s = editor();
  const ids = sortByZ(s.doc, topLevelOnly(s.doc, existingIds(s.doc, a.ids)));
  const count = has(a, 'count') ? clamp(Math.round(num(a.count, 'count')), 1, 200) : 1;
  const off = has(a, 'offset') ? vecOf(a.offset, 'offset') : { x: 0, y: 0 };
  showPage(samePage(s.doc, ids));
  const copies = editor().mutate(
    (d) => {
      const out: ID[][] = [];
      let last = ids;
      for (let k = 0; k < count; k++) {
        last = ops.duplicateNodes(d, last, off);
        out.push(last);
      }
      return out;
    },
    { select: (r) => r.flat(), label: 'MCP: duplicate' },
  );
  return okJson({ copies: copies.map((c, i) => ({ copy: i + 1, ids: c })), sourceIds: ids });
};

const groupNodesTool: Handler = (a) => {
  const s = editor();
  const ids = existingIds(s.doc, a.ids);
  const kind = has(a, 'kind') ? oneOf(a.kind, ['group', 'frame', 'boolean'] as const, 'kind') : 'group';
  const op = has(a, 'op') ? oneOf(a.op, ['union', 'subtract', 'intersect', 'exclude'] as const, 'op') : 'union';
  if (kind === 'boolean' && ids.length < 2) throw new ToolError('Boolean operations need at least 2 shapes');
  showPage(samePage(s.doc, ids));
  const id = editor().mutate(
    (d) => {
      const g = ops.groupNodes(d, ids, kind, op);
      if (g && has(a, 'name')) d.nodes[g].name = String(a.name);
      return g;
    },
    { select: (r) => (r ? [r] : []), label: `MCP: ${kind}` },
  );
  if (!id) throw new ToolError('Nothing was grouped');
  const doc = editor().doc;
  return okJson({ id, ...nodeSummary(doc, doc.nodes[id]), children: childrenOf(doc, id) });
};

const ungroupNodesTool: Handler = (a) => {
  const s = editor();
  const ids = existingIds(s.doc, a.ids);
  const bad = ids.filter((id) => !isContainer(s.doc.nodes[id]));
  if (bad.length) throw new ToolError(`Not a group / frame / boolean: ${bad.map((id) => `${id} (${s.doc.nodes[id].type})`).join(', ')}`);
  showPage(samePage(s.doc, ids));
  const kids = editor().mutate((d) => ops.ungroupNodes(d, ids), { select: (r) => r, label: 'MCP: ungroup' });
  return okJson({ children: kids });
};

const alignNodesTool: Handler = (a) => {
  const s = editor();
  const ids = existingIds(s.doc, a.ids);
  const mode = oneOf(a.align, ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'] as const, 'align', {
    center: 'hcenter',
    centre: 'hcenter',
    'horizontal-center': 'hcenter',
    middle: 'vcenter',
    'vertical-center': 'vcenter',
  });
  if (ids.length === 1 && !s.doc.nodes[s.doc.nodes[ids[0]].parentId]) throw new ToolError('A single node can only be aligned within a parent frame / group (it is at the page top level)');
  showPage(samePage(s.doc, ids));
  editor().mutate((d) => ops.alignNodes(d, ids, mode), { select: ids, label: 'MCP: align' });
  const doc = editor().doc;
  return okJson({ aligned: ids.map((id) => ({ id, bounds: boundsOf(doc, id) })) });
};

const distributeNodesTool: Handler = (a) => {
  const s = editor();
  const ids = topLevelOnly(s.doc, existingIds(s.doc, a.ids));
  const axis = oneOf(a.axis, ['horizontal', 'vertical'] as const, 'axis', { h: 'horizontal', x: 'horizontal', v: 'vertical', y: 'vertical' });
  const spacing = has(a, 'spacing') ? num(a.spacing, 'spacing') : undefined;
  if (spacing === undefined && ids.length < 3) throw new ToolError('Distributing needs at least 3 nodes (or pass spacing to place 2+ nodes a fixed distance apart)');
  if (ids.length < 2) throw new ToolError('Need at least 2 nodes');
  showPage(samePage(s.doc, ids));
  editor().mutate(
    (d) => {
      if (spacing === undefined) return ops.distributeNodes(d, ids, axis === 'horizontal' ? 'h' : 'v');
      const key = axis === 'horizontal' ? 'x' : 'y';
      const size = axis === 'horizontal' ? 'width' : 'height';
      const items = ids.map((id) => ({ id, b: worldBounds(d, id) })).sort((p, q) => p.b[key] - q.b[key]);
      let cursor = items[0].b[key] + items[0].b[size] + spacing;
      for (const it of items.slice(1)) {
        const delta = cursor - it.b[key];
        ops.translateNodes(d, [it.id], key === 'x' ? delta : 0, key === 'y' ? delta : 0);
        cursor += it.b[size] + spacing;
      }
    },
    { select: ids, label: 'MCP: distribute' },
  );
  const doc = editor().doc;
  return okJson({ distributed: ids.map((id) => ({ id, bounds: boundsOf(doc, id) })) });
};

const setAutoLayoutTool: Handler = (a) => {
  const s = editor();
  const ids = existingIds(s.doc, a.ids ?? (has(a, 'id') ? [a.id] : undefined));
  const mode = has(a, 'mode') ? oneOf(a.mode, ['horizontal', 'vertical', 'none'] as const, 'mode', { row: 'horizontal', column: 'vertical', off: 'none' }) : undefined;
  showPage(samePage(s.doc, ids));
  const frameId = editor().mutate(
    (d) => {
      let fid: ID | null;
      const single = ids.length === 1 ? d.nodes[ids[0]] : null;
      if (single && single.type === 'frame') {
        fid = single.id;
        if (mode === 'none') {
          single.layout = null;
          return fid;
        }
        if (!single.layout) ops.setAutoLayout(d, fid, true);
      } else {
        if (mode === 'none') throw new ToolError('mode "none" needs a single frame id');
        fid = ops.wrapInAutoLayout(d, ids);
        if (!fid) throw new ToolError('Could not wrap the nodes in an auto-layout frame');
      }
      const f = d.nodes[fid];
      if (f.type !== 'frame') return fid;
      const spec: Record<string, unknown> = {};
      for (const k of ['gap', 'padding', 'align', 'justify', 'wrap']) if (has(a, k)) spec[k] = a[k];
      if (mode) spec.mode = mode;
      f.layout = toLayout(spec, f.layout);
      if (has(a, 'sizingH')) f.sizingH = oneOf(a.sizingH, SIZING, 'sizingH');
      if (has(a, 'sizingV')) f.sizingV = oneOf(a.sizingV, SIZING, 'sizingV');
      return fid;
    },
    { select: (r) => (r ? [r] : []), label: 'MCP: auto layout' },
  );
  const doc = editor().doc;
  const f = frameId ? doc.nodes[frameId] : null;
  return okJson({ frameId, layout: f && f.type === 'frame' ? f.layout : null, ...(f ? nodeSummary(doc, f) : {}) });
};

/* ---------------------------------------------------------- svg import */

type SvgImporter = (svg: string, opts?: { name?: string }) => ClipboardData;
// Resolved through import.meta.glob so this module builds even before the importer lands.
const svgModules = import.meta.glob<{ importSvg: SvgImporter }>('../import/svg.ts');

async function loadSvgImporter(): Promise<SvgImporter> {
  const load = svgModules['../import/svg.ts'];
  if (!load) throw new ToolError('SVG import is not available in this build of Alt.');
  const mod = await load();
  if (typeof mod.importSvg !== 'function') throw new ToolError('SVG import is not available in this build of Alt.');
  return mod.importSvg;
}

const importSvgTool: Handler = async (a) => {
  if (typeof a.svg !== 'string' || !/<svg[\s>]/i.test(a.svg)) throw new ToolError('"svg" must be SVG markup containing an <svg> element');
  const importSvg = await loadSvgImporter();
  const s = editor();
  const parentId = containerId(s.doc, a.parentId);
  const name = has(a, 'name') ? String(a.name) : undefined;
  let data: ClipboardData;
  try {
    data = importSvg(a.svg, name ? { name } : undefined);
  } catch (e) {
    throw new ToolError(`Could not import the SVG: ${(e as Error).message}`);
  }
  if (!data?.nodes?.length) throw new ToolError('The SVG contains nothing that can be imported');
  showPage(pageIdOf(s.doc, parentId));
  const ids = editor().mutate(
    (d) => {
      let roots = ops.pasteNodes(d, data, parentId);
      if (!roots.length) return roots;
      if ((has(a, 'width') || has(a, 'height')) && roots.length > 1) {
        const g = ops.groupNodes(d, roots, 'group');
        if (g) roots = [g];
      }
      if (roots.length === 1) {
        const n = d.nodes[roots[0]];
        if (name) n.name = name;
        if (has(a, 'width') || has(a, 'height')) {
          const w = has(a, 'width') ? Math.max(0.01, num(a.width, 'width')) : (num(a.height, 'height') * n.width) / Math.max(n.height, 0.01);
          const h = has(a, 'height') ? Math.max(0.01, num(a.height, 'height')) : (w * n.height) / Math.max(n.width, 0.01);
          ops.setProps(d, n.id, { width: w, height: h } as Partial<SceneNode>);
        }
      }
      if (has(a, 'x') || has(a, 'y')) {
        const b = selectionBounds(d, roots);
        if (b) {
          const t = apply(ops.containerMatrix(d, parentId), { x: has(a, 'x') ? num(a.x, 'x') : 0, y: has(a, 'y') ? num(a.y, 'y') : 0 });
          ops.translateNodes(d, roots, has(a, 'x') ? t.x - b.x : 0, has(a, 'y') ? t.y - b.y : 0);
        }
      }
      return roots;
    },
    { select: (r) => r, label: 'MCP: import SVG' },
  );
  const doc = editor().doc;
  return okJson({ created: ids.map((id) => ({ ...nodeSummary(doc, doc.nodes[id]), ...(isContainer(doc.nodes[id]) ? { childCount: (doc.nodes[id] as { children: ID[] }).children.length } : {}) })) });
};

/* ------------------------------------------------------------- export */

async function exporters(): Promise<{ list: Exporter[]; get: (id: string) => Exporter | undefined }> {
  const mod = await import('../export/index');
  return { list: mod.EXPORTERS, get: mod.getExporter };
}

const listExporters: Handler = async () => {
  const { list } = await exporters();
  return okJson({
    exporters: list.map((e) => ({
      id: e.id,
      label: e.label,
      group: e.group,
      extension: e.extension,
      textual: e.textual,
      description: e.description,
      ...(e.options?.length
        ? {
            options: e.options.map((o) => ({
              key: o.key,
              label: o.label,
              type: o.type,
              default: o.default,
              ...(o.options ? { values: o.options.map((x) => x.value) } : {}),
              ...(o.min !== undefined ? { min: o.min } : {}),
              ...(o.max !== undefined ? { max: o.max } : {}),
            })),
          }
        : {}),
    })),
  });
};

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-|.*\+xml|.*\+json))|image\/svg\+xml/;
const MAX_TEXT_CHARS = 400_000;
const MAX_BINARY_BYTES = 8 * 1024 * 1024;

const exportTool: Handler = async (a) => {
  const { list, get } = await exporters();
  const fmt = String(a.format ?? '').trim().toLowerCase();
  const ex = get(fmt) ?? list.find((e) => e.id.toLowerCase() === fmt || e.extension.toLowerCase() === fmt || e.label.toLowerCase() === fmt);
  if (!ex) throw new ToolError(`Unknown export format "${a.format}". Available: ${list.map((e) => e.id).join(', ')}`);
  const s = editor();
  const { doc } = s;
  let ids: ID[];
  let pageId: ID;
  if (has(a, 'ids')) {
    ids = existingIds(doc, a.ids);
    pageId = samePage(doc, ids);
  } else if (has(a, 'pageId')) {
    pageId = String(a.pageId);
    if (!getPage(doc, pageId)) throw new ToolError(`Unknown page "${pageId}"`);
    ids = [];
  } else {
    ids = [...s.selection];
    pageId = s.pageId;
  }
  const roots = ids.length ? sortByZ(doc, topLevelOnly(doc, ids)) : (getPage(doc, pageId)?.children ?? []).filter((id) => doc.nodes[id]?.visible);
  if (!roots.length) throw new ToolError('Nothing to export: the page is empty and no ids were given');
  const options: Record<string, unknown> = {};
  for (const o of ex.options ?? []) options[o.key] = o.default;
  if (isObj(a.options)) Object.assign(options, a.options);
  const files = await ex.run({ doc, ids: roots, pageId, options, rasterize: (rids, opts) => rasterize(doc, pageId, rids, opts) });
  const content: McpContent[] = [];
  const summary: string[] = [];
  for (const f of files) {
    const mime = f.mime || 'application/octet-stream';
    if (typeof f.data === 'string' || TEXT_MIME.test(mime)) {
      const text = typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data);
      const clipped = text.length > MAX_TEXT_CHARS;
      content.push({ type: 'text', text: `=== ${f.name} (${mime}${clipped ? `, truncated to ${MAX_TEXT_CHARS} of ${text.length} chars` : ''}) ===\n${clipped ? text.slice(0, MAX_TEXT_CHARS) : text}` });
      summary.push(`${f.name} (${text.length} chars)`);
    } else if (/^image\/(png|jpeg|webp|gif)$/.test(mime) && f.data.length <= MAX_BINARY_BYTES) {
      content.push({ type: 'text', text: `=== ${f.name} (${mime}, ${f.data.length} bytes) ===` });
      content.push({ type: 'image', data: toBase64(f.data), mimeType: mime });
      summary.push(`${f.name} (${f.data.length} bytes)`);
    } else {
      if (f.data.length > MAX_BINARY_BYTES) {
        content.push({ type: 'text', text: `=== ${f.name} (${mime}, ${f.data.length} bytes) — too large to return inline (limit ${MAX_BINARY_BYTES} bytes). Export fewer layers or ask the user to export it from Alt's Export dialog. ===` });
      } else content.push({ type: 'text', text: `=== ${f.name} (${mime}, ${f.data.length} bytes, base64) ===\n${toBase64(f.data)}` });
      summary.push(`${f.name} (${f.data.length} bytes)`);
    }
  }
  content.unshift({ type: 'text', text: `Exported ${roots.length} layer(s) as ${ex.label} → ${files.length} file(s): ${summary.join(', ')}` });
  return { content };
};

const screenshot: Handler = async (a) => {
  const s = editor();
  const { doc } = s;
  let ids: ID[];
  let pageId: ID;
  if (has(a, 'ids') && Array.isArray(a.ids) && a.ids.length) {
    ids = existingIds(doc, a.ids);
    pageId = samePage(doc, ids);
  } else if (a.target === 'selection') {
    if (!s.selection.length) throw new ToolError('Nothing is selected in Alt. Pass ids, or target "page".');
    ids = [...s.selection];
    pageId = s.pageId;
  } else {
    pageId = has(a, 'pageId') ? String(a.pageId) : s.pageId;
    if (!getPage(doc, pageId)) throw new ToolError(`Unknown page "${pageId}"`);
    ids = [];
  }
  const page = getPage(doc, pageId)!;
  const roots = ids.length ? sortByZ(doc, topLevelOnly(doc, ids)) : [];
  const bounds = roots.length ? selectionBounds(doc, roots) : unionRects(page.children.filter((id) => doc.nodes[id]?.visible).map((id) => worldBounds(doc, id)));
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new ToolError('Nothing to render: the target is empty');
  const maxSize = has(a, 'maxSize') ? clamp(Math.round(num(a.maxSize, 'maxSize')), 64, 4096) : 1600;
  const longest = Math.max(bounds.width, bounds.height);
  let scale = has(a, 'scale') ? clamp(num(a.scale, 'scale'), 0.01, 8) : longest * 2 <= maxSize ? 2 : 1;
  scale = Math.min(scale, maxSize / longest);
  let background: string | null;
  if (a.background === null) background = null;
  else if (typeof a.background === 'string') background = colorOf(a.background, 'background').hex;
  else if (page.background) background = page.background;
  else {
    try {
      const { canvasBackground } = await import('../editor/settings');
      background = canvasBackground();
    } catch {
      background = '#F2F2F4';
    }
  }
  let format: 'png' | 'jpeg' = a.format === 'jpeg' || a.format === 'jpg' ? 'jpeg' : 'png';
  let bytes = await rasterize(doc, pageId, roots, { scale, format, quality: 0.9, background });
  if (bytes.length > 3_500_000 && format === 'png') {
    format = 'jpeg';
    bytes = await rasterize(doc, pageId, roots, { scale, format, quality: 0.85, background: background ?? '#FFFFFF' });
  }
  const info = {
    target: roots.length ? roots : `page ${page.name}`,
    pageId,
    bounds: { x: r2(bounds.x), y: r2(bounds.y), width: r2(bounds.width), height: r2(bounds.height) },
    scale: r2(scale),
    imageSize: { width: Math.ceil(bounds.width * scale), height: Math.ceil(bounds.height * scale) },
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(info) },
      { type: 'image', data: toBase64(bytes), mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' },
    ],
  };
};

const managePages: Handler = (a) => {
  const s = editor();
  const action = oneOf(a.action, ['list', 'create', 'rename', 'delete', 'duplicate', 'switch'] as const, 'action', { add: 'create', new: 'create', remove: 'delete', copy: 'duplicate', go: 'switch', select: 'switch' });
  const pageArg = (): ID => {
    const id = has(a, 'pageId') ? String(a.pageId) : s.pageId;
    if (!getPage(editor().doc, id)) throw new ToolError(`Unknown page "${id}". Pages: ${editor().doc.pages.map((p) => `${p.id} (${p.name})`).join(', ')}`);
    return id;
  };
  const bg = has(a, 'background') ? colorOf(a.background, 'background').hex : undefined;
  let result: Record<string, unknown> = {};
  switch (action) {
    case 'list':
      break;
    case 'create': {
      const id = editor().mutate(
        (d) => {
          const pid = ops.addPage(d, has(a, 'name') ? String(a.name) : undefined);
          if (bg) d.pages.find((p) => p.id === pid)!.background = bg;
          return pid;
        },
        { label: 'MCP: add page' },
      );
      if (a.switchTo !== false) editor().setPage(id);
      result = { created: id };
      break;
    }
    case 'rename': {
      const id = pageArg();
      if (!has(a, 'name') && !bg) throw new ToolError('Pass name and/or background');
      editor().mutate(
        (d) => {
          const p = d.pages.find((x) => x.id === id)!;
          if (has(a, 'name')) p.name = String(a.name);
          if (bg) p.background = bg;
        },
        { label: 'MCP: rename page' },
      );
      result = { renamed: id };
      break;
    }
    case 'delete': {
      const id = pageArg();
      if (editor().doc.pages.length <= 1) throw new ToolError('Cannot delete the only page');
      editor().mutate((d) => ops.deletePage(d, id), { select: [], label: 'MCP: delete page' });
      result = { deleted: id };
      break;
    }
    case 'duplicate': {
      const id = pageArg();
      const nid = editor().mutate((d) => ops.duplicatePage(d, id), { label: 'MCP: duplicate page' });
      if (nid && has(a, 'name')) editor().mutate((d) => void (d.pages.find((p) => p.id === nid)!.name = String(a.name)), { label: 'MCP: rename page' });
      if (nid && a.switchTo !== false) editor().setPage(nid);
      result = { created: nid };
      break;
    }
    case 'switch': {
      const id = pageArg();
      editor().setPage(id);
      result = { switchedTo: id };
      break;
    }
  }
  const doc = editor().doc;
  return okJson({ ...result, currentPageId: editor().pageId, pages: doc.pages.map((p) => pageInfo(doc, p.id)) });
};

function history(dir: 'undo' | 'redo'): Handler {
  return (a) => {
    const steps = has(a, 'steps') ? clamp(Math.round(num(a.steps, 'steps')), 1, 100) : 1;
    let done = 0;
    for (let i = 0; i < steps; i++) {
      const s = editor();
      if (dir === 'undo' ? !s.past.length && !s.tx : !s.future.length) break;
      if (dir === 'undo') s.undo();
      else s.redo();
      done++;
    }
    const s = editor();
    return okJson({ [dir === 'undo' ? 'undone' : 'redone']: done, canUndo: s.past.length > 0, canRedo: s.future.length > 0, currentPageId: s.pageId, selection: s.selection });
  };
}

const zoomToTool: Handler = (a) => {
  const s = editor();
  if (has(a, 'ids') && Array.isArray(a.ids) && a.ids.length) {
    const ids = existingIds(s.doc, a.ids);
    showPage(samePage(s.doc, ids));
    zoomTo(ids);
    return okJson({ zoomedTo: ids });
  }
  if (a.target === 'selection') {
    if (!s.selection.length) throw new ToolError('Nothing is selected');
    zoomTo([...s.selection]);
    return okJson({ zoomedTo: s.selection });
  }
  const page = getPage(s.doc, s.pageId)!;
  const all = page.children.filter((id) => s.doc.nodes[id]);
  zoomTo(all, true);
  return okJson({ zoomedTo: 'fit', pageId: page.id });
};

/* -------------------------------------------------------------- scripts */

function safeJson(v: unknown, max = 200_000): string {
  const seen = new WeakSet<object>();
  let out: string | undefined;
  try {
    out = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return `[function ${val.name || 'anonymous'}]`;
      if (val instanceof Uint8Array) return `[${val.length} bytes]`;
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    });
  } catch (e) {
    out = `[unserialisable: ${(e as Error).message}]`;
  }
  if (out === undefined) out = 'undefined';
  return out.length > max ? out.slice(0, max) + '…[truncated]' : out;
}

function buildScriptApi(log: (level: string, args: unknown[]) => void) {
  const call = async (tool: string, args: Args = {}) => {
    const r = await executeTool({ tool, args });
    const text = r.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text);
    if (r.isError) throw new Error(text.join('\n') || `${tool} failed`);
    if (text.length === 1) {
      try {
        return JSON.parse(text[0]);
      } catch {
        return text[0];
      }
    }
    return r.content;
  };
  return {
    get doc() {
      return editor().doc;
    },
    get pageId() {
      return editor().pageId;
    },
    get page() {
      const s = editor();
      return getPage(s.doc, s.pageId);
    },
    get selection() {
      return [...editor().selection];
    },
    getNode: (id: ID) => editor().doc.nodes[id] ?? null,
    children: (id: ID) => {
      const doc = editor().doc;
      return childrenOf(doc, id).map((c) => doc.nodes[c]).filter(Boolean);
    },
    find(q: { name?: string; type?: string; text?: string } = {}) {
      const doc = editor().doc;
      const page = getPage(doc, editor().pageId)!;
      const out: SceneNode[] = [];
      walk(doc, page.children, (n) => {
        if (q.type && n.type !== q.type) return;
        if (q.name && !n.name.toLowerCase().includes(q.name.toLowerCase())) return;
        if (q.text && (n.type !== 'text' || !n.text.toLowerCase().includes(q.text.toLowerCase()))) return;
        out.push(n);
      });
      return out;
    },
    create: async (specs: unknown, parentId?: ID) => (await call('create_nodes', { nodes: Array.isArray(specs) ? specs : [specs], ...(parentId ? { parentId } : {}) })).created,
    update: async (ids: ID | ID[], props: Spec) => call('update_nodes', { ids: Array.isArray(ids) ? ids : [ids], props }),
    remove: (ids: ID | ID[]) => editor().mutate((d) => ops.deleteNodes(d, Array.isArray(ids) ? ids : [ids]), { select: [], label: 'Script: delete' }),
    select: (ids: ID[]) => editor().setSelection(ids),
    setPage: (id: ID) => editor().setPage(id),
    mutate: <R>(recipe: (d: Doc) => R, label = 'Script') => editor().mutate(recipe, { label }),
    call,
    ops,
    util: { createNode, solid, gradient, uid, parseColor, worldBounds, defaultEffect },
    log: (...args: unknown[]) => log('log', args),
  };
}

const runScript: Handler = async (a) => {
  if (native) {
    const status = await native.mcp.getStatus().catch(() => null);
    if (status && !status.allowScripts) throw new ToolError('run_script is disabled. Ask the user to enable "Allow scripts" in Alt → Settings → MCP.');
  }
  if (typeof a.code !== 'string' || !a.code.trim()) throw new ToolError('"code" must be a non-empty string');
  const timeoutMs = has(a, 'timeoutMs') ? clamp(Math.round(num(a.timeoutMs, 'timeoutMs')), 100, 110_000) : 30_000;
  const logs: string[] = [];
  const log = (level: string, args: unknown[]) => {
    if (logs.length >= 500) return;
    logs.push((level === 'log' ? '' : `${level}: `) + args.map((x) => (typeof x === 'string' ? x : safeJson(x, 5000))).join(' '));
  };
  const consoleProxy = {
    log: (...x: unknown[]) => log('log', x),
    info: (...x: unknown[]) => log('log', x),
    debug: (...x: unknown[]) => log('log', x),
    warn: (...x: unknown[]) => log('warn', x),
    error: (...x: unknown[]) => log('error', x),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {
    /* prototype probe */
  }).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
  let fn: (...a: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction('alt', 'console', a.code);
  } catch (e) {
    throw new ToolError(`Script syntax error: ${(e as Error).message}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(buildScriptApi(log), consoleProxy),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(`Script timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return ok(safeJson({ result: result === undefined ? null : result, logs }));
  } catch (e) {
    if (e instanceof ToolError) throw e;
    const err = e as Error;
    return fail(`Script error: ${err?.message ?? String(e)}${err?.stack ? `\n${err.stack.split('\n').slice(0, 6).join('\n')}` : ''}${logs.length ? `\nlogs:\n${logs.join('\n')}` : ''}`);
  } finally {
    clearTimeout(timer);
  }
};

/* ============================================================ dispatcher */

const HANDLERS: Record<string, Handler> = {
  get_document: getDocument,
  get_tree: getTree,
  get_nodes: getNodes,
  find_nodes: findNodes,
  get_selection: getSelection,
  set_selection: setSelection,
  create_nodes: createNodes,
  update_nodes: updateNodes,
  delete_nodes: deleteNodes,
  move_nodes: moveNodesTool,
  duplicate_nodes: duplicateNodesTool,
  group_nodes: groupNodesTool,
  ungroup_nodes: ungroupNodesTool,
  align_nodes: alignNodesTool,
  distribute_nodes: distributeNodesTool,
  set_auto_layout: setAutoLayoutTool,
  import_svg: importSvgTool,
  list_exporters: listExporters,
  export: exportTool,
  screenshot,
  manage_pages: managePages,
  undo: history('undo'),
  redo: history('redo'),
  zoom_to: zoomToTool,
  run_script: runScript,
};

/** Execute an MCP tool call against the live editor. Never throws. */
export async function executeTool(req: McpToolRequest): Promise<McpToolResult> {
  const tool = req?.tool;
  const handler = typeof tool === 'string' ? HANDLERS[tool] : undefined;
  if (!handler) return fail(`Unknown tool "${tool}". Available tools: ${MCP_TOOLS.map((t) => t.name).join(', ')}`);
  const args = isObj(req.args) ? req.args : {};
  emitActivity(tool, 'start');
  try {
    const result = await handler(args);
    emitActivity(tool, 'end', !result.isError);
    return result;
  } catch (e) {
    emitActivity(tool, 'end', false);
    if (e instanceof ToolError) return fail(e.message);
    console.error(`[mcp] ${tool} failed`, e);
    return fail(`Error in ${tool}: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** Names of tools implemented here (for tests / diagnostics). */
export const IMPLEMENTED_TOOLS = Object.keys(HANDLERS);
export { isScriptTool };
