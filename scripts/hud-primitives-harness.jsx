import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import StatusIndicator from '../src/components/hud/StatusIndicator';
import HudPanel from '../src/components/hud/HudPanel';
import ModuleWidget from '../src/components/hud/ModuleWidget';
import QuickAction from '../src/components/hud/QuickAction';
import ActivityItem, { formatRelativeTime } from '../src/components/hud/ActivityItem';
import { Search } from 'lucide-react';

// Isolated harness for the HUD generic primitives (PHASE UI-2) — same
// "test the new surface in isolation" approach as
// cortex-command-center-harness.jsx.
function Harness() {
  const now = Date.now();
  return (
    <div>
      <section aria-label="status-indicators">
        {(['idle', 'listening', 'thinking', 'searching', 'generating', 'done', 'error', 'unavailable']).map(s => (
          <div key={s} data-testid={`status-${s}`}><StatusIndicator status={s} /></div>
        ))}
      </section>

      <HudPanel title="Test Panel" ariaLabel="Test Panel">
        <p>panel content</p>
      </HudPanel>

      <div data-testid="widget-idle">
        <ModuleWidget name="TestModule" status="idle" metric="3 items" detail="last run ok" onOpen={() => { window.__opened = 'idle'; }} />
      </div>
      <div data-testid="widget-running">
        <ModuleWidget name="TestModule" status="generating" metric="running" />
      </div>
      <div data-testid="widget-error">
        <ModuleWidget name="TestModule" status="error" error="Connexion refusée" />
      </div>
      <div data-testid="widget-absent">
        <ModuleWidget name="TestModule" status="unavailable" />
      </div>
      <div data-testid="widget-loading">
        <ModuleWidget name="TestModule" status="idle" loading />
      </div>

      <QuickAction icon={Search} label="Quick search" onClick={() => { window.__quickActionClicked = true; }} />
      <QuickAction icon={Search} label="Disabled action" onClick={() => { window.__disabledClicked = true; }} disabled />

      <ul>
        <ActivityItem event={{ id: '1', module: 'METAGPT', type: 'mission', label: 'Mission completed', status: 'done', timestamp: now - 65000 }} now={now} />
        <ActivityItem event={{ id: '2', module: 'SHERLOCK', type: 'search', label: 'Search running', status: 'searching', timestamp: now }} now={now} />
      </ul>
      <div data-testid="relative-time-check">{formatRelativeTime(now - 3 * 3600 * 1000, now)}</div>
    </div>
  );
}

export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
