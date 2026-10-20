// [COMP-9 CHAT] Companion conversation model (src/lib/companion/chat-model.ts, Node type stripping): one generation at a
// time, no optimistic assistant text, late answers for cancelled / retried turns dropped, bounded history, error texts,
// and the HTTP port's answer contract (strict { text } body, abort = cancellation). No browser, no network.
// Usage: node --test scripts/test-companion-chat-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHAT_LIMITS, EMPTY_CHAT, answerFacts, canSend, chatErrorText, chatReducer, questionFor } from '../src/lib/companion/chat-model.ts';

const answer = (extra = {}) => ({
  requestId: 'cans_1', text: 'Bonjour.', truncated: false, local: true, model: 'llama3.2:3b', durationMs: 4200, contextItems: 2, actionProposalIgnored: false,
  diagnostics: { kgContextUsed: false, kg: { gate: 'KG_OPEN', state: 'ACTIVE', status: 'COMP_7_NO_MATCH', authority: 'NONE', retrieved: 0, used: 0, dropped: 0, chars: 0, excluded: [] } },
  kgProvenance: [], ...extra,
});
const send = (s, n, text = `question ${n}`) => chatReducer(s, { type: 'send', userId: `u${n}`, assistantId: `a${n}`, text, at: n });
const last = (s) => s.turns.at(-1);

test('send: user turn + one PENDING assistant turn, no assistant text before the backend answers', () => {
  const s = send(EMPTY_CHAT, 1, 'Bonjour');
  assert.deepEqual(s.turns.map(t => [t.role, t.status]), [['USER', 'SENT'], ['ASSISTANT', 'PENDING']]);
  assert.equal(s.activeId, 'a1');
  assert.equal(last(s).answer, null, 'no optimistic content');
  assert.equal(questionFor(s, 'a1'), 'Bonjour');
});

test('one generation at a time: a second send while pending is refused; empty / too long refused', () => {
  const s = send(EMPTY_CHAT, 1);
  assert.equal(send(s, 2), s, 'second send ignored while pending');
  assert.equal(canSend(s, 'x'), false);
  assert.equal(canSend(EMPTY_CHAT, '   '), false);
  assert.equal(canSend(EMPTY_CHAT, 'x'.repeat(CHAT_LIMITS.maxInputChars + 1)), false);
  assert.equal(canSend(EMPTY_CHAT, 'x'.repeat(CHAT_LIMITS.maxInputChars)), true);
  assert.equal(CHAT_LIMITS.maxInputChars, 16_000, 'same bound as the server');
});

test('resolve fills only the active turn; then the next question can be sent', () => {
  let s = send(EMPTY_CHAT, 1);
  s = chatReducer(s, { type: 'resolve', assistantId: 'a1', answer: answer() });
  assert.equal(last(s).status, 'DONE');
  assert.equal(last(s).answer.text, 'Bonjour.');
  assert.equal(s.activeId, null);
  s = send(s, 2);
  assert.equal(s.activeId, 'a2');
});

test('cancel: the active turn becomes CANCELLED; its late answer or late failure is dropped', () => {
  let s = chatReducer(send(EMPTY_CHAT, 1), { type: 'cancel', assistantId: 'a1' });
  assert.equal(last(s).status, 'CANCELLED');
  assert.equal(s.activeId, null);
  const after = chatReducer(s, { type: 'resolve', assistantId: 'a1', answer: answer({ text: 'trop tard' }) });
  assert.equal(after, s, 'late answer ignored');
  assert.equal(chatReducer(s, { type: 'fail', assistantId: 'a1', code: 'MODEL_TIMEOUT' }), s, 'late failure ignored');
  s = send(s, 2);
  const late = chatReducer(s, { type: 'resolve', assistantId: 'a1', answer: answer({ text: 'trop tard' }) });
  assert.equal(late, s, 'an old answer never lands on the newer pending question');
  assert.equal(last(chatReducer(s, { type: 'resolve', assistantId: 'a2', answer: answer({ text: 'récente' }) })).answer.text, 'récente');
});

