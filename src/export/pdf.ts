/**
 * Vector PDF exporter: the SVG exporter's output is drawn with svg2pdf.js
 * onto jsPDF pages (1 px = 1 pt, one page per exported layer). When svg2pdf
 * can't handle a page it is replaced by a 2× raster of the layer.
 *
 * Browser only (needs DOMParser + document); throws a clear error elsewhere.
 */
import type { ExportContext, ExportFile, Exporter } from './types';
import { buildSvg } from './svg';
import { FileNamer, MIME, resolveRoots } from './util';

export function canExportPdf(): boolean {
  return typeof DOMParser !== 'undefined' && typeof document !== 'undefined';
}

/** Parse SVG markup into a live element attached (invisibly) to the document. */
function mountSvg(svg: string): { el: SVGSVGElement; dispose: () => void } {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const err = parsed.querySelector('parsererror');
  if (err) throw new Error(`Invalid SVG: ${err.textContent ?? ''}`);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  const el = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  host.appendChild(el);
  document.body.appendChild(host);
  return { el, dispose: () => host.remove() };
}

export const pdfExporter: Exporter = {
  id: 'pdf',
  label: 'PDF',
  group: 'Vector',
  extension: 'pdf',
  description: 'Vector PDF with one page per layer (falls back to a high-res image per page when needed).',
  textual: false,
  options: [{ key: 'combine', label: 'All pages in one file', type: 'boolean', default: true }],
  async run(ctx: ExportContext): Promise<ExportFile[]> {
    if (!canExportPdf()) throw new Error('PDF export needs a browser environment (DOMParser / document).');
    const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
    if (!roots.length) return [];
    const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
    const combine = ctx.options.combine !== false;
    const names = new FileNamer();
    const files: ExportFile[] = [];
    type Pdf = InstanceType<typeof jsPDF>;
    let pdf: Pdf | null = null;

    const finish = (p: Pdf, base: string) => {
      files.push({ name: names.get(base, 'pdf'), mime: MIME.pdf, data: new Uint8Array(p.output('arraybuffer')) });
    };

    for (const id of roots) {
      const node = ctx.doc.nodes[id];
      const { svg, width, height } = buildSvg(ctx.doc, [id], { layerIds: false });
      const w = Math.max(1, width);
      const h = Math.max(1, height);
      const orientation = w > h ? 'landscape' : 'portrait';
      if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true });
      else pdf.addPage([w, h], orientation);
      pdf.setDocumentProperties({ title: combine ? ctx.doc.name : node.name, creator: 'Alt' });
      let mounted: ReturnType<typeof mountSvg> | null = null;
      try {
        mounted = mountSvg(svg);
        await svg2pdf(mounted.el, pdf, { x: 0, y: 0, width: w, height: h });
      } catch (err) {
        console.warn(`svg2pdf failed for "${node.name}", embedding a bitmap instead`, err);
        // replace the (possibly half-drawn) page
        pdf.deletePage(pdf.getNumberOfPages());
        pdf.addPage([w, h], orientation);
        const png = await ctx.rasterize([id], { scale: 2, format: 'png', background: null });
        pdf.addImage(png, 'PNG', 0, 0, w, h);
      } finally {
        mounted?.dispose();
      }
      if (!combine) {
        finish(pdf, node.name);
        pdf = null;
      }
    }
    if (pdf) {
      const page = ctx.doc.pages.find((p) => p.id === ctx.pageId);
      finish(pdf, roots.length === 1 ? ctx.doc.nodes[roots[0]].name : page?.name || ctx.doc.name);
    }
    return files;
  },
};
