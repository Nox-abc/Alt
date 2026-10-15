import type { BooleanOp, ID, SceneNode } from '../core/types';
import { editor, type ToolId } from '../core/store';
import { getPage, isContainer, sortByZ, topLevelOnly, defaultEffect } from '../core/doc';
import {
  addPage,
  alignNodes,
  deleteNodes,
  distributeNodes,
  duplicateNodes,
  flattenNodes,
  flipNodes,
  groupNodes,
  reorderNodes,
  rotateNodes,
  setAutoLayout,
  tidyNodes,
  translateNodes,
  ungroupNodes,
  wrapInAutoLayout,
  setProps,
  type AlignMode,
} from '../core/ops';
import { isMac, openExternal } from '../platform/native';
import { useSettings } from './settings';
import { useUI } from '../ui/uiStore';
import { zoomStep, zoomToFit, zoomToSelection, setZoom } from './viewport';
import { importDialog, newDocument, openDocument, saveDocument } from './file';
import { copyAsPng, copyAsSvg, copySelection, cutSelection, pasteData } from './clipboard';
import { enterNode } from './tools/select';
import { toast } from '../ui/toast';
import { promptDialog } from '../ui/dialog';

export interface Action {
  id: string;
  label: string;
  group: string;
  /** default shortcut(s), e.g. "Mod+Shift+K" */
  keys?: string[];
  run: () => void;
  enabled?: () => boolean;
  /** hidden from the command palette */
  hidden?: boolean;
}

const hasSel = () => editor().selection.length > 0;
const multi = (n = 2) => () => editor().selection.length >= n;

function sel(): ID[] {
  return sortByZ(editor().doc, topLevelOnly(editor().doc, editor().selection));
}

function op(label: string, fn: (ids: ID[]) => (d: any) => unknown, select?: (r: any, ids: ID[]) => ID[]) {
  return () => {
    const ids = sel();
    if (!ids.length) return;
    editor().mutate(fn(ids), { label, select: select ? (r) => select(r, ids) : undefined });
  };
}

const tool = (t: ToolId) => () => editor().setTool(t);

export function booleanSelection(opName: BooleanOp) {
  const ids = sel();
  if (ids.length < 2) {
    toast('Select at least two shapes', { kind: 'error' });
    return;
  }
  editor().mutate((d) => groupNodes(d, ids, 'boolean', opName), { select: (r) => (r ? [r] : []), label: 'Boolean' });
}

function toggleProp(key: 'visible' | 'locked') {
  const ids = sel();
  if (!ids.length) return;
  const doc = editor().doc;
  const allOn = ids.every((id) => doc.nodes[id]?.[key]);
  editor().mutate((d) => {
    for (const id of ids) d.nodes[id][key] = !allOn as never;
  });
}

function setOpacity(v: number) {
  const ids = sel();
  if (!ids.length) return;
  editor().mutate((d) => {
    for (const id of ids) d.nodes[id].opacity = v;
  });
}

function nudge(dx: number, dy: number) {
  const s = editor();
  const ids = sel().filter((id) => !s.doc.nodes[id]?.locked);
  if (!ids.length) return;
  s.mutate((d) => translateNodes(d, ids, dx, dy), { label: 'Nudge' });
}

function selectAll() {
  const s = editor();
  const first = s.selection[0] ? s.doc.nodes[s.selection[0]] : null;
  const parentId = first ? first.parentId : s.pageId;
  const kids = s.doc.nodes[parentId] && isContainer(s.doc.nodes[parentId]) ? (s.doc.nodes[parentId] as any).children : getPage(s.doc, s.pageId)?.children ?? [];
  s.setSelection(kids.filter((id: ID) => s.doc.nodes[id]?.visible && !s.doc.nodes[id]?.locked));
}

function selectParent() {
  const s = editor();
  if (s.editing) {
    s.setEditing(null);
    return;
  }
  const first = s.selection[0] ? s.doc.nodes[s.selection[0]] : null;
  if (first && s.doc.nodes[first.parentId]) s.setSelection([first.parentId]);
  else s.setSelection([]);
}

