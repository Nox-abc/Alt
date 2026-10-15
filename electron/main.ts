/**
 * Alt — Electron main process.
 *
 * Responsibilities: window + native chrome, application menu (display-only
 * accelerators; the renderer owns keyboard shortcuts), file dialogs / IO,
 * recent files, close confirmation, OS file-open events, the `app://` protocol
 * that serves the production renderer with a CSP, and the local MCP server
 * that forwards tool calls to the renderer.
 *
 * Bundled by esbuild to dist-electron/main.cjs (CJS, `electron` external).
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pkg from '../package.json';
import type { McpConfig, McpStatus, NativeFile } from '../src/platform/native';
import { getMcpTools, IMAGE_SOURCE_TOOLS, isScriptTool, MCP_INSTRUCTIONS } from '../src/api/mcpTools';
import { createMcpHandler, errorText, toolError, type McpToolResult } from './mcp/protocol';
import { McpHttpServer } from './mcp/server';
import { resolveImageSources, type ImageIO } from './mcp/images';

/* ================================================================ constants */

const IS_MAC = process.platform === 'darwin';
const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || '';
const SHOW_DEVTOOLS = IS_DEV || process.env.ALT_DEVTOOLS === '1';

const APP_SCHEME = 'app';
const APP_HOST = 'alt';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const RENDERER_DIR = path.join(__dirname, '..', 'dist');
const PRELOAD = path.join(__dirname, 'preload.cjs');

const BG_DARK = '#0E0E10';
const TITLE_BAR_HEIGHT = 40;
const HOMEPAGE = (pkg as { homepage?: string }).homepage ?? 'https://github.com';

const DOC_EXT = 'alt';
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico', 'pdf', 'zip', 'ttf', 'otf', 'woff', 'woff2', 'psd', 'fig', 'rbxm', 'rbxl']);
const OPENABLE_EXT = new Set(['alt', 'svg', 'json', 'png', 'jpg', 'jpeg', 'webp', 'gif']);
const MAX_READ_BYTES = 1024 * 1024 * 1024;
const MAX_RECENT = 20;
const MCP_CALL_TIMEOUT_MS = 120_000;

const DEFAULT_MCP: McpConfig = { enabled: true, port: 7331, allowScripts: false };

const CSP = [
  "default-src 'self'",
  // 'unsafe-eval' powers the scripting API (MCP run_script / in-app scripts); no remote scripts are ever allowed.
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob: https://fonts.gstatic.com",
  "connect-src 'self' data: blob: https://fonts.googleapis.com https://fonts.gstatic.com",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* ================================================================== state */

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

interface Settings {
  mcp: McpConfig;
  window?: WindowState;
  chrome?: { dark: boolean; background: string; symbol: string };
}

let settings: Settings = { mcp: { ...DEFAULT_MCP } };
let recent: string[] = [];
let mainWindow: BrowserWindow | null = null;

/** what the current renderer has subscribed to (reset on every navigation / crash) */
const listening = { menu: 0, openFile: 0, close: 0, mcp: false };
let docEdited = false;
let forceClose = false;
let quitRequested = false;
const pendingFiles: string[] = [];
const pendingMenuActions: string[] = [];

const log = (...args: unknown[]) => {
  if (IS_DEV || process.env.ALT_DEBUG) console.log('[alt]', ...args);
};

/* ========================================================== early setup */

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

if (IS_DEV) app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()} Dev`));
if (process.platform === 'win32') app.setAppUserModelId('app.alt.design');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // macOS can deliver files before `ready`
  app.on('open-file', (e, file) => {
    e.preventDefault();
    openPaths([file]);
  });
  app.on('second-instance', (_e, argv, cwd) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) createWindow();
    openPaths(filesFromArgv(argv, cwd));
  });
  app.on('before-quit', () => {
    quitRequested = true;
  });
  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });
  app.on('activate', () => {
    if (!mainWindow && app.isReady()) createWindow();
  });
  app.on('will-quit', () => {
    void mcpServer.stop();
  });
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));

  app.whenReady().then(onReady).catch((e) => {
    console.error('[alt] startup failed', e);
    dialog.showErrorBox('Alt failed to start', errorText(e));
    app.quit();
  });
}

async function onReady() {
  settings = loadSettings();
  recent = loadRecent();
  registerAppProtocol();
  configureSession();
  registerIpc();
  installStdioShim();
  app.setAboutPanelOptions({
    applicationName: 'Alt',
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} Alt contributors — MIT License`,
    website: HOMEPAGE,
  });
  buildMenu();
  pendingFiles.push(...filesFromArgv(process.argv, process.cwd()));
  createWindow();
  await applyMcpConfig();
}

