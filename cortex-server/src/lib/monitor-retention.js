/**
 * Observateur passive monitoring — retention/purge. Copies
 * purgeRequestLogsOlderThan's batched-delete pattern (see sqlite.js),
 * scoped ONLY to monitor_* tables via purgeMonitorDataOlderThan — never
 * touches cyber_audit_* or any other Docteur data. Checked once per
 * monitor-service.js tick (cheap timestamp comparison), run at most
 * once per day.
 */
import { getMonitorSettings } from './monitor-config.js';
import { getMeta, setMeta, purgeMonitorDataOlderThan } from './sqlite.js';

const LAST_PURGE_META_KEY = 'monitor_last_purge_at';
const PURGE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function maybeRunRetentionPurge() {
  const lastPurgeAt = getMeta(LAST_PURGE_META_KEY);
  const lastMs = lastPurgeAt ? new Date(lastPurgeAt).getTime() : 0;
  if (Date.now() - lastMs < PURGE_CHECK_INTERVAL_MS) return 0;

  const settings = getMonitorSettings();
  const deleted = purgeMonitorDataOlderThan(settings.retentionDays);
  setMeta(LAST_PURGE_META_KEY, new Date().toISOString());
  return deleted;
}
