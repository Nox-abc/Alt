import type { ID, NodeType, Rect, SceneNode, Vec } from '../../core/types';
import { editor, getViewport, type ToolId } from '../../core/store';
import { normRect, rectContains, worldBounds } from '../../core/geometry';
import { createNode, uniqueName, solid } from '../../core/doc';
import { frameAt, insertNode, moveNodes, pagePointToParent, pageRectToParent, refitNode } from '../../core/ops';
import { cmdsToSubPaths } from '../../core/path';
import { shapeLibraryCmds, spiralCmds, SHAPE_LIBRARY } from '../../core/shapes';
import { snapBox, snapTargets } from '../snapping';
import { useSettings } from '../settings';
import { CURSORS, requestOverlay, ui, type PointerInfo, type Tool } from '../toolkit';

interface Drawing {
  tool: ToolId;
  start: Vec;
  id: ID;
  parent: ID;
  moved: boolean;
  targets: ReturnType<typeof snapTargets>;
}

let cur: Drawing | null = null;

function nodeTypeFor(tool: ToolId): NodeType {
  switch (tool) {
    case 'frame':
      return 'frame';
    case 'rect':
      return 'rect';
    case 'ellipse':
      return 'ellipse';
    case 'polygon':
      return 'polygon';
    case 'star':
      return 'star';
    default:
      return 'path';
  }
}

function geometryFor(tool: ToolId, w: number, h: number): Partial<SceneNode> {
  const o = editor().toolOptions;
  switch (tool) {
    case 'polygon':
      return { sides: o.polygonSides } as Partial<SceneNode>;
    case 'star':
      return { points: o.starPoints, innerRadius: o.starInner } as Partial<SceneNode>;
    case 'spiral':
      return { paths: cmdsToSubPaths(spiralCmds(Math.max(w, 1), Math.max(h, 1), o.spiralTurns)), fills: [], strokeWidth: 2 } as Partial<SceneNode>;
    case 'shape': {
      const def = SHAPE_LIBRARY.find((s) => s.id === o.shapeId) ?? SHAPE_LIBRARY[0];
      return {
        name: def.name,
        paths: cmdsToSubPaths(shapeLibraryCmds(def.id, { x: 0, y: 0, width: Math.max(w, 1), height: Math.max(h, 1) })),
        fills: [solid()],
        strokes: [],
        fillRule: 'evenodd',
      } as Partial<SceneNode>;
    }
    default:
      return {};
  }
}

function constrain(p: PointerInfo, start: Vec): Rect {
  let end = { ...p.world };
  if (p.shift) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    end = { x: start.x + Math.sign(dx || 1) * s, y: start.y + Math.sign(dy || 1) * s };
  }
  if (p.alt) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  }
  return normRect(start, end);
}

function isLine(tool: ToolId) {
  return tool === 'line' || tool === 'arrow';
}

function applyRect(d: Drawing, r: Rect, p?: PointerInfo) {
  const s = editor();
  s.mutate(
    (doc) => {
      const n = doc.nodes[d.id];
      if (!n) return;
      if (isLine(d.tool) && n.type === 'path') {
        const a = pagePointToParent(doc, d.parent, d.start);
        let endW = p ? p.world : { x: r.x + r.width, y: r.y + r.height };
        if (p?.shift) {
          const dx = endW.x - d.start.x;
          const dy = endW.y - d.start.y;
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(dx, dy);
          endW = { x: d.start.x + Math.cos(ang) * len, y: d.start.y + Math.sin(ang) * len };
        }
        const b = pagePointToParent(doc, d.parent, endW);
        n.x = 0;
        n.y = 0;
        n.width = 1;
        n.height = 1;
        n.paths = [
          {
            closed: false,
            points: [
              { x: a.x, y: a.y, in: null, out: null, mode: 'corner' },
              { x: b.x, y: b.y, in: null, out: null, mode: 'corner' },
            ],
          },
        ];
        refitNode(doc, n.id);
        return;
      }
      const lr = pageRectToParent(doc, d.parent, r);
      n.x = lr.x;
      n.y = lr.y;
      n.width = Math.max(1, lr.width);
      n.height = Math.max(1, lr.height);
      if (d.tool === 'spiral' || d.tool === 'shape') Object.assign(n, geometryFor(d.tool, n.width, n.height));
    },
    { history: false },
  );
}

