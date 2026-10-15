import { getStroke } from 'perfect-freehand';
import type {
  BrushNode,
  BrushPoint,
  BrushSettings,
  EllipseNode,
  Marker,
  PolygonNode,
  Rect,
  SceneNode,
  StarNode,
  Vec,
} from './types';
import { parseSvgPath, subPathsToCmds, type PathCmd } from './path';

const K = 0.5522847498;

export function rectCmds(w: number, h: number): PathCmd[] {
  return [
    { c: 'M', x: 0, y: 0 },
    { c: 'L', x: w, y: 0 },
    { c: 'L', x: w, y: h },
    { c: 'L', x: 0, y: h },
    { c: 'Z' },
  ];
}

export function getRadii(n: { cornerRadius?: number; cornerRadii?: [number, number, number, number] | null }): [number, number, number, number] {
  if (n.cornerRadii) return n.cornerRadii;
  const r = n.cornerRadius ?? 0;
  return [r, r, r, r];
}

/** Rounded rectangle, optionally with iOS-style corner smoothing (squircle). */
export function roundRectCmds(w: number, h: number, radii: [number, number, number, number], smoothing = 0): PathCmd[] {
  const max = Math.min(w, h) / 2;
  let [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, max))) as [number, number, number, number];
  if (!tl && !tr && !br && !bl) return rectCmds(w, h);
  if (smoothing > 0) return parseSvgPath(squirclePath(w, h, [tl, tr, br, bl], smoothing));
  const out: PathCmd[] = [];
  out.push({ c: 'M', x: tl, y: 0 });
  out.push({ c: 'L', x: w - tr, y: 0 });
  if (tr) out.push({ c: 'C', x1: w - tr + tr * K, y1: 0, x2: w, y2: tr - tr * K, x: w, y: tr });
  out.push({ c: 'L', x: w, y: h - br });
  if (br) out.push({ c: 'C', x1: w, y1: h - br + br * K, x2: w - br + br * K, y2: h, x: w - br, y: h });
  out.push({ c: 'L', x: bl, y: h });
  if (bl) out.push({ c: 'C', x1: bl - bl * K, y1: h, x2: 0, y2: h - bl + bl * K, x: 0, y: h - bl });
  out.push({ c: 'L', x: 0, y: tl });
  if (tl) out.push({ c: 'C', x1: 0, y1: tl - tl * K, x2: tl - tl * K, y2: 0, x: tl, y: 0 });
  out.push({ c: 'Z' });
  return out;
}

/* Squircle corners – port of the well known figma-squircle construction (MIT). */
interface CornerParams {
  a: number;
  b: number;
  c: number;
  d: number;
  p: number;
  arc: number;
  r: number;
}

function cornerParams(r: number, smoothing: number, budget: number): CornerParams {
  let p = (1 + smoothing) * r;
  if (r > 0) {
    const maxSmoothing = budget / r - 1;
    smoothing = Math.max(0, Math.min(smoothing, maxSmoothing));
    p = Math.min(p, budget);
  }
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(((arcMeasure / 2) * Math.PI) / 180) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3p4 = r * Math.tan(((alpha / 2) * Math.PI) / 180);
  const beta = 45 * smoothing;
  const c = p3p4 * Math.cos((beta * Math.PI) / 180);
  const d = c * Math.tan((beta * Math.PI) / 180);
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  return { a, b, c, d, p, arc, r };
}

