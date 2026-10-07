// HUD Command Center V2 — Dashboard mode layout. Deliberately thin
// orchestration: composes ModuleWidget/QuickAction/ActivityItem, never
// reimplements MetaGPT/Sherlock/Investment/OpenMontage logic inline
// (mission requirement 10: "éviter un composant gigantesque Dashboard.tsx
// de 2000 lignes"). All data comes from useModuleSummaries (real client
// calls) — nothing here is fabricated.
//
// V2.1: widgets moved from two stacked rails into four corners around the
// Cortex (mission requirement 4 — "une vraie composition autour de lui"),
// linked to the core with a thin SVG overlay (CortexLinks). Purely a layout
// change: same components, same data, same callbacks.
//
// Customizable Dashboard V1: the user orders / hides the cards (lib/dashboard/dashboard-layout.ts). The first four
// visible cards take the corners, the others the right rail — the default layout is exactly the V2.1 one. Each summary
// card owns its hook, so a hidden card is unmounted and stops polling. Hiding a card never disables the feature.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Bot, Search, LineChart, Clapperboard, Plug, Settings as SettingsIcon, SlidersHorizontal, GripVertical } from 'lucide-react';
import ModuleWidget from './ModuleWidget';
import QuickAction from './QuickAction';
import ActivityItem, { type HudActivityEvent } from './ActivityItem';
import HudPanel from './HudPanel';
import CortexLinks from './CortexLinks';
import DashboardCustomizer from './DashboardCustomizer';
import {
  useMetaGptSummary, useSherlockSummary, useInvestmentSummary, useOpenMontageSummary, useConnectorsSummary,
  useObservateurSummary, useMaitreSummary, type ModuleSummary,
} from '../../hooks/useModuleSummaries';
import {
  DASHBOARD_CARDS, defaultDashboardLayout, loadDashboardLayout, moveCard, placeCards, sameLayout, saveDashboardLayout, visibleCards,
  type DashboardLayout,
} from '../../lib/dashboard/dashboard-layout';

/** ids of the optional launcher cards → the SAME opener the TopBar / menu already use */
export type DashboardLaunchers = Partial<Record<string, () => void>>;

interface Props {
  lastSherlockJobId: string | null;
  activityEvents: HudActivityEvent[];
  onOpenMetaGpt: () => void;
  onOpenSherlock: () => void;
  onOpenInvestment: () => void;
  onOpenVideoSummary: () => void;
  onOpenObservateur: () => void;
  onOpenMaitre: () => void;
  onOpenSettings: () => void;
  onQuickMetaGptMission: () => void;
  onQuickSherlockSearch: () => void;
  onQuickInvestmentAnalysis: () => void;
  onQuickVideoRender: () => void;
  launchers?: DashboardLaunchers;
}

type ReportActive = (id: string, active: boolean) => void;
const isActive = (s: ModuleSummary) => s.status !== 'unavailable' && s.status !== 'idle';

function SummaryCard({ id, name, summary, onOpen, openLabel, detail, onActive }: {
  id: string; name: string; summary: ModuleSummary; onOpen: () => void; openLabel: string; detail?: string; onActive: ReportActive;
}) {
  const active = isActive(summary);
  useEffect(() => { onActive(id, active); }, [id, active, onActive]);
  return (
    <ModuleWidget
      name={name} status={summary.status} metric={summary.metric} detail={detail ?? summary.detail}
      loading={summary.loading} error={summary.error ?? undefined} onOpen={onOpen} openLabel={openLabel}
    />
  );
}
// one component per hook: mounted only while its card is visible
const MetaGptCard = (p: { onOpen: () => void; onActive: ReportActive }) => <SummaryCard id="metagpt" name="MetaGPT" summary={useMetaGptSummary()} openLabel="Ouvrir Studio" {...p} />;
const SherlockCard = (p: { jobId: string | null; onOpen: () => void; onActive: ReportActive }) => <SummaryCard id="sherlock" name="Sherlock" summary={useSherlockSummary(p.jobId)} openLabel="Ouvrir" onOpen={p.onOpen} onActive={p.onActive} />;
const InvestmentCard = (p: { onOpen: () => void; onActive: ReportActive }) => <SummaryCard id="investment" name="Investment" summary={useInvestmentSummary()} openLabel="Ouvrir Studio" {...p} />;
const VideoStudioCard = (p: { onOpen: () => void; onActive: ReportActive }) => <SummaryCard id="video-studio" name="Studio Vidéo" summary={useOpenMontageSummary()} detail="Rendu MP4 local" openLabel="Ouvrir" {...p} />;
const ConnectorsCard = (p: { onOpen: () => void; onActive: ReportActive }) => <SummaryCard id="connectors" name="Connecteurs" summary={useConnectorsSummary()} openLabel="Gérer" {...p} />;
const ObservateurCard = (p: { onOpen: () => void; onActive: ReportActive }) => <SummaryCard id="observateur" name="Observateur" summary={useObservateurSummary()} openLabel="Ouvrir Observateur" {...p} />;
const MaitreCard = (p: { onOpen: () => void; onActive: ReportActive }) => <SummaryCard id="maitre" name="MAÎTRE" summary={useMaitreSummary()} openLabel="Ouvrir MAÎTRE" {...p} />;

