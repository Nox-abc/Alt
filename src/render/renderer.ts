import type { BitmapNode, Doc, Effect, ID, PathNode, Rect, SceneNode, TextNode } from '../core/types';
import { IDENTITY, localMatrix, mul, transformRect, translate, type Mat } from '../core/geometry';
import { cmdsToPath2D, traceCmds, type PathCmd } from '../core/path';
import { getRadii, markerCmds, nodeCmds, roundRectCmds, ellipseCmds } from '../core/shapes';
import { booleanCmds } from '../core/boolean';
import { layoutText } from '../core/text';
import { hexToRgba, isContainer } from '../core/doc';
import { assets } from './assets';
import { compositeOp, drawPaint, makeCanvas, noiseTile, type Ctx2D } from './paint';

export interface RenderEnv {
  doc: Doc;
  /** device pixels per world unit */
  scale: number;
  /** nodes that are not drawn (e.g. text being edited) */
  skip?: Set<ID>;
  /** wireframe mode */
  outline?: boolean;
  outlineColor?: string;
}

interface Surface {
  ctx: Ctx2D;
  /** device-space position of the surface's top-left pixel */
  ox: number;
  oy: number;
  w: number;
  h: number;
}

const SHADOW_OFF = 50000;

/* ----------------------------------------------------------- canvas pool */

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
const pool: AnyCanvas[] = [];

function acquire(w: number, h: number): { canvas: AnyCanvas; ctx: Ctx2D } {
  w = Math.max(1, Math.ceil(w));
  h = Math.max(1, Math.ceil(h));
  let c = pool.pop();
  if (!c) c = makeCanvas(w, h);
  if (c.width < w || c.height < h || c.width > w * 2 + 256 || c.height > h * 2 + 256) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d') as Ctx2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.clearRect(0, 0, w, h);
  return { canvas: c, ctx };
}

function release(c: AnyCanvas) {
  if (pool.length < 16) pool.push(c);
}

/* -------------------------------------------------------------- geometry */

const pathCache = new WeakMap<object, Path2D>();

export function nodePath(doc: Doc, n: SceneNode): Path2D {
  if (n.type === 'boolean') {
    const cmds = booleanCmds(doc, n);
    let p = pathCache.get(cmds);
    if (!p) {
      p = cmdsToPath2D(cmds);
      pathCache.set(cmds, p);
    }
    return p;
  }
  let p = pathCache.get(n);
  if (!p) {
    p = cmdsToPath2D(nodeCmds(n));
    pathCache.set(n, p);
  }
  return p;
}

function setTransform(s: Surface, m: Mat) {
  s.ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - s.ox, m[5] - s.oy);
}

function visibleEffects(n: SceneNode): Effect[] {
  return n.effects.filter((e) => e.visible);
}

function strokeExtent(n: SceneNode): number {
  if (!n.strokes.some((p) => p.visible)) return 0;
  const sw = n.strokeWidth;
  let e = n.strokeAlign === 'outside' ? sw : n.strokeAlign === 'inside' ? 0 : sw / 2;
  if (n.strokeJoin === 'miter') e *= 2;
  if (n.type === 'path' && (n.startMarker !== 'none' || n.endMarker !== 'none')) e = Math.max(e, sw * 5 + 6);
  if (n.type === 'path' && n.strokeCap !== 'butt') e = Math.max(e, sw);
  return e;
}

function effectMargin(n: SceneNode, scale: number): number {
  let m = 0;
  for (const e of visibleEffects(n)) {
    switch (e.type) {
      case 'drop-shadow':
        m = Math.max(m, (Math.max(Math.abs(e.x), Math.abs(e.y)) + e.blur * 1.5 + Math.max(0, e.spread)) * scale);
        break;
      case 'glow':
        m = Math.max(m, (e.blur * 1.5 + Math.max(0, e.spread)) * scale);
        break;
      case 'layer-blur':
        m = Math.max(m, e.radius * 1.5 * scale);
        break;
    }
  }
  return Math.ceil(m) + 2;
}

