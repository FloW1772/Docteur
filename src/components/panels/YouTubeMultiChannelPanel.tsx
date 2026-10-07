import { useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Minus, Plus, RotateCcw, X } from 'lucide-react';
import type { PlaylistVideo, YouTubeChannelBatch, YouTubeChannelJob, YouTubeChannelJobResult } from '../../lib/cortex/client';
import {
  JOB_STATUS_COLOR, JOB_STATUS_LABEL, batchHeadline, batchProgress, batchSummaryText, batchTone, canCancelJob, canImportJob,
  canRetryJob, jobDetail, jobLabel, jobPhasesText, queueErrorText,
} from '../../lib/youtube/multi-channel';

// Persistent panel of a multi-channel YouTube discovery (one row per pasted line). Like YouTubeDiscoveryPanel it lives
// outside the capture modal; the queue itself runs on the server, so closing / reducing this panel never stops it.
const RESULTS_PAGE = 50; // display paging only: every discovered item stays reachable with "Afficher plus"

const TONE_ACCENT = { active: '#a78bfa', success: '#3dffaa', partial: '#3dffaa', failed: '#ff4d58', cancelled: '#9f8fbf' } as const;

const smallButton = (color: string): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 5, cursor: 'pointer',
  background: `${color}1a`, border: `1px solid ${color}4d`, color, fontSize: 11,
});

interface ResultState { loading: boolean; error: string | null; result: YouTubeChannelJobResult | null; shown: number }

