import { useState } from 'react';
import { editor, useEditor, type ToolId, type ToolOptions } from '../core/store';
import { SHAPE_LIBRARY } from '../core/shapes';
import { shortcutLabel, runAction } from '../editor/actions';
import { useSettings } from '../editor/settings';
import { NumberField, Popover, Select } from './controls';
import { PaintPicker } from './ColorPicker';
import {
  MousePointer2,
  Hand,
  Frame,
  Square,
  Circle,
  Star,
  MoveUpRight,
  PenTool,
  Pencil,
  Brush,
  Paintbrush,
  SprayCan,
  Eraser,
  PaintBucket,
  Type,
  Image as ImageIcon,
  Pipette,
  Shapes,
  ChevronDown,
  Scaling,
  SpiralIcon,
  PixelIcon,
  LineIcon,
  PolygonIcon,
  Check,
} from './icons';

interface ToolDef {
  id: ToolId | 'image';
  label: string;
  icon: React.ReactNode;
}

const I = 18;
const DEFS: Record<string, ToolDef> = {
  move: { id: 'move', label: 'Move', icon: <MousePointer2 size={I} /> },
  scale: { id: 'scale', label: 'Scale', icon: <Scaling size={I} /> },
  hand: { id: 'hand', label: 'Hand', icon: <Hand size={I} /> },
  frame: { id: 'frame', label: 'Frame', icon: <Frame size={I} /> },
  rect: { id: 'rect', label: 'Rectangle', icon: <Square size={I} /> },
  ellipse: { id: 'ellipse', label: 'Ellipse', icon: <Circle size={I} /> },
  polygon: { id: 'polygon', label: 'Polygon', icon: <PolygonIcon size={I} /> },
  star: { id: 'star', label: 'Star', icon: <Star size={I} /> },
  line: { id: 'line', label: 'Line', icon: <LineIcon size={I} /> },
  arrow: { id: 'arrow', label: 'Arrow', icon: <MoveUpRight size={I} /> },
  spiral: { id: 'spiral', label: 'Spiral', icon: <SpiralIcon size={I} /> },
  shape: { id: 'shape', label: 'Shape library', icon: <Shapes size={I} /> },
  pen: { id: 'pen', label: 'Pen', icon: <PenTool size={I} /> },
  pencil: { id: 'pencil', label: 'Pencil', icon: <Pencil size={I} /> },
  brush: { id: 'brush', label: 'Vector brush', icon: <Brush size={I} /> },
  paint: { id: 'paint', label: 'Paint brush', icon: <Paintbrush size={I} /> },
  spray: { id: 'spray', label: 'Spray', icon: <SprayCan size={I} /> },
  pixel: { id: 'pixel', label: 'Pixel pencil', icon: <PixelIcon size={I} /> },
  eraser: { id: 'eraser', label: 'Eraser', icon: <Eraser size={I} /> },
  bucket: { id: 'bucket', label: 'Paint bucket', icon: <PaintBucket size={I} /> },
  text: { id: 'text', label: 'Text', icon: <Type size={I} /> },
  image: { id: 'image', label: 'Place image', icon: <ImageIcon size={I} /> },
  eyedropper: { id: 'eyedropper', label: 'Eyedropper', icon: <Pipette size={I} /> },
};

