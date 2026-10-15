import { useEffect, useMemo, useRef, useState } from 'react';
import type { GradientPaint, GradientStop, ImageFit, Paint, PatternKind, PaintType } from '../core/types';
import { editor, useEditor } from '../core/store';
import { gradient, hexToRgb, hsvToRgb, normalizeHex, paintToCss, rgbToHex, rgbToHsl, rgbToHsv, hslToRgb, uid, walk } from '../core/doc';
import { NumberField, Popover, Select, Segmented } from './controls';
import { Pipette, Square, Image as ImageIcon, Grid2x2, Sparkles, X, RotateCw, ArrowLeftRight, Plus, Trash } from './icons';
import { openFile } from '../platform/native';
import { loadImageInfo } from '../render/assets';
import { toast } from './toast';

/* --------------------------------------------------------------- helpers */

export function paintPreview(p: Paint, doc = editor().doc): string {
  if (p.type === 'image') {
    const a = doc.assets[p.assetId];
    return a ? `center / cover no-repeat url("${a.data}")` : '#888';
  }
  if (p.type === 'diamond') return paintToCss({ ...p, type: 'radial' });
  return paintToCss(p);
}

export function paintLabel(p: Paint): string {
  switch (p.type) {
    case 'solid':
      return p.color.replace('#', '').toUpperCase();
    case 'linear':
      return 'Linear';
    case 'radial':
      return 'Radial';
    case 'angular':
      return 'Angular';
    case 'diamond':
      return 'Diamond';
    case 'image':
      return 'Image';
    case 'pattern':
      return `Pattern · ${p.pattern}`;
    case 'noise':
      return 'Noise';
  }
}

export function convertPaint(p: Paint, type: PaintType): Paint {
  if (p.type === type) return p;
  const base = { id: p.id, visible: p.visible, opacity: p.opacity, blendMode: p.blendMode };
  const firstColor = p.type === 'solid' ? p.color : 'stops' in p ? p.stops[0]?.color ?? '#000000' : 'color' in p ? (p as any).color : '#D9D9D9';
  switch (type) {
    case 'solid':
      return { ...base, type: 'solid', color: firstColor };
    case 'linear':
    case 'radial':
    case 'angular':
    case 'diamond': {
      if ('stops' in p) return { ...(p as GradientPaint), type, ...(type === 'linear' ? { from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } } : { from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } }) };
      const g = gradient(type, firstColor, firstColor);
      g.stops[1].opacity = 0;
      return { ...g, ...base, type };
    }
    case 'image':
      return { ...base, type: 'image', assetId: '', fit: 'fill', scale: 1, rotation: 0 };
    case 'pattern':
      return { ...base, type: 'pattern', pattern: 'dots', color: firstColor, background: null, scale: 16, rotation: 0, weight: 0.3 };
    case 'noise':
      return { ...base, type: 'noise', color: firstColor, background: null, density: 0.35, size: 1, seed: 7 };
  }
}

function docColors(): string[] {
  const s = editor();
  const set = new Map<string, number>();
  for (const p of s.doc.pages)
    walk(s.doc, p.children, (n) => {
      for (const paint of [...n.fills, ...n.strokes]) if (paint.type === 'solid') set.set(paint.color.toUpperCase(), (set.get(paint.color.toUpperCase()) ?? 0) + 1);
    });
  return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 20);
}

const PRESETS = ['#000000', '#FFFFFF', '#F24E1E', '#FF7262', '#FFB020', '#14AE5C', '#0D99FF', '#7C6CFF', '#E046C9', '#8A8A94'];

/* ------------------------------------------------------- colour surfaces */

