import { useMemo } from 'react';
import type { Doc, ID, SceneNode } from '../../core/types';
import { editor, useEditor } from '../../core/store';
import { setProps } from '../../core/ops';

/** Selected nodes (re-renders when the document or selection changes). */
export function useSelected(): SceneNode[] {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  return useMemo(() => selection.map((id) => doc.nodes[id]).filter(Boolean), [doc, selection]);
}

export function mixed<T>(nodes: SceneNode[], get: (n: SceneNode) => T): T | 'mixed' {
  if (!nodes.length) return 'mixed';
  const first = get(nodes[0]);
  for (let i = 1; i < nodes.length; i++) {
    const v = get(nodes[i]);
    if (JSON.stringify(v) !== JSON.stringify(first)) return 'mixed';
  }
  return first;
}

export function num(v: unknown): number | 'mixed' {
  return typeof v === 'number' ? v : 'mixed';
}

/** Apply a change to every selected node (one undo step). */
export function updateSelected(fn: (n: SceneNode, d: Doc) => void, label?: string, ids?: ID[]) {
  const s = editor();
  const targets = ids ?? s.selection;
  s.mutate(
    (d) => {
      for (const id of targets) if (d.nodes[id]) fn(d.nodes[id], d);
    },
    { label },
  );
}

/** Set props via ops.setProps (keeps type-aware side effects like resizing content). */
export function setSelectedProps(props: Partial<SceneNode> | ((n: SceneNode) => Partial<SceneNode>), label?: string, ids?: ID[]) {
  const s = editor();
  const targets = ids ?? s.selection;
  s.mutate(
    (d) => {
      for (const id of targets) {
        const n = d.nodes[id];
        if (!n) continue;
        setProps(d, id, typeof props === 'function' ? props(n) : props);
      }
    },
    { label },
  );
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
