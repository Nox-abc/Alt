import { useEffect, useMemo, useState } from 'react';
import { zipSync, strToU8 } from 'fflate';
import type { ExportSetting, ID, SceneNode } from '../../core/types';
import { editor, useEditor } from '../../core/store';
import { uid } from '../../core/doc';
import { EXPORTERS, exportRoots, getExporter, type ExportFile, type Exporter } from '../../export';
import { rasterize } from '../../render/rasterize';
import { saveFile } from '../../platform/native';
import { NumberField, Section, Select, IconButton, Switch } from '../controls';
import { Plus, Minus, Download, Copy, Check, Code, FileImage, Gamepad2, Smartphone, Globe, FileBraces, Sparkles } from '../icons';
import { toast } from '../toast';
import { useUI } from '../uiStore';
import { copyText } from '../../editor/clipboard';

/* -------------------------------------------------------------- running */

export async function runExporter(ex: Exporter, ids: ID[], options: Record<string, unknown> = {}): Promise<ExportFile[]> {
  const s = editor();
  const defaults = Object.fromEntries((ex.options ?? []).map((o) => [o.key, o.default]));
  return ex.run({
    doc: s.doc,
    ids: ids.length ? exportRoots(s.doc, s.pageId, ids) : [],
    pageId: s.pageId,
    options: { ...defaults, ...options },
    rasterize: (i, o) => rasterize(s.doc, s.pageId, i, o),
  });
}

function bytes(f: ExportFile): Uint8Array {
  return typeof f.data === 'string' ? strToU8(f.data) : f.data;
}

export async function saveExportFiles(files: ExportFile[], baseName: string): Promise<string | null> {
  if (!files.length) {
    toast('Nothing to export', { kind: 'error' });
    return null;
  }
  if (files.length === 1) {
    const f = files[0];
    const ext = f.name.split('.').pop() ?? 'bin';
    return saveFile({ defaultName: f.name, data: typeof f.data === 'string' ? f.data : f.data, mime: f.mime, filters: [{ name: ext.toUpperCase(), extensions: [ext] }], saveAs: true });
  }
  const used = new Set<string>();
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    let name = f.name;
    let k = 2;
    while (used.has(name)) name = f.name.replace(/(\.[^.]+)?$/, ` ${k++}$1`);
    used.add(name);
    entries[name] = bytes(f);
  }
  const zip = zipSync(entries, { level: 6 });
  return saveFile({ defaultName: `${baseName}.zip`, data: zip, mime: 'application/zip', filters: [{ name: 'Zip archive', extensions: ['zip'] }], saveAs: true });
}

export function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'export';
}

/* ------------------------------------------------- per-node export section */

