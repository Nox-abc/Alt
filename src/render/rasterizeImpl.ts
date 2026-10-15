import type { Doc, ID, Rect } from '../core/types';
import { unionRects, worldBounds } from '../core/geometry';
import type { RasterOptions } from '../export/types';
import { assets } from './assets';
import { renderNodesInto } from './renderer';

const MAX_DIM = 16384;
const MAX_PIXELS = 160_000_000;

/** How far a node's effects (shadows, glows, blurs) and outside strokes reach beyond its box. */
function effectReach(doc: Doc, id: ID): { l: number; t: number; r: number; b: number } {
  const n = doc.nodes[id];
  const out = { l: 0, t: 0, r: 0, b: 0 };
  if (!n) return out;
  const grow = (l: number, t: number, r: number, b: number) => {
    out.l = Math.max(out.l, l);
    out.t = Math.max(out.t, t);
    out.r = Math.max(out.r, r);
    out.b = Math.max(out.b, b);
  };
  if (n.strokes.some((p) => p.visible) && n.strokeAlign !== 'inside') {
    const w = n.strokeAlign === 'outside' ? n.strokeWidth : n.strokeWidth / 2;
    grow(w, w, w, w);
  }
  for (const e of n.effects) {
    if (!e.visible) continue;
    if (e.type === 'drop-shadow') {
      const k = e.blur * 1.2 + Math.max(0, e.spread);
      grow(k - e.x, k - e.y, k + e.x, k + e.y);
    } else if (e.type === 'glow') {
      const k = e.blur * 1.2 + Math.max(0, e.spread);
      grow(k, k, k, k);
    } else if (e.type === 'layer-blur') {
      const k = e.radius * 1.2;
      grow(k, k, k, k);
    }
  }
  return out;
}

export function exportBounds(doc: Doc, pageId: ID, ids: ID[]): { bounds: Rect | null; roots: ID[] } {
  const page = doc.pages.find((p) => p.id === pageId);
  const roots = ids.length ? ids : (page?.children ?? []).filter((id) => doc.nodes[id]?.visible);
  const rects = roots.filter((id) => doc.nodes[id]).map((id) => {
    const b = worldBounds(doc, id);
    const r = effectReach(doc, id);
    return { x: b.x - r.l, y: b.y - r.t, width: b.width + r.l + r.r, height: b.height + r.t + r.b };
  });
  return { bounds: unionRects(rects), roots };
}

export async function renderToCanvas(doc: Doc, pageId: ID, ids: ID[], opts: Pick<RasterOptions, 'scale' | 'background'>) {
  await assets.ensure(doc);
  try {
    await (document as any).fonts?.ready;
  } catch {
    /* ignore */
  }
  const { bounds, roots } = exportBounds(doc, pageId, ids);
  const b = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : { x: 0, y: 0, width: 1, height: 1 };
  let scale = Math.max(0.01, opts.scale);
  let w = Math.ceil(b.width * scale);
  let h = Math.ceil(b.height * scale);
  const shrink = Math.min(1, MAX_DIM / w, MAX_DIM / h, Math.sqrt(MAX_PIXELS / (w * h)));
  if (shrink < 1) {
    scale *= shrink;
    w = Math.ceil(b.width * scale);
    h = Math.ceil(b.height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d')!;
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  renderNodesInto(ctx, doc, roots, [scale, 0, 0, scale, -b.x * scale, -b.y * scale], scale);
  return canvas;
}

export async function rasterizeImpl(doc: Doc, pageId: ID, ids: ID[], opts: RasterOptions): Promise<Uint8Array> {
  const canvas = await renderToCanvas(doc, pageId, ids, {
    scale: opts.scale,
    background: opts.format === 'jpeg' && !opts.background ? '#FFFFFF' : opts.background,
  });
  const type = opts.format === 'jpeg' ? 'image/jpeg' : opts.format === 'webp' ? 'image/webp' : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, opts.quality ?? 0.92),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
