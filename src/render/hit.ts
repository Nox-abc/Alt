import type { Doc, ID, Rect, SceneNode, Vec } from '../core/types';
import { apply, invert, localMatrix, mul, rectsIntersect, transformRect, IDENTITY, type Mat } from '../core/geometry';
import { layoutText } from '../core/text';
import { nodePath } from './renderer';
import { makeCanvas, type Ctx2D } from './paint';

let hctx: Ctx2D | null = null;
function ctx(): Ctx2D {
  if (!hctx) hctx = makeCanvas(1, 1).getContext('2d') as Ctx2D;
  return hctx;
}

function hitLeaf(doc: Doc, n: SceneNode, p: Vec, tol: number): boolean {
  if (n.type === 'text') {
    const l = layoutText(n);
    const w = Math.max(n.width, l.contentWidth);
    const h = Math.max(n.height, l.contentHeight);
    return p.x >= -tol && p.y >= -tol && p.x <= w + tol && p.y <= h + tol;
  }
  if (n.type === 'bitmap') return p.x >= 0 && p.y >= 0 && p.x <= n.width && p.y <= n.height;
  const path = nodePath(doc, n);
  const c = ctx();
  c.setTransform(1, 0, 0, 1, 0, 0);
  const fills = n.fills.some((f) => f.visible);
  const strokes = n.strokes.some((f) => f.visible) && n.strokeWidth > 0;
  const rule: CanvasFillRule = n.type === 'path' ? n.fillRule : n.type === 'boolean' ? 'evenodd' : 'nonzero';
  const isOpenPath = n.type === 'path' && n.paths.some((sp) => !sp.closed);
  if ((fills || (!strokes && !isOpenPath)) && c.isPointInPath(path, p.x, p.y, rule)) return true;
  if (strokes || isOpenPath) {
    c.lineWidth = Math.max(n.strokeWidth * (n.strokeAlign === 'center' ? 1 : 2), tol * 2);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    if (c.isPointInStroke(path, p.x, p.y)) return true;
  }
  return false;
}

/**
 * Hit test a page. Returns the chain of node ids from the top-level node down
 * to the deepest node under the point (empty when nothing is hit).
 */
export function hitTest(doc: Doc, pageId: ID, world: Vec, zoom: number, opts: { includeLocked?: boolean } = {}): ID[] {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return [];
  const tol = 4 / zoom;
  const visit = (ids: ID[], parentM: Mat): ID[] | null => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = doc.nodes[ids[i]];
      if (!n || !n.visible) continue;
      if (n.locked && !opts.includeLocked) continue;
      const m = mul(parentM, localMatrix(n));
      const lp = apply(invert(m), world);
      // local tolerance (scale is 1 – only rotation/flip in local matrices)
      if (n.type === 'frame') {
        const inside = lp.x >= 0 && lp.y >= 0 && lp.x <= n.width && lp.y <= n.height;
        if (inside || !n.clipContent) {
          const sub = visit(n.children, m);
          if (sub) return [n.id, ...sub];
        }
        if (inside) return [n.id];
        continue;
      }
      if (n.type === 'group') {
        const sub = visit(n.children, m);
        if (sub) return [n.id, ...sub];
        continue;
      }
      if (n.type === 'boolean') {
        if (hitLeaf(doc, n, lp, tol)) {
          const sub = visit(n.children, m);
          return sub ? [n.id, ...sub] : [n.id];
        }
        continue;
      }
      if (hitLeaf(doc, n, lp, tol)) return [n.id];
    }
    return null;
  };
  return visit(page.children, [...IDENTITY]) ?? [];
}

/** Nodes among `scopeIds` whose world bounds intersect the rect. */
export function nodesInRect(doc: Doc, scopeIds: ID[], r: Rect, parentM: Mat = [...IDENTITY]): ID[] {
  const out: ID[] = [];
  for (const id of scopeIds) {
    const n = doc.nodes[id];
    if (!n || !n.visible || n.locked) continue;
    const m = mul(parentM, localMatrix(n));
    const b = transformRect(m, { x: 0, y: 0, width: n.width, height: n.height });
    if (rectsIntersect(b, r)) {
      // precise check for rotated nodes: test rect corners & centre against the quad
      out.push(id);
    }
  }
  return out;
}
