import type { ID, PathNode, Vec } from '../../core/types';
import { editor, getViewport } from '../../core/store';
import { apply, invert, worldMatrix } from '../../core/geometry';
import { createNode } from '../../core/doc';
import { frameAt, insertNode, pagePointToParent, refitNode } from '../../core/ops';
import { CURSORS, requestOverlay, setCursor, ui, type PointerInfo, type Tool } from '../toolkit';
import { toScreen } from '../viewport';
import { vectorEdit } from './vector';
import { accentColor } from '../overlay';

/**
 * Pen tool: click for corners, drag for smooth points, click the first point to
 * close. Works on the path currently in vector-edit mode (extends open ends).
 */
let active: { id: ID; sub: number; dragging: boolean; downAt: Vec } | null = null;

function pathNode(id: ID | undefined): PathNode | null {
  if (!id) return null;
  const n = editor().doc.nodes[id];
  return n?.type === 'path' ? n : null;
}

function toLocal(id: ID, world: Vec): Vec {
  return apply(invert(worldMatrix(editor().doc, id)), world);
}

function constrain(prev: Vec | null, p: Vec, shift: boolean): Vec {
  if (!shift || !prev) return p;
  const dx = p.x - prev.x;
  const dy = p.y - prev.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: prev.x + Math.cos(ang) * len, y: prev.y + Math.sin(ang) * len };
}

function firstPointScreen(n: PathNode, sub: number): Vec | null {
  const sp = n.paths[sub];
  if (!sp?.points.length) return null;
  return toScreen(apply(worldMatrix(editor().doc, n.id), sp.points[0]));
}

function lastWorldPoint(): Vec | null {
  if (!active) return null;
  const n = pathNode(active.id);
  const sp = n?.paths[active.sub];
  if (!n || !sp?.points.length) return null;
  return apply(worldMatrix(editor().doc, n.id), sp.points[sp.points.length - 1]);
}

function finish() {
  const s = editor();
  if (active) {
    const n = pathNode(active.id);
    if (n && n.paths.every((sp) => sp.points.length < 2)) {
      s.cancel();
      active = null;
      return;
    }
    s.commit();
    const id = active.id;
    active = null;
    if (editor().doc.nodes[id]) {
      s.setSelection([id]);
      s.setEditing({ kind: 'path', id });
    }
  }
  requestOverlay();
}

