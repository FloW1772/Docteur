import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Clock3, Cpu, Pause, Play, Power, RadioTower, RefreshCw, Shield, ShieldOff, Square, Users } from 'lucide-react';
import {
  cortexClient,
  type RassilonAuditEvent,
  type RassilonDevice,
  type RassilonLanStatus,
  type RassilonPairingOffer,
  type RassilonPairingView,
  type RassilonSettings,
  type RassilonStatus,
} from '../../lib/cortex/client';

type Draft = Omit<RassilonSettings, 'enabled' | 'updatedAt'>;

const JOB_LABELS: Record<string, string> = {
  SAFE_CPU_TASK: 'Calcul déterministe sûr (SAFE_CPU_TASK)',
  EMBEDDING_BATCH: 'Embeddings via le modèle local autorisé (EMBEDDING_BATCH)',
  RASSILON_COMPUTE_SAFE: 'Autoriser SAFE_CPU_TASK',
  RASSILON_EMBEDDING: 'Autoriser EMBEDDING_BATCH local',
};

const STATE_COLORS: Record<string, string> = {
  DISABLED: '#7a6c9a', IDLE: '#3dffaa', WORKING: '#5ee7ff', PAUSED: '#f59e0b',
  AUTO_PAUSED: '#f59e0b', ERROR: '#ff4d58', UNKNOWN: '#ff4d58',
};

const EMPTY_DRAFT: Draft = {
  maxCpuPercent: 25,
  maxRamMb: 2048,
  maxConcurrentJobs: 1,
  maxJobDurationSec: 300,
  maxScratchMb: 1024,
  pauseOnBattery: true,
  minimumBatteryPercent: 30,
  pauseWhenUserActive: true,
  acceptedJobTypes: [],
  approvalMode: 'ASK_EACH_JOB',
};

function shortFingerprint(value: string | null | undefined) {
  if (!value) return '—';
  return value.length <= 19 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Jamais';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Inconnu' : parsed.toLocaleString('fr-FR');
}

function sessionAge(value: string | null | undefined) {
  if (!value) return '—';
  const age = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(age)) return 'Inconnu';
  const minutes = Math.floor(age / 60_000);
  return minutes < 1 ? '< 1 min' : `${minutes} min`;
}

function safeMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : 'rassilon_request_failed';
  return raw.slice(0, 160);
}

function validateDraft(draft: Draft): string[] {
  const issues: string[] = [];
  const bounds: Array<[keyof Draft, number, number, string]> = [
    ['maxCpuPercent', 1, 90, 'CPU'],
    ['maxRamMb', 64, 16_384, 'RAM'],
    ['maxConcurrentJobs', 1, 4, 'Concurrence'],
    ['maxJobDurationSec', 1, 3_600, 'Durée'],
    ['maxScratchMb', 16, 16_384, 'Scratch'],
    ['minimumBatteryPercent', 0, 100, 'Batterie'],
  ];
  for (const [field, min, max, label] of bounds) {
    const value = draft[field];
    if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
      issues.push(`${label} doit être compris entre ${min} et ${max}.`);
    }
  }
  if (draft.acceptedJobTypes.some(type => !['SAFE_CPU_TASK', 'EMBEDDING_BATCH'].includes(type))) {
    issues.push('Executor non autorisé.');
  }
  return issues;
}

const cardStyle = {
  border: '1px solid rgba(94,231,255,0.12)',
  background: 'rgba(8,7,18,0.52)',
  borderRadius: 8,
  padding: 14,
} as const;

const inputStyle = {
  width: '100%', borderRadius: 5, padding: '6px 8px', fontSize: 12,
  color: '#d8d0ee', background: 'rgba(255,255,255,0.035)',
  border: '1px solid rgba(255,255,255,0.12)', outline: 'none',
} as const;

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
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 5,
        color: disabled ? '#4b4262' : color, border: `1px solid ${disabled ? '#302941' : `${color}55`}`,
        background: disabled ? 'rgba(255,255,255,0.015)' : `${color}10`, cursor: disabled ? 'not-allowed' : 'pointer',
      }}>
      {children}
    </button>
  );
}

