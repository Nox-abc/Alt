import { useEffect } from 'react';
import { editor, useEditor } from './core/store';
import { hexToRgb } from './core/doc';
import { Canvas } from './editor/Canvas';
import { installKeyboard } from './editor/keyboard';
import { installClipboard } from './editor/clipboard';
import { resolvedTheme, useSettings } from './editor/settings';
import { runAction } from './editor/actions';
import { autosaveClear, autosaveRead, autosaveWrite, confirmDiscard, openDocumentText, parseDoc } from './editor/file';
import { native } from './platform/native';
import { registerMcp } from './api/registerMcp';
import { TooltipLayer } from './ui/controls';
import { ContextMenuHost } from './ui/ContextMenu';
import { CommandPalette } from './ui/CommandPalette';
import { SettingsDialog } from './ui/SettingsDialog';
import { DialogHost, ExportDialog, Presenter, StatusBar, TitleBar, Toasts, Welcome } from './ui/Shell';
import { LeftPanel, RightPanel } from './ui/Panels';
import { Toolbar } from './ui/Toolbar';
import { Rulers } from './ui/Rulers';
import { useUI } from './ui/uiStore';
import { ScriptConsole } from './ui/ScriptConsole';
import { toast } from './ui/toast';

function useTheme() {
  const theme = useSettings((s) => s.theme);
  const accent = useSettings((s) => s.accent);
  const uiScale = useSettings((s) => s.uiScale);
  const reduce = useSettings((s) => s.reduceMotion);
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      const t = resolvedTheme(theme);
      root.dataset.theme = t;
      root.dataset.reduceMotion = String(reduce);
      const { r, g, b } = hexToRgb(accent);
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      root.style.setProperty('--accent-fg', lum > 0.72 ? '#111114' : '#ffffff');
      root.style.setProperty('--ui-scale', String(uiScale));
      native?.setChrome({ dark: t === 'dark', background: t === 'dark' ? '#141417' : '#ffffff', symbol: t === 'dark' ? '#d0d0d8' : '#33333a' });
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, accent, uiScale, reduce]);
}

function useDesktopBridge() {
  const name = useEditor((s) => s.doc.name);
  const dirty = useEditor((s) => s.dirty);
  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${name} — Alt`;
    native?.setTitle(`${name} — Alt`);
    native?.setDocumentEdited(dirty);
  }, [name, dirty]);
  useEffect(() => {
    if (!native) {
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (editor().dirty) e.preventDefault();
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }
    const offs = [
      native.onMenuAction((a) => runAction(a)),
      native.onOpenFile(async (f) => {
        if (await confirmDiscard()) openDocumentText(f.data, f.path, f.name);
      }),
      native.onCloseRequest(async () => {
        if (await confirmDiscard()) {
          void autosaveClear();
          native!.confirmClose();
        }
      }),
    ];
    return () => offs.forEach((o) => o());
  }, []);
}

function useAutosave() {
  useEffect(() => {
    // offer crash recovery
    void autosaveRead().then((rec) => {
      if (!rec || !useSettings.getState().autosave) return;
      try {
        const doc = parseDoc(rec.doc);
        if (!Object.keys(doc.nodes).length) return;
        toast(`Recovered “${doc.name}” from ${new Date(rec.at).toLocaleString()}`, {
          ms: 12000,
          action: {
            label: 'Restore',
            run: () => {
              editor().loadDoc(doc, rec.path);
              editor().mutate((d) => void (d.updatedAt = Date.now()), { history: false });
            },
          },
        });
      } catch {
        /* ignore corrupt recovery data */
      }
    });
    const t = setInterval(() => {
      const s = editor();
      if (s.dirty && useSettings.getState().autosave) void autosaveWrite(s.doc, s.filePath);
    }, 8000);
    const unsub = useEditor.subscribe((s, p) => {
      if (p.dirty && !s.dirty) void autosaveClear();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, []);
}

export function App() {
  useTheme();
  useDesktopBridge();
  useAutosave();
  useEffect(() => {
    const k = installKeyboard();
    const c = installClipboard();
    const m = registerMcp();
    return () => {
      k();
      c();
      m?.();
    };
  }, []);
  useEffect(() => {
    const onRename = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      useSettings.getState().set({ showLeftPanel: true });
      useUI.getState().set({ leftTab: 'layers', renaming: id });
    };
    window.addEventListener('alt:rename', onRename);
    return () => window.removeEventListener('alt:rename', onRename);
  }, []);
  const showLeft = useSettings((s) => s.showLeftPanel);
  const showRight = useSettings((s) => s.showRightPanel);
  const uiHidden = useUI((s) => s.uiHidden);
  return (
    <div className="app">
      <TitleBar />
      <div className="workspace">
        {showLeft && !uiHidden && <LeftPanel />}
        <main className="canvas-area">
          <div className="canvas-row">
            <Canvas />
            <Rulers />
            {!uiHidden && <Toolbar />}
            <Welcome />
            <StatusBar />
          </div>
        </main>
        {showRight && !uiHidden && <RightPanel />}
      </div>
      <TooltipLayer />
      <ContextMenuHost />
      <CommandPalette />
      <SettingsDialog />
      <ExportDialog />
      <ScriptConsole />
      <DialogHost />
      <Presenter />
      <Toasts />
    </div>
  );
}
