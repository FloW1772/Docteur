// Local, per-device settings for the reference corpus feature — never synced
// to the server, matches the "100% local" requirement.

const SHOW_3D_KEY      = 'docteur-corpus-show-3d';
const TRUSTED_SITES_KEY = 'docteur-corpus-trusted-sites';

export function getCorpusShowIn3D(): boolean {
  try { return localStorage.getItem(SHOW_3D_KEY) === 'true'; } catch { return false; }
}

export function setCorpusShowIn3D(value: boolean): void {
  try { localStorage.setItem(SHOW_3D_KEY, String(value)); } catch { /* ignore */ }
  window.dispatchEvent(new Event('docteur-corpus-3d-changed'));
}

export function getCorpusTrustedSites(): string[] {
  try {
    const raw = localStorage.getItem(TRUSTED_SITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

export function setCorpusTrustedSites(sites: string[]): void {
  try { localStorage.setItem(TRUSTED_SITES_KEY, JSON.stringify(sites)); } catch { /* ignore */ }
}

export function addCorpusTrustedSite(site: string): string[] {
  const cleaned = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!cleaned) return getCorpusTrustedSites();
  const current = getCorpusTrustedSites();
  if (current.includes(cleaned)) return current;
  const next = [...current, cleaned];
  setCorpusTrustedSites(next);
  return next;
}

export function removeCorpusTrustedSite(site: string): string[] {
  const next = getCorpusTrustedSites().filter(s => s !== site);
  setCorpusTrustedSites(next);
  return next;
}
