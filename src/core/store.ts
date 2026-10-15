import { create } from 'zustand';
import { enablePatches, produce, produceWithPatches, setAutoFreeze, type Patch } from 'immer';
import type { BrushSettings, Doc, ID, Marker, SceneNode } from './types';
import { createDoc, getPage, isContainer, sortByZ } from './doc';
import { finalize } from './layout';
import { DEFAULT_BRUSH } from './shapes';

enablePatches();
// Freezing large documents on every change is expensive; we never mutate state outside immer.
setAutoFreeze(false);

export type ToolId =
  | 'move'
  | 'scale'
  | 'hand'
  | 'frame'
  | 'rect'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'line'
  | 'arrow'
  | 'spiral'
  | 'shape'
  | 'pen'
  | 'pencil'
  | 'brush'
  | 'text'
  | 'image'
  | 'paint'
  | 'eraser'
  | 'bucket'
  | 'pixel'
  | 'spray'
  | 'eyedropper'
  | 'lasso'
  | 'measure';

export interface Viewport {
  /** screen = world · zoom + (x, y) */
  x: number;
  y: number;
  zoom: number;
}

export type EditMode =
  | null
  | { kind: 'text'; id: ID; isNew?: boolean }
  | { kind: 'path'; id: ID }
  | { kind: 'gradient'; id: ID; target: 'fills' | 'strokes'; index: number };

export interface VectorSel {
  sub: number;
  idx: number;
}

export interface ToolOptions {
  brush: BrushSettings;
  brushColor: string;
  brushOpacity: number;
  /** raster paint */
  paintColor: string;
  paintSize: number;
  paintHardness: number;
  paintOpacity: number;
  paintFlow: number;
  sprayDensity: number;
  bucketTolerance: number;
  pixelSize: number;
  symmetry: 'none' | 'x' | 'y' | 'xy' | 'radial';
  symmetrySegments: number;
  polygonSides: number;
  starPoints: number;
  starInner: number;
  spiralTurns: number;
  shapeId: string;
  pencilSmoothing: number;
  lineMarker: Marker;
}

interface HistoryEntry {
  doc: Doc;
  selection: ID[];
  pageId: ID;
  label?: string;
}

export interface EditorState {
  doc: Doc;
  pageId: ID;
  selection: ID[];
  hoverId: ID | null;
  tool: ToolId;
  /** tool restored after a temporary tool (space → hand) */
  toolLock: boolean;
  editing: EditMode;
  vectorSel: VectorSel[];
  viewports: Record<ID, Viewport>;
  toolOptions: ToolOptions;
  past: HistoryEntry[];
  future: HistoryEntry[];
  tx: HistoryEntry | null;
  filePath: string | null;
  dirty: boolean;
  /** monotonically increasing – bumps whenever the document changes */
  version: number;
}

export interface EditorActions {
  mutate<R = void>(recipe: (d: Doc) => R, opts?: { select?: ID[] | ((r: R, d: Doc) => ID[]); label?: string; history?: boolean }): R;
  begin(label?: string): void;
  commit(): void;
  cancel(): void;
  undo(): void;
  redo(): void;
  setSelection(ids: ID[]): void;
  toggleSelection(id: ID): void;
  setHover(id: ID | null): void;
  setTool(tool: ToolId, lock?: boolean): void;
  setPage(id: ID): void;
  setViewport(v: Partial<Viewport>): void;
  setEditing(e: EditMode): void;
  setVectorSel(s: VectorSel[]): void;
  setToolOptions(p: Partial<ToolOptions>): void;
  loadDoc(doc: Doc, filePath?: string | null): void;
  newDoc(name?: string): void;
  markSaved(filePath?: string | null): void;
}

export type Store = EditorState & EditorActions;

const HISTORY_LIMIT = 200;

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  brush: { ...DEFAULT_BRUSH },
  brushColor: '#111111',
  brushOpacity: 1,
  paintColor: '#111111',
  paintSize: 16,
  paintHardness: 0.8,
  paintOpacity: 1,
  paintFlow: 1,
  sprayDensity: 0.5,
  bucketTolerance: 32,
  pixelSize: 1,
  symmetry: 'none',
  symmetrySegments: 6,
  polygonSides: 3,
  starPoints: 5,
  starInner: 0.382,
  spiralTurns: 4,
  shapeId: 'heart',
  pencilSmoothing: 2.5,
  lineMarker: 'none',
};

