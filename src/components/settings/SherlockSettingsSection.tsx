import { useEffect, useState, useRef } from 'react';
import { cortexClient } from '../../lib/cortex/client';
import type { SherlockInstallState, SherlockJob } from '../../lib/cortex/client';
import { startJobPolling } from '../../lib/video-job-polling';

const labels: Record<string, string> = { running: 'En cours', done: 'Terminée', error: 'Erreur', cancelled: 'Annulée', found: 'Trouvé', absent: 'Absent', invalid: 'Pseudonyme incompatible' };
const button = { border: '1px solid #8b7baa', borderRadius: 6, padding: '6px 12px', color: '#e2d7ff', background: '#292039' };
export function SherlockSettingsSection() {
  const [state, setState] = useState<SherlockInstallState | null>(null);
  const [username, setUsername] = useState('');
  const [job, setJob] = useState<SherlockJob | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const stop = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  async function reload() {
    try { const next = await cortexClient.getSherlockStatus(); if (mounted.current) setState(next); }
    catch { if (mounted.current) setError('Service Sherlock indisponible.'); }
  }
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; stop.current?.(); }; }, []);
  const running = pending || job?.status === 'running';
  async function search() {
    if (running) return;
    if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u.test(username) || username.includes('..')) {
      setError('Pseudonyme : 1 à 64 lettres, chiffres, tirets, points ou underscores ; sans espace ni deux points successifs.'); return;
    }
    setPending(true); setError(''); setJob(null);
    try {
      const result = await cortexClient.searchSherlock(username);
      if (!mounted.current) return;
      setJob({ id: result.jobId, operation: 'Recherche', username, status: 'running', duration: 0, current: 0, total: 3, summary: null });
      stop.current?.();
      stop.current = startJobPolling(() => cortexClient.getSherlockJob(result.jobId), next => next.status, next => setJob(next), () => {}, { intervalMs: 700 });
    } catch { if (mounted.current) setError('Recherche refusée ou service indisponible. Réessaie dans une minute.'); }
    finally { if (mounted.current) setPending(false); }
  }
  async function cancel() {
    if (!job) return;
    try { const result = await cortexClient.cancelSherlockSearch(job.id); if (!result.cancelled) setError('La recherche est déjà arrêtée.'); }
    catch { setError('Annulation non confirmée. Réessaie.'); }
  }
  const results = job?.summary?.results ?? [];
  return <section aria-label="Sherlock OSINT" className="flex flex-col gap-2 p-3 rounded" style={{ color: '#ddd3ed', background: '#191321', fontSize: 12 }}>
    <h3>Recherche de pseudonyme — Sherlock</h3>
    <p>Recherche sur des sites publics via Docteur. Le pseudonyme est transmis aux sites consultés. Une correspondance ne prouve pas une identité.</p>
    <p>{state?.status === 'installed' ? 'Disponible' : 'Environnement indisponible'} <button type="button" style={button} onClick={() => void reload()}>Vérifier</button></p>
    <label>Pseudonyme public<input aria-label="Pseudonyme public" value={username} disabled={running} maxLength={64} onChange={event => setUsername(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search(); }} style={{ display: 'block', width: '100%', padding: 8, color: '#fff', background: '#30243f' }} /></label>
    <div>{running ? <button type="button" disabled={!job} style={button} onClick={() => void cancel()}>Annuler</button> : <button type="button" style={button} disabled={!username || state?.status !== 'installed'} onClick={() => void search()}>Rechercher</button>}</div>
    {error && <p role="alert">{error}</p>}
    {job && <div aria-live="polite">
      <p>{job.username} — État : {labels[job.status] ?? 'Inconnu'} — Durée : {(job.duration / 1000).toFixed(1)} s</p>
      <p>{job.current}/{job.total} sites — {results.filter(r => r.status === 'found').length} trouvés — {results.filter(r => r.status === 'absent').length} absents — {results.filter(r => r.status === 'error' || r.status === 'invalid').length} erreurs</p>
      {job.status === 'error' && <p role="alert">{job.summary?.error === 'timeout' ? 'Délai de recherche dépassé.' : 'La recherche a été interrompue.'}</p>}
      <ul>{results.map(result => <li key={result.site}>{result.site} — {labels[result.status]} {result.status === 'found' && /^https?:\/\//.test(result.profileUrl) && <a href={result.profileUrl} target="_blank" rel="noopener noreferrer">Voir le profil public</a>}</li>)}</ul>
    </div>}
    <p>Une recherche à la fois ; 3 départs par minute. Résultats externes non vérifiés, conservés comme données de recherche.</p>
  </section>;
}
