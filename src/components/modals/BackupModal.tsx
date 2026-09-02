import { useEffect, useRef, useState } from 'react';
import { X, Download, Upload, HardDrive, RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { BackupEntry, BackupExport } from '../../lib/cortex/client';
import type { Page } from '../../lib/types';

interface Props {
  pages:          Page[];
  onClose:        () => void;
  onRestorePages: (neurons: BackupExport['neurons'], links: Array<{ from: string; to: string }>) => Promise<void>;
}

type Phase = 'idle' | 'exporting' | 'importing' | 'triggering';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function BackupModal({ pages, onClose, onRestorePages }: Props) {
  const [backups, setBackups]   = useState<BackupEntry[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [phase, setPhase]       = useState<Phase>('idle');
  const [status, setStatus]     = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef            = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase === 'idle') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  useEffect(() => { fetchList(); }, []);

  async function fetchList() {
    setLoadingList(true);
    try {
      const result = await cortexClient.backupList();
      setBackups([...result.backups].reverse()); // most recent first
    } catch {
      setBackups([]);
    } finally {
      setLoadingList(false);
    }
  }

  async function handleExportNow() {
    setPhase('exporting');
    setStatus(null);
    try {
      // Get neurons from LanceDB (has content as string for LLM indexing)
      const serverData = await cortexClient.backupExport();

      // Links are now computed server-side from SQLite (backup.js).
      // Fall back to client-side computation from in-memory pages if server didn't include them
      // (older server versions or partial page loads).
      let links: Array<{ from: string; to: string }> = serverData.links ?? [];
      if (links.length === 0 && pages.length > 0) {
        const seen = new Set<string>();
        for (const page of pages) {
          for (const targetId of (page.links ?? [])) {
            const key = [page.id, targetId].sort().join('|');
            if (!seen.has(key)) { seen.add(key); links.push({ from: page.id, to: targetId }); }
          }
        }
      }

      const data: BackupExport = { ...serverData, links };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `docteur-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ ok: true, message: `${data.neurons_count} neurones + ${links.length} synapses exportés` });
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setPhase('idle');
    }
  }

  async function handleTriggerBackup() {
    setPhase('triggering');
    setStatus(null);
    try {
      const result = await cortexClient.backupTrigger();
      setStatus({ ok: true, message: `Backup créé : ${result.filename} (${result.neurons_count} neurones)` });
      fetchList();
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setPhase('idle');
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setPhase('importing');
    setStatus(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as BackupExport;
      if (!data.version || !Array.isArray(data.neurons)) {
        throw new Error('Format invalide — ce fichier n\'est pas un backup Docteur');
      }
      // 1. Reindex in LanceDB
      const result = await cortexClient.backupImport(data);
      // 2. Recreate in IndexedDB (cortex 3D + sidebar) + restore synapses
      const links = Array.isArray(data.links) ? data.links : [];
      await onRestorePages(data.neurons, links);
      const linkMsg  = links.length > 0 ? ` · ${links.length} synapses` : '';
      const errMsg   = result.errors.length > 0 ? ` (${result.errors.length} erreurs)` : '';
      const reconMsg = result.reconstructedBlocks && result.reconstructedBlocks > 0
        ? ` · ${result.reconstructedBlocks} neurone(s) d'un backup ancien reconstruit(s) depuis le texte indexé (contenu approximatif)`
        : '';
      setStatus({ ok: result.ok, message: `${result.indexed}/${result.total} neurones restaurés${linkMsg}${errMsg}${reconMsg}` });
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setPhase('idle');
    }
  }

  const busy = phase !== 'idle';
  const lastBackup = backups[0] ?? null;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(520px, calc(100vw - 24px))',
          border: '1px solid rgba(94,231,255,0.25)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid rgba(94,231,255,0.1)' }}
        >
          <HardDrive size={16} style={{ color: '#5ee7ff', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Backup & restauration
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              {lastBackup
                ? `Dernier backup : ${formatDate(lastBackup.exported_at)} · ${lastBackup.neurons_count} neurones`
                : 'Aucun backup disponible'}
            </p>
          </div>
          <button
            type="button"
            title="Fermer"
            style={{ color: '#5a4a7a' }}
            onClick={onClose}
            disabled={busy}
          >
            <X size={14} />
          </button>
        </div>

        {/* Actions */}
        <div className="px-5 py-4 flex flex-col gap-3" style={{ borderBottom: '1px solid rgba(94,231,255,0.08)' }}>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleExportNow}
              className="flex-1 flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded"
              style={{
                background:  'rgba(61,255,170,0.1)',
                border:      '1px solid rgba(61,255,170,0.28)',
                color:       busy && phase === 'exporting' ? '#7a6c9a' : '#3dffaa',
                cursor:      busy ? 'default' : 'pointer',
              }}
            >
              {phase === 'exporting' ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
              {phase === 'exporting' ? 'Exportation...' : 'Exporter maintenant'}
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded"
              style={{
                background:  'rgba(94,231,255,0.1)',
                border:      '1px solid rgba(94,231,255,0.25)',
                color:       busy && phase === 'importing' ? '#7a6c9a' : '#5ee7ff',
                cursor:      busy ? 'default' : 'pointer',
              }}
            >
              {phase === 'importing' ? <RefreshCw size={12} className="animate-spin" /> : <Upload size={12} />}
              {phase === 'importing' ? 'Restauration...' : 'Restaurer depuis un fichier'}
            </button>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={handleTriggerBackup}
            className="flex items-center justify-center gap-2 font-mono text-xs py-2 rounded"
            style={{
              background:  'rgba(255,255,255,0.04)',
              border:      '1px solid rgba(255,255,255,0.08)',
              color:       busy && phase === 'triggering' ? '#7a6c9a' : '#9f8fbf',
              cursor:      busy ? 'default' : 'pointer',
            }}
          >
            {phase === 'triggering' ? <RefreshCw size={11} className="animate-spin" /> : <HardDrive size={11} />}
            {phase === 'triggering' ? 'Sauvegarde en cours...' : 'Créer un backup maintenant'}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            title="Sélectionner un fichier backup JSON"
            aria-label="Sélectionner un fichier backup JSON"
            onChange={handleFileSelected}
          />

          {status && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded font-mono text-xs"
              style={{
                background: status.ok ? 'rgba(61,255,170,0.08)' : 'rgba(255,77,88,0.08)',
                border:     `1px solid ${status.ok ? 'rgba(61,255,170,0.2)' : 'rgba(255,77,88,0.2)'}`,
                color:      status.ok ? '#3dffaa' : '#ff4d58',
              }}
            >
              {status.ok
                ? <CheckCircle size={12} style={{ flexShrink: 0 }} />
                : <AlertTriangle size={12} style={{ flexShrink: 0 }} />}
              {status.message}
            </div>
          )}
        </div>

        {/* Backup list */}
        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          <div className="px-5 py-2 font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
            BACKUPS DISPONIBLES {loadingList ? '…' : `(${backups.length}/30)`}
          </div>

          {!loadingList && backups.length === 0 && (
            <p className="px-5 pb-4 font-mono text-xs" style={{ color: '#5a4a7a' }}>
              Aucun backup sur le serveur
            </p>
          )}

          {backups.map(b => (
            <div
              key={b.name}
              className="flex items-center gap-3 px-5 py-2"
              style={{ borderTop: '1px solid rgba(61,255,170,0.05)' }}
            >
              <HardDrive size={11} style={{ color: '#3d3060', flexShrink: 0 }} />
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs truncate" style={{ color: '#c0b0e0' }}>
                  {b.name.replace('backup-', '').replace('.json', '')}
                </p>
                <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 10 }}>
                  {b.neurons_count} neurones · {formatBytes(b.size_bytes)}
                </p>
              </div>
              <span className="font-mono" style={{ color: '#3d3060', fontSize: 10, flexShrink: 0 }}>
                {formatDate(b.exported_at).split(' ').slice(0, 3).join(' ')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
