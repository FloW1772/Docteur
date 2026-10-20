// Companion V1 — COMP-6A isolated Companion panel. Takes a CompanionUiPort as a prop; NOT imported by App.tsx and
// NOT wired to any route (COMP-6 wires it). Reads go through READ_ONLY actions; every change becomes a proposal the
// person reviews and confirms with a trusted gesture.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  errorText, proposedByLabel, STATE_TEXT, proposalUiState, CompanionUiError,
  type CompanionPreferences, type CompanionStatusDto, type CompanionUiPort, type ContextExplainDto, type LocalMutationActionId, type MemoryExplainDto, type MemoryRowDto, type ProposalDto,
} from '../../lib/companion/ui-contracts';
import { CompanionStatusPanel } from './CompanionStatusPanel';
import { CompanionMemoryPanel } from './CompanionMemoryPanel';
import { CompanionWhyPanel } from './CompanionWhyPanel';
import { CompanionActionReview } from './CompanionActionReview';
import { CompanionChat } from './CompanionChat';
import { CompanionErrorAlert, ToneBadge } from './CompanionCommon';
import './companion.css';

const codeOf = (e: unknown) => (e instanceof CompanionUiError ? e.code : typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'ACTION_FAILED');

export function CompanionPanel({ port, pendingProposals = [], contextRequestId = null, clock = Date.now }: {
  port: CompanionUiPort; pendingProposals?: ProposalDto[]; contextRequestId?: string | null; clock?: () => number;
}) {
  const [uiSessionId, setUiSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<CompanionStatusDto | null>(null);
  const [memories, setMemories] = useState<MemoryRowDto[] | null>(null);
  const [memError, setMemError] = useState<string | null>(null);
  const [why, setWhy] = useState<{ explain: MemoryExplainDto | null; context: ContextExplainDto | null } | null>(null);
  const [review, setReview] = useState<ProposalDto | null>(null);
  const [backendProposals, setBackendProposals] = useState<ProposalDto[]>([]); // [COMP-REMED-1] e.g. model proposals received by the backend
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await port.getStatus()); } catch (e) { setError(codeOf(e)); }
    try { setMemories(await port.listMemories()); setMemError(null); } catch (e) { setMemError(errorText(codeOf(e)).text); }
    if (port.listProposals) { try { setBackendProposals(await port.listProposals()); } catch { /* keep the last list; reviews re-check on the server */ } }
  }, [port]);
  useEffect(() => {
    let alive = true; let opened: string | null = null;
    port.openUiSession().then(s => { opened = s.uiSessionId; if (alive) setUiSessionId(s.uiSessionId); else void port.closeUiSession?.(s.uiSessionId); }).catch(e => setError(codeOf(e)));
    void load();
    return () => { alive = false; if (opened) void port.closeUiSession?.(opened); };
  }, [port, load]);

  const remember = () => { opener.current = document.activeElement as HTMLElement | null; };
  async function requestAction(actionId: LocalMutationActionId, parameters: Record<string, unknown>) {
    remember(); setError(null);
    try { setReview(await port.propose(actionId, parameters)); } catch (e) { setError(codeOf(e)); }
  }
  async function explain(memoryId: string) {
    setError(null);
    try { setWhy({ explain: await port.explainMemory(memoryId), context: null }); } catch (e) { setError(codeOf(e)); }
  }
  async function explainContext(requestId: string) {
    setError(null);
    try { setWhy({ explain: null, context: await port.explainContext(requestId) }); } catch (e) { setError(codeOf(e)); }
  }
  function closeReview() { setReview(null); void load(); opener.current?.focus?.(); }
  // props first (fixtures / future chat feed), then what the backend holds; one entry per proposal
  const shown = [...pendingProposals, ...backendProposals].filter((p, i, all) => all.findIndex(x => x.proposalId === p.proposalId) === i);

  return (
    <div className="cmp-root" data-testid="cmp-panel">
      <CompanionErrorAlert code={error} />
      {/* [COMP-9 CHAT] conversation over the existing answer path; "why" reuses the context explanation (memory ON only) */}
      <CompanionChat port={port} active={status?.activation === 'ACTIVE'} memoryEnabled={status?.preferences?.memoryEnabled === true} onExplain={id => { remember(); void explainContext(id); }} />
      <CompanionStatusPanel status={status} onRequestPreferences={(patch: Partial<CompanionPreferences>) => void requestAction('COMPANION.PREFERENCES.UPDATE', patch)} />
      {shown.length > 0 && (
        <section className="cmp-card" aria-labelledby="cmp-pending-title" data-testid="cmp-pending">
          <h2 id="cmp-pending-title">Actions proposées</h2>
          <ul className="cmp-list">
            {shown.map(p => {
              const by = proposedByLabel(p.proposedBy);
              const s = STATE_TEXT[proposalUiState({ proposal: p, now: clock() })];
              return (
                <li key={p.proposalId} className="cmp-row" data-proposal-id={p.proposalId}>
                  <ToneBadge tone={by.model ? 'model' : 'muted'} label={by.label}>{by.model ? 'PROPOSED_BY_MODEL' : 'Proposé par vous'}</ToneBadge>
                  <span>{p.preview?.summary ? String(p.preview.summary).slice(0, 160) : p.actionId}</span>
                  <ToneBadge tone={s.tone}>{s.label}</ToneBadge>
                  <button type="button" className="cmp-btn" onClick={() => { remember(); setReview(p); }}>Examiner<span className="cmp-sr"> {p.actionId}</span></button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {contextRequestId && <div className="cmp-row"><button type="button" className="cmp-btn" onClick={() => void explainContext(contextRequestId)}>Quels souvenirs ont servi pour cette réponse ?</button></div>}
      {why && <CompanionWhyPanel explain={why.explain} context={why.context} onClose={() => setWhy(null)} />}
      <CompanionMemoryPanel memories={memories} error={memError} onExplain={id => { remember(); void explain(id); }} onRequestAction={(a, p) => void requestAction(a, p)} />
      {review && uiSessionId && <CompanionActionReview key={review.proposalId} port={port} uiSessionId={uiSessionId} initial={review} onClose={closeReview} clock={clock} />}
    </div>
  );
}

export default CompanionPanel;