/* ============================================================== settings */

function userFile(name: string) {
  return path.join(app.getPath('userData'), name);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(value, null, 2));
}

function sanitizeMcp(raw: Partial<McpConfig> | undefined): McpConfig {
  const port = Number(raw?.port);
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_MCP.enabled,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_MCP.port,
    allowScripts: typeof raw?.allowScripts === 'boolean' ? raw.allowScripts : DEFAULT_MCP.allowScripts,
  };
}

function loadSettings(): Settings {
  const raw = readJson<Partial<Settings>>(userFile('settings.json')) ?? {};
  const s: Settings = { mcp: sanitizeMcp(raw.mcp) };
  if (raw.window && Number.isFinite(raw.window.width) && Number.isFinite(raw.window.height)) s.window = raw.window;
  if (raw.chrome && typeof raw.chrome.background === 'string') s.chrome = raw.chrome;
  return s;
}

let settingsWrite: Promise<void> = Promise.resolve();
function saveSettings() {
  const snapshot = JSON.parse(JSON.stringify(settings));
  settingsWrite = settingsWrite.then(() => writeJson(userFile('settings.json'), snapshot)).catch((e) => log('settings write failed', e));
}

/** Port override for development / side-by-side installs (not persisted). */
function effectivePort() {
  const env = Number(process.env.ALT_MCP_PORT);
  return Number.isInteger(env) && env > 0 && env < 65536 ? env : settings.mcp.port;
}

/* ================================================================= recent */

function loadRecent(): string[] {
  const raw = readJson<unknown>(userFile('recent.json'));
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT) : [];
}

function addRecent(file: string) {
  if (extOf(file) !== DOC_EXT) return;
  recent = [file, ...recent.filter((p) => p !== file)].slice(0, MAX_RECENT);
  void writeJson(userFile('recent.json'), recent).catch((e) => log('recent write failed', e));
  if (IS_MAC || process.platform === 'win32') app.addRecentDocument(file);
  buildMenu();
}

function clearRecent() {
  recent = [];
  void writeJson(userFile('recent.json'), recent).catch(() => undefined);
  app.clearRecentDocuments();
  buildMenu();
}

/* ================================================================ files */

function extOf(file: string) {
  return path.extname(file).slice(1).toLowerCase();
}

async function readNativeFile(file: string, binary?: boolean): Promise<NativeFile> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('readFile expects an absolute path');
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error(`Not a file: ${file}`);
  if (st.size > MAX_READ_BYTES) throw new Error(`File is too large (${Math.round(st.size / 1048576)} MB)`);
  const isBinary = binary ?? BINARY_EXT.has(extOf(file));
  const buf = await fsp.readFile(file);
  return { path: file, name: path.basename(file), data: isBinary ? buf.toString('base64') : buf.toString('utf8'), ...(isBinary ? { binary: true } : {}) };
}

async function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    // some filesystems (network shares, FAT) refuse rename-over; fall back to a direct write
    if ((e as NodeJS.ErrnoException).code === 'EXDEV' || (e as NodeJS.ErrnoException).code === 'EPERM') await fsp.writeFile(file, data);
    else throw e;
  }
}

type FileFilter = { name: string; extensions: string[] };
function sanitizeFilters(filters: unknown): FileFilter[] {
  if (!Array.isArray(filters)) return [];
  return filters
    .filter((f): f is FileFilter => !!f && typeof f.name === 'string' && Array.isArray(f.extensions))
    .map((f) => ({ name: f.name.slice(0, 100), extensions: f.extensions.filter((x) => typeof x === 'string').map((x) => x.replace(/^\./, '')) }));
}

