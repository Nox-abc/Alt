import { create } from 'zustand';
import type { ID } from '../core/types';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: string;
  run?: () => void;
  disabled?: boolean;
  checked?: boolean;
  submenu?: MenuItem[];
  separator?: boolean;
  danger?: boolean;
}

interface UIState {
  palette: boolean;
  paletteQuery: string;
  settings: string | null;
  exportOpen: boolean;
  present: boolean;
  presentIndex: number;
  contextMenu: { x: number; y: number; items: MenuItem[] } | null;
  appMenu: boolean;
  leftTab: 'layers' | 'assets';
  rightTab: 'design' | 'export' | 'code';
  renaming: ID | null;
  uiHidden: boolean;
  set(p: Partial<Omit<UIState, 'set'>>): void;
}

export const useUI = create<UIState>()((set) => ({
  palette: false,
  paletteQuery: '',
  settings: null,
  exportOpen: false,
  present: false,
  presentIndex: 0,
  contextMenu: null,
  appMenu: false,
  leftTab: 'layers',
  rightTab: 'design',
  renaming: null,
  uiHidden: false,
  set(p) {
    set(p);
  },
}));

export const ui = () => useUI.getState();
