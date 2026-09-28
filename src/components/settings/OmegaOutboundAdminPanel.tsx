import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';

type HighImpactAction = 'LOCK' | 'LOGOFF' | 'RESTART' | 'SHUTDOWN';
type Cell = string | number | boolean | null | string[];
type Row = Record<string, Cell>;
type AdminOperation = {
  operationId: string;
  actionType: string;
  status: string;
  error?: string | null;
  expiresAt?: string | null;
  result?: Record<string, unknown>;
};

const READS = [
  { route: 'system-info', label: 'Read system info' },
  { route: 'processes', label: 'Read processes' },
  { route: 'services', label: 'Read services' },
  { route: 'network', label: 'Read network' },
  { route: 'disks', label: 'Read disks' },
] as const;
const HIGH_IMPACT: HighImpactAction[] = ['LOCK', 'LOGOFF', 'RESTART', 'SHUTDOWN'];
const TABLES: Record<string, { list: string; columns: Array<[string, string]> }> = {
  PROCESS_LIST: { list: 'processes', columns: [['pid', 'PID'], ['name', 'Name'], ['memoryBytes', 'Memory (bytes)'], ['cpuSeconds', 'CPU (s)']] },
  SERVICE_STATUS: { list: 'services', columns: [['name', 'Name'], ['displayName', 'Display name'], ['state', 'State'], ['startMode', 'Start mode']] },
  NETWORK_STATUS: { list: 'interfaces', columns: [['description', 'Interface'], ['dhcpEnabled', 'DHCP'], ['addresses', 'Addresses'], ['gateways', 'Gateways'], ['dnsServers', 'DNS']] },
  DISK_STATUS: { list: 'disks', columns: [['drive', 'Drive'], ['filesystem', 'Filesystem'], ['totalBytes', 'Total (bytes)'], ['freeBytes', 'Free (bytes)']] },
};
const TERMINAL = new Set(['EXECUTED', 'DENIED', 'CANCELLED', 'EXPIRED', 'FAILED']);
// Errors after which this ADMIN session can no longer be used.
const SESSION_TERMINAL = new Set(['SESSION_EXPIRED', 'DEVICE_REVOKED', 'REMOTE_STOPPED', 'NETWORK_UNAVAILABLE', 'SESSION_NOT_FOUND', 'PERMISSION_DENIED']);
const POLL_MS = 1_500;
const MAX_POLLS = 40;

