import type { Doc, Effect, ID, NodeType, Paint, SceneNode } from '../core/types';
import { editor } from '../core/store';
import { createNode, defaultEffect, gradient, solid, uid } from '../core/doc';
import { addPage, fitText, groupNodes, insertNode, pagePointToParent } from '../core/ops';
import { cmdsToSubPaths, parseSvgPath } from '../core/path';
import { worldBounds } from '../core/geometry';
import { zoomToRect, viewCenter } from '../editor/viewport';

export interface Spec {
  type: NodeType;
  props?: Record<string, unknown>;
  d?: string;
  children?: Spec[];
}

const shadow = (y: number, blur: number, opacity = 0.18, color = '#000000'): Effect => ({ ...(defaultEffect('drop-shadow') as any), y, blur, opacity, color });
const lin = (a: string, b: string, angle: 'v' | 'h' | 'd' = 'v'): Paint => {
  const g = gradient('linear', a, b);
  if (angle === 'h') {
    g.from = { x: 0, y: 0.5 };
    g.to = { x: 1, y: 0.5 };
  } else if (angle === 'd') {
    g.from = { x: 0, y: 0 };
    g.to = { x: 1, y: 1 };
  }
  return g;
};

/** Create a node tree from a compact spec. Returns the root id. */
export function build(d: Doc, parentId: ID, spec: Spec): ID {
  const props = { ...(spec.props ?? {}) } as Partial<SceneNode> & Record<string, unknown>;
  const n = createNode(spec.type, { parentId, ...(props as any) });
  if (spec.type === 'path' && spec.d) {
    (n as any).paths = cmdsToSubPaths(parseSvgPath(spec.d));
  }
  insertNode(d, n, parentId);
  if (n.type === 'text') fitText(d, n.id);
  for (const c of spec.children ?? []) build(d, n.id, c);
  return n.id;
}

function txt(text: string, size: number, weight = 400, color = '#111111', extra: Record<string, unknown> = {}): Spec {
  return { type: 'text', props: { text, fontSize: size, fontWeight: weight, fills: [solid(color)], name: text.slice(0, 32), ...extra } };
}

function place(specFactory: () => Spec, name: string) {
  const s = editor();
  const c = viewCenter();
  const id = s.mutate(
    (d) => {
      const root = build(d, s.pageId, specFactory());
      const n = d.nodes[root];
      const p = pagePointToParent(d, s.pageId, c);
      n.x = Math.round(p.x - n.width / 2);
      n.y = Math.round(p.y - n.height / 2);
      return root;
    },
    { select: (r) => [r], label: `Insert ${name}` },
  );
  requestAnimationFrame(() => zoomToRect(worldBounds(editor().doc, id), { maxZoom: 1 }));
  return id;
}

