/**
 * Document operations. Every function mutates an (immer) draft of the Doc.
 * They are shared by the UI, keyboard shortcuts, the scripting API and MCP.
 */
import type { Asset, BooleanOp, Doc, FrameNode, ID, PathNode, Rect, SceneNode, Vec } from './types';
import {
  apply,
  applyLinear,
  invert,
  localMatrix,
  mul,
  normalizeAngle,
  parentMatrix,
  placementFromMatrix,
  selectionBounds,
  translate,
  worldBounds,
  worldMatrix,
  type Mat,
  IDENTITY,
  linearMatrix,
} from './geometry';
import { childrenOf, createNode, isContainer, sortByZ, topLevelOnly, uid, uniqueName, descendants } from './doc';
import { resizeContent } from './layout';
import { measureTextBox } from './text';
import { geometryOf } from './boolean';
import { cmdsBounds, cmdsToSubPaths, subPathsToCmds, transformCmds } from './path';
import { brushCmds } from './shapes';

export function getChildrenArray(d: Doc, parentId: ID): ID[] | null {
  const n = d.nodes[parentId];
  if (n) return isContainer(n) ? n.children : null;
  return d.pages.find((p) => p.id === parentId)?.children ?? null;
}

/** Matrix of a container (or identity for a page) – maps container-local → page. */
export function containerMatrix(d: Doc, parentId: ID): Mat {
  return d.nodes[parentId] ? worldMatrix(d, parentId) : [...IDENTITY];
}

export function insertNode(d: Doc, node: SceneNode, parentId: ID, index?: number): ID {
  const arr = getChildrenArray(d, parentId);
  if (!arr) throw new Error(`Cannot insert into ${parentId}`);
  node.parentId = parentId;
  d.nodes[node.id] = node;
  if (index === undefined || index < 0 || index > arr.length) arr.push(node.id);
  else arr.splice(index, 0, node.id);
  return node.id;
}

function detach(d: Doc, id: ID) {
  const n = d.nodes[id];
  if (!n) return;
  const arr = getChildrenArray(d, n.parentId);
  if (arr) {
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
  }
}

export function deleteNodes(d: Doc, ids: ID[]) {
  const parents = new Set<ID>();
  for (const id of ids) {
    const n = d.nodes[id];
    if (!n) continue;
    parents.add(n.parentId);
    detach(d, id);
    for (const c of descendants(d, id)) delete d.nodes[c];
    delete d.nodes[id];
  }
  // remove groups that became empty
  for (const pid of parents) {
    const p = d.nodes[pid];
    if (p && (p.type === 'group' || p.type === 'boolean') && p.children.length === 0) deleteNodes(d, [pid]);
  }
}

/** Move nodes into another container, preserving their on-screen transform. */
export function moveNodes(d: Doc, ids: ID[], newParentId: ID, index?: number) {
  const target = getChildrenArray(d, newParentId);
  if (!target) return;
  let insertAt = index;
  for (const id of sortByZ(d, topLevelOnly(d, ids))) {
    const n = d.nodes[id];
    if (!n || id === newParentId) continue;
    // never move a node into its own subtree
    let cur: SceneNode | undefined = d.nodes[newParentId];
    let cyclic = false;
    while (cur) {
      if (cur.id === id) cyclic = true;
      cur = d.nodes[cur.parentId];
    }
    if (cyclic) continue;
    const world = worldMatrix(d, id);
    const oldArr = getChildrenArray(d, n.parentId);
    const oldIndex = oldArr ? oldArr.indexOf(id) : -1;
    const sameParent = n.parentId === newParentId;
    detach(d, id);
    if (sameParent && insertAt !== undefined && oldIndex >= 0 && oldIndex < insertAt) insertAt--;
    const local = mul(invert(containerMatrix(d, newParentId)), world);
    const pl = placementFromMatrix(local, n.width, n.height);
    n.x = pl.x;
    n.y = pl.y;
    n.rotation = pl.rotation;
    n.flipX = pl.flipX;
    n.flipY = pl.flipY;
    n.parentId = newParentId;
    if (insertAt === undefined || insertAt > target.length) target.push(id);
    else {
      target.splice(Math.max(0, insertAt), 0, id);
      insertAt++;
    }
  }
}

const TEXT_METRIC_KEYS = new Set([
  'text',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'italic',
  'lineHeight',
  'letterSpacing',
  'paragraphSpacing',
  'textCase',
  'autoResize',
]);

