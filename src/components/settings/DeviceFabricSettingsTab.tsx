import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle, Cpu, Link2, MonitorSmartphone, Pencil, Plus, RefreshCw, Send, Sparkles, Trash2, Unlink } from 'lucide-react';
import {
  cortexClient,
  type FabricActionType,
  type FabricAgentIdentity,
  type FabricAgentLink,
  type FabricAgentType,
  type FabricAuditEvent,
  type FabricDevice,
  type FabricDirection,
  type FabricOperation,
  type FabricTri,
} from '../../lib/cortex/client';

const STATE_COLORS: Record<string, string> = {
  ONLINE: '#3dffaa', AVAILABLE: '#3dffaa', TRUSTED: '#3dffaa', YES: '#3dffaa',
  PARTIAL: '#f59e0b', UNKNOWN: '#9b91b4',
  OFFLINE: '#7a6c9a', UNAVAILABLE: '#7a6c9a', NO: '#7a6c9a',
  REVOKED: '#ff4d58', ERROR: '#ff4d58',
};

// Direction wording follows the real agent models: OMEGA V1 is host-side
// only, RASSILON has one direction per role.
const DIRECTION_LABELS: Record<FabricDirection, string> = {
  REMOTE_ACTS_ON_THIS_PC: 'Cet appareil peut agir sur ce PC',
  THIS_PC_SENDS_COMPUTE: 'Ce PC peut envoyer du calcul à cet appareil',
  DEVICE_SENDS_COMPUTE: 'Cet appareil peut envoyer du calcul à ce PC',
  LOCAL_WORKER: 'Worker RASSILON de ce PC',
};

// OMEGA V1 has no outbound client: Fabric can never drive OMEGA from here.
const ROUTING_LABELS: Record<string, string> = {
  NOT_ROUTABLE: 'NOT AVAILABLE',
  READY: 'READY — worker exact uniquement',
  NOT_AVAILABLE: 'NOT AVAILABLE',
};

const ROUTING_REASON_LABELS: Record<string, string> = {
  omega_outbound_client_not_implemented: 'OMEGA outbound client not implemented — aucun client OMEGA sortant en V1.',
  rassilon_identity_missing: 'identité RASSILON introuvable (lien périmé).',
  rassilon_fingerprint_mismatch: 'la clé RASSILON a changé depuis le lien.',
  cross_agent_key_reuse: 'même clé dans OMEGA et RASSILON.',
  agent_projection_error: 'état RASSILON illisible (projection en erreur).',
  rassilon_identity_revoked: 'identité RASSILON révoquée.',
  rassilon_identity_untrusted: 'identité RASSILON non confirmée.',
  rassilon_target_not_a_worker: 'cet appareil n’est pas un worker pour ce PC.',
  session_expired: 'SESSION EXPIRED — refaire le pairing dans RASSILON (aucun renouvellement Fabric).',
  session_revoked: 'session RASSILON révoquée (STOP local ou révocation).',
  session_missing: 'aucune session RASSILON — appairer dans RASSILON.',
  session_unknown: 'état de session RASSILON inconnu pour ce sens.',
  presence_not_verified: 'présence non vérifiée récemment — cliquer VÉRIFIER LA DISPONIBILITÉ.',
  capability_not_authorized: 'aucune capacité autorisée par le worker.',
  capability_not_supported: 'aucune capacité supportée annoncée.',
  target_not_available: 'worker indisponible.',
};

const OPERATION_ERROR_LABELS: Record<string, string> = {
  interrupted_by_restart: 'interrompue par un redémarrage (non reprise)',
  result_stale: 'résultat périmé refusé',
  result_timestamp_invalid: 'horodatage du résultat invalide',
  result_authenticity_invalid: 'résultat non authentique pour ce worker / ce job',
  result_binding_invalid: 'résultat non lié à ce worker / ce job',
  result_schema_invalid: 'résultat non conforme (schéma ou valeur)',
  result_timeout: 'délai dépassé',
  result_unreachable: 'résultat injoignable',
  session_unavailable: 'session RASSILON indisponible',
  target_revoked: 'worker révoqué pendant l’opération',
};

// Mirrors lib/device-fabric-agents.js: presence is fresh for 30 s, a session
// is "expiring" in its last 3 minutes. Display aging only — no network.
const PRESENCE_STALE_AFTER_MS = 90_000;
const SESSION_EXPIRING_MS = 3 * 60_000;

/**
 * Ages the presence/session a RASSILON link reported at fetch time by the
 * local time elapsed since, so an AVAILABLE shown on screen turns UNKNOWN
 * once its verification is older than the freshness window, and a session
 * turns EXPIRED at its expiry — without any network call. Pure; the server
 * applies the same rules when routing.
 */
