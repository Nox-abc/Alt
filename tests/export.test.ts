import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, FrameNode, ID } from '../src/core/types';
import { createDoc, createNode, defaultEffect, gradient, solid } from '../src/core/doc';
import { insertNode, pasteNodes } from '../src/core/ops';
import { EXPORTERS, exportRoots, getExporter } from '../src/export';
import type { ExportFile, RasterOptions } from '../src/export/types';
import { buildSvg } from '../src/export/svg';
import { parseXml, importSvg, isSvgText } from '../src/import/svg';
import { base64ToBytes, bytesToBase64, cssLinear, imageSize, NameRegistry, sanitizeFileName } from '../src/export/util';
import { tailwindClasses } from '../src/export/react';

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface Fixture {
  doc: Doc;
  pageId: ID;
  frame: FrameNode;
  ids: Record<string, ID>;
}

/** A card: horizontal auto layout with a gradient + shadow rect, ellipse, text, path and bitmap. */
function fixture(): Fixture {
  const doc = createDoc('Test doc');
  const pageId = doc.pages[0].id;
  const frame = createNode('frame', {
    parentId: pageId,
    name: 'Product Card',
    width: 420,
    height: 120,
    cornerRadius: 16,
    sizingH: 'fixed',
    sizingV: 'hug',
    fills: [solid('#FFFFFF')],
    strokes: [solid('#E0E0E0')],
    strokeWidth: 1,
    layout: { mode: 'horizontal', gap: 12, padding: [16, 20, 16, 20], align: 'center', justify: 'start', wrap: false },
  });
  insertNode(doc, frame, pageId);
  const rect = createNode('rect', {
    parentId: frame.id,
    name: 'Hero',
    x: 20,
    y: 16,
    width: 120,
    height: 88,
    cornerRadius: 8,
    fills: [gradient('linear', '#FF5F6D', '#FFC371')],
    effects: [defaultEffect('drop-shadow')],
  });
  insertNode(doc, rect, frame.id);
  const ellipse = createNode('ellipse', { parentId: frame.id, name: 'Avatar', x: 152, y: 36, width: 48, height: 48, fills: [solid('#3366FF')] });
  insertNode(doc, ellipse, frame.id);
  const text = createNode('text', {
    parentId: frame.id,
    name: 'Title',
    x: 212,
    y: 44,
    width: 120,
    height: 30,
    text: 'Fresh <deals> & "more"',
    fontSize: 20,
    fontWeight: 700,
    autoResize: 'width',
  });
  insertNode(doc, text, frame.id);
  const path = createNode('path', {
    parentId: frame.id,
    name: 'Check icon',
    x: 344,
    y: 48,
    width: 24,
    height: 24,
    fills: [],
    strokes: [solid('#22AA55')],
    strokeWidth: 2,
    paths: [
      {
        closed: false,
        points: [
          { x: 2, y: 12, in: null, out: null },
          { x: 9, y: 20, in: null, out: null },
          { x: 22, y: 4, in: null, out: null },
        ],
      },
    ],
  });
  insertNode(doc, path, frame.id);
  doc.assets.px = { id: 'px', mime: 'image/png', data: PNG_1PX, name: 'pixel.png' };
  const bmp = createNode('bitmap', { parentId: frame.id, name: 'Sprite', x: 380, y: 52, width: 16, height: 16, assetId: 'px', pixelWidth: 1, pixelHeight: 1, smoothing: false });
  insertNode(doc, bmp, frame.id);
  return { doc, pageId, frame, ids: { rect: rect.id, ellipse: ellipse.id, text: text.id, path: path.id, bmp: bmp.id } };
}

const rasterCalls: { ids: ID[]; opts: RasterOptions }[] = [];
const rasterize = async (ids: ID[], opts: RasterOptions) => {
  rasterCalls.push({ ids, opts });
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
};

async function run(id: string, f: Fixture, options: Record<string, unknown> = {}, ids: ID[] = [f.frame.id]): Promise<ExportFile[]> {
  const ex = getExporter(id);
  if (!ex) throw new Error(`missing exporter ${id}`);
  return ex.run({ doc: f.doc, ids, pageId: f.pageId, options, rasterize });
}

const text = (f: ExportFile) => (typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data));

