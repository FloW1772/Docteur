// NB-7 test double for Ollama (loopback HTTP). Deterministic hash embeddings, scripted chat answers, and a log of every
// /api/chat request (the exact messages the server sends to the model), so the E2E proof can inspect what the LLM really receives.
import http from 'node:http';

export const FAKE_DIM = 64;
export function fakeEmbedding(text) {
  const v = new Array(FAKE_DIM).fill(0);
  for (const raw of String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of raw) h = (h * 31 + ch.codePointAt(0)) >>> 0; v[h % FAKE_DIM] += 1; }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map(x => x / n);
}

export function startFakeOllama({ port = 0, answer = () => 'Réponse du modèle local. [M1]' } = {}) {
  const state = { chatRequests: [], embedRequests: 0, embedDown: false, chatDown: false };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { /* empty */ }
      const url = req.url.split('?')[0];
      if (url === '/api/tags') return json({ models: [{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 1 }, { name: 'llama3.2:3b', model: 'llama3.2:3b', size: 1 }] });
      if (url === '/api/version') return json({ version: '0.0.0-fake' });
      if (url === '/api/embed' || url === '/api/embeddings') {
        state.embedRequests++; if (state.embedDown) return json({ error: 'embedding model unavailable' }, 500);
        const inputs = Array.isArray(b.input) ? b.input : [b.input ?? b.prompt ?? '']; return json({ model: b.model, embeddings: inputs.map(fakeEmbedding) });
      }
      if (url === '/api/chat') {
        if (state.chatDown) return json({ error: 'chat unavailable' }, 500);
        state.chatRequests.push({ model: b.model, messages: b.messages }); const text = answer(b.messages, state.chatRequests.length);
        return json({ model: b.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: true });
      }
      if (url === '/api/ps') return json({ models: [] });
      return json({});
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, state, close: () => new Promise(r => server.close(r)) })));
}
