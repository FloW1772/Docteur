import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldCheck, Square } from 'lucide-react';
import { cortexClient, type FabricDevice, type FabricOmegaV2AdminOperation, type FabricOmegaV2AdminReadResult } from '../../lib/cortex/client';

type HighImpactAction = 'LOCK' | 'LOGOFF' | 'RESTART' | 'SHUTDOWN';
type Cell = string | number | boolean | null | string[];
type Row = Record<string, Cell>;

const READS = [
  { key: 'systemInfo', label: 'Read system info', call: (id: string) => cortexClient.deviceFabricOmegaV2AdminSystemInfo(id) },
  { key: 'processes', label: 'Read processes', call: (id: string) => cortexClient.deviceFabricOmegaV2AdminProcesses(id) },
  { key: 'services', label: 'Read services', call: (id: string) => cortexClient.deviceFabricOmegaV2AdminServiceStatus(id) },
  { key: 'network', label: 'Read network', call: (id: string) => cortexClient.deviceFabricOmegaV2AdminNetworkStatus(id) },
  { key: 'disks', label: 'Read disks', call: (id: string) => cortexClient.deviceFabricOmegaV2AdminDiskStatus(id) },
] as const;
const HIGH_IMPACT: HighImpactAction[] = ['LOCK', 'LOGOFF', 'RESTART', 'SHUTDOWN'];
const HIGH_IMPACT_CALL: Record<HighImpactAction, (id: string) => Promise<{ ok: boolean; admin: FabricOmegaV2AdminOperation }>> = {
  LOCK: id => cortexClient.deviceFabricOmegaV2AdminLock(id),
  LOGOFF: id => cortexClient.deviceFabricOmegaV2AdminLogoff(id),
  RESTART: id => cortexClient.deviceFabricOmegaV2AdminRestart(id),
  SHUTDOWN: id => cortexClient.deviceFabricOmegaV2AdminShutdown(id),
};
const TABLES: Record<string, { list: string; columns: Array<[string, string]> }> = {
  PROCESS_LIST: { list: 'processes', columns: [['pid', 'PID'], ['name', 'Name'], ['memoryBytes', 'Memory (bytes)'], ['cpuSeconds', 'CPU (s)']] },
  SERVICE_STATUS: { list: 'services', columns: [['name', 'Name'], ['displayName', 'Display name'], ['state', 'State'], ['startMode', 'Start mode']] },
  NETWORK_STATUS: { list: 'interfaces', columns: [['description', 'Interface'], ['dhcpEnabled', 'DHCP'], ['addresses', 'Addresses'], ['gateways', 'Gateways'], ['dnsServers', 'DNS']] },
  DISK_STATUS: { list: 'disks', columns: [['drive', 'Drive'], ['filesystem', 'Filesystem'], ['totalBytes', 'Total (bytes)'], ['freeBytes', 'Free (bytes)']] },
};
const TERMINAL = new Set(['EXECUTED', 'DENIED', 'CANCELLED', 'EXPIRED', 'FAILED']);
// Errors after which this Fabric-owned ADMIN session can no longer be used.
const SESSION_TERMINAL = new Set(['OMEGA_V2_SESSION_EXPIRED', 'OMEGA_V2_REVOKED', 'OMEGA_V2_REMOTE_STOPPED',
  'OMEGA_V2_NETWORK_UNAVAILABLE', 'OMEGA_V2_ADMIN_NOT_AUTHORIZED', 'OMEGA_V2_LINK_CHANGED']);
const POLL_MS = 1_500;
const MAX_POLLS = 40;

