#!/usr/bin/env node
/**
 * Bundle the Electron main process and preload with esbuild.
 *
 *   electron/main.ts    → dist-electron/main.cjs
 *   electron/preload.ts → dist-electron/preload.cjs
 *
 * Usage: node scripts/build-electron.mjs [--dev] [--watch]
 * Also importable: `buildElectron({ dev, watch, onRebuild })` (used by scripts/dev.mjs).
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist-electron');

/** @param {{ dev?: boolean, watch?: boolean, onRebuild?: (result: esbuild.BuildResult) => void }} [opts] */
export async function buildElectron(opts = {}) {
  const dev = !!opts.dev;
  fs.mkdirSync(outdir, { recursive: true });

  /** @type {esbuild.Plugin} */
  const notify = {
    name: 'alt-notify',
    setup(build) {
      let first = true;
      build.onEnd((result) => {
        const errors = result.errors.length;
        if (!first || opts.watch) {
          const stamp = new Date().toLocaleTimeString();
          console.log(errors ? `[electron] build failed (${errors} error${errors > 1 ? 's' : ''}) ${stamp}` : `[electron] built main + preload ${stamp}`);
        }
        first = false;
        opts.onRebuild?.(result);
      });
    },
  };

  /** @type {esbuild.BuildOptions} */
  const options = {
    absWorkingDir: root,
    entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    keepNames: true,
    legalComments: 'none',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
    plugins: [notify],
  };

  if (opts.watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return ctx;
  }
  const result = await esbuild.build(options);
  if (result.errors.length) throw new Error('electron build failed');
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dev = process.argv.includes('--dev');
  const watch = process.argv.includes('--watch');
  buildElectron({ dev, watch })
    .then(() => {
      if (!watch) console.log(`[electron] dist-electron/main.cjs + preload.cjs (${dev ? 'development' : 'production'})`);
    })
    .catch((e) => {
      console.error(e.message ?? e);
      process.exit(1);
    });
}
