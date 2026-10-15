import type { Doc, ID, Rect, SceneNode, Vec } from '../../core/types';
import { editor, getViewport } from '../../core/store';
import {
  apply,
  invert,
  normRect,
  parentMatrix,
  rectContains,
  selectionBounds,
  snapAngle,
  worldBounds,
  worldMatrix,
  type Mat,
  pointInRect,
  normalizeAngle,
} from '../../core/geometry';
import { childrenOf, descendants, isContainer, sortByZ } from '../../core/doc';
import { duplicateNodes, flattenNodes, frameAt, getChildrenArray, moveNodes, rotateNodes, translateNodes } from '../../core/ops';
import { resizeContent } from '../../core/layout';
import { hitTest, nodesInRect } from '../../render/hit';
import { snapBox, snapTargets } from '../snapping';
import { useSettings } from '../settings';
import { toScreen } from '../viewport';
import {
  CURSORS,
  HANDLES,
  quadPoint,
  requestOverlay,
  resizeCursor,
  rotateCursor,
  selectionFrame,
  setCursor,
  ui,
  type PointerInfo,
  type SelectionFrame,
  type Tool,
} from '../toolkit';
import { vectorEdit } from './vector';
import { gradientEdit } from './gradient';
import { frameLabelAt } from '../overlay';

/* ------------------------------------------------------------ scale tool */

/** Scale tool: scale visual properties together with geometry (stroke, type, radii, effects). */
function scaleStyles(d: Doc, id: ID, k: number) {
  const n = d.nodes[id] as any;
  if (!n || k === 1) return;
  n.strokeWidth *= k;
  if (n.dash?.length) n.dash = n.dash.map((v: number) => v * k);
  if (typeof n.cornerRadius === 'number') n.cornerRadius *= k;
  if (n.cornerRadii) n.cornerRadii = n.cornerRadii.map((v: number) => v * k);
  if (n.type === 'text') {
    n.fontSize *= k;
    n.letterSpacing *= k;
    n.paragraphSpacing *= k;
  }
  if (n.type === 'brush') n.brush = { ...n.brush, size: n.brush.size * k };
  if (n.type === 'frame' && n.layout) {
    n.layout = { ...n.layout, gap: n.layout.gap * k, padding: n.layout.padding.map((v: number) => v * k) };
  }
  n.effects = n.effects.map((e: any) => {
    const o = { ...e };
    for (const key of ['x', 'y', 'blur', 'spread', 'radius', 'size']) if (typeof o[key] === 'number') o[key] *= k;
    return o;
  });
  for (const c of n.children ?? []) scaleStyles(d, c, k);
}

/* ------------------------------------------------------------- targeting */

/** Which node a click on `chain` should select (Figma-like rules). */
export function pickTarget(doc: Doc, chain: ID[], deep: boolean): ID | null {
  if (!chain.length) return null;
  if (deep) {
    // deepest selectable (skip boolean operands only when the boolean itself is the hit)
    return chain[chain.length - 1];
  }
  const sel = editor().selection;
  const entered = new Set<ID>();
  for (const id of sel) {
    let cur = doc.nodes[doc.nodes[id]?.parentId];
    while (cur) {
      entered.add(cur.id);
      cur = doc.nodes[cur.parentId];
    }
  }
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    const n = doc.nodes[id];
    const last = i === chain.length - 1;
    if (last) {
      // clicking the empty area of a top-level frame that has children → nothing (marquee)
      if (i === 0 && n?.type === 'frame' && n.children.length && !sel.includes(id)) return null;
      return id;
    }
    if (entered.has(id)) continue;
    if (i === 0 && n?.type === 'frame') continue;
    return id;
  }
  return null;
}

function restoreSubtrees(d: Doc, base: Doc, ids: ID[]) {
  for (const id of ids) {
    if (base.nodes[id]) d.nodes[id] = base.nodes[id];
    for (const c of descendants(base, id)) if (base.nodes[c]) d.nodes[c] = base.nodes[c];
  }
}

/* ------------------------------------------------------------ drag states */

