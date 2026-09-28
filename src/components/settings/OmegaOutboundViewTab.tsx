import { useEffect, useRef, useState } from 'react';
import { Monitor, RefreshCw, Square, StopCircle } from 'lucide-react';
import { OmegaOutboundAdminPanel } from './OmegaOutboundAdminPanel';

type Session = {
  sessionId: string;
  remoteOmegaDeviceId: string;
  permission: string;
  status: string;
  expiresAt: string;
};

const backend = () => `${location.protocol}//${location.hostname}:3001`;
// Host errors after which the remote INTERACTIVE stream is gone: stop sending locally.
const TERMINAL_INPUT_ERRORS = new Set(['INTERACTIVE_NOT_STARTED', 'INTERACTIVE_STOPPED', 'VIEW_NOT_ACTIVE', 'WRONG_STREAM',
  'SESSION_EXPIRED', 'REMOTE_STOPPED', 'DEVICE_REVOKED', 'PERMISSION_DENIED', 'NETWORK_UNAVAILABLE']);
type PointerButton = 'LEFT' | 'MIDDLE' | 'RIGHT';

export function OmegaOutboundViewTab() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [screenIndex, setScreenIndex] = useState(0);
  const [viewState, setViewState] = useState('STOPPED');
  const [viewStreamId, setViewStreamId] = useState('');
  const [interactiveState, setInteractiveStateValue] = useState('STOPPED');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollEnabled, setPollEnabled] = useState(false);
  const pollInFlight = useRef(false);
  const pollGeneration = useRef(0);
  const viewLiveRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveTimer = useRef<number | undefined>(undefined);
  // Live flag read by timers and async sends so a stale render closure can never
  // forward input after any STOP path.
  const interactiveLiveRef = useRef(false);
  const heldKeys = useRef(new Set<string>());
  const heldButtons = useRef(new Map<PointerButton, { x: number; y: number }>());
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const selectedSession = sessions.find(session => session.sessionId === selected) ?? null;
  const viewActive = ['VIEW_STARTING', 'VIEWING'].includes(viewState);

  function setInteractiveState(next: string) {
    interactiveLiveRef.current = next === 'INTERACTIVE';
    if (!interactiveLiveRef.current) {
      if (moveTimer.current !== undefined) window.clearTimeout(moveTimer.current);
      moveTimer.current = undefined; pendingMove.current = null;
      heldKeys.current.clear(); heldButtons.current.clear();
    }
    setInteractiveStateValue(next);
  }

  async function loadSessions() {
    const response = await fetch(`${backend()}/api/omega/outbound/sessions`);
    const data = await response.json() as { sessions?: Session[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? 'SESSION_LIST_FAILED');
    const next = data.sessions ?? [];
    setSessions(next);
    if (!selected && next[0]) setSelected(next[0].sessionId);
  }

  useEffect(() => { void loadSessions().catch(e => setError(e instanceof Error ? e.message : 'NETWORK_UNAVAILABLE')); }, []);

  useEffect(() => () => { if (frameUrl) URL.revokeObjectURL(frameUrl); }, [frameUrl]);

  useEffect(() => {
    if (!pollEnabled || !viewActive || !selected) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const generation = ++pollGeneration.current;
    const poll = async () => {
      if (!viewLiveRef.current || cancelled || generation !== pollGeneration.current || pollInFlight.current) return;
      pollInFlight.current = true;
      let retry = true;
      try {
        const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(selected)}/view/frame`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store',
        });
        if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'FRAME_UNAVAILABLE');
        const blob = await response.blob();
        if (blob.type !== 'image/png') throw new Error('FRAME_INVALID');
        try {
          const decoded = await createImageBitmap(blob);
          const validDimensions = decoded.width >= 1 && decoded.height >= 1 && decoded.width <= 7680 && decoded.height <= 7680;
          decoded.close();
          if (!validDimensions) throw new Error('FRAME_INVALID');
        } catch { throw new Error('FRAME_INVALID'); }
        const nextUrl = URL.createObjectURL(blob);
        if (cancelled || generation !== pollGeneration.current) URL.revokeObjectURL(nextUrl);
        else {
          setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return nextUrl; });
          setViewState('VIEWING');
        }
      } catch (e) {
        if (!cancelled) {
          const raw = e instanceof Error ? e.message : 'NETWORK_UNAVAILABLE';
          const message = /fetch|network|load failed/i.test(raw) ? 'NETWORK_UNAVAILABLE' : raw;
          if (message !== 'RATE_LIMITED') {
            cancelled = true;
            retry = false;
            viewLiveRef.current = false;
            setPollEnabled(false);
            if (generation === pollGeneration.current) pollGeneration.current += 1;
            setError(message);
            setViewState('STOPPED');
            setInteractiveState('STOPPED');
            setViewStreamId('');
            setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
          }
        }
      } finally {
        pollInFlight.current = false;
        if (retry && viewLiveRef.current && !cancelled && generation === pollGeneration.current) {
          timer = window.setTimeout(() => void poll(), 500);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (generation === pollGeneration.current) pollGeneration.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selected, viewActive, pollEnabled]);

  async function startView() {
    if (!selected) return;
    viewLiveRef.current = false;
    setPollEnabled(false);
    pollGeneration.current += 1;
    setBusy(true); setError(null); setViewState('VIEW_STARTING');
    setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
    try {
      const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(selected)}/view/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screenIndex }),
      });
      const data = await response.json() as { view?: { status?: string; streamId?: string }; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'VIEW_START_FAILED');
      viewLiveRef.current = true;
      setViewState(data.view?.status ?? 'VIEW_STARTING');
      setViewStreamId(data.view?.streamId ?? '');
      setPollEnabled(true);
    } catch (e) { viewLiveRef.current = false; setViewState('STOPPED'); setError(e instanceof Error ? e.message : 'VIEW_START_FAILED'); }
    finally { setBusy(false); }
  }

  async function stopView() {
    if (!selected) return;
    viewLiveRef.current = false;
    setPollEnabled(false);
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(selected)}/view/stop`, { method: 'POST' });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'VIEW_STOP_FAILED');
      setViewState('STOPPED');
      setInteractiveState('STOPPED'); setViewStreamId('');
      setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
    } catch (e) { setError(e instanceof Error ? e.message : 'VIEW_STOP_FAILED'); }
    finally { setBusy(false); }
  }

  async function stopSession() {
    if (!selected) return;
    viewLiveRef.current = false;
    setPollEnabled(false);
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(selected)}/stop`, { method: 'POST' });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'SESSION_STOP_FAILED');
      setViewState('STOPPED'); setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
      setInteractiveState('STOPPED'); setViewStreamId('');
      await loadSessions();
    } catch (e) { setError(e instanceof Error ? e.message : 'SESSION_STOP_FAILED'); }
    finally { setBusy(false); }
  }

  async function startInteractive() {
    if (!selected || viewState !== 'VIEWING' || !viewStreamId) return;
    setBusy(true); setError(null); setInteractiveState('INTERACTIVE_STARTING');
    try {
      const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(selected)}/interactive/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const data = await response.json() as { interactive?: { status?: string }; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'INTERACTIVE_START_FAILED');
      setInteractiveState(data.interactive?.status ?? 'INTERACTIVE');
      queueMicrotask(() => viewportRef.current?.focus());
    } catch (e) { setInteractiveState('STOPPED'); setError(e instanceof Error ? e.message : 'INTERACTIVE_START_FAILED'); }
    finally { setBusy(false); }
  }

  async function stopInteractive() {
    if (!selected) return;
    setInteractiveState('INTERACTIVE_STOPPING');
    try {
      const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(selected)}/interactive/stop`, { method: 'POST' });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'INTERACTIVE_STOP_FAILED');
    } catch (e) { setError(e instanceof Error ? e.message : 'INTERACTIVE_STOP_FAILED'); }
    finally { setInteractiveState('STOPPED'); }
  }

  async function sendInput(category: 'pointer' | 'button' | 'wheel' | 'key', payload: Record<string, unknown>) {
    if (!selected || !interactiveLiveRef.current) return;
    try {
      const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(selected)}/input/${category}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const code = ((await response.json()) as { error?: string }).error ?? 'INPUT_REJECTED';
        if (code !== 'RATE_LIMITED') setError(code);
        if (TERMINAL_INPUT_ERRORS.has(code)) setInteractiveState('STOPPED');
      }
    } catch { setInteractiveState('STOPPED'); setError('NETWORK_UNAVAILABLE'); }
  }

  // Maps a client point to normalized remote coordinates over the displayed
  // frame only: the object-fit:contain letterbox bands are outside the screen.
  function mapPointer(clientX: number, clientY: number, clamp = false) {
    const image = imageRef.current;
    if (!viewportRef.current || !image || image.naturalWidth < 1 || image.naturalHeight < 1) return null;
    const box = image.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;
    let x = (clientX - left) / width;
    let y = (clientY - top) / height;
    if (clamp) { x = Math.min(Math.max(x, 0), 0.999999); y = Math.min(Math.max(y, 0), 0.999999); }
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < 1 && y < 1 ? { x, y } : null;
  }

  function releaseLocalHeld() {
    for (const key of heldKeys.current) void sendInput('key', { key, state: 'UP' });
    for (const [button, point] of heldButtons.current) void sendInput('button', { ...point, button, state: 'UP' });
    heldKeys.current.clear(); heldButtons.current.clear();
  }

  wheelHandler.current = event => {
    if (!interactiveLiveRef.current) return;
    const point = mapPointer(event.clientX, event.clientY); if (!point) return;
    event.preventDefault(); void sendInput('wheel', { ...point, delta: event.deltaY < 0 ? 1 : -1 });
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const listener = (event: WheelEvent) => wheelHandler.current(event);
    viewport.addEventListener('wheel', listener, { passive: false });
    return () => viewport.removeEventListener('wheel', listener);
  }, []);

  function schedulePointer(clientX: number, clientY: number) {
    if (!interactiveLiveRef.current) return;
    pendingMove.current = mapPointer(clientX, clientY);
    if (!pendingMove.current || moveTimer.current !== undefined) return;
    moveTimer.current = window.setTimeout(() => {
      moveTimer.current = undefined;
      const point = pendingMove.current; pendingMove.current = null;
      if (point) void sendInput('pointer', point);
    }, 50);
  }

  const allowedCodes = new Set(['KeyA','KeyB','KeyC','KeyD','KeyE','KeyF','KeyG','KeyH','KeyI','KeyJ','KeyK','KeyL','KeyM','KeyN','KeyO','KeyP','KeyQ','KeyR','KeyS','KeyT','KeyU','KeyV','KeyW','KeyX','KeyY','KeyZ',
    'Digit0','Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Space','Tab','Enter','Backspace','Delete','Insert','ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home','End','PageUp','PageDown','ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12','Semicolon','Equal','Comma','Minus','Period','Slash','Backquote','BracketLeft','Backslash','BracketRight','Quote']);

  return (
    <section className="px-5 py-4 flex flex-col gap-4" aria-label="OMEGA outbound VIEW">
      <div className="flex items-center gap-3">
        <Monitor size={17} style={{ color: '#5ee7ff' }} />
        <div>
          <h4 className="font-grotesk font-semibold" style={{ color: '#f0eaff' }}>OMEGA VIEW ONLY</h4>
          <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Read-only remote screen</p>
        </div>
        <button type="button" title="Refresh sessions" aria-label="Refresh sessions" onClick={() => void loadSessions()} style={{ marginLeft: 'auto', color: '#5ee7ff' }}><RefreshCw size={14} /></button>
      </div>
      <select value={selected} disabled={busy || viewActive} onChange={event => {
        viewLiveRef.current = false;
        setPollEnabled(false);
        pollGeneration.current += 1;
        setSelected(event.target.value);
        setViewState('STOPPED');
        setInteractiveState('STOPPED'); setViewStreamId('');
        setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
      }} aria-label="Remote device session">
        <option value="">Select a connected device</option>
        {sessions.filter(session => session.status === 'CONNECTED').map(session => <option key={session.sessionId} value={session.sessionId}>{session.remoteOmegaDeviceId} · {session.permission}</option>)}
      </select>
      <div className="font-mono text-xs" style={{ color: '#a99bc5' }}>
        REMOTE: {selectedSession?.remoteOmegaDeviceId ?? 'NONE'} · CONNECTION: {selectedSession?.status ?? 'DISCONNECTED'}
      </div>
      <label className="font-mono text-xs" style={{ color: '#a99bc5' }}>Screen index <input type="number" min={0} max={63} value={screenIndex} onChange={event => setScreenIndex(Number(event.target.value))} /></label>
      <div className="font-mono text-xs" style={{ color: viewState === 'VIEWING' ? '#3dffaa' : '#ffb547' }}>VIEW: {viewState}</div>
      <div className="font-mono text-xs" style={{ color: interactiveState === 'INTERACTIVE' ? '#ff6bd6' : '#7a6c9a' }}>INTERACTIVE: {interactiveState}</div>
      <div ref={viewportRef} aria-label="Read-only remote viewport" tabIndex={0}
        onPointerMove={event => schedulePointer(event.clientX, event.clientY)}
        onPointerDown={event => {
          if (!interactiveLiveRef.current) return;
          const point = mapPointer(event.clientX, event.clientY); if (!point) return;
          const button: PointerButton | null = event.button === 0 ? 'LEFT' : event.button === 1 ? 'MIDDLE' : event.button === 2 ? 'RIGHT' : null;
          if (!button || heldButtons.current.has(button)) return;
          event.preventDefault();
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events have no capture */ }
          heldButtons.current.set(button, point);
          void sendInput('button', { ...point, button, state: 'DOWN' });
        }}
        onPointerUp={event => {
          if (!interactiveLiveRef.current) return;
          const button: PointerButton | null = event.button === 0 ? 'LEFT' : event.button === 1 ? 'MIDDLE' : event.button === 2 ? 'RIGHT' : null;
          const held = button ? heldButtons.current.get(button) : undefined;
          if (!button || !held) return;
          // A release outside the frame is clamped to its edge so no button stays held remotely.
          const point = mapPointer(event.clientX, event.clientY, true) ?? held;
          heldButtons.current.delete(button);
          event.preventDefault(); void sendInput('button', { ...point, button, state: 'UP' });
        }}
        onKeyDown={event => {
          if (!interactiveLiveRef.current) return;
          if (event.code === 'Escape') { event.preventDefault(); releaseLocalHeld(); void stopInteractive(); return; }
          if (!allowedCodes.has(event.code) || event.repeat || heldKeys.current.has(event.code)) return;
          event.preventDefault(); heldKeys.current.add(event.code); void sendInput('key', { key: event.code, state: 'DOWN' });
        }}
        onKeyUp={event => {
          if (!interactiveLiveRef.current || !heldKeys.current.has(event.code)) return;
          event.preventDefault(); heldKeys.current.delete(event.code); void sendInput('key', { key: event.code, state: 'UP' });
        }}
        onBlur={() => { if (interactiveLiveRef.current) releaseLocalHeld(); }}
        onPaste={event => event.preventDefault()} onCopy={event => event.preventDefault()} onCut={event => event.preventDefault()}
        onContextMenu={event => { if (interactiveState === 'INTERACTIVE') event.preventDefault(); }}
        onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}
        style={{ minHeight: 220, background: '#080712', border: interactiveState === 'INTERACTIVE' ? '2px solid #ff6bd6' : '1px solid rgba(94,231,255,0.18)', display: 'grid', placeItems: 'center' }}>
        {frameUrl ? <img ref={imageRef} src={frameUrl} alt="Remote screen" draggable={false} style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' }} /> : <span className="font-mono text-xs" style={{ color: '#5a4a7a' }}>No frame</span>}
      </div>
      {error && <p role="alert" className="font-mono text-xs" style={{ color: '#ff6b78' }}>{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !selected || viewActive} onClick={() => void startView()}><Monitor size={13} /> Start VIEW</button>
        <button type="button" disabled={busy || viewState !== 'VIEWING' || !['INTERACTIVE', 'ADMIN'].includes(selectedSession?.permission ?? '') || interactiveState !== 'STOPPED'} onClick={() => void startInteractive()}><Monitor size={13} /> Start INTERACTIVE</button>
        <button type="button" disabled={busy || interactiveState === 'STOPPED'} onClick={() => void stopInteractive()}><Square size={13} /> Stop INTERACTIVE</button>
        <button type="button" disabled={busy || viewState === 'STOPPED'} onClick={() => void stopView()}><Square size={13} /> Stop VIEW</button>
        <button type="button" disabled={busy || !selected} onClick={() => void stopSession()}><StopCircle size={13} /> Stop session</button>
      </div>
      {/* ADMIN exists only for a CONNECTED session whose granted permission is exactly ADMIN. */}
      {selectedSession?.permission === 'ADMIN' && selectedSession.status === 'CONNECTED' && (
        <OmegaOutboundAdminPanel key={selectedSession.sessionId} sessionId={selectedSession.sessionId}
          remoteDeviceId={selectedSession.remoteOmegaDeviceId} expiresAt={selectedSession.expiresAt} backend={backend()} />
      )}
    </section>
  );
}