/** Checks that start / end tags balance (comments, CDATA, PIs and self-closing tags handled). */
function expectWellFormedXml(xml: string) {
  const stack: string[] = [];
  const body = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) expect(stack.pop()).toBe(name);
    else stack.push(name);
  }
  expect(stack).toEqual([]);
  // no stray unescaped ampersands
  expect(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(body)).toBe(false);
}

/** Balanced (), [] and {} outside of string literals. */
function expectBalanced(code: string) {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      i = code.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c in pairs) expect(stack.pop()).toBe(pairs[c]);
  }
  expect(stack).toEqual([]);
}

let f: Fixture;
beforeEach(() => {
  f = fixture();
  rasterCalls.length = 0;
});

describe('registry', () => {
  it('registers unique exporters with groups and extensions', () => {
    const ids = EXPORTERS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['png', 'jpg', 'webp', 'svg', 'pdf', 'html', 'react', 'react-tailwind', 'swiftui', 'flutter', 'compose', 'android-vector', 'roblox-rbxmx', 'roblox-lua', 'godot', 'unity-uitk', 'json', 'design-tokens', 'css-variables']) {
      expect(getExporter(id), id).toBeDefined();
    }
    for (const e of EXPORTERS) {
      expect(e.label).toBeTruthy();
      expect(e.extension).toMatch(/^[a-z]+$/);
    }
  });

  it('resolves export roots', () => {
    expect(exportRoots(f.doc, f.pageId, [])).toEqual([f.frame.id]);
    // nested selection collapses to the top-level node
    expect(exportRoots(f.doc, f.pageId, [f.ids.rect, f.frame.id])).toEqual([f.frame.id]);
    expect(exportRoots(f.doc, f.pageId, [f.ids.text, f.ids.rect])).toEqual([f.ids.rect, f.ids.text]);
    // hidden page children are skipped when exporting the whole page
    const hidden = createNode('rect', { parentId: f.pageId, visible: false });
    insertNode(f.doc, hidden, f.pageId);
    expect(exportRoots(f.doc, f.pageId, [])).toEqual([f.frame.id]);
  });
});

describe('raster / pdf', () => {
  it('rasterises each root with the requested scale', async () => {
    const files = await run('png', f, { scale: '2' });
    expect(files.map((x) => x.name)).toEqual(['Product Card@2x.png']);
    expect(rasterCalls[0].opts).toMatchObject({ scale: 2, format: 'png', background: null });
    const jpg = await run('jpg', f, { scale: 1 });
    expect(jpg[0].name).toBe('Product Card.jpg');
    expect(rasterCalls[1].opts.background).toBe('#ffffff');
  });

  it('exports the whole page when nothing is selected', async () => {
    const files = await run('webp', f, {}, []);
    expect(files).toHaveLength(1);
    expect(rasterCalls[0].ids).toEqual([]);
  });

  it('reports that PDF needs a browser', async () => {
    await expect(run('pdf', f)).rejects.toThrow(/browser/i);
  });
});

describe('svg', () => {
  it('produces a well-formed document with gradients, filters, text and paths', async () => {
    const [file] = await run('svg', f);
    const svg = text(file);
    expect(file.name).toBe('Product Card.svg');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('viewBox="0 0 420 120"');
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('<filter');
    expect(svg).toContain('feGaussianBlur');
    expect(svg).toContain('<circle');
    expect(svg).toContain('<text');
    expect(svg).toContain('Fresh &lt;deals&gt; &amp; "more"');
    expect(svg).toContain('image-rendering:pixelated');
    expect(svg).toContain('clip-path="url(#clip-');
    expect(svg).toContain('id="product-card"');
    expectWellFormedXml(svg);
  });

  it('supports inside / outside strokes, masks, conic and diamond gradients', () => {
    const r = f.doc.nodes[f.ids.rect];
    r.strokes = [solid('#000000')];
    r.strokeAlign = 'outside';
    r.strokeWidth = 3;
    r.fills = [gradient('angular', '#ff0000', '#0000ff'), gradient('diamond', '#00ff00', '#000000')];
    f.doc.nodes[f.ids.ellipse].isMask = true;
    const { svg } = buildSvg(f.doc, [f.frame.id]);
    expect(svg).toContain('<mask id="outside-');
    expect(svg).toContain('mask-type:alpha');
    expect(svg).toContain('<pattern id="angular-');
    expect(svg).toContain('<pattern id="diamond-');
    // the outside stroke grows the viewBox
    expect(svg).toMatch(/viewBox="0 0 420 120"/);
    expectWellFormedXml(svg);
  });

  it('combines several roots into one file on request', async () => {
    const other = createNode('rect', { parentId: f.pageId, x: 500, y: 0, width: 50, height: 50 });
    insertNode(f.doc, other, f.pageId);
    const separate = await run('svg', f, {}, [f.frame.id, other.id]);
    expect(separate).toHaveLength(2);
    const combined = await run('svg', f, { combine: true }, [f.frame.id, other.id]);
    expect(combined).toHaveLength(1);
    expect(text(combined[0])).toContain('viewBox="0 0 550 120"');
  });
});

