import { useEffect, useRef, useState } from 'react';
import { editor, getViewport, useEditor } from '../core/store';
import { getPage } from '../core/doc';
import { useSettings } from '../editor/settings';
import { setZoom, zoomStep, zoomToFit, zoomToSelection } from '../editor/viewport';
import { runAction } from '../editor/actions';
import { openRecent } from '../editor/file';
import { isMac, native, platform } from '../platform/native';
import { renderToCanvas } from '../render/rasterizeImpl';
import { useUI } from './uiStore';
import { useToasts } from './toast';
import { useDialog } from './dialog';
import { MenuList, Popover, IconButton } from './controls';
import {
  AltLogo,
  ChevronDown,
  Play,
  Settings,
  Download,
  Plug,
  PanelLeft,
  PanelRight,
  X,
  ChevronLeft,
  ChevronRight,
  Frame,
  Brush,
  PixelIcon,
  Sparkles,
  FolderOpen,
  Command,
} from './icons';
import { ExportBrowser } from './panels/ExportSection';
import type { MenuItem } from './uiStore';
import { TEMPLATES } from './templates';

/* ================================================================ titlebar */

function appMenu(): MenuItem[] {
  const recent = useSettings.getState().recent;
  return [
    { label: 'Back to files', disabled: true },
    {
      label: 'File',
      submenu: [
        { label: 'New file', action: 'file.new' },
        { label: 'Open…', action: 'file.open' },
        ...(native && recent.length
          ? [{ label: 'Open recent', submenu: recent.slice(0, 10).map((p) => ({ label: p.split(/[\\/]/).pop()!, run: () => void openRecent(p) })) }]
          : []),
        { separator: true },
        { label: 'Save', action: 'file.save' },
        { label: 'Save as…', action: 'file.saveAs' },
        { separator: true },
        { label: 'Import image or SVG…', action: 'file.import' },
        { label: 'Export…', action: 'file.export' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', action: 'edit.undo' },
        { label: 'Redo', action: 'edit.redo' },
        { separator: true },
        { label: 'Copy as SVG', action: 'edit.copySvg' },
        { label: 'Copy as PNG', action: 'edit.copyPng' },
        { label: 'Duplicate', action: 'edit.duplicate' },
        { label: 'Delete', action: 'edit.delete' },
        { separator: true },
        { label: 'Select all', action: 'edit.selectAll' },
        { label: 'Find layers…', action: 'edit.find' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom in', action: 'view.zoomIn' },
        { label: 'Zoom out', action: 'view.zoomOut' },
        { label: 'Zoom to fit', action: 'view.zoomFit' },
        { label: 'Zoom to 100%', action: 'view.zoom100' },
        { separator: true },
        { label: 'Pixel grid', action: 'view.togglePixelGrid', checked: useSettings.getState().showPixelGrid },
        { label: 'Rulers', action: 'view.toggleRulers', checked: useSettings.getState().showRulers },
        { label: 'Outline mode', action: 'view.outline', checked: useSettings.getState().outlineMode },
        { label: 'Show / hide UI', action: 'view.toggleUI' },
        { separator: true },
        { label: 'Toggle theme', action: 'view.toggleTheme' },
        { label: 'Present frames', action: 'view.present' },
      ],
    },
    {
      label: 'Object',
      submenu: [
        { label: 'Group', action: 'object.group' },
        { label: 'Ungroup', action: 'object.ungroup' },
        { label: 'Frame selection', action: 'object.frame' },
        { label: 'Add auto layout', action: 'object.autoLayout' },
        { label: 'Create component', action: 'object.component' },
        { separator: true },
        { label: 'Union', action: 'object.union' },
        { label: 'Subtract', action: 'object.subtract' },
        { label: 'Intersect', action: 'object.intersect' },
        { label: 'Exclude', action: 'object.exclude' },
        { label: 'Flatten', action: 'object.flatten' },
        { label: 'Use as mask', action: 'object.mask' },
        { separator: true },
        { label: 'Repeat in grid…', action: 'object.repeat' },
        { label: 'Radial repeat…', action: 'object.radialRepeat' },
      ],
    },
    { separator: true },
    { label: 'Command palette…', action: 'app.commandPalette' },
    { label: 'Keyboard shortcuts', action: 'app.shortcuts' },
    { label: 'Script console…', action: 'app.scripts' },
    { label: 'Connect AI agents (MCP)…', action: 'help.mcp' },
    { label: 'Settings…', action: 'app.settings' },
  ];
}

function ZoomMenu() {
  const zoom = useEditor((s) => getViewport(s).zoom);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div className="zoom-widget">
      <button className="select" data-tip="Zoom" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <span className="value" style={{ textAlign: 'right' }}>
          {Math.round(zoom * 100)}%
        </span>
        <ChevronDown size={12} className="chev" />
      </button>
      {anchor && (
        <Popover anchor={anchor} placement="bottom-end" onClose={() => setAnchor(null)} width={200}>
          <MenuList
            onClose={() => setAnchor(null)}
            items={[
              { label: 'Zoom in', action: 'view.zoomIn', run: () => zoomStep(1) },
              { label: 'Zoom out', action: 'view.zoomOut', run: () => zoomStep(-1) },
              { label: 'Zoom to fit', action: 'view.zoomFit', run: zoomToFit },
              { label: 'Zoom to selection', action: 'view.zoomSelection', run: () => zoomToSelection() },
              { separator: true },
              ...[0.5, 1, 2, 4, 8].map((z) => ({ label: `${z * 100}%`, checked: Math.abs(zoom - z) < 0.001, run: () => setZoom(z) })),
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

/** Pulsing badge while an MCP agent is editing the document. */
function AgentActivity() {
  const [active, setActive] = useState<{ tool: string; until: number } | null>(null);
  useEffect(() => {
    let running = 0;
    let timer = 0;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { tool: string; phase: 'start' | 'end' };
      if (d.phase === 'start') running++;
      else running = Math.max(0, running - 1);
      clearTimeout(timer);
      setActive({ tool: d.tool, until: Date.now() });
      if (!running) timer = window.setTimeout(() => setActive(null), 1600);
    };
    window.addEventListener('alt:mcp-activity', on);
    return () => {
      window.removeEventListener('alt:mcp-activity', on);
      clearTimeout(timer);
    };
  }, []);
  if (!active) return null;
  return (
    <span className="badge ok agent-badge" data-tip={`AI agent: ${active.tool.replace(/_/g, ' ')}`}>
      <span className="dot" /> Agent
    </span>
  );
}

export function TitleBar() {
  const name = useEditor((s) => s.doc.name);
  const dirty = useEditor((s) => s.dirty);
  const page = useEditor((s) => getPage(s.doc, s.pageId)?.name);
  const left = useSettings((s) => s.showLeftPanel);
  const right = useSettings((s) => s.showRightPanel);
  const set = useSettings((s) => s.set);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [title, setTitle] = useState(name);
  useEffect(() => setTitle(name), [name]);
  const chrome = platform === 'darwin' ? 'mac' : platform === 'web' ? '' : 'winlinux';
  return (
    <div className={`titlebar ${chrome}`} onDoubleClick={(e) => e.target === e.currentTarget && native && undefined}>
      <button className={`logo-btn ${menu ? 'open' : ''}`} onClick={(e) => setMenu((e.currentTarget as HTMLElement).getBoundingClientRect())} data-tip="Main menu">
        <span className="logo-mark">
          <AltLogo size={13} />
        </span>
        <ChevronDown size={12} className="muted" />
      </button>
      <IconButton size="sm" icon={<PanelLeft size={15} />} active={left} tip="Toggle layers panel" onClick={() => set({ showLeftPanel: !left })} />
      <div className="spacer" />
      <div className="doc-title">
        <span className="page">{page}</span>
        <span className="muted">/</span>
        <input
          value={title}
          size={Math.max(6, title.length)}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const v = title.trim() || 'Untitled';
            setTitle(v);
            if (v !== name) editor().mutate((d) => void (d.name = v), { label: 'Rename file' });
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
        />
        {dirty && <span className="dirty-dot" data-tip="Unsaved changes" />}
      </div>
      <AgentActivity />
      <IconButton size="sm" icon={<Command size={15} />} action="app.commandPalette" tip="Command palette" />
      <IconButton size="sm" icon={<Plug size={15} />} action="help.mcp" tip="Connect AI agents (MCP)" />
      <IconButton size="sm" icon={<Play size={15} />} action="view.present" tip="Present frames" />
      <button className="btn primary" style={{ height: 28 }} onClick={() => runAction('file.export')} data-tip="Export" data-key={isMac ? '⇧⌘E' : 'Ctrl+Shift+E'}>
        <Download size={14} /> Export
      </button>
      <ZoomMenu />
      <IconButton size="sm" icon={<PanelRight size={15} />} active={right} tip="Toggle design panel" onClick={() => set({ showRightPanel: !right })} />
      <IconButton size="sm" icon={<Settings size={15} />} action="app.settings" tip="Settings" />
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} width={240}>
          <MenuList items={appMenu()} onClose={() => setMenu(null)} />
        </Popover>
      )}
    </div>
  );
}

/* ================================================================== toasts */

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.color ? <span className="tcolor" style={{ background: t.color }} /> : <span className="tdot" />}
          <span>{t.text}</span>
          {t.action && (
            <button className="btn ghost" style={{ height: 22, color: '#fff' }} onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ================================================================= dialogs */

export function DialogHost() {
  const cur = useDialog((s) => s.current);
  const close = useDialog((s) => s.close);
  const [value, setValue] = useState('');
  useEffect(() => setValue(cur?.input?.value ?? ''), [cur]);
  if (!cur) return null;
  const primary = cur.buttons.find((b) => b.primary) ?? cur.buttons[cur.buttons.length - 1];
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close('cancel')}>
      <div
        className="modal sm"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close('cancel');
          if (e.key === 'Enter') close(primary.value, value);
        }}
      >
        <div className="modal-body" style={{ paddingTop: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 650 }}>{cur.title}</div>
          {cur.message && <div className="hint" style={{ marginTop: 6, fontSize: 12 }}>{cur.message}</div>}
          {cur.input && <input className="text-input" style={{ marginTop: 12 }} autoFocus value={value} placeholder={cur.input.placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />}
        </div>
        <div className="modal-foot">
          {cur.buttons.map((b) => (
            <button key={b.value} className={`btn ${b.primary ? 'primary' : b.danger ? 'danger' : ''}`} autoFocus={!cur.input && b === primary} onClick={() => close(b.value, value)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ExportDialog() {
  const open = useUI((s) => s.exportOpen);
  if (!open) return null;
  const close = () => useUI.getState().set({ exportOpen: false });
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal" style={{ width: 'min(900px, calc(100vw - 48px))', height: 'min(640px, calc(100vh - 80px))' }}>
        <div className="modal-head">
          <h2>Export</h2>
          <button className="icon-btn sm" onClick={close} autoFocus>
            <X size={15} />
          </button>
        </div>
        <ExportBrowser />
      </div>
    </div>
  );
}

/* ================================================================= present */

export function Presenter() {
  const open = useUI((s) => s.present);
  const index = useUI((s) => s.presentIndex);
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const page = getPage(doc, pageId);
  const frames = (page?.children ?? []).filter((id) => doc.nodes[id]?.type === 'frame' && doc.nodes[id]?.visible);
  const id = frames[Math.min(index, frames.length - 1)];
  useEffect(() => {
    if (!open || !id) return;
    let cancelled = false;
    const n = doc.nodes[id];
    const scale = Math.min((window.innerWidth * devicePixelRatio) / n.width, (window.innerHeight * devicePixelRatio) / n.height);
    void renderToCanvas(doc, pageId, [id], { scale }).then((c) => {
      if (cancelled || !ref.current) return;
      const target = ref.current;
      target.width = c.width;
      target.height = c.height;
      target.style.width = `${c.width / devicePixelRatio}px`;
      target.style.height = `${c.height / devicePixelRatio}px`;
      target.getContext('2d')!.drawImage(c, 0, 0);
    });
    return () => {
      cancelled = true;
    };
  }, [open, id, doc, pageId]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      const set = useUI.getState().set;
      if (e.key === 'Escape') set({ present: false });
      else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') set({ presentIndex: Math.min(frames.length - 1, index + 1) });
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') set({ presentIndex: Math.max(0, index - 1) });
    };
    window.addEventListener('keydown', onKey);
    void document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [open, index, frames.length]);
  if (!open) return null;
  const set = useUI.getState().set;
  return (
    <div className="present" onClick={() => set({ presentIndex: Math.min(frames.length - 1, index + 1) })}>
      {id ? <canvas ref={ref} /> : <div style={{ color: '#aaa' }}>Add frames to this page to present them.</div>}
      <div className="present-bar" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn sm" onClick={() => set({ presentIndex: Math.max(0, index - 1) })}>
          <ChevronLeft size={15} />
        </button>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {frames.length ? index + 1 : 0} / {frames.length}
        </span>
        <button className="icon-btn sm" onClick={() => set({ presentIndex: Math.min(frames.length - 1, index + 1) })}>
          <ChevronRight size={15} />
        </button>
        <button className="icon-btn sm" onClick={() => set({ present: false })}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

/* ================================================================= welcome */

export function Welcome() {
  const empty = useEditor((s) => Object.keys(s.doc.nodes).length === 0 && s.doc.pages.length === 1);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!empty) setHidden(false);
  }, [empty]);
  if (!empty || hidden) return null;
  const tile = (icon: React.ReactNode, title: string, desc: string, run: () => void) => (
    <button className="welcome-tile" onClick={run}>
      <span className="wt-icon">{icon}</span>
      <span>
        <div className="wt-title">{title}</div>
        <div className="wt-desc">{desc}</div>
      </span>
    </button>
  );
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="row" style={{ justifyContent: 'space-between', margin: 0 }}>
          <span className="logo-mark" style={{ width: 34, height: 34, borderRadius: 10 }}>
            <AltLogo size={19} />
          </span>
          <button className="icon-btn sm" onClick={() => setHidden(true)}>
            <X size={14} />
          </button>
        </div>
        <h1>Make anything.</h1>
        <p>Design interfaces, paint, draw pixel art and export to the web, native apps and game engines — or let an AI agent drive Alt through MCP.</p>
        <div className="welcome-grid">
          {tile(<Frame size={16} />, 'New frame', 'Press F and drag', () => editor().setTool('frame'))}
          {tile(<Brush size={16} />, 'Start drawing', 'Pressure brushes', () => editor().setTool('brush'))}
          {tile(<PixelIcon size={16} />, 'Pixel art', '32×32 sprite', () => editor().setTool('pixel'))}
          {tile(<Sparkles size={16} />, 'Try a template', 'Mobile app UI', () => TEMPLATES[0].create())}
          {tile(<FolderOpen size={16} />, 'Open file', '.alt documents', () => runAction('file.open'))}
          {tile(<Plug size={16} />, 'Connect an agent', 'MCP in one click', () => runAction('help.mcp'))}
        </div>
      </div>
    </div>
  );
}

/* =============================================================== statusbar */

export function StatusBar() {
  const sel = useEditor((s) => s.selection.length);
  const nodes = useEditor((s) => Object.keys(s.doc.nodes).length);
  const outline = useSettings((s) => s.outlineMode);
  return (
    <div className="statusbar">
      {outline && <span className="badge">Outline</span>}
      <span>{sel ? `${sel} selected · ` : ''}{nodes} layers</span>
    </div>
  );
}
