// Query-count and latency comparison on synthetic in-memory conversations.
import './test-setup.mjs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { initSqlite, getDatabase, createConversation, addConversationMessage, getAllConversationsForBackup } from './src/lib/sqlite.js';

initSqlite(':memory:');
const db = getDatabase();
db.transaction(() => {
  for (let i = 0; i < 1000; i++) {
    createConversation(`bench-${i}`, `Synthetic conversation ${i}`);
    for (let j = 0; j < 10; j++) addConversationMessage(`bench-${i}`, j % 2 ? 'assistant' : 'user', `Synthetic message ${j}`);
  }
})();
// Reproduces the original N+1 implementation, without modifying any source.
const before = () => db.prepare('SELECT * FROM conversations ORDER BY created_at ASC').all().map(conv => ({
  ...conv, messages: db.prepare('SELECT role, content, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conv.id),
}));
const counts = [];
for (const [name, fn] of [['before', before], ['after', getAllConversationsForBackup]]) {
  fn(); const timings = []; let queries = 0;
  const prepare = db.prepare;
  db.prepare = function (...args) { queries++; return prepare.apply(this, args); };
  try {
    for (let run = 0; run < 7; run++) {
      const start = performance.now(); const result = fn(); timings.push(performance.now() - start);
      assert.equal(result.length, 1000); assert.equal(result.reduce((n, c) => n + c.messages.length, 0), 10000);
      assert.ok(result.every(c => c.messages[0].content === 'Synthetic message 0' && c.messages[9].content === 'Synthetic message 9'));
    }
  } finally { db.prepare = prepare; }
  timings.sort((a, b) => a - b);
  counts.push({ name, conversations: 1000, messages: 10000, queriesPerExport: queries / 7, medianMs: Number(timings[3].toFixed(2)) });
}
db.close();
console.log(JSON.stringify(counts, null, 2));