function safe(value: string | null | undefined, max = 64) {
  if (!value) return '—';
  const clean = value.replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩‎‏]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function cell(value: Cell) {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/**
 * Fabric's own ADMIN section: read-only status + the four high-impact
 * actions, mirroring the certified OmegaOutboundAdminPanel's UX exactly but
 * orchestrated through Fabric's own closed routes. Fabric's confirmation
 * here only gates its own request to OMEGA; the remote device's own local
 * approval (shown by OMEGA's status codes) is never replaced or simulated.
 */
export function FabricOmegaV2AdminPanel({ device, disabled }: { device: FabricDevice; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabledReason, setDisabledReason] = useState<string | null>(null);
  const [readResult, setReadResult] = useState<FabricOmegaV2AdminReadResult | null>(null);
  const [confirming, setConfirming] = useState<HighImpactAction | null>(null);
  const [operation, setOperation] = useState<FabricOmegaV2AdminOperation | null>(null);
  const pollTimer = useRef<number | undefined>(undefined);
  const liveRef = useRef(true);
  const blocked = disabled ? 'DISABLED' : disabledReason;
  const pending = !!operation && !TERMINAL.has(operation.status);

  function stopPolling() {
    if (pollTimer.current !== undefined) window.clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
  }

  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; stopPolling(); };
  }, []);

  useEffect(() => { if (blocked) { stopPolling(); setConfirming(null); } }, [blocked]);

  function fail(code: string) {
    setError(code);
    if (SESSION_TERMINAL.has(code)) { setDisabledReason(code); stopPolling(); }
  }

  async function read(item: (typeof READS)[number]) {
    if (blocked) return;
    setBusy(true); setError(null);
    try {
      const result = (await item.call(device.fabricDeviceId)).admin;
      if (!liveRef.current) return;
      setReadResult(result);
      if (result.status !== 'EXECUTED') setError(result.error ?? result.status);
    } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'OMEGA_V2_UNAVAILABLE'); }
    finally { if (liveRef.current) setBusy(false); }
  }

  function poll(operationId: string, attempt: number) {
    stopPolling();
    if (attempt >= MAX_POLLS) { setError('OMEGA_V2_ADMIN_STATUS_TIMEOUT'); setOperation(current => current && { ...current, status: 'EXPIRED' }); return; }
    pollTimer.current = window.setTimeout(async () => {
      try {
        const next = (await cortexClient.deviceFabricOmegaV2AdminOperationStatus(device.fabricDeviceId, operationId)).admin;
        if (!liveRef.current) return;
        setOperation(next);
        if (!TERMINAL.has(next.status)) poll(operationId, attempt + 1);
        else if (next.error) setError(next.error);
      } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'OMEGA_V2_UNAVAILABLE'); }
    }, POLL_MS);
  }

  async function confirmHighImpact(action: HighImpactAction) {
    if (blocked || pending) return;
    setConfirming(null); setBusy(true); setError(null);
    try {
      const result = (await HIGH_IMPACT_CALL[action](device.fabricDeviceId)).admin;
      if (!liveRef.current) return;
      setOperation(result);
      if (!TERMINAL.has(result.status)) poll(result.operationId, 0);
      else if (result.error) setError(result.error);
    } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'OMEGA_V2_UNAVAILABLE'); }
    finally { if (liveRef.current) setBusy(false); }
  }

  async function cancelOperation() {
    if (!operation || !pending) return;
    stopPolling();
    try {
      const result = (await cortexClient.deviceFabricOmegaV2AdminOperationCancel(device.fabricDeviceId, operation.operationId)).admin;
      if (liveRef.current) setOperation(result);
    } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'OMEGA_V2_UNAVAILABLE'); }
  }

  // STOP DEVICE: a capacity reduction only, never itself an ADMIN operation
  // (no allowlist check, no approval). Stops exactly this Fabric-owned ADMIN
  // session; VIEW/INTERACTIVE (a separate session) are unaffected.
  async function stopDevice() {
    stopPolling(); setConfirming(null); setBusy(true); setError(null);
    try {
      await cortexClient.deviceFabricOmegaV2AdminStopDevice(device.fabricDeviceId);
      if (liveRef.current) { setOperation(null); setReadResult(null); setDisabledReason('OMEGA_V2_SESSION_EXPIRED'); }
    } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'OMEGA_V2_UNAVAILABLE'); }
    finally { if (liveRef.current) setBusy(false); }
  }

  const table = readResult?.status === 'EXECUTED' ? TABLES[readResult.actionType] : undefined;
  const rows = table ? (readResult?.result?.[table.list] as Row[] | undefined) ?? [] : [];
  const system = readResult?.status === 'EXECUTED' && readResult.actionType === 'GET_SYSTEM_INFO'
    ? readResult.result?.system as Record<string, string> | undefined : undefined;

  return (
    <section aria-label={`OMEGA ADMIN ${safe(device.displayName)}`} className="flex flex-col gap-3 mt-2"
      style={{ borderTop: '1px solid rgba(255,181,71,0.25)', paddingTop: 12 }}>
      <div className="flex items-center gap-2">
        <ShieldCheck size={15} style={{ color: '#ffb547' }} />
        <h4 className="font-mono text-xs font-semibold" style={{ color: '#f0eaff' }}>OMEGA ADMIN</h4>
        <span aria-label="ADMIN state" className="font-mono text-xs" style={{ marginLeft: 'auto', color: blocked ? '#ff6b78' : '#3dffaa' }}>
          {blocked ? `ADMIN DISABLED: ${safe(blocked, 48)}` : 'ADMIN: AVAILABLE'}
        </span>
        <button type="button" data-testid="fabric-omega-v2-admin-stop-device" disabled={disabled || busy}
          onClick={() => void stopDevice()} style={{ color: '#a99bc5' }}><Square size={11} /> STOP DEVICE</button>
      </div>

      <div aria-label="READ-ONLY STATUS" className="flex flex-col gap-2">
        <h5 className="font-mono text-xs" style={{ color: '#5ee7ff' }}>READ-ONLY STATUS</h5>
        <div className="flex flex-wrap gap-2">
          {READS.map(item => (
            <button key={item.key} type="button" data-testid={`fabric-omega-v2-admin-read-${item.key}`}
              disabled={busy || !!blocked} onClick={() => void read(item)}>{item.label}</button>
          ))}
        </div>
        {system && (
          <dl aria-label="ADMIN system info" className="font-mono text-xs" style={{ color: '#a99bc5' }}>
            {Object.entries(system).map(([key, value]) => <div key={key}><dt style={{ display: 'inline' }}>{safe(key, 32)}: </dt><dd style={{ display: 'inline' }}>{safe(cell(value as Cell), 128)}</dd></div>)}
          </dl>
        )}
        {table && (
          <div style={{ maxHeight: 220, overflow: 'auto' }}>
            <table aria-label="ADMIN result" className="font-mono text-xs" style={{ color: '#a99bc5' }}>
              <thead><tr>{table.columns.map(([key, label]) => <th key={key} style={{ textAlign: 'left', paddingRight: 8 }}>{label}</th>)}</tr></thead>
              <tbody>{rows.map((row, index) => <tr key={index}>{table.columns.map(([key]) => <td key={key} style={{ paddingRight: 8 }}>{safe(cell(row[key]), 96)}</td>)}</tr>)}</tbody>
            </table>
            {readResult?.result?.truncated === true && <p className="font-mono text-xs" style={{ color: '#ffb547' }}>Truncated to {rows.length} entries</p>}
          </div>
        )}
      </div>

      <div aria-label="HIGH-IMPACT ACTIONS" className="flex flex-col gap-2" style={{ border: '1px solid #ff6b78', borderRadius: 6, padding: 10, background: 'rgba(255,107,120,0.06)' }}>
        <h5 className="font-mono text-xs flex items-center gap-1" style={{ color: '#ff6b78' }}><AlertTriangle size={12} /> HIGH-IMPACT ACTIONS</h5>
        <p className="font-mono text-xs" style={{ color: '#a99bc5' }}>Chaque demande nécessite votre confirmation ici ET une approbation locale explicite sur l'appareil distant.</p>
        <div className="flex flex-wrap gap-2">
          {HIGH_IMPACT.map(action => (
            <button key={action} type="button" data-testid={`fabric-omega-v2-admin-${action.toLowerCase()}`}
              disabled={busy || !!blocked || pending || !!confirming}
              onClick={() => setConfirming(action)} style={{ color: '#ff6b78' }}>Demander {action}</button>
          ))}
        </div>
        {confirming && !blocked && (
          <div role="dialog" aria-label="Confirm high-impact ADMIN action" className="flex flex-col gap-2" style={{ border: '1px dashed #ff6b78', padding: 8 }}>
            <p className="font-mono text-xs" style={{ color: '#f0eaff' }}>
              Confirmer {confirming} sur {safe(device.displayName)} ? Rien ne se produit tant que l'appareil distant n'approuve pas localement.
            </p>
            <div className="flex gap-2">
              <button type="button" data-testid="fabric-omega-v2-admin-confirm" disabled={busy}
                onClick={() => void confirmHighImpact(confirming)} style={{ color: '#ff6b78' }}>Confirmer {confirming}</button>
              <button type="button" onClick={() => setConfirming(null)}>Retour</button>
            </div>
          </div>
        )}
        {operation && (
          <div className="flex items-center gap-2">
            <span aria-label="ADMIN operation status" className="font-mono text-xs" style={{ color: operation.status === 'EXECUTED' ? '#3dffaa' : '#ffb547' }}>
              {safe(operation.actionType, 16)}: {safe(operation.status, 24)}{operation.error ? ` (${safe(operation.error, 32)})` : ''}
            </span>
            {pending && operation.status === 'PENDING_APPROVAL' && !blocked && (
              <button type="button" onClick={() => void cancelOperation()}>Annuler la demande ADMIN</button>
            )}
          </div>
        )}
      </div>
      {error && <p role="alert" aria-label="ADMIN error" className="font-mono text-xs" style={{ color: '#ff6b78' }}>{safe(error, 64)}</p>}
    </section>
  );
}

export default FabricOmegaV2AdminPanel;
