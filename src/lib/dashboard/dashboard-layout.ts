// Customizable Dashboard V1 — the pure layout model of the HUD Dashboard (no React, no I/O except the guarded
// localStorage helpers at the bottom).
//
//   catalog (code, stable ids)  +  stored preference { version, order, hidden }  →  resolveDashboardLayout()  →  layout
//
// MASQUER ≠ DÉSACTIVER: this only decides which CARDS the Dashboard shows and in which order. Every feature keeps its
// other entry points (TopBar, "More" menu, console, voice commands, shortcuts); no route, permission or module changes.
// Robust by construction: unknown / duplicated / corrupt stored ids are ignored, and a card added in a future version
// appears at its default place with its default visibility.

export interface DashboardCardDefinition {
  /** stable identifier — persisted; NEVER the displayed title */
  id: string;
  label: string;
  /** shown on a fresh install (the 9 historical Dashboard cards); launcher cards are opt-in */
  defaultVisible: boolean;
  description: string;
}

export const DASHBOARD_LAYOUT_VERSION = 1;
export const DASHBOARD_STORAGE_KEY = 'docteur.dashboardLayout';
/** the first visible cards take the four corners around the Cortex (tl, tr, bl, br); the rest go to the right rail */
export const CORNER_SLOTS = ['tl', 'tr', 'bl', 'br'] as const;
export type CornerSlot = typeof CORNER_SLOTS[number];

/** Default order = the historical Dashboard (4 corners, then the rail), then the opt-in launcher cards. */
export const DASHBOARD_CARDS: readonly DashboardCardDefinition[] = Object.freeze([
  { id: 'metagpt', label: 'MetaGPT', defaultVisible: true, description: 'Studio multi-agents' },
  { id: 'sherlock', label: 'Sherlock', defaultVisible: true, description: 'Recherche de pseudonymes' },
  { id: 'investment', label: 'Investment', defaultVisible: true, description: 'Analyse d’investissement' },
  { id: 'video-studio', label: 'Studio Vidéo', defaultVisible: true, description: 'Rendu MP4 local' },
  { id: 'connectors', label: 'Connecteurs', defaultVisible: true, description: 'Sources connectées' },
  { id: 'observateur', label: 'Observateur', defaultVisible: true, description: 'Surveillance locale' },
  { id: 'maitre', label: 'MAÎTRE', defaultVisible: true, description: 'Assistant système' },
  { id: 'quick-actions', label: 'Actions rapides', defaultVisible: true, description: 'Raccourcis des studios' },
  { id: 'activity', label: 'Activité récente', defaultVisible: true, description: 'Derniers événements' },
  { id: 'notebook', label: 'Notebook', defaultVisible: false, description: 'Carnets de documents' },
  { id: 'teacher', label: 'Professeur', defaultVisible: false, description: 'Cours guidés' },
  { id: 'capture', label: 'Capture / YouTube', defaultVisible: false, description: 'URL, articles, chaînes YouTube' },
  { id: 'kiwix', label: 'Kiwix', defaultVisible: false, description: 'Encyclopédies hors-ligne' },
  { id: 'image-generator', label: 'Images', defaultVisible: false, description: 'Génération d’images' },
  { id: 'agents', label: 'Agents', defaultVisible: false, description: 'Agents planifiés' },
  { id: 'skills', label: 'Compétences', defaultVisible: false, description: 'Compétences et outils' },
  { id: 'prompt-generator', label: 'Générateur de prompts', defaultVisible: false, description: 'Prompts structurés' },
  { id: 'corpus', label: 'Corpus', defaultVisible: false, description: 'Import de corpus' },
  { id: 'todo', label: 'À faire', defaultVisible: false, description: 'Liste de tâches' },
  { id: 'rassilon', label: 'RASSILON', defaultVisible: false, description: 'Calcul local & LAN' },
  { id: 'devices', label: 'Appareils', defaultVisible: false, description: 'Inventaire Device Fabric' },
  { id: 'omega', label: 'OMEGA', defaultVisible: false, description: 'Écran distant (lecture seule)' },
]);

