import { describe, expect, it, beforeEach } from 'vitest';
import { createDoc, createNode, sortByZ } from '../src/core/doc';
import {
  alignNodes,
  deleteNodes,
  distributeNodes,
  duplicateNodes,
  groupNodes,
  insertNode,
  moveNodes,
  pasteNodes,
  reorderNodes,
  rotateNodes,
  serializeNodes,
  setAutoLayout,
  setProps,
  translateNodes,
  ungroupNodes,
} from '../src/core/ops';
import { finalize, layoutFrame } from '../src/core/layout';
import { worldBounds, worldMatrix, apply } from '../src/core/geometry';
import { useEditor } from '../src/core/store';
import type { Doc, FrameNode } from '../src/core/types';

function close(a: number, b: number, eps = 1e-6) {
  expect(Math.abs(a - b)).toBeLessThan(eps);
}

function rectsClose(a: { x: number; y: number; width: number; height: number }, b: typeof a, eps = 1e-6) {
  close(a.x, b.x, eps);
  close(a.y, b.y, eps);
  close(a.width, b.width, eps);
  close(a.height, b.height, eps);
}

let doc: Doc;
let page: string;

beforeEach(() => {
  doc = createDoc('Test');
  page = doc.pages[0].id;
});

function add(type: 'rect' | 'ellipse' | 'frame' | 'text', props: Record<string, unknown> = {}, parent = page) {
  const n = createNode(type, { parentId: parent, ...(props as any) });
  insertNode(doc, n, parent);
  return n.id;
}

describe('geometry', () => {
  it('rotates around the node centre', () => {
    const id = add('rect', { x: 100, y: 50, width: 40, height: 20, rotation: 90 });
    const b = worldBounds(doc, id);
    // centre stays at (120, 60), box becomes 20 × 40
    rectsClose(b, { x: 110, y: 40, width: 20, height: 40 });
  });

  it('composes parent transforms', () => {
    const f = add('frame', { x: 10, y: 20, width: 200, height: 200 });
    const r = add('rect', { x: 5, y: 5, width: 10, height: 10 }, f);
    const m = worldMatrix(doc, r);
    const p = apply(m, { x: 0, y: 0 });
    close(p.x, 15);
    close(p.y, 25);
  });
});

describe('grouping', () => {
  it('group / ungroup keeps every node in place, even rotated ones', () => {
    const a = add('rect', { x: 0, y: 0, width: 50, height: 50, rotation: 30 });
    const b = add('ellipse', { x: 100, y: 40, width: 30, height: 60 });
    const before = [worldBounds(doc, a), worldBounds(doc, b)];
    const g = groupNodes(doc, [a, b], 'group')!;
    finalize(doc, [g, a, b]);
    expect(doc.nodes[a].parentId).toBe(g);
    rectsClose(worldBounds(doc, a), before[0]);
    rectsClose(worldBounds(doc, b), before[1]);
    // group hugs its children
    const gb = worldBounds(doc, g);
    expect(gb.x).toBeLessThanOrEqual(before[0].x + 1e-6);
    // rotate the group, then ungroup – world placement must survive
    rotateNodes(doc, [g], 45);
    const rotated = [worldBounds(doc, a), worldBounds(doc, b)];
    ungroupNodes(doc, [g]);
    expect(doc.nodes[g]).toBeUndefined();
    rectsClose(worldBounds(doc, a), rotated[0], 1e-6);
    rectsClose(worldBounds(doc, b), rotated[1], 1e-6);
  });

  it('moving a node into a rotated frame preserves its world box', () => {
    const f = add('frame', { x: 0, y: 0, width: 300, height: 300, rotation: 15 });
    const r = add('rect', { x: 400, y: 10, width: 20, height: 30 });
    const before = worldBounds(doc, r);
    moveNodes(doc, [r], f);
    expect(doc.nodes[r].parentId).toBe(f);
    rectsClose(worldBounds(doc, r), before, 1e-6);
  });

  it('removes groups that become empty', () => {
    const a = add('rect');
    const g = groupNodes(doc, [a], 'group')!;
    deleteNodes(doc, [a]);
    expect(doc.nodes[g]).toBeUndefined();
  });
});

