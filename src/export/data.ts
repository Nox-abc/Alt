/**
 * Data exporters: native Alt JSON, W3C design tokens, CSS variables, Android
 * VectorDrawable and Unity UI Toolkit (UXML + USS).
 */
import type { Asset, Doc, GradientPaint, ID, Page, Paint, SceneNode, ShadowEffect, TextStyleProps } from '../core/types';
import { localMatrix, mul, placementFromMatrix, transformRect, worldMatrix, type Mat } from '../core/geometry';
import { cmdsToSvgD, transformCmds } from '../core/path';
import { geometryOf } from '../core/boolean';
import { nodeCmds } from '../core/shapes';
import { isContainer } from '../core/doc';
import { applyCase } from '../core/text';
import type { ExportContext, ExportFile, Exporter } from './types';
import {
  argbHex,
  childNodes,
  collectAssets,
  cornerRadii,
  cssColor,
  cssGradient,
  dataUrlToBytes,
  FileNamer,
  fontStack,
  gradientGeom,
  hexColor,
  isGradient,
  isPlainEllipse,
  isVectorNode,
  kebabCase,
  MIME,
  NameRegistry,
  num,
  px,
  r2,
  resolveRoots,
  sanitizeFileName,
  snakeCase,
  sortedStops,
  uniformRadius,
  visibleEffects,
  visiblePaints,
  xmlAttr,
} from './util';

/* ================================================================== JSON */

/** A standalone Alt document containing only the exported roots. */
export function subsetDocument(doc: Doc, pageId: ID, rootIds: ID[], includeAssets = true): Doc {
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const nodes: Record<ID, SceneNode> = {};
  const visit = (id: ID) => {
    const n = doc.nodes[id];
    if (!n) return;
    nodes[id] = JSON.parse(JSON.stringify(n));
    if (isContainer(n)) n.children.forEach(visit);
  };
  rootIds.forEach(visit);
  for (const id of rootIds) {
    const n = nodes[id];
    if (!n || n.parentId === page.id) continue;
    // nested selection: re-place the root in page space
    const pl = placementFromMatrix(worldMatrix(doc, id), n.width, n.height);
    n.x = pl.x;
    n.y = pl.y;
    n.rotation = pl.rotation;
    n.flipY = pl.flipY;
    n.flipX = pl.flipX;
    n.parentId = page.id;
  }
  const assets: Record<ID, Asset> = {};
  if (includeAssets) for (const a of collectAssets(doc, rootIds)) assets[a] = doc.assets[a];
  const outPage: Page = { id: page.id, name: page.name, children: [...rootIds], background: page.background, guides: [] };
  const now = Date.now();
  return { format: 'alt', version: 1, id: doc.id, name: doc.name, pages: [outPage], nodes, assets, styles: JSON.parse(JSON.stringify(doc.styles)), createdAt: doc.createdAt, updatedAt: now };
}

export const jsonExporter: Exporter = {
  id: 'json',
  label: 'Alt JSON',
  group: 'Data',
  extension: 'json',
  description: 'The exported layers as a standalone Alt document (opens in Alt, easy to script).',
  textual: true,
  options: [{ key: 'includeAssets', label: 'Embed images', type: 'boolean', default: true }],
  async run(ctx: ExportContext): Promise<ExportFile[]> {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    const sub = subsetDocument(ctx.doc, ctx.pageId, roots, ctx.options.includeAssets !== false);
    const name = roots.length === 1 ? ctx.doc.nodes[roots[0]].name : ctx.doc.name;
    return [{ name: new FileNamer().get(name, 'json'), mime: MIME.json, data: JSON.stringify(sub, null, 2) + '\n' }];
  },
};

/* ================================================================ tokens */

interface ColorToken {
  path: string[];
  hex: string;
  alpha: number;
}
interface GradientToken {
  path: string[];
  paint: GradientPaint;
}
interface TypeToken {
  path: string[];
  style: Pick<TextStyleProps, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic' | 'lineHeight' | 'letterSpacing' | 'textCase' | 'textDecoration'>;
}
interface ShadowToken {
  path: string[];
  shadows: ShadowEffect[];
}

