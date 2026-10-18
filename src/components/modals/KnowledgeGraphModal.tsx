// [Knowledge Graph V1] KG-6 — interactive Knowledge Graph view (read-only).
// Search an entity → bounded neighbourhood (depth 1) → manual, progressive expansion.
// Every rule (visibility, limits, both sides of a contradiction, ambiguity) is enforced
// by the server (cortex-server/src/lib/kg-view.js); this view only displays and asks.
// Private sources are never shown unless the user explicitly includes them (local).
// Relations are descriptive: nothing here grants a permission.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Network, Search, ZoomIn, ZoomOut, Maximize2, Crosshair, PlusCircle, SlidersHorizontal } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import LoadingSpinner from '../loading/LoadingSpinner';
import GraphCanvas, { type Selection } from '../knowledge-graph/GraphCanvas';
import { ClaimDetails, EntityDetails, RelationDetails } from '../knowledge-graph/KgDetails';
import KgTimeline from '../knowledge-graph/KgTimeline';
import { cortexClient } from '../../lib/cortex/client';
import type { KgClaimStatus, KgClaimView, KgEntityView, KgFilters, KgRelationView, KgSearchHit, KgTimeline as Timeline, KgViewError, KgVisibility } from '../../lib/cortex/client';
import {
  createGraph, mergeNeighborhood, recenter as recenterGraph, fitTransform, zoomAt, centerOn, describeEdge, statusLabel, typeLabel,
  MAX_RENDERED_NODES, type GraphState, type Transform,
} from '../../lib/kg/graph-model';

interface Props {
  onClose: () => void;
  scope?: KgVisibility['scope'];
  /** KG-7: reopen a neuron / an external URL with Docteur's existing mechanisms (App) */
  onOpenNeuron?: (pageId: string) => void;
  onOpenUrl?: (url: string, title: string) => void;
}

/** The exact stored text behind a citation, read through Notebook's own citation preview (read-only). */
type SourcePreview = { title: string; meta: string; text: string; start: number | null; end: number | null; warning: string | null } | null;

const ENTITY_TYPES = ['PERSON', 'ORGANIZATION', 'LOCATION', 'PRODUCT', 'PROJECT', 'DOCUMENT', 'CONCEPT', 'EVENT'];
const STATUSES: KgClaimStatus[] = ['SUPPORTED', 'ASSERTED', 'DISPUTED', 'HYPOTHESIS', 'SUPERSEDED'];
const DEFAULT_STATUSES: KgClaimStatus[] = ['SUPPORTED', 'ASSERTED', 'DISPUTED', 'HYPOTHESIS'];
const MAX_REEXPAND = 10;

type Details = { kind: 'entity'; view: KgEntityView } | { kind: 'claim'; view: KgClaimView } | { kind: 'relation'; view: KgRelationView } | null;

function errorMessage(e: unknown): string {
  const err = e as KgViewError;
  if (err?.code === 'KG_DISABLED') return 'KG_DISABLED';
  if (err?.code === 'KG_NOT_FOUND') return 'Élément introuvable ou non visible avec les filtres de confidentialité actuels.';
  return err?.code ? `${err.code}${err.message && err.message !== err.code ? ` — ${err.message}` : ''}` : (err?.message || 'Erreur inconnue');
}

