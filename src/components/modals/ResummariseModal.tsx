import { useState, useRef } from 'react';
import { X, RefreshCw, Cpu, Zap, Save, MessageSquareWarning } from 'lucide-react';
import { cortexClient, type ResummariseLevel, type ResummariseProgress, type StyleExampleUsed } from '../../lib/cortex/client';
import type { Page } from '../../lib/types';

interface Props {
  page: Page;
  onClose:       () => void;
  onDone:        (summary: string, modelUsed: string) => void;
  onRetranscribe?: () => void;
}

const RESUMMARISE_LEVEL_PROMPT_HINTS: Record<ResummariseLevel, string> = {
  short:      'Résumé très court en français (2-3 phrases maximum) : l\'essentiel uniquement, sans détails ni liste. Markdown simple.',
  standard:   'Analyse ce contenu et produis en français : 1. RÉSUMÉ (3-5 phrases) 2. POINTS CLÉS (5-8 puces) 3. CHIFFRES ET FAITS NOTABLES 4. À RETENIR (1-2 phrases). Markdown propre.',
  detailed:   'Analyse détaillée en français : résumé étendu, points clés développés, arguments et exemples, chiffres, dates et faits notables, à retenir. Markdown propre.',
  exhaustive: 'Compte-rendu exhaustif structuré en français (sections Markdown) : résumé, points principaux, points secondaires, chiffres/dates/faits, conclusion. Markdown propre.',
};

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

  const [result, setResult]             = useState<{ summary: string; modelUsed: string; usedExamples?: StyleExampleUsed[] } | null>(null);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [exampleType, setExampleType]   = useState('');
  const [saveStatus, setSaveStatus]     = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [regenerating, setRegenerating] = useState(false);

  const running = progress !== null;

  async function handleStart() {
    if (!hasTranscription) return;
    setError(null);
    setResult(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ label: 'Initialisation…' });
    try {
      const transcription = meta.transcription_raw as string;
      const r = await cortexClient.resummarise(
        { transcription, level, focus: focus.trim() || undefined, use_powerful: usePowerful },
        (p) => setProgress(p),
        ctrl.signal,
      );
      setResult({ summary: r.summary, modelUsed: r.model_used, usedExamples: r.used_examples });
      setProgress(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message);
        setProgress(null);
      }
    } finally {
      abortRef.current = null;
    }
  }

  async function handleSaveAsExample() {
    if (!result || !exampleType.trim()) return;
    setSaveStatus('Enregistrement…');
    try {
      await cortexClient.saveAsStyleExample({
        title:   `Exemple — ${page.title}`,
        content: result.summary,
        type:    exampleType.trim(),
        source_excerpt: typeof meta.transcription_raw === 'string' ? (meta.transcription_raw as string).slice(0, 500) : undefined,
      });
      setSaveStatus('Exemple enregistré.');
      setShowSaveForm(false);
    } catch (e) {
      setSaveStatus(`Échec : ${(e as Error).message}`);
    }
  }

  async function handleRegenerateWithFeedback() {
    if (!result || !feedbackText.trim()) return;
    setRegenerating(true);
    try {
      const basePrompt = RESUMMARISE_LEVEL_PROMPT_HINTS[level];
      const r = await cortexClient.regenerateSummaryWithFeedback({
        original_prompt: basePrompt,
        bad_output: result.summary,
        feedback: feedbackText.trim(),
      });
      setResult({ summary: r.summary, modelUsed: r.model_used });
      setShowFeedbackForm(false);
      setFeedbackText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegenerating(false);
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
        ) : result ? (
          /* Result — utiliser / sauvegarder comme exemple / régénérer avec un retour */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{
              maxHeight: 220, overflowY: 'auto', fontSize: 11, color: '#c0b0e0', lineHeight: 1.6,
              whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 8, padding: '10px 12px',
            }}>
              {result.summary}
            </div>

            {result.usedExamples && result.usedExamples.length > 0 && (
              <div style={{ fontSize: 10, color: '#5a4a7a' }}>
                Exemples de style utilisés : {result.usedExamples.map(e => e.title).join(', ')}
              </div>
            )}

            {!showSaveForm && !showFeedbackForm && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setShowSaveForm(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace' }}>
                  <Save size={11} /> Sauvegarder comme exemple
                </button>
                <button type="button" onClick={() => setShowFeedbackForm(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace' }}>
                  <MessageSquareWarning size={11} /> Régénérer en précisant ce qui n'allait pas
                </button>
              </div>
            )}

            {showSaveForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em' }}>TYPE DE RÉSUMÉ (ex : vidéo éducative, interview, podcast…)</span>
                <input
                  type="text" value={exampleType} onChange={e => setExampleType(e.target.value)}
                  placeholder="Type de résumé"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#c0b0e0', fontSize: 11, padding: '8px 10px', outline: 'none', fontFamily: 'IBM Plex Mono, monospace' }}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => setShowSaveForm(false)}
                    style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer' }}>
                    Annuler
                  </button>
                  <button type="button" onClick={() => void handleSaveAsExample()} disabled={!exampleType.trim()}
                    style={{ background: 'rgba(94,231,255,0.12)', border: '1px solid rgba(94,231,255,0.3)', borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#5ee7ff', cursor: exampleType.trim() ? 'pointer' : 'default', opacity: exampleType.trim() ? 1 : 0.5 }}>
                    Enregistrer
                  </button>
                </div>
              </div>
            )}
            {saveStatus && <div style={{ fontSize: 10, color: '#7a6c9a' }}>{saveStatus}</div>}

            {showFeedbackForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em' }}>CE QUI N'ALLAIT PAS</span>
                <textarea
                  value={feedbackText} onChange={e => setFeedbackText(e.target.value)}
                  placeholder="Ex : trop long, manque les chiffres clés, ton trop formel…"
                  rows={3}
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#c0b0e0', fontSize: 11, padding: '8px 10px', outline: 'none', fontFamily: 'IBM Plex Mono, monospace', resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => setShowFeedbackForm(false)}
                    style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer' }}>
                    Annuler
                  </button>
                  <button type="button" onClick={() => void handleRegenerateWithFeedback()} disabled={!feedbackText.trim() || regenerating}
                    style={{ background: 'rgba(94,231,255,0.12)', border: '1px solid rgba(94,231,255,0.3)', borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#5ee7ff', cursor: feedbackText.trim() && !regenerating ? 'pointer' : 'default', opacity: feedbackText.trim() && !regenerating ? 1 : 0.5 }}>
                    {regenerating ? 'Régénération…' : 'Régénérer'}
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
              <button type="button" onClick={onClose}
                style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '7px 16px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace' }}>
                Annuler
              </button>
              <button type="button" onClick={() => onDone(result.summary, result.modelUsed)}
                style={{ background: 'rgba(94,231,255,0.12)', border: '1px solid rgba(94,231,255,0.3)', borderRadius: 6, padding: '7px 16px', fontSize: 11, color: '#5ee7ff', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace' }}>
                Utiliser ce résumé
              </button>
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
                    {usePowerful ? 'Modèle puissant — meilleure qualité' : 'Modèle local standard'}
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
