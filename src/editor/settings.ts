import { create } from 'zustand';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface Settings {
  theme: ThemeMode;
  accent: string;
  /** UI zoom factor */
  uiScale: number;
  /** canvas background overrides (empty = theme default) */
  canvasDark: string;
  canvasLight: string;
  toolbarPosition: 'bottom' | 'top';
  showRulers: boolean;
  showPixelGrid: boolean;
  snapToPixels: boolean;
  snapToObjects: boolean;
  snapToGrid: boolean;
  gridSize: number;
  showFrameLabels: boolean;
  nudge: number;
  bigNudge: number;
  /** mouse wheel zooms instead of scrolling */
  wheelZoom: boolean;
  invertZoom: boolean;
  outlineMode: boolean;
  reduceMotion: boolean;
  /** user overrides: action id → shortcut (e.g. "Mod+Shift+K") */
  keymap: Record<string, string>;
  recent: string[];
  mcp: { enabled: boolean; port: number; allowScripts: boolean };
  showLeftPanel: boolean;
  showRightPanel: boolean;
  leftWidth: number;
  rightWidth: number;
  autosave: boolean;
  fontList: string[];
}

export const ACCENTS = ['#7C6CFF', '#0D99FF', '#14AE5C', '#F24E1E', '#FF7262', '#FFB020', '#E046C9', '#E7E7EA'];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#7C6CFF',
  uiScale: 1,
  canvasDark: '',
  canvasLight: '',
  toolbarPosition: 'bottom',
  showRulers: false,
  showPixelGrid: true,
  snapToPixels: true,
  snapToObjects: true,
  snapToGrid: false,
  gridSize: 8,
  showFrameLabels: true,
  nudge: 1,
  bigNudge: 10,
  wheelZoom: false,
  invertZoom: false,
  outlineMode: false,
  reduceMotion: false,
  keymap: {},
  recent: [],
  mcp: { enabled: true, port: 7331, allowScripts: false },
  showLeftPanel: true,
  showRightPanel: true,
  leftWidth: 248,
  rightWidth: 264,
  autosave: true,
  fontList: [],
};

const KEY = 'alt.settings';

function load(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...o, mcp: { ...DEFAULT_SETTINGS.mcp, ...(o.mcp ?? {}) } };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

interface SettingsStore extends Settings {
  set(p: Partial<Settings>): void;
  reset(): void;
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  ...load(),
  set(p) {
    set(p);
    persist(get());
  },
  reset() {
    set({ ...DEFAULT_SETTINGS });
    persist(get());
  },
}));

function persist(s: SettingsStore) {
  try {
    const { set: _s, reset: _r, ...data } = s;
    globalThis.localStorage?.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function resolvedTheme(mode: ThemeMode = useSettings.getState().theme): 'dark' | 'light' {
  if (mode === 'system') return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return mode;
}

export function canvasBackground(): string {
  const s = useSettings.getState();
  const t = resolvedTheme(s.theme);
  if (t === 'dark') return s.canvasDark || '#1A1A1D';
  return s.canvasLight || '#F2F2F4';
}