/** Generic property update with type-aware side effects. */
export function setProps(d: Doc, id: ID, props: Partial<SceneNode>) {
  const n = d.nodes[id] as any;
  if (!n) return;
  const { width, height, id: _id, type: _type, parentId: _p, children: _c, ...rest } = props as any;
  for (const k of Object.keys(rest)) {
    const v = rest[k];
    if (v === undefined) continue;
    n[k] = v;
  }
  if (typeof rest.rotation === 'number') n.rotation = normalizeAngle(rest.rotation);
  if (width !== undefined || height !== undefined) {
    const w = Math.max(0.01, width ?? n.width);
    const h = Math.max(0.01, height ?? n.height);
    if (n.type === 'text' && width !== undefined && n.autoResize === 'width') n.autoResize = 'height';
    if (n.type === 'text' && height !== undefined) n.autoResize = 'none';
    resizeContent(d, n, w, h);
    if (n.type === 'frame') {
      if (width !== undefined && n.sizingH === 'hug') n.sizingH = 'fixed';
      if (height !== undefined && n.sizingV === 'hug') n.sizingV = 'fixed';
    }
  }
  if (n.type === 'text') {
    if (rest.sizingH === 'hug') n.autoResize = 'width';
    if (Object.keys(rest).some((k) => TEXT_METRIC_KEYS.has(k)) || width !== undefined) fitText(d, id);
  }
}

export function fitText(d: Doc, id: ID) {
  const n = d.nodes[id];
  if (!n || n.type !== 'text') return;
  const s = measureTextBox(n);
  if (n.autoResize === 'width') {
    // keep alignment anchor when auto width grows
    const dw = s.width - n.width;
    if (n.textAlign === 'center') n.x -= dw / 2;
    else if (n.textAlign === 'right') n.x -= dw;
    n.width = s.width;
    n.height = s.height;
  } else if (n.autoResize === 'height') n.height = s.height;
}

/** Translate nodes by a page-space delta. */
export function translateNodes(d: Doc, ids: ID[], dx: number, dy: number) {
  for (const id of topLevelOnly(d, ids)) {
    const n = d.nodes[id];
    if (!n) continue;
    const pm = parentMatrix(d, id);
    const inv = invert([pm[0], pm[1], pm[2], pm[3], 0, 0]);
    const delta = applyLinear(inv, { x: dx, y: dy });
    n.x += delta.x;
    n.y += delta.y;
  }
}

