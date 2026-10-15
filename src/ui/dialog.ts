import { create } from 'zustand';

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogRequest {
  id: number;
  title: string;
  message?: string;
  buttons: DialogButton[];
  input?: { value: string; placeholder?: string };
  resolve: (v: { button: string; input?: string }) => void;
}

interface DialogStore {
  current: DialogRequest | null;
  open(r: Omit<DialogRequest, 'id' | 'resolve'>): Promise<{ button: string; input?: string }>;
  close(button: string, input?: string): void;
}

let seq = 1;

export const useDialog = create<DialogStore>()((set, get) => ({
  current: null,
  open(r) {
    return new Promise((resolve) => {
      get().current?.resolve({ button: 'cancel' });
      set({ current: { ...r, id: seq++, resolve } });
    });
  },
  close(button, input) {
    const c = get().current;
    set({ current: null });
    c?.resolve({ button, input });
  },
}));

export async function confirmDialog(title: string, message: string, ok = 'OK', danger = false): Promise<boolean> {
  const r = await useDialog.getState().open({
    title,
    message,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: ok, value: 'ok', primary: !danger, danger },
    ],
  });
  return r.button === 'ok';
}

export async function promptDialog(title: string, value: string, placeholder?: string): Promise<string | null> {
  const r = await useDialog.getState().open({
    title,
    input: { value, placeholder },
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  return r.button === 'ok' ? (r.input ?? '') : null;
}
