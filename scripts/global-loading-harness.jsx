// Global Loading V1 — browser harness. Mounts the REAL loading primitives and the REAL
// modals wired to them; every /api/** call is answered by the Playwright test.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import { useLongOperation } from '../src/hooks/useLongOperation';
import OperationProgress from '../src/components/loading/OperationProgress';
import OperationStatusLine from '../src/components/loading/OperationStatusLine';
import BlockingOverlay from '../src/components/loading/BlockingOverlay';
import ImageGeneratorModal from '../src/components/modals/ImageGeneratorModal';
import VisionAnalyzeModal from '../src/components/modals/VisionAnalyzeModal';
import PdfExportModal from '../src/components/modals/PdfExportModal';
import ConversationModal from '../src/components/modals/ConversationModal';
import BackupModal from '../src/components/modals/BackupModal';

// Fast policy so the lab runs in real time.
const LAB_POLICY = { scope: 'modal', slowAfterMs: 400, timeoutMs: 1_500, cancellable: true, retryable: true };
window.__lab = { jobs: [], results: [], toasts: [], restored: [] };

function controlledTask({ signal, setStep, setProgress }) {
  return new Promise((resolve, reject) => {
    const job = { resolve, reject, signal, setStep, setProgress, aborted: false };
    signal.addEventListener('abort', () => { job.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    window.__lab.jobs.push(job);
  });
}

function Lab() {
  const op = useLongOperation(LAB_POLICY);
  const record = (value) => window.__lab.results.push(value === undefined ? null : value);
  return (
    <div style={{ padding: 24, maxWidth: 520 }}>
      <button type="button" id="start" onClick={() => { void op.run('Opération test', controlledTask, { step: 'Démarrage…' }).then(record); }}>Lancer</button>
      <OperationProgress
        state={op.state} policy={op.policy} elapsedMs={op.elapsedMs} slow={op.slow}
        onCancel={op.cancel} onRetry={() => { void op.retry().then(record); }} onDismiss={op.reset}
      />
      <div data-testid="status">{op.state.status}</div>
      <div data-testid="line"><OperationStatusLine operation={op} /></div>
    </div>
  );
}

function OverlayLab() {
  const op = useLongOperation({ ...LAB_POLICY, scope: 'global', timeoutMs: 60_000 });
  return (
    <div style={{ padding: 24 }}>
      <button type="button" id="before">Avant</button>
      <button type="button" id="trigger" onClick={() => { void op.run('Blocage test', controlledTask); }}>Restaurer</button>
      <button type="button" id="after">Après</button>
      <BlockingOverlay open={op.running} title="Blocage test" onEscape={op.cancel}>
        <OperationProgress state={op.state} policy={op.policy} elapsedMs={op.elapsedMs} slow={op.slow} onCancel={op.cancel} />
      </BlockingOverlay>
      <div data-testid="status">{op.state.status}</div>
    </div>
  );
}

const VIEWS = {
  lab: () => <Lab />,
  overlay: () => <OverlayLab />,
  image: () => <ImageGeneratorModal onClose={() => {}} strictLocalMode />,
  vision: () => <VisionAnalyzeModal imageId="img-1" onClose={() => {}} onSave={() => {}} />,
  pdf: () => <PdfExportModal variant="subject" initialSubject="Astronomie" onClose={() => { window.__lab.closed = true; }} onToast={(m) => window.__lab.toasts.push(m)} />,
  chat: () => <ConversationModal onClose={() => {}} onSaveConversation={() => {}} />,
  backup: () => (
    <BackupModal
      pages={[]}
      onClose={() => {}}
      onRestorePages={async (neurons, links) => { window.__lab.restored.push({ neurons: neurons.length, links: links.length }); }}
    />
  ),
};

export function mount() {
  const view = new URLSearchParams(window.location.search).get('view') ?? 'lab';
  createRoot(document.getElementById('root')).render(VIEWS[view]());
}
