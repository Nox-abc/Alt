/**
 * MCP tool definitions for Alt.
 *
 * PURE DATA — no DOM, store or Electron imports: this module is bundled into
 * the Electron main process (tools/list) and into the renderer (tool execution
 * in `mcpHandlers.ts`).
 */

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: McpToolAnnotations;
}

// Loose JSON-Schema type: enough structure to be useful, open enough for any keyword.
export type JsonSchema = { [key: string]: unknown };

/** Tools that execute arbitrary code — only listed when the user enables scripts. */
export const SCRIPT_TOOLS = ['run_script'] as const;

/* --------------------------------------------------------------- helpers */

const num = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'number', description, ...extra });
const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra });
const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
const oneOfStr = (values: readonly string[], description: string): JsonSchema => ({ type: 'string', enum: [...values], description });
const ids = (description = 'Node ids.'): JsonSchema => ({ type: 'array', items: { type: 'string' }, description });

const COLOR_HELP = 'hex (#RRGGBB / #RRGGBBAA), rgb()/rgba()/hsl() or a CSS colour name';

const paintSchema: JsonSchema = {
  description:
    `Paint shorthand. One of: a colour string (${COLOR_HELP}); "none" or null to remove; ` +
    'a gradient object {type:"linear"|"radial"|"angular"|"diamond", stops:[{offset:0..1, color, opacity?}] (or colors:["#a","#b",…]), angle? (linear, CSS degrees: 0 = to top, 90 = to right, 180 = to bottom — default 180), from?/to? ({x,y} normalised 0..1 handles)}; ' +
    'or an image object {type:"image", src:"https://…" | "data:…" | "/absolute/path.png", fit?:"fill"|"fit"|"crop"|"tile"|"stretch"}.',
  anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'null' }],
};

const paintArraySchema = (what: string): JsonSchema => ({
  type: 'array',
  description:
    `Full ${what} list (bottom → top), replacing the existing one. Each item is a paint object: ` +
    '{type:"solid", color, opacity?} | {type:"linear"|"radial"|"angular"|"diamond", stops, from?, to?, angle?} | {type:"image", src, fit?} | ' +
    '{type:"pattern", pattern:"dots"|"grid"|"lines"|"diagonal"|"checker"|"cross"|"waves"|"zigzag"|"triangles"|"hexagons", color, background?, scale?} | {type:"noise", color, density?, size?}. ' +
    'Colour strings are also accepted as items. Optional on every paint: opacity (0..1), visible, blendMode.',
  items: { anyOf: [{ type: 'string' }, { type: 'object' }] },
});

const shadowSchema: JsonSchema = {
  description:
    'Drop shadow shorthand (replaces existing shadows): {x?, y?, blur?, spread?, color?, opacity?, inner?: true for an inner shadow}, an array of those, ' +
    'true for a soft default shadow, or null/false to remove. Colour alpha (e.g. "#0000001A") is used as opacity when opacity is omitted.',
  anyOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }, { type: 'boolean' }, { type: 'null' }],
};

const autoLayoutSchema: JsonSchema = {
  description:
    'Auto layout for frames (like CSS flexbox). {mode:"horizontal"|"vertical"|"none", gap?, padding? (number | [vertical, horizontal] | [top, right, bottom, left] | {top,right,bottom,left}), ' +
    'align? (cross axis: "start"|"center"|"end"|"stretch"), justify? (main axis: "start"|"center"|"end"|"space-between"), wrap? (horizontal only)}. ' +
    'Children are then positioned automatically (their x/y are ignored). Unless sizingH/sizingV are given, the frame hugs its content on each axis where width/height was not specified. ' +
    'Pass null or {mode:"none"} to remove auto layout.',
  anyOf: [{ type: 'object' }, { type: 'null' }],
};

