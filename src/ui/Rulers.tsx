import { useEffect, useRef } from 'react';
import { editor, getViewport, useEditor } from '../core/store';
import { selectionBounds } from '../core/geometry';
import { uid, getPage } from '../core/doc';
import { canvasSize } from '../editor/viewport';
import { useSettings } from '../editor/settings';

function niceStep(zoom: number) {
  const target = 80 / zoom;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (pow * m >= target) return pow * m;
  return pow * 10;
}

function Ruler({ axis }: { axis: 'h' | 'v' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const vp = useEditor((s) => s.viewports[s.pageId]);
  const sel = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  const accent = useSettings((s) => s.accent);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const dpr = devicePixelRatio || 1;
      const r = c.parentElement!.getBoundingClientRect();
      const len = axis === 'h' ? r.width : r.height;
      c.width = Math.round((axis === 'h' ? len : 20) * dpr);
      c.height = Math.round((axis === 'h' ? 20 : len) * dpr);
      c.style.width = `${axis === 'h' ? len : 20}px`;
      c.style.height = `${axis === 'h' ? 20 : len}px`;
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const v = getViewport();
      const offset = 20; // ruler thickness: canvas origin sits after the corner
      const origin = axis === 'h' ? v.x - offset : v.y - offset;
      const step = niceStep(v.zoom);
      const style = getComputedStyle(document.documentElement);
      const fg = style.getPropertyValue('--text-3') || '#888';
      // selection band
      const b = selectionBounds(doc, sel);
      if (b) {
        const a0 = (axis === 'h' ? b.x : b.y) * v.zoom + origin;
        const a1 = (axis === 'h' ? b.x + b.width : b.y + b.height) * v.zoom + origin;
        ctx.fillStyle = accent + '33';
        if (axis === 'h') ctx.fillRect(a0, 0, a1 - a0, 20);
        else ctx.fillRect(0, a0, 20, a1 - a0);
      }
      ctx.strokeStyle = fg;
      ctx.fillStyle = fg;
      ctx.lineWidth = 1;
      ctx.font = '9.5px Inter Variable, Inter, system-ui';
      const start = Math.floor(-origin / v.zoom / step) * step;
      const end = (len - origin) / v.zoom;
      ctx.beginPath();
      for (let w = start; w <= end; w += step / 5) {
        const p = Math.round(w * v.zoom + origin) + 0.5;
        const major = Math.abs(w / step - Math.round(w / step)) < 1e-6;
        const t = major ? 8 : 4;
        if (axis === 'h') {
          ctx.moveTo(p, 20);
          ctx.lineTo(p, 20 - t);
        } else {
          ctx.moveTo(20, p);
          ctx.lineTo(20 - t, p);
        }
        if (major) {
          const label = String(Math.round(w));
          if (axis === 'h') ctx.fillText(label, p + 3, 10);
          else {
            ctx.save();
            ctx.translate(10, p - 3);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(label, 0, 0);
            ctx.restore();
          }
        }
      }
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c.parentElement!);
    return () => ro.disconnect();
  }, [vp, sel, doc, axis, accent]);
  const onDown = (e: React.PointerEvent) => {
    // drag out a guide
    const s = editor();
    const id = uid();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    s.begin('Guide');
    const axisKey: 'x' | 'y' = axis === 'h' ? 'y' : 'x';
    const valueAt = (ev: PointerEvent | React.PointerEvent) => {
      const v = getViewport();
      return axisKey === 'y' ? Math.round((ev.clientY - canvasSize.top - v.y) / v.zoom) : Math.round((ev.clientX - canvasSize.left - v.x) / v.zoom);
    };
    s.mutate((d) => void getPage(d, s.pageId)!.guides.push({ id, axis: axisKey, value: valueAt(e) }), { history: false });
    const move = (ev: PointerEvent) =>
      editor().mutate(
        (d) => {
          const g = getPage(d, s.pageId)!.guides.find((x) => x.id === id);
          if (g) g.value = valueAt(ev);
        },
        { history: false },
      );
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      // dropping back on the ruler removes the guide
      const r = el.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) editor().cancel();
      else editor().commit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className={`ruler ${axis}`} onPointerDown={onDown} data-tip={axis === 'h' ? 'Drag to add a horizontal guide' : 'Drag to add a vertical guide'} data-tip-pos="below">
      <canvas ref={ref} />
    </div>
  );
}

export function Rulers() {
  const show = useSettings((s) => s.showRulers);
  if (!show) return null;
  return (
    <>
      <div className="ruler-corner" />
      <Ruler axis="h" />
      <Ruler axis="v" />
    </>
  );
}
