import { useState } from 'react';
import { X, ExternalLink, AlertTriangle } from 'lucide-react';
import { cortexClient, type LocalAiRecommendationEntry, type OllamaPullProgress } from '../../lib/cortex/client';
import { formatBytes } from '../../lib/ollamaModels';

function isSafeExternalUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function openUrl(url: string | null | undefined) {
  if (!isSafeExternalUrl(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function formatParams(n: number | null): string {
  if (n == null) return 'Unknown';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return String(n);
}

function estimateLabel(confidenceType: string): string {
  switch (confidenceType) {
    case 'OFFICIAL_REQUIREMENT': return 'Official requirement';
    case 'COMMUNITY_ESTIMATE': return 'Community estimate';
    case 'DERIVED_ESTIMATE': return 'Estimated';
    default: return 'Unknown';
  }
}

type InstallStep = 'closed' | 'previewing' | 'preview_ready' | 'preview_blocked' | 'installing' | 'installed' | 'failed';

export function LocalModelDetails({ entry, onClose, onInstalled }: {
  entry: LocalAiRecommendationEntry;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const { model, distribution, fit, installed } = entry;
  const [step, setStep] = useState<InstallStep>('closed');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [progress, setProgress] = useState<OllamaPullProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [verifiedPullName, setVerifiedPullName] = useState<string | null>(null);
  const abortRef = useState<{ current: AbortController | null }>({ current: null })[0];

  const isMoe = model.architecture.type === 'moe';
  const longContextWarning = fit.warnings.some(w => w.includes('LONG_CONTEXT_MEMORY_NOT_INCLUDED'));

  // Mission §16: install only ever offered when executionLocation is LOCAL,
  // the distribution is individually verified, the runtime is Ollama, and
  // fit is not NOT_RECOMMENDED. The backend re-checks every one of these
  // independently in install-preview — this is UI-side gating only, never
  // the trust boundary itself.
  const canAttemptInstall =
    distribution.executionLocation === 'LOCAL' &&
    distribution.verified === true &&
    distribution.runtime === 'OLLAMA' &&
    !!distribution.ollamaPullName &&
    distribution.requiresRemoteCode !== true &&
    fit.rating !== 'NOT_RECOMMENDED';

  async function startPreview() {
    setStep('previewing');
    setPreviewError(null);
    try {
      const result = await cortexClient.localAiInstallPreview(distribution.id);
      if (!result.ok || !result.verifiedOllamaPullName) {
        setPreviewError(result.error ?? 'This model cannot be installed.');
        setStep('preview_blocked');
        return;
      }
      setVerifiedPullName(result.verifiedOllamaPullName);
      setStep('preview_ready');
    } catch (e) {
      setPreviewError((e as Error).message);
      setStep('preview_blocked');
    }
  }

  async function confirmInstall() {
    if (!verifiedPullName) return;
    setStep('installing');
    setInstallError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await cortexClient.pullOllamaModel(verifiedPullName, (event) => setProgress(event), controller.signal);
      setStep('installed');
      onInstalled();
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setStep('preview_ready');
      } else {
        setInstallError((e as Error).message);
        setStep('failed');
      }
    }
  }

  function cancelInstall() {
    abortRef.current?.abort();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(10,6,20,0.7)' }} onClick={onClose}>
      <div
        className="flex flex-col gap-3 p-4 rounded max-w-lg w-full max-h-[85vh] overflow-y-auto"
        style={{ background: '#140c24', border: '1px solid rgba(255,255,255,0.1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>{model.name}</h3>
            <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>{model.publisher} · {model.family}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ color: '#5a4a7a', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {model.provenance === 'community_modified' && (
          <div className="flex items-start gap-2 px-2.5 py-2 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <AlertTriangle size={12} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
            <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}>
              Community-modified weights. Review provenance/license before installation.
            </p>
          </div>
        )}

        <section>
          <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>Why this fits</p>
          <ul className="font-mono list-disc pl-4" style={{ fontSize: 10, color: '#c0b0e0' }}>
            {fit.reasons.map((r, i) => <li key={i}>{r}</li>)}
            {fit.reasons.length === 0 && <li style={{ color: '#5a4a7a' }}>No specific reasons available.</li>}
          </ul>
          {fit.warnings.length > 0 && (
            <ul className="font-mono list-disc pl-4" style={{ fontSize: 10, color: '#f59e0b', marginTop: 4 }}>
              {fit.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </section>

        <section>
          <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>Parameter architecture</p>
          <p className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>
            {isMoe
              ? `${formatParams(model.architecture.totalParameters)} total / ${formatParams(model.architecture.activeParameters)} active (MoE — active parameters affect speed, not memory footprint)`
              : `${formatParams(model.architecture.totalParameters)} parameters (dense)`}
          </p>
        </section>

        <section>
          <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>Hardware requirements</p>
          {distribution.estimatedRequirements ? (
            <p className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>
              {estimateLabel(distribution.estimatedRequirements.confidenceType)} —
              {' '}RAM: {distribution.estimatedRequirements.ramBytes != null ? formatBytes(distribution.estimatedRequirements.ramBytes) : 'Unknown'}
              {distribution.estimatedRequirements.vramBytes != null && `, VRAM: ${formatBytes(distribution.estimatedRequirements.vramBytes)}`}
              {distribution.artifactSizeBytes != null && `, Disk: ${formatBytes(distribution.artifactSizeBytes)}`}
            </p>
          ) : (
            <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>Unknown</p>
          )}
          {longContextWarning && (
            <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b', marginTop: 4 }}>
              ⚠ Long-context memory usage may require additional RAM/VRAM. This estimate does not include KV-cache cost at extended context.
            </p>
          )}
        </section>

        <section>
          <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>Context &amp; capabilities</p>
          <p className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>
            {model.contextLength?.native != null ? `${(model.contextLength.native / 1000).toFixed(0)}K native` : 'Context: Unknown'}
            {model.contextLength?.extended != null && ` → ${(model.contextLength.extended / 1000).toFixed(0)}K extended`}
          </p>
          <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
            {Object.entries(model.capabilities).filter(([, v]) => v).map(([k]) => k).join(' · ') || 'None specified'}
          </p>
        </section>

        <section>
          <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>Runtime</p>
          <p className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>
            {distribution.runtime}
            {distribution.runtime === 'LM_STUDIO' && ' — support: not integrated'}
            {distribution.ollamaPullName && ` — ${distribution.ollamaPullName}`}
          </p>
        </section>

        <section>
          <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>License &amp; provenance</p>
          <p className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>
            License: {model.license ?? 'Unknown'}
            {model.additionalPolicies.length > 0 && ` (+ ${model.additionalPolicies.join(', ')})`}
          </p>
          <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
            Provenance: {model.provenance} · Trust: {model.trustLevel}
          </p>
          {model.upstreamCanonicalId && (
            <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>Upstream: {model.upstreamCanonicalId}</p>
          )}
        </section>

        {model.limitations.length > 0 && (
          <section>
            <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>Limitations</p>
            <ul className="font-mono list-disc pl-4" style={{ fontSize: 10, color: '#c0b0e0' }}>
              {model.limitations.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </section>
        )}

        <section>
          <p className="font-mono uppercase" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>Source verification</p>
          <p className="font-mono" style={{ fontSize: 10, color: distribution.verified ? '#3dffaa' : '#f59e0b' }}>
            {distribution.verified ? 'Individually verified' : 'Not individually verified — install unavailable'}
          </p>
          <div className="flex gap-2 flex-wrap mt-1">
            {isSafeExternalUrl(model.officialSourceUrl) && (
              <button type="button" onClick={() => openUrl(model.officialSourceUrl)} className="font-mono flex items-center gap-1" style={{ fontSize: 9, color: '#5ee7ff', cursor: 'pointer' }}>
                <ExternalLink size={9} /> Official source
              </button>
            )}
            {isSafeExternalUrl(model.huggingFaceUrl) && (
              <button type="button" onClick={() => openUrl(model.huggingFaceUrl)} className="font-mono flex items-center gap-1" style={{ fontSize: 9, color: '#5ee7ff', cursor: 'pointer' }}>
                <ExternalLink size={9} /> Hugging Face
              </button>
            )}
            {isSafeExternalUrl(distribution.sourceUrl) && (
              <button type="button" onClick={() => openUrl(distribution.sourceUrl)} className="font-mono flex items-center gap-1" style={{ fontSize: 9, color: '#5ee7ff', cursor: 'pointer' }}>
                <ExternalLink size={9} /> Ollama
              </button>
            )}
          </div>
        </section>

        {/* --- Install flow: card -> details -> preview -> confirm -> pull. No auto-install. --- */}
        <section className="pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {installed && step === 'closed' && (
            <p className="font-mono" style={{ fontSize: 10, color: '#3dffaa' }}>Already installed in Ollama.</p>
          )}

          {!canAttemptInstall && step === 'closed' && !installed && (
            <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
              {distribution.executionLocation === 'CLOUD'
                ? 'This distribution runs in the cloud and cannot be installed as a local model.'
                : !distribution.verified
                ? 'This exact distribution has not been individually verified and cannot be installed yet.'
                : fit.rating === 'NOT_RECOMMENDED'
                ? 'Not recommended for this machine.'
                : 'Not installable from this view.'}
            </p>
          )}

          {canAttemptInstall && step === 'closed' && (
            <button type="button" onClick={startPreview} className="font-mono text-xs px-3 py-1.5 rounded" style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff', cursor: 'pointer' }}>
              {installed ? 'View install details' : 'Install…'}
            </button>
          )}

          {step === 'previewing' && (
            <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>Checking install preview…</p>
          )}

          {step === 'preview_blocked' && (
            <p className="font-mono" style={{ fontSize: 10, color: '#ff4d58' }}>⚠ {previewError}</p>
          )}

          {step === 'preview_ready' && verifiedPullName && (
            <div className="flex flex-col gap-2">
              <div className="px-2.5 py-2 rounded font-mono" style={{ fontSize: 10, color: '#c0b0e0', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <p>Model: {model.name}</p>
                <p>Publisher: {model.publisher}</p>
                <p>Runtime: {distribution.runtime}</p>
                <p>Exact pull name: {verifiedPullName}</p>
                {distribution.artifactSizeBytes != null && <p>Download size: {formatBytes(distribution.artifactSizeBytes)}</p>}
                <p>License: {model.license ?? 'Unknown'}</p>
                <p>Trust: {model.trustLevel}</p>
                <p>Hardware fit: {fit.rating}</p>
              </div>
              {fit.rating === 'TIGHT' && (
                <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}>
                  ⚠ This model may run slowly or leave limited memory headroom.
                </p>
              )}
              {fit.rating === 'UNKNOWN' && (
                <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}>
                  ⚠ Hardware requirements are not fully known.
                </p>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={confirmInstall} className="font-mono text-xs px-3 py-1.5 rounded" style={{ background: 'rgba(61,255,170,0.1)', border: '1px solid rgba(61,255,170,0.3)', color: '#3dffaa', cursor: 'pointer' }}>
                  INSTALL
                </button>
                <button type="button" onClick={() => setStep('closed')} className="font-mono text-xs px-3 py-1.5 rounded" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#7a6c9a', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {step === 'installing' && (
            <div className="flex flex-col gap-2">
              <p className="font-mono" style={{ fontSize: 10, color: '#5ee7ff' }}>
                {progress?.status ?? 'Installing…'}
                {progress?.total != null && progress?.completed != null && progress.total > 0
                  ? ` (${Math.round((progress.completed / progress.total) * 100)}%)`
                  : ''}
              </p>
              <button type="button" onClick={cancelInstall} className="font-mono text-xs px-3 py-1.5 rounded self-start" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#7a6c9a', cursor: 'pointer' }}>
                Abort
              </button>
            </div>
          )}

          {step === 'installed' && (
            <p className="font-mono" style={{ fontSize: 10, color: '#3dffaa' }}>✅ Installed.</p>
          )}

          {step === 'failed' && (
            <div className="flex flex-col gap-2">
              <p className="font-mono" style={{ fontSize: 10, color: '#ff4d58' }}>⚠ {installError}</p>
              <button type="button" onClick={() => setStep('closed')} className="font-mono text-xs px-3 py-1.5 rounded self-start" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#7a6c9a', cursor: 'pointer' }}>
                Close
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
