import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Doc, ID, SceneNode } from '../../core/types';
import { editor, useEditor } from '../../core/store';
import { getPage, isContainer, isAncestor, uniqueName } from '../../core/doc';
import { addPage, deletePage, duplicatePage, getChildrenArray, moveNodes } from '../../core/ops';
import {
  Frame,
  Square,
  Circle,
  Star,
  Type,
  Image as ImageIcon,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  ChevronRight,
  Plus,
  Group,
  Component,
  SquaresUnite,
  SquaresSubtract,
  SquaresIntersect,
  SquaresExclude,
  PenTool,
  Layers,
  BrushStrokeIcon,
  PixelIcon,
  PolygonIcon,
  AutoLayoutIcon,
  MaskIcon,
  Paintbrush,
  LineIcon,
} from '../icons';
import { IconButton, Popover, MenuList } from '../controls';
import { useUI } from '../uiStore';
import { zoomToSelection } from '../../editor/viewport';
import { openContextMenu } from '../ContextMenu';

export function nodeIcon(n: SceneNode, size = 14): React.ReactNode {
  if (n.isMask) return <MaskIcon size={size} />;
  switch (n.type) {
    case 'frame':
      if (n.isComponent) return <Component size={size} />;
      if (n.layout) return <AutoLayoutIcon size={size} />;
      return <Frame size={size} />;
    case 'group':
      return <Group size={size} />;
    case 'boolean':
      return n.op === 'union' ? <SquaresUnite size={size} /> : n.op === 'subtract' ? <SquaresSubtract size={size} /> : n.op === 'intersect' ? <SquaresIntersect size={size} /> : <SquaresExclude size={size} />;
    case 'rect':
      return n.fills.some((f) => f.type === 'image') ? <ImageIcon size={size} /> : <Square size={size} />;
    case 'ellipse':
      return <Circle size={size} />;
    case 'polygon':
      return <PolygonIcon size={size} />;
    case 'star':
      return <Star size={size} />;
    case 'path':
      return n.paths.length === 1 && n.paths[0].points.length === 2 && !n.paths[0].closed ? <LineIcon size={size} /> : <PenTool size={size} />;
    case 'text':
      return <Type size={size} />;
    case 'brush':
      return <BrushStrokeIcon size={size} />;
    case 'bitmap':
      return n.smoothing ? <Paintbrush size={size} /> : <PixelIcon size={size} />;
  }
}

interface Row {
  id: ID;
  depth: number;
  hasKids: boolean;
  open: boolean;
}

const ROW_H = 30;

function flatten(doc: Doc, ids: ID[], expanded: Set<ID>, depth: number, out: Row[]) {
  for (let i = ids.length - 1; i >= 0; i--) {
    const n = doc.nodes[ids[i]];
    if (!n) continue;
    const kids = isContainer(n) ? n.children : [];
    const open = expanded.has(n.id);
    out.push({ id: n.id, depth, hasKids: kids.length > 0, open });
    if (open && kids.length) flatten(doc, kids, expanded, depth + 1, out);
  }
}

