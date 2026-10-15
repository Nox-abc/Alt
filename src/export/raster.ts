/**
 * PNG / JPG / WebP exporters. Pixels come from the app's renderer through
 * `ctx.rasterize`; this module only handles options and file naming.
 */
import type { ExportContext, ExportFile, ExportOption, Exporter, RasterOptions } from './types';
import { FileNamer, resolveRoots } from './util';

const SCALES = ['0.5', '0.75', '1', '1.5', '2', '3', '4'];

const scaleOption: ExportOption = {
  key: 'scale',
  label: 'Scale',
  type: 'select',
  default: '2',
  options: SCALES.map((s) => ({ value: s, label: `${s}×` })),
};

/** Parse the scale option (select strings or numbers), clamped to 0.5–4. */
export function parseScale(v: unknown, fallback = 1): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.max(0.5, Math.min(4, n));
}

/** Figma-style suffix: `Card@2x.png` (1× has no suffix). */
export function scaleSuffix(scale: number): string {
  return scale === 1 ? '' : `@${+scale.toFixed(2)}x`;
}

interface RasterSpec {
  id: string;
  label: string;
  format: RasterOptions['format'];
  extension: string;
  mime: string;
  description: string;
  lossy: boolean;
  defaultBackground: string;
}

function rasterExporter(spec: RasterSpec): Exporter {
  const options: ExportOption[] = [scaleOption];
  if (spec.lossy) options.push({ key: 'quality', label: 'Quality', type: 'number', default: 0.9, min: 0.1, max: 1, step: 0.05 });
  options.push({
    key: 'background',
    label: spec.format === 'jpeg' ? 'Background' : 'Background (empty = transparent)',
    type: 'text',
    default: spec.defaultBackground,
  });
  return {
    id: spec.id,
    label: spec.label,
    group: 'Image',
    extension: spec.extension,
    description: spec.description,
    textual: false,
    options,
    async run(ctx: ExportContext): Promise<ExportFile[]> {
      const scale = parseScale(ctx.options.scale, 2);
      const bg = typeof ctx.options.background === 'string' ? ctx.options.background.trim() : spec.defaultBackground;
      const opts: RasterOptions = {
        scale,
        format: spec.format,
        quality: spec.lossy ? Math.max(0.1, Math.min(1, Number(ctx.options.quality ?? 0.9) || 0.9)) : undefined,
        // JPEG has no alpha channel – always flatten onto a colour
        background: bg || (spec.format === 'jpeg' ? '#ffffff' : null),
      };
      const names = new FileNamer();
      const suffix = scaleSuffix(scale);
      const roots = ctx.ids.length ? resolveRoots(ctx.doc, ctx.pageId, ctx.ids) : [];
      if (!roots.length) {
        const page = ctx.doc.pages.find((p) => p.id === ctx.pageId);
        const data = await ctx.rasterize([], opts);
        return [{ name: names.get(`${page?.name || ctx.doc.name}${suffix}`, spec.extension), mime: spec.mime, data }];
      }
      const out: ExportFile[] = [];
      for (const id of roots) {
        const data = await ctx.rasterize([id], opts);
        out.push({ name: names.get(`${ctx.doc.nodes[id].name}${suffix}`, spec.extension), mime: spec.mime, data });
      }
      return out;
    },
  };
}

export const pngExporter = rasterExporter({
  id: 'png',
  label: 'PNG',
  format: 'png',
  extension: 'png',
  mime: 'image/png',
  description: 'Lossless bitmap with transparency.',
  lossy: false,
  defaultBackground: '',
});

export const jpgExporter = rasterExporter({
  id: 'jpg',
  label: 'JPG',
  format: 'jpeg',
  extension: 'jpg',
  mime: 'image/jpeg',
  description: 'Compressed photo format, flattened onto a background colour.',
  lossy: true,
  defaultBackground: '#ffffff',
});

export const webpExporter = rasterExporter({
  id: 'webp',
  label: 'WebP',
  format: 'webp',
  extension: 'webp',
  mime: 'image/webp',
  description: 'Small modern bitmap format with transparency.',
  lossy: true,
  defaultBackground: '',
});
