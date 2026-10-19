// Companion V1 — COMP-6B dedicated HTTP implementation of CompanionUiPort.
// Fixed typed endpoints only; no generic RPC method name is accepted by the server.
import {
  CompanionUiError,
  type ActionResultDto,
  type ApprovalDto,
  type ChallengeDto,
  type CompanionStatusDto,
  type CompanionUiPort,
  type ContextExplainDto,
  type HumanApprovalIntent,
  type LocalMutationActionId,
  type MemoryExplainDto,
  type MemoryRowDto,
  type ProposalDto,
} from './ui-contracts';

type CallOptions = { json?: unknown };

export function createHttpCompanionUiPort({ baseUrl, fetchImpl = fetch }: { baseUrl: string; fetchImpl?: typeof fetch }): CompanionUiPort {
  const api = `${baseUrl.replace(/\/+$/, '')}/api/companion`;
  const id = (value: string) => encodeURIComponent(value);
  async function call<T>(method: string, url: string, { json }: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try { response = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }); }
    catch { throw new CompanionUiError('ACTION_FAILED', 'Docteur est injoignable.', 'NETWORK'); }
    let payload: { ok?: boolean; value?: T; error?: { code?: string; message?: string; reason?: string | null } } = {};
    try { payload = await response.json(); } catch { /* fail closed below */ }
    if (!response.ok || payload.ok !== true) throw new CompanionUiError(payload.error?.code ?? `HTTP_${response.status}`, payload.error?.message ?? 'Requête refusée.', payload.error?.reason ?? null);
    return payload.value as T;
  }
  return Object.freeze({
    openUiSession: () => call<{ uiSessionId: string }>('POST', `${api}/sessions`),
    closeUiSession: (uiSessionId: string) => call<boolean>('DELETE', `${api}/sessions/${id(uiSessionId)}`),
    getStatus: () => call<CompanionStatusDto>('GET', `${api}/status`),
    listMemories: () => call<MemoryRowDto[]>('GET', `${api}/memories`),
    explainMemory: (memoryId: string) => call<MemoryExplainDto>('GET', `${api}/memories/${id(memoryId)}/explanation`),
    explainContext: (requestId: string) => call<ContextExplainDto>('GET', `${api}/contexts/${id(requestId)}/explanation`),
    propose: (actionId: LocalMutationActionId, parameters: Record<string, unknown>) => call<ProposalDto>('POST', `${api}/proposals`, { json: { actionId, parameters } }),
    proposeFromModel: (rawOutput: unknown) => call<ProposalDto>('POST', `${api}/model-proposals`, { json: { rawOutput } }),
    getProposal: (proposalId: string) => call<ProposalDto>('GET', `${api}/proposals/${id(proposalId)}`),
    listProposals: () => call<ProposalDto[]>('GET', `${api}/proposals`), // [COMP-REMED-1]
    issueChallenge: (uiSessionId: string, proposalId: string) => call<ChallengeDto>('POST', `${api}/sessions/${id(uiSessionId)}/proposals/${id(proposalId)}/challenge`),
    submitIntent: (intent: HumanApprovalIntent) => call<ApprovalDto>('POST', `${api}/approvals`, { json: intent }),
    execute: (request) => call<ActionResultDto>('POST', `${api}/executions`, { json: request }),
    abortExecution: (executionId: string) => call<boolean>('POST', `${api}/executions/${id(executionId)}/abort`),
    reject: (proposalId: string) => call<ProposalDto>('POST', `${api}/proposals/${id(proposalId)}/reject`),
    cancel: (proposalId: string) => call<ProposalDto>('POST', `${api}/proposals/${id(proposalId)}/cancel`),
  } satisfies CompanionUiPort);
}
