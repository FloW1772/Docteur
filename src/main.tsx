import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import * as THREE from 'three';
import './styles/globals.css';
import { initMobilePerformanceMode } from './lib/useMobile';
import { ServerStartup } from './ServerStartup';

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
  const updateSW = registerSW({
    immediate: true,
    // registerType: 'prompt' (vite.config.ts) — a new SW never reloads the
    // page on its own. It only notifies the app via this event; App-level
    // UI (UpdateBanner) decides when it's safe to call updateSW() (a reload).
    onNeedRefresh() {
      window.dispatchEvent(new CustomEvent('docteur-sw-update-available'));
    },
    onOfflineReady() {
      console.log('[SW] Docteur est disponible hors ligne.');
    },
    onRegistered(r) {
      console.log('[SW] Enregistre :', r?.scope ?? 'inconnu');
    },
    onRegisterError(error) {
      console.error('[SW] Echec enregistrement :', error);
    },
  });
  // UpdateBanner calls this (window.docteurApplySWUpdate()) once it has
  // flushed pending saves and the user confirmed — it reloads the page.
  (window as unknown as { docteurApplySWUpdate?: () => void }).docteurApplySWUpdate = () => { void updateSW(true); };
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServerStartup />
  </StrictMode>
);
