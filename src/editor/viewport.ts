import type { ID, Rect, Vec } from '../core/types';
import { editor, getViewport, type Viewport } from '../core/store';
import { selectionBounds, unionRects, worldBounds } from '../core/geometry';
import { getPage } from '../core/doc';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

/** CSS size of the canvas element (kept up to date by the Canvas component). */
export const canvasSize = { width: 800, height: 600, left: 0, top: 0 };

export function toWorld(p: Vec, v: Viewport = getViewport()): Vec {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

export function toScreen(p: Vec, v: Viewport = getViewport()): Vec {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

export function clampZoom(z: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Zoom keeping a screen point fixed. */
export function zoomAt(screen: Vec, zoom: number) {
  const v = getViewport();
  const z = clampZoom(zoom);
  const w = toWorld(screen, v);
  editor().setViewport({ zoom: z, x: screen.x - w.x * z, y: screen.y - w.y * z });
}

export function zoomBy(factor: number, screen?: Vec) {
  const v = getViewport();
  zoomAt(screen ?? { x: canvasSize.width / 2, y: canvasSize.height / 2 }, v.zoom * factor);
}

const STEPS = [0.02, 0.05, 0.1, 0.125, 0.25, 0.333, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256];

export function zoomStep(dir: 1 | -1) {
  const z = getViewport().zoom;
  const next = dir > 0 ? STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM : [...STEPS].reverse().find((s) => s < z * 0.999) ?? MIN_ZOOM;
  zoomAt({ x: canvasSize.width / 2, y: canvasSize.height / 2 }, next);
}

export function zoomToRect(r: Rect | null, opts: { padding?: number; maxZoom?: number; animate?: boolean } = {}) {
  if (!r) {
    editor().setViewport({ x: canvasSize.width / 2, y: canvasSize.height / 2, zoom: 1 });
    return;
  }
  const pad = opts.padding ?? 64;
  const w = Math.max(1, r.width);
  const h = Math.max(1, r.height);
  const z = clampZoom(Math.min((canvasSize.width - pad * 2) / w, (canvasSize.height - pad * 2) / h, opts.maxZoom ?? 1));
  const target = { zoom: z, x: canvasSize.width / 2 - (r.x + w / 2) * z, y: canvasSize.height / 2 - (r.y + h / 2) * z };
  if (opts.animate === false) editor().setViewport(target);
  else animateViewport(target);
}

let anim = 0;
export function animateViewport(target: Viewport, ms = 260) {
  cancelAnimationFrame(anim);
  const from = getViewport();
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce || ms <= 0) {
    editor().setViewport(target);
    return;
  }
  const t0 = performance.now();
  // interpolate in log-zoom space so the motion feels uniform
  const lz0 = Math.log(from.zoom);
  const lz1 = Math.log(target.zoom);
  const c0 = { x: (canvasSize.width / 2 - from.x) / from.zoom, y: (canvasSize.height / 2 - from.y) / from.zoom };
  const c1 = { x: (canvasSize.width / 2 - target.x) / target.zoom, y: (canvasSize.height / 2 - target.y) / target.zoom };
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    const z = Math.exp(lz0 + (lz1 - lz0) * e);
    const cx = c0.x + (c1.x - c0.x) * e;
    const cy = c0.y + (c1.y - c0.y) * e;
    editor().setViewport({ zoom: z, x: canvasSize.width / 2 - cx * z, y: canvasSize.height / 2 - cy * z });
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

export function pageContentBounds(): Rect | null {
  const s = editor();
  const page = getPage(s.doc, s.pageId);
  if (!page) return null;
  return unionRects(page.children.filter((id) => s.doc.nodes[id]?.visible).map((id) => worldBounds(s.doc, id)));
}

export function zoomToFit() {
  zoomToRect(pageContentBounds(), { maxZoom: 1 });
}

export function zoomToSelection(ids?: ID[]) {
  const s = editor();
  const sel = ids ?? s.selection;
  if (!sel.length) return zoomToFit();
  zoomToRect(selectionBounds(s.doc, sel), { maxZoom: 8 });
}

export function setZoom(z: number) {
  zoomAt({ x: canvasSize.width / 2, y: canvasSize.height / 2 }, z);
}

/** World-space point at the centre of the visible canvas. */
export function viewCenter(): Vec {
  return toWorld({ x: canvasSize.width / 2, y: canvasSize.height / 2 });
}

export function visibleWorldRect(): Rect {
  const a = toWorld({ x: 0, y: 0 });
  const b = toWorld({ x: canvasSize.width, y: canvasSize.height });
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}
