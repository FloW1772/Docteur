import crypto from 'node:crypto';
import {
  getAllPagesFromStore, getFileOriginals, getFileResults, getTodoItems,
  getAllConversationsForBackup, listPreferenceFacts, getAllGeneratedPrompts,
  getDatabase, countPreferenceFacts,
} from './sqlite.js';

const PAGE_KINDS = new Set(['note', 'task', 'idea', 'reference', 'memory', 'channel', 'video', 'link', 'playlist', 'question', 'recherche', 'cv', 'candidature', 'rapport', 'prompt', 'corpus', 'exemple-resume', 'video_summary']);
const BLOCK_TYPES = new Set(['h1', 'h2', 'paragraph', 'todo', 'list', 'image']);
export function validateBackupPage(page) {
  if (!PAGE_KINDS.has(page.kind) || !Array.isArray(page.blocks) || page.blocks.some(block =>
    !block || typeof block.id !== 'string' || !block.id || !BLOCK_TYPES.has(block.type) || typeof block.content !== 'string' ||
    (block.checked !== undefined && typeof block.checked !== 'boolean'))) throw new Error('Type ou blocs du neurone invalides');
  if (![page.createdAt, page.updatedAt].every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('Dates du neurone invalides');
  for (const field of ['links', 'tags']) {
    if (page[field] !== undefined && (!Array.isArray(page[field]) || page[field].some(value => typeof value !== 'string'))) throw new Error(`${field} du neurone invalide`);
  }
  if (page.metadata === null || typeof page.metadata !== 'object' || Array.isArray(page.metadata)) throw new Error('Métadonnées du neurone invalides');
  if (page.private !== undefined && typeof page.private !== 'boolean') throw new Error('Confidentialité du neurone invalide');
  if (page.color !== undefined && typeof page.color !== 'string') throw new Error('Couleur du neurone invalide');
}

// SQLite is authoritative for pages. The vector index is optional and may lag
// behind edits or contain legacy neurons that were never saved as pages.
export function buildBackupSnapshot(indexedNeurons, now = new Date()) {
  const neurons = new Map(indexedNeurons.map(neuron => [neuron.id, neuron]));
  const pages = getAllPagesFromStore();
  const seenEdges = new Set();
  const links = [];
  for (const page of pages) {
    const indexed = neurons.get(page.id);
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    neurons.set(page.id, {
      ...indexed, ...page, blocks,
      content: blocks.map(b => typeof b?.content === 'string' ? b.content : '').filter(Boolean).join('\n\n'),
    });
    for (const targetId of (page.links ?? [])) {
      const key = JSON.stringify([page.id, targetId].sort());
      if (!seenEdges.has(key)) { seenEdges.add(key); links.push({ from: page.id, to: targetId }); }
    }
  }
  return {
    version: '1.2', exported_at: now.toISOString(),
    neurons_count: neurons.size, neurons: [...neurons.values()], links,
    files: { originals: getFileOriginals(), results: getFileResults() },
    todo_items: getTodoItems(),
    personal_data: {
      note: 'Conversations et préférences retenues — données personnelles, jamais indexées ni envoyées au cloud.',
      conversations: getAllConversationsForBackup(), preference_facts: listPreferenceFacts(),
    },
    generated_prompts: {
      note: 'Prompts générés — indépendants des neurones.', prompts: getAllGeneratedPrompts({}),
    },
  };
}

// Additive, atomic per conversation; never overwrite an existing conversation.
// Legacy 1.2 exports omitted message ids. Derive stable ids for those messages
// so re-importing a backup cannot duplicate an exchange.
export function restoreBackupConversation(conversation) {
  if (!conversation || typeof conversation.id !== 'string' || !conversation.id || !Array.isArray(conversation.messages))
    throw new Error('Conversation invalide');
  const db = getDatabase();
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversation.id)) return false;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(conversation.id, conversation.title ?? '', conversation.created_at ?? now, conversation.updated_at ?? now);
    const insert = db.prepare('INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const [i, message] of conversation.messages.entries()) {
      if (!message || !['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string')
        throw new Error('Message de conversation invalide');
      const id = message.id ?? crypto.createHash('sha256').update(JSON.stringify([conversation.id, i, message.role, message.content, message.created_at])).digest('hex');
      insert.run(id, conversation.id, message.role, message.content, message.created_at ?? now);
    }
    return true;
  })();
}

export function restoreBackupPreference(fact) {
  if (!fact || typeof fact.id !== 'string' || !fact.id || typeof fact.fact !== 'string' || !fact.fact.trim())
    throw new Error('Préférence invalide');
  const db = getDatabase();
  if (db.prepare('SELECT 1 FROM preference_facts WHERE id = ?').get(fact.id)) return false;
  if (countPreferenceFacts() >= 50) throw new Error('Limite de 50 préférences atteinte');
  const now = new Date().toISOString();
  const privacy = fact.privacy ? 1 : 0;
  db.prepare(`INSERT INTO preference_facts
    (id, fact, created_at, updated_at, source, source_ref, privacy, egress_policy, importance, confidence, usage_count, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fact.id, fact.fact, fact.created_at ?? now, fact.updated_at ?? now, fact.source ?? 'manual', fact.source_ref ?? null,
      privacy, privacy ? 'local_only' : (fact.egress_policy ?? 'cloud_allowed'), fact.importance ?? 0.5, fact.confidence ?? 0.5,
      fact.usage_count ?? 0, fact.last_used_at ?? null);
  return true;
}
