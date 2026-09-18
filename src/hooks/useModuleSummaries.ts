// HUD dashboard — one thin summary hook per module widget. Each hook reuses
// the EXISTING client functions (cortexClient/metagptRequest/investmentRequest)
// — never a new backend endpoint, never fabricated data. A module with no
// real state yet returns status: 'unavailable', never a fake "idle".
import { useMemo } from 'react';
import { useIntervalPoll } from './useIntervalPoll';
import { cortexClient } from '../lib/cortex/client';
import { metagptRequest, type Mission } from '../lib/metagpt-studio';
import { investmentRequest, type PaperPortfolio } from '../lib/investment-studio';
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
