// Sherlock Studio — a real dedicated Studio shell for the OSINT username
// search (Phase UX-4), replacing the previous buried Settings section
// (SherlockSettingsSection, now removed — this Studio supersedes it). Same
// backend contract: search/cancel/status, single active job, 3 default
// sites, 3 searches/minute rate limit. No history persistence exists
// server-side (BACKEND GAP, documented in reports/STUDIOS_UX_V2_2026-09.md)
// — this UI never fabricates one.
import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { SherlockInstallState, SherlockJob } from '../../lib/cortex/client';
import { startJobPolling } from '../../lib/video-job-polling';
import StudioShell from '../studio/StudioShell';
import StudioStatus, { type StudioStatusTone } from '../studio/StudioStatus';
import StudioToolbar from '../studio/StudioToolbar';
import StudioEmptyState from '../studio/StudioEmptyState';
import StudioErrorState from '../studio/StudioErrorState';

const STATUS_LABEL: Record<string, string> = {
  running: 'En cours', done: 'Terminée', error: 'Erreur', cancelled: 'Annulée',
};
const STATUS_TONE: Record<string, StudioStatusTone> = {
  running: 'active', done: 'success', error: 'error', cancelled: 'neutral',
};
const RESULT_LABEL: Record<string, string> = {
  found: 'Trouvé', absent: 'Absent', invalid: 'Pseudonyme incompatible', error: 'Erreur',
};
const RESULT_TONE: Record<string, StudioStatusTone> = {
  found: 'success', absent: 'neutral', invalid: 'warning', error: 'error',
};

const USERNAME_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u;

interface Props {
  onClose: () => void;
  /** Called with the finished job id so the caller (App.tsx) can remember it for the Dashboard widget. */
  onJobUpdate?: (jobId: string) => void;
}

