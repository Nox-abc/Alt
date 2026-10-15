import type { Doc, ID, SceneNode, Vec } from '../core/types';
import { editor } from '../core/store';
import { createDoc, createNode, isContainer, uid, walk } from '../core/doc';
import { frameAt, insertNode, pagePointToParent, pasteNodes, type ClipboardData } from '../core/ops';
import { native, openFile, saveFile } from '../platform/native';
import { loadImageInfo } from '../render/assets';
import { useDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { useSettings } from './settings';
import { viewCenter, zoomToFit } from './viewport';
import { importSvg } from '../import/svg';

export const ALT_FILTERS = [{ name: 'Alt design', extensions: ['alt'] }];

/** Remove assets no node references. */
export function pruneAssets(doc: Doc): Doc {
  const used = new Set<ID>();
  for (const n of Object.values(doc.nodes)) {
    for (const p of [...n.fills, ...n.strokes]) if (p.type === 'image') used.add(p.assetId);
    if (n.type === 'bitmap') used.add(n.assetId);
  }
  for (const s of doc.styles.colors) if (s.paint.type === 'image') used.add(s.paint.assetId);
  const assets: Doc['assets'] = {};
  for (const [k, v] of Object.entries(doc.assets)) if (used.has(k)) assets[k] = v;
  return { ...doc, assets };
}

export function serializeDoc(doc: Doc): string {
  return JSON.stringify({ ...pruneAssets(doc), updatedAt: Date.now() });
}

export function parseDoc(text: string): Doc {
  const raw = JSON.parse(text);
  if (!raw || raw.format !== 'alt' || !Array.isArray(raw.pages) || typeof raw.nodes !== 'object') throw new Error('Not an Alt document');
  const doc = raw as Doc;
  doc.assets ??= {};
  doc.styles ??= { colors: [], text: [], effects: [] };
  for (const p of doc.pages) {
    p.guides ??= [];
    p.background ??= '';
  }
  // forward-compatible defaults for nodes created by older versions or MCP clients
  for (const n of Object.values(doc.nodes)) {
    const base = createNode(n.type, { parentId: n.parentId }) as any;
    for (const k of Object.keys(base)) if ((n as any)[k] === undefined) (n as any)[k] = base[k];
  }
  return doc;
}

function baseName(path: string | null, fallback = 'Untitled') {
  if (!path) return fallback;
  return path.split(/[\\/]/).pop()!.replace(/\.(alt|json)$/i, '');
}

export async function confirmDiscard(): Promise<boolean> {
  if (!editor().dirty) return true;
  const r = await useDialog.getState().open({
    title: 'Save changes?',
    message: `“${editor().doc.name}” has unsaved changes.`,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: "Don't save", value: 'discard', danger: true },
      { label: 'Save', value: 'save', primary: true },
    ],
  });
  if (r.button === 'save') return saveDocument(false);
  return r.button === 'discard';
}

export async function newDocument() {
  if (!(await confirmDiscard())) return;
  editor().loadDoc(createDoc('Untitled'));
}

export function openDocumentText(text: string, path: string | null, name?: string) {
  try {
    const doc = parseDoc(text);
    if (path || name) doc.name = baseName(path, name ?? doc.name);
    editor().loadDoc(doc, path);
    if (path) addRecent(path);
    requestAnimationFrame(() => zoomToFit());
  } catch (e) {
    toast(`Couldn't open file: ${(e as Error).message}`, { kind: 'error' });
  }
}

export async function openDocument() {
  if (!(await confirmDiscard())) return;
  const f = await openFile([{ name: 'Alt design', extensions: ['alt', 'json'] }]);
  if (!f) return;
  openDocumentText(f.data, f.path, f.name.replace(/\.(alt|json)$/i, ''));
}

export async function openRecent(path: string) {
  if (!native) return;
  if (!(await confirmDiscard())) return;
  try {
    const f = await native.readFile(path);
    openDocumentText(f.data, f.path, f.name);
  } catch (e) {
    toast(`Couldn't open ${path}`, { kind: 'error' });
  }
}

function addRecent(path: string) {
  const s = useSettings.getState();
  s.set({ recent: [path, ...s.recent.filter((p) => p !== path)].slice(0, 12) });
}

