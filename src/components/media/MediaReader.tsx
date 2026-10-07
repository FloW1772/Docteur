import { Component, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Clapperboard, ExternalLink, Download, FileText, Inbox, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react';
import { MarkdownContent } from '../../lib/renderMd';
// [Browser Media Bridge V1] one loading system (F2), reuse/import bridges, failure isolation
import OperationProgress from '../loading/OperationProgress';
import OperationStatusLine from '../loading/OperationStatusLine';
import LoadingSpinner from '../loading/LoadingSpinner';
import { useLongOperation, useOperationClock } from '../../hooks/useLongOperation';
import { IDLE_OPERATION, OPERATION_POLICIES, isSlow, type OperationState } from '../../lib/loading/operation';
import { docteurApiOrigin } from '../../lib/media/docteur-origin';
import {
  KIND_LABEL, LOAD_TIMEOUT_MS, SLOW_AFTER_MS, UNSUPPORTED_MESSAGE, classifyMediaResource, fetchPdfBytes, fetchTextResource,
  initialReaderState, mediaErrorEvent, readerReducer, type MediaDescriptor, type ReaderEvent,
} from '../../lib/media/media-resource';

// Media Reader V1 — the single "open in Docteur" viewer. The link next to the button still opens the original source;
// this reader decides the viewer from classifyMediaResource() and always shows a real state: loading → ready | error |
// unsupported (never an empty box, never an endless spinner). Nothing is executed: no HTML injection, no remote page in
// an iframe, no new server route. Everything it creates (timers, fetches, object URLs, media downloads) dies on close.

export interface MediaReaderRequest {
  /** increments on every open: reopening / switching media remounts the reader with a fresh state */
  requestId: number;
  url: string;
  title?: string | null;
  mimeType?: string | null;
}

export interface CapturedPageView { id: string; title: string; text: string }

interface Props {
  request: MediaReaderRequest;
  /** Docteur API origin (its local media routes are allowed); defaults to the client's own API base */
  apiOrigin?: string | null;
  onClose: () => void;
  /** an already-captured article for this URL (web bridge); may load the neuron's content on demand (existing lazy loader) */
  resolveCapturedPage?: (url: string) => Promise<CapturedPageView | null>;
  onNavigateToPage?: (pageId: string) => void;
  /** existing Browser module (POST /api/browser/open): user's selected browser, http(s) validated server-side */
  onOpenInBrowser?: (url: string) => Promise<void>;
  /** [Browser Media Bridge V1] hand the PDF bytes already read by the reader to the local PDF workshop */
  onOpenPdfInToolbox?: (file: File) => Promise<void>;
  /** [Browser Media Bridge V1] open the existing capture flow prefilled with this link (the user confirms) */
  onCaptureUrl?: (url: string) => void;
  /** [Media Studio V1] send a video / audio / image the reader could load to the local Media Studio */
  onSendToMediaStudio?: (media: { url: string; title: string; kind: 'video' | 'audio' | 'image' }) => void;
}

type Dispatch = (event: ReaderEvent) => void;

const panelBorder = 'rgba(167,139,250,0.28)';
const actionStyle = (color: string) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', textDecoration: 'none',
  background: `${color}14`, border: `1px solid ${color}55`, color, fontSize: 12, fontFamily: 'IBM Plex Mono, monospace',
});

