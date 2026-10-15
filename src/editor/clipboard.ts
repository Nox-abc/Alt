import type { ID, Vec } from '../core/types';
import { editor } from '../core/store';
import { createNode, sortByZ, topLevelOnly } from '../core/doc';
import { deleteNodes, fitText, frameAt, insertNode, pagePointToParent, pasteNodes, serializeNodes, type ClipboardData } from '../core/ops';
import { apply, rectsIntersect, worldBounds } from '../core/geometry';
import { isTyping } from './toolkit';
import { importFileObjects, importSvgText } from './file';
import { viewCenter, visibleWorldRect } from './viewport';
import { toast } from '../ui/toast';
import { getExporter, exportRoots } from '../export';
import { rasterize } from '../render/rasterize';

const MIME = 'web application/x-alt+json';
const HTML_MARK = /<!--\(alt\)([A-Za-z0-9+/=]+)\(\/alt\)-->/;

let internal: ClipboardData | null = null;

function b64(s: string) {
  return btoa(unescape(encodeURIComponent(s)));
}
function unb64(s: string) {
  return decodeURIComponent(escape(atob(s)));
}

async function selectionSvg(ids: ID[]): Promise<string | null> {
  const ex = getExporter('svg');
  if (!ex) return null;
  try {
    const s = editor();
    const files = await ex.run({ doc: s.doc, ids: exportRoots(s.doc, s.pageId, ids), pageId: s.pageId, options: { combine: true }, rasterize: (i, o) => rasterize(s.doc, s.pageId, i, o) });
    const f = files[0];
    return f ? (typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data)) : null;
  } catch {
    return null;
  }
}

export function copySelection(e?: ClipboardEvent): boolean {
  const s = editor();
  if (!s.selection.length) return false;
  const data = serializeNodes(s.doc, s.selection);
  internal = data;
  const json = JSON.stringify(data);
  const names = sortByZ(s.doc, topLevelOnly(s.doc, s.selection)).map((id) => s.doc.nodes[id]?.name).join(', ');
  if (e?.clipboardData) {
    e.preventDefault();
    try {
      e.clipboardData.setData('application/x-alt+json', json);
    } catch {
      /* custom types unsupported */
    }
    e.clipboardData.setData('text/html', `<meta charset="utf-8"><!--(alt)${b64(json)}(/alt)--><span>${names.replace(/</g, '&lt;')}</span>`);
    e.clipboardData.setData('text/plain', names);
  } else {
    void navigator.clipboard?.writeText(names).catch(() => {});
  }
  return true;
}

export function cutSelection(e?: ClipboardEvent) {
  if (!copySelection(e)) return;
  const s = editor();
  const ids = [...s.selection];
  s.mutate((d) => deleteNodes(d, ids), { select: [], label: 'Cut' });
}

function pasteTarget(): ID {
  const s = editor();
  if (s.selection.length === 1) {
    const n = s.doc.nodes[s.selection[0]];
    if (n?.type === 'frame') return n.id;
    if (n) return n.parentId;
  }
  return s.pageId;
}

export function pasteData(data: ClipboardData, at?: Vec) {
  const s = editor();
  const parent = pasteTarget();
  // paste in place when the originals are on screen (and inside the target frame), otherwise centre
  let inPlace = false;
  const pts = data.roots.map((r) => apply(r.world, { x: 0, y: 0 }));
  if (!at) {
    const vis = visibleWorldRect();
    inPlace = pts.length > 0 && pts.every((p) => rectsIntersect(vis, { x: p.x, y: p.y, width: 1, height: 1 }));
  }
  const parentNode = s.doc.nodes[parent];
  if (parentNode && !at) {
    const fb = worldBounds(s.doc, parent);
    const inside = pts.every((p) => rectsIntersect(fb, { x: p.x, y: p.y, width: 1, height: 1 }));
    if (!inside) {
      inPlace = false;
      at = { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 };
    }
  }
  const ids = s.mutate((d) => pasteNodes(d, data, parent, { at: inPlace ? undefined : at ?? viewCenter() }), {
    select: (r) => r,
    label: 'Paste',
  });
  return ids;
}

