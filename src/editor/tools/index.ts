import type { ToolId } from '../../core/store';
import type { Tool } from '../toolkit';
import { selectTool } from './select';
import { makeShapeTool } from './shape';
import { textTool } from './text';
import { brushTool, pencilTool } from './draw';
import { bucketTool, eraserTool, paintTool, pixelTool, sprayTool } from './paint';
import { eyedropperTool, handTool } from './misc';
import { penTool } from './pen';

const shapeTools = Object.fromEntries(
  (['frame', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'spiral', 'shape'] as ToolId[]).map((t) => [t, makeShapeTool(t)]),
);

export const TOOLS: Partial<Record<ToolId, Tool>> = {
  move: selectTool,
  scale: { ...selectTool, id: 'scale' },
  hand: handTool,
  text: textTool,
  pen: penTool,
  pencil: pencilTool,
  brush: brushTool,
  paint: paintTool,
  eraser: eraserTool,
  spray: sprayTool,
  pixel: pixelTool,
  bucket: bucketTool,
  eyedropper: eyedropperTool,
  ...shapeTools,
};

export function getTool(id: ToolId): Tool {
  return TOOLS[id] ?? selectTool;
}