function ageLinkForDisplay(link: FabricAgentLink, elapsedMs: number): FabricAgentLink {
  if (link.agentType !== 'RASSILON' || link.linkState !== 'OK' || elapsedMs <= 0) return link;
  let changed = false;
  const directions = link.directions.map(block => {
    if (!block.presence || !block.session) return block;
    const ageMs = block.presence.ageMs === null ? null : block.presence.ageMs + elapsedMs;
    let presenceState = block.presence.state;
    if (presenceState === 'VERIFIED' && ageMs !== null && ageMs > block.presence.freshnessWindowMs) presenceState = ageMs > PRESENCE_STALE_AFTER_MS ? 'NOT_VERIFIED' : 'STALE';
    if (presenceState === 'STALE' && ageMs !== null && ageMs > PRESENCE_STALE_AFTER_MS) presenceState = 'NOT_VERIFIED';
    const expiresInMs = block.session.expiresInMs === null ? null : Math.max(0, block.session.expiresInMs - elapsedMs);
    let sessionState = block.session.state;
    if ((sessionState === 'VALID' || sessionState === 'EXPIRING') && expiresInMs !== null) {
      sessionState = expiresInMs <= 0 ? 'EXPIRED' : expiresInMs <= SESSION_EXPIRING_MS ? 'EXPIRING' : 'VALID';
    }
    const expired = sessionState === 'EXPIRED';
    const stale = presenceState !== 'VERIFIED';
    if (!expired && !stale) return { ...block, presence: { ...block.presence, ageMs }, session: { ...block.session, state: sessionState, expiresInMs } };
    changed = changed || block.availability === 'AVAILABLE' || expired !== (block.session.state === 'EXPIRED');
    const availability = expired ? 'UNAVAILABLE' : block.availability === 'AVAILABLE' ? 'UNKNOWN' : block.availability;
    return {
      ...block,
      availability,
      presence: { ...block.presence, state: presenceState, ageMs },
      session: { ...block.session, state: sessionState, expiresInMs },
      capabilities: block.capabilities.map(cap => ({
        ...cap,
        routable: false,
        available: expired ? 'NO' as const : cap.available === 'YES' ? 'UNKNOWN' as const : cap.available,
      })),
    };
  });
  const aged = { ...link, directions };
  if (!changed && !directions.some((b, i) => b !== link.directions[i])) return link;
  const routable = directions.some(block => block.capabilities.some(cap => cap.routable));
  const worker = directions.find(block => block.direction === 'THIS_PC_SENDS_COMPUTE');
  return {
    ...aged,
    routable,
    availability: worker?.availability ?? link.availability,
    routingStatus: routable ? 'READY' : 'NOT_AVAILABLE',
    routingReason: routable ? null : worker?.session?.state === 'EXPIRED' ? 'session_expired' : worker?.presence?.state !== 'VERIFIED' ? 'presence_not_verified' : link.routingReason,
  };
}

// Same rule as computeDeviceState() in lib/device-fabric.js.
function deviceStateFrom(availabilities: string[]): string {
  if (availabilities.length === 0) return 'UNKNOWN';
  if (availabilities.includes('ERROR')) return 'ERROR';
  const available = availabilities.filter(a => a === 'AVAILABLE').length;
  if (available === availabilities.length) return 'ONLINE';
  if (available > 0) return 'PARTIAL';
  if (availabilities.every(a => a === 'UNAVAILABLE')) return 'OFFLINE';
  return 'UNKNOWN';
}

function secondsAgo(ms: number | null) {
  return ms === null ? '—' : `${Math.round(ms / 1000)} s`;
}

const ACTION_LABELS: Record<FabricActionType, string> = {
  RASSILON_SAFE_CPU: 'CALCUL TEST',
  RASSILON_EMBEDDING: 'EMBEDDINGS',
};

// Fixed, harmless test computation: SHA-256 of a constant buffer.
const TEST_COMPUTE_HEX = Array.from(new TextEncoder().encode('docteur-device-fabric-test'), b => b.toString(16).padStart(2, '0')).join('');

// Mirrors the backend bounds (lib/device-fabric-routing.js FABRIC_LIMITS);
// the backend and RASSILON revalidate everything.
const EMBEDDING_LIMITS = { texts: 16, charsPerText: 2_000, totalChars: 16_000 };
const EMBEDDING_MODELS = ['nomic-embed-text'] as const;
const TERMINAL_OPERATION = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'NOT_AVAILABLE']);

function embeddingIssues(texts: string[]): string[] {
  const issues: string[] = [];
  if (texts.length === 0) issues.push('Au moins un texte (une ligne par texte).');
  if (texts.length > EMBEDDING_LIMITS.texts) issues.push(`Au plus ${EMBEDDING_LIMITS.texts} textes.`);
  if (texts.some(text => text.length > EMBEDDING_LIMITS.charsPerText)) issues.push(`Au plus ${EMBEDDING_LIMITS.charsPerText} caractères par texte.`);
  if (texts.reduce((sum, text) => sum + text.length, 0) > EMBEDDING_LIMITS.totalChars) issues.push(`Au plus ${EMBEDDING_LIMITS.totalChars} caractères au total.`);
  return issues;
}

