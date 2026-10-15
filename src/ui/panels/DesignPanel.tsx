import { useState } from 'react';
import type {
  AutoLayout,
  BitmapNode,
  BrushNode,
  EllipseNode,
  FrameNode,
  LayoutGrid,
  Marker,
  PathNode,
  PolygonNode,
  SceneNode,
  Sizing,
  StarNode,
  TextNode,
  ConstraintH,
  ConstraintV,
} from '../../core/types';
import { editor, useEditor } from '../../core/store';
import { selectionBounds } from '../../core/geometry';
import { getPage, uid, normalizeHex } from '../../core/doc';
import { setAutoLayout, translateNodes, setProps, fitText } from '../../core/ops';
import { NumberField, Section, Segmented, Select, Popover, IconButton, MenuList } from '../controls';
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  RotateCw,
  Plus,
  Minus,
  Eye,
  EyeOff,
  Link,
  Unlink,
  IndependentCornersIcon,
  CornerIcon,
  ArrowRight,
  ArrowUpDown,
  ArrowLeftRight,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  ArrowUpToLine,
  ArrowDownToLine,
  AlignCenterVertical as VMiddle,
  Ellipsis,
  Ruler,
  LayoutGrid as GridIcon,
  Columns3,
  Rows3,
  Hash,
  Sun,
  Blend,
  Component,
  Repeat,
  TextWrap,
  Maximize2,
  ChevronDown,
  StrokeWeightIcon,
  ArcIcon,
  WandSparkles,
} from '../icons';
import { mixed, num, setSelectedProps, updateSelected, useSelected } from './shared';
import { BLEND_OPTIONS, EffectsSection, PaintSection } from './PaintList';
import { FontPicker, WEIGHTS } from '../fonts';
import { PaintPicker, paintPreview } from '../ColorPicker';
import { ExportSection } from './ExportSection';
import { runAction } from '../../editor/actions';
import { toast } from '../toast';

/* ----------------------------------------------------------- frame presets */

const PRESETS: { group: string; items: [string, number, number][] }[] = [
  {
    group: 'Phone',
    items: [
      ['iPhone 16 Pro', 402, 874],
      ['iPhone 16', 393, 852],
      ['iPhone SE', 375, 667],
      ['Android Compact', 412, 917],
      ['Android Medium', 700, 840],
    ],
  },
  {
    group: 'Tablet',
    items: [
      ['iPad Pro 13"', 1032, 1376],
      ['iPad mini', 744, 1133],
      ['Surface Pro', 1368, 912],
    ],
  },
  {
    group: 'Desktop',
    items: [
      ['MacBook Air', 1280, 832],
      ['MacBook Pro 16"', 1728, 1117],
      ['Desktop', 1440, 1024],
      ['Full HD', 1920, 1080],
      ['4K', 3840, 2160],
    ],
  },
  {
    group: 'Social & print',
    items: [
      ['Instagram post', 1080, 1080],
      ['Instagram story', 1080, 1920],
      ['YouTube thumbnail', 1280, 720],
      ['X / Twitter post', 1600, 900],
      ['A4', 595, 842],
      ['Letter', 612, 792],
      ['Business card', 336, 192],
    ],
  },
  {
    group: 'Games & icons',
    items: [
      ['Roblox UI 1080p', 1920, 1080],
      ['Roblox thumbnail', 768, 432],
      ['App icon', 1024, 1024],
      ['Favicon', 32, 32],
      ['Pixel sprite 16', 16, 16],
      ['Pixel sprite 64', 64, 64],
    ],
  },
];

/* ---------------------------------------------------------------- sections */

function AlignBar() {
  const n = useEditor((s) => s.selection.length);
  const b = (icon: React.ReactNode, action: string, tip: string, disabled = false) => (
    <IconButton icon={icon} action={action} tip={tip} disabled={disabled} size="sm" />
  );
  return (
    <div className="section" style={{ paddingTop: 8, paddingBottom: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 0 }}>
          {b(<AlignStartVertical size={15} />, 'align.left', 'Align left')}
          {b(<AlignCenterVertical size={15} />, 'align.hcenter', 'Align horizontal centers')}
          {b(<AlignEndVertical size={15} />, 'align.right', 'Align right')}
          {b(<AlignStartHorizontal size={15} />, 'align.top', 'Align top')}
          {b(<AlignCenterHorizontal size={15} />, 'align.vcenter', 'Align vertical centers')}
          {b(<AlignEndHorizontal size={15} />, 'align.bottom', 'Align bottom')}
        </div>
        <div className="row" style={{ gap: 0 }}>
          {b(<AlignHorizontalDistributeCenter size={15} />, 'align.distributeH', 'Distribute horizontally', n < 3)}
          {b(<AlignVerticalDistributeCenter size={15} />, 'align.distributeV', 'Distribute vertically', n < 3)}
          {b(<GridIcon size={15} />, 'align.tidy', 'Tidy up', n < 2)}
        </div>
      </div>
    </div>
  );
}