const LayerRow = memo(function LayerRow({
  row,
  node,
  selected,
  primary,
  hovered,
  renaming,
  topFrame,
  childOfSelected,
  onToggle,
  onDragStart,
}: {
  row: Row;
  node: SceneNode;
  selected: boolean;
  primary: boolean;
  hovered: boolean;
  renaming: boolean;
  topFrame: boolean;
  childOfSelected: boolean;
  onToggle: (id: ID) => void;
  onDragStart: (e: React.PointerEvent, id: ID) => void;
}) {
  const [name, setName] = useState(node.name);
  useEffect(() => setName(node.name), [node.name, renaming]);
  const commitName = () => {
    useUI.getState().set({ renaming: null });
    const v = name.trim();
    if (v && v !== node.name) editor().mutate((d) => void (d.nodes[node.id].name = v), { label: 'Rename' });
  };
  return (
    <div
      className={`layer ${selected ? 'selected' : ''} ${primary ? 'primary' : ''} ${hovered && !selected ? 'hovered' : ''} ${!node.visible ? 'invisible' : ''} ${topFrame ? 'frame-top' : ''} ${childOfSelected ? 'child-of-selected' : ''}`}
      style={{ paddingLeft: 6 + row.depth * 16 }}
      onPointerEnter={() => editor().setHover(node.id)}
      onPointerLeave={() => editor().setHover(null)}
      onPointerDown={(e) => {
        if (e.button !== 0 || renaming) return;
        onDragStart(e, node.id);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.lactions, .twisty')) return;
        useUI.getState().set({ renaming: node.id });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!editor().selection.includes(node.id)) editor().setSelection([node.id]);
        openContextMenu(e.clientX, e.clientY, true);
      }}
    >
      <span
        className={`twisty ${row.open ? 'open' : ''}`}
        style={{ visibility: row.hasKids ? 'visible' : 'hidden' }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onToggle(node.id)}
      >
        <ChevronRight size={12} />
      </span>
      <span className="ltype">{nodeIcon(node)}</span>
      {renaming ? (
        <input
          className="rename"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commitName}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitName();
            if (e.key === 'Escape') useUI.getState().set({ renaming: null });
          }}
        />
      ) : (
        <span className="lname">{node.name}</span>
      )}
      <span className={`lactions ${node.locked || !node.visible ? 'pinned' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
        <IconButton
          size="xs"
          icon={node.locked ? <Lock size={12} /> : <LockOpen size={12} />}
          tip={node.locked ? 'Unlock' : 'Lock'}
          onClick={() => editor().mutate((d) => void (d.nodes[node.id].locked = !node.locked), { label: 'Lock' })}
        />
        <IconButton
          size="xs"
          icon={node.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          tip={node.visible ? 'Hide' : 'Show'}
          onClick={() => editor().mutate((d) => void (d.nodes[node.id].visible = !node.visible), { label: 'Visibility' })}
        />
      </span>
    </div>
  );
});

export function LayersTree() {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const selection = useEditor((s) => s.selection);
  const hoverId = useEditor((s) => s.hoverId);
  const renaming = useUI((s) => s.renaming);
  const [expanded, setExpanded] = useState<Set<ID>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [drop, setDrop] = useState<{ y: number; inside: ID | null } | null>(null);

  // reveal selected nodes
  useEffect(() => {
    if (!selection.length) return;
    let changed = false;
    const next = new Set(expanded);
    for (const id of selection) {
      let cur = doc.nodes[doc.nodes[id]?.parentId];
      while (cur) {
        if (!next.has(cur.id)) {
          next.add(cur.id);
          changed = true;
        }
        cur = doc.nodes[cur.parentId];
      }
    }
    if (changed) setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const page = getPage(doc, pageId);
  const rows = useMemo(() => {
    const out: Row[] = [];
    if (page) flatten(doc, page.children, expanded, 0, out);
    return out;
  }, [doc, page, expanded]);

  // scroll selected row into view
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !selection.length) return;
    const idx = rows.findIndex((r) => r.id === selection[selection.length - 1]);
    if (idx < 0) return;
    const y = idx * ROW_H;
    if (y < el.scrollTop || y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y - el.clientHeight / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggle = (id: ID) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const selSet = useMemo(() => new Set(selection), [selection]);
  const childOfSel = (id: ID) => {
    let cur = doc.nodes[doc.nodes[id]?.parentId];
    while (cur) {
      if (selSet.has(cur.id)) return true;
      cur = doc.nodes[cur.parentId];
    }
    return false;
  };

  const onDragStart = (e: React.PointerEvent, id: ID) => {
    const s = editor();
    const startY = e.clientY;
    let dragging = false;
    const el = scrollRef.current!;
    // click selection semantics
    const mod = e.metaKey || e.ctrlKey;
    if (e.shiftKey && s.selection.length) {
      const last = rows.findIndex((r) => r.id === s.selection[s.selection.length - 1]);
      const cur = rows.findIndex((r) => r.id === id);
      const parent = doc.nodes[id].parentId;
      const range = rows.slice(Math.min(last, cur), Math.max(last, cur) + 1).filter((r) => doc.nodes[r.id]?.parentId === parent).map((r) => r.id);
      s.setSelection([...new Set([...s.selection.filter((x) => doc.nodes[x]?.parentId === parent), ...range])]);
    } else if (mod) s.toggleSelection(id);
    else if (!s.selection.includes(id)) s.setSelection([id]);
    const pick = (clientY: number) => {
      const r = el.getBoundingClientRect();
      const y = clientY - r.top + el.scrollTop;
      const idx = Math.max(0, Math.min(rows.length - 1, Math.floor(y / ROW_H)));
      const row = rows[idx];
      if (!row) return null;
      const node = editor().doc.nodes[row.id];
      const within = y - idx * ROW_H;
      const container = node && (node.type === 'frame' || node.type === 'group' || node.type === 'boolean');
      if (container && within > ROW_H * 0.3 && within < ROW_H * 0.7) return { row, mode: 'inside' as const, y: idx * ROW_H };
      return within < ROW_H / 2 ? { row, mode: 'above' as const, y: idx * ROW_H } : { row, mode: 'below' as const, y: (idx + 1) * ROW_H };
    };
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) < 4) return;
      dragging = true;
      const p = pick(ev.clientY);
      if (!p) return;
      setDrop({ y: p.y, inside: p.mode === 'inside' ? p.row.id : null });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrop(null);
      if (!dragging) {
        if (!mod && !e.shiftKey && editor().selection.length > 1) editor().setSelection([id]);
        return;
      }
      const p = pick(ev.clientY);
      if (!p) return;
      const st = editor();
      const ids = st.selection.filter((x) => x !== p.row.id && !isAncestor(st.doc, x, p.row.id));
      if (!ids.length) return;
      st.mutate(
        (d) => {
          if (p.mode === 'inside') {
            moveNodes(d, ids, p.row.id);
            return;
          }
          const target = d.nodes[p.row.id];
          const arr = getChildrenArray(d, target.parentId)!;
          const idx = arr.indexOf(target.id);
          // list is reversed: "above" in the UI means higher z-index
          moveNodes(d, ids, target.parentId, p.mode === 'above' ? idx + 1 : idx);
        },
        { label: 'Reorder layers' },
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const start = Math.max(0, Math.floor(scroll.top / ROW_H) - 6);
  const end = Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / ROW_H) + 6);

  if (!rows.length) {
    return (
      <div className="empty-state">
        <Layers size={28} />
        <div>
          No layers yet.
          <br />
          Press <span className="kbd">F</span> for a frame, <span className="kbd">R</span> for a rectangle or <span className="kbd">B</span> to start drawing.
        </div>
      </div>
    );
  }

  return (
    <div
      className="panel-scroll layers"
      ref={scrollRef}
      onScroll={(e) => setScroll({ top: (e.target as HTMLElement).scrollTop, height: (e.target as HTMLElement).clientHeight })}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) editor().setSelection([]);
      }}
    >
      <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
          {rows.slice(start, end).map((row) => {
            const node = doc.nodes[row.id];
            return (
              <div key={row.id} style={{ height: ROW_H, paddingTop: 1 }} onDoubleClickCapture={() => {}}>
                <LayerRow
                  row={row}
                  node={node}
                  selected={selSet.has(row.id)}
                  primary={selSet.has(row.id) && selection.length === 1}
                  hovered={hoverId === row.id}
                  renaming={renaming === row.id}
                  topFrame={row.depth === 0 && node.type === 'frame'}
                  childOfSelected={childOfSel(row.id)}
                  onToggle={toggle}
                  onDragStart={onDragStart}
                />
              </div>
            );
          })}
        </div>
        {drop && !drop.inside && <div className="drop-line" style={{ top: drop.y - 1 }} />}
        {drop?.inside && <div className="drop-line" style={{ top: rows.findIndex((r) => r.id === drop.inside) * ROW_H + ROW_H - 2, left: 40 }} />}
      </div>
    </div>
  );
}

export function PagesList() {
  const pages = useEditor((s) => s.doc.pages);
  const pageId = useEditor((s) => s.pageId);
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState<ID | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: ID } | null>(null);
  return (
    <div className="section" style={{ padding: '6px 0 4px' }}>
      <div className="section-head" style={{ padding: '0 12px', marginBottom: open ? 2 : 0 }} onClick={() => setOpen(!open)}>
        <span className="title">
          <ChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms', color: 'var(--text-3)' }} />
          Pages
        </span>
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <IconButton
            size="sm"
            icon={<Plus size={15} />}
            tip="Add page"
            onClick={() => {
              const id = editor().mutate((d) => addPage(d), { label: 'Add page' });
              editor().setPage(id);
              setRenaming(id);
            }}
          />
        </span>
      </div>
      {open && (
        <div className="pages" style={{ maxHeight: 180, overflow: 'auto' }}>
          {pages.map((p) => (
            <div
              key={p.id}
              className={`layer ${p.id === pageId ? 'selected' : ''}`}
              onClick={() => editor().setPage(p.id)}
              onDoubleClick={() => setRenaming(p.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: p.id });
              }}
            >
              <span className="ltype">{p.id === pageId ? <span className="dirty-dot" style={{ background: 'var(--accent)' }} /> : null}</span>
              {renaming === p.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={p.name}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    setRenaming(null);
                    if (v) editor().mutate((d) => void (d.pages.find((x) => x.id === p.id)!.name = v), { label: 'Rename page' });
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="lname">{p.name}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {menu && (
        <Popover anchor={{ x: menu.x, y: menu.y }} placement="point" onClose={() => setMenu(null)}>
          <MenuList
            onClose={() => setMenu(null)}
            items={[
              { label: 'Rename', run: () => setRenaming(menu.id) },
              {
                label: 'Duplicate',
                run: () => {
                  const id = editor().mutate((d) => duplicatePage(d, menu.id), { label: 'Duplicate page' });
                  if (id) editor().setPage(id);
                },
              },
              { separator: true },
              { label: 'Delete', danger: true, disabled: pages.length <= 1, run: () => editor().mutate((d) => deletePage(d, menu.id), { label: 'Delete page' }) },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

export function focusLayer(id: ID) {
  editor().setSelection([id]);
  zoomToSelection([id]);
}

export { uniqueName };