function squirclePath(w: number, h: number, radii: [number, number, number, number], smoothing: number): string {
  const budget = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => cornerParams(Math.min(r, budget), smoothing, budget));
  const f = (n: number) => +n.toFixed(4);
  const parts: string[] = [];
  parts.push(`M ${f(w - tr.p)} 0`);
  if (tr.r)
    parts.push(
      `c ${f(tr.a)} 0 ${f(tr.a + tr.b)} 0 ${f(tr.a + tr.b + tr.c)} ${f(tr.d)}`,
      `a ${f(tr.r)} ${f(tr.r)} 0 0 1 ${f(tr.arc)} ${f(tr.arc)}`,
      `c ${f(tr.d)} ${f(tr.c)} ${f(tr.d)} ${f(tr.b + tr.c)} ${f(tr.d)} ${f(tr.a + tr.b + tr.c)}`,
    );
  else parts.push(`l ${f(tr.p)} 0`);
  parts.push(`L ${f(w)} ${f(h - br.p)}`);
  if (br.r)
    parts.push(
      `c 0 ${f(br.a)} 0 ${f(br.a + br.b)} ${f(-br.d)} ${f(br.a + br.b + br.c)}`,
      `a ${f(br.r)} ${f(br.r)} 0 0 1 ${f(-br.arc)} ${f(br.arc)}`,
      `c ${f(-br.c)} ${f(br.d)} ${f(-(br.b + br.c))} ${f(br.d)} ${f(-(br.a + br.b + br.c))} ${f(br.d)}`,
    );
  else parts.push(`l 0 ${f(br.p)}`);
  parts.push(`L ${f(bl.p)} ${f(h)}`);
  if (bl.r)
    parts.push(
      `c ${f(-bl.a)} 0 ${f(-(bl.a + bl.b))} 0 ${f(-(bl.a + bl.b + bl.c))} ${f(-bl.d)}`,
      `a ${f(bl.r)} ${f(bl.r)} 0 0 1 ${f(-bl.arc)} ${f(-bl.arc)}`,
      `c ${f(-bl.d)} ${f(-bl.c)} ${f(-bl.d)} ${f(-(bl.b + bl.c))} ${f(-bl.d)} ${f(-(bl.a + bl.b + bl.c))}`,
    );
  else parts.push(`l ${f(-bl.p)} 0`);
  parts.push(`L 0 ${f(tl.p)}`);
  if (tl.r)
    parts.push(
      `c 0 ${f(-tl.a)} 0 ${f(-(tl.a + tl.b))} ${f(tl.d)} ${f(-(tl.a + tl.b + tl.c))}`,
      `a ${f(tl.r)} ${f(tl.r)} 0 0 1 ${f(tl.arc)} ${f(-tl.arc)}`,
      `c ${f(tl.c)} ${f(-tl.d)} ${f(tl.b + tl.c)} ${f(-tl.d)} ${f(tl.a + tl.b + tl.c)} ${f(-tl.d)}`,
    );
  else parts.push(`l 0 ${f(-tl.p)}`);
  parts.push('Z');
  return parts.join(' ');
}

/* --------------------------------------------------------------- ellipse */

function ellipseArc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, moveTo: boolean): PathCmd[] {
  const out: PathCmd[] = [];
  const sweep = a1 - a0;
  const segs = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const d = sweep / segs;
  const k = (4 / 3) * Math.tan(d / 4);
  let t = a0;
  const pt = (tt: number) => ({ x: cx + rx * Math.cos(tt), y: cy + ry * Math.sin(tt) });
  const der = (tt: number) => ({ x: -rx * Math.sin(tt), y: ry * Math.cos(tt) });
  const p0 = pt(t);
  if (moveTo) out.push({ c: 'M', x: p0.x, y: p0.y });
  else out.push({ c: 'L', x: p0.x, y: p0.y });
  for (let i = 0; i < segs; i++) {
    const tn = t + d;
    const a = pt(t);
    const da = der(t);
    const b = pt(tn);
    const db = der(tn);
    out.push({ c: 'C', x1: a.x + k * da.x, y1: a.y + k * da.y, x2: b.x - k * db.x, y2: b.y - k * db.y, x: b.x, y: b.y });
    t = tn;
  }
  return out;
}

export function ellipseCmds(w: number, h: number, arcStart = 0, arcSweep = 360, inner = 0): PathCmd[] {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const full = Math.abs(arcSweep) >= 359.999;
  const a0 = (arcStart * Math.PI) / 180;
  const a1 = ((arcStart + (full ? 360 : arcSweep)) * Math.PI) / 180;
  if (full && inner <= 0) {
    return [
      { c: 'M', x: w, y: cy },
      { c: 'C', x1: w, y1: cy + ry * K, x2: cx + rx * K, y2: h, x: cx, y: h },
      { c: 'C', x1: cx - rx * K, y1: h, x2: 0, y2: cy + ry * K, x: 0, y: cy },
      { c: 'C', x1: 0, y1: cy - ry * K, x2: cx - rx * K, y2: 0, x: cx, y: 0 },
      { c: 'C', x1: cx + rx * K, y1: 0, x2: w, y2: cy - ry * K, x: w, y: cy },
      { c: 'Z' },
    ];
  }
  if (full) {
    return [
      ...ellipseArc(cx, cy, rx, ry, a0, a1, true),
      { c: 'Z' },
      ...ellipseArc(cx, cy, rx * inner, ry * inner, a1, a0, true),
      { c: 'Z' },
    ];
  }
  if (inner <= 0) {
    return [{ c: 'M', x: cx, y: cy }, ...ellipseArc(cx, cy, rx, ry, a0, a1, false), { c: 'Z' }];
  }
  return [...ellipseArc(cx, cy, rx, ry, a0, a1, true), ...ellipseArc(cx, cy, rx * inner, ry * inner, a1, a0, false), { c: 'Z' }];
}

