import type { Doc, PathNode, PathPoint, Vec } from '../../core/types';
import { editor, getViewport, type VectorSel } from '../../core/store';
import { apply, invert, worldMatrix, type Mat } from '../../core/geometry';
import { nearestOnCubic, splitCubic, subPathsToCmds, inferMode } from '../../core/path';
import { deleteNodes, refitNode } from '../../core/ops';
import { CURSORS, requestOverlay, setCursor, type PointerInfo } from '../toolkit';
import { accentColor } from '../overlay';

type Hit =
  | { kind: 'anchor'; sub: number; idx: number }
  | { kind: 'handle'; sub: number; idx: number; which: 'in' | 'out' }
  | { kind: 'segment'; sub: number; idx: number; t: number; point: Vec }
  | null;

let drag:
  | { kind: 'anchors'; start: Vec; base: Doc; inv: Mat; moved: boolean }
  | { kind: 'handle'; sub: number; idx: number; which: 'in' | 'out'; base: Doc; inv: Mat; breakMirror: boolean }
  | null = null;

function node(idOverride?: string): PathNode | null {
  const s = editor();
  const id = idOverride ?? (s.editing?.kind === 'path' ? s.editing.id : null);
  if (!id) return null;
  const n = s.doc.nodes[id];
  return n && n.type === 'path' ? n : null;
}

function screenOf(m: Mat, p: Vec): Vec {
  const v = getViewport();
  const w = apply(m, p);
  return { x: w.x * v.zoom + v.x, y: w.y * v.zoom + v.y };
}

function showHandlesFor(n: PathNode, sel: VectorSel[], sub: number, idx: number): boolean {
  const total = n.paths.reduce((a, s) => a + s.points.length, 0);
  if (total <= 40) return true;
  return sel.some((s) => s.sub === sub && Math.abs(s.idx - idx) <= 1);
}

function hit(n: PathNode, screen: Vec): Hit {
  const m = worldMatrix(editor().doc, n.id);
  const sel = editor().vectorSel;
  // handles first (they sit on top)
  for (let si = 0; si < n.paths.length; si++) {
    const sp = n.paths[si];
    for (let i = 0; i < sp.points.length; i++) {
      if (!showHandlesFor(n, sel, si, i)) continue;
      const p = sp.points[i];
      for (const which of ['in', 'out'] as const) {
        const h = p[which];
        if (!h) continue;
        const s = screenOf(m, h);
        if (Math.hypot(s.x - screen.x, s.y - screen.y) <= 6) return { kind: 'handle', sub: si, idx: i, which };
      }
    }
  }
  for (let si = 0; si < n.paths.length; si++) {
    const sp = n.paths[si];
    for (let i = 0; i < sp.points.length; i++) {
      const s = screenOf(m, sp.points[i]);
      if (Math.hypot(s.x - screen.x, s.y - screen.y) <= 6) return { kind: 'anchor', sub: si, idx: i };
    }
  }
  // segments
  const inv = invert(m);
  const v = getViewport();
  const world = { x: (screen.x - v.x) / v.zoom, y: (screen.y - v.y) / v.zoom };
  const lp = apply(inv, world);
  let best: Hit = null;
  let bestD = 6 / v.zoom;
  for (let si = 0; si < n.paths.length; si++) {
    const sp = n.paths[si];
    const count = sp.closed ? sp.points.length : sp.points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = sp.points[i];
      const b = sp.points[(i + 1) % sp.points.length];
      const r = nearestOnCubic(a, a.out ?? a, b.in ?? b, b, lp);
      if (r.d < bestD) {
        bestD = r.d;
        best = { kind: 'segment', sub: si, idx: i, t: r.t, point: r.point };
      }
    }
  }
  return best;
}

function mutatePath(fn: (n: PathNode, d: Doc) => void, base?: Doc) {
  const s = editor();
  const id = (s.editing as { id: string }).id;
  s.mutate(
    (d) => {
      if (base) d.nodes[id] = base.nodes[id];
      const n = d.nodes[id] as PathNode;
      fn(n, d);
      refitNode(d, id);
    },
    { history: !s.tx },
  );
}

export function smoothPoint(sp: PathNode['paths'][number], i: number) {
  const p = sp.points[i];
  const n = sp.points.length;
  const prev = sp.points[(i - 1 + n) % n];
  const next = sp.points[(i + 1) % n];
  const hasPrev = sp.closed || i > 0;
  const hasNext = sp.closed || i < n - 1;
  const dir = { x: (hasNext ? next.x : p.x) - (hasPrev ? prev.x : p.x), y: (hasNext ? next.y : p.y) - (hasPrev ? prev.y : p.y) };
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  const dPrev = hasPrev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0;
  const dNext = hasNext ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
  p.in = hasPrev ? { x: p.x - ux * dPrev, y: p.y - uy * dPrev } : null;
  p.out = hasNext ? { x: p.x + ux * dNext, y: p.y + uy * dNext } : null;
  p.mode = 'mirrored';
}

