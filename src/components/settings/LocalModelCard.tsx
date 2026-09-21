import { HardDrive } from 'lucide-react';
import type { LocalAiRecommendationEntry, FitRating, TrustLevel } from '../../lib/cortex/client';
import { formatBytes } from '../../lib/ollamaModels';

// Never presents a fit rating as a "best model" ranking — only ever labels
// what a specific card is good for (mission AI-4 §8): "Recommended for this
// PC", "Good fit for coding", "Low-resource option", etc. No "#1"/"BEST".

const FIT_STYLES: Record<FitRating, { label: string; color: string }> = {
  EXCELLENT: { label: 'EXCELLENT', color: '#3dffaa' },
  GOOD: { label: 'GOOD', color: '#5ee7ff' },
  TIGHT: { label: 'TIGHT', color: '#f59e0b' },
  NOT_RECOMMENDED: { label: 'NOT RECOMMENDED', color: '#ff4d58' },
  UNKNOWN: { label: 'UNKNOWN', color: '#7a6c9a' },
};

const TRUST_STYLES: Record<TrustLevel, { label: string; color: string }> = {
  OFFICIAL: { label: 'OFFICIAL', color: '#3dffaa' },
  VERIFIED_COMMUNITY: { label: 'VERIFIED COMMUNITY', color: '#5ee7ff' },
  COMMUNITY: { label: 'COMMUNITY', color: '#f59e0b' },
  UNVERIFIED: { label: 'UNVERIFIED', color: '#ff4d58' },
};

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

export function LocalModelCard({ entry, badge, onOpenDetails }: {
  entry: LocalAiRecommendationEntry;
  badge?: string;
  onOpenDetails: () => void;
}) {
  const { model, distribution, fit, installed } = entry;
  const fitStyle = FIT_STYLES[fit.rating];
  const trustStyle = TRUST_STYLES[model.trustLevel];
  const isMoe = model.architecture.type === 'moe';
  const longContextWarning = fit.warnings.some(w => w.includes('LONG_CONTEXT_MEMORY_NOT_INCLUDED'));

  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="text-left px-3 py-3 rounded flex flex-col gap-1.5 w-full"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer' }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {badge && (
          <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, color: '#c0b0e0', border: '1px solid rgba(192,176,224,0.25)', background: 'rgba(192,176,224,0.08)' }}>
            {badge}
          </span>
        )}
        <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>{model.name}</span>
        {installed && (
          <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, color: '#3dffaa', border: '1px solid rgba(61,255,170,0.3)', background: 'rgba(61,255,170,0.08)' }}>
            INSTALLED
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>
        <span>{model.publisher}</span>
        <span
          title={fit.reasons.concat(fit.warnings).join(' • ') || 'No details available'}
          className="px-1.5 py-0.5 rounded"
          style={{ color: fitStyle.color, border: `1px solid ${fitStyle.color}40`, background: `${fitStyle.color}14` }}
        >
          {fitStyle.label}
        </span>
        <span className="px-1.5 py-0.5 rounded" style={{ color: trustStyle.color, border: `1px solid ${trustStyle.color}40`, background: `${trustStyle.color}14` }}>
          {trustStyle.label}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>
        {isMoe ? (
          <span>{formatParams(model.architecture.totalParameters)} total / {formatParams(model.architecture.activeParameters)} active</span>
        ) : (
          <span>{formatParams(model.architecture.totalParameters)} params</span>
        )}
        {distribution.artifactSizeBytes != null && (
          <span className="flex items-center gap-1"><HardDrive size={9} /> {formatBytes(distribution.artifactSizeBytes)}</span>
        )}
        {model.contextLength?.native != null && <span>{(model.contextLength.native / 1000).toFixed(0)}K ctx</span>}
      </div>

      {entry.distribution.estimatedRequirements && (
        <p className="font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>
          {estimateLabel(entry.distribution.estimatedRequirements.confidenceType)} RAM:{' '}
          {entry.distribution.estimatedRequirements.ramBytes != null ? formatBytes(entry.distribution.estimatedRequirements.ramBytes) : 'Unknown'}
          {entry.distribution.estimatedRequirements.vramBytes != null && ` · VRAM: ${formatBytes(entry.distribution.estimatedRequirements.vramBytes)}`}
        </p>
      )}

      {longContextWarning && (
        <p className="font-mono" style={{ fontSize: 9, color: '#f59e0b' }}>
          ⚠ Long-context memory usage may require additional RAM/VRAM.
        </p>
      )}

      {model.license == null && (
        <p className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>License: Unknown</p>
      )}
    </button>
  );
}