/* ------------------------------------------------------ polygon & star */

function fitToBox(pts: Vec[], w: number, h: number, ref: Vec[] = pts): Vec[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ref) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const sx = maxX - minX || 1;
  const sy = maxY - minY || 1;
  return pts.map((p) => ({ x: ((p.x - minX) / sx) * w, y: ((p.y - minY) / sy) * h }));
}

export function polygonPoints(w: number, h: number, sides: number): Vec[] {
  const n = Math.max(3, Math.round(sides));
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  return fitToBox(pts, w, h);
}

export function starPoints(w: number, h: number, points: number, inner: number): Vec[] {
  const n = Math.max(3, Math.round(points));
  const outer: Vec[] = [];
  const all: Vec[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : Math.max(0.01, inner);
    const p = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    all.push(p);
    if (i % 2 === 0) outer.push(p);
  }
  return fitToBox(all, w, h, outer);
}

/** Closed polygon with rounded corners. */
export function roundedPolygonCmds(pts: Vec[], radius: number): PathCmd[] {
  const n = pts.length;
  if (n < 3) return [];
  if (radius <= 0) {
    return [{ c: 'M', ...pts[0] }, ...pts.slice(1).map((p) => ({ c: 'L' as const, ...p })), { c: 'Z' }];
  }
  const out: PathCmd[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const v1 = { x: prev.x - cur.x, y: prev.y - cur.y };
    const v2 = { x: next.x - cur.x, y: next.y - cur.y };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    if (!l1 || !l2) continue;
    const u1 = { x: v1.x / l1, y: v1.y / l1 };
    const u2 = { x: v2.x / l2, y: v2.y / l2 };
    const cos = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const theta = Math.acos(cos);
    let t = radius / Math.tan(theta / 2);
    t = Math.min(t, l1 / 2, l2 / 2);
    const r = t * Math.tan(theta / 2);
    const a = { x: cur.x + u1.x * t, y: cur.y + u1.y * t };
    const b = { x: cur.x + u2.x * t, y: cur.y + u2.y * t };
    // control distance for an arc of angle (π - θ)
    const phi = Math.PI - theta;
    const k = (4 / 3) * Math.tan(phi / 4) * r;
    const c1 = { x: a.x - u1.x * k, y: a.y - u1.y * k };
    const c2 = { x: b.x - u2.x * k, y: b.y - u2.y * k };
    out.push(i === 0 ? { c: 'M', x: a.x, y: a.y } : { c: 'L', x: a.x, y: a.y });
    out.push({ c: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.x, y: b.y });
  }
  out.push({ c: 'Z' });
  return out;
}

export function polygonCmds(n: Pick<PolygonNode, 'width' | 'height' | 'sides' | 'cornerRadius'>): PathCmd[] {
  return roundedPolygonCmds(polygonPoints(n.width, n.height, n.sides), n.cornerRadius);
}

export function starCmds(n: Pick<StarNode, 'width' | 'height' | 'points' | 'innerRadius' | 'cornerRadius'>): PathCmd[] {
  return roundedPolygonCmds(starPoints(n.width, n.height, n.points, n.innerRadius), n.cornerRadius);
}

/* ------------------------------------------------------------------ brush */

export const DEFAULT_BRUSH: BrushSettings = {
  kind: 'pen',
  size: 8,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  taperStart: 0,
  taperEnd: 0,
  simulatePressure: true,
  angle: 45,
};

