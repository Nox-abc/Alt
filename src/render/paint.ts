import type { BlendMode, Doc, GradientPaint, ImagePaint, NoisePaint, Paint, PatternPaint } from '../core/types';
import { hexToRgb, hexToRgba } from '../core/doc';
import { assets } from './assets';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function compositeOp(b: BlendMode | undefined): GlobalCompositeOperation {
  if (!b || b === 'normal') return 'source-over';
  if (b === 'plus-lighter') return 'lighter';
  return b as GlobalCompositeOperation;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/* ------------------------------------------------------------- gradients */

function stopColor(s: { color: string; opacity: number }, mul: number) {
  return hexToRgba(s.color, s.opacity * mul);
}

function addStops(g: CanvasGradient, p: GradientPaint) {
  const stops = [...p.stops].sort((a, b) => a.offset - b.offset);
  for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.offset)), stopColor(s, 1));
}

const diamondCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

/** 256² texture of a diamond gradient centred in the tile, radius = half tile. */
function diamondTexture(p: GradientPaint) {
  const key = JSON.stringify(p.stops);
  const hit = diamondCache.get(key);
  if (hit) return hit;
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d') as Ctx2D;
  const img = g.createImageData(S, S);
  const stops = [...p.stops].sort((a, b) => a.offset - b.offset).map((s) => ({ ...hexToRgb(s.color), a: s.opacity, o: s.offset }));
  const sample = (t: number) => {
    if (t <= stops[0].o) return stops[0];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].o) {
        const a = stops[i - 1];
        const b = stops[i];
        const k = (t - a.o) / (b.o - a.o || 1);
        return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k, o: t };
      }
    }
    return stops[stops.length - 1];
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const t = (Math.abs(x + 0.5 - S / 2) + Math.abs(y + 0.5 - S / 2)) / (S / 2);
      const c2 = sample(Math.min(1, t));
      const i = (y * S + x) * 4;
      img.data[i] = c2.r;
      img.data[i + 1] = c2.g;
      img.data[i + 2] = c2.b;
      img.data[i + 3] = c2.a * 255;
    }
  g.putImageData(img, 0, 0);
  if (diamondCache.size > 64) diamondCache.clear();
  diamondCache.set(key, c);
  return c;
}

/** Create a canvas style for a gradient in local units (w×h box). */
export function gradientStyle(ctx: Ctx2D, p: GradientPaint, w: number, h: number): CanvasGradient | null {
  const fx = p.from.x * w;
  const fy = p.from.y * h;
  const tx = p.to.x * w;
  const ty = p.to.y * h;
  if (p.type === 'linear') {
    const g = ctx.createLinearGradient(fx, fy, tx, ty);
    addStops(g, p);
    return g;
  }
  if (p.type === 'radial' || p.type === 'diamond') {
    const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.max(0.001, Math.hypot(tx - fx, ty - fy)));
    addStops(g, p);
    return g;
  }
  if (p.type === 'angular') {
    const g = ctx.createConicGradient(Math.atan2(ty - fy, tx - fx), fx, fy);
    addStops(g, p);
    return g;
  }
  return null;
}

/* --------------------------------------------------------------- patterns */

const patternCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
const TILE = 64;