export interface TokenSet {
  colors: ColorToken[];
  gradients: GradientToken[];
  typography: TypeToken[];
  shadows: ShadowToken[];
}

const stylePath = (name: string) => name.split('/').map((s) => kebabCase(s)).filter(Boolean);

/** Design tokens from document styles plus every colour / text style used by the export. */
export function collectTokens(doc: Doc, rootIds: ID[]): TokenSet {
  const t: TokenSet = { colors: [], gradients: [], typography: [], shadows: [] };
  for (const s of doc.styles.colors) {
    const path = stylePath(s.name);
    if (!path.length) continue;
    if (s.paint.type === 'solid') t.colors.push({ path, hex: s.paint.color, alpha: s.paint.opacity });
    else if (isGradient(s.paint)) t.gradients.push({ path, paint: s.paint });
  }
  for (const s of doc.styles.text) {
    const path = stylePath(s.name);
    if (path.length) t.typography.push({ path, style: s });
  }
  for (const s of doc.styles.effects) {
    const shadows = s.effects.filter((e): e is ShadowEffect => (e.type === 'drop-shadow' || e.type === 'inner-shadow') && e.visible);
    const path = stylePath(s.name);
    if (path.length && shadows.length) t.shadows.push({ path, shadows });
  }
  // used values
  const colors = new Map<string, ColorToken>();
  const types = new Map<string, TypeToken>();
  const addColor = (hex: string, alpha: number) => {
    const key = hexColor(hex, alpha).slice(1).toLowerCase();
    if (!colors.has(key)) colors.set(key, { path: ['palette', key], hex, alpha });
  };
  const addPaint = (p: Paint) => {
    if (p.type === 'solid') addColor(p.color, p.opacity);
    else if (isGradient(p)) for (const s of p.stops) addColor(s.color, s.opacity * p.opacity);
  };
  const visit = (id: ID) => {
    const n = doc.nodes[id];
    if (!n || !n.visible) return;
    visiblePaints(n.fills).forEach(addPaint);
    visiblePaints(n.strokes).forEach(addPaint);
    for (const e of visibleEffects(n.effects)) if (e.type === 'drop-shadow' || e.type === 'inner-shadow' || e.type === 'glow') addColor(e.color, e.opacity);
    if (n.type === 'text') {
      const key = `${kebabCase(n.fontFamily) || 'font'}-${num(n.fontSize)}-${Math.round(n.fontWeight)}${n.italic ? '-italic' : ''}`.replace(/\./g, '_');
      if (!types.has(key)) types.set(key, { path: ['scale', key], style: n });
    }
    if (isContainer(n)) n.children.forEach(visit);
  };
  rootIds.forEach(visit);
  t.colors.push(...colors.values());
  t.typography.push(...types.values());
  return t;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown) {
  let cur = obj;
  for (const seg of path.slice(0, -1)) {
    if (typeof cur[seg] !== 'object' || cur[seg] === null || '$value' in (cur[seg] as object)) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** W3C Design Tokens (DTCG) JSON. */
export function tokensJson(doc: Doc, t: TokenSet): string {
  const out: Record<string, unknown> = { $description: `Design tokens exported from Alt — ${doc.name}` };
  const color: Record<string, unknown> = {};
  for (const c of t.colors) setPath(color, c.path, { $type: 'color', $value: hexColor(c.hex, c.alpha).toLowerCase() });
  if (Object.keys(color).length) out.color = color;
  const gradient: Record<string, unknown> = {};
  for (const g of t.gradients)
    setPath(gradient, g.path, {
      $type: 'gradient',
      $value: sortedStops(g.paint).map((s) => ({ color: hexColor(s.color, s.opacity * g.paint.opacity).toLowerCase(), position: r2(s.offset, 4) })),
      $extensions: { 'app.alt': { type: g.paint.type, from: g.paint.from, to: g.paint.to } },
    });
  if (Object.keys(gradient).length) out.gradient = gradient;
  const typography: Record<string, unknown> = {};
  for (const ty of t.typography) {
    const s = ty.style;
    setPath(typography, ty.path, {
      $type: 'typography',
      $value: { fontFamily: s.fontFamily, fontSize: `${num(s.fontSize)}px`, fontWeight: Math.round(s.fontWeight), lineHeight: r2(s.lineHeight, 3), letterSpacing: `${num(s.letterSpacing)}px` },
      ...(s.italic || s.textCase !== 'none' || s.textDecoration !== 'none' ? { $extensions: { 'app.alt': { italic: s.italic, textCase: s.textCase, textDecoration: s.textDecoration } } } : {}),
    });
  }
  if (Object.keys(typography).length) out.typography = typography;
  const shadow: Record<string, unknown> = {};
  for (const sh of t.shadows) {
    const v = sh.shadows.map((e) => ({
      color: hexColor(e.color, e.opacity).toLowerCase(),
      offsetX: `${num(e.x)}px`,
      offsetY: `${num(e.y)}px`,
      blur: `${num(e.blur)}px`,
      spread: `${num(e.spread)}px`,
      ...(e.type === 'inner-shadow' ? { inset: true } : {}),
    }));
    setPath(shadow, sh.path, { $type: 'shadow', $value: v.length === 1 ? v[0] : v });
  }
  if (Object.keys(shadow).length) out.shadow = shadow;
  return JSON.stringify(out, null, 2) + '\n';
}

const shadowCss = (e: ShadowEffect) => `${e.type === 'inner-shadow' ? 'inset ' : ''}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread)} ${cssColor(e.color, e.opacity)}`;

/** CSS custom properties (+ typography utility classes). */
export function tokensCss(doc: Doc, t: TokenSet): string {
  const lines: string[] = [`/* Design tokens — exported from Alt (${doc.name.replace(/\*\//g, '')}) */`, '', ':root {'];
  const section = (title: string, entries: [string, string][]) => {
    if (!entries.length) return;
    lines.push(`  /* ${title} */`, ...entries.map(([k, v]) => `  --${k}: ${v};`), '');
  };
  section('Colours', t.colors.map((c) => [`color-${c.path.join('-')}`, cssColor(c.hex, c.alpha)]));
  section('Gradients', t.gradients.map((g) => [`gradient-${g.path.join('-')}`, cssGradient(g.paint, 100, 100)]));
  const type: [string, string][] = [];
  for (const ty of t.typography) {
    const k = `font-${ty.path.join('-')}`;
    type.push([`${k}-family`, fontStack(ty.style.fontFamily)], [`${k}-size`, px(ty.style.fontSize)], [`${k}-weight`, String(Math.round(ty.style.fontWeight))], [`${k}-line-height`, num(ty.style.lineHeight, 3)]);
    if (ty.style.letterSpacing) type.push([`${k}-letter-spacing`, px(ty.style.letterSpacing)]);
  }
  section('Typography', type);
  section('Shadows', t.shadows.map((s) => [`shadow-${s.path.join('-')}`, s.shadows.map(shadowCss).join(', ')]));
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('}');
  for (const ty of t.typography) {
    const k = `font-${ty.path.join('-')}`;
    lines.push('', `.text-${ty.path.join('-')} {`, `  font-family: var(--${k}-family);`, `  font-size: var(--${k}-size);`, `  font-weight: var(--${k}-weight);`, `  line-height: var(--${k}-line-height);`);
    if (ty.style.letterSpacing) lines.push(`  letter-spacing: var(--${k}-letter-spacing);`);
    if (ty.style.italic) lines.push('  font-style: italic;');
    lines.push('}');
  }
  return lines.join('\n') + '\n';
}

export const tokensExporter: Exporter = {
  id: 'design-tokens',
  label: 'Design tokens',
  group: 'Data',
  extension: 'json',
  description: 'W3C design tokens (DTCG) for colour / text / effect styles and every colour & type style in use.',
  textual: true,
  async run(ctx) {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    return [{ name: 'tokens.json', mime: MIME.json, data: tokensJson(ctx.doc, collectTokens(ctx.doc, roots)) }];
  },
};

export const cssVariablesExporter: Exporter = {
  id: 'css-variables',
  label: 'CSS variables',
  group: 'Data',
  extension: 'css',
  description: 'Design tokens as CSS custom properties plus typography classes.',
  textual: true,
  async run(ctx) {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    return [{ name: 'tokens.css', mime: MIME.css, data: tokensCss(ctx.doc, collectTokens(ctx.doc, roots)) }];
  },
};

/* ======================================================== VectorDrawable */

const avdColor = (hex: string, alpha = 1) => `#${argbHex(hex, alpha)}`;

class VectorDrawableBuilder {
  readonly lines: string[] = [];
  readonly notes = new Set<string>();
  constructor(
    readonly doc: Doc,
    readonly rootId: ID,
  ) {}

  private gradient(p: GradientPaint, n: SceneNode, m: Mat, pad: string): string[] {
    const g = gradientGeom(p, n.width, n.height);
    const ap = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
    const from = ap(g.from.x, g.from.y);
    const to = ap(g.to.x, g.to.y);
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    let attrs: string;
    if (p.type === 'linear') attrs = `android:type="linear" android:startX="${num(from.x)}" android:startY="${num(from.y)}" android:endX="${num(to.x)}" android:endY="${num(to.y)}"`;
    else if (p.type === 'angular') {
      attrs = `android:type="sweep" android:centerX="${num(from.x)}" android:centerY="${num(from.y)}"`;
      if (Math.abs(g.angle) > 0.01) this.notes.add(`"${n.name}": sweep gradient start angle is not supported.`);
    } else {
      attrs = `android:type="radial" android:centerX="${num(from.x)}" android:centerY="${num(from.y)}" android:gradientRadius="${num(Math.max(0.01, ((g.rx + g.ry) / 2) * scale))}"`;
      if (p.type === 'diamond' || Math.abs(g.rx - g.ry) > 0.5) this.notes.add(`"${n.name}": ${p.type === 'diamond' ? 'diamond' : 'elliptical'} gradient approximated with a circular radial gradient.`);
    }
    return [
      `${pad}<gradient ${attrs}>`,
      ...sortedStops(p).map((s) => `${pad}    <item android:offset="${num(s.offset, 4)}" android:color="${avdColor(s.color, s.opacity * p.opacity)}" />`),
      `${pad}</gradient>`,
    ];
  }

  private path(n: SceneNode, m: Mat, alpha: number, level: number) {
    const pad = '    '.repeat(level);
    const d = cmdsToSvgD(transformCmds(n.type === 'frame' ? nodeCmds(n) : geometryOf(this.doc, n), m), 2);
    if (!d) return;
    const evenOdd = (n.type === 'path' && n.fillRule === 'evenodd') || n.type === 'boolean';
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const fills = visiblePaints(n.fills).filter((p) => p.type === 'solid' || isGradient(p));
    const strokes = n.strokeWidth > 0 ? visiblePaints(n.strokes).filter((p) => p.type === 'solid' || isGradient(p)) : [];
    if (visiblePaints(n.fills).some((p) => p.type === 'image' || p.type === 'pattern' || p.type === 'noise')) this.notes.add(`"${n.name}": image / pattern / noise paints are not supported.`);
    const emit = (kind: 'fill' | 'stroke', p: Paint) => {
      const attrs: string[] = [`android:name="${xmlAttr(snakeCase(n.name) || n.type)}"`, `android:pathData="${d}"`];
      const children: string[] = [];
      if (kind === 'fill') {
        if (p.type === 'solid') attrs.push(`android:fillColor="${avdColor(p.color, p.opacity)}"`);
        else children.push(`${pad}    <aapt:attr name="android:fillColor">`, ...this.gradient(p as GradientPaint, n, m, `${pad}        `), `${pad}    </aapt:attr>`);
        if (alpha < 0.999) attrs.push(`android:fillAlpha="${num(alpha, 3)}"`);
        if (evenOdd) attrs.push('android:fillType="evenOdd"');
      } else {
        if (p.type === 'solid') attrs.push(`android:strokeColor="${avdColor(p.color, p.opacity)}"`);
        else children.push(`${pad}    <aapt:attr name="android:strokeColor">`, ...this.gradient(p as GradientPaint, n, m, `${pad}        `), `${pad}    </aapt:attr>`);
        attrs.push(`android:strokeWidth="${num(n.strokeWidth * scale)}"`);
        if (n.strokeCap !== 'butt') attrs.push(`android:strokeLineCap="${n.strokeCap}"`);
        if (n.strokeJoin !== 'miter') attrs.push(`android:strokeLineJoin="${n.strokeJoin}"`);
        if (alpha < 0.999) attrs.push(`android:strokeAlpha="${num(alpha, 3)}"`);
      }
      this.lines.push(`${pad}<path`);
      attrs.forEach((a, i) => this.lines.push(`${pad}    ${a}${i === attrs.length - 1 ? (children.length ? '>' : ' />') : ''}`));
      if (children.length) this.lines.push(...children, `${pad}</path>`);
    };
    fills.forEach((p) => emit('fill', p));
    strokes.forEach((p) => emit('stroke', p));
    if (strokes.length && n.strokeAlign !== 'center' && (n.type !== 'path' || n.paths.every((sp) => sp.closed))) this.notes.add(`"${n.name}": ${n.strokeAlign} stroke drawn centred.`);
    if (n.dash.some((x) => x > 0)) this.notes.add(`"${n.name}": dashed strokes are not supported.`);
  }

  /** Emit a node; `m` maps its local space to the viewport. */
  node(n: SceneNode, m: Mat, alpha: number, level: number) {
    if (!n.visible && n.id !== this.rootId) return;
    const a = alpha * n.opacity;
    const pad = '    '.repeat(level);
    if (n.type === 'text') {
      this.lines.push(`${pad}<!-- text "${n.name.replace(/--/g, '—')}" is not supported in vector drawables -->`);
      return;
    }
    if (n.type === 'bitmap') {
      this.lines.push(`${pad}<!-- bitmap "${n.name.replace(/--/g, '—')}" is not supported in vector drawables -->`);
      return;
    }
    if (visibleEffects(n.effects).length) this.notes.add(`"${n.name}": effects are not supported.`);
    if (n.type === 'frame' || n.type === 'group') {
      if (n.type === 'frame') this.path(n, m, a, level);
      const kids = childNodes(this.doc, n);
      const clip = n.type === 'frame' && n.clipContent && kids.length;
      let lvl = level;
      if (clip) {
        this.lines.push(`${pad}<group android:name="${xmlAttr(snakeCase(n.name) || 'frame')}_clip">`);
        this.lines.push(`${pad}    <clip-path android:pathData="${cmdsToSvgD(transformCmds(nodeCmds(n), m), 2)}" />`);
        lvl++;
      }
      let open = 0;
      for (const k of kids) {
        const km = mul(m, localMatrix(k));
        if (k.isMask) {
          const p = '    '.repeat(lvl + open);
          this.lines.push(`${p}<group android:name="${xmlAttr(snakeCase(k.name) || 'mask')}">`, `${p}    <clip-path android:pathData="${cmdsToSvgD(transformCmds(geometryOf(this.doc, k), km), 2)}" />`);
          open++;
          continue;
        }
        this.node(k, km, a, lvl + open);
      }
      for (let i = open - 1; i >= 0; i--) this.lines.push(`${'    '.repeat(lvl + i)}</group>`);
      if (clip) this.lines.push(`${pad}</group>`);
      return;
    }
    this.path(n, m, a, level);
    if (n.type === 'path' && (n.startMarker !== 'none' || n.endMarker !== 'none')) this.notes.add(`"${n.name}": line end markers are not exported.`);
  }
}

export function buildVectorDrawable(doc: Doc, rootId: ID): string {
  const root = doc.nodes[rootId];
  const b = new VectorDrawableBuilder(doc, rootId);
  b.node(root, [1, 0, 0, 1, 0, 0], 1, 1);
  const w = Math.max(1, r2(root.width));
  const h = Math.max(1, r2(root.height));
  const head = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- ${root.name.replace(/--/g, '—')} — exported from Alt -->`,
    ...[...b.notes].map((n) => `<!-- ${n.replace(/--/g, '—')} -->`),
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '    xmlns:aapt="http://schemas.android.com/aapt"',
    `    android:width="${num(w)}dp"`,
    `    android:height="${num(h)}dp"`,
    `    android:viewportWidth="${num(w)}"`,
    `    android:viewportHeight="${num(h)}">`,
  ];
  return [...head, ...b.lines, '</vector>', ''].join('\n');
}

export const vectorDrawableExporter: Exporter = {
  id: 'android-vector',
  label: 'Android VectorDrawable',
  group: 'Native',
  extension: 'xml',
  description: 'Vector drawable XML (shapes, strokes, gradients via aapt:attr, clip paths).',
  textual: true,
  async run(ctx) {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    const names = new NameRegistry('snake', [], { prefixDigits: 'ic_' });
    return roots.map((id) => ({ name: `${names.get(ctx.doc.nodes[id].name, 'vector')}.xml`, mime: MIME.xml, data: buildVectorDrawable(ctx.doc, id) }));
  },
};

/* ============================================================ Unity UITK */

interface UnityImage {
  id: ID;
  file: string;
  assetId?: ID;
}

class UnityBuilder {
  /** USS rules in document order (parents before children) */
  readonly rules: { cls: string; decls: [string, string][] }[] = [];
  readonly images: UnityImage[] = [];
  readonly notes = new Set<string>();
  private classes = new NameRegistry('kebab');
  private files = new FileNamer();
  constructor(readonly doc: Doc) {}

  private note(n: SceneNode, msg: string) {
    this.notes.add(`"${n.name}": ${msg}`);
  }

  private image(n: SceneNode, assetId?: ID): string {
    const asset = assetId ? this.doc.assets[assetId] : undefined;
    const ok = asset && /png|jpe?g/.test(asset.mime);
    const file = this.files.get(sanitizeFileName(n.name), ok && /jpe?g/.test(asset!.mime) ? 'jpg' : 'png');
    this.images.push({ id: n.id, file, assetId: ok ? assetId : undefined });
    return file;
  }

  /** Returns UXML lines for a node. */
  node(n: SceneNode, mode: 'root' | 'abs' | 'flow', parent: SceneNode | null, index: number, level: number): string[] {
    if (!n.visible && mode !== 'root') return [];
    const pad = '    '.repeat(level);
    const cls = this.classes.get(n.name, n.type);
    const d: [string, string][] = [];
    this.rules.push({ cls, decls: d });
    const L = parent?.type === 'frame' ? parent.layout : null;
    // placement
    if (mode === 'root') d.push(['width', px(n.width)], ['height', px(n.height)]);
    let box = { x: n.x, y: n.y, width: n.width, height: n.height };
    const raster = isVectorNode(n) || ((n.type === 'frame' || n.type === 'group') && childNodes(this.doc, n).some((k) => k.isMask)) || visiblePaints(n.fills).some((p) => isGradient(p) && n.type !== 'frame');
    if (raster && mode !== 'root') box = transformRect(localMatrix(n), { x: 0, y: 0, width: n.width, height: n.height });
    if (mode === 'abs') d.push(['position', 'absolute'], ['left', px(box.x)], ['top', px(box.y)], ['width', px(box.width)], ['height', px(box.height)]);
    if (mode === 'flow' && L) {
      const horiz = L.mode === 'horizontal';
      const main = horiz ? n.sizingH : n.sizingV;
      const cross = horiz ? n.sizingV : n.sizingH;
      const hugMain = n.type === 'text' ? (horiz ? n.autoResize === 'width' : n.autoResize !== 'none') : n.type === 'frame' && !!n.layout && main === 'hug';
      if (main === 'fill') d.push(['flex-grow', '1'], ['flex-basis', '0']);
      else if (!hugMain) d.push([horiz ? 'width' : 'height', px(horiz ? n.width : n.height)], ['flex-shrink', '0']);
      if (cross === 'fill' || L.align === 'stretch') d.push(['align-self', 'stretch']);
      else d.push([horiz ? 'height' : 'width', px(horiz ? n.height : n.width)]);
      if (index > 0 && L.gap && L.justify !== 'space-between') d.push([horiz ? 'margin-left' : 'margin-top', px(L.gap)]);
    }
    if (mode !== 'root' && !raster) {
      if (r2(n.rotation, 3)) d.push(['rotate', `${num(n.rotation, 3)}deg`]);
      if (n.flipX || n.flipY) d.push(['scale', `${n.flipX ? -1 : 1} ${n.flipY ? -1 : 1}`]);
    }
    if (n.opacity < 0.999) d.push(['opacity', num(n.opacity, 3)]);
    if (n.blendMode !== 'normal') this.note(n, `blend mode ${n.blendMode} is not supported.`);
    if (visibleEffects(n.effects).length && !raster) this.note(n, 'effects are not supported in USS.');

    let tag = 'ui:VisualElement';
    let attrs = '';
    let children: string[] = [];
    if (raster && mode !== 'root') {
      d.push(['background-image', `url("${this.image(n)}")`], ['-unity-background-scale-mode', 'stretch-to-fill']);
    } else if (n.type === 'text') {
      tag = 'ui:Label';
      attrs = ` text="${xmlAttr(applyCase(n.text, n.textCase))}"`;
      d.push(['font-size', px(n.fontSize)]);
      const style = n.fontWeight >= 600 ? (n.italic ? 'bold-and-italic' : 'bold') : n.italic ? 'italic' : '';
      if (style) d.push(['-unity-font-style', style]);
      const fill = visiblePaints(n.fills).filter((p) => p.type !== 'image').at(-1);
      if (fill) d.push(['color', fill.type === 'solid' ? cssColor(fill.color, fill.opacity) : isGradient(fill) ? cssColor(sortedStops(fill)[0].color) : cssColor(fill.color, fill.opacity)]);
      const v = n.autoResize === 'none' ? { top: 'upper', middle: 'middle', bottom: 'lower' }[n.verticalAlign] : 'upper';
      const h = { left: 'left', center: 'center', right: 'right', justify: 'left' }[n.textAlign];
      d.push(['-unity-text-align', `${v}-${h}`], ['white-space', n.autoResize === 'width' ? 'nowrap' : 'normal']);
      if (n.letterSpacing) d.push(['letter-spacing', px(n.letterSpacing)]);
      d.push(['margin-left', '0'], ['margin-right', '0'], ['margin-top', '0'], ['margin-bottom', '0'], ['padding-left', '0'], ['padding-right', '0'], ['padding-top', '0'], ['padding-bottom', '0']);
      this.notes.add(`Fonts: assign a Font Asset for "${n.fontFamily}" with -unity-font-definition.`);
    } else if (n.type === 'bitmap') {
      if (this.doc.assets[n.assetId]) d.push(['background-image', `url("${this.image(n, n.assetId)}")`], ['-unity-background-scale-mode', 'stretch-to-fill']);
    } else {
      this.box(n, d);
      const kids = n.type === 'frame' || n.type === 'group' ? childNodes(this.doc, n) : [];
      const layout = n.type === 'frame' ? n.layout : null;
      const flow = !!layout && kids.every((k) => k.layoutPositioning !== 'absolute');
      if (layout && flow) {
        d.push(['flex-direction', layout.mode === 'horizontal' ? 'row' : 'column']);
        if (layout.wrap && layout.mode === 'horizontal') d.push(['flex-wrap', 'wrap']);
        d.push(['justify-content', { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' }[layout.justify]]);
        d.push(['align-items', { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }[layout.align]]);
        const [t, r, b, l] = layout.padding;
        if (t) d.push(['padding-top', px(t)]);
        if (r) d.push(['padding-right', px(r)]);
        if (b) d.push(['padding-bottom', px(b)]);
        if (l) d.push(['padding-left', px(l)]);
      } else if (layout) this.note(n, 'auto layout with absolutely positioned children exported with fixed positions.');
      if (n.type === 'frame' && n.clipContent && kids.length) d.push(['overflow', 'hidden']);
      kids.filter((k) => !k.isMask).forEach((k, i) => children.push(...this.node(k, flow ? 'flow' : 'abs', n, i, level + 1)));
    }
    const nameAttr = ` name="${xmlAttr(n.name)}"`;
    if (!children.length) return [`${pad}<${tag}${nameAttr}${attrs} class="${cls}" />`];
    return [`${pad}<${tag}${nameAttr}${attrs} class="${cls}">`, ...children, `${pad}</${tag}>`];
  }

  private box(n: SceneNode, d: [string, string][]) {
    const fills = visiblePaints(n.fills);
    const top = fills.filter((p) => p.type !== 'image').at(-1);
    if (top) {
      if (top.type === 'solid') d.push(['background-color', cssColor(top.color, top.opacity)]);
      else if (isGradient(top)) {
        d.push(['background-color', cssColor(sortedStops(top)[0].color, top.opacity)]);
        this.note(n, 'gradients are not supported in USS; the first colour is used.');
      } else d.push(['background-color', cssColor(top.background ?? top.color, top.opacity)]);
    }
    const img = fills.filter((p) => p.type === 'image').at(-1);
    if (img && img.type === 'image' && this.doc.assets[img.assetId]) {
      d.push(['background-image', `url("${this.image(n, img.assetId)}")`]);
      d.push(['-unity-background-scale-mode', { fill: 'scale-and-crop', crop: 'scale-and-crop', fit: 'scale-to-fit', stretch: 'stretch-to-fill', tile: 'scale-and-crop' }[img.fit]]);
    }
    const radii = isPlainEllipse(n) ? Array(4).fill(Math.min(n.width, n.height) / 2) : n.type === 'rect' || n.type === 'frame' ? cornerRadii(n) : [0, 0, 0, 0];
    const names = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
    if (uniformRadius(n) !== 0 || isPlainEllipse(n)) radii.forEach((r: number, i: number) => r > 0 && d.push([names[i], px(r)]));
    const stroke = visiblePaints(n.strokes).filter((p) => p.type === 'solid' || isGradient(p)).at(-1);
    if (stroke && n.strokeWidth > 0) {
      d.push(['border-width', px(n.strokeWidth)], ['border-color', stroke.type === 'solid' ? cssColor(stroke.color, stroke.opacity) : cssColor(sortedStops(stroke as GradientPaint)[0].color)]);
      if (n.strokeAlign !== 'inside') this.note(n, 'USS borders are drawn inside the box.');
    }
  }
}

export function buildUnity(doc: Doc, rootId: ID, ussFile: string): { uxml: string; uss: string; images: UnityImage[] } {
  const b = new UnityBuilder(doc);
  const body = b.node(doc.nodes[rootId], 'root', null, 0, 1);
  const notes = [...b.notes].map((n) => `    <!-- ${n.replace(/--/g, '—')} -->`);
  const uxml = [
    '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements" editor-extension-mode="False">',
    ...notes,
    `    <Style src="${xmlAttr(ussFile)}" />`,
    ...body,
    '</ui:UXML>',
    '',
  ].join('\n');
  const rules = b.rules.map((r) => [`.${r.cls} {`, ...r.decls.map(([k, v]) => `    ${k}: ${v};`), '}'].join('\n'));
  const uss = [`/* ${doc.nodes[rootId].name.replace(/\*\//g, '')} — exported from Alt */`, ...rules].join('\n\n') + '\n';
  return { uxml, uss, images: b.images };
}

export const unityExporter: Exporter = {
  id: 'unity-uitk',
  label: 'Unity UI Toolkit',
  group: 'Game engines',
  extension: 'uxml',
  description: 'UXML layout + USS styles for Unity UI Toolkit (flexbox auto layout, images as textures).',
  textual: true,
  async run(ctx) {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    const names = new NameRegistry('pascal', [], { prefixDigits: 'Layer' });
    const out: ExportFile[] = [];
    for (const id of roots) {
      const name = names.get(ctx.doc.nodes[id].name, 'Screen');
      const { uxml, uss, images } = buildUnity(ctx.doc, id, `${name}.uss`);
      out.push({ name: `${name}.uxml`, mime: MIME.uxml, data: uxml }, { name: `${name}.uss`, mime: MIME.uss, data: uss });
      for (const img of images) {
        const decoded = img.assetId ? dataUrlToBytes(ctx.doc.assets[img.assetId]?.data ?? '') : null;
        if (decoded) out.push({ name: img.file, mime: decoded.mime, data: decoded.bytes });
        else {
          try {
            out.push({ name: img.file, mime: 'image/png', data: await ctx.rasterize([img.id], { scale: 2, format: 'png', background: null }) });
          } catch (e) {
            console.warn(`Couldn't rasterize ${img.file}`, e);
          }
        }
      }
    }
    return out;
  },
};