export function ExportSection({ nodes }: { nodes: SceneNode[] }) {
  const [busy, setBusy] = useState(false);
  const settings: ExportSetting[] = nodes.length === 1 ? nodes[0].exportSettings : [];
  const target = nodes.length ? nodes.map((n) => n.id) : [];
  const label = nodes.length === 0 ? 'page' : nodes.length === 1 ? `“${nodes[0].name}”` : `${nodes.length} layers`;
  const [local, setLocal] = useState<ExportSetting[]>([{ id: 'default', format: 'png', scale: 2, suffix: '@2x' }]);
  const list = nodes.length === 1 ? settings : local;
  const setList = (l: ExportSetting[]) => {
    if (nodes.length === 1) editor().mutate((d) => void (d.nodes[nodes[0].id].exportSettings = l), { label: 'Export settings' });
    else setLocal(l);
  };
  const add = () => setList([...list, { id: uid(), format: 'png', scale: list.length ? list[list.length - 1].scale * 2 : 1, suffix: '' }]);
  const run = async () => {
    setBusy(true);
    try {
      const effective = list.length ? list : [{ id: 'x', format: 'png' as const, scale: 1, suffix: '' }];
      const files: ExportFile[] = [];
      const s = editor();
      const roots = target.length ? exportRoots(s.doc, s.pageId, target) : [];
      for (const st of effective) {
        const ex = getExporter(st.format);
        if (!ex) continue;
        if (roots.length > 1) {
          for (const id of roots) {
            const out = await runExporter(ex, [id], { scale: st.scale });
            const name = safeName(s.doc.nodes[id]?.name ?? 'layer');
            files.push(...out.map((f) => ({ ...f, name: `${name}${st.suffix}.${f.name.split('.').pop()}` })));
          }
        } else {
          const out = await runExporter(ex, roots, { scale: st.scale });
          const name = safeName(roots.length ? s.doc.nodes[roots[0]]?.name ?? 'export' : s.doc.name);
          files.push(...out.map((f) => ({ ...f, name: out.length > 1 ? f.name : `${name}${st.suffix}.${f.name.split('.').pop()}` })));
        }
      }
      const path = await saveExportFiles(files, safeName(nodes.length === 1 ? nodes[0].name : editor().doc.name));
      if (path) toast(`Exported ${files.length} file${files.length > 1 ? 's' : ''}`, { kind: 'success' });
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Export"
      actions={
        <>
          <IconButton size="sm" icon={<Sparkles size={14} />} tip="More formats — HTML, React, Roblox, SwiftUI…" onClick={() => useUI.getState().set({ exportOpen: true })} />
          <IconButton size="sm" icon={<Plus size={15} />} tip="Add export setting" onClick={add} />
        </>
      }
    >
      {list.map((st, i) => (
        <div className="row" key={st.id}>
          <Select
            value={String(st.scale)}
            style={{ width: 64 }}
            options={['0.5', '0.75', '1', '1.5', '2', '3', '4'].map((v) => ({ value: v, label: `${v}x` }))}
            onChange={(v) => setList(list.map((x, j) => (j === i ? { ...x, scale: +v, suffix: +v === 1 ? '' : `@${v}x` } : x)))}
          />
          <input className="text-input flex1" placeholder="Suffix" value={st.suffix} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, suffix: e.target.value } : x)))} />
          <Select<ExportSetting['format']>
            value={st.format}
            style={{ width: 70 }}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpg', label: 'JPG' },
              { value: 'webp', label: 'WEBP' },
              { value: 'svg', label: 'SVG' },
              { value: 'pdf', label: 'PDF' },
            ]}
            onChange={(v) => setList(list.map((x, j) => (j === i ? { ...x, format: v } : x)))}
          />
          <IconButton size="sm" icon={<Minus size={14} />} onClick={() => setList(list.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button className="btn block" style={{ marginTop: 8 }} disabled={busy} onClick={run}>
        <Download size={14} /> {busy ? 'Exporting…' : `Export ${label}`}
      </button>
    </Section>
  );
}

/* ------------------------------------------------------------- code tab */

const GROUP_ICONS: Record<string, React.ReactNode> = {
  Image: <FileImage size={14} />,
  Vector: <FileImage size={14} />,
  Web: <Globe size={14} />,
  Native: <Smartphone size={14} />,
  'Game engines': <Gamepad2 size={14} />,
  Data: <FileBraces size={14} />,
};

