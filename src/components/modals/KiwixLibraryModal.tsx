import { useEffect, useRef, useState } from 'react';
import {
  X, Library, Search, Settings, Download, Trash2, Play, Square,
  ExternalLink, Plus, ArrowLeft, AlertTriangle, CheckCircle,
} from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  KiwixSettings, KiwixArchive, KiwixStatus, KiwixSearchResult,
  KiwixArticleContent, KiwixCatalogEntry, KiwixSearchScope,
} from '../../lib/cortex/client';
import { renderSafeZimHtml } from '../../lib/kiwix-safe-render';

interface Props {
  onClose: () => void;
}

type Tab = 'bibliotheque' | 'catalogue' | 'reglages';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

export default function KiwixLibraryModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('bibliotheque');

  const [settings, setSettings] = useState<KiwixSettings | null>(null);
  const [status, setStatus] = useState<KiwixStatus | null>(null);
  const [archives, setArchives] = useState<KiwixArchive[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [searchBook, setSearchBook] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KiwixSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [article, setArticle] = useState<KiwixArticleContent | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogLang, setCatalogLang] = useState('fra');
  const [catalogResults, setCatalogResults] = useState<KiwixCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<KiwixCatalogEntry | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ fileName: string; percent: number | null } | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);

  const [pathForm, setPathForm] = useState({ kiwixServePath: '', archivesFolder: '', port: 8090 });
  const [savingSettings, setSavingSettings] = useState(false);
  const [searchScope, setSearchScope] = useState<KiwixSearchScope>('neurones');

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { void loadAll(); }, []);

  async function loadAll() {
    try {
      const [s, st, arch, scope] = await Promise.all([
        cortexClient.kiwixSettings(),
        cortexClient.kiwixStatus(),
        cortexClient.kiwixArchives(),
        cortexClient.kiwixSearchScope(),
      ]);
      setSettings(s);
      setStatus(st);
      setArchives(arch.archives);
      setTotalBytes(arch.totalBytes);
      setSearchScope(scope);
      setPathForm({ kiwixServePath: s.kiwixServePath ?? '', archivesFolder: s.archivesFolder, port: s.port });
    } catch { /* ignore */ }
  }

  async function handleStart() {
    setStarting(true);
    setStartError(null);
    try {
      const result = await cortexClient.startKiwix();
      if (!result.ok) {
        setStartError(result.message ?? 'Démarrage impossible');
      } else {
        await loadAll();
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    await cortexClient.stopKiwix();
    await loadAll();
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setArticle(null);
    try {
      const results = await cortexClient.kiwixSearchArchives(searchBook, searchQuery.trim());
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function openArticle(book: string, path: string) {
    try {
      const content = await cortexClient.kiwixArticle(book, path);
      setArticle(content);
      setImportMsg(null);
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }

  function handleArticleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = (e.target as HTMLElement).closest('a[data-zim-link]') as HTMLElement | null;
    if (!target || !article) return;
    e.preventDefault();
    const zimPath = target.getAttribute('data-zim-link');
    if (zimPath) void openArticle(article.book, zimPath);
  }

  async function handleImport() {
    if (!article) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const result = await cortexClient.importKiwixArticle({
        book: article.book, path: article.path, title: article.title, text: article.text,
      });
      setImportMsg(result.ok ? `Ajouté au cortex (${result.chunkCount} bloc(s)).` : 'Échec de l\'ajout.');
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setImporting(false);
    }
  }

  async function handleCatalogSearch() {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const [entries, free] = await Promise.all([
        cortexClient.kiwixCatalog(catalogQuery, catalogLang || undefined),
        cortexClient.kiwixDiskSpace(),
      ]);
      setCatalogResults(entries);
      setFreeBytes(free);
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : 'Erreur inconnue');
      setCatalogResults([]);
    } finally {
      setCatalogLoading(false);
    }
  }

  async function confirmDownload() {
    if (!confirmEntry?.downloadUrl) return;
    const entry = confirmEntry;
    setConfirmEntry(null);
    const fileName = `${entry.name || entry.title}.zim`.replace(/[\\/:*?"<>|]/g, '_');
    downloadAbortRef.current = new AbortController();
    setDownloadProgress({ fileName, percent: 0 });
    try {
      await cortexClient.downloadKiwixArchive(
        { url: entry.downloadUrl as string, fileName, sizeBytes: entry.sizeBytes ?? 0 },
        (p) => {
          if (p.type === 'progress') setDownloadProgress({ fileName, percent: p.percent ?? null });
        },
        downloadAbortRef.current.signal,
      );
      setDownloadProgress(null);
      await loadAll();
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : 'Téléchargement échoué');
      setDownloadProgress(null);
    }
  }

  function cancelDownload() {
    downloadAbortRef.current?.abort();
    setDownloadProgress(null);
  }

  async function handleDeleteArchive(fileName: string) {
    if (!confirm(`Supprimer l'archive "${fileName}" ?`)) return;
    try {
      await cortexClient.deleteKiwixArchive(fileName);
      await loadAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Suppression impossible');
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const s = await cortexClient.setKiwixSettings(pathForm);
      setSettings(s);
    } finally {
      setSavingSettings(false);
    }
  }

  async function changeScope(scope: KiwixSearchScope) {
    setSearchScope(scope);
    await cortexClient.setKiwixSearchScope(scope);
  }

  const insufficientSpace = confirmEntry?.sizeBytes != null && freeBytes != null && freeBytes < confirmEntry.sizeBytes;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(820px, calc(100vw - 24px))',
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
          <Library size={16} style={{ color: '#84cc16', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Bibliothèque (archives ZIM hors-ligne)
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              {status?.running
                ? `kiwix-serve actif · port ${status.port} · ${status.archives.length} archive(s)`
                : 'kiwix-serve arrêté'}
            </p>
          </div>
          <button type="button" title="Fermer" style={{ color: '#5a4a7a' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="flex gap-1 px-5 pt-3" style={{ borderBottom: '1px solid rgba(132,204,22,0.08)' }}>
          {([
            ['bibliotheque', 'Bibliothèque'],
            ['catalogue', 'Catalogue en ligne'],
            ['reglages', 'Réglages'],
          ] as Array<[Tab, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className="font-mono text-xs px-3 py-2 rounded-t"
              style={{
                color: tab === key ? '#84cc16' : '#7a6c9a',
                borderBottom: tab === key ? '2px solid #84cc16' : '2px solid transparent',
                background: 'transparent',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }} className="px-5 py-4 flex flex-col gap-4">

          {tab === 'bibliotheque' && (
            <>
              <div className="flex items-center gap-2">
                {!status?.running ? (
                  <button
                    type="button"
                    disabled={starting}
                    onClick={handleStart}
                    className="flex items-center gap-2 font-mono text-xs py-2 px-3 rounded"
                    style={{ background: 'rgba(132,204,22,0.1)', border: '1px solid rgba(132,204,22,0.28)', color: '#84cc16' }}
                  >
                    <Play size={12} />
                    {starting ? 'Démarrage…' : 'Démarrer kiwix-serve'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="flex items-center gap-2 font-mono text-xs py-2 px-3 rounded"
                    style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.28)', color: '#f87171' }}
                  >
                    <Square size={12} />
                    Arrêter
                  </button>
                )}
                <span className="font-mono text-xs" style={{ color: '#7a6c9a' }}>
                  {archives.length} archive(s) · {formatBytes(totalBytes)} occupés
                </span>
              </div>

              {startError && (
                <div className="flex items-start gap-2 p-3 rounded font-mono text-xs" style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', color: '#f87171' }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    {startError}
                    {startError.includes('kiwix-tools') || !settings?.binaryFound ? (
                      <div className="mt-1">
                        <a href={settings?.kiwixToolsUrl ?? 'https://download.kiwix.org/release/kiwix-tools/'} target="_blank" rel="noopener noreferrer" style={{ color: '#84cc16' }}>
                          Télécharger kiwix-tools <ExternalLink size={10} style={{ display: 'inline' }} />
                        </a>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {archives.length === 0 && (
                <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>
                  Aucune archive .zim trouvée dans {settings?.archivesFolder}. Place tes fichiers .zim dans ce dossier ou change-le dans Réglages.
                </p>
              )}

              <div className="flex flex-col gap-1">
                {archives.map(a => (
                  <div key={a.fileName} className="flex items-center gap-2 py-1.5 px-2 rounded" style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <span className="flex-1 font-mono text-xs" style={{ color: '#d8d0ea' }}>{a.name}</span>
                    <span className="font-mono text-xs" style={{ color: '#7a6c9a' }}>{formatBytes(a.sizeBytes)}</span>
                    <button type="button" title="Supprimer" onClick={() => handleDeleteArchive(a.fileName)} style={{ color: '#f87171' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {status?.running && (
                <>
                  <div className="flex gap-2 items-center pt-2" style={{ borderTop: '1px solid rgba(132,204,22,0.08)' }}>
                    <select
                      value={searchBook}
                      onChange={e => setSearchBook(e.target.value)}
                      className="font-mono text-xs py-1.5 px-2 rounded"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.15)', color: '#d8d0ea' }}
                      title="Archive à cibler (vide = toutes)"
                    >
                      <option value="">Toutes les archives</option>
                      {archives.map(a => <option key={a.fileName} value={a.name}>{a.name}</option>)}
                    </select>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleSearch(); }}
                      placeholder="Rechercher un article…"
                      className="flex-1 font-mono text-xs py-1.5 px-2 rounded"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.15)', color: '#d8d0ea' }}
                    />
                    <button type="button" onClick={handleSearch} disabled={searching} title="Rechercher" style={{ color: '#84cc16' }}>
                      <Search size={14} />
                    </button>
                  </div>

                  {!article && (
                    <div className="flex flex-col gap-1">
                      {searchResults.map((r, i) => (
                        <button
                          key={`${r.bookName}-${r.path}-${i}`}
                          type="button"
                          onClick={() => openArticle(r.bookName, r.path)}
                          className="text-left py-1.5 px-2 rounded"
                          style={{ background: 'rgba(255,255,255,0.02)', border: 'none', cursor: 'pointer' }}
                        >
                          <div className="font-mono text-xs" style={{ color: '#84cc16' }}>{r.title}</div>
                          <div className="font-mono text-xs" style={{ color: '#7a6c9a' }}>{r.bookName} — {r.snippet}</div>
                        </button>
                      ))}
                    </div>
                  )}

                  {article && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setArticle(null)} title="Retour aux résultats" style={{ color: '#7a6c9a' }}>
                          <ArrowLeft size={14} />
                        </button>
                        <h4 className="font-grotesk text-sm font-semibold flex-1" style={{ color: '#f0eaff' }}>{article.title}</h4>
                        <button
                          type="button"
                          disabled={importing}
                          onClick={handleImport}
                          className="flex items-center gap-1 font-mono text-xs py-1.5 px-2 rounded"
                          style={{ background: 'rgba(132,204,22,0.1)', border: '1px solid rgba(132,204,22,0.28)', color: '#84cc16' }}
                        >
                          <Plus size={12} />
                          {importing ? 'Ajout…' : 'Ajouter au cortex'}
                        </button>
                      </div>
                      {importMsg && (
                        <div className="font-mono text-xs flex items-center gap-1" style={{ color: importMsg.startsWith('Ajouté') ? '#84cc16' : '#f87171' }}>
                          <CheckCircle size={12} /> {importMsg}
                        </div>
                      )}
                      <div
                        onClick={handleArticleClick}
                        className="kiwix-article-content font-mono text-xs"
                        style={{ color: '#d8d0ea', lineHeight: 1.6, maxHeight: '48vh', overflowY: 'auto', padding: '4px 2px' }}
                      >
                        {renderSafeZimHtml(article.html)}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {tab === 'catalogue' && (
            <>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={catalogQuery}
                  onChange={e => setCatalogQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void handleCatalogSearch(); }}
                  placeholder="Sujet (ex: wikipedia, medecine, survie…)"
                  className="flex-1 font-mono text-xs py-1.5 px-2 rounded"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.15)', color: '#d8d0ea' }}
                />
                <input
                  type="text"
                  value={catalogLang}
                  onChange={e => setCatalogLang(e.target.value)}
                  placeholder="langue (fra, eng…)"
                  className="w-28 font-mono text-xs py-1.5 px-2 rounded"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.15)', color: '#d8d0ea' }}
                />
                <button type="button" onClick={handleCatalogSearch} disabled={catalogLoading} title="Rechercher" style={{ color: '#84cc16' }}>
                  <Search size={14} />
                </button>
              </div>

              {catalogError && (
                <div className="font-mono text-xs" style={{ color: '#f87171' }}>{catalogError}</div>
              )}

              <div className="flex flex-col gap-1">
                {catalogResults.map(entry => (
                  <div key={entry.id || entry.name} className="flex items-start gap-2 py-2 px-2 rounded" style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <div className="flex-1">
                      <div className="font-mono text-xs" style={{ color: '#84cc16' }}>{entry.title}</div>
                      <div className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                        {entry.language} · {formatBytes(entry.sizeBytes)} · {entry.updated?.slice(0, 10)}
                      </div>
                      {entry.description && (
                        <div className="font-mono text-xs mt-0.5" style={{ color: '#5a4a7a' }}>{entry.description.slice(0, 180)}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={!entry.downloadUrl}
                      onClick={() => setConfirmEntry(entry)}
                      title="Télécharger"
                      className="flex items-center gap-1 font-mono text-xs py-1 px-2 rounded"
                      style={{ background: 'rgba(132,204,22,0.1)', border: '1px solid rgba(132,204,22,0.28)', color: '#84cc16', flexShrink: 0 }}
                    >
                      <Download size={12} /> Télécharger
                    </button>
                  </div>
                ))}
              </div>

              {confirmEntry && (
                <div className="p-3 rounded flex flex-col gap-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.2)' }}>
                  <p className="font-mono text-xs" style={{ color: '#d8d0ea' }}>
                    Cette archive fait {formatBytes(confirmEntry.sizeBytes)}. Espace libre : {formatBytes(freeBytes)}.
                  </p>
                  {insufficientSpace && (
                    <p className="font-mono text-xs" style={{ color: '#f87171' }}>
                      Espace insuffisant — libère de la place avant de continuer.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!!insufficientSpace}
                      onClick={confirmDownload}
                      className="font-mono text-xs py-1.5 px-3 rounded"
                      style={{ background: 'rgba(132,204,22,0.15)', border: '1px solid rgba(132,204,22,0.3)', color: '#84cc16', opacity: insufficientSpace ? 0.5 : 1 }}
                    >
                      Confirmer le téléchargement
                    </button>
                    <button type="button" onClick={() => setConfirmEntry(null)} className="font-mono text-xs py-1.5 px-3 rounded" style={{ color: '#7a6c9a' }}>
                      Annuler
                    </button>
                  </div>
                </div>
              )}

              {downloadProgress && (
                <div className="p-3 rounded flex items-center gap-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.2)' }}>
                  <span className="font-mono text-xs flex-1" style={{ color: '#d8d0ea' }}>
                    Téléchargement de {downloadProgress.fileName}… {downloadProgress.percent != null ? `${downloadProgress.percent}%` : ''}
                  </span>
                  <button type="button" onClick={cancelDownload} className="font-mono text-xs" style={{ color: '#f87171' }}>
                    Annuler
                  </button>
                </div>
              )}
            </>
          )}

          {tab === 'reglages' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Dossier kiwix-tools (contenant kiwix-serve.exe)</label>
                <input
                  type="text"
                  value={pathForm.kiwixServePath}
                  onChange={e => setPathForm(f => ({ ...f, kiwixServePath: e.target.value }))}
                  placeholder="C:\Outils\kiwix-tools_win-i686"
                  className="font-mono text-xs py-1.5 px-2 rounded"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.15)', color: '#d8d0ea' }}
                />
                {settings && !settings.binaryFound && (
                  <span className="font-mono text-xs" style={{ color: '#f87171' }}>
                    kiwix-serve.exe introuvable. Télécharge{' '}
                    <a href={settings.kiwixToolsUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#84cc16' }}>
                      kiwix-tools_win-i686.zip
                    </a>, extrais-le, et indique ce dossier ici.
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Dossier des archives .zim</label>
                <input
                  type="text"
                  value={pathForm.archivesFolder}
                  onChange={e => setPathForm(f => ({ ...f, archivesFolder: e.target.value }))}
                  className="font-mono text-xs py-1.5 px-2 rounded"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.15)', color: '#d8d0ea' }}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Port</label>
                <input
                  type="number"
                  value={pathForm.port}
                  onChange={e => setPathForm(f => ({ ...f, port: Number(e.target.value) || 8090 }))}
                  className="font-mono text-xs py-1.5 px-2 rounded"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(132,204,22,0.15)', color: '#d8d0ea', width: 100 }}
                />
              </div>

              <button
                type="button"
                disabled={savingSettings}
                onClick={saveSettings}
                className="self-start font-mono text-xs py-1.5 px-3 rounded"
                style={{ background: 'rgba(132,204,22,0.1)', border: '1px solid rgba(132,204,22,0.28)', color: '#84cc16' }}
              >
                {savingSettings ? 'Enregistrement…' : 'Enregistrer'}
              </button>

              <div className="pt-3 flex flex-col gap-1" style={{ borderTop: '1px solid rgba(132,204,22,0.08)' }}>
                <label className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Recherche combinée (question posée à Docteur)</label>
                <div className="flex gap-2">
                  {([
                    ['neurones', 'Mes neurones seuls'],
                    ['archives', 'Archives seules'],
                    ['les_deux', 'Les deux'],
                  ] as Array<[KiwixSearchScope, string]>).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => changeScope(key)}
                      className="font-mono text-xs py-1.5 px-2 rounded"
                      style={{
                        background: searchScope === key ? 'rgba(132,204,22,0.15)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${searchScope === key ? 'rgba(132,204,22,0.4)' : 'rgba(132,204,22,0.12)'}`,
                        color: searchScope === key ? '#84cc16' : '#7a6c9a',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>
                <Settings size={10} style={{ display: 'inline', marginRight: 4 }} />
                kiwix-serve ne démarre jamais automatiquement au lancement de Docteur — uniquement quand tu ouvres cette Bibliothèque ou cliques sur Démarrer.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
