import { useEffect, useMemo, useState } from 'react';
import { ACCENTS, useSettings, type Settings } from '../editor/settings';
import { ACTIONS, eventCombo, formatKeys, keysFor } from '../editor/actions';
import { native, openExternal, type McpStatus } from '../platform/native';
import { useUI } from './uiStore';
import { NumberField, Segmented, Select, Switch } from './controls';
import { Palette, Monitor, Keyboard, Plug, Info, X, Copy, Check, Sun, Moon, RefreshCw, Search, Sparkles, ExternalLink } from './icons';
import { copyText } from '../editor/clipboard';
import { loadLocalFonts } from './fonts';

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="s-text">
        <div className="s-title">{title}</div>
        {desc && <div className="s-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function Appearance() {
  const s = useSettings();
  return (
    <>
      <Row title="Theme" desc="Follow the system or pick a side.">
        <Segmented
          value={s.theme}
          options={[
            { value: 'dark', label: <span className="row" style={{ gap: 5, margin: 0, minHeight: 0 }}><Moon size={13} /> Dark</span> },
            { value: 'light', label: <span className="row" style={{ gap: 5, margin: 0, minHeight: 0 }}><Sun size={13} /> Light</span> },
            { value: 'system', label: <span className="row" style={{ gap: 5, margin: 0, minHeight: 0 }}><Monitor size={13} /> Auto</span> },
          ]}
          onChange={(theme) => s.set({ theme })}
        />
      </Row>
      <Row title="Accent colour" desc="Used for selection, focus and active tools.">
        <div className="row" style={{ gap: 6 }}>
          {ACCENTS.map((c) => (
            <span key={c} className="swatch" style={{ width: 22, height: 22, borderRadius: 11, boxShadow: s.accent === c ? '0 0 0 2px var(--bg-panel), 0 0 0 4px ' + c : undefined }} onClick={() => s.set({ accent: c })}>
              <i style={{ background: c }} />
            </span>
          ))}
          <label className="swatch" style={{ width: 22, height: 22, borderRadius: 11 }} data-tip="Custom">
            <i style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }} />
            <input type="color" value={s.accent} onChange={(e) => s.set({ accent: e.target.value.toUpperCase() })} style={{ opacity: 0, position: 'absolute', inset: 0 }} />
          </label>
        </div>
      </Row>
      <Row title="Interface scale" desc="Make the UI denser or roomier.">
        <Select
          value={String(s.uiScale)}
          style={{ width: 120 }}
          options={['0.85', '0.9', '1', '1.1', '1.2', '1.35'].map((v) => ({ value: v, label: `${Math.round(+v * 100)}%` }))}
          onChange={(v) => s.set({ uiScale: +v })}
        />
      </Row>
      <Row title="Toolbar position">
        <Segmented
          value={s.toolbarPosition}
          options={[
            { value: 'bottom', label: 'Bottom' },
            { value: 'top', label: 'Top' },
          ]}
          onChange={(toolbarPosition) => s.set({ toolbarPosition })}
        />
      </Row>
      <Row title="Canvas colour (dark)" desc="Leave empty for the default.">
        <input className="text-input" style={{ width: 120 }} placeholder="#1A1A1D" defaultValue={s.canvasDark} onBlur={(e) => s.set({ canvasDark: e.target.value.trim() })} />
      </Row>
      <Row title="Canvas colour (light)">
        <input className="text-input" style={{ width: 120 }} placeholder="#F2F2F4" defaultValue={s.canvasLight} onBlur={(e) => s.set({ canvasLight: e.target.value.trim() })} />
      </Row>
      <Row title="Reduce motion" desc="Turn off interface animations.">
        <Switch on={s.reduceMotion} onChange={(reduceMotion) => s.set({ reduceMotion })} />
      </Row>
      <Row title="Installed fonts" desc={s.fontList.length ? `${s.fontList.length} local families available.` : 'Let Alt list the fonts installed on this computer.'}>
        <button className="btn" onClick={() => void loadLocalFonts()}>
          <RefreshCw size={13} /> {s.fontList.length ? 'Reload' : 'Load fonts'}
        </button>
      </Row>
    </>
  );
}

