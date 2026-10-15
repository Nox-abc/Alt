import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { editor } from '../core/store';
import { ChevronDown, Check, ChevronRight } from './icons';
import type { MenuItem } from './uiStore';
import { runAction, shortcutLabel } from '../editor/actions';

/* ================================================================= tooltip */

/**
 * Global tooltip layer: any element with `data-tip` (and optional `data-key`)
 * gets a polished tooltip. Moving between tooltipped elements is instant.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; key?: string; x: number; y: number; below: boolean } | null>(null);
  useEffect(() => {
    let timer = 0;
    let lastHide = 0;
    let current: HTMLElement | null = null;
    const show = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const below = r.top < 60 || el.dataset.tipPos === 'below';
      setTip({ text: el.dataset.tip!, key: el.dataset.key, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === current) return;
      clearTimeout(timer);
      current = el;
      if (!el || !el.dataset.tip) {
        if (tip !== null) lastHide = performance.now();
        setTip(null);
        return;
      }
      const warm = performance.now() - lastHide < 400;
      timer = window.setTimeout(() => show(el), warm ? 0 : 480);
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      lastHide = performance.now();
      setTip(null);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('blur', hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const w = ref.current.offsetWidth;
    setLeft(Math.max(6, Math.min(window.innerWidth - w - 6, tip.x - w / 2)));
  }, [tip]);
  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" style={{ left, top: tip.y, transform: tip.below ? undefined : 'translateY(-100%)' }}>
      <span>{tip.text}</span>
      {tip.key && <kbd>{tip.key}</kbd>}
    </div>,
    document.body,
  );
}

/* ================================================================= popover */

