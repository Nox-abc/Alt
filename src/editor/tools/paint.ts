import type { BitmapNode, ID, Vec } from '../../core/types';
import { editor, getViewport, type ToolId } from '../../core/store';
import { apply, invert, worldBounds, worldMatrix } from '../../core/geometry';
import { createNode, hexToRgb, uid } from '../../core/doc';
import { frameAt, insertNode, pageRectToParent } from '../../core/ops';
import { hitTest } from '../../render/hit';
import { assets } from '../../render/assets';
import { CURSORS, requestOverlay, requestScene, ui, type PointerInfo, type Tool } from '../toolkit';
import { toScreen, visibleWorldRect } from '../viewport';
import { symmetryTransforms } from './draw';

interface Session {
  tool: ToolId;
  nodeId: ID;
  oldAsset: ID | null;
  liveId: ID;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  base: HTMLCanvasElement;
  layer: HTMLCanvasElement;
  lctx: CanvasRenderingContext2D;
  inv: ReturnType<typeof invert>;
  sx: number;
  sy: number;
  last: Vec | null;
  stamp: HTMLCanvasElement | null;
  erase: boolean;
}

let session: Session | null = null;

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function findBitmapTarget(p: PointerInfo): BitmapNode | null {
  const s = editor();
  if (s.selection.length === 1) {
    const n = s.doc.nodes[s.selection[0]];
    if (n?.type === 'bitmap' && !n.locked) return n;
  }
  const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = s.doc.nodes[chain[i]];
    if (n?.type === 'bitmap' && !n.locked) return n;
  }
  return null;
}

/** Create a fresh transparent paint layer under the pointer. */
function createBitmap(p: PointerInfo, pixelArt: boolean): ID {
  const s = editor();
  const parent = frameAt(s.doc, s.pageId, p.world) ?? s.pageId;
  return s.mutate(
    (d) => {
      let r;
      let pw: number;
      let ph: number;
      if (pixelArt) {
        const cells = 32;
        const cell = Math.max(1, Math.round(16 / Math.max(0.25, Math.min(4, getViewport().zoom))));
        const size = cells * cell;
        r = pageRectToParent(d, parent, { x: Math.round(p.world.x - size / 2), y: Math.round(p.world.y - size / 2), width: size, height: size });
        pw = cells;
        ph = cells;
      } else if (parent !== s.pageId) {
        const f = d.nodes[parent];
        r = { x: 0, y: 0, width: f.width, height: f.height };
        const k = Math.min(2, 4096 / Math.max(f.width, f.height));
        pw = Math.round(f.width * k);
        ph = Math.round(f.height * k);
      } else {
        const v = visibleWorldRect();
        const rr = { x: Math.floor(v.x), y: Math.floor(v.y), width: Math.ceil(v.width), height: Math.ceil(v.height) };
        r = rr;
        const k = Math.min(2 * getViewport().zoom, 4096 / Math.max(rr.width, rr.height));
        pw = Math.round(rr.width * k);
        ph = Math.round(rr.height * k);
      }
      const n = createNode('bitmap', {
        parentId: parent,
        name: pixelArt ? 'Pixel art' : 'Paint layer',
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        pixelWidth: Math.max(1, pw),
        pixelHeight: Math.max(1, ph),
        smoothing: !pixelArt,
        pixelGrid: pixelArt,
        assetId: 'asset_' + uid(),
      });
      insertNode(d, n, parent);
      return n.id;
    },
    { select: (id) => [id], history: false },
  );
}

function startSession(tool: ToolId, node: BitmapNode, erase: boolean): Session {
  const s = editor();
  const canvas = makeCanvas(node.pixelWidth, node.pixelHeight);
  const ctx = canvas.getContext('2d')!;
  const src = assets.getLive(node.assetId) ?? assets.get(s.doc, node.assetId);
  if (src) ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const base = makeCanvas(canvas.width, canvas.height);
  base.getContext('2d')!.drawImage(canvas, 0, 0);
  const layer = makeCanvas(canvas.width, canvas.height);
  const liveId = node.assetId;
  assets.setLive(liveId, canvas);
  return {
    tool,
    nodeId: node.id,
    oldAsset: s.doc.assets[node.assetId] ? node.assetId : null,
    liveId,
    canvas,
    ctx,
    base,
    layer,
    lctx: layer.getContext('2d')!,
    inv: invert(worldMatrix(s.doc, node.id)),
    sx: node.pixelWidth / node.width,
    sy: node.pixelHeight / node.height,
    last: null,
    stamp: null,
    erase,
  };
}

function toPixel(s: Session, world: Vec): Vec {
  const lp = apply(s.inv, world);
  return { x: lp.x * s.sx, y: lp.y * s.sy };
}

function softStamp(color: string, radius: number, hardness: number): HTMLCanvasElement {
  const r = Math.max(0.5, radius);
  const size = Math.ceil(r * 2) + 2;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d')!;
  const { r: R, g: G, b: B } = hexToRgb(color);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, r);
  const h = Math.max(0, Math.min(0.99, hardness));
  grad.addColorStop(0, `rgba(${R},${G},${B},1)`);
  grad.addColorStop(h, `rgba(${R},${G},${B},1)`);
  grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  g.fill();
  return c;
}

