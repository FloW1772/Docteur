import { useEffect, useSyncExternalStore } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// Registre centralisé des modales ouvertes.
//
// POUR AJOUTER UNE NOUVELLE MODALE :
//   1. Déclarer son état comme d'habitude : const [monModalOpen, setMonModalOpen] = useState(false);
//   2. Juste après, appeler : useModalOpenTracking(monModalOpen);
//   C'est tout — anyModalOpen (via useAnyModalOpen()) se met à jour automatiquement.
//   Il n'y a plus de liste à modifier manuellement, donc plus rien à oublier.
//
// Choix d'implémentation : un compteur (nombre de modales actuellement
// enregistrées comme ouvertes) plutôt qu'un Set d'ids. Un Set serait un peu
// plus "debuggable" (on peut lister quelles modales sont ouvertes), mais un
// compteur suffit ici et est trivialement sûr sous React StrictMode : chaque
// montage en dev déclenche mount → cleanup → mount, donc register()/
// unregister() sont appelés en paires symétriques (+1/-1, +1/-1, ...) via le
// cleanup de useEffect, qui ne peut pas être "oublié" par erreur. Le compteur
// ne peut donc jamais dériver.
// ─────────────────────────────────────────────────────────────────────────

let openCount = 0;
const listeners = new Set<() => void>();

function register() {
  openCount += 1;
  listeners.forEach(l => l());
}

function unregister() {
  openCount -= 1;
  listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return openCount > 0;
}

/**
 * À appeler une fois, juste après la déclaration du useState d'une modale,
 * avec son booléen isOpen. S'enregistre/se désenregistre automatiquement
 * (via le cleanup de useEffect) à chaque transition ouverte/fermée et au
 * démontage — impossible à oublier.
 */
export function useModalOpenTracking(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    register();
    return () => unregister();
  }, [isOpen]);
}

/** Lecture réactive de "au moins une modale enregistrée est ouverte". */
export function useAnyModalOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