function CanvasSettings() {
  const s = useSettings();
  const t = (key: keyof Settings, title: string, desc?: string) => (
    <Row title={title} desc={desc}>
      <Switch on={!!s[key]} onChange={(v) => s.set({ [key]: v } as Partial<Settings>)} />
    </Row>
  );
  return (
    <>
      {t('snapToObjects', 'Smart guides', 'Snap to the edges and centres of nearby layers.')}
      {t('snapToPixels', 'Snap to pixel grid', 'Round positions and sizes to whole pixels.')}
      {t('snapToGrid', 'Snap to grid')}
      <Row title="Grid size">
        <NumberField value={s.gridSize} min={1} precision={0} onChange={(gridSize) => s.set({ gridSize })} width={90} />
      </Row>
      {t('showPixelGrid', 'Pixel grid', 'Show a pixel grid when zoomed beyond 800%.')}
      {t('showRulers', 'Rulers')}
      {t('showFrameLabels', 'Frame names on canvas')}
      {t('outlineMode', 'Outline mode', 'Show wireframes instead of rendered content.')}
      <Row title="Nudge amount" desc="Arrow keys / Shift + arrow keys.">
        <div className="row" style={{ gap: 6 }}>
          <NumberField value={s.nudge} min={0.1} onChange={(nudge) => s.set({ nudge })} width={70} />
          <NumberField value={s.bigNudge} min={1} onChange={(bigNudge) => s.set({ bigNudge })} width={70} />
        </div>
      </Row>
      {t('wheelZoom', 'Scroll wheel zooms', 'For mouse users: the wheel zooms, Shift + wheel pans.')}
      {t('invertZoom', 'Invert zoom direction')}
      {t('autosave', 'Crash recovery', 'Keep a local recovery copy of your work.')}
    </>
  );
}

function Shortcuts() {
  const keymap = useSettings((s) => s.keymap);
  const set = useSettings((s) => s.set);
  const [q, setQ] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Shift', 'Alt', 'Meta', 'Control'].includes(e.key)) return;
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const combo = e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.shiftKey ? '' : eventCombo(e);
      set({ keymap: { ...keymap, [recording]: combo } });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, keymap, set]);
  const list = ACTIONS.filter((a) => !a.hidden && (a.label + a.group).toLowerCase().includes(q.toLowerCase()));
  const conflicts = useMemo(() => {
    const seen = new Map<string, string>();
    const bad = new Set<string>();
    for (const a of ACTIONS) for (const k of keysFor(a.id)) {
      if (seen.has(k)) bad.add(a.id).add(seen.get(k)!);
      else seen.set(k, a.id);
    }
    return bad;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keymap]);
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="field flex1">
          <span className="prefix static">
            <Search size={13} />
          </span>
          <input placeholder="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {Object.keys(keymap).length > 0 && (
          <button className="btn ghost" onClick={() => set({ keymap: {} })}>
            Reset all
          </button>
        )}
      </div>
      {list.map((a) => {
        const keys = keysFor(a.id);
        return (
          <div className="setting" key={a.id} style={{ padding: '7px 0' }}>
            <div className="s-text">
              <div className="s-title" style={{ fontWeight: 500 }}>
                {a.label}
              </div>
            </div>
            <span className="muted" style={{ width: 70 }}>
              {a.group}
            </span>
            <button className="btn ghost" style={{ minWidth: 120, justifyContent: 'flex-end' }} onClick={() => setRecording(a.id)} data-tip="Click, then press a new shortcut (Backspace clears)">
              {recording === a.id ? (
                <span style={{ color: 'var(--accent)' }}>Press keys…</span>
              ) : keys.length ? (
                keys.slice(0, 2).map((k) => (
                  <span key={k} className="kbd" style={{ borderColor: conflicts.has(a.id) ? 'var(--danger)' : undefined, color: conflicts.has(a.id) ? 'var(--danger)' : undefined }}>
                    {formatKeys(k)}
                  </span>
                ))
              ) : (
                <span className="muted">—</span>
              )}
            </button>
          </div>
        );
      })}
    </>
  );
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="s-title flex1">{label}</span>
        <button
          className="btn ghost"
          onClick={() => {
            void copyText(text, 'Copied');
            setOk(true);
            setTimeout(() => setOk(false), 1200);
          }}
        >
          {ok ? <Check size={13} /> : <Copy size={13} />} Copy
        </button>
      </div>
      <div className="code wrap">{text}</div>
    </div>
  );
}

