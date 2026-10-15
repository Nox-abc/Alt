import type { Doc, ID, Rect } from '../core/types';
import { selectionBounds, unionRects, worldBounds } from '../core/geometry';
import type { RasterOptions } from '../export/types';
import { assets } from './assets';
import { renderNodesInto } from './renderer';

const MAX_DIM = 16384;
const MAX_PIXELS = 160_000_000;

export function exportBounds(doc: Doc, pageId: ID, ids: ID[]): { bounds: Rect | null; roots: ID[] } {
  const page = doc.pages.find((p) => p.id === pageId);
  const roots = ids.length ? ids : (page?.children ?? []).filter((id) => doc.nodes[id]?.visible);
  return { bounds: ids.length ? selectionBounds(doc, roots) : unionRects(roots.map((id) => worldBounds(doc, id))), roots };
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
