import type { Vec } from '../../core/types';
import { editor, getViewport } from '../../core/store';
import { rgbToHex } from '../../core/doc';
import { CURSORS, requestOverlay, setCursor, ui, type Tool } from '../toolkit';
import { toast } from '../../ui/toast';

let panStart: { screen: Vec; vx: number; vy: number } | null = null;

export const handTool: Tool = {
  id: 'hand',
  cursor: CURSORS.hand,
  down(p) {
    const v = getViewport();
    panStart = { screen: p.screen, vx: v.x, vy: v.y };
    setCursor(CURSORS.grabbing);
  },
  move(p) {
    if (!panStart) return;
    editor().setViewport({ x: panStart.vx + p.screen.x - panStart.screen.x, y: panStart.vy + p.screen.y - panStart.screen.y });
  },
  up() {
    panStart = null;
    setCursor(CURSORS.hand);
  },
  cancel() {
    panStart = null;
  },
};

/** The scene canvas is registered by the Canvas component (for colour sampling). */
export const sceneCanvasRef: { current: HTMLCanvasElement | null } = { current: null };

export function sampleScreen(p: Vec): string | null {
  const c = sceneCanvasRef.current;
  if (!c) return null;
  const dpr = c.width / (c.clientWidth || 1);
  const ctx = c.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
  if (!ctx) return null;
  const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
  return rgbToHex(d[0], d[1], d[2]);
}

export const eyedropperTool: Tool = {
  id: 'eyedropper',
  cursor: CURSORS.eyedropper,
  down(p) {
    const hex = sampleScreen(p.screen);
    if (!hex) return;
    const s = editor();
    s.setToolOptions({ paintColor: hex, brushColor: hex });
    const ids = s.selection.filter((id) => s.doc.nodes[id] && s.doc.nodes[id].type !== 'group');
    if (ids.length && !p.alt) {
      s.mutate(
        (d) => {
          for (const id of ids) {
            const n = d.nodes[id];
            const first = n.fills[0];
            if (first?.type === 'solid') first.color = hex;
            else n.fills = [{ id: first?.id ?? Math.random().toString(36).slice(2), type: 'solid', color: hex, opacity: 1, visible: true }];
          }
        },
        { label: 'Pick colour' },
      );
    }
    navigator.clipboard?.writeText(hex).catch(() => {});
    toast(`Picked ${hex}`, { color: hex });
    if (!s.toolLock) s.setTool('move');
  },
  move(p) {
    ui.label = { text: sampleScreen(p.screen) ?? '', at: p.screen };
    requestOverlay();
  },
  cancel() {
    ui.label = null;
  },
};
