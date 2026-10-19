// Companion V1 — COMP-6A action review dialog: preview → confirmation (simple / typed / reinforced) → approval through
// the human gesture channel → execution → honest result. The UI is not the authority: the server re-validates the
// proposal, digest, preview, expiry, single use and phrase; a hidden or disabled button authorises nothing.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ACK_TEXT, CONFIRMATION_TEXT, STATE_TEXT, availableControls, buildApprovalIntent, confirmationKindOf, confirmationReady, displayText, effectText,
  previewRows, proposalUiState, proposedByLabel, resultView, secondsLeft, CompanionUiError,
  type ActionResultDto, type ApprovalDto, type ChallengeDto, type CompanionUiPort, type LocalMutationActionId, type ProposalDto, type ProposalUiState,
} from '../../lib/companion/ui-contracts';
import { CompanionErrorAlert, CompanionPrivacyBadge, ToneBadge } from './CompanionCommon';
import './companion.css';

const BURNS_CHALLENGE = ['APPROVAL_INTENT_REPLAYED', 'APPROVAL_INTENT_EXPIRED', 'APPROVAL_INTENT_MISMATCH', 'APPROVAL_DIGEST_MISMATCH', 'PREVIEW_STALE', 'UI_SESSION_UNKNOWN', 'APPROVAL_INTENT_INVALID'];
const KILLS_APPROVAL = ['APPROVAL_ALREADY_USED', 'APPROVAL_EXPIRED', 'APPROVAL_NOT_FOUND', 'PREVIEW_STALE', 'APPROVAL_DIGEST_MISMATCH'];
const codeOf = (e: unknown) => (e instanceof CompanionUiError ? e.code : typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'ACTION_FAILED');
const newExecutionId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function CompanionActionReview({ port, uiSessionId, initial, onClose, clock = Date.now }: {
  port: CompanionUiPort; uiSessionId: string; initial: ProposalDto; onClose: (final: { state: ProposalUiState; result: ActionResultDto | null }) => void; clock?: () => number;
}) {
  const [proposal, setProposal] = useState<ProposalDto>(initial);
  const [challenge, setChallenge] = useState<ChallengeDto | null>(null);
  const [approval, setApproval] = useState<ApprovalDto | null>(null);
  const [approvalDead, setApprovalDead] = useState(false);
  const [typed, setTyped] = useState('');
  const [acks, setAcks] = useState<string[]>([]);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ActionResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(clock());
  const executionRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => { const t = setInterval(() => setNow(clock()), 500); return () => clearInterval(t); }, [clock]);
  // Escape closes only this nested review wherever focus is. Window capture runs before the product StudioShell's
  // document-capture listener, preventing one Escape from closing both dialogs and stranding focus.
  const closeRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const kind = confirmationKindOf(proposal);
  let state = proposalUiState({ proposal, approval, executing, result, now });
  if (approvalDead && state === 'APPROVED') state = 'EXPIRED';
  const challengeExpired = challenge ? Date.parse(challenge.expiresAt) <= now : false;
  const ready = confirmationReady(kind, challenge, typed, acks);
  const controls = availableControls(state, {
    confirmationReady: ready && !busy, challengeReady: Boolean(challenge) && !challengeExpired,
    cancellableWhileExecuting: typeof proposal.preview?.pointOfNoReturn === 'string' && proposal.preview.pointOfNoReturn.startsWith('NB5_DELETE'),
  });
  const pb = proposedByLabel(proposal.proposedBy);
  const pv = proposal.preview ?? {};
  const isForget = proposal.actionId === 'COMPANION.MEMORY.FORGET';
  const isRelease = pv.privacyImpact?.neverCloudRelease === true;
  const titleId = `cmp-review-${proposal.proposalId}`;

  const requestChallenge = useCallback(async () => {
    setChallenge(null); setTyped(''); setAcks([]);
    try { setChallenge(await port.issueChallenge(uiSessionId, proposal.proposalId)); } catch (e) { setError(codeOf(e)); }
  }, [port, uiSessionId, proposal.proposalId]);
  useEffect(() => {
    if (proposal.status === 'PENDING' && kind !== 'NONE' && kind !== 'UNKNOWN' && !proposal.expired && !proposal.previewStale) void requestChallenge();
  }, [proposal.proposalId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => { try { setProposal(await port.getProposal(proposal.proposalId)); } catch { /* keep the last known state */ } };

  async function confirm(e: MouseEvent<HTMLButtonElement>) {
    if (!challenge) return;
    const intent = buildApprovalIntent(challenge, e.nativeEvent, { typed, acknowledgements: acks }, clock());
    if (!intent) { setError('APPROVAL_REQUIRED'); return; }
    setBusy(true); setError(null);
    try {
      setApproval(await port.submitIntent(intent)); setApprovalDead(false); setChallenge(null);
      await refresh();
    } catch (err) {
      const c = codeOf(err); setError(c);
      if (BURNS_CHALLENGE.includes(c)) { setChallenge(null); await refresh(); }
    } finally { setBusy(false); }
  }
  async function execute(e: MouseEvent<HTMLButtonElement>) {
    if (!approval || e.nativeEvent.isTrusted !== true) { setError('APPROVAL_REQUIRED'); return; }
    const executionId = newExecutionId(); executionRef.current = executionId;
    setExecuting(true); setError(null);
    try {
      setResult(await port.execute({ actionId: proposal.actionId, parameters: proposal.parameters, approvalId: approval.approvalId, executionId }));
    } catch (err) {
      const c = codeOf(err); setError(c);
      if (KILLS_APPROVAL.includes(c)) { setApproval(null); setApprovalDead(true); }
    } finally { executionRef.current = null; setExecuting(false); await refresh(); }
  }
  /** [COMP-REMED-1] READ_ONLY (COMP-5: no approval): a trusted gesture runs it with its proposalId; the server checks the digest. */
  async function runReadOnly(e: MouseEvent<HTMLButtonElement>) {
    if (kind !== 'NONE' || proposal.riskClass !== 'READ_ONLY' || e.nativeEvent.isTrusted !== true) { setError('APPROVAL_REQUIRED'); return; }
    const executionId = newExecutionId(); executionRef.current = executionId;
    setExecuting(true); setError(null);
    try { setResult(await port.execute({ actionId: proposal.actionId, parameters: proposal.parameters, proposalId: proposal.proposalId, executionId })); }
    catch (err) { setError(codeOf(err)); }
    finally { executionRef.current = null; setExecuting(false); await refresh(); }
  }
  async function cancel() {
    setError(null);
    if (executing && executionRef.current) { await port.abortExecution(executionRef.current).catch(() => false); return; }
    try { setProposal(await port.cancel(proposal.proposalId)); setChallenge(null); } catch (err) { setError(codeOf(err)); }
  }
  async function reject() {
    setError(null);
    try { setProposal(await port.reject(proposal.proposalId)); setChallenge(null); } catch (err) { setError(codeOf(err)); }
  }
  async function reconfirm() {
    setError(null); setApproval(null); setApprovalDead(false); setResult(null); setChallenge(null);
    try { setProposal(await port.propose(proposal.actionId as LocalMutationActionId, proposal.parameters)); } catch (err) { setError(codeOf(err)); }
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') return; // handled once, at document level
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  closeRef.current = () => onClose({ state, result });
  // focus follows the next step: after the approval the Confirm button is gone, Execute is the next control
  useEffect(() => {
    if (state === 'APPROVED') dialogRef.current?.querySelector<HTMLButtonElement>('[data-testid="cmp-btn-execute"]')?.focus();
    else if (state !== 'PENDING' && dialogRef.current && !dialogRef.current.contains(document.activeElement)) headingRef.current?.focus();
  }, [state]);

  const st = STATE_TEXT[state];
  const rv = result ? resultView(result) : null;
  return (
    <div className="cmp-backdrop">
      <div className="cmp-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-state`} ref={dialogRef} onKeyDown={onKeyDown}
        data-testid="cmp-review" data-ui-state={state} data-proposal-id={proposal.proposalId}>
        <h2 id={titleId} tabIndex={-1} ref={headingRef}>Vérifier l’action : {displayText(pv.action ?? proposal.actionId)}</h2>
        <div className="cmp-row">
          <span id={`${titleId}-state`} data-testid="cmp-state"><ToneBadge tone={st.tone} label={`État : ${st.label}`}>{state}</ToneBadge> <span className="cmp-muted">{st.label}</span></span>
          <ToneBadge tone={pb.model ? 'model' : 'muted'} label={pb.label}><span data-testid="cmp-proposed-by" data-proposed-by={proposal.proposedBy}>{pb.model ? 'PROPOSED_BY_MODEL' : pb.label}</span></ToneBadge>
          <ToneBadge tone="muted" label={`Classe de risque ${proposal.riskClass}`}>{proposal.riskClass}</ToneBadge>
        </div>
        {pb.model && <p className="cmp-alert info" data-testid="cmp-model-note">Cette action a été proposée par le modèle local. Le modèle ne peut ni l’approuver ni l’exécuter : seule votre confirmation le peut.</p>}
        {proposal.previewStale && <CompanionErrorAlert code="PREVIEW_STALE" />}

        <table className="cmp-preview" aria-label="Aperçu de l’action" data-testid="cmp-preview">
          <tbody>{previewRows(proposal).map(r => <tr key={r.key} data-row={r.key}><th scope="row">{r.label}</th><td>{displayText(r.value, 600)}</td></tr>)}</tbody>
        </table>

        {isForget && (
          <div className="cmp-alert danger" data-testid="cmp-forget-warning">
            <strong>Oubli définitif.</strong> Souvenir : {displayText(pv.memory?.memoryId)} — {pv.memory?.excerpt ? `« ${displayText(pv.memory.excerpt, 160)} »` : pv.memory?.excerptWithheld ? 'résumé masqué' : 'sans résumé'}.
            <ul>{(pv.effects ?? []).filter(x => !x.startsWith('VERIFIED_AFTERWARDS')).map(x => <li key={x}>{effectText(x)}</li>)}</ul>
            Irréversible. Le résultat peut être <strong>FORGET_INCOMPLETE</strong> si un stockage n’a pas pu être purgé : ce ne sera alors pas un succès.
          </div>
        )}
        {isRelease && (
          <div className="cmp-alert danger" data-testid="cmp-release-warning">
            <strong>Sortie de NEVER_CLOUD.</strong>
            <div className="cmp-row">Portée actuelle : <CompanionPrivacyBadge scope={pv.changes?.[0]?.from} /> → nouvelle portée : <CompanionPrivacyBadge scope={pv.changes?.[0]?.to} /></div>
            Ce souvenir perd son verrou « jamais au cloud ». Un envoi cloud pourra devenir possible plus tard si le cloud est activé et autorisé ; un envoi passé ne pourrait pas être annulé.
          </div>
        )}

        {state === 'PENDING' && (
          <fieldset className="cmp-card" data-testid="cmp-confirm" data-kind={kind}>
            <legend>{CONFIRMATION_TEXT[kind]}</legend>
            {!challenge && kind !== 'NONE' && <p className="cmp-muted" role="status">{challengeExpired ? 'La fenêtre de confirmation a expiré.' : 'Préparation de la confirmation…'}</p>}
            {challenge && (
              <p className="cmp-muted">Empreinte confirmée : <code data-testid="cmp-digest">{challenge.actionDigestShort}</code> · fenêtre : <span data-testid="cmp-challenge-left">{secondsLeft(challenge.expiresAt, now)}</span> s</p>
            )}
            {challenge && kind === 'REINFORCED_CONFIRM' && challenge.requiredAcknowledgements.map(a => (
              <label key={a} className="cmp-check">
                <input type="checkbox" checked={acks.includes(a)} onChange={e => setAcks(prev => (e.target.checked ? [...prev, a] : prev.filter(x => x !== a)))} data-ack={a} />
                <span>{ACK_TEXT[a] ?? a}</span>
              </label>
            ))}
            {challenge && (kind === 'TYPED_CONFIRM' || kind === 'REINFORCED_CONFIRM') && challenge.typedPhrase && (
              <label className="cmp-check" style={{ flexDirection: 'column' }}>
                <span id={`${titleId}-phrase`}>Recopiez exactement : <span className="cmp-phrase" data-testid="cmp-phrase">{challenge.typedPhrase}</span></span>
                <input className="cmp-input" value={typed} onChange={e => setTyped(e.target.value)} aria-describedby={`${titleId}-phrase`} autoComplete="off" spellCheck={false} aria-label="Phrase de confirmation" data-testid="cmp-typed" />
              </label>
            )}
            {challengeExpired && <button type="button" className="cmp-btn" onClick={() => void requestChallenge()}>Redemander la confirmation</button>}
          </fieldset>
        )}
        {state === 'APPROVED' && approval && (
          <p className="cmp-alert info" data-testid="cmp-approval">Approuvée par vous. Confirmation à usage unique, valable encore <span data-testid="cmp-approval-left">{secondsLeft(approval.expiresAt, now)}</span> s.</p>
        )}
        {state === 'EXPIRED' && <p className="cmp-alert warn" data-testid="cmp-expired">Expirée : l’exécution est impossible. Une nouvelle confirmation est nécessaire.</p>}
        {state === 'UNKNOWN' && <p className="cmp-alert danger" data-testid="cmp-unknown">État inconnu : aucune action n’est proposée.</p>}
        {rv && <div className={`cmp-alert ${rv.tone}`} role="status" data-testid="cmp-result" data-result-state={rv.state} data-success={String(rv.success)}><strong>{rv.title}</strong> — {rv.detail}</div>}
        <CompanionErrorAlert code={error} id={`${titleId}-error`} />

        <div className="cmp-row">
          {state === 'PENDING' && kind !== 'NONE' && <button type="button" className="cmp-btn primary" disabled={!controls.canConfirm} onClick={e => void confirm(e)} data-testid="cmp-btn-confirm">Confirmer</button>}
          {state === 'PENDING' && kind === 'NONE' && proposal.riskClass === 'READ_ONLY' && <button type="button" className="cmp-btn primary" disabled={busy} onClick={e => void runReadOnly(e)} data-testid="cmp-btn-run-readonly">Exécuter (lecture seule)</button>}
          {state === 'PENDING' && <button type="button" className="cmp-btn ghost" disabled={!controls.canReject} onClick={() => void reject()}>Refuser</button>}
          {(state === 'APPROVED' || state === 'EXPIRED' || state === 'EXECUTING') && (
            <button type="button" className="cmp-btn primary" disabled={!controls.canExecute} onClick={e => void execute(e)} data-testid="cmp-btn-execute">Exécuter</button>
          )}
          {controls.canReconfirm && <button type="button" className="cmp-btn" onClick={() => void reconfirm()} data-testid="cmp-btn-reconfirm">Nouvelle confirmation</button>}
          {controls.canCancel && <button type="button" className="cmp-btn ghost" onClick={() => void cancel()} data-testid="cmp-btn-cancel">Annuler</button>}
          <button type="button" className="cmp-btn ghost" onClick={() => onClose({ state, result })} data-testid="cmp-btn-close">Fermer</button>
        </div>
      </div>
    </div>
  );
}
