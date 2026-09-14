import { useRef, useState } from 'react';
import { X, Crop, Type, Image as ImageIcon, Copy, CheckCircle, AlertTriangle, RefreshCw, RotateCw, Contrast } from 'lucide-react';
import { useScreenOcr } from '../../hooks/useScreenOcr';

interface CropRect { x: number; y: number; w: number; h: number } // normalized 0..1, relative to natural image size

interface Props {
  imageDataUrl:    string;
  onClose:         () => void;
  onSaveImage:     (dataUrl: string) => Promise<void>;
  onSaveText:      (text: string, dataUrl: string | null) => Promise<void>;
  onAnalyzeImage?: (dataUrl: string) => Promise<void>;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  return new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image invalide'));
    img.src = dataUrl;
  });
}

// Otsu's method: picks the grayscale threshold that best splits the image
// into two classes (ink vs. paper) by maximizing between-class variance —
// no manual tuning, and it adapts per-photo rather than using one fixed
// cutoff that would only suit some lighting conditions.
function otsuThreshold(gray: Uint8ClampedArray | number[]): number {
  const histogram = new Array(256).fill(0);
  for (const v of gray) histogram[v]++;
  const total = gray.length;

  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];

  let sumB = 0, wB = 0, best = 0, bestVariance = 0;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > bestVariance) { bestVariance = variance; best = t; }
  }
  return best;
}

// Crop (normalized rect) → rotate (0/90/180/270°) → optional grayscale+contrast
// boost → optional binarization. All local canvas operations — no library, no
// network. Grayscale + contrast is a simple, well-known trick to help
// Tesseract on a photographed document (uneven lighting, low contrast print)
// without a real perspective deskew, which would need much more than a
// "simple" transform. Binarization (pure black/white via Otsu's threshold)
// can help further on a clean, evenly-lit page but can also hurt on uneven
// lighting — left as a separate opt-in toggle rather than bundled into
// "enhance" so it can be tried and compared.
async function transformImage(dataUrl: string, rect: CropRect | null, rotation: 0 | 90 | 180 | 270, enhance: boolean, binarize = false): Promise<string> {
  const img = await loadImage(dataUrl);
  const sx = rect ? Math.round(rect.x * img.naturalWidth)  : 0;
  const sy = rect ? Math.round(rect.y * img.naturalHeight) : 0;
  const sw = rect ? Math.max(1, Math.round(rect.w * img.naturalWidth))  : img.naturalWidth;
  const sh = rect ? Math.max(1, Math.round(rect.h * img.naturalHeight)) : img.naturalHeight;

  const rotated90 = rotation === 90 || rotation === 270;
  const canvas = document.createElement('canvas');
  canvas.width  = rotated90 ? sh : sw;
  canvas.height = rotated90 ? sw : sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(img, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);

  if (enhance || binarize) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    const CONTRAST = 1.35; // gentle boost — enough to help OCR, not enough to blow out fine text
    const grayValues = new Uint8ClampedArray(d.length / 4);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      grayValues[p] = enhance
        ? Math.min(255, Math.max(0, (gray - 128) * CONTRAST + 128))
        : gray;
    }
    if (binarize) {
      const threshold = otsuThreshold(grayValues);
      for (let p = 0; p < grayValues.length; p++) grayValues[p] = grayValues[p] >= threshold ? 255 : 0;
    }
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      d[i] = d[i + 1] = d[i + 2] = grayValues[p];
    }
    ctx.putImageData(imageData, 0, 0);
  }

  return canvas.toDataURL('image/png');
}

