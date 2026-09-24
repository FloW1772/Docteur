import { useEffect, useState } from 'react';
import { cortexClient, type RassilonLanStatus, type RassilonStatus } from '../../lib/cortex/client';

interface Props {
  onOpen: () => void;
  pollMs?: number;
}

const COLORS: Record<string, string> = {
  DISABLED: '#7a6c9a',
  IDLE: '#3dffaa',
  WORKING: '#5ee7ff',
  PAUSED: '#f59e0b',
  AUTO_PAUSED: '#f59e0b',
  ERROR: '#ff4d58',
  UNKNOWN: '#ff4d58',
};

export default function RassilonStatusBadge({ onOpen, pollMs = 5_000 }: Props) {
  const [status, setStatus] = useState<RassilonStatus | null>(null);
  const [lan, setLan] = useState<RassilonLanStatus | null>(null);
  const [unknown, setUnknown] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [nextStatus, nextLan] = await Promise.all([
          cortexClient.rassilonStatus(),
          cortexClient.rassilonLanStatus(),
        ]);
        if (!active) return;
        setStatus(nextStatus);
        setLan(nextLan.lan);
        setUnknown(false);
      } catch {
        if (active) setUnknown(true);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [pollMs]);

  const state = unknown ? 'UNKNOWN' : status?.state ?? 'UNKNOWN';
  const lanActive = !unknown && lan?.state === 'LISTENING';
  const label = state === 'DISABLED' ? 'RASSILON OFF' : `RASSILON ${state.replace('_', ' ')}`;
  const detail = unknown
    ? 'État indisponible — ouvrir RASSILON'
    : `${label}${lanActive ? ' · LAN ACTIVE' : ' · LAN OFF'}${status?.queueDepth ? ` · queue ${status.queueDepth}` : ''}`;

  return (
    <button
      type="button"
      aria-label={detail}
      title={detail}
      onClick={onOpen}
      className="font-mono text-xs tracking-[0.16em]"
      style={{
        color: COLORS[state] ?? COLORS.UNKNOWN,
        border: `1px solid ${COLORS[state] ?? COLORS.UNKNOWN}55`,
        background: `${COLORS[state] ?? COLORS.UNKNOWN}10`,
        borderRadius: 5,
        padding: '3px 7px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      {label}{lanActive ? ' · LAN' : ''}
    </button>
  );
}