function filesFromArgv(argv: string[], cwd: string): string[] {
  // packaged: [exe, ...args]; dev: [electron, ".", ...args]
  const args = argv.slice(process.defaultApp ? 2 : 1);
  const out: string[] = [];
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    const p = path.resolve(cwd, a);
    if (!OPENABLE_EXT.has(extOf(p))) continue;
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* not a file */
    }
  }
  return out;
}

function openPaths(paths: string[]) {
  if (!paths.length) return;
  pendingFiles.push(...paths);
  if (!app.isReady()) return;
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  flushPendingFiles();
}

function flushPendingFiles() {
  const wc = liveContents();
  if (!wc || listening.openFile <= 0) return;
  const files = pendingFiles.splice(0);
  for (const f of files) {
    readNativeFile(f)
      .then((nf) => {
        wc.send('open-file', nf);
        addRecent(f);
      })
      .catch((e) => dialog.showErrorBox('Could not open file', `${f}\n\n${errorText(e)}`));
  }
}

/* ============================================================== protocol */

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (!rel || rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    let body: Buffer;
    let served = file;
    try {
      body = await fsp.readFile(file);
    } catch {
      // single-page-app fallback for extension-less routes
      if (path.extname(file)) return new Response('Not found', { status: 404 });
      served = path.join(RENDERER_DIR, 'index.html');
      try {
        body = await fsp.readFile(served);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    const ext = path.extname(served).toLowerCase();
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    return new Response(new Uint8Array(body), { status: 200, headers });
  });
}

function isAppUrl(url: string): boolean {
  if (url.startsWith(APP_ORIGIN + '/')) return true;
  if (DEV_SERVER_URL) {
    try {
      return new URL(url).origin === new URL(DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  return false;
}

function isSafeExternal(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function hardenWebContents(contents: WebContents) {
  const guard = (e: { preventDefault(): void }, url: string) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', (e, url) => guard(e, url));
  contents.on('will-redirect', (e, url) => guard(e, url));
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'local-fonts', 'pointerLock', 'keyboardLock', 'window-management']);

function configureSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = details.requestingUrl || wc.getURL();
    cb(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && isAppUrl(origin.endsWith('/') ? origin : origin + '/'));
}

/* ================================================================ window */

function liveContents(): WebContents | null {
  return mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() ? mainWindow.webContents : null;
}

function restoredBounds(): WindowState {
  const def: WindowState = { width: 1440, height: 900 };
  const s = settings.window;
  if (!s) return def;
  const width = Math.max(960, Math.round(s.width));
  const height = Math.max(600, Math.round(s.height));
  if (s.x === undefined || s.y === undefined) return { width, height, maximized: s.maximized };
  // keep the window on a connected display
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return s.x! + 100 > a.x && s.y! + 40 > a.y && s.x! < a.x + a.width - 100 && s.y! < a.y + a.height - 40;
  });
  return visible ? { x: Math.round(s.x), y: Math.round(s.y), width, height, maximized: s.maximized } : { width, height, maximized: s.maximized };
}

function saveWindowState(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  const maximized = win.isMaximized() || win.isFullScreen();
  const b = maximized ? win.getNormalBounds() : win.getBounds();
  settings.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
  saveSettings();
}

function resetRendererState() {
  listening.menu = 0;
  listening.openFile = 0;
  listening.close = 0;
  listening.mcp = false;
}

/** Window icon for Linux (macOS / Windows use the bundle / exe icon). */
function linuxIcon(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  for (const p of [path.join(RENDERER_DIR, 'icon-512.png'), path.join(app.getAppPath(), 'build', 'icon.png')]) if (fs.existsSync(p)) return p;
  return undefined;
}

