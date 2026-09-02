import { useState, useMemo, memo, useCallback } from 'react';
import {
  Trash2, Plus, FileText, CheckSquare, Zap, BookOpen, Heart,
  Radio, RefreshCw, Video, Link, ChevronLeft, Search, X, ListVideo,
  MessageCircle, Crosshair, Home, Camera, FileUser, Mail, Briefcase, Terminal, Mountain,
  PenLine, Clapperboard,
} from 'lucide-react';
import type { Page, PageKind } from '../../lib/types';
import { KIND_META } from '../../lib/types';

const KIND_ICONS: Record<PageKind, React.ElementType> = {
  note:        FileText,
  task:        CheckSquare,
  idea:        Zap,
  reference:   BookOpen,
  memory:      Heart,
  channel:     Radio,
  video:       Video,
  link:        Link,
  playlist:    ListVideo,
  question:    MessageCircle,
  recherche:   Crosshair,
  cv:          FileUser,
  candidature: Mail,
  rapport:     Briefcase,
  prompt:      Terminal,
  corpus:      Mountain,
  'exemple-resume': PenLine,
  video_summary:    Clapperboard,
};

// Filters shown in the bar. "all" = no kind restriction.
type FilterKey = 'all' | PageKind | 'candidature_all';

const FILTER_DEFS: { key: FilterKey; label: string; always?: boolean }[] = [
  { key: 'all',             label: 'Tout',        always: true },
  { key: 'channel',         label: 'Sources',     always: true },
  { key: 'link',            label: 'Articles',    always: true },
  { key: 'video',           label: 'Vidéos' },
  { key: 'playlist',        label: 'Playlists' },
  { key: 'note',            label: 'Notes',       always: true },
  { key: 'question',        label: 'Questions',   always: true },
  { key: 'recherche',       label: 'Recherches',  always: true },
  { key: 'candidature_all', label: 'Candidature', always: true },
  { key: 'rapport',         label: 'Rapports' },
  { key: 'prompt',          label: 'Prompts' },
];

// Kinds shown in the home screen summary (ordered)
const SUMMARY_KINDS: Array<{ kind: PageKind; label: string }> = [
  { kind: 'link',      label: 'Articles' },
  { kind: 'video',     label: 'Vidéos' },
  { kind: 'note',      label: 'Notes' },
  { kind: 'playlist',  label: 'Playlists' },
  { kind: 'question',  label: 'Questions' },
  { kind: 'recherche', label: 'Recherches' },
  { kind: 'channel',   label: 'Sources' },
];

// ── Per-row helper ────────────────────────────────────────────────────────────

const FALLBACK_REASON_LABELS: Record<string, string> = {
  video_content:    '⚠ vidéo',
  article_expired:  '⚠ expiré',
  extraction_failed:'⚠ non extrait',
  no_transcript:    '⚠ sans transcript',
};

const TRANSCRIPTION_LABELS: Record<string, string> = {
  whisper_local: '🔒 Whisper local',
  whisper_groq:  '⚡ Whisper Groq',
};

function pageSubtitle(page: Page, isDrillTarget: boolean): string {
  const synCount = page.links?.length ?? 0;
  if (isDrillTarget) {
    if (page.kind === 'playlist') return synCount === 1 ? '1 vidéo' : `${synCount} vidéos`;
    return synCount === 1 ? '1 article' : `${synCount} articles`;
  }
  const ago = timeAgo(page.updatedAt);
  const fallbackReason       = page.metadata?.capture_fallback_reason as string | undefined;
  const transcriptionProvider = page.metadata?.transcription_provider as string | undefined;
  if (fallbackReason) {
    const label = FALLBACK_REASON_LABELS[fallbackReason] ?? `⚠ ${fallbackReason}`;
    return `${ago} · ${label}`;
  }
  if (transcriptionProvider) {
    const label = TRANSCRIPTION_LABELS[transcriptionProvider] ?? transcriptionProvider;
    return `${ago} · ${label}`;
  }
  if (synCount === 0) return ago;
  return `${ago} · ${synCount === 1 ? '1 synapse' : `${synCount} synapses`}`;
}

interface RowProps {
  page:           Page;
  isSelected:     boolean;
  isHovered:      boolean;
  isDrillTarget:  boolean;
  onHoverEnter:   (id: string) => void;
  onHoverLeave:   () => void;
  onClick:        (page: Page) => void;
  onDelete:       (e: React.MouseEvent, id: string) => void;
}