function composite(s: Session) {
  const o = editor().toolOptions;
  s.ctx.globalCompositeOperation = 'copy';
  s.ctx.globalAlpha = 1;
  s.ctx.drawImage(s.base, 0, 0);
  s.ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  s.ctx.globalAlpha = s.tool === 'pixel' ? 1 : o.paintOpacity;
  s.ctx.drawImage(s.layer, 0, 0);
  s.ctx.globalCompositeOperation = 'source-over';
  s.ctx.globalAlpha = 1;
  assets.touch();
  requestScene();
}

function pixelCenter(s: Session): Vec {
  return { x: s.canvas.width / 2, y: s.canvas.height / 2 };
}

function dab(s: Session, at: Vec, pressure: number) {
  const o = editor().toolOptions;
  const tfs = symmetryTransforms(o, pixelCenter(s));
  const g = s.lctx;
  if (s.tool === 'pixel') {
    const size = Math.max(1, Math.round(o.pixelSize));
    g.fillStyle = o.paintColor;
    for (const tf of tfs) {
      const q = tf(at);
      const x = Math.floor(q.x - (size - 1) / 2);
      const y = Math.floor(q.y - (size - 1) / 2);
      g.fillRect(x, y, size, size);
    }
    return;
  }
  const scale = (s.sx + s.sy) / 2;
  const radius = (o.paintSize / 2) * scale * (0.25 + pressure * 1.5);
  if (s.tool === 'spray') {
    const count = Math.max(1, Math.round(o.sprayDensity * radius * 0.8));
    g.fillStyle = o.paintColor;
    for (const tf of tfs) {
      const q = tf(at);
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * radius;
        const dot = Math.max(0.6, scale * 0.8);
        g.globalAlpha = 0.4 + Math.random() * 0.6;
        g.fillRect(q.x + Math.cos(a) * d, q.y + Math.sin(a) * d, dot, dot);
      }
    }
    g.globalAlpha = 1;
    return;
  }
  if (!s.stamp || Math.abs(s.stamp.width - (Math.ceil(radius * 2) + 2)) > 1) s.stamp = softStamp(o.paintColor, radius, o.paintHardness);
  g.globalAlpha = Math.max(0.02, o.paintFlow);
  for (const tf of tfs) {
    const q = tf(at);
    g.drawImage(s.stamp, q.x - s.stamp.width / 2, q.y - s.stamp.height / 2);
  }
  g.globalAlpha = 1;
}

function strokeTo(s: Session, to: Vec, pressure: number) {
  const o = editor().toolOptions;
  if (!s.last) {
    dab(s, to, pressure);
    s.last = to;
    return;
  }
  const from = s.last;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const scale = (s.sx + s.sy) / 2;
  const spacing = s.tool === 'pixel' ? 0.5 : s.tool === 'spray' ? Math.max(2, o.paintSize * scale * 0.3) : Math.max(0.5, o.paintSize * scale * 0.08);
  const steps = Math.max(1, Math.floor(dist / spacing));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    dab(s, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, pressure);
  }
  s.last = to;
}