export default function YouTubeMultiChannelPanel({
  batch, lost, importedJobIds, bottomOffset = 16,
  onCancelJob, onRetryJob, onCancelAll, onImport, onClose, loadItems,
}: {
  batch: YouTubeChannelBatch;
  /** connection / server-restart message; the last known state stays visible */
  lost: string | null;
  importedJobIds: ReadonlySet<string>;
  bottomOffset?: number;
  onCancelJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
  onCancelAll: () => void;
  onImport: (jobIds: string[]) => void;
  onClose: () => void;
  loadItems: (jobId: string) => Promise<YouTubeChannelJobResult>;
}) {
  const [reduced, setReduced] = useState(false);
  const [open, setOpen] = useState<Record<string, ResultState>>({});
  const s = batch.summary;
  const tone = batchTone(s);
  const accent = TONE_ACCENT[tone];
  const interactive = !lost;
  const importable = batch.jobs.filter(job => canImportJob(job) && !importedJobIds.has(job.id));

  async function toggleResults(job: YouTubeChannelJob): Promise<void> {
    if (open[job.id]) {
      setOpen(prev => { const next = { ...prev }; delete next[job.id]; return next; });
      return;
    }
    setOpen(prev => ({ ...prev, [job.id]: { loading: true, error: null, result: null, shown: RESULTS_PAGE } }));
    try {
      const result = await loadItems(job.id);
      setOpen(prev => (prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id], loading: false, result } } : prev));
    } catch (err) {
      setOpen(prev => (prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id], loading: false, error: queueErrorText(err) } } : prev));
    }
  }

  const showMore = (jobId: string) => setOpen(prev => (prev[jobId] ? { ...prev, [jobId]: { ...prev[jobId], shown: prev[jobId].shown + RESULTS_PAGE } } : prev));

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="yt-multi-panel"
      data-active={s.active ? 'true' : 'false'}
      data-tone={tone}
      style={{
        position: 'fixed', right: 16, bottom: bottomOffset, zIndex: 9000, width: 'min(440px, calc(100vw - 32px))',
        maxHeight: reduced ? undefined : 'min(72vh, 640px)', display: 'flex', flexDirection: 'column',
        padding: 14, borderRadius: 12, background: 'rgba(12, 9, 22, 0.96)', backdropFilter: 'blur(14px)',
        border: `1px solid ${accent}55`, boxShadow: '0 20px 60px rgba(0,0,0,0.55)', color: '#e6dcff',
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        {s.active
          ? <Loader2 size={15} className="animate-spin" style={{ color: accent, flexShrink: 0 }} />
          : <span style={{ width: 8, height: 8, borderRadius: 99, background: accent, flexShrink: 0 }} />}
        <span className="font-grotesk font-semibold text-sm" style={{ flex: 1 }}>Découverte YouTube — plusieurs chaînes</span>
        <button type="button" aria-label={reduced ? 'Agrandir le panneau' : 'Réduire le panneau'} data-testid="yt-multi-reduce"
          onClick={() => setReduced(r => !r)} style={{ background: 'none', border: 'none', color: '#9f8fbf', cursor: 'pointer', padding: 2 }}>
          {reduced ? <Plus size={14} /> : <Minus size={14} />}
        </button>
        {(!s.active || lost) && (
          <button type="button" aria-label="Fermer la découverte multi-chaînes" data-testid="yt-multi-close" onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#9f8fbf', cursor: 'pointer', padding: 2 }}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="font-mono text-xs" data-testid="yt-multi-headline" style={{ color: accent, lineHeight: 1.5 }}>{batchHeadline(batch)}</div>
      <div className="font-mono text-xs mt-1" data-testid="yt-multi-summary" style={{ color: '#9f8fbf', lineHeight: 1.5 }}>{batchSummaryText(s)}</div>
      <div style={{ height: 4, borderRadius: 4, background: 'rgba(167,139,250,0.12)', marginTop: 6, overflow: 'hidden' }}>
        <div data-testid="yt-multi-progress" style={{ height: '100%', width: `${Math.round(batchProgress(s) * 100)}%`, background: accent, transition: 'width 300ms ease' }} />
      </div>
      {lost && <div className="font-mono text-xs mt-2" data-testid="yt-multi-lost" style={{ color: '#ffb84d' }}>{lost}</div>}

      {!reduced && (
        <ul data-testid="yt-multi-jobs" style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {batch.jobs.map(job => {
            const color = JOB_STATUS_COLOR[job.status];
            const phases = job.status === 'RUNNING' || job.status === 'COMPLETED' ? jobPhasesText(job) : null;
            const results = open[job.id];
            const imported = importedJobIds.has(job.id);
            return (
              <li key={job.id} data-testid="yt-multi-job" data-job-status={job.status} data-line={job.index + 1}
                style={{ padding: '8px 0', borderTop: '1px solid rgba(167,139,250,0.1)' }}>
                <div className="flex items-center gap-2">
                  {job.status === 'RUNNING'
                    ? <Loader2 size={11} className="animate-spin" style={{ color, flexShrink: 0 }} />
                    : <span style={{ width: 7, height: 7, borderRadius: 99, background: color, flexShrink: 0 }} />}
                  <span className="font-mono text-xs" title={job.normalizedUrl ?? job.input}
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e6dcff' }}>
                    <span style={{ color: '#7a6c9a' }}>{job.index + 1}.</span> {jobLabel(job)}
                  </span>
                  <span className="font-mono" data-testid="yt-multi-job-status" style={{ fontSize: 10, color, flexShrink: 0 }}>{JOB_STATUS_LABEL[job.status]}</span>
                </div>
                {job.channelName && <div className="font-mono" style={{ fontSize: 10, color: '#7a6c9a', marginLeft: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.normalizedUrl ?? job.input}</div>}
                <div className="font-mono text-xs" data-testid="yt-multi-job-detail"
                  style={{ marginLeft: 15, color: job.status === 'FAILED' ? '#ff8a92' : '#9f8fbf', lineHeight: 1.5, wordBreak: 'break-word' }}>
                  {jobDetail(job)}
                </div>
                {phases && <div className="font-mono" style={{ fontSize: 10, marginLeft: 15, color: '#7a6c9a' }}>{phases}</div>}

                <div className="flex flex-wrap gap-1 font-mono" style={{ marginLeft: 15, marginTop: 4 }}>
                  {interactive && canCancelJob(job) && (
                    <button type="button" data-testid="yt-multi-job-cancel" aria-label={`Annuler la chaîne ligne ${job.index + 1}`}
                      onClick={() => onCancelJob(job.id)} style={smallButton('#ff4d58')}><X size={10} /> Annuler</button>
                  )}
                  {interactive && canRetryJob(job) && (
                    <button type="button" data-testid="yt-multi-job-retry" aria-label={`Relancer la chaîne ligne ${job.index + 1}`}
                      onClick={() => onRetryJob(job.id)} style={smallButton('#a78bfa')}><RotateCcw size={10} /> Relancer</button>
                  )}
                  {job.status === 'COMPLETED' && job.itemsFound > 0 && (
                    <button type="button" data-testid="yt-multi-job-results" aria-expanded={Boolean(results)}
                      onClick={() => { void toggleResults(job); }} style={smallButton('#c4b5fd')}>
                      {results ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Résultats
                    </button>
                  )}
                  {canImportJob(job) && (
                    <button type="button" data-testid="yt-multi-job-import" disabled={imported}
                      onClick={() => onImport([job.id])} style={{ ...smallButton('#3dffaa'), opacity: imported ? 0.5 : 1, cursor: imported ? 'default' : 'pointer' }}>
                      <Download size={10} /> {imported ? 'Importée' : 'Importer'}
                    </button>
                  )}
                </div>

                {results && (
                  <div data-testid="yt-multi-job-items" style={{ marginLeft: 15, marginTop: 6 }}>
                    {results.loading && <div className="font-mono text-xs" style={{ color: '#9f8fbf' }}>Chargement…</div>}
                    {results.error && <div className="font-mono text-xs" style={{ color: '#ff8a92' }}>{results.error}</div>}
                    {results.result && (
                      <ResultList items={results.result.items} shown={results.shown} onMore={() => showMore(job.id)} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {interactive && (s.active || importable.length > 0) && (
        <div className="flex gap-2 mt-3 font-mono text-xs">
          {s.active && (
            <button type="button" data-testid="yt-multi-cancel-all" aria-label="Annuler toutes les chaînes en cours ou en attente" onClick={onCancelAll}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 6, background: 'rgba(255,77,88,0.1)', border: '1px solid rgba(255,77,88,0.3)', color: '#ff4d58', cursor: 'pointer' }}>
              Annuler tout
            </button>
          )}
          {importable.length > 0 && (
            <button type="button" data-testid="yt-multi-import-all" onClick={() => onImport(importable.map(job => job.id))}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 6, background: 'rgba(61,255,170,0.08)', border: '1px solid rgba(61,255,170,0.3)', color: '#3dffaa', cursor: 'pointer' }}>
              Importer {importable.length > 1 ? `les ${importable.length} chaînes` : 'la chaîne'} terminée{importable.length > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ResultList({ items, shown, onMore }: { items: PlaylistVideo[]; shown: number; onMore: () => void }) {
  const visible = items.slice(0, shown);
  return (
    <>
      <ol className="font-mono" style={{ fontSize: 11, color: '#c4b5fd', margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
        {visible.map(item => (
          <li key={item.id} title={item.url} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.mediaType && item.mediaType !== 'VIDEO' && <span style={{ color: '#7a6c9a' }}>[{item.mediaType === 'SHORT' ? 'Short' : 'Stream'}] </span>}
            {item.title || item.url}
          </li>
        ))}
      </ol>
      {items.length > shown && (
        <button type="button" data-testid="yt-multi-job-more" onClick={onMore} className="font-mono" style={{ ...smallButton('#9f8fbf'), marginTop: 4 }}>
          Afficher {Math.min(RESULTS_PAGE, items.length - shown)} de plus ({items.length - shown} restants)
        </button>
      )}
    </>
  );
}
