import { useEffect, useRef, useState } from 'react';
import { Monitor, MousePointerClick, Square, StopCircle } from 'lucide-react';
import { cortexClient, type FabricDevice, type FabricOmegaV2ViewState, type OmegaV2Link } from '../../lib/cortex/client';

function safe(value: string | null | undefined, max = 96) {
  if (!value) return '—';
  const clean = value.replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩‎‏]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const buttonStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 9px', borderRadius: 5,
  color: '#5ee7ff', border: '1px solid rgba(94,231,255,0.34)', background: 'rgba(94,231,255,0.06)' } as const;

const backend = () => `${location.protocol}//${location.hostname}:3001`;
// Host errors after which the remote INTERACTIVE stream is gone: stop sending locally.
const TERMINAL_INPUT_ERRORS = new Set(['INTERACTIVE_NOT_STARTED', 'INTERACTIVE_STOPPED', 'VIEW_NOT_ACTIVE', 'WRONG_STREAM',
  'SESSION_EXPIRED', 'REMOTE_STOPPED', 'DEVICE_REVOKED', 'PERMISSION_DENIED', 'NETWORK_UNAVAILABLE']);
type PointerButton = 'LEFT' | 'MIDDLE' | 'RIGHT';

// Same allowlist as the certified general OMEGA panel (OmegaOutboundViewTab):
// never reimplemented differently here, only reused.
const ALLOWED_CODES = new Set(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyM',
  'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote']);

/**
 * Fabric-specific VIEW+INTERACTIVE shell. The certified general OMEGA panel
 * cannot be embedded safely here because it intentionally also exposes
 * ADMIN and a free session picker. Fabric orchestrates START/STOP only,
 * through its own closed exact-target routes; pointer/keyboard/wheel input
 * events and frame bytes always go straight to OMEGA V2's own certified
 * `/api/omega/outbound/sessions/:id/*` endpoints with the sessionId this
 * state exposes — Fabric never sees or forwards a single input event.
 */