function FrameHeader({ node }: { node: FrameNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div className="section" style={{ paddingTop: 8, paddingBottom: 8 }}>
      <div className="row">
        <button className="select ghost flex1" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())} style={{ fontWeight: 600 }}>
          {node.isComponent ? <Component size={14} /> : null}
          <span className="value">{node.isComponent ? 'Component' : 'Frame'}</span>
          <ChevronDown size={13} className="chev" />
        </button>
        <IconButton
          icon={<RotateCw size={14} />}
          size="sm"
          tip="Swap orientation"
          onClick={() => setSelectedProps((n) => ({ width: n.height, height: n.width }), 'Orientation')}
        />
        <IconButton
          icon={<Maximize2 size={14} />}
          size="sm"
          tip="Resize to fit content"
          onClick={() => {
            const s = editor();
            const f = s.doc.nodes[node.id] as FrameNode;
            if (!f.children.length) return;
            s.mutate((d) => {
              const kids = f.children.map((c) => d.nodes[c]).filter(Boolean);
              const minX = Math.min(...kids.map((k) => k.x));
              const minY = Math.min(...kids.map((k) => k.y));
              const maxX = Math.max(...kids.map((k) => k.x + k.width));
              const maxY = Math.max(...kids.map((k) => k.y + k.height));
              for (const k of kids) {
                k.x -= minX;
                k.y -= minY;
              }
              const fr = d.nodes[node.id];
              fr.x += minX;
              fr.y += minY;
              fr.width = Math.max(1, maxX - minX);
              fr.height = Math.max(1, maxY - minY);
            });
          }}
        />
      </div>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={240} className="preset-list">
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <MenuList
              onClose={() => setAnchor(null)}
              items={[
                { label: node.isComponent ? 'Detach component' : 'Make component', run: () => updateSelected((n) => n.type === 'frame' && (n.isComponent = !n.isComponent)) },
                { separator: true },
                ...PRESETS.flatMap((g) => [
                  { label: g.group, disabled: true },
                  ...g.items.map(([name, w, h]) => ({
                    label: `${name}   ${w}×${h}`,
                    run: () => setSelectedProps({ width: w, height: h, name } as Partial<SceneNode>, 'Preset'),
                  })),
                ]),
              ]}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

function LayoutSection({ nodes }: { nodes: SceneNode[] }) {
  const doc = useEditor((s) => s.doc);
  const single = nodes.length === 1 ? nodes[0] : null;
  const bounds = selectionBounds(doc, nodes.map((n) => n.id));
  const lock = single ? !!single.meta?.lockRatio : false;
  const parent = single ? doc.nodes[single.parentId] : null;
  const inAutoLayout = parent?.type === 'frame' && !!parent.layout && single?.layoutPositioning === 'auto';
  const isLayoutFrame = single?.type === 'frame' && !!single.layout;
  const setXY = (k: 'x' | 'y', v: number) => {
    if (single) setSelectedProps({ [k]: v } as Partial<SceneNode>, 'Position');
    else if (bounds) editor().mutate((d) => translateNodes(d, nodes.map((n) => n.id), k === 'x' ? v - bounds.x : 0, k === 'y' ? v - bounds.y : 0), { label: 'Position' });
  };
  const setSize = (k: 'width' | 'height', v: number) => {
    setSelectedProps((n) => {
      if (n.meta?.lockRatio && n.width > 0 && n.height > 0) {
        const r = n.width / n.height;
        return k === 'width' ? { width: v, height: v / r } : { height: v, width: v * r };
      }
      return { [k]: v } as Partial<SceneNode>;
    }, 'Resize');
  };
  const sizingOptions = (axis: 'H' | 'V') => {
    const opts: { value: Sizing; label: string }[] = [{ value: 'fixed', label: 'Fixed' }];
    if (isLayoutFrame || single?.type === 'text') opts.push({ value: 'hug', label: 'Hug contents' });
    if (inAutoLayout) opts.push({ value: 'fill', label: 'Fill container' });
    return opts;
  };
  return (
    <Section title="Layout">
      <div className="grid2">
        <NumberField label="X" value={single ? single.x : bounds?.x ?? 0} onChange={(v) => setXY('x', v)} />
        <NumberField label="Y" value={single ? single.y : bounds?.y ?? 0} onChange={(v) => setXY('y', v)} />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <div className="grid2 flex1">
          <NumberField label="W" value={single ? single.width : num(mixed(nodes, (n) => n.width))} min={0.01} onChange={(v) => setSize('width', v)} />
          <NumberField label="H" value={single ? single.height : num(mixed(nodes, (n) => n.height))} min={0.01} onChange={(v) => setSize('height', v)} />
        </div>
        <IconButton
          size="sm"
          icon={lock ? <Link size={14} /> : <Unlink size={14} />}
          active={lock}
          tip="Constrain proportions"
          onClick={() => updateSelected((n) => (n.meta = { ...(n.meta ?? {}), lockRatio: !lock }))}
        />
      </div>
      {(isLayoutFrame || inAutoLayout || single?.type === 'text') && (
        <div className="grid2" style={{ marginTop: 6 }}>
          <Select<Sizing>
            value={single!.type === 'text' && single!.sizingH !== 'fill' ? (single!.autoResize === 'width' ? 'hug' : 'fixed') : single!.sizingH}
            icon={<ArrowLeftRight size={13} />}
            options={sizingOptions('H')}
            onChange={(v) => {
              if (single!.type === 'text') {
                const ar = v === 'hug' ? 'width' : single!.autoResize === 'width' ? 'height' : single!.autoResize;
                setSelectedProps({ sizingH: v, autoResize: ar } as Partial<SceneNode>, 'Sizing');
              } else setSelectedProps({ sizingH: v } as Partial<SceneNode>, 'Sizing');
            }}
          />
          <Select<Sizing>
            value={single!.type === 'text' && single!.sizingV !== 'fill' ? (single!.autoResize === 'none' ? 'fixed' : 'hug') : single!.sizingV}
            icon={<ArrowUpDown size={13} />}
            options={sizingOptions('V')}
            onChange={(v) => {
              if (single!.type === 'text') {
                const ar = v === 'hug' ? (single!.autoResize === 'none' ? 'height' : single!.autoResize) : 'none';
                setSelectedProps({ sizingV: v, autoResize: ar } as Partial<SceneNode>, 'Sizing');
              } else setSelectedProps({ sizingV: v } as Partial<SceneNode>, 'Sizing');
            }}
          />
        </div>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <NumberField label={<RotateCw size={12} />} tip="Rotation" value={num(mixed(nodes, (n) => n.rotation))} suffix="°" precision={1} onChange={(v) => setSelectedProps({ rotation: v } as Partial<SceneNode>, 'Rotate')} className="flex1" />
        <IconButton size="sm" icon={<ArrowLeftRight size={14} />} action="object.flipH" tip="Flip horizontal" />
        <IconButton size="sm" icon={<ArrowUpDown size={14} />} action="object.flipV" tip="Flip vertical" />
        <IconButton size="sm" icon={<RotateCw size={14} />} action="object.rotateCw" tip="Rotate 90°" />
      </div>
      {inAutoLayout && (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="label flex1">Ignore auto layout</span>
          <Segmented
            value={single!.layoutPositioning}
            options={[
              { value: 'auto', label: 'Flow' },
              { value: 'absolute', label: 'Absolute' },
            ]}
            onChange={(v) => setSelectedProps({ layoutPositioning: v } as Partial<SceneNode>)}
          />
        </div>
      )}
      {single && parent?.type === 'frame' && !parent.layout && <Constraints node={single} />}
    </Section>
  );
}

function Constraints({ node }: { node: SceneNode }) {
  return (
    <div className="grid2" style={{ marginTop: 6 }}>
      <Select<ConstraintH>
        value={node.constraints.h}
        tip="Horizontal constraint"
        icon={<ArrowLeftRight size={13} />}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
          { value: 'stretch', label: 'Left & right' },
          { value: 'center', label: 'Center' },
          { value: 'scale', label: 'Scale' },
        ]}
        onChange={(h) => updateSelected((n) => (n.constraints = { ...n.constraints, h }))}
      />
      <Select<ConstraintV>
        value={node.constraints.v}
        tip="Vertical constraint"
        icon={<ArrowUpDown size={13} />}
        options={[
          { value: 'top', label: 'Top' },
          { value: 'bottom', label: 'Bottom' },
          { value: 'stretch', label: 'Top & bottom' },
          { value: 'center', label: 'Center' },
          { value: 'scale', label: 'Scale' },
        ]}
        onChange={(v) => updateSelected((n) => (n.constraints = { ...n.constraints, v }))}
      />
    </div>
  );
}