const ERROR_LABELS: Record<string, string> = {
  cross_agent_key_reuse: 'Lien refusé : la même clé existe dans OMEGA et RASSILON (réutilisation de clé).',
  agent_identity_revoked: 'Lien refusé : cette identité est révoquée.',
  agent_identity_not_found: 'Lien refusé : identité introuvable.',
  agent_identity_already_linked: 'Lien refusé : identité déjà liée à un autre appareil.',
  agent_type_already_linked_on_device: 'Lien refusé : cet appareil a déjà un lien de ce type.',
  fingerprint_confirmation_mismatch: 'Lien refusé : l’empreinte a changé entre-temps.',
  display_name_taken: 'Ce nom est déjà utilisé.',
  display_name_charset_invalid: 'Nom invalide : lettres, chiffres, espaces et ponctuation simple uniquement.',
  display_name_length_invalid: 'Nom invalide : 1 à 64 caractères.',
  removal_requires_link_confirmation: 'Suppression : confirmation des liens requise.',
  not_routable: 'OMEGA n’est pas routable depuis Fabric (aucun client OMEGA sortant).',
  rassilon_not_linked: 'Routage refusé : aucun worker RASSILON lié à cet appareil.',
  rassilon_identity_revoked: 'Routage refusé : l’identité RASSILON est révoquée.',
  rassilon_identity_missing: 'Routage refusé : l’identité RASSILON liée n’existe plus.',
  rassilon_fingerprint_mismatch: 'Routage refusé : la clé RASSILON a changé depuis le lien.',
  rassilon_target_not_a_worker: 'Routage refusé : cet appareil n’est pas un worker pour ce PC.',
  capability_not_supported: 'Routage refusé : capacité non supportée par le worker.',
  capability_support_unknown: 'Routage refusé : support de la capacité inconnu (vérifiez la disponibilité).',
  capability_not_authorized: 'Routage refusé : capacité non autorisée par le worker.',
  target_not_available: 'Routage refusé : worker indisponible (session RASSILON absente ou expirée).',
  target_availability_unknown: 'Routage refusé : disponibilité inconnue — vérifiez la disponibilité du worker.',
  no_eligible_worker: 'Refusé par RASSILON : le worker exact ne satisfait pas sa politique (ressources, modèle).',
  session_unavailable: 'Session RASSILON indisponible : ré-appairer dans RASSILON.',
  fabric_operation_limit_reached: 'Trop d’opérations en cours : attendez qu’elles se terminent.',
  local_rassilon_identity_missing: 'Identité RASSILON locale absente : configurez RASSILON d’abord.',
  internal_error: 'Erreur interne Device Fabric (base de données ou projection agent).',
  agent_projection_error: 'Refusé : l’état de l’agent est illisible (projection en erreur).',
  rassilon_link_unsafe: 'Routage refusé : le lien RASSILON n’est pas sûr.',
  probe_failed: 'Vérification échouée : le worker exact n’a pas répondu (aucun autre worker contacté).',
};

const cardStyle = {
  border: '1px solid rgba(94,231,255,0.12)',
  background: 'rgba(8,7,18,0.52)',
  borderRadius: 8,
  padding: 14,
} as const;

const inputStyle = {
  borderRadius: 5, padding: '6px 8px', fontSize: 12,
  color: '#d8d0ee', background: 'rgba(255,255,255,0.035)',
  border: '1px solid rgba(255,255,255,0.12)', outline: 'none',
} as const;

/** Agent-supplied names are untrusted: drop control/bidi characters and cap length. */
function safeText(value: string | null | undefined, max = 80): string {
  if (!value) return '—';
  const cleaned = value.replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩‎‏]/g, '');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function shortFingerprint(value: string | null | undefined) {
  if (!value) return '—';
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Jamais';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Inconnu' : parsed.toLocaleString('fr-FR');
}

function errorText(error: unknown) {
  const code = error instanceof Error ? error.message : 'device_fabric_request_failed';
  if (ERROR_LABELS[code]) return ERROR_LABELS[code];
  // Server errors are short snake_case codes; anything else (network failure,
  // unexpected body) is not echoed — it only means the API was not reached.
  return /^[a-z0-9_]{1,64}$/.test(code) ? `Erreur : ${code}` : 'API Device Fabric injoignable.';
}

function Badge({ value, label }: { value: string; label?: string }) {
  const color = STATE_COLORS[value] ?? STATE_COLORS.UNKNOWN;
  return (
    <span className="font-mono" style={{ fontSize: 10, color, border: `1px solid ${color}55`, borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>
      {label ? `${label} ` : ''}{value}
    </span>
  );
}

function ActionButton({ children, onClick, disabled, danger = false, title }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  const color = danger ? '#ff4d58' : '#5ee7ff';
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="font-mono text-xs"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 9px', borderRadius: 5,
        color: disabled ? '#4b4262' : color, border: `1px solid ${disabled ? '#302941' : `${color}55`}`,
        background: disabled ? 'rgba(255,255,255,0.015)' : `${color}10`, cursor: disabled ? 'not-allowed' : 'pointer',
      }}>
      {children}
    </button>
  );
}

function TriCell({ value, unreachable }: { value: FabricTri; unreachable: boolean }) {
  const shown = unreachable ? 'UNKNOWN' : value;
  return <td style={{ color: STATE_COLORS[shown], padding: '2px 8px 2px 0' }}>{shown}</td>;
}

interface LinkDialogState {
  fabricDeviceId: string;
  agentType: FabricAgentType;
  agentDeviceId: string | null;
  verified: boolean;
}

