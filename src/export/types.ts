import type { Doc, ID } from '../core/types';

export type ExportGroup = 'Image' | 'Vector' | 'Web' | 'Native' | 'Game engines' | 'Data';

export interface ExportOption {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select' | 'text';
  default: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

export interface RasterOptions {
  /** pixel scale (1 = 100%) */
  scale: number;
  format: 'png' | 'jpeg' | 'webp';
  /** jpeg / webp quality 0..1 */
  quality?: number;
  /** CSS colour or null for transparent */
  background?: string | null;
}

export interface ExportContext {
  doc: Doc;
  /** root node ids to export (already top-level, sorted back→front). Empty = whole page. */
  ids: ID[];
  pageId: ID;
  options: Record<string, unknown>;
  /** Render nodes (or the page when ids is empty) to an encoded image. Provided by the app. */
  rasterize: (ids: ID[], opts: RasterOptions) => Promise<Uint8Array>;
}

export interface ExportFile {
  /** file name including extension */
  name: string;
  mime: string;
  data: string | Uint8Array;
}

export interface Exporter {
  id: string;
  label: string;
  group: ExportGroup;
  /** main file extension (without dot) */
  extension: string;
  description: string;
  options?: ExportOption[];
  /** true when output is text that can be previewed / copied */
  textual: boolean;
  run(ctx: ExportContext): Promise<ExportFile[]>;
}