function patternTile(p: PatternPaint) {
  const key = `${p.pattern}|${p.color}|${p.background}|${p.weight}`;
  const hit = patternCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(TILE, TILE);
  const g = c.getContext('2d') as Ctx2D;
  if (p.background) {
    g.fillStyle = p.background;
    g.fillRect(0, 0, TILE, TILE);
  }
  g.fillStyle = p.color;
  g.strokeStyle = p.color;
  const wt = Math.max(0.05, Math.min(1, p.weight));
  const lw = Math.max(1, wt * 16);
  g.lineWidth = lw;
  g.lineCap = 'square';
  switch (p.pattern) {
    case 'dots':
      g.beginPath();
      g.arc(TILE / 2, TILE / 2, Math.max(1.5, wt * 20), 0, Math.PI * 2);
      g.fill();
      break;
    case 'grid':
      g.fillRect(0, 0, TILE, lw / 2);
      g.fillRect(0, TILE - lw / 2, TILE, lw / 2);
      g.fillRect(0, 0, lw / 2, TILE);
      g.fillRect(TILE - lw / 2, 0, lw / 2, TILE);
      break;
    case 'lines':
      g.fillRect(0, TILE / 2 - lw / 2, TILE, lw);
      break;
    case 'diagonal':
      g.beginPath();
      g.moveTo(-8, TILE + 8);
      g.lineTo(TILE + 8, -8);
      g.moveTo(-8, 8);
      g.lineTo(8, -8);
      g.moveTo(TILE - 8, TILE + 8);
      g.lineTo(TILE + 8, TILE - 8);
      g.stroke();
      break;
    case 'checker':
      g.fillRect(0, 0, TILE / 2, TILE / 2);
      g.fillRect(TILE / 2, TILE / 2, TILE / 2, TILE / 2);
      break;
    case 'cross':
      g.fillRect(TILE / 2 - lw / 2, TILE / 4, lw, TILE / 2);
      g.fillRect(TILE / 4, TILE / 2 - lw / 2, TILE / 2, lw);
      break;
    case 'waves':
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(0, TILE / 2);
      g.bezierCurveTo(TILE / 4, TILE / 2 - 16, TILE / 4, TILE / 2 - 16, TILE / 2, TILE / 2);
      g.bezierCurveTo((3 * TILE) / 4, TILE / 2 + 16, (3 * TILE) / 4, TILE / 2 + 16, TILE, TILE / 2);
      g.stroke();
      break;
    case 'zigzag':
      g.lineJoin = 'miter';
      g.beginPath();
      g.moveTo(0, TILE / 2 + 10);
      g.lineTo(TILE / 2, TILE / 2 - 10);
      g.lineTo(TILE, TILE / 2 + 10);
      g.stroke();
      break;
    case 'triangles':
      g.beginPath();
      g.moveTo(TILE / 2, TILE * 0.2);
      g.lineTo(TILE * 0.8, TILE * 0.75);
      g.lineTo(TILE * 0.2, TILE * 0.75);
      g.closePath();
      g.fill();
      break;
    case 'hexagons': {
      g.lineWidth = Math.max(1, wt * 6);
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const x = TILE / 2 + Math.cos(a) * TILE * 0.38;
        const y = TILE / 2 + Math.sin(a) * TILE * 0.38;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.closePath();
      g.stroke();
      break;
    }
  }
  if (patternCache.size > 128) patternCache.clear();
  patternCache.set(key, c);
  return c;
}

/* ------------------------------------------------------------------ noise */

const noiseCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 256² noise tile. `color` null → black/white grains. */
export function noiseTile(density: number, color: string | null, seed: number, background: string | null = null) {
  const key = `${density.toFixed(3)}|${color}|${seed}|${background}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d') as Ctx2D;
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, S, S);
  }
  const img = g.getImageData(0, 0, S, S);
  const rnd = mulberry32(seed || 1);
  const rgb = color ? hexToRgb(color) : null;
  for (let i = 0; i < S * S; i++) {
    if (rnd() > density) continue;
    const o = i * 4;
    if (rgb) {
      img.data[o] = rgb.r;
      img.data[o + 1] = rgb.g;
      img.data[o + 2] = rgb.b;
      img.data[o + 3] = 255;
    } else {
      const v = rnd() > 0.5 ? 255 : 0;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  if (noiseCache.size > 32) noiseCache.clear();
  noiseCache.set(key, c);
  return c;
}

/* ----------------------------------------------------------------- images */

export function imageFilterString(p: ImagePaint): string {
  const f = p.filters;
  if (!f) return 'none';
  const parts: string[] = [];
  if (f.exposure) parts.push(`brightness(${1 + f.exposure})`);
  if (f.contrast) parts.push(`contrast(${1 + f.contrast})`);
  if (f.saturation) parts.push(`saturate(${1 + f.saturation})`);
  if (f.temperature) parts.push(f.temperature > 0 ? `sepia(${f.temperature * 0.5})` : `hue-rotate(${f.temperature * 30}deg)`);
  if (f.tint) parts.push(`hue-rotate(${f.tint * 40}deg)`);
  if (f.highlights) parts.push(`brightness(${1 + f.highlights * 0.25})`);
  if (f.shadows) parts.push(`contrast(${1 - f.shadows * 0.25})`);
  return parts.length ? parts.join(' ') : 'none';
}

export function imageRect(fit: ImagePaint['fit'], iw: number, ih: number, w: number, h: number) {
  if (fit === 'stretch') return { x: 0, y: 0, width: w, height: h };
  const s = fit === 'fit' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  return { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh };
}

/* ------------------------------------------------------------------ fill */

/**
 * Fill `path` (in the context's current local space) with a paint covering a
 * w×h box. `strokeMode` paints a stroke instead (lineWidth etc. preset).
 */
export function drawPaint(
  ctx: Ctx2D,
  doc: Doc,
  paint: Paint,
  path: Path2D,
  w: number,
  h: number,
  opts: { stroke?: boolean; fillRule?: CanvasFillRule; scale: number; text?: (style: string | CanvasGradient | CanvasPattern) => void },
) {
  if (!paint.visible || paint.opacity <= 0) return;
  const prevAlpha = ctx.globalAlpha;
  const prevOp = ctx.globalCompositeOperation;
  if (paint.blendMode && paint.blendMode !== 'normal') ctx.globalCompositeOperation = compositeOp(paint.blendMode);
  const apply = (style: string | CanvasGradient | CanvasPattern) => {
    if (opts.text) opts.text(style);
    else if (opts.stroke) {
      ctx.strokeStyle = style;
      ctx.stroke(path);
    } else {
      ctx.fillStyle = style;
      ctx.fill(path, opts.fillRule ?? 'nonzero');
    }
  };
  switch (paint.type) {
    case 'solid':
      apply(hexToRgba(paint.color, paint.opacity));
      break;
    case 'linear':
    case 'angular':
      ctx.globalAlpha = prevAlpha * paint.opacity;
      apply(gradientStyle(ctx, paint, w, h)!);
      break;
    case 'radial':
    case 'diamond': {
      ctx.globalAlpha = prevAlpha * paint.opacity;
      if (opts.stroke || opts.text) {
        apply(gradientStyle(ctx, paint, w, h)!);
        break;
      }
      // elliptical gradient in normalised box space
      ctx.save();
      ctx.clip(path, opts.fillRule ?? 'nonzero');
      ctx.transform(w || 1, 0, 0, h || 1, 0, 0);
      const fx = paint.from.x;
      const fy = paint.from.y;
      const r = Math.max(0.0001, Math.hypot(paint.to.x - fx, paint.to.y - fy));
      if (paint.type === 'radial') {
        const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, r);
        addStops(g, paint);
        ctx.fillStyle = g;
        ctx.fillRect(-2, -2, 5, 5);
      } else {
        const tex = diamondTexture(paint);
        const last = [...paint.stops].sort((a, b) => b.offset - a.offset)[0];
        ctx.fillStyle = stopColor(last, 1);
        ctx.fillRect(-2, -2, 5, 5);
        const ang = Math.atan2(paint.to.y - fy, paint.to.x - fx);
        ctx.translate(fx, fy);
        ctx.rotate(ang);
        ctx.drawImage(tex as CanvasImageSource, -r, -r, r * 2, r * 2);
      }
      ctx.restore();
      break;
    }
    case 'image': {
      const img = assets.get(doc, paint.assetId);
      if (!img) {
        // placeholder while decoding
        apply('rgba(128,128,128,0.25)');
        break;
      }
      const size = assets.size(doc, paint.assetId) ?? { width: w, height: h };
      ctx.globalAlpha = prevAlpha * paint.opacity;
      const filter = imageFilterString(paint);
      if (paint.fit === 'tile' || opts.stroke || opts.text) {
        const pat = ctx.createPattern(img, 'repeat');
        if (pat) {
          const s = paint.fit === 'tile' ? paint.scale || 1 : Math.max(w / size.width, h / size.height);
          pat.setTransform(new DOMMatrix().rotate(paint.rotation || 0).scale(s));
          if (filter !== 'none') ctx.filter = filter;
          apply(pat);
          ctx.filter = 'none';
        }
        break;
      }
      ctx.save();
      ctx.clip(path, opts.fillRule ?? 'nonzero');
      const r = imageRect(paint.fit, size.width, size.height, w, h);
      if (filter !== 'none') ctx.filter = filter;
      if (paint.rotation) {
        ctx.translate(w / 2, h / 2);
        ctx.rotate((paint.rotation * Math.PI) / 180);
        ctx.translate(-w / 2, -h / 2);
      }
      ctx.drawImage(img, r.x, r.y, r.width, r.height);
      ctx.restore();
      break;
    }
    case 'pattern': {
      const tile = patternTile(paint);
      const pat = ctx.createPattern(tile as CanvasImageSource, 'repeat');
      if (!pat) break;
      const s = Math.max(1, paint.scale) / TILE;
      pat.setTransform(new DOMMatrix().rotate(paint.rotation || 0).scale(s));
      ctx.globalAlpha = prevAlpha * paint.opacity;
      apply(pat);
      break;
    }
    case 'noise': {
      const n = paint as NoisePaint;
      const tile = noiseTile(n.density, n.color, n.seed, n.background);
      const pat = ctx.createPattern(tile as CanvasImageSource, 'repeat');
      if (!pat) break;
      // grains stay crisp regardless of zoom: one tile texel = `size` local px
      pat.setTransform(new DOMMatrix().scale(Math.max(0.25, n.size)));
      ctx.globalAlpha = prevAlpha * paint.opacity;
      const prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      apply(pat);
      ctx.imageSmoothingEnabled = prevSmooth;
      break;
    }
  }
  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevOp;
}

export { makeCanvas };
