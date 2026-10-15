/**
 * React exporters built on the HTML web tree:
 *  - "React" – a TSX component with a typed `styles` object (inline styles)
 *  - "React + Tailwind" – the same component using Tailwind utility classes
 *    with arbitrary values (`w-[120px]`, `bg-[#ff0000]`, …)
 */
import type { Doc, ID } from '../core/types';
import type { ExportContext, ExportFile, Exporter, ExportOption } from './types';
import { ASSET_TOKEN, flattenWeb, WebBuilder, type Decl, type WebNode } from './html';
import { CodeWriter, FileNamer, jsString, MIME, NameRegistry, resolveRoots, serializeJsx } from './util';

const REACT_RESERVED = [
  'React',
  'Fragment',
  'Component',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'Map',
  'Set',
  'Promise',
  'Error',
  'Image',
  'Text',
  'Element',
  'Node',
  'Document',
  'Window',
  'Event',
  'Function',
  'JSON',
  'Math',
  'Date',
];

const hasAsset = (s: string) => s.includes('{{asset:');
const assetIdOf = (s: string) => /\{\{asset:([^}]+)\}\}/.exec(s)?.[1];

const UNITLESS = new Set(['opacity', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'zIndex', 'order']);

const camelProp = (prop: string) => prop.replace(/^-(webkit|moz|ms)-/, (_, v: string) => v.charAt(0).toUpperCase() + v.slice(1) + '-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** JSX text child: plain when safe, an expression otherwise. */
function jsxText(text: string): string {
  if (!text) return '';
  if (/[{}<>&\n\r]|^\s|\s$|\s{2}/.test(text)) return `{${jsString(text)}}`;
  return text;
}

interface AssetRefs {
  /** asset id → JS identifier */
  names: Map<ID, string>;
  idents: NameRegistry;
}

function assetIdent(refs: AssetRefs, b: WebBuilder, id: ID): string {
  let name = refs.names.get(id);
  if (!name) {
    const file = b.assets.get(id) ?? 'image';
    name = refs.idents.get(`${file.replace(/\.[a-z0-9]+$/i, '')} image`, 'image');
    refs.names.set(id, name);
  }
  return name;
}

/** JS expression for a CSS value (template literal when it references assets). */
function jsValue(prop: string, value: string, refs: AssetRefs, b: WebBuilder): string {
  if (hasAsset(value)) {
    const body = value.replace(/[`\\]/g, (c) => `\\${c}`).replace(ASSET_TOKEN, (_, id: string) => `\${${assetIdent(refs, b, id)}}`);
    return `\`${body}\``;
  }
  const key = camelProp(prop);
  const px = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  if (px && key !== 'lineHeight') return px[1];
  if (value === '0') return '0';
  if (UNITLESS.has(key) && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return jsString(value);
}

function header(rootName: string): string[] {
  return [`/**`, ` * ${rootName} — exported from Alt.`, ` */`];
}

function imageDecls(refs: AssetRefs, b: WebBuilder, mode: 'inline' | 'files'): { imports: string[]; consts: string[] } {
  const imports: string[] = [];
  const consts: string[] = [];
  for (const [id, ident] of refs.names) {
    if (mode === 'files') imports.push(`import ${ident} from './${b.opts.assetDir}/${b.assets.get(id)}';`);
    else consts.push(`const ${ident} = ${jsString(b.doc.assets[id]?.data ?? '')};`);
  }
  return { imports, consts };
}

/* ---------------------------------------------------------- inline styles */

function renderInline(w: WebNode, keys: Map<WebNode, string>, refs: AssetRefs, b: WebBuilder, out: CodeWriter) {
  const style = `style={styles.${keys.get(w)}}`;
  switch (w.kind) {
    case 'text':
      out.line(`<p ${style}>${jsxText(w.text ?? '')}</p>`);
      return;
    case 'img': {
      const id = w.src && assetIdOf(w.src);
      const src = id ? `{${assetIdent(refs, b, id)}}` : '""';
      out.line(`<img ${style} src=${src} alt=${JSON.stringify(w.alt ?? '')} />`);
      return;
    }
    case 'svg':
      out.lines_(serializeJsx(w.svg!, '  ').replace(/^<svg/, `<svg ${style}`));
      return;
    default:
      if (!w.children.length) {
        out.line(`<div ${style} />`);
        return;
      }
      out.line(`<div ${style}>`);
      out.indent(() => w.children.forEach((c) => renderInline(c, keys, refs, b, out)));
      out.line('</div>');
  }
}

export interface ReactBuild {
  code: string;
  /** image files to write next to the component (assets: 'files') */
  files: ExportFile[];
}

export function buildReactInline(doc: Doc, rootId: ID, opts: { assets: 'inline' | 'files'; componentName: string }): ReactBuild | null {
  const b = new WebBuilder(doc, { assets: opts.assets, assetDir: 'assets' });
  const tree = b.build(rootId);
  if (!tree) return null;
  const keyNames = new NameRegistry('camel', ['styles']);
  const keys = new Map<WebNode, string>();
  const all = flattenWeb(tree);
  for (const w of all) keys.set(w, keyNames.get(w.className));
  const refs: AssetRefs = { names: new Map(), idents: new NameRegistry('camel', ['styles', opts.componentName]) };

  const body = new CodeWriter();
  body.block(`export default function ${opts.componentName}() {`, () => {
    body.line('return (');
    body.indent(() => renderInline(tree, keys, refs, b, body));
    body.line(');');
  });

  const styles = new CodeWriter();
  styles.block(
    'const styles = {',
    () => {
      for (const w of all) {
        styles.block(
          `${keys.get(w)}: {`,
          () => {
            for (const [k, v] of w.css) {
              if (k === '/*') styles.line(`// ${v}`);
              else styles.line(`${camelProp(k)}: ${jsValue(k, v, refs, b)},`);
            }
          },
          '},',
        );
      }
    },
    '} satisfies Record<string, CSSProperties>;',
  );

  const { imports, consts } = imageDecls(refs, b, opts.assets);
  const out = new CodeWriter();
  header(doc.nodes[rootId].name).forEach((l) => out.line(l));
  out.line("import type { CSSProperties } from 'react';");
  imports.forEach((l) => out.line(l));
  out.blank();
  out.lines_(body.toString().trimEnd());
  out.blank();
  if (consts.length) {
    consts.forEach((l) => out.line(l));
    out.blank();
  }
  out.lines_(styles.toString().trimEnd());
  return { code: out.toString(), files: opts.assets === 'files' ? b.assetFilesOut() : [] };
}

/* --------------------------------------------------------------- tailwind */

const arb = (v: string) => v.replace(/"/g, "'").replace(/_/g, '\\_').replace(/,\s+/g, ',').replace(/\s+/g, '_');
const tw = (prefix: string, v: string) => `${prefix}-[${arb(v)}]`;

const WEIGHTS: Record<string, string> = {
  '100': 'font-thin',
  '200': 'font-extralight',
  '300': 'font-light',
  '400': 'font-normal',
  '500': 'font-medium',
  '600': 'font-semibold',
  '700': 'font-bold',
  '800': 'font-extrabold',
  '900': 'font-black',
};

const FLEX_ALIGN: Record<string, string> = { 'flex-start': 'start', center: 'center', 'flex-end': 'end', stretch: 'stretch', 'space-between': 'between' };

/** Convert one CSS declaration into Tailwind classes (null = keep as inline style). */
export function tailwindClasses(prop: string, value: string): string[] | null {
  const v = value.trim();
  const parts = v.split(/\s+/);
  switch (prop) {
    case 'position':
      return [v];
    case 'left':
    case 'top':
    case 'right':
    case 'bottom':
      return [v === '0' ? `${prop}-0` : tw(prop, v)];
    case 'inset':
      return [v === '0' ? 'inset-0' : tw('inset', v)];
    case 'width':
      return [v === '100%' ? 'w-full' : v === 'fit-content' ? 'w-fit' : tw('w', v)];
    case 'height':
      return [v === '100%' ? 'h-full' : v === 'fit-content' ? 'h-fit' : tw('h', v)];
    case 'min-width':
      return [v === '0' ? 'min-w-0' : tw('min-w', v)];
    case 'min-height':
      return [v === '0' ? 'min-h-0' : tw('min-h', v)];
    case 'flex':
      return [v === '1 1 0' ? 'flex-1' : v === 'none' ? 'flex-none' : tw('flex', v)];
    case 'flex-shrink':
      return [v === '0' ? 'shrink-0' : tw('shrink', v)];
    case 'display':
      return [v === 'none' ? 'hidden' : v];
    case 'flex-direction':
      return [v === 'column' ? 'flex-col' : 'flex-row'];
    case 'flex-wrap':
      return [v === 'wrap' ? 'flex-wrap' : 'flex-nowrap'];
    case 'align-content':
      return [`content-${FLEX_ALIGN[v] ?? 'start'}`];
    case 'justify-content':
      return [`justify-${FLEX_ALIGN[v] ?? 'start'}`];
    case 'align-items':
      return [`items-${FLEX_ALIGN[v] ?? 'start'}`];
    case 'align-self':
      return [`self-${FLEX_ALIGN[v] ?? 'auto'}`];
    case 'gap':
      return [tw('gap', v)];
    case 'row-gap':
      return [tw('gap-y', v)];
    case 'padding': {
      const [t, r = t, b = t, l = r] = parts;
      if (t === r && r === b && b === l) return [tw('p', t)];
      if (t === b && r === l) return [tw('py', t), tw('px', r)];
      if (r === l) return [tw('pt', t), tw('px', r), tw('pb', b)];
      return [tw('pt', t), tw('pr', r), tw('pb', b), tw('pl', l)];
    }
    case 'margin':
      return [v === '0' ? 'm-0' : tw('m', v)];
    case 'background-color':
      return [tw('bg', v)];
    case 'background':
      return v.includes('url(') ? null : [`[background:${arb(v)}]`];
    case 'border-radius': {
      if (v === '50%') return ['rounded-full'];
      if (parts.length === 1) return [tw('rounded', v)];
      const [tl, tr, br, bl] = parts;
      return [tw('rounded-tl', tl), tw('rounded-tr', tr), tw('rounded-br', br), tw('rounded-bl', bl)];
    }
    case 'outline': {
      const [w, style, ...color] = parts;
      return [style === 'dashed' ? 'outline-dashed' : 'outline', tw('outline', w), tw('outline', color.join(' '))];
    }
    case 'outline-offset':
      return [tw('outline-offset', v)];
    case 'box-shadow':
      return [tw('shadow', v)];
    case 'opacity':
      return [tw('opacity', v)];
    case 'mix-blend-mode':
      return [`mix-blend-${v}`];
    case 'transform':
      return parts.map((t) => {
        const rot = /^rotate\((.+)\)$/.exec(t);
        if (rot) return tw('rotate', rot[1]);
        if (t === 'scaleX(-1)') return '-scale-x-100';
        if (t === 'scaleY(-1)') return '-scale-y-100';
        if (t === 'scale(-1)') return '-scale-100';
        return `[transform:${arb(t)}]`;
      });
    case 'filter': {
      const blur = /^blur\(([^)]+)\)$/.exec(v);
      return [blur ? tw('blur', blur[1]) : `[filter:${arb(v)}]`];
    }
    case 'backdrop-filter': {
      const blur = /^blur\(([^)]+)\)$/.exec(v);
      return [blur ? tw('backdrop-blur', blur[1]) : `[backdrop-filter:${arb(v)}]`];
    }
    case '-webkit-backdrop-filter':
    case '-webkit-background-clip':
      return [];
    case 'overflow':
      return [`overflow-${v}`];
    case 'font-family':
      return [tw('font', v)];
    case 'font-size':
      return [tw('text', v)];
    case 'font-weight':
      return [WEIGHTS[v] ?? tw('font', v)];
    case 'font-style':
      return [v === 'italic' ? 'italic' : 'not-italic'];
    case 'line-height':
      return [tw('leading', v)];
    case 'letter-spacing':
      return [tw('tracking', v)];
    case 'text-align':
      return [`text-${v}`];
    case 'text-decoration':
      return [v === 'underline' ? 'underline' : 'line-through'];
    case 'text-transform':
      return [v];
    case 'white-space':
      return [`whitespace-${v}`];
    case 'color':
      return [v === 'transparent' ? 'text-transparent' : tw('text', v)];
    case 'background-clip':
      return [v === 'text' ? 'bg-clip-text' : `bg-clip-${v}`];
    default:
      return [`[${prop}:${arb(v)}]`];
  }
}

function classesFor(w: WebNode): { classes: string[]; style: Decl[] } {
  const classes: string[] = [];
  const style: Decl[] = [];
  for (const [k, v] of w.css) {
    if (k === '/*') continue;
    const c = tailwindClasses(k, v);
    if (c) classes.push(...c);
    else style.push([k, v]);
  }
  return { classes: [...new Set(classes)], style };
}

function renderTailwind(w: WebNode, refs: AssetRefs, b: WebBuilder, out: CodeWriter) {
  const { classes, style } = classesFor(w);
  const attrs: string[] = [];
  if (classes.length) attrs.push(`className="${classes.join(' ')}"`);
  if (style.length) attrs.push(`style={{ ${style.map(([k, v]) => `${camelProp(k)}: ${jsValue(k, v, refs, b)}`).join(', ')} }}`);
  const a = attrs.length ? ' ' + attrs.join(' ') : '';
  switch (w.kind) {
    case 'text':
      out.line(`<p${a}>${jsxText(w.text ?? '')}</p>`);
      return;
    case 'img': {
      const id = w.src && assetIdOf(w.src);
      const src = id ? `{${assetIdent(refs, b, id)}}` : '""';
      out.line(`<img${a} src=${src} alt=${JSON.stringify(w.alt ?? '')} />`);
      return;
    }
    case 'svg':
      out.lines_(serializeJsx(w.svg!, '  ').replace(/^<svg/, `<svg${a}`));
      return;
    default:
      if (!w.children.length) {
        out.line(`<div${a} />`);
        return;
      }
      out.line(`<div${a}>`);
      out.indent(() => w.children.forEach((c) => renderTailwind(c, refs, b, out)));
      out.line('</div>');
  }
}

export function buildReactTailwind(doc: Doc, rootId: ID, opts: { assets: 'inline' | 'files'; componentName: string }): ReactBuild | null {
  const b = new WebBuilder(doc, { assets: opts.assets, assetDir: 'assets' });
  const tree = b.build(rootId);
  if (!tree) return null;
  const refs: AssetRefs = { names: new Map(), idents: new NameRegistry('camel', [opts.componentName]) };
  const body = new CodeWriter();
  body.block(`export default function ${opts.componentName}() {`, () => {
    body.line('return (');
    body.indent(() => renderTailwind(tree, refs, b, body));
    body.line(');');
  });
  const { imports, consts } = imageDecls(refs, b, opts.assets);
  const out = new CodeWriter();
  header(doc.nodes[rootId].name).forEach((l) => out.line(l));
  if (imports.length) {
    imports.forEach((l) => out.line(l));
    out.blank();
  }
  out.lines_(body.toString().trimEnd());
  if (consts.length) {
    out.blank();
    consts.forEach((l) => out.line(l));
  }
  return { code: out.toString(), files: opts.assets === 'files' ? b.assetFilesOut() : [] };
}

/* -------------------------------------------------------------- exporters */

const assetOption: ExportOption = {
  key: 'assets',
  label: 'Images',
  type: 'select',
  default: 'inline',
  options: [
    { value: 'inline', label: 'Embed (data URLs)' },
    { value: 'files', label: 'Import from ./assets' },
  ],
};

function makeReactExporter(id: string, label: string, description: string, build: typeof buildReactTailwind): Exporter {
  return {
    id,
    label,
    group: 'Web',
    extension: 'tsx',
    description,
    textual: true,
    options: [assetOption],
    async run(ctx: ExportContext): Promise<ExportFile[]> {
      const roots = resolveRoots(ctx.doc, ctx.pageId, ctx.ids);
      const assets = ctx.options.assets === 'files' ? 'files' : 'inline';
      const names = new NameRegistry('pascal', REACT_RESERVED, { prefixDigits: 'Layer' });
      const files = new FileNamer();
      const out: ExportFile[] = [];
      const assetFiles = new Map<string, ExportFile>();
      for (const id of roots) {
        const componentName = names.get(ctx.doc.nodes[id].name, 'Component');
        const built = build(ctx.doc, id, { assets, componentName });
        if (!built) continue;
        out.push({ name: files.get(componentName, 'tsx'), mime: MIME.tsx, data: built.code });
        for (const f of built.files) assetFiles.set(f.name, f);
      }
      return [...out, ...assetFiles.values()];
    },
  };
}

export const reactExporter = makeReactExporter('react', 'React', 'Typed TSX component with an inline `styles` object — no CSS setup needed.', buildReactInline);

export const tailwindExporter = makeReactExporter(
  'react-tailwind',
  'React + Tailwind',
  'TSX component styled with Tailwind utility classes and arbitrary values.',
  buildReactTailwind,
);