const GROUPS: string[][] = [
  ['move', 'scale', 'hand'],
  ['frame'],
  ['rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'spiral', 'shape'],
  ['pen', 'pencil'],
  ['brush', 'paint', 'spray', 'pixel', 'eraser', 'bucket'],
  ['text'],
  ['image', 'eyedropper'],
];

function actionId(id: string) {
  return `tool.${id}`;
}

function ToolGroup({ ids, tool }: { ids: string[]; tool: ToolId }) {
  const [last, setLast] = useState(ids[0]);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const current = ids.includes(tool) ? tool : last;
  const def = DEFS[current];
  const active = ids.includes(tool);
  const activate = (id: string) => {
    setLast(id);
    if (id === 'image') runAction('tool.image');
    else editor().setTool(id as ToolId);
  };
  return (
    <div className="tool-group">
      <button
        className={`tool-btn ${active ? 'active' : ''}`}
        data-tip={def.label}
        data-key={shortcutLabel(actionId(def.id)) || undefined}
        onClick={() => activate(def.id)}
        onDoubleClick={() => def.id !== 'image' && editor().setTool(def.id as ToolId, true)}
      >
        {def.icon}
      </button>
      {ids.length > 1 && (
        <button className="tool-chev" data-tip="More tools" onClick={(e) => setMenu((e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())}>
          <ChevronDown size={11} />
        </button>
      )}
      {menu && (
        <Popover anchor={menu} placement="top" offset={10} onClose={() => setMenu(null)}>
          {ids.map((id) => (
            <div
              key={id}
              className="menu-item"
              onClick={() => {
                setMenu(null);
                activate(id);
              }}
            >
              <span className="mi-icon">{id === current ? <Check size={13} /> : null}</span>
              <span style={{ display: 'grid', placeItems: 'center', width: 18 }}>{DEFS[id].icon}</span>
              <span className="mi-label">{DEFS[id].label}</span>
              <span className="mi-short">{shortcutLabel(actionId(id))}</span>
            </div>
          ))}
        </Popover>
      )}
    </div>
  );
}

function ColorOpt({ value, opacity, onChange, label = 'Colour' }: { value: string; opacity?: number; onChange: (hex: string, a: number) => void; label?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div className="opt">
      <span className="swatch" data-tip={label} onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <i style={{ background: value, opacity: opacity ?? 1 }} />
      </span>
      {anchor && (
        <PaintPicker
          paint={{ id: 'tool', type: 'solid', color: value, opacity: opacity ?? 1, visible: true }}
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onChange={(p) => p.type === 'solid' && onChange(p.color, p.opacity)}
        />
      )}
    </div>
  );
}

function Range({ label, value, min, max, step = 1, onChange, fmt }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <div className="opt">
      <span>{label}</span>
      <input type="range" className="slider" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span style={{ width: 30, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>{fmt ? fmt(value) : value}</span>
    </div>
  );
}

function Symmetry({ o, set }: { o: ToolOptions; set: (p: Partial<ToolOptions>) => void }) {
  return (
    <>
      <div className="divider" />
      <div className="opt">
        <Select
          value={o.symmetry}
          tip="Symmetry"
          style={{ width: 120 }}
          options={[
            { value: 'none', label: 'No symmetry' },
            { value: 'x', label: 'Mirror X' },
            { value: 'y', label: 'Mirror Y' },
            { value: 'xy', label: 'Mirror X + Y' },
            { value: 'radial', label: 'Radial' },
          ]}
          onChange={(v) => set({ symmetry: v as ToolOptions['symmetry'] })}
        />
        {o.symmetry === 'radial' && <NumberField label="×" value={o.symmetrySegments} min={2} max={64} precision={0} onChange={(v) => set({ symmetrySegments: Math.round(v) })} width={60} />}
      </div>
    </>
  );
}

function ToolOptionsBar() {
  const tool = useEditor((s) => s.tool);
  const o = useEditor((s) => s.toolOptions);
  const set = editor().setToolOptions;
  let body: React.ReactNode = null;
  switch (tool) {
    case 'brush':
    case 'pencil':
      body = (
        <>
          <ColorOpt value={o.brushColor} opacity={o.brushOpacity} onChange={(c, a) => set({ brushColor: c, brushOpacity: a })} />
          {tool === 'brush' && (
            <div className="opt">
              <Select
                value={o.brush.kind}
                style={{ width: 112 }}
                options={[
                  { value: 'pen', label: 'Pen' },
                  { value: 'ink', label: 'Ink' },
                  { value: 'marker', label: 'Marker' },
                  { value: 'highlighter', label: 'Highlighter' },
                  { value: 'calligraphy', label: 'Calligraphy' },
                ]}
                onChange={(kind) => set({ brush: { ...o.brush, kind: kind as ToolOptions['brush']['kind'] } })}
              />
            </div>
          )}
          <Range label="Size" value={o.brush.size} min={1} max={120} onChange={(v) => set({ brush: { ...o.brush, size: v } })} />
          {tool === 'brush' && <Range label="Smooth" value={o.brush.streamline} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ brush: { ...o.brush, streamline: v, smoothing: v } })} />}
          {tool === 'brush' && <Range label="Taper" value={o.brush.taperEnd} min={0} max={200} onChange={(v) => set({ brush: { ...o.brush, taperEnd: v, taperStart: v / 2 } })} />}
          {tool === 'pencil' && <Range label="Smooth" value={o.pencilSmoothing} min={0.5} max={10} step={0.5} onChange={(v) => set({ pencilSmoothing: v })} />}
          <Symmetry o={o} set={set} />
        </>
      );
      break;
    case 'paint':
    case 'spray':
    case 'eraser':
      body = (
        <>
          {tool !== 'eraser' && <ColorOpt value={o.paintColor} onChange={(c) => set({ paintColor: c })} />}
          <Range label="Size" value={o.paintSize} min={1} max={300} onChange={(v) => set({ paintSize: v })} />
          {tool !== 'spray' && <Range label="Hardness" value={o.paintHardness} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ paintHardness: v })} />}
          {tool === 'spray' && <Range label="Density" value={o.sprayDensity} min={0.05} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ sprayDensity: v })} />}
          <Range label="Opacity" value={o.paintOpacity} min={0.02} max={1} step={0.02} fmt={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ paintOpacity: v })} />
          <Range label="Flow" value={o.paintFlow} min={0.02} max={1} step={0.02} fmt={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ paintFlow: v })} />
          <Symmetry o={o} set={set} />
        </>
      );
      break;
    case 'pixel':
      body = (
        <>
          <ColorOpt value={o.paintColor} onChange={(c) => set({ paintColor: c })} />
          <Range label="Brush" value={o.pixelSize} min={1} max={16} onChange={(v) => set({ pixelSize: v })} />
          <Symmetry o={o} set={set} />
          <div className="divider" />
          <span className="opt muted">Click empty canvas for a new 32×32 sprite · Alt erases</span>
        </>
      );
      break;
    case 'bucket':
      body = (
        <>
          <ColorOpt value={o.paintColor} onChange={(c) => set({ paintColor: c })} />
          <Range label="Tolerance" value={o.bucketTolerance} min={0} max={255} onChange={(v) => set({ bucketTolerance: v })} />
          <span className="opt muted">Fills paint layers, or recolours vector shapes</span>
        </>
      );
      break;
    case 'polygon':
      body = <Range label="Sides" value={o.polygonSides} min={3} max={24} onChange={(v) => set({ polygonSides: v })} />;
      break;
    case 'star':
      body = (
        <>
          <Range label="Points" value={o.starPoints} min={3} max={40} onChange={(v) => set({ starPoints: v })} />
          <Range label="Ratio" value={o.starInner} min={0.05} max={0.95} step={0.01} fmt={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ starInner: v })} />
        </>
      );
      break;
    case 'spiral':
      body = <Range label="Turns" value={o.spiralTurns} min={1} max={20} step={0.5} onChange={(v) => set({ spiralTurns: v })} />;
      break;
    case 'line':
      body = (
        <div className="opt">
          <Select
            value={o.lineMarker}
            style={{ width: 130 }}
            options={[
              { value: 'none', label: 'Plain line' },
              { value: 'arrow', label: 'Arrow end' },
              { value: 'triangle', label: 'Triangle end' },
              { value: 'circle', label: 'Circle end' },
            ]}
            onChange={(v) => set({ lineMarker: v as ToolOptions['lineMarker'] })}
          />
        </div>
      );
      break;
    case 'shape':
      body = (
        <div className="opt" style={{ gap: 2 }}>
          {SHAPE_LIBRARY.slice(0, 14).map((s) => (
            <button key={s.id} className={`icon-btn sm ${o.shapeId === s.id ? 'active' : ''}`} data-tip={s.name} onClick={() => set({ shapeId: s.id })}>
              <svg width="16" height="16" viewBox="-4 -4 108 108">
                <path d={s.d} fill="currentColor" fillRule="evenodd" />
              </svg>
            </button>
          ))}
        </div>
      );
      break;
  }
  if (!body) return null;
  return <div className="tool-options">{body}</div>;
}

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const pos = useSettings((s) => s.toolbarPosition);
  return (
    <div className={`toolbar-dock ${pos === 'top' ? 'top' : ''}`}>
      <ToolOptionsBar />
      <div className="toolbar">
        {GROUPS.map((g, i) => (
          <div key={i} style={{ display: 'contents' }}>
            {i > 0 && (i === 1 || i === 5) && <div className="sep" />}
            <ToolGroup ids={g} tool={tool} />
          </div>
        ))}
      </div>
    </div>
  );
}
