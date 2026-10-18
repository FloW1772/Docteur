// COMP-4 fixture: a fake Ollama HTTP runtime on 127.0.0.1 (random port). Loopback only — never a real model, never the
// Internet. It lets the tests drive the REAL ollama-js client and observe, server-side, whether a request was really
// aborted (the client closed the connection before the answer was written).
import http from 'node:http';

export async function startFakeOllama({ models = ['qwen-local:3b'], chat = null } = {}) {
  const state = {
    models: [...models], chatBodies: [], paths: [], abortedChats: 0, completedChats: 0,
    // default answer: the model that was asked, a short text and token counts
    chat: chat ?? ((body) => ({ json: { model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: 'DOCTEUR_LOCAL_OK' }, done: true, done_reason: 'stop', prompt_eval_count: 42, eval_count: 7 } })),
  };
  const send = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      state.paths.push(`${req.method} ${req.url}`);
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/tags') return send(res, 200, { models: state.models.map(name => ({ name, model: name, size: 2e9, details: { family: 'llama', parameter_size: '3B', quantization_level: 'Q4_K_M' } })) });
      if (req.url === '/api/show') return state.models.includes(body.model) ? send(res, 200, { capabilities: ['completion'], model_info: { 'llama.context_length': 8192 }, details: { family: 'llama' } }) : send(res, 404, { error: `model '${body.model}' not found` });
      if (req.url === '/api/ps') return send(res, 200, { models: [] });
      if (req.url === '/api/chat') {
        state.chatBodies.push(body);
        let closedEarly = false;
        res.on('close', () => { if (!res.writableEnded) { closedEarly = true; state.abortedChats++; } });
        const out = await state.chat(body, { req, res, isClosed: () => closedEarly });
        if (closedEarly || res.writableEnded || out === undefined) return undefined;
        if (out.destroy) { req.socket.destroy(); return undefined; }
        if (out.delayMs) await new Promise(r => setTimeout(r, out.delayMs));
        if (closedEarly) return undefined;
        state.completedChats++;
        return send(res, out.status ?? 200, out.raw ?? out.json);
      }
      return send(res, 404, { error: 'not found' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state, url: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A chat handler that never answers until the client goes away (generation "in progress"). */
export const hang = () => new Promise(() => {});
