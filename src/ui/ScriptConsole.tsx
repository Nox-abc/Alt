import { useEffect, useState } from 'react';
import { useUI } from './uiStore';
import { Select } from './controls';
import { X, Play, Save, Trash, Code } from './icons';
import { toast } from './toast';
import { promptDialog } from './dialog';

interface SavedScript {
  name: string;
  code: string;
}

/** Built-in examples – double as documentation for the `alt` API. */
export const EXAMPLES: SavedScript[] = [
  {
    name: 'Randomise fill colours of the selection',
    code: `// Give every selected layer a random pastel fill
const ids = alt.selection;
if (!ids.length) return 'Select some layers first';
const pastel = (h) => {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = 0.75 - 0.175 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
};
alt.mutate((d) => {
  for (const id of ids) d.nodes[id].fills = [alt.util.solid(pastel(Math.random() * 360))];
}, 'Random colours');
return \`Recoloured \${ids.length} layers\`;`,
  },
  {
    name: 'Generate a dot grid',
    code: `// 12 × 8 grid of circles with a hue sweep
const nodes = [];
for (let y = 0; y < 8; y++)
  for (let x = 0; x < 12; x++)
    nodes.push({ type: 'ellipse', name: \`Dot \${x},\${y}\`, x: x * 36, y: y * 36, width: 24, height: 24, fill: \`hsl(\${(x * 30 + y * 12) % 360}, 80%, 60%)\` });
const created = await alt.create({ type: 'frame', name: 'Dot grid', width: 440, height: 296, fill: '#0E0E12', children: nodes.map((n) => ({ ...n, x: n.x + 16, y: n.y + 16 })) });
return created;`,
  },
  {
    name: 'Rename selected layers sequentially',
    code: `// "Item 1", "Item 2", … in layer order
const base = 'Item';
alt.mutate((d) => alt.selection.forEach((id, i) => (d.nodes[id].name = \`\${base} \${i + 1}\`)), 'Rename');
return alt.selection.length + ' layers renamed';`,
  },
  {
    name: 'List every text layer on this page',
    code: `return alt.find({ type: 'text' }).map((n) => ({ id: n.id, name: n.name, text: n.text }));`,
  },
  {
    name: 'Create a colour palette from the selection',
    code: `// Collect solid fills from the selection and save them as colour styles
const colours = new Set();
for (const id of alt.selection) for (const p of alt.getNode(id)?.fills ?? []) if (p.type === 'solid') colours.add(p.color);
alt.mutate((d) => {
  let i = d.styles.colors.length;
  for (const c of colours) d.styles.colors.push({ id: alt.util.uid(), name: 'Palette ' + ++i, paint: alt.util.solid(c) });
}, 'Palette');
return [...colours];`,
  },
];

const KEY = 'alt.scripts';

function loadSaved(): SavedScript[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function ScriptConsole() {
  const open = useUI((s) => s.settings === 'scripts');
  const [saved, setSaved] = useState<SavedScript[]>(loadSaved);
  const [code, setCode] = useState(() => localStorage.getItem('alt.scriptDraft') ?? EXAMPLES[0].code);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    localStorage.setItem('alt.scriptDraft', code);
  }, [code]);
  if (!open) return null;
  const close = () => useUI.getState().set({ settings: null });
  const run = async () => {
    setBusy(true);
    const { runLocalScript } = await import('../api/mcpHandlers');
    const r = await runLocalScript(code);
    setBusy(false);
    let text = r.text;
    try {
      const j = JSON.parse(r.text);
      text = [j.logs?.length ? j.logs.join('\n') : '', j.result !== null && j.result !== undefined ? JSON.stringify(j.result, null, 2) : ''].filter(Boolean).join('\n\n') || 'Done.';
    } catch {
      /* plain text */
    }
    setOut({ ok: r.ok, text });
  };
  const save = async () => {
    const name = await promptDialog('Save script as', saved.find((s) => s.code === code)?.name ?? 'My script');
    if (!name) return;
    const next = [...saved.filter((s) => s.name !== name), { name, code }];
    setSaved(next);
    localStorage.setItem(KEY, JSON.stringify(next));
    toast(`Saved “${name}”`, { kind: 'success' });
  };
  const all = [...saved.map((s) => ({ ...s, user: true })), ...EXAMPLES.map((s) => ({ ...s, user: false }))];
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 'min(860px, calc(100vw - 48px))', height: 'min(640px, calc(100vh - 80px))' }} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="modal-head">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Code size={15} /> Script console
          </h2>
          <button className="icon-btn sm" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
          <div className="row" style={{ margin: 0 }}>
            <Select
              className="flex1"
              value={null}
              placeholder="Load a script or example…"
              options={all.map((s, i) => ({ value: String(i), label: `${s.user ? '★ ' : ''}${s.name}`, separatorBefore: i === saved.length && saved.length > 0 }))}
              onChange={(v) => {
                setCode(all[+v].code);
                setOut(null);
              }}
            />
            {saved.some((s) => s.code === code) && (
              <button
                className="btn ghost"
                onClick={() => {
                  const next = saved.filter((s) => s.code !== code);
                  setSaved(next);
                  localStorage.setItem(KEY, JSON.stringify(next));
                }}
              >
                <Trash size={13} /> Delete
              </button>
            )}
            <button className="btn" onClick={() => void save()}>
              <Save size={13} /> Save
            </button>
            <button className="btn primary" disabled={busy} onClick={run} data-tip="Run" data-key="Ctrl+Enter">
              <Play size={13} /> {busy ? 'Running…' : 'Run'}
            </button>
          </div>
          <textarea
            className="text-input"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: a, selectionEnd: b } = el;
                setCode(code.slice(0, a) + '  ' + code.slice(b));
                requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
              }
              if (e.key === 'Escape') close();
            }}
            style={{ flex: 1, minHeight: 220, resize: 'none' }}
          />
          <div className="hint">
            Scripts get an <code>alt</code> object: <code>doc</code>, <code>selection</code>, <code>page</code>, <code>getNode(id)</code>, <code>find(&#123;type, name, text&#125;)</code>, <code>create(spec)</code>, <code>update(ids, props)</code>, <code>remove(ids)</code>, <code>select(ids)</code>,{' '}
            <code>mutate(draft =&gt; …)</code> (one undo step), <code>call(tool, args)</code> for any MCP tool, plus <code>ops</code> and <code>util</code>. <code>return</code> a value to print it.
          </div>
          {out && (
            <div className="code wrap" style={{ maxHeight: 160, color: out.ok ? undefined : 'var(--danger)' }}>
              {out.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