describe('web', () => {
  it('HTML uses flexbox for auto layout and real text', async () => {
    const files = await run('html', f);
    const html = text(files[0]);
    expect(files[0].name).toBe('index.html');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('display: flex;');
    expect(html).toContain('gap: 12px;');
    expect(html).toContain('padding: 16px 20px;');
    expect(html).toContain('align-items: center;');
    expect(html).toContain('linear-gradient(');
    expect(html).toContain('box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25)');
    expect(html).toContain('border-radius: 50%');
    expect(html).toContain('<p class="title">Fresh &lt;deals&gt; &amp; "more"</p>');
    expect(html).toContain('<svg class="check-icon"');
    expect(html).toContain('<img class="sprite" src="data:image/png;base64,');
    expect(html).toContain('image-rendering: pixelated');
    expect(html).toContain('fonts.googleapis.com/css2?family=Inter:wght@700');
    expectWellFormedXml(html.replace(/<!doctype html>/, '').replace(/<(meta|link|img)\b([^>]*?)\s*\/?>/g, '<$1$2/>'));
  });

  it('HTML can write images and CSS as separate files', async () => {
    const files = await run('html', f, { assets: 'files', separateCss: true });
    expect(files.map((x) => x.name)).toEqual(['index.html', 'styles.css', 'assets/pixel.png']);
    expect(text(files[0])).toContain('src="assets/pixel.png"');
    expect(files[2].data).toBeInstanceOf(Uint8Array);
  });

  it('React exports a typed component with a styles object', async () => {
    const [file] = await run('react', f);
    const tsx = text(file);
    expect(file.name).toBe('ProductCard.tsx');
    expect(tsx).toContain("import type { CSSProperties } from 'react';");
    expect(tsx).toContain('export default function ProductCard() {');
    expect(tsx).toContain('<div style={styles.productCard}>');
    expect(tsx).toContain("display: 'flex',");
    expect(tsx).toContain('gap: 12,');
    expect(tsx).toContain(`{'Fresh <deals> & "more"'}`);
    expect(tsx).toContain('strokeWidth={2}');
    expect(tsx).toContain('} satisfies Record<string, CSSProperties>;');
    expect(tsx).toContain('src={pixelImage}');
    expect(tsx).toMatch(/const pixelImage = 'data:image\/png;base64,/);
    expectBalanced(tsx);
  });

  it('React + Tailwind uses utility classes with arbitrary values', async () => {
    const [file] = await run('react-tailwind', f);
    const tsx = text(file);
    expect(tsx).toContain('className="relative flex-none w-[420px] flex items-center gap-[12px] py-[16px] px-[20px] bg-[#ffffff]');
    expect(tsx).toContain('rounded-[16px]');
    expect(tsx).toContain('rounded-full');
    expect(tsx).toContain('shadow-[0_4px_12px_rgba(0,0,0,0.25)]');
    expect(tsx).toContain('font-bold');
    expectBalanced(tsx);
    expect(tailwindClasses('transform', 'rotate(15deg) scaleX(-1)')).toEqual(['rotate-[15deg]', '-scale-x-100']);
    expect(tailwindClasses('padding', '4px 8px 4px 8px')).toEqual(['py-[4px]', 'px-[8px]']);
  });
});

describe('native', () => {
  it('SwiftUI uses stacks, shapes and Path builders', async () => {
    const files = await run('swiftui', f);
    const swift = text(files[0]);
    expect(files[0].name).toBe('ProductCardView.swift');
    expect(swift).toContain('import SwiftUI');
    expect(swift).toContain('struct ProductCardView: View {');
    expect(swift).toContain('HStack(alignment: .center, spacing: 12) {');
    expect(swift).toContain('RoundedRectangle(cornerRadius: 8)');
    expect(swift).toContain('LinearGradient(stops:');
    expect(swift).toContain('.shadow(color:');
    expect(swift).toContain('Circle()');
    expect(swift).toContain('Text(verbatim: "Fresh <deals> & \\"more\\"")');
    expect(swift).toContain('private struct CheckIconShape: Shape {');
    expect(swift).toContain('.interpolation(.none)');
    expect(swift).toContain('#Preview {');
    expect(files.map((x) => x.name)).toContain('pixel.png');
    expectBalanced(swift);
  });

  it('Flutter builds Row / Container / CustomPainter widgets', async () => {
    const files = await run('flutter', f);
    const dart = text(files[0]);
    expect(files[0].name).toBe('ProductCard.dart');
    expect(dart).toContain("import 'package:flutter/material.dart';");
    expect(dart).toContain('class ProductCard extends StatelessWidget {');
    expect(dart).toContain('Row(');
    expect(dart).toContain('spacing: 12');
    expect(dart).toContain('BoxDecoration(');
    expect(dart).toContain('LinearGradient(');
    expect(dart).toContain('BoxShadow(');
    expect(dart).toContain("'Fresh <deals> & \"more\"'");
    expect(dart).toContain('extends CustomPainter');
    expect(dart).toContain("Image.asset(\n");
    expect(files.map((x) => x.name)).toContain('assets/pixel.png');
    expectBalanced(dart);
  });

  it('Compose emits Row, modifiers, Text and Canvas', async () => {
    const files = await run('compose', f, { package: 'com.acme.ui' });
    const kt = text(files[0]);
    expect(files[0].name).toBe('ProductCard.kt');
    expect(kt).toContain('package com.acme.ui');
    expect(kt).toContain('@Composable\nfun ProductCard(modifier: Modifier = Modifier) {');
    expect(kt).toContain('Row(');
    expect(kt).toContain('horizontalArrangement = Arrangement.spacedBy(12.dp)');
    expect(kt).toContain('.background(');
    expect(kt).toContain('Text(');
    expect(kt).toContain('Canvas(');
    expect(kt).toContain('import androidx.compose.ui.unit.dp');
    const imports = kt.split('\n').filter((l) => l.startsWith('import '));
    expect(imports).toEqual([...imports].sort());
    expectBalanced(kt);
  });

  it('Android VectorDrawable bakes geometry into viewport space', async () => {
    const [file] = await run('android-vector', f);
    const xml = text(file);
    expect(file.name).toBe('product_card.xml');
    expect(xml).toContain('<vector xmlns:android="http://schemas.android.com/apk/res/android"');
    expect(xml).toContain('android:viewportWidth="420"');
    expect(xml).toContain('<aapt:attr name="android:fillColor">');
    expect(xml).toContain('android:strokeColor="#FF22AA55"');
    expect(xml).toContain('<clip-path');
    expectWellFormedXml(xml);
  });
});

describe('roblox', () => {
  it('writes a valid rbxmx model with typed properties', async () => {
    const files = await run('roblox-rbxmx', f);
    const xml = text(files[0]);
    expect(files[0].name).toBe('Product Card.rbxmx');
    expect(xml).toMatch(/^<roblox [^>]*version="4">/);
    for (const cls of ['ScreenGui', 'Frame', 'UICorner', 'UIStroke', 'UIGradient', 'UIListLayout', 'UIPadding', 'TextLabel', 'ImageLabel']) expect(xml, cls).toContain(`class="${cls}"`);
    expect(xml).toContain('<string name="Name">Product Card</string>');
    expect(xml).toMatch(/<UDim2 name="Size">\s*<XS>0<\/XS>\s*<XO>420<\/XO>\s*<YS>0<\/YS>\s*<YO>120<\/YO>\s*<\/UDim2>/);
    expect(xml).toMatch(/<Color3 name="BackgroundColor3">\s*<R>1<\/R>/);
    expect(xml).toContain('<token name="FillDirection">0</token>');
    expect(xml).toContain('<token name="SortOrder">2</token>');
    expect(xml).toMatch(/<UDim name="Padding">\s*<S>0<\/S>\s*<O>12<\/O>/);
    expect(xml).toContain('<int name="LayoutOrder">');
    expect(xml).toContain('<Font name="FontFace">');
    expect(xml).toContain('<url>rbxasset://fonts/families/BuilderSans.json</url>');
    expect(xml).toContain('<Weight>700</Weight>');
    expect(xml).toContain('<ColorSequence name="Color">0 1 0.3725 0.4275 0 1 1 0.7647 0.4431 0 </ColorSequence>');
    expect(xml).toContain('<string name="Text">Fresh &lt;deals&gt; &amp; "more"</string>');
    expect(xml).toContain('<BinaryString name="AttributesSerialize">');
    expect(xml).toContain('<token name="ResampleMode">1</token>');
    expectWellFormedXml(xml);
    // vector → rasterised decal, bitmap → original image
    const names = files.map((x) => x.name);
    expect(names).toContain('Check icon.png');
    expect(names).toContain('Sprite.png');
    expect(rasterCalls.map((c) => c.ids[0])).toEqual([f.ids.path]);
  });

  it('supports SurfaceGui, plain Frame and scale sizing', async () => {
    const surface = text((await run('roblox-rbxmx', f, { container: 'SurfaceGui' }))[0]);
    expect(surface).toContain('class="SurfaceGui"');
    expect(surface).toMatch(/<Vector2 name="CanvasSize">\s*<X>420<\/X>/);
    const frameOnly = text((await run('roblox-rbxmx', f, { container: 'Frame', units: 'scale' }))[0]);
    expect(frameOnly).not.toContain('ScreenGui');
    expect(frameOnly).toMatch(/<Item class="Frame" referent="RBX0+">/);
    expect(frameOnly).toMatch(/<XS>0\.0476<\/XS>/); // 20 / 420
  });

  it('writes a Luau builder script', async () => {
    const files = await run('roblox-lua', f);
    const lua = text(files[0]);
    expect(files[0].name).toBe('Product Card.lua');
    expect(lua).toContain('local instance = Instance.new(className)');
    expect(lua).toContain('local ui = create("ScreenGui", {');
    expect(lua).toContain('create("UIListLayout", {');
    expect(lua).toContain('FillDirection = Enum.FillDirection.Horizontal,');
    expect(lua).toContain('Size = UDim2.fromOffset(420, 120),');
    expect(lua).toContain('BackgroundColor3 = Color3.fromRGB(255, 255, 255),');
    expect(lua).toContain('FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Bold, Enum.FontStyle.Normal),');
    expect(lua).toContain('Text = "Fresh <deals> & \\"more\\"",');
    expect(lua).toContain('Attributes = { AltImage = "Check icon.png" }');
    expect(lua).toContain('ui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")');
    expectBalanced(lua.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, ''));
    const toScript = text((await run('roblox-lua', f, { parent: 'script' }))[0]);
    expect(toScript).toContain('ui.Parent = script.Parent');
  });
});