export function FabricOmegaV2ViewPanel({ device, link, disabled, onChanged }: {
  device: FabricDevice;
  link: OmegaV2Link;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<FabricOmegaV2ViewState | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const live = state?.sessionStatus === 'CONNECTED' && ['VIEW_STARTING', 'VIEWING'].includes(state.viewStatus);
  const interactive = state?.interactiveStatus === 'INTERACTIVE';

  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveTimer = useRef<number | undefined>(undefined);
  // Live flag read by timers/handlers so a stale render closure can never
  // forward input after any STOP path (mirrors the certified panel).
  const interactiveLiveRef = useRef(false);
  const heldKeys = useRef(new Set<string>());
  const heldButtons = useRef(new Map<PointerButton, { x: number; y: number }>());
  interactiveLiveRef.current = interactive;

  function clearFrame() {
    setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
  }

  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => () => { if (frameUrl) URL.revokeObjectURL(frameUrl); }, [frameUrl]);

  useEffect(() => {
    if (!state?.sessionId || !live) return undefined;
    const current = ++generation.current;
    let timer: number | undefined;
    const pull = async () => {
      try {
        const blob = await cortexClient.omegaOutboundViewFrame(state.sessionId as string);
        if (blob.type !== 'image/png') throw new Error('OMEGA_V2_FRAME_INVALID');
        const decoded = await createImageBitmap(blob);
        const valid = decoded.width >= 1 && decoded.height >= 1 && decoded.width <= 7680 && decoded.height <= 7680;
        decoded.close();
        if (!valid) throw new Error('OMEGA_V2_FRAME_INVALID');
        const next = URL.createObjectURL(blob);
        if (generation.current !== current) URL.revokeObjectURL(next);
        else {
          setFrameUrl(previous => { if (previous) URL.revokeObjectURL(previous); return next; });
          setState(previous => previous ? { ...previous, viewStatus: 'VIEWING' } : previous);
        }
      } catch (cause) {
        if (generation.current !== current) return;
        generation.current += 1;
        clearFrame();
        setState(previous => previous ? { ...previous, viewStatus: 'STOPPED', sessionStatus: 'DISCONNECTED', interactiveStatus: 'STOPPED' } : previous);
        const code = cause instanceof Error ? cause.message : 'OMEGA_V2_UNAVAILABLE';
        setError(/^[A-Z0-9_]{1,64}$/.test(code) ? code : 'OMEGA_V2_UNAVAILABLE');
        return;
      }
      if (generation.current === current) timer = window.setTimeout(() => void pull(), 500);
    };
    void pull();
    return () => { if (generation.current === current) generation.current += 1; if (timer !== undefined) window.clearTimeout(timer); };
  }, [state?.sessionId, live]);

  useEffect(() => {
    if (!state?.sessionId) return undefined;
    const timer = window.setInterval(() => {
      void cortexClient.deviceFabricOmegaV2ViewStatus(device.fabricDeviceId).then(result => {
        setState(result.view);
        if (result.view.viewStatus === 'STOPPED' || result.view.sessionStatus !== 'CONNECTED') clearFrame();
      }).catch(() => { /* frame pull reports transport failures without reconnecting */ });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [device.fabricDeviceId, state?.sessionId]);

  async function start() {
    setBusy(true); setError(null); clearFrame();
    try {
      const result = await cortexClient.deviceFabricOmegaV2ViewStart(device.fabricDeviceId, link, 0);
      setState(result.view);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error && /^[A-Z0-9_]{1,64}$/.test(cause.message) ? cause.message : 'OMEGA_V2_UNAVAILABLE');
    } finally { setBusy(false); }
  }

  function releaseLocalHeld() {
    if (!state?.sessionId) return;
    for (const key of heldKeys.current) void sendInput(state.sessionId, 'key', { key, state: 'UP' });
    for (const [button, point] of heldButtons.current) void sendInput(state.sessionId, 'button', { ...point, button, state: 'UP' });
    heldKeys.current.clear(); heldButtons.current.clear();
  }

  async function stopView() {
    setBusy(true); setError(null); generation.current += 1; releaseLocalHeld(); clearFrame();
    try { setState((await cortexClient.deviceFabricOmegaV2ViewStop(device.fabricDeviceId)).view); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'OMEGA_V2_UNAVAILABLE'); }
    finally { setBusy(false); }
  }

  async function stopSession() {
    setBusy(true); setError(null); generation.current += 1; releaseLocalHeld(); clearFrame();
    try { setState((await cortexClient.deviceFabricOmegaV2SessionStop(device.fabricDeviceId)).view); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'OMEGA_V2_UNAVAILABLE'); }
    finally { setBusy(false); }
  }

  async function startInteractive() {
    setBusy(true); setError(null);
    try {
      const result = await cortexClient.deviceFabricOmegaV2InteractiveStart(device.fabricDeviceId);
      setState(result.view);
      if (result.view.interactiveStatus === 'INTERACTIVE') queueMicrotask(() => viewportRef.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error && /^[A-Z0-9_]{1,64}$/.test(cause.message) ? cause.message : 'OMEGA_V2_UNAVAILABLE');
    } finally { setBusy(false); }
  }

  async function stopInteractive() {
    setBusy(true); setError(null);
    releaseLocalHeld();
    try { setState((await cortexClient.deviceFabricOmegaV2InteractiveStop(device.fabricDeviceId)).view); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'OMEGA_V2_UNAVAILABLE'); }
    finally { setBusy(false); }
  }

  // Sent straight to OMEGA V2's own certified input route — never through a
  // Fabric route, which exposes none (mission §12, §13, §32).
  async function sendInput(sessionId: string, category: 'pointer' | 'button' | 'wheel' | 'key', payload: Record<string, unknown>) {
    if (!interactiveLiveRef.current) return;
    try {
      const response = await fetch(`${backend()}/api/omega/outbound/sessions/${encodeURIComponent(sessionId)}/input/${category}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const code = ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'INPUT_REJECTED';
        if (code !== 'RATE_LIMITED') setError(code);
        if (TERMINAL_INPUT_ERRORS.has(code)) setState(previous => previous ? { ...previous, interactiveStatus: 'STOPPED' } : previous);
      }
    } catch {
      setState(previous => previous ? { ...previous, interactiveStatus: 'STOPPED' } : previous);
      setError('OMEGA_V2_NETWORK_UNAVAILABLE');
    }
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

  function schedulePointer(clientX: number, clientY: number) {
    if (!interactiveLiveRef.current || !state?.sessionId) return;
    pendingMove.current = mapPointer(clientX, clientY);
    if (!pendingMove.current || moveTimer.current !== undefined) return;
    const sessionId = state.sessionId;
    moveTimer.current = window.setTimeout(() => {
      moveTimer.current = undefined;
      const point = pendingMove.current; pendingMove.current = null;
      if (point) void sendInput(sessionId, 'pointer', point);
    }, 50);
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const listener = (event: WheelEvent) => {
      if (!interactiveLiveRef.current || !state?.sessionId) return;
      const point = mapPointer(event.clientX, event.clientY); if (!point) return;
      event.preventDefault(); void sendInput(state.sessionId, 'wheel', { ...point, delta: event.deltaY < 0 ? 1 : -1 });
    };
    viewport.addEventListener('wheel', listener, { passive: false });
    return () => viewport.removeEventListener('wheel', listener);
  }, [state?.sessionId]);

  return (
    <section data-testid="fabric-omega-v2-view" aria-label={`OMEGA VIEW ${safe(device.displayName)}`}
      className="flex flex-col gap-2 mt-2" style={{ border: '1px solid rgba(94,231,255,0.18)', borderRadius: 6, padding: 8 }}>
      <div className="font-mono text-xs" style={{ color: '#5ee7ff' }}><strong>OMEGA VIEW</strong></div>
      <div className="font-mono" style={{ fontSize: 10, color: '#9b91b4' }}>
        APPAREIL FABRIC: {safe(device.displayName, 64)} · HOST: {safe(link.omegaV2HostId, 64)}<br />
        CONNEXION: {state?.sessionStatus ?? 'DISCONNECTED'} · VIEW: {state?.viewStatus ?? 'STOPPED'} · INTERACTIVE: {state?.interactiveStatus ?? 'STOPPED'}
        {state?.linkChanged ? ` · LIEN MODIFIÉ (${safe(state.linkReason, 48)})` : ''}
      </div>
      <div ref={viewportRef} aria-label={interactive ? 'Fabric remote viewport (INTERACTIVE)' : 'Read-only Fabric remote viewport'} tabIndex={0}
        onPointerMove={event => schedulePointer(event.clientX, event.clientY)}
        onPointerDown={event => {
          if (!interactiveLiveRef.current || !state?.sessionId) return;
          const point = mapPointer(event.clientX, event.clientY); if (!point) return;
          const button: PointerButton | null = event.button === 0 ? 'LEFT' : event.button === 1 ? 'MIDDLE' : event.button === 2 ? 'RIGHT' : null;
          if (!button || heldButtons.current.has(button)) return;
          event.preventDefault();
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events have no capture */ }
          heldButtons.current.set(button, point);
          void sendInput(state.sessionId, 'button', { ...point, button, state: 'DOWN' });
        }}
        onPointerUp={event => {
          if (!interactiveLiveRef.current || !state?.sessionId) return;
          const button: PointerButton | null = event.button === 0 ? 'LEFT' : event.button === 1 ? 'MIDDLE' : event.button === 2 ? 'RIGHT' : null;
          const held = button ? heldButtons.current.get(button) : undefined;
          if (!button || !held) return;
          // A release outside the frame is clamped to its edge so no button stays held remotely.
          const point = mapPointer(event.clientX, event.clientY, true) ?? held;
          heldButtons.current.delete(button);
          event.preventDefault(); void sendInput(state.sessionId, 'button', { ...point, button, state: 'UP' });
        }}
        onKeyDown={event => {
          if (!interactiveLiveRef.current) return;
          if (event.code === 'Escape') { event.preventDefault(); releaseLocalHeld(); void stopInteractive(); return; }
          if (!state?.sessionId || !ALLOWED_CODES.has(event.code) || event.repeat || heldKeys.current.has(event.code)) return;
          event.preventDefault(); heldKeys.current.add(event.code); void sendInput(state.sessionId, 'key', { key: event.code, state: 'DOWN' });
        }}
        onKeyUp={event => {
          if (!interactiveLiveRef.current || !state?.sessionId || !heldKeys.current.has(event.code)) return;
          event.preventDefault(); heldKeys.current.delete(event.code); void sendInput(state.sessionId, 'key', { key: event.code, state: 'UP' });
        }}
        onBlur={() => { if (interactiveLiveRef.current) releaseLocalHeld(); }}
        onPaste={event => event.preventDefault()} onCopy={event => event.preventDefault()} onCut={event => event.preventDefault()}
        onContextMenu={event => { if (interactive) event.preventDefault(); }}
        onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}
        style={{ minHeight: 180, background: '#080712', display: 'grid', placeItems: 'center',
          border: interactive ? '2px solid #ff6bd6' : '1px solid rgba(94,231,255,0.14)' }}>
        {frameUrl ? <img ref={imageRef} src={frameUrl} alt="Fabric remote screen" draggable={false}
          style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' }} />
          : <span className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Aucune frame</span>}
      </div>
      {error && <p role="alert" className="font-mono text-xs" style={{ color: '#ff6b78' }}>{safe(error, 64)}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="fabric-omega-v2-view-start" style={buttonStyle}
          disabled={disabled || busy || live} onClick={() => void start()}><Monitor size={13} /> VOIR</button>
        <button type="button" data-testid="fabric-omega-v2-interactive-start" style={buttonStyle}
          disabled={disabled || busy || !live || state?.viewStatus !== 'VIEWING' || interactive}
          onClick={() => void startInteractive()}><MousePointerClick size={13} /> ACTIVER INTERACTIVE</button>
        <button type="button" data-testid="fabric-omega-v2-interactive-stop" style={buttonStyle}
          disabled={disabled || busy || !interactive} onClick={() => void stopInteractive()}>
          <Square size={13} /> STOP INTERACTIVE
        </button>
        <button type="button" data-testid="fabric-omega-v2-view-stop" style={buttonStyle}
          disabled={disabled || busy || !live} onClick={() => void stopView()}><Square size={13} /> STOP VIEW</button>
        <button type="button" data-testid="fabric-omega-v2-session-stop" style={buttonStyle}
          disabled={disabled || busy || !state?.sessionId || state.sessionStatus !== 'CONNECTED'} onClick={() => void stopSession()}>
          <StopCircle size={13} /> STOP SESSION
        </button>
      </div>
    </section>
  );
}

export default FabricOmegaV2ViewPanel;
