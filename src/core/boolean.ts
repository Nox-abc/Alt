import paper from 'paper/dist/paper-core';
import type { BooleanOp, Doc, SceneNode, Vec } from './types';
import { cmdsToSvgD, parseSvgPath, transformCmds, type PathCmd } from './path';
import { nodeCmds } from './shapes';
import { localMatrix } from './geometry';
import { isContainer } from './doc';

let ready = false;
function ensure() {
  if (ready) return true;
  try {
    paper.setup(new paper.Size(1, 1));
    ready = true;
  } catch {
    ready = false;
  }
  return ready;
}

function toItem(cmds: PathCmd[]): paper.PathItem {
  return new paper.CompoundPath({ pathData: cmdsToSvgD(cmds, 4), insert: false, fillRule: 'nonzero' } as any);
}

const OPS: Record<BooleanOp, 'unite' | 'subtract' | 'intersect' | 'exclude'> = {
  union: 'unite',
  subtract: 'subtract',
  intersect: 'intersect',
  exclude: 'exclude',
};

/** Combine shapes (all already in the same coordinate space). */
export function combineCmds(op: BooleanOp, shapes: PathCmd[][]): PathCmd[] {
  const valid = shapes.filter((s) => s.length);
  if (!valid.length) return [];
  if (valid.length === 1 || !ensure()) return valid.flat();
  try {
    let acc = toItem(valid[0]);
    for (let i = 1; i < valid.length; i++) {
      const next = toItem(valid[i]);
      const res = (acc as any)[OPS[op]](next, { insert: false }) as paper.PathItem;
      acc.remove();
      next.remove();
      acc = res;
    }
    const d = (acc as any).pathData as string;
    acc.remove();
    return parseSvgPath(d);
  } catch (e) {
    console.warn('boolean op failed', e);
    return valid.flat();
  }
}

/** Geometry of any node in its own local space, including containers. */
export function geometryOf(doc: Doc, n: SceneNode): PathCmd[] {
  if (n.type === 'boolean') return booleanCmds(doc, n);
  if (n.type === 'group' || n.type === 'frame') {
    if (n.type === 'frame' && !n.children.length) return nodeCmds(n);
    const parts: PathCmd[] = [];
    for (const id of n.children) {
      const k = doc.nodes[id];
      if (!k || !k.visible) continue;
      parts.push(...transformCmds(geometryOf(doc, k), localMatrix(k)));
    }
    return parts;
  }
  return nodeCmds(n);
}

const cache = new Map<string, { sig: unknown[]; cmds: PathCmd[] }>();

function signature(doc: Doc, n: SceneNode, out: unknown[] = []): unknown[] {
  out.push(n);
  if (isContainer(n)) for (const id of n.children) {
    const k = doc.nodes[id];
    if (k) signature(doc, k, out);
  }
  return out;
}

function sameSig(a: unknown[], b: unknown[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Live boolean result for a boolean node, memoised on its subtree identity. */
export function booleanCmds(doc: Doc, n: Extract<SceneNode, { type: 'boolean' }>): PathCmd[] {
  const sig = signature(doc, n);
  const hit = cache.get(n.id);
  if (hit && sameSig(hit.sig, sig)) return hit.cmds;
  const shapes: PathCmd[][] = [];
  for (const id of n.children) {
    const k = doc.nodes[id];
    if (!k || !k.visible) continue;
    shapes.push(transformCmds(geometryOf(doc, k), localMatrix(k)));
  }
  const cmds = combineCmds(n.op, shapes);
  cache.set(n.id, { sig, cmds });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return cmds;
}

/** Fit a smooth bezier path through freehand points (pencil tool). */
export function simplifyPoints(points: Vec[], tolerance = 2.5, closed = false): PathCmd[] {
  if (points.length < 2) return [];
  if (!ensure()) {
    return [{ c: 'M', ...points[0] }, ...points.slice(1).map((p) => ({ c: 'L' as const, ...p }))];
  }
  const path = new paper.Path({ segments: points.map((p) => [p.x, p.y]), insert: false } as any);
  if (closed) path.closed = true;
  path.simplify(tolerance);
  const d = path.pathData;
  path.remove();
  return parseSvgPath(d);
}

/** Smooth an existing command list (Catmull-Rom-ish via paper). */
export function smoothCmds(cmds: PathCmd[]): PathCmd[] {
  if (!ensure()) return cmds;
  const item = toItem(cmds);
  (item as any).smooth({ type: 'continuous' });
  const d = (item as any).pathData;
  item.remove();
  return parseSvgPath(d);
}

/** Reverse the direction of the path. */
export function reverseCmds(cmds: PathCmd[]): PathCmd[] {
  if (!ensure()) return cmds;
  const item = toItem(cmds);
  (item as any).reverse();
  const d = (item as any).pathData;
  item.remove();
  return parseSvgPath(d);
}

/** Point-in-shape test using paper (used for lasso etc.). */
export function containsPoint(cmds: PathCmd[], p: Vec): boolean {
  if (!ensure()) return false;
  const item = toItem(cmds);
  const r = item.contains(new paper.Point(p.x, p.y));
  item.remove();
  return r;
}
