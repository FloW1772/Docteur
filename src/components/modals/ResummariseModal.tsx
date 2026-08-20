import { useState, useRef } from 'react';
import { X, RefreshCw, Cpu, Zap } from 'lucide-react';
import { cortexClient, type ResummariseLevel, type ResummariseProgress } from '../../lib/cortex/client';
import type { Page } from '../../lib/types';

interface Props {
  page: Page;
  onClose:       () => void;
  onDone:        (summary: string, modelUsed: string) => void;
  onRetranscribe?: () => void;
}

const LEVELS: { value: ResummariseLevel; label: string; desc: string }[] = [
  { value: 'short',     label: 'Court',    desc: '2-3 phrases — l\'essentiel uniquement' },
  { value: 'standard',  label: 'Standard', desc: 'Résumé + points clés + à retenir (actuel)' },
  { value: 'detailed',  label: 'Détaillé', desc: 'Résumé étendu, arguments, exemples, chiffres' },
  { value: 'exhaustive',label: 'Exhaustif',desc: 'Compte-rendu par sections, proche d\'un rapport' },
];

export default function ResummariseModal({ page, onClose, onDone, onRetranscribe }: Props) {
  const meta = (page.metadata ?? {}) as Record<string, unknown>;
  const hasTranscription = typeof meta.transcription_raw === 'string' && (meta.transcription_raw as string).length > 0;
  const wordCount        = typeof meta.word_count === 'number' ? (meta.word_count as number) : null;
  const currentModel     = typeof meta.model_used === 'string' ? (meta.model_used as string) : null;

  const [level, setLevel]               = useState<ResummariseLevel>('standard');
  const [focus, setFocus]               = useState('');
  const [usePowerful, setUsePowerful]   = useState(false);
  const [progress, setProgress]         = useState<ResummariseProgress | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const running = progress !== null;

  async function handleStart() {
    if (!hasTranscription) return;
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ label: 'Initialisation…' });
    try {
      const transcription = meta.transcription_raw as string;
      const result = await cortexClient.resummarise(
        { transcription, level, focus: focus.trim() || undefined, use_powerful: usePowerful },
        (p) => setProgress(p),
        ctrl.signal,
      );
      onDone(result.summary, result.model_used);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message);
        setProgress(null);
      }
    } finally {
      abortRef.current = null;
    }
  }

  const overlay: React.CSSProperties = {
    position:       'fixed', inset: 0, zIndex: 1200,
    background:     'rgba(5,0,15,0.85)',
    display:        'flex', alignItems: 'center', justifyContent: 'center',
    padding:        16,
  };
  const box: React.CSSProperties = {
    background:     '#0f0b1e',
    border:         '1px solid rgba(94,231,255,0.15)',
    borderRadius:   14,
    width:          '100%', maxWidth: 520,
    padding:        '24px 28px',
    display:        'flex', flexDirection: 'column', gap: 20,
    fontFamily:     'IBM Plex Mono, monospace',
    color:          '#c0b0e0',
  };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={box}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: '#5ee7ff', letterSpacing: '0.05em' }}>
            ↺ RÉGÉNÉRER LE RÉSUMÉ
          </span>
          <button
            type="button"
            onClick={() => { abortRef.current?.abort(); onClose(); }}
            style={{ background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer', padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Video info */}
        <div style={{ fontSize: 11, color: '#7a6c9a', borderLeft: '2px solid rgba(94,231,255,0.15)', paddingLeft: 10 }}>
          <div style={{ color: '#c0b0e0', marginBottom: 2 }}>{page.title}</div>
          {wordCount && <div>{wordCount.toLocaleString('fr-FR')} mots transcrits</div>}
          {currentModel && <div>Résumé actuel : {currentModel}</div>}
        </div>

        {!hasTranscription ? (
          /* No transcription stored */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{
              padding:      '12px 14px',
              borderRadius:  8,
              background:   'rgba(251,191,36,0.06)',
              border:       '1px solid rgba(251,191,36,0.2)',
              fontSize:      11,
              color:        '#fbbf24',
              lineHeight:    1.6,
            }}>
              <strong>Transcription non conservée</strong>
              <br />
              La transcription brute n'a pas été enregistrée lors de l'analyse initiale.
              {wordCount && (
                <>
                  <br />
                  Estimation : {Math.ceil(wordCount / 150)} min de vidéo · retranscription locale en quelques minutes
                </>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#7a6c9a', lineHeight: 1.6 }}>
              Vous pouvez retranscrire la vidéo pour activer la régénération du résumé.
              Les nouvelles analyses conserveront automatiquement la transcription.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose}
                style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 14px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer' }}>
                Annuler
              </button>
              {onRetranscribe && (
                <button type="button" onClick={() => { onClose(); onRetranscribe(); }}
                  style={{ background: 'rgba(94,231,255,0.12)', border: '1px solid rgba(94,231,255,0.3)', borderRadius: 6, padding: '6px 14px', fontSize: 11, color: '#5ee7ff', cursor: 'pointer' }}>
                  Retranscrire la vidéo
                </button>
              )}
            </div>
          </div>
        ) : running ? (
          /* Progress */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <RefreshCw size={14} style={{ color: '#5ee7ff', animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 12, color: '#5ee7ff' }}>{progress?.label ?? 'Analyse…'}</span>
            </div>
            {progress?.total && progress.total > 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 2, background: '#5ee7ff',
                    width: `${Math.round(((progress.step ?? 0) / progress.total) * 100)}%`,
                    transition: 'width 0.3s',
                  }} />
                </div>
                <span style={{ fontSize: 10, color: '#5a4a7a' }}>
                  Étape {progress.step}/{progress.total}
                </span>
              </div>
            )}
            <button type="button" onClick={() => abortRef.current?.abort()}
              style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 14px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer', alignSelf: 'flex-end' }}>
              Annuler
            </button>
          </div>
        ) : (
          /* Configuration */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Level selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em' }}>NIVEAU DE DÉTAIL</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {LEVELS.map(l => (
                  <button
                    key={l.value}
                    type="button"
                    onClick={() => setLevel(l.value)}
                    style={{
                      display:        'flex',
                      alignItems:     'center',
                      gap:             10,
                      padding:        '8px 12px',
                      borderRadius:    8,
                      border:         `1px solid ${level === l.value ? 'rgba(94,231,255,0.4)' : 'rgba(255,255,255,0.06)'}`,
                      background:     level === l.value ? 'rgba(94,231,255,0.08)' : 'transparent',
                      cursor:         'pointer',
                      textAlign:      'left',
                    }}
                  >
                    <span style={{
                      fontSize:    11,
                      color:       level === l.value ? '#5ee7ff' : '#c0b0e0',
                      minWidth:    72,
                      fontWeight:  level === l.value ? 600 : 400,
                    }}>
                      {l.label}
                    </span>
                    <span style={{ fontSize: 10, color: '#5a4a7a' }}>{l.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Focus field */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em' }}>FOCALISER SUR (optionnel)</span>
              <input
                type="text"
                placeholder="Ex : les conseils pratiques, les chiffres clés, la méthode…"
                value={focus}
                onChange={e => setFocus(e.target.value)}
                style={{
                  background:   'rgba(255,255,255,0.03)',
                  border:       '1px solid rgba(255,255,255,0.1)',
                  borderRadius:  6,
                  color:        '#c0b0e0',
                  fontSize:      11,
                  padding:      '8px 10px',
                  outline:      'none',
                  fontFamily:   'IBM Plex Mono, monospace',
                }}
              />
            </div>

            {/* Powerful model toggle */}
            <div style={{
              display:      'flex',
              alignItems:   'center',
              justifyContent: 'space-between',
              padding:      '10px 12px',
              borderRadius:  8,
              background:   'rgba(255,255,255,0.02)',
              border:       '1px solid rgba(255,255,255,0.06)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {usePowerful ? <Zap size={12} style={{ color: '#a78bfa' }} /> : <Cpu size={12} style={{ color: '#5a4a7a' }} />}
                <div>
                  <div style={{ fontSize: 11, color: usePowerful ? '#a78bfa' : '#c0b0e0' }}>
                    {usePowerful ? 'qwen2.5:14b — meilleure qualité' : 'Modèle local standard'}
                  </div>
                  {usePowerful && (
                    <div style={{ fontSize: 10, color: '#7a6c9a', marginTop: 2 }}>
                      Plus lent (2-5 min) — modèle le plus précis disponible
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUsePowerful(p => !p)}
                style={{
                  flexShrink:  0,
                  width:        36, height: 20, borderRadius: 10,
                  background:  usePowerful ? '#a78bfa' : 'rgba(255,255,255,0.1)',
                  border:      `1px solid ${usePowerful ? '#a78bfa' : 'rgba(255,255,255,0.15)'}`,
                  position:    'relative', cursor: 'pointer', transition: 'all 0.2s',
                }}
              >
                <span style={{
                  position:    'absolute', top: 2, left: usePowerful ? 18 : 2,
                  width:        14, height: 14, borderRadius: 7,
                  background:  usePowerful ? '#0a0014' : '#5a4a7a',
                  transition:  'left 0.2s',
                }} />
              </button>
            </div>

            {/* Error */}
            {error && (
              <div style={{ fontSize: 11, color: '#f87171', padding: '8px 10px', borderRadius: 6, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
                {error}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose}
                style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '7px 16px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace' }}>
                Annuler
              </button>
              <button type="button" onClick={handleStart}
                style={{ background: 'rgba(94,231,255,0.12)', border: '1px solid rgba(94,231,255,0.3)', borderRadius: 6, padding: '7px 16px', fontSize: 11, color: '#5ee7ff', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={11} />
                Régénérer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