export async function handlePaste(e: ClipboardEvent) {
  if (isTyping(e)) return;
  const dt = e.clipboardData;
  if (!dt) return;
  e.preventDefault();
  const custom = (() => {
    try {
      return dt.getData('application/x-alt+json');
    } catch {
      return '';
    }
  })();
  const html = dt.getData('text/html');
  const m = html ? HTML_MARK.exec(html) : null;
  const raw = custom || (m ? unb64(m[1]) : '');
  if (raw) {
    try {
      const data = JSON.parse(raw) as ClipboardData;
      if (data.app === 'alt') {
        pasteData(data);
        return;
      }
    } catch {
      /* fall through */
    }
  }
  if (dt.files?.length) {
    await importFileObjects([...dt.files], viewCenter());
    return;
  }
  const text = dt.getData('text/plain');
  if (!text) {
    if (internal) pasteData(internal);
    return;
  }
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    importSvgText(text, 'Pasted SVG');
    return;
  }
  // plain text → text layer
  const s = editor();
  const center = viewCenter();
  const parent = frameAt(s.doc, s.pageId, center) ?? s.pageId;
  s.mutate(
    (d) => {
      const n = createNode('text', { parentId: parent, text: text.slice(0, 20000), name: text.slice(0, 40).replace(/\s+/g, ' ') });
      if (text.length > 60 || text.includes('\n')) {
        n.autoResize = 'height';
        n.width = 360;
      }
      const lp = pagePointToParent(d, parent, center);
      n.x = Math.round(lp.x - 50);
      n.y = Math.round(lp.y - 12);
      insertNode(d, n, parent);
      fitText(d, n.id);
      return n.id;
    },
    { select: (r) => [r], label: 'Paste text' },
  );
}

export async function copyAsSvg() {
  const s = editor();
  const svg = await selectionSvg(s.selection);
  if (!svg) return toast('Nothing to copy', { kind: 'error' });
  await navigator.clipboard.writeText(svg);
  toast('Copied as SVG', { kind: 'success' });
}

export async function copyAsPng() {
  const s = editor();
  if (!s.selection.length) return toast('Select something first', { kind: 'error' });
  try {
    const bytes = await rasterize(s.doc, s.pageId, exportRoots(s.doc, s.pageId, s.selection), { scale: 2, format: 'png' });
    const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied as PNG (2×)', { kind: 'success' });
  } catch (err) {
    toast(`Copy failed: ${(err as Error).message}`, { kind: 'error' });
  }
}

export async function copyText(text: string, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, { kind: 'success' });
  } catch {
    toast('Clipboard unavailable', { kind: 'error' });
  }
}

export function installClipboard() {
  const onCopy = (e: ClipboardEvent) => {
    if (isTyping(e) || editor().editing?.kind === 'text') return;
    copySelection(e);
  };
  const onCut = (e: ClipboardEvent) => {
    if (isTyping(e) || editor().editing?.kind === 'text') return;
    cutSelection(e);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (editor().editing?.kind === 'text') return;
    void handlePaste(e);
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
  return () => {
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
  };
}

export { MIME };

/** Paste via the async Clipboard API (context menus / native menus where no paste event fires). */
export async function pasteFromSystem() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('text/html')) {
        const html = await (await item.getType('text/html')).text();
        const m = HTML_MARK.exec(html);
        if (m) {
          const data = JSON.parse(unb64(m[1])) as ClipboardData;
          if (data.app === 'alt') return void pasteData(data);
        }
      }
      const img = item.types.find((t) => t.startsWith('image/'));
      if (img) {
        const blob = await item.getType(img);
        return void (await importFileObjects([new File([blob], 'Pasted image.' + img.split('/')[1], { type: img })], viewCenter()));
      }
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text();
        if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return void importSvgText(text, 'Pasted SVG');
      }
    }
  } catch {
    /* permission denied – fall back to the in-app clipboard */
  }
  if (internal) pasteData(internal);
}