function selectChildren() {
  const s = editor();
  if (s.selection.length !== 1) return;
  const n = s.doc.nodes[s.selection[0]];
  if (!n) return;
  if (isContainer(n) && n.children.length) s.setSelection([...n.children]);
  else enterNode(n);
}

async function renameSelection() {
  const s = editor();
  const id = s.selection[0];
  if (!id) return;
  useUI.getState().set({ renaming: id, leftTab: 'layers' });
}

function makeComponent() {
  const ids = sel();
  if (!ids.length) return;
  const s = editor();
  let target = ids.length === 1 && s.doc.nodes[ids[0]].type === 'frame' ? ids[0] : null;
  s.mutate(
    (d) => {
      if (!target) target = groupNodes(d, ids, 'frame');
      if (!target) return null;
      const f = d.nodes[target];
      if (f.type === 'frame') {
        f.isComponent = true;
        if (!f.name.startsWith('◆')) f.name = f.name.replace(/^Frame/, 'Component');
      }
      return target;
    },
    { select: (r) => (r ? [r] : []), label: 'Create component' },
  );
}

function useAsMask() {
  const ids = sel();
  if (!ids.length) return;
  const s = editor();
  const doc = s.doc;
  if (ids.length === 1 && doc.nodes[ids[0]].isMask) {
    s.mutate((d) => void (d.nodes[ids[0]].isMask = false), { label: 'Remove mask' });
    return;
  }
  // bottom-most selected node becomes the mask of a new group
  s.mutate(
    (d) => {
      const g = groupNodes(d, ids, 'group');
      if (!g) return null;
      const grp = d.nodes[g] as any;
      grp.name = 'Mask group';
      const bottom = d.nodes[grp.children[0]];
      bottom.isMask = true;
      return g;
    },
    { select: (r) => (r ? [r] : []), label: 'Mask' },
  );
}

function outlineToggle() {
  const s = useSettings.getState();
  s.set({ outlineMode: !s.outlineMode });
}

function repeatGrid() {
  void (async () => {
    const ids = sel();
    if (!ids.length) return toast('Select something to repeat', { kind: 'error' });
    const spec = await promptDialog('Repeat — columns × rows, gap (e.g. "4x3 16")', '3x3 16');
    if (!spec) return;
    const m = /(\d+)\s*[x×]\s*(\d+)(?:\s+(-?\d+(?:\.\d+)?))?/.exec(spec);
    if (!m) return toast('Use the format 4x3 16', { kind: 'error' });
    const cols = Math.min(50, +m[1]);
    const rows = Math.min(50, +m[2]);
    const gap = m[3] ? +m[3] : 16;
    const s = editor();
    const { selectionBounds } = await import('../core/geometry');
    const b = selectionBounds(s.doc, ids)!;
    s.mutate(
      (d) => {
        const out: ID[] = [...ids];
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++) {
            if (!r && !c) continue;
            out.push(...duplicateNodes(d, ids, { x: c * (b.width + gap), y: r * (b.height + gap) }));
          }
        return out;
      },
      { select: (r) => r, label: 'Repeat grid' },
    );
  })();
}

function radialRepeat() {
  void (async () => {
    const ids = sel();
    if (!ids.length) return toast('Select something to repeat', { kind: 'error' });
    const spec = await promptDialog('Radial repeat — copies, radius', '8 120');
    if (!spec) return;
    const [countS, radiusS] = spec.trim().split(/\s+/);
    const count = Math.max(2, Math.min(72, +countS || 8));
    const radius = +radiusS || 120;
    const s = editor();
    const { selectionBounds } = await import('../core/geometry');
    const b = selectionBounds(s.doc, ids)!;
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 + radius };
    s.mutate(
      (d) => {
        const out: ID[] = [...ids];
        for (let i = 1; i < count; i++) {
          const copies = duplicateNodes(d, ids);
          rotateNodes(d, copies, (360 / count) * i, center);
          out.push(...copies);
        }
        return out;
      },
      { select: (r) => r, label: 'Radial repeat' },
    );
  })();
}

function addEffect(type: 'drop-shadow' | 'layer-blur' | 'background-blur' | 'glow' | 'noise') {
  const ids = sel();
  if (!ids.length) return;
  editor().mutate((d) => {
    for (const id of ids) d.nodes[id].effects.push(defaultEffect(type));
  });
}