function createWindow() {
  const b = restoredBounds();
  const chrome = settings.chrome ?? { dark: true, background: BG_DARK, symbol: '#E8E8EC' };
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Alt',
    backgroundColor: chrome.background || BG_DARK,
    ...(linuxIcon() ? { icon: linuxIcon() } : {}),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: chrome.background, symbolColor: chrome.symbol, height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // MCP tool calls (screenshots, layout) must run promptly while the window is in the background
      backgroundThrottling: false,
      additionalArguments: [`--alt-version=${app.getVersion()}`],
    },
  });
  mainWindow = win;
  docEdited = false;
  forceClose = false;
  resetRendererState();
  if (!IS_MAC) win.setMenuBarVisibility(false);

  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (b.maximized) win.maximize();
    win.show();
  };
  win.once('ready-to-show', show);
  setTimeout(show, 4000); // never stay invisible if the renderer is slow / broken

  const wc = win.webContents;
  const wcId = wc.id;
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      resetRendererState();
      failPendingCalls(wcId, 'The Alt window reloaded while the tool was running. Please retry.');
    }
  });
  wc.on('render-process-gone', (_e, details) => {
    log('renderer gone', details.reason);
    resetRendererState();
    failPendingCalls(wcId, 'The Alt window crashed while the tool was running. Please retry.');
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.reload(), 500);
  });

  win.on('close', (e) => {
    const canAsk = docEdited && listening.close > 0 && !wc.isCrashed();
    if (forceClose || !canAsk) {
      saveWindowState(win);
      return;
    }
    e.preventDefault();
    quitAfterClose = quitRequested;
    quitRequested = false; // the prevented close cancels any quit in progress
    wc.send('close-request');
  });
  win.on('closed', () => {
    failPendingCalls(wcId, 'The Alt window was closed.');
    if (mainWindow === win) mainWindow = null;
    resetRendererState();
  });

  if (DEV_SERVER_URL) void win.loadURL(DEV_SERVER_URL);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);
  if (SHOW_DEVTOOLS && process.env.ALT_OPEN_DEVTOOLS === '1') wc.openDevTools({ mode: 'detach' });
  return win;
}

let quitAfterClose = false;

/* ================================================================== menu */

function sendMenuAction(action: string) {
  const wc = liveContents();
  if (wc && listening.menu > 0) {
    wc.send('menu:action', action);
    return;
  }
  pendingMenuActions.push(action);
  if (!mainWindow && app.isReady()) createWindow();
}

function flushMenuActions() {
  const wc = liveContents();
  if (!wc || listening.menu <= 0) return;
  for (const a of pendingMenuActions.splice(0)) wc.send('menu:action', a);
}

type Item = MenuItemConstructorOptions;
const sep: Item = { type: 'separator' };
function act(label: string, action: string, accelerator?: string): Item {
  return { label, accelerator, registerAccelerator: false, click: () => sendMenuAction(action) };
}

