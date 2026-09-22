// Dedicated lib file for the Code Intelligence Gateway, following the
// same shape as maitre-studio.ts/monitor-studio.ts: typed interfaces
// mirroring the backend's already-bounded API output, one generic
// request wrapper, errors piped through studioRequestError.
//
// This module is STRICTLY READ-ONLY end to end — there is no function
// here that could ever mutate a file or the git repository. If a future
// change ever needs write capability, that is a different, explicitly
// scoped module, never an addition to this one.
import { studioRequestError } from './studio-errors';

export type CodeIntelMatchType = 'text' | 'filename' | 'symbol_heuristic';

export interface CodeIntelSearchResult {
  relativePath: string;
  line: number | null;
  column: number | null;
  snippet: string | null;
  symbol?: string;
  language: string;
  matchType: CodeIntelMatchType;
}

export interface CodeIntelSearchResponse {
  ok: true;
  results: CodeIntelSearchResult[];
  truncated: boolean;
}

export interface CodeIntelStatus {
  ok: true;
  readOnly: true;
  gitAvailable: boolean;
  capabilities: string[];
}

export interface CodeIntelGitStatusEntry {
  statusCode: string;
  path: string;
}

export interface CodeIntelGitStatusResponse {
  ok: true;
  entries: CodeIntelGitStatusEntry[];
}

export interface CodeIntelGitDiffResponse {
  ok: true;
  diff: string;
  truncated: boolean;
}

export interface CodeIntelGitLogCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface CodeIntelGitLogResponse {
  ok: true;
  commits: CodeIntelGitLogCommit[];
}

export interface CodeIntelGitShowResponse {
  ok: true;
  content: string;
  truncated: boolean;
}

const base = `${window.location.protocol}//${window.location.hostname}:3001/api/code-intel`;

async function codeIntelRequest<T>(suffix: string): Promise<T> {
  const response = await fetch(`${base}${suffix}`, { method: 'GET' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(studioRequestError(data.error || data.code));
  return data as T;
}

export function getCodeIntelStatus(): Promise<CodeIntelStatus> {
  return codeIntelRequest('/status');
}

export function searchCodeIntel(query: string, kind: 'text' | 'filename' = 'text', limit = 50, caseSensitive = false): Promise<CodeIntelSearchResponse> {
  const params = new URLSearchParams({ q: query, kind, limit: String(limit) });
  if (caseSensitive) params.set('caseSensitive', 'true');
  return codeIntelRequest(`/search?${params.toString()}`);
}

export function searchCodeIntelSymbols(query: string, limit = 50): Promise<CodeIntelSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return codeIntelRequest(`/symbols?${params.toString()}`);
}

export function getCodeIntelGitStatus(): Promise<CodeIntelGitStatusResponse> {
  return codeIntelRequest('/git/status');
}

export function getCodeIntelGitDiff(staged = false, relPath?: string): Promise<CodeIntelGitDiffResponse> {
  const params = new URLSearchParams();
  if (staged) params.set('staged', 'true');
  if (relPath) params.set('path', relPath);
  const qs = params.toString();
  return codeIntelRequest(`/git/diff${qs ? `?${qs}` : ''}`);
}

export function getCodeIntelGitLog(limit = 20): Promise<CodeIntelGitLogResponse> {
  return codeIntelRequest(`/git/log?limit=${limit}`);
}

export function getCodeIntelGitShow(ref: string, relPath?: string): Promise<CodeIntelGitShowResponse> {
  const params = new URLSearchParams({ ref });
  if (relPath) params.set('path', relPath);
  return codeIntelRequest(`/git/show?${params.toString()}`);
}