function useDragSurface(onPos: (x: number, y: number) => void) {
  return (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    editor().begin('Color');
    const at = (ev: PointerEvent | React.PointerEvent) => {
      const r = el.getBoundingClientRect();
      onPos(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    };
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      editor().commit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
}

type Mode = 'hex' | 'rgb' | 'hsl' | 'hsb';

function ColorControls({ color, alpha, onChange }: { color: string; alpha: number; onChange: (hex: string, alpha: number) => void }) {
  const rgb = hexToRgb(color);
  const hsv0 = rgbToHsv(rgb.r, rgb.g, rgb.b);
  // keep hue/saturation stable when they become undefined (greys / black)
  const hsvRef = useRef(hsv0);
  const last = useRef(color);
  if (last.current.toUpperCase() !== color.toUpperCase()) {
    hsvRef.current = { h: hsv0.s === 0 || hsv0.v === 0 ? hsvRef.current.h : hsv0.h, s: hsv0.v === 0 ? hsvRef.current.s : hsv0.s, v: hsv0.v };
    last.current = color;
  }
  const hsv = hsvRef.current;
  const [mode, setMode] = useState<Mode>('hex');
  const setHsv = (h: number, s: number, v: number, a = alpha) => {
    hsvRef.current = { h, s, v };
    const c = hsvToRgb(h, s, v);
    const hex = rgbToHex(c.r, c.g, c.b);
    last.current = hex;
    onChange(hex, a);
  };
  const sv = useDragSurface((x, y) => setHsv(hsv.h, x, 1 - y));
  const hue = useDragSurface((x) => setHsv(Math.min(359.9, x * 360), hsv.s, hsv.v));
  const alphaDrag = useDragSurface((x) => onChange(color, Math.round(x * 100) / 100));
  const pure = hsvToRgb(hsv.h, 1, 1);
  const pureHex = rgbToHex(pure.r, pure.g, pure.b);
  const [hexText, setHexText] = useState(color.replace('#', ''));
  useEffect(() => setHexText(color.replace('#', '').toUpperCase()), [color]);

  const eyedrop = async () => {
    const ED = (window as any).EyeDropper;
    if (!ED) {
      toast('Use the eyedropper tool (I) on the canvas', { kind: 'info' });
      editor().setTool('eyedropper');
      return;
    }
    try {
      const r = await new ED().open();
      const hex = normalizeHex(r.sRGBHex) ?? color;
      onChange(hex, alpha);
    } catch {
      /* cancelled */
    }
  };

  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return (
    <>
      <div className="sv" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHex})` }} onPointerDown={sv}>
        <span className="knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: color }} />
      </div>
      <div className="row" style={{ marginTop: 10, gap: 10 }}>
        <button className="icon-btn sm" data-tip="Pick colour from screen" onClick={eyedrop}>
          <Pipette size={15} />
        </button>
        <div className="flex1">
          <div className="hue" style={{ marginTop: 0 }} onPointerDown={hue}>
            <span className="knob" style={{ left: `${(hsv.h / 360) * 100}%`, background: pureHex }} />
          </div>
          <div className="alpha" style={{ marginTop: 8 }} onPointerDown={alphaDrag}>
            <i style={{ background: `linear-gradient(90deg, transparent, ${color})` }} />
            <span className="knob" style={{ left: `${alpha * 100}%`, background: color }} />
          </div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Select<Mode>
          value={mode}
          onChange={setMode}
          style={{ width: 62 }}
          options={[
            { value: 'hex', label: 'Hex' },
            { value: 'rgb', label: 'RGB' },
            { value: 'hsl', label: 'HSL' },
            { value: 'hsb', label: 'HSB' },
          ]}
        />
        {mode === 'hex' ? (
          <label className="field no-prefix flex1">
            <input
              value={hexText}
              onChange={(e) => setHexText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onBlur={() => {
                const h = normalizeHex(hexText);
                if (h) onChange(h, alpha);
                else setHexText(color.replace('#', ''));
              }}
              style={{ textTransform: 'uppercase' }}
            />
          </label>
        ) : mode === 'rgb' ? (
          <>
            {(['r', 'g', 'b'] as const).map((k) => (
              <NumberField key={k} value={rgb[k]} min={0} max={255} precision={0} onChange={(v) => onChange(rgbToHex(k === 'r' ? v : rgb.r, k === 'g' ? v : rgb.g, k === 'b' ? v : rgb.b), alpha)} />
            ))}
          </>
        ) : mode === 'hsl' ? (
          <>
            <NumberField value={Math.round(hsl.h)} min={0} max={360} precision={0} onChange={(v) => { const c = hslToRgb(v, hsl.s, hsl.l); onChange(rgbToHex(c.r, c.g, c.b), alpha); }} />
            <NumberField value={Math.round(hsl.s * 100)} min={0} max={100} precision={0} onChange={(v) => { const c = hslToRgb(hsl.h, v / 100, hsl.l); onChange(rgbToHex(c.r, c.g, c.b), alpha); }} />
            <NumberField value={Math.round(hsl.l * 100)} min={0} max={100} precision={0} onChange={(v) => { const c = hslToRgb(hsl.h, hsl.s, v / 100); onChange(rgbToHex(c.r, c.g, c.b), alpha); }} />
          </>
        ) : (
          <>
            <NumberField value={Math.round(hsv.h)} min={0} max={360} precision={0} onChange={(v) => setHsv(v, hsv.s, hsv.v)} />
            <NumberField value={Math.round(hsv.s * 100)} min={0} max={100} precision={0} onChange={(v) => setHsv(hsv.h, v / 100, hsv.v)} />
            <NumberField value={Math.round(hsv.v * 100)} min={0} max={100} precision={0} onChange={(v) => setHsv(hsv.h, hsv.s, v / 100)} />
          </>
        )}
        <NumberField value={alpha} scale={100} precision={0} min={0} max={1} suffix="%" width={58} onChange={(v) => onChange(color, v)} />
      </div>
    </>
  );
}

/* ----------------------------------------------------------- gradient bar */

function StopsBar({ paint, sel, setSel, onChange }: { paint: GradientPaint; sel: number; setSel: (i: number) => void; onChange: (p: GradientPaint) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const sorted = [...paint.stops].sort((a, b) => a.offset - b.offset);
  const css = `linear-gradient(90deg, ${sorted.map((s) => `${hexToRgbaStr(s.color, s.opacity)} ${s.offset * 100}%`).join(', ')})`;
  const add = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).classList.contains('stop')) return;
    const r = ref.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const color = sampleGradient(sorted, t);
    const stops = [...paint.stops, { offset: t, color: color.color, opacity: color.opacity }];
    onChange({ ...paint, stops });
    setSel(stops.length - 1);
  };
  const drag = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSel(i);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    editor().begin('Gradient stop');
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      onChange({ ...paint, stops: paint.stops.map((s, k) => (k === i ? { ...s, offset: Math.round(t * 1000) / 1000 } : s)) });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      editor().commit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className="stops" ref={ref} onPointerDown={add} data-tip="Click to add a stop">
      <div className="bar" style={{ background: css }} />
      {paint.stops.map((s, i) => (
        <span key={i} className={`stop ${i === sel ? 'on' : ''}`} style={{ left: `${s.offset * 100}%`, background: s.color }} onPointerDown={drag(i)} />
      ))}
    </div>
  );
}

function hexToRgbaStr(hex: string, a: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function sampleGradient(stops: GradientStop[], t: number): { color: string; opacity: number } {
  if (t <= stops[0].offset) return stops[0];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = (t - a.offset) / (b.offset - a.offset || 1);
      const ca = hexToRgb(a.color);
      const cb = hexToRgb(b.color);
      return { color: rgbToHex(ca.r + (cb.r - ca.r) * k, ca.g + (cb.g - ca.g) * k, ca.b + (cb.b - ca.b) * k), opacity: a.opacity + (b.opacity - a.opacity) * k };
    }
  }
  return stops[stops.length - 1];
}

/* ---------------------------------------------------------------- picker */

const TYPE_TABS: { type: PaintType; tip: string; icon: React.ReactNode }[] = [
  { type: 'solid', tip: 'Solid', icon: <Square size={15} fill="currentColor" /> },
  { type: 'linear', tip: 'Linear gradient', icon: <span className="tab-grad lin" /> },
  { type: 'radial', tip: 'Radial gradient', icon: <span className="tab-grad rad" /> },
  { type: 'angular', tip: 'Angular gradient', icon: <span className="tab-grad ang" /> },
  { type: 'diamond', tip: 'Diamond gradient', icon: <span className="tab-grad dia" /> },
  { type: 'image', tip: 'Image', icon: <ImageIcon size={15} /> },
  { type: 'pattern', tip: 'Pattern', icon: <Grid2x2 size={15} /> },
  { type: 'noise', tip: 'Noise / grain', icon: <Sparkles size={15} /> },
];

const PATTERNS: PatternKind[] = ['dots', 'grid', 'lines', 'diagonal', 'checker', 'cross', 'waves', 'zigzag', 'triangles', 'hexagons'];

export function PaintPicker({
  paint,
  anchor,
  onChange,
  onClose,
  gradientTarget,
}: {
  paint: Paint;
  anchor: DOMRect;
  onChange: (p: Paint) => void;
  onClose: () => void;
  /** node + slot whose gradient can be edited on canvas */
  gradientTarget?: { id: string; target: 'fills' | 'strokes'; index: number };
}) {
  const [stop, setStop] = useState(0);
  const colors = useMemo(docColors, []);
  const styles = useEditor((s) => s.doc.styles.colors);
  const isGrad = paint.type === 'linear' || paint.type === 'radial' || paint.type === 'angular' || paint.type === 'diamond';

  useEffect(() => {
    if (isGrad && gradientTarget) editor().setEditing({ kind: 'gradient', ...gradientTarget });
    return () => {
      if (editor().editing?.kind === 'gradient') editor().setEditing(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGrad]);

  const g = isGrad ? (paint as GradientPaint) : null;
  const curStop = g ? g.stops[Math.min(stop, g.stops.length - 1)] : null;

  const pickImage = async () => {
    const f = await openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'] }], true);
    if (!f) return;
    const ext = f.name.split('.').pop()?.toLowerCase() ?? 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
    const data = f.binary ? `data:${mime};base64,${f.data}` : f.data;
    const info = await loadImageInfo(data);
    const assetId = 'asset_' + uid();
    editor().mutate((d) => {
      d.assets[assetId] = { id: assetId, mime, data, width: info.width, height: info.height, name: f.name };
    });
    onChange({ ...(paint as any), type: 'image', assetId });
  };

  return (
    <Popover anchor={anchor} placement="left" offset={10} onClose={onClose} className="picker">
      <div className="picker-head">
        <div className="picker-types">
          {TYPE_TABS.map((t) => (
            <button key={t.type} className={`icon-btn ${paint.type === t.type ? 'active' : ''}`} data-tip={t.tip} onClick={() => onChange(convertPaint(paint, t.type))}>
              {t.icon}
            </button>
          ))}
        </div>
        <button className="icon-btn sm" onClick={onClose} data-tip="Close">
          <X size={14} />
        </button>
      </div>
      <div className="picker-body">
        {g && (
          <>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="label flex1">Stops</span>
              <button className="icon-btn xs" data-tip="Flip gradient" onClick={() => onChange({ ...g, stops: g.stops.map((s) => ({ ...s, offset: 1 - s.offset })) })}>
                <ArrowLeftRight size={13} />
              </button>
              <button
                className="icon-btn xs"
                data-tip="Rotate 90°"
                onClick={() => {
                  const rot = (p: { x: number; y: number }) => ({ x: 0.5 - (p.y - 0.5), y: 0.5 + (p.x - 0.5) });
                  onChange({ ...g, from: rot(g.from), to: rot(g.to) });
                }}
              >
                <RotateCw size={13} />
              </button>
              <button
                className="icon-btn xs"
                data-tip="Remove stop"
                disabled={g.stops.length <= 2}
                onClick={() => {
                  onChange({ ...g, stops: g.stops.filter((_, i) => i !== stop) });
                  setStop(0);
                }}
              >
                <Trash size={13} />
              </button>
            </div>
            <StopsBar paint={g} sel={stop} setSel={setStop} onChange={(p) => onChange(p)} />
          </>
        )}
        {(paint.type === 'solid' || (g && curStop)) && (
          <ColorControls
            color={paint.type === 'solid' ? paint.color : curStop!.color}
            alpha={paint.type === 'solid' ? paint.opacity : curStop!.opacity}
            onChange={(hex, a) => {
              if (paint.type === 'solid') onChange({ ...paint, color: hex, opacity: a });
              else if (g) onChange({ ...g, stops: g.stops.map((s, i) => (i === stop ? { ...s, color: hex, opacity: a } : s)) });
            }}
          />
        )}
        {paint.type === 'image' && (
          <>
            <div
              className="sv"
              style={{
                height: 140,
                background: paint.assetId ? paintPreview(paint) : 'var(--bg-input)',
                display: 'grid',
                placeItems: 'center',
                cursor: 'default',
              }}
              onClick={pickImage}
            >
              <button className="btn" onClick={(e) => (e.stopPropagation(), pickImage())}>
                <ImageIcon size={14} /> {paint.assetId ? 'Replace image' : 'Choose image'}
              </button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Select<ImageFit>
                value={paint.fit}
                className="flex1"
                onChange={(fit) => onChange({ ...paint, fit })}
                options={[
                  { value: 'fill', label: 'Fill' },
                  { value: 'fit', label: 'Fit' },
                  { value: 'crop', label: 'Crop' },
                  { value: 'tile', label: 'Tile' },
                  { value: 'stretch', label: 'Stretch' },
                ]}
              />
              {paint.fit === 'tile' && <NumberField label="×" value={paint.scale} step={0.05} min={0.01} onChange={(v) => onChange({ ...paint, scale: v })} width={72} />}
              <NumberField label={<RotateCw size={12} />} value={paint.rotation} suffix="°" onChange={(v) => onChange({ ...paint, rotation: v })} width={72} />
            </div>
            {(['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'] as const).map((k) => (
              <div className="row" key={k}>
                <span className="label" style={{ width: 74, textTransform: 'capitalize' }}>
                  {k}
                </span>
                <input
                  type="range"
                  className="slider flex1"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={paint.filters?.[k] ?? 0}
                  onPointerDown={() => editor().begin('Image filter')}
                  onPointerUp={() => editor().commit()}
                  onChange={(e) => onChange({ ...paint, filters: { ...paint.filters, [k]: +e.target.value } })}
                  onDoubleClick={() => onChange({ ...paint, filters: { ...paint.filters, [k]: 0 } })}
                />
              </div>
            ))}
          </>
        )}
        {paint.type === 'pattern' && (
          <>
            <div className="grid3" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
              {PATTERNS.map((k) => (
                <button key={k} className={`btn ${paint.pattern === k ? 'primary' : ''}`} style={{ padding: 0, height: 26, fontSize: 10, textTransform: 'capitalize' }} onClick={() => onChange({ ...paint, pattern: k })}>
                  {k.slice(0, 6)}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <ColorControls color={paint.color} alpha={paint.opacity} onChange={(hex, a) => onChange({ ...paint, color: hex, opacity: a })} />
            </div>
            <div className="grid3" style={{ marginTop: 8 }}>
              <NumberField label="Sz" tip="Cell size" value={paint.scale} min={2} onChange={(v) => onChange({ ...paint, scale: v })} />
              <NumberField label="°" tip="Rotation" value={paint.rotation} onChange={(v) => onChange({ ...paint, rotation: v })} />
              <NumberField label="W" tip="Weight" value={paint.weight} min={0.05} max={1} step={0.05} onChange={(v) => onChange({ ...paint, weight: v })} />
            </div>
            <div className="row">
              <span className="label flex1">Background</span>
              <BackgroundToggle value={paint.background} onChange={(bg) => onChange({ ...paint, background: bg })} />
            </div>
          </>
        )}
        {paint.type === 'noise' && (
          <>
            <ColorControls color={paint.color} alpha={paint.opacity} onChange={(hex, a) => onChange({ ...paint, color: hex, opacity: a })} />
            <div className="grid3" style={{ marginTop: 8 }}>
              <NumberField label="D" tip="Density" value={paint.density} min={0.01} max={1} step={0.01} onChange={(v) => onChange({ ...paint, density: v })} />
              <NumberField label="Sz" tip="Grain size" value={paint.size} min={0.25} step={0.25} onChange={(v) => onChange({ ...paint, size: v })} />
              <button className="btn" data-tip="New random seed" onClick={() => onChange({ ...paint, seed: (Math.random() * 1e6) | 0 })}>
                <Sparkles size={13} />
              </button>
            </div>
            <div className="row">
              <span className="label flex1">Background</span>
              <BackgroundToggle value={paint.background} onChange={(bg) => onChange({ ...paint, background: bg })} />
            </div>
          </>
        )}
      </div>
      {(paint.type === 'solid' || g) && (
        <div className="picker-swatches">
          {[...colors, ...PRESETS.filter((p) => !colors.includes(p))].slice(0, 20).map((c) => (
            <span
              key={c}
              className="swatch"
              data-tip={c}
              onClick={() => {
                if (paint.type === 'solid') onChange({ ...paint, color: c });
                else if (g) onChange({ ...g, stops: g.stops.map((s, i) => (i === stop ? { ...s, color: c } : s)) });
              }}
            >
              <i style={{ background: c }} />
            </span>
          ))}
          {styles.map((st) => (
            <span key={st.id} className="swatch" data-tip={st.name} onClick={() => onChange({ ...st.paint, id: paint.id })}>
              <i style={{ background: paintPreview(st.paint) }} />
            </span>
          ))}
          <span
            className="swatch"
            data-tip="Save as colour style"
            style={{ display: 'grid', placeItems: 'center', background: 'var(--bg-input)' }}
            onClick={() => {
              const name = `Color ${styles.length + 1}`;
              editor().mutate((d) => {
                d.styles.colors.push({ id: uid(), name, paint: JSON.parse(JSON.stringify(paint)) });
              });
              toast(`Saved “${name}”`, { kind: 'success' });
            }}
          >
            <Plus size={12} />
          </span>
        </div>
      )}
    </Popover>
  );
}

function BackgroundToggle({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="row" style={{ gap: 6, margin: 0 }}>
      <Segmented
        value={value ? 'on' : 'off'}
        options={[
          { value: 'off', label: 'None' },
          { value: 'on', label: 'Color' },
        ]}
        onChange={(v) => onChange(v === 'on' ? value ?? '#FFFFFF' : null)}
      />
      {value && (
        <label className="field no-prefix" style={{ width: 82 }}>
          <input
            defaultValue={value.replace('#', '')}
            onBlur={(e) => {
              const h = normalizeHex(e.target.value);
              if (h) onChange(h);
            }}
            style={{ textTransform: 'uppercase' }}
          />
        </label>
      )}
    </div>
  );
}
