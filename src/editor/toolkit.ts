import type { ID, Rect, Vec } from '../core/types';
import type { ToolId } from '../core/store';
import type { SnapLine } from './snapping';
import { editor } from '../core/store';
import { apply, selectionBounds, worldMatrix, boxCorners } from '../core/geometry';

export interface PointerInfo {
  screen: Vec;
  world: Vec;
  button: number;
  buttons: number;
  shift: boolean;
  alt: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS */
  mod: boolean;
  pressure: number;
  pointerType: string;
  clickCount: number;
  event: PointerEvent | MouseEvent;
}

export interface Tool {
  id: ToolId;
  cursor?: string | (() => string);
  down?(p: PointerInfo): void;
  move?(p: PointerInfo): void;
  up?(p: PointerInfo): void;
  dblclick?(p: PointerInfo): void;
  key?(e: KeyboardEvent): boolean;
  keyUp?(e: KeyboardEvent): void;
  overlay?(ctx: CanvasRenderingContext2D): void;
  /** called when switching away or on Escape */
  cancel?(): void;
  activate?(): void;
}

/** Transient interaction state drawn by the overlay. */
export const ui = {
  snapLines: [] as SnapLine[],
  marquee: null as Rect | null,
  dragging: false,
  transforming: false,
  /** frame that will receive dropped nodes */
  dropTarget: null as ID | null,
  /** auto-layout insertion indicator in world coords */
  insertion: null as { a: Vec; b: Vec } | null,
  pointerWorld: null as Vec | null,
  pointerScreen: null as Vec | null,
  altDown: false,
  spaceDown: false,
  /** live label near the cursor ("120 × 80", "45°") */
  label: null as { text: string; at: Vec } | null,
  hoverHandle: null as string | null,
  frameLabelHover: null as ID | null,
};

type Fn = () => void;
let overlayFn: Fn = () => {};
let sceneFn: Fn = () => {};
let cursorFn: (c: string) => void = () => {};

export function bindCanvas(fns: { overlay: Fn; scene: Fn; cursor: (c: string) => void }) {
  overlayFn = fns.overlay;
  sceneFn = fns.scene;
  cursorFn = fns.cursor;
}

export const requestOverlay = () => overlayFn();
export const requestScene = () => sceneFn();
export const setCursor = (c: string) => cursorFn(c);

/* ------------------------------------------------------------ selection box */

export interface SelectionFrame {
  /** world-space corners tl, tr, br, bl */
  quad: Vec[];
  rotation: number;
  single: ID | null;
  width: number;
  height: number;
}

export function selectionFrame(ids: ID[] = editor().selection): SelectionFrame | null {
  const s = editor();
  const sel = ids.filter((id) => s.doc.nodes[id]);
  if (!sel.length) return null;
  if (sel.length === 1) {
    const n = s.doc.nodes[sel[0]];
    const m = worldMatrix(s.doc, n.id);
    const quad = boxCorners(n.width, n.height).map((p) => apply(m, p));
    const rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    return { quad, rotation: rot, single: n.id, width: n.width, height: n.height };
  }
  const b = selectionBounds(s.doc, sel)!;
  return {
    quad: [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height },
    ],
    rotation: 0,
    single: null,
    width: b.width,
    height: b.height,
  };
}

/** Handle ids: nw n ne e se s sw w – with normalised local coords. */
export const HANDLES: { id: string; hx: number; hy: number }[] = [
  { id: 'nw', hx: 0, hy: 0 },
  { id: 'n', hx: 0.5, hy: 0 },
  { id: 'ne', hx: 1, hy: 0 },
  { id: 'e', hx: 1, hy: 0.5 },
  { id: 'se', hx: 1, hy: 1 },
  { id: 's', hx: 0.5, hy: 1 },
  { id: 'sw', hx: 0, hy: 1 },
  { id: 'w', hx: 0, hy: 0.5 },
];

export function quadPoint(quad: Vec[], hx: number, hy: number): Vec {
  const top = { x: quad[0].x + (quad[1].x - quad[0].x) * hx, y: quad[0].y + (quad[1].y - quad[0].y) * hx };
  const bot = { x: quad[3].x + (quad[2].x - quad[3].x) * hx, y: quad[3].y + (quad[2].y - quad[3].y) * hx };
  return { x: top.x + (bot.x - top.x) * hy, y: top.y + (bot.y - top.y) * hy };
}

const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];

export function resizeCursor(handle: string, rotation: number): string {
  const base: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const a = (((base[handle] + rotation) % 180) + 180) % 180;
  const idx = Math.round(a / 45) % 4;
  return RESIZE_CURSORS[idx];
}

function svgCursor(svg: string, x: number, y: number, fallback: string) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
}

export function rotateCursor(angle: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${angle} 12 12)"><path d="M7 15.5a6.5 6.5 0 0 1 9.4-8.6l1.6-1.4v5h-5l1.9-1.7A4.5 4.5 0 0 0 9 15.4" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></g></svg>`;
  return svgCursor(svg, 12, 12, 'crosshair');
}

export const CURSORS = {
  crosshair: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 3v18M3 12h18" stroke="#fff" stroke-width="3"/><path d="M12 3v18M3 12h18" stroke="#000" stroke-width="1"/></svg>`,
    12,
    12,
    'crosshair',
  ),
  pen: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 3l6.5 15 2.2-6.3L18 9.5z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/><circle cx="10.6" cy="10.6" r="1.4" fill="#fff"/></svg>`,
    3,
    3,
    'crosshair',
  ),
  penAdd: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 3l6.5 15 2.2-6.3L18 9.5z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/><path d="M17 15v6M14 18h6" stroke="#000" stroke-width="3"/><path d="M17 15v6M14 18h6" stroke="#fff" stroke-width="1.2"/></svg>`,
    3,
    3,
    'crosshair',
  ),
  penClose: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 3l6.5 15 2.2-6.3L18 9.5z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/><circle cx="18" cy="18" r="3" fill="none" stroke="#000" stroke-width="3"/><circle cx="18" cy="18" r="3" fill="none" stroke="#fff" stroke-width="1.2"/></svg>`,
    3,
    3,
    'crosshair',
  ),
  pencil: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 21l2-6L16 4l4 4L9 19z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
    3,
    21,
    'crosshair',
  ),
  eyedropper: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 21l1-4 9-9 3 3-9 9z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/><path d="M14 5l2-2a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3l-2 2z" fill="#000" stroke="#fff" stroke-width="1.2"/></svg>`,
    3,
    21,
    'crosshair',
  ),
  bucket: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 11l7-7 8 8-7 7z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/><path d="M20 14c1.5 2 2 3 2 4a2 2 0 0 1-4 0c0-1 .5-2 2-4z" fill="#fff" stroke="#000"/></svg>`,
    20,
    20,
    'crosshair',
  ),
  text: 'text',
  hand: 'grab',
  grabbing: 'grabbing',
  move: 'default',
  duplicate: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l12 10-6 .5L13 19l-2.5 1-3-6.5L4 17z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/><path d="M18 14v6M15 17h6" stroke="#000" stroke-width="3"/><path d="M18 14v6M15 17h6" stroke="#fff" stroke-width="1.2"/></svg>`,
    4,
    2,
    'copy',
  ),
};

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