function AutoLayoutSection({ node }: { node: FrameNode }) {
  const L = node.layout;
  const [perSide, setPerSide] = useState(false);
  const set = (p: Partial<AutoLayout>) => updateSelected((n) => n.type === 'frame' && n.layout && Object.assign(n.layout, p), 'Auto layout');
  if (!L)
    return (
      <Section
        title="Auto layout"
        empty
        onHeaderClick={() => editor().mutate((d) => setAutoLayout(d, node.id, true), { label: 'Auto layout' })}
        actions={<IconButton size="sm" icon={<Plus size={15} />} tip="Add auto layout" keyHint="⇧A" onClick={() => editor().mutate((d) => setAutoLayout(d, node.id, true), { label: 'Auto layout' })} />}
      />
    );
  const pads = L.padding;
  const uniform = pads.every((p) => p === pads[0]);
  return (
    <Section title="Auto layout" actions={<IconButton size="sm" icon={<Minus size={15} />} tip="Remove auto layout" onClick={() => editor().mutate((d) => setAutoLayout(d, node.id, false), { label: 'Remove auto layout' })} />}>
      <div className="row">
        <Segmented
          className="flex1"
          value={L.wrap ? 'wrap' : L.mode}
          options={[
            { value: 'vertical', label: <ArrowDownToLine size={14} />, tip: 'Vertical' },
            { value: 'horizontal', label: <ArrowRight size={14} />, tip: 'Horizontal' },
            { value: 'wrap', label: <TextWrap size={14} />, tip: 'Wrap' },
          ]}
          onChange={(v) => set(v === 'wrap' ? { mode: 'horizontal', wrap: true } : { mode: v as AutoLayout['mode'], wrap: false })}
        />
        <NumberField label={<span style={{ fontSize: 10 }}>↔</span>} tip="Gap between items" value={L.gap} onChange={(v) => set({ gap: v })} width={78} />
      </div>
      <div className="grid2" style={{ marginTop: 6 }}>
        <Select
          value={L.align}
          tip="Cross-axis alignment"
          options={[
            { value: 'start', label: L.mode === 'horizontal' ? 'Top' : 'Left' },
            { value: 'center', label: 'Center' },
            { value: 'end', label: L.mode === 'horizontal' ? 'Bottom' : 'Right' },
            { value: 'stretch', label: 'Stretch' },
          ]}
          onChange={(v) => set({ align: v as AutoLayout['align'] })}
        />
        <Select
          value={L.justify}
          tip="Main-axis distribution"
          options={[
            { value: 'start', label: 'Packed start' },
            { value: 'center', label: 'Packed center' },
            { value: 'end', label: 'Packed end' },
            { value: 'space-between', label: 'Space between' },
          ]}
          onChange={(v) => set({ justify: v as AutoLayout['justify'] })}
        />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        {perSide || !uniform ? (
          <div className="grid2 flex1" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            {(['T', 'R', 'B', 'L'] as const).map((k, i) => (
              <NumberField key={k} label={k} value={pads[i]} min={0} onChange={(v) => set({ padding: pads.map((p, j) => (j === i ? v : p)) as AutoLayout['padding'] })} />
            ))}
          </div>
        ) : (
          <div className="grid2 flex1">
            <NumberField label="H" tip="Horizontal padding" value={pads[1]} min={0} onChange={(v) => set({ padding: [pads[0], v, pads[2], v] })} />
            <NumberField label="V" tip="Vertical padding" value={pads[0]} min={0} onChange={(v) => set({ padding: [v, pads[1], v, pads[3]] })} />
          </div>
        )}
        <IconButton size="sm" icon={<IndependentCornersIcon size={14} />} active={perSide} tip="Individual padding" onClick={() => setPerSide(!perSide)} />
      </div>
    </Section>
  );
}