function textStyleToggle(kind: 'bold' | 'italic' | 'underline' | 'strike') {
  const s = editor();
  const ids = sel().filter((id) => s.doc.nodes[id]?.type === 'text');
  if (!ids.length) return;
  s.mutate((d) => {
    for (const id of ids) {
      const n = d.nodes[id] as Extract<SceneNode, { type: 'text' }>;
      if (kind === 'bold') setProps(d, id, { fontWeight: n.fontWeight >= 600 ? 400 : 700 } as any);
      if (kind === 'italic') setProps(d, id, { italic: !n.italic } as any);
      if (kind === 'underline') n.textDecoration = n.textDecoration === 'underline' ? 'none' : 'underline';
      if (kind === 'strike') n.textDecoration = n.textDecoration === 'strikethrough' ? 'none' : 'strikethrough';
    }
  });
}

export const ACTIONS: Action[] = [
  // File
  { id: 'file.new', label: 'New file', group: 'File', keys: ['Mod+N'], run: () => void newDocument() },
  { id: 'file.open', label: 'Open…', group: 'File', keys: ['Mod+O'], run: () => void openDocument() },
  { id: 'file.save', label: 'Save', group: 'File', keys: ['Mod+S'], run: () => void saveDocument(false) },
  { id: 'file.saveAs', label: 'Save as…', group: 'File', keys: ['Mod+Shift+S'], run: () => void saveDocument(true) },
  { id: 'file.close', label: 'Close file', group: 'File', keys: ['Mod+W'], run: () => void newDocument() },
  { id: 'file.import', label: 'Import image or SVG…', group: 'File', keys: ['Mod+Shift+K'], run: () => void importDialog() },
  { id: 'file.export', label: 'Export…', group: 'File', keys: ['Mod+Shift+E'], run: () => useUI.getState().set({ exportOpen: true }) },
  // Edit
  { id: 'edit.undo', label: 'Undo', group: 'Edit', keys: ['Mod+Z'], run: () => editor().undo() },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', keys: ['Mod+Shift+Z', 'Mod+Y'], run: () => editor().redo() },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', run: () => void copySelection(), hidden: true },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', run: () => void cutSelection(), hidden: true },
  { id: 'edit.copySvg', label: 'Copy as SVG', group: 'Edit', keys: ['Mod+Shift+C'], run: () => void copyAsSvg(), enabled: hasSel },
  { id: 'edit.copyPng', label: 'Copy as PNG', group: 'Edit', keys: ['Mod+Alt+C'], run: () => void copyAsPng(), enabled: hasSel },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', keys: ['Mod+D'], run: op('Duplicate', (ids) => (d) => duplicateNodes(d, ids, { x: 0, y: 0 }), (r) => r), enabled: hasSel },
  { id: 'edit.delete', label: 'Delete', group: 'Edit', keys: ['Delete', 'Backspace'], run: op('Delete', (ids) => (d) => deleteNodes(d, ids), () => []), enabled: hasSel },
  { id: 'edit.selectAll', label: 'Select all', group: 'Edit', keys: ['Mod+A'], run: selectAll },
  { id: 'edit.selectNone', label: 'Deselect / select parent', group: 'Edit', keys: ['Escape'], run: selectParent, hidden: true },
  { id: 'edit.selectChildren', label: 'Select children / edit', group: 'Edit', keys: ['Enter'], run: selectChildren, hidden: true },
  { id: 'edit.rename', label: 'Rename layer', group: 'Edit', keys: ['Mod+R'], run: () => void renameSelection(), enabled: hasSel },
  { id: 'edit.find', label: 'Find layers…', group: 'Edit', keys: ['Mod+F'], run: () => useUI.getState().set({ palette: true, paletteQuery: '#' }) },
  // View
  { id: 'view.zoomIn', label: 'Zoom in', group: 'View', keys: ['Mod+=', '=', 'Mod+Shift+=', 'Shift+='], run: () => zoomStep(1) },
  { id: 'view.zoomOut', label: 'Zoom out', group: 'View', keys: ['Mod+-', '-'], run: () => zoomStep(-1) },
  { id: 'view.zoom100', label: 'Zoom to 100%', group: 'View', keys: ['Shift+0', 'Mod+0'], run: () => setZoom(1) },
  { id: 'view.zoomFit', label: 'Zoom to fit', group: 'View', keys: ['Shift+1'], run: zoomToFit },
  { id: 'view.zoomSelection', label: 'Zoom to selection', group: 'View', keys: ['Shift+2'], run: () => zoomToSelection() },
  { id: 'view.toggleUI', label: 'Show / hide UI', group: 'View', keys: ['Mod+\\'], run: () => useUI.getState().set({ uiHidden: !useUI.getState().uiHidden }) },
  { id: 'view.toggleRulers', label: 'Rulers', group: 'View', keys: ['Shift+R'], run: () => useSettings.getState().set({ showRulers: !useSettings.getState().showRulers }) },
  { id: 'view.togglePixelGrid', label: 'Pixel grid', group: 'View', keys: ["Shift+'"], run: () => useSettings.getState().set({ showPixelGrid: !useSettings.getState().showPixelGrid }) },
  { id: 'view.outline', label: 'Outline mode', group: 'View', keys: ['Mod+Y'], run: outlineToggle },
  { id: 'view.present', label: 'Present frames', group: 'View', keys: ['Mod+Alt+Enter'], run: () => useUI.getState().set({ present: true, presentIndex: 0 }) },
  {
    id: 'view.toggleTheme',
    label: 'Toggle light / dark theme',
    group: 'View',
    keys: ['Mod+Alt+T'],
    run: () => {
      const s = useSettings.getState();
      s.set({ theme: s.theme === 'light' ? 'dark' : 'light' });
    },
  },
  // Object
  { id: 'object.group', label: 'Group selection', group: 'Object', keys: ['Mod+G'], run: op('Group', (ids) => (d) => groupNodes(d, ids, 'group'), (r) => (r ? [r] : [])), enabled: hasSel },
  { id: 'object.ungroup', label: 'Ungroup', group: 'Object', keys: ['Mod+Shift+G'], run: op('Ungroup', (ids) => (d) => ungroupNodes(d, ids), (r) => r), enabled: hasSel },
  { id: 'object.frame', label: 'Frame selection', group: 'Object', keys: ['Mod+Alt+G'], run: op('Frame', (ids) => (d) => groupNodes(d, ids, 'frame'), (r) => (r ? [r] : [])), enabled: hasSel },
  {
    id: 'object.autoLayout',
    label: 'Add auto layout',
    group: 'Object',
    keys: ['Shift+A'],
    run: () => {
      const ids = sel();
      const s = editor();
      if (ids.length === 1 && s.doc.nodes[ids[0]]?.type === 'frame') s.mutate((d) => setAutoLayout(d, ids[0], !(d.nodes[ids[0]] as any).layout), { label: 'Auto layout' });
      else if (ids.length) s.mutate((d) => wrapInAutoLayout(d, ids), { select: (r) => (r ? [r] : []), label: 'Auto layout' });
    },
    enabled: hasSel,
  },
  { id: 'object.union', label: 'Union selection', group: 'Object', keys: ['Mod+Alt+U'], run: () => booleanSelection('union'), enabled: multi() },
  { id: 'object.subtract', label: 'Subtract selection', group: 'Object', keys: ['Mod+Alt+S'], run: () => booleanSelection('subtract'), enabled: multi() },
  { id: 'object.intersect', label: 'Intersect selection', group: 'Object', keys: ['Mod+Alt+I'], run: () => booleanSelection('intersect'), enabled: multi() },
  { id: 'object.exclude', label: 'Exclude selection', group: 'Object', keys: ['Mod+Alt+X'], run: () => booleanSelection('exclude'), enabled: multi() },
  { id: 'object.flatten', label: 'Flatten', group: 'Object', keys: ['Mod+E'], run: op('Flatten', (ids) => (d) => flattenNodes(d, ids), (r) => (r ? [r] : [])), enabled: hasSel },
  { id: 'object.mask', label: 'Use as mask', group: 'Object', keys: ['Mod+Alt+M'], run: useAsMask, enabled: hasSel },
  { id: 'object.component', label: 'Create component', group: 'Object', keys: ['Mod+Alt+K'], run: makeComponent, enabled: hasSel },
  { id: 'object.flipH', label: 'Flip horizontal', group: 'Object', keys: ['Shift+H'], run: op('Flip', (ids) => (d) => flipNodes(d, ids, 'h')), enabled: hasSel },
  { id: 'object.flipV', label: 'Flip vertical', group: 'Object', keys: ['Shift+V'], run: op('Flip', (ids) => (d) => flipNodes(d, ids, 'v')), enabled: hasSel },
  { id: 'object.rotateCw', label: 'Rotate 90° clockwise', group: 'Object', keys: ['Shift+]'], run: op('Rotate', (ids) => (d) => rotateNodes(d, ids, 90)), enabled: hasSel },
  { id: 'object.rotateCcw', label: 'Rotate 90° counter-clockwise', group: 'Object', keys: ['Shift+['], run: op('Rotate', (ids) => (d) => rotateNodes(d, ids, -90)), enabled: hasSel },
  { id: 'object.bringFront', label: 'Bring to front', group: 'Arrange', keys: ['Mod+Alt+]', 'Mod+Shift+]', ']'], run: op('Arrange', (ids) => (d) => reorderNodes(d, ids, 'front')), enabled: hasSel },
  { id: 'object.bringForward', label: 'Bring forward', group: 'Arrange', keys: ['Mod+]'], run: op('Arrange', (ids) => (d) => reorderNodes(d, ids, 'forward')), enabled: hasSel },
  { id: 'object.sendBackward', label: 'Send backward', group: 'Arrange', keys: ['Mod+['], run: op('Arrange', (ids) => (d) => reorderNodes(d, ids, 'backward')), enabled: hasSel },
  { id: 'object.sendBack', label: 'Send to back', group: 'Arrange', keys: ['Mod+Alt+[', 'Mod+Shift+[', '['], run: op('Arrange', (ids) => (d) => reorderNodes(d, ids, 'back')), enabled: hasSel },
  { id: 'object.lock', label: 'Lock / unlock', group: 'Object', keys: ['Mod+Shift+L'], run: () => toggleProp('locked'), enabled: hasSel },
  { id: 'object.hide', label: 'Show / hide', group: 'Object', keys: ['Mod+Shift+H'], run: () => toggleProp('visible'), enabled: hasSel },
  { id: 'object.repeat', label: 'Repeat in grid…', group: 'Object', run: repeatGrid, enabled: hasSel },
  { id: 'object.radialRepeat', label: 'Radial repeat…', group: 'Object', run: radialRepeat, enabled: hasSel },
  { id: 'object.shadow', label: 'Add drop shadow', group: 'Effects', run: () => addEffect('drop-shadow'), enabled: hasSel },
  { id: 'object.glow', label: 'Add glow', group: 'Effects', run: () => addEffect('glow'), enabled: hasSel },
  { id: 'object.blur', label: 'Add layer blur', group: 'Effects', run: () => addEffect('layer-blur'), enabled: hasSel },
  { id: 'object.glass', label: 'Add background blur (glass)', group: 'Effects', run: () => addEffect('background-blur'), enabled: hasSel },
  { id: 'object.grain', label: 'Add grain', group: 'Effects', run: () => addEffect('noise'), enabled: hasSel },
  // Align
  ...(
    [
      ['left', 'Align left', 'Alt+A'],
      ['hcenter', 'Align horizontal centers', 'Alt+H'],
      ['right', 'Align right', 'Alt+D'],
      ['top', 'Align top', 'Alt+W'],
      ['vcenter', 'Align vertical centers', 'Alt+V'],
      ['bottom', 'Align bottom', 'Alt+S'],
    ] as [AlignMode, string, string][]
  ).map(([m, label, key]) => ({ id: `align.${m}`, label, group: 'Align', keys: [key], run: op('Align', (ids) => (d) => alignNodes(d, ids, m)), enabled: hasSel })),
  { id: 'align.distributeH', label: 'Distribute horizontal spacing', group: 'Align', keys: ['Alt+Shift+H'], run: op('Distribute', (ids) => (d) => distributeNodes(d, ids, 'h')), enabled: multi(3) },
  { id: 'align.distributeV', label: 'Distribute vertical spacing', group: 'Align', keys: ['Alt+Shift+V'], run: op('Distribute', (ids) => (d) => distributeNodes(d, ids, 'v')), enabled: multi(3) },
  { id: 'align.tidy', label: 'Tidy up', group: 'Align', keys: ['Mod+Alt+Shift+T'], run: op('Tidy up', (ids) => (d) => tidyNodes(d, ids)), enabled: multi() },
  // Text
  { id: 'text.bold', label: 'Bold', group: 'Text', keys: ['Mod+B'], run: () => textStyleToggle('bold') },
  { id: 'text.italic', label: 'Italic', group: 'Text', keys: ['Mod+I'], run: () => textStyleToggle('italic') },
  { id: 'text.underline', label: 'Underline', group: 'Text', keys: ['Mod+U'], run: () => textStyleToggle('underline') },
  { id: 'text.strike', label: 'Strikethrough', group: 'Text', keys: ['Mod+Shift+X'], run: () => textStyleToggle('strike') },
  // Tools
  { id: 'tool.move', label: 'Move', group: 'Tools', keys: ['V'], run: tool('move') },
  { id: 'tool.scale', label: 'Scale', group: 'Tools', keys: ['K'], run: tool('scale') },
  { id: 'tool.hand', label: 'Hand', group: 'Tools', keys: ['H'], run: tool('hand') },
  { id: 'tool.frame', label: 'Frame', group: 'Tools', keys: ['F', 'A'], run: tool('frame') },
  { id: 'tool.rect', label: 'Rectangle', group: 'Tools', keys: ['R'], run: tool('rect') },
  { id: 'tool.ellipse', label: 'Ellipse', group: 'Tools', keys: ['O'], run: tool('ellipse') },
  { id: 'tool.polygon', label: 'Polygon', group: 'Tools', keys: ['Y'], run: tool('polygon') },
  { id: 'tool.star', label: 'Star', group: 'Tools', keys: ['Shift+Y'], run: tool('star') },
  { id: 'tool.line', label: 'Line', group: 'Tools', keys: ['L'], run: tool('line') },
  { id: 'tool.arrow', label: 'Arrow', group: 'Tools', keys: ['Shift+L'], run: tool('arrow') },
  { id: 'tool.spiral', label: 'Spiral', group: 'Tools', keys: ['Shift+O'], run: tool('spiral') },
  { id: 'tool.shape', label: 'Shape library', group: 'Tools', keys: ['Shift+U'], run: tool('shape') },
  { id: 'tool.pen', label: 'Pen', group: 'Tools', keys: ['P'], run: tool('pen') },
  { id: 'tool.pencil', label: 'Pencil', group: 'Tools', keys: ['Shift+P'], run: tool('pencil') },
  { id: 'tool.brush', label: 'Vector brush', group: 'Tools', keys: ['B'], run: tool('brush') },
  { id: 'tool.text', label: 'Text', group: 'Tools', keys: ['T'], run: tool('text') },
  { id: 'tool.paint', label: 'Paint brush (raster)', group: 'Tools', keys: ['Shift+B'], run: tool('paint') },
  { id: 'tool.eraser', label: 'Eraser', group: 'Tools', keys: ['E'], run: tool('eraser') },
  { id: 'tool.spray', label: 'Spray', group: 'Tools', keys: ['Shift+J'], run: tool('spray') },
  { id: 'tool.pixel', label: 'Pixel pencil', group: 'Tools', keys: ['X'], run: tool('pixel') },
  { id: 'tool.bucket', label: 'Paint bucket', group: 'Tools', keys: ['G'], run: tool('bucket') },
  { id: 'tool.eyedropper', label: 'Eyedropper', group: 'Tools', keys: ['I'], run: tool('eyedropper') },
  { id: 'tool.image', label: 'Place image…', group: 'Tools', run: () => void importDialog() },
  // Pages
  {
    id: 'page.new',
    label: 'New page',
    group: 'Pages',
    run: () => {
      const id = editor().mutate((d) => addPage(d), { label: 'New page' });
      editor().setPage(id);
    },
  },
  // App
  { id: 'app.commandPalette', label: 'Command palette', group: 'App', keys: ['Mod+K', 'Mod+/'], run: () => useUI.getState().set({ palette: true, paletteQuery: '' }) },
  { id: 'app.settings', label: 'Settings', group: 'App', keys: ['Mod+,'], run: () => useUI.getState().set({ settings: 'appearance' }) },
  { id: 'app.shortcuts', label: 'Keyboard shortcuts', group: 'App', keys: ['Mod+Shift+/'], run: () => useUI.getState().set({ settings: 'shortcuts' }) },
  { id: 'help.mcp', label: 'Connect AI agents (MCP)', group: 'App', run: () => useUI.getState().set({ settings: 'mcp' }) },
  // nudges & opacity (hidden from the palette)
  ...[
    ['ArrowLeft', -1, 0],
    ['ArrowRight', 1, 0],
    ['ArrowUp', 0, -1],
    ['ArrowDown', 0, 1],
  ].flatMap(([k, x, y]) => [
    { id: `nudge.${k}`, label: `Nudge ${k}`, group: 'Edit', keys: [k as string], run: () => nudge((x as number) * useSettings.getState().nudge, (y as number) * useSettings.getState().nudge), hidden: true },
    {
      id: `nudgeBig.${k}`,
      label: `Big nudge ${k}`,
      group: 'Edit',
      keys: [`Shift+${k}`],
      run: () => nudge((x as number) * useSettings.getState().bigNudge, (y as number) * useSettings.getState().bigNudge),
      hidden: true,
    },
  ]),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => ({
    id: `opacity.${n}`,
    label: `Opacity ${n === 0 ? 100 : n * 10}%`,
    group: 'Edit',
    keys: [String(n)],
    run: () => setOpacity(n === 0 ? 1 : n / 10),
    hidden: true,
  })),
];

