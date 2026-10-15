import type { Doc, ID } from '../core/types';

type Listener = () => void;

interface Entry {
  src: string;
  img: HTMLImageElement;
  ready: boolean;
  failed: boolean;
  promise: Promise<void>;
}

/**
 * Decoded image cache for document assets. Bitmap layers that are being
 * painted on register a live canvas that overrides the stored data URL.
 */
class AssetStore {
  private images = new Map<ID, Entry>();
  private live = new Map<ID, HTMLCanvasElement>();
  private listeners = new Set<Listener>();

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private load(id: ID, src: string): Entry {
    const img = new Image();
    img.decoding = 'async';
    const e: Entry = { src, img, ready: false, failed: false, promise: Promise.resolve() };
    e.promise = new Promise<void>((resolve) => {
      img.onload = () => {
        e.ready = true;
        resolve();
        this.emit();
      };
      img.onerror = () => {
        e.failed = true;
        resolve();
      };
    });
    img.src = src;
    this.images.set(id, e);
    return e;
  }

  /** Synchronous lookup – returns null until decoded (a re-render is triggered on load). */
  get(doc: Doc, id: ID): CanvasImageSource | null {
    const live = this.live.get(id);
    if (live) return live;
    const a = doc.assets[id];
    if (!a) return null;
    let e = this.images.get(id);
    if (!e || e.src !== a.data) e = this.load(id, a.data);
    return e.ready ? e.img : null;
  }

  size(doc: Doc, id: ID): { width: number; height: number } | null {
    const live = this.live.get(id);
    if (live) return { width: live.width, height: live.height };
    const a = doc.assets[id];
    if (!a) return null;
    const e = this.images.get(id);
    if (e?.ready) return { width: e.img.naturalWidth, height: e.img.naturalHeight };
    if (a.width && a.height) return { width: a.width, height: a.height };
    return null;
  }

  /** Wait until every asset referenced by the document is decoded. */
  async ensure(doc: Doc, ids?: ID[]): Promise<void> {
    const wanted = ids ?? Object.keys(doc.assets);
    const ps: Promise<void>[] = [];
    for (const id of wanted) {
      if (this.live.has(id)) continue;
      const a = doc.assets[id];
      if (!a) continue;
      let e = this.images.get(id);
      if (!e || e.src !== a.data) e = this.load(id, a.data);
      ps.push(e.promise);
    }
    await Promise.all(ps);
  }

  setLive(id: ID, canvas: HTMLCanvasElement | null) {
    if (canvas) this.live.set(id, canvas);
    else this.live.delete(id);
    this.emit();
  }

  getLive(id: ID) {
    return this.live.get(id) ?? null;
  }

  touch() {
    this.emit();
  }
}

export const assets = new AssetStore();

/** Read an image file / data URL into an Asset-ready record. */
export async function loadImageInfo(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 100, height: 100 });
    img.src = dataUrl;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
