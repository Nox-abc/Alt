import type { PathPoint, Rect, SubPath, Vec } from './types';
import { apply, type Mat } from './geometry';

/** Normalised path commands: everything is absolute M / L / C / Z. */
export type PathCmd =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Z' };

const fmt = (n: number, p = 3) => {
  const f = 10 ** p;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? '0' : String(v);
};

export function cmdsToSvgD(cmds: PathCmd[], precision = 3): string {
  const out: string[] = [];
  for (const k of cmds) {
    switch (k.c) {
      case 'M':
      case 'L':
        out.push(`${k.c}${fmt(k.x, precision)} ${fmt(k.y, precision)}`);
        break;
      case 'C':
        out.push(
          `C${fmt(k.x1, precision)} ${fmt(k.y1, precision)} ${fmt(k.x2, precision)} ${fmt(k.y2, precision)} ${fmt(k.x, precision)} ${fmt(k.y, precision)}`,
        );
        break;
      case 'Z':
        out.push('Z');
        break;
    }
  }
  return out.join(' ');
}

/** Replay commands onto a canvas context or Path2D. */
export function traceCmds(ctx: CanvasRenderingContext2D | Path2D | OffscreenCanvasRenderingContext2D, cmds: PathCmd[]) {
  for (const k of cmds) {
    switch (k.c) {
      case 'M':
        ctx.moveTo(k.x, k.y);
        break;
      case 'L':
        ctx.lineTo(k.x, k.y);
        break;
      case 'C':
        ctx.bezierCurveTo(k.x1, k.y1, k.x2, k.y2, k.x, k.y);
        break;
      case 'Z':
        ctx.closePath();
        break;
    }
  }
}

export function cmdsToPath2D(cmds: PathCmd[]): Path2D {
  const p = new Path2D();
  traceCmds(p, cmds);
  return p;
}

export function transformCmds(cmds: PathCmd[], m: Mat): PathCmd[] {
  return cmds.map((k) => {
    switch (k.c) {
      case 'M':
      case 'L': {
        const p = apply(m, k);
        return { c: k.c, x: p.x, y: p.y };
      }
      case 'C': {
        const a = apply(m, { x: k.x1, y: k.y1 });
        const b = apply(m, { x: k.x2, y: k.y2 });
        const p = apply(m, k);
        return { c: 'C', x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: p.x, y: p.y };
      }
      default:
        return k;
    }
  });
}

/* ---------------------------------------------------------------- bounds */

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // derivative coefficients
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