export async function saveDocument(saveAs: boolean): Promise<boolean> {
  const s = editor();
  const data = serializeDoc(s.doc);
  const name = `${s.doc.name || 'Untitled'}.alt`;
  const path = await saveFile({ path: s.filePath, defaultName: name, data, mime: 'application/json', filters: ALT_FILTERS, saveAs: saveAs || !s.filePath });
  if (!path) return false;
  if (native) {
    const nm = baseName(path, s.doc.name);
    if (nm !== s.doc.name) editor().mutate((d) => void (d.name = nm), { history: false });
    addRecent(path);
  }
  editor().markSaved(native ? path : null);
  toast('Saved', { kind: 'success', ms: 1400 });
  return true;
}

/* ---------------------------------------------------------------- import */

function insertionParentAt(at: Vec): ID {
  const s = editor();
  return frameAt(s.doc, s.pageId, at) ?? s.pageId;
}

export async function importImageDataUrl(dataUrl: string, name: string, at?: Vec): Promise<ID> {
  const info = await loadImageInfo(dataUrl);
  const s = editor();
  const center = at ?? viewCenter();
  const parent = insertionParentAt(center);
  const max = 1200;
  const k = Math.min(1, max / Math.max(info.width, info.height));
  const w = Math.round(info.width * k);
  const h = Math.round(info.height * k);
  const mime = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? 'image/png';
  return s.mutate(
    (d) => {
      const assetId = 'asset_' + uid();
      d.assets[assetId] = { id: assetId, mime, data: dataUrl, width: info.width, height: info.height, name };
      const n = createNode('rect', {
        parentId: parent,
        name: name.replace(/\.[a-z0-9]+$/i, '') || 'Image',
        fills: [{ id: uid(), type: 'image', assetId, fit: 'fill', scale: 1, rotation: 0, opacity: 1, visible: true }],
      });
      n.width = w;
      n.height = h;
      const local = pagePointToParent(d, parent, center);
      n.x = Math.round(local.x - w / 2);
      n.y = Math.round(local.y - h / 2);
      return insertNode(d, n, parent);
    },
    { select: (r) => [r], label: 'Import image' },
  );
}

export function importSvgText(text: string, name = 'SVG', at?: Vec): ID[] {
  let data: ClipboardData;
  try {
    data = importSvg(text, { name });
  } catch (e) {
    toast(`Couldn't import SVG: ${(e as Error).message}`, { kind: 'error' });
    return [];
  }
  const s = editor();
  const center = at ?? viewCenter();
  const parent = insertionParentAt(center);
  return s.mutate((d) => pasteNodes(d, data, parent, { at: center }), { select: (r) => r, label: 'Import SVG' });
}

export async function importFileObjects(files: File[], at?: Vec) {
  let offset = 0;
  for (const f of files) {
    const point = at ? { x: at.x + offset, y: at.y + offset } : undefined;
    offset += 24;
    if (/\.alt$/i.test(f.name) || f.type === 'application/json') {
      const text = await f.text();
      if (await confirmDiscard()) openDocumentText(text, null, f.name);
      return;
    }
    if (f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)) {
      importSvgText(await f.text(), f.name.replace(/\.svg$/i, ''), point);
      continue;
    }
    if (f.type.startsWith('image/')) {
      const url = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(f);
      });
      await importImageDataUrl(url, f.name, point);
    }
  }
}

export async function importDialog() {
  const f = await openFile([{ name: 'Images & SVG', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'] }], true);
  if (!f) return;
  const ext = f.name.split('.').pop()?.toLowerCase() ?? 'png';
  if (ext === 'svg') {
    const text = f.binary ? decodeURIComponent(escape(atob(f.data))) : f.data;
    importSvgText(text, f.name.replace(/\.svg$/i, ''));
    return;
  }
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const url = f.binary ? `data:${mime};base64,${f.data}` : f.data;
  await importImageDataUrl(url, f.name);
}

/* --------------------------------------------------------------- autosave */

const DB = 'alt';
const STORE = 'autosave';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function autosaveWrite(doc: Doc, path: string | null) {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ doc: serializeDoc(doc), path, at: Date.now() }, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable */
  }
}

export async function autosaveRead(): Promise<{ doc: string; path: string | null; at: number } | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get('current');
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function autosaveClear() {
  try {
    const db = await idb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete('current');
  } catch {
    /* ignore */
  }
}

/** Count nodes – used for the status bar. */
export function nodeCount(doc: Doc): number {
  return Object.keys(doc.nodes).length;
}

export function allTextNodes(doc: Doc): SceneNode[] {
  const out: SceneNode[] = [];
  for (const p of doc.pages) walk(doc, p.children, (n) => void (n.type === 'text' && out.push(n)));
  return out;
}

export { isContainer };
