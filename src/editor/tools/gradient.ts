import type { Doc, GradientPaint, Vec } from '../../core/types';
import { editor, getViewport } from '../../core/store';
import { apply, invert, worldMatrix } from '../../core/geometry';
import { hexToRgba } from '../../core/doc';
import { requestOverlay, type PointerInfo } from '../toolkit';
import { accentColor } from '../overlay';

let drag: { which: 'from' | 'to' | number; base: Doc } | null = null;

function current(): { paint: GradientPaint; w: number; h: number; id: string } | null {
  const s = editor();
  const e = s.editing;
  if (e?.kind !== 'gradient') return null;
  const n = s.doc.nodes[e.id];
  if (!n) return null;
  const p = n[e.target][e.index];
  if (!p || (p.type !== 'linear' && p.type !== 'radial' && p.type !== 'angular' && p.type !== 'diamond')) return null;
  return { paint: p, w: n.width, h: n.height, id: n.id };
}

function screenPts() {
  const c = current();
  if (!c) return null;
  const v = getViewport();
  const m = worldMatrix(editor().doc, c.id);
  const sc = (p: Vec) => {
    const w = apply(m, { x: p.x * c.w, y: p.y * c.h });
    return { x: w.x * v.zoom + v.x, y: w.y * v.zoom + v.y };
  };
  return { from: sc(c.paint.from), to: sc(c.paint.to), c, sc };
}

function update(fn: (p: GradientPaint) => void) {
  const s = editor();
  const e = s.editing;
  if (e?.kind !== 'gradient' || !drag) return;
  const base = drag.base;
  s.mutate(
    (d) => {
      d.nodes[e.id] = base.nodes[e.id];
      fn(d.nodes[e.id][e.target][e.index] as GradientPaint);
    },
    { history: false },
  );
}

export const gradientEdit = {
  down(p: PointerInfo): boolean {
    const sp = screenPts();
    if (!sp) return false;
    const near = (a: Vec) => Math.hypot(a.x - p.screen.x, a.y - p.screen.y) <= 8;
    let which: 'from' | 'to' | number | null = near(sp.to) ? 'to' : near(sp.from) ? 'from' : null;
    if (which === null) {
      sp.c.paint.stops.forEach((st, i) => {
        const at = { x: sp.from.x + (sp.to.x - sp.from.x) * st.offset, y: sp.from.y + (sp.to.y - sp.from.y) * st.offset };
        if (which === null && st.offset > 0 && st.offset < 1 && near(at)) which = i;
      });
    }
    if (which === null) return false;
    editor().begin('Edit gradient');
    drag = { which, base: editor().doc };
    return true;
  },
  move(p: PointerInfo): boolean {
    if (!drag) return false;
    const c = current();
    if (!c) return false;
    const m = worldMatrix(editor().doc, c.id);
    const lp = apply(invert(m), p.world);
    const nx = lp.x / (c.w || 1);
    const ny = lp.y / (c.h || 1);
    const which = drag.which;
    if (which === 'from' || which === 'to') {
      update((g) => {
        g[which] = { x: nx, y: ny };
      });
    } else {
      const sp = screenPts()!;
      const dx = sp.to.x - sp.from.x;
      const dy = sp.to.y - sp.from.y;
      const t = Math.max(0, Math.min(1, ((p.screen.x - sp.from.x) * dx + (p.screen.y - sp.from.y) * dy) / (dx * dx + dy * dy || 1)));
      update((g) => {
        g.stops[which].offset = t;
      });
    }
    requestOverlay();
    return true;
  },
  up(_p: PointerInfo): boolean {
    if (!drag) return false;
    editor().commit();
    drag = null;
    return true;
  },
  overlay(ctx: CanvasRenderingContext2D) {
    const sp = screenPts();
    if (!sp) return;
    const accent = accentColor();
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.moveTo(sp.from.x, sp.from.y);
    ctx.lineTo(sp.to.x, sp.to.y);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    const stops = [...sp.c.paint.stops];
    for (const st of stops) {
      const at = { x: sp.from.x + (sp.to.x - sp.from.x) * st.offset, y: sp.from.y + (sp.to.y - sp.from.y) * st.offset };
      ctx.beginPath();
      ctx.arc(at.x, at.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(st.color, 1);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.arc(at.x, at.y, 7.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of [sp.from, sp.to]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();
  },
};