export function cmdsBounds(cmds: PathCmd[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const k of cmds) {
    if (k.c === 'M') {
      cx = sx = k.x;
      cy = sy = k.y;
      add(cx, cy);
    } else if (k.c === 'L') {
      cx = k.x;
      cy = k.y;
      add(cx, cy);
    } else if (k.c === 'C') {
      add(k.x, k.y);
      for (const t of cubicExtrema(cx, k.x1, k.x2, k.x)) add(cubicAt(cx, k.x1, k.x2, k.x, t), cubicAt(cy, k.y1, k.y2, k.y, t));
      for (const t of cubicExtrema(cy, k.y1, k.y2, k.y)) add(cubicAt(cx, k.x1, k.x2, k.x, t), cubicAt(cy, k.y1, k.y2, k.y, t));
      cx = k.x;
      cy = k.y;
    } else {
      cx = sx;
      cy = sy;
    }
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* -------------------------------------------------------- sub-path model */

export function subPathsToCmds(paths: SubPath[]): PathCmd[] {
  const out: PathCmd[] = [];
  for (const sp of paths) {
    const pts = sp.points;
    if (!pts.length) continue;
    out.push({ c: 'M', x: pts[0].x, y: pts[0].y });
    const seg = (a: PathPoint, b: PathPoint) => {
      if (a.out || b.in) {
        const c1 = a.out ?? a;
        const c2 = b.in ?? b;
        out.push({ c: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.x, y: b.y });
      } else out.push({ c: 'L', x: b.x, y: b.y });
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (sp.closed && pts.length > 1) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      if (last.out || first.in) seg(last, first);
      out.push({ c: 'Z' });
    } else if (sp.closed) out.push({ c: 'Z' });
  }
  return out;
}

const near = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

export function cmdsToSubPaths(cmds: PathCmd[]): SubPath[] {
  const out: SubPath[] = [];
  let cur: SubPath | null = null;
  let lastStart: Vec = { x: 0, y: 0 };
  const ensure = () => {
    if (!cur) {
      cur = { closed: false, points: [{ x: lastStart.x, y: lastStart.y, in: null, out: null }] };
      out.push(cur);
    }
    return cur;
  };
  for (const k of cmds) {
    if (k.c === 'M') {
      cur = { closed: false, points: [{ x: k.x, y: k.y, in: null, out: null }] };
      lastStart = { x: k.x, y: k.y };
      out.push(cur);
    } else if (k.c === 'L') {
      ensure().points.push({ x: k.x, y: k.y, in: null, out: null });
    } else if (k.c === 'C') {
      const c = ensure();
      const prev = c.points[c.points.length - 1];
      prev.out = { x: k.x1, y: k.y1 };
      c.points.push({ x: k.x, y: k.y, in: { x: k.x2, y: k.y2 }, out: null });
      continue;
    } else if (k.c === 'Z') {
      if (!cur) continue;
      const c: SubPath = cur;
      c.closed = true;
      // merge duplicated closing point
      if (c.points.length > 1) {
        const first = c.points[0];
        const last = c.points[c.points.length - 1];
        if (near(first, last)) {
          first.in = last.in;
          c.points.pop();
        }
      }
      lastStart = { x: c.points[0].x, y: c.points[0].y };
      cur = null;
    }
  }
  for (const sp of out) {
    for (const p of sp.points) {
      if (p.in && near(p.in, p)) p.in = null;
      if (p.out && near(p.out, p)) p.out = null;
      p.mode = inferMode(p);
    }
  }
  return out.filter((sp) => sp.points.length > 0);
}

export function inferMode(p: PathPoint): PathPoint['mode'] {
  if (!p.in || !p.out) return p.in || p.out ? 'asymmetric' : 'corner';
  const a = { x: p.in.x - p.x, y: p.in.y - p.y };
  const b = { x: p.out.x - p.x, y: p.out.y - p.y };
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (!la || !lb) return 'asymmetric';
  const cross = (a.x * b.y - a.y * b.x) / (la * lb);
  const dot = (a.x * b.x + a.y * b.y) / (la * lb);
  if (Math.abs(cross) < 0.02 && dot < 0) return Math.abs(la - lb) < 0.5 ? 'mirrored' : 'asymmetric';
  return 'disconnected';
}

export function transformSubPaths(paths: SubPath[], m: Mat): SubPath[] {
  return paths.map((sp) => ({
    closed: sp.closed,
    points: sp.points.map((p) => ({
      ...p,
      ...apply(m, p),
      in: p.in ? apply(m, p.in) : null,
      out: p.out ? apply(m, p.out) : null,
    })),
  }));
}

/* ------------------------------------------------------- SVG path parser */

const ARG_COUNTS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else out.push(parseFloat(m[2]));
  }
  return out;
}

/** Parse arc flags that may be glued together ("a1 1 0 01 1 1"). */
function tokenizeWithFlags(d: string): (string | number)[] {
  // Fast path – most paths don't glue flags.
  const toks = tokenize(d);
  // Re-scan arcs with a dedicated flag-aware tokenizer when needed.
  if (!/[aA]/.test(d)) return toks;
  const out: (string | number)[] = [];
  let i = 0;
  const s = d;
  const isCmd = (ch: string) => /[MmLlHhVvCcSsQqTtAaZz]/.test(ch);
  let cmd = '';
  let argIdx = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isCmd(ch)) {
      out.push(ch);
      cmd = ch.toLowerCase();
      argIdx = 0;
      i++;
      continue;
    }
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    if (cmd === 'a' && (argIdx % 7 === 3 || argIdx % 7 === 4) && (ch === '0' || ch === '1')) {
      out.push(ch === '1' ? 1 : 0);
      argIdx++;
      i++;
      continue;
    }
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i)) || /^[+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i));
    if (!m) {
      i++;
      continue;
    }
    out.push(parseFloat(m[0]));
    argIdx++;
    i += m[0].length;
  }
  return out;
}