function loadToolOptions(): ToolOptions {
  try {
    const raw = globalThis.localStorage?.getItem('alt.toolOptions');
    if (raw) {
      const o = JSON.parse(raw);
      return { ...DEFAULT_TOOL_OPTIONS, ...o, brush: { ...DEFAULT_BRUSH, ...(o.brush ?? {}) } };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_TOOL_OPTIONS };
}

function changedNodeIds(patches: Patch[]): Set<ID> {
  const ids = new Set<ID>();
  for (const p of patches) {
    if (p.path[0] === 'nodes' && p.path.length >= 2) ids.add(String(p.path[1]));
  }
  return ids;
}

function validSelection(doc: Doc, ids: ID[]): ID[] {
  return ids.filter((id) => doc.nodes[id]);
}

const initialDoc = createDoc('Untitled');

export const useEditor = create<Store>()((set, get) => ({
  doc: initialDoc,
  pageId: initialDoc.pages[0].id,
  selection: [],
  hoverId: null,
  tool: 'move',
  toolLock: false,
  editing: null,
  vectorSel: [],
  viewports: {},
  toolOptions: loadToolOptions(),
  past: [],
  future: [],
  tx: null,
  filePath: null,
  dirty: false,
  version: 0,

  mutate(recipe, opts = {}) {
    const s = get();
    let result: any;
    const [next, patches] = produceWithPatches(s.doc, (d: Doc) => {
      result = recipe(d);
    });
    if (!patches.length) {
      if (opts.select) {
        const sel = typeof opts.select === 'function' ? opts.select(result, s.doc) : opts.select;
        set({ selection: validSelection(s.doc, sel) });
      }
      return result;
    }
    const changed = changedNodeIds(patches);
    const finalDoc = changed.size ? produce(next, (d: Doc) => finalize(d, changed)) : next;
    const entry: HistoryEntry = { doc: s.doc, selection: s.selection, pageId: s.pageId, label: opts.label };
    const record = opts.history !== false && !s.tx;
    let selection = s.selection;
    if (opts.select) selection = typeof opts.select === 'function' ? opts.select(result, finalDoc) : opts.select;
    selection = validSelection(finalDoc, selection);
    // keep the current page valid
    const pageId = finalDoc.pages.some((p) => p.id === s.pageId) ? s.pageId : finalDoc.pages[0].id;
    set({
      doc: finalDoc,
      selection,
      pageId,
      past: record ? [...s.past.slice(-HISTORY_LIMIT + 1), entry] : s.past,
      future: record ? [] : s.future,
      dirty: true,
      version: s.version + 1,
      hoverId: s.hoverId && finalDoc.nodes[s.hoverId] ? s.hoverId : null,
      editing: s.editing && 'id' in s.editing && !finalDoc.nodes[s.editing.id] ? null : s.editing,
    });
    return result;
  },

  begin(label) {
    const s = get();
    if (s.tx) return;
    set({ tx: { doc: s.doc, selection: s.selection, pageId: s.pageId, label } });
  },

  commit() {
    const s = get();
    if (!s.tx) return;
    if (s.tx.doc === s.doc) {
      set({ tx: null });
      return;
    }
    set({ past: [...s.past.slice(-HISTORY_LIMIT + 1), s.tx], future: [], tx: null });
  },

  cancel() {
    const s = get();
    if (!s.tx) return;
    set({ doc: s.tx.doc, selection: validSelection(s.tx.doc, s.selection), tx: null, version: s.version + 1 });
  },

  undo() {
    const s = get();
    if (s.tx) get().commit();
    const st = get();
    const prev = st.past[st.past.length - 1];
    if (!prev) return;
    set({
      doc: prev.doc,
      selection: validSelection(prev.doc, prev.selection),
      pageId: prev.doc.pages.some((p) => p.id === prev.pageId) ? prev.pageId : prev.doc.pages[0].id,
      past: st.past.slice(0, -1),
      future: [{ doc: st.doc, selection: st.selection, pageId: st.pageId }, ...st.future],
      editing: null,
      dirty: true,
      version: st.version + 1,
    });
  },

  redo() {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({
      doc: next.doc,
      selection: validSelection(next.doc, next.selection),
      pageId: next.doc.pages.some((p) => p.id === next.pageId) ? next.pageId : next.doc.pages[0].id,
      past: [...s.past, { doc: s.doc, selection: s.selection, pageId: s.pageId }],
      future: s.future.slice(1),
      editing: null,
      dirty: true,
      version: s.version + 1,
    });
  },

  setSelection(ids) {
    const s = get();
    const sel = validSelection(s.doc, ids);
    if (sel.length === s.selection.length && sel.every((v, i) => v === s.selection[i])) return;
    set({ selection: sel, vectorSel: [] });
  },

  toggleSelection(id) {
    const s = get();
    if (s.selection.includes(id)) set({ selection: s.selection.filter((x) => x !== id) });
    else {
      // can't mix a node with its ancestors / descendants
      const doc = s.doc;
      const filtered = s.selection.filter((x) => {
        let cur = doc.nodes[x];
        while (cur) {
          if (cur.parentId === id) return false;
          cur = doc.nodes[cur.parentId];
        }
        let c2 = doc.nodes[id];
        while (c2) {
          if (c2.parentId === x) return false;
          c2 = doc.nodes[c2.parentId];
        }
        return true;
      });
      set({ selection: [...filtered, id] });
    }
  },

  setHover(id) {
    if (get().hoverId !== id) set({ hoverId: id });
  },

  setTool(tool, lock = false) {
    const s = get();
    set({ tool, toolLock: lock, editing: tool === 'move' ? s.editing : s.editing?.kind === 'path' && tool === 'pen' ? s.editing : null });
  },

  setPage(id) {
    const s = get();
    if (!getPage(s.doc, id)) return;
    set({ pageId: id, selection: [], hoverId: null, editing: null });
  },

  setViewport(v) {
    const s = get();
    const cur = s.viewports[s.pageId] ?? { x: 0, y: 0, zoom: 1 };
    const next = { ...cur, ...v };
    if (next.x === cur.x && next.y === cur.y && next.zoom === cur.zoom) return;
    set({ viewports: { ...s.viewports, [s.pageId]: next } });
  },

  setEditing(e) {
    set({ editing: e, vectorSel: [] });
  },

  setVectorSel(v) {
    set({ vectorSel: v });
  },

  setToolOptions(p) {
    const s = get();
    const toolOptions = { ...s.toolOptions, ...p };
    set({ toolOptions });
    try {
      globalThis.localStorage?.setItem('alt.toolOptions', JSON.stringify(toolOptions));
    } catch {
      /* ignore */
    }
  },

  loadDoc(doc, filePath = null) {
    set({
      doc,
      pageId: doc.pages[0].id,
      selection: [],
      hoverId: null,
      editing: null,
      past: [],
      future: [],
      tx: null,
      filePath,
      dirty: false,
      viewports: {},
      version: get().version + 1,
    });
  },

  newDoc(name = 'Untitled') {
    get().loadDoc(createDoc(name), null);
  },

  markSaved(filePath) {
    set({ dirty: false, filePath: filePath === undefined ? get().filePath : filePath });
  },
}));

/* ------------------------------------------------------------ selectors */

export const editor = () => useEditor.getState();

export function currentPage(s: EditorState = editor()) {
  return getPage(s.doc, s.pageId)!;
}

export function getViewport(s: EditorState = editor()): Viewport {
  return s.viewports[s.pageId] ?? { x: 0, y: 0, zoom: 1 };
}

export function selectedNodes(s: EditorState = editor()): SceneNode[] {
  return s.selection.map((id) => s.doc.nodes[id]).filter(Boolean);
}

/** The container new shapes should go into: the selected frame, or the page. */
export function insertionParent(s: EditorState = editor()): ID {
  return s.pageId;
}

export function sortedSelection(s: EditorState = editor()): ID[] {
  return sortByZ(s.doc, s.selection);
}

export { isContainer };