const CARD_BY_ID = new Map(DASHBOARD_CARDS.map(c => [c.id, c]));

function LauncherCard({ id, onOpen }: { id: string; onOpen?: () => void }) {
  const card = CARD_BY_ID.get(id);
  return (
    <HudPanel compact className="hud2-module-widget" ariaLabel={`Module ${card?.label ?? id}`}>
      <div className="hud2-module-widget-header"><strong className="hud2-module-widget-name">{card?.label ?? id}</strong></div>
      {card?.description && <p className="hud2-module-widget-detail">{card.description}</p>}
      {onOpen && <button type="button" className="hud2-module-widget-open" onClick={onOpen}>Ouvrir</button>}
    </HudPanel>
  );
}

export default function Dashboard({
  lastSherlockJobId, activityEvents,
  onOpenMetaGpt, onOpenSherlock, onOpenInvestment, onOpenVideoSummary, onOpenObservateur, onOpenMaitre, onOpenSettings,
  onQuickMetaGptMission, onQuickSherlockSearch, onQuickInvestmentAnalysis, onQuickVideoRender, launchers = {},
}: Props) {
  const [layout, setLayout] = useState<DashboardLayout>(() => loadDashboardLayout());
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [editing, setEditing] = useState(false);
  const [activeIds, setActiveIds] = useState<ReadonlySet<string>>(() => new Set());
  const onActive = useCallback<ReportActive>((id, active) => {
    setActiveIds(prev => (prev.has(id) === active ? prev : new Set(active ? [...prev, id] : [...prev].filter(x => x !== id))));
  }, []);

  // persist ONLY when the layout really changes (drop, move, hide, show, restore) — never while dragging
  const commit = useCallback((next: DashboardLayout) => {
    if (sameLayout(layoutRef.current, next)) return;
    layoutRef.current = next;
    setLayout(next);
    saveDashboardLayout(next);
  }, []);

  const renderCard = (id: string) => {
    switch (id) {
      case 'metagpt': return <MetaGptCard onOpen={onOpenMetaGpt} onActive={onActive} />;
      case 'sherlock': return <SherlockCard jobId={lastSherlockJobId} onOpen={onOpenSherlock} onActive={onActive} />;
      case 'investment': return <InvestmentCard onOpen={onOpenInvestment} onActive={onActive} />;
      case 'video-studio': return <VideoStudioCard onOpen={onOpenVideoSummary} onActive={onActive} />;
      case 'connectors': return <ConnectorsCard onOpen={onOpenSettings} onActive={onActive} />;
      case 'observateur': return <ObservateurCard onOpen={onOpenObservateur} onActive={onActive} />;
      case 'maitre': return <MaitreCard onOpen={onOpenMaitre} onActive={onActive} />;
      case 'quick-actions':
        return (
          <HudPanel title="Actions rapides" compact>
            <div className="hud2-quick-actions-list">
              <QuickAction icon={Bot} label="Nouvelle mission MetaGPT" onClick={onQuickMetaGptMission} />
              <QuickAction icon={Search} label="Recherche Sherlock" onClick={onQuickSherlockSearch} />
              <QuickAction icon={LineChart} label="Analyse investissement" onClick={onQuickInvestmentAnalysis} />
              <QuickAction icon={Clapperboard} label="Nouveau rendu vidéo" onClick={onQuickVideoRender} />
              <QuickAction icon={SettingsIcon} label="Ouvrir paramètres" onClick={onOpenSettings} />
              <QuickAction icon={Plug} label="Gérer les connecteurs" onClick={onOpenSettings} />
            </div>
          </HudPanel>
        );
      case 'activity':
        return (
          <HudPanel title="Activité récente" compact>
            {activityEvents.length === 0 ? (
              <p className="hud2-module-widget-detail" role="status">Aucun événement récent.</p>
            ) : (
              <ul className="hud2-activity-list">
                {activityEvents.map(event => <ActivityItem key={event.id} event={event} />)}
              </ul>
            )}
          </HudPanel>
        );
      default:
        return <LauncherCard id={id} onOpen={launchers[id]} />;
    }
  };

  // ── V1.1 direct reorder: in PERSONNALISER mode the cards around the Cortex are themselves movable. Pointer Events (not
  // HTML5 drag & drop, whose drop is lost on long paths across non-droppable areas): mouse, pen AND touch, pointer
  // capture on the grip overlay, target found by hit-testing. The dragged card follows the pointer through a DOM
  // transform (no React render per pixel); only a change of target re-renders. Same move rule (moveCard) and same single
  // commit as the panel → same persisted order. Nothing is written while moving; release outside a card, Esc or
  // pointercancel change nothing. A press without movement is not a drag (and never reaches "Ouvrir").
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const gesture = useRef<{ id: string; pointerId: number; x: number; y: number; started: boolean; over: string | null } | null>(null);
  // floating label that follows the pointer (the card itself stays in place: moving it would be clipped by the rail)
  const ghostRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef({ x: 0, y: 0 });
  const DRAG_THRESHOLD_PX = 5;
  const endDrag = useCallback(() => {
    gesture.current = null;
    setDragId(null); setOverId(null);
  }, []);
  useEffect(() => { if (!editing) endDrag(); }, [editing, endDrag]);
  useEffect(() => {
    if (!dragId) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); endDrag(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragId, endDrag]);
  const targetAt = (x: number, y: number, draggedId: string): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const card = (el as HTMLElement).closest?.('[data-testid="dashboard-card"]') as HTMLElement | null;
      const cardId = card?.dataset.cardId;
      if (cardId && cardId !== draggedId) return cardId;
    }
    return null;
  };
  const visibleOrder = visibleCards(layout);
  const editProps = (id: string) => (editing ? {
    'data-editing': 'true',
    'data-drop-target': overId === id && dragId !== id ? 'true' : undefined,
    'data-dragging': dragId === id ? 'true' : undefined,
  } : {});
  const gripHandlers = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already released: moves still reach us while over the grip */ }
      gesture.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, started: false, over: null };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g || g.pointerId !== e.pointerId) return;
      const dx = e.clientX - g.x; const dy = e.clientY - g.y;
      if (!g.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        g.started = true;
        setDragId(g.id);
      }
      lastPointer.current = { x: e.clientX, y: e.clientY };
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
      const over = targetAt(e.clientX, e.clientY, g.id);
      if (over !== g.over) { g.over = over; setOverId(over); }
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g || g.pointerId !== e.pointerId) return;
      const { started, over } = g;
      endDrag();
      if (started && over) commit(moveCard(layoutRef.current, g.id, over));
    },
    onPointerCancel: endDrag,
    onLostPointerCapture: (e: ReactPointerEvent<HTMLDivElement>) => { if (gesture.current?.pointerId === e.pointerId) endDrag(); },
  });
  // covers the card while editing: it is the grip, shows the drop target, and swallows clicks so "Ouvrir" never fires
  const editOverlay = (id: string) => editing && (
    <div
      className="hud2-card-edit-overlay"
      data-testid="dashboard-card-grip"
      aria-hidden="true"
      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
      {...gripHandlers(id)}
    >
      <GripVertical size={14} />
      <span className="hud2-card-edit-hint">Glisser pour déplacer</span>
      <span className="hud2-card-drop-hint">Déposer ici (position {visibleOrder.indexOf(id) + 1})</span>
    </div>
  );

  const { corners, rail } = placeCards(layout);
  const nothingVisible = corners.length === 0;

  return (
    <>
      <CortexLinks occupiedSlots={corners.map(c => c.slot)} activeSlots={corners.filter(c => activeIds.has(c.id)).map(c => c.slot)} />

      {corners.map(({ slot, id }) => (
        <div key={id} className={`hud2-corner hud2-corner--${slot}`} data-testid="dashboard-card" data-card-id={id} data-slot={slot} {...editProps(id)}>
          {renderCard(id)}
          {editOverlay(id)}
        </div>
      ))}

      {rail.length > 0 && (
        <aside className="hud2-rail hud2-rail--top" aria-label="Connecteurs et actions">
          {rail.map(id => (
            <div key={id} className="hud2-rail-card" data-testid="dashboard-card" data-card-id={id} data-slot="rail" {...editProps(id)}>
              {renderCard(id)}
              {editOverlay(id)}
            </div>
          ))}
        </aside>
      )}

      {dragId && (
        <div
          className="hud2-drag-ghost"
          data-testid="dashboard-drag-ghost"
          aria-hidden="true"
          ref={el => {
            (ghostRef as { current: HTMLDivElement | null }).current = el;
            if (el) el.style.transform = `translate(${lastPointer.current.x + 14}px, ${lastPointer.current.y + 14}px)`;
          }}
        >
          <GripVertical size={12} /> {CARD_BY_ID.get(dragId)?.label ?? dragId}
        </div>
      )}

      {nothingVisible && !editing && (
        <p className="hud2-dashboard-empty" role="status" data-testid="dashboard-empty">
          Toutes les cartes du Dashboard sont masquées. « Personnaliser » permet d’en réafficher.
        </p>
      )}

      {editing ? (
        <DashboardCustomizer
          layout={layout}
          onChange={commit}
          onRestoreDefaults={() => commit(defaultDashboardLayout())}
          onDone={() => setEditing(false)}
        />
      ) : (
        <button type="button" className="hud2-customize-toggle" data-testid="dashboard-customize" onClick={() => setEditing(true)} aria-label="Personnaliser le Dashboard" title="Personnaliser le Dashboard">
          <SlidersHorizontal size={11} /> PERSONNALISER
        </button>
      )}
    </>
  );
}