/** Convert an SVG arc to cubic beziers (endpoint parameterisation). */
export function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): PathCmd[] {
  if (rx === 0 || ry === 0) return [{ c: 'L', x: x2, y: y2 }];
  if (x1 === x2 && y1 === y2) return [];
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const delta = dt / segs;
  const k = (4 / 3) * Math.tan(delta / 4);
  const out: PathCmd[] = [];
  let t = t1;
  const pt = (tt: number) => {
    const ex = rx * Math.cos(tt);
    const ey = ry * Math.sin(tt);
    return { x: cosPhi * ex - sinPhi * ey + cx, y: sinPhi * ex + cosPhi * ey + cy };
  };
  const der = (tt: number) => {
    const ex = -rx * Math.sin(tt);
    const ey = ry * Math.cos(tt);
    return { x: cosPhi * ex - sinPhi * ey, y: sinPhi * ex + cosPhi * ey };
  };
  for (let i = 0; i < segs; i++) {
    const p0 = pt(t);
    const d0 = der(t);
    const tn = t + delta;
    const p3 = pt(tn);
    const d3 = der(tn);
    out.push({
      c: 'C',
      x1: p0.x + k * d0.x,
      y1: p0.y + k * d0.y,
      x2: p3.x - k * d3.x,
      y2: p3.y - k * d3.y,
      x: i === segs - 1 ? x2 : p3.x,
      y: i === segs - 1 ? y2 : p3.y,
    });
    t = tn;
  }
  return out;
}

export function parseSvgPath(d: string): PathCmd[] {
  const toks = tokenizeWithFlags(d);
  const out: PathCmd[] = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC: Vec | null = null; // last cubic control point (for S)
  let lastQ: Vec | null = null; // last quadratic control point (for T)
  const num = () => {
    const v = toks[i++];
    return typeof v === 'number' ? v : NaN;
  };
  const quad = (qx: number, qy: number, x: number, y: number) => {
    out.push({
      c: 'C',
      x1: cx + (2 / 3) * (qx - cx),
      y1: cy + (2 / 3) * (qy - cy),
      x2: x + (2 / 3) * (qx - x),
      y2: y + (2 / 3) * (qy - y),
      x,
      y,
    });
  };
  while (i < toks.length) {
    const t = toks[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'z' || cmd === 'Z') {
        out.push({ c: 'Z' });
        cx = sx;
        cy = sy;
        lastC = lastQ = null;
        continue;
      }
    } else if (!cmd) {
      i++;
      continue;
    }
    const lc = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    const need = ARG_COUNTS[lc];
    if (need === undefined) break;
    if (i + need > toks.length || toks.slice(i, i + need).some((v) => typeof v !== 'number')) {
      // malformed – skip token
      if (typeof toks[i] !== 'string') i++;
      continue;
    }
    switch (lc) {
      case 'm': {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        out.push({ c: 'M', x, y });
        cx = sx = x;
        cy = sy = y;
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      }
      case 'l': {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        out.push({ c: 'L', x, y });
        cx = x;
        cy = y;
        lastC = lastQ = null;
        break;
      }
      case 'h': {
        let x = num();
        if (rel) x += cx;
        out.push({ c: 'L', x, y: cy });
        cx = x;
        lastC = lastQ = null;
        break;
      }
      case 'v': {
        let y = num();
        if (rel) y += cy;
        out.push({ c: 'L', x: cx, y });
        cy = y;
        lastC = lastQ = null;
        break;
      }
      case 'c': {
        let x1 = num();
        let y1 = num();
        let x2 = num();
        let y2 = num();
        let x = num();
        let y = num();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastC = { x: x2, y: y2 };
        lastQ = null;
        cx = x;
        cy = y;
        break;
      }
      case 's': {
        let x2 = num();
        let y2 = num();
        let x = num();
        let y = num();
        if (rel) {
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        const x1 = lastC ? 2 * cx - lastC.x : cx;
        const y1 = lastC ? 2 * cy - lastC.y : cy;
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastC = { x: x2, y: y2 };
        lastQ = null;
        cx = x;
        cy = y;
        break;
      }
      case 'q': {
        let qx = num();
        let qy = num();
        let x = num();
        let y = num();
        if (rel) {
          qx += cx;
          qy += cy;
          x += cx;
          y += cy;
        }
        quad(qx, qy, x, y);
        lastQ = { x: qx, y: qy };
        lastC = null;
        cx = x;
        cy = y;
        break;
      }
      case 't': {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        const qx: number = lastQ ? 2 * cx - lastQ.x : cx;
        const qy: number = lastQ ? 2 * cy - lastQ.y : cy;
        quad(qx, qy, x, y);
        lastQ = { x: qx, y: qy };
        lastC = null;
        cx = x;
        cy = y;
        break;
      }
      case 'a': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        out.push(...arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y));
        cx = x;
        cy = y;
        lastC = lastQ = null;
        break;
      }
    }
  }
  return out;
}

