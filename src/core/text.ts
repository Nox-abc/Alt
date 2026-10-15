import type { TextNode, TextStyleProps } from './types';

export interface FontMetrics {
  ascent: number;
  descent: number;
}

export interface Measurer {
  width(text: string, font: string): number;
  metrics(font: string, size: number): FontMetrics;
}

export const FONT_FALLBACK = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

export function fontString(s: Pick<TextStyleProps, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic'>, sizeOverride?: number): string {
  const fam = s.fontFamily.includes(' ') || /\d/.test(s.fontFamily) ? `"${s.fontFamily}"` : s.fontFamily;
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${sizeOverride ?? s.fontSize}px ${fam}, ${FONT_FALLBACK}`;
}

export function cssFontFamily(family: string): string {
  return `"${family}", ${FONT_FALLBACK}`;
}

/* A canvas-backed measurer with an approximation fallback for non-DOM environments. */
let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
const metricCache = new Map<string, FontMetrics>();

function getCtx() {
  if (ctx) return ctx;
  try {
    if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  return ctx;
}

export const defaultMeasurer: Measurer = {
  width(text, font) {
    const key = font + '\u0000' + text;
    const c = widthCache.get(key);
    if (c !== undefined) return c;
    const g = getCtx();
    let w: number;
    if (g) {
      g.font = font;
      w = g.measureText(text).width;
    } else {
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '16');
      w = approxWidth(text) * size;
    }
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(key, w);
    return w;
  },
  metrics(font, size) {
    const key = font;
    const c = metricCache.get(key);
    if (c) return c;
    const g = getCtx();
    let m: FontMetrics = { ascent: size * 0.92, descent: size * 0.24 };
    if (g) {
      g.font = font;
      const tm = g.measureText('Hg');
      if (tm.fontBoundingBoxAscent !== undefined && tm.fontBoundingBoxAscent > 0) {
        m = { ascent: tm.fontBoundingBoxAscent, descent: tm.fontBoundingBoxDescent };
      }
    }
    metricCache.set(key, m);
    return m;
  },
};

/** Called when web fonts finish loading so cached measurements refresh. */
export function clearTextCaches() {
  widthCache.clear();
  metricCache.clear();
}

function approxWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') w += 0.28;
    else if (/[il.,:;'|!]/.test(ch)) w += 0.26;
    else if (/[mwMW]/.test(ch)) w += 0.82;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else w += 0.54;
  }
  return w;
}

export function applyCase(text: string, c: TextStyleProps['textCase']): string {
  switch (c) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return text.replace(/\b(\p{L})/gu, (m) => m.toUpperCase());
    default:
      return text;
  }
}

export interface TextLine {
  text: string;
  /** left offset of the line within the box */
  x: number;
  /** top of the line box */
  top: number;
  /** baseline y */
  baseline: number;
  width: number;
  /** extra spacing per space (justify) */
  wordSpacing: number;
  /** last line of its paragraph */
  last: boolean;
}

export interface TextLayout {
  lines: TextLine[];
  /** natural content size */
  contentWidth: number;
  contentHeight: number;
  lineHeight: number;
  font: string;
}

type LayoutInput = Pick<TextNode, keyof TextStyleProps | 'text' | 'width' | 'height' | 'autoResize'>;

const layoutCache = new WeakMap<object, TextLayout>();

export function layoutText(n: LayoutInput, measurer: Measurer = defaultMeasurer): TextLayout {
  const cached = layoutCache.get(n);
  if (cached && measurer === defaultMeasurer) return cached;
  const font = fontString(n);
  const ls = n.letterSpacing;
  const measure = (s: string) => measurer.width(s, font) + ls * [...s].length;
  const lh = n.fontSize * n.lineHeight;
  const { ascent, descent } = measurer.metrics(font, n.fontSize);
  const content = ascent + descent;
  const baselineOffset = (lh - content) / 2 + ascent;
  const text = applyCase(n.text, n.textCase);
  const paragraphs = text.split('\n');
  const wrap = n.autoResize !== 'width';
  const maxW = Math.max(1, n.width);
  const raw: { text: string; width: number; last: boolean; para: number }[] = [];

  paragraphs.forEach((para, pi) => {
    if (!wrap) {
      raw.push({ text: para, width: measure(para), last: true, para: pi });
      return;
    }
    if (para === '') {
      raw.push({ text: '', width: 0, last: true, para: pi });
      return;
    }
    // tokens: words with trailing spaces
    const tokens = para.match(/\S+\s*|\s+/g) ?? [para];
    let line = '';
    let lineW = 0;
    const flush = (last: boolean) => {
      const t = line.replace(/\s+$/, '');
      raw.push({ text: t, width: measure(t), last, para: pi });
      line = '';
      lineW = 0;
    };
    for (const tok of tokens) {
      const word = tok.replace(/\s+$/, '');
      const wW = measure(word);
      if (line && lineW + wW > maxW + 0.01) flush(false);
      if (!line && wW > maxW && word.length > 1) {
        // break a long word into characters
        let chunk = '';
        for (const ch of [...tok]) {
          if (chunk && measure(chunk + ch) > maxW) {
            raw.push({ text: chunk, width: measure(chunk), last: false, para: pi });
            chunk = '';
          }
          chunk += ch;
        }
        line = chunk;
        lineW = measure(chunk);
        continue;
      }
      line += tok;
      lineW = measure(line);
    }
    flush(true);
  });

  const contentWidth = raw.reduce((m, l) => Math.max(m, l.width), 0);
  let y = 0;
  const lines: TextLine[] = [];
  let prevPara = 0;
  for (const r of raw) {
    if (r.para !== prevPara) {
      y += n.paragraphSpacing;
      prevPara = r.para;
    }
    lines.push({ text: r.text, x: 0, top: y, baseline: y + baselineOffset, width: r.width, wordSpacing: 0, last: r.last });
    y += lh;
  }
  const contentHeight = Math.max(lh, y);
  const boxW = n.autoResize === 'width' ? contentWidth : n.width;
  for (const l of lines) {
    switch (n.textAlign) {
      case 'center':
        l.x = (boxW - l.width) / 2;
        break;
      case 'right':
        l.x = boxW - l.width;
        break;
      case 'justify': {
        const spaces = (l.text.match(/ /g) ?? []).length;
        if (!l.last && spaces > 0 && wrap) l.wordSpacing = (boxW - l.width) / spaces;
        break;
      }
    }
  }
  if (n.autoResize === 'none') {
    const free = n.height - contentHeight;
    const dy = n.verticalAlign === 'middle' ? free / 2 : n.verticalAlign === 'bottom' ? free : 0;
    if (dy) for (const l of lines) {
      l.top += dy;
      l.baseline += dy;
    }
  }
  const out = { lines, contentWidth, contentHeight, lineHeight: lh, font };
  if (measurer === defaultMeasurer) layoutCache.set(n, out);
  return out;
}

/** Size a text node should take given its auto-resize mode. */
export function measureTextBox(n: LayoutInput, measurer: Measurer = defaultMeasurer): { width: number; height: number } {
  const l = layoutText({ ...n }, measurer);
  if (n.autoResize === 'width') return { width: Math.max(1, Math.ceil(l.contentWidth)), height: Math.ceil(l.contentHeight) };
  if (n.autoResize === 'height') return { width: n.width, height: Math.ceil(l.contentHeight) };
  return { width: n.width, height: n.height };
}