function McpSettings() {
  const cfg = useSettings((s) => s.mcp);
  const set = useSettings((s) => s.set);
  const [status, setStatus] = useState<McpStatus | null>(null);
  useEffect(() => {
    if (!native) return;
    void native.mcp.getStatus().then(setStatus);
    return native.mcp.onStatus(setStatus);
  }, []);
  const apply = async (next: typeof cfg) => {
    set({ mcp: next });
    if (native) setStatus(await native.mcp.configure(next));
  };
  const url = status?.url ?? `http://127.0.0.1:${cfg.port}/mcp`;
  const shim = status?.stdioShim ?? '/path/to/Alt/resources/mcp/alt-mcp.mjs';
  const exe = status?.execPath ?? '/path/to/Alt';
  const stdioConfig = JSON.stringify({ mcpServers: { alt: { command: exe, args: [shim], env: { ELECTRON_RUN_AS_NODE: '1', ALT_MCP_PORT: String(cfg.port) } } } }, null, 2);
  const httpConfig = JSON.stringify({ mcpServers: { alt: { url } } }, null, 2);
  const vscode = JSON.stringify({ servers: { alt: { type: 'http', url } } }, null, 2);
  return (
    <>
      <div className="row" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
        <div className="flex1">
          <div style={{ fontSize: 15, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} /> Connect AI agents
          </div>
          <div className="hint" style={{ marginTop: 4, maxWidth: 480 }}>
            Alt ships a built-in Model Context Protocol server. Agents like Claude Code, Claude Desktop, Cursor or VS Code can read your document, create and edit layers, take screenshots and export code — every change is undoable.
          </div>
        </div>
        {native ? (
          status?.running ? (
            <span className="badge ok">
              <span className="dot" /> Running
            </span>
          ) : (
            <span className="badge err">
              <span className="dot" /> {status?.enabled === false ? 'Off' : 'Stopped'}
            </span>
          )
        ) : (
          <span className="badge">Desktop app only</span>
        )}
      </div>
      {status?.error && <div className="hint" style={{ color: 'var(--danger)', marginBottom: 6 }}>{status.error}</div>}
      <Row title="Enable MCP server" desc="Listens on 127.0.0.1 only — nothing is exposed to your network.">
        <Switch on={cfg.enabled} onChange={(enabled) => void apply({ ...cfg, enabled })} />
      </Row>
      <Row title="Port">
        <NumberField value={cfg.port} min={1024} max={65535} precision={0} onChange={(port) => void apply({ ...cfg, port: Math.round(port) })} width={100} />
      </Row>
      <Row title="Allow scripts" desc="Lets agents run JavaScript against the document API (run_script). Only enable for agents you trust.">
        <Switch on={cfg.allowScripts} onChange={(allowScripts) => void apply({ ...cfg, allowScripts })} />
      </Row>
      <CopyBlock label="Claude Code" text={`claude mcp add --transport http alt ${url}`} />
      <CopyBlock label="Cursor / Windsurf / any HTTP client (mcp.json)" text={httpConfig} />
      <CopyBlock label="VS Code (.vscode/mcp.json)" text={vscode} />
      <CopyBlock label="Claude Desktop & stdio-only clients (no Node.js needed)" text={stdioConfig} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={() => openExternal('https://modelcontextprotocol.io')}>
          <ExternalLink size={13} /> What is MCP?
        </button>
      </div>
    </>
  );
}

function About() {
  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: '-0.02em' }}>Alt</div>
      <div className="hint" style={{ marginTop: 4 }}>
        Version {native?.version ?? __APP_VERSION__} · {native ? `${native.platform} ${native.arch}` : 'web'}
      </div>
      <p style={{ color: 'var(--text-2)', lineHeight: 1.6, marginTop: 14 }}>
        A free and open-source design studio for every kind of 2D art — interfaces, illustration, painting and pixel art — with export to the web, native apps and game engines, and a built-in MCP server for AI agents.
      </p>
      <p className="hint">Released under the MIT licence. Icons by Lucide (ISC). Boolean geometry by paper.js (MIT). Brush strokes by perfect-freehand (MIT).</p>
      <button className="btn" onClick={() => openExternal('https://github.com/nox-abc/alt')}>
        <ExternalLink size={13} /> Source code
      </button>
    </div>
  );
}

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} /> },
  { id: 'canvas', label: 'Canvas', icon: <Monitor size={15} /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={15} /> },
  { id: 'mcp', label: 'AI agents (MCP)', icon: <Plug size={15} /> },
  { id: 'about', label: 'About', icon: <Info size={15} /> },
];

export function SettingsDialog() {
  const tab = useUI((s) => s.settings);
  if (!tab) return null;
  const close = () => useUI.getState().set({ settings: null });
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
      tabIndex={-1}
    >
      <div className="modal" style={{ width: 'min(820px, calc(100vw - 48px))', height: 'min(620px, calc(100vh - 80px))' }}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn sm" onClick={close} autoFocus>
            <X size={15} />
          </button>
        </div>
        <div className="split">
          <div className="split-nav">
            {TABS.map((t) => (
              <div key={t.id} className={`nav-item ${tab === t.id ? 'on' : ''}`} onClick={() => useUI.getState().set({ settings: t.id })}>
                {t.icon}
                {t.label}
              </div>
            ))}
          </div>
          <div className="split-body">
            {tab === 'appearance' && <Appearance />}
            {tab === 'canvas' && <CanvasSettings />}
            {tab === 'shortcuts' && <Shortcuts />}
            {tab === 'mcp' && <McpSettings />}
            {tab === 'about' && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}