export function polygonToSmoothCmds(pts: number[][], closed = true): PathCmd[] {
  const len = pts.length;
  if (len < 4) {
    if (!len) return [];
    return [{ c: 'M', x: pts[0][0], y: pts[0][1] }, ...pts.slice(1).map((p) => ({ c: 'L' as const, x: p[0], y: p[1] })), { c: 'Z' }];
  }
  const out: PathCmd[] = [];
  const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[0], pts[1]);
  out.push({ c: 'M', x: start[0], y: start[1] });
  let cx = start[0];
  let cy = start[1];
  for (let i = 1; i <= len; i++) {
    const q = pts[i % len];
    const e = mid(q, pts[(i + 1) % len]);
    out.push({
      c: 'C',
      x1: cx + (2 / 3) * (q[0] - cx),
      y1: cy + (2 / 3) * (q[1] - cy),
      x2: e[0] + (2 / 3) * (q[0] - e[0]),
      y2: e[1] + (2 / 3) * (q[1] - e[1]),
      x: e[0],
      y: e[1],
    });
    cx = e[0];
    cy = e[1];
  }
  if (closed) out.push({ c: 'Z' });
  return out;
}

export function brushOutline(points: BrushPoint[], s: BrushSettings, last = true): number[][] {
  if (!points.length) return [];
  if (s.kind === 'calligraphy') return calligraphyOutline(points, s);
  const thinning = s.kind === 'marker' || s.kind === 'highlighter' ? 0 : s.kind === 'ink' ? Math.max(0.7, s.thinning) : s.thinning;
  return getStroke(
    points.map((p) => [p.x, p.y, p.p]),
    {
      size: s.size,
      thinning,
      smoothing: s.smoothing,
      streamline: s.streamline,
      simulatePressure: s.simulatePressure,
      last,
      start: { taper: s.taperStart, cap: true },
      end: { taper: s.taperEnd, cap: true },
    },
  );
}

function calligraphyOutline(points: BrushPoint[], s: BrushSettings): number[][] {
  const a = (s.angle * Math.PI) / 180;
  const nx = Math.cos(a) * (s.size / 2);
  const ny = Math.sin(a) * (s.size / 2);
  const left: number[][] = [];
  const right: number[][] = [];
  // light smoothing of the input
  const pts: BrushPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[Math.min(points.length - 1, i + 1)];
    pts.push({ x: (p0.x + p1.x * 2 + p2.x) / 4, y: (p0.y + p1.y * 2 + p2.y) / 4, p: p1.p });
  }
  for (const p of pts) {
    const pr = s.simulatePressure ? 1 : 0.4 + p.p * 0.8;
    left.push([p.x + nx * pr, p.y + ny * pr]);
    right.push([p.x - nx * pr, p.y - ny * pr]);
  }
  return [...left, ...right.reverse()];
}

export function brushCmds(n: Pick<BrushNode, 'points' | 'brush'>): PathCmd[] {
  return polygonToSmoothCmds(brushOutline(n.points, n.brush));
}

/* ---------------------------------------------------------------- markers */

/**
 * Geometry of a line-end marker placed at `at`, pointing along `angle` (radians,
 * the direction the line travels when arriving at the end point).
 */
export function markerCmds(marker: Marker, at: Vec, angle: number, strokeWidth: number): { cmds: PathCmd[]; filled: boolean } {
  const s = Math.max(1, strokeWidth);
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const tr = (x: number, y: number) => ({ x: at.x + x * c - y * sn, y: at.y + x * sn + y * c });
  const poly = (pts: Vec[], close = true): PathCmd[] => [
    { c: 'M', ...pts[0] },
    ...pts.slice(1).map((p) => ({ c: 'L' as const, ...p })),
    ...(close ? [{ c: 'Z' as const }] : []),
  ];
  switch (marker) {
    case 'arrow': {
      const L = 4 * s + 4;
      return { cmds: poly([tr(-L, -L * 0.8), tr(0, 0), tr(-L, L * 0.8)], false), filled: false };
    }
    case 'triangle': {
      const L = 4 * s + 4;
      return { cmds: poly([tr(-L, -L * 0.6), tr(s * 0.5, 0), tr(-L, L * 0.6)]), filled: true };
    }
    case 'circle': {
      const r = 2 * s + 2;
      const cc = tr(0, 0);
      return {
        cmds: ellipseCmds(r * 2, r * 2).map((k) =>
          k.c === 'Z' ? k : k.c === 'C' ? { ...k, x1: k.x1 + cc.x - r, y1: k.y1 + cc.y - r, x2: k.x2 + cc.x - r, y2: k.y2 + cc.y - r, x: k.x + cc.x - r, y: k.y + cc.y - r } : { ...k, x: k.x + cc.x - r, y: k.y + cc.y - r },
        ),
        filled: true,
      };
    }
    case 'square': {
      const r = 2 * s + 2;
      return { cmds: poly([tr(-r, -r), tr(r, -r), tr(r, r), tr(-r, r)]), filled: true };
    }
    case 'diamond': {
      const r = 2.5 * s + 2.5;
      return { cmds: poly([tr(-r, 0), tr(0, -r), tr(r, 0), tr(0, r)]), filled: true };
    }
    case 'bar': {
      const r = 3 * s + 3;
      return { cmds: poly([tr(0, -r), tr(0, r)], false), filled: false };
    }
    default:
      return { cmds: [], filled: false };
  }
}

