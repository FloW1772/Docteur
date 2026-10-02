// NB-4 — SYNTHETIC FIXTURES ONLY. No real export of ChatGPT / Gemini / Claude was available, so
// every provider structure below is a hand-made imitation of the publicly documented shape and is
// labelled SYNTHETIC_ONLY. Nothing here contains personal data; every "secret" is an obvious fake.
import zlib from 'node:zlib';

export const enc = (s) => new TextEncoder().encode(s);
export const FAKE_KEY = 'sk-live-FAKEFAKEFAKEFAKEFAKE1234567890';
export const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----';

// ── ZIP writer (also crafts hostile archives) ───────────────────────────────
export function makeZip(entries, { comment = '' } = {}) {
  const locals = []; const central = []; let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data ?? '', typeof e.data === 'string' ? 'utf8' : undefined);
    const method = e.method ?? 8;
    const comp = e.rawCompressed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = e.crc ?? zlib.crc32(data);
    const usize = e.declaredUsize ?? data.length; const csize = comp.length;
    const flags = (e.encrypted ? 1 : 0) | 0x800;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.symlink ? 0x031e : 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(e.symlink ? ((0xa1ff << 16) >>> 0) : 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp); central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22); const cm = Buffer.from(comment);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(cm.length, 20);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd, cm]));
}

// ── ChatGPT-shaped export (SYNTHETIC_ONLY): conversations.json with a "mapping" tree ─────────
let t0 = 1_741_000_000; // 2025-03-03
export function chatgptConversation({ id, title, turns, start = t0, currentLeaf = null, regenerate = null }) {
  const mapping = { root: { id: 'root', message: null, parent: null, children: [] } };
  let prev = 'root'; let ts = start; const ids = [];
  turns.forEach((t, i) => {
    const nid = t.id ?? `${id}-m${i}`; ids.push(nid); ts += 60;
    const content = t.code ? { content_type: 'code', language: t.code, text: t.text } : { content_type: t.contentType ?? 'text', parts: [t.text] };
    mapping[nid] = { id: nid, parent: prev, children: [], message: { id: nid, author: { role: t.role, name: t.name ?? null }, create_time: t.time ?? ts, content, metadata: { model_slug: t.role === 'assistant' ? 'synthetic-model' : undefined, attachments: t.attachments } } };
    mapping[prev].children.push(nid); prev = nid;
  });
  if (regenerate) { // alternate assistant answer to turn #regenerate.turn (a sibling under the same parent)
    const target = ids[regenerate.turn]; const parent = mapping[target].parent; const nid = `${id}-alt`;
    mapping[nid] = { id: nid, parent, children: [], message: { id: nid, author: { role: 'assistant' }, create_time: start + 500, content: { content_type: 'text', parts: [regenerate.text] }, metadata: {} } };
    mapping[parent].children.push(nid);
  }
  return { id, conversation_id: id, title, create_time: start, update_time: ts, mapping, current_node: currentLeaf ?? prev };
}
export const chatgptExport = (convs) => JSON.stringify(convs);

// ── Claude-shaped export (SYNTHETIC_ONLY) ───────────────────────────────────
export function claudeConversation({ uuid, name, messages, created = '2025-03-05T10:00:00.000Z' }) {
  return { uuid, name, created_at: created, updated_at: created, account: { uuid: 'acct-synthetic' },
    chat_messages: messages.map((m, i) => ({ uuid: m.uuid ?? `${uuid}-${i}`, text: m.text, sender: m.sender, created_at: m.at ?? new Date(Date.parse(created) + i * 60000).toISOString(), content: m.blocks ?? [{ type: 'text', text: m.text }], attachments: m.attachments ?? [], files: m.files ?? [] })) };
}
export const claudeExport = (convs) => JSON.stringify(convs);

// ── Gemini-shaped export (Takeout My Activity, SYNTHETIC_ONLY) ──────────────
export function geminiActivity({ prompt, response, time = '2025-03-12T09:00:00.000Z' }) {
  return { header: 'Gemini Apps', title: `Prompted ${prompt}`, time, products: ['Gemini Apps'], activityControls: ['Gemini Apps Activity'], safeHtmlItem: response ? [{ html: `<p>${response}</p>` }] : [] };
}
export const geminiExport = (items) => JSON.stringify(items, null, 2);

// ── generic formats ─────────────────────────────────────────────────────────
export const genericJson = (convs) => JSON.stringify({ conversations: convs });
export const genericMarkdown = (turns, title = 'Session') => `# ${title}\n\n${turns.map(t => `**${t.label}:**\n${t.text}`).join('\n\n')}\n`;
export const genericText = (turns) => turns.map(t => `${t.label}: ${t.text}`).join('\n');
export const genericHtml = (turns) => `<html><body>${turns.map(t => `<div data-message-author-role="${t.role}"><p>${t.text}</p></div>`).join('')}</body></html>`;

// A small realistic-looking multi-conversation history used by many tests.
export function sampleHistory() {
  return [
    chatgptConversation({ id: 'c-device', title: 'Architecture Device Fabric', start: 1_741_000_000, turns: [
      { role: 'user', text: 'Nous avons décidé de garder Device Fabric en mode ADMIN uniquement pour le contrôle distant.' },
      { role: 'assistant', text: 'Très bien. Voici un exemple de configuration :\n\n```json\n{ "mode": "ADMIN", "remote": true }\n```\n\nLa cause du refus vient de la politique de permissions.' },
      { role: 'user', text: 'Je préfère des réponses courtes et en français.' },
    ] }),
    chatgptConversation({ id: 'c-msn', title: 'Discussion sur MSN et les articles', start: 1_741_100_000, turns: [
      { role: 'user', text: 'Retrouve comment importer les articles MSN dans le Notebook avec leur canonicalUri.' },
      { role: 'assistant', text: 'Il faut conserver canonicalUri et la source pour chaque article MSN importé.' },
    ] }),
    chatgptConversation({ id: 'c-gemini', title: 'Question sur Gemini', start: 1_741_200_000, turns: [
      { role: 'user', text: 'Qu\'est-ce que je voulais faire avec Gemini exactement dans Docteur ?' },
      { role: 'assistant', text: 'Gemini serait un provider optionnel, jamais un composant obligatoire.' },
    ] }),
  ];
}