function wrapContained(frameId: ID) {
  const s = editor();
  const doc = s.doc;
  const f = doc.nodes[frameId];
  if (!f) return;
  const fb = worldBounds(doc, frameId);
  const siblings = (doc.nodes[f.parentId] as any)?.children ?? doc.pages.find((p) => p.id === f.parentId)?.children ?? [];
  const inside = (siblings as ID[]).filter((id) => id !== frameId && doc.nodes[id] && rectContains(fb, worldBounds(doc, id)));
  if (inside.length) s.mutate((d) => moveNodes(d, inside, frameId), { history: false });
}

export function makeShapeTool(tool: ToolId): Tool {
  return {
    id: tool,
    cursor: CURSORS.crosshair,
    down(p) {
      if (p.button !== 0) return;
      const s = editor();
      const parent = frameAt(s.doc, s.pageId, p.world) ?? s.pageId;
      s.begin('Create');
      const type = nodeTypeFor(tool);
      const id = s.mutate(
        (d) => {
          const props: Partial<SceneNode> = { ...geometryFor(tool, 1, 1) };
          if (isLine(tool)) {
            Object.assign(props, { name: tool === 'arrow' ? 'Arrow' : 'Line', fills: [], endMarker: tool === 'arrow' ? 'arrow' : s.toolOptions.lineMarker, strokeWidth: 2 });
          }
          if (tool === 'spiral') props.name = 'Spiral';
          const n = createNode(type, { parentId: parent, ...(props as any) });
          if (type === 'frame') n.name = uniqueName(d, parent, 'Frame');
          const lp = pagePointToParent(d, parent, p.world);
          n.x = lp.x;
          n.y = lp.y;
          n.width = 1;
          n.height = 1;
          return insertNode(d, n, parent);
        },
        { select: (r) => [r], history: false },
      );
      cur = { tool, start: p.world, id, parent, moved: false, targets: snapTargets(s.doc, s.pageId, [id]) };
      ui.dragging = true;
    },
    move(p) {
      if (!cur || !(p.buttons & 1)) return;
      const d = cur;
      if (!d.moved && Math.hypot(p.world.x - d.start.x, p.world.y - d.start.y) * getViewport().zoom < 2) return;
      d.moved = true;
      let r = constrain(p, d.start);
      if (!isLine(tool) && !p.mod) {
        const xs: ('min' | 'max')[] = [p.world.x >= d.start.x ? 'max' : 'min'];
        const ys: ('min' | 'max')[] = [p.world.y >= d.start.y ? 'max' : 'min'];
        const snap = snapBox(r, d.targets, getViewport().zoom, { x: xs, y: ys });
        ui.snapLines = snap.lines;
        if (xs[0] === 'max') r.width += snap.dx;
        else {
          r.x += snap.dx;
          r.width -= snap.dx;
        }
        if (ys[0] === 'max') r.height += snap.dy;
        else {
          r.y += snap.dy;
          r.height -= snap.dy;
        }
        if (useSettings.getState().snapToPixels) {
          const x2 = Math.round(r.x + r.width);
          const y2 = Math.round(r.y + r.height);
          r = { x: Math.round(r.x), y: Math.round(r.y), width: x2 - Math.round(r.x), height: y2 - Math.round(r.y) };
        }
      }
      ui.label = { text: `${Math.round(r.width)} × ${Math.round(r.height)}`, at: p.screen };
      applyRect(d, r, p);
      requestOverlay();
    },
    up(p) {
      if (!cur) return;
      const d = cur;
      cur = null;
      ui.dragging = false;
      ui.snapLines = [];
      ui.label = null;
      if (!d.moved) {
        // click → default sized shape centred on the pointer
        const size = tool === 'frame' ? { w: 100, h: 100 } : isLine(tool) ? { w: 100, h: 0 } : { w: 100, h: 100 };
        if (isLine(tool)) applyRect(d, { x: d.start.x, y: d.start.y, width: size.w, height: 0 }, { ...p, world: { x: d.start.x + 100, y: d.start.y }, shift: false });
        else applyRect(d, { x: Math.round(d.start.x - size.w / 2), y: Math.round(d.start.y - size.h / 2), width: size.w, height: size.h });
      }
      if (tool === 'frame') wrapContained(d.id);
      editor().commit();
      if (!editor().toolLock) editor().setTool('move');
      requestOverlay();
    },
    cancel() {
      if (cur) editor().cancel();
      cur = null;
      ui.dragging = false;
      ui.snapLines = [];
      ui.label = null;
    },
  };
}
