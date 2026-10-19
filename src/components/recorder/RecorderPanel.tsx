// Native Recorder — RECORDER-1 RecorderPanel. Takes a RecorderPort (and, in tests, a CaptureEnv) as props;
// App.tsx mounts it in the product shell. Capture starts only on "Démarrer"; while capturing a
// visible "ENREGISTREMENT EN COURS" bar shows the source, the elapsed time and Stop.
// [REC-DL-1] "Télécharger" appears only on READY recordings (the one just finished, and the recent list).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Pause, Play, Square, X } from 'lucide-react';
import { RecorderCaptureController, browserCaptureEnv, type CaptureEnv, type CaptureSnapshot, type MediaDeviceOption } from '../../lib/recorder/capture-controller';
import {
  SOURCE_LABEL, STATE_LABEL, containerLabel, formatBytes, formatElapsed, isActive, recorderErrorText,
  type RecorderPort, type RecordingDto, type RecordingSource,
} from '../../lib/recorder/recorder-contracts';
import { RecordingDownloadButton } from './RecordingDownloadButton';
import './recorder.css';

const STATUS_TEXT: Record<string, string> = {
  READY: 'Prêt', FAILED: 'Échec', CANCELLED: 'Annulé', MISSING: 'Fichier manquant', DELETING: 'Suppression incomplète', PREPARING: 'En préparation', RECORDING: 'En cours', FINALIZING: 'Finalisation',
};

