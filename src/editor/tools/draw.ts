import type { BrushPoint, ID, Vec } from '../../core/types';
import { editor, getViewport, type ToolOptions } from '../../core/store';
import { createNode, solid } from '../../core/doc';
import { frameAt, insertNode, pagePointToParent, refitNode } from '../../core/ops';
import { simplifyPoints } from '../../core/boolean';
import { cmdsToSubPaths } from '../../core/path';
import { brushOutline } from '../../core/shapes';
import { worldBounds } from '../../core/geometry';
import { hexToRgba } from '../../core/doc';
import { CURSORS, requestOverlay, ui, type PointerInfo, type Tool } from '../toolkit';
import { toScreen, viewCenter } from '../viewport';

let stroke: { pts: BrushPoint[]; parent: ID; last: number; center: Vec } | null = null;

/** Symmetry transforms (world space) for the current tool options. */
export function symmetryTransforms(o: ToolOptions, c: Vec): ((p: Vec) => Vec)[] {
  const id = (p: Vec) => p;
  switch (o.symmetry) {
    case 'x':
      return [id, (p) => ({ x: 2 * c.x - p.x, y: p.y })];
    case 'y':
      return [id, (p) => ({ x: p.x, y: 2 * c.y - p.y })];
    case 'xy':
      return [id, (p) => ({ x: 2 * c.x - p.x, y: p.y }), (p) => ({ x: p.x, y: 2 * c.y - p.y }), (p) => ({ x: 2 * c.x - p.x, y: 2 * c.y - p.y })];
    case 'radial': {
      const n = Math.max(2, Math.min(64, o.symmetrySegments));
      return Array.from({ length: n }, (_, k) => {
        const a = (k * 2 * Math.PI) / n;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        return (p: Vec) => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos });
      });
    }
    default:
      return [id];
  }
}

