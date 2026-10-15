/**
 * Bridge to the desktop shell. In Electron the preload script exposes
 * `window.altNative`; in a plain browser every call falls back to web APIs.
 */

export interface NativeFile {
  path: string | null;
  name: string;
  /** file contents; text for .alt/.json/.svg, base64 for binary when `binary` is set */
  data: string;
  binary?: boolean;
}

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string;
  allowScripts: boolean;
  error?: string;
  /** absolute path of the bundled stdio shim (for clients that only speak stdio) */
  stdioShim?: string;
  /** absolute path of the app executable (used with ELECTRON_RUN_AS_NODE=1 to run the shim) */
  execPath?: string;
}

export interface McpConfig {
  enabled: boolean;
  port: number;
  allowScripts: boolean;
}

/** A tool call forwarded from the MCP server (main process) to the renderer. */
export interface McpToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

/** MCP tool result content (subset of the MCP spec). */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface AltNative {
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  version: string;
  /** Show an open dialog; returns null if cancelled. */
  openFile(opts: { filters: { name: string; extensions: string[] }[]; binary?: boolean }): Promise<NativeFile | null>;
  /** Read a file by absolute path. */
  readFile(path: string, binary?: boolean): Promise<NativeFile>;
  /**
   * Save data. If `path` is given and `saveAs` is false, writes there without a dialog.
   * Returns the written path or null when cancelled.
   */
  saveFile(opts: {
    path?: string | null;
    defaultName: string;
    data: string | Uint8Array;
    filters: { name: string; extensions: string[] }[];
    saveAs?: boolean;
  }): Promise<string | null>;
  /** Menu / accelerator actions from the native menu (e.g. "file.save"). */
  onMenuAction(cb: (action: string) => void): () => void;
  /** Files opened via the OS (double-click, argv, open-file event). */
  onOpenFile(cb: (file: NativeFile) => void): () => void;
  setTitle(title: string): void;
  setDocumentEdited(edited: boolean): void;
  getRecentFiles(): Promise<string[]>;
  openExternal(url: string): void;
  showItemInFolder(path: string): void;
  /** Ask before closing when there are unsaved changes. Renderer answers via `confirmClose`. */
  onCloseRequest(cb: () => void): () => void;
  confirmClose(): void;
  /** Theme for native window chrome (title bar overlay colours on Windows / Linux). */
  setChrome(opts: { dark: boolean; background: string; symbol: string }): void;
  /** Pop up the native application menu at window coordinates (Windows / Linux hide the menu bar). */
  showAppMenu?(x: number, y: number): void;
  /** Absolute path of a File from drag & drop / <input type=file> (desktop only; null when unknown). */
  getPathForFile?(file: File): string | null;
  mcp: {
    getStatus(): Promise<McpStatus>;
    configure(cfg: McpConfig): Promise<McpStatus>;
    /** Register the renderer-side tool executor. Only one handler is kept. */
    onToolCall(handler: (req: McpToolRequest) => Promise<McpToolResult>): () => void;
    onStatus(cb: (s: McpStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    altNative?: AltNative;
  }
}

export const native: AltNative | undefined = typeof window !== 'undefined' ? window.altNative : undefined;
export const isDesktop = !!native;
export const platform: 'darwin' | 'win32' | 'linux' | 'web' = native?.platform ?? 'web';
export const isMac = platform === 'darwin' || (platform === 'web' && typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform));

/* ------------------------------------------------------------- web fallbacks */

function pickFile(accept: string, binary: boolean): Promise<NativeFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (binary) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        resolve({ path: null, name: f.name, data: btoa(s), binary: true });
      } else resolve({ path: null, name: f.name, data: await f.text() });
    };
    input.click();
  });
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function openFile(filters: { name: string; extensions: string[] }[], binary = false): Promise<NativeFile | null> {
  if (native) return native.openFile({ filters, binary });
  const accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
  return pickFile(accept, binary);
}

export async function saveFile(opts: {
  path?: string | null;
  defaultName: string;
  data: string | Uint8Array;
  mime?: string;
  filters: { name: string; extensions: string[] }[];
  saveAs?: boolean;
}): Promise<string | null> {
  if (native) return native.saveFile(opts);
  const blob = new Blob([opts.data as BlobPart], { type: opts.mime ?? 'application/octet-stream' });
  downloadBlob(blob, opts.defaultName);
  return opts.defaultName;
}

export function openExternal(url: string) {
  if (native) native.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
