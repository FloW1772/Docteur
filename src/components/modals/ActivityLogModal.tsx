import { useEffect, useState } from 'react';
import { X, ScrollText, CheckCircle, AlertTriangle, Trash2, Download, RefreshCw, Search } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { ActivityLogEntry } from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
}

const PAGE_SIZE = 50;

const OP_LABELS: Record<string, string> = {
  capture:                'Capture',
  capture_deep:           'Capture approfondie',
  question:               'Question',
  veille:                 'Veille',
  cv_analyze:             'Analyse CV',
  cv_rewrite:             'Réécriture CV',
  agent_run:              'Agent',
  skill_run:              'Compétence',
  corpus_import:          'Import corpus (fichiers)',
  corpus_search_capture:  'Corpus (recherche ciblée)',
  file_import:            'Import fichier',
  inbox_import:           'Import dossier surveillé',
  cloud_call:             'Appel cloud',
  privacy_block:          'Blocage confidentialité',
};

function opLabel(opType: string): string {
  return OP_LABELS[opType] ?? opType;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso; }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

export default function ActivityLogModal({ onClose }: Props) {
  const [entries, setEntries]     = useState<ActivityLogEntry[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(0);
  const [loading, setLoading]     = useState(true);
  const [opTypes, setOpTypes]     = useState<string[]>([]);
  const [filterOp, setFilterOp]   = useState('');
  const [filterResult, setFilterResult] = useState<'' | 'success' | 'failure'>('');
  const [filterFrom, setFilterFrom]     = useState('');
  const [filterTo, setFilterTo]         = useState('');
  const [search, setSearch]       = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [stats, setStats]         = useState<{ count: number; sizeBytes: number; retentionDays: number } | null>(null);
  const [retentionInput, setRetentionInput] = useState('90');
  const [status, setStatus]       = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void cortexClient.activityOpTypes().then(setOpTypes);
    void refreshStats();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(0); }, [filterOp, filterResult, filterFrom, filterTo, searchDebounced]);

  useEffect(() => {
    void fetchPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterOp, filterResult, filterFrom, filterTo, searchDebounced, page]);

  async function refreshStats() {
    try {
      const s = await cortexClient.activityStats();
      setStats(s);
      setRetentionInput(String(s.retentionDays));
    } catch { /* server offline */ }
  }

  async function fetchPage() {
    setLoading(true);
    try {
      const { rows, total: t } = await cortexClient.activityLog({
        opType: filterOp || undefined,
        result: filterResult || undefined,
        from:   filterFrom ? new Date(filterFrom).toISOString() : undefined,
        to:     filterTo   ? new Date(filterTo + 'T23:59:59').toISOString() : undefined,
        q:      searchDebounced || undefined,
        limit:  PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setEntries(rows);
      setTotal(t);
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveRetention() {
    const days = Number(retentionInput);
    if (!Number.isFinite(days) || days < 1) return;
    try {
      const result = await cortexClient.setActivityRetention(days);
      setStatus({ ok: true, message: `Rétention : ${result.retentionDays} jours${result.purged > 0 ? ` · ${result.purged} entrée(s) purgée(s)` : ''}` });
      void refreshStats();
      void fetchPage();
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    }
  }

  async function handleClear() {
    try {
      const result = await cortexClient.clearActivityLog();
      setStatus({ ok: true, message: `Journal vidé — ${result.deleted} entrée(s) supprimée(s)` });
      setConfirmClear(false);
      void refreshStats();
      void fetchPage();
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    }
  }

  async function handleExport() {
    if (!confirm('Ce fichier peut contenir des titres de vos neurones. Ne le partagez pas sans le relire.\n\nExporter le journal ?')) return;
    try {
      const data = await cortexClient.exportActivityLog();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `docteur-journal-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ ok: true, message: `${data.count} entrée(s) exportée(s)` });
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(720px, calc(100vw - 24px))',
          border: '1px solid rgba(94,231,255,0.25)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(94,231,255,0.1)' }}>
          <ScrollText size={16} style={{ color: '#5ee7ff', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Journal d'activité
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              {stats ? `${stats.count} entrée(s) · ${formatBytes(stats.sizeBytes)} · 100% local, jamais exporté avec le backup` : '…'}
            </p>
          </div>
          <button type="button" title="Fermer" style={{ color: '#5a4a7a' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Filters */}
        <div className="px-5 py-3 flex flex-wrap gap-2" style={{ borderBottom: '1px solid rgba(94,231,255,0.08)' }}>
          <div className="flex items-center gap-1.5 px-2 rounded" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <Search size={11} style={{ color: '#5a4a7a', flexShrink: 0 }} />
            <input
              type="text"
              placeholder="Recherche…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="font-mono text-xs py-1.5"
              style={{ background: 'transparent', border: 'none', color: '#c8b8e8', outline: 'none', width: 130 }}
            />
          </div>
          <select
            value={filterOp}
            onChange={e => setFilterOp(e.target.value)}
            className="font-mono text-xs px-2 py-1.5 rounded"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
          >
            <option value="">Tous types</option>
            {opTypes.map(t => <option key={t} value={t}>{opLabel(t)}</option>)}
          </select>
          <select
            value={filterResult}
            onChange={e => setFilterResult(e.target.value as '' | 'success' | 'failure')}
            className="font-mono text-xs px-2 py-1.5 rounded"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
          >
            <option value="">Succès + échecs</option>
            <option value="success">Succès uniquement</option>
            <option value="failure">Échecs uniquement</option>
          </select>
          <input
            type="date"
            value={filterFrom}
            onChange={e => setFilterFrom(e.target.value)}
            title="Depuis le"
            className="font-mono text-xs px-2 py-1.5 rounded"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
          />
          <input
            type="date"
            value={filterTo}
            onChange={e => setFilterTo(e.target.value)}
            title="Jusqu'au"
            className="font-mono text-xs px-2 py-1.5 rounded"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
          />
          <button type="button" onClick={() => { void fetchPage(); }} title="Rafraîchir" style={{ color: '#5ee7ff' }}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        {/* List */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {!loading && entries.length === 0 && (
            <p className="px-5 py-6 font-mono text-xs text-center" style={{ color: '#5a4a7a' }}>
              Aucune entrée pour ces filtres.
            </p>
          )}
          {entries.map(e => (
            <div key={e.id} className="flex items-start gap-3 px-5 py-2.5" style={{ borderTop: '1px solid rgba(94,231,255,0.05)' }}>
              {e.result === 'success'
                ? <CheckCircle size={13} style={{ color: '#3dffaa', flexShrink: 0, marginTop: 2 }} />
                : <AlertTriangle size={13} style={{ color: '#ff4d58', flexShrink: 0, marginTop: 2 }} />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs font-semibold" style={{ color: '#5ee7ff' }}>{opLabel(e.op_type)}</span>
                  <span className="font-mono text-xs truncate" style={{ color: '#c8b8e8' }}>{e.item}</span>
                </div>
                {e.reason && (
                  <p className="font-mono" style={{ color: '#ff8a90', fontSize: 10, marginTop: 2 }}>{e.reason}</p>
                )}
                <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 10, marginTop: 2 }}>
                  {formatDate(e.timestamp)}
                  {e.duration_ms !== null ? ` · ${formatDuration(e.duration_ms)}` : ''}
                  {e.model_used ? ` · ${e.model_used}` : ''}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 px-5 py-2" style={{ borderTop: '1px solid rgba(94,231,255,0.08)' }}>
            <button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)}
              className="font-mono text-xs" style={{ color: page === 0 ? '#3d3060' : '#5ee7ff', cursor: page === 0 ? 'default' : 'pointer' }}>
              ← Précédent
            </button>
            <span className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Page {page + 1}/{totalPages}</span>
            <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
              className="font-mono text-xs" style={{ color: page >= totalPages - 1 ? '#3d3060' : '#5ee7ff', cursor: page >= totalPages - 1 ? 'default' : 'pointer' }}>
              Suivant →
            </button>
          </div>
        )}

        {/* Footer: retention + clear + export */}
        <div className="px-5 py-3 flex flex-wrap items-center gap-3" style={{ borderTop: '1px solid rgba(94,231,255,0.1)' }}>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Rétention (jours)</span>
            <input
              type="number"
              min={1}
              max={365}
              value={retentionInput}
              onChange={e => setRetentionInput(e.target.value)}
              className="font-mono text-xs px-2 py-1 rounded"
              style={{ width: 60, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
            />
            <button type="button" onClick={() => { void handleSaveRetention(); }} className="font-mono text-xs" style={{ color: '#5ee7ff', cursor: 'pointer' }}>
              Appliquer
            </button>
          </div>

          <span className="flex-1" />

          <button
            type="button"
            onClick={() => { void handleExport(); }}
            className="flex items-center gap-1.5 font-mono text-xs"
            style={{ color: '#5ee7ff', cursor: 'pointer' }}
          >
            <Download size={11} /> Exporter
          </button>

          {!confirmClear ? (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 font-mono text-xs"
              style={{ color: '#ff4d58', cursor: 'pointer' }}
            >
              <Trash2 size={11} /> Vider le journal
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs" style={{ color: '#ff4d58' }}>Confirmer ?</span>
              <button type="button" onClick={() => { void handleClear(); }} className="font-mono text-xs" style={{ color: '#ff4d58', cursor: 'pointer' }}>Oui</button>
              <button type="button" onClick={() => setConfirmClear(false)} className="font-mono text-xs" style={{ color: '#5a4a7a', cursor: 'pointer' }}>Annuler</button>
            </div>
          )}
        </div>

        {status && (
          <div
            className="mx-5 mb-3 flex items-center gap-2 px-3 py-2 rounded font-mono text-xs"
            style={{
              background: status.ok ? 'rgba(61,255,170,0.08)' : 'rgba(255,77,88,0.08)',
              border: `1px solid ${status.ok ? 'rgba(61,255,170,0.2)' : 'rgba(255,77,88,0.2)'}`,
              color: status.ok ? '#3dffaa' : '#ff4d58',
            }}
          >
            {status.ok ? <CheckCircle size={12} style={{ flexShrink: 0 }} /> : <AlertTriangle size={12} style={{ flexShrink: 0 }} />}
            {status.message}
          </div>
        )}
      </div>
    </div>
  );
}