export function RecorderPanel({ port, env, timesliceMs, maxQueuedBytes, startDownload }: {
  port: RecorderPort; env?: CaptureEnv | null; timesliceMs?: number; maxQueuedBytes?: number; startDownload?: (url: string) => void;
}) {
  const [recent, setRecent] = useState<RecordingDto[] | null>(null);
  const [availability, setAvailability] = useState<'CHECKING' | 'READY' | 'UNAVAILABLE'>('CHECKING');
  const loadRecent = useCallback(async () => {
    try { setRecent((await port.listRecordings({ limit: 10 })).items); setAvailability('READY'); }
    catch { setRecent(null); setAvailability('UNAVAILABLE'); }
  }, [port]);
  // [MASTER WS2] Delete one recording after an explicit confirmation step (two clicks: Supprimer → Confirmer).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteRecording = useCallback(async (recordingId: string) => {
    setDeletingId(recordingId); setDeleteError(null);
    try { await port.deleteRecording(recordingId); setConfirmDeleteId(null); await loadRecent(); }
    catch (e) { setDeleteError(e instanceof Error ? e.message : 'Suppression impossible.'); }
    finally { setDeletingId(null); }
  }, [port, loadRecent]);
  const captureEnv = useMemo(() => env ?? browserCaptureEnv(), [env]);
  const controller = useMemo(() => (captureEnv ? new RecorderCaptureController({ port, env: captureEnv, timesliceMs, maxQueuedBytes }) : null), [port, captureEnv, timesliceMs, maxQueuedBytes]);
  const [snap, setSnap] = useState<CaptureSnapshot | null>(controller?.snapshot ?? null);
  const [source, setSource] = useState<RecordingSource>('SCREEN');
  const [withMic, setWithMic] = useState(false);
  const [title, setTitle] = useState('');
  // [MASTER WS2] Optional device selector. Devices are enumerated (never opened) at mount and refreshed after each
  // capture (labels appear once a permission has been granted). '' = browser default.
  const [devices, setDevices] = useState<MediaDeviceOption[]>([]);
  const [micDeviceId, setMicDeviceId] = useState('');
  const [cameraDeviceId, setCameraDeviceId] = useState('');
  const [, tick] = useState(0);
  const previewRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!controller) return undefined;
    const off = controller.subscribe(setSnap);
    return () => { off(); controller.dispose(); }; // unmount: every track stopped, open session cancelled
  }, [controller]);
  const live = snap?.state === 'RECORDING' || snap?.state === 'PAUSED';
  useEffect(() => { if (!live) return undefined; const t = setInterval(() => tick(n => n + 1), 500); return () => clearInterval(t); }, [live]);
  useEffect(() => { if (previewRef.current) previewRef.current.srcObject = snap?.previewStream ?? null; }, [snap?.previewStream]);
  useEffect(() => { if (snap?.state === 'RECORDING') stopRef.current?.focus(); }, [snap?.state]);
  // the recent list (metadata only) is read at mount and after each capture ends — never a capture, never a download
  useEffect(() => { if (!snap || !isActive(snap.state)) void loadRecent(); }, [snap?.state, loadRecent]); // eslint-disable-line react-hooks/exhaustive-deps
  // [MASTER WS2] Enumerate devices (never opens one) at mount and after each capture — labels fill in post-permission.
  useEffect(() => {
    if (!controller || (snap && isActive(snap.state))) return;
    let cancelled = false;
    void controller.listDevices().then(list => { if (!cancelled) setDevices(list); });
    return () => { cancelled = true; };
  }, [controller, snap?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!controller || !snap) {
    return <section className="rec-card" aria-labelledby="rec-title"><h2 id="rec-title">Enregistreur</h2><p className="rec-alert danger" role="alert">Ce navigateur ne permet pas l’enregistrement vidéo (MediaRecorder indisponible).</p></section>;
  }
  const active = isActive(snap.state);
  const elapsed = controller.snapshot.elapsedMs;
  return (
    <section className="rec-root rec-card" aria-labelledby="rec-title" data-testid="rec-panel" data-state={snap.state}>
      <h2 id="rec-title">Enregistreur</h2>
      {availability === 'UNAVAILABLE' && <p className="rec-alert danger" role="alert" data-testid="rec-unavailable">Recorder indisponible. Vérifiez que le serveur Docteur est démarré, puis rouvrez cet outil.</p>}
      {live && (
        <div className={`rec-live${snap.state === 'PAUSED' ? ' paused' : ''}`} role="status" aria-live="polite" data-testid="rec-live">
          <span className="rec-dot" aria-hidden="true" />
          <span>{STATE_LABEL[snap.state]}</span>
          <span>· {snap.source ? SOURCE_LABEL[snap.source] : ''}{snap.withMic ? ' + micro' : ''}</span>
          <span className="rec-time" data-testid="rec-elapsed" aria-label={`Durée ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</span>
          <button type="button" className="rec-btn start" ref={stopRef} onClick={() => void controller.stop()} data-testid="rec-stop-live"><Square size={12} aria-hidden="true" />Arrêter</button>
        </div>
      )}
      <fieldset className="rec-fieldset" disabled={active}>
        <legend>Source</legend>
        {(['SCREEN', 'CAMERA'] as RecordingSource[]).map(s => (
          <label key={s} className="rec-choice"><input type="radio" name="rec-source" value={s} checked={source === s} onChange={() => setSource(s)} />{SOURCE_LABEL[s]}</label>
        ))}
        <label className="rec-choice"><input type="checkbox" checked={withMic} onChange={e => setWithMic(e.target.checked)} />Inclure le micro</label>
        {source === 'CAMERA' && devices.some(d => d.kind === 'videoinput') && (
          <label className="rec-row"><span className="rec-muted">Caméra</span>
            <select className="rec-input" value={cameraDeviceId} onChange={e => setCameraDeviceId(e.target.value)} disabled={active} data-testid="rec-camera-select" aria-label="Choisir la caméra">
              <option value="">Caméra par défaut</option>
              {devices.filter(d => d.kind === 'videoinput').map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Caméra ${i + 1}`}</option>)}
            </select>
          </label>
        )}
        {withMic && devices.some(d => d.kind === 'audioinput') && (
          <label className="rec-row"><span className="rec-muted">Micro</span>
            <select className="rec-input" value={micDeviceId} onChange={e => setMicDeviceId(e.target.value)} disabled={active} data-testid="rec-mic-select" aria-label="Choisir le micro">
              <option value="">Micro par défaut</option>
              {devices.filter(d => d.kind === 'audioinput').map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Micro ${i + 1}`}</option>)}
            </select>
          </label>
        )}
      </fieldset>
      <label className="rec-row"><span className="rec-muted">Titre (facultatif)</span><input className="rec-input" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} disabled={active} aria-label="Titre de l’enregistrement" /></label>
      <div className="rec-row">
        <button type="button" className="rec-btn start" disabled={active || availability !== 'READY'} onClick={() => void controller.start({ source, withMic, title: title.trim() || undefined, micDeviceId: micDeviceId || undefined, cameraDeviceId: source === 'CAMERA' ? (cameraDeviceId || undefined) : undefined })} data-testid="rec-start">
          <Circle size={12} aria-hidden="true" />Démarrer
        </button>
        {live && snap.canPause && snap.state === 'RECORDING' && <button type="button" className="rec-btn" onClick={() => controller.pause()} data-testid="rec-pause"><Pause size={12} aria-hidden="true" />Pause</button>}
        {live && snap.canPause && snap.state === 'PAUSED' && <button type="button" className="rec-btn" onClick={() => controller.resume()} data-testid="rec-resume"><Play size={12} aria-hidden="true" />Reprendre</button>}
        <button type="button" className="rec-btn" disabled={!live} onClick={() => void controller.stop()} data-testid="rec-stop"><Square size={12} aria-hidden="true" />Arrêter</button>
        <button type="button" className="rec-btn ghost" disabled={!active || snap.state === 'FINALIZING' || snap.state === 'STOPPING'} onClick={() => void controller.cancel()} data-testid="rec-cancel"><X size={12} aria-hidden="true" />Annuler</button>
      </div>
      <p className="rec-muted" role="status" data-testid="rec-state">{STATE_LABEL[snap.state]}</p>
      {snap.previewStream && <video ref={previewRef} className="rec-preview" autoPlay muted playsInline aria-label="Aperçu de la caméra (local)" data-testid="rec-preview" />}
      {(active || snap.state === 'READY') && (
        <dl className="rec-dl" aria-label="Détails de l’enregistrement">
          <dt>Format</dt><dd data-testid="rec-format">{containerLabel(snap.mimeType)}{snap.mimeType ? ` (${snap.mimeType})` : ''}</dd>
          <dt>Taille envoyée</dt><dd data-testid="rec-size">{formatBytes(snap.bytesSent + snap.bytesQueued)}</dd>
        </dl>
      )}
      {snap.state === 'READY' && snap.recording && (
        <p className="rec-alert ok" data-testid="rec-result" data-recording-id={snap.recording.recordingId}>
          Enregistré localement : « {snap.recording.title} » — {formatElapsed(snap.recording.durationMs ?? 0)}, {formatBytes(snap.recording.sizeBytes)}, {containerLabel(snap.recording.mimeType)}.
        </p>
      )}
      {snap.state === 'FAILED' && <p className="rec-alert danger" role="alert" data-testid="rec-error" data-error-code={snap.error ?? ''}><strong>{snap.error}</strong> — {recorderErrorText(snap.error)}</p>}
      {snap.state === 'READY' && snap.recording && <RecordingDownloadButton key={snap.recording.recordingId} port={port} recording={snap.recording} startDownload={startDownload} />}
      {snap.state === 'CANCELLED' && <p className="rec-alert muted" data-testid="rec-cancelled">Enregistrement annulé : rien n’a été conservé.</p>}
      {recent && recent.length > 0 && (
        <section aria-labelledby="rec-recent-title" data-testid="rec-recent">
          <h3 id="rec-recent-title" className="rec-muted">Enregistrements récents</h3>
          <ul className="rec-list">
            {recent.map(r => (
              <li key={r.recordingId} className="rec-row rec-item" data-recording-id={r.recordingId} data-status={r.status}>
                <span className="rec-item-title">{r.title}</span>
                <span className="rec-muted">{STATUS_TEXT[r.status] ?? 'État inconnu'}{r.status === 'READY' ? ` · ${formatElapsed(r.durationMs ?? 0)} · ${formatBytes(r.sizeBytes)} · ${containerLabel(r.mimeType)}` : ''}</span>
                <RecordingDownloadButton port={port} recording={r} startDownload={startDownload} />
                {confirmDeleteId === r.recordingId ? (
                  <span className="rec-confirm" role="group" aria-label="Confirmer la suppression">
                    <span className="rec-muted">Supprimer définitivement ?</span>
                    <button type="button" className="rec-btn danger" disabled={deletingId === r.recordingId} onClick={() => void deleteRecording(r.recordingId)} data-testid="rec-delete-confirm">{deletingId === r.recordingId ? 'Suppression…' : 'Confirmer'}</button>
                    <button type="button" className="rec-btn ghost" disabled={deletingId === r.recordingId} onClick={() => { setConfirmDeleteId(null); setDeleteError(null); }} data-testid="rec-delete-cancel">Annuler</button>
                  </span>
                ) : (
                  <button type="button" className="rec-btn ghost" onClick={() => { setConfirmDeleteId(r.recordingId); setDeleteError(null); }} data-testid="rec-delete" aria-label={`Supprimer l’enregistrement « ${r.title} »`}><X size={12} aria-hidden="true" />Supprimer</button>
                )}
                {deleteError && confirmDeleteId === r.recordingId && <span className="rec-alert danger" role="alert" data-testid="rec-delete-error">{deleteError}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

export default RecorderPanel;
