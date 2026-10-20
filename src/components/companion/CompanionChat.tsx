// Companion V1 — [COMP-9 CHAT] conversation surface of the Companion panel, over CompanionUiPort.answer (the existing
// POST /companion/answers path: Companion context → local model through the Model Router). One generation at a time;
// "Annuler" aborts the HTTP request, which aborts the server-side context assembly and local model call. Model text is
// rendered as plain text (React escapes it): no HTML, no Markdown, no link is ever interpreted. The chat creates no
// action and no memory: a model action proposal is reported as ignored, never registered or executed.
import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import LoadingSpinner from '../loading/LoadingSpinner';
import { CompanionUiError, displayText, type CompanionUiPort } from '../../lib/companion/ui-contracts';
import {
  answerFacts, canSend, chatReducer, CHAT_LIMITS, EMPTY_CHAT, questionFor,
  type ChatAssistantTurn, type ChatTurn,
} from '../../lib/companion/chat-model';
import './companion.css';

let seq = 0;
const newId = (prefix: string) => {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
};
const proofs = (n: number) => (n > 0 ? ` — ${n} preuve${n > 1 ? 's' : ''}` : '');
const errorParts = (e: unknown) => (e instanceof CompanionUiError ? { code: e.code, reason: e.reason } : { code: 'COMP_CONVERSATION_FAILED', reason: null });

function AssistantTurn({ turn, onCancel, onRetry, onExplain, canRetry }: Readonly<{
  turn: ChatAssistantTurn; onCancel: () => void; onRetry: () => void; onExplain: ((requestId: string) => void) | null; canRetry: boolean;
}>) {
  if (turn.status === 'PENDING') {
    return (
      <div className="cmp-chat-turn assistant" data-testid="cmp-chat-pending">
        <LoadingSpinner label="Le Companion prépare sa réponse…" detail="Modèle local, sans cloud." />
        <button type="button" className="cmp-btn ghost" onClick={onCancel} data-testid="cmp-chat-cancel">Annuler</button>
      </div>
    );
  }
  if (turn.status === 'FAILED' || turn.status === 'CANCELLED') {
    const failed = turn.status === 'FAILED';
    return (
      <div className="cmp-chat-turn assistant" data-testid={failed ? 'cmp-chat-error' : 'cmp-chat-cancelled'} data-code={turn.error?.code ?? undefined}>
        <p className={`cmp-alert ${failed ? 'danger' : 'muted'}`} role={failed ? 'alert' : 'status'}>{failed ? turn.error?.text : 'Réponse annulée.'}</p>
        {canRetry && <button type="button" className="cmp-btn" onClick={onRetry} data-testid="cmp-chat-retry">Réessayer</button>}
      </div>
    );
  }
  const answer = turn.answer;
  if (!answer) return null;
  const facts = answerFacts(answer);
  const meta = [facts.model, facts.duration, facts.context, facts.graph].filter(Boolean).join(' · ');
  return (
    <div className="cmp-chat-turn assistant" data-testid="cmp-chat-answer" data-request-id={answer.requestId}>
      <span className="cmp-sr">Companion :</span>
      <p className="cmp-chat-text">{answer.text}</p>
      <p className="cmp-muted cmp-chat-meta" data-testid="cmp-chat-meta">{meta}</p>
      {facts.truncated && <p className="cmp-muted">Réponse tronquée à la limite de longueur.</p>}
      {facts.actionIgnored && (
        <p className="cmp-alert info" role="note" data-testid="cmp-chat-action-ignored">
          Le modèle a aussi suggéré une action : elle n’a pas été enregistrée (la conversation ne crée ni n’exécute aucune action).
        </p>
      )}
      {answer.kgProvenance.length > 0 && (
        <details className="cmp-chat-sources" data-testid="cmp-chat-sources">
          <summary>Sources du graphe de connaissances ({answer.kgProvenance.length})</summary>
          <ul className="cmp-list">
            {answer.kgProvenance.map(p => (
              <li key={p.itemId} className="cmp-muted">{displayText(p.sourceRef ?? p.itemId, 200)}{proofs(p.evidenceRefs.length)}</li>
            ))}
          </ul>
        </details>
      )}
      {onExplain && <button type="button" className="cmp-btn ghost" onClick={() => onExplain(answer.requestId)} data-testid="cmp-chat-why">Quels souvenirs ont servi ?</button>}
    </div>
  );
}

