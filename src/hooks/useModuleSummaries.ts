// HUD dashboard — one thin summary hook per module widget. Each hook reuses
// the EXISTING client functions (cortexClient/metagptRequest/investmentRequest)
// — never a new backend endpoint, never fabricated data. A module with no
// real state yet returns status: 'unavailable', never a fake "idle".
import { useMemo } from 'react';
import { useIntervalPoll } from './useIntervalPoll';
import { cortexClient } from '../lib/cortex/client';
import { metagptRequest, type Mission } from '../lib/metagpt-studio';
import { investmentRequest, type PaperPortfolio } from '../lib/investment-studio';
import { listCyberMissions } from '../lib/cyber-audit-studio';
import { getMonitorStatus } from '../lib/monitor-studio';
import { getMaitreOverview } from '../lib/maitre-studio';
import type { WidgetStatus } from '../components/hud/StatusIndicator';

export interface ModuleSummary {
  status: WidgetStatus;
  metric?: string;
  detail?: string;
  loading: boolean;
  error: string | null;
}

const METAGPT_STATE_TO_WIDGET: Record<string, WidgetStatus> = {
  CREATED: 'idle', PLANNING: 'thinking', PRD_READY: 'thinking', DESIGN_READY: 'thinking',
  TASKS_READY: 'idle', GENERATING: 'generating', CODE_READY: 'idle', PREPARING_DIFF: 'thinking',
  AWAITING_APPROVAL: 'idle', APPLYING: 'generating', APPLIED: 'done',
  FAILED: 'error', CANCELLED: 'error', BLOCKED_BY_POLICY: 'error', APPROVAL_INVALIDATED: 'error',
};

export function useMetaGptSummary(): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(() => metagptRequest<{ missions: Mission[] }>(''), 15000);
  return useMemo(() => {
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'MetaGPT indisponible' };
    const missions = data?.missions ?? [];
    if (missions.length === 0) return { status: 'unavailable', loading: false, error: null, detail: 'Aucune mission' };
    const latest = missions[0];
    return {
      status: METAGPT_STATE_TO_WIDGET[latest.current_state] ?? 'idle',
      metric: latest.current_state,
      detail: latest.title,
      loading: false,
      error: null,
    };
  }, [data, loading, error]);
}

export function useSherlockSummary(lastJobId: string | null): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(
    () => (lastJobId ? cortexClient.getSherlockJob(lastJobId) : Promise.resolve(null)),
    15000,
    [lastJobId],
  );
  return useMemo(() => {
    if (!lastJobId) return { status: 'unavailable', loading: false, error: null, detail: 'Aucune recherche récente' };
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'Sherlock indisponible' };
    if (!data) return { status: 'unavailable', loading: false, error: null };
    const running = data.status === 'running';
    const resultsCount = data.summary?.results?.length ?? 0;
    return {
      status: running ? 'searching' : data.status === 'done' ? 'done' : data.status === 'cancelled' || data.status === 'error' ? 'error' : 'idle',
      metric: running ? `${data.current}/${data.total} sites` : `${resultsCount} résultat${resultsCount === 1 ? '' : 's'}`,
      detail: data.username,
      loading: false,
      error: null,
    };
  }, [data, loading, error, lastJobId]);
}

export function useInvestmentSummary(): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(() => investmentRequest<{ portfolios: PaperPortfolio[] }>('/portfolios'), 20000);
  return useMemo(() => {
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'Investment indisponible' };
    const portfolios = data?.portfolios ?? [];
    if (portfolios.length === 0) return { status: 'unavailable', loading: false, error: null, detail: 'Aucun portefeuille simulé' };
    const total = portfolios.reduce((sum, p) => sum + p.cash, 0);
    return {
      status: 'idle',
      metric: `${portfolios.length} portefeuille${portfolios.length === 1 ? '' : 's'}`,
      detail: `Cash total simulé : ${total.toFixed(2)} ${portfolios[0].base_currency}`,
      loading: false,
      error: null,
    };
  }, [data, loading, error]);
}

export function useOpenMontageSummary(): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(() => cortexClient.getOpenMontageStatus(), 15000);
  return useMemo(() => {
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'OpenMontage indisponible' };
    if (!data) return { status: 'unavailable', loading: false, error: null };
    const statusMap: Record<string, WidgetStatus> = {
      NOT_INSTALLED: 'unavailable', PARTIAL: 'unavailable', READY_LOCAL: 'idle', BUSY: 'generating', ERROR: 'error',
    };
    return {
      status: statusMap[data.status] ?? 'unavailable',
      metric: data.status,
      loading: false,
      error: null,
    };
  }, [data, loading, error]);
}

const CYBER_STATUS_TO_WIDGET: Record<string, WidgetStatus> = {
  CREATED: 'idle', READY: 'idle', RUNNING: 'searching', COMPLETED: 'done',
  CANCELLED: 'error', FAILED: 'error', BLOCKED_BY_POLICY: 'error',
};

