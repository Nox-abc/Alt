import type { Doc, ID, Rect, SceneNode, Vec } from './types';

/** 2D affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return [...IDENTITY];
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

export function apply(m: Mat, p: Vec): Vec {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** apply only the linear part (for vectors / offsets) */
export function applyLinear(m: Mat, p: Vec): Vec {
  return { x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y };
}

export function translate(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx: number, sy = sx): Mat {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export const deg2rad = (d: number) => (d * Math.PI) / 180;
export const rad2deg = (r: number) => (r * 180) / Math.PI;

type Transformable = Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>;

/** local → parent matrix of a node */
export function localMatrix(n: Transformable): Mat {
  const hw = n.width / 2;
  const hh = n.height / 2;
  let m = translate(n.x + hw, n.y + hh);
  if (n.rotation) m = mul(m, rotate(n.rotation));
  if (n.flipX || n.flipY) m = mul(m, scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1));
  return mul(m, translate(-hw, -hh));
}

/** linear part (rotation + flip) of a node's local matrix */
export function linearMatrix(n: Pick<SceneNode, 'rotation' | 'flipX' | 'flipY'>): Mat {
  let m: Mat = [...IDENTITY];
  if (n.rotation) m = mul(m, rotate(n.rotation));
  if (n.flipX || n.flipY) m = mul(m, scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1));
  return m;
}

export function isPageId(doc: Doc, id: ID): boolean {
  return doc.pages.some((p) => p.id === id);
}

/** ancestors from the page-level node down to (excluding) the node itself */
export function ancestors(doc: Doc, id: ID): SceneNode[] {
  const out: SceneNode[] = [];
  let cur = doc.nodes[id];
  while (cur) {
    const p = doc.nodes[cur.parentId];
    if (!p) break;
    out.unshift(p);
    cur = p;
  }
  return out;
}

/** matrix from the node's parent coordinate space to page space */
export function parentMatrix(doc: Doc, id: ID): Mat {
  let m: Mat = [...IDENTITY];
  for (const a of ancestors(doc, id)) m = mul(m, localMatrix(a));
  return m;
}

/** local → page matrix */
export function worldMatrix(doc: Doc, id: ID): Mat {
  const n = doc.nodes[id];
  if (!n) return [...IDENTITY];
  return mul(parentMatrix(doc, id), localMatrix(n));
}

export function pageOf(doc: Doc, id: ID): ID | null {
  let cur: SceneNode | undefined = doc.nodes[id];
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (!doc.nodes[cur.parentId]) return cur.parentId;
    cur = doc.nodes[cur.parentId];
  }
  return null;
}

export function boxCorners(w: number, h: number): Vec[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

export function boundsOfPoints(pts: Vec[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function transformRect(m: Mat, r: Rect): Rect {
  return boundsOfPoints([
    apply(m, { x: r.x, y: r.y }),
    apply(m, { x: r.x + r.width, y: r.y }),
    apply(m, { x: r.x + r.width, y: r.y + r.height }),
    apply(m, { x: r.x, y: r.y + r.height }),
  ]);
}

/** axis-aligned bounds of a node in page space */
export function worldBounds(doc: Doc, id: ID): Rect {
  const n = doc.nodes[id];
  if (!n) return { x: 0, y: 0, width: 0, height: 0 };
  return transformRect(worldMatrix(doc, id), { x: 0, y: 0, width: n.width, height: n.height });
}

/** world-space quad (4 corners) of a node */
export function worldQuad(doc: Doc, id: ID): Vec[] {
  const n = doc.nodes[id];
  if (!n) return [];
  const m = worldMatrix(doc, id);
  return boxCorners(n.width, n.height).map((p) => apply(m, p));
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function selectionBounds(doc: Doc, ids: ID[]): Rect | null {
  return unionRects(ids.filter((id) => doc.nodes[id]).map((id) => worldBounds(doc, id)));
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function pointInRect(p: Vec, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function normRect(a: Vec, b: Vec): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec, b: Vec, t: number): Vec {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round(v: number, precision = 2): number {
  const f = 10 ** precision;
  return Math.round(v * f) / f;
}

/** Decompose a matrix into translation / rotation (deg) / scale (with flip in x). */
export function decompose(m: Mat): { tx: number; ty: number; rotation: number; sx: number; sy: number } {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  const sy = sx ? det / sx : Math.hypot(c, d);
  const rotation = rad2deg(Math.atan2(b, a));
  return { tx: e, ty: f, rotation, sx, sy };
}

/**
 * Compute node x/y/rotation/flip such that its local box (w×h) maps through
 * `parentInv · world` – used when reparenting or baking transforms.
 */
export function placementFromMatrix(
  m: Mat,
  width: number,
  height: number,
): { x: number; y: number; rotation: number; flipX: boolean; flipY: boolean; sx: number; sy: number } {
  const dec = decompose(m);
  let rotation = dec.rotation;
  let flipY = false;
  let sy = dec.sy;
  if (sy < 0) {
    flipY = true;
    sy = -sy;
  }
  const w = width * dec.sx;
  const h = height * sy;
  // centre of the box in parent space
  const c = apply(m, { x: width / 2, y: height / 2 });
  rotation = normalizeAngle(rotation);
  return { x: c.x - w / 2, y: c.y - h / 2, rotation, flipX: false, flipY, sx: dec.sx, sy };
}

export function normalizeAngle(deg: number): number {
  let r = deg % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  if (Math.abs(r) < 1e-9) r = 0;
  return r;
}

export function snapAngle(deg: number, step = 15): number {
  return Math.round(deg / step) * step;
}

export function rectCenter(r: Rect): Vec {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function expandRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}
