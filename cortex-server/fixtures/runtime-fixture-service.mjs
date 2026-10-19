// Runtime Supervisor V1 — TEST-ONLY fixture service (never registered in the product registry).
// A harmless HTTP server on 127.0.0.1 with deterministic behaviours, so the real-process harness never has to crash or
// stop a real Docteur component. Usage: node runtime-fixture-service.mjs --port <n> --mode <mode> [--control <file>]
//   healthy          GET /health 200 (+ echoes the supervisor instance token), POST /shutdown → exit 0
//   slow             like healthy, starts listening after --delay ms (default 1500)
//   unhealthy        GET /health 500
//   crash-after      healthy, then exits with code 3 after --after ms (default 400)
//   crash-on-start   exits with code 7 before listening
//   hang-stop        healthy, but ignores POST /shutdown (only a forced termination stops it)
//   wrong-identity   healthy, but echoes a different instance token (port-hijack simulation)
// --control <file>: when the file exists its trimmed content replaces --mode (lets a test change behaviour on restart).
// GET /envkeys returns the NAMES (never values) of the environment variables the process received.
import http from 'node:http';
import fs from 'node:fs';

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('port'));
let mode = arg('mode', 'healthy');
const control = arg('control');
if (control && fs.existsSync(control)) mode = fs.readFileSync(control, 'utf8').trim() || mode;
const token = mode === 'wrong-identity' ? 'not-the-supervisor-token' : (process.env.DOCTEUR_RS_INSTANCE ?? '');

if (mode === 'crash-on-start') setTimeout(() => process.exit(7), 50);
else {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(mode === 'unhealthy' ? 500 : 200, { 'content-type': 'application/json', 'x-docteur-rs-instance': token });
      return res.end(JSON.stringify({ ok: mode !== 'unhealthy' }));
    }
    if (req.method === 'GET' && req.url === '/envkeys') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(Object.keys(process.env).sort()));
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(202); res.end();
      if (mode !== 'hang-stop') server.close(() => process.exit(0));
      return undefined;
    }
    res.writeHead(404); return res.end();
  });
  const listen = () => server.listen(port, '127.0.0.1');
  if (mode === 'slow') setTimeout(listen, Number(arg('delay', '1500'))); else listen();
  if (mode === 'crash-after') setTimeout(() => process.exit(3), Number(arg('after', '400')));
  if (mode === 'hang-stop') process.on('SIGTERM', () => {}); // ignore polite termination where supported
}
