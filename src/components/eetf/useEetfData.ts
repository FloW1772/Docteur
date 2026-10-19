// EETF V1 — EETF-7 shared data hook: status, assets, jobs (polled while a job is active).
import { useCallback, useEffect, useRef, useState } from 'react';
import { eetfClient, messageOf, type EetfAsset, type EetfJob, type EetfStatus } from '../../lib/eetf/client';

export interface EetfData {
  status: EetfStatus | null;
  statusError: string | null;
  loading: boolean;
  assets: EetfAsset[];
  jobs: EetfJob[];
  refreshStatus: (force?: boolean) => Promise<void>;
  refreshAssets: () => Promise<void>;
  refreshJobs: () => Promise<void>;
}

export function useEetfData(): EetfData {
  const [status, setStatus] = useState<EetfStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<EetfAsset[]>([]);
  const [jobs, setJobs] = useState<EetfJob[]>([]);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refreshStatus = useCallback(async (force = false) => {
    try { const s = await eetfClient.status(force); if (alive.current) { setStatus(s); setStatusError(null); } }
    catch (e) { if (alive.current) { setStatus(null); setStatusError(messageOf(e)); } }
  }, []);
  const refreshAssets = useCallback(async () => {
    try { const a = await eetfClient.listAssets(); if (alive.current) setAssets(a); } catch { /* status explains a disabled EETF */ }
  }, []);
  const refreshJobs = useCallback(async () => {
    try { const j = await eetfClient.listJobs(); if (alive.current) setJobs(j); } catch { /* idem */ }
  }, []);

  useEffect(() => {
    void (async () => { await refreshStatus(); await Promise.all([refreshAssets(), refreshJobs()]); if (alive.current) setLoading(false); })();
  }, [refreshStatus, refreshAssets, refreshJobs]);

  const active = jobs.some(j => j.status === 'QUEUED' || j.status === 'RUNNING');
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { void refreshJobs().then(refreshAssets); }, 700);
    return () => clearInterval(t);
  }, [active, refreshJobs, refreshAssets]);

  return { status, statusError, loading, assets, jobs, refreshStatus, refreshAssets, refreshJobs };
}