/** Device-space bounds of everything a node draws (excluding effects). */
function contentBounds(doc: Doc, n: SceneNode, m: Mat, scale: number): Rect {
  if (n.type === 'text') {
    // text may overflow a fixed box
    const l = layoutText(n);
    const ext = strokeExtent(n);
    const w = Math.max(n.width, l.contentWidth);
    const h = Math.max(n.height, l.contentHeight);
    return transformRect(m, { x: -ext - 2, y: Math.min(0, l.lines[0]?.top ?? 0) - ext - 2, width: w + ext * 2 + 4, height: h + ext * 2 + 4 });
  }
  const ext = strokeExtent(n);
  let r = transformRect(m, { x: -ext, y: -ext, width: n.width + ext * 2, height: n.height + ext * 2 });
  if (n.type === 'frame' && !n.clipContent) {
    for (const id of n.children) {
      const k = doc.nodes[id];
      if (!k || !k.visible) continue;
      const km = mul(m, localMatrix(k));
      const kb = contentBounds(doc, k, km, scale);
      const em = effectMargin(k, scale);
      r = union(r, { x: kb.x - em, y: kb.y - em, width: kb.width + em * 2, height: kb.height + em * 2 });
    }
  } else if (n.type === 'group') {
    for (const id of n.children) {
      const k = doc.nodes[id];
      if (!k || !k.visible) continue;
      const km = mul(m, localMatrix(k));
      const kb = contentBounds(doc, k, km, scale);
      const em = effectMargin(k, scale);
      r = union(r, { x: kb.x - em, y: kb.y - em, width: kb.width + em * 2, height: kb.height + em * 2 });
    }
  }
  return r;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r <= x || btm <= y) return null;
  return { x, y, width: r - x, height: btm - y };
}

function needsLayer(n: SceneNode): boolean {
  if (n.effects.some((e) => e.visible)) return true;
  if (n.opacity < 1) {
    if (isContainer(n)) return true;
    if (n.fills.some((f) => f.visible) && n.strokes.some((f) => f.visible) && n.strokeWidth > 0) return true;
    if (n.type === 'text' && n.fills.filter((f) => f.visible).length > 1) return true;
  }
  if (n.blendMode !== 'normal' && isContainer(n)) return true;
  return false;
}

/* --------------------------------------------------------------- drawing */

export function drawChildren(s: Surface, ids: ID[], parentM: Mat, env: RenderEnv) {
  for (let i = 0; i < ids.length; i++) {
    const n = env.doc.nodes[ids[i]];
    if (!n || !n.visible || env.skip?.has(n.id)) continue;
    if (n.isMask && !env.outline) {
      drawMasked(s, n, ids.slice(i + 1), parentM, env);
      return;
    }
    drawNode(s, n, parentM, env);
  }
}

function surfaceRect(s: Surface): Rect {
  return { x: s.ox, y: s.oy, width: s.w, height: s.h };
}

function drawMasked(s: Surface, mask: SceneNode, rest: ID[], parentM: Mat, env: RenderEnv) {
  const m = mul(parentM, localMatrix(mask));
  const mb = contentBounds(env.doc, mask, m, env.scale);
  const r = intersect(mb, surfaceRect(s));
  if (!r) return;
  const C = acquire(r.width, r.height);
  const cs: Surface = { ctx: C.ctx, ox: r.x, oy: r.y, w: r.width, h: r.height };
  drawChildren(cs, rest, parentM, env);
  const M = acquire(r.width, r.height);
  const ms: Surface = { ctx: M.ctx, ox: r.x, oy: r.y, w: r.width, h: r.height };
  drawNode(ms, { ...mask, isMask: false, opacity: 1 } as SceneNode, parentM, env);
  C.ctx.setTransform(1, 0, 0, 1, 0, 0);
  C.ctx.globalCompositeOperation = 'destination-in';
  C.ctx.drawImage(M.canvas as CanvasImageSource, 0, 0);
  C.ctx.globalCompositeOperation = 'source-over';
  s.ctx.save();
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalAlpha = mask.opacity;
  s.ctx.drawImage(C.canvas as CanvasImageSource, r.x - s.ox, r.y - s.oy);
  s.ctx.restore();
  release(M.canvas);
  release(C.canvas);
}

export function drawNode(s: Surface, n: SceneNode, parentM: Mat, env: RenderEnv) {
  const m = mul(parentM, localMatrix(n));
  const cb = contentBounds(env.doc, n, m, env.scale);
  const em = env.outline ? 2 : effectMargin(n, env.scale);
  const full = { x: cb.x - em, y: cb.y - em, width: cb.width + em * 2, height: cb.height + em * 2 };
  const vis = intersect(full, surfaceRect(s));
  if (!vis) return;
  if (env.outline || !needsLayer(n)) {
    const ctx = s.ctx;
    ctx.save();
    if (!env.outline) {
      ctx.globalAlpha *= n.opacity;
      if (n.blendMode !== 'normal') ctx.globalCompositeOperation = compositeOp(n.blendMode);
    }
    drawContent(s, n, m, env);
    ctx.restore();
    return;
  }
  drawLayered(s, n, m, vis, env);
}

