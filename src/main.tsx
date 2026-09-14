import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import * as THREE from 'three';
import './styles/globals.css';
import App from './App';
import { initMobilePerformanceMode } from './lib/useMobile';

// In dev mode, unregister any stale SW (from previous production builds on
// localhost) so it never intercepts Vite's HMR / @vite/client requests.
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => r.unregister());
  });
  caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
}

initMobilePerformanceMode();

// Register the SW only in production builds (never in dev).
if (import.meta.env.PROD) {
  registerSW({
    immediate: true,
    onRegistered(r) {
      console.log('[SW] Enregistre :', r?.scope ?? 'inconnu');
    },
    onRegisterError(error) {
      console.error('[SW] Echec enregistrement :', error);
    },
  });
}

function patchThreeTexture3DUploadDefaults(): void {
  const rendererProto = THREE.WebGLRenderer.prototype as unknown as {
    initTexture?: (texture: THREE.Texture) => void;
  };

  const originalInitTexture = rendererProto.initTexture;
  if (!originalInitTexture) return;

  rendererProto.initTexture = function patchedInitTexture(texture: THREE.Texture): void {
    if ((texture as THREE.Data3DTexture).isData3DTexture || (texture as THREE.DataArrayTexture).isDataArrayTexture) {
      texture.flipY = false;
      texture.premultiplyAlpha = false;
      texture.unpackAlignment = 1;
    }

    originalInitTexture.call(this, texture);
  };
}

patchThreeTexture3DUploadDefaults();


function ServerStartup() {
  const [ready, setReady] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = performance.now();
    let attempts = 0;
    async function probe() {
      attempts++;
      try {
        const response = await fetch(`${location.protocol}//${location.hostname}:3001/api/ping`, { signal: AbortSignal.timeout(2000) });
        if (response.ok && !cancelled) {
          console.info('[startup] backend ready before App mount', { elapsedMs: Math.round(performance.now() - started), attempts, at: new Date().toISOString() });
          setReady(true);
          return;
        }
      } catch { /* Only the readiness probe runs until the server listens. */ }
      if (!cancelled) {
        setElapsed(Math.round((performance.now() - started) / 1000));
        timer = setTimeout(probe, Math.min(5000, 500 * 2 ** Math.min(attempts, 4)));
      }
    }
    void probe();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  if (ready) return <App />;
  return <div role="status" style={{ padding: 40, color: '#f0eaff' }}>
    Connexion au serveur en cours... {elapsed}s
    {elapsed >= 15 && <button onClick={() => setReady(true)} style={{ display: 'block', marginTop: 20 }}>Ouvrir la copie hors ligne</button>}
  </div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServerStartup />
  </StrictMode>
);
