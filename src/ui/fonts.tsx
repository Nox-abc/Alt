import { useMemo, useState } from 'react';
import { useSettings } from '../editor/settings';
import { Popover } from './controls';
import { ChevronDown, Search, Check } from './icons';
import { toast } from './toast';

export const BUILTIN_FONTS = ['Inter', 'JetBrains Mono'];

export const COMMON_FONTS = [
  'system-ui',
  'Arial',
  'Helvetica',
  'Helvetica Neue',
  'SF Pro Display',
  'SF Pro Text',
  'Segoe UI',
  'Roboto',
  'Ubuntu',
  'Cantarell',
  'Noto Sans',
  'Open Sans',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Palatino',
  'Garamond',
  'Courier New',
  'Menlo',
  'Consolas',
  'Impact',
  'Comic Sans MS',
  'Brush Script MT',
];

export const WEIGHTS = [
  { value: 100, label: 'Thin' },
  { value: 200, label: 'Extra Light' },
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semi Bold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' },
];

export async function loadLocalFonts(): Promise<number> {
  const q = (window as any).queryLocalFonts;
  if (!q) {
    toast('Local font access is not available here', { kind: 'error' });
    return 0;
  }
  try {
    const fonts: { family: string }[] = await q();
    const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    useSettings.getState().set({ fontList: families });
    toast(`Loaded ${families.length} local font families`, { kind: 'success' });
    return families.length;
  } catch {
    toast('Permission to read local fonts was denied', { kind: 'error' });
    return 0;
  }
}

export function useFontList(): string[] {
  const local = useSettings((s) => s.fontList);
  return useMemo(() => [...new Set([...BUILTIN_FONTS, ...COMMON_FONTS, ...local])], [local]);
}

export function FontPicker({ value, onChange }: { value: string | 'mixed'; onChange: (f: string) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [q, setQ] = useState('');
  const fonts = useFontList();
  const local = useSettings((s) => s.fontList);
  const list = fonts.filter((f) => f.toLowerCase().includes(q.toLowerCase())).slice(0, 400);
  return (
    <>
      <button className="select flex1" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <span className="value" style={{ fontFamily: value === 'mixed' ? undefined : `"${value}", var(--font)` }}>
          {value === 'mixed' ? 'Mixed' : value}
        </span>
        <ChevronDown size={13} className="chev" />
      </button>
      {anchor && (
        <Popover anchor={anchor} placement="left" offset={10} width={250} onClose={() => setAnchor(null)}>
          <div className="field" style={{ margin: 2, marginBottom: 6 }}>
            <span className="prefix static">
              <Search size={13} />
            </span>
            <input autoFocus placeholder="Search fonts" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {list.map((f) => (
              <div
                key={f}
                className="menu-item"
                onClick={() => {
                  onChange(f);
                  setAnchor(null);
                }}
              >
                <span className="mi-icon">{f === value ? <Check size={13} /> : null}</span>
                <span className="mi-label" style={{ fontFamily: `"${f}", var(--font)`, fontSize: 13 }}>
                  {f}
                </span>
              </div>
            ))}
          </div>
          {!local.length && 'queryLocalFonts' in window && (
            <>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => void loadLocalFonts()}>
                <span className="mi-icon" />
                <span className="mi-label">Load installed fonts…</span>
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}
