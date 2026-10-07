// [Model Router V1] Settings → Modèles — one view of every provider and model
// Docteur can use, with the facts the runtime really reports (each with its
// source), and a routing tester: AUTO (deterministic) or manual selection, the
// decision and why the other models were set aside, then an optional single run
// with clear errors. Never downloads or installs anything.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import LoadingSpinner from '../loading/LoadingSpinner';
import { cortexClient } from '../../lib/cortex/client';
import type { ModelCapability, ModelRouterRegistry, ModelRouteDecision, ModelRunResult, ModelFact, ModelRouteRequest } from '../../lib/cortex/client';

const CAPS: Array<[ModelCapability, string]> = [
  ['TEXT', 'Texte'], ['VISION', 'Vision'], ['AUDIO', 'Audio'], ['EMBEDDING', 'Embedding'], ['TOOL_USE', 'Outils'],
  ['STRUCTURED_OUTPUT', 'Sortie structurée'], ['IMAGE_GENERATION', 'Génération d’images'], ['LONG_CONTEXT', 'Long contexte'],
];
const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: 'Disponible', RUNTIME_UNAVAILABLE: 'Runtime arrêté', NOT_CONFIGURED: 'Non configuré', CLOUD_DISABLED: 'Cloud désactivé',
  DISABLED_BY_STRICT_LOCAL: 'Bloqué (Strict Local)', CHECKED_BY_IMAGE_MODULE: 'Vérifié par le Générateur d’images',
};

function bytes(n: number | null | undefined): string {
  if (n == null) return 'inconnu';
  const gb = n / 1_073_741_824;
  return gb >= 1 ? `${gb.toFixed(1)} Go` : `${(n / 1_048_576).toFixed(0)} Mo`;
}
function factText<T>(f: ModelFact<T> | null | undefined, format: (v: T) => string = String): string {
  if (!f || f.value === null) return 'inconnu';
  return `${format(f.value)} (${f.source === 'runtime' ? 'runtime' : f.source === 'catalog' ? 'catalogue' : f.source})`;
}

