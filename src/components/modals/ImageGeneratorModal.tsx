import { useEffect, useState, useCallback } from 'react';
import { Image as ImageIcon, X, Wand2, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { cortexClient, getImageUrl } from '../../lib/cortex/client';
import type { ImageGenProvidersStatus, ImageGenerationRow, ImageGenCapabilities } from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
  strictLocalMode: boolean;
  onOpenSettings?: () => void;
}

type ProviderChoice = 'auto' | 'comfyui' | 'cloudflare' | 'huggingface' | 'pollinations';

const modalStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
};
const panelStyle: React.CSSProperties = {
  width: 720, maxWidth: 'calc(100vw - 24px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
  background: '#0d0f14', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '8px 10px', fontSize: 13, width: '100%',
  fontFamily: 'inherit', outline: 'none',
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
  borderRadius: 6, color: '#a78bfa', padding: '7px 14px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const btnGhostStyle: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8, padding: 12,
};

const SIZE_OPTIONS = [
  { label: '512×512', width: 512, height: 512 },
  { label: '768×768', width: 768, height: 768 },
  { label: '1024×1024', width: 1024, height: 1024 },
];

const DEFAULT_CAPABILITIES: ImageGenCapabilities = {
  text_to_image: true, image_to_image: false, image_edit: false,
  negative_prompt: true, seed: true, custom_size: true,
};

function capabilitiesFor(provider: ProviderChoice, status: ImageGenProvidersStatus | null): ImageGenCapabilities {
  if (!status) return DEFAULT_CAPABILITIES;
  if (provider === 'auto') return DEFAULT_CAPABILITIES;
  if (provider === 'comfyui') return { text_to_image: true, image_to_image: false, image_edit: false, negative_prompt: true, seed: true, custom_size: true };
  return status.providers[provider]?.capabilities ?? DEFAULT_CAPABILITIES;
}

function localityNotice(provider: ProviderChoice, strictLocalMode: boolean): { text: string; tone: 'local' | 'cloud' | 'blocked' } {
  if (strictLocalMode) return { text: 'STRICT LOCAL — CLOUD BLOQUÉ', tone: 'blocked' };
  if (provider === 'comfyui') return { text: 'Génération locale — les données restent sur cette machine.', tone: 'local' };
  if (provider === 'auto') return { text: 'Mode Auto : ComfyUI local essayé en premier (selon la priorité configurée).', tone: 'local' };
  const names: Record<string, string> = { cloudflare: 'Cloudflare', huggingface: 'Hugging Face', pollinations: 'Pollinations' };
  return { text: `Le prompt sera envoyé à ${names[provider] ?? provider}.`, tone: 'cloud' };
}