/** Properties shared by create_nodes specs and update_nodes. */
const nodeProps: Record<string, JsonSchema> = {
  name: str('Layer name shown in the layers panel and used by code exporters ("Header", "Primary button").'),
  x: num('Left of the unrotated box, relative to the parent (ignored inside auto-layout frames).'),
  y: num('Top of the unrotated box, relative to the parent (ignored inside auto-layout frames).'),
  width: num('Width in px. Text: setting width makes the text wrap (autoResize "height").'),
  height: num('Height in px.'),
  rotation: num('Degrees, clockwise, around the box centre.'),
  opacity: num('Layer opacity 0..1.', { minimum: 0, maximum: 1 }),
  visible: bool('Show / hide the layer.'),
  locked: bool('Lock the layer against accidental edits in the UI.'),
  blendMode: str('Layer blend mode: normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity, plus-lighter.'),
  flipX: bool('Mirror horizontally.'),
  flipY: bool('Mirror vertically.'),
  fill: paintSchema,
  color: { ...paintSchema, description: 'Alias of `fill` (handy for text colour).' },
  fills: paintArraySchema('fill'),
  stroke: { ...paintSchema, description: 'Stroke paint shorthand — same formats as `fill`. Combine with strokeWidth.' },
  strokes: paintArraySchema('stroke'),
  strokeWidth: num('Stroke thickness in px.', { minimum: 0 }),
  strokeAlign: oneOfStr(['inside', 'center', 'outside'], 'Stroke position relative to the outline.'),
  strokeCap: oneOfStr(['butt', 'round', 'square'], 'Line cap for open paths / lines.'),
  strokeJoin: oneOfStr(['miter', 'round', 'bevel'], 'Corner join style.'),
  dash: { type: 'array', items: { type: 'number' }, description: 'Dash pattern, e.g. [4, 4]. Empty array = solid.' },
  cornerRadius: {
    description: 'Corner radius in px for frames / rects (number), or per-corner [topLeft, topRight, bottomRight, bottomLeft]. Also rounds polygon / star corners.',
    anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }],
  },
  cornerSmoothing: num('iOS-style continuous corners, 0..1 (0.6 ≈ Apple squircle).', { minimum: 0, maximum: 1 }),
  shadow: shadowSchema,
  blur: num('Layer blur radius in px (0 removes).', { minimum: 0 }),
  backgroundBlur: num('Background blur radius in px for frosted-glass panels (use with a semi-transparent fill; 0 removes).', { minimum: 0 }),
  effects: {
    type: 'array',
    description:
      'Full effects list (replaces existing). Items: {type:"drop-shadow"|"inner-shadow", color, opacity, x, y, blur, spread} | {type:"glow", color, opacity, blur, spread} | ' +
      '{type:"layer-blur"|"background-blur", radius} | {type:"noise", amount, size, monochrome} | {type:"adjust", brightness, contrast, saturation, hue, grayscale, sepia, invert}. Missing fields get defaults.',
    items: { type: 'object' },
  },
  // text
  text: str('Text content (text nodes). Use \\n for line breaks.'),
  fontFamily: str('Font family, e.g. "Inter" (default), "JetBrains Mono", or any installed font.'),
  fontSize: num('Font size in px (default 24).', { minimum: 1 }),
  fontWeight: {
    description: 'Font weight 100..900, or a name: thin, extralight, light, regular, medium, semibold, bold, extrabold, black.',
    anyOf: [{ type: 'number' }, { type: 'string' }],
  },
  italic: bool('Italic text.'),
  lineHeight: num('Line height as a multiple of the font size (e.g. 1.4). Values > 4 are treated as px.'),
  letterSpacing: num('Letter spacing in px (negative tightens).'),
  paragraphSpacing: num('Extra space between paragraphs in px.'),
  textAlign: oneOfStr(['left', 'center', 'right', 'justify'], 'Horizontal text alignment.'),
  verticalAlign: oneOfStr(['top', 'middle', 'bottom'], 'Vertical alignment inside a fixed-height text box.'),
  textDecoration: oneOfStr(['none', 'underline', 'strikethrough'], 'Text decoration.'),
  textCase: oneOfStr(['none', 'upper', 'lower', 'title'], 'Text transform.'),
  autoResize: oneOfStr(
    ['width', 'height', 'none'],
    'Text box sizing: "width" = grows to fit on one line per paragraph (default), "height" = fixed width, wraps and grows vertically, "none" = fixed box.',
  ),
  // vector
  d: str('SVG path data for path nodes, in the node\'s local coordinates (e.g. an icon drawn in a 24×24 box). The node is fitted to the path bounds; x/y position the result. Give width/height to scale it.'),
  fillRule: oneOfStr(['nonzero', 'evenodd'], 'Fill rule for path nodes.'),
  startMarker: oneOfStr(['none', 'arrow', 'triangle', 'circle', 'square', 'diamond', 'bar'], 'Marker at the start of an open path / line.'),
  endMarker: oneOfStr(['none', 'arrow', 'triangle', 'circle', 'square', 'diamond', 'bar'], 'Marker at the end of an open path / line (e.g. "arrow").'),
  x1: num('Line start x (type "line"), parent coordinates.'),
  y1: num('Line start y (type "line").'),
  x2: num('Line end x (type "line").'),
  y2: num('Line end y (type "line").'),
  // shapes
  sides: { type: 'integer', minimum: 3, description: 'Polygon side count (default 3).' },
  points: { type: 'integer', minimum: 3, description: 'Star point count (default 5).' },
  innerRadius: num('Star: inner radius ratio 0..1 (default 0.382). Ellipse: donut hole ratio 0..1.', { minimum: 0, maximum: 1 }),
  arcStart: num('Ellipse arc start angle in degrees (0 = 3 o\'clock).'),
  arcSweep: num('Ellipse arc sweep in degrees (360 = full ellipse) — for pie / progress shapes.'),
  // image
  image: str('Image source → image fill: https URL, data: URL or absolute local file path (png, jpg, webp, gif, svg). For type "image" the natural size is used when width/height are omitted.'),
  imageFit: oneOfStr(['fill', 'fit', 'crop', 'tile', 'stretch'], 'How the image fills the box (default "fill" = cover).'),
  // containers
  op: oneOfStr(['union', 'subtract', 'intersect', 'exclude'], 'Boolean operation (type "boolean"). subtract = bottom child minus the others.'),
  clipContent: bool('Frames: clip children to the frame bounds (default true).'),
  autoLayout: autoLayoutSchema,
  sizingH: oneOfStr(
    ['fixed', 'hug', 'fill'],
    'Horizontal sizing: "hug" = auto-layout frame / text shrinks to content, "fill" = stretch to fill the parent auto-layout frame, "fixed" = keep width.',
  ),
  sizingV: oneOfStr(['fixed', 'hug', 'fill'], 'Vertical sizing (see sizingH).'),
  layoutPositioning: oneOfStr(['auto', 'absolute'], '"absolute" lets a child of an auto-layout frame keep its own x/y (badges, overlays).'),
  constraints: {
    type: 'object',
    description: 'Resizing constraints inside a (non auto-layout) frame: {h:"left"|"right"|"center"|"scale"|"stretch", v:"top"|"bottom"|"center"|"scale"|"stretch"}.',
    properties: {
      h: { type: 'string', enum: ['left', 'right', 'center', 'scale', 'stretch'] },
      v: { type: 'string', enum: ['top', 'bottom', 'center', 'scale', 'stretch'] },
    },
  },
  isComponent: bool('Mark a frame as a reusable component.'),
  isMask: bool('Use this layer as a mask for the siblings above it.'),
  meta: { type: 'object', description: 'Free-form JSON metadata stored on the node (for your own bookkeeping).' },
};

