import type { Doc, ID } from '../core/types';
import type { RasterOptions } from '../export/types';

/**
 * Render nodes (or a whole page when `ids` is empty) to an encoded image.
 * Implemented by the canvas renderer.
 */
export async function rasterize(doc: Doc, pageId: ID, ids: ID[], opts: RasterOptions): Promise<Uint8Array> {
  const { rasterizeImpl } = await import('./rasterizeImpl');
  return rasterizeImpl(doc, pageId, ids, opts);
}
