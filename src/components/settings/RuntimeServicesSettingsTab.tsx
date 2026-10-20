// Runtime Supervisor V1 — Paramètres → Runtime / Services.
// Read: state, health, ownership, PID / uptime when known, last exit / error / restart. Act: « Relancer » only when the
// backend says the restart is allowed (closed registry, Docteur-owned, Root Policy). Confirmation before interrupting a
// running service; explicit reset for a blocked one; one operation at a time; sanitized, fixed messages only.
// [RS-KIWIX-RESTART] a DELEGATED service (Kiwix) answers restart.code CHALLENGE_REQUIRED: « Relancer » asks the server for a
// local challenge, shows what the restart does, and only a trusted click / key press on « Confirmer » sends the opaque id
// back. The id is never displayed; no path, PID action, command line or policy detail is shown or sent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';
import { createHttpRuntimePort } from '../../lib/runtime/http-port';
import {
  RuntimeUiError, errorLabel, formatUptime, healthLabel, isBusy, ownershipLabel, restartEffectLabel, restartReasonLabel, stateBadge, stopTimeoutNotice,
  type RestartChallengeDto, type RestartGesture, type RuntimePort, type RuntimeServiceDto, type Tone,
} from '../../lib/runtime/contracts';

const TONE: Record<Tone, { fg: string; bg: string; border: string }> = {
  ok: { fg: '#3dffaa', bg: 'rgba(61,255,170,0.08)', border: 'rgba(61,255,170,0.3)' },
  warn: { fg: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.3)' },
  danger: { fg: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.3)' },
  info: { fg: '#5ee7ff', bg: 'rgba(94,231,255,0.08)', border: 'rgba(94,231,255,0.3)' },
  muted: { fg: '#94a3b8', bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.2)' },
};
const btn = (tone: Tone, disabled: boolean): React.CSSProperties => ({
  background: disabled ? 'transparent' : TONE[tone].bg, border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : TONE[tone].border}`, borderRadius: 6,
  color: disabled ? '#5a4a7a' : TONE[tone].fg, padding: '6px 12px', fontSize: 11, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'monospace',
  display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32,
});
const fmtTime = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleTimeString('fr-FR') : '—');
const POLL_BUSY_MS = 700;
const POLL_IDLE_MS = 10_000;

type Message = { tone: Tone; text: string };
/** What confirmed the ceremony: keyboard activation reports detail 0; a script-dispatched event is not trusted. */
const gestureOf = (e: React.MouseEvent<HTMLButtonElement>): RestartGesture => ({ kind: e.detail === 0 ? 'KEYBOARD' : 'POINTER', trusted: e.nativeEvent.isTrusted === true });

function ServiceCard({ s, onRestart, message, confirming, onAskConfirm, onCancelConfirm, pending, ceremony, onAskCeremony, onConfirmCeremony, onCancelCeremony }: {
  s: RuntimeServiceDto; onRestart: (s: RuntimeServiceDto, opts: { confirmInterrupt?: boolean; resetBlocked?: boolean }) => void; message: Message | undefined;
  confirming: boolean; onAskConfirm: (s: RuntimeServiceDto) => void; onCancelConfirm: () => void; pending: boolean;
  ceremony: RestartChallengeDto | undefined; onAskCeremony: (s: RuntimeServiceDto) => void;
  onConfirmCeremony: (s: RuntimeServiceDto, c: RestartChallengeDto, g: RestartGesture) => void; onCancelCeremony: (s: RuntimeServiceDto) => void;
}) {
  const badge = stateBadge(s.state);
  const busy = isBusy(s) || pending;
  const allowed = s.restart.allowed && !busy && !ceremony;
  const reasonId = `rs-reason-${s.serviceId}`;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const ceremonyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);
  useEffect(() => { if (ceremony) ceremonyRef.current?.focus(); }, [ceremony]);
  const needsConfirm = s.restart.code === 'CONFIRMATION_REQUIRED' || s.restart.code === 'RESET_REQUIRED';
  const needsCeremony = s.restart.code === 'CHALLENGE_REQUIRED';
  const rows: Array<[string, string]> = [
    ['Santé', `${healthLabel(s.health.code)}`],
    ['Propriété', ownershipLabel(s.ownershipClass)],
    ['PID', s.pid === null ? '—' : String(s.pid)],
    ['Disponibilité', formatUptime(s.uptimeMs)],
    ['Dernier code de sortie', s.lastExitCode === null ? '—' : String(s.lastExitCode)],
    ['Dernière relance', fmtTime(s.lastRestartAt)],
  ];
  const err = errorLabel(s.lastError);
  const stopTimeout = stopTimeoutNotice(s);
  return (
    <li data-testid={`rs-service-${s.serviceId}`} data-state={s.state} className="rs-card"
      style={{ border: `1px solid ${TONE[badge.tone].border}`, borderRadius: 8, padding: 12, background: 'rgba(255,255,255,0.02)', listStyle: 'none' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <h4 id={`rs-title-${s.serviceId}`} style={{ margin: 0, fontSize: 13, color: '#e2e8f0', fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{s.displayName}</h4>
          <span data-testid="rs-state" role="status" aria-label={`État : ${badge.label}`}
            style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 999, color: TONE[badge.tone].fg, background: TONE[badge.tone].bg, border: `1px solid ${TONE[badge.tone].border}` }}>{badge.label}</span>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#5a4a7a' }}>{s.optional ? 'optionnel' : 'requis'}</span>
        </div>
        <button type="button" data-testid="rs-restart" disabled={!allowed} aria-disabled={!allowed} aria-describedby={!s.restart.allowed ? reasonId : undefined} aria-busy={busy}
          onClick={() => (needsCeremony ? onAskCeremony(s) : needsConfirm ? onAskConfirm(s) : onRestart(s, {}))} style={btn(s.state === 'BLOCKED' ? 'danger' : 'info', !allowed)}>
          <RotateCcw size={12} className={busy ? 'animate-spin' : undefined} aria-hidden="true" />
          {busy ? 'Relance…' : s.state === 'BLOCKED' ? 'Débloquer et relancer' : 'Relancer'}
        </button>
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '4px 12px', margin: '10px 0 0', fontFamily: 'monospace', fontSize: 11 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}><dt style={{ color: '#5a4a7a', fontSize: 10 }}>{k}</dt><dd style={{ margin: 0, color: '#cbd5e1', overflowWrap: 'anywhere' }}>{v}</dd></div>
        ))}
      </dl>
      {stopTimeout && (
        <div data-testid="rs-stop-timeout" role="status" aria-live="polite"
          style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, border: `1px solid ${TONE.warn.border}`, background: TONE.warn.bg, fontFamily: 'monospace' }}>
          <p style={{ margin: 0, fontSize: 12, color: TONE.warn.fg }}>{stopTimeout.title}</p>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: '#e2e8f0' }}>{stopTimeout.text}</p>
          {stopTimeout.mayStillRun && <p data-testid="rs-stop-timeout-running" style={{ margin: '2px 0 0', fontSize: 11, color: '#e2e8f0' }}>Le service peut encore être actif.</p>}
        </div>
      )}
      {err && <p data-testid="rs-error" style={{ margin: '8px 0 0', fontSize: 11, color: '#f87171', fontFamily: 'monospace' }}>Dernière erreur : {err}</p>}
      {s.note && <p style={{ margin: '6px 0 0', fontSize: 10, color: '#5a4a7a', fontFamily: 'monospace' }}>{s.note}</p>}
      {!s.restart.allowed && (
        <p id={reasonId} data-testid="rs-restart-reason" style={{ margin: '6px 0 0', fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', display: 'flex', gap: 6, alignItems: 'center' }}>
          {(s.restart.code === 'ROOT_POLICY_APPROVAL_REQUIRED' || s.restart.code === 'ROOT_POLICY_DENIED') && <ShieldAlert size={11} aria-hidden="true" />}
          {restartReasonLabel(s.restart.code)}{s.restart.code === 'RESTART_BACKOFF' && s.retryAt ? ` Nouvel essai possible à ${fmtTime(s.retryAt)}.` : ''}
        </p>
      )}
      {confirming && (
        <div role="alertdialog" aria-modal="false" aria-labelledby={`rs-confirm-${s.serviceId}`} data-testid="rs-confirm"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelConfirm(); } }}
          style={{ marginTop: 10, padding: 10, borderRadius: 6, border: `1px solid ${TONE.warn.border}`, background: TONE.warn.bg }}>
          <p id={`rs-confirm-${s.serviceId}`} style={{ margin: 0, fontSize: 11, color: '#fbbf24', fontFamily: 'monospace' }}>
            {s.state === 'BLOCKED'
              ? 'Ce service a planté plusieurs fois de suite. Le débloquer efface ce compteur et tente une nouvelle relance.'
              : 'La relance peut interrompre un travail en cours sur ce service. Continuer ?'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button ref={confirmRef} type="button" data-testid="rs-confirm-yes" style={btn('warn', false)}
              onClick={() => onRestart(s, s.state === 'BLOCKED' ? { resetBlocked: true } : { confirmInterrupt: true })}>
              {s.state === 'BLOCKED' ? 'Débloquer et relancer' : 'Confirmer la relance'}
            </button>
            <button type="button" data-testid="rs-confirm-no" style={btn('muted', false)} onClick={onCancelConfirm}>Annuler</button>
          </div>
        </div>
      )}
      {ceremony && (
        <div role="alertdialog" aria-modal="false" aria-labelledby={`rs-ceremony-title-${s.serviceId}`} aria-describedby={`rs-ceremony-desc-${s.serviceId}`} data-testid="rs-ceremony"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelCeremony(s); } }}
          style={{ marginTop: 10, padding: 10, borderRadius: 6, border: `1px solid ${TONE.warn.border}`, background: TONE.warn.bg }}>
          <p id={`rs-ceremony-title-${s.serviceId}`} style={{ margin: 0, fontSize: 12, color: '#fbbf24', fontFamily: 'monospace' }}>Relancer {s.displayName} ?</p>
          <ul id={`rs-ceremony-desc-${s.serviceId}`} data-testid="rs-ceremony-details" style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11, color: '#e2e8f0', fontFamily: 'monospace', display: 'grid', gap: 2 }}>
            <li>État actuel : {stateBadge(ceremony.state).label}</li>
            <li>Opération : arrêt vérifié du service, puis redémarrage local (127.0.0.1 uniquement).</li>
            {ceremony.effects.map(e => restartEffectLabel(e)).filter(Boolean).map(text => <li key={text}>{text}</li>)}
            <li>Confirmation à usage unique, valable jusqu’à {fmtTime(ceremony.expiresAt)}.</li>
          </ul>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button ref={ceremonyRef} type="button" data-testid="rs-ceremony-confirm" disabled={pending} style={btn('warn', pending)}
              onClick={(e) => onConfirmCeremony(s, ceremony, gestureOf(e))}>Confirmer la relance</button>
            <button type="button" data-testid="rs-ceremony-cancel" style={btn('muted', false)} onClick={() => onCancelCeremony(s)}>Annuler</button>
          </div>
        </div>
      )}
      <p aria-live="polite" data-testid="rs-message" style={{ margin: message ? '8px 0 0' : 0, fontSize: 11, fontFamily: 'monospace', color: message ? TONE[message.tone].fg : undefined }}>{message?.text ?? ''}</p>
    </li>
  );
}

export function RuntimeServicesSettingsTab({ port: injected, baseUrl }: { port?: RuntimePort; baseUrl?: string }) {
  const port = useMemo(() => injected ?? createHttpRuntimePort({ baseUrl: baseUrl ?? `${window.location.protocol}//${window.location.hostname}:3001` }), [injected, baseUrl]);
  const [services, setServices] = useState<RuntimeServiceDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [ceremonies, setCeremonies] = useState<Record<string, RestartChallengeDto>>({});
  const watching = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>()); // synchronous guard: a double click never sends two ceremony requests
  const dropCeremony = useCallback((serviceId: string) => setCeremonies(c => { const n = { ...c }; delete n[serviceId]; return n; }), []);

  const load = useCallback(async () => {
    try {
      const list = await port.list();
      setServices(list); setLoadError(null);
      for (const s of list) {
        if (!watching.current.has(s.serviceId) || isBusy(s)) continue;
        watching.current.delete(s.serviceId);
        const ok = s.state === 'HEALTHY';
        setMessages(m => ({ ...m, [s.serviceId]: ok ? { tone: 'ok', text: 'Relance réussie : le service est sain.' } : { tone: 'danger', text: `Relance échouée : ${errorLabel(s.lastError) ?? stateBadge(s.state).label}` } }));
      }
    } catch (e) {
      setLoadError(e instanceof RuntimeUiError ? e.message : 'Docteur est injoignable.');
    }
  }, [port]);

  const busy = (services ?? []).some(isBusy) || watching.current.size > 0;
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => clearTimeout(t);
  }, [services, busy, load]);

  const restart = useCallback(async (s: RuntimeServiceDto, opts: { confirmInterrupt?: boolean; resetBlocked?: boolean }) => {
    if (pending[s.serviceId]) return; // no double submission
    setConfirming(null);
    setPending(p => ({ ...p, [s.serviceId]: true }));
    setMessages(m => ({ ...m, [s.serviceId]: { tone: 'info', text: 'Relance en cours…' } }));
    try {
      await port.restart(s.serviceId, opts);
      watching.current.add(s.serviceId);
    } catch (e) {
      const text = e instanceof RuntimeUiError
        ? `${e.message}${e.retryAt ? ` Nouvel essai possible à ${fmtTime(e.retryAt)}.` : ''}`
        : 'Relance impossible.';
      setMessages(m => ({ ...m, [s.serviceId]: { tone: 'danger', text } }));
    } finally {
      setPending(p => { const n = { ...p }; delete n[s.serviceId]; return n; });
      void load();
    }
  }, [pending, port, load]);

  const failText = (e: unknown, fallback: string) => (e instanceof RuntimeUiError ? e.message : fallback);
  /** Ceremony step 1: the server issues a challenge for the current instance (or explains why not). */
  const askCeremony = useCallback(async (s: RuntimeServiceDto) => {
    if (inFlight.current.has(s.serviceId)) return;
    inFlight.current.add(s.serviceId);
    setConfirming(null);
    setPending(p => ({ ...p, [s.serviceId]: true }));
    setMessages(m => { const n = { ...m }; delete n[s.serviceId]; return n; });
    try {
      const c = await port.createRestartChallenge(s.serviceId);
      setCeremonies(x => ({ ...x, [s.serviceId]: c }));
    } catch (e) {
      setMessages(m => ({ ...m, [s.serviceId]: { tone: 'danger', text: failText(e, 'Relance impossible.') } }));
    } finally {
      inFlight.current.delete(s.serviceId);
      setPending(p => { const n = { ...p }; delete n[s.serviceId]; return n; });
    }
  }, [port]);
  /** Ceremony step 2: only a trusted gesture sends the opaque id back; the dialog closes first, so it can never be resent. */
  const confirmCeremony = useCallback(async (s: RuntimeServiceDto, c: RestartChallengeDto, gesture: RestartGesture) => {
    if (inFlight.current.has(s.serviceId)) return;
    dropCeremony(s.serviceId);
    if (!gesture.trusted) { setMessages(m => ({ ...m, [s.serviceId]: { tone: 'danger', text: 'Confirmation refusée : geste non reconnu.' } })); return; }
    inFlight.current.add(s.serviceId);
    setPending(p => ({ ...p, [s.serviceId]: true }));
    setMessages(m => ({ ...m, [s.serviceId]: { tone: 'info', text: 'Relance en cours…' } }));
    try {
      await port.confirmRestart(s.serviceId, c.challengeId, gesture);
      watching.current.add(s.serviceId);
      await load(); // stay busy until the server's own "operation in progress" is on screen (no enabled-button gap)
    } catch (e) {
      setMessages(m => ({ ...m, [s.serviceId]: { tone: 'danger', text: failText(e, 'Relance impossible.') } }));
    } finally {
      inFlight.current.delete(s.serviceId);
      setPending(p => { const n = { ...p }; delete n[s.serviceId]; return n; });
      void load();
    }
  }, [port, load, dropCeremony]);
  const cancelCeremony = useCallback((s: RuntimeServiceDto) => {
    dropCeremony(s.serviceId); // nothing is sent: the unused challenge expires server-side
    setMessages(m => ({ ...m, [s.serviceId]: { tone: 'muted', text: 'Relance annulée.' } }));
  }, [dropCeremony]);

  return (
    <section aria-labelledby="rs-heading" className="px-5 py-4" data-testid="runtime-services">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <div>
          <h3 id="rs-heading" style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0', letterSpacing: '0.08em' }}>RUNTIME / SERVICES</h3>
          <p style={{ margin: '2px 0 0', fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a' }}>État des services connus de Docteur. Seuls les services détenus par Docteur peuvent être relancés.</p>
        </div>
        <button type="button" data-testid="rs-refresh" onClick={() => { void load(); }} style={btn('muted', false)}><RefreshCw size={11} aria-hidden="true" /> Actualiser</button>
      </div>
      {loadError && <p role="alert" data-testid="rs-load-error" style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171' }}>{loadError}</p>}
      {!services && !loadError && <p style={{ fontFamily: 'monospace', fontSize: 11, color: '#5a4a7a' }}>Chargement…</p>}
      {services && (
        <ul aria-label="Services Docteur" style={{ display: 'grid', gap: 10, padding: 0, margin: 0 }}>
          {services.map(s => (
            <ServiceCard key={s.serviceId} s={s} message={messages[s.serviceId]} pending={Boolean(pending[s.serviceId]) || watching.current.has(s.serviceId)}
              confirming={confirming === s.serviceId} onAskConfirm={(x) => setConfirming(x.serviceId)} onCancelConfirm={() => setConfirming(null)} onRestart={restart}
              ceremony={ceremonies[s.serviceId]} onAskCeremony={(x) => { void askCeremony(x); }} onConfirmCeremony={(x, c, g) => { void confirmCeremony(x, c, g); }} onCancelCeremony={cancelCeremony} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default RuntimeServicesSettingsTab;