export const vectorEdit = {
  down(p: PointerInfo): boolean {
    const n = node();
    if (!n) return false;
    const s = editor();
    const h = hit(n, p.screen);
    const m = worldMatrix(s.doc, n.id);
    if (h?.kind === 'handle') {
      s.begin('Edit handle');
      drag = { kind: 'handle', sub: h.sub, idx: h.idx, which: h.which, base: editor().doc, inv: invert(m), breakMirror: p.alt };
      return true;
    }
    if (h?.kind === 'anchor') {
      const exists = s.vectorSel.some((v) => v.sub === h.sub && v.idx === h.idx);
      if (p.shift) s.setVectorSel(exists ? s.vectorSel.filter((v) => !(v.sub === h.sub && v.idx === h.idx)) : [...s.vectorSel, { sub: h.sub, idx: h.idx }]);
      else if (!exists) s.setVectorSel([{ sub: h.sub, idx: h.idx }]);
      s.begin('Move points');
      drag = { kind: 'anchors', start: p.world, base: editor().doc, inv: invert(m), moved: false };
      requestOverlay();
      return true;
    }
    if (h?.kind === 'segment') {
      // insert a point by splitting the segment
      mutatePath((pn) => {
        const sp = pn.paths[h.sub];
        const a = sp.points[h.idx];
        const bi = (h.idx + 1) % sp.points.length;
        const b = sp.points[bi];
        const curved = !!(a.out || b.in);
        if (curved) {
          const parts = splitCubic(a, a.out ?? a, b.in ?? b, b, h.t);
          a.out = { ...parts.left[1] };
          b.in = { ...parts.right[2] };
          const np: PathPoint = { x: parts.point.x, y: parts.point.y, in: { ...parts.left[2] }, out: { ...parts.right[1] }, mode: 'mirrored' };
          sp.points.splice(h.idx + 1, 0, np);
        } else {
          sp.points.splice(h.idx + 1, 0, { x: h.point.x, y: h.point.y, in: null, out: null, mode: 'corner' });
        }
      });
      s.setVectorSel([{ sub: h.sub, idx: h.idx + 1 }]);
      s.begin('Move points');
      drag = { kind: 'anchors', start: p.world, base: editor().doc, inv: invert(worldMatrix(editor().doc, n.id)), moved: false };
      return true;
    }
    // empty space: deselect points, or leave edit mode
    if (s.vectorSel.length) {
      s.setVectorSel([]);
      return true;
    }
    s.setEditing(null);
    return false;
  },

  move(p: PointerInfo): boolean {
    const n = node();
    if (!n) return false;
    if (!drag) {
      const h = hit(n, p.screen);
      setCursor(h?.kind === 'segment' ? CURSORS.penAdd : h ? 'default' : 'default');
      return false;
    }
    const s = editor();
    if (drag.kind === 'anchors') {
      const d0 = drag;
      const a = apply(d0.inv, d0.start);
      const b = apply(d0.inv, p.world);
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      if (p.shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      d0.moved = true;
      const sel = s.vectorSel;
      mutatePath((pn) => {
        for (const v of sel) {
          const pt = pn.paths[v.sub]?.points[v.idx];
          if (!pt) continue;
          pt.x += dx;
          pt.y += dy;
          if (pt.in) pt.in = { x: pt.in.x + dx, y: pt.in.y + dy };
          if (pt.out) pt.out = { x: pt.out.x + dx, y: pt.out.y + dy };
        }
      }, d0.base);
      requestOverlay();
      return true;
    }
    if (drag.kind === 'handle') {
      const d0 = drag;
      const lp = apply(d0.inv, p.world);
      mutatePath((pn) => {
        const pt = pn.paths[d0.sub]?.points[d0.idx];
        if (!pt) return;
        const other = d0.which === 'in' ? 'out' : 'in';
        pt[d0.which] = { x: lp.x, y: lp.y };
        const mode = d0.breakMirror || p.alt ? 'disconnected' : pt.mode ?? inferMode(pt);
        if (mode === 'mirrored') pt[other] = { x: 2 * pt.x - lp.x, y: 2 * pt.y - lp.y };
        else if (mode === 'asymmetric' && pt[other]) {
          const o = pt[other]!;
          const len = Math.hypot(o.x - pt.x, o.y - pt.y);
          const dx = lp.x - pt.x;
          const dy = lp.y - pt.y;
          const l2 = Math.hypot(dx, dy) || 1;
          pt[other] = { x: pt.x - (dx / l2) * len, y: pt.y - (dy / l2) * len };
        }
        pt.mode = mode;
      }, d0.base);
      requestOverlay();
      return true;
    }
    return false;
  },

  up(_p: PointerInfo): boolean {
    if (!drag) return false;
    const s = editor();
    if (drag.kind === 'anchors' && !drag.moved) s.cancel();
    else s.commit();
    drag = null;
    requestOverlay();
    return true;
  },

  dblclick(p: PointerInfo) {
    const n = node();
    if (!n) return;
    const h = hit(n, p.screen);
    if (h?.kind === 'anchor') {
      mutatePath((pn) => {
        const sp = pn.paths[h.sub];
        const pt = sp.points[h.idx];
        if (pt.in || pt.out) {
          pt.in = null;
          pt.out = null;
          pt.mode = 'corner';
        } else smoothPoint(sp, h.idx);
      });
      return;
    }
    if (!h) editor().setEditing(null);
  },

  key(e: KeyboardEvent): boolean {
    const n = node();
    if (!n) return false;
    const s = editor();
    if (e.key === 'Escape' || e.key === 'Enter') {
      s.setEditing(null);
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!s.vectorSel.length) return true;
      const sel = s.vectorSel;
      const id = n.id;
      s.mutate((d) => {
        const pn = d.nodes[id] as PathNode;
        const bySub = new Map<number, Set<number>>();
        for (const v of sel) bySub.set(v.sub, new Set([...(bySub.get(v.sub) ?? []), v.idx]));
        pn.paths = pn.paths
          .map((sp, si) => ({ ...sp, points: sp.points.filter((_, i) => !bySub.get(si)?.has(i)) }))
          .filter((sp) => sp.points.length >= 2 || (sp.points.length === 1 && !sp.closed));
        for (const sp of pn.paths) if (sp.closed && sp.points.length < 3) sp.closed = false;
        if (!pn.paths.length || pn.paths.every((sp) => sp.points.length < 2)) deleteNodes(d, [id]);
        else refitNode(d, id);
      });
      s.setVectorSel([]);
      if (!editor().doc.nodes[id]) s.setEditing(null);
      return true;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      s.setVectorSel(n.paths.flatMap((sp, si) => sp.points.map((_, idx) => ({ sub: si, idx }))));
      requestOverlay();
      return true;
    }
    if (e.key.startsWith('Arrow') && s.vectorSel.length) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const sel = s.vectorSel;
      mutatePath((pn) => {
        for (const v of sel) {
          const pt = pn.paths[v.sub]?.points[v.idx];
          if (!pt) continue;
          pt.x += dx;
          pt.y += dy;
          if (pt.in) pt.in = { x: pt.in.x + dx, y: pt.in.y + dy };
          if (pt.out) pt.out = { x: pt.out.x + dx, y: pt.out.y + dy };
        }
      });
      return true;
    }
    return false;
  },

  overlay(ctx: CanvasRenderingContext2D, idOverride?: string) {
    const n = node(idOverride);
    if (!n) return;
    const s = editor();
    const m = worldMatrix(s.doc, n.id);
    const accent = accentColor();
    const sel = s.vectorSel;
    // path outline
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const k of subPathsToCmds(n.paths)) {
      if (k.c === 'M') {
        const p = screenOf(m, k);
        ctx.moveTo(p.x, p.y);
      } else if (k.c === 'L') {
        const p = screenOf(m, k);
        ctx.lineTo(p.x, p.y);
      } else if (k.c === 'C') {
        const a = screenOf(m, { x: k.x1, y: k.y1 });
        const b = screenOf(m, { x: k.x2, y: k.y2 });
        const p = screenOf(m, k);
        ctx.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
      } else ctx.closePath();
    }
    ctx.stroke();
    // handles
    for (let si = 0; si < n.paths.length; si++) {
      const sp = n.paths[si];
      sp.points.forEach((pt, i) => {
        if (!showHandlesFor(n, sel, si, i)) return;
        const a = screenOf(m, pt);
        for (const h of [pt.in, pt.out]) {
          if (!h) continue;
          const hp = screenOf(m, h);
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(hp.x, hp.y);
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      });
    }
    // anchors
    for (let si = 0; si < n.paths.length; si++) {
      n.paths[si].points.forEach((pt, i) => {
        const a = screenOf(m, pt);
        const isSel = sel.some((v) => v.sub === si && v.idx === i);
        ctx.fillStyle = isSel ? accent : '#fff';
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (pt.in || pt.out) ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
        else ctx.rect(a.x - 3.5, a.y - 3.5, 7, 7);
        ctx.fill();
        ctx.stroke();
      });
    }
    ctx.restore();
  },
};