export function useCyberAuditSummary(): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(() => listCyberMissions(), 15000);
  return useMemo(() => {
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'Cyber Audit indisponible' };
    const missions = data?.missions ?? [];
    if (missions.length === 0) return { status: 'unavailable', loading: false, error: null, detail: 'Aucune mission' };
    const latest = missions[0];
    return {
      status: CYBER_STATUS_TO_WIDGET[latest.status] ?? 'idle',
      metric: `${latest.counts.findings} finding${latest.counts.findings === 1 ? '' : 's'}`,
      detail: latest.title,
      loading: false,
      error: null,
    };
  }, [data, loading, error]);
}

export function useObservateurSummary(): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(() => getMonitorStatus(), 15000);
  return useMemo(() => {
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'Observateur indisponible' };
    const status = data?.status;
    if (!status) return { status: 'unavailable', loading: false, error: null, detail: 'Arrêté' };
    if (status.degraded) return { status: 'error', loading: false, error: null, detail: 'MONITORING DEGRADED' };
    if (!status.enabled) return { status: 'unavailable', loading: false, error: null, detail: 'Arrêté' };
    return {
      status: status.paused ? 'idle' : 'searching',
      metric: status.paused ? 'En pause' : 'Actif',
      detail: status.lastReportAt ? `Dernier rapport : ${new Date(status.lastReportAt).toLocaleDateString('fr-FR')}` : 'Aucun rapport',
      loading: false,
      error: null,
    };
  }, [data, loading, error]);
}

/**
 * MAÎTRE widget summary (MA-11 mission §31/§32) — status/open-incident-
 * count/highest-severity/pending-approval-count/isolation-active only,
 * derived exclusively from GET /api/maitre/overview's real data. No
 * destructive action is ever offered here — the widget only opens
 * MAÎTRE Studio (mission §31: no "Kill"/"Isolate" button on the widget
 * itself). A plain anomaly is never inflated to a CRITICAL visual state
 * — the mapping below only ever reflects what the backend's own
 * deterministic severity/isolation fields report.
 */
export function useMaitreSummary(): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(() => getMaitreOverview(), 15000);
  return useMemo(() => {
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'MAÎTRE indisponible' };
    const overview = data?.overview;
    if (!overview) return { status: 'unavailable', loading: false, error: null, detail: 'Aucune donnée' };

    if (overview.isolationStatus === 'ISOLATION_ACTIVE') {
      return { status: 'error', metric: 'Isolé', detail: 'Isolation réseau active', loading: false, error: null };
    }
    if (overview.isolationStatus === 'PARTIAL_FAILURE' || overview.isolationStatus === 'MANUAL_REVIEW') {
      return { status: 'error', metric: 'Révision requise', detail: 'Isolation en échec partiel', loading: false, error: null };
    }
    if (overview.highestActiveSeverity === 'CRITICAL' || overview.highestActiveSeverity === 'HIGH') {
      return { status: 'error', metric: `${overview.openIncidentCount} incident(s)`, detail: overview.highestActiveSeverity, loading: false, error: null };
    }
    if (overview.pendingApprovalCount > 0) {
      return { status: 'thinking', metric: `${overview.pendingApprovalCount} en attente`, detail: 'Approbation requise', loading: false, error: null };
    }
    if (overview.openIncidentCount > 0) {
      return { status: 'searching', metric: `${overview.openIncidentCount} incident(s)`, detail: 'En observation', loading: false, error: null };
    }
    return { status: 'done', metric: 'Sain', detail: 'Aucun incident ouvert', loading: false, error: null };
  }, [data, loading, error]);
}

export function useConnectorsSummary(): ModuleSummary {
  const { data, loading, error } = useIntervalPoll(() => cortexClient.listConnectors(), 30000);
  return useMemo(() => {
    if (loading) return { status: 'unavailable', loading: true, error: null };
    if (error) return { status: 'error', loading: false, error, detail: 'Connecteurs indisponibles' };
    const connectors = data?.connectors ?? [];
    const connectedCount = connectors.filter(c => c.connected).length;
    const configuredCount = connectors.filter(c => c.client_configured && !c.connected).length;
    const errorCount = connectors.filter(c => c.last_sync_status === 'error').length;
    // Never conflate "configured" (OAuth app registered) with "connected"
    // (account authorized) — mission requirement 15.
    return {
      status: errorCount > 0 ? 'error' : connectedCount > 0 ? 'idle' : 'unavailable',
      metric: `${connectedCount} connecté${connectedCount === 1 ? '' : 's'}`,
      detail: configuredCount > 0 ? `${configuredCount} configuré${configuredCount === 1 ? '' : 's'} sans connexion` : undefined,
      loading: false,
      error: null,
    };
  }, [data, loading, error]);
}