function AppearanceSection({ nodes }: { nodes: SceneNode[] }) {
  const [independent, setIndependent] = useState(false);
  const opacity = num(mixed(nodes, (n) => n.opacity));
  const blend = mixed(nodes, (n) => n.blendMode);
  const visible = mixed(nodes, (n) => n.visible);
  const hasCorners = nodes.every((n) => n.type === 'rect' || n.type === 'frame');
  const hasPolyRadius = nodes.every((n) => n.type === 'polygon' || n.type === 'star');
  const radii = hasCorners ? mixed(nodes, (n) => ('cornerRadii' in n && n.cornerRadii ? n.cornerRadii : null)) : null;
  const showIndependent = independent || (radii && radii !== 'mixed');
  return (
    <Section
      title="Appearance"
      actions={
        <>
          <IconButton size="sm" icon={visible === false ? <EyeOff size={14} /> : <Eye size={14} />} tip="Toggle visibility" action="object.hide" />
          <BlendButton value={blend} />
        </>
      }
    >
      <div className="grid2">
        <NumberField label={<Sun size={12} />} tip="Opacity" value={opacity} scale={100} precision={0} min={0} max={1} suffix="%" onChange={(v) => setSelectedProps({ opacity: v } as Partial<SceneNode>, 'Opacity')} />
        {hasCorners && (
          <div className="row" style={{ margin: 0, gap: 4 }}>
            <NumberField
              label={<CornerIcon size={12} />}
              tip="Corner radius"
              value={num(mixed(nodes, (n) => (n as any).cornerRadius))}
              min={0}
              onChange={(v) => setSelectedProps({ cornerRadius: v, cornerRadii: null } as any, 'Radius')}
              className="flex1"
            />
            <IconButton size="xs" icon={<IndependentCornersIcon size={13} />} active={!!showIndependent} tip="Independent corners" onClick={() => setIndependent(!showIndependent)} />
          </div>
        )}
        {hasPolyRadius && (
          <NumberField label={<CornerIcon size={12} />} tip="Corner radius" value={num(mixed(nodes, (n) => (n as any).cornerRadius))} min={0} onChange={(v) => setSelectedProps({ cornerRadius: v } as any, 'Radius')} />
        )}
      </div>
      {hasCorners && showIndependent && (
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 6 }}>
          {['↖', '↗', '↘', '↙'].map((lbl, i) => (
            <NumberField
              key={i}
              label={lbl}
              value={radii && radii !== 'mixed' ? radii[i] : num(mixed(nodes, (n) => (n as any).cornerRadius))}
              min={0}
              onChange={(v) =>
                updateSelected((n) => {
                  const base = (n as any).cornerRadii ?? [(n as any).cornerRadius, (n as any).cornerRadius, (n as any).cornerRadius, (n as any).cornerRadius];
                  base[i] = v;
                  (n as any).cornerRadii = [...base];
                }, 'Radius')
              }
            />
          ))}
        </div>
      )}
      {hasCorners && (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="label" style={{ width: 92 }}>
            Corner smoothing
          </span>
          <input
            type="range"
            className="slider flex1"
            min={0}
            max={1}
            step={0.01}
            value={num(mixed(nodes, (n) => (n as any).cornerSmoothing)) === 'mixed' ? 0 : (nodes[0] as any).cornerSmoothing}
            onPointerDown={() => editor().begin('Smoothing')}
            onPointerUp={() => editor().commit()}
            onChange={(e) => updateSelected((n) => ((n as any).cornerSmoothing = +e.target.value))}
          />
          <span className="muted" style={{ width: 34, textAlign: 'right' }}>
            {Math.round(((nodes[0] as any).cornerSmoothing ?? 0) * 100)}%
          </span>
        </div>
      )}
      {nodes.length === 1 && nodes[0].type === 'frame' && (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="label flex1">Clip content</span>
          <Segmented
            value={(nodes[0] as FrameNode).clipContent ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Clip' },
              { value: 'off', label: 'Overflow' },
            ]}
            onChange={(v) => updateSelected((n) => n.type === 'frame' && (n.clipContent = v === 'on'))}
          />
        </div>
      )}
    </Section>
  );
}

function BlendButton({ value }: { value: string | 'mixed' }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <IconButton size="sm" icon={<Blend size={14} />} active={value !== 'normal' && value !== 'mixed'} tip={`Blend: ${value}`} onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())} />
      {anchor && (
        <Popover anchor={anchor} placement="bottom-end" onClose={() => setAnchor(null)}>
          <MenuList
            onClose={() => setAnchor(null)}
            items={BLEND_OPTIONS.flatMap((o) => [
              ...(o.separatorBefore ? [{ separator: true }] : []),
              { label: o.label, checked: o.value === value, run: () => setSelectedProps({ blendMode: o.value } as Partial<SceneNode>, 'Blend') },
            ])}
          />
        </Popover>
      )}
    </>
  );
}