export default function SherlockStudioModal({ onClose, onJobUpdate }: Props) {
  const [installState, setInstallState] = useState<SherlockInstallState | null>(null);
  const [username, setUsername] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [job, setJob] = useState<SherlockJob | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const stop = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  async function reloadStatus() {
    try {
      const next = await cortexClient.getSherlockStatus();
      if (mounted.current) setInstallState(next);
    } catch {
      if (mounted.current) setError('Service Sherlock indisponible.');
    }
  }

  useEffect(() => {
    mounted.current = true;
    void reloadStatus();
    return () => { mounted.current = false; stop.current?.(); };
  }, []);

  const running = pending || job?.status === 'running';

  async function search() {
    if (running) return;
    if (!USERNAME_PATTERN.test(username) || username.includes('..')) {
      setError('Pseudonyme : 1 à 64 lettres, chiffres, tirets, points ou underscores ; sans espace ni deux points successifs.');
      return;
    }
    setPending(true); setError(''); setJob(null);
    try {
      const result = await cortexClient.searchSherlock(username, { timeoutMs: timeoutSeconds * 1000 });
      if (!mounted.current) return;
      setJob({ id: result.jobId, operation: 'Recherche', username, status: 'running', duration: 0, current: 0, total: 3, summary: null });
      stop.current?.();
      stop.current = startJobPolling(
        () => cortexClient.getSherlockJob(result.jobId),
        next => next.status,
        next => { setJob(next); if (next.status === 'done') onJobUpdate?.(result.jobId); },
        () => {},
        { intervalMs: 700 },
      );
    } catch {
      if (mounted.current) setError('Recherche refusée ou service indisponible (limite : 3 recherches par minute, une recherche à la fois). Réessaie dans une minute.');
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      const result = await cortexClient.cancelSherlockSearch(job.id);
      if (!result.cancelled) setError('La recherche est déjà arrêtée.');
    } catch {
      setError('Annulation non confirmée. Réessaie.');
    }
  }

  const results = job?.summary?.results ?? [];
  const found = job?.summary?.found ?? results.filter(r => r.status === 'found').length;
  const absent = job?.summary?.absent ?? results.filter(r => r.status === 'absent').length;
  const errors = job?.summary?.errors ?? results.filter(r => r.status === 'error' || r.status === 'invalid').length;

  return (
    <StudioShell
      icon={<Search size={18} />}
      title="Studio Sherlock"
      onClose={onClose}
      subtitle="Recherche sur des sites publics via Docteur. Le pseudonyme est transmis aux sites consultés — une correspondance ne prouve pas une identité. Une recherche à la fois ; 3 départs par minute."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <StudioStatus
          label={installState?.status === 'installed' ? 'Environnement disponible' : 'Environnement indisponible'}
          tone={installState?.status === 'installed' ? 'success' : 'warning'}
        />
        <button type="button" className="studio-button" onClick={() => void reloadStatus()}>Vérifier</button>
      </div>

      {error && <StudioErrorState message={error} />}

      <label>Pseudonyme public
        <input
          aria-label="Pseudonyme public"
          className="studio-field"
          value={username}
          disabled={running}
          maxLength={64}
          onChange={e => setUsername(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void search(); }}
        />
      </label>

      <label>Délai maximum par site (secondes)
        <input
          aria-label="Délai maximum par site"
          type="number"
          min={1}
          max={120}
          className="studio-field"
          style={{ width: 120 }}
          disabled={running}
          value={timeoutSeconds}
          onChange={e => setTimeoutSeconds(Math.min(120, Math.max(1, Number(e.target.value) || 30)))}
        />
      </label>

      <StudioToolbar
        destructive={running && <button type="button" className="studio-button studio-button--danger" disabled={!job} onClick={() => void cancel()}>Annuler</button>}
      >
        {!running && (
          <button
            type="button"
            className="studio-button studio-button--primary"
            disabled={!username || installState?.status !== 'installed'}
            onClick={() => void search()}
          >
            Rechercher
          </button>
        )}
      </StudioToolbar>

      {!job && !running && (
        <StudioEmptyState message="Entrez un pseudonyme pour rechercher sa présence publique." />
      )}

      {job && (
        <div aria-live="polite">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '10px 0' }}>
            <StudioStatus label={`${job.username} — État : ${STATUS_LABEL[job.status] ?? 'Inconnu'}`} tone={STATUS_TONE[job.status] ?? 'neutral'} />
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Durée : {(job.duration / 1000).toFixed(1)} s</span>
          </div>

          {/* PROGRESS / SUMMARY */}
          <p style={{ fontSize: 13 }}>
            {job.current}/{job.total} sites — {found} trouvés — {absent} absents — {errors} erreurs
          </p>

          {/* ERRORS */}
          {job.status === 'error' && (
            <StudioErrorState message={job.summary?.error === 'timeout' ? 'Délai de recherche dépassé.' : 'La recherche a été interrompue.'} />
          )}

          {/* RESULTS */}
          {results.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: '10px 0', padding: 0 }}>
              {results.map(result => (
                <li key={result.site} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 13 }}>
                  <StudioStatus compact label={result.site} tone={RESULT_TONE[result.status] ?? 'neutral'} />
                  <span style={{ color: 'var(--text-dim)' }}>{RESULT_LABEL[result.status]}</span>
                  {result.responseTime != null && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{result.responseTime} ms</span>}
                  {result.status === 'found' && /^https?:\/\//.test(result.profileUrl) && (
                    <a href={result.profileUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cyan)', marginLeft: 'auto' }}>
                      Voir le profil public
                    </a>
                  )}
                </li>
              ))}
            </ul>
          ) : job.status !== 'running' && (
            <StudioEmptyState message="Aucun résultat pour l'instant." />
          )}
        </div>
      )}

      {/* HISTORY — honest absence: no job persistence exists server-side today
          (see BACKEND GAP 2, reports/STUDIOS_UX_V2_2026-09.md). Never simulated. */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <h3 style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 8px' }}>Historique</h3>
        <StudioEmptyState message="Aucun historique persistant — Sherlock ne conserve les recherches qu'en mémoire pendant la session du serveur." />
      </div>
    </StudioShell>
  );
}
