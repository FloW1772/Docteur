// EETF V1 — EETF-7 interactive skybox preview (Three.js already in Docteur; no new 3D dependency).
// PREVIEW ONLY: the panorama is shown as if equirectangular; yaw / pitch / fov are viewer settings, not a
// scene camera; no cubemap is produced. Rendering happens on demand (no animation loop, no automatic camera
// motion, so prefers-reduced-motion has nothing to stop). Everything is disposed on unmount.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { applyPreviewParams, buildSkyboxPreview, PREVIEW_LIMITS, type SkyboxPreview } from '../../lib/eetf/skybox-preview';
import { eetfAssetUrl } from '../../lib/eetf/client';
import './eetf.css';

export interface ViewParams { yaw: number; pitch: number; fov: number }
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export function clampView(p: ViewParams): ViewParams {
  return { yaw: clamp(p.yaw, PREVIEW_LIMITS.yawMin, PREVIEW_LIMITS.yawMax), pitch: clamp(p.pitch, PREVIEW_LIMITS.pitchMin, PREVIEW_LIMITS.pitchMax), fov: clamp(p.fov, PREVIEW_LIMITS.fovMin, PREVIEW_LIMITS.fovMax) };
}

declare global { interface Window { __eetfSkybox?: { created: number; disposed: number } } }
const stats = () => (window.__eetfSkybox ??= { created: 0, disposed: 0 });

export default function EetfSkyboxViewer({ assetId, view, onView }: { assetId: string; view: ViewParams; onView: (v: ViewParams) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<SkyboxPreview | null>(null);
  const renderer = useRef<THREE.WebGLRenderer | null>(null);
  const viewRef = useRef(view);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const draw = () => {
    const r = renderer.current; const p = preview.current; const h = host.current;
    if (!r || !p || !h) return;
    const w = Math.max(1, h.clientWidth); const ht = Math.max(1, h.clientHeight);
    r.setSize(w, ht, false);
    applyPreviewParams(p, { ...viewRef.current, aspect: clamp(w / ht, 0.25, 4) });
    r.render(p.scene, p.camera);
  };

  useEffect(() => {
    const h = host.current;
    if (!h) return undefined;
    let disposed = false;
    let texture: THREE.Texture | null = null;
    let r: THREE.WebGLRenderer;
    try {
      r = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
    } catch { setState('unavailable'); return undefined; }
    renderer.current = r;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    h.appendChild(r.domElement);
    stats().created += 1;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(eetfAssetUrl(assetId), (t) => {
      if (disposed) { t.dispose(); return; }
      texture = t;
      preview.current = buildSkyboxPreview(t, { ...viewRef.current, aspect: 16 / 9 });
      setState('ready');
      draw();
    }, undefined, () => { if (!disposed) setState('unavailable'); });
    const ro = new ResizeObserver(() => draw());
    ro.observe(h);
    return () => {
      disposed = true;
      ro.disconnect();
      preview.current?.dispose();
      texture?.dispose();
      preview.current = null;
      r.dispose();
      r.forceContextLoss();
      r.domElement.remove();
      renderer.current = null;
      stats().disposed += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  useEffect(() => { viewRef.current = view; draw(); });

  const drag = useRef<{ x: number; y: number; v: ViewParams } | null>(null);
  return (
    <div className="eetf-card" data-testid="eetf-skybox" data-reduced-motion={reducedMotion ? 'reduce' : 'no-preference'}>
      <h3>Aperçu skybox — PREVIEW ONLY</h3>
      <p className="eetf-muted">Affichage d’aperçu : l’image est traitée comme équirectangulaire pour la visualisation. Ce n’est ni une caméra de scène, ni une cubemap, ni une validation de projection.</p>
      <div ref={host} className="eetf-canvas" tabIndex={0} role="img" aria-label={`Aperçu skybox interactif : lacet ${view.yaw}°, tangage ${view.pitch}°, champ ${view.fov}°. Flèches pour tourner, + et − pour zoomer.`}
        data-state={state}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 15 : 5;
          const m: Record<string, Partial<ViewParams>> = { ArrowLeft: { yaw: view.yaw - step }, ArrowRight: { yaw: view.yaw + step }, ArrowUp: { pitch: view.pitch + step }, ArrowDown: { pitch: view.pitch - step }, '+': { fov: view.fov - step }, '-': { fov: view.fov + step } };
          if (m[e.key]) { e.preventDefault(); onView(clampView({ ...view, ...m[e.key] })); }
        }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, v: view }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; onView(clampView({ yaw: d.v.yaw - (e.clientX - d.x) * 0.3, pitch: d.v.pitch + (e.clientY - d.y) * 0.3, fov: d.v.fov })); }}
        onPointerUp={() => { drag.current = null; }}
        onWheel={(e) => { onView(clampView({ ...view, fov: view.fov + Math.sign(e.deltaY) * 3 })); }}
      >
        {state === 'unavailable' && <p className="eetf-muted" style={{ padding: 12 }}>Aperçu interactif indisponible (WebGL ou image) : utilisez le rendu serveur.</p>}
      </div>
    </div>
  );
}
