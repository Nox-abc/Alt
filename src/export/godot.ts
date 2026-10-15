/**
 * Godot 4 scene exporter (`.tscn`, format 3).
 *
 * Frames / rectangles / ellipses → Panel + StyleBoxFlat (bg, corner radii,
 * borders, shadow), text → Label (+ SystemFont), auto layout → PanelContainer
 * / MarginContainer + H/VBoxContainer (or HFlowContainer), gradients →
 * GradientTexture2D, images → TextureRect. Anything Godot can't draw is
 * rasterised to a PNG and shown with a TextureRect.
 */
import type { Doc, GradientPaint, ID, ImagePaint, SceneNode, TextNode } from '../core/types';
import { localMatrix, transformRect } from '../core/geometry';
import { applyCase } from '../core/text';
import type { ExportContext, ExportFile, Exporter } from './types';
import {
  childNodes,
  cornerRadii,
  dataUrlToBytes,
  FileNamer,
  flt,
  isGradient,
  isPlainEllipse,
  isVectorNode,
  MIME,
  num,
  r2,
  resolveRoots,
  rgb01,
  sanitizeFileName,
  snakeCase,
  sortedStops,
  uniformRadius,
  visibleEffects,
  visiblePaints,
} from './util';

type Props = [string, string][];

interface GdNode {
  name: string;
  type: string;
  props: Props;
  children: GdNode[];
}

interface Resource {
  kind: 'ext' | 'sub';
  type: string;
  id: string;
  props: Props;
  path?: string;
}

interface ImageJob {
  id: ID;
  file: string;
  assetId?: ID;
}

const gdString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '').replace(/\t/g, '\\t')}"`;

const gdColor = (hex: string, alpha = 1) => {
  const c = rgb01(hex);
  return `Color(${num(c.r, 4)}, ${num(c.g, 4)}, ${num(c.b, 4)}, ${num(Math.max(0, Math.min(1, alpha)), 4)})`;
};

const vec2 = (x: number, y: number) => `Vector2(${num(x, 3)}, ${num(y, 3)})`;