export function CodePanel() {
  const textual = EXPORTERS.filter((e) => e.textual);
  const [id, setId] = useState(() => localStorage.getItem('alt.codeFormat') ?? 'html');
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const [out, setOut] = useState<{ name: string; text: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ex = getExporter(id) ?? textual[0];
  useEffect(() => {
    let cancelled = false;
    if (!ex) return;
    const t = setTimeout(async () => {
      try {
        const files = await runExporter(ex, selection);
        if (cancelled) return;
        setOut(files.filter((f) => typeof f.data === 'string').map((f) => ({ name: f.name, text: f.data as string })));
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [doc, selection, ex]);
  return (
    <div>
      <div className="section">
        <div className="row">
          <Select
            className="flex1"
            value={ex?.id ?? ''}
            icon={<Code size={14} />}
            options={textual.map((e, i) => ({ value: e.id, label: e.label, separatorBefore: i > 0 && textual[i - 1].group !== e.group }))}
            onChange={(v) => {
              setId(v);
              localStorage.setItem('alt.codeFormat', v);
            }}
          />
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {selection.length ? `Generated for ${selection.length} selected layer${selection.length > 1 ? 's' : ''}.` : 'Nothing selected — showing the whole page.'} {ex?.description}
        </div>
      </div>
      {err && <div className="section hint" style={{ color: 'var(--danger)' }}>{err}</div>}
      {out.map((f) => (
        <div className="section" key={f.name}>
          <div className="section-head">
            <span className="title muted" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
              {f.name}
            </span>
            <span className="actions">
              <IconButton
                size="sm"
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                tip="Copy"
                onClick={() => {
                  void copyText(f.text, 'Code copied');
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
              />
            </span>
          </div>
          <div className="code" style={{ maxHeight: 420 }}>
            {f.text.length > 60000 ? f.text.slice(0, 60000) + '\n… (truncated)' : f.text}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- export dialog */

export function ExportBrowser({ compact }: { compact?: boolean }) {
  const selection = useEditor((s) => s.selection);
  const docName = useEditor((s) => s.doc.name);
  const [id, setId] = useState('png');
  const ex = getExporter(id) ?? EXPORTERS[0];
  const [opts, setOpts] = useState<Record<string, Record<string, unknown>>>({});
  const values = { ...Object.fromEntries((ex.options ?? []).map((o) => [o.key, o.default])), ...(opts[ex.id] ?? {}) };
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const g = new Map<string, Exporter[]>();
    for (const e of EXPORTERS) g.set(e.group, [...(g.get(e.group) ?? []), e]);
    return [...g.entries()];
  }, []);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    if (!ex.textual) return;
    runExporter(ex, selection, values)
      .then((files) => {
        if (cancelled) return;
        const f = files.find((x) => typeof x.data === 'string');
        setPreview(f ? (f.data as string) : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, selection, JSON.stringify(values)]);
  const doExport = async () => {
    setBusy(true);
    try {
      const files = await runExporter(ex, selection, values);
      const base = safeName(selection.length === 1 ? editor().doc.nodes[selection[0]]?.name ?? docName : docName);
      const renamed = files.length === 1 ? [{ ...files[0], name: files[0].name.startsWith('export') || files[0].name.startsWith('Untitled') ? `${base}.${files[0].name.split('.').pop()}` : files[0].name }] : files;
      const p = await saveExportFiles(renamed, `${base}-${ex.id}`);
      if (p) toast(`Exported ${ex.label}`, { kind: 'success' });
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="split" style={{ gridTemplateColumns: compact ? '1fr' : '210px 1fr' }}>
      <div className="split-nav">
        {groups.map(([g, list]) => (
          <div key={g}>
            <div className="nav-group">{g}</div>
            {list.map((e) => (
              <div key={e.id} className={`nav-item ${e.id === ex.id ? 'on' : ''}`} onClick={() => setId(e.id)}>
                {GROUP_ICONS[g] ?? <Code size={14} />}
                <span>{e.label}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="split-body">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="flex1">
            <div style={{ fontSize: 15, fontWeight: 650 }}>{ex.label}</div>
            <div className="hint" style={{ marginTop: 4 }}>
              {ex.description}
            </div>
          </div>
          <span className="badge">.{ex.extension}</span>
        </div>
        <div className="hint" style={{ margin: '12px 0' }}>
          {selection.length ? `Exporting ${selection.length} selected layer${selection.length > 1 ? 's' : ''}.` : 'Nothing selected — exporting every top-level layer on this page.'}
        </div>
        {(ex.options ?? []).map((o) => (
          <div className="setting" key={o.key}>
            <div className="s-text">
              <div className="s-title">{o.label}</div>
            </div>
            {o.type === 'boolean' ? (
              <Switch on={!!values[o.key]} onChange={(v) => setOpts({ ...opts, [ex.id]: { ...values, [o.key]: v } })} />
            ) : o.type === 'select' ? (
              <Select value={String(values[o.key])} options={(o.options ?? []).map((x) => ({ value: x.value, label: x.label }))} onChange={(v) => setOpts({ ...opts, [ex.id]: { ...values, [o.key]: v } })} style={{ width: 200 }} />
            ) : o.type === 'number' ? (
              <NumberField value={Number(values[o.key])} min={o.min} max={o.max} step={o.step ?? 1} onChange={(v) => setOpts({ ...opts, [ex.id]: { ...values, [o.key]: v } })} width={110} />
            ) : (
              <input className="text-input" style={{ width: 200 }} value={String(values[o.key] ?? '')} onChange={(e) => setOpts({ ...opts, [ex.id]: { ...values, [o.key]: e.target.value } })} />
            )}
          </div>
        ))}
        {preview && (
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="label flex1">Preview</span>
              <button className="btn ghost" onClick={() => void copyText(preview, 'Copied to clipboard')}>
                <Copy size={13} /> Copy
              </button>
            </div>
            <div className="code" style={{ maxHeight: 300 }}>
              {preview.length > 40000 ? preview.slice(0, 40000) + '\n…' : preview}
            </div>
          </div>
        )}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy} onClick={doExport}>
            <Download size={14} /> {busy ? 'Exporting…' : `Export ${ex.label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
