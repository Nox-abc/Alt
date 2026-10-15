/**
 * Exporter registry.
 *
 * `EXPORTERS` lists every available exporter in menu order. Each exporter
 * receives an `ExportContext` whose `ids` are the roots to export (use
 * `exportRoots` to resolve a selection) and returns the files to write.
 */
import type { Doc, ID } from '../core/types';
import type { Exporter } from './types';
import { resolveRoots } from './util';
import { jpgExporter, pngExporter, webpExporter } from './raster';
import { svgExporter } from './svg';
import { pdfExporter } from './pdf';
import { htmlExporter } from './html';
import { reactExporter, tailwindExporter } from './react';
import { composeExporter, flutterExporter, swiftUIExporter } from './native';
import { luauExporter, rbxmxExporter } from './roblox';
import { godotExporter } from './godot';
import { cssVariablesExporter, jsonExporter, tokensExporter, unityExporter, vectorDrawableExporter } from './data';

export const EXPORTERS: Exporter[] = [
  // Image
  pngExporter,
  jpgExporter,
  webpExporter,
  // Vector
  svgExporter,
  pdfExporter,
  // Web
  htmlExporter,
  reactExporter,
  tailwindExporter,
  // Native
  swiftUIExporter,
  flutterExporter,
  composeExporter,
  vectorDrawableExporter,
  // Game engines
  rbxmxExporter,
  luauExporter,
  godotExporter,
  unityExporter,
  // Data
  jsonExporter,
  tokensExporter,
  cssVariablesExporter,
];

export function getExporter(id: string): Exporter | undefined {
  return EXPORTERS.find((e) => e.id === id);
}

/**
 * Roots for an export: the selection reduced to top-level nodes sorted back
 * → front, or every visible child of the page when nothing is selected.
 */
export function exportRoots(doc: Doc, pageId: ID, ids: ID[]): ID[] {
  return resolveRoots(doc, pageId, ids);
}

export type { ExportContext, ExportFile, ExportGroup, ExportOption, Exporter, RasterOptions } from './types';
