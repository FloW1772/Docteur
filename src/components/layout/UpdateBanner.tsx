import { useEffect, useState } from 'react';

// Shown when main.tsx's onNeedRefresh fires (see vite.config.ts —
// registerType: 'prompt', never 'autoUpdate'): a new Service Worker is
// installed and waiting, but nothing reloads the page until the user
// confirms here. flushSaves runs first so an update never drops unsaved
// work mid-generation/mid-typing.
export function UpdateBanner({ flushSaves }: { flushSaves: () => Promise<void> }) {
  const [visible, setVisible] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const onUpdateAvailable = () => setVisible(true);
    window.addEventListener('docteur-sw-update-available', onUpdateAvailable);
    return () => window.removeEventListener('docteur-sw-update-available', onUpdateAvailable);
  }, []);

  if (!visible) return null;

  async function applyUpdate() {
    setApplying(true);
    try { await flushSaves(); } catch { /* best-effort — never block the update on a save failure */ }
    (window as unknown as { docteurApplySWUpdate?: () => void }).docteurApplySWUpdate?.();
  }

  return (
    <div className="update-banner" role="status">
      <span>Une nouvelle version de Docteur est disponible.</span>
      <div className="update-banner-actions">
        <button type="button" onClick={() => void applyUpdate()} disabled={applying}>
          {applying ? 'Mise à jour…' : 'Mettre à jour'}
        </button>
        <button type="button" className="update-banner-later" onClick={() => setVisible(false)} disabled={applying}>
          Plus tard
        </button>
      </div>
    </div>
  );
}
