import { useState } from 'react';
import { cortexClient, type OpenMontageJob } from '../../lib/cortex/client';

export default function OpenMontageOutput({ job }: { job: OpenMontageJob }) {
  const [metadata, setMetadata] = useState<{ width: number; height: number; duration: number } | null>(null);
  const url = cortexClient.getOpenMontageArtifactUrl(job.jobId);
  return (
    <div className="studio-render-output">
      <video controls preload="metadata" aria-label="Aperçu du rendu" src={url}
        onLoadedMetadata={e => {
          const video = e.currentTarget;
          if (video.videoWidth > 0 && video.videoHeight > 0 && Number.isFinite(video.duration)) {
            setMetadata({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
          }
        }}
        onError={() => setMetadata(null)}
      />
      <strong>output.mp4</strong>
      <p>Paramètres demandés : {job.width}×{job.height} @ {job.fps}fps · {job.durationSeconds} s</p>
      <p role="status">{metadata
        ? `Fichier lu : ${metadata.width}×${metadata.height} · ${metadata.duration.toFixed(2)} s. Cadence non mesurée.`
        : 'Métadonnées du fichier non vérifiées — disponibles après chargement de l’aperçu.'}</p>
      <a className="studio-button" href={url} download="output.mp4">Télécharger le MP4</a>
    </div>
  );
}
