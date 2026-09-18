import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import StudioShell from '../src/components/studio/StudioShell';
import StudioTabs from '../src/components/studio/StudioTabs';
import StudioStatus from '../src/components/studio/StudioStatus';
import StudioEmptyState from '../src/components/studio/StudioEmptyState';
import StudioErrorState from '../src/components/studio/StudioErrorState';
import StudioArtifactViewer from '../src/components/studio/StudioArtifactViewer';
import StudioSourceBadge from '../src/components/studio/StudioSourceBadge';
import StudioTimeline from '../src/components/studio/StudioTimeline';
import StudioToolbar from '../src/components/studio/StudioToolbar';
import StudioSplitPane from '../src/components/studio/StudioSplitPane';
import { Boxes } from 'lucide-react';

// Isolated harness for the shared Studio design-system primitives
// (STUDIOS UX V2, Phase UX-2) — mounts the real components, same
// "test the new surface in isolation" approach as hud-primitives-harness.jsx.

const TABS = ['OVERVIEW', 'DETAILS', 'HISTORY'];

function Harness() {
  const [shellOpen, setShellOpen] = useState(true);
  const [tab, setTab] = useState('OVERVIEW');
  const [retryCount, setRetryCount] = useState(0);

  return (
    <div>
      <button type="button" onClick={() => setShellOpen(true)}>Ouvrir le Studio test</button>
      {shellOpen && (
        <StudioShell icon={<Boxes size={18} />} title="Test Studio" onClose={() => setShellOpen(false)} subtitle="Sous-titre de sécurité">
          <StudioTabs tabs={TABS} active={tab} onChange={setTab} badges={{ HISTORY: 2 }}>
            <div data-testid="active-tab">{tab}</div>
          </StudioTabs>

          <div data-testid="statuses">
            <StudioStatus label="Actif" tone="active" />
            <StudioStatus label="Réussi" tone="success" />
            <StudioStatus label="Attention" tone="warning" />
            <StudioStatus label="Erreur" tone="error" />
            <StudioStatus label="Neutre" tone="neutral" />
          </div>

          <div data-testid="empty-state">
            <StudioEmptyState message="Aucune donnée pour l'instant." />
          </div>

          <div data-testid="error-state">
            <StudioErrorState message="job_not_found" onRetry={() => setRetryCount(c => c + 1)} />
            <div data-testid="retry-count">{retryCount}</div>
          </div>

          <StudioArtifactViewer title="PRD" content="# Fixture PRD content" meta="1.2 KB" />
          <StudioArtifactViewer title="Empty artifact" content={null} />

          <div data-testid="source-badge">
            <StudioSourceBadge label="Mock Filing" url="https://example.com/filing" timestamp="2026-09-18" recency="historical" />
          </div>

          <StudioTimeline
            entries={[
              { id: 'e1', kind: 'earnings', when: '2026-08-01', title: 'Q3 beat', source: 'source' },
              { id: 'e2', kind: 'other', when: null, title: 'Undated', interpretation: 'Speculative note' },
            ]}
          />

          <StudioToolbar destructive={<button type="button" className="studio-button studio-button--danger">Annuler</button>}>
            <button type="button" className="studio-button studio-button--primary">Primaire</button>
            <button type="button" className="studio-button">Secondaire</button>
          </StudioToolbar>

          <StudioSplitPane
            secondaryLabel="Activité"
            main={<div data-testid="split-main">Contenu principal</div>}
            secondary={<div data-testid="split-secondary">Rail secondaire</div>}
          />
        </StudioShell>
      )}
      {!shellOpen && <p data-testid="shell-closed">closed</p>}
    </div>
  );
}

export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
