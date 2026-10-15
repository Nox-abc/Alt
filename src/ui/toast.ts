import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  color?: string;
  action?: { label: string; run: () => void };
}

interface ToastStore {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>, ms?: number): void;
  dismiss(id: number): void;
}

let seq = 1;

export const useToasts = create<ToastStore>()((set, get) => ({
  toasts: [],
  push(t, ms = 2600) {
    const id = seq++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function toast(text: string, opts: { kind?: Toast['kind']; color?: string; action?: Toast['action']; ms?: number } = {}) {
  useToasts.getState().push({ text, kind: opts.kind ?? 'info', color: opts.color, action: opts.action }, opts.ms);
}