/** Sample a command list into polylines (one per sub-path), for hit-testing & lasso. */
export function flattenCmds(cmds: PathCmd[], tolerance = 0.5): { points: Vec[]; closed: boolean }[] {
  const out: { points: Vec[]; closed: boolean }[] = [];
  let cur: { points: Vec[]; closed: boolean } | null = null;
  let cx = 0;
  let cy = 0;
  for (const k of cmds) {
    if (k.c === 'M') {
      cur = { points: [{ x: k.x, y: k.y }], closed: false };
      out.push(cur);
      cx = k.x;
      cy = k.y;
    } else if (k.c === 'L') {
      cur?.points.push({ x: k.x, y: k.y });
      cx = k.x;
      cy = k.y;
    } else if (k.c === 'C') {
      const len = Math.hypot(k.x1 - cx, k.y1 - cy) + Math.hypot(k.x2 - k.x1, k.y2 - k.y1) + Math.hypot(k.x - k.x2, k.y - k.y2);
      const n = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / tolerance))));
      for (let s = 1; s <= n; s++) {
        const t = s / n;
        cur?.points.push({ x: cubicAt(cx, k.x1, k.x2, k.x, t), y: cubicAt(cy, k.y1, k.y2, k.y, t) });
      }
      cx = k.x;
      cy = k.y;
    } else if (k.c === 'Z') {
      if (cur) {
        cur.closed = true;
        const f = cur.points[0];
        cx = f.x;
        cy = f.y;
      }
    }
  }
  return out;
}

/** Point on cubic + split (De Casteljau) – used by the vector editor to insert points. */
export function splitCubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number) {
  const l = (a: Vec, b: Vec) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const p01 = l(p0, p1);
  const p12 = l(p1, p2);
  const p23 = l(p2, p3);
  const p012 = l(p01, p12);
  const p123 = l(p12, p23);
  const p = l(p012, p123);
  return { left: [p0, p01, p012, p], right: [p, p123, p23, p3], point: p };
}

export function cubicPoint(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  return { x: cubicAt(p0.x, p1.x, p2.x, p3.x, t), y: cubicAt(p0.y, p1.y, p2.y, p3.y, t) };
}

/** Nearest point on a polyline to `p` – returns segment index & t */
export function nearestOnCubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, p: Vec): { t: number; d: number; point: Vec } {
  let best = { t: 0, d: Infinity, point: p0 };
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const q = cubicPoint(p0, p1, p2, p3, t);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { t, d, point: q };
  }
  // refine
  let lo = Math.max(0, best.t - 1 / N);
  let hi = Math.min(1, best.t + 1 / N);
  for (let k = 0; k < 20; k++) {
    const t1 = lo + (hi - lo) / 3;
    const t2 = hi - (hi - lo) / 3;
    const d1 = Math.hypot(cubicPoint(p0, p1, p2, p3, t1).x - p.x, cubicPoint(p0, p1, p2, p3, t1).y - p.y);
    const d2 = Math.hypot(cubicPoint(p0, p1, p2, p3, t2).x - p.x, cubicPoint(p0, p1, p2, p3, t2).y - p.y);
    if (d1 < d2) hi = t2;
    else lo = t1;
  }
  const t = (lo + hi) / 2;
  const point = cubicPoint(p0, p1, p2, p3, t);
  return { t, d: Math.hypot(point.x - p.x, point.y - p.y), point };
}