type Drag =
  | {
      kind: 'move';
      start: Vec;
      ids: ID[];
      base: Doc;
      startBox: Rect;
      targets: ReturnType<typeof snapTargets>;
      layoutChild: ID | null;
      insertIndex: number | null;
      moved: boolean;
    }
  | { kind: 'marquee'; start: Vec; base: ID[]; scope: ID[]; scopeM: Mat }
  | {
      kind: 'resize';
      hx: number;
      hy: number;
      base: Doc;
      ids: ID[];
      frame: SelectionFrame;
      M0: Mat;
      inv0: Mat;
      w0: number;
      h0: number;
      axisAligned: boolean;
      targets: ReturnType<typeof snapTargets>;
    }
  | { kind: 'rotate'; center: Vec; start: number; base: Doc; ids: ID[]; startRot: number };

let press: { p: PointerInfo; intent: 'move' | 'marquee' | 'resize' | 'rotate'; handle?: { hx: number; hy: number }; scope?: ID[]; scopeM?: Mat } | null = null;
let drag: Drag | null = null;

const HANDLE_R = 7;

function hitHandles(screen: Vec): { kind: 'resize'; hx: number; hy: number; id: string } | { kind: 'rotate'; id: string } | null {
  const s = editor();
  if (!s.selection.length || s.editing) return null;
  if (s.selection.some((id) => s.doc.nodes[id]?.locked)) return null;
  const f = selectionFrame();
  if (!f) return null;
  const v = getViewport();
  const q = f.quad.map((p) => toScreen(p, v));
  const w = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const h = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
  const tiny = w < 18 || h < 18;
  for (const hd of HANDLES) {
    if (tiny && (hd.hx === 0.5 || hd.hy === 0.5)) continue;
    // edges are hit along the whole side
    const hp = quadPoint(q, hd.hx, hd.hy);
    if (hd.hx !== 0.5 && hd.hy !== 0.5) {
      if (Math.hypot(screen.x - hp.x, screen.y - hp.y) <= HANDLE_R) return { kind: 'resize', hx: hd.hx, hy: hd.hy, id: hd.id };
    }
  }
  // edges: distance to segment
  const segs: [number, number, number, number, string][] = [
    [0, 1, 0.5, 0, 'n'],
    [1, 2, 1, 0.5, 'e'],
    [2, 3, 0.5, 1, 's'],
    [3, 0, 0, 0.5, 'w'],
  ];
  for (const [a, b, hx, hy, id] of segs) {
    const A = q[a];
    const B = q[b];
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 24) continue;
    const t = ((screen.x - A.x) * (B.x - A.x) + (screen.y - A.y) * (B.y - A.y)) / (len * len);
    if (t < 0.12 || t > 0.88) continue;
    const px = A.x + (B.x - A.x) * t;
    const py = A.y + (B.y - A.y) * t;
    if (Math.hypot(screen.x - px, screen.y - py) <= 4) return { kind: 'resize', hx, hy, id };
  }
  // rotation zones just outside the corners
  const c = { x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 };
  for (const [i, id] of [
    [0, 'nw'],
    [1, 'ne'],
    [2, 'se'],
    [3, 'sw'],
  ] as const) {
    const p = q[i];
    const d = Math.hypot(screen.x - p.x, screen.y - p.y);
    const outward = (screen.x - p.x) * (p.x - c.x) + (screen.y - p.y) * (p.y - c.y) > -20;
    if (d > HANDLE_R && d < 22 && outward) {
      const inside = pointInQuad(screen, q);
      if (!inside) return { kind: 'rotate', id };
    }
  }
  return null;
}

