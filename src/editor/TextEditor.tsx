import { useEffect, useLayoutEffect, useRef } from 'react';
import type { TextNode } from '../core/types';
import { editor, getViewport, useEditor } from '../core/store';
import { worldMatrix } from '../core/geometry';
import { deleteNodes, setProps } from '../core/ops';
import { layoutText, cssFontFamily } from '../core/text';
import { hexToRgba } from '../core/doc';
import { useSettings } from './settings';
import { handleTextFieldKeys } from './keyboard';

/**
 * Inline text editing: a transparent-background textarea laid exactly over the
 * text node (same transform, font metrics and wrapping), live-updating the node.
 */
export function TextEditor({ id, isNew }: { id: string; isNew: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const node = useEditor((s) => s.doc.nodes[id]) as TextNode | undefined;
  useEditor((s) => s.viewports);
  const accent = useSettings((s) => s.accent);
  const finished = useRef(false);

  useEffect(() => {
    const s = editor();
    if (!s.tx) s.begin('Edit text');
    const el = ref.current;
    if (el) {
      el.focus({ preventScroll: true });
      if (!isNew) el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
    }
    return () => {
      // React StrictMode re-runs effects; only finish when editing really moved on
      const e = editor().editing;
      if (e?.kind === 'text' && e.id === id) return;
      finish();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    // keep caret visible / textarea scroll at 0
    if (ref.current) ref.current.scrollTop = 0;
  });

  function finish() {
    if (finished.current) return;
    finished.current = true;
    const s = editor();
    const n = s.doc.nodes[id] as TextNode | undefined;
    if (n && !n.text.trim()) {
      if (isNew && s.tx) {
        s.cancel();
      } else {
        s.mutate((d) => deleteNodes(d, [id]), { history: false });
        s.commit();
      }
      s.setSelection([]);
    } else {
      // name new / default-named text layers after their content
      if (n && (n.name === 'Text' || n.meta?.autoName)) {
        const label = n.text.split('\n')[0].trim().slice(0, 48) || 'Text';
        if (label !== n.name) s.mutate((d) => void Object.assign(d.nodes[id], { name: label, meta: { ...(d.nodes[id].meta ?? {}), autoName: true } }), { history: false });
      }
      s.commit();
    }
    if (editor().editing?.kind === 'text') editor().setEditing(null);
  }

  if (!node) return null;
  const v = getViewport();
  const m = worldMatrix(editor().doc, id);
  const L = layoutText(node);
  const fill = node.fills.find((f) => f.visible && f.type === 'solid');
  const color = fill && fill.type === 'solid' ? hexToRgba(fill.color, fill.opacity) : '#000';
  const width = node.autoResize === 'width' ? Math.max(4, L.contentWidth + node.fontSize) : node.width;
  const height = Math.max(node.height, L.contentHeight);
  const padTop = L.lines[0]?.top ?? 0;
  const transform = `matrix(${m[0] * v.zoom}, ${m[1] * v.zoom}, ${m[2] * v.zoom}, ${m[3] * v.zoom}, ${m[4] * v.zoom + v.x}, ${m[5] * v.zoom + v.y})`;
  const textTransform = node.textCase === 'upper' ? 'uppercase' : node.textCase === 'lower' ? 'lowercase' : node.textCase === 'title' ? 'capitalize' : 'none';

  return (
    <div className="text-editor" style={{ transform, transformOrigin: '0 0' }}>
      <textarea
        ref={ref}
        spellCheck={false}
        value={node.text}
        onChange={(e) => {
          const text = e.target.value;
          editor().mutate((d) => setProps(d, id, { text } as Partial<TextNode>), { history: false });
        }}
        onBlur={() => finish()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (handleTextFieldKeys(e)) return;
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            finish();
          }
        }}
        style={{
          width: width + 2,
          height: height + 2,
          paddingTop: padTop,
          font: `${node.italic ? 'italic ' : ''}${node.fontWeight} ${node.fontSize}px ${cssFontFamily(node.fontFamily)}`,
          lineHeight: `${node.fontSize * node.lineHeight}px`,
          letterSpacing: `${node.letterSpacing}px`,
          textAlign: node.textAlign,
          textTransform,
          textDecoration: node.textDecoration === 'strikethrough' ? 'line-through' : node.textDecoration,
          whiteSpace: node.autoResize === 'width' ? 'pre' : 'pre-wrap',
          color,
          caretColor: accent,
        }}
      />
    </div>
  );
}