function cell(value: Cell) {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export function OmegaOutboundAdminPanel({ sessionId, remoteDeviceId, expiresAt, backend }: {
  sessionId: string; remoteDeviceId: string; expiresAt: string; backend: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabledReason, setDisabledReason] = useState<string | null>(null);
  const [readResult, setReadResult] = useState<AdminOperation | null>(null);
  const [confirming, setConfirming] = useState<HighImpactAction | null>(null);
  const [operation, setOperation] = useState<AdminOperation | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollTimer = useRef<number | undefined>(undefined);
  const liveRef = useRef(true);
  const expired = Date.parse(expiresAt) <= now;
  const blocked = disabledReason ?? (expired ? 'SESSION_EXPIRED' : null);
  const pending = !!operation && !TERMINAL.has(operation.status);
  const base = `${backend}/api/omega/outbound/sessions/${encodeURIComponent(sessionId)}/admin`;

  function stopPolling() {
    if (pollTimer.current !== undefined) window.clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
  }

  useEffect(() => {
    liveRef.current = true;
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(clock); liveRef.current = false; stopPolling(); };
  }, []);

  useEffect(() => { if (blocked) { stopPolling(); setConfirming(null); } }, [blocked]);

  function fail(code: string) {
    setError(code);
    if (SESSION_TERMINAL.has(code)) { setDisabledReason(code); stopPolling(); }
  }

  async function call(path: string, init?: RequestInit): Promise<AdminOperation> {
    let response: Response;
    try { response = await fetch(`${base}/${path}`, init); } catch { throw new Error('NETWORK_UNAVAILABLE'); }
    const data = await response.json().catch(() => ({})) as { admin?: AdminOperation; error?: string };
    if (!response.ok || !data.admin) throw new Error(data.error ?? 'ADMIN_REJECTED');
    return data.admin;
  }

  async function read(route: string) {
    if (blocked) return;
    setBusy(true); setError(null);
    try {
      const result = await call(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!liveRef.current) return;
      setReadResult(result);
      if (result.status !== 'EXECUTED') setError(result.error ?? result.status);
    } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'ADMIN_REJECTED'); }
    finally { if (liveRef.current) setBusy(false); }
  }

  function poll(operationId: string, attempt: number) {
    stopPolling();
    if (attempt >= MAX_POLLS) { setError('ADMIN_STATUS_TIMEOUT'); setOperation(current => current && { ...current, status: 'EXPIRED' }); return; }
    pollTimer.current = window.setTimeout(async () => {
      try {
        const next = await call(`operations/${encodeURIComponent(operationId)}`);
        if (!liveRef.current) return;
        setOperation(next);
        if (!TERMINAL.has(next.status)) poll(operationId, attempt + 1);
        else if (next.error) setError(next.error);
      } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'ADMIN_REJECTED'); }
    }, POLL_MS);
  }

  async function confirmHighImpact(action: HighImpactAction) {
    if (blocked || pending) return;
    setConfirming(null); setBusy(true); setError(null);
    try {
      const result = await call(`${action.toLowerCase()}/request`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: action }),
      });
      if (!liveRef.current) return;
      setOperation(result);
      if (!TERMINAL.has(result.status)) poll(result.operationId, 0);
      else if (result.error) setError(result.error);
    } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'ADMIN_REJECTED'); }
    finally { if (liveRef.current) setBusy(false); }
  }

  async function cancelOperation() {
    if (!operation || !pending) return;
    stopPolling();
    try {
      const result = await call(`operations/${encodeURIComponent(operation.operationId)}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (liveRef.current) setOperation(result);
    } catch (e) { if (liveRef.current) fail(e instanceof Error ? e.message : 'ADMIN_REJECTED'); }
  }

  const table = readResult?.status === 'EXECUTED' ? TABLES[readResult.actionType] : undefined;
  const rows = table ? (readResult?.result?.[table.list] as Row[] | undefined) ?? [] : [];
  const system = readResult?.status === 'EXECUTED' && readResult.actionType === 'GET_SYSTEM_INFO'
    ? readResult.result?.system as Record<string, string> | undefined : undefined;

  return (
    <section aria-label="OMEGA ADMIN" className="flex flex-col gap-3" style={{ borderTop: '1px solid rgba(255,181,71,0.25)', paddingTop: 12 }}>
      <div className="flex items-center gap-2">
        <ShieldCheck size={15} style={{ color: '#ffb547' }} />
        <h4 className="font-grotesk font-semibold" style={{ color: '#f0eaff' }}>OMEGA ADMIN</h4>
        <span aria-label="ADMIN state" className="font-mono text-xs" style={{ marginLeft: 'auto', color: blocked ? '#ff6b78' : '#3dffaa' }}>
          {blocked ? `ADMIN DISABLED: ${blocked}` : 'ADMIN: AVAILABLE'}
        </span>
      </div>

      <div aria-label="READ-ONLY STATUS" className="flex flex-col gap-2">
        <h5 className="font-mono text-xs" style={{ color: '#5ee7ff' }}>READ-ONLY STATUS</h5>
        <div className="flex flex-wrap gap-2">
          {READS.map(item => (
            <button key={item.route} type="button" disabled={busy || !!blocked} onClick={() => void read(item.route)}>{item.label}</button>
          ))}
        </div>
        {system && (
          <dl aria-label="ADMIN system info" className="font-mono text-xs" style={{ color: '#a99bc5' }}>
            {Object.entries(system).map(([key, value]) => <div key={key}><dt style={{ display: 'inline' }}>{key}: </dt><dd style={{ display: 'inline' }}>{cell(value)}</dd></div>)}
          </dl>
        )}
        {table && (
          <div style={{ maxHeight: 220, overflow: 'auto' }}>
            <table aria-label="ADMIN result" className="font-mono text-xs" style={{ color: '#a99bc5' }}>
              <thead><tr>{table.columns.map(([key, label]) => <th key={key} style={{ textAlign: 'left', paddingRight: 8 }}>{label}</th>)}</tr></thead>
              <tbody>{rows.map((row, index) => <tr key={index}>{table.columns.map(([key]) => <td key={key} style={{ paddingRight: 8 }}>{cell(row[key])}</td>)}</tr>)}</tbody>
            </table>
            {readResult?.result?.truncated === true && <p className="font-mono text-xs" style={{ color: '#ffb547' }}>Truncated to {rows.length} entries</p>}
          </div>
        )}
      </div>

      <div aria-label="HIGH-IMPACT ACTIONS" className="flex flex-col gap-2" style={{ border: '1px solid #ff6b78', borderRadius: 6, padding: 10, background: 'rgba(255,107,120,0.06)' }}>
        <h5 className="font-mono text-xs flex items-center gap-1" style={{ color: '#ff6b78' }}><AlertTriangle size={12} /> HIGH-IMPACT ACTIONS</h5>
        <p className="font-mono text-xs" style={{ color: '#a99bc5' }}>Each request needs your confirmation here and an explicit local approval on the remote device.</p>
        <div className="flex flex-wrap gap-2">
          {HIGH_IMPACT.map(action => (
            <button key={action} type="button" disabled={busy || !!blocked || pending || !!confirming}
              onClick={() => setConfirming(action)} style={{ color: '#ff6b78' }}>Request {action}</button>
          ))}
        </div>
        {confirming && !blocked && (
          <div role="dialog" aria-label="Confirm high-impact ADMIN action" className="flex flex-col gap-2" style={{ border: '1px dashed #ff6b78', padding: 8 }}>
            <p className="font-mono text-xs" style={{ color: '#f0eaff' }}>
              Confirm {confirming} on {remoteDeviceId}? Nothing happens unless the remote device approves it locally.
            </p>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void confirmHighImpact(confirming)} style={{ color: '#ff6b78' }}>Confirm {confirming} request</button>
              <button type="button" onClick={() => setConfirming(null)}>Back</button>
            </div>
          </div>
        )}
        {operation && (
          <div className="flex items-center gap-2">
            <span aria-label="ADMIN operation status" className="font-mono text-xs" style={{ color: operation.status === 'EXECUTED' ? '#3dffaa' : '#ffb547' }}>
              {operation.actionType}: {operation.status}{operation.error ? ` (${operation.error})` : ''}
            </span>
            {pending && operation.status === 'PENDING_APPROVAL' && !blocked && (
              <button type="button" onClick={() => void cancelOperation()}>Cancel ADMIN request</button>
            )}
          </div>
        )}
      </div>
      {error && <p role="status" aria-label="ADMIN error" className="font-mono text-xs" style={{ color: '#ff6b78' }}>{error}</p>}
    </section>
  );
}
