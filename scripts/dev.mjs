#!/usr/bin/env node
/**
 * Development runner:
 *   1. starts the Vite dev server (renderer, HMR) on :5173
 *   2. builds electron/main.ts + preload.ts with esbuild in watch mode
 *   3. launches Electron with VITE_DEV_SERVER_URL and restarts it whenever
 *      main / preload are rebuilt
 * Closing the app window or Ctrl+C stops everything.
 *
 * Extra args after `--` are passed to Electron, e.g. `npm run dev -- ./file.alt`.
 * Env: ALT_OPEN_DEVTOOLS=1 opens DevTools on start, ALT_MCP_PORT overrides the MCP port.
 */
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildElectron } from './build-electron.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
/** @type {string} path of the electron binary */
const electronBin = require('electron');
const passthrough = (() => {
  const i = process.argv.indexOf('--');
  return i >= 0 ? process.argv.slice(i + 1) : process.argv.slice(2);
})();

let vite;
let esbuildCtx;
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let restarting = false;
let shuttingDown = false;
let restartTimer = null;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  await killElectron();
  await esbuildCtx?.dispose().catch(() => {});
  await vite?.close().catch(() => {});
  process.exit(code);
}

function killElectron() {
  return new Promise((resolve) => {
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return resolve();
    const force = setTimeout(() => c.kill('SIGKILL'), 3000);
    c.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

function startElectron(url) {
  const env = { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, ['.', ...passthrough], { cwd: root, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (restarting || shuttingDown) return;
    console.log(`[dev] electron exited (${signal ?? code}); stopping dev server`);
    void shutdown(code ?? 0);
  });
}

async function restartElectron(url) {
  restarting = true;
  await killElectron();
  restarting = false;
  if (!shuttingDown) startElectron(url);
}

async function main() {
  vite = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port: 5173, strictPort: true } });
  await vite.listen();
  const url = vite.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';
  console.log(`[dev] renderer at ${url}`);

  let started = false;
  esbuildCtx = await buildElectron({
    dev: true,
    watch: true,
    onRebuild(result) {
      if (result.errors.length) return; // keep the running app until the code compiles again
      if (!started) {
        started = true;
        startElectron(url);
        return;
      }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        console.log('[dev] main / preload changed — restarting Electron');
        void restartElectron(url);
      }, 150);
    },
  });
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGHUP', () => void shutdown(0));

main().catch((e) => {
  console.error('[dev] failed to start:', e);
  void shutdown(1);
});