test('retry: only a FAILED / CANCELLED turn, only when idle; new id, same question; the old id is dead', () => {
  let s = chatReducer(send(EMPTY_CHAT, 1, 'Quelle heure ?'), { type: 'fail', assistantId: 'a1', code: 'LOCAL_MODEL_UNAVAILABLE' });
  assert.equal(last(s).status, 'FAILED');
  assert.match(last(s).error.text, /modèle local/i);
  s = chatReducer(s, { type: 'retry', assistantId: 'a1', newAssistantId: 'a1b', at: 9 });
  assert.equal(s.activeId, 'a1b');
  assert.equal(last(s).status, 'PENDING');
  assert.equal(questionFor(s, 'a1b'), 'Quelle heure ?');
  assert.equal(s.turns.length, 2, 'retry replaces the failed turn, no duplicate question');
  assert.equal(chatReducer(s, { type: 'resolve', assistantId: 'a1', answer: answer() }), s, 'old id dead');
  assert.equal(chatReducer(s, { type: 'retry', assistantId: 'a1b', newAssistantId: 'x', at: 10 }), s, 'cannot retry a pending turn');
  const done = chatReducer(s, { type: 'resolve', assistantId: 'a1b', answer: answer() });
  assert.equal(chatReducer(done, { type: 'retry', assistantId: 'a1b', newAssistantId: 'y', at: 11 }), done, 'cannot retry a DONE turn');
  let c = chatReducer(send(EMPTY_CHAT, 1), { type: 'cancel', assistantId: 'a1' });
  c = chatReducer(c, { type: 'retry', assistantId: 'a1', newAssistantId: 'a1c', at: 3 });
  assert.equal(c.activeId, 'a1c', 'a cancelled turn can be retried');
});

test('history is bounded (display only) and never needs the model', () => {
  let s = EMPTY_CHAT;
  for (let i = 1; i <= 30; i++) { s = send(s, i); s = chatReducer(s, { type: 'resolve', assistantId: `a${i}`, answer: answer() }); }
  assert.equal(s.turns.length, CHAT_LIMITS.maxTurns);
  assert.equal(s.turns[0].role, 'USER', 'oldest pairs dropped whole');
});

test('error texts: network ≠ model failure; unknown code = honest failure, never success', () => {
  assert.match(chatErrorText('ACTION_FAILED', 'NETWORK').text, /injoignable/);
  for (const c of ['LOCAL_MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_PROVIDER_ERROR', 'MODEL_INVALID_RESPONSE', 'MODEL_CLOUD_FORBIDDEN', 'COMPANION_DISABLED', 'COMP_CONVERSATION_FAILED', 'COMP_CONVERSATION_INVALID', 'ROOT_POLICY_DENIED']) {
    const e = chatErrorText(c);
    assert.ok(e.text.length > 10 && !/raison inconnue/.test(e.text), c);
  }
  assert.match(chatErrorText('SOMETHING_NEW').text, /raison inconnue/);
});

test('answer facts: only returned fields (local model, duration, context, graph, truncation, ignored action)', () => {
  const f = answerFacts(answer({ diagnostics: { kgContextUsed: true, kg: { used: 2 } }, truncated: true, actionProposalIgnored: true }));
  assert.deepEqual(f, { model: 'modèle local llama3.2:3b', duration: '4,2 s', context: '2 éléments de contexte', graph: '2 sources du graphe', truncated: true, actionIgnored: true });
  const bare = answerFacts(answer({ model: null, durationMs: null, contextItems: null }));
  assert.deepEqual([bare.model, bare.duration, bare.context, bare.graph], ['modèle local', null, null, null]);
});

test('static: the chat renders model text as plain text, aborts on unmount, creates no action, no memory word, no runtime name', () => {
  const chat = fs.readFileSync('src/components/companion/CompanionChat.tsx', 'utf8');
  const model = fs.readFileSync('src/lib/companion/chat-model.ts', 'utf8');
  const port = fs.readFileSync('src/lib/companion/http-port.ts', 'utf8');
  for (const src of [chat, model]) {
    assert.ok(!/dangerouslySetInnerHTML|innerHTML|renderMarkdown|marked\(|eval\(/.test(src), 'no HTML / Markdown interpretation');
    assert.ok(!/ollama|exec\(|spawn|child_process|DIRECT_TEST_ONLY/i.test(src), 'no runtime name / process / test channel');
    assert.ok(!/notebook-memory|getMemoryService|createMemoryService|docteur-memory|dmem_|buildMemoryMessages|chat-memory|getChatMemory|memoryUsed|memory_project/.test(src), 'NB-7 guard words absent');
    assert.ok(!/\.propose\(|proposeFromModel|submitIntent|\.execute\(|issueChallenge/.test(src), 'the chat never proposes, approves or executes');
  }
  assert.ok(/controller\.abort\(\)/.test(chat) && /return \(\) => \{[^}]*abort\(\)/.test(chat), 'cancel and unmount abort the request');
  assert.ok(/answer: \(text: string, options: \{ signal\?: AbortSignal \} = \{\}\) => call<AnswerDto>\('POST', `\$\{api\}\/answers`, \{ json: \{ text \}, signal: options\.signal \}\)/.test(port), 'POST /answers with { text } only and the caller signal');
});