function buildMenu() {
  const recentItems: Item[] = recent.length
    ? [
        ...recent.slice(0, 12).map(
          (p): Item => ({
            label: path.basename(p),
            sublabel: path.dirname(p),
            click: () => openPaths([p]),
          }),
        ),
        sep,
        { label: 'Clear Recent', click: clearRecent },
      ]
    : [{ label: 'No Recent Files', enabled: false }];

  const appMenu: Item = {
    label: 'Alt',
    submenu: [
      { role: 'about' },
      sep,
      act('Settings…', 'app.settings', 'CmdOrCtrl+,'),
      act('AI Agents (MCP)…', 'help.mcp'),
      sep,
      { role: 'services' },
      sep,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      { role: 'quit' },
    ],
  };

  const fileMenu: Item = {
    label: 'File',
    submenu: [
      act('New', 'file.new', 'CmdOrCtrl+N'),
      act('Open…', 'file.open', 'CmdOrCtrl+O'),
      { label: 'Open Recent', submenu: recentItems },
      sep,
      act('Save', 'file.save', 'CmdOrCtrl+S'),
      act('Save As…', 'file.saveAs', 'CmdOrCtrl+Shift+S'),
      sep,
      act('Import…', 'file.import', 'CmdOrCtrl+Shift+K'),
      act('Export…', 'file.export', 'CmdOrCtrl+Shift+E'),
      sep,
      act('Close', 'file.close', 'CmdOrCtrl+W'),
      ...(IS_MAC ? [] : [sep, act('Settings…', 'app.settings', 'CmdOrCtrl+,'), sep, { role: 'quit', label: 'Exit' } as Item]),
    ],
  };

  const editMenu: Item = {
    label: 'Edit',
    submenu: [
      act('Undo', 'edit.undo', 'CmdOrCtrl+Z'),
      act('Redo', 'edit.redo', 'CmdOrCtrl+Shift+Z'),
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      act('Duplicate', 'edit.duplicate', 'CmdOrCtrl+D'),
      act('Delete', 'edit.delete', IS_MAC ? 'Backspace' : 'Delete'),
      sep,
      act('Select All', 'edit.selectAll', 'CmdOrCtrl+A'),
      act('Select None', 'edit.selectNone', 'Escape'),
      sep,
      act('Find…', 'edit.find', 'CmdOrCtrl+F'),
    ],
  };

  const viewMenu: Item = {
    label: 'View',
    submenu: [
      act('Command Palette…', 'app.commandPalette', 'CmdOrCtrl+/'),
      sep,
      act('Zoom In', 'view.zoomIn', 'CmdOrCtrl+='),
      act('Zoom Out', 'view.zoomOut', 'CmdOrCtrl+-'),
      act('Zoom to 100%', 'view.zoom100', 'Shift+0'),
      act('Zoom to Fit', 'view.zoomFit', 'Shift+1'),
      act('Zoom to Selection', 'view.zoomSelection', 'Shift+2'),
      sep,
      act('Show / Hide UI', 'view.toggleUI', 'CmdOrCtrl+\\'),
      act('Rulers', 'view.toggleRulers', 'Shift+R'),
      act('Pixel Grid', 'view.togglePixelGrid', "Shift+'"),
      sep,
      act('Present', 'view.present', 'CmdOrCtrl+Alt+Enter'),
      { role: 'togglefullscreen' },
      ...(SHOW_DEVTOOLS ? [sep, { role: 'reload' } as Item, { role: 'forceReload' } as Item, { role: 'toggleDevTools' } as Item] : []),
    ],
  };

  const objectMenu: Item = {
    label: 'Object',
    submenu: [
      act('Group Selection', 'object.group', 'CmdOrCtrl+G'),
      act('Ungroup', 'object.ungroup', 'CmdOrCtrl+Shift+G'),
      act('Frame Selection', 'object.frame', 'CmdOrCtrl+Alt+G'),
      act('Add Auto Layout', 'object.autoLayout', 'Shift+A'),
      sep,
      {
        label: 'Boolean',
        submenu: [act('Union', 'object.union'), act('Subtract', 'object.subtract'), act('Intersect', 'object.intersect'), act('Exclude', 'object.exclude')],
      },
      act('Flatten', 'object.flatten', 'CmdOrCtrl+E'),
      sep,
      act('Flip Horizontal', 'object.flipH', 'Shift+H'),
      act('Flip Vertical', 'object.flipV', 'Shift+V'),
    ],
  };

  const arrangeMenu: Item = {
    label: 'Arrange',
    submenu: [
      act('Bring to Front', 'object.bringFront', IS_MAC ? 'Alt+Cmd+]' : 'Ctrl+Shift+]'),
      act('Bring Forward', 'object.bringForward', 'CmdOrCtrl+]'),
      act('Send Backward', 'object.sendBackward', 'CmdOrCtrl+['),
      act('Send to Back', 'object.sendBack', IS_MAC ? 'Alt+Cmd+[' : 'Ctrl+Shift+['),
    ],
  };

  const windowMenu: Item = IS_MAC
    ? { role: 'windowMenu' }
    : {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { label: 'Maximize', click: () => mainWindow && (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()) },
          { role: 'close' },
        ],
      };

  const helpMenu: Item = {
    role: 'help',
    submenu: [
      act('Keyboard Shortcuts', 'app.shortcuts', 'CmdOrCtrl+Shift+/'),
      act('Connect AI Agents (MCP)…', 'help.mcp'),
      act('Documentation', 'help.docs'),
      sep,
      { label: 'Report an Issue…', click: () => void shell.openExternal(`${HOMEPAGE.replace(/\/$/, '')}/issues`) },
      ...(IS_MAC ? [] : [sep, { role: 'about' } as Item]),
    ],
  };

  const template: Item[] = [...(IS_MAC ? [appMenu] : []), fileMenu, editMenu, viewMenu, objectMenu, arrangeMenu, windowMenu, helpMenu];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* =================================================================== IPC */

