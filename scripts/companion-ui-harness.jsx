// [Companion V1] COMP-6A — browser harness: mounts the REAL isolated CompanionPanel with a TEST-ONLY CompanionUiPort.
// The port posts to /__companion/rpc, which the Playwright suite answers in-process with the REAL COMP-5 framework,
// human approval channel and UI service on temporary stores. No product route, no App.tsx, no client.ts.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionPanel } from '../src/components/companion/CompanionPanel';
import { CompanionUiError } from '../src/lib/companion/ui-contracts';

async function rpc(method, ...args) {
  const r = await fetch('/__companion/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const j = await r.json();
  if (!r.ok) throw new CompanionUiError(j.code ?? 'ACTION_FAILED', j.message ?? 'refused', j.reason ?? null);
  return j.value;
}
const METHODS = ['openUiSession', 'getStatus', 'listMemories', 'explainMemory', 'explainContext', 'propose', 'getProposal', 'issueChallenge', 'submitIntent', 'execute', 'abortExecution', 'reject', 'cancel'];
const port = Object.freeze(Object.fromEntries(METHODS.map(m => [m, (...args) => rpc(m, ...args)])));

export function mount() {
  const cfg = window.__companionHarness ?? {};
  createRoot(document.getElementById('root')).render(
    <div style={{ background: '#020617', minHeight: '100vh', padding: 16 }}>
      <button type="button" id="outside">Hors du panneau</button>
      <CompanionPanel port={port} pendingProposals={cfg.pendingProposals ?? []} contextRequestId={cfg.contextRequestId ?? null} />
    </div>,
  );
}