/** Godot node names can't contain . : @ / " % */
const nodeName = (s: string) => s.replace(/[.:@/"%\\]/g, '_').replace(/\s+/g, ' ').trim() || 'Node';

/* Size flags */
const SHRINK_BEGIN = 0;
const FILL = 1;
const EXPAND_FILL = 3;
const SHRINK_CENTER = 4;
const SHRINK_END = 8;

class GodotBuilder {
  readonly resources: Resource[] = [];
  readonly jobs: ImageJob[] = [];
  readonly notes = new Set<string>();
  private ids = new Set<string>();
  private files = new FileNamer();
  private textures = new Map<string, string>();

  constructor(
    readonly doc: Doc,
    readonly resPath: string,
  ) {}

  private note(n: SceneNode, msg: string) {
    this.notes.add(`"${n.name}": ${msg}`);
  }

  private resId(type: string, hint: string): string {
    const base = `${type}_${snakeCase(hint) || 'res'}`;
    let id = base;
    let i = 2;
    while (this.ids.has(id)) id = `${base}_${i++}`;
    this.ids.add(id);
    return id;
  }

  private sub(type: string, hint: string, props: Props): string {
    const id = this.resId(type, hint);
    this.resources.push({ kind: 'sub', type, id, props });
    return `SubResource("${id}")`;
  }

  private texture(n: SceneNode, assetId?: ID): string {
    const key = assetId ?? `node:${n.id}`;
    const hit = this.textures.get(key);
    if (hit) return hit;
    const asset = assetId ? this.doc.assets[assetId] : undefined;
    const ext = asset && /jpe?g/.test(asset.mime) ? 'jpg' : 'png';
    const file = this.files.get(sanitizeFileName(asset?.name?.replace(/\.[a-z0-9]+$/i, '') ?? n.name), ext);
    this.jobs.push({ id: n.id, file, assetId: asset && /png|jpe?g|webp/.test(asset.mime) ? assetId : undefined });
    const id = `${this.resources.filter((r) => r.kind === 'ext').length + 1}_${snakeCase(file.replace(/\.[a-z]+$/, '')) || 'img'}`;
    this.resources.push({ kind: 'ext', type: 'Texture2D', id, props: [], path: `${this.resPath}${file}` });
    const ref = `ExtResource("${id}")`;
    this.textures.set(key, ref);
    return ref;
  }

  /* -------------------------------------------------------- placement */

  private placement(n: SceneNode, mode: 'root' | 'abs' | 'flow', parentLayout: { horiz: boolean; align: string } | null, box?: { x: number; y: number; width: number; height: number }): Props {
    const p: Props = [];
    const b = box ?? { x: n.x, y: n.y, width: n.width, height: n.height };
    if (mode === 'root') {
      p.push(['layout_mode', '3'], ['anchors_preset', '0'], ['offset_right', flt(n.width)], ['offset_bottom', flt(n.height)]);
    } else if (mode === 'abs') {
      p.push(['layout_mode', '0'], ['offset_left', flt(b.x)], ['offset_top', flt(b.y)], ['offset_right', flt(b.x + b.width)], ['offset_bottom', flt(b.y + b.height)]);
    } else if (parentLayout) {
      const mainFill = parentLayout.horiz ? n.sizingH === 'fill' : n.sizingV === 'fill';
      const crossFill = (parentLayout.horiz ? n.sizingV : n.sizingH) === 'fill' || parentLayout.align === 'stretch';
      const hugW = n.type === 'text' && n.autoResize === 'width';
      const hugH = n.type === 'text' && n.autoResize !== 'none';
      const w = hugW ? 0 : parentLayout.horiz ? (mainFill ? 0 : n.width) : crossFill ? 0 : n.width;
      const h = hugH ? 0 : parentLayout.horiz ? (crossFill ? 0 : n.height) : mainFill ? 0 : n.height;
      p.push(['layout_mode', '2']);
      if (w || h) p.push(['custom_minimum_size', vec2(w, h)]);
      const cross = crossFill ? FILL : { start: SHRINK_BEGIN, center: SHRINK_CENTER, end: SHRINK_END, stretch: FILL }[parentLayout.align as 'start'];
      const [hFlag, vFlag] = parentLayout.horiz ? [mainFill ? EXPAND_FILL : FILL, cross] : [cross, mainFill ? EXPAND_FILL : FILL];
      if (hFlag !== FILL) p.push(['size_flags_horizontal', String(hFlag)]);
      if (vFlag !== FILL) p.push(['size_flags_vertical', String(vFlag)]);
    }
    if (mode !== 'root' && box === undefined) {
      const rot = r2(n.rotation, 3);
      if (rot || n.flipX || n.flipY) p.push(['pivot_offset', vec2(n.width / 2, n.height / 2)]);
      if (rot) p.push(['rotation', num((rot * Math.PI) / 180, 5)]);
      if (n.flipX || n.flipY) p.push(['scale', vec2(n.flipX ? -1 : 1, n.flipY ? -1 : 1)]);
    }
    if (n.opacity < 0.999) p.push(['modulate', `Color(1, 1, 1, ${num(n.opacity, 3)})`]);
    if (n.blendMode === 'multiply' || n.blendMode === 'plus-lighter') {
      const mat = this.sub('CanvasItemMaterial', `${n.name} blend`, [['blend_mode', n.blendMode === 'multiply' ? '3' : '1']]);
      p.push(['material', mat]);
    } else if (n.blendMode !== 'normal') this.note(n, `blend mode ${n.blendMode} is not supported.`);
    return p;
  }

  /* ------------------------------------------------------------- style */

  /** StyleBoxFlat for a box-like node (null when it would draw nothing). */
  private styleBox(n: SceneNode, padding?: [number, number, number, number]): string | null {
    const props: Props = [];
    const fill = visiblePaints(n.fills).filter((p) => p.type !== 'image').at(-1);
    if (fill && fill.type === 'solid') props.push(['bg_color', gdColor(fill.color, fill.opacity)]);
    else if (fill && !isGradient(fill)) props.push(['bg_color', gdColor(fill.background ?? fill.color, fill.opacity)]);
    else props.push(['draw_center', 'false']);
    // corners
    let radii: [number, number, number, number] | null = null;
    if (isPlainEllipse(n)) {
      const r = Math.min(n.width, n.height) / 2;
      radii = [r, r, r, r];
      if (Math.abs(n.width - n.height) > 1) this.note(n, 'non-circular ellipse drawn as a pill.');
    } else if (n.type === 'rect' || n.type === 'frame') radii = cornerRadii(n);
    if (radii) {
      const names = ['corner_radius_top_left', 'corner_radius_top_right', 'corner_radius_bottom_right', 'corner_radius_bottom_left'];
      radii.forEach((r, i) => r > 0 && props.push([names[i], String(Math.round(r))]));
      if (radii.some((r) => r > 0)) props.push(['corner_detail', isPlainEllipse(n) ? '16' : '8']);
    }
    // border (drawn inside the box; expand margins move it outside)
    const stroke = visiblePaints(n.strokes).filter((p) => p.type !== 'image').at(-1);
    if (stroke && n.strokeWidth > 0) {
      const w = Math.max(1, Math.round(n.strokeWidth));
      const color = stroke.type === 'solid' ? stroke.color : isGradient(stroke) ? sortedStops(stroke)[0].color : stroke.color;
      for (const side of ['left', 'top', 'right', 'bottom']) props.push([`border_width_${side}`, String(w)]);
      props.push(['border_color', gdColor(color, stroke.opacity)]);
      const grow = n.strokeAlign === 'outside' ? w : n.strokeAlign === 'center' ? w / 2 : 0;
      if (grow) for (const side of ['left', 'top', 'right', 'bottom']) props.push([`expand_margin_${side}`, flt(grow)]);
      if (n.dash.some((d) => d > 0)) this.note(n, 'dashed borders are not supported.');
    }
    // shadow
    const shadows = visibleEffects(n.effects).filter((e) => e.type === 'drop-shadow' || e.type === 'glow');
    const sh = shadows[0];
    if (sh && (sh.type === 'drop-shadow' || sh.type === 'glow')) {
      props.push(['shadow_color', gdColor(sh.color, sh.opacity)], ['shadow_size', String(Math.max(1, Math.round(sh.blur / 2 + Math.max(0, sh.spread))))]);
      if (sh.type === 'drop-shadow' && (sh.x || sh.y)) props.push(['shadow_offset', vec2(sh.x, sh.y)]);
      if (shadows.length > 1) this.note(n, 'only the first shadow is exported.');
    }
    if (padding) {
      const [t, r, b, l] = padding;
      if (l) props.push(['content_margin_left', flt(l)]);
      if (t) props.push(['content_margin_top', flt(t)]);
      if (r) props.push(['content_margin_right', flt(r)]);
      if (b) props.push(['content_margin_bottom', flt(b)]);
    }
    for (const e of visibleEffects(n.effects)) if (e.type !== 'drop-shadow' && e.type !== 'glow') this.note(n, `${e.type.replace('-', ' ')} effect is not supported.`);
    const draws = props.some(([k]) => k === 'bg_color' || k.startsWith('border_width') || k === 'shadow_color');
    if (!draws && !padding) return null;
    return this.sub('StyleBoxFlat', n.name, props);
  }

  private gradientTexture(p: GradientPaint, n: SceneNode): string {
    const stops = sortedStops(p);
    const grad = this.sub('Gradient', `${n.name} gradient`, [
      ['offsets', `PackedFloat32Array(${stops.map((s) => num(s.offset, 4)).join(', ')})`],
      [
        'colors',
        `PackedColorArray(${stops
          .map((s) => {
            const c = rgb01(s.color);
            return [c.r, c.g, c.b, s.opacity * p.opacity].map((v) => num(v, 4)).join(', ');
          })
          .join(', ')})`,
      ],
    ]);
    const fill = p.type === 'linear' ? '0' : p.type === 'diamond' ? '2' : '1';
    const props: Props = [['gradient', grad], ['width', String(Math.max(1, Math.round(n.width)))], ['height', String(Math.max(1, Math.round(n.height)))]];
    if (fill !== '0') props.push(['fill', fill]);
    props.push(['fill_from', vec2(p.from.x, p.from.y)], ['fill_to', vec2(p.to.x, p.to.y)]);
    return this.sub('GradientTexture2D', `${n.name} texture`, props);
  }

  /* ------------------------------------------------------------- nodes */

  build(rootId: ID): GdNode {
    return this.node(this.doc.nodes[rootId], 'root', null)!;
  }

  private node(n: SceneNode, mode: 'root' | 'abs' | 'flow', parentLayout: { horiz: boolean; align: string } | null): GdNode | null {
    if (!n.visible && mode !== 'root') return null;
    const name = nodeName(n.name);
    if (n.type === 'text') return { name, type: 'Label', props: [...this.placement(n, mode, parentLayout), ...this.label(n)], children: [] };

    const img = visiblePaints(n.fills).filter((p): p is ImagePaint => p.type === 'image').at(-1);
    if (n.type === 'bitmap' || (img && n.type === 'rect')) {
      const assetId = n.type === 'bitmap' ? n.assetId : img!.assetId;
      const props: Props = [...this.placement(n, mode, parentLayout), ['texture', this.texture(n, assetId)], ['expand_mode', '1']];
      const fit = n.type === 'bitmap' ? 'stretch' : img!.fit;
      const stretch = { stretch: '0', tile: '1', fit: '5', fill: '6', crop: '6' }[fit];
      if (stretch !== '0') props.push(['stretch_mode', stretch]);
      if (n.type === 'bitmap' && !n.smoothing) props.push(['texture_filter', '1']);
      if (n.type === 'rect' && (uniformRadius(n) !== 0 || visiblePaints(n.strokes).length)) this.note(n, 'image corner radius / stroke not exported.');
      return { name, type: 'TextureRect', props, children: [] };
    }

    const kids = n.type === 'frame' || n.type === 'group' ? childNodes(this.doc, n) : [];
    const masked = kids.some((k) => k.isMask);
    const top = visiblePaints(n.fills).filter((p) => p.type !== 'image').at(-1);
    const leafGradient = !kids.length && top && isGradient(top);
    const decorated = visiblePaints(n.strokes).length > 0 || visibleEffects(n.effects).length > 0;
    const raster = isVectorNode(n) || masked || (leafGradient && (top!.type === 'angular' || uniformRadius(n) !== 0 || isPlainEllipse(n) || decorated));
    if (raster && mode !== 'root') {
      // rendered by Alt: the image already contains the rotation
      const box = transformRect(localMatrix(n), { x: 0, y: 0, width: n.width, height: n.height });
      const props: Props = [...this.placement(n, mode, parentLayout, box), ['texture', this.texture(n)], ['expand_mode', '1']];
      return { name, type: 'TextureRect', props, children: [] };
    }
    if (leafGradient) {
      const props: Props = [...this.placement(n, mode, parentLayout), ['texture', this.gradientTexture(top as GradientPaint, n)], ['expand_mode', '1']];
      return { name, type: 'TextureRect', props, children: [] };
    }

    const L = n.type === 'frame' ? n.layout : null;
    const container = !!L && kids.length > 0 && kids.every((k) => k.layoutPositioning !== 'absolute');
    if (L && !container && kids.length) this.note(n, 'auto layout with absolutely positioned children exported with fixed positions.');
    const placement = this.placement(n, mode, parentLayout);
    const clip: Props = n.type === 'frame' && n.clipContent && kids.length ? [['clip_contents', 'true']] : [];
    const gradientBg = top && isGradient(top) && n.type !== 'group' ? this.gradientBackground(top, n) : null;

    if (container && L) {
      const horiz = L.mode === 'horizontal';
      const wrap = L.wrap && horiz;
      const [pt, pr, pb, pl] = L.padding;
      let gap = L.gap;
      if (L.justify === 'space-between' && kids.length > 1 && !wrap) {
        const inner = (horiz ? n.width - pl - pr : n.height - pt - pb) - kids.reduce((a, k) => a + (horiz ? k.width : k.height), 0);
        gap = Math.max(0, inner / (kids.length - 1));
      }
      const boxProps: Props = [];
      if (wrap) boxProps.push(['theme_override_constants/h_separation', String(Math.round(gap))], ['theme_override_constants/v_separation', String(Math.round(gap))]);
      else if (Math.round(gap) !== 4) boxProps.push(['theme_override_constants/separation', String(Math.round(gap))]);
      const align = { start: 0, center: 1, end: 2, 'space-between': 0 }[L.justify];
      if (align) boxProps.push(['alignment', String(align)]);
      const flowLayout = { horiz, align: L.align };
      const children = kids.map((k) => this.node(k, 'flow', flowLayout)).filter((c): c is GdNode => !!c);
      const boxType = wrap ? 'HFlowContainer' : horiz ? 'HBoxContainer' : 'VBoxContainer';
      const style = this.styleBox(n, L.padding);
      const hasPadding = pt || pr || pb || pl;
      if (!style && !hasPadding && !gradientBg) return { name, type: boxType, props: [...placement, ...clip, ...boxProps], children };
      const inner: GdNode = { name: 'Layout', type: boxType, props: [['layout_mode', '2'], ...boxProps], children };
      if (gradientBg) {
        // MarginContainer keeps the gradient background behind the stack
        const margins: Props = hasPadding ? [['theme_override_constants/margin_left', String(pl)], ['theme_override_constants/margin_top', String(pt)], ['theme_override_constants/margin_right', String(pr)], ['theme_override_constants/margin_bottom', String(pb)]] : [];
        return {
          name,
          type: 'Control',
          props: [...placement, ...clip],
          children: [gradientBg, { name: 'Content', type: 'MarginContainer', props: [['layout_mode', '1'], ['anchors_preset', '15'], ['anchor_right', '1.0'], ['anchor_bottom', '1.0'], ...margins], children: [inner] }],
        };
      }
      if (style) return { name, type: 'PanelContainer', props: [...placement, ...clip, ['theme_override_styles/panel', style]], children: [inner] };
      return {
        name,
        type: 'MarginContainer',
        props: [...placement, ...clip, ['theme_override_constants/margin_left', String(pl)], ['theme_override_constants/margin_top', String(pt)], ['theme_override_constants/margin_right', String(pr)], ['theme_override_constants/margin_bottom', String(pb)]],
        children: [inner],
      };
    }

    const children = kids.filter((k) => !k.isMask).map((k) => this.node(k, 'abs', null)).filter((c): c is GdNode => !!c);
    if (gradientBg) children.unshift(gradientBg);
    const style = n.type === 'group' ? null : this.styleBox(n);
    if (style) return { name, type: 'Panel', props: [...placement, ...clip, ['theme_override_styles/panel', style]], children };
    return { name, type: 'Control', props: [...placement, ...clip], children };
  }

  /** Full-rect gradient TextureRect used as a container background. */
  private gradientBackground(p: GradientPaint, n: SceneNode): GdNode {
    if (uniformRadius(n) !== 0) this.note(n, 'gradient background ignores the corner radius.');
    return {
      name: 'Background',
      type: 'TextureRect',
      props: [
        ['layout_mode', '1'],
        ['anchors_preset', '15'],
        ['anchor_right', '1.0'],
        ['anchor_bottom', '1.0'],
        ['mouse_filter', '2'],
        ['texture', this.gradientTexture(p, n)],
        ['expand_mode', '1'],
      ],
      children: [],
    };
  }

  private label(n: TextNode): Props {
    const p: Props = [];
    const fill = visiblePaints(n.fills).filter((x) => x.type !== 'image').at(-1);
    const color = !fill ? null : fill.type === 'solid' ? gdColor(fill.color, fill.opacity) : isGradient(fill) ? gdColor(sortedStops(fill)[0].color, fill.opacity) : gdColor(fill.color, fill.opacity);
    if (fill && isGradient(fill)) this.note(n, 'gradient text exported with its first colour.');
    const fontProps: Props = [['font_names', `PackedStringArray(${gdString(n.fontFamily)})`]];
    if (Math.round(n.fontWeight) !== 400) fontProps.push(['font_weight', String(Math.round(n.fontWeight))]);
    if (n.italic) fontProps.push(['font_italic', 'true']);
    const font = this.sub('SystemFont', `${n.fontFamily} ${n.fontWeight}${n.italic ? ' italic' : ''}`, fontProps);
    if (color) p.push(['theme_override_colors/font_color', color]);
    const stroke = visiblePaints(n.strokes).filter((x) => x.type === 'solid').at(-1);
    if (stroke && stroke.type === 'solid' && n.strokeWidth > 0) {
      p.push(['theme_override_colors/font_outline_color', gdColor(stroke.color, stroke.opacity)], ['theme_override_constants/outline_size', String(Math.round(n.strokeAlign === 'center' ? n.strokeWidth : n.strokeWidth * 2))]);
    }
    const shadow = visibleEffects(n.effects).find((e) => e.type === 'drop-shadow');
    if (shadow && shadow.type === 'drop-shadow') {
      p.push(['theme_override_colors/font_shadow_color', gdColor(shadow.color, shadow.opacity)]);
      if (shadow.x) p.push(['theme_override_constants/shadow_offset_x', String(Math.round(shadow.x))]);
      if (shadow.y) p.push(['theme_override_constants/shadow_offset_y', String(Math.round(shadow.y))]);
      if (shadow.blur) p.push(['theme_override_constants/shadow_outline_size', String(Math.round(shadow.blur / 2))]);
    }
    const extra = Math.round((n.lineHeight - 1.2) * n.fontSize);
    if (extra) p.push(['theme_override_constants/line_spacing', String(extra)]);
    p.push(['theme_override_fonts/font', font], ['theme_override_font_sizes/font_size', String(Math.round(n.fontSize))]);
    const upper = n.textCase === 'upper';
    p.push(['text', gdString(upper ? n.text : applyCase(n.text, n.textCase))]);
    const h = { left: 0, center: 1, right: 2, justify: 3 }[n.textAlign];
    if (h) p.push(['horizontal_alignment', String(h)]);
    const v = n.autoResize === 'none' ? { top: 0, middle: 1, bottom: 2 }[n.verticalAlign] : 0;
    if (v) p.push(['vertical_alignment', String(v)]);
    if (n.autoResize !== 'width') p.push(['autowrap_mode', '3']);
    if (upper) p.push(['uppercase', 'true']);
    if (n.textDecoration !== 'none') this.note(n, `${n.textDecoration} is not supported by Label (use RichTextLabel).`);
    if (n.letterSpacing) this.note(n, 'letter spacing is not exported.');
    return p;
  }
}

/* ------------------------------------------------------------- serialise */

export function toTscn(root: GdNode, resources: Resource[], notes: string[]): string {
  const lines: string[] = [];
  const ext = resources.filter((r) => r.kind === 'ext');
  const sub = resources.filter((r) => r.kind === 'sub');
  lines.push(`[gd_scene load_steps=${ext.length + sub.length + 1} format=3]`, '');
  if (notes.length) {
    lines.push('; Exported from Alt.', ...notes.map((n) => `; ${n}`), '');
  }
  for (const r of ext) lines.push(`[ext_resource type="${r.type}" path=${gdString(r.path ?? '')} id="${r.id}"]`);
  if (ext.length) lines.push('');
  for (const r of sub) {
    lines.push(`[sub_resource type="${r.type}" id="${r.id}"]`);
    for (const [k, v] of r.props) lines.push(`${k} = ${v}`);
    lines.push('');
  }
  const walk = (n: GdNode, parentPath: string | null) => {
    const parent = parentPath === null ? '' : ` parent=${gdString(parentPath)}`;
    lines.push(`[node name=${gdString(n.name)} type="${n.type}"${parent}]`);
    for (const [k, v] of n.props) lines.push(`${k} = ${v}`);
    lines.push('');
    // sibling names must be unique
    const used = new Set<string>();
    for (const c of n.children) {
      let name = c.name;
      let i = 2;
      while (used.has(name)) name = `${c.name}${i++}`;
      used.add(name);
      c.name = name;
      walk(c, parentPath === null ? '.' : parentPath === '.' ? n.name : `${parentPath}/${n.name}`);
    }
  };
  walk(root, null);
  return lines.join('\n').trimEnd() + '\n';
}

/** Build a .tscn for one root (exposed for tests). */
export function buildTscn(doc: Doc, rootId: ID, resPath = 'res://assets/'): { tscn: string; images: ImageJob[] } {
  const b = new GodotBuilder(doc, resPath);
  const tree = b.build(rootId);
  return { tscn: toTscn(tree, b.resources, [...b.notes]), images: b.jobs };
}

async function imageFiles(ctx: ExportContext, jobs: ImageJob[]): Promise<ExportFile[]> {
  const out: ExportFile[] = [];
  for (const j of jobs) {
    if (j.assetId) {
      const decoded = dataUrlToBytes(ctx.doc.assets[j.assetId]?.data ?? '');
      if (decoded) {
        out.push({ name: j.file, mime: decoded.mime, data: decoded.bytes });
        continue;
      }
    }
    try {
      out.push({ name: j.file.replace(/\.[a-z]+$/i, '.png'), mime: 'image/png', data: await ctx.rasterize([j.id], { scale: 2, format: 'png', background: null }) });
    } catch (e) {
      console.warn(`Couldn't rasterize ${j.file}`, e);
    }
  }
  return out;
}

export const godotExporter: Exporter = {
  id: 'godot',
  label: 'Godot 4 scene',
  group: 'Game engines',
  extension: 'tscn',
  description: 'A .tscn UI scene: Panels with StyleBoxFlat, Labels, Box/Flow containers and TextureRects.',
  textual: true,
  options: [{ key: 'resPath', label: 'Image folder', type: 'text', default: 'res://assets/' }],
  async run(ctx: ExportContext): Promise<ExportFile[]> {
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    let resPath = typeof ctx.options.resPath === 'string' && ctx.options.resPath.trim() ? ctx.options.resPath.trim() : 'res://assets/';
    if (!resPath.endsWith('/')) resPath += '/';
    const names = new FileNamer();
    const files: ExportFile[] = [];
    for (const id of roots) {
      const { tscn, images } = buildTscn(ctx.doc, id, resPath);
      files.push({ name: names.get(snakeCase(ctx.doc.nodes[id].name) || 'scene', 'tscn'), mime: MIME.tscn, data: tscn });
      files.push(...(await imageFiles(ctx, images)));
    }
    return files;
  },
};