const PageRow = memo(function PageRow({ page, isSelected, isHovered, isDrillTarget, onHoverEnter, onHoverLeave, onClick, onDelete }: RowProps) {
  const meta        = KIND_META[page.kind];
  const Icon        = KIND_ICONS[page.kind];
  const sub         = pageSubtitle(page, isDrillTarget);
  const hasFallback    = !isDrillTarget && !!page.metadata?.capture_fallback_reason;
  const hasTranscript  = !isDrillTarget && !!page.metadata?.transcription_provider;
  const border         = isSelected ? meta.color : isHovered ? '#5ee7ff' : 'transparent';
  const bg             = isSelected ? `rgba(${hexToRgb(meta.color)}, 0.08)` : isHovered ? 'rgba(61,255,170,0.05)' : 'transparent';

  return (
    <div
      className="sidebar-item neuron-list-item relative flex items-center gap-2 px-3 py-2 cursor-pointer transition-all"
      style={{ borderLeft: `2px solid ${border}`, background: bg }}
      onClick={() => onClick(page)}
      onMouseEnter={() => onHoverEnter(page.id)}
      onMouseLeave={onHoverLeave}
    >
      <Icon size={13} style={{ color: meta.color, flexShrink: 0, opacity: isSelected ? 1 : 0.7 }} />

      <div className="flex-1 min-w-0">
        <p className="sidebar-item-title font-mono text-xs truncate" style={{ color: isSelected ? '#f0eaff' : '#c0b0e0' }}>
          {page.title || 'Sans titre'}
        </p>
        <p className="font-mono text-xs" style={{ color: isDrillTarget ? '#ff8b3d88' : hasFallback ? '#ff8b3d' : hasTranscript ? '#a78bfa' : '#5ee7ff', fontSize: 10 }}>
          {sub}
        </p>
      </div>

      {isDrillTarget && isHovered && (
        <ChevronLeft size={11} style={{ color: '#ff8b3d', flexShrink: 0, transform: 'rotate(180deg)' }} />
      )}

      {isHovered && !isDrillTarget && (
        <button
          type="button"
          className="flex-shrink-0 p-1 rounded transition-colors"
          style={{ color: '#7060a0' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#ff4dcb')}
          onMouseLeave={e => (e.currentTarget.style.color = '#7060a0')}
          onClick={e => onDelete(e, page.id)}
          title="Supprimer"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min  = Math.floor(diff / 60000);
  const hr   = Math.floor(diff / 3600000);
  const day  = Math.floor(diff / 86400000);
  if (min < 1)  return 'à l\'instant';
  if (min < 60) return `${min}m`;
  if (hr  < 24) return `${hr}h`;
  return `${day}j`;
}

interface Props {
  pages:              Page[];
  selectedPageId:     string | null;
  loading:            boolean;
  cortexAvailable:    boolean;
  onSelectPage:       (id: string) => void;
  onNewPage:          (kind?: PageKind) => void;
  onDeletePage:       (id: string) => void;
  onRequestReindex:   () => void;
  showHomeScreen:     boolean;
  onToggleHomeScreen: (show: boolean) => void;
  onCaptureOpen:      () => void;
  onSearchOpen:       () => void;
  pageCounts?:        { total: number; byKind: Record<string, number> };
  allMetaLoaded?:     boolean;
  onLoadAllPages?:    () => void;
}

function Sidebar({
  pages, selectedPageId, loading, cortexAvailable,
  onSelectPage, onNewPage, onDeletePage, onRequestReindex,
  showHomeScreen, onToggleHomeScreen, onCaptureOpen, onSearchOpen,
  pageCounts, allMetaLoaded, onLoadAllPages,
}: Props) {
  const [hoveredId,    setHoveredId]    = useState<string | null>(null);
  const [showKindMenu, setShowKindMenu] = useState(false);
  const [filter,       setFilter]       = useState<FilterKey>('all');
  const [drilldownId,  setDrilldownId]  = useState<string | null>(null);
  const [search,       setSearch]       = useState('');

  // Count pages by kind for filter badges
  const counts = useMemo(() => {
    const c: Partial<Record<FilterKey, number>> = { all: pages.length };
    for (const p of pages) {
      c[p.kind] = (c[p.kind] ?? 0) + 1;
    }
    c['candidature_all'] = (c['cv'] ?? 0) + (c['candidature'] ?? 0);
    return c;
  }, [pages]);

  // Recent neurons for home screen (sorted by updatedAt desc, top 8)
  const recentPages = useMemo(() =>
    [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8),
  [pages]);

  // Drilldown channel info
  const drilldownPage = drilldownId ? pages.find(p => p.id === drilldownId) : null;
  const drilldownChildren = useMemo(() => {
    if (!drilldownId) return [];
    return pages.filter(p => p.id !== drilldownId && (p.links ?? []).includes(drilldownId));
  }, [pages, drilldownId]);

  // Filtered + searched list
  const visiblePages = useMemo(() => {
    let list: Page[];
    if (drilldownId) {
      list = drilldownChildren;
    } else if (filter === 'all') {
      list = pages;
    } else if (filter === 'candidature_all') {
      list = pages.filter(p => p.kind === 'cv' || p.kind === 'candidature');
    } else {
      list = pages.filter(p => p.kind === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(p => (p.title || '').toLowerCase().includes(q));
    }
    // Prompt filter: templates first, then by date
    if (filter === 'prompt') {
      list = [...list].sort((a, b) => {
        const at = a.metadata?.template ? 1 : 0;
        const bt = b.metadata?.template ? 1 : 0;
        if (bt !== at) return bt - at;
        return b.updatedAt - a.updatedAt;
      });
    }
    return list;
  }, [pages, filter, drilldownId, drilldownChildren, search]);

  function handleFilterClick(key: FilterKey) {
    setFilter(key);
    setDrilldownId(null);
    setSearch('');
  }

  // Stable callbacks passed to memoized PageRow — created once, never recreated.
  const handleRowHoverEnter = useCallback((id: string) => setHoveredId(id), []);
  const handleRowHoverLeave = useCallback(() => setHoveredId(null), []);
  const handleRowDelete     = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onDeletePage(id);
  }, [onDeletePage]);
  const handleRowClick      = useCallback((page: Page) => {
    if ((filter === 'channel' || filter === 'playlist') && !drilldownId && page.kind === filter) {
      setDrilldownId(page.id);
      onSelectPage(page.id);
      return;
    }
    onSelectPage(page.id);
  }, [filter, drilldownId, onSelectPage]);

  // Visible filter buttons: always-shown ones + optional ones that have pages
  const visibleFilters = FILTER_DEFS.filter(f =>
    f.always || (counts[f.key] ?? 0) > 0,
  );

  // Use server-provided total if available (accurate even with lazy loading), else fall back to loaded count
  const total = pageCounts?.total || pages.length;
  // Per-kind counts: prefer server counts for home screen, computed for filter bar
  const serverKindCounts = pageCounts?.byKind ?? {};

  return (
    <aside className="glass sidebar-hud flex flex-col">

      {/* ── Fixed header ───────────────────────────────────────────────────── */}
      <div className="flex-shrink-0">

        {/* New neuron button — always visible */}
        <div className="p-3 pb-2">
          <div className="relative">
            <button
              type="button"
              className="btn-emerald w-full flex items-center justify-center gap-2 sidebar-action"
              onClick={() => setShowKindMenu(v => !v)}
            >
              <Plus size={13} />
              Nouveau neurone
            </button>

            {showKindMenu && (
              <div className="sidebar-menu absolute top-full left-0 right-0 mt-2 overflow-hidden z-50">
                {(Object.keys(KIND_META) as PageKind[]).map(kind => {
                  const meta = KIND_META[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                      style={{ color: '#e8d9ff', fontSize: 12, fontFamily: 'IBM Plex Mono, monospace' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(61,255,170,0.05)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => { setShowKindMenu(false); onNewPage(kind); }}
                    >
                      <span style={{ color: meta.color }}>{meta.icon}</span>
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Full list mode: back to home + filters + drilldown + search */}
        {!showHomeScreen && (
          <>
            {/* Back to home */}
            <div
              className="px-3 pb-2 flex items-center gap-1.5"
              style={{ borderBottom: '1px solid rgba(61,255,170,0.06)' }}
            >
              <button
                type="button"
                className="flex items-center gap-1.5 font-mono transition-colors w-full"
                style={{ fontSize: 9, color: '#5a4a7a', letterSpacing: '0.08em' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#3dffaa')}
                onMouseLeave={e => (e.currentTarget.style.color = '#5a4a7a')}
                onClick={() => onToggleHomeScreen(true)}
              >
                <Home size={9} />
                ACCUEIL
              </button>
            </div>

            {/* Filter bar */}
            <div
              className="flex flex-wrap gap-1 px-3 pb-2 pt-2"
              style={{ borderBottom: '1px solid rgba(61,255,170,0.06)' }}
            >
              {visibleFilters.map(f => {
                const active  = filter === f.key && !drilldownId;
                const count   = counts[f.key] ?? 0;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => handleFilterClick(f.key)}
                    className="font-mono flex items-center gap-1 rounded px-1.5 py-0.5 transition-all"
                    style={{
                      fontSize:    9,
                      letterSpacing: '0.06em',
                      background:  active ? 'rgba(61,255,170,0.14)' : 'rgba(255,255,255,0.04)',
                      border:      `1px solid ${active ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.07)'}`,
                      color:       active ? '#3dffaa' : '#7a6c9a',
                      cursor:      'pointer',
                      whiteSpace:  'nowrap',
                    }}
                  >
                    {f.label}
                    {f.key !== 'all' && (
                      <span style={{ color: active ? '#3dffaa99' : '#3d3060', fontSize: 8 }}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Drilldown header */}
            {drilldownId && drilldownPage && (
              <div
                className="flex items-center gap-2 px-3 py-2"
                style={{ borderBottom: '1px solid rgba(61,255,170,0.06)', background: 'rgba(255,139,61,0.06)' }}
              >
                <button
                  type="button"
                  onClick={() => { setDrilldownId(null); }}
                  className="flex-shrink-0 p-0.5 rounded"
                  style={{ color: '#ff8b3d' }}
                  title="Retour aux sources"
                >
                  <ChevronLeft size={13} />
                </button>
                <div className="min-w-0">
                  <p className="font-mono text-xs truncate" style={{ color: '#ff8b3d', fontSize: 10 }}>
                    {drilldownPage.title}
                  </p>
                  <p className="font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>
                    {drilldownPage.kind === 'playlist'
                      ? `${drilldownChildren.length} vidéo${drilldownChildren.length !== 1 ? 's' : ''}`
                      : `${drilldownChildren.length} lien${drilldownChildren.length !== 1 ? 's' : ''}`}
                  </p>
                </div>
              </div>
            )}

            {/* Search field */}
            <div className="px-3 py-2" style={{ borderBottom: '1px solid rgba(61,255,170,0.06)' }}>
              <div className="flex items-center gap-1.5" style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 6,
                padding: '4px 8px',
              }}>
                <Search size={10} style={{ color: '#5a4a7a', flexShrink: 0 }} />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Filtrer par titre…"
                  className="flex-1 bg-transparent outline-none font-mono"
                  style={{ fontSize: 10, color: '#c0b0e0', minWidth: 0 }}
                />
                {search && (
                  <button
                    type="button"
                    title="Effacer la recherche"
                    aria-label="Effacer la recherche"
                    onClick={() => setSearch('')}
                    style={{ color: '#5a4a7a' }}
                  >
                    <X size={9} />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      {showHomeScreen ? (

        /* ── Home screen ──────────────────────────────────────────────────── */
        <div className="flex-1 overflow-y-auto" style={{ padding: '12px 0' }}>

          {/* CORTEX summary */}
          <div className="px-3 mb-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono" style={{ fontSize: 9, letterSpacing: '0.12em', color: '#3d3060' }}>
                CORTEX
              </span>
              <div style={{ flex: 1, height: 1, background: 'rgba(61,255,170,0.08)' }} />
            </div>

            {loading ? (
              <div className="flex justify-center py-2">
                <div className="neural-dot" />
              </div>
            ) : (
              <>
                {/* Total + sync indicator */}
                <div className="flex items-center gap-2 mb-2">
                  <p className="font-mono" style={{ fontSize: 13, color: '#3dffaa', fontWeight: 600 }}>
                    {total.toLocaleString('fr')}
                    <span style={{ fontSize: 9, color: '#3d3060', fontWeight: 400, marginLeft: 6 }}>
                      neurone{total !== 1 ? 's' : ''}
                    </span>
                  </p>
                  {!allMetaLoaded && pages.length > 0 && (
                    <span
                      className="font-mono"
                      style={{ fontSize: 8, color: '#3d3060', letterSpacing: '0.06em' }}
                      title="Synchronisation en cours — le cortex est disponible, tout le contenu sera accessible hors-ligne"
                    >
                      synchro…
                    </span>
                  )}
                </div>

                {/* Kind breakdown — 2 columns */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '3px 8px',
                }}>
                  {SUMMARY_KINDS.map(({ kind, label }) => {
                    const n = serverKindCounts[kind] ?? counts[kind] ?? 0;
                    if (n === 0) return null;
                    const color = KIND_META[kind].color;
                    return (
                      <button
                        key={kind}
                        type="button"
                        className="flex items-center gap-1.5 font-mono text-left rounded px-1 py-0.5 transition-all"
                        style={{ fontSize: 9, color: '#7a6c9a' }}
                        onMouseEnter={e => (e.currentTarget.style.color = color)}
                        onMouseLeave={e => (e.currentTarget.style.color = '#7a6c9a')}
                        onClick={() => {
                          onToggleHomeScreen(false);
                          setFilter(kind);
                          setDrilldownId(null);
                          setSearch('');
                        }}
                        title={`Voir tous les ${label.toLowerCase()}`}
                      >
                        <span style={{ color, opacity: 0.7, fontSize: 8 }}>◆</span>
                        <span className="flex-1 truncate">{label}</span>
                        <span style={{ color: '#3d3060', minWidth: 20, textAlign: 'right' }}>{n}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* RÉCENTS */}
          {!loading && recentPages.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-2 px-3 mb-1">
                <span className="font-mono" style={{ fontSize: 9, letterSpacing: '0.12em', color: '#3d3060' }}>
                  RÉCENTS
                </span>
                <div style={{ flex: 1, height: 1, background: 'rgba(61,255,170,0.08)' }} />
              </div>
              {recentPages.map(page => (
                <PageRow
                  key={page.id}
                  page={page}
                  isSelected={page.id === selectedPageId}
                  isHovered={page.id === hoveredId}
                  isDrillTarget={false}
                  onHoverEnter={handleRowHoverEnter}
                  onHoverLeave={handleRowHoverLeave}
                  onClick={handleRowClick}
                  onDelete={handleRowDelete}
                />
              ))}
            </div>
          )}

          {/* ACTIONS */}
          <div className="px-3 mb-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono" style={{ fontSize: 9, letterSpacing: '0.12em', color: '#3d3060' }}>
                ACTIONS
              </span>
              <div style={{ flex: 1, height: 1, background: 'rgba(61,255,170,0.08)' }} />
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 rounded font-mono text-left transition-colors"
                style={{
                  fontSize: 10,
                  background: 'rgba(94,231,255,0.06)',
                  border: '1px solid rgba(94,231,255,0.12)',
                  color: '#5ee7ff',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(94,231,255,0.12)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(94,231,255,0.06)')}
                onClick={onSearchOpen}
              >
                <Search size={11} />
                Rechercher
                <span style={{ marginLeft: 'auto', fontSize: 9, opacity: 0.5 }}>Ctrl+L</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 rounded font-mono text-left transition-colors"
                style={{
                  fontSize: 10,
                  background: 'rgba(61,255,170,0.06)',
                  border: '1px solid rgba(61,255,170,0.12)',
                  color: '#3dffaa',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(61,255,170,0.12)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(61,255,170,0.06)')}
                onClick={onCaptureOpen}
              >
                <Camera size={11} />
                Capturer
              </button>
            </div>
          </div>

          {/* TOUS LES NEURONES */}
          <div className="px-3">
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded font-mono transition-colors"
              style={{
                fontSize: 10,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#7a6c9a',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(167,139,250,0.08)';
                e.currentTarget.style.color = '#a78bfa';
                e.currentTarget.style.borderColor = 'rgba(167,139,250,0.2)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                e.currentTarget.style.color = '#7a6c9a';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
              }}
              onClick={() => {
                if (!allMetaLoaded && onLoadAllPages) onLoadAllPages();
                onToggleHomeScreen(false);
              }}
            >
              <span>Tous les neurones</span>
              <span style={{ fontSize: 9, opacity: 0.6 }}>
                {allMetaLoaded ? total : `${pages.length} / ${total}`} →
              </span>
            </button>
          </div>
        </div>

      ) : (

        /* ── Scrollable full list (unchanged behavior) ─────────────────────── */
        <div className="sidebar-list flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="flex items-center justify-center h-20">
              <div className="neural-dot" />
            </div>
          ) : visiblePages.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>
                {search ? 'Aucun résultat' : 'Aucun neurone'}
              </p>
            </div>
          ) : (
            visiblePages.map(page => {
              const isDrillTarget = (filter === 'channel' || filter === 'playlist') && drilldownId === null && page.kind === filter;
              return (
                <PageRow
                  key={page.id}
                  page={page}
                  isSelected={page.id === selectedPageId}
                  isHovered={page.id === hoveredId}
                  isDrillTarget={isDrillTarget}
                  onHoverEnter={handleRowHoverEnter}
                  onHoverLeave={handleRowHoverLeave}
                  onClick={handleRowClick}
                  onDelete={handleRowDelete}
                />
              );
            })
          )}
        </div>

      )}

      {/* ── Prompt stats footer (shown when filter = 'prompt') ────────────── */}
      {filter === 'prompt' && (
        <PromptStats pages={visiblePages} allPrompts={pages.filter(p => p.kind === 'prompt')} />
      )}

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-3 py-2" style={{ borderTop: '1px solid rgba(61,255,170,0.08)' }}>
        <button
          className="w-full flex items-center justify-center gap-2 font-mono transition-colors"
          style={{
            fontSize:      10,
            letterSpacing: '0.12em',
            color:         cortexAvailable ? '#3d3060' : '#2a2040',
            padding:       '5px 0',
            cursor:        cortexAvailable ? 'pointer' : 'not-allowed',
            opacity:       cortexAvailable ? 1 : 0.4,
          }}
          onMouseEnter={e => { if (cortexAvailable) e.currentTarget.style.color = '#5ee7ff'; }}
          onMouseLeave={e => { e.currentTarget.style.color = cortexAvailable ? '#3d3060' : '#2a2040'; }}
          onClick={cortexAvailable ? onRequestReindex : undefined}
          title={cortexAvailable ? 'Ré-indexer tous les neurones dans le cortex cognitif' : 'Serveur cognitif hors ligne'}
          disabled={!cortexAvailable}
        >
          <RefreshCw size={10} />
          RÉINDEXER
        </button>
      </div>
    </aside>
  );
}

// ── Prompt stats mini-panel ────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'copilot':     'Copilot',
  'cline':       'Cline',
  'aider':       'Aider',
};

function PromptStats({ pages, allPrompts }: { pages: Page[]; allPrompts: Page[] }) {
  const total    = allPrompts.length;
  const templates = allPrompts.filter(p => p.metadata?.template).length;
  const ok       = allPrompts.filter(p => p.metadata?.resultat === 'ok').length;
  const rate     = total > 0 ? Math.round((ok / total) * 100) : 0;

  const byCounts: Record<string, number> = {};
  for (const p of allPrompts) {
    const t = (p.metadata?.outil as string | undefined) ?? '';
    if (t) byCounts[t] = (byCounts[t] ?? 0) + 1;
  }
  const byTool = Object.entries(byCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex-shrink-0 px-3 py-2 font-mono" style={{ borderTop: '1px solid rgba(52,211,153,0.1)', fontSize: 9, color: '#2a4a3a', letterSpacing: '0.08em' }}>
      <div style={{ color: '#34d399', marginBottom: 4, letterSpacing: '0.14em' }}>PROMPTS — {pages.length} affiché{pages.length > 1 ? 's' : ''}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span>total: {total}</span>
        {templates > 0 && <span style={{ color: '#34d399' }}>modèles: {templates}</span>}
        {total > 0 && <span style={{ color: ok > 0 ? '#34d399' : '#4a3a6a' }}>succès: {rate}%</span>}
      </div>
      {byTool.length > 0 && (
        <div style={{ marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {byTool.map(([t, n]) => (
            <span key={t}>{TOOL_LABELS[t] ?? t}: {n}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// Sidebar only needs to re-render when pages structure changes (count, ids, titles, kinds,
// updatedAt, link count) — not when block content changes during typing.
export default memo(Sidebar, (prev, next) => {
  if (prev.selectedPageId   !== next.selectedPageId)   return false;
  if (prev.loading          !== next.loading)           return false;
  if (prev.cortexAvailable  !== next.cortexAvailable)   return false;
  if (prev.showHomeScreen   !== next.showHomeScreen)    return false;
  if (prev.pages.length     !== next.pages.length)      return false;
  for (let i = 0; i < next.pages.length; i++) {
    const p = prev.pages[i], n = next.pages[i];
    if (!p || p.id !== n.id || p.title !== n.title || p.kind !== n.kind ||
        p.updatedAt !== n.updatedAt || (p.links?.length ?? 0) !== (n.links?.length ?? 0)) return false;
  }
  return true;
});

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}