export default function ScreenCaptureModal({ imageDataUrl, onClose, onSaveImage, onSaveText, onAnalyzeImage }: Props) {
  const [stage, setStage]     = useState<'preview' | 'result'>('preview');
  const [text, setText]       = useState('');
  const [saving, setSaving]   = useState<'image' | 'neuron' | 'analyze' | null>(null);
  const [copied, setCopied]   = useState(false);
  const [status, setStatus]   = useState<{ ok: boolean; message: string } | null>(null);

  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop]       = useState<CropRect | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  // Simple pre-processing — useful mostly for a photographed document (uneven
  // lighting, slight tilt); harmless to leave off for a clean screenshot.
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [enhance, setEnhance]   = useState(false);
  const [binarize, setBinarize] = useState(false);

  const ocr = useScreenOcr();

  function rotate90() {
    setRotation(prev => (((prev + 90) % 360) as 0 | 90 | 180 | 270));
  }

  function relativePos(e: React.PointerEvent): { x: number; y: number } {
    const el = imgContainerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function handlePointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = relativePos(e);
    dragStartRef.current = p;
    setDragRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragStartRef.current) return;
    const p = relativePos(e);
    setDragRect({ x0: dragStartRef.current.x, y0: dragStartRef.current.y, x1: p.x, y1: p.y });
  }

  function handlePointerUp() {
    if (!dragStartRef.current || !dragRect) { dragStartRef.current = null; return; }
    const x = Math.min(dragRect.x0, dragRect.x1);
    const y = Math.min(dragRect.y0, dragRect.y1);
    const w = Math.abs(dragRect.x1 - dragRect.x0);
    const h = Math.abs(dragRect.y1 - dragRect.y0);
    dragStartRef.current = null;
    // Ignore accidental micro-drags (a click) — keep the full image as the target.
    if (w < 0.02 || h < 0.02) { setCrop(null); setDragRect(null); return; }
    setCrop({ x, y, w, h });
  }

  function clearCrop() { setCrop(null); setDragRect(null); }

  async function handleExtractText() {
    setStatus(null);
    try {
      const cropped = await transformImage(imageDataUrl, crop, rotation, enhance, binarize);
      const result = await ocr.recognize(cropped);
      if (result === null) return; // ocr.error already surfaces the failure reason
      const trimmed = result.trim();
      if (!trimmed) {
        // A successful OCR with no readable text needs an explicit message.
        setStatus({ ok: false, message: 'Aucun texte détecté sur cette image. Rapprochez-vous, améliorez l\'éclairage, ou essayez le recadrage/contraste.' });
        return;
      }
      setText(trimmed);
      setStage('result');
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : 'Extraction du texte impossible' });
    }
  }

  async function handleSaveImage() {
    setSaving('image');
    setStatus(null);
    try {
      const cropped = await transformImage(imageDataUrl, crop, rotation, enhance, binarize);
      await onSaveImage(cropped);
      setStatus({ ok: true, message: 'Neurone créé avec l\'image.' });
      setTimeout(onClose, 900);
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setSaving(null);
    }
  }

  async function handleAnalyzeImage() {
    if (!onAnalyzeImage) return;
    setSaving('analyze');
    setStatus(null);
    try {
      const cropped = await transformImage(imageDataUrl, crop, rotation, enhance, binarize);
      await onAnalyzeImage(cropped);
      onClose();
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setSaving(null);
    }
  }

  async function handleCreateTextNeuron(includeImage: boolean) {
    setSaving('neuron');
    setStatus(null);
    try {
      const cropped = includeImage ? await transformImage(imageDataUrl, crop, rotation, enhance, binarize) : null;
      await onSaveText(text, cropped);
      setStatus({ ok: true, message: 'Neurone créé.' });
      setTimeout(onClose, 900);
    } catch (e) {
      setStatus({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setSaving(null);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be unavailable */ }
  }

  const busy = saving !== null || ocr.phase === 'loading' || ocr.phase === 'recognizing';

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(720px, calc(100vw - 24px))',
          border: '1px solid rgba(94,231,255,0.25)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(94,231,255,0.1)' }}>
          <Crop size={16} style={{ color: '#5ee7ff', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Capture d'écran
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              100% local — l'image ne quitte jamais cette machine
            </p>
          </div>
          <button type="button" title="Fermer" style={{ color: '#5a4a7a' }} onClick={onClose} disabled={busy}>
            <X size={14} />
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {stage === 'preview' && (
            <div className="px-5 py-4 flex flex-col gap-3">
              <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>
                Glissez pour sélectionner une zone précise (facultatif — sans sélection, l'image entière est utilisée).
              </p>
              <div
                ref={imgContainerRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                style={{ position: 'relative', width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', cursor: 'crosshair', touchAction: 'none' }}
              >
                <img src={imageDataUrl} alt="Capture d'écran" style={{ width: '100%', display: 'block', userSelect: 'none', pointerEvents: 'none' }} draggable={false} />
                {(dragRect || crop) && (() => {
                  const r = dragRect
                    ? { x: Math.min(dragRect.x0, dragRect.x1), y: Math.min(dragRect.y0, dragRect.y1), w: Math.abs(dragRect.x1 - dragRect.x0), h: Math.abs(dragRect.y1 - dragRect.y0) }
                    : crop!;
                  return (
                    <div style={{
                      position: 'absolute',
                      left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`,
                      border: '2px solid #5ee7ff', background: 'rgba(94,231,255,0.12)', pointerEvents: 'none',
                    }} />
                  );
                })()}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {crop && (
                  <button type="button" onClick={clearCrop} className="font-mono text-xs" style={{ color: '#5a4a7a', cursor: 'pointer' }}>
                    Effacer la sélection (utiliser l'image entière)
                  </button>
                )}
                <button
                  type="button"
                  onClick={rotate90}
                  className="flex items-center gap-1.5 font-mono text-xs"
                  style={{ color: rotation !== 0 ? '#5ee7ff' : '#7a6c9a', cursor: 'pointer' }}
                  title="Pivoter 90° (photo prise de travers) — appliqué à l'extraction/l'enregistrement, pas à cet aperçu"
                >
                  <RotateCw size={12} /> Pivoter {rotation !== 0 ? `(${rotation}°)` : ''}
                </button>
                <label className="flex items-center gap-1.5 font-mono text-xs" style={{ color: enhance ? '#5ee7ff' : '#7a6c9a', cursor: 'pointer' }}>
                  <input type="checkbox" checked={enhance} onChange={e => setEnhance(e.target.checked)} />
                  <Contrast size={12} /> Améliorer le contraste (utile pour une photo)
                </label>
                <label className="flex items-center gap-1.5 font-mono text-xs" style={{ color: binarize ? '#5ee7ff' : '#7a6c9a', cursor: 'pointer' }} title="Noir et blanc pur — peut aider sur une page propre et bien éclairée, peut nuire si l'éclairage est inégal : à essayer et comparer">
                  <input type="checkbox" checked={binarize} onChange={e => setBinarize(e.target.checked)} />
                  <Contrast size={12} /> Noir &amp; blanc (binarisation)
                </label>
              </div>

              {(ocr.phase === 'loading' || ocr.phase === 'recognizing') && (
                <div className="flex items-center gap-2 font-mono text-xs" style={{ color: '#5ee7ff' }}>
                  <RefreshCw size={12} className="animate-spin" />
                  {ocr.phase === 'loading' ? 'Chargement du moteur OCR (première utilisation)…' : `Extraction du texte… ${Math.round(ocr.progress * 100)}%`}
                </div>
              )}
              {ocr.phase === 'error' && ocr.error && (
                <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{ocr.error}</p>
              )}

              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { void handleExtractText(); }}
                  className="flex-1 flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded"
                  style={{ background: 'rgba(94,231,255,0.1)', border: '1px solid rgba(94,231,255,0.28)', color: '#5ee7ff', cursor: busy ? 'default' : 'pointer', minWidth: 180 }}
                >
                  <Type size={12} /> Extraire le texte
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { void handleSaveImage(); }}
                  className="flex-1 flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded"
                  style={{ background: 'rgba(61,255,170,0.1)', border: '1px solid rgba(61,255,170,0.28)', color: '#3dffaa', cursor: busy ? 'default' : 'pointer', minWidth: 180 }}
                >
                  {saving === 'image' ? <RefreshCw size={12} className="animate-spin" /> : <ImageIcon size={12} />}
                  Enregistrer l'image dans un neurone
                </button>
                {onAnalyzeImage && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { void handleAnalyzeImage(); }}
                    className="flex-1 flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded"
                    style={{ background: 'rgba(94,231,255,0.1)', border: '1px solid rgba(94,231,255,0.28)', color: '#5ee7ff', cursor: busy ? 'default' : 'pointer', minWidth: 180 }}
                  >
                    {saving === 'analyze' ? <RefreshCw size={12} className="animate-spin" /> : '👁'}
                    Analyser (vision locale)
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={onClose}
                  className="font-mono text-xs py-2.5 px-4 rounded"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#9f8fbf', cursor: busy ? 'default' : 'pointer' }}
                >
                  Annuler
                </button>
              </div>
            </div>
          )}

          {stage === 'result' && (
            <div className="px-5 py-4 flex flex-col gap-3">
              <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>
                Texte extrait par OCR local — relisez et corrigez avant de créer le neurone.
              </p>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                rows={10}
                className="font-mono text-xs px-3 py-2 rounded"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', color: '#c8b8e8', resize: 'vertical', lineHeight: 1.6 }}
              />
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={busy || !text.trim()}
                  onClick={() => { void handleCreateTextNeuron(false); }}
                  className="flex-1 flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded"
                  style={{ background: 'rgba(61,255,170,0.1)', border: '1px solid rgba(61,255,170,0.28)', color: '#3dffaa', cursor: busy ? 'default' : 'pointer', minWidth: 160 }}
                >
                  {saving === 'neuron' ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                  Créer un neurone
                </button>
                <button
                  type="button"
                  disabled={busy || !text.trim()}
                  onClick={() => { void handleCreateTextNeuron(true); }}
                  className="font-mono text-xs py-2.5 px-3 rounded"
                  style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff', cursor: busy ? 'default' : 'pointer' }}
                  title="Créer le neurone avec le texte ET l'image en complément"
                >
                  + avec l'image
                </button>
                <button
                  type="button"
                  disabled={!text.trim()}
                  onClick={() => { void handleCopy(); }}
                  className="font-mono text-xs py-2.5 px-3 rounded"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: copied ? '#3dffaa' : '#9f8fbf', cursor: 'pointer' }}
                >
                  <Copy size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                  {copied ? 'Copié !' : 'Copier'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStage('preview')}
                  className="font-mono text-xs py-2.5 px-3 rounded"
                  style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', color: '#5a4a7a', cursor: busy ? 'default' : 'pointer' }}
                >
                  Retour
                </button>
              </div>
            </div>
          )}

          {status && (
            <div
              className="mx-5 mb-4 flex items-center gap-2 px-3 py-2 rounded font-mono text-xs"
              style={{
                background: status.ok ? 'rgba(61,255,170,0.08)' : 'rgba(255,77,88,0.08)',
                border: `1px solid ${status.ok ? 'rgba(61,255,170,0.2)' : 'rgba(255,77,88,0.2)'}`,
                color: status.ok ? '#3dffaa' : '#ff4d58',
              }}
            >
              {status.ok ? <CheckCircle size={12} style={{ flexShrink: 0 }} /> : <AlertTriangle size={12} style={{ flexShrink: 0 }} />}
              {status.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
