import type { Doc, ID, Rect } from '../core/types';
import { worldBounds } from '../core/geometry';
import { childrenOf, getPage } from '../core/doc';
import { useSettings } from './settings';

export interface SnapLine {
  axis: 'x' | 'y';
  /** x for vertical lines, y for horizontal lines */
  value: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  lines: SnapLine[];
}

interface Target {
  r: Rect;
  xs: number[];
  ys: number[];
}

/** Collect snap targets near the moving nodes. */
export function snapTargets(doc: Doc, pageId: ID, moving: ID[]): Target[] {
  const exclude = new Set<ID>();
  const collectDesc = (id: ID) => {
    exclude.add(id);
    for (const c of childrenOf(doc, id)) collectDesc(c);
  };
  moving.forEach(collectDesc);
  const ids = new Set<ID>();
  const parents = new Set(moving.map((id) => doc.nodes[id]?.parentId).filter(Boolean) as ID[]);
  for (const p of parents) {
    for (const c of childrenOf(doc, p)) ids.add(c);
    if (doc.nodes[p]) ids.add(p);
  }
  const page = getPage(doc, pageId);
  page?.children.forEach((c) => ids.add(c));
  const out: Target[] = [];
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const n = doc.nodes[id];
    if (!n || !n.visible) continue;
    const r = worldBounds(doc, id);
    out.push({ r, xs: [r.x, r.x + r.width / 2, r.x + r.width], ys: [r.y, r.y + r.height / 2, r.y + r.height] });
  }
  for (const g of page?.guides ?? []) {
    if (g.axis === 'x') out.push({ r: { x: g.value, y: -1e5, width: 0, height: 2e5 }, xs: [g.value], ys: [] });
    else out.push({ r: { x: -1e5, y: g.value, width: 2e5, height: 0 }, xs: [], ys: [g.value] });
  }
  return out;
}

function best(values: number[], targets: number[][], threshold: number) {
  let bestD = threshold;
  let delta = 0;
  let found = false;
  for (const v of values)
    for (const ts of targets)
      for (const t of ts) {
        const d = Math.abs(t - v);
        if (d < bestD - 1e-9) {
          bestD = d;
          delta = t - v;
          found = true;
        }
      }
  return found ? delta : null;
}

/** Snap a moving box. `edges` restricts which edges participate (for resizing). */
export function snapBox(
  box: Rect,
  targets: Target[],
  zoom: number,
  opts: { x?: ('min' | 'mid' | 'max')[]; y?: ('min' | 'mid' | 'max')[] } = {},
): SnapResult {
  const s = useSettings.getState();
  const th = 6 / zoom;
  const xKeys = opts.x ?? ['min', 'mid', 'max'];
  const yKeys = opts.y ?? ['min', 'mid', 'max'];
  const xv = (k: string, r: Rect) => (k === 'min' ? r.x : k === 'mid' ? r.x + r.width / 2 : r.x + r.width);
  const yv = (k: string, r: Rect) => (k === 'min' ? r.y : k === 'mid' ? r.y + r.height / 2 : r.y + r.height);
  let dx = 0;
  let dy = 0;
  if (s.snapToObjects) {
    dx = best(xKeys.map((k) => xv(k, box)), targets.map((t) => t.xs), th) ?? 0;
    dy = best(yKeys.map((k) => yv(k, box)), targets.map((t) => t.ys), th) ?? 0;
  }
  if (s.snapToGrid && s.gridSize > 0) {
    const g = s.gridSize;
    if (!dx) {
      const v = xv(xKeys[0], box);
      dx = Math.round(v / g) * g - v;
    }
    if (!dy) {
      const v = yv(yKeys[0], box);
      dy = Math.round(v / g) * g - v;
    }
  }
  const snapped = { ...box, x: box.x + dx, y: box.y + dy };
  const lines: SnapLine[] = [];
  if (s.snapToObjects) {
    for (const k of xKeys) {
      const v = xv(k, snapped);
      const matches = targets.filter((t) => t.xs.some((x) => Math.abs(x - v) < 1e-6));
      if (matches.length) {
        const ys = [snapped.y, snapped.y + snapped.height, ...matches.flatMap((m) => [m.r.y, m.r.y + m.r.height])];
        lines.push({ axis: 'x', value: v, from: Math.max(-1e5, Math.min(...ys)), to: Math.min(1e5, Math.max(...ys)) });
      }
    }
    for (const k of yKeys) {
      const v = yv(k, snapped);
      const matches = targets.filter((t) => t.ys.some((y) => Math.abs(y - v) < 1e-6));
      if (matches.length) {
        const xs = [snapped.x, snapped.x + snapped.width, ...matches.flatMap((m) => [m.r.x, m.r.x + m.r.width])];
        lines.push({ axis: 'y', value: v, from: Math.max(-1e5, Math.min(...xs)), to: Math.min(1e5, Math.max(...xs)) });
      }
    }
  }
  return { dx, dy, lines };
}

export function roundIfPixelSnap(v: number): number {
  return useSettings.getState().snapToPixels ? Math.round(v) : v;
}