export const penTool: Tool = {
  id: 'pen',
  cursor: CURSORS.pen,
  activate() {
    active = null;
  },
  down(p) {
    if (p.button !== 0) return;
    const s = editor();
    // close the path when clicking its first point
    if (active) {
      const n = pathNode(active.id);
      const fp = n ? firstPointScreen(n, active.sub) : null;
      if (n && fp && n.paths[active.sub].points.length > 2 && Math.hypot(fp.x - p.screen.x, fp.y - p.screen.y) < 8) {
        s.mutate(
          (d) => {
            (d.nodes[active!.id] as PathNode).paths[active!.sub].closed = true;
            refitNode(d, active!.id);
          },
          { history: false },
        );
        finish();
        return;
      }
    }
    // in vector edit mode, let the editor handle anchors/handles when not drawing
    if (!active && s.editing?.kind === 'path') {
      const n = pathNode(s.editing.id);
      if (n) {
        // continue from a selected open end point
        const sel = s.vectorSel[0];
        const sp = sel ? n.paths[sel.sub] : null;
        if (sp && !sp.closed && (sel.idx === sp.points.length - 1 || sel.idx === 0)) {
          s.begin('Pen');
          if (sel.idx === 0 && sp.points.length > 1) {
            s.mutate(
              (d) => {
                const q = (d.nodes[n.id] as PathNode).paths[sel.sub];
                q.points.reverse();
                for (const pt of q.points) [pt.in, pt.out] = [pt.out, pt.in];
              },
              { history: false },
            );
          }
          active = { id: n.id, sub: sel.sub, dragging: false, downAt: p.world };
        } else if (vectorEdit.down(p)) return;
      }
    }
    if (!active) {
      s.begin('Pen');
      const parent = frameAt(s.doc, s.pageId, p.world) ?? s.pageId;
      const id = s.mutate(
        (d) => {
          const lp = pagePointToParent(d, parent, p.world);
          const n = createNode('path', { parentId: parent, x: lp.x, y: lp.y, width: 0.01, height: 0.01, strokeWidth: 1, paths: [{ closed: false, points: [] }] });
          n.strokes = [{ id: n.strokes[0].id, type: 'solid', color: '#000000', opacity: 1, visible: true }];
          return insertNode(d, n, parent);
        },
        { select: (r) => [r], history: false },
      );
      active = { id, sub: 0, dragging: false, downAt: p.world };
    }
    const a = active!;
    const prev = lastWorldPoint();
    const at = constrain(prev, p.world, p.shift);
    const local = toLocal(a.id, at);
    s.mutate(
      (d) => {
        const n = d.nodes[a.id] as PathNode;
        n.paths[a.sub].points.push({ x: local.x, y: local.y, in: null, out: null, mode: 'corner' });
        refitNode(d, a.id);
      },
      { history: false },
    );
    a.dragging = true;
    a.downAt = at;
    requestOverlay();
  },
  move(p) {
    ui.pointerWorld = p.world;
    if (!active) {
      if (editor().editing?.kind === 'path') vectorEdit.move(p);
      requestOverlay();
      return;
    }
    const a = active;
    const n = pathNode(a.id);
    const fp = n ? firstPointScreen(n, a.sub) : null;
    setCursor(fp && n && n.paths[a.sub].points.length > 2 && Math.hypot(fp.x - p.screen.x, fp.y - p.screen.y) < 8 ? CURSORS.penClose : CURSORS.pen);
    if (a.dragging && p.buttons & 1) {
      // drag out symmetric handles for the point just placed
      const dragLocal = toLocal(a.id, p.world);
      const anchorLocal = toLocal(a.id, a.downAt);
      if (Math.hypot(p.world.x - a.downAt.x, p.world.y - a.downAt.y) * getViewport().zoom < 2) return;
      editor().mutate(
        (d) => {
          const pn = d.nodes[a.id] as PathNode;
          const sp = pn.paths[a.sub];
          const pt = sp.points[sp.points.length - 1];
          // handles must be expressed in the (possibly refitted) local space
          const dx = dragLocal.x - anchorLocal.x;
          const dy = dragLocal.y - anchorLocal.y;
          pt.out = { x: pt.x + dx, y: pt.y + dy };
          pt.in = p.alt && pt.in ? pt.in : { x: pt.x - dx, y: pt.y - dy };
          pt.mode = p.alt ? 'disconnected' : 'mirrored';
          refitNode(d, a.id);
        },
        { history: false },
      );
    }
    requestOverlay();
  },
  up(p) {
    if (!active) {
      if (editor().editing?.kind === 'path') vectorEdit.up(p);
      return;
    }
    active.dragging = false;
  },
  key(e) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      if (active) finish();
      else if (editor().editing) editor().setEditing(null);
      editor().setTool('move');
      return true;
    }
    if (!active && editor().editing?.kind === 'path') return vectorEdit.key(e);
    return false;
  },
  dblclick() {
    if (active) finish();
  },
  overlay(ctx) {
    const s = editor();
    if (s.editing?.kind === 'path' && !active) vectorEdit.overlay(ctx);
    if (!active) return;
    const n = pathNode(active.id);
    if (!n) return;
    vectorEditOverlayFor(ctx, n);
    const last = lastWorldPoint();
    const pw = ui.pointerWorld;
    if (!last || !pw || active.dragging) return;
    const sp = n.paths[active.sub];
    const lastPt = sp.points[sp.points.length - 1];
    const m = worldMatrix(s.doc, n.id);
    const v = getViewport();
    const a = toScreen(last, v);
    const b = toScreen(pw, v);
    ctx.save();
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    if (lastPt.out) {
      const c1 = toScreen(apply(m, lastPt.out), v);
      ctx.bezierCurveTo(c1.x, c1.y, b.x, b.y, b.x, b.y);
    } else ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  },
  cancel() {
    if (active) finish();
  },
};

function vectorEditOverlayFor(ctx: CanvasRenderingContext2D, n: PathNode) {
  vectorEdit.overlay(ctx, n.id);
}
