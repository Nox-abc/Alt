import { useMemo, useState } from 'react';
import type { FrameNode } from '../../core/types';
import { editor, useEditor } from '../../core/store';
import { SHAPE_LIBRARY } from '../../core/shapes';
import { createNode, walk } from '../../core/doc';
import { duplicateNodes, insertNode, pagePointToParent, translateNodes } from '../../core/ops';
import { cmdsToSubPaths, parseSvgPath } from '../../core/path';
import { worldBounds } from '../../core/geometry';
import { viewCenter } from '../../editor/viewport';
import { Search, Component, Image as ImageIcon, Palette, Shapes, LayoutGrid } from '../icons';
import { paintPreview } from '../ColorPicker';
import { TEMPLATES } from '../templates';
import { toast } from '../toast';

function insertLibraryShape(id: string) {
  const def = SHAPE_LIBRARY.find((s) => s.id === id);
  if (!def) return;
  const s = editor();
  const c = viewCenter();
  s.mutate(
    (d) => {
      const n = createNode('path', {
        parentId: s.pageId,
        name: def.name,
        paths: cmdsToSubPaths(parseSvgPath(def.d).map((k) => (k.c === 'Z' ? k : k.c === 'C' ? { ...k, x1: k.x1 * 2, y1: k.y1 * 2, x2: k.x2 * 2, y2: k.y2 * 2, x: k.x * 2, y: k.y * 2 } : { ...k, x: k.x * 2, y: k.y * 2 }))),
        fills: [{ id: Math.random().toString(36).slice(2), type: 'solid', color: '#D9D9D9', opacity: 1, visible: true }],
        strokes: [],
        fillRule: 'evenodd',
        width: 200,
        height: 200,
      });
      const p = pagePointToParent(d, s.pageId, c);
      n.x = Math.round(p.x - 100);
      n.y = Math.round(p.y - 100);
      insertNode(d, n, s.pageId);
      return n.id;
    },
    { select: (r) => [r], label: 'Insert shape' },
  );
}

export function AssetsPanel() {
  const doc = useEditor((s) => s.doc);
  const [q, setQ] = useState('');
  const components = useMemo(() => {
    const out: FrameNode[] = [];
    for (const p of doc.pages) walk(doc, p.children, (n) => void (n.type === 'frame' && n.isComponent && out.push(n)));
    return out;
  }, [doc]);
  const images = Object.values(doc.assets).filter((a) => a.mime.startsWith('image/') && a.name);
  const ql = q.toLowerCase();
  return (
    <div className="panel-scroll">
      <div className="section">
        <label className="field">
          <span className="prefix static">
            <Search size={13} />
          </span>
          <input placeholder="Search assets" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="section">
        <div className="section-head">
          <span className="title">
            <LayoutGrid size={13} /> Templates
          </span>
        </div>
        <div className="grid2">
          {TEMPLATES.filter((t) => t.name.toLowerCase().includes(ql)).map((t) => (
            <button key={t.id} className="btn" style={{ justifyContent: 'flex-start', height: 'auto', padding: '8px 10px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => t.create()}>
              <span style={{ fontWeight: 600 }}>{t.name}</span>
              <span className="muted" style={{ fontSize: 10.5, fontWeight: 400 }}>
                {t.hint}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="section">
        <div className="section-head">
          <span className="title">
            <Component size={13} /> Components
          </span>
        </div>
        {components.filter((c) => c.name.toLowerCase().includes(ql)).length === 0 ? (
          <div className="hint">Select a frame and press ⌥⌘K / Ctrl+Alt+K to make it a reusable component.</div>
        ) : (
          components
            .filter((c) => c.name.toLowerCase().includes(ql))
            .map((c) => (
              <div
                key={c.id}
                className="layer"
                onClick={() => {
                  const s = editor();
                  const b = worldBounds(s.doc, c.id);
                  const center = viewCenter();
                  s.mutate(
                    (d) => {
                      const ids = duplicateNodes(d, [c.id]);
                      for (const id of ids) {
                        const n = d.nodes[id];
                        if (n.type === 'frame') {
                          n.isComponent = false;
                          n.name = c.name.replace(/^Component/, 'Instance');
                          n.meta = { ...(n.meta ?? {}), instanceOf: c.id };
                        }
                      }
                      translateNodes(d, ids, center.x - b.x - b.width / 2, center.y - b.y - b.height / 2);
                      return ids;
                    },
                    { select: (r) => r, label: 'Insert component' },
                  );
                  toast(`Inserted ${c.name}`);
                }}
              >
                <span className="ltype">
                  <Component size={14} />
                </span>
                <span className="lname">{c.name}</span>
              </div>
            ))
        )}
      </div>
      <div className="section">
        <div className="section-head">
          <span className="title">
            <Shapes size={13} /> Shape library
          </span>
        </div>
        <div className="grid3" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          {SHAPE_LIBRARY.filter((s) => s.name.toLowerCase().includes(ql)).map((s) => (
            <button
              key={s.id}
              className="icon-btn"
              style={{ width: '100%', height: 40 }}
              data-tip={`${s.name} — click to insert, or pick the shape tool`}
              onClick={() => insertLibraryShape(s.id)}
              onDoubleClick={() => {
                editor().setToolOptions({ shapeId: s.id });
                editor().setTool('shape');
              }}
            >
              <svg width="22" height="22" viewBox="-4 -4 108 108">
                <path d={s.d} fill="currentColor" fillRule="evenodd" />
              </svg>
            </button>
          ))}
        </div>
      </div>
      <div className="section">
        <div className="section-head">
          <span className="title">
            <Palette size={13} /> Colour styles
          </span>
        </div>
        {doc.styles.colors.length === 0 ? (
          <div className="hint">Save colours from any colour picker with the + swatch.</div>
        ) : (
          <div className="grid3" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
            {doc.styles.colors.map((c) => (
              <span
                key={c.id}
                className="swatch"
                style={{ width: '100%', height: 'auto', aspectRatio: '1' }}
                data-tip={`${c.name} — click to apply`}
                onClick={() => {
                  const s = editor();
                  if (!s.selection.length) return toast('Select layers to apply the style');
                  s.mutate((d) => {
                    for (const id of s.selection) d.nodes[id].fills = [{ ...JSON.parse(JSON.stringify(c.paint)), id: Math.random().toString(36).slice(2) }];
                  });
                }}
              >
                <i style={{ background: paintPreview(c.paint) }} />
              </span>
            ))}
          </div>
        )}
      </div>
      {images.length > 0 && (
        <div className="section">
          <div className="section-head">
            <span className="title">
              <ImageIcon size={13} /> Images
            </span>
          </div>
          <div className="grid3">
            {images.map((a) => (
              <div key={a.id} className="swatch" style={{ width: '100%', height: 64, borderRadius: 8, background: `center / cover url("${a.data}")` }} data-tip={a.name} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
