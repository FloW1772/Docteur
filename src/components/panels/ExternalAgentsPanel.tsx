import { useEffect, useState } from 'react';
import { externalAgentRequest as api, externalAgentUrl, externalAgentMessages as messages } from '../../lib/cortex/external-agents';
import type { ExternalClient, ExternalJob, ExternalProvider, ExternalSettings } from '../../lib/cortex/external-agents';

const STATUS: Record<string, string> = { waiting_approval: 'Confirmation requise', queued: 'En attente', starting: 'Démarrage', running: 'En cours', completed: 'Terminé', failed: 'Échec', cancelled: 'Annulé', timeout: 'Délai dépassé' };
const FEATURES: Record<string, string> = { code_analysis: 'Analyse de code', code_generation: 'Génération de code', code_fix: 'Correction', refactor: 'Refactorisation', debug: 'Diagnostic', test_generation: 'Génération de tests', repository_analysis: 'Analyse de fichiers du repository' };
const btn = 'px-3 py-2 rounded border border-slate-600 disabled:opacity-40';
const field = 'w-full rounded p-2 bg-slate-900 border border-slate-600';
export default function ExternalAgentsPanel() {
  const [settings, setSettings] = useState<ExternalSettings | null>(null);
  const [clients, setClients] = useState<Record<string, ExternalClient>>({});
  const [jobs, setJobs] = useState<ExternalJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [provider, setProvider] = useState<ExternalProvider>('auto');
  const [mode, setMode] = useState('read');
  const [feature, setFeature] = useState('code_analysis');
  const [cwd, setCwd] = useState('');
  const [rootDraft, setRootDraft] = useState('');
  const [rootApproval, setRootApproval] = useState<{id: string; root: string} | null>(null);
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState('');
  const [model, setModel] = useState('');
  const [timeout, setTimeoutValue] = useState(300000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const job = jobs.find(j => j.id === selected);
  function update(value: ExternalJob) { setJobs(current => [value, ...current.filter(j => j.id !== value.id)]); }
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { const code = e instanceof Error ? e.message : 'error'; setError(messages[code] ?? code); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([api<ExternalSettings>('/settings'), api<ExternalJob[]>('/jobs'), api<Record<string, ExternalClient>>('/clients')]).then(([s, j, c]) => {
      if (active) { setSettings(s); setCwd(s.allowedRoots[0] ?? ''); setJobs(j); setClients(c); }
    }).catch(e => { if (active) setError(messages[e.message] ?? e.message); });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!selected) return;
    const events = new EventSource(externalAgentUrl(`/jobs/${selected}/events`));
    const listener = (event: MessageEvent) => { try { update(JSON.parse(event.data)); } catch { setError('Flux de job invalide'); } };
    events.addEventListener('job', listener);
    events.onopen = () => setError(current => current.startsWith('Flux interrompu.') ? '' : current);
    events.onerror = () => setError('Flux interrompu. Reconnexion automatique en cours.');
    return () => events.close();
  }, [selected]);
  const jobAction = (suffix: string, body: unknown = {}) => action(async () => update(await api<ExternalJob>(`/jobs/${selected}/${suffix}`, body)));
  return <section aria-label="Agents externes" className="p-5 flex flex-col gap-4 text-sm text-slate-200">
    <h3 className="text-lg font-semibold">IA · Agents externes</h3>
    <p>Clients officiels exécutés sur cet ordinateur. Leur connexion reste gérée par Codex et Claude Code.</p>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {settings?.strictLocal && <p role="status" className="text-amber-300">{messages.strict_local}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {(['codex', 'claude'] as const).map(p => <article key={p} className="border border-slate-700 rounded p-3 flex flex-col gap-2">
        <strong>{p === 'codex' ? 'Codex' : 'Claude Code'}</strong>
        <span>Installé : {clients[p] ? clients[p].installed ? 'oui' : 'non' : 'détection…'} · Version : {clients[p]?.version ?? '—'}</span>
        <span>{messages[clients[p]?.reason] ?? 'Détection en cours…'}</span>
        <button className={btn} disabled={busy} onClick={() => void action(async () => { const c = await api<ExternalClient>(`/test/${p}`, {}); setClients(old => ({...old, [p]: c})); })}>Tester {p === 'codex' ? 'Codex' : 'Claude Code'}</button>
        <details><summary className="cursor-pointer">Ouvrir instructions de connexion</summary>
          <p className="mt-2">Dans votre terminal, exécutez <code>{p === 'codex' ? 'codex login' : 'claude auth login'}</code>, puis cliquez sur Tester.</p>
          <a className="underline" href={p === 'codex' ? 'https://developers.openai.com/codex/cli/reference' : 'https://code.claude.com/docs/en/cli-reference'} target="_blank" rel="noreferrer">Documentation officielle</a>
        </details>
      </article>)}
    </div>
    <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void action(async () => {
      const result = await api<ExternalJob>('/jobs', { provider, feature, mode, permissions: mode === 'read' ? 'SAFE' : 'EDIT', cwd, prompt, files: files.split('\n').map(f => f.trim()).filter(Boolean), timeout, model });
      update(result); setSelected(result.id);
    }); }}>
      <label>Agent<select aria-label="Agent" className={field} value={provider} onChange={e => setProvider(e.target.value as ExternalProvider)}>
        <option value="auto">Auto (Codex, puis Claude si indisponible avant lancement)</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="none">Aucun agent externe</option>
      </select></label>
      <label>Tâche de code<select className={field} value={feature} onChange={e => setFeature(e.target.value)}>{Object.entries(FEATURES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Mode<select aria-label="Mode" className={field} value={mode} onChange={e => setMode(e.target.value)}><option value="read">Lecture seule · SAFE</option><option value="edit">Édition avec revue · EDIT</option><option disabled>Édition + tests (indisponible)</option><option disabled>FULL (indisponible)</option></select></label>
      <label>Workspace<select aria-label="Workspace" className={field} value={cwd} onChange={e => setCwd(e.target.value)}>{settings?.allowedRoots.map(root => <option key={root}>{root}</option>)}</select></label>
      <label>Fichiers sélectionnés (chemins relatifs, un par ligne)<textarea aria-label="Fichiers sélectionnés" className={field} rows={3} placeholder={'src/example.ts\npackage.json'} value={files} onChange={e => setFiles(e.target.value)} /></label>
      <label>Instruction<textarea aria-label="Instruction" className={field} required maxLength={20000} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      <label>Modèle (vide : défaut du client)<input className={field} value={model} onChange={e => setModel(e.target.value)} maxLength={100} /></label>
      <label>Timeout<select className={field} value={timeout} onChange={e => setTimeoutValue(Number(e.target.value))}><option value={300000}>5 minutes</option><option value={900000}>15 minutes</option><option value={1800000}>30 minutes</option></select></label>
      <p>Le prompt et les fichiers sélectionnés seront envoyés au service choisi. Aucun neurone Cortex n’est joint. Shell, build/test et opérations Git en écriture sont bloqués.</p>
      <button className={btn} disabled={busy || !settings || settings.strictLocal || provider === 'none'}>Prévisualiser l’envoi</button>
    </form>
    <details><summary className="cursor-pointer">Choisir un autre dossier autorisé</summary>
      <input aria-label="Nouveau dossier" className={field} placeholder="C:\\dev\\mon-projet" value={rootDraft} onChange={e => setRootDraft(e.target.value)} />
      <button className={btn} disabled={busy} onClick={() => void action(async () => setRootApproval(await api('/roots', {cwd: rootDraft})))}>Vérifier le dossier</button>
      {rootApproval && <div role="group" aria-label="Autorisation du dossier"><p>Autoriser la sélection explicite de fichiers sous {rootApproval.root} ?</p>
        {[true, false].map(accepted => <button key={String(accepted)} className={btn} disabled={busy} onClick={() => void action(async () => { const s = await api<ExternalSettings>(`/roots/${rootApproval.id}/approval`, {accepted}); setSettings(s); if (accepted) setCwd(rootApproval.root); setRootApproval(null); })}>{accepted ? 'Autoriser ce dossier' : 'Refuser'}</button>)}
      </div>}
    </details>
    {job && <article className="border border-slate-600 rounded p-3 flex flex-col gap-3" aria-label="Détail du job">
      <strong>{job.provider} · {STATUS[job.status] ?? job.status}</strong>
      <p>{job.workspace}</p>
      <p>Durée : {Math.floor((job.status === 'running' && job.started_at ? now - Date.parse(job.started_at) : job.duration) / 1000)} s · Exit code : {job.exit_code ?? '—'}</p>
      {job.error && <p role="alert">{messages[job.error] ?? job.error}</p>}
      {job.status === 'waiting_approval' && <div className="border border-amber-600 p-3"><strong>Confirmer cet envoi au service externe</strong>
        <p>{job.scope.bytes} octets · {job.scope.files.join(', ') || 'Prompt uniquement'}</p><pre className="whitespace-pre-wrap">{job.scope.prompt}</pre>
        <button className={btn} disabled={busy} onClick={() => void jobAction('approval', {accepted: true})}>Confirmer et lancer</button>
        <button className={btn} disabled={busy} onClick={() => void jobAction('approval', {accepted: false})}>Refuser l’envoi</button>
      </div>}
      {['queued', 'starting', 'running'].includes(job.status) && <button className={btn} disabled={busy} onClick={() => void jobAction('cancel')}>Arrêter</button>}
      <details open><summary>Logs stdout / stderr (secrets masqués)</summary><pre aria-label="Logs du job" className="whitespace-pre-wrap break-all max-h-64 overflow-auto text-xs bg-slate-950 p-2">{job.output || 'Aucune sortie'}</pre></details>
      <p>Fichiers modifiés : {job.changes.length} · {job.tests}</p>
      {job.summary && <p className="whitespace-pre-wrap">{job.summary}</p>}
      {job.changes.map(change => <details key={change.path}><summary>{change.kind} · {change.path} · Voir diff</summary><pre className="whitespace-pre-wrap break-all text-xs max-h-72 overflow-auto">{change.diff}</pre></details>)}
      {job.review === 'pending' && <div><button className={btn} disabled={busy} onClick={() => void jobAction('review', {accepted: true})}>Accepter changements</button><button className={btn} disabled={busy} onClick={() => void jobAction('review', {accepted: false})}>Rejeter changements</button></div>}
      {job.review === 'accepted' && <button className={btn} disabled={busy} onClick={() => void jobAction('undo')}>Revenir en arrière</button>}
      {['rejected', 'reverted', 'unavailable_after_restart'].includes(job.review) && <p>{job.review === 'rejected' ? 'Changements rejetés' : job.review === 'reverted' ? 'Changements annulés' : 'Revue et retour arrière indisponibles après redémarrage.'}</p>}
      {['failed', 'timeout'].includes(job.status) && clients[job.provider === 'codex' ? 'claude' : 'codex']?.ready && <button className={btn} onClick={() => { setProvider(job.provider === 'codex' ? 'claude' : 'codex'); setSelected(null); }}>Préparer avec l’autre agent (nouvelle confirmation requise)</button>}
    </article>}
    <div className="flex flex-col gap-2"><strong>Historique local</strong>
      <button className={btn} disabled={busy} onClick={() => void action(async () => { setJobs(await api('/history/delete', {})); setSelected(null); })}>Supprimer l’historique terminé</button>
      {jobs.map(j => <button key={j.id} className={`${btn} text-left`} onClick={() => setSelected(j.id)}>{new Date(j.created_at).toLocaleString()} · {j.provider} · {j.task} · {STATUS[j.status] ?? j.status}</button>)}
    </div>
  </section>;
}
