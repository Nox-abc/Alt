import type { FrameNode, ID, Rect, Vec } from '../core/types';
import { editor, getViewport } from '../core/store';
import { apply, selectionBounds, worldBounds, worldMatrix, type Mat } from '../core/geometry';
import { getPage, isContainer } from '../core/doc';
import { nodePath } from '../render/renderer';
import { useSettings } from './settings';
import { HANDLES, quadPoint, selectionFrame, ui } from './toolkit';
import { toScreen } from './viewport';

export function accentColor(): string {
  return useSettings.getState().accent;
}

const FONT = '500 11px "Inter Variable", Inter, system-ui, sans-serif';

/* ------------------------------------------------------------ frame labels */

let labelRects: { id: ID; r: Rect }[] = [];

export function frameLabelAt(p: Vec): ID | null {
  for (let i = labelRects.length - 1; i >= 0; i--) {
    const { id, r } = labelRects[i];
    if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) return id;
  }
  return null;
}

function drawFrameLabels(ctx: CanvasRenderingContext2D) {
  labelRects = [];
  const s = editor();
  if (!useSettings.getState().showFrameLabels) return;
  const page = getPage(s.doc, s.pageId);
  if (!page) return;
  const v = getViewport();
  ctx.font = FONT;
  ctx.textBaseline = 'alphabetic';
  for (const id of page.children) {
    const n = s.doc.nodes[id];
    if (!n || n.type !== 'frame' || !n.visible) continue;
    const m = worldMatrix(s.doc, id);
    const tl = toScreen(apply(m, { x: 0, y: 0 }), v);
    const tr = toScreen(apply(m, { x: n.width, y: 0 }), v);
    const width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    if (width < 24) continue;
    const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x);
    let text = n.name;
    const maxW = width;
    if (ctx.measureText(text).width > maxW) {
      while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
      text += '…';
    }
    const selected = s.selection.includes(id);
    const hovered = s.hoverId === id;
    ctx.save();
    ctx.translate(tl.x, tl.y);
    ctx.rotate(angle);
    ctx.fillStyle = selected || hovered ? accentColor() : 'rgba(150,150,160,0.95)';
    if (n.isComponent) ctx.fillStyle = selected || hovered ? accentColor() : 'rgba(190,180,255,0.95)';
    ctx.fillText(text, 0, -6);
    ctx.restore();
    const tw = ctx.measureText(text).width;
    if (Math.abs(angle) < 0.01) labelRects.push({ id, r: { x: tl.x, y: tl.y - 20, width: tw, height: 18 } });
  }
}

/* ---------------------------------------------------------------- helpers */

function outlineNode(ctx: CanvasRenderingContext2D, id: ID, width: number, color: string) {
  const s = editor();
  const n = s.doc.nodes[id];
  if (!n) return;
  const v = getViewport();
  const m = worldMatrix(s.doc, id);
  const vm: Mat = [m[0] * v.zoom, m[1] * v.zoom, m[2] * v.zoom, m[3] * v.zoom, m[4] * v.zoom + v.x, m[5] * v.zoom + v.y];
  ctx.save();
  ctx.setTransform(ctx.getTransform().multiply(new DOMMatrix(vm)));
  ctx.lineWidth = width / v.zoom;
  ctx.strokeStyle = color;
  if (n.type === 'text' || n.type === 'group' || n.type === 'frame' || n.type === 'bitmap') {
    ctx.strokeRect(0, 0, n.width, n.height);
  } else {
    try {
      ctx.stroke(nodePath(s.doc, n));
    } catch {
      ctx.strokeRect(0, 0, n.width, n.height);
    }
  }
  ctx.restore();
}