function adjustFilter(effects: Effect[], scale: number): string {
  const parts: string[] = [];
  for (const e of effects) {
    if (e.type === 'layer-blur' && e.radius > 0) parts.push(`blur(${((e.radius / 2) * scale).toFixed(2)}px)`);
    if (e.type === 'adjust') {
      if (e.brightness) parts.push(`brightness(${1 + e.brightness})`);
      if (e.contrast) parts.push(`contrast(${1 + e.contrast})`);
      if (e.saturation) parts.push(`saturate(${1 + e.saturation})`);
      if (e.hue) parts.push(`hue-rotate(${e.hue}deg)`);
      if (e.grayscale) parts.push(`grayscale(${e.grayscale})`);
      if (e.sepia) parts.push(`sepia(${e.sepia})`);
      if (e.invert) parts.push(`invert(${e.invert})`);
    }
  }
  return parts.length ? parts.join(' ') : 'none';
}

function spreadPath(n: SceneNode, spread: number): Path2D | null {
  if (n.type === 'rect' || n.type === 'frame') {
    const radii = getRadii(n).map((r) => (r > 0 ? r + spread : 0)) as [number, number, number, number];
    const w = Math.max(0, n.width + spread * 2);
    const h = Math.max(0, n.height + spread * 2);
    const cmds = roundRectCmds(w, h, radii, n.cornerSmoothing);
    const p = new Path2D();
    const shifted: PathCmd[] = cmds.map((k) =>
      k.c === 'Z'
        ? k
        : k.c === 'C'
          ? { ...k, x1: k.x1 - spread, y1: k.y1 - spread, x2: k.x2 - spread, y2: k.y2 - spread, x: k.x - spread, y: k.y - spread }
          : { ...k, x: k.x - spread, y: k.y - spread },
    );
    traceCmds(p, shifted);
    return p;
  }
  if (n.type === 'ellipse') {
    const cmds = ellipseCmds(Math.max(0, n.width + spread * 2), Math.max(0, n.height + spread * 2), n.arcStart, n.arcSweep, n.innerRadius);
    const p = new Path2D();
    traceCmds(
      p,
      cmds.map((k) =>
        k.c === 'Z'
          ? k
          : k.c === 'C'
            ? { ...k, x1: k.x1 - spread, y1: k.y1 - spread, x2: k.x2 - spread, y2: k.y2 - spread, x: k.x - spread, y: k.y - spread }
            : { ...k, x: k.x - spread, y: k.y - spread },
      ),
    );
    return p;
  }
  return null;
}

