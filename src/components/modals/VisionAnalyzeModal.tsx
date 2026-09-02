import { useEffect, useState } from 'react';
import { X, Eye, Type, AlertTriangle, Save, Loader2 } from 'lucide-react';
import { cortexClient, getImageUrl } from '../../lib/cortex/client';
import { useScreenOcr } from '../../hooks/useScreenOcr';

interface Props {
  imageId: string;
  onClose: () => void;
  // engine indicates which local pipeline produced the result — always shown
  // to the user, and saved into the neuron's content.
  onSave: (question: string, resultText: string, engine: 'ocr' | 'vision', modelUsed: string) => void;
}

export default function VisionAnalyzeModal({ imageId, onClose, onSave }: Props) {
  const [question, setQuestion]   = useState('');
  const [answer, setAnswer]       = useState<string | null>(null);
  const [ocrText, setOcrText]     = useState<string | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  const [gpuBusy, setGpuBusy]     = useState(false);
  const [visionModel, setVisionModel] = useState<string>('llava:7b');
  const [saved, setSaved]         = useState(false);
  const ocr = useScreenOcr();

  useEffect(() => {
    cortexClient.visionStatus().then(s => {
      setVisionModel(s.model || 'llava:7b');
      setNotInstalled(!s.installed);
      setGpuBusy(s.gpu_busy === true);
    }).catch(() => {});
  }, []);

  const visionUnavailable = notInstalled || gpuBusy;

  async function handleAnalyzeVision() {
    if (!question.trim() || visionLoading) return;
    setVisionLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await cortexClient.analyzeImage(imageId, question.trim());
      if (!result.ok) {
        if (result.model_installed === false) setNotInstalled(true);
        if (result.gpu_busy) setGpuBusy(true);
        setError(result.error ?? 'Analyse impossible');
        return;
      }
      setAnswer(result.answer ?? '');
      setModelUsed(result.model_used ?? visionModel);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analyse impossible — utilisez l\'OCR à la place.');
    } finally {
      setVisionLoading(false);
    }
  }

  async function handleExtractText() {
    setError(null);
    setAnswer(null);
    const text = await ocr.recognize(getImageUrl(imageId));
    if (text !== null) setOcrText(text.trim());
    else setError(ocr.error ?? 'Extraction OCR impossible');
  }

  const ocrBusy = ocr.phase === 'loading' || ocr.phase === 'recognizing';

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(5,2,12,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 520, maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto',
          background: '#120c22', border: '1px solid rgba(94,231,255,0.2)', borderRadius: 14,
          padding: 20, display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Eye size={16} style={{ color: '#5ee7ff' }} />
            <span className="font-grotesk font-semibold" style={{ color: '#f0eaff' }}>Analyser l'image</span>
          </div>
          <button type="button" onClick={onClose} style={{ color: '#7a6c9a', background: 'none', border: 'none', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <img
          src={getImageUrl(imageId)}
          alt=""
          style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, objectFit: 'contain', margin: '0 auto', display: 'block' }}
        />

        <div style={{ background: 'rgba(255,181,71,0.06)', border: '1px solid rgba(255,181,71,0.15)', borderRadius: 8, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={13} style={{ color: '#ffb547', flexShrink: 0, marginTop: 1 }} />
          <p className="font-mono text-xs" style={{ color: '#ffb547' }}>
            Analyse locale — résultat indicatif, à vérifier. L'OCR se trompe sur les polices stylisées et les images floues ; le modèle de vision 7B est nettement moins précis qu'un modèle cloud. Ni l'un ni l'autre n'invente : si ce n'est pas lisible, il le dit.
          </p>
        </div>

        {notInstalled && (
          <div style={{ background: 'rgba(94,231,255,0.06)', border: '1px solid rgba(94,231,255,0.15)', borderRadius: 8, padding: 12 }}>
            <p className="font-mono text-xs" style={{ color: '#5ee7ff' }}>
              Modèle de vision "{visionModel}" non installé (~4,7 Go, 100% local) — installez-le depuis Réglages → Modèles Ollama pour poser des questions sur l'image. En attendant, l'OCR (extraction de texte) reste disponible ci-dessous.
            </p>
          </div>
        )}
        {!notInstalled && gpuBusy && (
          <div style={{ background: 'rgba(255,181,71,0.06)', border: '1px solid rgba(255,181,71,0.15)', borderRadius: 8, padding: 12 }}>
            <p className="font-mono text-xs" style={{ color: '#ffb547' }}>
              Un autre traitement GPU est en cours (lot, transcription…). La vision est temporairement désactivée pour éviter un échec de chargement — utilisez l'OCR, ou réessayez dans un instant.
            </p>
          </div>
        )}

        {/* ── OCR — toujours disponible ─────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
          <button
            type="button"
            disabled={ocrBusy}
            onClick={() => void handleExtractText()}
            className="flex items-center justify-center gap-2 font-mono text-xs font-semibold"
            style={{
              padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(61,255,170,0.35)',
              background: ocrBusy ? 'rgba(61,255,170,0.05)' : 'rgba(61,255,170,0.14)',
              color: '#3dffaa', cursor: ocrBusy ? 'default' : 'pointer',
            }}
          >
            {ocrBusy
              ? <><Loader2 size={13} className="animate-spin" /> {ocr.phase === 'loading' ? 'Chargement du moteur OCR…' : `Extraction… ${Math.round(ocr.progress * 100)}%`}</>
              : <><Type size={13} /> Extraire le texte (OCR)</>
            }
          </button>

          {ocrText !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Texte extrait — corrigeable avant sauvegarde :</p>
              <textarea
                value={ocrText}
                onChange={e => setOcrText(e.target.value)}
                rows={4}
                className="font-mono text-xs"
                style={{
                  width: '100%', resize: 'vertical', borderRadius: 8, padding: '8px 10px',
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', color: '#f0eaff',
                }}
              />
              <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Moteur : OCR (Tesseract, local)</p>
              <button
                type="button"
                disabled={saved}
                onClick={() => { onSave(question.trim(), ocrText, 'ocr', 'tesseract'); setSaved(true); }}
                className="flex items-center justify-center gap-2 font-mono text-xs font-semibold"
                style={{
                  padding: '8px 12px', borderRadius: 8,
                  border: `1px solid ${saved ? 'rgba(61,255,170,0.2)' : 'rgba(61,255,170,0.35)'}`,
                  background: saved ? 'rgba(61,255,170,0.05)' : 'rgba(61,255,170,0.14)',
                  color: '#3dffaa', cursor: saved ? 'default' : 'pointer',
                }}
              >
                <Save size={13} /> {saved ? 'Neurone créé' : 'Sauvegarder'}
              </button>
            </div>
          )}
        </div>

        {/* ── Vision — si le modèle est installé et le GPU libre ─────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
          <textarea
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="Votre question sur cette image…"
            rows={2}
            disabled={visionUnavailable || visionLoading}
            className="font-mono text-xs"
            style={{
              width: '100%', resize: 'vertical', borderRadius: 8, padding: '8px 10px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', color: '#f0eaff',
              opacity: visionUnavailable ? 0.5 : 1,
            }}
          />
          <button
            type="button"
            disabled={visionUnavailable || visionLoading || !question.trim()}
            onClick={() => void handleAnalyzeVision()}
            className="flex items-center justify-center gap-2 font-mono text-xs font-semibold"
            style={{
              padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(94,231,255,0.35)',
              background: visionUnavailable || visionLoading || !question.trim() ? 'rgba(94,231,255,0.05)' : 'rgba(94,231,255,0.14)',
              color: '#5ee7ff', cursor: visionUnavailable || visionLoading || !question.trim() ? 'default' : 'pointer',
              opacity: visionUnavailable ? 0.5 : 1,
            }}
          >
            {visionLoading
              ? <><Loader2 size={13} className="animate-spin" /> Analyse en cours… (chargement du modèle + inférence, patientez)</>
              : <><Eye size={13} /> Analyser l'image (vision)</>
            }
          </button>
        </div>

        {error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p className="font-mono text-xs" style={{ color: '#ff6b75' }}>⚠ {error}</p>
          </div>
        )}

        {answer && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 12 }}>
              <p className="font-mono text-xs" style={{ color: '#f0eaff', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{answer}</p>
            </div>
            <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Moteur : vision ({modelUsed})</p>
            <button
              type="button"
              disabled={saved}
              onClick={() => { onSave(question.trim(), answer, 'vision', modelUsed ?? visionModel); setSaved(true); }}
              className="flex items-center justify-center gap-2 font-mono text-xs font-semibold"
              style={{
                padding: '8px 12px', borderRadius: 8,
                border: `1px solid ${saved ? 'rgba(61,255,170,0.2)' : 'rgba(61,255,170,0.35)'}`,
                background: saved ? 'rgba(61,255,170,0.05)' : 'rgba(61,255,170,0.14)',
                color: '#3dffaa', cursor: saved ? 'default' : 'pointer',
              }}
            >
              <Save size={13} /> {saved ? 'Neurone créé' : 'Sauvegarder'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
