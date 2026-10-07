// [Media Studio V1] Local, non-destructive media editor. Projects (assets, video sequence + audio track,
// settings, export config) are saved on cortex-server after every edit and reopen identically. Media files are
// Docteur's own copies: the user's originals are never touched. Export = FFmpeg on cortex-server (fixed binary,
// argv, shell:false, Root Policy MEDIA_TRANSCODE), one job at a time, real progress, real cancel. No cloud.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Clapperboard, Download, Film, ImageIcon, Music, Plus, Scissors, Trash2, Upload, Volume2, VolumeX } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import StudioEmptyState from '../studio/StudioEmptyState';
import OperationProgress from '../loading/OperationProgress';
import OperationStatusLine from '../loading/OperationStatusLine';
import SequencePreview from '../media-studio/SequencePreview';
import { useLongOperation, useOperationClock } from '../../hooks/useLongOperation';
import { IDLE_OPERATION, OPERATION_POLICIES, isSlow, type OperationState } from '../../lib/loading/operation';
import { cortexClient, docteurImageIdOf } from '../../lib/cortex/client';
import type { MediaAsset, MediaClip, MediaEdit, MediaExportJob, MediaProjectSummary, MediaProjectView, MediaResolution } from '../../lib/cortex/client';
import { bridgeFileName, fetchMediaBlob } from '../../lib/media-studio/import';
import { formatTimecode } from '../../lib/media-studio/preview';

export interface MediaStudioImportRequest {
  /** increments on every send from the Media Reader */
  requestId: number;
  url: string;
  title?: string | null;
}

interface Props {
  onClose: () => void;
  /** [Media Studio V1] media sent from the Media Reader (imported into the open / most recent project) */
  pendingImport?: MediaStudioImportRequest | null;
}

const RESOLUTION_LABEL: Record<MediaResolution, string> = { '640x360': '640×360 (16:9)', '1280x720': '1280×720 HD', '1920x1080': '1920×1080 Full HD', '1080x1920': '1080×1920 vertical' };
const SOURCE_LABEL = { upload: 'fichier', 'media-reader': 'Media Reader', 'docteur-image': 'image Docteur' } as const;
const FINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const STATUS_LABEL: Record<MediaExportJob['status'], string> = { QUEUED: 'en file', RUNNING: 'en cours', COMPLETED: 'terminé', FAILED: 'échec', CANCELLED: 'annulé' };
const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const sec = (ms: number) => Math.round(ms / 100) / 10;
const ms = (s: string) => Math.round(Number(s.replace(',', '.')) * 1000);
const clipMs = (c: MediaClip) => c.outMs - c.inMs;
const kindIcon = (k: MediaAsset['kind']) => (k === 'video' ? <Film size={12} aria-hidden="true" /> : k === 'audio' ? <Music size={12} aria-hidden="true" /> : <ImageIcon size={12} aria-hidden="true" />);

/** F2 view of a server export job (the job is the source of truth). */
function exportOperation(job: MediaExportJob | null, now: number): OperationState {
  if (!job) return IDLE_OPERATION;
  const startedAt = Date.parse(job.startedAt ?? job.createdAt);
  const base = { ...IDLE_OPERATION, label: 'Export MP4', startedAt, attempt: 1 };
  switch (job.status) {
    case 'QUEUED': return { ...base, status: 'running', step: 'En file d’attente (un export à la fois)…' };
    case 'RUNNING': return { ...base, status: 'running', step: job.progress > 0 ? `Encodage FFmpeg — ${job.progress} %` : 'Préparation de l’encodage FFmpeg…', progress: { current: job.progress, total: 100, unit: '%' } };
    case 'FAILED': return { ...base, status: 'error', error: job.error ?? 'Export échoué', finishedAt: Date.parse(job.finishedAt ?? '') || now };
    case 'CANCELLED': return { ...base, status: 'cancelled', finishedAt: Date.parse(job.finishedAt ?? '') || now };
    default: return { ...base, status: 'success', finishedAt: Date.parse(job.finishedAt ?? '') || now };
  }
}

