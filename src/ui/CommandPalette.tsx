import { useEffect, useMemo, useRef, useState } from 'react';
import { editor } from '../core/store';
import { walk } from '../core/doc';
import { ACTIONS, runAction, shortcutLabel } from '../editor/actions';
import { zoomToSelection } from '../editor/viewport';
import { useUI } from './uiStore';
import { Search, Command, Layers, ChevronRight } from './icons';
import { nodeIcon } from './panels/LayersPanel';
import { TEMPLATES } from './templates';
import { LayoutGrid } from './icons';

interface Item {
  key: string;
  label: string;
  group: string;
  icon: React.ReactNode;
  short?: string;
  run: () => void;
}

function score(label: string, q: string): number {
  if (!q) return 1;
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 100 - l.length * 0.1;
  const i = l.indexOf(q);
  if (i >= 0) return 60 - i;
  // fuzzy subsequence
  let j = 0;
  for (const ch of l) if (ch === q[j]) j++;
  return j === q.length ? 20 - l.length * 0.05 : -1;
}

export function CommandPalette() {
  const open = useUI((s) => s.palette);
  const initial = useUI((s) => s.paletteQuery);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setQ(initial);
      setSel(0);
    }
  }, [open, initial]);
  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const query = q.trim().toLowerCase();
    const layerMode = query.startsWith('#');
    const s = editor();
    const out: (Item & { score: number })[] = [];
    if (!layerMode) {
      for (const a of ACTIONS) {
        if (a.hidden) continue;
        if (a.enabled && !a.enabled()) continue;
        const sc = Math.max(score(a.label, query), score(`${a.group} ${a.label}`, query) - 10);
        if (sc < 0) continue;
        out.push({ key: a.id, label: a.label, group: a.group, icon: <Command size={13} />, short: shortcutLabel(a.id), run: () => runAction(a.id), score: sc });
      }
    }
    if (!layerMode) {
      for (const t of TEMPLATES) {
        const sc = score(`Insert template ${t.name}`, query);
        if (sc < 0 && score(t.name, query) < 0) continue;
        out.push({ key: 'tpl-' + t.id, label: `Insert template: ${t.name}`, group: 'Templates', icon: <LayoutGrid size={13} />, run: t.create, score: Math.max(sc, score(t.name, query)) - 5 });
      }
    }
    const lq = layerMode ? query.slice(1).trim() : query;
    if (layerMode || lq.length > 1) {
      for (const page of s.doc.pages)
        walk(s.doc, page.children, (n) => {
          const sc = score(n.name, lq);
          if (sc < 0) return;
          out.push({
            key: n.id,
            label: n.name,
            group: page.name,
            icon: nodeIcon(n, 13),
            score: sc - (layerMode ? 0 : 30),
            run: () => {
              if (s.pageId !== page.id) editor().setPage(page.id);
              editor().setSelection([n.id]);
              requestAnimationFrame(() => zoomToSelection([n.id]));
            },
          });
        });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 80);
  }, [open, q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  if (!open) return null;
  const close = () => useUI.getState().set({ palette: false });
  const go = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };
  return (
    <div className="modal-backdrop" style={{ background: 'transparent', backdropFilter: 'none' }} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <div className="palette-input">
          {q.startsWith('#') ? <Layers size={17} /> : <Search size={17} />}
          <input
            autoFocus
            value={q}
            placeholder="Search commands, tools and layers…  (# for layers)"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((v) => Math.min(items.length - 1, v + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((v) => Math.max(0, v - 1));
              } else if (e.key === 'Enter') go(items[sel]);
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="empty-state">No results for “{q}”</div>}
          {items.map((it, i) => (
            <div key={it.key + i} className={`palette-item ${i === sel ? 'on' : ''}`} onPointerMove={() => setSel(i)} onClick={() => go(it)}>
              <span className="pi-icon">{it.icon}</span>
              <span className="pi-label">{it.label}</span>
              <span className="pi-group">{it.group}</span>
              {it.short && <span className="kbd">{it.short}</span>}
              {!it.short && i === sel && <ChevronRight size={14} className="muted" />}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> run
          </span>
          <span>
            <span className="kbd">#</span> search layers
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <span className="kbd">Esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}