/* -------------------------------------------------------------- dispatch */

/** Local-space outline geometry for a node (no strokes / effects). */
export function nodeCmds(n: SceneNode): PathCmd[] {
  switch (n.type) {
    case 'rect':
    case 'frame':
      return roundRectCmds(n.width, n.height, getRadii(n), n.cornerSmoothing);
    case 'ellipse':
      return ellipseCmds(n.width, n.height, (n as EllipseNode).arcStart, (n as EllipseNode).arcSweep, (n as EllipseNode).innerRadius);
    case 'polygon':
      return polygonCmds(n);
    case 'star':
      return starCmds(n);
    case 'path':
      return subPathsToCmds(n.paths);
    case 'brush':
      return brushCmds(n);
    case 'text':
    case 'bitmap':
      return rectCmds(n.width, n.height);
    default:
      return [];
  }
}

/** Shape library — premade vector shapes in a 100×100 box. */
export const SHAPE_LIBRARY: { id: string; name: string; d: string }[] = [
  { id: 'heart', name: 'Heart', d: 'M50 88 C 20 66 4 50 4 30 C 4 15 15 5 28 5 C 38 5 46 11 50 20 C 54 11 62 5 72 5 C 85 5 96 15 96 30 C 96 50 80 66 50 88 Z' },
  { id: 'cloud', name: 'Cloud', d: 'M26 80 C 12 80 2 70 2 57 C 2 45 11 36 23 35 C 25 20 37 9 52 9 C 66 9 77 19 80 32 C 91 33 98 43 98 55 C 98 69 88 80 74 80 Z' },
  { id: 'bubble', name: 'Speech bubble', d: 'M14 6 H86 C 92 6 96 10 96 16 V62 C 96 68 92 72 86 72 H40 L22 92 L24 72 H14 C 8 72 4 68 4 62 V16 C 4 10 8 6 14 6 Z' },
  { id: 'arrow-right', name: 'Arrow', d: 'M4 38 H58 V14 L96 50 L58 86 V62 H4 Z' },
  { id: 'chevron', name: 'Chevron', d: 'M8 8 H52 L92 50 L52 92 H8 L48 50 Z' },
  { id: 'cross', name: 'Cross', d: 'M36 4 H64 V36 H96 V64 H64 V96 H36 V64 H4 V36 H36 Z' },
  { id: 'bolt', name: 'Lightning', d: 'M58 2 L14 58 H46 L38 98 L86 38 H54 Z' },
  { id: 'moon', name: 'Moon', d: 'M62 4 C 38 10 24 30 24 52 C 24 76 42 94 66 96 C 54 100 30 98 16 82 C -4 58 4 18 34 6 C 43 2 53 2 62 4 Z' },
  { id: 'drop', name: 'Drop', d: 'M50 2 C 50 2 14 44 14 64 C 14 84 30 98 50 98 C 70 98 86 84 86 64 C 86 44 50 2 50 2 Z' },
  { id: 'shield', name: 'Shield', d: 'M50 2 L92 16 V46 C 92 72 74 90 50 98 C 26 90 8 72 8 46 V16 Z' },
  { id: 'tag', name: 'Tag', d: 'M4 10 C 4 7 7 4 10 4 H52 L96 48 L48 96 L4 52 Z' },
  { id: 'gear', name: 'Gear', d: 'M43 2 H57 L60 15 L70 19 L81 11 L89 19 L81 30 L85 40 L98 43 V57 L85 60 L81 70 L89 81 L81 89 L70 81 L60 85 L57 98 H43 L40 85 L30 81 L19 89 L11 81 L19 70 L15 60 L2 57 V43 L15 40 L19 30 L11 19 L19 11 L30 19 L40 15 Z M50 34 A16 16 0 1 0 50.01 34 Z' },
  { id: 'burst', name: 'Burst', d: 'M50 0 L59 22 L82 10 L76 34 L100 40 L80 54 L94 74 L70 72 L66 96 L50 78 L34 96 L30 72 L6 74 L20 54 L0 40 L24 34 L18 10 L41 22 Z' },
  { id: 'flower', name: 'Flower', d: 'M50 30 C 50 10 70 0 78 14 C 86 28 70 40 58 44 C 72 36 92 40 92 56 C 92 72 70 72 60 58 C 68 72 64 96 48 94 C 32 92 36 70 46 60 C 32 72 8 70 8 54 C 8 38 30 36 42 44 C 30 40 14 28 22 14 C 30 0 50 10 50 30 Z' },
  { id: 'squircle', name: 'Squircle', d: 'M50 2 C 88 2 98 12 98 50 C 98 88 88 98 50 98 C 12 98 2 88 2 50 C 2 12 12 2 50 2 Z' },
  { id: 'leaf', name: 'Leaf', d: 'M6 94 C 6 40 40 6 94 6 C 94 60 60 94 6 94 Z' },
  { id: 'triangle-right', name: 'Right triangle', d: 'M4 4 L96 96 H4 Z' },
  { id: 'trapezoid', name: 'Trapezoid', d: 'M22 10 H78 L98 90 H2 Z' },
  { id: 'parallelogram', name: 'Parallelogram', d: 'M26 12 H98 L74 88 H2 Z' },
  { id: 'ring', name: 'Ring', d: 'M50 2 A48 48 0 1 0 50.01 2 Z M50 26 A24 24 0 1 1 49.99 26 Z' },
  { id: 'pill', name: 'Pill', d: 'M30 20 H70 A30 30 0 0 1 70 80 H30 A30 30 0 0 1 30 20 Z' },
  { id: 'wave', name: 'Wave', d: 'M0 40 C 17 20 33 20 50 40 C 67 60 83 60 100 40 V100 H0 Z' },
  { id: 'blob', name: 'Blob', d: 'M70 8 C 88 16 100 38 94 60 C 88 84 66 98 42 94 C 18 90 2 72 4 48 C 6 24 24 6 44 4 C 54 3 62 4 70 8 Z' },
  { id: 'check', name: 'Check', d: 'M8 52 L22 38 L40 56 L80 14 L94 28 L40 84 Z' },
];

