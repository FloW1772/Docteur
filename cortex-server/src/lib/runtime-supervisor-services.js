// Runtime Supervisor V1 — the PRODUCT service registry (closed, code-defined, read-only observers).
//
// Runtime graph this registry reflects (audit 2026-10-19):
//   Docteur-Launcher.bat ─ start "Cortex Server" cmd /k npm run dev ─ node --watch ─ node src/server.js   (:3001, this process)
//                        ─ start "Docteur Frontend" cmd /k npm run dev ─ vite                            (:5173)
//                        ─ starts `ollama serve` only when no ollama.exe runs (else a user-started runtime)  (:11434)
//   server.js ─ Kiwix module  ─ kiwix-serve.exe (on demand, POST /kiwix/start; child handle held by kiwix.js)
//             ─ Image module  ─ ComfyUI python (on demand; child handle held by comfyui-install-manager.js)
// No service here is launched by the Runtime Supervisor, so none is restartable in V1:
//   docteur-backend    DOCTEUR_OWNED / SELF       — the process hosting the supervisor; self-restart is not supported
//   docteur-frontend   DOCTEUR_MANAGED_OPTIONAL  — started by the launcher, no ownership handle in the backend
//   ollama             EXTERNAL_OBSERVED         — user- or launcher-started runtime; health only, never stopped
//   kiwix-serve        DOCTEUR_MANAGED_OPTIONAL  — lifecycle owned by the Kiwix module (its own start/stop)
//   comfyui            DOCTEUR_MANAGED_OPTIONAL  — lifecycle owned by the image-generation module
// Observers only read in-process state and make bounded loopback probes; none starts, stops or signals anything.
// [RS-KIWIX-RESTART] when the composition root passes the Kiwix lifecycle port (`kiwixDelegate`), kiwix-serve becomes a
// DELEGATED service: the Kiwix module stays its process owner and source of truth; the supervisor gets only its status and
// the single restartOwnedKiwix(authorization) operation (restartable only through the local ceremony + Root Policy).

import { loopbackTarget } from './runtime-supervisor-probe.js';
import { getStatus as kiwixStatus, healthCheck as kiwixHealth } from './kiwix.js';
import { getInstallState as comfyInstallState } from './comfyui-install-manager.js';

const FRONTEND_PORT = 5173;
const COMFYUI_LOOPBACK = Object.freeze({ host: '127.0.0.1', port: 8188 });

/** Maps a probe result of an observed HTTP service to { state, health, portListening }. */
export function observedFromProbe(r, { okCode = 'HTTP_OK' } = {}) {
  if (r.code === 'OK') return { state: 'HEALTHY', health: { status: 'HEALTHY', code: okCode }, portListening: true, processRunning: true };
  if (r.code === 'REFUSED') return { state: 'STOPPED', health: { status: 'UNREACHABLE', code: 'PORT_NOT_LISTENING' }, portListening: false, processRunning: null };
  return { state: 'DEGRADED', health: { status: 'DEGRADED', code: r.code === 'TIMEOUT' ? 'HEALTH_TIMEOUT' : 'HEALTH_HTTP_ERROR' }, portListening: true, processRunning: null };
}

/** The delegated kiwix-serve entry: status + one typed restart operation, nothing else crosses into the supervisor. */
function kiwixDelegatedService(port) {
  return {
    serviceId: 'kiwix-serve', displayName: 'Kiwix (archives hors-ligne)', ownershipClass: 'DOCTEUR_MANAGED_OPTIONAL', kind: 'DELEGATED', optional: true, dependencies: ['docteur-backend'],
    note: 'Démarré et arrêté par le module Kiwix ; relance possible ici après confirmation locale.',
    restartEffects: ['IN_FLIGHT_REQUESTS_INTERRUPTED', 'LOCAL_ARCHIVES_UNCHANGED'],
    delegate: {
      status: () => port.getLifecycleStatus(),
      restartOwnedInstance: (authorization, { onReplacementDecision } = {}) => port.restartOwnedKiwix(authorization, { onReplacementDecision }),
    },
  };
}