function floodFill(canvas: HTMLCanvasElement, at: Vec, color: string, tolerance: number) {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const x0 = Math.floor(at.x);
  const y0 = Math.floor(at.y);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const i0 = (y0 * w + x0) * 4;
  const tr = d[i0];
  const tg = d[i0 + 1];
  const tb = d[i0 + 2];
  const ta = d[i0 + 3];
  const { r, g, b } = hexToRgb(color);
  const tol = tolerance * 4;
  const match = (i: number) => Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) + Math.abs(d[i + 3] - ta) <= tol;
  if (tr === r && tg === g && tb === b && ta === 255) return false;
  const seen = new Uint8Array(w * h);
  const stack = [x0, y0];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    let xl = x;
    while (xl >= 0 && !seen[y * w + xl] && match((y * w + xl) * 4)) xl--;
    xl++;
    let xr = x;
    while (xr < w && !seen[y * w + xr] && match((y * w + xr) * 4)) xr++;
    for (let xi = xl; xi < xr; xi++) {
      const k = y * w + xi;
      seen[k] = 1;
      const o = k * 4;
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
      if (y > 0 && !seen[k - w] && match((k - w) * 4)) stack.push(xi, y - 1);
      if (y < h - 1 && !seen[k + w] && match((k + w) * 4)) stack.push(xi, y + 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

function commit(s: Session) {
  const st = editor();
  const data = s.canvas.toDataURL('image/png');
  const newId = 'asset_' + uid();
  const nodeId = s.nodeId;
  const old = s.oldAsset;
  st.mutate(
    (d) => {
      d.assets[newId] = { id: newId, mime: 'image/png', data, width: s.canvas.width, height: s.canvas.height };
      const n = d.nodes[nodeId];
      if (n && n.type === 'bitmap') n.assetId = newId;
      if (old && old !== newId) {
        const stillUsed = Object.values(d.nodes).some((x) => x.id !== nodeId && x.type === 'bitmap' && x.assetId === old);
        if (!stillUsed) delete d.assets[old];
      }
    },
    { history: false },
  );
  assets.setLive(s.liveId, null);
  assets.setLive(newId, s.canvas);
  st.commit();
}

function makePaintTool(id: 'paint' | 'eraser' | 'spray' | 'pixel' | 'bucket'): Tool {
  return {
    id,
    cursor: id === 'bucket' ? CURSORS.bucket : 'none',
    down(p) {
      if (p.button !== 0) return;
      const s = editor();
      if (id === 'bucket') {
        const target = findBitmapTarget(p);
        if (!target) {
          // vector target → recolour its fill
          const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
          const leafId = chain[chain.length - 1];
          const leaf = leafId ? s.doc.nodes[leafId] : null;
          if (leaf) {
            const color = s.toolOptions.paintColor;
            s.mutate(
              (d) => {
                const n = d.nodes[leaf.id];
                if (n.type === 'text' || n.fills.length === 0) n.fills = [{ id: uid(), type: 'solid', color, opacity: 1, visible: true }];
                else n.fills[0] = { id: n.fills[0].id, type: 'solid', color, opacity: 1, visible: true };
              },
              { select: [leaf.id], label: 'Fill' },
            );
          }
          return;
        }
        s.begin('Fill');
        const ses = startSession('bucket', target, false);
        const at = toPixel(ses, p.world);
        floodFill(ses.canvas, at, s.toolOptions.paintColor, s.toolOptions.bucketTolerance);
        assets.touch();
        commit(ses);
        requestScene();
        return;
      }
      let target = findBitmapTarget(p);
      if (!target && id === 'eraser') return;
      s.begin(id === 'eraser' ? 'Erase' : 'Paint');
      if (!target) {
        const nid = createBitmap(p, id === 'pixel');
        target = editor().doc.nodes[nid] as BitmapNode;
      }
      session = startSession(id, target, id === 'eraser' || (id === 'pixel' && p.alt));
      strokeTo(session, toPixel(session, p.world), p.pointerType === 'pen' ? p.pressure : 0.5);
      composite(session);
    },
    move(p) {
      requestOverlay();
      if (!session || !(p.buttons & 1)) return;
      const evs = (p.event as PointerEvent).getCoalescedEvents?.() ?? [];
      if (evs.length > 1) {
        const rect = (p.event.target as HTMLElement).getBoundingClientRect();
        const v = getViewport();
        for (const e of evs) {
          const w = { x: (e.clientX - rect.left - v.x) / v.zoom, y: (e.clientY - rect.top - v.y) / v.zoom };
          strokeTo(session, toPixel(session, w), e.pointerType === 'pen' ? e.pressure : 0.5);
        }
      } else strokeTo(session, toPixel(session, p.world), p.pointerType === 'pen' ? p.pressure : 0.5);
      composite(session);
    },
    up() {
      if (!session) return;
      const s = session;
      session = null;
      commit(s);
      requestOverlay();
    },
    overlay(ctx) {
      if (id === 'bucket') return;
      const pw = ui.pointerWorld;
      if (!pw) return;
      const s = editor();
      const o = s.toolOptions;
      const v = getViewport();
      const sp = toScreen(pw, v);
      ctx.save();
      if (id === 'pixel') {
        // highlight the pixel cell under the cursor
        const target = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null;
        if (target?.type === 'bitmap') {
          const inv = invert(worldMatrix(s.doc, target.id));
          const lp = apply(inv, pw);
          const cw = target.width / target.pixelWidth;
          const ch = target.height / target.pixelHeight;
          const size = Math.max(1, Math.round(o.pixelSize));
          const px = Math.floor(lp.x / cw - (size - 1) / 2);
          const py = Math.floor(lp.y / ch - (size - 1) / 2);
          const m = worldMatrix(s.doc, target.id);
          const corners = [
            [px * cw, py * ch],
            [(px + size) * cw, py * ch],
            [(px + size) * cw, (py + size) * ch],
            [px * cw, (py + size) * ch],
          ].map(([x, y]) => toScreen(apply(m, { x, y }), v));
          ctx.beginPath();
          corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
          ctx.closePath();
          ctx.fillStyle = o.paintColor + '88';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.strokeStyle = '#fff';
          ctx.strokeRect(sp.x - 4, sp.y - 4, 8, 8);
        }
      } else {
        const r = Math.max(2, (o.paintSize * v.zoom) / 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (id === 'spray') {
          ctx.setLineDash([2, 3]);
          ctx.stroke();
        }
      }
      ctx.restore();
    },
    cancel() {
      if (session) {
        assets.setLive(session.liveId, null);
        editor().cancel();
      }
      session = null;
    },
  };
}

export const paintTool = makePaintTool('paint');
export const eraserTool = makePaintTool('eraser');
export const sprayTool = makePaintTool('spray');
export const pixelTool = makePaintTool('pixel');
export const bucketTool = makePaintTool('bucket');

export function bitmapBounds(id: ID) {
  return worldBounds(editor().doc, id);
}