const NODE_TYPES = ['frame', 'rect', 'ellipse', 'text', 'path', 'line', 'image', 'polygon', 'star', 'group', 'boolean'] as const;

const nodeSpecSchema: JsonSchema = {
  type: 'object',
  properties: {
    type: oneOfStr(NODE_TYPES, 'Node type.'),
    ...nodeProps,
    children: {
      type: 'array',
      description: 'Child node specs (same shape as this object, nested to any depth). Allowed for frame, group and boolean.',
      items: { type: 'object', additionalProperties: true },
    },
  },
  required: ['type'],
  additionalProperties: true,
};

const CREATE_EXAMPLE = JSON.stringify({
  nodes: [
    {
      type: 'frame',
      name: 'Card',
      x: 80,
      y: 80,
      width: 360,
      fill: '#FFFFFF',
      cornerRadius: 20,
      shadow: { y: 12, blur: 32, color: '#0F172A1F' },
      autoLayout: { mode: 'vertical', gap: 12, padding: 24 },
      children: [
        { type: 'text', name: 'Title', text: 'Weekly report', fontSize: 22, fontWeight: 'semibold', fill: '#0F172A' },
        { type: 'text', name: 'Body', text: 'Revenue grew 12% week over week.', fontSize: 15, lineHeight: 1.5, fill: '#475569', sizingH: 'fill', autoResize: 'height' },
        {
          type: 'frame',
          name: 'Button',
          fill: '#4F46E5',
          cornerRadius: 10,
          autoLayout: { mode: 'horizontal', padding: [10, 16], align: 'center' },
          children: [{ type: 'text', text: 'Open', fontSize: 15, fontWeight: 600, fill: '#FFFFFF' }],
        },
      ],
    },
  ],
});