const byId = new Map(ACTIONS.map((a) => [a.id, a]));

export function getAction(id: string) {
  return byId.get(id);
}

export function runAction(id: string) {
  const a = byId.get(id);
  if (!a) {
    // native-menu-only actions
    if (id === 'help.docs') openExternal('https://github.com/nox-abc/alt#readme');
    else if (id === 'file.close') void newDocument();
    return;
  }
  if (a.enabled && !a.enabled()) return;
  a.run();
}

/* ------------------------------------------------------------- shortcuts */

export function keysFor(id: string): string[] {
  const custom = useSettings.getState().keymap[id];
  if (custom !== undefined) return custom ? [custom] : [];
  return byId.get(id)?.keys ?? [];
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Equal: '=',
  Minus: '-',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Backquote: '`',
  NumpadAdd: '=',
  NumpadSubtract: '-',
};

export function eventCombo(e: KeyboardEvent): string {
  let key: string;
  if (e.code.startsWith('Key')) key = e.code.slice(3);
  else if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else if (e.key === ' ') key = 'Space';
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mod) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

let comboIndex: Map<string, string> | null = null;
useSettings.subscribe(() => (comboIndex = null));

function index(): Map<string, string> {
  if (comboIndex) return comboIndex;
  comboIndex = new Map();
  for (const a of ACTIONS) for (const k of keysFor(a.id)) if (!comboIndex.has(k)) comboIndex.set(k, a.id);
  return comboIndex;
}

export function actionForEvent(e: KeyboardEvent): string | null {
  return index().get(eventCombo(e)) ?? null;
}

export function formatKeys(combo: string | undefined): string {
  if (!combo) return '';
  const parts = combo.split('+');
  const key = parts.pop()!;
  const map: Record<string, string> = isMac
    ? { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃' }
    : { Mod: 'Ctrl+', Alt: 'Alt+', Shift: 'Shift+', Ctrl: 'Ctrl+' };
  const keyMap: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Enter: isMac ? '↩' : 'Enter',
    Escape: 'Esc',
    Backspace: isMac ? '⌫' : 'Backspace',
    Delete: isMac ? '⌦' : 'Del',
    Space: 'Space',
  };
  return parts.map((p) => map[p] ?? p).join('') + (keyMap[key] ?? key);
}

export function shortcutLabel(id: string): string {
  return formatKeys(keysFor(id)[0]);
}