function drawLayered(s: Surface, n: SceneNode, m: Mat, r: Rect, env: RenderEnv) {
  const effects = visibleEffects(n);
  const scale = env.scale;
  const L = acquire(r.width, r.height);
  const ls: Surface = { ctx: L.ctx, ox: r.x, oy: r.y, w: r.width, h: r.height };
  drawContent(ls, n, m, env);
  const lw = Math.ceil(r.width);
  const lh = Math.ceil(r.height);

  // inner shadows & noise are painted onto the layer itself
  for (const e of effects) {
    if (e.type === 'inner-shadow') {
      const M = Math.ceil((Math.max(Math.abs(e.x), Math.abs(e.y)) + e.blur * 2) * scale) + 4;
      const inv = acquire(lw + M * 2, lh + M * 2);
      inv.ctx.fillStyle = '#000';
      inv.ctx.fillRect(0, 0, lw + M * 2, lh + M * 2);
      inv.ctx.globalCompositeOperation = 'destination-out';
      inv.ctx.drawImage(L.canvas as CanvasImageSource, M, M);
      inv.ctx.globalCompositeOperation = 'source-over';
      const c = L.ctx;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-atop';
      c.shadowColor = hexToRgba(e.color, e.opacity);
      c.shadowBlur = e.blur * scale;
      c.shadowOffsetX = e.x * scale + SHADOW_OFF;
      c.shadowOffsetY = e.y * scale;
      c.drawImage(inv.canvas as CanvasImageSource, -M - SHADOW_OFF, -M);
      c.restore();
      release(inv.canvas);
    } else if (e.type === 'noise' && e.amount > 0) {
      const tile = noiseTile(0.5, null, 7);
      const c = L.ctx;
      const pat = c.createPattern(tile as CanvasImageSource, 'repeat');
      if (pat) {
        pat.setTransform(new DOMMatrix().translate(-r.x, -r.y).scale(Math.max(0.5, e.size * scale * 0.5)));
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = 'source-atop';
        c.globalAlpha = e.amount;
        c.imageSmoothingEnabled = false;
        if (!e.monochrome) c.filter = 'hue-rotate(45deg) saturate(4)';
        c.fillStyle = pat;
        c.fillRect(0, 0, lw, lh);
        c.restore();
      }
    }
  }

  const ctx = s.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= n.opacity;
  ctx.globalCompositeOperation = compositeOp(n.blendMode);
  const dx = r.x - s.ox;
  const dy = r.y - s.oy;

  // drop shadows & glows (behind)
  for (const e of effects) {
    if (e.type !== 'drop-shadow' && e.type !== 'glow') continue;
    const ox = e.type === 'drop-shadow' ? e.x : 0;
    const oy = e.type === 'drop-shadow' ? e.y : 0;
    ctx.save();
    ctx.shadowColor = hexToRgba(e.color, e.opacity);
    ctx.shadowBlur = e.blur * scale;
    ctx.shadowOffsetX = ox * scale + SHADOW_OFF;
    ctx.shadowOffsetY = oy * scale;
    const sp = e.spread ? spreadPath(n, e.spread) : null;
    if (sp) {
      const mm = mul(translate(-s.ox - SHADOW_OFF, -s.oy), m);
      ctx.setTransform(mm[0], mm[1], mm[2], mm[3], mm[4], mm[5]);
      ctx.fillStyle = '#000';
      ctx.fill(sp);
    } else {
      ctx.drawImage(L.canvas as CanvasImageSource, 0, 0, lw, lh, dx - SHADOW_OFF, dy, lw, lh);
      if (e.type === 'glow') ctx.drawImage(L.canvas as CanvasImageSource, 0, 0, lw, lh, dx - SHADOW_OFF, dy, lw, lh);
    }
    ctx.restore();
  }

  // background blur – blur what's already on the surface, clipped to the shape
  for (const e of effects) {
    if (e.type !== 'background-blur' || e.radius <= 0) continue;
    const B = acquire(lw, lh);
    B.ctx.filter = `blur(${((e.radius / 2) * scale).toFixed(2)}px)`;
    const src = s.ctx.canvas as CanvasImageSource;
    B.ctx.drawImage(src, dx, dy, lw, lh, 0, 0, lw, lh);
    B.ctx.filter = 'none';
    ctx.save();
    const mm = mul(translate(-s.ox, -s.oy), m);
    ctx.setTransform(mm[0], mm[1], mm[2], mm[3], mm[4], mm[5]);
    ctx.clip(nodePath(env.doc, n));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(B.canvas as CanvasImageSource, 0, 0, lw, lh, dx, dy, lw, lh);
    ctx.restore();
    release(B.canvas);
  }

  const filter = adjustFilter(effects, scale);
  if (filter !== 'none') ctx.filter = filter;
  ctx.drawImage(L.canvas as CanvasImageSource, 0, 0, lw, lh, dx, dy, lw, lh);
  ctx.restore();
  release(L.canvas);
}

function hasVisible(p: { visible: boolean; opacity: number }[]) {
  return p.some((x) => x.visible && x.opacity > 0);
}

function isClosedShape(n: SceneNode): boolean {
  if (n.type === 'path') return n.paths.length > 0 && n.paths.every((p) => p.closed);
  return n.type !== 'text';
}

function drawStrokes(s: Surface, n: SceneNode, path: Path2D, m: Mat, env: RenderEnv, fillRule: CanvasFillRule) {
  if (!hasVisible(n.strokes) || n.strokeWidth <= 0) return;
  const ctx = s.ctx;
  setTransform(s, m);
  ctx.lineCap = n.strokeCap;
  ctx.lineJoin = n.strokeJoin;
  ctx.miterLimit = 4;
  ctx.setLineDash(n.dash.length ? n.dash : []);
  const align = isClosedShape(n) ? n.strokeAlign : 'center';
  ctx.save();
  if (align === 'inside') {
    ctx.clip(path, fillRule);
    ctx.lineWidth = n.strokeWidth * 2;
  } else if (align === 'outside') {
    const inv = new Path2D();
    const big = 1e6;
    inv.rect(-big, -big, big * 2, big * 2);
    inv.addPath(path);
    ctx.clip(inv, 'evenodd');
    ctx.lineWidth = n.strokeWidth * 2;
  } else ctx.lineWidth = n.strokeWidth;
  for (const p of n.strokes) drawPaint(ctx, env.doc, p, path, n.width, n.height, { stroke: true, scale: env.scale });
  ctx.restore();
  ctx.setLineDash([]);
}

