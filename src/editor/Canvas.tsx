import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { editor, getViewport, useEditor } from '../core/store';
import { renderPage } from '../render/renderer';
import { assets } from '../render/assets';
import { clearTextCaches } from '../core/text';
import { hitTest } from '../render/hit';
import { canvasBackground, resolvedTheme, useSettings } from './settings';
import { bindCanvas, ui, type PointerInfo, CURSORS } from './toolkit';
import { getTool } from './tools';
import { drawOverlay } from './overlay';
import { canvasSize, clampZoom, toWorld, zoomAt, zoomToFit, zoomToSelection } from './viewport';
import { pickTarget } from './tools/select';
import { sceneCanvasRef } from './tools/misc';
import { isMac } from '../platform/native';
import { importFileObjects } from './file';
import { TextEditor } from './TextEditor';
import { openContextMenu } from '../ui/ContextMenu';

export function Canvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState('default');
  const editing = useEditor((s) => s.editing);
  const dirty = useRef({ scene: true, overlay: true, raf: 0 });
  const marks = useRef({ scene: () => {}, overlay: () => {} });

  // ---------------------------------------------------------------- render loop
  useEffect(() => {
    const d = dirty.current;
    const frame = () => {
      d.raf = 0;
      const scene = sceneRef.current;
      const overlay = overlayRef.current;
      if (!scene || !overlay) return;
      const dpr = window.devicePixelRatio || 1;
      const s = editor();
      const v = getViewport(s);
      const settings = useSettings.getState();
      if (d.scene) {
        d.scene = false;
        const ctx = scene.getContext('2d')!;
        const skip = s.editing?.kind === 'text' ? new Set([s.editing.id]) : undefined;
        renderPage(ctx, s.doc, s.pageId, {
          panX: v.x,
          panY: v.y,
          zoom: v.zoom,
          dpr,
          background: canvasBackground(),
          skip,
          outline: settings.outlineMode,
          outlineColor: resolvedTheme() === 'dark' ? '#9A9AA6' : '#55555F',
        });
      }
      if (d.overlay) {
        d.overlay = false;
        const ctx = overlay.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const tool = getTool(s.tool);
        drawOverlay(ctx, overlay.width / dpr, overlay.height / dpr, tool.overlay?.bind(tool));
      }
    };
    const schedule = () => {
      if (!d.raf) d.raf = requestAnimationFrame(frame);
    };
    const markScene = () => {
      d.scene = true;
      d.overlay = true;
      schedule();
    };
    const markOverlay = () => {
      d.overlay = true;
      schedule();
    };
    marks.current = { scene: markScene, overlay: markOverlay };
    bindCanvas({ overlay: markOverlay, scene: markScene, cursor: setCursor });
    const unsubs = [
      useEditor.subscribe((s, p) => {
        if (s.doc !== p.doc || s.pageId !== p.pageId || s.viewports !== p.viewports || s.editing !== p.editing) markScene();
        else if (s.selection !== p.selection || s.hoverId !== p.hoverId || s.vectorSel !== p.vectorSel || s.tool !== p.tool || s.toolOptions !== p.toolOptions) markOverlay();
      }),
      useSettings.subscribe(markScene),
      assets.onChange(markScene),
    ];
    const onFonts = () => {
      clearTextCaches();
      markScene();
    };
    document.fonts?.addEventListener?.('loadingdone', onFonts);
    markScene();
    return () => {
      unsubs.forEach((u) => u());
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      cancelAnimationFrame(d.raf);
    };
  }, []);

  // ------------------------------------------------------------------- sizing
  useLayoutEffect(() => {
    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const prevW = canvasSize.width;
      const prevH = canvasSize.height;
      canvasSize.width = r.width;
      canvasSize.height = r.height;
      canvasSize.left = r.left;
      canvasSize.top = r.top;
      for (const c of [sceneRef.current!, overlayRef.current!]) {
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
        c.style.width = r.width + 'px';
        c.style.height = r.height + 'px';
      }
      // keep the view centred while panels resize
      const s = editor();
      if (s.viewports[s.pageId] && prevW > 1) {
        const v = getViewport();
        s.setViewport({ x: v.x + (r.width - prevW) / 2, y: v.y + (r.height - prevH) / 2 });
      }
      marks.current.scene();
    });
    ro.observe(wrap);
    sceneCanvasRef.current = sceneRef.current;
    return () => ro.disconnect();
  }, []);

  // first view of a page → fit its content
  const pageId = useEditor((s) => s.pageId);
  useEffect(() => {
    const s = editor();
    if (!s.viewports[pageId]) {
      requestAnimationFrame(() => {
        const st = editor();
        const page = st.doc.pages.find((p) => p.id === st.pageId);
        if (page && page.children.length) zoomToFit();
        else st.setViewport({ x: Math.round(canvasSize.width / 2), y: Math.round(canvasSize.height / 2), zoom: 1 });
      });
    }
  }, [pageId]);

  // external zoom requests (MCP, menus)
  useEffect(() => {
    const onZoom = (e: Event) => {
      const ids = (e as CustomEvent).detail?.ids as string[] | 'fit' | undefined;
      if (!ids || ids === 'fit' || !ids.length) zoomToFit();
      else zoomToSelection(ids);
    };
    window.addEventListener('alt:zoom-to', onZoom);
    return () => window.removeEventListener('alt:zoom-to', onZoom);
  }, []);

  // ------------------------------------------------------------------ pointer
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const clicks = useRef({ t: 0, x: 0, y: 0, n: 0 });

  function info(e: PointerEvent | MouseEvent | React.PointerEvent): PointerInfo {
    const r = overlayRef.current!.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const pe = e as PointerEvent;
    return {
      screen,
      world: toWorld(screen),
      button: e.button,
      buttons: e.buttons,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: isMac ? e.metaKey : e.ctrlKey,
      pressure: pe.pressure ?? 0.5,
      pointerType: pe.pointerType ?? 'mouse',
      clickCount: clicks.current.n,
      event: (e as any).nativeEvent ?? e,
    };
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const el = overlayRef.current!;
    el.focus({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && ui.spaceDown)) {
      e.preventDefault();
      const v = getViewport();
      pan.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y };
      el.setPointerCapture(e.pointerId);
      setCursor(CURSORS.grabbing);
      return;
    }
    if (e.button === 2) return;
    el.setPointerCapture(e.pointerId);
    const now = performance.now();
    const c = clicks.current;
    if (now - c.t < 380 && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 6) c.n++;
    else c.n = 1;
    c.t = now;
    c.x = e.clientX;
    c.y = e.clientY;
    const p = info(e);
    const tool = getTool(editor().tool);
    if (c.n === 2 && tool.dblclick) {
      tool.dblclick(p);
      return;
    }
    tool.down?.(p);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      editor().setViewport({ x: pan.current.vx + e.clientX - pan.current.x, y: pan.current.vy + e.clientY - pan.current.y });
      return;
    }
    const p = info(e);
    ui.pointerWorld = p.world;
    ui.pointerScreen = p.screen;
    ui.altDown = e.altKey;
    const tool = getTool(editor().tool);
    if (ui.spaceDown) setCursor(CURSORS.hand);
    else if (editor().tool !== 'move' && editor().tool !== 'scale') setCursor(typeof tool.cursor === 'function' ? tool.cursor() : tool.cursor ?? 'default');
    tool.move?.(p);
    marks.current.overlay();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const el = overlayRef.current!;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (pan.current) {
      pan.current = null;
      setCursor(ui.spaceDown ? CURSORS.hand : 'default');
      return;
    }
    if (e.button === 2) return;
    getTool(editor().tool).up?.(info(e));
  };

  const onPointerLeave = () => {
    ui.pointerWorld = null;
    if (!ui.dragging) editor().setHover(null);
  };

  // wheel / pinch
  useEffect(() => {
    const el = overlayRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const v = getViewport();
      const settings = useSettings.getState();
      const pinch = e.ctrlKey && !isMac ? Math.abs(e.deltaY) < 40 : e.ctrlKey;
      const zoomGesture = e.ctrlKey || e.metaKey || (settings.wheelZoom && !e.shiftKey);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (zoomGesture) {
        const k = pinch ? 0.012 : 0.0022;
        const dir = settings.invertZoom ? -1 : 1;
        zoomAt(screen, clampZoom(v.zoom * Math.exp(-e.deltaY * unit * k * dir)));
        return;
      }
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      editor().setViewport({ x: v.x - dx, y: v.y - dy });
    };
    // Safari-style gesture events (macOS trackpads in some engines)
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const s = editor();
    const p = info(e);
    const chain = hitTest(s.doc, s.pageId, p.world, getViewport().zoom);
    const target = pickTarget(s.doc, chain, p.mod) ?? chain[chain.length - 1] ?? null;
    if (target && !s.selection.includes(target)) s.setSelection([target]);
    if (!target && !s.selection.length) s.setSelection([]);
    openContextMenu(e.clientX, e.clientY, !!(target || s.selection.length));
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    const r = overlayRef.current!.getBoundingClientRect();
    await importFileObjects(files, toWorld({ x: e.clientX - r.left, y: e.clientY - r.top }));
  };

  const tool = useEditor((s) => s.tool);
  useEffect(() => {
    const t = getTool(tool);
    setCursor(typeof t.cursor === 'function' ? t.cursor() : t.cursor ?? 'default');
    t.activate?.();
    dirty.current.overlay = true;
  }, [tool]);

  return (
    <div className="canvas-wrap" ref={wrapRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <canvas ref={sceneRef} className="canvas-scene" />
      <canvas
        ref={overlayRef}
        className="canvas-overlay"
        tabIndex={0}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
      />
      {editing?.kind === 'text' && <TextEditor key={editing.id} id={editing.id} isNew={!!editing.isNew} />}
    </div>
  );
}