export default function KnowledgeGraphModal({ onClose, scope = null, onOpenNeuron, onOpenUrl }: Props) {
  const [sourcePreview, setSourcePreview] = useState<SourcePreview>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KgSearchHit[] | null>(null);
  const [graph, setGraph] = useState<GraphState | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 400, y: 300, k: 1 });
  const [selection, setSelection] = useState<Selection>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Details>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [tab, setTab] = useState<'details' | 'timeline'>('details');
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [includePrivate, setIncludePrivate] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<KgClaimStatus[]>(DEFAULT_STATUSES);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeUndated, setIncludeUndated] = useState(true);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [knownSources, setKnownSources] = useState<{ sourceId: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [metrics, setMetrics] = useState<{ lastMs: number; nodes: number; edges: number } | null>(null);
  const size = useRef({ w: 800, h: 600 });
  const seq = useRef(0);

  // KG-7: private sources need an explicit scope — the caller's (e.g. one notebook) or, from the global view, the whole local KG
  const vis: KgVisibility = useMemo(() => ({ includePrivate, provider: 'local', scope: includePrivate ? (scope ?? { all: true }) : scope }), [includePrivate, scope]);
  const filters: KgFilters = useMemo(() => ({
    ...(types.length ? { entityTypes: types } : {}), statuses, ...(from ? { from } : {}), ...(to ? { to } : {}), includeUndated,
    ...(sourceIds.length ? { sourceIds } : {}),
  }), [types, statuses, from, to, includeUndated, sourceIds]);
  // sources met in the loaded neighbourhoods (only allowed ones are ever returned) — offered by the source filter
  const rememberSources = useCallback((list: { sourceId: string; name: string }[] | undefined) => {
    if (!list?.length) return;
    setKnownSources(prev => {
      const next = [...prev];
      for (const s of list) if (!next.some(x => x.sourceId === s.sourceId)) next.push({ sourceId: s.sourceId, name: s.name });
      return next.slice(0, 40);
    });
  }, []);

  const fail = useCallback((e: unknown) => setError(errorMessage(e)), []);
  const announce = (g: GraphState, extra = '') => setLive(`${g.nodes.size} nœuds, ${g.edges.size} relations affichés.${extra ? ` ${extra}` : ''}`);
  const fit = useCallback((g: GraphState | null = graph) => { if (g) setTransform(fitTransform(g, size.current.w, size.current.h)); }, [graph]);

  const openEntity = useCallback(async (entityId: string) => {
    const id = ++seq.current;
    setTab('details');
    try {
      const v = await cortexClient.kgEntity(entityId, vis);
      if (id === seq.current) { setDetails({ kind: 'entity', view: v }); setSelection({ kind: 'node', id: v.entity.id }); }
    } catch (e) { if (id === seq.current) fail(e); }
  }, [vis, fail]);

  const openClaim = useCallback(async (claimId: string) => {
    const id = ++seq.current;
    setTab('details');
    try {
      const v = await cortexClient.kgClaim(claimId, vis);
      if (id === seq.current) { setDetails({ kind: 'claim', view: v }); setSelection({ kind: 'edge', id: `clm:${claimId}` }); }
    } catch (e) { if (id === seq.current) fail(e); }
  }, [vis, fail]);

  // KG-7: a citation reopens its real source — Notebook chunk (right notebook, document, version, locator), neuron, URL
  const openSource = useCallback(async (evidenceId: string) => {
    try {
      const c = await cortexClient.kgCitation(evidenceId, vis);
      const o = c.open;
      if (o.available === false) { setSourcePreview({ title: c.source.name, meta: '', text: '', start: null, end: null, warning: 'La source n’est plus disponible (supprimée ou déplacée).' }); return; }
      if (o.kind === 'notebook_document' && o.notebookId && o.chunkId) {
        if (o.origin === 'ai_history') {
          const p = await cortexClient.aiHistoryCitation(o.notebookId, o.chunkId);
          setSourcePreview({ title: p.conversationTitle, meta: `Historique IA · ${p.providerLabel}${p.date ? ` · ${p.date}` : ''}`, text: p.text, start: o.charStart ?? null, end: o.charEnd ?? null, warning: null });
        } else {
          const p = await cortexClient.previewNotebookCitation(o.notebookId, o.chunkId);
          setSourcePreview({ title: p.sourceTitle, meta: `Notebook · version ${p.documentVersion}${p.page ? ` · p. ${p.page}` : ''}${p.headingPath.length ? ` · ${p.headingPath.join(' › ')}` : ''}`, text: p.text,
            start: o.charStart ?? null, end: o.charEnd ?? null, warning: p.superseded ? 'Version remplacée : ce passage vient d’une version antérieure du document.' : null });
        }
        return;
      }
      if (o.kind === 'neuron' && onOpenNeuron) { onOpenNeuron(o.pageId); onClose(); return; }
      if (o.kind !== 'notebook_document' && o.url && onOpenUrl) { onOpenUrl(o.url, c.source.name); return; }
      setSourcePreview({ title: c.source.name, meta: '', text: c.evidence.preview, start: null, end: null, warning: 'Aucun moyen d’ouvrir cette source ; extrait conservé affiché.' });
    } catch (e) { fail(e); }
  }, [vis, fail, onOpenNeuron, onOpenUrl, onClose]);

  const openEdge = useCallback(async (edgeId: string) => {
    const edge = graph?.edges.get(edgeId);
    if (!edge) return;
    setSelection({ kind: 'edge', id: edgeId });
    if (edge.kind === 'claim' && edge.claimId) { await openClaim(edge.claimId); return; }
    const id = ++seq.current;
    setTab('details');
    try {
      const v = await cortexClient.kgRelation(edge.relationshipId!, vis);
      if (id === seq.current) setDetails({ kind: 'relation', view: v });
    } catch (e) { if (id === seq.current) fail(e); }
  }, [graph, openClaim, vis, fail]);

  /** Loads (or reloads after a filter change) the view: centre + the nodes already expanded. */
  const loadCenter = useCallback(async (entityId: string, reexpand: string[] = []) => {
    setBusy('Chargement du voisinage…');
    setError(null);
    setNotice(null);
    const t0 = performance.now();
    const startSeq = seq.current;
    try {
      const nb = await cortexClient.kgNeighborhood(entityId, { ...vis, depth: 1, filters });
      rememberSources(nb.sources);
      let g = createGraph(nb);
      for (const id of reexpand.slice(0, MAX_REEXPAND)) {
        if (!g.nodes.has(id) || id === g.centerId) continue;
        const more = await cortexClient.kgNeighborhood(id, { ...vis, depth: 1, filters });
        rememberSources(more.sources);
        g = mergeNeighborhood(g, more, id).state;
      }
      setGraph(g);
      setFocusedId(g.centerId);
      setTransform(fitTransform(g, size.current.w, size.current.h));
      setMetrics({ lastMs: Math.round(performance.now() - t0), nodes: g.nodes.size, edges: g.edges.size });
      announce(g);
      // the user's latest action wins: if they opened other details meanwhile, keep them
      if (seq.current === startSeq) await openEntity(g.centerId);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [vis, filters, openEntity, fail, rememberSources]);

  const expand = useCallback(async (nodeId: string) => {
    if (!graph) return;
    const node = graph.nodes.get(nodeId);
    if (!node) return;
    if (node.expanded && node.hiddenEdges === 0) { setNotice(`${node.label} est déjà entièrement affiché.`); return; }
    setBusy(`Développement de ${node.label}…`);
    setError(null);
    const t0 = performance.now();
    try {
      // a node already expanded asks for its NEXT slice of edges (high fan-out paging)
      const offset = node.expanded ? node.nextOffset : 0;
      const nbr = await cortexClient.kgNeighborhood(nodeId, { ...vis, depth: 1, filters, offset });
      rememberSources(nbr.sources);
      const r = mergeNeighborhood(graph, nbr, nodeId);
      if (r.refused) {
        setNotice(`Limite d’affichage atteinte (${MAX_RENDERED_NODES} nœuds) : recentrez sur ${node.label} ou relancez une recherche.`);
      } else {
        setGraph(r.state);
        setMetrics({ lastMs: Math.round(performance.now() - t0), nodes: r.state.nodes.size, edges: r.state.edges.size });
        announce(r.state, `${r.addedNodes} nouveau${r.addedNodes > 1 ? 'x' : ''} nœud${r.addedNodes > 1 ? 's' : ''} autour de ${node.label}.`);
        const rest = r.state.nodes.get(nodeId)?.hiddenEdges ?? 0;
        if (rest > 0) setNotice(`${rest} relation${rest > 1 ? 's' : ''} de ${node.label} non chargée${rest > 1 ? 's' : ''} (limite par nœud) — recentrez pour les voir.`);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [graph, vis, filters, fail, rememberSources]);

  const recenter = useCallback((nodeId: string) => {
    if (!graph) return;
    const node = graph.nodes.get(nodeId);
    if (!node) return;
    if (node.hiddenEdges > 0 || !node.expanded) { void loadCenter(nodeId); return; }
    const g = recenterGraph(graph, nodeId);
    setGraph(g);
    setTransform(t => centerOn(t, g.nodes.get(nodeId)!, size.current.w, size.current.h));
    setLive(`Vue centrée sur ${node.label}.`);
  }, [graph, loadCenter]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy('Recherche…');
    setError(null);
    try {
      const r = await cortexClient.kgSearch(q, vis);
      const entities = r.results.filter(h => h.resultType === 'entity');
      setHits(entities);
      setLive(`${entities.length} entité${entities.length > 1 ? 's' : ''} trouvée${entities.length > 1 ? 's' : ''}.`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  // filters / privacy changed: reload the current view with the same expansions
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!graph) return;
    const expanded = [...graph.nodes.values()].filter(n => n.expanded && n.id !== graph.centerId).map(n => n.id);
    void loadCenter(graph.centerId, expanded);
    setDetails(null);
    setTimeline(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vis, filters]);

  // timeline of the selected entity
  const timelineEntity = details?.kind === 'entity' ? details.view.entity.id : null;
  useEffect(() => {
    if (tab !== 'timeline' || !timelineEntity) return;
    let cancelled = false;
    cortexClient.kgTimeline(timelineEntity, { ...vis, filters: { ...(from ? { from } : {}), ...(to ? { to } : {}) } })
      .then(t => { if (!cancelled) setTimeline(t); })
      .catch(e => { if (!cancelled) fail(e); });
    return () => { cancelled = true; };
  }, [tab, timelineEntity, vis, from, to, fail]);

  const selectedNode = selection?.kind === 'node' ? graph?.nodes.get(selection.id) ?? null : (focusedId ? graph?.nodes.get(focusedId) ?? null : null);
  const onSize = useCallback((w: number, h: number) => { size.current = { w, h }; }, []);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  if (error === 'KG_DISABLED') {
    return (
      <StudioShell icon={<Network size={18} />} title="Knowledge Graph" onClose={onClose}>
        <div className="studio-empty" data-testid="kg-disabled">
          <p className="studio-empty-message">Le Knowledge Graph est désactivé tant que sa certification (KG-CERT) n’est pas terminée. Aucune donnée n’est créée dans votre base.</p>
        </div>
      </StudioShell>
    );
  }

  return (
    <StudioShell icon={<Network size={18} />} title="Knowledge Graph" onClose={onClose} width="min(1280px, calc(100vw - 24px))"
      subtitle="Lecture seule · local · chaque affirmation cite ses sources d’origine · une relation n’accorde aucune permission">
      <div className="kg-layout">
        <form role="search" className="kg-search" onSubmit={e => { e.preventDefault(); void search(); }}>
          <label htmlFor="kg-query" className="kg-label">Rechercher une entité</label>
          <input id="kg-query" className="kg-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Nom, alias, identifiant…" autoComplete="off" />
          <button type="submit" className="kg-btn kg-btn--primary" disabled={!query.trim() || Boolean(busy)}><Search size={14} aria-hidden="true" /> Rechercher</button>
          <label className="kg-check">
            <input type="checkbox" checked={includePrivate} onChange={e => setIncludePrivate(e.target.checked)} />
            Inclure les sources privées (affichage local uniquement)
          </label>
        </form>

        {hits && (
          <div className="kg-hits" aria-label="Résultats de recherche">
            {hits.length === 0 ? <p className="kg-muted">Aucune entité trouvée.</p> : (
              <ul>
                {hits.slice(0, 12).map(h => (
                  <li key={h.id}>
                    <button type="button" className="kg-hit" onClick={() => { setHits(null); void loadCenter(h.id); }}>
                      <strong>{h.label}</strong> <span className="kg-muted">{typeLabel(h.entityType ?? '')}</span>
                      {h.status === 'AMBIGUOUS' && <span className="kg-status kg-status--ambiguous">ambiguë</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="kg-toolbar" role="toolbar" aria-label="Commandes du graphe">
          <div className="kg-segmented" role="radiogroup" aria-label="Affichage">
            <button type="button" role="radio" aria-checked={view === 'graph'} className={view === 'graph' ? 'is-active' : ''} onClick={() => setView('graph')}>Graphe</button>
            <button type="button" role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}>Liste</button>
          </div>
          <button type="button" className="kg-btn" aria-label="Zoom avant" disabled={!graph} onClick={() => setTransform(t => zoomAt(t, 1.2, size.current.w / 2, size.current.h / 2))}><ZoomIn size={14} aria-hidden="true" /></button>
          <button type="button" className="kg-btn" aria-label="Zoom arrière" disabled={!graph} onClick={() => setTransform(t => zoomAt(t, 1 / 1.2, size.current.w / 2, size.current.h / 2))}><ZoomOut size={14} aria-hidden="true" /></button>
          <button type="button" className="kg-btn" aria-label="Ajuster à la vue" disabled={!graph} onClick={() => fit()}><Maximize2 size={14} aria-hidden="true" /></button>
          <button type="button" className="kg-btn" disabled={!selectedNode || Boolean(busy)} onClick={() => selectedNode && void expand(selectedNode.id)}>
            <PlusCircle size={14} aria-hidden="true" /> Développer{selectedNode && selectedNode.hiddenEdges > 0 ? ` (+${selectedNode.hiddenEdges})` : ''}
          </button>
          <button type="button" className="kg-btn" disabled={!selectedNode || Boolean(busy)} onClick={() => selectedNode && recenter(selectedNode.id)}><Crosshair size={14} aria-hidden="true" /> Centrer</button>
          <button type="button" className="kg-btn" aria-expanded={showFilters} aria-controls="kg-filters" onClick={() => setShowFilters(s => !s)}><SlidersHorizontal size={14} aria-hidden="true" /> Filtres</button>
          {graph && <span className="kg-count" data-testid="kg-count">{graph.nodes.size} nœuds · {graph.edges.size} relations{metrics ? ` · ${metrics.lastMs} ms` : ''}</span>}
        </div>

        {showFilters && (
          <fieldset id="kg-filters" className="kg-filters">
            <legend>Filtres (appliqués par le serveur)</legend>
            <div className="kg-filter-group" role="group" aria-label="Types d’entité">
              <span className="kg-label">Types</span>
              {ENTITY_TYPES.map(t => <label key={t} className="kg-check"><input type="checkbox" checked={types.includes(t)} onChange={() => setTypes(l => toggle(l, t))} /> {typeLabel(t)}</label>)}
            </div>
            <div className="kg-filter-group" role="group" aria-label="Statuts des affirmations">
              <span className="kg-label">Statuts</span>
              {STATUSES.map(s => <label key={s} className="kg-check"><input type="checkbox" checked={statuses.includes(s)} onChange={() => setStatuses(l => (l.includes(s) && l.length === 1 ? l : toggle(l, s)))} /> {statusLabel(s)}</label>)}
            </div>
            {knownSources.length > 0 && (
              <div className="kg-filter-group" role="group" aria-label="Sources">
                <span className="kg-label">Sources</span>
                {knownSources.map(s => <label key={s.sourceId} className="kg-check"><input type="checkbox" checked={sourceIds.includes(s.sourceId)} onChange={() => setSourceIds(l => toggle(l, s.sourceId))} /> {s.name}</label>)}
              </div>
            )}
            <div className="kg-filter-group">
              <label className="kg-label" htmlFor="kg-from">Valide après</label>
              <input id="kg-from" type="date" className="kg-input kg-input--date" value={from} onChange={e => setFrom(e.target.value)} />
              <label className="kg-label" htmlFor="kg-to">avant</label>
              <input id="kg-to" type="date" className="kg-input kg-input--date" value={to} onChange={e => setTo(e.target.value)} />
              <label className="kg-check"><input type="checkbox" checked={includeUndated} onChange={e => setIncludeUndated(e.target.checked)} /> garder les affirmations sans date</label>
            </div>
          </fieldset>
        )}

        {error && <div className="studio-error" role="alert"><p className="studio-error-message">{error}</p></div>}
        {notice && <p className="kg-notice" role="status">{notice}</p>}

        <div className="kg-main">
          <section className="kg-stage" aria-label={view === 'graph' ? 'Graphe' : 'Liste des nœuds et relations'} aria-busy={Boolean(busy)}>
            {busy && <div className="kg-busy"><LoadingSpinner label={busy} /></div>}
            {!graph && !busy && <div className="studio-empty"><p className="studio-empty-message">Recherchez une entité pour afficher son voisinage (profondeur 1), puis développez les nœuds un par un.</p></div>}
            {graph && view === 'graph' && (
              <GraphCanvas graph={graph} transform={transform} onTransform={setTransform} selection={selection} focusedId={focusedId}
                onFocusNode={setFocusedId} onSelectNode={id => { setSelection({ kind: 'node', id }); void openEntity(id); }}
                onSelectEdge={id => void openEdge(id)} onExpand={id => void expand(id)} onRecenter={recenter} onFit={() => fit()} onSize={onSize} />
            )}
            {graph && view === 'list' && (
              <div className="kg-list" data-testid="kg-list">
                <table className="kg-table">
                  <caption>Nœuds ({graph.nodes.size})</caption>
                  <thead><tr><th scope="col">Entité</th><th scope="col">Type</th><th scope="col">Statut</th><th scope="col">Relations</th><th scope="col">Actions</th></tr></thead>
                  <tbody>
                    {[...graph.nodes.values()].sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label, 'fr')).map(n => (
                      <tr key={n.id} aria-selected={selection?.kind === 'node' && selection.id === n.id}>
                        <th scope="row">{n.label}{n.id === graph.centerId ? ' (centre)' : ''}</th>
                        <td>{typeLabel(n.type)}</td>
                        <td>{n.ambiguous ? <span className="kg-status kg-status--ambiguous">ambiguë</span> : n.status.toLowerCase()}</td>
                        <td>{n.shownEdges}{n.hiddenEdges ? ` (+${n.hiddenEdges} non chargées)` : ''}</td>
                        <td>
                          <button type="button" className="kg-btn kg-btn--small" onClick={() => { setFocusedId(n.id); void openEntity(n.id); }}>Détails <span className="kg-sr">de {n.label}</span></button>
                          <button type="button" className="kg-btn kg-btn--small" onClick={() => void expand(n.id)}>Développer <span className="kg-sr">{n.label}</span></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <table className="kg-table">
                  <caption>Relations ({graph.edges.size})</caption>
                  <thead><tr><th scope="col">Relation</th><th scope="col">Statut</th><th scope="col">Période</th><th scope="col">Action</th></tr></thead>
                  <tbody>
                    {[...graph.edges.values()].map(e => (
                      <tr key={e.id}>
                        <th scope="row">{describeEdge(e, graph.nodes).split(', ')[0]}</th>
                        <td>{statusLabel(e.status)}{e.contradiction ? ' · ⚠ contradiction' : ''}</td>
                        <td>{e.validFrom || e.validTo ? `${e.validFrom ?? '…'} → ${e.validTo ?? '…'}` : '—'}</td>
                        <td><button type="button" className="kg-btn kg-btn--small" onClick={() => void openEdge(e.id)}>Détails <span className="kg-sr">{e.label}</span></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {graph && view === 'graph' && (
              <ul className="kg-legend" aria-label="Légende">
                <li><span className="kg-legend-swatch kg-legend-swatch--conflict" /> contradiction</li>
                <li><span className="kg-legend-swatch kg-legend-swatch--ambiguous" /> entité ambiguë (?)</li>
                <li><span className="kg-legend-swatch kg-legend-swatch--hypothesis" /> hypothèse (modèle)</li>
                <li><span className="kg-legend-more">+N</span> relations non chargées</li>
              </ul>
            )}
          </section>

          <aside className="kg-side" aria-label="Détails">
            <div className="studio-tabs" role="tablist" aria-label="Panneau">
              <button type="button" role="tab" id="kg-tab-details" aria-selected={tab === 'details'} aria-controls="kg-panel" className={`studio-tab${tab === 'details' ? ' studio-tab--active' : ''}`} onClick={() => setTab('details')}>Détails</button>
              <button type="button" role="tab" id="kg-tab-timeline" aria-selected={tab === 'timeline'} aria-controls="kg-panel" className={`studio-tab${tab === 'timeline' ? ' studio-tab--active' : ''}`} onClick={() => setTab('timeline')} disabled={!timelineEntity}>Chronologie</button>
            </div>
            <div id="kg-panel" role="tabpanel" aria-labelledby={tab === 'details' ? 'kg-tab-details' : 'kg-tab-timeline'} className="kg-panel">
              {tab === 'details' && !details && <p className="kg-muted">Sélectionnez un nœud ou une relation.</p>}
              {tab === 'details' && details?.kind === 'entity' && <EntityDetails view={details.view} onOpenEntity={id => void openEntity(id)} onOpenClaim={id => void openClaim(id)} />}
              {tab === 'details' && details?.kind === 'claim' && <ClaimDetails view={details.view} onOpenEntity={id => void openEntity(id)} onOpenClaim={id => void openClaim(id)} onOpenSource={id => void openSource(id)} />}
              {tab === 'details' && sourcePreview && (
                <section className="kg-source-preview" aria-label="Source" data-testid="kg-source-preview">
                  <div className="kg-evidence-head"><strong>{sourcePreview.title}</strong><button type="button" className="kg-link" onClick={() => setSourcePreview(null)}>Fermer</button></div>
                  {sourcePreview.meta && <p className="kg-muted">{sourcePreview.meta}</p>}
                  {sourcePreview.warning && <p className="kg-muted" role="note">{sourcePreview.warning}</p>}
                  {sourcePreview.text && (
                    <blockquote className="kg-excerpt">
                      {sourcePreview.start !== null && sourcePreview.end !== null && sourcePreview.end <= sourcePreview.text.length
                        ? <>{sourcePreview.text.slice(0, sourcePreview.start)}<mark>{sourcePreview.text.slice(sourcePreview.start, sourcePreview.end)}</mark>{sourcePreview.text.slice(sourcePreview.end)}</>
                        : sourcePreview.text}
                    </blockquote>
                  )}
                </section>
              )}
              {tab === 'details' && details?.kind === 'relation' && <RelationDetails view={details.view} onOpenEntity={id => void openEntity(id)} />}
              {tab === 'timeline' && (timeline && timeline.entityId === timelineEntity ? <KgTimeline timeline={timeline} onOpenClaim={id => void openClaim(id)} /> : <p className="kg-muted">Chargement de la chronologie…</p>)}
            </div>
          </aside>
        </div>
        <p className="kg-sr" aria-live="polite" data-testid="kg-live">{live}</p>
      </div>
    </StudioShell>
  );
}