/** Place a node so that its axis-aligned page-space box equals `r` (rotation is kept). */
export function setWorldRect(d: Doc, id: ID, r: Rect) {
  const n = d.nodes[id];
  if (!n) return;
  const pm = parentMatrix(d, id);
  const inv = invert(pm);
  const c = apply(inv, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  resizeContent(d, n, Math.max(0.01, r.width), Math.max(0.01, r.height));
  n.x = c.x - n.width / 2;
  n.y = c.y - n.height / 2;
}

export function setWorldPosition(d: Doc, id: ID, p: Vec) {
  const b = worldBounds(d, id);
  translateNodes(d, [id], p.x - b.x, p.y - b.y);
}

/* ------------------------------------------------------------- grouping */

export function groupNodes(d: Doc, ids: ID[], kind: 'group' | 'boolean' | 'frame' = 'group', op: BooleanOp = 'union'): ID | null {
  const list = sortByZ(d, topLevelOnly(d, ids)).filter((id) => d.nodes[id]);
  if (!list.length) return null;
  const top = d.nodes[list[list.length - 1]];
  const parentId = top.parentId;
  const siblings = getChildrenArray(d, parentId)!;
  const set = new Set(list);
  const idx = siblings.indexOf(top.id);
  const removedBefore = siblings.slice(0, idx).filter((s) => set.has(s)).length;
  const insertAt = idx - removedBefore;
  // bounds in parent space
  const pInv = invert(containerMatrix(d, parentId));
  const pts: Vec[] = [];
  for (const id of list) {
    const n = d.nodes[id];
    const m = mul(pInv, worldMatrix(d, id));
    pts.push(
      apply(m, { x: 0, y: 0 }),
      apply(m, { x: n.width, y: 0 }),
      apply(m, { x: n.width, y: n.height }),
      apply(m, { x: 0, y: n.height }),
    );
  }
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x));
  const maxY = Math.max(...pts.map((p) => p.y));
  const bottom = d.nodes[list[0]];
  let g: SceneNode;
  if (kind === 'boolean') {
    g = createNode('boolean', {
      parentId,
      op,
      name: op[0].toUpperCase() + op.slice(1),
      fills: structuredCloneSafe(bottom.fills),
      strokes: structuredCloneSafe(bottom.strokes),
      strokeWidth: bottom.strokeWidth,
    });
  } else if (kind === 'frame') {
    g = createNode('frame', { parentId, fills: [], name: uniqueName(d, parentId, 'Frame'), clipContent: false });
  } else g = createNode('group', { parentId, name: uniqueName(d, parentId, 'Group') });
  g.x = minX;
  g.y = minY;
  g.width = Math.max(0.01, maxX - minX);
  g.height = Math.max(0.01, maxY - minY);
  const worlds = new Map(list.map((id) => [id, worldMatrix(d, id)] as const));
  const oldParents = new Set(list.map((id) => d.nodes[id].parentId));
  for (const id of list) detach(d, id);
  insertNode(d, g, parentId, insertAt);
  const gInv = invert(worldMatrix(d, g.id));
  for (const id of list) {
    const n = d.nodes[id];
    const local = mul(gInv, worlds.get(id)!);
    const pl = placementFromMatrix(local, n.width, n.height);
    n.x = pl.x;
    n.y = pl.y;
    n.rotation = pl.rotation;
    n.flipX = pl.flipX;
    n.flipY = pl.flipY;
    n.parentId = g.id;
    (g as any).children.push(id);
  }
  for (const pid of oldParents) {
    const op = d.nodes[pid];
    if (op && (op.type === 'group' || op.type === 'boolean') && op.children.length === 0) deleteNodes(d, [pid]);
  }
  return g.id;
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function ungroupNodes(d: Doc, ids: ID[]): ID[] {
  const out: ID[] = [];
  for (const id of ids) {
    const g = d.nodes[id];
    if (!g || !isContainer(g)) continue;
    const parentId = g.parentId;
    const arr = getChildrenArray(d, parentId)!;
    const idx = arr.indexOf(id);
    const kids = [...g.children];
    moveNodes(d, kids, parentId, idx + 1);
    // groups' own opacity / effects are dropped like in most editors
    deleteNodes(d, [id]);
    out.push(...kids);
  }
  return out;
}

/* ------------------------------------------------------------ duplicate */

export function cloneSubtree(doc: Doc, id: ID, idMap: Map<ID, ID> = new Map()): SceneNode[] {
  const n = doc.nodes[id];
  if (!n) return [];
  const copy = structuredCloneSafe(n) as SceneNode;
  const newId = uid();
  idMap.set(id, newId);
  copy.id = newId;
  const out = [copy];
  if (isContainer(copy)) {
    const kids: ID[] = [];
    for (const c of (n as any).children as ID[]) {
      const sub = cloneSubtree(doc, c, idMap);
      if (sub.length) {
        sub[0].parentId = newId;
        kids.push(sub[0].id);
        out.push(...sub);
      }
    }
    (copy as any).children = kids;
  }
  return out;
}

export function duplicateNodes(d: Doc, ids: ID[], offset: Vec = { x: 0, y: 0 }): ID[] {
  const out: ID[] = [];
  for (const id of sortByZ(d, topLevelOnly(d, ids))) {
    const n = d.nodes[id];
    if (!n) continue;
    const nodes = cloneSubtree(d, id);
    const arr = getChildrenArray(d, n.parentId)!;
    const idx = arr.indexOf(id);
    const root = nodes[0];
    for (const k of nodes.slice(1)) d.nodes[k.id] = k;
    insertNode(d, root, n.parentId, idx + 1);
    if (offset.x || offset.y) translateNodes(d, [root.id], offset.x, offset.y);
    out.push(root.id);
  }
  return out;
}

/* ---------------------------------------------------------------- z-order */

