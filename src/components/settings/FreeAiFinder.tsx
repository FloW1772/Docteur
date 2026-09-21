import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, ExternalLink, Lock, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { cortexClient, type FreeAiProvider } from '../../lib/cortex/client';
import { selectRecommendedFreeProviders, deriveProviderStatus, type FreeProviderStatus } from '../../lib/freeAiRecommendations';

// Free AI Finder — discovery-only assistant for public free-tier / trial-credit
// LLM API providers. This is a DISCOVERY + CONFIGURATION ASSISTANT, never an
// account/key scraper: it only fetches one fixed public catalog (backend
// route /api/free-ai/providers), never reads cookies/sessions, never
// automates signup, and never receives an API key value from the backend —
// only a `configuredInDocteur` boolean derived server-side from secret-store
// status. "Voir la documentation" only ever opens the provider's own docs_url
// in a new tab (noopener/noreferrer) — the dataset has no signup_url field,
// so this never claims to be a direct link to account/key creation; nothing
// is scraped automatically.

type FreeTypeFilter = 'perpetual-or-renewing' | 'trial' | 'all';
type ModalityFilter = 'text' | 'vision' | 'image' | 'audio' | 'embeddings';

const FREE_TYPE_LABELS: Record<string, string> = {
  perpetual: '✅ Free tier continu',
  'renewing-quota': '🔄 Crédits renouvelables',
  'recurring-credit': '🔄 Crédits renouvelables',
  'trial-credit': '🎁 Crédits d’essai',
};

const DOCTEUR_STATE_LABELS: Record<FreeAiProvider['docteurState'], { label: string; color: string }> = {
  configured:              { label: '✅ Configuré dans Docteur', color: '#3dffaa' },
  native_not_configured:   { label: '⚠ Clé manquante',           color: '#f59e0b' },
  maybe_via_freellmapi:    { label: '🔗 Potentiellement compatible via FreeLLMAPI', color: '#22d3ee' },
  not_integrated:          { label: '➕ Non intégré directement', color: '#5a4a7a' },
};

const FRESHNESS_LABELS: Record<FreeAiProvider['verificationFreshness'], string | null> = {
  fresh: null,
  aging: 'Informations potentiellement anciennes',
  recheck: 'À revérifier avant utilisation',
  unknown: null,
};

const STATUS_LABELS: Record<FreeProviderStatus, { label: string; color: string } | null> = {
  AVAILABLE: null, // no badge needed for the common case
  UNKNOWN: { label: 'État inconnu', color: '#7a6c9a' },
  STALE: { label: 'Informations anciennes', color: '#f59e0b' },
  DEPRECATED: { label: 'Probablement obsolète', color: '#ff4d58' },
  UNAVAILABLE: { label: 'Indisponible', color: '#ff4d58' },
};

function tristateLabel(value: boolean | null, yes: string, no: string): string {
  if (value === true) return yes;
  if (value === false) return no;
  return 'Inconnu';
}

function isSafeExternalUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function openDocsUrl(url: string | null) {
  if (!isSafeExternalUrl(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function ProviderCard({ p, badge }: { p: FreeAiProvider; badge?: string }) {
  const state = DOCTEUR_STATE_LABELS[p.docteurState];
  const freshnessNote = FRESHNESS_LABELS[p.verificationFreshness];
  const status = STATUS_LABELS[deriveProviderStatus(p)];
  return (
    <div className="px-3 py-3 rounded flex flex-col gap-1.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        {badge && (
          <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, color: '#c0b0e0', border: '1px solid rgba(192,176,224,0.25)', background: 'rgba(192,176,224,0.08)' }}>
            {badge}
          </span>
        )}
        <span className="font-grotesk font-semibold text-xs" style={{ color: '#f0eaff' }}>{p.name}</span>
        {p.freeType && (
          <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, background: 'rgba(61,255,170,0.1)', color: '#3dffaa', border: '1px solid rgba(61,255,170,0.2)' }}>
            {FREE_TYPE_LABELS[p.freeType] ?? '❓ Conditions à vérifier'}
          </span>
        )}
        <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, color: state.color, border: `1px solid ${state.color}40`, background: `${state.color}14` }}>
          {state.label}
        </span>
        {status && (
          <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, color: status.color, border: `1px solid ${status.color}40`, background: `${status.color}14` }}>
            {status.label}
          </span>
        )}
      </div>

      {p.freeTier && <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>{p.freeTier}</p>}

      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>
        <span>💳 Carte : {tristateLabel(p.cardRequired, 'Oui', 'Non')}</span>
        <span>📱 Téléphone : {tristateLabel(p.phoneRequired, 'Oui', 'Non')}</span>
        <span>🔌 {p.openAICompatible === true ? 'OpenAI compatible' : p.openAICompatible === false ? 'API propriétaire' : 'Compatibilité inconnue'}</span>
        {p.commercialUse !== null && <span>🏢 Usage commercial : {tristateLabel(p.commercialUse, 'Oui', 'Non')}</span>}
        {p.modalities.length > 0 && <span>🧠 {p.modalities.join(' / ')}</span>}
      </div>

      <div className="flex items-center gap-2 flex-wrap font-mono" style={{ fontSize: 9, color: '#3d3060' }}>
        <span>{p.verified ? '✅ Vérifié' : '⚠ Information communautaire'}{p.lastVerified ? ` le ${p.lastVerified}` : ''}</span>
        {freshnessNote && <span style={{ color: '#f59e0b' }}>· {freshnessNote}</span>}
      </div>

      <div className="flex items-center gap-2 pt-1 flex-wrap">
        {isSafeExternalUrl(p.docsUrl) && (
          <button type="button" onClick={() => openDocsUrl(p.docsUrl)} className="font-mono text-xs px-2.5 py-1.5 rounded flex items-center gap-1.5" style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff', cursor: 'pointer' }}>
            <ExternalLink size={10} /> Voir la documentation
          </button>
        )}
      </div>

      {p.notes && <p className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>ℹ {p.notes}</p>}
    </div>
  );
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'jamais';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'inconnu';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

