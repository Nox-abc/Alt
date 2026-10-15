import { test } from 'vitest';
import { createDoc, createNode, gradient, solid, defaultEffect } from '../src/core/doc';
import { insertNode } from '../src/core/ops';
import { getExporter } from '../src/export';
test('web', async () => {
  const d = createDoc('Demo');
  const page = d.pages[0].id;
  const f = createNode('frame', { parentId: page, name: 'Card', width: 300, height: 200, cornerRadius: 12, sizingH: 'fixed', sizingV: 'hug', layout: { mode: 'vertical', gap: 8, padding: [16,16,16,16], align: 'start', justify: 'start', wrap: false } });
  insertNode(d, f, page);
  const r = createNode('rect', { parentId: f.id, name: 'Hero image', x: 16, y: 16, width: 120, height: 60, fills: [gradient('linear', '#ff0000', '#0000ff')], effects: [defaultEffect('drop-shadow')], strokes: [solid('#000000')], strokeWidth: 2, rotation: 15, sizingH: 'fill' });
  insertNode(d, r, f.id);
  const e = createNode('ellipse', { parentId: f.id, x: 16, y: 84, width: 40, height: 40, fills: [gradient('radial', '#00ff00', '#ff00ff')] });
  insertNode(d, e, f.id);
  const t = createNode('text', { parentId: f.id, name: 'Title', x: 16, y: 130, width: 200, height: 30, text: 'Hello {World} & you', fontWeight: 600, autoResize: 'height' });
  insertNode(d, t, f.id);
  const p = createNode('star', { parentId: f.id, name: 'Star', x: 150, y: 20, width: 50, height: 50, layoutPositioning: 'absolute' });
  insertNode(d, p, f.id);
  for (const id of ['html', 'react', 'react-tailwind']) {
    const files = await getExporter(id)!.run({ doc: d, ids: [f.id], pageId: page, options: {}, rasterize: async () => new Uint8Array() });
    for (const fl of files) console.log('=== ' + fl.name + '\n' + fl.data);
  }
});