export function DeviceFabricSettingsTab() {
  const [devices, setDevices] = useState<FabricDevice[]>([]);
  const [agents, setAgents] = useState<Record<FabricAgentType, FabricAgentIdentity[]>>({ OMEGA: [], RASSILON: [] });
  const [audit, setAudit] = useState<FabricAuditEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [linkDialog, setLinkDialog] = useState<LinkDialogState | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [operations, setOperations] = useState<FabricOperation[]>([]);
  const [embedDraft, setEmbedDraft] = useState<{ fabricDeviceId: string; text: string; model: string } | null>(null);
  const [agentErrors, setAgentErrors] = useState<Partial<Record<FabricAgentType, string>>>({});
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [clock, setClock] = useState(() => Date.now());

  // Read-only: listing devices/operations never routes anything.
  const refresh = useCallback(async () => {
    try {
      const [nextDevices, nextAgents, nextAudit, nextOperations] = await Promise.all([
        cortexClient.deviceFabricDevices(), cortexClient.deviceFabricAgents(), cortexClient.deviceFabricAudit(20),
        cortexClient.deviceFabricOperations(10),
      ]);
      const now = Date.now();
      setFetchedAt(now);
      setClock(now);
      setDevices(nextDevices.devices);
      setAgents(nextAgents.agents);
      setAgentErrors(nextAgents.agentErrors ?? {});
      setAudit(nextAudit.events);
      setOperations(nextOperations.operations);
      setUnreachable(false);
      setError(null);
    } catch (nextError) {
      setUnreachable(true);
      setError(errorText(nextError));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Local clock for display aging of RASSILON presence/session. It only
  // re-renders; it never calls the API (no heartbeat, no probe).
  const hasRassilonWorkerLink = devices.some(device => device.agents.RASSILON?.directions.some(block => block.presence));
  useEffect(() => {
    if (!hasRassilonWorkerLink) return;
    const tick = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [hasRassilonWorkerLink]);
  const elapsedMs = Math.max(0, clock - fetchedAt);

  // While an operation is still running, re-read its status (GET only).
  const pendingOperations = operations.some(operation => !TERMINAL_OPERATION.has(operation.status));
  useEffect(() => {
    if (!pendingOperations || unreachable) return;
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [pendingOperations, unreachable, refresh]);

  const run = useCallback(async (task: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await task();
      setNotice(success);
      setPendingConfirm(null);
      await refresh();
      return true;
    } catch (nextError) {
      setError(errorText(nextError));
      // A confirmation is consumed by the attempt, whatever its outcome: the
      // next send always needs a fresh two-step confirmation.
      setPendingConfirm(null);
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const actionsDisabled = busy || unreachable || !loaded;
  const dialogDevice = linkDialog ? devices.find(d => d.fabricDeviceId === linkDialog.fabricDeviceId) ?? null : null;
  const candidates = linkDialog
    ? agents[linkDialog.agentType].filter(identity => !identity.linkedFabricDeviceId && identity.trust !== 'REVOKED' && identity.fingerprint)
    : [];
  const selected = linkDialog?.agentDeviceId ? candidates.find(identity => identity.agentDeviceId === linkDialog.agentDeviceId) ?? null : null;

  const routeTo = async (device: FabricDevice, actionType: FabricActionType, semanticPayload: Record<string, unknown>) => {
    const ok = await run(
      () => cortexClient.deviceFabricRoute({ fabricDeviceId: device.fabricDeviceId, actionType, semanticPayload }),
      `${ACTION_LABELS[actionType]} envoyé au worker exact de « ${safeText(device.displayName, 64)} ».`,
    );
    // A refused route is still recorded (NOT_AVAILABLE / FAILED): show it,
    // without clearing the error message. Read-only.
    if (!ok) {
      try { setOperations((await cortexClient.deviceFabricOperations(10)).operations); } catch { /* error already shown */ }
    }
    return ok;
  };

  // Bounded RASSILON actions, only towards a worker this PC may send compute to.
  const renderRassilonActions = (device: FabricDevice, link: FabricAgentLink) => {
    const block = link.directions.find(d => d.direction === 'THIS_PC_SENDS_COMPUTE');
    if (!block || link.linkState !== 'OK') return null;
    const routable = (name: string) => !unreachable && block.capabilities.some(cap => cap.name === name && cap.routable);
    const workerLabel = `${safeText(link.identity?.displayName ?? link.agentDeviceId, 48)} · ${shortFingerprint(link.linkedFingerprint)}`;
    const computeKey = `compute:${device.fabricDeviceId}`;
    const draft = embedDraft?.fabricDeviceId === device.fabricDeviceId ? embedDraft : null;
    const texts = draft ? draft.text.split('\n').map(line => line.trim()).filter(line => line.length > 0) : [];
    const issues = draft ? embeddingIssues(texts) : [];
    const embedKey = `embed:${device.fabricDeviceId}`;
    return (
      <div className="mt-1 flex flex-col gap-2" data-testid="rassilon-actions">
        <div className="flex flex-wrap gap-2">
          <ActionButton disabled={actionsDisabled || link.trust !== 'TRUSTED'}
            onClick={() => void run(() => cortexClient.deviceFabricProbe(device.fabricDeviceId), 'Disponibilité vérifiée auprès du worker exact.')}>
            <Activity size={12} /> VÉRIFIER LA DISPONIBILITÉ
          </ActionButton>
          <ActionButton disabled={actionsDisabled || !routable('SAFE_CPU_TASK')}
            title={routable('SAFE_CPU_TASK') ? undefined : 'SAFE_CPU_TASK non routable : SUPPORTED, AUTHORIZED et AVAILABLE doivent valoir YES'}
            onClick={() => pendingConfirm === computeKey
              ? void routeTo(device, 'RASSILON_SAFE_CPU', { kind: 'HASH_BUFFER', data: { hex: TEST_COMPUTE_HEX, algorithm: 'sha256' } })
              : setPendingConfirm(computeKey)}>
            <Cpu size={12} /> {pendingConfirm === computeKey ? 'CONFIRMER LE CALCUL TEST' : 'CALCUL TEST'}
          </ActionButton>
          <ActionButton disabled={actionsDisabled || !routable('EMBEDDING_BATCH')}
            title={routable('EMBEDDING_BATCH') ? undefined : 'EMBEDDING_BATCH non routable : SUPPORTED, AUTHORIZED et AVAILABLE doivent valoir YES'}
            onClick={() => setEmbedDraft(draft ? null : { fabricDeviceId: device.fabricDeviceId, text: '', model: EMBEDDING_MODELS[0] })}>
            <Sparkles size={12} /> EMBEDDINGS
          </ActionButton>
        </div>
        {pendingConfirm === computeKey && (
          <p style={{ color: '#f59e0b' }}>Calcul SHA-256 fixe, envoyé uniquement à : {workerLabel}. Aucun autre worker ne sera utilisé.</p>
        )}
        {draft && routable('EMBEDDING_BATCH') && (
          <div aria-label="Embeddings RASSILON" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
            <p style={{ color: '#817697' }}>
              Worker exact : {workerLabel}. Modèle local uniquement, aucun cloud, aucun téléchargement.
              Limites : {EMBEDDING_LIMITS.texts} textes, {EMBEDDING_LIMITS.charsPerText} caractères par texte, {EMBEDDING_LIMITS.totalChars} au total.
            </p>
            <textarea aria-label="Textes à vectoriser (un par ligne)" rows={4} value={draft.text}
              onChange={event => setEmbedDraft({ ...draft, text: event.target.value })}
              style={{ ...inputStyle, width: '100%', marginTop: 6, fontFamily: 'inherit' }} />
            <label className="block mt-1" style={{ color: '#817697' }}>Modèle local autorisé{' '}
              <select aria-label="Modèle d’embedding" value={draft.model} onChange={event => setEmbedDraft({ ...draft, model: event.target.value })} style={inputStyle}>
                {EMBEDDING_MODELS.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
            </label>
            <p style={{ color: '#6f6588' }}>{texts.length} texte(s) · {texts.reduce((sum, text) => sum + text.length, 0)} caractère(s)</p>
            {issues.length > 0 && <ul style={{ color: '#ff7d85' }}>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
            <div className="mt-2">
              <ActionButton disabled={actionsDisabled || issues.length > 0}
                onClick={() => pendingConfirm === embedKey
                  ? void routeTo(device, 'RASSILON_EMBEDDING', { texts, model: draft.model }).then(ok => { if (ok) setEmbedDraft(null); })
                  : setPendingConfirm(embedKey)}>
                <Send size={12} /> {pendingConfirm === embedKey ? 'CONFIRMER L’ENVOI' : 'ENVOYER LES EMBEDDINGS'}
              </ActionButton>
            </div>
          </div>
        )}
      </div>
    );
  };

  const deviceName = (fabricDeviceId: string) => safeText(devices.find(d => d.fabricDeviceId === fabricDeviceId)?.displayName ?? fabricDeviceId, 48);

  const operationSummary = (operation: FabricOperation) => {
    const summary = operation.resultSummary;
    if (!summary) {
      if (!operation.safeError) return '—';
      const label = OPERATION_ERROR_LABELS[operation.safeError] ?? ROUTING_REASON_LABELS[operation.safeError] ?? ERROR_LABELS[operation.safeError];
      return `Erreur : ${safeText(operation.safeError, 64)}${label ? ` — ${label}` : ''}`;
    }
    if (operation.jobType === 'EMBEDDING_BATCH') {
      return `${Number(summary.vectorCount)} vecteur(s) × ${Number(summary.dimensions)} · ${safeText(String(summary.model), 40)}`;
    }
    if (summary.kind === 'HASH_BUFFER') return `${safeText(String(summary.algorithm), 10)} ${safeText(String(summary.digest), 16)}… (${Number(summary.inputBytes)} octets)`;
    return safeText(JSON.stringify(summary), 120);
  };

  const operationDuration = (operation: FabricOperation) => {
    const start = Date.parse(operation.startedAt ?? operation.createdAt);
    const end = Date.parse(operation.completedAt ?? '');
    return Number.isFinite(start) && Number.isFinite(end) ? `${Math.max(0, end - start)} ms` : '—';
  };

  const renderAgent = (device: FabricDevice, agentType: FabricAgentType) => {
    const fetched = device.agents[agentType];
    const link: FabricAgentLink | null = fetched ? ageLinkForDisplay(fetched, elapsedMs) : null;
    if (!link) {
      return (
        <div className="font-mono text-xs" style={{ color: '#817697' }}>
          <p>Lié : NON</p>
          <div className="mt-2">
            <ActionButton disabled={actionsDisabled} onClick={() => setLinkDialog({ fabricDeviceId: device.fabricDeviceId, agentType, agentDeviceId: null, verified: false })}>
              <Link2 size={12} /> LINK {agentType}
            </ActionButton>
          </div>
        </div>
      );
    }
    const trust = unreachable ? 'UNKNOWN' : link.trust;
    const availability = unreachable ? 'UNKNOWN' : link.availability;
    const unlinkKey = `unlink:${device.fabricDeviceId}:${agentType}`;
    return (
      <div className="font-mono text-xs flex flex-col gap-1" style={{ color: '#aaa0bf' }}>
        <p>Lié : OUI · {safeText(link.identity?.displayName ?? link.agentDeviceId)}</p>
        <div className="flex flex-wrap gap-2">
          <Badge value={trust} label="Trust" />
          <Badge value={availability} label="Disponibilité" />
          {link.linkState !== 'OK' && <Badge value="ERROR" label={`Lien ${link.linkState}`} />}
        </div>
        <p title={link.linkedFingerprint} style={{ overflowWrap: 'anywhere' }}>
          Empreinte {shortFingerprint(link.linkedFingerprint)} · Identité {safeText(link.agentDeviceId, 64)}
        </p>
        {link.linkState === 'MISSING' && <p style={{ color: '#ff7d85' }}>Identité {agentType} introuvable : lien conservé, à délier manuellement.</p>}
        {link.linkState === 'FINGERPRINT_MISMATCH' && <p style={{ color: '#ff7d85' }}>La clé {agentType} a changé depuis le lien : identité non confirmée.</p>}
        {link.linkState === 'CROSS_AGENT_KEY_REUSE' && <p style={{ color: '#ff7d85' }}>Même clé dans OMEGA et RASSILON : réutilisation de clé, identité non fiable.</p>}
        {link.linkState === 'AGENT_ERROR' && <p style={{ color: '#ff7d85' }}>État {agentType} illisible (projection en erreur) : rien n’est supposé, routage désactivé.</p>}
        {link.directions.map(block => (
          <div key={block.direction} className="mt-1">
            <p style={{ color: '#5ee7ff' }}>{DIRECTION_LABELS[block.direction]}</p>
            {block.presence && block.session && (
              <div className="flex flex-wrap items-center gap-2 my-1" data-testid="rassilon-freshness">
                <Badge value={unreachable ? 'UNKNOWN' : block.presence.state} label="Présence" />
                <Badge value={unreachable ? 'UNKNOWN' : block.session.state} label="Session" />
                <span style={{ color: '#6f6588' }}>
                  Dernière vérification : {formatDate(block.presence.lastVerifiedAt)} · fraîcheur {secondsAgo(block.presence.ageMs)} / fenêtre {Math.round(block.presence.freshnessWindowMs / 1000)} s
                  {block.session.expiresInMs !== null && block.session.state !== 'EXPIRED' ? ` · session expire dans ${Math.max(0, Math.ceil(block.session.expiresInMs / 60_000))} min` : ''}
                </span>
              </div>
            )}
            <table style={{ fontSize: 10 }}>
              <thead><tr style={{ color: '#5f5576', textAlign: 'left' }}><th style={{ paddingRight: 8 }}>Capacité</th><th style={{ paddingRight: 8 }}>SUPPORTED</th><th style={{ paddingRight: 8 }}>AUTHORIZED</th><th>AVAILABLE</th></tr></thead>
              <tbody>
                {block.capabilities.map(cap => (
                  <tr key={cap.name}>
                    <td style={{ color: '#d8d0ee', padding: '2px 8px 2px 0' }}>{cap.name}</td>
                    <TriCell value={cap.supported} unreachable={unreachable} />
                    <TriCell value={cap.authorized} unreachable={unreachable} />
                    <TriCell value={cap.available} unreachable={unreachable} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {agentType === 'OMEGA' && link.linkState === 'OK' && <p style={{ color: '#6f6588' }}>Dernière session OMEGA : {formatDate(link.identity?.lastSessionAt)}</p>}
        <p>Routing : <span style={{ color: link.routingStatus === 'READY' && !unreachable ? '#3dffaa' : '#f59e0b' }}>{unreachable ? 'UNKNOWN' : ROUTING_LABELS[link.routingStatus] ?? 'NOT AVAILABLE'}</span></p>
        {!unreachable && link.routingReason && (
          <p data-testid="routing-reason" style={{ color: '#f59e0b' }}>Raison : {ROUTING_REASON_LABELS[link.routingReason] ?? safeText(link.routingReason, 64)}</p>
        )}
        {agentType === 'RASSILON' && renderRassilonActions(device, link)}
        <div className="mt-1">
          <ActionButton danger disabled={actionsDisabled}
            onClick={() => pendingConfirm === unlinkKey
              ? void run(() => cortexClient.deviceFabricUnlink(device.fabricDeviceId, agentType), `Lien ${agentType} supprimé (aucune révocation ${agentType}).`)
              : setPendingConfirm(unlinkKey)}>
            <Unlink size={12} /> {pendingConfirm === unlinkKey ? `CONFIRMER UNLINK ${agentType}` : `UNLINK ${agentType}`}
          </ActionButton>
        </div>
      </div>
    );
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-4" data-testid="device-fabric-panel">
      <div style={{ ...cardStyle, borderColor: 'rgba(61,255,170,0.3)', background: 'rgba(61,255,170,0.035)' }}>
        <div className="flex items-start gap-3">
          <MonitorSmartphone size={18} style={{ color: '#3dffaa', flexShrink: 0 }} />
          <div>
            <p className="font-grotesk font-semibold text-sm" style={{ color: '#e9fff6' }}>DEVICES — INVENTAIRE LOCAL</p>
            <p className="font-mono text-xs mt-1" style={{ color: '#87a89b', lineHeight: 1.55 }}>
              Un lien est une étiquette d’inventaire : il n’accorde aucun droit OMEGA ni RASSILON. OMEGA et RASSILON gardent chacun leur confiance, leurs permissions et leur STOP. Aucun routage d’action dans cette version.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="font-mono text-xs flex items-center gap-2" style={{ color: '#ff7d85', ...cardStyle, borderColor: 'rgba(255,77,88,0.3)' }}>
          <AlertTriangle size={14} /> {unreachable ? `Données Device Fabric indisponibles — états UNKNOWN. ${error}` : error}
        </div>
      )}
      {!unreachable && Object.entries(agentErrors).map(([agentType, code]) => (
        <div key={agentType} role="alert" className="font-mono text-xs" style={{ color: '#ff7d85' }}>
          Projection {agentType} illisible ({safeText(code, 40)}) : ses identités ne sont pas listées et ses liens sont en ERROR.
        </div>
      ))}
      {notice && (
        <div role="status" className="font-mono text-xs flex items-center gap-2" style={{ color: '#3dffaa' }}>
          <CheckCircle size={13} /> {notice}
        </div>
      )}

      <section style={cardStyle} aria-label="Créer un appareil">
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Nom du nouvel appareil" placeholder="PC Bureau" maxLength={64} value={newName}
            onChange={event => setNewName(event.target.value)} style={{ ...inputStyle, minWidth: 200 }} />
          <ActionButton disabled={actionsDisabled || newName.trim().length === 0}
            onClick={() => void run(async () => { await cortexClient.deviceFabricCreate(newName); setNewName(''); }, 'Appareil créé.')}>
            <Plus size={12} /> CREATE DEVICE
          </ActionButton>
          <ActionButton disabled={busy} onClick={() => void refresh()}><RefreshCw size={12} /> REFRESH</ActionButton>
        </div>
      </section>

      {!loaded && <p className="font-mono text-xs" style={{ color: '#9b91b4' }}>Chargement — états UNKNOWN.</p>}
      {loaded && !unreachable && devices.length === 0 && (
        <p className="font-mono text-xs" style={{ color: '#6f6588' }}>Aucun appareil. Créez-en un, puis liez explicitement ses identités OMEGA et RASSILON.</p>
      )}

      {devices.map(device => {
        const renameActive = renaming?.id === device.fabricDeviceId;
        const removeKey = `remove:${device.fabricDeviceId}`;
        const linkCount = Number(Boolean(device.agents.OMEGA)) + Number(Boolean(device.agents.RASSILON));
        return (
          <section key={device.fabricDeviceId} style={cardStyle} aria-label={`Appareil ${safeText(device.displayName)}`} data-testid="fabric-device-card">
            <div className="flex flex-wrap items-center gap-3">
              {renameActive ? (
                <>
                  <input aria-label="Nouveau nom" maxLength={64} value={renaming.name}
                    onChange={event => setRenaming({ id: device.fabricDeviceId, name: event.target.value })} style={inputStyle} />
                  <ActionButton disabled={actionsDisabled || renaming.name.trim().length === 0}
                    onClick={() => void run(async () => { await cortexClient.deviceFabricRename(device.fabricDeviceId, renaming.name); setRenaming(null); }, 'Appareil renommé.')}>
                    <CheckCircle size={12} /> ENREGISTRER
                  </ActionButton>
                  <ActionButton onClick={() => setRenaming(null)}>ANNULER</ActionButton>
                </>
              ) : (
                <strong className="font-grotesk text-sm" style={{ color: '#f0eaff' }}>{safeText(device.displayName, 64)}</strong>
              )}
              <Badge value={unreachable ? 'UNKNOWN' : deviceStateFrom(Object.values(device.agents).filter((l): l is FabricAgentLink => !!l).map(l => ageLinkForDisplay(l, elapsedMs).availability))} label="Overall" />
              {!renameActive && (
                <ActionButton disabled={actionsDisabled} onClick={() => setRenaming({ id: device.fabricDeviceId, name: device.displayName })}>
                  <Pencil size={12} /> RENAME
                </ActionButton>
              )}
              <ActionButton danger disabled={actionsDisabled}
                onClick={() => pendingConfirm === removeKey
                  ? void run(() => cortexClient.deviceFabricRemove(device.fabricDeviceId, linkCount > 0), 'Appareil Fabric supprimé. OMEGA et RASSILON inchangés.')
                  : setPendingConfirm(removeKey)}>
                <Trash2 size={12} /> {pendingConfirm === removeKey ? 'CONFIRMER DELETE' : 'DELETE'}
              </ActionButton>
            </div>
            {pendingConfirm === removeKey && (
              <p className="font-mono text-xs mt-2" style={{ color: '#f59e0b' }}>
                {linkCount > 0 ? `Supprime l’appareil et ses ${linkCount} lien(s). ` : 'Supprime l’appareil. '}Cela ne révoque ni OMEGA ni RASSILON et ne touche à aucune clé ni session.
              </p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              {(['OMEGA', 'RASSILON'] as const).map(agentType => (
                <div key={agentType} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }} aria-label={`${agentType} ${safeText(device.displayName)}`}>
                  <p className="font-mono text-xs mb-1" style={{ color: '#5ee7ff', letterSpacing: '0.12em' }}>{agentType}</p>
                  {renderAgent(device, agentType)}
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {linkDialog && dialogDevice && (
        <section role="dialog" aria-label={`Lier ${linkDialog.agentType}`} style={{ ...cardStyle, borderColor: 'rgba(245,158,11,0.35)' }}>
          <p className="font-mono text-xs mb-2" style={{ color: '#f59e0b', letterSpacing: '0.12em' }}>LIER UNE IDENTITÉ {linkDialog.agentType}</p>
          {candidates.length === 0 ? (
            <p className="font-mono text-xs" style={{ color: '#817697' }}>Aucune identité {linkDialog.agentType} disponible (déjà liées ou révoquées exclues). Le pairing se fait dans {linkDialog.agentType}, jamais ici.</p>
          ) : (
            <div className="flex flex-col gap-1 font-mono text-xs" style={{ color: '#aaa0bf' }}>
              {candidates.map(identity => (
                <label key={identity.agentDeviceId}>
                  <input type="radio" name="fabric-link-candidate" checked={linkDialog.agentDeviceId === identity.agentDeviceId}
                    onChange={() => setLinkDialog({ ...linkDialog, agentDeviceId: identity.agentDeviceId, verified: false })} />
                  {' '}{safeText(identity.displayName)} · {identity.role} · {shortFingerprint(identity.fingerprint)}
                </label>
              ))}
            </div>
          )}
          {selected && (
            <dl className="font-mono text-xs mt-3 grid" style={{ color: '#d8d0ee', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px' }}>
              <dt style={{ color: '#817697' }}>Appareil Fabric</dt><dd>{safeText(dialogDevice.displayName, 64)}</dd>
              <dt style={{ color: '#817697' }}>Type d’agent</dt><dd>{linkDialog.agentType}</dd>
              <dt style={{ color: '#817697' }}>Identité agent</dt><dd style={{ overflowWrap: 'anywhere' }}>{safeText(selected.agentDeviceId, 128)}</dd>
              <dt style={{ color: '#817697' }}>Empreinte</dt><dd data-testid="fabric-link-fingerprint" style={{ overflowWrap: 'anywhere' }}>{selected.fingerprint}</dd>
            </dl>
          )}
          {selected && (
            <label className="font-mono text-xs block mt-3" style={{ color: '#f59e0b' }}>
              <input type="checkbox" checked={linkDialog.verified} onChange={event => setLinkDialog({ ...linkDialog, verified: event.target.checked })} />
              {' '}J’ai vérifié cette empreinte sur l’appareil. Ce lien n’accorde aucun droit.
            </label>
          )}
          <div className="flex gap-2 mt-3">
            <ActionButton disabled={actionsDisabled || !selected || !linkDialog.verified}
              onClick={() => {
                if (!selected?.fingerprint) return;
                void run(() => cortexClient.deviceFabricLink(dialogDevice.fabricDeviceId, linkDialog.agentType, selected.agentDeviceId, selected.fingerprint as string), `Identité ${linkDialog.agentType} liée.`)
                  .then(ok => { if (ok) setLinkDialog(null); });
              }}>
              <Link2 size={12} /> CONFIRMER LE LIEN
            </ActionButton>
            <ActionButton onClick={() => setLinkDialog(null)}>ANNULER</ActionButton>
          </div>
        </section>
      )}

      <section style={cardStyle} aria-label="Opérations Device Fabric">
        <p className="font-mono text-xs mb-2" style={{ color: '#5ee7ff', letterSpacing: '0.12em' }}>OPÉRATIONS RASSILON</p>
        <p className="font-mono mb-2" style={{ fontSize: 10, color: '#6f6588' }}>
          Annulation depuis ce PC : indisponible en V1 (RASSILON n’offre pas de primitive d’annulation côté controller). Un STOP local sur le worker l’arrête. Aucun retry, aucun autre worker.
        </p>
        {operations.length === 0 ? <p className="font-mono text-xs" style={{ color: '#6f6588' }}>Aucune opération. Rien n’est jamais envoyé sans action explicite.</p> : (
          <table className="w-full font-mono" style={{ fontSize: 10, color: '#8e84a4' }} data-testid="fabric-operations">
            <thead><tr style={{ textAlign: 'left', color: '#5f5576' }}><th>Appareil</th><th>Agent</th><th>Action</th><th>Statut</th><th>Durée</th><th>Résultat</th><th>Job</th></tr></thead>
            <tbody>{operations.map(operation => (
              <tr key={operation.operationId} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }} title={`Corrélation ${operation.correlationId}`}>
                <td>{deviceName(operation.fabricDeviceId)}</td>
                <td>RASSILON {safeText(operation.agentDeviceId, 24)}</td>
                <td>{ACTION_LABELS[operation.actionType] ?? safeText(operation.actionType, 24)}</td>
                <td style={{ color: STATE_COLORS[operation.status === 'COMPLETED' ? 'YES' : operation.status === 'FAILED' || operation.status === 'NOT_AVAILABLE' ? 'ERROR' : 'PARTIAL'] }}>{unreachable ? 'UNKNOWN' : operation.status}</td>
                <td>{operationDuration(operation)}</td>
                <td>{operationSummary(operation)}</td>
                <td>{operation.agentOperationId ? safeText(operation.agentOperationId, 13) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section style={cardStyle} aria-label="Audit Device Fabric">
        <p className="font-mono text-xs mb-2" style={{ color: '#5ee7ff', letterSpacing: '0.12em' }}>AUDIT FABRIC</p>
        {audit.length === 0 ? <p className="font-mono text-xs" style={{ color: '#6f6588' }}>Aucun événement.</p> : (
          <table className="w-full font-mono" style={{ fontSize: 10, color: '#8e84a4' }}>
            <thead><tr style={{ textAlign: 'left', color: '#5f5576' }}><th>Heure</th><th>Événement</th><th>Agent</th><th>Raison</th></tr></thead>
            <tbody>{audit.map(event => (
              <tr key={event.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <td>{formatDate(event.createdAt)}</td><td>{safeText(event.eventType, 40)}</td>
                <td>{event.agentType ? `${event.agentType} ${safeText(event.agentDeviceId, 32)}` : '—'}</td><td>{safeText(event.reason, 64)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export default DeviceFabricSettingsTab;