function ShapeSection({ nodes }: { nodes: SceneNode[] }) {
  const t = nodes[0].type;
  if (!nodes.every((n) => n.type === t)) return null;
  if (t === 'polygon') {
    return (
      <Section title="Polygon">
        <NumberField label="Sides" value={num(mixed(nodes, (n) => (n as PolygonNode).sides))} min={3} max={64} precision={0} onChange={(v) => setSelectedProps({ sides: Math.round(v) } as any)} />
      </Section>
    );
  }
  if (t === 'star') {
    return (
      <Section title="Star">
        <div className="grid2">
          <NumberField label="Pts" tip="Points" value={num(mixed(nodes, (n) => (n as StarNode).points))} min={3} max={100} precision={0} onChange={(v) => setSelectedProps({ points: Math.round(v) } as any)} />
          <NumberField label="Ratio" tip="Inner radius" value={num(mixed(nodes, (n) => (n as StarNode).innerRadius))} min={0.01} max={1} step={0.01} scale={100} precision={0} suffix="%" onChange={(v) => setSelectedProps({ innerRadius: v } as any)} />
        </div>
      </Section>
    );
  }
  if (t === 'ellipse') {
    return (
      <Section title={<><ArcIcon size={13} /> Arc</>}>
        <div className="grid3">
          <NumberField label="∠" tip="Start angle" value={num(mixed(nodes, (n) => (n as EllipseNode).arcStart))} onChange={(v) => setSelectedProps({ arcStart: v } as any)} />
          <NumberField label="◔" tip="Sweep (degrees)" value={num(mixed(nodes, (n) => (n as EllipseNode).arcSweep))} min={0} max={360} onChange={(v) => setSelectedProps({ arcSweep: v } as any)} />
          <NumberField label="◎" tip="Inner radius %" value={num(mixed(nodes, (n) => (n as EllipseNode).innerRadius))} min={0} max={0.99} step={0.01} scale={100} precision={0} onChange={(v) => setSelectedProps({ innerRadius: v } as any)} />
        </div>
      </Section>
    );
  }
  if (t === 'brush') {
    const b = (nodes[0] as BrushNode).brush;
    const setB = (p: Partial<BrushNode['brush']>) => updateSelected((n) => n.type === 'brush' && Object.assign(n.brush, p), 'Brush');
    return (
      <Section title="Brush">
        <div className="grid2">
          <Select
            value={b.kind}
            options={[
              { value: 'pen', label: 'Pen' },
              { value: 'ink', label: 'Ink' },
              { value: 'marker', label: 'Marker' },
              { value: 'highlighter', label: 'Highlighter' },
              { value: 'calligraphy', label: 'Calligraphy' },
            ]}
            onChange={(kind) => setB({ kind: kind as BrushNode['brush']['kind'] })}
          />
          <NumberField label="Size" value={b.size} min={0.5} onChange={(v) => setB({ size: v })} />
          <NumberField label="Thin" tip="Thinning" value={b.thinning} min={-1} max={1} step={0.05} onChange={(v) => setB({ thinning: v })} />
          <NumberField label="Smth" tip="Smoothing" value={b.smoothing} min={0} max={1} step={0.05} onChange={(v) => setB({ smoothing: v })} />
          <NumberField label="Taper" tip="Taper start" value={b.taperStart} min={0} onChange={(v) => setB({ taperStart: v })} />
          <NumberField label="End" tip="Taper end" value={b.taperEnd} min={0} onChange={(v) => setB({ taperEnd: v })} />
          {b.kind === 'calligraphy' && <NumberField label="Angle" value={b.angle} suffix="°" onChange={(v) => setB({ angle: v })} />}
        </div>
      </Section>
    );
  }
  if (t === 'bitmap') {
    const n = nodes[0] as BitmapNode;
    return (
      <Section title="Paint layer">
        <div className="row">
          <span className="label flex1">
            {n.pixelWidth} × {n.pixelHeight} px
          </span>
          <Segmented
            value={n.smoothing ? 'smooth' : 'pixel'}
            options={[
              { value: 'smooth', label: 'Smooth' },
              { value: 'pixel', label: 'Pixelated' },
            ]}
            onChange={(v) => updateSelected((x) => x.type === 'bitmap' && (x.smoothing = v === 'smooth'))}
          />
        </div>
        <div className="row">
          <span className="label flex1">Pixel grid</span>
          <Segmented
            value={n.pixelGrid ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Show' },
              { value: 'off', label: 'Hide' },
            ]}
            onChange={(v) => updateSelected((x) => x.type === 'bitmap' && (x.pixelGrid = v === 'on'))}
          />
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          Paint with <b>Shift+B</b>, erase with <b>E</b>, pixel pencil <b>X</b>, fill with <b>G</b>.
        </div>
      </Section>
    );
  }
  if (t === 'path') {
    return null;
  }
  return null;
}