export function FreeAiFinder({ strictLocalActive, alwaysShowAll, onAlwaysShowAllChange }: {
  strictLocalActive: boolean;
  // Persistent preference (router_settings.always_show_all_free_apis),
  // owned by SettingsModal so it shares the same load/save plumbing as
  // every other router setting — this component never touches SQLite
  // itself. Undefined/omitted is treated as false (mission §9 default).
  alwaysShowAll?: boolean;
  onAlwaysShowAllChange?: (value: boolean) => void;
}) {
  const [providers, setProviders] = useState<FreeAiProvider[] | null>(null);
  const [source, setSource] = useState<{ label: string; repo?: string } | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [freeTypeFilter, setFreeTypeFilter] = useState<FreeTypeFilter>('all');
  const [noCard, setNoCard] = useState(false);
  const [noPhone, setNoPhone] = useState(false);
  const [openAIOnly, setOpenAIOnly] = useState(false);
  const [modalityFilter, setModalityFilter] = useState<ModalityFilter | null>(null);
  // Temporary, session-only expansion — clicking "View all" never writes the
  // persistent preference (mission §8/§10); it only affects this render.
  const [expandedThisSession, setExpandedThisSession] = useState(false);
  const showAll = alwaysShowAll === true || expandedThisSession;

  async function load() {
    setLoading(true);
    try {
      const result = await cortexClient.getFreeAiProviders(false);
      setProviders(result.providers);
      setSource({ label: result.source, repo: result.sourceRepo });
      setFetchedAt(result.fetchedAt);
      setStale(result.stale);
      setWarning(result.warning);
    } catch (e) {
      setWarning((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const result = await cortexClient.refreshFreeAiProviders();
      if (result.ok) {
        setProviders(result.providers);
        setFetchedAt(result.fetchedAt);
        setStale(result.stale);
        setWarning(result.warning ?? null);
      } else {
        setWarning(result.error ?? 'Actualisation échouée');
      }
    } catch (e) {
      setWarning((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const allModalities = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers ?? []) for (const m of p.modalities) set.add(m);
    return Array.from(set);
  }, [providers]);

  const filtered = useMemo(() => {
    if (!providers) return [];
    const q = search.trim().toLowerCase();
    return providers
      .filter(p => {
        if (q && !p.name.toLowerCase().includes(q) && !p.id.toLowerCase().includes(q)) return false;
        if (freeTypeFilter === 'perpetual-or-renewing' && !(p.freeType === 'perpetual' || p.freeType === 'renewing-quota' || p.freeType === 'recurring-credit')) return false;
        if (freeTypeFilter === 'trial' && p.freeType !== 'trial-credit') return false;
        if (noCard && p.cardRequired !== false) return false;
        if (noPhone && p.phoneRequired !== false) return false;
        if (openAIOnly && p.openAICompatible !== true) return false;
        if (modalityFilter && !p.modalities.includes(modalityFilter)) return false;
        return true;
      })
      .sort((a, b) => {
        // Free tier continu, sans carte, OpenAI-compatible, vérification
        // récente, reste — "configured" no longer affects sort order here
        // since configured/discoverable providers are now rendered as two
        // separate lists (see configuredProviders/discoverableProviders
        // below) rather than one interleaved, sorted-to-top list.
        const rank = (p: FreeAiProvider) => {
          let r = 0;
          if (p.freeType === 'perpetual' || p.freeType === 'renewing-quota') r -= 100;
          if (p.cardRequired === false) r -= 10;
          if (p.openAICompatible === true) r -= 5;
          if (p.verificationFreshness === 'fresh') r -= 1;
          return r;
        };
        return rank(a) - rank(b);
      });
  }, [providers, search, freeTypeFilter, noCard, noPhone, openAIOnly, modalityFilter]);

  // AI-5 progressive disclosure: a small, deterministic recommended subset
  // (never DEPRECATED/UNAVAILABLE, see freeAiRecommendations.ts) computed
  // from the FULL unfiltered provider list — search/filter apply only once
  // the user has expanded to "View all", not to the recommended subset.
  const recommended = useMemo(() => selectRecommendedFreeProviders(providers ?? []), [providers]);
  const recommendedIds = useMemo(() => new Set(recommended.map(p => p.id)), [recommended]);

  // Mission requirement: a provider already configured natively in Docteur
  // must no longer appear in "À découvrir" — it moves to its own "Déjà
  // configurés" section instead of being interleaved (previously sorted
  // first but still mixed into the same list). Only computed/rendered once
  // expanded — see `showAll` gating in the render below (mission §23: the
  // full list should be lazy-rendered after user interaction).
  const configuredProviders = useMemo(() => filtered.filter(p => p.docteurState === 'configured'), [filtered]);
  const discoverableProviders = useMemo(() => filtered.filter(p => p.docteurState !== 'configured'), [filtered]);

  const counts = useMemo(() => {
    const list = providers ?? [];
    return {
      total: list.length,
      noCard: list.filter(p => p.cardRequired === false).length,
      openAICompatible: list.filter(p => p.openAICompatible === true).length,
      configured: list.filter(p => p.docteurState === 'configured').length,
    };
  }, [providers]);

  return (
    <div className="flex flex-col gap-3 px-3 py-3 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2">
        <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>
          🆓 IA gratuites
        </span>
        <button
          type="button"
          disabled={refreshing || strictLocalActive}
          onClick={refresh}
          title={strictLocalActive ? 'Désactivé en mode Strict Local' : 'Actualiser les offres'}
          className="font-mono text-xs px-2.5 py-1.5 rounded flex items-center gap-1.5 flex-shrink-0"
          style={{
            background: 'rgba(94,231,255,0.08)',
            border: '1px solid rgba(94,231,255,0.2)',
            color: refreshing || strictLocalActive ? '#3d3060' : '#5ee7ff',
            cursor: refreshing || strictLocalActive ? 'default' : 'pointer',
          }}
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          Actualiser les offres
        </button>
      </div>

      <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>
        Découvre les providers IA disposant actuellement d’un accès gratuit (free tier, crédits renouvelables ou d’essai).
        Gratuit ne signifie pas local — voir Mode Strict Local ci-dessous.
      </p>

      {strictLocalActive && (
        <div className="flex items-start gap-2 px-2.5 py-2 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
          <Lock size={12} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
          <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}>
            Strict Local actif — l’actualisation Internet du catalogue est désactivée. Les données affichées proviennent du dernier cache local{providers && providers.length === 0 ? ', et aucun cache hors ligne n’est disponible.' : '.'}
          </p>
        </div>
      )}

      {warning && !strictLocalActive && (
        <p className="font-mono" style={{ fontSize: 10, color: stale ? '#f59e0b' : '#ff4d58' }}>
          ⚠ {warning}
        </p>
      )}

      {providers && providers.length > 0 && showAll && (
        <>
          <div className="flex items-center gap-2">
            <Search size={11} style={{ color: '#3d3060', flexShrink: 0 }} />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher un provider ou une modalité…"
              aria-label="Rechercher dans les IA gratuites"
              className="font-mono w-full"
              style={{ fontSize: 11, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 4, color: '#c0b0e0', padding: '4px 8px', outline: 'none' }}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {([
              ['all', 'Tous'],
              ['perpetual-or-renewing', 'Free permanent'],
              ['trial', 'Essai'],
            ] as [FreeTypeFilter, string][]).map(([value, label]) => (
              <button key={value} type="button" onClick={() => setFreeTypeFilter(value)}
                className="font-mono px-2 py-1 rounded" style={{
                  fontSize: 9, color: freeTypeFilter === value ? '#3dffaa' : '#5a4a7a',
                  border: `1px solid ${freeTypeFilter === value ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
                }}>{label}</button>
            ))}
            <button type="button" onClick={() => setNoCard(v => !v)}
              className="font-mono px-2 py-1 rounded" style={{
                fontSize: 9, color: noCard ? '#3dffaa' : '#5a4a7a',
                border: `1px solid ${noCard ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.08)'}`,
                background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
              }}>Sans carte</button>
            <button type="button" onClick={() => setNoPhone(v => !v)}
              className="font-mono px-2 py-1 rounded" style={{
                fontSize: 9, color: noPhone ? '#3dffaa' : '#5a4a7a',
                border: `1px solid ${noPhone ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.08)'}`,
                background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
              }}>Sans téléphone</button>
            <button type="button" onClick={() => setOpenAIOnly(v => !v)}
              className="font-mono px-2 py-1 rounded" style={{
                fontSize: 9, color: openAIOnly ? '#3dffaa' : '#5a4a7a',
                border: `1px solid ${openAIOnly ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.08)'}`,
                background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
              }}>OpenAI compatible</button>
            {allModalities.map(m => (
              <button key={m} type="button" onClick={() => setModalityFilter(f => f === m ? null : m as ModalityFilter)}
                className="font-mono px-2 py-1 rounded" style={{
                  fontSize: 9, color: modalityFilter === m ? '#3dffaa' : '#5a4a7a',
                  border: `1px solid ${modalityFilter === m ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
                }}>{m}</button>
            ))}
          </div>

          <p className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>
            {counts.total} providers · {counts.noCard} sans carte · {counts.openAICompatible} compatibles OpenAI · {counts.configured} configurés dans Docteur
          </p>
        </>
      )}

      <div className="flex flex-col gap-2">
        {loading && !providers && (
          <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>Chargement du catalogue…</p>
        )}

        {providers && providers.length === 0 && !loading && (
          <div className="flex flex-col items-start gap-2 px-2.5 py-2 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
              {strictLocalActive ? 'Aucun catalogue hors ligne disponible.' : 'Impossible de charger le catalogue des offres gratuites.'}
            </p>
            {!strictLocalActive && (
              <button type="button" onClick={load} className="font-mono text-xs px-2.5 py-1.5 rounded" style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff', cursor: 'pointer' }}>
                Réessayer
              </button>
            )}
          </div>
        )}

        {providers && providers.length > 0 && !showAll && (
          <div className="flex flex-col gap-2">
            <span className="font-mono" style={{ fontSize: 10, color: '#5ee7ff', letterSpacing: '0.08em' }}>
              RECOMMENDED ({recommended.length})
            </span>
            {recommended.length === 0 && (
              <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>Aucun fournisseur recommandé pour le moment.</p>
            )}
            {recommended.map(p => <ProviderCard key={p.id} p={p} />)}
            {providers.length > recommended.length && (
              <button
                type="button"
                onClick={() => setExpandedThisSession(true)}
                className="font-mono text-xs px-2.5 py-1.5 rounded self-start flex items-center gap-1.5"
                style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff', cursor: 'pointer' }}
              >
                <ChevronRight size={11} /> View all free APIs ({providers.length})
              </button>
            )}
          </div>
        )}

        {showAll && (
          <>
            {!alwaysShowAll && (
              <button
                type="button"
                onClick={() => setExpandedThisSession(false)}
                className="font-mono text-xs px-2.5 py-1.5 rounded self-start flex items-center gap-1.5"
                style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#7a6c9a', cursor: 'pointer' }}
              >
                <ChevronDown size={11} /> Show recommended only
              </button>
            )}

            {configuredProviders.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="font-mono" style={{ fontSize: 10, color: '#3dffaa', letterSpacing: '0.08em' }}>
                  ✅ DÉJÀ CONFIGURÉS ({configuredProviders.length})
                </span>
                {configuredProviders.map(p => <ProviderCard key={p.id} p={p} badge={recommendedIds.has(p.id) ? 'Recommended' : undefined} />)}
              </div>
            )}

            {discoverableProviders.length > 0 && (
              <div className="flex flex-col gap-2" style={{ marginTop: configuredProviders.length > 0 ? 8 : 0 }}>
                {configuredProviders.length > 0 && (
                  <span className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.08em' }}>
                    🔍 À DÉCOUVRIR ({discoverableProviders.length})
                  </span>
                )}
                {discoverableProviders.map(p => <ProviderCard key={p.id} p={p} badge={recommendedIds.has(p.id) ? 'Recommended' : undefined} />)}
              </div>
            )}
          </>
        )}
      </div>

      {providers && providers.length > 0 && onAlwaysShowAllChange && (
        <label className="flex items-center gap-2 font-mono" style={{ fontSize: 10, color: '#7a6c9a', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={alwaysShowAll === true}
            onChange={e => onAlwaysShowAllChange(e.target.checked)}
          />
          Always show all free APIs
        </label>
      )}

      <p className="font-mono" style={{ fontSize: 9, color: '#2e2555' }}>
        Catalogue : {source?.repo ? (
          <button type="button" onClick={() => openDocsUrl(source.repo ?? null)} style={{ color: '#3d3060', textDecoration: 'underline', cursor: 'pointer' }}>{source.label}</button>
        ) : (source?.label ?? 'free-llm-api-hub')} — données communautaires, vérifier les conditions officielles.
        {' '}Dernière actualisation : {formatRelativeTime(fetchedAt)}.
        {' '}Les offres gratuites et leurs limites peuvent changer sans préavis.
      </p>
    </div>
  );
}