export function RassilonSettingsTab({ pollMs = 5_000 }: { pollMs?: number }) {
  const [status, setStatus] = useState<RassilonStatus | null>(null);
  const [lan, setLan] = useState<RassilonLanStatus | null>(null);
  const [devices, setDevices] = useState<RassilonDevice[]>([]);
  const [audit, setAudit] = useState<RassilonAuditEvent[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True while the last poll failed: every state shown is then UNKNOWN, never the last good value.
  const [unreachable, setUnreachable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [bindAddress, setBindAddress] = useState('192.168.1.2');
  const [port, setPort] = useState(3443);
  const [networkProfile, setNetworkProfile] = useState<'Private' | 'Unknown'>('Private');
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [pairingOffer, setPairingOffer] = useState<RassilonPairingOffer | null>(null);
  const [pairing, setPairing] = useState<RassilonPairingView | null>(null);
  const [approvedPermissions, setApprovedPermissions] = useState<string[]>([]);
  const draftLoaded = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextLan, nextDevices, nextAudit] = await Promise.all([
        cortexClient.rassilonStatus(), cortexClient.rassilonLanStatus(),
        cortexClient.rassilonDevices(), cortexClient.rassilonAudit(40),
      ]);
      setStatus(nextStatus);
      setLan(nextLan.lan);
      setDevices(nextDevices.devices);
      setAudit(nextAudit.events);
      if (!draftLoaded.current) {
        const { enabled: _enabled, updatedAt: _updatedAt, ...settings } = nextStatus.settings;
        setDraft(settings);
        if (nextLan.lan.bindAddress) setBindAddress(nextLan.lan.bindAddress);
        if (nextLan.lan.port) setPort(nextLan.lan.port);
        draftLoaded.current = true;
      }
      setUnreachable(false);
      setError(null);
    } catch (nextError) {
      setUnreachable(true);
      setError(safeMessage(nextError));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);

  useEffect(() => {
    if (!pairingOffer || ['USED', 'CANCELLED', 'EXPIRED'].includes(pairing?.state ?? '')) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await cortexClient.rassilonPairing(pairingOffer.pairingId);
        if (!active) return;
        setPairing(response.pairing);
        if (response.pairing.state === 'REQUESTED') {
          setApprovedPermissions(current => current.length ? current : response.pairing.requestedPermissions);
        }
      } catch (nextError) {
        if (active) setError(safeMessage(nextError));
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pairingOffer, pairing?.state]);

  const run = useCallback(async (name: string, task: () => Promise<unknown>, success: string) => {
    setBusy(name); setError(null); setNotice(null);
    try {
      await task();
      setNotice(success);
      setConfirmAction(null);
      await refresh();
    } catch (nextError) {
      setError(safeMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const issues = validateDraft(draft);
  const workerState = unreachable || !status ? 'UNKNOWN' : status.state;
  const lanLabel = unreachable || !lan ? 'UNKNOWN' : lan.state === 'LISTENING' ? 'ACTIVE' : lan.state === 'ERROR' ? 'ERROR' : 'OFF';
  const lanActive = lanLabel === 'ACTIVE';
  const activeDevices = devices.filter(device => device.presence === 'ONLINE' || device.presence === 'STALE');

  const changeNumber = (field: keyof Draft, value: string) => {
    setDraft(current => ({ ...current, [field]: Number(value) }));
  };

  const toggleJobType = (jobType: 'SAFE_CPU_TASK' | 'EMBEDDING_BATCH') => {
    setDraft(current => ({
      ...current,
      acceptedJobTypes: current.acceptedJobTypes.includes(jobType)
        ? current.acceptedJobTypes.filter(type => type !== jobType)
        : [...current.acceptedJobTypes, jobType],
    }));
  };

  const startPairing = () => run('pairing-start', async () => {
    const response = await cortexClient.rassilonStartPairing();
    setPairingOffer(response.pairing);
    setPairing(null);
    setApprovedPermissions([]);
  }, 'Pairing temporaire ouvert.');

  return (
    <div className="px-5 py-4 flex flex-col gap-4" data-testid="rassilon-panel">
      <div style={{ ...cardStyle, borderColor: 'rgba(61,255,170,0.3)', background: 'rgba(61,255,170,0.035)' }}>
        <div className="flex items-start gap-3">
          <Shield size={18} style={{ color: '#3dffaa', flexShrink: 0 }} />
          <div>
            <p className="font-grotesk font-semibold text-sm" style={{ color: '#e9fff6' }}>LOCAL USER HAS FINAL AUTHORITY</p>
            <p className="font-mono text-xs mt-1" style={{ color: '#87a89b', lineHeight: 1.55 }}>
              Aucun controller distant ne peut activer RASSILON, relever les quotas, désactiver les gardes ou annuler un STOP local.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="font-mono text-xs flex items-center gap-2" style={{ color: '#ff7d85', ...cardStyle, borderColor: 'rgba(255,77,88,0.3)' }}>
          <AlertTriangle size={14} /> État/API : {error}
        </div>
      )}
      {notice && (
        <div role="status" className="font-mono text-xs flex items-center gap-2" style={{ color: '#3dffaa' }}>
          <CheckCircle size={13} /> {notice}
        </div>
      )}

      <section style={cardStyle} aria-label="État RASSILON">
        <div className="flex flex-wrap items-center gap-3">
          <Cpu size={16} style={{ color: STATE_COLORS[workerState] }} />
          <strong className="font-mono text-sm" style={{ color: STATE_COLORS[workerState] }}>RASSILON {workerState.replace('_', ' ')}</strong>
          <span className="font-mono text-xs" style={{ color: lanActive ? '#3dffaa' : '#7a6c9a' }}>
            LAN {lanLabel}
          </span>
          <span className="font-mono text-xs" style={{ color: '#857a9e' }}>Queue : {status?.queueDepth ?? '—'}</span>
          <ActionButton onClick={() => void refresh()} disabled={busy !== null}><RefreshCw size={12} /> Actualiser</ActionButton>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 font-mono text-xs" style={{ color: '#9b91b4' }}>
          <div>Job courant : <span style={{ color: '#d8d0ee' }}>{status?.activeJob?.jobType ?? 'Aucun'}</span></div>
          <div>Controller : <span style={{ color: '#d8d0ee' }}>{status?.remoteController?.displayName ?? 'Aucun actif'}</span></div>
          <div>Appareils connectés : <span style={{ color: '#d8d0ee' }}>{activeDevices.length}</span></div>
        </div>
        {status?.error && (
          <div className="mt-3 font-mono text-xs" style={{ color: '#ff7d85' }}>
            Erreur sûre : {status.error.code} · {status.error.message} · {formatDate(status.error.timestamp)}. Action : STOP puis ENABLE explicite après correction.
          </div>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          <ActionButton disabled={busy !== null || issues.length > 0 || status?.enabled === true}
            onClick={() => void run('enable', () => cortexClient.rassilonEnable(draft), 'RASSILON activé explicitement.')}>
            <Power size={12} /> ENABLE
          </ActionButton>
          <ActionButton disabled={busy !== null || !status?.enabled}
            onClick={() => void run('disable', () => cortexClient.rassilonDisable(), 'RASSILON désactivé.')}>
            <ShieldOff size={12} /> DISABLE
          </ActionButton>
          <ActionButton disabled={busy !== null || !status?.enabled || ['PAUSED', 'AUTO_PAUSED'].includes(status?.state ?? '')}
            onClick={() => void run('pause', () => cortexClient.rassilonPause(), 'Worker en pause manuelle.')}>
            <Pause size={12} /> PAUSE
          </ActionButton>
          <ActionButton disabled={busy !== null || !status?.enabled || !['PAUSED', 'AUTO_PAUSED'].includes(status?.state ?? '')}
            onClick={() => void run('resume', () => cortexClient.rassilonResume(), 'Worker repris par action locale.')}>
            <Play size={12} /> RESUME
          </ActionButton>
          <ActionButton danger disabled={busy !== null}
            onClick={() => confirmAction === 'stop'
              ? void run('stop', () => cortexClient.rassilonStop(), 'STOP exécuté : queue, travail actif, sessions et LAN arrêtés.')
              : setConfirmAction('stop')}>
            <Square size={12} /> {confirmAction === 'stop' ? 'CONFIRMER STOP ALL' : 'STOP RASSILON'}
          </ActionButton>
        </div>
      </section>

      <section style={cardStyle} aria-label="Quotas et gardes">
        <p className="font-mono text-xs mb-3" style={{ color: '#5ee7ff', letterSpacing: '0.12em' }}>QUOTAS ET GARDES LOCAUX</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {([
            ['maxCpuPercent', 'CPU cible / soft limit (%)', 1, 90],
            ['maxRamMb', 'RAM whole-process (MiB)', 64, 16_384],
            ['maxJobDurationSec', 'Durée max (secondes)', 1, 3_600],
            ['maxScratchMb', 'Scratch max (MiB)', 16, 16_384],
            ['maxConcurrentJobs', 'Concurrence', 1, 4],
            ['minimumBatteryPercent', 'Batterie minimale (%)', 0, 100],
          ] as const).map(([field, label, min, max]) => (
            <label key={field} className="font-mono" style={{ fontSize: 10, color: '#817697' }}>
              {label}
              <input aria-label={label} type="number" min={min} max={max} value={draft[field] as number}
                onChange={event => changeNumber(field, event.target.value)} style={{ ...inputStyle, marginTop: 4 }} />
            </label>
          ))}
        </div>
        <div className="flex flex-col gap-2 mt-3 font-mono text-xs" style={{ color: '#aaa0bf' }}>
          <label><input type="checkbox" checked={draft.pauseOnBattery} onChange={event => setDraft(current => ({ ...current, pauseOnBattery: event.target.checked }))} /> Pause sur batterie</label>
          <label><input type="checkbox" checked={draft.pauseWhenUserActive} onChange={event => setDraft(current => ({ ...current, pauseWhenUserActive: event.target.checked }))} /> Pause quand l’utilisateur est actif</label>
          {(['SAFE_CPU_TASK', 'EMBEDDING_BATCH'] as const).map(type => (
            <label key={type}><input type="checkbox" checked={draft.acceptedJobTypes.includes(type)} onChange={() => toggleJobType(type)} /> {JOB_LABELS[type]}</label>
          ))}
        </div>
        {issues.length > 0 && <ul className="font-mono text-xs mt-3" style={{ color: '#ff7d85' }}>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        <div className="mt-3">
          <ActionButton disabled={busy !== null || issues.length > 0}
            onClick={() => void run('settings', () => cortexClient.rassilonUpdateSettings(draft), 'Réglages validés par le backend.')}>
            <CheckCircle size={12} /> ENREGISTRER LES RÉGLAGES
          </ActionButton>
        </div>
      </section>

      <section style={cardStyle} aria-label="Réseau LAN RASSILON">
        <div className="flex items-center gap-2 mb-3">
          <RadioTower size={15} style={{ color: lanActive ? '#3dffaa' : '#7a6c9a' }} />
          <p className="font-mono text-xs" style={{ color: lanActive ? '#3dffaa' : '#7a6c9a', letterSpacing: '0.12em' }}>LAN {lanLabel}</p>
        </div>
        <p className="font-mono text-xs mb-3" style={{ color: '#817697', lineHeight: 1.5 }}>
          HTTPS uniquement · IPv4 RFC1918 · certificat local préconfiguré · aucune règle firewall automatique.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="font-mono" style={{ fontSize: 10, color: '#817697' }}>Adresse privée IPv4
            <input aria-label="Adresse privée IPv4" value={bindAddress} onChange={event => setBindAddress(event.target.value)} style={{ ...inputStyle, marginTop: 4 }} />
          </label>
          <label className="font-mono" style={{ fontSize: 10, color: '#817697' }}>Port TLS
            <input aria-label="Port TLS" type="number" min={1024} max={65535} value={port} onChange={event => setPort(Number(event.target.value))} style={{ ...inputStyle, marginTop: 4 }} />
          </label>
          <label className="font-mono" style={{ fontSize: 10, color: '#817697' }}>Profil réseau
            <select aria-label="Profil réseau" value={networkProfile} onChange={event => setNetworkProfile(event.target.value as 'Private' | 'Unknown')} style={{ ...inputStyle, marginTop: 4 }}>
              <option value="Private">Private</option><option value="Unknown">Unknown (refusé par défaut)</option>
            </select>
          </label>
        </div>
        {networkProfile === 'Unknown' && (
          <label className="font-mono text-xs block mt-3" style={{ color: '#f59e0b' }}>
            <input type="checkbox" checked={allowUnknown} onChange={event => setAllowUnknown(event.target.checked)} /> Override local explicite du profil inconnu
          </label>
        )}
        <div className="flex gap-2 mt-3">
          <ActionButton disabled={busy !== null || !status?.enabled || lanActive || port < 1024 || port > 65535 || (networkProfile === 'Unknown' && !allowUnknown)}
            onClick={() => void run('lan-enable', () => cortexClient.rassilonLanEnable({ bindAddress, port, networkProfile, allowUnknownNetworkProfile: allowUnknown }), 'LAN RASSILON activé explicitement.')}>
            <RadioTower size={12} /> LAN ENABLE
          </ActionButton>
          <ActionButton disabled={busy !== null || !lanActive}
            onClick={() => void run('lan-disable', () => cortexClient.rassilonLanDisable(), 'LAN RASSILON désactivé.')}>
            <ShieldOff size={12} /> LAN DISABLE
          </ActionButton>
        </div>
        {lan && <p className="font-mono mt-3" style={{ fontSize: 10, color: '#6f6588' }}>Bind : {lan.bindAddress ?? '—'}:{lan.port ?? '—'} · TLS pin {shortFingerprint(lan.certificateFingerprint)}</p>}
      </section>

      <section style={cardStyle} aria-label="Pairing RASSILON">
        <p className="font-mono text-xs mb-3" style={{ color: '#5ee7ff', letterSpacing: '0.12em' }}>PAIRING EXPLICITE</p>
        {!pairingOffer ? (
          <ActionButton disabled={busy !== null || !lanActive} onClick={() => void startPairing()} title={!lanActive ? 'Activez d’abord le LAN' : undefined}>
            <Users size={12} /> OUVRIR UN PAIRING TEMPORAIRE
          </ActionButton>
        ) : (
          <div className="font-mono text-xs flex flex-col gap-2" style={{ color: '#aaa0bf' }}>
            <div>Code temporaire : <strong style={{ color: '#f0eaff', fontSize: 18, letterSpacing: '0.18em' }}>{pairingOffer.code}</strong></div>
            <div>Expiration : {formatDate(pairingOffer.expiresAt)}</div>
            <div>Fingerprint worker : <span style={{ color: '#d8d0ee', overflowWrap: 'anywhere' }}>{pairingOffer.worker.fingerprint}</span></div>
            <details><summary>Challenge public</summary><span style={{ overflowWrap: 'anywhere' }}>{pairingOffer.workerNonce}</span></details>
            <div>État : <strong>{pairing?.state ?? 'STARTED'}</strong></div>
            {pairing?.state === 'REQUESTED' && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
                <p>Controller demandeur : {pairing.controllerDisplayName ?? 'Sans nom'} · {shortFingerprint(pairing.controllerFingerprint)}</p>
                <p className="mt-2">Permissions demandées :</p>
                {pairing.requestedPermissions.map(permission => (
                  <label key={permission} className="block mt-1">
                    <input type="checkbox" checked={approvedPermissions.includes(permission)} onChange={() => setApprovedPermissions(current => current.includes(permission) ? current.filter(item => item !== permission) : [...current, permission])} /> {JOB_LABELS[permission] ?? permission}
                  </label>
                ))}
                <div className="flex gap-2 mt-3">
                  <ActionButton disabled={busy !== null} onClick={() => void run('pairing-confirm', async () => {
                    const response = await cortexClient.rassilonConfirmPairing(pairing.pairingId, approvedPermissions);
                    setPairing(response.pairing);
                  }, 'Trust confirmé localement avec les permissions sélectionnées.')}><Shield size={12} /> CONFIRMER LE TRUST</ActionButton>
                  <ActionButton danger disabled={busy !== null} onClick={() => void run('pairing-reject', async () => {
                    const response = await cortexClient.rassilonRejectPairing(pairing.pairingId);
                    setPairing(response.pairing);
                  }, 'Pairing refusé et invalidé.')}><ShieldOff size={12} /> REFUSER</ActionButton>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section style={cardStyle} aria-label="Appareils de confiance">
        <p className="font-mono text-xs mb-3" style={{ color: '#5ee7ff', letterSpacing: '0.12em' }}>TRUSTED DEVICES</p>
        {devices.length === 0 ? <p className="font-mono text-xs" style={{ color: '#6f6588' }}>Aucun appareil distant approuvé.</p> : devices.map(device => (
          <div key={device.deviceId} className="py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex flex-wrap items-center gap-2">
              <strong className="font-mono text-xs" style={{ color: '#d8d0ee' }}>{device.displayName}</strong>
              <span className="font-mono" style={{ fontSize: 10, color: device.presence === 'REVOKED' ? '#ff4d58' : device.presence === 'ONLINE' ? '#3dffaa' : '#f59e0b' }}>{device.presence}</span>
              <span className="font-mono" style={{ fontSize: 10, color: '#807493' }}>{device.role}</span>
            </div>
            <div className="font-mono mt-1" style={{ fontSize: 10, color: '#6f6588', lineHeight: 1.55 }}>
              Fingerprint {shortFingerprint(device.fingerprint)} · Permissions {device.permissions.map(value => JOB_LABELS[value] ?? value).join(', ') || 'Aucune'}<br />
              Dernière présence {formatDate(device.lastSeenAt)} · Session {device.session?.active ? `active, âge ${sessionAge(device.session.createdAt)}` : device.session ? 'inactive/révoquée' : 'aucune'}
            </div>
            {device.presence !== 'REVOKED' && (
              <div className="mt-2">
                <ActionButton danger disabled={busy !== null} onClick={() => confirmAction === `revoke:${device.deviceId}`
                  ? void run('revoke', () => cortexClient.rassilonRevokeDevice(device.deviceId), 'Appareil révoqué ; sessions invalidées et futurs jobs refusés.')
                  : setConfirmAction(`revoke:${device.deviceId}`)}>
                  <ShieldOff size={12} /> {confirmAction === `revoke:${device.deviceId}` ? 'CONFIRMER LA RÉVOCATION' : 'REVOKE DEVICE'}
                </ActionButton>
              </div>
            )}
          </div>
        ))}
      </section>

      <section style={cardStyle} aria-label="Audit RASSILON">
        <p className="font-mono text-xs mb-3" style={{ color: '#5ee7ff', letterSpacing: '0.12em' }}>AUDIT RÉCENT</p>
        {audit.length === 0 ? <p className="font-mono text-xs" style={{ color: '#6f6588' }}>Aucun événement récent.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="w-full font-mono" style={{ fontSize: 10, color: '#8e84a4' }}>
              <thead><tr style={{ textAlign: 'left', color: '#5f5576' }}><th>Heure</th><th>Événement</th><th>Device</th><th>Job</th><th>Statut</th></tr></thead>
              <tbody>{audit.map(event => <tr key={event.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <td>{formatDate(event.timestamp)}</td><td>{event.eventType}</td><td>{shortFingerprint(event.deviceId)}</td><td>{event.jobType ?? '—'}</td>
                <td style={{ color: event.status === 'ERROR' ? '#ff7d85' : event.status === 'OK' ? '#3dffaa' : '#f59e0b' }}>{event.status}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <div className="font-mono text-xs flex items-center gap-2" style={{ color: '#625875' }}>
        <Clock3 size={12} /> Les états proviennent exclusivement de l’API locale. API inaccessible = UNKNOWN/ERROR.
      </div>
    </div>
  );
}

export default RassilonSettingsTab;
