import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { cortexClient, type LocalAiRecommendationEntry, type LocalHardwareProfile, type FitRating } from '../../lib/cortex/client';
import { buildRecommendedSubset } from '../../lib/localAiRecommendations';
import { LocalModelCard } from './LocalModelCard';
import { LocalModelDetails } from './LocalModelDetails';

function formatBytesShort(bytes: number | null): string {
  if (bytes == null) return 'Unknown';
  const gb = bytes / 1_073_741_824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1_048_576).toFixed(0)} MB`;
}

export function LocalModelsSettingsSection() {
  const [results, setResults] = useState<LocalAiRecommendationEntry[] | null>(null);
  const [hardwareProfile, setHardwareProfile] = useState<LocalHardwareProfile | null>(null);
  const [catalogStale, setCatalogStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsEntry, setDetailsEntry] = useState<LocalAiRecommendationEntry | null>(null);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [fitFilter, setFitFilter] = useState<FitRating | null>(null);
  const [refreshingHardware, setRefreshingHardware] = useState(false);
  // All Ollama models actually installed, independent of whether they're in
  // the AI-3 catalog — a model the user pulled that isn't one of the seed
  // entries must still show up as installed, never be silently hidden
  // (mission AI-6 §21). `results` alone can't answer this since it's
  // catalog-shaped by construction.
  const [allInstalledOllamaNames, setAllInstalledOllamaNames] = useState<string[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Single batched call — hardware detection and fit evaluation happen
      // once on the backend, not per card (mission §26).
      const [result, installed] = await Promise.all([
        cortexClient.localAiRecommendations(),
        cortexClient.localAiInstalled(),
      ]);
      setResults(result.results);
      setHardwareProfile(result.hardwareProfile);
      setCatalogStale(result.catalogMeta.stale);
      setAllInstalledOllamaNames(installed.installedOllamaModels);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshHardware() {
    setRefreshingHardware(true);
    try {
      // Local-only re-detection (CPU/RAM/GPU/disk) — never triggers a
      // catalog Internet refresh (mission §27).
      await cortexClient.localAiHardware(true);
      await load();
    } finally {
      setRefreshingHardware(false);
    }
  }

  const officialResults = useMemo(
    () => (results ?? []).filter(r => r.model.provenance !== 'community_modified'),
    [results],
  );
  const communityResults = useMemo(
    () => (results ?? []).filter(r => r.model.provenance === 'community_modified'),
    [results],
  );
  const installedResults = useMemo(() => (results ?? []).filter(r => r.installed), [results]);

  // Real Ollama models with no catalog match — still shown as Installed,
  // just with partial/UNKNOWN metadata instead of a full catalog card.
  const uncatalogedInstalled = useMemo(() => {
    const catalogedPullNames = new Set(
      (results ?? []).map(r => r.distribution.ollamaPullName).filter((n): n is string => !!n),
    );
    return allInstalledOllamaNames.filter(name => !catalogedPullNames.has(name));
  }, [results, allInstalledOllamaNames]);

  const recommended = useMemo(() => buildRecommendedSubset(officialResults), [officialResults]);
  const recommendedIds = useMemo(() => new Set(recommended.map(r => r.entry.distribution.id)), [recommended]);

  const exploreFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return officialResults.filter(r => {
      if (q && !r.model.name.toLowerCase().includes(q) && !r.model.publisher.toLowerCase().includes(q) && !r.model.family.toLowerCase().includes(q)) return false;
      if (fitFilter && r.fit.rating !== fitFilter) return false;
      return true;
    });
  }, [officialResults, search, fitFilter]);

  function handleInstalled() {
    setDetailsEntry(null);
    load();
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="font-mono" style={{ fontSize: 10, color: '#ff4d58' }}>⚠ {error}</p>
      )}

      {catalogStale && (
        <div className="px-2.5 py-2 rounded font-mono" style={{ fontSize: 10, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
          Catalog may be outdated.
        </div>
      )}

      {hardwareProfile && (
        <div className="flex items-center gap-2 flex-wrap font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>
          <span>{hardwareProfile.logicalCores} cores</span>
          <span>{formatBytesShort(hardwareProfile.totalRamBytes)} RAM</span>
          <span>{hardwareProfile.gpus.length > 0 ? hardwareProfile.gpus.map(g => g.name).join(', ') : 'No GPU detected'}</span>
          {hardwareProfile.freeDiskBytes != null && <span>{formatBytesShort(hardwareProfile.freeDiskBytes)} free disk</span>}
          <button type="button" onClick={refreshHardware} disabled={refreshingHardware} className="flex items-center gap-1" style={{ color: '#5ee7ff', cursor: refreshingHardware ? 'default' : 'pointer' }}>
            <RefreshCw size={9} className={refreshingHardware ? 'animate-spin' : ''} /> Refresh hardware profile
          </button>
        </div>
      )}

      {/* --- Installed --- */}
      <section className="flex flex-col gap-2">
        <span className="font-mono" style={{ fontSize: 10, color: '#3dffaa', letterSpacing: '0.08em' }}>
          INSTALLED ({installedResults.length + uncatalogedInstalled.length})
        </span>
        {loading && !results && <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>Loading…</p>}
        {results && installedResults.length === 0 && uncatalogedInstalled.length === 0 && (
          <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>No models are currently installed.</p>
        )}
        {installedResults.map(entry => (
          <LocalModelCard key={entry.distribution.id} entry={entry} onOpenDetails={() => setDetailsEntry(entry)} />
        ))}
        {uncatalogedInstalled.map(name => (
          <div key={name} className="px-3 py-2.5 rounded flex items-center gap-2" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>{name}</span>
            <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, color: '#3dffaa', border: '1px solid rgba(61,255,170,0.3)', background: 'rgba(61,255,170,0.08)' }}>INSTALLED</span>
            <span className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>Not in local catalog — metadata unknown</span>
          </div>
        ))}
      </section>

      {/* --- Recommended for this PC --- */}
      <section className="flex flex-col gap-2">
        <span className="font-mono" style={{ fontSize: 10, color: '#5ee7ff', letterSpacing: '0.08em' }}>
          RECOMMENDED FOR THIS PC ({recommended.length})
        </span>
        {results && recommended.length === 0 && (
          <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>No verified local models currently fit this machine well.</p>
        )}
        {recommended.map(({ entry, badge }) => (
          <LocalModelCard key={entry.distribution.id} entry={entry} badge={badge} onOpenDetails={() => setDetailsEntry(entry)} />
        ))}
      </section>

      {/* --- Explore all --- */}
      <section className="flex flex-col gap-2">
        <button type="button" onClick={() => setExploreOpen(v => !v)} className="flex items-center gap-1.5 font-mono" style={{ fontSize: 10, color: '#c0b0e0', cursor: 'pointer' }}>
          {exploreOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          VIEW ALL LOCAL MODELS ({officialResults.length})
        </button>
        {exploreOpen && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Search size={11} style={{ color: '#3d3060', flexShrink: 0 }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name, publisher, family…"
                aria-label="Search local models"
                className="font-mono w-full"
                style={{ fontSize: 11, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 4, color: '#c0b0e0', padding: '4px 8px', outline: 'none' }}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(['EXCELLENT', 'GOOD', 'TIGHT', 'NOT_RECOMMENDED', 'UNKNOWN'] as FitRating[]).map(f => (
                <button key={f} type="button" onClick={() => setFitFilter(v => v === f ? null : f)}
                  className="font-mono px-2 py-1 rounded" style={{
                    fontSize: 9, color: fitFilter === f ? '#3dffaa' : '#5a4a7a',
                    border: `1px solid ${fitFilter === f ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.08)'}`,
                    background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
                  }}>{f}</button>
              ))}
            </div>
            {exploreFiltered.length === 0 && (
              <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>No models match this search/filter.</p>
            )}
            {exploreFiltered.map(entry => (
              <LocalModelCard
                key={entry.distribution.id}
                entry={entry}
                badge={recommendedIds.has(entry.distribution.id) ? 'Recommended' : undefined}
                onOpenDetails={() => setDetailsEntry(entry)}
              />
            ))}
          </div>
        )}
      </section>

      {/* --- Community / unrestricted (collapsed by default) --- */}
      {communityResults.length > 0 && (
        <section className="flex flex-col gap-2">
          <button type="button" onClick={() => setCommunityOpen(v => !v)} className="flex items-center gap-1.5 font-mono" style={{ fontSize: 10, color: '#f59e0b', cursor: 'pointer' }}>
            {communityOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            COMMUNITY / UNRESTRICTED ({communityResults.length})
          </button>
          {communityOpen && (
            <div className="flex flex-col gap-2">
              <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}>
                Community-modified weights. Review provenance/license before installation.
              </p>
              {communityResults.map(entry => (
                <LocalModelCard key={entry.distribution.id} entry={entry} onOpenDetails={() => setDetailsEntry(entry)} />
              ))}
            </div>
          )}
        </section>
      )}

      {detailsEntry && (
        <LocalModelDetails entry={detailsEntry} onClose={() => setDetailsEntry(null)} onInstalled={handleInstalled} />
      )}
    </div>
  );
}
