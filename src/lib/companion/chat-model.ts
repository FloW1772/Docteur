// Companion V1 — [COMP-9 CHAT] bounded conversation model of the Companion chat (pure; Node type stripping in tests).
//
// One generation at a time: a question opens one pending assistant turn, and only that turn's own answer can fill it.
// A cancelled, failed or retried turn changes id, so a late answer for an old id is simply dropped (never replaces a
// newer state). Nothing here is optimistic: an assistant turn only ever shows text the backend actually returned.
// The backend answers each question on its own (POST /companion/answers takes { text } only): this history is kept
// for display in this panel, it is not sent to the model and it is not stored anywhere.
import { errorText, type AnswerDto } from './ui-contracts.ts';

export const CHAT_LIMITS = Object.freeze({
  /** Same bound as the server (CONVERSATION_LIMITS.maxRequestChars). */
  maxInputChars: 16_000,
  /** Oldest turns are dropped from the display beyond this (never sent anywhere, never stored). */
  maxTurns: 40,
});

export type ChatTurnStatus = 'SENT' | 'PENDING' | 'DONE' | 'FAILED' | 'CANCELLED';
export interface ChatUserTurn { id: string; role: 'USER'; text: string; at: number; status: 'SENT' }
export interface ChatAssistantTurn {
  id: string; role: 'ASSISTANT'; forTurnId: string; at: number; status: Exclude<ChatTurnStatus, 'SENT'>;
  answer: AnswerDto | null; error: { code: string; text: string } | null;
}
export type ChatTurn = ChatUserTurn | ChatAssistantTurn;
export interface ChatState { turns: ChatTurn[]; activeId: string | null }

export type ChatEvent =
  | { type: 'send'; userId: string; assistantId: string; text: string; at: number }
  | { type: 'resolve'; assistantId: string; answer: AnswerDto }
  | { type: 'fail'; assistantId: string; code: string; reason?: string | null; message?: string | null }
  | { type: 'cancel'; assistantId: string }
  | { type: 'retry'; assistantId: string; newAssistantId: string; at: number };

export const EMPTY_CHAT: ChatState = Object.freeze({ turns: [], activeId: null }) as ChatState;

export function canSend(state: ChatState, text: string): boolean {
  return state.activeId === null && typeof text === 'string' && text.trim().length > 0 && text.length <= CHAT_LIMITS.maxInputChars;
}

/** Plain-French error for a failed answer. "Docteur est injoignable" only for a real network failure. */
export function chatErrorText(code: string, reason?: string | null): { code: string; text: string } {
  if (code === 'ACTION_FAILED' && reason === 'NETWORK') return { code: 'NETWORK', text: 'Docteur est injoignable : le serveur local ne répond pas.' };
  const e = errorText(code);
  return { code: e.code, text: e.known ? e.text : 'La réponse a échoué (raison inconnue).' };
}

const bound = (turns: ChatTurn[]): ChatTurn[] => (turns.length > CHAT_LIMITS.maxTurns ? turns.slice(turns.length - CHAT_LIMITS.maxTurns) : turns);
const isActive = (state: ChatState, id: string) => state.activeId === id
  && state.turns.some(t => t.id === id && t.role === 'ASSISTANT' && t.status === 'PENDING');
const patch = (state: ChatState, id: string, change: Partial<ChatAssistantTurn>): ChatTurn[] =>
  state.turns.map(t => (t.id === id && t.role === 'ASSISTANT' ? { ...t, ...change } : t));

export function chatReducer(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'send': {
      if (!canSend(state, event.text)) return state;
      const user: ChatUserTurn = { id: event.userId, role: 'USER', text: event.text, at: event.at, status: 'SENT' };
      const pending: ChatAssistantTurn = { id: event.assistantId, role: 'ASSISTANT', forTurnId: event.userId, at: event.at, status: 'PENDING', answer: null, error: null };
      return { turns: bound([...state.turns, user, pending]), activeId: event.assistantId };
    }
    case 'resolve':
      if (!isActive(state, event.assistantId)) return state; // late answer for a cancelled / retried / unknown turn
      return { turns: patch(state, event.assistantId, { status: 'DONE', answer: event.answer, error: null }), activeId: null };
    case 'fail':
      if (!isActive(state, event.assistantId)) return state;
      return { turns: patch(state, event.assistantId, { status: 'FAILED', answer: null, error: chatErrorText(event.code, event.reason) }), activeId: null };
    case 'cancel':
      if (!isActive(state, event.assistantId)) return state;
      return { turns: patch(state, event.assistantId, { status: 'CANCELLED', answer: null, error: null }), activeId: null };
    case 'retry': {
      if (state.activeId !== null) return state;
      const turn = state.turns.find(t => t.id === event.assistantId);
      if (!turn || turn.role !== 'ASSISTANT' || (turn.status !== 'FAILED' && turn.status !== 'CANCELLED')) return state;
      if (!state.turns.some(t => t.id === turn.forTurnId && t.role === 'USER')) return state;
      const fresh: ChatAssistantTurn = { ...turn, id: event.newAssistantId, at: event.at, status: 'PENDING', answer: null, error: null };
      return { turns: state.turns.map(t => (t.id === turn.id ? fresh : t)), activeId: event.newAssistantId };
    }
    default:
      return state;
  }
}

/** The question a pending assistant turn answers (what is sent, and re-sent on Retry). */
export function questionFor(state: ChatState, assistantId: string): string | null {
  const turn = state.turns.find(t => t.id === assistantId);
  if (!turn || turn.role !== 'ASSISTANT') return null;
  const user = state.turns.find(t => t.id === turn.forTurnId);
  return user && user.role === 'USER' ? user.text : null;
}

/** Compact, factual description of an answer from the fields the backend returned (nothing inferred). */
export function answerFacts(answer: AnswerDto): { model: string; duration: string | null; context: string | null; graph: string | null; truncated: boolean; actionIgnored: boolean } {
  const secs = Number.isFinite(answer.durationMs) && (answer.durationMs as number) >= 0 ? `${((answer.durationMs as number) / 1000).toFixed(1).replace('.', ',')} s` : null;
  const items = Number.isSafeInteger(answer.contextItems) ? answer.contextItems as number : null;
  const used = answer.diagnostics?.kg?.used ?? 0;
  return {
    model: answer.local ? `modèle local${answer.model ? ` ${answer.model}` : ''}` : 'modèle inconnu',
    duration: secs,
    context: items === null ? null : `${items} élément${items > 1 ? 's' : ''} de contexte`,
    graph: answer.diagnostics?.kgContextUsed && used > 0 ? `${used} source${used > 1 ? 's' : ''} du graphe` : null,
    truncated: answer.truncated === true,
    actionIgnored: answer.actionProposalIgnored === true,
  };
}