function drawMarkers(s: Surface, n: PathNode, m: Mat, env: RenderEnv) {
  if (n.startMarker === 'none' && n.endMarker === 'none') return;
  const paint = n.strokes.find((p) => p.visible);
  if (!paint) return;
  const open = n.paths.filter((p) => !p.closed && p.points.length > 1);
  if (!open.length) return;
  const ctx = s.ctx;
  setTransform(s, m);
  const draw = (marker: PathNode['startMarker'], at: { x: number; y: number }, from: { x: number; y: number }) => {
    if (marker === 'none') return;
    const angle = Math.atan2(at.y - from.y, at.x - from.x);
    const { cmds, filled } = markerCmds(marker, at, angle, n.strokeWidth);
    const p = cmdsToPath2D(cmds);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = n.strokeWidth;
    if (filled) drawPaint(ctx, env.doc, paint, p, n.width, n.height, { scale: env.scale });
    else drawPaint(ctx, env.doc, paint, p, n.width, n.height, { stroke: true, scale: env.scale });
    ctx.restore();
  };
  const first = open[0];
  const p0 = first.points[0];
  const p1 = first.points[1];
  draw(n.startMarker, p0, p0.out ?? p1.in ?? p1);
  const last = open[open.length - 1];
  const pn = last.points[last.points.length - 1];
  const pm = last.points[last.points.length - 2];
  draw(n.endMarker, pn, pn.in ?? pm.out ?? pm);
}

function drawText(s: Surface, n: TextNode, m: Mat, env: RenderEnv) {
  if (env.skip?.has(n.id)) return;
  const ctx = s.ctx;
  setTransform(s, m);
  const L = layoutText(n);
  ctx.font = L.font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  (ctx as any).letterSpacing = `${n.letterSpacing}px`;
  (ctx as any).fontKerning = 'normal';
  const empty = new Path2D();
  const drawLines = (mode: 'fill' | 'stroke') => (style: string | CanvasGradient | CanvasPattern) => {
    if (mode === 'fill') ctx.fillStyle = style;
    else ctx.strokeStyle = style;
    for (const line of L.lines) {
      if (!line.text) continue;
      (ctx as any).wordSpacing = line.wordSpacing ? `${line.wordSpacing}px` : '0px';
      if (mode === 'fill') ctx.fillText(line.text, line.x, line.baseline);
      else ctx.strokeText(line.text, line.x, line.baseline);
      if (n.textDecoration !== 'none' && mode === 'fill') {
        const th = Math.max(1, n.fontSize / 14);
        const y = n.textDecoration === 'underline' ? line.baseline + n.fontSize * 0.12 : line.baseline - n.fontSize * 0.3;
        ctx.fillRect(line.x, y - th / 2, line.width + (line.wordSpacing ? line.wordSpacing * (line.text.split(' ').length - 1) : 0), th);
      }
    }
    (ctx as any).wordSpacing = '0px';
  };
  if (env.outline) {
    drawLines('fill')(env.outlineColor ?? '#888');
    return;
  }
  const strokesVisible = hasVisible(n.strokes) && n.strokeWidth > 0;
  const outsideStroke = strokesVisible && n.strokeAlign === 'outside';
  const strokeAll = () => {
    ctx.lineJoin = 'round';
    ctx.lineWidth = n.strokeAlign === 'outside' ? n.strokeWidth * 2 : n.strokeWidth;
    for (const p of n.strokes) drawPaint(ctx, env.doc, p, empty, n.width, n.height, { scale: env.scale, text: drawLines('stroke') });
  };
  if (outsideStroke) strokeAll();
  for (const p of n.fills) drawPaint(ctx, env.doc, p, empty, Math.max(n.width, L.contentWidth), Math.max(n.height, L.contentHeight), { scale: env.scale, text: drawLines('fill') });
  if (strokesVisible && !outsideStroke) strokeAll();
  (ctx as any).letterSpacing = '0px';
}