export function reorderNodes(d: Doc, ids: ID[], where: 'front' | 'back' | 'forward' | 'backward') {
  const byParent = new Map<ID, ID[]>();
  for (const id of ids) {
    const n = d.nodes[id];
    if (!n) continue;
    byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), id]);
  }
  for (const [pid, sel] of byParent) {
    const arr = getChildrenArray(d, pid)!;
    const set = new Set(sel);
    if (where === 'front' || where === 'back') {
      const rest = arr.filter((x) => !set.has(x));
      const moving = arr.filter((x) => set.has(x));
      const next = where === 'front' ? [...rest, ...moving] : [...moving, ...rest];
      arr.splice(0, arr.length, ...next);
    } else if (where === 'forward') {
      for (let i = arr.length - 2; i >= 0; i--) {
        if (set.has(arr[i]) && !set.has(arr[i + 1])) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      }
    } else {
      for (let i = 1; i < arr.length; i++) {
        if (set.has(arr[i]) && !set.has(arr[i - 1])) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
      }
    }
  }
}

/* --------------------------------------------------------- align / distribute */

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignNodes(d: Doc, ids: ID[], mode: AlignMode) {
  const list = topLevelOnly(d, ids).filter((id) => d.nodes[id]);
  if (!list.length) return;
  let target: Rect | null;
  if (list.length === 1) {
    const p = d.nodes[d.nodes[list[0]].parentId];
    if (!p) return;
    target = worldBounds(d, p.id);
  } else target = selectionBounds(d, list);
  if (!target) return;
  for (const id of list) {
    const b = worldBounds(d, id);
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case 'left':
        dx = target.x - b.x;
        break;
      case 'hcenter':
        dx = target.x + target.width / 2 - (b.x + b.width / 2);
        break;
      case 'right':
        dx = target.x + target.width - (b.x + b.width);
        break;
      case 'top':
        dy = target.y - b.y;
        break;
      case 'vcenter':
        dy = target.y + target.height / 2 - (b.y + b.height / 2);
        break;
      case 'bottom':
        dy = target.y + target.height - (b.y + b.height);
        break;
    }
    translateNodes(d, [id], dx, dy);
  }
}

export function distributeNodes(d: Doc, ids: ID[], axis: 'h' | 'v') {
  const list = topLevelOnly(d, ids).filter((id) => d.nodes[id]);
  if (list.length < 3) return;
  const items = list.map((id) => ({ id, b: worldBounds(d, id) }));
  const key = axis === 'h' ? 'x' : 'y';
  const size = axis === 'h' ? 'width' : 'height';
  items.sort((a, b) => a.b[key] - b.b[key]);
  const first = items[0].b;
  const last = items[items.length - 1].b;
  const span = last[key] + last[size] - first[key];
  const total = items.reduce((a, it) => a + it.b[size], 0);
  const gap = (span - total) / (items.length - 1);
  let cursor = first[key] + first[size] + gap;
  for (let i = 1; i < items.length - 1; i++) {
    const it = items[i];
    const delta = cursor - it.b[key];
    translateNodes(d, [it.id], axis === 'h' ? delta : 0, axis === 'h' ? 0 : delta);
    cursor += it.b[size] + gap;
  }
}

/** Arrange nodes in a tidy grid keeping their order. */
export function tidyNodes(d: Doc, ids: ID[], gap = 24) {
  const list = topLevelOnly(d, ids).filter((id) => d.nodes[id]);
  if (list.length < 2) return;
  const items = list.map((id) => ({ id, b: worldBounds(d, id) }));
  const bounds = selectionBounds(d, list)!;
  items.sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x);
  const cols = Math.ceil(Math.sqrt(items.length));
  const cellW = Math.max(...items.map((i) => i.b.width));
  const cellH = Math.max(...items.map((i) => i.b.height));
  items.forEach((it, i) => {
    const cx = bounds.x + (i % cols) * (cellW + gap);
    const cy = bounds.y + Math.floor(i / cols) * (cellH + gap);
    translateNodes(d, [it.id], cx - it.b.x, cy - it.b.y);
  });
}

/* -------------------------------------------------------- rotate / flip */

export function rotateNodes(d: Doc, ids: ID[], deg: number, center?: Vec) {
  const list = topLevelOnly(d, ids).filter((id) => d.nodes[id]);
  const c = center ?? (() => {
    const b = selectionBounds(d, list);
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 };
  })();
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  for (const id of list) {
    const n = d.nodes[id];
    const wm = worldMatrix(d, id);
    const wc = apply(wm, { x: n.width / 2, y: n.height / 2 });
    const rx = c.x + (wc.x - c.x) * cos - (wc.y - c.y) * sin;
    const ry = c.y + (wc.x - c.x) * sin + (wc.y - c.y) * cos;
    const pm = parentMatrix(d, id);
    const det = pm[0] * pm[3] - pm[1] * pm[2];
    const local = apply(invert(pm), { x: rx, y: ry });
    n.rotation = normalizeAngle(n.rotation + (det < 0 ? -deg : deg));
    n.x = local.x - n.width / 2;
    n.y = local.y - n.height / 2;
  }
}