describe('auto layout', () => {
  it('stacks children with gap and padding and hugs content', () => {
    const f = add('frame', { width: 10, height: 10 });
    add('rect', { width: 100, height: 40 }, f);
    add('rect', { width: 60, height: 20 }, f);
    setAutoLayout(doc, f, true);
    const frame = doc.nodes[f] as FrameNode;
    frame.layout = { mode: 'vertical', gap: 8, padding: [10, 12, 10, 12], align: 'start', justify: 'start', wrap: false };
    layoutFrame(doc, frame);
    const [k1, k2] = frame.children.map((id) => doc.nodes[id]);
    expect(k1.x).toBe(12);
    expect(k1.y).toBe(10);
    expect(k2.y).toBe(10 + 40 + 8);
    expect(frame.width).toBe(12 + 100 + 12);
    expect(frame.height).toBe(10 + 40 + 8 + 20 + 10);
  });

  it('distributes fill children along the main axis', () => {
    const f = add('frame', { width: 300, height: 50 });
    const a = add('rect', { width: 50, height: 20, sizingH: 'fill' }, f);
    const b = add('rect', { width: 50, height: 20 }, f);
    const frame = doc.nodes[f] as FrameNode;
    frame.layout = { mode: 'horizontal', gap: 10, padding: [0, 0, 0, 0], align: 'center', justify: 'start', wrap: false };
    frame.sizingH = 'fixed';
    frame.sizingV = 'fixed';
    layoutFrame(doc, frame);
    expect(doc.nodes[a].width).toBe(300 - 50 - 10);
    expect(doc.nodes[b].x).toBe(240 + 10);
    expect(doc.nodes[b].y).toBe(15);
  });
});

describe('ops', () => {
  it('aligns and distributes', () => {
    const a = add('rect', { x: 0, y: 0, width: 10, height: 10 });
    const b = add('rect', { x: 50, y: 30, width: 10, height: 10 });
    const c = add('rect', { x: 200, y: 60, width: 10, height: 10 });
    alignNodes(doc, [a, b, c], 'top');
    expect([a, b, c].map((id) => doc.nodes[id].y)).toEqual([0, 0, 0]);
    distributeNodes(doc, [a, b, c], 'h');
    close(doc.nodes[b].x, 100);
  });

  it('reorders z and duplicates above the original', () => {
    const a = add('rect');
    const b = add('rect');
    reorderNodes(doc, [a], 'front');
    expect(doc.pages[0].children).toEqual([b, a]);
    const [copy] = duplicateNodes(doc, [b], { x: 10, y: 0 });
    expect(doc.pages[0].children).toEqual([b, copy, a]);
    expect(doc.nodes[copy].x).toBe(doc.nodes[b].x + 10);
    expect(sortByZ(doc, [a, copy, b])).toEqual([b, copy, a]);
  });

  it('round-trips through the clipboard format with fresh ids', () => {
    const f = add('frame', { x: 30, y: 40, width: 100, height: 100 });
    add('rect', { x: 10, y: 10 }, f);
    const data = serializeNodes(doc, [f]);
    const ids = pasteNodes(doc, data, page, { offset: { x: 5, y: 5 } });
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(f);
    const pasted = doc.nodes[ids[0]] as FrameNode;
    expect(pasted.children).toHaveLength(1);
    expect(pasted.x).toBe(35);
    expect(doc.nodes[pasted.children[0]].parentId).toBe(pasted.id);
  });

  it('resizing a group scales its children', () => {
    const a = add('rect', { x: 0, y: 0, width: 100, height: 100 });
    const b = add('rect', { x: 100, y: 0, width: 100, height: 100 });
    const g = groupNodes(doc, [a, b], 'group')!;
    setProps(doc, g, { width: 400 });
    expect(doc.nodes[a].width).toBe(200);
    expect(doc.nodes[b].x).toBe(200);
  });

  it('translates in page space through rotated parents', () => {
    const f = add('frame', { x: 0, y: 0, width: 100, height: 100, rotation: 90 });
    const r = add('rect', { x: 10, y: 10, width: 10, height: 10 }, f);
    const before = worldBounds(doc, r);
    translateNodes(doc, [r], 25, 0);
    const after = worldBounds(doc, r);
    close(after.x - before.x, 25);
    close(after.y - before.y, 0);
  });
});

describe('store', () => {
  it('records undo / redo and coalesces transactions', () => {
    const s = useEditor.getState();
    s.newDoc('Undo');
    const pid = useEditor.getState().pageId;
    const id = useEditor.getState().mutate((d) => {
      const n = createNode('rect', { parentId: pid });
      insertNode(d, n, pid);
      return n.id;
    });
    useEditor.getState().begin();
    for (let i = 1; i <= 5; i++) useEditor.getState().mutate((d) => void (d.nodes[id].x = i * 10));
    useEditor.getState().commit();
    expect(useEditor.getState().doc.nodes[id].x).toBe(50);
    useEditor.getState().undo();
    expect(useEditor.getState().doc.nodes[id].x).toBe(0);
    useEditor.getState().undo();
    expect(useEditor.getState().doc.nodes[id]).toBeUndefined();
    useEditor.getState().redo();
    useEditor.getState().redo();
    expect(useEditor.getState().doc.nodes[id].x).toBe(50);
  });
});
