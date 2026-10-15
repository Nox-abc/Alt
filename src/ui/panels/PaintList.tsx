import { useState } from 'react';
import type { Effect, EffectType, Paint, SceneNode, BlendMode } from '../../core/types';
import { defaultEffect, normalizeHex, solid, uid } from '../../core/doc';
import { editor } from '../../core/store';
import { NumberField, Popover, Select, Section } from '../controls';
import { Eye, EyeOff, Minus, Plus, SlidersHorizontal, Grip } from '../icons';
import { PaintPicker, paintLabel, paintPreview } from '../ColorPicker';
import { mixed, updateSelected, clone } from './shared';

export const BLEND_OPTIONS: { value: BlendMode; label: string; separatorBefore?: boolean }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'darken', label: 'Darken', separatorBefore: true },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color burn' },
  { value: 'lighten', label: 'Lighten', separatorBefore: true },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color dodge' },
  { value: 'plus-lighter', label: 'Plus lighter' },
  { value: 'overlay', label: 'Overlay', separatorBefore: true },
  { value: 'soft-light', label: 'Soft light' },
  { value: 'hard-light', label: 'Hard light' },
  { value: 'difference', label: 'Difference', separatorBefore: true },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue', separatorBefore: true },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

function PaintRow({
  paint,
  index,
  slot,
  nodes,
  onChange,
  onRemove,
}: {
  paint: Paint;
  index: number;
  slot: 'fills' | 'strokes';
  nodes: SceneNode[];
  onChange: (p: Paint) => void;
  onRemove: () => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [hex, setHex] = useState<string | null>(null);
  return (
    <div className={`paint-row ${paint.visible ? '' : 'hidden'}`}>
      <div className="paint-main">
        <span className="swatch" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
          <i style={{ background: paintPreview(paint) }} />
        </span>
        {paint.type === 'solid' ? (
          <input
            value={hex ?? paint.color.replace('#', '')}
            onFocus={(e) => {
              setHex(paint.color.replace('#', ''));
              e.target.select();
            }}
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onBlur={() => {
              const h = hex !== null ? normalizeHex(hex) : null;
              setHex(null);
              if (h) onChange({ ...paint, color: h });
            }}
          />
        ) : (
          <span className="flex1" style={{ cursor: 'default' }} onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
            {paintLabel(paint)}
          </span>
        )}
        <span className="pct">
          <NumberField value={paint.opacity} scale={100} precision={0} min={0} max={1} suffix="%" onChange={(v) => onChange({ ...paint, opacity: v })} className="ghost-field" />
        </span>
      </div>
      <div className="row-actions">
        <button className="icon-btn sm" data-tip={paint.visible ? 'Hide' : 'Show'} onClick={() => onChange({ ...paint, visible: !paint.visible })}>
          {paint.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="icon-btn sm" data-tip="Remove" onClick={onRemove}>
          <Minus size={14} />
        </button>
      </div>
      {anchor && (
        <PaintPicker
          paint={paint}
          anchor={anchor}
          onChange={onChange}
          onClose={() => setAnchor(null)}
          gradientTarget={nodes.length === 1 ? { id: nodes[0].id, target: slot, index } : undefined}
        />
      )}
    </div>
  );
}

export function PaintSection({ nodes, slot, title, extra }: { nodes: SceneNode[]; slot: 'fills' | 'strokes'; title: string; extra?: React.ReactNode }) {
  const value = mixed(nodes, (n) => n[slot]);
  const add = () =>
    updateSelected((n) => {
      if (slot === 'strokes' && !n.strokes.length && n.strokeWidth <= 0) n.strokeWidth = 1;
      n[slot].push(solid(slot === 'strokes' ? '#000000' : n[slot].length ? '#000000' : '#D9D9D9', slot === 'fills' && n[slot].length ? 0.2 : 1));
    }, `Add ${slot === 'fills' ? 'fill' : 'stroke'}`);
  if (value === 'mixed') {
    return (
      <Section title={title} actions={<button className="icon-btn sm" data-tip="Replace mixed" onClick={() => updateSelected((n) => (n[slot] = [solid(slot === 'strokes' ? '#000000' : '#D9D9D9')]))}><Plus size={14} /></button>}>
        <div className="hint">Mixed — click + to replace for all {nodes.length} layers.</div>
      </Section>
    );
  }
  const paints = value;
  const setPaint = (i: number, p: Paint) =>
    editor().mutate((d) => {
      for (const n of nodes) if (d.nodes[n.id]) d.nodes[n.id][slot][i] = clone({ ...p, id: d.nodes[n.id][slot][i]?.id ?? uid() });
    });
  const remove = (i: number) =>
    updateSelected((n) => {
      n[slot].splice(i, 1);
    }, 'Remove paint');
  // top-most paint first, like most editors
  const order = paints.map((_, i) => i).reverse();
  return (
    <Section
      title={title}
      empty={!paints.length}
      onHeaderClick={!paints.length ? add : undefined}
      actions={
        <button className="icon-btn sm" data-tip={`Add ${slot === 'fills' ? 'fill' : 'stroke'}`} onClick={add}>
          <Plus size={15} />
        </button>
      }
    >
      {order.map((i) => (
        <PaintRow key={paints[i].id + i} paint={paints[i]} index={i} slot={slot} nodes={nodes} onChange={(p) => setPaint(i, p)} onRemove={() => remove(i)} />
      ))}
      {extra}
    </Section>
  );
}

/* --------------------------------------------------------------- effects */

const EFFECT_OPTIONS: { value: EffectType; label: string }[] = [
  { value: 'drop-shadow', label: 'Drop shadow' },
  { value: 'inner-shadow', label: 'Inner shadow' },
  { value: 'glow', label: 'Outer glow' },
  { value: 'layer-blur', label: 'Layer blur' },
  { value: 'background-blur', label: 'Background blur' },
  { value: 'noise', label: 'Grain' },
  { value: 'adjust', label: 'Adjustments' },
];

function EffectEditor({ effect, onChange }: { effect: Effect; onChange: (e: Effect) => void }) {
  const [picker, setPicker] = useState<DOMRect | null>(null);
  switch (effect.type) {
    case 'drop-shadow':
    case 'inner-shadow':
    case 'glow': {
      const e = effect;
      return (
        <>
          <div className="grid2">
            {'x' in e && <NumberField label="X" value={e.x} onChange={(v) => onChange({ ...e, x: v } as Effect)} />}
            {'y' in e && <NumberField label="Y" value={e.y} onChange={(v) => onChange({ ...e, y: v } as Effect)} />}
            <NumberField label="Blur" value={e.blur} min={0} onChange={(v) => onChange({ ...e, blur: v })} />
            <NumberField label="Spread" value={e.spread} onChange={(v) => onChange({ ...e, spread: v })} />
          </div>
          <div className="paint-row" style={{ marginTop: 6 }}>
            <div className="paint-main">
              <span className="swatch" onClick={(ev) => setPicker((ev.currentTarget as HTMLElement).getBoundingClientRect())}>
                <i style={{ background: e.color, opacity: e.opacity }} />
              </span>
              <span className="flex1">{e.color.replace('#', '')}</span>
              <span className="pct">
                <NumberField value={e.opacity} scale={100} precision={0} min={0} max={1} suffix="%" onChange={(v) => onChange({ ...e, opacity: v })} />
              </span>
            </div>
          </div>
          {picker && (
            <PaintPicker
              paint={{ id: 'x', type: 'solid', color: e.color, opacity: e.opacity, visible: true }}
              anchor={picker}
              onClose={() => setPicker(null)}
              onChange={(p) => p.type === 'solid' && onChange({ ...e, color: p.color, opacity: p.opacity })}
            />
          )}
        </>
      );
    }
    case 'layer-blur':
    case 'background-blur':
      return <NumberField label="Blur" value={effect.radius} min={0} onChange={(v) => onChange({ ...effect, radius: v })} />;
    case 'noise':
      return (
        <div className="grid2">
          <NumberField label="Amt" value={effect.amount} min={0} max={1} step={0.01} scale={100} precision={0} suffix="%" onChange={(v) => onChange({ ...effect, amount: v })} />
          <NumberField label="Size" value={effect.size} min={0.25} step={0.25} onChange={(v) => onChange({ ...effect, size: v })} />
          <Select value={effect.monochrome ? 'mono' : 'color'} options={[{ value: 'mono', label: 'Monochrome' }, { value: 'color', label: 'Colour' }]} onChange={(v) => onChange({ ...effect, monochrome: v === 'mono' })} />
        </div>
      );
    case 'adjust':
      return (
        <>
          {(['brightness', 'contrast', 'saturation', 'grayscale', 'sepia', 'invert'] as const).map((k) => (
            <div className="row" key={k}>
              <span className="label" style={{ width: 70, textTransform: 'capitalize' }}>
                {k}
              </span>
              <input
                type="range"
                className="slider flex1"
                min={k === 'grayscale' || k === 'sepia' || k === 'invert' ? 0 : -1}
                max={1}
                step={0.01}
                value={effect[k]}
                onPointerDown={() => editor().begin('Adjust')}
                onPointerUp={() => editor().commit()}
                onDoubleClick={() => onChange({ ...effect, [k]: 0 })}
                onChange={(ev) => onChange({ ...effect, [k]: +ev.target.value })}
              />
            </div>
          ))}
          <NumberField label="Hue" value={effect.hue} suffix="°" onChange={(v) => onChange({ ...effect, hue: v })} />
        </>
      );
  }
}

function EffectRow({ effect, onChange, onRemove }: { effect: Effect; onChange: (e: Effect) => void; onRemove: () => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div className={`paint-row ${effect.visible ? '' : 'hidden'}`}>
      <button className="icon-btn sm" data-tip="Effect settings" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <SlidersHorizontal size={14} />
      </button>
      <Select<EffectType>
        value={effect.type}
        className="flex1"
        options={EFFECT_OPTIONS}
        onChange={(t) => onChange({ ...defaultEffect(t), id: effect.id })}
      />
      <div className="row-actions">
        <button className="icon-btn sm" data-tip={effect.visible ? 'Hide' : 'Show'} onClick={() => onChange({ ...effect, visible: !effect.visible })}>
          {effect.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="icon-btn sm" data-tip="Remove" onClick={onRemove}>
          <Minus size={14} />
        </button>
      </div>
      {anchor && (
        <Popover anchor={anchor} placement="left" offset={10} onClose={() => setAnchor(null)} width={240}>
          <div style={{ padding: 8 }}>
            <div className="menu-title" style={{ padding: '2px 2px 8px' }}>
              {EFFECT_OPTIONS.find((o) => o.value === effect.type)?.label}
            </div>
            <EffectEditor effect={effect} onChange={onChange} />
          </div>
        </Popover>
      )}
    </div>
  );
}

export function EffectsSection({ nodes }: { nodes: SceneNode[] }) {
  const value = mixed(nodes, (n) => n.effects);
  const add = () => updateSelected((n) => void n.effects.push(defaultEffect('drop-shadow')), 'Add effect');
  if (value === 'mixed')
    return (
      <Section title="Effects" actions={<button className="icon-btn sm" onClick={() => updateSelected((n) => (n.effects = [defaultEffect('drop-shadow')]))}><Plus size={15} /></button>}>
        <div className="hint">Mixed effects</div>
      </Section>
    );
  const set = (i: number, e: Effect) =>
    editor().mutate((d) => {
      for (const n of nodes) if (d.nodes[n.id]) d.nodes[n.id].effects[i] = clone(e);
    });
  return (
    <Section
      title="Effects"
      empty={!value.length}
      onHeaderClick={!value.length ? add : undefined}
      actions={
        <button className="icon-btn sm" data-tip="Add effect" onClick={add}>
          <Plus size={15} />
        </button>
      }
    >
      {value.map((e, i) => (
        <EffectRow key={e.id} effect={e} onChange={(ne) => set(i, ne)} onRemove={() => updateSelected((n) => void n.effects.splice(i, 1), 'Remove effect')} />
      ))}
    </Section>
  );
}

export { Grip };