function quadScreen(q: Vec[]): Vec[] {
  const v = getViewport();
  return q.map((p) => toScreen(p, v));
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg = '#fff', align: 'center' | 'left' = 'center') {
  ctx.font = FONT;
  const w = ctx.measureText(text).width + 10;
  const h = 18;
  const left = align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(Math.round(left), Math.round(y), w, h, 4);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, Math.round(left + 5), Math.round(y + h / 2) + 0.5);
  ctx.textBaseline = 'alphabetic';
}

/* ------------------------------------------------------------ measurement */

function drawMeasure(ctx: CanvasRenderingContext2D) {
  const s = editor();
  if (!ui.altDown || !s.selection.length || ui.dragging) return;
  const a = selectionBounds(s.doc, s.selection);
  if (!a) return;
  let target: Rect | null = null;
  if (s.hoverId && !s.selection.includes(s.hoverId)) target = worldBounds(s.doc, s.hoverId);
  else {
    const parent = s.doc.nodes[s.doc.nodes[s.selection[0]]?.parentId];
    if (parent) target = worldBounds(s.doc, parent.id);
  }
  if (!target) return;
  const v = getViewport();
  const red = '#F24E5E';
  ctx.save();
  ctx.strokeStyle = red;
  ctx.lineWidth = 1;
  const line = (x1: number, y1: number, x2: number, y2: number, label: number) => {
    if (Math.abs(label) < 0.01) return;
    const p1 = toScreen({ x: x1, y: y1 }, v);
    const p2 = toScreen({ x: x2, y: y2 }, v);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    pill(ctx, String(+Math.abs(label).toFixed(2)), (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 9, red);
  };
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  const inside = a.x >= target.x && a.y >= target.y && a.x + a.width <= target.x + target.width && a.y + a.height <= target.y + target.height;
  if (inside) {
    line(target.x, cy, a.x, cy, a.x - target.x);
    line(a.x + a.width, cy, target.x + target.width, cy, target.x + target.width - (a.x + a.width));
    line(cx, target.y, cx, a.y, a.y - target.y);
    line(cx, a.y + a.height, cx, target.y + target.height, target.y + target.height - (a.y + a.height));
  } else {
    if (target.x > a.x + a.width) line(a.x + a.width, cy, target.x, cy, target.x - (a.x + a.width));
    else if (target.x + target.width < a.x) line(target.x + target.width, cy, a.x, cy, a.x - (target.x + target.width));
    if (target.y > a.y + a.height) line(cx, a.y + a.height, cx, target.y, target.y - (a.y + a.height));
    else if (target.y + target.height < a.y) line(cx, target.y + target.height, cx, a.y, a.y - (target.y + target.height));
    const t = quadScreen([
      { x: target.x, y: target.y },
      { x: target.x + target.width, y: target.y },
      { x: target.x + target.width, y: target.y + target.height },
      { x: target.x, y: target.y + target.height },
    ]);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    t.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

/* ----------------------------------------------------------- grids & guides */

function drawPixelGrid(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const v = getViewport();
  if (!useSettings.getState().showPixelGrid || v.zoom < 8) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(128,128,128,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const x0 = Math.floor(-v.x / v.zoom);
  const x1 = Math.ceil((W - v.x) / v.zoom);
  const y0 = Math.floor(-v.y / v.zoom);
  const y1 = Math.ceil((H - v.y) / v.zoom);
  for (let x = x0; x <= x1; x++) {
    const sx = Math.round(x * v.zoom + v.x) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, H);
  }
  for (let y = y0; y <= y1; y++) {
    const sy = Math.round(y * v.zoom + v.y) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(W, sy);
  }
  ctx.stroke();
  ctx.restore();
}

function drawBitmapGrids(ctx: CanvasRenderingContext2D) {
  const s = editor();
  const v = getViewport();
  const page = getPage(s.doc, s.pageId);
  if (!page) return;
  const visit = (ids: ID[]) => {
    for (const id of ids) {
      const n = s.doc.nodes[id];
      if (!n || !n.visible) continue;
      if (isContainer(n)) visit(n.children);
      if (n.type !== 'bitmap' || !n.pixelGrid) continue;
      const cw = n.width / n.pixelWidth;
      const ch = n.height / n.pixelHeight;
      if (cw * v.zoom < 6 || n.pixelWidth > 512 || n.pixelHeight > 512) continue;
      const m = worldMatrix(s.doc, id);
      ctx.save();
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= n.pixelWidth; i++) {
        const a = toScreen(apply(m, { x: i * cw, y: 0 }), v);
        const b = toScreen(apply(m, { x: i * cw, y: n.height }), v);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      for (let j = 0; j <= n.pixelHeight; j++) {
        const a = toScreen(apply(m, { x: 0, y: j * ch }), v);
        const b = toScreen(apply(m, { x: n.width, y: j * ch }), v);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  };
  visit(page.children);
}

function drawLayoutGrids(ctx: CanvasRenderingContext2D) {
  const s = editor();
  const v = getViewport();
  const page = getPage(s.doc, s.pageId);
  if (!page) return;
  const visit = (ids: ID[]) => {
    for (const id of ids) {
      const n = s.doc.nodes[id];
      if (!n || !n.visible || n.type !== 'frame') continue;
      visit(n.children);
      const f = n as FrameNode;
      if (!f.layoutGrids?.length) continue;
      const m = worldMatrix(s.doc, id);
      for (const g of f.layoutGrids) {
        if (!g.visible) continue;
        ctx.save();
        const rects: Rect[] = [];
        if (g.type === 'grid') {
          ctx.strokeStyle = hexA(g.color, g.opacity);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = 0; x <= f.width; x += Math.max(1, g.size)) {
            const a = toScreen(apply(m, { x, y: 0 }), v);
            const b = toScreen(apply(m, { x, y: f.height }), v);
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
          for (let y = 0; y <= f.height; y += Math.max(1, g.size)) {
            const a = toScreen(apply(m, { x: 0, y }), v);
            const b = toScreen(apply(m, { x: f.width, y }), v);
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
          ctx.stroke();
        } else {
          const along = g.type === 'columns' ? f.width : f.height;
          const count = Math.max(1, g.count);
          const size = (along - g.margin * 2 - g.gutter * (count - 1)) / count;
          for (let i = 0; i < count; i++) {
            const start = g.margin + i * (size + g.gutter);
            rects.push(g.type === 'columns' ? { x: start, y: 0, width: size, height: f.height } : { x: 0, y: start, width: f.width, height: size });
          }
          ctx.fillStyle = hexA(g.color, g.opacity);
          for (const r of rects) {
            const q = [
              { x: r.x, y: r.y },
              { x: r.x + r.width, y: r.y },
              { x: r.x + r.width, y: r.y + r.height },
              { x: r.x, y: r.y + r.height },
            ].map((p) => toScreen(apply(m, p), v));
            ctx.beginPath();
            q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.fill();
          }
        }
        ctx.restore();
      }
    }
  };
  visit(page.children);
}

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawGuides(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const s = editor();
  const page = getPage(s.doc, s.pageId);
  if (!page?.guides.length) return;
  const v = getViewport();
  ctx.save();
  ctx.strokeStyle = '#F24E5E';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const g of page.guides) {
    if (g.axis === 'x') {
      const x = Math.round(g.value * v.zoom + v.x) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    } else {
      const y = Math.round(g.value * v.zoom + v.y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

/* -------------------------------------------------------------- selection */

function drawSelection(ctx: CanvasRenderingContext2D) {
  const s = editor();
  const accent = accentColor();
  const editingPath = s.editing?.kind === 'path';
  // hover
  if (s.hoverId && !s.selection.includes(s.hoverId) && !ui.dragging && !ui.transforming) outlineNode(ctx, s.hoverId, 1.5, accent);
  if (ui.dropTarget && s.doc.nodes[ui.dropTarget]) outlineNode(ctx, ui.dropTarget, 2, accent);
  if (!s.selection.length || editingPath) return;
  if (s.selection.length > 1) for (const id of s.selection) outlineNode(ctx, id, 1, accent);
  else if (s.doc.nodes[s.selection[0]] && !['frame', 'group', 'text', 'bitmap', 'rect'].includes(s.doc.nodes[s.selection[0]].type)) {
    outlineNode(ctx, s.selection[0], 1, accent);
  }
  const f = selectionFrame();
  if (!f) return;
  const q = quadScreen(f.quad);
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  const locked = s.selection.some((id) => s.doc.nodes[id]?.locked);
  const editingText = s.editing?.kind === 'text';
  if (!locked && !editingText && !ui.dragging) {
    const w = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
    const h = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
    const tiny = w < 18 || h < 18;
    for (const hd of HANDLES) {
      const isEdge = hd.hx === 0.5 || hd.hy === 0.5;
      if (isEdge) continue;
      if (tiny && hd.id !== 'se') continue;
      const p = quadPoint(q, hd.hx, hd.hy);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((f.rotation * Math.PI) / 180);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 2;
      ctx.beginPath();
      ctx.rect(-3.5, -3.5, 7, 7);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.stroke();
      ctx.restore();
    }
  }
  // dimension pill under the box
  if (!editingText) {
    const bottom = q.reduce((a, b) => (b.y > a.y ? b : a), q[0]);
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const label = `${+f.width.toFixed(2)} × ${+f.height.toFixed(2)}`;
    const single = f.single ? s.doc.nodes[f.single] : null;
    const hug = single?.type === 'frame' && single.layout ? (single.sizingH === 'hug' || single.sizingV === 'hug' ? ' · Hug' : '') : '';
    pill(ctx, label + hug, cx, bottom.y + 8, accent);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------- main */

export function drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, toolOverlay?: (ctx: CanvasRenderingContext2D) => void) {
  ctx.clearRect(0, 0, W, H);
  const s = editor();
  const v = getViewport();
  drawPixelGrid(ctx, W, H);
  drawLayoutGrids(ctx);
  drawBitmapGrids(ctx);
  drawGuides(ctx, W, H);
  drawFrameLabels(ctx);
  drawSelection(ctx);
  // snapping guides
  if (ui.snapLines.length) {
    ctx.save();
    ctx.strokeStyle = '#F24E5E';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const l of ui.snapLines) {
      if (l.axis === 'x') {
        const a = toScreen({ x: l.value, y: l.from }, v);
        const b = toScreen({ x: l.value, y: l.to }, v);
        ctx.moveTo(Math.round(a.x) + 0.5, a.y);
        ctx.lineTo(Math.round(b.x) + 0.5, b.y);
      } else {
        const a = toScreen({ x: l.from, y: l.value }, v);
        const b = toScreen({ x: l.to, y: l.value }, v);
        ctx.moveTo(a.x, Math.round(a.y) + 0.5);
        ctx.lineTo(b.x, Math.round(b.y) + 0.5);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  if (ui.insertion) {
    const a = toScreen(ui.insertion.a, v);
    const b = toScreen(ui.insertion.b, v);
    ctx.save();
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
  if (ui.marquee) {
    const a = toScreen({ x: ui.marquee.x, y: ui.marquee.y }, v);
    const w = ui.marquee.width * v.zoom;
    const h = ui.marquee.height * v.zoom;
    ctx.save();
    ctx.fillStyle = hexA(accentColor(), 0.08);
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, w, h);
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(w), Math.round(h));
    ctx.restore();
  }
  drawMeasure(ctx);
  toolOverlay?.(ctx);
  if (ui.label?.text) {
    pill(ctx, ui.label.text, ui.label.at.x + 14, ui.label.at.y + 18, 'rgba(20,20,24,0.92)', '#fff', 'left');
  }
  void s;
}