function pointInQuad(p: Vec, q: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const xi = q[i].x;
    const yi = q[i].y;
    const xj = q[j].x;
    const yj = q[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function topLevelFrameAt(doc: Doc, chain: ID[]): ID | null {
  const first = chain[0] ? doc.nodes[chain[0]] : null;
  return first && first.type === 'frame' ? first.id : null;
}

/* ---------------------------------------------------------------- moving */

function startMove(p: PointerInfo, origin: Vec) {
  const s = editor();
  let ids = sortByZ(s.doc, s.selection).filter((id) => !s.doc.nodes[id]?.locked);
  if (!ids.length) return;
  s.begin('Move');
  if (p.alt) {
    ids = editor().mutate((d) => duplicateNodes(d, ids), { select: (r) => r, history: false });
  }
  const base = editor().doc;
  let layoutChild: ID | null = null;
  if (ids.length === 1) {
    const n = base.nodes[ids[0]];
    const parent = base.nodes[n.parentId];
    if (parent?.type === 'frame' && parent.layout && n.layoutPositioning === 'auto') layoutChild = n.id;
  }
  drag = {
    kind: 'move',
    start: origin,
    ids,
    base,
    startBox: selectionBounds(base, ids)!,
    targets: snapTargets(base, s.pageId, ids),
    layoutChild,
    insertIndex: null,
    moved: false,
  };
  ui.dragging = true;
}

function updateMove(p: PointerInfo) {
  if (!drag || drag.kind !== 'move') return;
  const d0 = drag;
  const v = getViewport();
  let dx = p.world.x - d0.start.x;
  let dy = p.world.y - d0.start.y;
  if (p.shift) {
    if (Math.abs(dx) > Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  const box = { ...d0.startBox, x: d0.startBox.x + dx, y: d0.startBox.y + dy };
  ui.snapLines = [];
  if (!p.mod && !d0.layoutChild) {
    const snap = snapBox(box, d0.targets, v.zoom);
    dx += snap.dx;
    dy += snap.dy;
    ui.snapLines = snap.lines;
    if (!snap.dx && useSettings.getState().snapToPixels) dx = Math.round(d0.startBox.x + dx) - d0.startBox.x;
    if (!snap.dy && useSettings.getState().snapToPixels) dy = Math.round(d0.startBox.y + dy) - d0.startBox.y;
  }
  d0.moved = true;
  const s = editor();
  s.mutate(
    (d) => {
      restoreSubtrees(d, d0.base, d0.ids);
      if (d0.layoutChild) d.nodes[d0.layoutChild].layoutPositioning = 'absolute';
      translateNodes(d, d0.ids, dx, dy);
    },
    { history: false },
  );
  // drop target / auto-layout insertion
  const doc = editor().doc;
  ui.insertion = null;
  if (d0.layoutChild) {
    const n = doc.nodes[d0.layoutChild];
    const parent = doc.nodes[n.parentId];
    if (parent?.type === 'frame' && parent.layout) {
      const inside = pointInRect(p.world, worldBounds(doc, parent.id));
      if (inside) {
        const horiz = parent.layout.mode === 'horizontal';
        const flow = parent.children.filter((c) => c !== n.id && doc.nodes[c]?.visible && doc.nodes[c]?.layoutPositioning === 'auto');
        let idx = flow.length;
        for (let i = 0; i < flow.length; i++) {
          const b = worldBounds(doc, flow[i]);
          const mid = horiz ? b.x + b.width / 2 : b.y + b.height / 2;
          if ((horiz ? p.world.x : p.world.y) < mid) {
            idx = i;
            break;
          }
        }
        d0.insertIndex = idx;
        const pb = worldBounds(doc, parent.id);
        let at: number;
        if (!flow.length) at = horiz ? pb.x + parent.layout.padding[3] : pb.y + parent.layout.padding[0];
        else if (idx < flow.length) {
          const b = worldBounds(doc, flow[idx]);
          at = (horiz ? b.x : b.y) - parent.layout.gap / 2;
        } else {
          const b = worldBounds(doc, flow[flow.length - 1]);
          at = (horiz ? b.x + b.width : b.y + b.height) + parent.layout.gap / 2;
        }
        ui.insertion = horiz
          ? { a: { x: at, y: pb.y + parent.layout.padding[0] }, b: { x: at, y: pb.y + pb.height - parent.layout.padding[2] } }
          : { a: { x: pb.x + parent.layout.padding[3], y: at }, b: { x: pb.x + pb.width - parent.layout.padding[1], y: at } };
        ui.dropTarget = null;
        return;
      }
      d0.insertIndex = null;
    }
  }
  const movable = d0.ids.every((id) => {
    const par = doc.nodes[doc.nodes[id]?.parentId];
    return !par || par.type === 'frame';
  });
  if (movable) {
    const exclude = new Set<ID>(d0.ids);
    const target = frameAt(doc, s.pageId, p.world, exclude) ?? s.pageId;
    const curParent = doc.nodes[d0.ids[0]].parentId;
    ui.dropTarget = target !== curParent ? target : null;
  }
}

function finishMove() {
  if (!drag || drag.kind !== 'move') return;
  const d0 = drag;
  const s = editor();
  if (d0.layoutChild) {
    const lc = d0.layoutChild;
    const idx = d0.insertIndex;
    s.mutate(
      (d) => {
        const n = d.nodes[lc];
        if (idx === null) {
          // dragged out of the auto-layout frame → becomes a free child of the page / frame below
          n.layoutPositioning = 'auto';
          const target = frameAt(d, s.pageId, ui.pointerWorld ?? { x: 0, y: 0 }, new Set([lc])) ?? s.pageId;
          if (target !== n.parentId) moveNodes(d, [lc], target);
          return;
        }
        n.layoutPositioning = 'auto';
        const arr = getChildrenArray(d, n.parentId)!;
        const flow = arr.filter((c) => c !== lc && d.nodes[c]?.visible && d.nodes[c]?.layoutPositioning === 'auto');
        const without = arr.filter((c) => c !== lc);
        const anchor = flow[idx];
        const pos = anchor ? without.indexOf(anchor) : without.length;
        without.splice(pos, 0, lc);
        arr.splice(0, arr.length, ...without);
      },
      { history: false },
    );
  } else if (ui.dropTarget && d0.moved) {
    const t = ui.dropTarget;
    s.mutate((d) => moveNodes(d, d0.ids, t), { history: false });
  }
  if (!d0.moved && !d0.layoutChild) {
    s.cancel();
  } else s.commit();
}

/* -------------------------------------------------------------- resizing */

function startResize(hx: number, hy: number) {
  const s = editor();
  const ids = s.selection.filter((id) => s.doc.nodes[id] && !s.doc.nodes[id].locked);
  const frame = selectionFrame(ids);
  if (!frame || !ids.length) return;
  s.begin('Resize');
  const base = editor().doc;
  let M0: Mat;
  let w0: number;
  let h0: number;
  if (frame.single) {
    const n = base.nodes[frame.single];
    M0 = worldMatrix(base, n.id);
    w0 = n.width;
    h0 = n.height;
  } else {
    const b = selectionBounds(base, ids)!;
    M0 = [1, 0, 0, 1, b.x, b.y];
    w0 = b.width;
    h0 = b.height;
  }
  const axisAligned = Math.abs(M0[1]) < 1e-9 && Math.abs(M0[2]) < 1e-9 && M0[0] > 0 && M0[3] > 0;
  drag = { kind: 'resize', hx, hy, base, ids, frame, M0, inv0: invert(M0), w0, h0, axisAligned, targets: snapTargets(base, s.pageId, ids) };
  ui.transforming = true;
}

function updateResize(p: PointerInfo) {
  if (!drag || drag.kind !== 'resize') return;
  const R = drag;
  const lp = apply(R.inv0, p.world);
  const { hx, hy, w0, h0 } = R;
  let x0 = 0;
  let x1 = w0;
  let y0 = 0;
  let y1 = h0;
  if (hx === 0) x0 = lp.x;
  else if (hx === 1) x1 = lp.x;
  if (hy === 0) y0 = lp.y;
  else if (hy === 1) y1 = lp.y;
  if (p.alt) {
    if (hx === 0) x1 = w0 - x0;
    else if (hx === 1) x0 = w0 - x1;
    if (hy === 0) y1 = h0 - y0;
    else if (hy === 1) y0 = h0 - y1;
  }
  // snapping of the moving edges (axis-aligned only)
  ui.snapLines = [];
  if (R.axisAligned && !p.mod) {
    const ox = R.M0[4];
    const oy = R.M0[5];
    const box = normRect({ x: x0 + ox, y: y0 + oy }, { x: x1 + ox, y: y1 + oy });
    const xs: ('min' | 'max')[] = hx === 0.5 ? [] : [(hx === 0) === x0 <= x1 ? 'min' : 'max'];
    const ys: ('min' | 'max')[] = hy === 0.5 ? [] : [(hy === 0) === y0 <= y1 ? 'min' : 'max'];
    const snap = snapBox(box, R.targets, getViewport().zoom, { x: xs, y: ys });
    ui.snapLines = snap.lines;
    if (hx === 0) x0 += snap.dx;
    else if (hx === 1) x1 += snap.dx;
    if (hy === 0) y0 += snap.dy;
    else if (hy === 1) y1 += snap.dy;
    if (useSettings.getState().snapToPixels) {
      if (!snap.dx) {
        if (hx === 0) x0 = Math.round(x0 + ox) - ox;
        else if (hx === 1) x1 = Math.round(x1 + ox) - ox;
      }
      if (!snap.dy) {
        if (hy === 0) y0 = Math.round(y0 + oy) - oy;
        else if (hy === 1) y1 = Math.round(y1 + oy) - oy;
      }
    }
  }
  let nw = x1 - x0;
  let nh = y1 - y0;
  if (p.shift && w0 > 0 && h0 > 0) {
    if (hx !== 0.5 && hy !== 0.5) {
      const s = Math.max(Math.abs(nw) / w0, Math.abs(nh) / h0);
      nw = (nw < 0 ? -1 : 1) * s * w0;
      nh = (nh < 0 ? -1 : 1) * s * h0;
    } else if (hx !== 0.5) {
      nh = (Math.abs(nw) / w0) * h0;
      y0 = h0 / 2 - nh / 2;
    } else {
      nw = (Math.abs(nh) / h0) * w0;
      x0 = w0 / 2 - nw / 2;
    }
    if (hx === 1) x1 = x0 + nw;
    else if (hx === 0) x0 = p.alt ? w0 / 2 - nw / 2 : x1 - nw;
    else x1 = x0 + nw;
    if (hy === 1) y1 = y0 + nh;
    else if (hy === 0) y0 = p.alt ? h0 / 2 - nh / 2 : y1 - nh;
    else y1 = y0 + nh;
    if (p.alt) {
      x0 = w0 / 2 - nw / 2;
      x1 = x0 + nw;
      y0 = h0 / 2 - nh / 2;
      y1 = y0 + nh;
    }
  }
  nw = x1 - x0;
  nh = y1 - y0;
  const aw = Math.max(0.01, Math.abs(nw));
  const ah = Math.max(0.01, Math.abs(nh));
  const lx = Math.min(x0, x1);
  const ly = Math.min(y0, y1);
  const flipX = nw < 0;
  const flipY = nh < 0;
  const s = editor();
  ui.label = { text: `${+aw.toFixed(2)} × ${+ah.toFixed(2)}`, at: p.screen };
  if (R.frame.single) {
    const id = R.frame.single;
    const center = apply(R.M0, { x: lx + aw / 2, y: ly + ah / 2 });
    s.mutate(
      (d) => {
        restoreSubtrees(d, R.base, [id]);
        const n = d.nodes[id];
        const pc = apply(invert(parentMatrix(d, id)), center);
        if (n.type === 'text') {
          if (hy === 0.5) n.autoResize = 'height';
          else n.autoResize = 'none';
        }
        if (n.type === 'frame' && n.layout) {
          if (hx !== 0.5) n.sizingH = 'fixed';
          if (hy !== 0.5) n.sizingV = 'fixed';
        }
        if (editor().tool === 'scale') {
          const k = Math.sqrt((aw / (w0 || 1)) * (ah / (h0 || 1)));
          scaleStyles(d, id, k);
          if (n.type === 'text') n.autoResize = 'none';
        }
        resizeContent(d, n, aw, ah);
        if (flipX) n.flipX = !n.flipX;
        if (flipY) n.flipY = !n.flipY;
        n.x = pc.x - n.width / 2;
        n.y = pc.y - n.height / 2;
      },
      { history: false },
    );
    return;
  }
  // multi-selection: map every node box through the frame scale
  const sx = nw / (w0 || 1);
  const sy = nh / (h0 || 1);
  const ox = R.M0[4];
  const oy = R.M0[5];
  const mapX = (x: number) => ox + x0 + (x - ox) * sx;
  const mapY = (y: number) => oy + y0 + (y - oy) * sy;
  s.mutate(
    (d) => {
      restoreSubtrees(d, R.base, R.ids);
      for (const id of R.ids) {
        const n = d.nodes[id];
        const wm = worldMatrix(R.base, id);
        const c = apply(wm, { x: n.width / 2, y: n.height / 2 });
        const nc = { x: mapX(c.x), y: mapY(c.y) };
        const r = (((n.rotation % 180) + 180) % 180) * (Math.PI / 180);
        const cos = Math.abs(Math.cos(r));
        const sin = Math.abs(Math.sin(r));
        const ksx = Math.sqrt((sx * cos) ** 2 + (sy * sin) ** 2);
        const ksy = Math.sqrt((sx * sin) ** 2 + (sy * cos) ** 2);
        if (n.type === 'text' && n.autoResize === 'width') n.autoResize = 'height';
        if (editor().tool === 'scale') {
          scaleStyles(d, id, Math.sqrt(Math.abs(sx * sy)));
          if (n.type === 'text') n.autoResize = 'none';
        }
        resizeContent(d, n, Math.max(0.01, n.width * ksx), Math.max(0.01, n.height * ksy));
        if (sx < 0) n.flipX = !n.flipX;
        if (sy < 0) n.flipY = !n.flipY;
        const pc = apply(invert(parentMatrix(d, id)), nc);
        n.x = pc.x - n.width / 2;
        n.y = pc.y - n.height / 2;
      }
    },
    { history: false },
  );
}

/* -------------------------------------------------------------- rotating */

function startRotate(p: PointerInfo) {
  const s = editor();
  const ids = s.selection.filter((id) => s.doc.nodes[id] && !s.doc.nodes[id].locked);
  const f = selectionFrame(ids);
  if (!f) return;
  s.begin('Rotate');
  const center = { x: (f.quad[0].x + f.quad[2].x) / 2, y: (f.quad[0].y + f.quad[2].y) / 2 };
  drag = {
    kind: 'rotate',
    center,
    start: Math.atan2(p.world.y - center.y, p.world.x - center.x),
    base: editor().doc,
    ids,
    startRot: f.single ? f.rotation : 0,
  };
  ui.transforming = true;
}

function updateRotate(p: PointerInfo) {
  if (!drag || drag.kind !== 'rotate') return;
  const R = drag;
  let delta = ((Math.atan2(p.world.y - R.center.y, p.world.x - R.center.x) - R.start) * 180) / Math.PI;
  if (p.shift) delta = snapAngle(R.startRot + delta, 15) - R.startRot;
  ui.label = { text: `${Math.round(normalizeAngle(R.startRot + delta))}°`, at: p.screen };
  setCursor(rotateCursor(((Math.atan2(p.world.y - R.center.y, p.world.x - R.center.x) * 180) / Math.PI) + 45));
  editor().mutate(
    (d) => {
      restoreSubtrees(d, R.base, R.ids);
      rotateNodes(d, R.ids, delta, R.center);
    },
    { history: false },
  );
}

/* --------------------------------------------------------------- marquee */

function updateMarquee(p: PointerInfo) {
  if (!drag || drag.kind !== 'marquee') return;
  const r = normRect(drag.start, p.world);
  ui.marquee = r;
  const doc = editor().doc;
  const hits = nodesInRect(doc, drag.scope, r, drag.scopeM);
  const next = p.shift ? [...new Set([...drag.base, ...hits])] : hits;
  editor().setSelection(next);
}

/* ------------------------------------------------------------------ tool */

function updateHover(p: PointerInfo) {
  const s = editor();
  const handle = hitHandles(p.screen);
  ui.hoverHandle = handle?.id ?? null;
  if (handle?.kind === 'resize') {
    const f = selectionFrame();
    setCursor(resizeCursor(handle.id, f?.rotation ?? 0));
    s.setHover(null);
    return;
  }
  if (handle?.kind === 'rotate') {
    const f = selectionFrame()!;
    const base: Record<string, number> = { nw: -45, ne: 45, se: 135, sw: 225 };
    setCursor(rotateCursor(base[handle.id] + f.rotation));
    s.setHover(null);
    return;
  }
  const label = frameLabelAt(p.screen);
  ui.frameLabelHover = label;
  if (label) {
    s.setHover(label);
    setCursor(p.alt ? CURSORS.duplicate : 'default');
    return;
  }
  const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
  const target = pickTarget(s.doc, chain, p.mod);
  s.setHover(target);
  setCursor(p.alt && target && s.selection.includes(target) ? CURSORS.duplicate : 'default');
}

export const selectTool: Tool = {
  id: 'move',
  cursor: 'default',

  down(p) {
    const s = editor();
    if (p.button !== 0) return;
    if (s.editing?.kind === 'path' && vectorEdit.down(p)) return;
    if (s.editing?.kind === 'gradient' && gradientEdit.down(p)) return;
    if (s.editing?.kind === 'gradient') s.setEditing(null);
    const handle = hitHandles(p.screen);
    if (handle?.kind === 'resize') {
      press = { p, intent: 'resize', handle: { hx: handle.hx, hy: handle.hy } };
      return;
    }
    if (handle?.kind === 'rotate') {
      press = { p, intent: 'rotate' };
      return;
    }
    const label = frameLabelAt(p.screen);
    if (label) {
      if (p.shift) s.toggleSelection(label);
      else if (!s.selection.includes(label)) s.setSelection([label]);
      press = { p, intent: 'move' };
      return;
    }
    const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
    const target = pickTarget(s.doc, chain, p.mod);
    if (target) {
      if (p.shift) {
        s.toggleSelection(target);
        if (editor().selection.includes(target)) press = { p, intent: 'move' };
        return;
      }
      if (!s.selection.includes(target)) s.setSelection([target]);
      press = { p, intent: 'move' };
      return;
    }
    // inside the current multi-selection bounds → drag the selection
    const sb = s.selection.length > 1 ? selectionBounds(s.doc, s.selection) : null;
    if (sb && pointInRect(p.world, sb) && !p.shift) {
      press = { p, intent: 'move' };
      return;
    }
    // marquee – scope is the top-level frame we started in (if its children are not selected)
    const frameId = topLevelFrameAt(s.doc, chain);
    let scope = s.doc.pages.find((pg) => pg.id === s.pageId)?.children ?? [];
    let scopeM: Mat = [1, 0, 0, 1, 0, 0];
    if (frameId && !s.selection.includes(frameId)) {
      scope = childrenOf(s.doc, frameId);
      scopeM = worldMatrix(s.doc, frameId);
    }
    if (!p.shift) s.setSelection([]);
    press = { p, intent: 'marquee', scope, scopeM };
  },

  move(p) {
    const s = editor();
    if (s.editing?.kind === 'path' && vectorEdit.move(p)) return;
    if (s.editing?.kind === 'gradient' && gradientEdit.move(p)) return;
    if (drag) {
      if (drag.kind === 'move') updateMove(p);
      else if (drag.kind === 'resize') updateResize(p);
      else if (drag.kind === 'rotate') updateRotate(p);
      else if (drag.kind === 'marquee') updateMarquee(p);
      requestOverlay();
      return;
    }
    if (press && p.buttons & 1) {
      const d = Math.hypot(p.screen.x - press.p.screen.x, p.screen.y - press.p.screen.y);
      if (d < 3) return;
      const origin = press.p.world;
      if (press.intent === 'move') startMove(p, origin);
      else if (press.intent === 'resize') startResize(press.handle!.hx, press.handle!.hy);
      else if (press.intent === 'rotate') startRotate(press.p);
      else if (press.intent === 'marquee') {
        drag = { kind: 'marquee', start: origin, base: [...editor().selection], scope: press.scope ?? [], scopeM: press.scopeM ?? [1, 0, 0, 1, 0, 0] };
      }
      press = null;
      this.move!(p);
      return;
    }
    updateHover(p);
  },

  up(p) {
    const s = editor();
    if (s.editing?.kind === 'path' && vectorEdit.up(p)) return;
    if (s.editing?.kind === 'gradient' && gradientEdit.up(p)) return;
    if (drag) {
      if (drag.kind === 'move') finishMove();
      else if (drag.kind === 'resize' || drag.kind === 'rotate') s.commit();
    } else if (press?.intent === 'move' && !p.shift && !p.alt) {
      // plain click on an already-selected node inside a multi-selection → select just it
      const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
      const target = pickTarget(s.doc, chain, p.mod);
      if (target && s.selection.length > 1 && s.selection.includes(target)) s.setSelection([target]);
    }
    drag = null;
    press = null;
    ui.dragging = false;
    ui.transforming = false;
    ui.marquee = null;
    ui.snapLines = [];
    ui.dropTarget = null;
    ui.insertion = null;
    ui.label = null;
    requestOverlay();
  },

  dblclick(p) {
    const s = editor();
    if (s.editing?.kind === 'path') {
      vectorEdit.dblclick(p);
      return;
    }
    const label = frameLabelAt(p.screen);
    if (label) {
      window.dispatchEvent(new CustomEvent('alt:rename', { detail: { id: label } }));
      return;
    }
    const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
    if (!chain.length) return;
    const cur = s.selection[0] ? s.doc.nodes[s.selection[0]] : null;
    // go one level deeper inside a selected container
    if (cur && isContainer(cur) && chain.includes(cur.id)) {
      const idx = chain.indexOf(cur.id);
      if (idx < chain.length - 1) {
        s.setSelection([chain[idx + 1]]);
        return;
      }
    }
    const target = pickTarget(s.doc, chain, p.mod) ?? chain[chain.length - 1];
    const n = s.doc.nodes[target];
    if (!n) return;
    enterNode(n);
  },

  key(e) {
    const s = editor();
    if (s.editing?.kind === 'path') return vectorEdit.key(e);
    if (s.editing?.kind === 'gradient' && e.key === 'Escape') {
      s.setEditing(null);
      return true;
    }
    return false;
  },

  overlay(ctx) {
    const s = editor();
    if (s.editing?.kind === 'path') vectorEdit.overlay(ctx);
    if (s.editing?.kind === 'gradient') gradientEdit.overlay(ctx);
  },

  cancel() {
    if (drag && drag.kind !== 'marquee') editor().cancel();
    drag = null;
    press = null;
    ui.dragging = false;
    ui.transforming = false;
    ui.marquee = null;
    ui.snapLines = [];
    ui.label = null;
  },
};

/** Enter a node: edit text, edit vector points, or dive into containers. */
export function enterNode(n: SceneNode) {
  const s = editor();
  if (n.locked) return;
  if (n.type === 'text') {
    s.setSelection([n.id]);
    s.setEditing({ kind: 'text', id: n.id });
    return;
  }
  if (n.type === 'path') {
    s.setSelection([n.id]);
    s.setEditing({ kind: 'path', id: n.id });
    return;
  }
  if (n.type === 'rect' || n.type === 'ellipse' || n.type === 'polygon' || n.type === 'star') {
    const id = s.mutate((d) => flattenNodes(d, [n.id]), { select: (r) => (r ? [r] : []) });
    if (id) s.setEditing({ kind: 'path', id });
    return;
  }
  if (isContainer(n) && n.children.length) {
    s.setSelection([n.children[n.children.length - 1]]);
  }
}

export function isDraggingSelection() {
  return !!drag;
}

export function selectionContainsPoint(p: Vec): boolean {
  const s = editor();
  const b = selectionBounds(s.doc, s.selection);
  return !!b && rectContains(b, { x: p.x, y: p.y, width: 0, height: 0 });
}