export function flipNodes(d: Doc, ids: ID[], axis: 'h' | 'v') {
  const list = topLevelOnly(d, ids).filter((id) => d.nodes[id]);
  const b = selectionBounds(d, list);
  if (!b) return;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  for (const id of list) {
    const n = d.nodes[id];
    const wb = worldBounds(d, id);
    if (axis === 'h') n.flipX = !n.flipX;
    else n.flipY = !n.flipY;
    n.rotation = normalizeAngle(-n.rotation);
    if (list.length > 1) {
      const nc = axis === 'h' ? { x: 2 * cx - (wb.x + wb.width / 2), y: wb.y + wb.height / 2 } : { x: wb.x + wb.width / 2, y: 2 * cy - (wb.y + wb.height / 2) };
      const cur = worldBounds(d, id);
      translateNodes(d, [id], nc.x - (cur.x + cur.width / 2), nc.y - (cur.y + cur.height / 2));
    }
  }
}

/* --------------------------------------------------------------- flatten */

export function flattenNodes(d: Doc, ids: ID[]): ID | null {
  const list = sortByZ(d, topLevelOnly(d, ids)).filter((id) => d.nodes[id] && d.nodes[id].type !== 'text');
  if (!list.length) return null;
  const top = d.nodes[list[list.length - 1]];
  const parentId = top.parentId;
  const arr = getChildrenArray(d, parentId)!;
  const insertAt = arr.indexOf(top.id);
  let node: PathNode;
  if (list.length === 1) {
    const n = top;
    const cmds = geometryOf(d, n);
    node = createNode('path', {
      parentId,
      name: n.name,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      rotation: n.rotation,
      flipX: n.flipX,
      flipY: n.flipY,
      opacity: n.opacity,
      blendMode: n.blendMode,
      fills: structuredCloneSafe(n.fills),
      strokes: structuredCloneSafe(n.strokes),
      strokeWidth: n.strokeWidth,
      strokeAlign: n.strokeAlign,
      effects: structuredCloneSafe(n.effects),
      paths: cmdsToSubPaths(cmds),
      fillRule: n.type === 'path' ? n.fillRule : 'nonzero',
    });
    if (n.type === 'brush' && !node.fills.length) node.fills = [];
  } else {
    const pInv = invert(containerMatrix(d, parentId));
    const all = list.flatMap((id) => transformCmds(geometryOf(d, d.nodes[id]), mul(pInv, worldMatrix(d, id))));
    const b = cmdsBounds(all) ?? { x: 0, y: 0, width: 1, height: 1 };
    const local = transformCmds(all, translate(-b.x, -b.y));
    node = createNode('path', {
      parentId,
      x: b.x,
      y: b.y,
      width: Math.max(0.01, b.width),
      height: Math.max(0.01, b.height),
      fills: structuredCloneSafe(top.fills),
      strokes: structuredCloneSafe(top.strokes),
      strokeWidth: top.strokeWidth,
      paths: cmdsToSubPaths(local),
    });
  }
  deleteNodes(d, list);
  const arr2 = getChildrenArray(d, parentId);
  if (!arr2) {
    // parent got removed (empty group) – fall back to page
    return null;
  }
  insertNode(d, node, parentId, Math.min(insertAt, arr2.length));
  return node.id;
}

/* --------------------------------------------------------------- pages */

export function addPage(d: Doc, name?: string): ID {
  const id = 'page_' + uid();
  d.pages.push({ id, name: name ?? `Page ${d.pages.length + 1}`, children: [], background: '', guides: [] });
  return id;
}

export function deletePage(d: Doc, pageId: ID) {
  if (d.pages.length <= 1) return;
  const p = d.pages.find((x) => x.id === pageId);
  if (!p) return;
  deleteNodes(d, [...p.children]);
  d.pages = d.pages.filter((x) => x.id !== pageId);
}

