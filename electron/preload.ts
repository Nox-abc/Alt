/**
 * Preload (sandboxed, context-isolated): exposes `window.altNative`
 * implementing the `AltNative` contract from src/platform/native.ts.
 *
 * Bundled by esbuild to dist-electron/preload.cjs. Only `electron` may be
 * required at runtime (sandboxed preloads have no node built-ins).
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { AltNative, McpStatus, McpToolRequest, McpToolResult, NativeFile } from '../src/platform/native';

const versionArg = process.argv.find((a) => a.startsWith('--alt-version='));
const version = versionArg ? versionArg.slice('--alt-version='.length) : '0.0.0';

type Kind = 'menu' | 'open-file' | 'close' | 'mcp';

/** Subscribe to a main→renderer channel and tell main that someone is listening. */
function subscribe<T>(channel: string, kind: Kind, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[altNative] ${channel} listener failed`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  ipcRenderer.send('renderer:listen', kind, true);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
    ipcRenderer.send('renderer:listen', kind, false);
  };
}

/* ------------------------------------------------------------ MCP bridge */

let toolHandler: ((req: McpToolRequest) => Promise<McpToolResult>) | null = null;

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

ipcRenderer.on('mcp:call', async (_e, msg: { callId: string; tool: string; args: Record<string, unknown> }) => {
  let result: McpToolResult;
  if (!toolHandler) result = errorResult('Alt is not ready to run tools yet. Retry in a moment.');
  else {
    try {
      result = await toolHandler({ tool: msg.tool, args: msg.args ?? {} });
      if (!result || !Array.isArray(result.content)) result = errorResult(`Tool "${msg.tool}" returned no result.`);
    } catch (err) {
      result = errorResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    ipcRenderer.send('mcp:result', { callId: msg.callId, result });
  } catch (err) {
    // e.g. a non-cloneable value slipped into the result
    ipcRenderer.send('mcp:result', { callId: msg.callId, result: errorResult(`Could not return the result: ${err instanceof Error ? err.message : String(err)}`) });
  }
});

/* ------------------------------------------------------------------ API */

const api: AltNative = {
  platform: process.platform as AltNative['platform'],
  arch: process.arch,
  version,

  openFile: (opts) => ipcRenderer.invoke('dialog:open', opts) as Promise<NativeFile | null>,
  readFile: (path, binary) => ipcRenderer.invoke('fs:read', path, binary) as Promise<NativeFile>,
  saveFile: (opts) => ipcRenderer.invoke('dialog:save', opts) as Promise<string | null>,

  onMenuAction: (cb) => subscribe<string>('menu:action', 'menu', cb),
  onOpenFile: (cb) => subscribe<NativeFile>('open-file', 'open-file', cb),

  setTitle: (title) => ipcRenderer.send('window:set-title', title),
  setDocumentEdited: (edited) => ipcRenderer.send('window:set-edited', !!edited),
  getRecentFiles: () => ipcRenderer.invoke('recent:get') as Promise<string[]>,
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  showItemInFolder: (path) => ipcRenderer.send('shell:show-item', path),

  onCloseRequest: (cb) => subscribe<void>('close-request', 'close', () => cb()),
  confirmClose: () => ipcRenderer.send('window:close-confirm'),
  setChrome: (opts) => ipcRenderer.send('window:set-chrome', opts),

  showAppMenu: (x, y) => ipcRenderer.send('menu:popup', { x, y }),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:get-status') as Promise<McpStatus>,
    configure: (cfg) => ipcRenderer.invoke('mcp:configure', cfg) as Promise<McpStatus>,
    onToolCall: (handler) => {
      toolHandler = handler;
      ipcRenderer.send('renderer:listen', 'mcp', true);
      return () => {
        if (toolHandler !== handler) return;
        toolHandler = null;
        ipcRenderer.send('renderer:listen', 'mcp', false);
      };
    },
    onStatus: (cb) => {
      const listener = (_e: IpcRendererEvent, s: McpStatus) => cb(s);
      ipcRenderer.on('mcp:status', listener);
      return () => ipcRenderer.removeListener('mcp:status', listener);
    },
  },
};

contextBridge.exposeInMainWorld('altNative', api);