function TextSection({ nodes }: { nodes: TextNode[] }) {
  const m = <K extends keyof TextNode>(k: K) => mixed(nodes, (n) => (n as TextNode)[k]);
  const set = (p: Partial<TextNode>) => setSelectedProps(p as Partial<SceneNode>, 'Text');
  const weight = m('fontWeight');
  return (
    <Section title="Typography">
      <div className="row">
        <FontPicker value={m('fontFamily') as string} onChange={(f) => set({ fontFamily: f })} />
      </div>
      <div className="grid2" style={{ marginTop: 6 }}>
        <Select<number>
          value={weight === 'mixed' ? 'mixed' : (weight as number)}
          options={WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
          onChange={(v) => set({ fontWeight: v })}
        />
        <NumberField label={<Hash size={12} />} tip="Font size" value={num(m('fontSize'))} min={1} onChange={(v) => set({ fontSize: v })} />
        <NumberField label="LH" tip="Line height (× size)" value={num(m('lineHeight'))} min={0.5} step={0.05} onChange={(v) => set({ lineHeight: v })} />
        <NumberField label="LS" tip="Letter spacing (px)" value={num(m('letterSpacing'))} step={0.1} onChange={(v) => set({ letterSpacing: v })} />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <Segmented
          className="flex1"
          value={(m('textAlign') as string) === 'mixed' ? null : (m('textAlign') as TextNode['textAlign'])}
          options={[
            { value: 'left', label: <AlignLeft size={14} />, tip: 'Align left' },
            { value: 'center', label: <AlignCenter size={14} />, tip: 'Align center' },
            { value: 'right', label: <AlignRight size={14} />, tip: 'Align right' },
            { value: 'justify', label: <AlignJustify size={14} />, tip: 'Justify' },
          ]}
          onChange={(v) => set({ textAlign: v })}
        />
        <Segmented
          className="flex1"
          value={(m('verticalAlign') as string) === 'mixed' ? null : (m('verticalAlign') as TextNode['verticalAlign'])}
          options={[
            { value: 'top', label: <ArrowUpToLine size={14} />, tip: 'Top' },
            { value: 'middle', label: <VMiddle size={14} />, tip: 'Middle' },
            { value: 'bottom', label: <ArrowDownToLine size={14} />, tip: 'Bottom' },
          ]}
          onChange={(v) => set({ verticalAlign: v, autoResize: 'none' })}
        />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <Segmented
          className="flex1"
          value={(m('autoResize') as string) === 'mixed' ? null : (m('autoResize') as TextNode['autoResize'])}
          options={[
            { value: 'width', label: 'Auto width', tip: 'Grow horizontally' },
            { value: 'height', label: 'Auto height', tip: 'Wrap, grow vertically' },
            { value: 'none', label: 'Fixed', tip: 'Fixed size' },
          ]}
          onChange={(v) => set({ autoResize: v })}
        />
      </div>
      <div className="grid2" style={{ marginTop: 6 }}>
        <Select
          value={m('textDecoration') as string}
          options={[
            { value: 'none', label: 'No decoration' },
            { value: 'underline', label: 'Underline' },
            { value: 'strikethrough', label: 'Strikethrough' },
          ]}
          onChange={(v) => set({ textDecoration: v as TextNode['textDecoration'] })}
        />
        <Select
          value={m('textCase') as string}
          options={[
            { value: 'none', label: 'As typed' },
            { value: 'upper', label: 'UPPERCASE' },
            { value: 'lower', label: 'lowercase' },
            { value: 'title', label: 'Title Case' },
          ]}
          onChange={(v) => set({ textCase: v as TextNode['textCase'] })}
        />
        <Select
          value={m('italic') ? 'italic' : 'normal'}
          options={[
            { value: 'normal', label: 'Upright' },
            { value: 'italic', label: 'Italic' },
          ]}
          onChange={(v) => set({ italic: v === 'italic' })}
        />
        <NumberField label="¶" tip="Paragraph spacing" value={num(m('paragraphSpacing'))} min={0} onChange={(v) => set({ paragraphSpacing: v })} />
      </div>
      <TextStylesRow nodes={nodes} />
    </Section>
  );
}

function TextStylesRow({ nodes }: { nodes: TextNode[] }) {
  const styles = useEditor((s) => s.doc.styles.text);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <button className="btn ghost flex1" style={{ justifyContent: 'flex-start' }} onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <WandSparkles size={13} /> Text styles
      </button>
      {anchor && (
        <Popover anchor={anchor} placement="left" offset={10} width={220} onClose={() => setAnchor(null)}>
          <MenuList
            onClose={() => setAnchor(null)}
            items={[
              ...styles.map((st) => ({
                label: `${st.name} — ${st.fontSize}/${st.fontWeight}`,
                run: () => {
                  const { id: _i, name: _n, ...props } = st;
                  setSelectedProps(props as Partial<SceneNode>, 'Apply text style');
                },
              })),
              ...(styles.length ? [{ separator: true }] : []),
              {
                label: 'Save as text style…',
                run: () => {
                  const n = nodes[0];
                  const st = {
                    id: uid(),
                    name: `${n.fontFamily} ${n.fontSize}`,
                    fontFamily: n.fontFamily,
                    fontSize: n.fontSize,
                    fontWeight: n.fontWeight,
                    italic: n.italic,
                    lineHeight: n.lineHeight,
                    letterSpacing: n.letterSpacing,
                    paragraphSpacing: n.paragraphSpacing,
                    textAlign: n.textAlign,
                    verticalAlign: n.verticalAlign,
                    textDecoration: n.textDecoration,
                    textCase: n.textCase,
                  };
                  editor().mutate((d) => void d.styles.text.push(st));
                  toast(`Saved “${st.name}”`, { kind: 'success' });
                },
              },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

function StrokeExtras({ nodes }: { nodes: SceneNode[] }) {
  const has = nodes.some((n) => n.strokes.length);
  if (!has) return null;
  const isPath = nodes.every((n) => n.type === 'path');
  const markerOpts: { value: Marker; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'arrow', label: 'Arrow' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'circle', label: 'Circle' },
    { value: 'square', label: 'Square' },
    { value: 'diamond', label: 'Diamond' },
    { value: 'bar', label: 'Bar' },
  ];
  const dash = mixed(nodes, (n) => n.dash.join(' '));
  return (
    <>
      <div className="grid2" style={{ marginTop: 6 }}>
        <NumberField label={<StrokeWeightIcon size={12} />} tip="Stroke weight" value={num(mixed(nodes, (n) => n.strokeWidth))} min={0} step={0.5} onChange={(v) => setSelectedProps({ strokeWidth: v } as Partial<SceneNode>, 'Stroke')} />
        <Select
          value={mixed(nodes, (n) => n.strokeAlign)}
          options={[
            { value: 'inside', label: 'Inside' },
            { value: 'center', label: 'Center' },
            { value: 'outside', label: 'Outside' },
          ]}
          onChange={(v) => setSelectedProps({ strokeAlign: v as SceneNode['strokeAlign'] } as Partial<SceneNode>, 'Stroke')}
        />
        <Select
          value={mixed(nodes, (n) => n.strokeCap)}
          tip="Line cap"
          options={[
            { value: 'butt', label: 'Butt cap' },
            { value: 'round', label: 'Round cap' },
            { value: 'square', label: 'Square cap' },
          ]}
          onChange={(v) => setSelectedProps({ strokeCap: v as SceneNode['strokeCap'] } as Partial<SceneNode>)}
        />
        <Select
          value={mixed(nodes, (n) => n.strokeJoin)}
          tip="Line join"
          options={[
            { value: 'miter', label: 'Miter join' },
            { value: 'round', label: 'Round join' },
            { value: 'bevel', label: 'Bevel join' },
          ]}
          onChange={(v) => setSelectedProps({ strokeJoin: v as SceneNode['strokeJoin'] } as Partial<SceneNode>)}
        />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="label" style={{ width: 44 }}>
          Dash
        </span>
        <input
          className="text-input flex1"
          placeholder="e.g. 6 4"
          defaultValue={dash === 'mixed' ? '' : dash}
          key={String(dash)}
          onBlur={(e) => {
            const arr = e.target.value
              .split(/[\s,]+/)
              .map(Number)
              .filter((v) => isFinite(v) && v >= 0);
            setSelectedProps({ dash: arr } as Partial<SceneNode>, 'Dash');
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
      {isPath && (
        <div className="grid2" style={{ marginTop: 6 }}>
          <Select<Marker> value={mixed(nodes, (n) => (n as PathNode).startMarker)} tip="Start" options={markerOpts.map((o) => ({ ...o, label: `Start: ${o.label}` }))} onChange={(v) => updateSelected((n) => n.type === 'path' && (n.startMarker = v))} />
          <Select<Marker> value={mixed(nodes, (n) => (n as PathNode).endMarker)} tip="End" options={markerOpts.map((o) => ({ ...o, label: `End: ${o.label}` }))} onChange={(v) => updateSelected((n) => n.type === 'path' && (n.endMarker = v))} />
        </div>
      )}
    </>
  );
}

function LayoutGridSection({ node }: { node: FrameNode }) {
  const grids = node.layoutGrids ?? [];
  const add = () =>
    updateSelected((n) => {
      if (n.type !== 'frame') return;
      n.layoutGrids = [...(n.layoutGrids ?? []), { id: uid(), type: 'columns', visible: true, size: 8, count: 12, gutter: 20, margin: 24, color: '#FF4D6D', opacity: 0.1 }];
    }, 'Layout grid');
  const set = (i: number, p: Partial<LayoutGrid>) => updateSelected((n) => n.type === 'frame' && Object.assign(n.layoutGrids[i], p), 'Layout grid');
  return (
    <Section title="Layout grid" empty={!grids.length} onHeaderClick={!grids.length ? add : undefined} actions={<IconButton size="sm" icon={<Plus size={15} />} tip="Add layout grid" onClick={add} />}>
      {grids.map((g, i) => (
        <div key={g.id} style={{ marginBottom: 6 }}>
          <div className="row">
            <Select
              className="flex1"
              value={g.type}
              icon={g.type === 'grid' ? <GridIcon size={13} /> : g.type === 'columns' ? <Columns3 size={13} /> : <Rows3 size={13} />}
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'columns', label: 'Columns' },
                { value: 'rows', label: 'Rows' },
              ]}
              onChange={(v) => set(i, { type: v as LayoutGrid['type'] })}
            />
            <IconButton size="sm" icon={g.visible ? <Eye size={14} /> : <EyeOff size={14} />} onClick={() => set(i, { visible: !g.visible })} />
            <IconButton size="sm" icon={<Minus size={14} />} onClick={() => updateSelected((n) => n.type === 'frame' && n.layoutGrids.splice(i, 1))} />
          </div>
          <div className="grid2" style={{ marginTop: 6 }}>
            {g.type === 'grid' ? (
              <NumberField label="Size" value={g.size} min={1} onChange={(v) => set(i, { size: v })} />
            ) : (
              <>
                <NumberField label="Count" value={g.count} min={1} precision={0} onChange={(v) => set(i, { count: Math.round(v) })} />
                <NumberField label="Gutter" value={g.gutter} min={0} onChange={(v) => set(i, { gutter: v })} />
                <NumberField label="Margin" value={g.margin} min={0} onChange={(v) => set(i, { margin: v })} />
              </>
            )}
            <NumberField label="%" tip="Opacity" value={g.opacity} scale={100} precision={0} min={0} max={1} onChange={(v) => set(i, { opacity: v })} />
          </div>
        </div>
      ))}
    </Section>
  );
}

/* ----------------------------------------------------------- page section */

function PageSection() {
  const page = useEditor((s) => getPage(s.doc, s.pageId));
  const styles = useEditor((s) => s.doc.styles);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [hex, setHex] = useState<string | null>(null);
  if (!page) return null;
  const bg = page.background || '';
  return (
    <>
      <Section title="Page">
        <div className="paint-row">
          <div className="paint-main">
            <span className="swatch" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
              <i style={{ background: bg || 'var(--bg-canvas)' }} />
            </span>
            <input
              value={hex ?? (bg ? bg.replace('#', '') : '')}
              placeholder="Theme default"
              style={{ textTransform: bg || hex !== null ? 'uppercase' : 'none' }}
              onFocus={(e) => {
                setHex(bg.replace('#', ''));
                e.target.select();
              }}
              onChange={(e) => setHex(e.target.value)}
              onBlur={() => {
                const h = hex !== null ? normalizeHex(hex) : null;
                setHex(null);
                editor().mutate((d) => {
                  const p = getPage(d, page.id)!;
                  p.background = h ?? '';
                });
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </div>
          <div className="row-actions">
            <IconButton size="sm" icon={<Minus size={14} />} tip="Use theme canvas colour" onClick={() => editor().mutate((d) => void (getPage(d, page.id)!.background = ''))} />
          </div>
        </div>
        {anchor && (
          <PaintPicker
            paint={{ id: 'bg', type: 'solid', color: bg || '#1A1A1D', opacity: 1, visible: true }}
            anchor={anchor}
            onClose={() => setAnchor(null)}
            onChange={(p) => p.type === 'solid' && editor().mutate((d) => void (getPage(d, page.id)!.background = p.color))}
          />
        )}
      </Section>
      <Section title="Local styles" empty={!styles.colors.length && !styles.text.length}>
        {styles.colors.map((c) => (
          <div className="row" key={c.id} style={{ marginTop: 4 }}>
            <span className="swatch">
              <i style={{ background: paintPreview(c.paint) }} />
            </span>
            <input
              className="text-input flex1"
              defaultValue={c.name}
              onBlur={(e) => editor().mutate((d) => void (d.styles.colors.find((x) => x.id === c.id)!.name = e.target.value))}
            />
            <IconButton size="sm" icon={<Minus size={14} />} onClick={() => editor().mutate((d) => void (d.styles.colors = d.styles.colors.filter((x) => x.id !== c.id)))} />
          </div>
        ))}
        {styles.text.map((t) => (
          <div className="row" key={t.id} style={{ marginTop: 4 }}>
            <span className="muted" style={{ width: 20, textAlign: 'center', fontWeight: 700 }}>
              Ag
            </span>
            <span className="flex1">{t.name}</span>
            <IconButton size="sm" icon={<Minus size={14} />} onClick={() => editor().mutate((d) => void (d.styles.text = d.styles.text.filter((x) => x.id !== t.id)))} />
          </div>
        ))}
      </Section>
      <ExportSection nodes={[]} />
    </>
  );
}

/* ------------------------------------------------------------------- main */

export function DesignPanel() {
  const nodes = useSelected();
  const editing = useEditor((s) => s.editing);
  if (!nodes.length) return <PageSection />;
  const single = nodes.length === 1 ? nodes[0] : null;
  const texts = nodes.filter((n) => n.type === 'text') as TextNode[];
  const allText = texts.length === nodes.length;
  const noFills = nodes.every((n) => n.type === 'group' || n.type === 'bitmap');
  return (
    <>
      <AlignBar />
      {single?.type === 'frame' && <FrameHeader node={single} />}
      <LayoutSection nodes={nodes} />
      {single?.type === 'frame' && <AutoLayoutSection node={single} />}
      <AppearanceSection nodes={nodes} />
      <ShapeSection nodes={nodes} />
      {allText && <TextSection nodes={texts} />}
      {!noFills && <PaintSection nodes={nodes} slot="fills" title="Fill" />}
      {!noFills && <PaintSection nodes={nodes} slot="strokes" title="Stroke" extra={<StrokeExtras nodes={nodes} />} />}
      <EffectsSection nodes={nodes} />
      {single?.type === 'frame' && <LayoutGridSection node={single} />}
      <ExportSection nodes={nodes} />
      {editing?.kind === 'path' && (
        <div className="section hint">
          Editing vector — drag points & handles, click a segment to add a point, double-click a point to toggle smooth, <b>Enter</b> to finish.
        </div>
      )}
      <QuickActions />
    </>
  );
}

function QuickActions() {
  const n = useEditor((s) => s.selection.length);
  return (
    <Section title="Quick actions">
      <div className="grid2">
        <button className="btn" onClick={() => runAction('object.repeat')}>
          <Repeat size={13} /> Repeat grid
        </button>
        <button className="btn" onClick={() => runAction('object.radialRepeat')}>
          <RotateCw size={13} /> Radial repeat
        </button>
        <button className="btn" disabled={n < 1} onClick={() => runAction('object.mask')}>
          <Ellipsis size={13} /> Mask
        </button>
        <button className="btn" onClick={() => runAction('object.flatten')}>
          <Ruler size={13} /> Flatten
        </button>
      </div>
    </Section>
  );
}

export { fitText, setProps };
