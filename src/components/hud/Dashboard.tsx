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
import { Bot, Search, LineChart, Clapperboard, Plug, Settings as SettingsIcon } from 'lucide-react';
import ModuleWidget from './ModuleWidget';
import QuickAction from './QuickAction';
import ActivityItem, { type HudActivityEvent } from './ActivityItem';
import HudPanel from './HudPanel';
import CortexLinks from './CortexLinks';
import {
  useMetaGptSummary, useSherlockSummary, useInvestmentSummary, useOpenMontageSummary, useConnectorsSummary,
  useCyberAuditSummary,
} from '../../hooks/useModuleSummaries';

interface Props {
  lastSherlockJobId: string | null;
  activityEvents: HudActivityEvent[];
  onOpenMetaGpt: () => void;
  onOpenSherlock: () => void;
  onOpenInvestment: () => void;
  onOpenVideoSummary: () => void;
  onOpenCyberAudit: () => void;
  onOpenSettings: () => void;
  onQuickMetaGptMission: () => void;
  onQuickSherlockSearch: () => void;
  onQuickInvestmentAnalysis: () => void;
  onQuickVideoRender: () => void;
}

export default function Dashboard({
  lastSherlockJobId, activityEvents,
  onOpenMetaGpt, onOpenSherlock, onOpenInvestment, onOpenVideoSummary, onOpenCyberAudit, onOpenSettings,
  onQuickMetaGptMission, onQuickSherlockSearch, onQuickInvestmentAnalysis, onQuickVideoRender,
}: Props) {
  const metagpt = useMetaGptSummary();
  const sherlock = useSherlockSummary(lastSherlockJobId);
  const investment = useInvestmentSummary();
  const openMontage = useOpenMontageSummary();
  const connectors = useConnectorsSummary();
  const cyberAudit = useCyberAuditSummary();

  const modules = [
    { key: 'metagpt', active: metagpt.status !== 'unavailable' && metagpt.status !== 'idle' },
    { key: 'sherlock', active: sherlock.status !== 'unavailable' && sherlock.status !== 'idle' },
    { key: 'investment', active: investment.status !== 'unavailable' && investment.status !== 'idle' },
    { key: 'video', active: openMontage.status !== 'unavailable' && openMontage.status !== 'idle' },
  ];

  return (
    <>
      <CortexLinks activeKeys={modules.filter(m => m.active).map(m => m.key)} />

      <div className="hud2-corner hud2-corner--tl">
        <ModuleWidget
          name="MetaGPT" status={metagpt.status} metric={metagpt.metric} detail={metagpt.detail}
          loading={metagpt.loading} error={metagpt.error ?? undefined} onOpen={onOpenMetaGpt} openLabel="Ouvrir Studio"
        />
      </div>

      <div className="hud2-corner hud2-corner--tr">
        <ModuleWidget
          name="Sherlock" status={sherlock.status} metric={sherlock.metric} detail={sherlock.detail}
          loading={sherlock.loading} error={sherlock.error ?? undefined} onOpen={onOpenSherlock} openLabel="Ouvrir"
        />
      </div>

      <div className="hud2-corner hud2-corner--bl">
        <ModuleWidget
          name="Investment" status={investment.status} metric={investment.metric} detail={investment.detail}
          loading={investment.loading} error={investment.error ?? undefined} onOpen={onOpenInvestment} openLabel="Ouvrir Studio"
        />
      </div>

      <div className="hud2-corner hud2-corner--br">
        <ModuleWidget
          name="Studio Vidéo" status={openMontage.status} metric={openMontage.metric}
          detail="Rendu MP4 local"
          loading={openMontage.loading} error={openMontage.error ?? undefined} onOpen={onOpenVideoSummary} openLabel="Ouvrir"
        />
      </div>

      <aside className="hud2-rail hud2-rail--top" aria-label="Connecteurs et actions">
        <ModuleWidget
          name="Connecteurs" status={connectors.status} metric={connectors.metric} detail={connectors.detail}
          loading={connectors.loading} error={connectors.error ?? undefined} onOpen={onOpenSettings} openLabel="Gérer"
        />

        <ModuleWidget
          name="Cyber Audit" status={cyberAudit.status} metric={cyberAudit.metric} detail={cyberAudit.detail}
          loading={cyberAudit.loading} error={cyberAudit.error ?? undefined} onOpen={onOpenCyberAudit} openLabel="Ouvrir Cyber Studio"
        />

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

        <HudPanel title="Activité récente" compact>
          {activityEvents.length === 0 ? (
            <p className="hud2-module-widget-detail" role="status">Aucun événement récent.</p>
          ) : (
            <ul className="hud2-activity-list">
              {activityEvents.map(event => <ActivityItem key={event.id} event={event} />)}
            </ul>
          )}
        </HudPanel>
      </aside>
    </>
  );
}