export function symmetryCenter(world: Vec): Vec {
  const s = editor();
  const f = frameAt(s.doc, s.pageId, world);
  if (f) {
    const b = worldBounds(s.doc, f);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  return viewCenter();
}

function pressureOf(p: PointerInfo): number {
  if (p.pointerType === 'pen' && p.pressure > 0) return p.pressure;
  return 0.5;
}

function makeDrawTool(id: 'pencil' | 'brush'): Tool {
  return {
    id,
    cursor: id === 'pencil' ? CURSORS.pencil : CURSORS.crosshair,
    down(p) {
      if (p.button !== 0) return;
      const s = editor();
      stroke = {
        pts: [{ x: p.world.x, y: p.world.y, p: pressureOf(p) }],
        parent: frameAt(s.doc, s.pageId, p.world) ?? s.pageId,
        last: performance.now(),
        center: symmetryCenter(p.world),
      };
      requestOverlay();
    },
    move(p) {
      if (!stroke || !(p.buttons & 1)) return;
      const evs = (p.event as PointerEvent).getCoalescedEvents?.() ?? [];
      const last = stroke.pts[stroke.pts.length - 1];
      const v = getViewport();
      if (evs.length > 1) {
        const rect = (p.event.target as HTMLElement).getBoundingClientRect();
        for (const e of evs) {
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          stroke.pts.push({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom, p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5 });
        }
      } else if (Math.hypot(p.world.x - last.x, p.world.y - last.y) * v.zoom > 0.5) {
        stroke.pts.push({ x: p.world.x, y: p.world.y, p: pressureOf(p) });
      }
      requestOverlay();
    },
    up(p) {
      if (!stroke) return;
      const st = stroke;
      stroke = null;
      const s = editor();
      const o = s.toolOptions;
      if (st.pts.length < 2) st.pts.push({ x: st.pts[0].x + 0.01, y: st.pts[0].y + 0.01, p: st.pts[0].p });
      const transforms = symmetryTransforms(o, st.center);
      const zoom = getViewport().zoom;
      s.mutate(
        (d) => {
          const ids: ID[] = [];
          for (const tf of transforms) {
            const pts = st.pts.map((q) => ({ ...tf(q), p: q.p }));
            const local = pts.map((q) => ({ ...pagePointToParent(d, st.parent, q), p: q.p }));
            if (id === 'pencil') {
              const first = local[0];
              const lastPt = local[local.length - 1];
              const closed = local.length > 8 && Math.hypot(first.x - lastPt.x, first.y - lastPt.y) * zoom < 10;
              const cmds = simplifyPoints(local, o.pencilSmoothing / Math.max(0.25, Math.min(zoom, 4)), closed);
              if (!cmds.length) continue;
              const n = createNode('path', {
                parentId: st.parent,
                name: 'Pencil',
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                paths: cmdsToSubPaths(cmds),
                strokes: [solid(o.brushColor, o.brushOpacity)],
                strokeWidth: Math.max(1, Math.round(o.brush.size / 4)),
              });
              if (closed) n.paths.forEach((sp) => (sp.closed = true));
              insertNode(d, n, st.parent);
              refitNode(d, n.id);
              ids.push(n.id);
            } else {
              const brush = { ...o.brush, simulatePressure: p.pointerType !== 'pen' && o.brush.simulatePressure };
              const n = createNode('brush', {
                parentId: st.parent,
                name: `${brush.kind[0].toUpperCase()}${brush.kind.slice(1)} stroke`,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                points: local,
                brush,
                fills: [solid(o.brushColor, brush.kind === 'highlighter' ? Math.min(o.brushOpacity, 0.45) : o.brushOpacity)],
                blendMode: brush.kind === 'highlighter' ? 'multiply' : 'normal',
              });
              insertNode(d, n, st.parent);
              refitNode(d, n.id);
              ids.push(n.id);
            }
          }
          return ids;
        },
        { select: (r) => r, label: id === 'pencil' ? 'Pencil' : 'Brush' },
      );
      requestOverlay();
    },
    overlay(ctx) {
      const s = editor();
      const o = s.toolOptions;
      const v = getViewport();
      if (!stroke) {
        // brush size preview cursor
        if (id === 'brush') {
          const pw = ui.pointerWorld;
          if (pw) {
            const sp = toScreen(pw, v);
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, Math.max(2, (o.brush.size * v.zoom) / 2), 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, Math.max(2, (o.brush.size * v.zoom) / 2) + 1, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }
        if (o.symmetry !== 'none' && (id === 'brush' || id === 'pencil')) drawSymmetryGuides(ctx, symmetryCenter(ui.pointerWorld ?? viewCenter()), o);
        return;
      }
      const transforms = symmetryTransforms(o, stroke.center);
      ctx.save();
      for (const tf of transforms) {
        const pts = stroke.pts.map((q) => {
          const w = tf(q);
          return { x: w.x * v.zoom + v.x, y: w.y * v.zoom + v.y, p: q.p };
        });
        if (id === 'pencil') {
          ctx.strokeStyle = hexToRgba(o.brushColor, o.brushOpacity);
          ctx.lineWidth = Math.max(1, Math.round(o.brush.size / 4)) * v.zoom;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.stroke();
        } else {
          const outline = brushOutline(pts, { ...o.brush, size: o.brush.size * v.zoom }, false);
          ctx.fillStyle = hexToRgba(o.brushColor, o.brush.kind === 'highlighter' ? Math.min(o.brushOpacity, 0.45) : o.brushOpacity);
          if (o.brush.kind === 'highlighter') ctx.globalCompositeOperation = 'multiply';
          ctx.beginPath();
          outline.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
          ctx.closePath();
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      ctx.restore();
      if (o.symmetry !== 'none') drawSymmetryGuides(ctx, stroke.center, o);
    },
    cancel() {
      stroke = null;
    },
  };
}

export function drawSymmetryGuides(ctx: CanvasRenderingContext2D, c: Vec, o: ToolOptions) {
  const v = getViewport();
  const sc = toScreen(c, v);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(124,108,255,0.7)';
  ctx.lineWidth = 1;
  const L = 4000;
  ctx.beginPath();
  if (o.symmetry === 'x' || o.symmetry === 'xy') {
    ctx.moveTo(sc.x, sc.y - L);
    ctx.lineTo(sc.x, sc.y + L);
  }
  if (o.symmetry === 'y' || o.symmetry === 'xy') {
    ctx.moveTo(sc.x - L, sc.y);
    ctx.lineTo(sc.x + L, sc.y);
  }
  if (o.symmetry === 'radial') {
    const n = Math.max(2, o.symmetrySegments);
    for (let k = 0; k < n; k++) {
      const a = (k * 2 * Math.PI) / n - Math.PI / 2;
      ctx.moveTo(sc.x, sc.y);
      ctx.lineTo(sc.x + Math.cos(a) * L, sc.y + Math.sin(a) * L);
    }
  }
  ctx.stroke();
  ctx.restore();
}

export const pencilTool = makeDrawTool('pencil');
export const brushTool = makeDrawTool('brush');