function fromMain(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const wc = liveContents();
  if (!wc || e.sender.id !== wc.id) return false;
  const url = e.senderFrame?.url ?? '';
  return !url || isAppUrl(url);
}

function windowOf(e: IpcMainEvent | IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(e.sender) ?? mainWindow ?? undefined;
}

function registerIpc() {
  const handle = <A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => Promise<R> | R) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromMain(e)) throw new Error('Unauthorized sender');
      return fn(e, ...(args as A));
    });
  const on = <A extends unknown[]>(channel: string, fn: (e: IpcMainEvent, ...args: A) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (!fromMain(e)) return;
      try {
        fn(e, ...(args as A));
      } catch (err) {
        log(`ipc ${channel} failed`, err);
      }
    });

  /* ---- files */
  handle('dialog:open', async (e, opts: { filters?: unknown; binary?: boolean } = {}) => {
    const win = windowOf(e);
    const dialogOpts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: sanitizeFilters(opts.filters) };
    const r = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const nf = await readNativeFile(file, opts.binary ?? undefined);
    if (!opts.binary) addRecent(file);
    return nf;
  });

  handle('fs:read', async (_e, file: string, binary?: boolean) => {
    const nf = await readNativeFile(file, binary);
    if (!binary) addRecent(file);
    return nf;
  });

  handle(
    'dialog:save',
    async (e, opts: { path?: string | null; defaultName?: string; data: string | Uint8Array; filters?: unknown; saveAs?: boolean }) => {
      if (!opts || (typeof opts.data !== 'string' && !(opts.data instanceof Uint8Array))) throw new Error('saveFile: data must be a string or Uint8Array');
      const filters = sanitizeFilters(opts.filters);
      let target = typeof opts.path === 'string' && path.isAbsolute(opts.path) ? opts.path : null;
      if (!target || opts.saveAs) {
        const defaultName = String(opts.defaultName || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-');
        const defaultPath = target ?? path.join(lastDir ?? app.getPath('documents'), defaultName);
        const win = windowOf(e);
        const dialogOpts: Electron.SaveDialogOptions = { defaultPath, filters, properties: ['createDirectory', 'showOverwriteConfirmation'] };
        const r = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
        if (r.canceled || !r.filePath) return null;
        target = r.filePath;
        const wanted = filters[0]?.extensions[0];
        if (wanted && wanted !== '*' && !path.extname(target)) target += `.${wanted}`;
      }
      await writeAtomic(target, opts.data);
      lastDir = path.dirname(target);
      addRecent(target);
      return target;
    },
  );

  handle('recent:get', () => recent.filter((p) => fs.existsSync(p)));

  /* ---- window */
  on('window:set-title', (e, title: unknown) => {
    windowOf(e)?.setTitle(String(title ?? 'Alt').slice(0, 300));
  });
  on('window:set-edited', (e, edited: unknown) => {
    docEdited = !!edited;
    if (IS_MAC) windowOf(e)?.setDocumentEdited(docEdited);
  });
  on('window:set-chrome', (e, opts: { dark?: unknown; background?: unknown; symbol?: unknown }) => {
    const color = (v: unknown, fb: string) => (typeof v === 'string' && v.length <= 64 && /^[#a-zA-Z0-9(),.\s%]+$/.test(v) ? v : fb);
    const chrome = { dark: !!opts?.dark, background: color(opts?.background, BG_DARK), symbol: color(opts?.symbol, '#E8E8EC') };
    settings.chrome = chrome;
    saveSettings();
    const win = windowOf(e);
    if (!win) return;
    win.setBackgroundColor(chrome.background);
    if (!IS_MAC) {
      try {
        win.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol, height: TITLE_BAR_HEIGHT });
      } catch (err) {
        log('setTitleBarOverlay failed', err);
      }
    }
  });
  on('window:close-confirm', (e) => {
    const win = windowOf(e);
    if (!win) return;
    forceClose = true;
    win.close();
    if (quitAfterClose) {
      quitAfterClose = false;
      app.quit();
    }
  });
  on('menu:popup', (e, pos: { x?: unknown; y?: unknown } = {}) => {
    const win = windowOf(e);
    const menu = Menu.getApplicationMenu();
    if (!win || !menu) return;
    const x = Number(pos.x);
    const y = Number(pos.y);
    menu.popup({ window: win, ...(Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {}) });
  });

  /* ---- renderer subscriptions */
  on('renderer:listen', (_e, kind: unknown, active: unknown) => {
    const d = active ? 1 : -1;
    if (kind === 'menu') {
      listening.menu = Math.max(0, listening.menu + d);
      flushMenuActions();
    } else if (kind === 'open-file') {
      listening.openFile = Math.max(0, listening.openFile + d);
      flushPendingFiles();
    } else if (kind === 'close') {
      listening.close = Math.max(0, listening.close + d);
    } else if (kind === 'mcp') {
      listening.mcp = !!active;
      broadcastMcpStatus();
    }
  });

  /* ---- shell */
  on('shell:open-external', (_e, url: unknown) => {
    if (typeof url === 'string' && isSafeExternal(url)) void shell.openExternal(url);
  });
  on('shell:show-item', (_e, file: unknown) => {
    if (typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(file);
  });

  /* ---- MCP */
  handle('mcp:get-status', () => mcpStatus());
  handle('mcp:configure', async (_e, cfg: Partial<McpConfig>) => {
    settings.mcp = sanitizeMcp({ ...settings.mcp, ...(cfg ?? {}) });
    saveSettings();
    return applyMcpConfig();
  });
  ipcMain.on('mcp:result', (e, msg: { callId?: unknown; result?: unknown }) => {
    if (!msg || typeof msg.callId !== 'string') return;
    const p = pendingCalls.get(msg.callId);
    if (!p || p.wcId !== e.sender.id) return;
    pendingCalls.delete(msg.callId);
    clearTimeout(p.timer);
    p.resolve(sanitizeToolResult(msg.result));
  });
}

let lastDir: string | null = null;

/* ================================================================== MCP */

interface PendingCall {
  resolve(r: McpToolResult): void;
  timer: ReturnType<typeof setTimeout>;
  wcId: number;
}
const pendingCalls = new Map<string, PendingCall>();

function failPendingCalls(wcId: number, reason: string) {
  for (const [id, p] of pendingCalls) {
    if (p.wcId !== wcId) continue;
    pendingCalls.delete(id);
    clearTimeout(p.timer);
    p.resolve(toolError(reason));
  }
}

function sanitizeToolResult(r: unknown): McpToolResult {
  if (r && typeof r === 'object' && Array.isArray((r as McpToolResult).content)) {
    const res = r as McpToolResult;
    return { content: res.content.filter((c) => c && typeof c === 'object' && typeof c.type === 'string'), ...(res.isError ? { isError: true } : {}) };
  }
  return toolError('Alt returned an invalid tool result.');
}

const imageIO: ImageIO = {
  async fetchUrl(url, signal) {
    const r = await net.fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': `Alt/${app.getVersion()} (MCP image fetch)` } });
    const body = new Uint8Array(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type'), body };
  },
  readFile: (p) => fsp.readFile(p),
  fileSize: async (p) => (await fsp.stat(p)).size,
};

async function callRenderer(tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const wc = liveContents();
  if (!wc || !listening.mcp) {
    return toolError(
      mainWindow
        ? 'Alt is starting up and is not ready to run tools yet. Wait a few seconds and retry.'
        : 'Alt is running but its window is closed. Ask the user to open the Alt window (click the Dock / taskbar icon), then retry.',
    );
  }
  if ((IMAGE_SOURCE_TOOLS as readonly string[]).includes(tool)) args = await resolveImageSources(args, imageIO, os.homedir());
  const callId = randomUUID();
  return new Promise<McpToolResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve(toolError(`Timed out after ${MCP_CALL_TIMEOUT_MS / 1000}s waiting for Alt to run "${tool}".`));
    }, MCP_CALL_TIMEOUT_MS);
    pendingCalls.set(callId, { resolve, timer, wcId: wc.id });
    try {
      wc.send('mcp:call', { callId, tool, args });
    } catch (e) {
      clearTimeout(timer);
      pendingCalls.delete(callId);
      resolve(toolError(`Could not reach the Alt window: ${errorText(e)}`));
    }
  });
}