export const TEMPLATES: { id: string; name: string; hint: string; create: () => void }[] = [
  {
    id: 'mobile',
    name: 'Mobile app',
    hint: 'Auto-layout screen',
    create: () =>
      place(
        () => ({
          type: 'frame',
          props: { name: 'Home — iPhone 16', width: 393, height: 852, fills: [solid('#F6F6F9')], cornerRadius: 44, cornerSmoothing: 0.6, layout: { mode: 'vertical', gap: 18, padding: [64, 22, 32, 22], align: 'stretch', justify: 'start', wrap: false }, sizingV: 'fixed', sizingH: 'fixed' },
          children: [
            txt('Good morning', 15, 500, '#8A8A94'),
            txt('Your studio', 32, 750, '#111114', { letterSpacing: -0.8 }),
            {
              type: 'frame',
              props: { name: 'Hero card', height: 190, fills: [lin('#7C6CFF', '#E046C9', 'd')], cornerRadius: 26, cornerSmoothing: 0.6, effects: [shadow(14, 34, 0.28, '#5B3FFF')], layout: { mode: 'vertical', gap: 6, padding: [24, 24, 24, 24], align: 'start', justify: 'end', wrap: false }, sizingH: 'fill', sizingV: 'fixed' },
              children: [txt('Weekly streak', 14, 500, '#FFFFFF', { opacity: 0.8 }), txt('12 designs shipped', 26, 700, '#FFFFFF', { letterSpacing: -0.4 })],
            },
            {
              type: 'frame',
              props: { name: 'Stats row', fills: [], layout: { mode: 'horizontal', gap: 12, padding: [0, 0, 0, 0], align: 'stretch', justify: 'start', wrap: false }, sizingH: 'fill', sizingV: 'hug' },
              children: ['Projects|48', 'Exports|312', 'Agents|3'].map((s) => {
                const [a, b] = s.split('|');
                return {
                  type: 'frame',
                  props: { name: a, height: 92, fills: [solid('#FFFFFF')], cornerRadius: 20, cornerSmoothing: 0.6, effects: [shadow(4, 16, 0.06)], layout: { mode: 'vertical', gap: 4, padding: [16, 16, 16, 16], align: 'start', justify: 'center', wrap: false }, sizingH: 'fill', sizingV: 'fixed' },
                  children: [txt(b, 24, 700, '#111114'), txt(a, 12, 500, '#8A8A94')],
                } as Spec;
              }),
            },
            {
              type: 'frame',
              props: { name: 'Primary button', height: 56, fills: [solid('#111114')], cornerRadius: 18, cornerSmoothing: 0.6, layout: { mode: 'horizontal', gap: 8, padding: [0, 20, 0, 20], align: 'center', justify: 'center', wrap: false }, sizingH: 'fill', sizingV: 'fixed' },
              children: [txt('New design', 16, 600, '#FFFFFF')],
            },
          ],
        }),
        'mobile template',
      ),
  },
  {
    id: 'roblox',
    name: 'Roblox HUD',
    hint: 'Exports to .rbxmx',
    create: () =>
      place(
        () => ({
          type: 'frame',
          props: { name: 'Roblox HUD', width: 1280, height: 720, fills: [lin('#1B2340', '#0B0F1C')], clipContent: true },
          children: [
            {
              type: 'frame',
              props: { name: 'HealthBar', x: 32, y: 32, width: 360, height: 40, fills: [solid('#0E1220', 0.85)], cornerRadius: 12, strokes: [solid('#FFFFFF', 0.12)], strokeWidth: 2 },
              children: [{ type: 'rect', props: { name: 'Fill', x: 4, y: 4, width: 260, height: 32, cornerRadius: 9, fills: [lin('#3CCF8E', '#16A36B', 'h')] } }, txt('HP 72 / 100', 15, 700, '#FFFFFF', { x: 16, y: 10 })],
            },
            {
              type: 'frame',
              props: { name: 'Coins', x: 1048, y: 32, width: 200, height: 52, fills: [solid('#0E1220', 0.85)], cornerRadius: 26, strokes: [solid('#FFC83D', 0.6)], strokeWidth: 2, layout: { mode: 'horizontal', gap: 10, padding: [0, 18, 0, 12], align: 'center', justify: 'start', wrap: false }, sizingH: 'fixed', sizingV: 'fixed' },
              children: [{ type: 'ellipse', props: { name: 'Coin', width: 30, height: 30, fills: [lin('#FFE27A', '#F5A623')], strokes: [solid('#B8740F')], strokeWidth: 2 } }, txt('12,480', 20, 800, '#FFE27A')],
            },
            ...['Play', 'Shop', 'Settings'].map(
              (label, i) =>
                ({
                  type: 'frame',
                  props: { name: `${label}Button`, x: 490, y: 300 + i * 84, width: 300, height: 64, fills: [i === 0 ? lin('#5B8CFF', '#3A5BFF') : solid('#1E2640')], cornerRadius: 16, strokes: [solid('#FFFFFF', 0.18)], strokeWidth: 2, effects: [shadow(8, 0, 0.45, '#05070F')], layout: { mode: 'horizontal', gap: 8, padding: [0, 0, 0, 0], align: 'center', justify: 'center', wrap: false }, sizingH: 'fixed', sizingV: 'fixed' },
                  children: [txt(label.toUpperCase(), 22, 800, '#FFFFFF', { letterSpacing: 1.5 })],
                }) as Spec,
            ),
          ],
        }),
        'Roblox HUD',
      ),
  },
  {
    id: 'poster',
    name: 'Poster',
    hint: 'Gradients, grain, blur',
    create: () =>
      place(
        () => ({
          type: 'frame',
          props: { name: 'Poster', width: 720, height: 900, fills: [solid('#0B0B10')], clipContent: true, effects: [{ ...(defaultEffect('noise') as any), amount: 0.12 }] },
          children: [
            { type: 'ellipse', props: { name: 'Glow A', x: -120, y: -80, width: 560, height: 560, fills: [solid('#7C6CFF')], effects: [{ ...(defaultEffect('layer-blur') as any), radius: 160 }] } },
            { type: 'ellipse', props: { name: 'Glow B', x: 300, y: 380, width: 520, height: 520, fills: [solid('#FF5C8A')], effects: [{ ...(defaultEffect('layer-blur') as any), radius: 180 }], opacity: 0.85 } },
            { type: 'star', props: { name: 'Star', x: 410, y: 120, width: 200, height: 200, points: 8, innerRadius: 0.5, cornerRadius: 6, fills: [lin('#FFFFFF', '#C9C2FF')], effects: [shadow(20, 40, 0.35)] } },
            {
              type: 'rect',
              props: { name: 'Glass card', x: 60, y: 560, width: 600, height: 260, cornerRadius: 32, cornerSmoothing: 0.6, fills: [solid('#FFFFFF', 0.08)], strokes: [solid('#FFFFFF', 0.22)], strokeWidth: 1, effects: [{ ...(defaultEffect('background-blur') as any), radius: 40 }] },
            },
            txt('MAKE\nANYTHING', 96, 850, '#FFFFFF', { x: 92, y: 586, lineHeight: 0.95, letterSpacing: -3 }),
          ],
        }),
        'poster',
      ),
  },
  {
    id: 'logo',
    name: 'Logo construct',
    hint: 'Booleans & paths',
    create: () => {
      const s = editor();
      const c = viewCenter();
      s.mutate(
        (d) => {
          const p = pagePointToParent(d, s.pageId, c);
          const a = build(d, s.pageId, { type: 'ellipse', props: { name: 'Outer', x: p.x - 120, y: p.y - 120, width: 240, height: 240 } });
          const b = build(d, s.pageId, { type: 'ellipse', props: { name: 'Inner', x: p.x - 40, y: p.y - 100, width: 160, height: 160 } });
          const ids = [a, b];
          // group as a subtract boolean
          const g = groupNodes(d, ids, 'boolean', 'subtract');
          if (g) {
            d.nodes[g].fills = [lin('#FFB020', '#F24E1E', 'd')];
            d.nodes[g].name = 'Moon mark';
          }
          return g;
        },
        { select: (r) => (r ? [r] : []), label: 'Logo' },
      );
    },
  },
  {
    id: 'pixel',
    name: 'Pixel canvas',
    hint: '32×32 pixel art',
    create: () => {
      editor().setTool('pixel');
    },
  },
  {
    id: 'page',
    name: 'Blank page',
    hint: 'Start fresh',
    create: () => {
      const id = editor().mutate((d) => addPage(d), { label: 'New page' });
      editor().setPage(id);
    },
  },
];

export { uid };