export function CompanionChat({ port, active, memoryEnabled, onExplain = null }: Readonly<{
  port: CompanionUiPort; active: boolean; memoryEnabled: boolean; onExplain?: ((requestId: string) => void) | null;
}>) {
  const [state, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const [draft, setDraft] = useState('');
  const inflight = useRef<{ id: string; controller: AbortController } | null>(null);
  const mounted = useRef(true);
  const available = active && typeof port.answer === 'function';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; inflight.current?.controller.abort(); inflight.current = null; };
  }, []);

  const run = useCallback(async (assistantId: string, text: string) => {
    const controller = new AbortController();
    inflight.current = { id: assistantId, controller };
    try {
      const answer = await port.answer!(text, { signal: controller.signal });
      if (mounted.current) dispatch({ type: 'resolve', assistantId, answer });
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) dispatch({ type: 'fail', assistantId, ...errorParts(e) });
    } finally {
      if (inflight.current?.id === assistantId) inflight.current = null;
    }
  }, [port]);

  const send = () => {
    if (!available || !canSend(state, draft)) return;
    const userId = newId('u'); const assistantId = newId('a');
    dispatch({ type: 'send', userId, assistantId, text: draft, at: Date.now() });
    const text = draft;
    setDraft('');
    void run(assistantId, text);
  };
  const cancel = () => {
    const current = inflight.current;
    if (!current) return;
    current.controller.abort();
    inflight.current = null;
    dispatch({ type: 'cancel', assistantId: current.id });
  };
  const retry = (assistantId: string) => {
    const text = questionFor(state, assistantId);
    if (!available || text === null || state.activeId !== null) return;
    const newAssistantId = newId('a');
    dispatch({ type: 'retry', assistantId, newAssistantId, at: Date.now() });
    void run(newAssistantId, text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const busy = state.activeId !== null;
  const tooLong = draft.length > CHAT_LIMITS.maxInputChars;
  return (
    <section className="cmp-card cmp-chat" aria-labelledby="cmp-chat-title" data-testid="cmp-chat">
      <h2 id="cmp-chat-title">Conversation</h2>
      <p className="cmp-muted" data-testid="cmp-chat-mem-state" data-memory={memoryEnabled ? 'ON' : 'OFF'}>
        {memoryEnabled
          ? 'Mémoire activée : vos souvenirs approuvés peuvent servir de contexte. La conversation n’en crée aucun.'
          : 'Mémoire désactivée : aucun souvenir n’est lu ni enregistré par cette conversation.'}
      </p>
      {!available ? (
        <p className="cmp-alert warn" role="note" data-testid="cmp-chat-unavailable">Conversation indisponible : le Companion n’est pas activé.</p>
      ) : (
        <>
          <div className="cmp-chat-log" role="log" aria-live="polite" aria-label="Conversation avec le Companion" data-testid="cmp-chat-log">
            {state.turns.length === 0 && (
              <p className="cmp-muted" data-testid="cmp-chat-empty">
                Posez une question au Companion. Il répond avec un modèle local, sans cloud. Chaque question est traitée
                séparément : l’historique affiché ici n’est pas envoyé au modèle.
              </p>
            )}
            {state.turns.map((t: ChatTurn) => (t.role === 'USER'
              ? <div key={t.id} className="cmp-chat-turn user" data-testid="cmp-chat-user"><span className="cmp-sr">Vous :</span><p className="cmp-chat-text">{t.text}</p></div>
              : <AssistantTurn key={t.id} turn={t} canRetry={!busy} onCancel={cancel} onRetry={() => retry(t.id)} onExplain={memoryEnabled ? onExplain : null} />))}
          </div>
          <form className="cmp-chat-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label htmlFor="cmp-chat-input" className="cmp-sr">Votre question au Companion</label>
            <textarea
              id="cmp-chat-input" className="cmp-input cmp-chat-input" rows={2} value={draft}
              placeholder="Votre question… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"
              onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} aria-invalid={tooLong} data-testid="cmp-chat-input"
            />
            <div className="cmp-row">
              <button type="submit" className="cmp-btn primary" disabled={busy || !canSend(state, draft)} data-testid="cmp-chat-send">Envoyer</button>
              {tooLong && <span className="cmp-muted" role="alert">Question trop longue ({draft.length} / {CHAT_LIMITS.maxInputChars} caractères).</span>}
            </div>
          </form>
        </>
      )}
    </section>
  );
}