const mcpHandler = createMcpHandler({
  serverInfo: { name: 'alt', title: 'Alt', version: app.getVersion() },
  instructions: MCP_INSTRUCTIONS,
  listTools: () => getMcpTools({ allowScripts: settings.mcp.allowScripts }),
  unavailableToolMessage: (name) =>
    isScriptTool(name) ? `${name} is disabled. Ask the user to enable "Allow scripts" in Alt → Settings → MCP, then retry.` : undefined,
  callTool: callRenderer,
});

const mcpServer = new McpHttpServer({
  handleText: (text) => mcpHandler.handleText(text),
  health: () => ({ app: 'Alt', version: app.getVersion(), ready: !!liveContents() && listening.mcp, scripts: settings.mcp.allowScripts }),
  extraOrigins: [APP_ORIGIN],
  log,
});

let mcpError: string | undefined;
let stdioShimPath: string | undefined;

function stableExecPath(): string {
  // An AppImage runs from a temporary mount; the .AppImage file itself is the stable entry point.
  return process.env.APPIMAGE || process.execPath;
}

function mcpStatus(): McpStatus {
  const port = effectivePort();
  return {
    enabled: settings.mcp.enabled,
    running: mcpServer.running,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    allowScripts: settings.mcp.allowScripts,
    ...(mcpError ? { error: mcpError } : {}),
    ...(stdioShimPath ? { stdioShim: stdioShimPath } : {}),
    execPath: stableExecPath(),
  };
}

