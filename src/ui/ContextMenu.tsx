import { editor } from '../core/store';
import { isMac } from '../platform/native';
import { useUI, type MenuItem } from './uiStore';
import { MenuList, Popover } from './controls';
import { copySelection, cutSelection, pasteFromSystem } from '../editor/clipboard';

export function selectionMenu(): MenuItem[] {
  const s = editor();
  const n = s.selection.length;
  const first = n ? s.doc.nodes[s.selection[0]] : null;
  const isContainer = first && (first.type === 'group' || first.type === 'frame' || first.type === 'boolean');
  return [
    { label: 'Copy', shortcut: isMac ? '⌘C' : 'Ctrl+C', run: () => (document.execCommand('copy') ? undefined : copySelection()) },
    { label: 'Cut', shortcut: isMac ? '⌘X' : 'Ctrl+X', run: () => (document.execCommand('cut') ? undefined : cutSelection()) },
    { label: 'Paste', shortcut: isMac ? '⌘V' : 'Ctrl+V', run: () => void pasteFromSystem() },
    {
      label: 'Copy as',
      submenu: [
        { label: 'Copy as SVG', action: 'edit.copySvg' },
        { label: 'Copy as PNG', action: 'edit.copyPng' },
      ],
    },
    { action: 'edit.duplicate', label: 'Duplicate' },
    { action: 'edit.delete', label: 'Delete', danger: true },
    { separator: true },
    { action: 'object.group', label: 'Group selection' },
    { action: 'object.frame', label: 'Frame selection' },
    ...(isContainer ? [{ action: 'object.ungroup', label: first!.type === 'frame' ? 'Remove frame' : 'Ungroup' }] : []),
    { action: 'object.autoLayout', label: 'Add auto layout' },
    {
      label: 'Boolean',
      disabled: n < 2,
      submenu: [
        { action: 'object.union', label: 'Union' },
        { action: 'object.subtract', label: 'Subtract' },
        { action: 'object.intersect', label: 'Intersect' },
        { action: 'object.exclude', label: 'Exclude' },
      ],
    },
    { action: 'object.flatten', label: 'Flatten' },
    { action: 'object.mask', label: first?.isMask ? 'Remove mask' : 'Use as mask' },
    { action: 'object.component', label: 'Create component' },
    { separator: true },
    {
      label: 'Arrange',
      submenu: [
        { action: 'object.bringFront', label: 'Bring to front' },
        { action: 'object.bringForward', label: 'Bring forward' },
        { action: 'object.sendBackward', label: 'Send backward' },
        { action: 'object.sendBack', label: 'Send to back' },
      ],
    },
    {
      label: 'Transform',
      submenu: [
        { action: 'object.flipH', label: 'Flip horizontal' },
        { action: 'object.flipV', label: 'Flip vertical' },
        { action: 'object.rotateCw', label: 'Rotate 90° clockwise' },
        { action: 'object.rotateCcw', label: 'Rotate 90° counter-clockwise' },
        { separator: true },
        { action: 'object.repeat', label: 'Repeat in grid…' },
        { action: 'object.radialRepeat', label: 'Radial repeat…' },
      ],
    },
    {
      label: 'Effects',
      submenu: [
        { action: 'object.shadow', label: 'Drop shadow' },
        { action: 'object.glow', label: 'Glow' },
        { action: 'object.blur', label: 'Layer blur' },
        { action: 'object.glass', label: 'Glass (background blur)' },
        { action: 'object.grain', label: 'Grain' },
      ],
    },
    { separator: true },
    { action: 'object.hide', label: first?.visible === false ? 'Show' : 'Hide' },
    { action: 'object.lock', label: first?.locked ? 'Unlock' : 'Lock' },
    { action: 'edit.rename', label: 'Rename' },
    { action: 'view.zoomSelection', label: 'Zoom to selection' },
    { action: 'file.export', label: 'Export…' },
  ];
}

export function canvasMenu(): MenuItem[] {
  return [
    { label: 'Paste here', run: () => void pasteFromSystem() },
    { action: 'edit.selectAll', label: 'Select all' },
    { separator: true },
    { action: 'file.import', label: 'Import image or SVG…' },
    { action: 'view.zoomFit', label: 'Zoom to fit' },
    { action: 'view.zoom100', label: 'Zoom to 100%' },
    { separator: true },
    { action: 'view.togglePixelGrid', label: 'Pixel grid' },
    { action: 'view.toggleRulers', label: 'Rulers' },
    { action: 'view.outline', label: 'Outline mode' },
    { separator: true },
    { action: 'app.commandPalette', label: 'Command palette…' },
  ];
}

export function openContextMenu(x: number, y: number, hasSelection: boolean) {
  useUI.getState().set({ contextMenu: { x, y, items: hasSelection ? selectionMenu() : canvasMenu() } });
}

export function ContextMenuHost() {
  const cm = useUI((s) => s.contextMenu);
  if (!cm) return null;
  const close = () => useUI.getState().set({ contextMenu: null });
  return (
    <Popover anchor={{ x: cm.x, y: cm.y }} placement="point" onClose={close} width={232}>
      <MenuList items={cm.items} onClose={close} />
    </Popover>
  );
}