export default function MediaReader({ request, apiOrigin = docteurApiOrigin(), onClose, resolveCapturedPage, onNavigateToPage, onOpenInBrowser, onOpenPdfInToolbox, onCaptureUrl, onSendToMediaStudio }: Props) {
  const descriptor = useMemo(
    () => classifyMediaResource({ url: request.url, title: request.title, mimeType: request.mimeType }, { apiOrigin }),
    [request.url, request.title, request.mimeType, apiOrigin],
  );
  const [state, dispatch] = useReducer(readerReducer, descriptor, initialReaderState);
  const [attempt, setAttempt] = useState(0);
  const [signal, setSignal] = useState<AbortSignal | undefined>(undefined);
  const timersRef = useRef<number[]>([]);
  const loading = state.phase === 'OPENING' || state.phase === 'LOADING';

  // one load attempt = one AbortController + a "slow" hint + a hard timeout; all of it is torn down on close / retry
  useEffect(() => {
    if (initialReaderState(descriptor).phase !== 'OPENING') return undefined;
    const controller = new AbortController();
    setSignal(controller.signal);
    dispatch({ type: 'start' });
    const slow = window.setTimeout(() => dispatch({ type: 'slow' }), SLOW_AFTER_MS);
    const timeout = window.setTimeout(() => { dispatch({ type: 'timeout' }); controller.abort(); }, LOAD_TIMEOUT_MS);
    timersRef.current = [slow, timeout];
    return () => { window.clearTimeout(slow); window.clearTimeout(timeout); controller.abort(); };
  }, [descriptor, attempt]);

  // READY / ERROR / UNSUPPORTED: the pending "slow" / timeout timers of this attempt must not fire any more
  useEffect(() => {
    if (!loading) { timersRef.current.forEach(id => window.clearTimeout(id)); timersRef.current = []; }
  }, [loading]);

  useEffect(() => {
    // capture phase: Escape closes the reader only, it never reaches the app shortcuts underneath
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const retry = () => setAttempt(a => a + 1);
  const viewerKey = `${descriptor.id}#${attempt}`;
  const showSourceLink = !descriptor.blocked;
  // F2 display of the load (the reader's own event-driven state machine stays the source of truth)
  const clock = useOperationClock(loading);
  const loadPolicy = OPERATION_POLICIES.mediaReader;
  const loadState: OperationState = { ...IDLE_OPERATION, status: loading ? 'running' : 'idle', label: 'Chargement du média…', step: `${KIND_LABEL[descriptor.kind]} · ${descriptor.host || descriptor.title}`, startedAt: clock.startedAt ?? clock.now };
  const canCapture = Boolean(onCaptureUrl) && !descriptor.blocked && (descriptor.kind === 'youtube' || descriptor.kind === 'web');
  // [Media Studio V1] only once the media really loaded in the reader (the studio re-checks the bytes server-side)
  const studioKind = descriptor.kind === 'video' || descriptor.kind === 'audio' || descriptor.kind === 'image' ? descriptor.kind : null;
  const canSendToStudio = Boolean(onSendToMediaStudio) && !descriptor.blocked && studioKind !== null && state.phase === 'READY';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Lecteur Docteur : ${descriptor.title}`}
      data-testid="media-reader"
      data-phase={state.phase}
      data-kind={descriptor.kind}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(4,2,12,0.88)', backdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: descriptor.kind === 'text' || descriptor.kind === 'web' ? 820 : 960, maxHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0 }}>
          <span className="font-mono" data-testid="media-reader-kind" style={{ fontSize: 10, letterSpacing: '0.08em', padding: '2px 7px', borderRadius: 4, background: 'rgba(167,139,250,0.15)', border: `1px solid ${panelBorder}`, color: '#c4b5fd', flexShrink: 0 }}>
            {KIND_LABEL[descriptor.kind].toUpperCase()}
          </span>
          <span data-testid="media-reader-title" style={{ color: '#b0a0d0', fontSize: 13, fontFamily: 'Space Grotesk, sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {descriptor.title}
          </span>
          {canCapture && (
            <button type="button" data-testid="media-reader-capture" onClick={() => onCaptureUrl?.(descriptor.url)} title="Capturer ce contenu comme neurone (vous confirmez dans la fenêtre de capture)" style={{ ...actionStyle('#3dffaa'), padding: '3px 9px', flexShrink: 0 }}>
              <Inbox size={12} /> Capturer dans Docteur
            </button>
          )}
          {canSendToStudio && studioKind && (
            <button type="button" data-testid="media-reader-send-studio" onClick={() => onSendToMediaStudio?.({ url: descriptor.url, title: descriptor.title, kind: studioKind })} title="Ajouter ce média à un projet du Media Studio (copie locale, l’original n’est pas modifié)" style={{ ...actionStyle('#ffb86b'), padding: '3px 9px', flexShrink: 0 }}>
              <Clapperboard size={12} /> Envoyer au Media Studio
            </button>
          )}
          {showSourceLink && (
            <a href={descriptor.url} target="_blank" rel="noopener noreferrer" data-testid="media-reader-source" title="Ouvrir la source originale" style={{ ...actionStyle('#5ee7ff'), padding: '3px 9px', flexShrink: 0 }}>
              <ExternalLink size={12} /> Ouvrir la source
            </a>
          )}
          <button type="button" data-testid="media-reader-close" aria-label="Fermer le lecteur" title="Fermer" onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#7060a0', cursor: 'pointer', padding: '0 4px', flexShrink: 0 }}
            onMouseEnter={e => { e.currentTarget.style.color = '#ff4dcb'; }} onMouseLeave={e => { e.currentTarget.style.color = '#7060a0'; }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', background: 'rgba(12,9,22,0.96)', border: `1px solid ${panelBorder}`, boxShadow: '0 24px 64px rgba(0,0,0,0.7)', minHeight: 220, flex: '1 1 auto', display: 'flex', flexDirection: 'column' }}>
          {state.phase !== 'ERROR' && state.phase !== 'UNSUPPORTED' && !descriptor.blocked && (
            <div style={{ visibility: state.phase === 'READY' ? 'visible' : 'hidden', flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <ViewerBoundary key={viewerKey} descriptor={descriptor} onRetry={retry} onOpenInBrowser={onOpenInBrowser}>
                <Viewer descriptor={descriptor} dispatch={dispatch} signal={signal}
                  resolveCapturedPage={resolveCapturedPage} onNavigateToPage={onNavigateToPage} onOpenInBrowser={onOpenInBrowser} onOpenPdfInToolbox={onOpenPdfInToolbox} />
              </ViewerBoundary>
            </div>
          )}

          {loading && (
            <div data-testid="media-reader-loading" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <div style={{ width: 'min(420px, 100%)' }}>
                <OperationProgress
                  state={loadState}
                  policy={loadPolicy}
                  elapsedMs={clock.now - (loadState.startedAt ?? clock.now)}
                  slow={state.slow || isSlow(loadState, loadPolicy, clock.now)}
                  slowTestId="media-reader-slow"
                  onCancel={onClose}
                  cancelLabel="Fermer"
                  cancelAriaLabel="Annuler le chargement et fermer le lecteur"
                />
              </div>
            </div>
          )}

          {(state.phase === 'ERROR' || state.phase === 'UNSUPPORTED') && (
            <Fallback descriptor={descriptor} phase={state.phase} message={state.message} onRetry={state.phase === 'ERROR' && !descriptor.blocked ? retry : undefined} onOpenInBrowser={onOpenInBrowser} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── viewers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ViewerProps {
  descriptor: MediaDescriptor;
  dispatch: Dispatch;
  signal: AbortSignal | undefined;
  resolveCapturedPage?: Props['resolveCapturedPage'];
  onNavigateToPage?: Props['onNavigateToPage'];
  onOpenInBrowser?: Props['onOpenInBrowser'];
  onOpenPdfInToolbox?: Props['onOpenPdfInToolbox'];
}

/**
 * A viewer that crashes stays inside the reader: explicit error + retry, the rest of Docteur
 * (and the neuron behind) keeps working.
 */
class ViewerBoundary extends Component<{ descriptor: MediaDescriptor; onRetry: () => void; onOpenInBrowser?: Props['onOpenInBrowser']; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn('[MediaReader] viewer failed', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Fallback descriptor={this.props.descriptor} phase="ERROR" message="Le lecteur de ce média a rencontré une erreur. Le reste de Docteur n’est pas affecté." onRetry={this.props.onRetry} onOpenInBrowser={this.props.onOpenInBrowser} />;
  }
}

/** Last line of defence around the whole reader overlay (used by App): a reader crash never takes the app down. */
export class MediaReaderBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn('[MediaReader] reader failed', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alertdialog" aria-modal="true" aria-label="Lecteur Docteur indisponible" data-testid="media-reader-crashed" style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(4,2,12,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center' }}>
          <AlertTriangle size={26} style={{ color: '#ff4d58' }} />
          <p className="font-mono text-sm" style={{ color: '#ff8a92' }}>Le lecteur a rencontré une erreur inattendue. Vos neurones ne sont pas affectés.</p>
          <button type="button" autoFocus onClick={this.props.onClose} style={actionStyle('#c4b5fd')}>Fermer</button>
        </div>
      </div>
    );
  }
}

function Viewer(props: ViewerProps) {
  switch (props.descriptor.kind) {
    case 'youtube': return <YouTubeViewer {...props} />;
    case 'video': return <NativeMediaViewer {...props} element="video" />;
    case 'audio': return <NativeMediaViewer {...props} element="audio" />;
    case 'image': return <ImageViewer {...props} />;
    case 'pdf': return <PdfViewer {...props} />;
    case 'text': return <TextViewer {...props} />;
    case 'web': return <WebViewer {...props} />;
    default: return null;
  }
}

function YouTubeViewer({ descriptor, dispatch }: ViewerProps) {
  // same embed as the historical player (youtube-nocookie, autoplay, same permissions)
  return (
    <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0 }}>
      <iframe
        data-testid="media-reader-youtube"
        src={descriptor.youtube?.embedUrl}
        onLoad={() => dispatch({ type: 'ready' })}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        title={descriptor.title}
      />
    </div>
  );
}

function NativeMediaViewer({ descriptor, dispatch, element }: ViewerProps & { element: 'video' | 'audio' }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const media = ref.current;
    return () => { // stop the download / decoder, not just the sound
      if (!media) return;
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
  }, []);
  const onReady = () => {
    dispatch({ type: 'ready' });
    ref.current?.play().catch(() => { /* autoplay refused: the controls are there */ });
  };
  const onError = () => {
    const event = mediaErrorEvent(ref.current?.error?.code);
    dispatch(event.type === 'unsupported' && descriptor.nativeSupport === 'uncertain'
      ? { type: 'unsupported', message: `${UNSUPPORTED_MESSAGE} Le format .${descriptor.extension} n’est pas décodé par ce moteur.` }
      : event);
  };
  const common = { ref, src: descriptor.url, controls: true, preload: 'metadata' as const, onLoadedMetadata: onReady, onError };
  return element === 'video'
    ? <video {...common} data-testid="media-reader-video" playsInline style={{ width: '100%', maxHeight: '75vh', background: '#000', display: 'block' }} />
    : (
      <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'stretch', justifyContent: 'center', flex: 1 }}>
        <div className="font-grotesk" style={{ color: '#e6dcff', fontSize: 15, textAlign: 'center' }}>♪ {descriptor.title}</div>
        <audio {...common} data-testid="media-reader-audio" style={{ width: '100%' }} />
      </div>
    );
}

function ImageViewer({ descriptor, dispatch }: ViewerProps) {
  const [actualSize, setActualSize] = useState(false);
  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: actualSize ? 'auto' : 'hidden', maxHeight: '78vh', background: 'rgba(0,0,0,0.35)' }}>
      <img
        data-testid="media-reader-image"
        src={descriptor.url}
        alt={descriptor.title}
        referrerPolicy="no-referrer"
        onLoad={() => dispatch({ type: 'ready' })}
        onError={() => dispatch({ type: 'error', message: 'Image inaccessible ou format non pris en charge.' })}
        onClick={() => setActualSize(v => !v)}
        style={actualSize
          ? { maxWidth: 'none', maxHeight: 'none', cursor: 'zoom-out' }
          : { maxWidth: '100%', maxHeight: '78vh', objectFit: 'contain', cursor: 'zoom-in', display: 'block' }}
      />
      <button type="button" data-testid="media-reader-zoom" onClick={() => setActualSize(v => !v)} aria-label={actualSize ? 'Ajuster à la fenêtre' : 'Taille réelle'}
        style={{ position: 'absolute', right: 10, bottom: 10, ...actionStyle('#c4b5fd'), padding: '4px 8px' }}>
        {actualSize ? <Minimize2 size={12} /> : <Maximize2 size={12} />} {actualSize ? 'Ajuster' : 'Taille réelle'}
      </button>
    </div>
  );
}

function PdfViewer({ descriptor, dispatch, signal, onOpenPdfInToolbox }: ViewerProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const handOff = useLongOperation('documentToolbox');
  useEffect(() => {
    if (!signal) return undefined;
    // no built-in PDF viewer (disabled by the user / policy, or a minimal browser build): say so at once, never wait for a timeout
    if (typeof navigator !== 'undefined' && navigator.pdfViewerEnabled === false) {
      dispatch({ type: 'unsupported', message: 'Le visualiseur PDF de ce navigateur est désactivé ou absent : le PDF ne peut pas être affiché dans Docteur.' });
      return undefined;
    }
    let created: string | null = null;
    let alive = true;
    fetchPdfBytes(descriptor.url, { signal })
      .then(pdf => {
        if (!alive) return;
        created = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
        setBytes(pdf);
        setObjectUrl(created);
      })
      .catch((err: Error & { unsupported?: boolean }) => {
        if (!alive || err.name === 'AbortError') return;
        if (err.unsupported) dispatch({ type: 'unsupported', message: err.message });
        else dispatch({ type: 'error', message: err instanceof TypeError ? 'Le site source n’autorise pas l’aperçu intégré de ce PDF.' : err.message });
      });
    return () => { alive = false; if (created) URL.revokeObjectURL(created); };
  }, [descriptor.url, dispatch, signal]);
  if (!objectUrl) return null;
  const fileName = (() => {
    const last = descriptor.url.split('?')[0].split('/').pop() ?? '';
    try { return decodeURIComponent(last) || 'document.pdf'; } catch { return last || 'document.pdf'; }
  })();
  return (
    <>
      {onOpenPdfInToolbox && bytes && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', flexWrap: 'wrap', borderBottom: `1px solid ${panelBorder}` }}>
          <button type="button" data-testid="media-reader-open-toolbox" disabled={handOff.running}
            onClick={() => { void handOff.run('Envoi à l’Atelier PDF', () => onOpenPdfInToolbox(new File([bytes], fileName, { type: 'application/pdf' }))); }}
            style={actionStyle('#3dffaa')}>
            <FileText size={12} /> Ouvrir dans l’Atelier PDF
          </button>
          <OperationStatusLine operation={handOff} />
        </div>
      )}
      <iframe data-testid="media-reader-pdf" data-object-url={objectUrl} src={objectUrl} title={descriptor.title} onLoad={() => dispatch({ type: 'ready' })} style={{ width: '100%', height: '78vh', border: 'none', background: '#fff' }} />
    </>
  );
}

function TextViewer({ descriptor, dispatch, signal }: ViewerProps) {
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  useEffect(() => {
    if (!signal) return undefined;
    let alive = true;
    fetchTextResource(descriptor.url, { signal })
      .then(result => { if (alive) { setContent(result); dispatch({ type: 'ready' }); } })
      .catch((err: Error & { unsupported?: boolean }) => {
        if (!alive || err.name === 'AbortError') return;
        if (err.unsupported) dispatch({ type: 'unsupported', message: err.message });
        else dispatch({ type: 'error', message: err instanceof TypeError ? 'Le site source n’autorise pas la lecture de ce texte depuis Docteur.' : err.message });
      });
    return () => { alive = false; };
  }, [descriptor.url, dispatch, signal]);
  if (!content) return null;
  return (
    <div data-testid="media-reader-text" style={{ padding: '18px 22px', overflowY: 'auto', maxHeight: '78vh' }}>
      {descriptor.markdown
        ? <MarkdownContent text={content.text} />
        : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, lineHeight: 1.6, color: '#d8ccff' }}>{content.text}</pre>}
      {content.truncated && <div className="font-mono text-xs" style={{ color: '#ffb84d', marginTop: 10 }}>Aperçu limité aux 2 premiers Mo — ouvrez la source pour le reste.</div>}
    </div>
  );
}

function WebViewer({ descriptor, resolveCapturedPage, onNavigateToPage, onOpenInBrowser }: ViewerProps) {
  const [captured, setCaptured] = useState<CapturedPageView | null>(null);
  const [resolving, setResolving] = useState(Boolean(resolveCapturedPage));
  useEffect(() => {
    if (!resolveCapturedPage) return undefined;
    let alive = true;
    resolveCapturedPage(descriptor.url)
      .then(view => { if (alive) setCaptured(view); })
      .catch(() => { /* no captured copy: the card below still offers the source and the browser */ })
      .finally(() => { if (alive) setResolving(false); });
    return () => { alive = false; };
  }, [descriptor.url, resolveCapturedPage]);
  return (
    <div data-testid="media-reader-web" style={{ padding: '18px 22px', overflowY: 'auto', maxHeight: '78vh', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {resolving && <div data-testid="media-reader-web-resolving"><LoadingSpinner label="Recherche d’une copie capturée dans Docteur…" size={12} /></div>}
      {captured ? (
        <>
          <div className="font-mono text-xs" style={{ color: '#3dffaa' }}>Article déjà capturé dans Docteur</div>
          <div className="font-grotesk" style={{ color: '#f0eaff', fontSize: 17, fontWeight: 600 }}>{captured.title}</div>
          <div data-testid="media-reader-web-captured">
            {captured.text.trim()
              ? <MarkdownContent text={captured.text} />
              : <div className="font-mono text-xs" style={{ color: '#9f8fbf' }}>Le contenu de ce neurone n’est pas encore chargé : ouvrez le neurone pour le lire.</div>}
          </div>
        </>
      ) : (
        <>
          <div className="font-grotesk" style={{ color: '#f0eaff', fontSize: 16, fontWeight: 600 }}>Page web · {descriptor.host}</div>
          <div className="font-mono text-xs" style={{ color: '#9f8fbf', lineHeight: 1.6, wordBreak: 'break-all' }}>{descriptor.url}</div>
          <div className="font-mono text-xs" style={{ color: '#7a6c9a', lineHeight: 1.6 }}>
            Par sécurité, Docteur n’intègre pas de pages web tierces dans son interface. Ouvrez-la dans votre navigateur, ou capturez-la pour la lire ici.
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {captured && onNavigateToPage && <button type="button" data-testid="media-reader-open-page" onClick={() => onNavigateToPage(captured.id)} style={actionStyle('#3dffaa')}>Ouvrir le neurone</button>}
        <BrowserAction url={descriptor.url} onOpenInBrowser={onOpenInBrowser} />
      </div>
    </div>
  );
}

function BrowserAction({ url, onOpenInBrowser }: { url: string; onOpenInBrowser?: Props['onOpenInBrowser'] }) {
  const [status, setStatus] = useState<string | null>(null);
  if (!onOpenInBrowser) return null;
  return (
    <>
      <button type="button" data-testid="media-reader-open-browser" style={actionStyle('#c4b5fd')}
        onClick={() => { setStatus('Ouverture…'); onOpenInBrowser(url).then(() => setStatus('Ouvert dans le navigateur'), (err: Error) => setStatus(err.message || 'Ouverture impossible')); }}>
        <ExternalLink size={12} /> Ouvrir dans le navigateur
      </button>
      {status && <span className="font-mono text-xs" data-testid="media-reader-browser-status" style={{ color: '#9f8fbf', alignSelf: 'center' }}>{status}</span>}
    </>
  );
}

function Fallback({ descriptor, phase, message, onRetry, onOpenInBrowser }: { descriptor: MediaDescriptor; phase: 'ERROR' | 'UNSUPPORTED'; message: string | null; onRetry?: () => void; onOpenInBrowser?: Props['onOpenInBrowser'] }) {
  const unsupported = phase === 'UNSUPPORTED';
  return (
    <div data-testid={unsupported ? 'media-reader-unsupported' : 'media-reader-error'} style={{ padding: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', margin: 'auto' }}>
      <AlertTriangle size={26} style={{ color: unsupported ? '#ffb84d' : '#ff4d58' }} />
      <div className="font-mono text-sm" data-testid="media-reader-message" style={{ color: unsupported ? '#ffd28a' : '#ff8a92', maxWidth: 560, lineHeight: 1.6 }}>
        {message ?? (unsupported ? UNSUPPORTED_MESSAGE : 'Le média n’a pas pu être chargé.')}
      </div>
      {!descriptor.blocked && (
        <div className="flex flex-wrap gap-2 justify-center">
          {onRetry && <button type="button" data-testid="media-reader-retry" onClick={onRetry} style={actionStyle('#a78bfa')}><RotateCcw size={12} /> Réessayer</button>}
          <a href={descriptor.url} target="_blank" rel="noopener noreferrer" data-testid="media-reader-fallback-source" style={actionStyle('#5ee7ff')}><ExternalLink size={12} /> Ouvrir la source</a>
          {descriptor.docteurLocal && <a href={descriptor.url} download data-testid="media-reader-download" style={actionStyle('#3dffaa')}><Download size={12} /> Télécharger</a>}
          {!descriptor.docteurLocal && <BrowserAction url={descriptor.url} onOpenInBrowser={onOpenInBrowser} />}
        </div>
      )}
    </div>
  );
}