export function createProductRuntimeServices({ ollamaUrl, kiwix = { status: kiwixStatus, health: kiwixHealth }, kiwixDelegate = null, comfy = { installState: comfyInstallState }, uptime = () => process.uptime() * 1000 } = {}) {
  const ollama = loopbackTarget(ollamaUrl);
  return [
    {
      serviceId: 'docteur-backend', displayName: 'Serveur Docteur (cortex-server)', ownershipClass: 'DOCTEUR_OWNED', kind: 'SELF', optional: false, dependencies: [],
      note: 'Héberge le superviseur : un redémarrage depuis lui-même n’est pas pris en charge (V1).',
      observe: async () => ({ state: 'HEALTHY', health: { status: 'HEALTHY', code: 'IN_PROCESS' }, pid: process.pid, uptimeMs: uptime(), processRunning: true, portListening: true }),
    },
    {
      serviceId: 'docteur-frontend', displayName: 'Interface Docteur (Vite)', ownershipClass: 'DOCTEUR_MANAGED_OPTIONAL', kind: 'OBSERVED', optional: true, dependencies: ['docteur-backend'],
      note: 'Démarrée par le lanceur Docteur ; le serveur n’en détient pas le processus.',
      observe: async ({ probe }) => {
        // Vite binds dual-stack (::); try IPv4 then IPv6 loopback
        let r = await probe({ host: '127.0.0.1', port: FRONTEND_PORT, path: '/', timeoutMs: 1_500 });
        if (r.code === 'REFUSED') r = await probe({ host: '::1', port: FRONTEND_PORT, path: '/', timeoutMs: 1_500 });
        return observedFromProbe(r);
      },
    },
    {
      serviceId: 'ollama', displayName: 'Ollama (modèles locaux)', ownershipClass: 'EXTERNAL_OBSERVED', kind: 'OBSERVED', optional: true, dependencies: [],
      note: 'Runtime externe : état de santé seulement, jamais arrêté ni relancé par Docteur.',
      observe: async ({ probe }) => {
        if (!ollama) return { state: 'BLOCKED', health: { status: 'NOT_PROBED', code: 'NON_LOOPBACK_ENDPOINT' } };
        return observedFromProbe(await probe({ ...ollama, path: '/api/version', timeoutMs: 1_500 }), { okCode: 'API_OK' });
      },
    },
    kiwixDelegate ? kiwixDelegatedService(kiwixDelegate) : {
      serviceId: 'kiwix-serve', displayName: 'Kiwix (archives hors-ligne)', ownershipClass: 'DOCTEUR_MANAGED_OPTIONAL', kind: 'OBSERVED', optional: true, dependencies: ['docteur-backend'],
      note: 'Démarré et arrêté par le module Kiwix (Paramètres Kiwix).',
      observe: async () => {
        const s = kiwix.status();
        const lastError = s?.lastError ? 'KIWIX_REPORTED_ERROR' : null;
        if (!s?.running) return { state: 'STOPPED', health: { status: 'NOT_PROBED', code: 'NOT_RUNNING' }, processRunning: false, lastError };
        const ok = await kiwix.health(s.port);
        return ok
          ? { state: 'HEALTHY', health: { status: 'HEALTHY', code: 'HTTP_OK' }, pid: s.pid, processRunning: true, portListening: true, lastError }
          : { state: 'DEGRADED', health: { status: 'DEGRADED', code: 'HEALTH_FAILED' }, pid: s.pid, processRunning: true, lastError };
      },
    },
    {
      serviceId: 'comfyui', displayName: 'ComfyUI (génération d’images)', ownershipClass: 'DOCTEUR_MANAGED_OPTIONAL', kind: 'OBSERVED', optional: true, dependencies: ['docteur-backend'],
      note: 'Installé, démarré et arrêté par le module Images.',
      observe: async ({ probe }) => {
        const install = comfy.installState();
        if (!install || install.status === 'not_installed' || install.kind === 'none') return { state: 'STOPPED', health: { status: 'NOT_PROBED', code: 'NOT_INSTALLED' }, processRunning: false };
        return observedFromProbe(await probe({ ...COMFYUI_LOOPBACK, path: '/system_stats', timeoutMs: 1_500 }));
      },
    },
  ];
}
