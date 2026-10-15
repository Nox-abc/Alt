import { useRef } from 'react';
import { useUI } from './uiStore';
import { useSettings } from '../editor/settings';
import { useDrag } from './controls';
import { LayersTree, PagesList } from './panels/LayersPanel';
import { AssetsPanel } from './panels/AssetsPanel';
import { DesignPanel } from './panels/DesignPanel';
import { CodePanel, ExportBrowser } from './panels/ExportSection';
import { useEditor } from '../core/store';

export function LeftPanel() {
  const tab = useUI((s) => s.leftTab);
  const width = useSettings((s) => s.leftWidth);
  const set = useSettings((s) => s.set);
  const start = useRef(width);
  const drag = useDrag((dx) => set({ leftWidth: Math.max(200, Math.min(480, start.current + dx)) }));
  return (
    <aside className="panel left" style={{ width }}>
      <div className="panel-tabs">
        <button className={`panel-tab ${tab === 'layers' ? 'active' : ''}`} onClick={() => useUI.getState().set({ leftTab: 'layers' })}>
          Layers
        </button>
        <button className={`panel-tab ${tab === 'assets' ? 'active' : ''}`} onClick={() => useUI.getState().set({ leftTab: 'assets' })}>
          Assets
        </button>
      </div>
      {tab === 'layers' ? (
        <>
          <PagesList />
          <LayersTree />
        </>
      ) : (
        <AssetsPanel />
      )}
      <div
        className="panel-resizer"
        onPointerDown={(e) => {
          start.current = useSettings.getState().leftWidth;
          drag(e);
        }}
      />
    </aside>
  );
}

export function RightPanel() {
  const tab = useUI((s) => s.rightTab);
  const width = useSettings((s) => s.rightWidth);
  const set = useSettings((s) => s.set);
  const nsel = useEditor((s) => s.selection.length);
  const start = useRef(width);
  const drag = useDrag((dx) => set({ rightWidth: Math.max(240, Math.min(520, start.current - dx)) }));
  return (
    <aside className="panel right" style={{ width }}>
      <div className="panel-tabs">
        {(['design', 'export', 'code'] as const).map((t) => (
          <button key={t} className={`panel-tab ${tab === t ? 'active' : ''}`} onClick={() => useUI.getState().set({ rightTab: t })}>
            {t === 'design' ? 'Design' : t === 'export' ? 'Export' : 'Code'}
          </button>
        ))}
        <span className="flex1" />
        {nsel > 0 && <span className="muted" style={{ paddingRight: 4 }}>{nsel} selected</span>}
      </div>
      <div className="panel-scroll">
        {tab === 'design' && <DesignPanel />}
        {tab === 'code' && <CodePanel />}
        {tab === 'export' && (
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            <ExportBrowser compact />
          </div>
        )}
      </div>
      <div
        className="panel-resizer"
        onPointerDown={(e) => {
          start.current = useSettings.getState().rightWidth;
          drag(e);
        }}
      />
    </aside>
  );
}
