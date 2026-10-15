import { editor } from '../core/store';
import { actionForEvent, eventCombo, runAction } from './actions';
import { getTool } from './tools';
import { CURSORS, isTyping, requestOverlay, setCursor, ui } from './toolkit';
import { useUI } from '../ui/uiStore';
import { useDialog } from '../ui/dialog';

/** Shortcuts that still work while typing in an input. */
const GLOBAL_WHILE_TYPING = new Set(['Mod+S', 'Mod+Shift+S', 'Mod+O', 'Mod+N', 'Mod+K', 'Mod+,', 'Mod+Shift+E', 'Mod+\\']);

function modalOpen() {
  const u = useUI.getState();
  return u.palette || !!u.settings || u.exportOpen || u.present || !!useDialog.getState().current;
}

export function installKeyboard() {
  const down = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const combo = eventCombo(e);
    if (modalOpen()) {
      if (useUI.getState().present) return; // presenter handles its own keys
      if (GLOBAL_WHILE_TYPING.has(combo) && combo !== 'Mod+K') {
        const id = actionForEvent(e);
        if (id) {
          e.preventDefault();
          runAction(id);
        }
      }
      return;
    }
    if (isTyping(e)) {
      if (GLOBAL_WHILE_TYPING.has(combo)) {
        const id = actionForEvent(e);
        if (id) {
          e.preventDefault();
          runAction(id);
        }
      }
      return;
    }
    if (e.key === ' ' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (!ui.spaceDown) {
        ui.spaceDown = true;
        setCursor(CURSORS.hand);
      }
      return;
    }
    if (e.key === 'Alt') {
      e.preventDefault();
      ui.altDown = true;
      requestOverlay();
    }
    const s = editor();
    const tool = getTool(s.tool);
    if (tool.key?.(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && s.tool !== 'move') {
      e.preventDefault();
      tool.cancel?.();
      s.setTool('move');
      return;
    }
    const id = actionForEvent(e);
    if (id) {
      e.preventDefault();
      runAction(id);
    }
  };
  const up = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      ui.spaceDown = false;
      const t = getTool(editor().tool);
      setCursor(typeof t.cursor === 'function' ? t.cursor() : t.cursor ?? 'default');
    }
    if (e.key === 'Alt') {
      ui.altDown = false;
      requestOverlay();
    }
    getTool(editor().tool).keyUp?.(e);
  };
  const blur = () => {
    ui.spaceDown = false;
    ui.altDown = false;
    requestOverlay();
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
  };
}