export default function MediaStudioModal({ onClose, pendingImport = null }: Props) {
  const [projects, setProjects] = useState<MediaProjectSummary[]>([]);
  const [view, setView] = useState<MediaProjectView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; alert?: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [job, setJob] = useState<MediaExportJob | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [draft, setDraft] = useState({ in: '', out: '', split: '', start: '', duration: '', volume: '100', fadeIn: '0', fadeOut: '0' });
  const [nameDraft, setNameDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const clipPreviewRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const handledImport = useRef<number | null>(null);
  const importOp = useLongOperation('mediaStudioImport');
  const lastImport = useRef<(() => Promise<void>) | null>(null);

  const project = view?.project ?? null;
  const selected = project?.clips.find(c => c.id === selectedId) ?? null;
  const assetOf = useCallback((id: string) => project?.assets.find(a => a.id === id) ?? null, [project]);
  const selectedAsset = selected ? assetOf(selected.assetId) : null;
  const assetUrl = useCallback((assetId: string) => (project ? cortexClient.mediaStudioAssetUrl(project.id, assetId) : ''), [project]);

  const refreshList = useCallback(async () => {
    try { setProjects((await cortexClient.mediaStudioListProjects()).projects); } catch (err) { setNotice({ text: (err as Error).message, alert: true }); }
  }, []);
  const applyView = useCallback((v: MediaProjectView) => {
    setView(v);
    setJob(j => v.jobs.find(x => x.id === j?.id) ?? v.jobs[0] ?? null);
  }, []);
  const openProject = useCallback(async (id: string) => {
    try { const v = await cortexClient.mediaStudioGetProject(id); setSelectedId(null); setJob(v.jobs[0] ?? null); setView(v); setNameDraft(v.project.name); }
    catch (err) { setNotice({ text: (err as Error).message, alert: true }); }
  }, []);
  const createProject = useCallback(async (name?: string) => {
    const v = await cortexClient.mediaStudioCreateProject(name);
    setSelectedId(null); setJob(null); setView(v); setNameDraft(v.project.name);
    await refreshList();
    return v;
  }, [refreshList]);

  // boot: most recent project (persistence: reopening shows exactly the saved state)
  useEffect(() => {
    let alive = true;
    cortexClient.mediaStudioListProjects().then(r => {
      if (!alive) return;
      setProjects(r.projects);
      if (r.projects[0] && !pendingImport) void openProject(r.projects[0].id);
    }).catch(err => { if (alive) setNotice({ text: (err as Error).message, alert: true }); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // inspector drafts follow the selected clip and its SAVED values only (an unrelated refresh, e.g. an export
  // finishing, never wipes what the user is typing)
  const selectedKey = selected ? JSON.stringify([selected.id, selected.inMs, selected.outMs, selected.startMs, selected.volume, selected.fadeInMs, selected.fadeOutMs]) : null;
  useEffect(() => {
    if (!selected) return;
    setDraft({
      in: String(sec(selected.inMs)), out: String(sec(selected.outMs)), split: String(sec(clipMs(selected) / 2)),
      start: String(sec(selected.startMs ?? 0)), duration: String(sec(clipMs(selected))),
      volume: String(Math.round(selected.volume * 100)), fadeIn: String(sec(selected.fadeInMs)), fadeOut: String(sec(selected.fadeOutMs)),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  async function edit(op: MediaEdit, success?: string) {
    if (!project) return;
    setEditing(true);
    setNotice(null);
    try {
      applyView(await cortexClient.mediaStudioEdit(project.id, op));
      if (success) setNotice({ text: success });
      if (op.op === 'settings' && op.name) void refreshList();
    } catch (err) {
      setNotice({ text: (err as Error).message, alert: true });
    } finally { setEditing(false); }
  }

  async function ensureProject(title?: string | null) {
    if (project) return project.id;
    // fresh list (the boot listing may still be in flight): never create a project per import by accident
    const list = (await cortexClient.mediaStudioListProjects()).projects;
    setProjects(list);
    if (list[0]) { const v = await cortexClient.mediaStudioGetProject(list[0].id); setSelectedId(null); setJob(v.jobs[0] ?? null); setView(v); setNameDraft(v.project.name); return v.project.id; }
    return (await createProject(title ? `Projet — ${title}`.slice(0, 80) : undefined)).project.id;
  }

  async function importFiles(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    const action = async () => {
      setNotice(null);
      const added = await importOp.run(`Import de ${list.length} média(s)`, async ({ signal, setStep, setProgress }) => {
        const pid = await ensureProject();
        const total = list.reduce((t, f) => t + f.size, 0);
        let done = 0;
        let last: (MediaProjectView & { asset: MediaAsset }) | null = null;
        for (const f of list) {
          setStep(`Envoi de « ${f.name} »…`);
          last = await cortexClient.mediaStudioUpload(pid, f, f.name, { signal, onProgress: p => setProgress({ current: Math.round(((done + p.sent) / total) * 100), total: 100, unit: '%' }) });
          done += f.size;
          applyView(last);
        }
        return list.length;
      });
      if (added) { setNotice({ text: `${added} média(s) ajouté(s). Vos fichiers d’origine ne sont pas modifiés.` }); void refreshList(); }
    };
    lastImport.current = action;
    await action();
  }

  async function importFromReader(req: MediaStudioImportRequest) {
    const action = async () => {
      setNotice(null);
      const result = await importOp.run('Import depuis le Media Reader', async ({ signal, setStep, setProgress }) => {
        const pid = await ensureProject(req.title);
        const imageId = docteurImageIdOf(req.url);
        if (imageId) { setStep('Copie de l’image Docteur…'); return cortexClient.mediaStudioImportImage(pid, imageId); }
        setStep('Récupération du média…');
        const blob = await fetchMediaBlob(req.url, { signal, onProgress: (r, t) => setProgress(t ? { current: Math.round((r / t) * 50), total: 100, unit: '%' } : null) });
        setStep('Envoi au Media Studio…');
        return cortexClient.mediaStudioUpload(pid, blob, bridgeFileName(req.url, req.title), {
          signal, origin: { type: 'media-reader', url: req.url },
          onProgress: p => setProgress({ current: 50 + Math.round((p.sent / p.total) * 50), total: 100, unit: '%' }),
        });
      });
      if (result) { applyView(result); setNotice({ text: `« ${result.asset.name} » ajouté au projet « ${result.project.name} ».` }); void refreshList(); }
    };
    lastImport.current = action;
    await action();
  }

  useEffect(() => {
    if (!pendingImport || handledImport.current === pendingImport.requestId) return;
    handledImport.current = pendingImport.requestId;
    void importFromReader(pendingImport);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImport]);

  // export polling while the job is not final
  useEffect(() => {
    if (!job || FINAL.has(job.status)) return undefined;
    let alive = true;
    const id = window.setInterval(() => {
      cortexClient.mediaStudioGetExport(job.id).then(r => {
        if (!alive) return;
        setJob(r.job);
        if (FINAL.has(r.job.status) && project) void cortexClient.mediaStudioGetProject(project.id).then(v => { if (alive) applyView(v); }).catch(() => {});
      }).catch(() => { /* next tick */ });
    }, 700);
    return () => { alive = false; window.clearInterval(id); };
  }, [job, project, applyView]);

  const exportActive = Boolean(job && !FINAL.has(job.status));
  const clock = useOperationClock(exportActive);
  const exportState = useMemo(() => exportOperation(job, clock.now), [job, clock.now]);
  const exportPolicy = OPERATION_POLICIES.mediaStudioExport;
  const exportElapsed = exportState.startedAt ? Math.max(0, (exportState.finishedAt ?? clock.now) - exportState.startedAt) : 0;

  async function startExport() {
    if (!project) return;
    setNotice(null);
    try { const r = await cortexClient.mediaStudioExport(project.id); setJob(r.job); }
    catch (err) { setNotice({ text: (err as Error).message, alert: true }); }
  }
  async function cancelExport() {
    if (!job) return;
    try { setJob((await cortexClient.mediaStudioCancelExport(job.id)).job); }
    catch (err) { setNotice({ text: (err as Error).message, alert: true }); }
  }
  async function removeAsset(a: MediaAsset) {
    if (!project) return;
    try { applyView(await cortexClient.mediaStudioRemoveAsset(project.id, a.id)); void refreshList(); }
    catch (err) { setNotice({ text: (err as Error).message, alert: true }); }
  }

  const videoClips = project?.clips.filter(c => c.trackId === 'V1') ?? [];
  const audioClips = project?.clips.filter(c => c.trackId === 'A1') ?? [];
  const sequenceMs = view?.timeline.durationMs ?? 0;
  const spanMs = Math.max(sequenceMs, ...audioClips.map(c => (c.startMs ?? 0) + clipMs(c)), 1);
  const vTrack = project?.tracks.find(t => t.id === 'V1');
  const aTrack = project?.tracks.find(t => t.id === 'A1');
  const busy = editing || importOp.running;
  const clipLabel = (c: MediaClip) => assetOf(c.assetId)?.name ?? 'clip';
  const fragment = selected && selectedAsset?.kind !== 'image' ? `#t=${selected.inMs / 1000},${selected.outMs / 1000}` : '';

  return (
    <StudioShell
      icon={<Clapperboard size={18} />}
      title="Media Studio"
      onClose={onClose}
      width="min(1240px, calc(100vw - 24px))"
      subtitle={<>100 % local. Montage non destructif : vos fichiers d’origine ne sont jamais modifiés. Projet enregistré à chaque modification. Export MP4 par FFmpeg sur votre machine.</>}
    >
      <div className="ms-layout" data-testid="media-studio">
        <aside className="ms-side" aria-label="Projets et médias">
          <div className="ms-projects">
            <label htmlFor="ms-project">Projet</label>
            <select id="ms-project" value={project?.id ?? ''} onChange={e => { if (e.target.value) void openProject(e.target.value); }}>
              {!project && <option value="">— aucun projet ouvert —</option>}
              {projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.clipCount} clip(s)</option>)}
            </select>
            <button type="button" className="tb-btn" onClick={() => { void createProject().catch(err => setNotice({ text: (err as Error).message, alert: true })); }} disabled={busy}><Plus size={12} aria-hidden="true" /> Nouveau projet</button>
          </div>
          <div
            className={`tb-drop${dragOver ? ' is-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); void importFiles(e.dataTransfer.files); }}
          >
            <button type="button" className="tb-btn tb-btn--primary" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={13} aria-hidden="true" /> Importer vidéo, audio, image</button>
            <span className="tb-hint">ou glissez-les ici · MP4, MOV, WebM, MP3, WAV, OGG, M4A, FLAC, PNG, JPEG, WebP, GIF · 1 Go max</span>
            <input ref={fileRef} type="file" multiple accept="video/*,audio/*,image/png,image/jpeg,image/webp,image/gif" hidden aria-label="Médias à importer" onChange={e => { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }} />
          </div>
          <OperationStatusLine operation={importOp} onRetry={() => { void lastImport.current?.(); }} />
          {importOp.running && importOp.policy.cancellable && <button type="button" className="tb-btn" onClick={importOp.cancel}>Annuler l’import</button>}
          <ul className="ms-assets" aria-label="Médias du projet">
            {project?.assets.map(a => (
              <li key={a.id} className="ms-asset" data-asset={a.name} data-kind={a.kind}>
                <span className="ms-asset-name">{kindIcon(a.kind)} {a.name}</span>
                <span className="ms-asset-meta">
                  {a.kind}{a.durationMs ? ` · ${formatTimecode(a.durationMs)}` : ''}{a.width ? ` · ${a.width}×${a.height}` : ''} · {size(a.size)}{a.kind === 'video' && !a.hasAudio ? ' · sans son' : ''} · {SOURCE_LABEL[a.source.type]}
                </span>
                <span className="ms-asset-actions">
                  {a.kind !== 'audio' && <button type="button" className="tb-btn" disabled={busy} onClick={() => { void edit({ op: 'add', assetId: a.id }); }} aria-label={`Ajouter ${a.name} à la piste vidéo`}><Film size={11} aria-hidden="true" /> Vidéo</button>}
                  {a.hasAudio && <button type="button" className="tb-btn" disabled={busy} onClick={() => { void edit({ op: 'add', assetId: a.id, trackId: 'A1' }); }} aria-label={`Ajouter ${a.name} à la piste audio`}><Music size={11} aria-hidden="true" /> Audio</button>}
                  <button type="button" className="tb-icon" disabled={busy} onClick={() => { void removeAsset(a); }} aria-label={`Retirer ${a.name} du projet`}><Trash2 size={12} aria-hidden="true" /></button>
                </span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="ms-main" aria-label="Montage">
          {notice && <p className={notice.alert ? 'tb-error' : 'tb-notice'} role={notice.alert ? 'alert' : 'status'}>{notice.text}</p>}
          {!project ? (
            <StudioEmptyState message="Créez un projet ou importez un média pour commencer." />
          ) : (
            <>
              <form className="ms-settings" onSubmit={e => { e.preventDefault(); if (nameDraft.trim() && nameDraft !== project.name) void edit({ op: 'settings', name: nameDraft.trim() }, 'Projet renommé.'); }}>
                <label htmlFor="ms-name">Nom</label>
                <input id="ms-name" value={nameDraft} maxLength={80} onChange={e => setNameDraft(e.target.value)} onBlur={e => e.currentTarget.form?.requestSubmit()} />
                <label htmlFor="ms-resolution">Format</label>
                <select id="ms-resolution" value={project.settings.resolution} disabled={busy} onChange={e => { void edit({ op: 'settings', resolution: e.target.value as MediaResolution }); }}>
                  {(Object.keys(RESOLUTION_LABEL) as MediaResolution[]).map(r => <option key={r} value={r}>{RESOLUTION_LABEL[r]}</option>)}
                </select>
                <label htmlFor="ms-fps">Images/s</label>
                <select id="ms-fps" value={project.settings.fps} disabled={busy} onChange={e => { void edit({ op: 'settings', fps: Number(e.target.value) as 24 | 25 | 30 }); }}>
                  {[24, 25, 30].map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <span className="ms-duration" data-testid="ms-duration">Durée : {formatTimecode(sequenceMs)}</span>
              </form>

              <SequencePreview project={project} assetUrl={assetUrl} />

              <div className="ms-timeline" aria-label="Timeline">
                <div className="ms-track" data-track="V1">
                  <div className="ms-track-head">
                    <span>{vTrack?.name ?? 'Vidéo'}</span>
                    <button type="button" className="tb-icon" aria-pressed={vTrack?.muted} aria-label={vTrack?.muted ? 'Rétablir le son de la piste vidéo' : 'Couper le son de la piste vidéo'} disabled={busy} onClick={() => { void edit({ op: 'track', trackId: 'V1', muted: !vTrack?.muted }); }}>{vTrack?.muted ? <VolumeX size={12} aria-hidden="true" /> : <Volume2 size={12} aria-hidden="true" />}</button>
                    <TrackVolume value={vTrack?.volume ?? 1} label="Volume de la piste vidéo" disabled={busy} onCommit={v => { void edit({ op: 'track', trackId: 'V1', volume: v }); }} />
                  </div>
                  <ol className="ms-clips ms-clips--sequence" aria-label="Clips de la piste vidéo (ordre de lecture)">
                    {videoClips.length === 0 && <li className="ms-clips-empty">Ajoutez une vidéo ou une image depuis la liste des médias.</li>}
                    {videoClips.map((c, i) => (
                      <li key={c.id} className={`ms-clip ms-clip--video${c.id === selectedId ? ' is-selected' : ''}${c.muted ? ' is-muted' : ''}`} style={{ flexGrow: clipMs(c) }} data-clip={clipLabel(c)} data-duration={clipMs(c)}>
                        <button type="button" className="ms-clip-main" onClick={() => setSelectedId(c.id)} aria-pressed={c.id === selectedId} aria-label={`Clip ${i + 1} : ${clipLabel(c)}, ${formatTimecode(clipMs(c))}`}>
                          <span className="ms-clip-name">{clipLabel(c)}</span>
                          <span className="ms-clip-meta">{formatTimecode(clipMs(c))}</span>
                        </button>
                        <span className="ms-clip-move">
                          <button type="button" className="tb-icon" disabled={busy || i === 0} onClick={() => { void edit({ op: 'reorder', clipId: c.id, toIndex: i - 1 }); }} aria-label={`Déplacer ${clipLabel(c)} vers la gauche`}><ArrowLeft size={11} aria-hidden="true" /></button>
                          <button type="button" className="tb-icon" disabled={busy || i === videoClips.length - 1} onClick={() => { void edit({ op: 'reorder', clipId: c.id, toIndex: i + 1 }); }} aria-label={`Déplacer ${clipLabel(c)} vers la droite`}><ArrowRight size={11} aria-hidden="true" /></button>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="ms-track" data-track="A1">
                  <div className="ms-track-head">
                    <span>{aTrack?.name ?? 'Audio'}</span>
                    <button type="button" className="tb-icon" aria-pressed={aTrack?.muted} aria-label={aTrack?.muted ? 'Rétablir le son de la piste audio' : 'Couper le son de la piste audio'} disabled={busy} onClick={() => { void edit({ op: 'track', trackId: 'A1', muted: !aTrack?.muted }); }}>{aTrack?.muted ? <VolumeX size={12} aria-hidden="true" /> : <Volume2 size={12} aria-hidden="true" />}</button>
                    <TrackVolume value={aTrack?.volume ?? 1} label="Volume de la piste audio" disabled={busy} onCommit={v => { void edit({ op: 'track', trackId: 'A1', volume: v }); }} />
                  </div>
                  <div className="ms-clips ms-clips--free" aria-label="Clips de la piste audio (position libre)">
                    {audioClips.length === 0 && <span className="ms-clips-empty">Ajoutez un son (musique, voix) depuis la liste des médias.</span>}
                    {audioClips.map(c => (
                      <button key={c.id} type="button" className={`ms-clip ms-clip--audio${c.id === selectedId ? ' is-selected' : ''}${c.muted ? ' is-muted' : ''}`}
                        style={{ left: `${((c.startMs ?? 0) / spanMs) * 100}%`, width: `${(clipMs(c) / spanMs) * 100}%` }}
                        onClick={() => setSelectedId(c.id)} aria-pressed={c.id === selectedId} data-clip={clipLabel(c)} data-start={c.startMs ?? 0}
                        aria-label={`Audio : ${clipLabel(c)}, à ${formatTimecode(c.startMs ?? 0)}, ${formatTimecode(clipMs(c))}`}>
                        <span className="ms-clip-name">{clipLabel(c)}</span>
                      </button>
                    ))}
                    {sequenceMs > 0 && <span className="ms-end-marker" style={{ left: `${(sequenceMs / spanMs) * 100}%` }} title="Fin de la séquence : le son au-delà n’est pas exporté" />}
                  </div>
                </div>
              </div>

              {selected && selectedAsset && (
                <section className="ms-inspector" aria-label={`Clip sélectionné : ${selectedAsset.name}`} data-testid="ms-inspector">
                  <header className="ms-inspector-head">
                    <h3>{kindIcon(selectedAsset.kind)} {selectedAsset.name} <small>({selected.trackId === 'V1' ? 'piste vidéo' : 'piste audio'})</small></h3>
                    <button type="button" className="tb-btn" disabled={busy} onClick={() => { const id = selected.id; setSelectedId(null); void edit({ op: 'delete', clipId: id }, 'Clip supprimé (le média reste dans le projet).'); }}><Trash2 size={12} aria-hidden="true" /> Supprimer le clip</button>
                  </header>
                  <div className="ms-inspector-body">
                    <div className="ms-clip-preview">
                      {selectedAsset.kind === 'image'
                        ? <img src={assetUrl(selectedAsset.id)} alt={`Aperçu de ${selectedAsset.name}`} />
                        : selectedAsset.kind === 'video'
                          ? <video ref={clipPreviewRef} key={`${selected.id}${fragment}`} src={`${assetUrl(selectedAsset.id)}${fragment}`} controls preload="metadata" aria-label={`Aperçu du clip ${selectedAsset.name}`} />
                          : <audio ref={clipPreviewRef} key={`${selected.id}${fragment}`} src={`${assetUrl(selectedAsset.id)}${fragment}`} controls preload="metadata" aria-label={`Aperçu du clip ${selectedAsset.name}`} />}
                    </div>
                    <div className="ms-forms">
                      {selectedAsset.kind === 'image' ? (
                        <form className="tb-panel" onSubmit={e => { e.preventDefault(); void edit({ op: 'update', clipId: selected.id, durationMs: ms(draft.duration) }, 'Durée de l’image modifiée.'); }}>
                          <label htmlFor="ms-duration-input">Durée (s)</label>
                          <input id="ms-duration-input" type="number" min={0.1} step={0.1} value={draft.duration} onChange={e => setDraft(d => ({ ...d, duration: e.target.value }))} />
                          <button type="submit" className="tb-btn" disabled={busy}>Appliquer la durée</button>
                        </form>
                      ) : (
                        <form className="tb-panel" onSubmit={e => { e.preventDefault(); void edit({ op: 'trim', clipId: selected.id, inMs: ms(draft.in), outMs: ms(draft.out) }, 'Clip raccourci (média source intact).'); }}>
                          <label htmlFor="ms-trim-in">Entrée (s)</label>
                          <input id="ms-trim-in" type="number" min={0} step={0.1} value={draft.in} onChange={e => setDraft(d => ({ ...d, in: e.target.value }))} />
                          <label htmlFor="ms-trim-out">Sortie (s)</label>
                          <input id="ms-trim-out" type="number" min={0.1} step={0.1} max={selectedAsset.durationMs ? selectedAsset.durationMs / 1000 : undefined} value={draft.out} onChange={e => setDraft(d => ({ ...d, out: e.target.value }))} />
                          <button type="submit" className="tb-btn" disabled={busy}>Rogner</button>
                          <span className="tb-hint">Média : {formatTimecode(selectedAsset.durationMs ?? 0)}</span>
                        </form>
                      )}
                      <form className="tb-panel" onSubmit={e => { e.preventDefault(); void edit({ op: 'split', clipId: selected.id, atMs: ms(draft.split) }, 'Clip coupé en deux.'); }}>
                        <label htmlFor="ms-split-at">Couper à (s depuis le début du clip)</label>
                        <input id="ms-split-at" type="number" min={0.1} step={0.1} value={draft.split} onChange={e => setDraft(d => ({ ...d, split: e.target.value }))} />
                        <button type="submit" className="tb-btn" disabled={busy}><Scissors size={12} aria-hidden="true" /> Couper</button>
                        {selectedAsset.kind !== 'image' && (
                          <button type="button" className="tb-btn" disabled={busy} onClick={() => { const el = clipPreviewRef.current; if (el) setDraft(d => ({ ...d, split: String(sec(el.currentTime * 1000 - selected.inMs)) })); }}>Position de lecture</button>
                        )}
                      </form>
                      {selected.trackId === 'A1' && (
                        <form className="tb-panel" onSubmit={e => { e.preventDefault(); void edit({ op: 'move', clipId: selected.id, startMs: ms(draft.start) }, 'Son repositionné.'); }}>
                          <label htmlFor="ms-start">Position dans la séquence (s)</label>
                          <input id="ms-start" type="number" min={0} step={0.1} value={draft.start} onChange={e => setDraft(d => ({ ...d, start: e.target.value }))} />
                          <button type="submit" className="tb-btn" disabled={busy}>Placer</button>
                        </form>
                      )}
                      {(selected.trackId === 'A1' || selectedAsset.hasAudio) && (
                        <form className="tb-panel" onSubmit={e => { e.preventDefault(); void edit({ op: 'update', clipId: selected.id, volume: Number(draft.volume) / 100, fadeInMs: ms(draft.fadeIn), fadeOutMs: ms(draft.fadeOut) }, 'Réglages audio appliqués.'); }}>
                          <label htmlFor="ms-volume">Volume (%)</label>
                          <input id="ms-volume" type="number" min={0} max={200} step={5} value={draft.volume} onChange={e => setDraft(d => ({ ...d, volume: e.target.value }))} />
                          <label htmlFor="ms-fade-in">Fondu d’entrée (s)</label>
                          <input id="ms-fade-in" type="number" min={0} step={0.1} value={draft.fadeIn} onChange={e => setDraft(d => ({ ...d, fadeIn: e.target.value }))} />
                          <label htmlFor="ms-fade-out">Fondu de sortie (s)</label>
                          <input id="ms-fade-out" type="number" min={0} step={0.1} value={draft.fadeOut} onChange={e => setDraft(d => ({ ...d, fadeOut: e.target.value }))} />
                          <button type="submit" className="tb-btn" disabled={busy}>Appliquer l’audio</button>
                          <label className="ms-check"><input type="checkbox" checked={selected.muted} disabled={busy} onChange={e => { void edit({ op: 'update', clipId: selected.id, muted: e.target.checked }); }} /> Muet</label>
                        </form>
                      )}
                    </div>
                  </div>
                </section>
              )}

              <section className="ms-export" aria-label="Export" data-testid="ms-export" data-export-status={job?.status ?? 'NONE'}>
                <div className="ms-export-head">
                  <button type="button" className="tb-btn tb-btn--primary" data-testid="ms-export-start" disabled={busy || exportActive || videoClips.length === 0} onClick={() => { void startExport(); }}><Clapperboard size={13} aria-hidden="true" /> Exporter en MP4</button>
                  <span className="tb-hint">{RESOLUTION_LABEL[project.settings.resolution]} · {project.settings.fps} i/s · H.264 + AAC · {formatTimecode(sequenceMs)}</span>
                </div>
                <OperationProgress
                  state={exportState}
                  policy={exportPolicy}
                  elapsedMs={exportElapsed}
                  slow={isSlow(exportState, exportPolicy, clock.now)}
                  onCancel={() => { void cancelExport(); }}
                  cancelLabel="Annuler l’export"
                  cancelAriaLabel="Annuler l’export MP4"
                  onRetry={() => { void startExport(); }}
                  onDismiss={() => setJob(null)}
                  hint={job?.status === 'RUNNING' ? 'L’annulation arrête FFmpeg et supprime le fichier partiel.' : null}
                />
                {job?.status === 'COMPLETED' && (
                  <div className="ms-export-result" data-testid="ms-export-result" role="status">
                    <p>Export terminé · {job.outputSize ? size(job.outputSize) : ''}{job.durationMs ? ` · ${formatTimecode(job.durationMs)}` : ''}</p>
                    <video src={cortexClient.mediaStudioExportUrl(job.id)} controls preload="metadata" aria-label="Aperçu du fichier exporté" />
                    <a className="tb-btn" href={cortexClient.mediaStudioExportUrl(job.id, true)} download><Download size={12} aria-hidden="true" /> Télécharger le MP4</a>
                  </div>
                )}
                {(view?.jobs.length ?? 0) > 0 && (
                  <details className="ms-jobs">
                    <summary>Historique des exports ({view?.jobs.length})</summary>
                    <ul>
                      {view?.jobs.map(j => (
                        <li key={j.id} data-job-status={j.status}>
                          {new Date(j.createdAt).toLocaleString('fr-FR')} — {STATUS_LABEL[j.status]}{j.status === 'COMPLETED' ? <> · <a href={cortexClient.mediaStudioExportUrl(j.id, true)} download>télécharger</a></> : ''}{j.error && j.error !== 'cancelled_by_user' ? ` · ${j.error === 'interrupted_by_restart' ? 'interrompu par un redémarrage' : j.error}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            </>
          )}
        </section>
      </div>
    </StudioShell>
  );
}

function TrackVolume({ value, label, disabled, onCommit }: { value: number; label: string; disabled: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(Math.round(value * 100)));
  useEffect(() => { setDraft(String(Math.round(value * 100))); }, [value]);
  const commit = () => { const v = Number(draft) / 100; if (Number.isFinite(v) && Math.abs(v - value) > 0.001) onCommit(v); };
  return (
    <span className="ms-track-volume">
      <input type="number" min={0} max={200} step={10} value={draft} disabled={disabled} aria-label={`${label} (%)`}
        onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }} />
      <span aria-hidden="true">%</span>
    </span>
  );
}