function broadcastMcpStatus() {
  liveContents()?.send('mcp:status', mcpStatus());
}

function describeListenError(e: unknown, port: number): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'EADDRINUSE') return `Port ${port} is already in use by another program (or another copy of Alt). Choose a different port.`;
  if (code === 'EACCES') return `Not allowed to listen on port ${port}. Choose a port above 1024.`;
  return `MCP server failed to start: ${errorText(e)}`;
}

let mcpApply: Promise<McpStatus> = Promise.resolve(null as unknown as McpStatus);
function applyMcpConfig(): Promise<McpStatus> {
  mcpApply = mcpApply.then(async () => {
    const port = effectivePort();
    mcpError = undefined;
    try {
      if (!settings.mcp.enabled) await mcpServer.stop();
      else if (!mcpServer.running || mcpServer.port !== port) {
        await mcpServer.start(port);
        log(`MCP server listening on http://127.0.0.1:${port}/mcp`);
      }
    } catch (e) {
      mcpError = describeListenError(e, port);
      log(mcpError);
    }
    broadcastMcpStatus();
    return mcpStatus();
  });
  return mcpApply;
}

/** Copy the stdio shim to a stable, user-writable location (survives app updates, AppImage mounts). */
function installStdioShim() {
  const devPath = path.join(app.getAppPath(), 'mcp', 'alt-mcp.mjs');
  if (!app.isPackaged) {
    stdioShimPath = fs.existsSync(devPath) ? devPath : undefined;
    return;
  }
  const bundled = path.join(process.resourcesPath, 'mcp', 'alt-mcp.mjs');
  const target = userFile(path.join('mcp', 'alt-mcp.mjs'));
  try {
    const src = fs.readFileSync(bundled);
    let same = false;
    try {
      same = fs.readFileSync(target).equals(src);
    } catch {
      /* missing */
    }
    if (!same) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, src);
    }
    stdioShimPath = target;
  } catch (e) {
    log('could not install stdio shim', e);
    stdioShimPath = fs.existsSync(bundled) ? bundled : undefined;
  }
}