export function duplicatePage(d: Doc, pageId: ID): ID | null {
  const p = d.pages.find((x) => x.id === pageId);
  if (!p) return null;
  const id = 'page_' + uid();
  const page = { ...structuredCloneSafe(p), id, name: p.name + ' copy', children: [] as ID[] };
  d.pages.splice(d.pages.indexOf(p) + 1, 0, page);
  for (const cid of p.children) {
    const nodes = cloneSubtree(d, cid);
    if (!nodes.length) continue;
    for (const k of nodes.slice(1)) d.nodes[k.id] = k;
    nodes[0].parentId = id;
    d.nodes[nodes[0].id] = nodes[0];
    d.pages.find((x) => x.id === id)!.children.push(nodes[0].id);
  }
  return id;
}

/* -------------------------------------------------------------- clipboard */

export interface ClipboardData {
  app: 'alt';
  version: 1;
  roots: { id: ID; world: Mat }[];
  nodes: SceneNode[];
  assets: Record<ID, Asset>;
}

export function serializeNodes(doc: Doc, ids: ID[]): ClipboardData {
  const roots = sortByZ(doc, topLevelOnly(doc, ids)).filter((id) => doc.nodes[id]);
  const nodes: SceneNode[] = [];
  const assets: Record<ID, Asset> = {};
  const seen = new Set<ID>();
  const collect = (id: ID) => {
    const n = doc.nodes[id];
    if (!n || seen.has(id)) return;
    seen.add(id);
    nodes.push(structuredCloneSafe(n));
    for (const p of [...n.fills, ...n.strokes]) if (p.type === 'image' && doc.assets[p.assetId]) assets[p.assetId] = doc.assets[p.assetId];
    if (n.type === 'bitmap' && doc.assets[n.assetId]) assets[n.assetId] = doc.assets[n.assetId];
    if (isContainer(n)) n.children.forEach(collect);
  };
  roots.forEach(collect);
  return { app: 'alt', version: 1, roots: roots.map((id) => ({ id, world: worldMatrix(doc, id) })), nodes, assets };
}

/** Insert clipboard data. Returns the new root ids. */
export function pasteNodes(d: Doc, data: ClipboardData, parentId: ID, opts: { index?: number; offset?: Vec; at?: Vec } = {}): ID[] {
  const idMap = new Map<ID, ID>();
  for (const n of data.nodes) idMap.set(n.id, uid());
  for (const [id, a] of Object.entries(data.assets ?? {})) if (!d.assets[id]) d.assets[id] = a;
  const byOld = new Map(data.nodes.map((n) => [n.id, n]));
  const out: ID[] = [];
  const parentInv = invert(containerMatrix(d, parentId));
  // compute an offset that moves the pasted group so its centre lands at `at`
  let shift: Vec = opts.offset ?? { x: 0, y: 0 };
  if (opts.at) {
    const pts: Vec[] = [];
    for (const r of data.roots) {
      const n = byOld.get(r.id);
      if (!n) continue;
      pts.push(apply(r.world, { x: 0, y: 0 }), apply(r.world, { x: n.width, y: n.height }), apply(r.world, { x: n.width, y: 0 }), apply(r.world, { x: 0, y: n.height }));
    }
    if (pts.length) {
      const minX = Math.min(...pts.map((p) => p.x));
      const maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxY = Math.max(...pts.map((p) => p.y));
      shift = { x: opts.at.x - (minX + maxX) / 2, y: opts.at.y - (minY + maxY) / 2 };
    }
  }
  let index = opts.index;
  for (const n of data.nodes) {
    const copy = structuredCloneSafe(n) as SceneNode;
    copy.id = idMap.get(n.id)!;
    if (isContainer(copy)) (copy as any).children = (copy as any).children.map((c: ID) => idMap.get(c)).filter(Boolean);
    const isRoot = data.roots.some((r) => r.id === n.id);
    if (!isRoot) {
      copy.parentId = idMap.get(n.parentId) ?? parentId;
      d.nodes[copy.id] = copy;
      continue;
    }
    const r = data.roots.find((x) => x.id === n.id)!;
    const world = mul(translate(shift.x, shift.y), r.world);
    const pl = placementFromMatrix(mul(parentInv, world), copy.width, copy.height);
    copy.x = pl.x;
    copy.y = pl.y;
    copy.rotation = pl.rotation;
    copy.flipX = pl.flipX;
    copy.flipY = pl.flipY;
    insertNode(d, copy, parentId, index);
    if (index !== undefined) index++;
    out.push(copy.id);
  }
  return out;
}

