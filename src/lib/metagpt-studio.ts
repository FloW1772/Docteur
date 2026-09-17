export interface DiffPackage {
  ok: boolean;
  job_id: string;
  diff_sha256: string;
  package_sha256: string;
  diff_text: string;
  files: { source: string; destination: string; operation: string }[];
  security_findings: { file: string; pattern: string; classification: string }[];
  dependency_requests: { package: string; reason: string }[];
  blocked_findings: number;
}
export interface Mission {
  id: string; title: string; mode: string; current_state: string; approved: boolean;
  diff_sha256: string | null; error_message?: string;
  metadata: { prepare_apply?: DiffPackage; approval?: { diff_sha256: string; files: string[] } };
  events: { id: string; to_state: string }[];
}
export interface Artifacts {
  planning: { prd: string | null; design: string | null; tasks: string | null };
  codegen: { path: string; content: string | null }[];
}
const base = `${window.location.protocol}//${window.location.hostname}:3001/api/metagpt/missions`;
export async function metagptRequest<T>(suffix = '', body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`${base}${suffix}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || data.state || `HTTP ${response.status}`);
  return data as T;
}
export function canApprove(mission: Mission | null, diff: DiffPackage | undefined): boolean {
  return !!(mission && diff?.ok && diff.job_id === mission.id && diff.diff_sha256 === mission.diff_sha256 &&
    diff.package_sha256 && diff.diff_text && diff.files?.length && mission.current_state === 'AWAITING_APPROVAL' &&
    diff.blocked_findings === 0 && !diff.security_findings?.some(f => f.classification === 'BLOCKED'));
}
export function canApply(mission: Mission | null, diff: DiffPackage | undefined): boolean {
  const approval = mission?.metadata.approval;
  if (!mission || !diff || !approval || !canApprove(mission, diff)) return false;
  return mission.approved && approval.diff_sha256 === diff.diff_sha256 &&
    JSON.stringify([...approval.files].sort()) === JSON.stringify(diff.files.map(f => f.destination).sort());
}