describe('godot / unity', () => {
  it('writes a Godot 4 scene', async () => {
    const files = await run('godot', f);
    const tscn = text(files[0]);
    expect(files[0].name).toBe('product_card.tscn');
    const header = /^\[gd_scene load_steps=(\d+) format=3\]/.exec(tscn);
    expect(header).not.toBeNull();
    const resources = (tscn.match(/^\[(ext|sub)_resource /gm) ?? []).length;
    expect(Number(header![1])).toBe(resources + 1);
    expect(tscn).toContain('[sub_resource type="StyleBoxFlat"');
    expect(tscn).toContain('corner_radius_top_left = 16');
    expect(tscn).toContain('[node name="Product Card" type="PanelContainer"]');
    expect(tscn).toContain('type="HBoxContainer" parent="."');
    expect(tscn).toContain('theme_override_constants/separation = 12');
    expect(tscn).toContain('type="Label" parent="Layout"');
    expect(tscn).toContain('text = "Fresh <deals> & \\"more\\""');
    expect(tscn).toContain('theme_override_font_sizes/font_size = 20');
    expect(tscn).toContain('[ext_resource type="Texture2D" path="res://assets/');
    expect(tscn).toContain('texture_filter = 1');
    expect(tscn).toMatch(/content_margin_left = 20\.0/);
  });

  it('writes Unity UXML + USS', async () => {
    const files = await run('unity-uitk', f);
    const [uxml, uss] = files.map(text);
    expect(files[0].name).toBe('ProductCard.uxml');
    expect(files[1].name).toBe('ProductCard.uss');
    expect(uxml).toContain('<Style src="ProductCard.uss" />');
    expect(uxml).toContain('<ui:Label name="Title" text="Fresh &lt;deals&gt; &amp; &quot;more&quot;"');
    expectWellFormedXml(uxml);
    expect(uss).toContain('flex-direction: row;');
    expect(uss).toContain('margin-left: 12px;');
    expect(uss).toContain('-unity-font-style: bold;');
  });
});

describe('data', () => {
  it('JSON is a standalone document of the exported subtree', async () => {
    const [file] = await run('json', f, {}, [f.ids.rect]);
    const doc = JSON.parse(text(file));
    expect(doc.format).toBe('alt');
    expect(Object.keys(doc.nodes)).toEqual([f.ids.rect]);
    expect(doc.pages[0].children).toEqual([f.ids.rect]);
    expect(doc.nodes[f.ids.rect].parentId).toBe(f.pageId);
    const whole = JSON.parse(text((await run('json', f))[0]));
    expect(Object.keys(whole.nodes)).toHaveLength(6);
    expect(whole.assets.px.data).toBe(PNG_1PX);
  });

  it('design tokens & CSS variables include styles and used values', async () => {
    f.doc.styles.colors.push({ id: 'c', name: 'Brand/Primary', paint: solid('#3366FF') });
    f.doc.styles.effects.push({ id: 'e', name: 'Elevation/1', effects: [defaultEffect('drop-shadow')] });
    const tokens = JSON.parse(text((await run('design-tokens', f))[0]));
    expect(tokens.color.brand.primary).toEqual({ $type: 'color', $value: '#3366ff' });
    expect(tokens.color.palette['22aa55'].$value).toBe('#22aa55');
    expect(tokens.shadow.elevation['1'].$type).toBe('shadow');
    const typo = Object.values(tokens.typography.scale)[0] as { $value: { fontWeight: number } };
    expect(typo.$value.fontWeight).toBe(700);
    const css = text((await run('css-variables', f))[0]);
    expect(css).toContain(':root {');
    expect(css).toContain('--color-brand-primary: #3366ff;');
    expect(css).toContain('--shadow-elevation-1: 0 4px 12px 0 rgba(0, 0, 0, 0.25);');
    expect(css).toMatch(/\.text-scale-inter-20-700 \{/);
  });
});

describe('svg import', () => {
  it('detects SVG text', () => {
    expect(isSvgText('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    expect(isSvgText('<?xml version="1.0"?>\n<!-- hi -->\n<svg width="1"/>')).toBe(true);
    expect(isSvgText('<html><svg/></html>')).toBe(false);
    expect(isSvgText('not svg')).toBe(false);
  });

  it('parses XML with entities, CDATA and namespaces', () => {
    const doc = parseXml('<!DOCTYPE svg [<!ENTITY a "x">]><svg:svg a="&lt;&a;&#65;"><style><![CDATA[.b{}]]></style></svg:svg>');
    const svg = doc.parts[0] as { tag: string; attrs: Record<string, string> };
    expect(svg.tag).toBe('svg');
    expect(svg.attrs.a).toBe('<xA');
  });

  it('imports shapes, transforms, gradients, <use>, clip paths and text', () => {
    const data = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 100 50">
        <title>Logo</title>
        <style>.red { fill: #f00 }</style>
        <defs>
          <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
          <circle id="dot" r="3"/>
          <clipPath id="c"><rect width="50" height="50"/></clipPath>
        </defs>
        <rect class="red" x="5" y="5" width="20" height="10" rx="2" transform="rotate(30 15 10)"/>
        <path d="M0 0 h10 v10 z" fill="url(#g)" stroke="black" stroke-width="2" transform="translate(30 0)"/>
        <use xlink:href="#dot" x="80" y="40" fill="green"/>
        <g clip-path="url(#c)"><circle cx="50" cy="25" r="10"/><line x1="0" y1="0" x2="10" y2="10" stroke="#000"/></g>
        <text x="10" y="45" font-size="8" font-weight="bold" text-anchor="start">Hi<tspan x="10" dy="10">there</tspan></text>
        <rect width="10" height="10" transform="skewX(20)"/>
      </svg>`,
    );
    const root = data.nodes[0] as FrameNode;
    expect(root.type).toBe('frame');
    expect(root.name).toBe('Logo');
    expect([root.width, root.height]).toEqual([200, 100]);
    expect(data.roots).toEqual([{ id: root.id, world: [1, 0, 0, 1, 0, 0] }]);
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const kids = root.children.map((id) => byId.get(id)!);
    const rect = kids.find((k) => k.type === 'rect')!;
    expect(rect.rotation).toBeCloseTo(30);
    expect([rect.width, rect.height]).toEqual([40, 20]);
    expect(rect.fills[0]).toMatchObject({ type: 'solid', color: '#FF0000' });
    expect(rect.type === 'rect' && rect.cornerRadius).toBe(4);
    const path = kids.find((k) => k.type === 'path' && k.fills[0]?.type === 'linear')!;
    expect(path.fills[0]).toMatchObject({ type: 'linear', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
    expect(path.strokeWidth).toBe(4);
    const dot = kids.find((k) => k.type === 'ellipse')!;
    expect([dot.x, dot.y, dot.width]).toEqual([154, 74, 12]);
    expect(dot.fills[0]).toMatchObject({ color: '#008000' });
    const clipGroup = kids.find((k) => k.type === 'group')!;
    const mask = byId.get((clipGroup as { children: ID[] }).children[0])!;
    expect(mask.isMask).toBe(true);
    const textNode = kids.find((k) => k.type === 'text')!;
    expect(textNode.type === 'text' && textNode.text).toBe('Hi\nthere');
    expect(textNode.type === 'text' && textNode.fontWeight).toBe(700);
    expect(textNode.type === 'text' && textNode.fontSize).toBe(16);
    const skewed = kids[kids.length - 1];
    expect(skewed.type).toBe('path');
    // every non-root node has its parent in the payload
    for (const n of data.nodes.slice(1)) expect(byId.has(n.parentId)).toBe(true);
  });

  it('round-trips an exported SVG back into the document', async () => {
    const [file] = await run('svg', f);
    const data = importSvg(text(file), { name: 'Round trip' });
    const doc = createDoc();
    const ids = pasteNodes(doc, data, doc.pages[0].id);
    expect(ids).toHaveLength(1);
    const root = doc.nodes[ids[0]] as FrameNode;
    expect(root.name).toBe('Round trip');
    expect([root.width, root.height]).toEqual([420, 120]);
    const types = new Set(Object.values(doc.nodes).map((n) => n.type));
    for (const t of ['frame', 'rect', 'text', 'path']) expect(types.has(t as never), t).toBe(true);
    const textNode = Object.values(doc.nodes).find((n) => n.type === 'text');
    expect(textNode && textNode.type === 'text' && textNode.text).toBe('Fresh <deals> & "more"');
  });
});

describe('util', () => {
  it('maps a top → bottom handle to a 180° CSS gradient', () => {
    const g = gradient('linear', '#000000', '#ffffff');
    const { angle, map } = cssLinear(g, 100, 50);
    expect(angle).toBeCloseTo(180);
    expect(map(0)).toBeCloseTo(0);
    expect(map(1)).toBeCloseTo(1);
  });

  it('creates unique identifiers and safe file names', () => {
    const reg = new NameRegistry('pascal', ['Text']);
    expect(reg.get('text')).toBe('Text2');
    expect(reg.get('3D card')).toBe('Layer3DCard');
    expect(reg.get('Héllo wörld!')).toBe('HelloWorld');
    expect(new NameRegistry('kebab').get('My  Layer/Name')).toBe('my-layer-name');
    expect(sanitizeFileName('a/b:c*?')).toBe('a b c');
  });

  it('encodes base64 and reads image headers', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(imageSize(base64ToBytes(PNG_1PX.split(',')[1]))).toEqual({ width: 1, height: 1 });
  });
});
