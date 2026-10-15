import type { Doc, FrameNode, ID, SceneNode } from './types';
import { apply, linearMatrix, localMatrix, mul, type Mat, translate } from './geometry';
import { isContainer, depthOf } from './doc';
import { measureTextBox } from './text';

const EPS = 1e-6;

/** Axis-aligned bounds of a node in its parent's coordinate space. */
export function boundsInParent(n: SceneNode) {
  const m = localMatrix(n);
  const pts = [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: n.width, y: 0 }),
    apply(m, { x: n.width, y: n.height }),
    apply(m, { x: 0, y: n.height }),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Groups & boolean nodes hug their children. Re-fit the container box and
 * compensate child positions so nothing moves on screen.
 */
export function normalizeContainer(d: Doc, id: ID) {
  const g = d.nodes[id];
  if (!g || (g.type !== 'group' && g.type !== 'boolean')) return;
  const kids = g.children.map((c) => d.nodes[c]).filter(Boolean) as SceneNode[];
  if (!kids.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const k of kids) {
    const b = boundsInParent(k);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  const w = Math.max(maxX - minX, 0.01);
  const h = Math.max(maxY - minY, 0.01);
  if (Math.abs(minX) < EPS && Math.abs(minY) < EPS && Math.abs(w - g.width) < EPS && Math.abs(h - g.height) < EPS) return;
  // new centre in parent space: c' = c + L·(min + half' − half)
  const L = linearMatrix(g);
  const off = apply(L, { x: minX + w / 2 - g.width / 2, y: minY + h / 2 - g.height / 2 });
  const cx = g.x + g.width / 2 + off.x;
  const cy = g.y + g.height / 2 + off.y;
  g.x = cx - w / 2;
  g.y = cy - h / 2;
  g.width = w;
  g.height = h;
  for (const k of kids) {
    k.x -= minX;
    k.y -= minY;
  }
}

/* ------------------------------------------------------------ auto layout */

function flowChildren(d: Doc, f: FrameNode): SceneNode[] {
  return f.children.map((c) => d.nodes[c]).filter((k): k is SceneNode => !!k && k.visible && k.layoutPositioning !== 'absolute');
}

/** Resize a child as a result of layout, re-flowing nested layouts / text. */
function setLayoutSize(d: Doc, n: SceneNode, w: number | null, h: number | null) {
  let changed = false;
  if (w !== null && Math.abs(n.width - w) > EPS) {
    n.width = Math.max(0.01, w);
    changed = true;
  }
  if (h !== null && Math.abs(n.height - h) > EPS) {
    n.height = Math.max(0.01, h);
    changed = true;
  }
  if (!changed) return;
  if (n.type === 'text' && w !== null && n.autoResize === 'width') {
    n.autoResize = 'height';
  }
  if (n.type === 'text' && n.autoResize === 'height') {
    n.height = measureTextBox(n).height;
  }
  if (n.type === 'frame' && n.layout) layoutFrame(d, n);
}

export function layoutFrame(d: Doc, f: FrameNode) {
  const L = f.layout;
  if (!L) return;
  const kids = flowChildren(d, f);
  const horiz = L.mode === 'horizontal';
  const [pt, pr, pb, pl] = L.padding;
  const mainOf = (n: SceneNode) => (horiz ? n.width : n.height);
  const crossOf = (n: SceneNode) => (horiz ? n.height : n.width);
  const mainSizing = (n: SceneNode) => (horiz ? n.sizingH : n.sizingV);
  const crossSizing = (n: SceneNode) => (horiz ? n.sizingV : n.sizingH);
  const frameMainHug = (horiz ? f.sizingH : f.sizingV) === 'hug';
  const frameCrossHug = (horiz ? f.sizingV : f.sizingH) === 'hug';
  const padMain = horiz ? pl + pr : pt + pb;
  const padCross = horiz ? pt + pb : pl + pr;

  // hug children that are text need their natural size first
  for (const k of kids) {
    if (k.type === 'text' && k.autoResize !== 'none') {
      const s = measureTextBox(k);
      k.width = s.width;
      k.height = s.height;
    }
  }

  // Wrapping (horizontal only, fixed width)
  const wrap = L.wrap && horiz && !frameMainHug;
  const innerMainFixed = (horiz ? f.width : f.height) - padMain;
  const rows: SceneNode[][] = [];
  if (wrap) {
    let row: SceneNode[] = [];
    let used = 0;
    for (const k of kids) {
      const s = mainOf(k);
      if (row.length && used + L.gap + s > innerMainFixed + EPS) {
        rows.push(row);
        row = [];
        used = 0;
      }
      used += (row.length ? L.gap : 0) + s;
      row.push(k);
    }
    if (row.length) rows.push(row);
  } else rows.push(kids);

  // main-axis size
  let innerMain = innerMainFixed;
  if (frameMainHug) {
    innerMain = 0;
    for (const row of rows) {
      const sum = row.reduce((a, k) => a + mainOf(k), 0) + L.gap * Math.max(0, row.length - 1);
      innerMain = Math.max(innerMain, sum);
    }
  }

  // fill children along the main axis (non-wrapping only)
  if (!wrap && !frameMainHug) {
    const fills = kids.filter((k) => mainSizing(k) === 'fill');
    if (fills.length) {
      const fixed = kids.filter((k) => mainSizing(k) !== 'fill').reduce((a, k) => a + mainOf(k), 0);
      const free = innerMain - fixed - L.gap * Math.max(0, kids.length - 1);
      const each = Math.max(1, free / fills.length);
      for (const k of fills) setLayoutSize(d, k, horiz ? each : null, horiz ? null : each);
    }
  }

  // cross-axis size
  const rowCross = rows.map((row) => row.reduce((m, k) => Math.max(m, crossSizing(k) === 'fill' ? 0 : crossOf(k)), 0));
  let innerCross = (horiz ? f.height : f.width) - padCross;
  if (frameCrossHug) innerCross = rowCross.reduce((a, b) => a + b, 0) + L.gap * Math.max(0, rows.length - 1);

  // stretch / fill on the cross axis
  if (!wrap) {
    for (const k of kids) {
      if (crossSizing(k) === 'fill' || L.align === 'stretch') {
        setLayoutSize(d, k, horiz ? null : innerCross, horiz ? innerCross : null);
      }
    }
  }

  // frame size
  if (frameMainHug) {
    if (horiz) f.width = Math.max(0.01, innerMain + padMain);
    else f.height = Math.max(0.01, innerMain + padMain);
  }
  if (frameCrossHug) {
    if (horiz) f.height = Math.max(0.01, innerCross + padCross);
    else f.width = Math.max(0.01, innerCross + padCross);
  }

  // positions
  let crossCursor = horiz ? pt : pl;
  rows.forEach((row, ri) => {
    const lineCross = wrap ? rowCross[ri] : innerCross;
    const total = row.reduce((a, k) => a + mainOf(k), 0);
    let gap = L.gap;
    let start = 0;
    const freeMain = innerMain - total - L.gap * Math.max(0, row.length - 1);
    if (L.justify === 'center') start = freeMain / 2;
    else if (L.justify === 'end') start = freeMain;
    else if (L.justify === 'space-between' && row.length > 1) gap = (innerMain - total) / (row.length - 1);
    let cursor = (horiz ? pl : pt) + start;
    for (const k of row) {
      let c = 0;
      const cs = crossOf(k);
      if (L.align === 'center') c = (lineCross - cs) / 2;
      else if (L.align === 'end') c = lineCross - cs;
      const mainPos = cursor;
      const crossPos = crossCursor + c;
      if (horiz) {
        k.x = mainPos;
        k.y = crossPos;
      } else {
        k.x = crossPos;
        k.y = mainPos;
      }
      cursor += mainOf(k) + gap;
    }
    crossCursor += lineCross + L.gap;
  });
}

/** Apply constraints to the children of a frame that changed size (non auto-layout frames). */
export function applyConstraints(d: Doc, f: FrameNode, oldW: number, oldH: number) {
  if (f.layout) return;
  const sx = oldW ? f.width / oldW : 1;
  const sy = oldH ? f.height / oldH : 1;
  const dw = f.width - oldW;
  const dh = f.height - oldH;
  for (const id of f.children) {
    const k = d.nodes[id];
    if (!k) continue;
    const { h, v } = k.constraints;
    let { x, y, width, height } = k;
    switch (h) {
      case 'right':
        x += dw;
        break;
      case 'center':
        x += dw / 2;
        break;
      case 'scale':
        x *= sx;
        width *= sx;
        break;
      case 'stretch':
        width += dw;
        break;
    }
    switch (v) {
      case 'bottom':
        y += dh;
        break;
      case 'center':
        y += dh / 2;
        break;
      case 'scale':
        y *= sy;
        height *= sy;
        break;
      case 'stretch':
        height += dh;
        break;
    }
    k.x = x;
    k.y = y;
    if (width !== k.width || height !== k.height) {
      resizeContent(d, k, Math.max(0.01, width), Math.max(0.01, height));
    }
  }
}

/**
 * Change a node's size, scaling its intrinsic geometry (vector points, group
 * children) as needed. Position is untouched.
 */
export function resizeContent(d: Doc, n: SceneNode, w: number, h: number) {
  const ow = n.width;
  const oh = n.height;
  if (Math.abs(ow - w) < EPS && Math.abs(oh - h) < EPS) return;
  const sx = ow ? w / ow : 1;
  const sy = oh ? h / oh : 1;
  n.width = w;
  n.height = h;
  switch (n.type) {
    case 'path':
      for (const sp of n.paths)
        for (const p of sp.points) {
          p.x *= sx;
          p.y *= sy;
          if (p.in) {
            p.in.x *= sx;
            p.in.y *= sy;
          }
          if (p.out) {
            p.out.x *= sx;
            p.out.y *= sy;
          }
        }
      break;
    case 'brush':
      for (const p of n.points) {
        p.x *= sx;
        p.y *= sy;
      }
      break;
    case 'group':
    case 'boolean':
      for (const id of n.children) {
        const k = d.nodes[id];
        if (!k) continue;
        // scale centre position, keep rotation, scale size along own axes
        const cx = (k.x + k.width / 2) * sx;
        const cy = (k.y + k.height / 2) * sy;
        const r = (k.rotation * Math.PI) / 180;
        const c = Math.abs(Math.cos(r));
        const s = Math.abs(Math.sin(r));
        // project the scale onto the child's axes
        const ksx = Math.sqrt((sx * c) ** 2 + (sy * s) ** 2);
        const ksy = Math.sqrt((sx * s) ** 2 + (sy * c) ** 2);
        const nw = Math.max(0.01, k.width * ksx);
        const nh = Math.max(0.01, k.height * ksy);
        resizeContent(d, k, nw, nh);
        k.x = cx - nw / 2;
        k.y = cy - nh / 2;
      }
      break;
    case 'frame':
      if (n.layout) layoutFrame(d, n);
      else applyConstraints(d, n, ow, oh);
      break;
    case 'text':
      if (n.autoResize === 'width') n.autoResize = 'height';
      if (n.autoResize === 'height') n.height = measureTextBox(n).height;
      break;
  }
}

/**
 * Post-mutation fix-ups: re-fit groups / booleans and re-run auto layout for
 * every container touched by the change, deepest first.
 */
export function finalize(d: Doc, changed: Iterable<ID>) {
  const targets = new Set<ID>();
  for (const id of changed) {
    let cur: SceneNode | undefined = d.nodes[id];
    if (cur && isContainer(cur)) targets.add(cur.id);
    let guard = 0;
    while (cur && guard++ < 500) {
      const p: SceneNode | undefined = d.nodes[cur.parentId];
      if (!p) break;
      targets.add(p.id);
      cur = p;
    }
  }
  const ordered = [...targets].filter((id) => d.nodes[id]).sort((a, b) => depthOf(d, b) - depthOf(d, a));
  for (const id of ordered) {
    const n = d.nodes[id];
    if (!n) continue;
    if (n.type === 'group' || n.type === 'boolean') {
      if (n.children.length === 0) continue;
      normalizeContainer(d, id);
    } else if (n.type === 'frame' && n.layout) layoutFrame(d, n);
  }
}

/** Convert a delta in page space into a delta in the node's parent space. */
export function pageDeltaToParent(parentWorld: Mat, dx: number, dy: number) {
  const inv = invertLinear(parentWorld);
  return apply(inv, { x: dx, y: dy });
}

function invertLinear(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0];
}

export { mul, translate };