export default function ImageGeneratorModal({ onClose, strictLocalMode, onOpenSettings }: Props) {
  const [providersStatus, setProvidersStatus] = useState<ImageGenProvidersStatus | null>(null);
  const [provider, setProvider] = useState<ProviderChoice>('auto');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [sizeIndex, setSizeIndex] = useState(0);
  const [steps, setSteps] = useState(20);
  const [seedMode, setSeedMode] = useState<'random' | 'fixed'>('random');
  const [seedValue, setSeedValue] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageGenerationRow | null>(null);
  const [history, setHistory] = useState<ImageGenerationRow[]>([]);

  const reload = useCallback(async () => {
    try {
      const [status, hist] = await Promise.all([
        cortexClient.getImageGenProvidersStatus(),
        cortexClient.getImageGenerationHistory(),
      ]);
      setProvidersStatus(status);
      setHistory(hist.generations ?? []);
    } catch {
      setProvidersStatus(null);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const capabilities = capabilitiesFor(provider, providersStatus);
  const notice = localityNotice(provider, strictLocalMode);
  const comfyuiUnavailable = provider === 'comfyui' && providersStatus?.providers.comfyui.available === false;
  const comfyuiNoModel = provider === 'comfyui' && providersStatus?.providers.comfyui.available === true && providersStatus.providers.comfyui.hasCompatibleModel === false;

  async function handleGenerate() {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    const size = SIZE_OPTIONS[sizeIndex];
    try {
      const params: Parameters<typeof cortexClient.generateImage>[0] = {
        prompt: prompt.trim(),
        width: size.width,
        height: size.height,
        provider: provider === 'auto' ? undefined : provider,
      };
      if (capabilities.negative_prompt && negativePrompt.trim()) params.negativePrompt = negativePrompt.trim();
      if (capabilities.seed && seedMode === 'fixed' && seedValue.trim()) params.seed = Number(seedValue.trim());
      if (provider === 'comfyui' || provider === 'auto') params.steps = steps;

      const res = await cortexClient.generateImage(params);
      const gen = await cortexClient.getImageGeneration(res.generation_id);
      setResult(gen.generation);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ImageIcon size={18} color="#a78bfa" />
            <span style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600 }}>Générateur d'images</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {onOpenSettings && (
              <button type="button" style={btnGhostStyle} onClick={onOpenSettings} title="Paramètres images">
                <SettingsIcon size={14} />
              </button>
            )}
            <button type="button" style={{ ...btnGhostStyle, padding: 6 }} onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelStyle}>Prompt</label>
            <textarea
              style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Un petit robot médecin devant une bibliothèque futuriste, illustration professionnelle, lumière douce."
            />
          </div>

          {capabilities.negative_prompt && (
            <div>
              <label style={labelStyle}>Prompt négatif</label>
              <textarea
                style={{ ...inputStyle, minHeight: 44, resize: 'vertical' }}
                value={negativePrompt}
                onChange={e => setNegativePrompt(e.target.value)}
                placeholder="flou, texte, mains déformées…"
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Provider</label>
              <select style={inputStyle} value={provider} onChange={e => setProvider(e.target.value as ProviderChoice)}>
                <option value="auto">Auto</option>
                <option value="comfyui">ComfyUI local</option>
                <option value="cloudflare">Cloudflare</option>
                <option value="huggingface">Hugging Face</option>
                <option value="pollinations">Pollinations</option>
              </select>
            </div>
            {capabilities.custom_size && (
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Format</label>
                <select style={inputStyle} value={sizeIndex} onChange={e => setSizeIndex(Number(e.target.value))}>
                  {SIZE_OPTIONS.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
                </select>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            {capabilities.seed && (
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Seed</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select style={{ ...inputStyle, width: 'auto' }} value={seedMode} onChange={e => setSeedMode(e.target.value as 'random' | 'fixed')}>
                    <option value="random">Aléatoire</option>
                    <option value="fixed">Valeur</option>
                  </select>
                  {seedMode === 'fixed' && (
                    <input style={inputStyle} type="number" value={seedValue} onChange={e => setSeedValue(e.target.value)} placeholder="12345" />
                  )}
                </div>
              </div>
            )}
            {(provider === 'comfyui' || provider === 'auto') && (
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Steps</label>
                <input style={inputStyle} type="number" min={1} max={150} value={steps} onChange={e => setSteps(Number(e.target.value))} />
              </div>
            )}
          </div>

          <div style={{
            ...cardStyle,
            borderColor: notice.tone === 'blocked' ? 'rgba(248,113,113,0.4)' : notice.tone === 'cloud' ? 'rgba(251,191,36,0.3)' : 'rgba(74,222,128,0.25)',
            color: notice.tone === 'blocked' ? '#f87171' : notice.tone === 'cloud' ? '#fbbf24' : '#4ade80',
            fontSize: 12, fontFamily: 'monospace',
          }}>
            {notice.text}
          </div>

          {comfyuiUnavailable && (
            <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.3)' }}>
              <div style={{ fontSize: 12, color: '#e2e8f0', marginBottom: 8 }}>ComfyUI n'est pas installé.</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {onOpenSettings && <button type="button" style={btnStyle} onClick={onOpenSettings}>Installer</button>}
                {onOpenSettings && <button type="button" style={btnGhostStyle} onClick={onOpenSettings}>Ouvrir les Paramètres</button>}
              </div>
            </div>
          )}

          {comfyuiNoModel && (
            <div style={{ ...cardStyle, borderColor: 'rgba(251,191,36,0.3)' }}>
              <div style={{ fontSize: 12, color: '#e2e8f0', marginBottom: 8 }}>ComfyUI fonctionne mais aucun modèle compatible n'est installé.</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {onOpenSettings && <button type="button" style={btnStyle} onClick={onOpenSettings}>Installer un modèle</button>}
              </div>
            </div>
          )}

          <button
            type="button"
            style={{ ...btnStyle, justifyContent: 'center', opacity: generating || !prompt.trim() ? 0.5 : 1, cursor: generating || !prompt.trim() ? 'not-allowed' : 'pointer' }}
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
          >
            {generating ? <RefreshCw size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {generating ? 'Génération en cours…' : 'Générer'}
          </button>

          {error && (
            <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.4)', color: '#f87171', fontSize: 12 }}>{error}</div>
          )}

          {result?.image_id && (
            <div style={cardStyle}>
              <img
                src={getImageUrl(result.image_id)}
                alt={result.prompt}
                style={{ width: '100%', borderRadius: 6, display: 'block' }}
              />
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', marginTop: 8 }}>
                {result.provider_used} · {result.model_used ?? '—'} · {result.width}×{result.height}
                {result.fallback ? ` · fallback (${result.fallback_reason_code})` : ''}
              </div>
            </div>
          )}

          {history.length > 0 && (
            <div>
              <label style={labelStyle}>Historique récent</label>
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                {history.filter(h => h.image_id).slice(0, 10).map(h => (
                  <img
                    key={h.id}
                    src={getImageUrl(h.image_id as string)}
                    alt={h.prompt}
                    title={h.prompt}
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, flexShrink: 0, cursor: 'pointer' }}
                    onClick={() => setResult(h)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