export function shapeLibraryCmds(id: string, box: Rect): PathCmd[] {
  const s = SHAPE_LIBRARY.find((x) => x.id === id);
  if (!s) return [];
  const cmds = parseSvgPath(s.d);
  const sx = box.width / 100;
  const sy = box.height / 100;
  return cmds.map((k) =>
    k.c === 'Z'
      ? k
      : k.c === 'C'
        ? { c: 'C', x1: k.x1 * sx + box.x, y1: k.y1 * sy + box.y, x2: k.x2 * sx + box.x, y2: k.y2 * sy + box.y, x: k.x * sx + box.x, y: k.y * sy + box.y }
        : { c: k.c, x: k.x * sx + box.x, y: k.y * sy + box.y },
  );
}

/** Archimedean / logarithmic spiral as smooth cubic segments in a w×h box. */
export function spiralCmds(w: number, h: number, turns: number, decay = 1): PathCmd[] {
  const steps = Math.max(8, Math.round(turns * 16));
  const pts: Vec[] = [];
  const total = turns * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * total;
    const r = Math.pow(i / steps, decay);
    pts.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
  }
  const scaled = pts.map((p) => ({ x: ((p.x + 1) / 2) * w, y: ((p.y + 1) / 2) * h }));
  // Catmull-Rom → Bezier
  const out: PathCmd[] = [{ c: 'M', x: scaled[0].x, y: scaled[0].y }];
  for (let i = 0; i < scaled.length - 1; i++) {
    const p0 = scaled[Math.max(0, i - 1)];
    const p1 = scaled[i];
    const p2 = scaled[i + 1];
    const p3 = scaled[Math.min(scaled.length - 1, i + 2)];
    out.push({
      c: 'C',
      x1: p1.x + (p2.x - p0.x) / 6,
      y1: p1.y + (p2.y - p0.y) / 6,
      x2: p2.x - (p3.x - p1.x) / 6,
      y2: p2.y - (p3.y - p1.y) / 6,
      x: p2.x,
      y: p2.y,
    });
  }
  return out;
}

export { subPathsToCmds };
