import { useEffect, useRef, useState } from 'react';
import { X, Mountain, Upload, RefreshCw, AlertTriangle, CheckCircle, Trash2, Info } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { CorpusScanResult, CorpusSource } from '../../lib/cortex/client';
import { getCorpusShowIn3D, setCorpusShowIn3D } from '../../lib/corpusSettings';

interface Props {
  onClose:  () => void;
  onReload: () => Promise<void>; // refresh pages from server after import
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

type Phase = 'idle' | 'scanning' | 'importing';

export default function CorpusModal({ onClose, onReload }: Props) {
  const [corpora, setCorpora]       = useState<CorpusSource[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [files, setFiles]           = useState<File[]>([]);
  const [corpusName, setCorpusName] = useState('');
  const [keywords, setKeywords]     = useState('');
  const [minSizeKo, setMinSizeKo]   = useState('');
  const [maxSizeKo, setMaxSizeKo]   = useState('');
  const [limit, setLimit]           = useState('500');
  const [scan, setScan]             = useState<CorpusScanResult | null>(null);
  const [phase, setPhase]           = useState<Phase>('idle');
  const [progress, setProgress]     = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus]         = useState<{ ok: boolean; message: string } | null>(null);
  const [lastErrors, setLastErrors] = useState<Array<{ name: string; error: string }>>([]);
  const [show3D, setShow3D]         = useState(getCorpusShowIn3D());
  const fileInputRef                = useRef<HTMLInputElement>(null);
  const pollRef                     = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase === 'idle') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  useEffect(() => { fetchList(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  async function fetchList() {
    setLoadingList(true);
    try {
      const result = await cortexClient.corpusList();
      setCorpora(result.corpora);
    } catch {
      setCorpora([]);
    } finally {
      setLoadingList(false);
    }
  }

  function filters() {
    return {
      keywords: keywords.trim() || undefined,
      minSize:  minSizeKo ? Number(minSizeKo) * 1024 : undefined,
      maxSize:  maxSizeKo ? Number(maxSizeKo) * 1024 : undefined,
      limit:    limit ? Number(limit) : undefined,
    };
  }

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    setFiles(list);
    setScan(null);
    setStatus(null);
    setLastErrors([]);
  }

  async function handleScan() {
    if (files.length === 0) return;
    setPhase('scanning');
    setStatus(null);
    setLastErrors([]);
    try {
      const result = await cortexClient.corpusScan(files, filters());
      setScan(result);
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setPhase('idle');
    }
  }

  async function handleConfirmImport() {
    if (!scan || files.length === 0) return;
    const name = corpusName.trim() || `Corpus ${new Date().toLocaleDateString('fr-FR')}`;
    setPhase('importing');
    setStatus(null);
    try {
      const result = await cortexClient.corpusImport(files, name, filters());
      setProgress({ done: 0, total: result.matched });
      pollRef.current = setInterval(async () => {
        try {
          const job = await cortexClient.corpusJobStatus(result.jobId);
          setProgress({ done: job.done, total: job.total });
          if (job.status !== 'running') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setPhase('idle');
            setScan(null);
            setFiles([]);
            setCorpusName('');
            const errMsg = job.errors.length > 0 ? ` (${job.errors.length} échec(s) — voir détail ci-dessous)` : '';
            setStatus({ ok: job.status === 'done', message: `${job.done}/${job.total} parties importées${errMsg}` });
            setLastErrors(job.errors);
            fetchList();
            await onReload();
          }
        } catch {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setPhase('idle');
        }
      }, 1000);
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
      setPhase('idle');
    }
  }

  async function handleDelete(corpus: CorpusSource) {
    if (!confirm(`Supprimer le corpus "${corpus.name}" et ses ${corpus.article_count} articles ? Vos neurones personnels ne seront pas touchés.`)) return;
    try {
      const result = await cortexClient.corpusDelete(corpus.id);
      setStatus({ ok: true, message: `${result.deleted} article(s) supprimé(s)` });
      fetchList();
      await onReload();
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    }
  }

  function toggleShow3D() {
    const next = !show3D;
    setShow3D(next);
    setCorpusShowIn3D(next);
  }

  const busy = phase !== 'idle';

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(560px, calc(100vw - 24px))',
          border: '1px solid rgba(132,204,22,0.25)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(132,204,22,0.1)' }}>
          <Mountain size={16} style={{ color: '#84cc16', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Corpus de référence
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              Connaissances hors-ligne (survie, premiers secours…) — 100% local
            </p>
          </div>
          <button type="button" title="Fermer" style={{ color: '#5a4a7a' }} onClick={onClose} disabled={busy}>
            <X size={14} />
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Import section */}
          <div className="px-5 py-4 flex flex-col gap-2" style={{ borderBottom: '1px solid rgba(132,204,22,0.08)' }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.markdown,.txt"
              className="hidden"
              title="Sélectionner des fichiers markdown/texte"
              aria-label="Sélectionner des fichiers markdown/texte"
              onChange={handleFilesSelected}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded"
              style={{
                background: 'rgba(132,204,22,0.1)', border: '1px solid rgba(132,204,22,0.28)',
                color: '#84cc16', cursor: busy ? 'default' : 'pointer',
              }}
            >
              <Upload size={12} />
              {files.length > 0 ? `${files.length} fichier(s) sélectionné(s)` : 'Choisir des fichiers .md / .txt'}
            </button>

            <input
              type="text"
              placeholder="Nom du corpus (ex: Survie en milieu naturel)"
              value={corpusName}
              onChange={e => setCorpusName(e.target.value)}
              className="font-mono text-xs px-3 py-2 rounded"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
            />

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Mots-clés titre (virgule)"
                value={keywords}
                onChange={e => setKeywords(e.target.value)}
                className="font-mono text-xs px-3 py-2 rounded flex-1"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
              />
              <input
                type="number"
                placeholder="Max articles"
                value={limit}
                onChange={e => setLimit(e.target.value)}
                className="font-mono text-xs px-3 py-2 rounded"
                style={{ width: 110, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="Taille min (Ko)"
                value={minSizeKo}
                onChange={e => setMinSizeKo(e.target.value)}
                className="font-mono text-xs px-3 py-2 rounded flex-1"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
              />
              <input
                type="number"
                placeholder="Taille max (Ko)"
                value={maxSizeKo}
                onChange={e => setMaxSizeKo(e.target.value)}
                className="font-mono text-xs px-3 py-2 rounded flex-1"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#c8b8e8' }}
              />
            </div>

            {!scan && (
              <button
                type="button"
                disabled={busy || files.length === 0}
                onClick={handleScan}
                className="flex items-center justify-center gap-2 font-mono text-xs py-2 rounded"
                style={{
                  background: 'rgba(94,231,255,0.1)', border: '1px solid rgba(94,231,255,0.25)',
                  color: files.length === 0 ? '#5a4a7a' : '#5ee7ff', cursor: busy || files.length === 0 ? 'default' : 'pointer',
                }}
              >
                {phase === 'scanning' ? <RefreshCw size={12} className="animate-spin" /> : <Info size={12} />}
                {phase === 'scanning' ? 'Analyse…' : 'Analyser (sans importer)'}
              </button>
            )}

            {scan && (
              <div className="flex flex-col gap-2 px-3 py-3 rounded" style={{ background: 'rgba(132,204,22,0.06)', border: '1px solid rgba(132,204,22,0.2)' }}>
                <p className="font-mono text-xs" style={{ color: '#c0e0a0' }}>
                  {scan.totalFound} fichier(s) détecté(s) · {scan.matchedCount} correspondent aux filtres
                  {scan.truncated ? ` (limité à ${scan.willImportCount})` : ''}
                </p>
                <p className="font-mono" style={{ color: '#7a9a5a', fontSize: 10 }}>
                  Estimation : ~{formatBytes(scan.estimatedSizeBytes)} · {scan.rejectedExt} ignorés (format) · {scan.rejectedSize} ignorés (taille)
                </p>
                {scan.sampleTitles.length > 0 && (
                  <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 10, lineHeight: 1.5 }}>
                    {scan.sampleTitles.slice(0, 8).join(' · ')}{scan.matchedCount > 8 ? '…' : ''}
                  </p>
                )}
                {scan.willImportCount === 0 ? (
                  <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>
                    Aucun article ne correspond — ajustez les filtres.
                  </p>
                ) : (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleConfirmImport}
                      className="flex-1 flex items-center justify-center gap-2 font-mono text-xs py-2 rounded"
                      style={{ background: 'rgba(61,255,170,0.12)', border: '1px solid rgba(61,255,170,0.3)', color: '#3dffaa', cursor: busy ? 'default' : 'pointer' }}
                    >
                      {phase === 'importing' ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                      Confirmer l'import de {scan.willImportCount} article(s)
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setScan(null)}
                      className="font-mono text-xs py-2 px-3 rounded"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#9f8fbf' }}
                    >
                      Annuler
                    </button>
                  </div>
                )}
              </div>
            )}

            {progress && phase === 'importing' && (
              <div className="font-mono text-xs" style={{ color: '#84cc16' }}>
                Import en cours (tâche de fond)… {progress.done}/{progress.total}
                <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: '#84cc16', transition: 'width 0.3s' }} />
                </div>
              </div>
            )}

            {status && (
              <div
                className="flex items-center gap-2 px-3 py-2 rounded font-mono text-xs"
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

            {lastErrors.length > 0 && (
              <div className="flex flex-col gap-1 px-3 py-2 rounded font-mono text-xs" style={{ background: 'rgba(255,77,88,0.05)', border: '1px solid rgba(255,77,88,0.15)' }}>
                <p style={{ color: '#ff8a90' }}>Échecs d'indexation ({lastErrors.length}) :</p>
                <div style={{ maxHeight: 140, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {lastErrors.map((err) => (
                    <p key={`${err.name}-${err.error}`} style={{ color: '#c98a8e', fontSize: 10, lineHeight: 1.4 }}>
                      <span style={{ color: '#e0a0a4' }}>{err.name}</span> — {err.error}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 3D toggle */}
          <div className="px-5 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(132,204,22,0.08)' }}>
            <input id="corpus-show-3d" type="checkbox" checked={show3D} onChange={toggleShow3D} />
            <label htmlFor="corpus-show-3d" className="font-mono text-xs" style={{ color: '#9f8fbf' }}>
              Inclure les références du corpus dans le cortex 3D (masqué par défaut)
            </label>
          </div>

          {/* Corpus list */}
          <div>
            <div className="px-5 py-2 font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
              CORPUS IMPORTÉS {loadingList ? '…' : `(${corpora.length})`}
            </div>
            {!loadingList && corpora.length === 0 && (
              <p className="px-5 pb-4 font-mono text-xs" style={{ color: '#5a4a7a' }}>
                Aucun corpus de référence importé
              </p>
            )}
            {corpora.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-5 py-2" style={{ borderTop: '1px solid rgba(132,204,22,0.05)' }}>
                <Mountain size={11} style={{ color: '#3d3060', flexShrink: 0 }} />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs truncate" style={{ color: '#c0b0e0' }}>{c.name}</p>
                  <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 10 }}>
                    {c.article_count} article(s) · {formatBytes(c.size_bytes)} · {c.status}
                    {c.error_count > 0 ? ` · ${c.error_count} erreur(s)` : ''}
                  </p>
                </div>
                <span className="font-mono" style={{ color: '#3d3060', fontSize: 10, flexShrink: 0 }}>
                  {formatDate(c.created_at).split(' ').slice(0, 3).join(' ')}
                </span>
                <button
                  type="button"
                  title="Supprimer ce corpus"
                  onClick={() => handleDelete(c)}
                  style={{ color: '#ff4d58', flexShrink: 0 }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
