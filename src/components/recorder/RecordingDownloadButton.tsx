// [REC-DL-1] "Télécharger" for ONE recording. Rendered only for a READY recording (canDownload). On a user click /
// Enter / Space: HEAD preflight (the server validates the real file through openRecording), then the browser's native
// download of the same URL. "Téléchargement lancé" means the browser received the download, never "téléchargé".
import { useState } from 'react';
import { Download } from 'lucide-react';
import { DOWNLOAD_LABEL, canDownload, downloadStateForError, type DownloadState, type RecorderPort, type RecordingDto } from '../../lib/recorder/recorder-contracts';
import { startNativeDownload } from '../../lib/recorder/native-download';
import './recorder.css';

export function RecordingDownloadButton({ port, recording, startDownload = startNativeDownload }: {
  port: RecorderPort; recording: Pick<RecordingDto, 'recordingId' | 'status' | 'title'>; startDownload?: (url: string) => void;
}) {
  const [state, setState] = useState<DownloadState>('IDLE');
  if (!canDownload(recording)) return null;
  const blocked = state === 'CHECKING' || state === 'MISSING' || state === 'UNAVAILABLE';
  async function go() {
    if (blocked) return;
    setState('CHECKING');
    try {
      await port.checkDownload(recording.recordingId);
      startDownload(port.downloadUrl(recording.recordingId));
      setState('STARTED');
    } catch (e) { setState(downloadStateForError((e as { code?: string })?.code)); }
  }
  const label = state === 'MISSING' || state === 'UNAVAILABLE' ? DOWNLOAD_LABEL[state] : state === 'CHECKING' ? DOWNLOAD_LABEL.CHECKING : DOWNLOAD_LABEL.IDLE;
  return (
    <span className="rec-row" data-testid="rec-download" data-recording-id={recording.recordingId} data-download-state={state}>
      <button type="button" className="rec-btn" onClick={() => void go()} disabled={blocked} aria-busy={state === 'CHECKING'}
        aria-label={`${label} : ${recording.title}`} data-testid="rec-download-btn">
        <Download size={12} aria-hidden="true" />{label}
      </button>
      {(state === 'STARTED' || state === 'ERROR') && (
        <span className={state === 'ERROR' ? 'rec-alert danger' : 'rec-muted'} role="status" data-testid="rec-download-status">
          {state === 'STARTED' ? 'Téléchargement lancé (voir les téléchargements du navigateur).' : 'Erreur : le téléchargement n’a pas pu démarrer.'}
        </span>
      )}
    </span>
  );
}
