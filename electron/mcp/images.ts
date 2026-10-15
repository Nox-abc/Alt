/**
 * Resolve image sources inside MCP tool arguments before they reach the
 * renderer: http(s) URLs are downloaded and absolute local paths are read, both
 * turned into data: URLs. Doing this in the main process avoids CORS and the
 * renderer's CSP and gives agents an easy way to place local images.
 *
 * Pure apart from the injected I/O functions so it can be unit-tested.
 */
import path from 'node:path';

export interface ImageIO {
  fetchUrl(url: string, signal: AbortSignal): Promise<{ ok: boolean; status: number; contentType: string | null; body: Uint8Array }>;
  readFile(filePath: string): Promise<Uint8Array>;
  fileSize(filePath: string): Promise<number>;
}

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGES_PER_CALL = 64;
const FETCH_TIMEOUT_MS = 20_000;

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function sniffImageMime(b: Uint8Array): string | null {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif';
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 512))).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function isLocalPath(s: string): boolean {
  return s.startsWith('file://') || path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('~/');
}

function expandPath(s: string, home: string): string {
  if (s.startsWith('file://')) return decodeURIComponent(new URL(s).pathname).replace(/^\/([a-zA-Z]:\/)/, '$1');
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return s;
}

/** Load one image source. Strings that are already data: URLs are returned unchanged. */
export async function loadImageSource(src: string, io: ImageIO, home = ''): Promise<string> {
  const s = src.trim();
  if (s.startsWith('data:') || s.startsWith('blob:')) return s;
  if (/^https?:\/\//i.test(s)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await io.fetchUrl(s, ctrl.signal);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (r.body.length > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      const declared = (r.contentType ?? '').split(';')[0].trim().toLowerCase();
      const mime = sniffImageMime(r.body) ?? (declared.startsWith('image/') ? declared : null);
      if (!mime) throw new Error(`not an image (content-type ${declared || 'unknown'})`);
      return toDataUrl(mime, r.body);
    } catch (e) {
      const why = ctrl.signal.aborted ? 'timed out' : e instanceof Error ? e.message : String(e);
      throw new Error(`Could not load image ${s}: ${why}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (isLocalPath(s)) {
    const file = expandPath(s, home);
    const ext = path.extname(file).toLowerCase();
    const extMime = EXT_MIME[ext];
    if (!extMime) throw new Error(`Could not load image ${s}: unsupported file type (use ${Object.keys(EXT_MIME).join(', ')})`);
    try {
      const size = await io.fileSize(file);
      if (size > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      const bytes = await io.readFile(file);
      const mime = sniffImageMime(bytes) ?? extMime;
      if (!mime.startsWith('image/')) throw new Error('not an image');
      return toDataUrl(mime, bytes);
    } catch (e) {
      throw new Error(`Could not load image ${s}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return s; // relative / unknown: let the renderer report it
}

const SOURCE_KEYS = new Set(['image']);
const PAINT_SOURCE_KEYS = ['src', 'url', 'image'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walk tool arguments and replace image sources (`image: "…"` anywhere, and
 * `src` / `url` / `image` of objects with `type: "image"`) by data: URLs.
 * Returns a new object; the input is not modified.
 */
export async function resolveImageSources<T>(args: T, io: ImageIO, home = ''): Promise<T> {
  const jobs: { holder: Record<string, unknown>; key: string; src: string }[] = [];
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 64) return v;
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    if (!isObj(v)) return v;
    const copy: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) copy[k] = visit(val, depth + 1);
    for (const k of Object.keys(copy)) {
      const val = copy[k];
      const isSource = SOURCE_KEYS.has(k) || (copy.type === 'image' && PAINT_SOURCE_KEYS.includes(k));
      if (isSource && typeof val === 'string' && !val.startsWith('data:')) jobs.push({ holder: copy, key: k, src: val });
    }
    return copy;
  };
  const out = visit(args, 0) as T;
  if (jobs.length > MAX_IMAGES_PER_CALL) throw new Error(`Too many images in one call (max ${MAX_IMAGES_PER_CALL})`);
  const cache = new Map<string, Promise<string>>();
  await Promise.all(
    jobs.map(async (j) => {
      let p = cache.get(j.src);
      if (!p) {
        p = loadImageSource(j.src, io, home);
        cache.set(j.src, p);
      }
      j.holder[j.key] = await p;
    }),
  );
  return out;
}