export interface DashboardPreference { version: number; order: string[]; hidden: string[] }
export interface DashboardLayout {
  /** every known card id, in the user's order (hidden ones included, so their place is kept) */
  order: string[];
  hidden: ReadonlySet<string>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function cleanIds(value: unknown, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !ID_RE.test(id) || !known.has(id) || seen.has(id)) continue; // unknown / duplicate / junk
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function defaultDashboardLayout(catalog: readonly DashboardCardDefinition[] = DASHBOARD_CARDS): DashboardLayout {
  return { order: catalog.map(c => c.id), hidden: new Set(catalog.filter(c => !c.defaultVisible).map(c => c.id)) };
}

/**
 * Reconciles a stored preference (anything: missing, corrupt, older, from a newer version…) with the current catalog.
 * Cards the preference never mentioned are inserted right after their default predecessor, with their default visibility.
 */
export function resolveDashboardLayout(stored: unknown, catalog: readonly DashboardCardDefinition[] = DASHBOARD_CARDS): DashboardLayout {
  const pref = stored as Partial<DashboardPreference> | null;
  if (!pref || typeof pref !== 'object' || Array.isArray(pref) || pref.version !== DASHBOARD_LAYOUT_VERSION) return defaultDashboardLayout(catalog);
  const known = new Set(catalog.map(c => c.id));
  const order = cleanIds(pref.order, known);
  const hiddenIds = cleanIds(pref.hidden, known);
  const mentioned = new Set([...order, ...hiddenIds]);
  const hidden = new Set(hiddenIds);
  catalog.forEach((card, index) => {
    if (mentioned.has(card.id)) {
      if (!order.includes(card.id)) order.push(card.id); // only in `hidden`: keep it, at the end
      return;
    }
    // a card unknown to this preference (added by a newer Docteur): default place, default visibility
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const pos = order.indexOf(catalog[i].id);
      if (pos >= 0) { at = pos + 1; break; }
    }
    order.splice(at, 0, card.id);
    if (!card.defaultVisible) hidden.add(card.id);
  });
  return { order, hidden };
}

export function toPreference(layout: DashboardLayout): DashboardPreference {
  return { version: DASHBOARD_LAYOUT_VERSION, order: [...layout.order], hidden: layout.order.filter(id => layout.hidden.has(id)) };
}

export const visibleCards = (layout: DashboardLayout): string[] => layout.order.filter(id => !layout.hidden.has(id));

/** Corner slot → card id, then the rail; the four corners keep the historical composition around the Cortex. */
export function placeCards(layout: DashboardLayout): { corners: Array<{ slot: CornerSlot; id: string }>; rail: string[] } {
  const visible = visibleCards(layout);
  return {
    corners: visible.slice(0, CORNER_SLOTS.length).map((id, i) => ({ slot: CORNER_SLOTS[i], id })),
    rail: visible.slice(CORNER_SLOTS.length),
  };
}

/** Moves one VISIBLE card to the position of another visible card (drag & drop). Hidden cards keep their place. */
export function moveCard(layout: DashboardLayout, draggedId: string, targetId: string): DashboardLayout {
  if (draggedId === targetId || !layout.order.includes(draggedId) || !layout.order.includes(targetId)) return layout;
  const order = layout.order.filter(id => id !== draggedId);
  const forward = layout.order.indexOf(draggedId) < layout.order.indexOf(targetId);
  order.splice(order.indexOf(targetId) + (forward ? 1 : 0), 0, draggedId);
  return { ...layout, order };
}

/** Keyboard / button move among the VISIBLE cards: -1 = earlier, +1 = later. */
export function moveCardBy(layout: DashboardLayout, id: string, delta: -1 | 1): DashboardLayout {
  const visible = visibleCards(layout);
  const i = visible.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= visible.length) return layout;
  return moveCard(layout, id, visible[j]);
}

export function hideCard(layout: DashboardLayout, id: string): DashboardLayout {
  if (!layout.order.includes(id) || layout.hidden.has(id)) return layout;
  return { ...layout, hidden: new Set([...layout.hidden, id]) };
}

/** Shows a card again; it comes back at the END of the visible cards (where the user will see it). */
export function showCard(layout: DashboardLayout, id: string): DashboardLayout {
  if (!layout.hidden.has(id)) return layout;
  const hidden = new Set(layout.hidden); hidden.delete(id);
  const order = layout.order.filter(x => x !== id);
  const lastVisible = order.reduce((acc, x, i) => (hidden.has(x) ? acc : i), -1);
  order.splice(lastVisible + 1, 0, id);
  return { order, hidden };
}

export const sameLayout = (a: DashboardLayout, b: DashboardLayout): boolean =>
  a.order.length === b.order.length && a.order.every((id, i) => id === b.order[i])
  && a.hidden.size === b.hidden.size && [...a.hidden].every(id => b.hidden.has(id));

// ── persistence (local only, existing docteur.* localStorage convention; never a secret, never the network) ──────────

export function loadDashboardLayout(storage: Pick<Storage, 'getItem'> | null = safeStorage()): DashboardLayout {
  try {
    const raw = storage?.getItem(DASHBOARD_STORAGE_KEY);
    return resolveDashboardLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultDashboardLayout(); // corrupt JSON / storage unavailable
  }
}

export function saveDashboardLayout(layout: DashboardLayout, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try { storage?.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(toPreference(layout))); return Boolean(storage); } catch { return false; }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