/* ----------------------------------------------------------------- tools */

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'get_document',
    title: 'Get document overview',
    description:
      'Overview of the document open in Alt: name, file path, unsaved state, pages (id, name, top-level node count), the current page, ' +
      'the current selection, shared styles (colour, text and effect styles) and a summary of the current page\'s top-level nodes with their bounds. ' +
      'Call this first to orient yourself and to find free canvas space for new frames.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_tree',
    title: 'Get layer tree',
    description:
      'Compact layer tree of a page (default: current page) or of a node\'s subtree. Each entry has id, type, name, x, y, w, h (parent-relative, rounded), ' +
      'plus when relevant: r (rotation), hidden, locked, text (first 80 chars), fill (first solid colour), layout (auto-layout summary), children. ' +
      'Beyond `depth`, containers show childCount instead of children — call again with nodeId to drill in.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: str('Root node id. Omit for a whole page.'),
        pageId: str('Page id (default: current page). Ignored when nodeId is given.'),
        depth: { type: 'integer', minimum: 1, maximum: 50, description: 'Levels to expand (default 4).' },
        includeHidden: bool('Include hidden layers (default true).'),
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_nodes',
    title: 'Get node details',
    description:
      'Full JSON of specific nodes — every property (fills, strokes, effects, text style, auto layout, constraints…) plus absoluteBounds (page coordinates). ' +
      'Large data is elided: image bytes become asset metadata and vector point lists become an SVG `d` string.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Node ids to fetch (max 200).'),
        includeChildren: bool('Also return all descendants of the given nodes (default false).'),
      },
      required: ['ids'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'find_nodes',
    title: 'Find nodes',
    description:
      'Search layers by name (case-insensitive substring, or a regular expression with regex:true), by type and/or by text content. ' +
      'Searches the current page unless pageId or allPages is given; withinId restricts the search to a subtree. Returns id, type, name, page, parent and absolute bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Name to match (substring, case-insensitive).'),
        regex: bool('Treat `name` (and `text`) as a JavaScript regular expression (case-insensitive).'),
        type: {
          description: 'Node type or list of types (frame, group, boolean, rect, ellipse, polygon, star, path, text, brush, bitmap).',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        text: str('Match text nodes whose content contains this (case-insensitive).'),
        pageId: str('Page to search (default: current page).'),
        allPages: bool('Search every page.'),
        withinId: str('Only search inside this node.'),
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max results (default 100).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_selection',
    title: 'Get selection',
    description: 'The layers the user currently has selected in Alt (summary + absolute bounds). Use when the user says "this", "the selected …", "these".',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'set_selection',
    title: 'Set selection',
    description: 'Select layers in the editor (switches to their page when needed). An empty list clears the selection. Optionally zoom the viewport to them.',
    inputSchema: {
      type: 'object',
      properties: { ids: ids('Ids to select (all on the same page).'), zoom: bool('Also zoom the viewport to the selection.') },
      required: ['ids'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_nodes',
    title: 'Create nodes',
    description:
      'Create layers — each spec may nest `children` to build a whole screen or component in ONE call (one undo step). Returns the created ids in the same tree shape as the input.\n\n' +
      'Placement: `parentId` = page or container (frame/group) to insert into (default: current page); `index` = z-position among its children (default: on top). ' +
      'Coordinates are relative to the parent; inside auto-layout frames x/y are ignored.\n\n' +
      'Types: frame (screens, cards, buttons, rows, any container; white fill by default — fill:"none" for transparent; supports autoLayout & clipContent), ' +
      'rect, ellipse (arcStart/arcSweep/innerRadius), polygon (sides), star (points, innerRadius), line (x1,y1,x2,y2 + stroke, endMarker:"arrow" for arrows), ' +
      'path (SVG `d`), text (auto-sizes; set width + autoResize:"height" to wrap), image (rect with an image fill; `image` = URL / data URL / local path), ' +
      'group and boolean (wrap their children; boolean uses `op`).\n\n' +
      'Example: ' +
      CREATE_EXAMPLE,
    inputSchema: {
      type: 'object',
      properties: {
        nodes: { type: 'array', description: 'Node specs to create (top level, in back-to-front order).', items: nodeSpecSchema },
        parentId: str('Page id or container node id to insert into (default: current page).'),
        index: { type: 'integer', minimum: 0, description: 'Insert position among the parent\'s children (0 = bottom). Default: on top.' },
        select: bool('Select the created top-level nodes (default true).'),
      },
      required: ['nodes'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_nodes',
    title: 'Update nodes',
    description:
      'Change properties of existing layers (partial update, one undo step). Accepts the same props as create_nodes specs (fill, stroke, cornerRadius, shadow, text props, autoLayout, d, image, sizing…) except type/children. ' +
      'Use `updates: [{id, ...props}]` for per-node changes, or `ids` + `props` to apply the same change to many layers. ' +
      'fill / stroke / shadow / blur replace the existing paints or effects of that kind; fills / strokes / effects replace the whole list. To re-parent, use move_nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'Per-node updates: [{id, ...props}].',
          items: { type: 'object', properties: { id: str('Node id.'), ...nodeProps }, required: ['id'], additionalProperties: true },
        },
        ids: ids('Apply `props` to all of these nodes.'),
        props: { type: 'object', description: 'Props applied to every node in `ids`.', properties: nodeProps, additionalProperties: true },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_nodes',
    title: 'Delete nodes',
    description: 'Delete layers (and their children). Undoable.',
    inputSchema: { type: 'object', properties: { ids: ids('Node ids to delete.') }, required: ['ids'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'move_nodes',
    title: 'Move / reparent / reorder nodes',
    description:
      'Re-parent and/or re-stack layers. With parentId: moves the nodes into that page or container keeping their on-screen position — or, when x/y are given, placing them at x/y relative to the new parent; ' +
      '`index` sets the z-position among the new siblings (0 = bottom). Without parentId: `order` ("front" | "back" | "forward" | "backward") changes stacking among the current siblings. ' +
      'Moving into an auto-layout frame makes the layout position them (index = order in the flow).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Nodes to move.'),
        parentId: str('Destination page id or container (frame / group) id.'),
        index: { type: 'integer', minimum: 0, description: 'Position among the destination\'s children (0 = bottom / first in an auto-layout flow).' },
        x: num('New x relative to the destination parent (optional).'),
        y: num('New y relative to the destination parent (optional).'),
        order: oneOfStr(['front', 'back', 'forward', 'backward'], 'Re-stack within the current parent.'),
      },
      required: ['ids'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'duplicate_nodes',
    title: 'Duplicate nodes',
    description:
      'Duplicate layers (with their children). `count` copies are made, the n-th one shifted by n × offset — e.g. count:3, offset:{x:340, y:0} lays out a row of cards. ' +
      'Copies of children of auto-layout frames are placed by the layout. Returns the new ids per copy.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Nodes to duplicate.'),
        count: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of copies (default 1).' },
        offset: { type: 'object', description: 'Shift per copy in page px (default {x:0, y:0}).', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
      required: ['ids'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'group_nodes',
    title: 'Group nodes',
    description:
      'Wrap layers in a new container: kind "group" (default; hugs its children), "frame" (a transparent frame around them) or "boolean" ' +
      '(combine shapes with op union | subtract | intersect | exclude — subtract removes the upper shapes from the bottom one). Returns the new container id.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Layers to wrap (they are moved into the new container, keeping their on-screen positions).'),
        kind: oneOfStr(['group', 'frame', 'boolean'], 'Container kind (default "group").'),
        op: oneOfStr(['union', 'subtract', 'intersect', 'exclude'], 'Boolean operation when kind is "boolean" (default "union").'),
        name: str('Name for the new container.'),
      },
      required: ['ids'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ungroup_nodes',
    title: 'Ungroup nodes',
    description: 'Dissolve groups / frames / booleans, moving their children into the parent at the same on-screen position. Returns the freed child ids.',
    inputSchema: { type: 'object', properties: { ids: ids('Container ids to dissolve.') }, required: ['ids'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'align_nodes',
    title: 'Align nodes',
    description: 'Align layers to each other (their combined bounds) — or a single layer within its parent frame.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Layers to align.'),
        align: oneOfStr(['left', 'center', 'right', 'top', 'middle', 'bottom'], 'Edge or centre to align to ("center" = horizontal centres, "middle" = vertical centres).'),
      },
      required: ['ids', 'align'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'distribute_nodes',
    title: 'Distribute nodes',
    description:
      'Space layers along an axis. Without spacing: equal gaps between the outermost layers (≥ 3 layers). With spacing: place the layers exactly `spacing` px apart in their current order, starting from the first one (≥ 2 layers).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Layers to distribute.'),
        axis: oneOfStr(['horizontal', 'vertical'], 'Axis to distribute along.'),
        spacing: num('Exact gap in px between consecutive layers.'),
      },
      required: ['ids', 'axis'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_auto_layout',
    title: 'Set auto layout',
    description:
      'Add, change or remove auto layout (flexbox-like stacking). With a single frame id it configures that frame; with other / several layers they are first wrapped in a new transparent auto-layout frame. ' +
      'mode "none" removes auto layout. Returns the frame id.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('A frame id, or layers to wrap in a new auto-layout frame.'),
        mode: oneOfStr(['horizontal', 'vertical', 'none'], 'Stack direction, or "none" to remove (default: inferred from the layers\' arrangement).'),
        gap: num('Space between children in px.'),
        padding: {
          description: 'Inner padding: number | [vertical, horizontal] | [top, right, bottom, left] | {top,right,bottom,left}.',
          anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }, { type: 'object' }],
        },
        align: oneOfStr(['start', 'center', 'end', 'stretch'], 'Cross-axis alignment of children.'),
        justify: oneOfStr(['start', 'center', 'end', 'space-between'], 'Main-axis distribution of children.'),
        wrap: bool('Wrap children onto new rows (horizontal, fixed-width frames).'),
        sizingH: oneOfStr(['fixed', 'hug', 'fill'], 'Frame width behaviour.'),
        sizingV: oneOfStr(['fixed', 'hug', 'fill'], 'Frame height behaviour.'),
      },
      required: ['ids'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'import_svg',
    title: 'Import SVG',
    description:
      'Import SVG markup as editable vector layers (paths, shapes, text, gradients) — ideal for icons, logos and illustrations. ' +
      'Optionally position (x/y relative to the parent) and scale (width and/or height; aspect ratio kept when only one is given).',
    inputSchema: {
      type: 'object',
      properties: {
        svg: str('Complete SVG markup (<svg …>…</svg>).'),
        parentId: str('Page or container to insert into (default: current page).'),
        x: num('Left position relative to the parent.'),
        y: num('Top position relative to the parent.'),
        width: num('Scale the imported artwork to this width.'),
        height: num('Scale the imported artwork to this height.'),
        name: str('Name for the imported layer.'),
      },
      required: ['svg'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_exporters',
    title: 'List exporters',
    description: 'All export formats Alt supports (image, vector, web/native code, game engines, data) with their ids, extensions, whether output is text, and their options.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'export',
    title: 'Export / generate code',
    description:
      'Export layers (or a whole page) with one of Alt\'s exporters — see list_exporters. Text formats (SVG, HTML, React, Tailwind, SwiftUI, Flutter, Compose, Roblox, Godot, JSON, CSS, design tokens…) return the generated files as text; ' +
      'png / jpg / webp return images; other binary formats (e.g. PDF) return base64. Nothing is written to disk — save the returned content yourself if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        format: str('Exporter id from list_exporters (e.g. "react", "html", "svg", "png").'),
        ids: ids('Layers to export (default: the selection, or the whole page when nothing is selected).'),
        pageId: str('Export this whole page instead (ignored when ids are given).'),
        options: { type: 'object', description: 'Exporter options (keys from list_exporters), e.g. {"scale": 2}.' },
      },
      required: ['format'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'screenshot',
    title: 'Screenshot',
    description:
      'Render layers or a page to an image so you can SEE the result. Use it after each significant change to check layout, spacing, overlaps, text wrapping and contrast. ' +
      'Default target: the given ids, else the current page (target:"selection" for the user\'s selection). The image is scaled so its longest side is ≤ maxSize.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Layers to render (e.g. a top-level frame).'),
        target: oneOfStr(['page', 'selection'], 'What to render when ids are omitted (default "page").'),
        pageId: str('Page to render (default: current page).'),
        scale: num('Pixel scale (default: 2 for small targets, reduced automatically to respect maxSize).', { minimum: 0.01, maximum: 8 }),
        maxSize: { type: 'integer', minimum: 64, maximum: 4096, description: 'Max width/height of the image in px (default 1600).' },
        background: { description: 'Background colour, or null for transparent (default: the page background).', anyOf: [{ type: 'string' }, { type: 'null' }] },
        format: oneOfStr(['png', 'jpeg'], 'Image format (default png; large renders fall back to jpeg).'),
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'manage_pages',
    title: 'Manage pages',
    description:
      'List, create, rename, delete, duplicate or switch pages. create / duplicate switch to the new page by default, so later create_nodes calls without parentId land there. ' +
      '`background` (colour) can be set with create or rename.',
    inputSchema: {
      type: 'object',
      properties: {
        action: oneOfStr(['list', 'create', 'rename', 'delete', 'duplicate', 'switch'], 'What to do.'),
        pageId: str('Target page (rename / delete / duplicate / switch). Default: current page.'),
        name: str('Page name (create / rename).'),
        background: str('Canvas background colour for the page.'),
        switchTo: bool('Switch to the created / duplicated page (default true).'),
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'undo',
    title: 'Undo',
    description: 'Undo the last change(s) in Alt (yours or the user\'s).',
    inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of steps (default 1).' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Redo previously undone change(s).',
    inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of steps (default 1).' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'zoom_to',
    title: 'Zoom viewport',
    description: 'Move the user\'s viewport to show specific layers, the selection or everything on the page ("fit"). Only affects the view, not the document.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Layers to zoom to.'),
        target: oneOfStr(['fit', 'selection'], 'Used when ids are omitted: "fit" = all content on the page (default), "selection" = the selection.'),
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run_script',
    title: 'Run script',
    description:
      'Run JavaScript inside Alt for things the other tools cannot express: procedural / generative art, bulk edits, data-driven layouts. ' +
      'The code is the body of an async function — use await, `return` a JSON-serialisable value; console.log output is captured.\n' +
      'API (global `alt`): alt.doc (current document, read-only), alt.page, alt.pageId, alt.selection (ids), alt.getNode(id), alt.children(id), ' +
      'alt.find({name?, type?, text?}) → nodes (current page), await alt.create(specOrSpecs, parentId?) → created tree (same spec format as create_nodes), await alt.update(idOrIds, props), ' +
      'alt.remove(ids), alt.select(ids), alt.setPage(id), await alt.call(toolName, args) → result of any other MCP tool (parsed JSON), ' +
      'alt.mutate(draft => …) for low-level edits on the immer draft of the Doc (one undo step; alt.ops.* functions such as setProps, insertNode, moveNodes, groupNodes, alignNodes take the draft as first argument), ' +
      'alt.util (createNode, solid, gradient, uid, parseColor, worldBounds). Enabled only when "Allow scripts" is on in Alt Settings → MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        code: str('JavaScript function body.'),
        timeoutMs: { type: 'integer', minimum: 100, maximum: 110000, description: 'Max run time for async work (default 30000).' },
      },
      required: ['code'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

/** Tool list as exposed to clients for the given settings. */
export function getMcpTools(opts: { allowScripts: boolean }): McpToolDef[] {
  return MCP_TOOLS.filter((t) => opts.allowScripts || !(SCRIPT_TOOLS as readonly string[]).includes(t.name));
}

export function isScriptTool(name: string): boolean {
  return (SCRIPT_TOOLS as readonly string[]).includes(name);
}

/** Names of the tool arguments that may carry image sources (resolved to data URLs by the desktop shell). */
export const IMAGE_SOURCE_TOOLS = ['create_nodes', 'update_nodes'] as const;

export const MCP_INSTRUCTIONS = `Alt is a vector design app (Figma-like). These tools read and edit the document that is open in the Alt desktop app, live: the user sees every change, and every edit is a normal undoable step that selects what it touched.

DOCUMENT MODEL
- A document has pages; each page holds a tree of layers (nodes). Containers: frame (screens, artboards, cards, buttons — clips content, can use auto layout), group (hugs its children), boolean (union/subtract/intersect/exclude of its children). Leaves: rect, ellipse, polygon, star, path (vector), text, brush, bitmap.
- x / y are relative to the parent (page or container) and are the top-left corner of the layer's UNROTATED box; width / height are the box size; rotation is in degrees, clockwise, around the box centre. Page coordinates are unbounded (y grows downwards).
- Children are ordered back-to-front: the last child is drawn on top.
- Colours are hex strings (#RRGGBB, #RRGGBBAA for alpha); inputs also accept rgb()/hsl()/CSS names. Opacity is 0..1. Sizes are px.
- In an auto-layout frame children are stacked automatically (x/y ignored). Control them with gap / padding / align / justify on the frame and sizingH / sizingV ("fixed" | "hug" | "fill") on frame and children — "fill" stretches a child across the parent, "hug" shrinks a frame to its content.

RECOMMENDED WORKFLOW
1. get_document — pages, current page, selection, existing top-level frames (place new work in empty space, ~100 px apart).
2. One top-level frame per screen / artboard (e.g. 1440×1024 desktop, 390×844 mobile, 1080×1080 social post).
3. Build each screen with ONE create_nodes call using nested children. Prefer auto-layout frames for stacks, rows, buttons, lists and cards; use absolute x/y for free-form art.
4. screenshot the frame and look at it critically (spacing, alignment, overflow, text wrapping, contrast, hierarchy).
5. Fix with update_nodes / move_nodes / delete_nodes, then screenshot again. Iterate until it looks polished.

TIPS
- Text auto-sizes to its content. For paragraphs give a width (or sizingH:"fill" inside auto layout) and autoResize:"height" so lines wrap.
- Frames get a white fill by default; pass fill:"none" for invisible layout wrappers.
- Polish: cornerRadius, cornerSmoothing, shadow ({y, blur, color:"#0000001F"}), gradients ({type:"linear", angle:135, colors:["#6366F1","#EC4899"]}), strokes, backgroundBlur for glass.
- Icons: path nodes with SVG d data drawn in a 24×24 box (set width/height to scale) with stroke + strokeWidth + fill:"none", or import_svg for full SVG markup.
- Images: an image node / image fill from a URL, data URL or absolute local path.
- Give layers meaningful names — they appear in the layers panel and become component / class names in code export.
- export converts designs to code (HTML, React, Tailwind, SwiftUI, Flutter, Compose, Roblox, Godot…) — list_exporters shows what is available.
- Batch: prefer a few large calls over many tiny ones. Ids are strings returned by the tools — never invent them. Re-read with get_tree / get_nodes when unsure.
- If something looks wrong, undo is available, and the user can always undo your changes too.`;