export function ModelRouterSection() {
  const [registry, setRegistry] = useState<ModelRouterRegistry | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [caps, setCaps] = useState<ModelCapability[]>(['TEXT']);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [numCtx, setNumCtx] = useState('');
  const [numGpu, setNumGpu] = useState('');
  const [prompt, setPrompt] = useState('');
  const [decision, setDecision] = useState<ModelRouteDecision | null>(null);
  const [run, setRun] = useState<ModelRunResult | null>(null);
  const [busy, setBusy] = useState<'route' | 'run' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await cortexClient.modelRouterRegistry();
      if (!r.ok) throw new Error((r as unknown as { error?: { message?: string } }).error?.message ?? 'Registre indisponible');
      setRegistry(r);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const llmProviders = useMemo(() => (registry?.providers ?? []).filter(p => p.kind === 'llm' && p.id !== 'pair'), [registry]);
  const providerModels = useMemo(() => (registry?.models ?? []).filter(m => m.provider === provider), [registry, provider]);
  useEffect(() => { if (mode === 'manual' && !providerModels.some(m => m.name === model)) setModel(providerModels[0]?.name ?? ''); }, [mode, providerModels, model]);

  function request(): ModelRouteRequest {
    const runtimeOptions: { num_ctx?: number; num_gpu?: number } = {};
    if (mode === 'manual' && provider === 'ollama') {
      if (numCtx.trim()) runtimeOptions.num_ctx = Number(numCtx);
      if (numGpu.trim()) runtimeOptions.num_gpu = Number(numGpu);
    }
    return { capabilities: caps, mode, provider: mode === 'manual' ? provider : null, model: mode === 'manual' ? model : null, ...(Object.keys(runtimeOptions).length ? { runtimeOptions } : {}) };
  }

  async function explain() {
    setBusy('route'); setRun(null);
    try { setDecision(await cortexClient.modelRouterRoute(request())); } catch (err) { setDecision({ ok: false, mode, rejected: [], error: { code: 'NETWORK', message: (err as Error).message, hint: null } }); }
    finally { setBusy(null); }
  }
  async function execute() {
    setBusy('run'); setDecision(null);
    try { setRun(await cortexClient.modelRouterRun({ ...request(), prompt })); } catch (err) { setRun({ ok: false, error: { code: 'NETWORK', message: (err as Error).message, hint: null } }); }
    finally { setBusy(null); }
  }
  const toggleCap = (c: ModelCapability) => setCaps(prev => (prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]));

  return (
    <section className="mr-section" aria-label="Routeur de modèles">
      <div className="mr-head">
        <span className="mr-title">ROUTEUR DE MODÈLES</span>
        <button type="button" className="mr-btn" onClick={() => { void load(); }} disabled={loading} aria-label="Actualiser le registre des modèles"><RefreshCw size={12} aria-hidden="true" /> Actualiser</button>
      </div>
      {loading && !registry && <LoadingSpinner label="Lecture des providers et des modèles…" />}
      {loadError && <p className="mr-error" role="alert">Registre indisponible : {loadError}</p>}
      {registry && (
        <>
          <p className="mr-state" role="status">
            {registry.strictLocal ? 'Strict Local actif : aucun appel cloud.' : registry.cloudEnabled ? 'Cloud autorisé (opt-in) — AUTO reste local quand un modèle local sait faire la tâche.' : 'Cloud désactivé.'}
            {' '}Un échec local n’est jamais renvoyé vers le cloud.
          </p>
          <ul className="mr-pending" aria-label="Cibles en attente d’identification">
            {registry.pendingIdentity.map(t => <li key={t.target}>{t.target} : identité exacte requise — non intégré ({t.status})</li>)}
          </ul>

          <details className="mr-block" open>
            <summary>Providers ({registry.providers.length})</summary>
            <ul className="mr-providers">
              {registry.providers.map(p => (
                <li key={p.id} data-provider={p.id}>
                  <strong>{p.label}</strong> <span className="mr-chip">{p.location}</span> <span className={`mr-status mr-status--${p.available ? 'ok' : 'off'}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                  {p.reason && <span className="mr-reason"> — {p.reason}</span>}
                </li>
              ))}
            </ul>
          </details>

          <details className="mr-block" open>
            <summary>Modèles ({registry.models.length})</summary>
            <div className="mr-table-wrap">
              <table className="mr-table">
                <thead><tr><th scope="col">Modèle</th><th scope="col">Lieu</th><th scope="col">Capacités</th><th scope="col">Quantization</th><th scope="col">Taille</th><th scope="col">Contexte</th><th scope="col">Mémoire</th></tr></thead>
                <tbody>
                  {registry.models.map(m => (
                    <tr key={m.id} data-model={m.name}>
                      <th scope="row">{m.name}{!m.available && <span className="mr-reason"> (indisponible)</span>}</th>
                      <td>{m.location}</td>
                      <td>{m.capabilitiesKnown ? m.capabilities.join(', ') : 'inconnues'}<span className="mr-source"> · {m.capabilitiesSource === 'runtime' ? 'runtime' : m.capabilitiesSource === 'catalog' ? 'catalogue' : m.capabilitiesSource}</span></td>
                      <td>{m.lowVram ? factText(m.lowVram.quantization) : '—'}</td>
                      <td>{m.lowVram ? factText(m.lowVram.sizeBytes, v => bytes(v)) : '—'}</td>
                      <td>{factText(m.contextLength, v => `${v.toLocaleString('fr-FR')} tokens`)}</td>
                      <td>
                        {m.lowVram?.loaded ? `chargé : ${bytes(m.lowVram.loaded.vramBytes)} VRAM${m.lowVram.loaded.ramOffloadBytes ? ` + ${bytes(m.lowVram.loaded.ramOffloadBytes)} RAM` : ''}` : ''}
                        {m.lowVram?.fit ? ` ajustement : ${m.lowVram.fit.rating} (estimation catalogue)` : ''}
                        {m.lowVram?.gpuLayers.value != null ? ` · couches GPU : ${m.lowVram.gpuLayers.value}` : ''}
                        {!m.lowVram?.loaded && !m.lowVram?.fit && (m.lowVram?.gpuLayers.value == null) ? 'non mesuré' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <form className="mr-test" onSubmit={e => { e.preventDefault(); void explain(); }} aria-label="Tester le routage">
            <fieldset className="mr-fieldset">
              <legend>Capacités demandées</legend>
              {CAPS.map(([c, label]) => (
                <label key={c} className="mr-check"><input type="checkbox" checked={caps.includes(c)} onChange={() => toggleCap(c)} /> {label}</label>
              ))}
            </fieldset>
            <fieldset className="mr-fieldset">
              <legend>Sélection</legend>
              <label className="mr-check"><input type="radio" name="mr-mode" checked={mode === 'auto'} onChange={() => setMode('auto')} /> AUTO (déterministe)</label>
              <label className="mr-check"><input type="radio" name="mr-mode" checked={mode === 'manual'} onChange={() => setMode('manual')} /> Manuelle</label>
              {mode === 'manual' && (
                <div className="mr-row">
                  <label htmlFor="mr-provider">Provider</label>
                  <select id="mr-provider" value={provider} onChange={e => setProvider(e.target.value)}>{llmProviders.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
                  <label htmlFor="mr-model">Modèle</label>
                  <select id="mr-model" value={model} onChange={e => setModel(e.target.value)}>{providerModels.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select>
                  {provider === 'ollama' && (
                    <>
                      <label htmlFor="mr-num-ctx">num_ctx</label>
                      <input id="mr-num-ctx" inputMode="numeric" value={numCtx} onChange={e => setNumCtx(e.target.value)} placeholder="défaut" size={8} />
                      <label htmlFor="mr-num-gpu">num_gpu</label>
                      <input id="mr-num-gpu" inputMode="numeric" value={numGpu} onChange={e => setNumGpu(e.target.value)} placeholder="défaut" size={5} />
                    </>
                  )}
                </div>
              )}
            </fieldset>
            <div className="mr-row">
              <button type="submit" className="mr-btn" disabled={busy !== null || caps.length === 0}>Voir la décision</button>
            </div>
            <label className="mr-prompt">Message de test (optionnel)
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2} maxLength={4000} placeholder="Ex. : Réponds « ok »." />
            </label>
            <div className="mr-row">
              <button type="button" className="mr-btn mr-btn--primary" disabled={busy !== null || !prompt.trim() || caps.length === 0} onClick={() => { void execute(); }}>Envoyer au modèle choisi</button>
              {busy === 'run' && <LoadingSpinner label="Appel du modèle…" />}
            </div>
          </form>

          {decision && <DecisionView data={decision} />}
          {run && (run.ok && run.result ? (
            <div className="mr-result" role="status">
              <p><strong>{run.result.model}</strong> ({run.result.location}) — {run.result.durationMs} ms</p>
              <div className="mr-text">{run.result.text}</div>
            </div>
          ) : <DecisionView data={{ ok: false, mode, rejected: run.rejected ?? [], error: run.error }} />)}
        </>
      )}
    </section>
  );
}

function DecisionView({ data }: { data: ModelRouteDecision }) {
  return (
    <div className={`mr-decision${data.ok ? '' : ' mr-decision--error'}`} role={data.ok ? 'status' : 'alert'}>
      {data.ok && data.decision ? (
        <p>Décision : <strong>{data.decision.model}</strong> via {data.decision.provider} ({data.decision.location}) — {data.decision.reason}</p>
      ) : (
        <p>{data.error?.code} — {data.error?.message}{data.error?.hint ? ` ${data.error.hint}` : ''}</p>
      )}
      {(data.warnings ?? []).map(w => <p key={w} className="mr-reason">{w}</p>)}
      {data.rejected.length > 0 && (
        <details><summary>Écartés ({data.rejected.length})</summary><ul>{data.rejected.map(r => <li key={r.id}>{r.id} : {r.reason}</li>)}</ul></details>
      )}
    </div>
  );
}