export function Popover({
  anchor,
  onClose,
  children,
  className = '',
  placement = 'bottom-start',
  offset = 6,
  width,
}: {
  anchor: DOMRect | { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  className?: string;
  placement?: 'bottom-start' | 'bottom-end' | 'left' | 'right' | 'top' | 'point';
  offset?: number;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>({ left: -9999, top: -9999, origin: 'top left' });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = 0;
    let top = 0;
    let origin = 'top left';
    if ('width' in anchor) {
      const a = anchor;
      switch (placement) {
        case 'bottom-end':
          left = a.right - w;
          top = a.bottom + offset;
          origin = 'top right';
          break;
        case 'left':
          left = a.left - w - offset;
          top = a.top;
          origin = 'top right';
          break;
        case 'right':
          left = a.right + offset;
          top = a.top;
          break;
        case 'top':
          left = a.left + a.width / 2 - w / 2;
          top = a.top - h - offset;
          origin = 'bottom center';
          break;
        default:
          left = a.left;
          top = a.bottom + offset;
      }
    } else {
      left = anchor.x;
      top = anchor.y;
    }
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = Math.max(8, ('width' in anchor && placement.startsWith('bottom') ? anchor.top - h - offset : vh - h - 8));
    if (top < 8) top = 8;
    setPos({ left, top, origin });
  }, [anchor, placement, offset]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.('.popover')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const id = setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={{ left: pos.left, top: pos.top, width, ['--origin' as any]: pos.origin }} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

/* ==================================================================== menu */

export function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [focus, setFocus] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  const actionable = items.map((it, i) => (!it.separator && !it.disabled && it.label ? i : -1)).filter((i) => i >= 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const cur = actionable.indexOf(focus);
        const next = e.key === 'ArrowDown' ? actionable[(cur + 1) % actionable.length] : actionable[(cur - 1 + actionable.length) % actionable.length];
        setFocus(next ?? -1);
      } else if (e.key === 'Enter' && focus >= 0) {
        e.preventDefault();
        e.stopPropagation();
        activate(items[focus]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const activate = (it: MenuItem) => {
    if (it.disabled || it.submenu) return;
    onClose();
    if (it.run) it.run();
    else if (it.action) runAction(it.action);
  };
  return (
    <>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-sep" />;
        if (!it.label && !it.submenu) return null;
        const short = it.shortcut ?? (it.action ? shortcutLabel(it.action) : '');
        return (
          <div
            key={i}
            className={`menu-item${it.disabled ? ' disabled' : ''}${focus === i ? ' focus' : ''}${it.danger ? ' danger' : ''}`}
            onPointerEnter={(e) => {
              setFocus(i);
              if (it.submenu) setSub({ index: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
              else setSub(null);
            }}
            onClick={() => activate(it)}
          >
            <span className="mi-icon">{it.checked ? <Check size={14} /> : null}</span>
            <span className="mi-label">{it.label}</span>
            {short && <span className="mi-short">{short}</span>}
            {it.submenu && <ChevronRight size={14} className="mi-short" />}
          </div>
        );
      })}
      {sub && items[sub.index]?.submenu && (
        <Popover anchor={sub.rect} placement="right" offset={4} onClose={() => setSub(null)}>
          <MenuList items={items[sub.index].submenu!} onClose={onClose} />
        </Popover>
      )}
    </>
  );
}

/* =========================================================== number field */

function evalExpr(input: string, current: number): number | null {
  const s = input.trim().replace(/,/g, '.').replace(/px|%|°/g, '');
  if (!s) return null;
  if (!/^[\d+\-*/().\s]+$/.test(s)) return null;
  try {
    // relative edits: "+10", "*2"
    const expr = /^[+*/]/.test(s) ? `${current}${s}` : s;
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${expr})`)();
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function NumberField({
  value,
  onChange,
  label,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 2,
  suffix,
  tip,
  scale = 1,
  className = '',
  width,
}: {
  value: number | 'mixed';
  onChange: (v: number) => void;
  label?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  tip?: string;
  /** display multiplier (e.g. 100 for opacity shown as %) */
  scale?: number;
  className?: string;
  width?: number;
}) {
  const fmt = (v: number) => String(+(v * scale).toFixed(precision));
  const [text, setText] = useState(value === 'mixed' ? '' : fmt(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === 'mixed' ? '' : fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);
  const clampV = (v: number) => Math.max(min, Math.min(max, v));
  const commit = () => {
    const cur = value === 'mixed' ? 0 : value * scale;
    const v = evalExpr(text, cur);
    if (v === null) {
      setText(value === 'mixed' ? '' : fmt(value));
      return;
    }
    onChange(clampV(v / scale));
  };
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = value === 'mixed' ? 0 : value;
    let moved = false;
    editor().begin('Scrub');
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 2) return;
      moved = true;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const v = start + (Math.round(dx / 2) * step * mult) / scale;
      onChange(clampV(+v.toFixed(precision + 2)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      editor().commit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <label className={`field ${label === undefined ? 'no-prefix' : ''} ${value === 'mixed' ? 'mixed' : ''} ${className}`} data-tip={tip} style={width ? { width } : undefined}>
      {label !== undefined && (
        <span className="prefix" onPointerDown={scrub}>
          {label}
        </span>
      )}
      <input
        value={text}
        placeholder={value === 'mixed' ? 'Mixed' : ''}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(value === 'mixed' ? '' : fmt(value));
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const cur = evalExpr(text, 0) ?? (value === 'mixed' ? 0 : value * scale);
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const next = clampV((cur + d) / scale);
            setText(fmt(next));
            onChange(next);
          }
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </label>
  );
}

/* ================================================================= select */

export interface Option<T extends string | number> {
  value: T;
  label: string;
  icon?: ReactNode;
  hint?: string;
  separatorBefore?: boolean;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className = '',
  placeholder = 'Mixed',
  icon,
  tip,
  style,
  ghost,
}: {
  value: T | 'mixed' | null;
  options: Option<T>[];
  onChange: (v: T) => void;
  className?: string;
  placeholder?: string;
  icon?: ReactNode;
  tip?: string;
  style?: React.CSSProperties;
  ghost?: boolean;
}) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  const cur = options.find((o) => o.value === value);
  return (
    <>
      <button
        className={`select ${ghost ? 'ghost' : ''} ${className}`}
        data-tip={tip}
        style={style}
        onClick={(e) => setOpen((e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        {icon ?? cur?.icon}
        <span className="value">{cur?.label ?? placeholder}</span>
        <ChevronDown size={13} className="chev" />
      </button>
      {open && (
        <Popover anchor={open} onClose={() => setOpen(null)} width={Math.max(open.width, 160)}>
          <MenuList
            onClose={() => setOpen(null)}
            items={options.flatMap((o) => [
              ...(o.separatorBefore ? [{ separator: true } as MenuItem] : []),
              { label: o.label, checked: o.value === value, shortcut: o.hint, run: () => onChange(o.value) },
            ])}
          />
        </Popover>
      )}
    </>
  );
}

/* ============================================================= segmented */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T | null;
  options: { value: T; label?: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`}>
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} data-tip={o.tip} onClick={() => onChange(o.value)}>
          {o.label ?? o.value}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, tip }: { on: boolean; onChange: (v: boolean) => void; tip?: string }) {
  return <button className={`switch ${on ? 'on' : ''}`} data-tip={tip} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

/* ================================================================ section */

export function Section({
  title,
  actions,
  children,
  empty,
  onHeaderClick,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  empty?: boolean;
  onHeaderClick?: () => void;
}) {
  return (
    <div className={`section ${empty ? 'empty-section' : ''}`}>
      <div className="section-head" onClick={onHeaderClick}>
        <span className="title">{title}</span>
        {actions && (
          <span className="actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {!empty && children}
    </div>
  );
}

export function IconButton({
  icon,
  tip,
  action,
  onClick,
  active,
  disabled,
  size = 'md',
  className = '',
  keyHint,
}: {
  icon: ReactNode;
  tip?: string;
  action?: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  size?: 'md' | 'sm' | 'xs';
  className?: string;
  keyHint?: string;
}) {
  const key = keyHint ?? (action ? shortcutLabel(action) : undefined);
  return (
    <button
      className={`icon-btn ${size !== 'md' ? size : ''} ${active ? 'active' : ''} ${className}`}
      data-tip={tip}
      data-key={key || undefined}
      disabled={disabled}
      onClick={(e) => {
        if (onClick) onClick(e);
        else if (action) runAction(action);
      }}
    >
      {icon}
    </button>
  );
}

/** Drag-to-resize helper for panels. */
export function useDrag(onMove: (dx: number, dy: number) => void, onEnd?: () => void) {
  return (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const move = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy);
    const up = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
}