/** Find the deepest frame at a page-space point (for dropping new shapes into frames). */
export function frameAt(doc: Doc, pageId: ID, p: Vec, exclude: Set<ID> = new Set()): ID | null {
  const page = doc.pages.find((x) => x.id === pageId);
  if (!page) return null;
  let found: ID | null = null;
  const visit = (ids: ID[]) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = doc.nodes[ids[i]];
      if (!n || !n.visible || exclude.has(n.id)) continue;
      if (n.type === 'frame') {
        const inv = invert(worldMatrix(doc, n.id));
        const lp = apply(inv, p);
        if (lp.x >= 0 && lp.y >= 0 && lp.x <= n.width && lp.y <= n.height) {
          found = n.id;
          visit(n.children);
          return;
        }
      }
    }
  };
  visit(page.children);
  return found;
}

/** Convert a page-space rectangle into a parent's local space (axis-aligned assumption). */
export function pageRectToParent(d: Doc, parentId: ID, r: Rect): Rect {
  const inv = invert(containerMatrix(d, parentId));
  const a = apply(inv, { x: r.x, y: r.y });
  const b = apply(inv, { x: r.x + r.width, y: r.y + r.height });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function pagePointToParent(d: Doc, parentId: ID, p: Vec): Vec {
  return apply(invert(containerMatrix(d, parentId)), p);
}

export function setAutoLayout(d: Doc, id: ID, on: boolean) {
  const n = d.nodes[id];
  if (!n || n.type !== 'frame') return;
  if (!on) {
    n.layout = null;
    return;
  }
  const f = n as FrameNode;
  // infer direction from children arrangement
  const kids = f.children.map((c) => d.nodes[c]).filter(Boolean) as SceneNode[];
  let mode: 'horizontal' | 'vertical' = 'vertical';
  if (kids.length > 1) {
    const xs = kids.map((k) => k.x);
    const ys = kids.map((k) => k.y);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    mode = spreadX > spreadY ? 'horizontal' : 'vertical';
    const key = mode === 'horizontal' ? 'x' : 'y';
    f.children.sort((a, b) => (d.nodes[a]?.[key] ?? 0) - (d.nodes[b]?.[key] ?? 0));
  }
  f.layout = { mode, gap: 10, padding: [10, 10, 10, 10], align: 'start', justify: 'start', wrap: false };
  f.sizingH = 'hug';
  f.sizingV = 'hug';
}

/** Wrap the selection in a new auto-layout frame (Shift+A). */
export function wrapInAutoLayout(d: Doc, ids: ID[]): ID | null {
  const id = groupNodes(d, ids, 'frame');
  if (!id) return null;
  setAutoLayout(d, id, true);
  const f = d.nodes[id] as FrameNode;
  f.fills = [];
  return id;
}

export function childrenIds(d: Doc, parentId: ID) {
  return childrenOf(d, parentId);
}

export { worldBounds };

/**
 * Re-fit a path / brush node's box to its geometry without moving it on screen.
 * Local coordinates of points are shifted so the bounds start at (0, 0).
 */
export function refitNode(d: Doc, id: ID) {
  const n = d.nodes[id];
  if (!n || (n.type !== 'path' && n.type !== 'brush')) return;
  const b = n.type === 'path' ? cmdsBounds(subPathsToCmds(n.paths)) : cmdsBounds(brushCmds(n));
  if (!b) return;
  const w = Math.max(b.width, 0.01);
  const h = Math.max(b.height, 0.01);
  if (Math.abs(b.x) < 1e-6 && Math.abs(b.y) < 1e-6 && Math.abs(w - n.width) < 1e-6 && Math.abs(h - n.height) < 1e-6) return;
  const L = linearMatrix(n);
  const off = apply(L, { x: b.x + w / 2 - n.width / 2, y: b.y + h / 2 - n.height / 2 });
  const cx = n.x + n.width / 2 + off.x;
  const cy = n.y + n.height / 2 + off.y;
  n.width = w;
  n.height = h;
  n.x = cx - w / 2;
  n.y = cy - h / 2;
  if (n.type === 'path') {
    for (const sp of n.paths)
      for (const p of sp.points) {
        p.x -= b.x;
        p.y -= b.y;
        if (p.in) {
          p.in.x -= b.x;
          p.in.y -= b.y;
        }
        if (p.out) {
          p.out.x -= b.x;
          p.out.y -= b.y;
        }
      }
  } else {
    for (const p of n.points) {
      p.x -= b.x;
      p.y -= b.y;
    }
  }
}
