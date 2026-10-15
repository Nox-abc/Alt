import type { Vec } from '../../core/types';
import { editor, getViewport } from '../../core/store';
import { createNode } from '../../core/doc';
import { fitText, frameAt, insertNode, pagePointToParent } from '../../core/ops';
import { hitTest } from '../../render/hit';
import { requestOverlay, ui, type Tool } from '../toolkit';

let start: Vec | null = null;

export const textTool: Tool = {
  id: 'text',
  cursor: 'text',
  down(p) {
    if (p.button !== 0) return;
    const s = editor();
    const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
    const leaf = chain.length ? s.doc.nodes[chain[chain.length - 1]] : null;
    if (leaf?.type === 'text') {
      s.setSelection([leaf.id]);
      s.setEditing({ kind: 'text', id: leaf.id });
      start = null;
      return;
    }
    start = p.world;
  },
  move(p) {
    if (!start || !(p.buttons & 1)) return;
    const r = { x: Math.min(start.x, p.world.x), y: Math.min(start.y, p.world.y), width: Math.abs(p.world.x - start.x), height: Math.abs(p.world.y - start.y) };
    ui.marquee = r;
    requestOverlay();
  },
  up(p) {
    if (!start) return;
    const s = editor();
    const st = start;
    start = null;
    const dragW = Math.abs(p.world.x - st.x) * getViewport().zoom;
    ui.marquee = null;
    const parent = frameAt(s.doc, s.pageId, st) ?? s.pageId;
    const fixed = dragW > 6;
    s.begin('Text');
    const id = s.mutate(
      (d) => {
        const n = createNode('text', { parentId: parent, text: '' });
        const opts = s.toolOptions;
        n.fills = [{ id: n.fills[0].id, type: 'solid', color: opts.brushColor === '#111111' ? '#000000' : '#000000', opacity: 1, visible: true }];
        const lp = pagePointToParent(d, parent, { x: Math.min(st.x, p.world.x), y: Math.min(st.y, p.world.y) });
        n.x = Math.round(lp.x);
        n.y = Math.round(lp.y - (fixed ? 0 : n.fontSize * n.lineHeight * 0.5));
        if (fixed) {
          n.autoResize = 'height';
          n.width = Math.max(10, Math.abs(p.world.x - st.x));
        }
        n.name = 'Text';
        insertNode(d, n, parent);
        fitText(d, n.id);
        return n.id;
      },
      { select: (r) => [r], history: false },
    );
    s.setEditing({ kind: 'text', id, isNew: true });
    if (!s.toolLock) s.setTool('move');
    editor().setEditing({ kind: 'text', id, isNew: true });
    requestOverlay();
  },
  cancel() {
    start = null;
    ui.marquee = null;
  },
};