function drawBitmap(s: Surface, n: BitmapNode, m: Mat, env: RenderEnv) {
  const ctx = s.ctx;
  setTransform(s, m);
  const img = n.assetId ? assets.get(env.doc, n.assetId) : null;
  if (env.outline) {
    ctx.strokeStyle = env.outlineColor ?? '#888';
    ctx.lineWidth = 1 / env.scale;
    ctx.strokeRect(0, 0, n.width, n.height);
    return;
  }
  if (!img) return;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = n.smoothing;
  if (n.smoothing) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, n.width, n.height);
  ctx.imageSmoothingEnabled = prev;
}

function drawContent(s: Surface, n: SceneNode, m: Mat, env: RenderEnv) {
  const ctx = s.ctx;
  const doc = env.doc;
  if (env.outline) {
    if (n.type === 'group') return drawChildren(s, n.children, m, env);
    if (n.type === 'text') return drawText(s, n, m, env);
    if (n.type === 'bitmap') return drawBitmap(s, n, m, env);
    const path = nodePath(doc, n);
    setTransform(s, m);
    ctx.strokeStyle = env.outlineColor ?? '#888';
    ctx.lineWidth = 1 / env.scale;
    ctx.stroke(path);
    if (n.type === 'frame') {
      if (n.clipContent) {
        ctx.save();
        ctx.clip(path);
        drawChildren(s, n.children, m, env);
        ctx.restore();
      } else drawChildren(s, n.children, m, env);
    }
    return;
  }
  switch (n.type) {
    case 'group':
      drawChildren(s, n.children, m, env);
      return;
    case 'text':
      drawText(s, n, m, env);
      return;
    case 'bitmap':
      drawBitmap(s, n, m, env);
      drawStrokes(s, n, nodePath(doc, n), m, env, 'nonzero');
      return;
    case 'frame': {
      const path = nodePath(doc, n);
      setTransform(s, m);
      for (const p of n.fills) drawPaint(ctx, doc, p, path, n.width, n.height, { scale: env.scale });
      if (n.children.length) {
        if (n.clipContent) {
          ctx.save();
          setTransform(s, m);
          ctx.clip(path);
          drawChildren(s, n.children, m, env);
          ctx.restore();
        } else drawChildren(s, n.children, m, env);
      }
      drawStrokes(s, n, path, m, env, 'nonzero');
      return;
    }
    default: {
      const path = nodePath(doc, n);
      const rule: CanvasFillRule = n.type === 'path' ? n.fillRule : n.type === 'boolean' ? 'evenodd' : 'nonzero';
      setTransform(s, m);
      for (const p of n.fills) drawPaint(ctx, doc, p, path, n.width, n.height, { scale: env.scale, fillRule: rule });
      drawStrokes(s, n, path, m, env, rule);
      if (n.type === 'path') drawMarkers(s, n, m, env);
    }
  }
}

/* ----------------------------------------------------------- entry points */

export interface PageRenderOptions {
  /** CSS-pixel pan */
  panX: number;
  panY: number;
  zoom: number;
  dpr: number;
  background: string;
  skip?: Set<ID>;
  outline?: boolean;
  outlineColor?: string;
}

/** Render a whole page into a canvas sized to the viewport. */
export function renderPage(ctx: CanvasRenderingContext2D, doc: Doc, pageId: ID, o: PageRenderOptions) {
  const page = doc.pages.find((p) => p.id === pageId);
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = page?.background || o.background;
  ctx.fillRect(0, 0, W, H);
  if (!page) return;
  const scale = o.zoom * o.dpr;
  const base: Mat = [scale, 0, 0, scale, o.panX * o.dpr, o.panY * o.dpr];
  const env: RenderEnv = { doc, scale, skip: o.skip, outline: o.outline, outlineColor: o.outlineColor };
  drawChildren({ ctx, ox: 0, oy: 0, w: W, h: H }, page.children, base, env);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Render specific nodes (with their ancestors' transforms) using a page→device matrix. */
export function renderNodesInto(ctx: Ctx2D, doc: Doc, ids: ID[], pageToDevice: Mat, scale: number) {
  const env: RenderEnv = { doc, scale };
  const s: Surface = { ctx, ox: 0, oy: 0, w: ctx.canvas.width, h: ctx.canvas.height };
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n || !n.visible) continue;
    // parent chain matrix
    let pm: Mat = [...IDENTITY];
    const chain: SceneNode[] = [];
    let cur = doc.nodes[n.parentId];
    while (cur) {
      chain.unshift(cur);
      cur = doc.nodes[cur.parentId];
    }
    for (const a of chain) pm = mul(pm, localMatrix(a));
    drawNode(s, n, mul(pageToDevice, pm), env);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
