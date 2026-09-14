import http from 'node:http';
import https from 'node:https';
const started = Date.now();
const probe = (secure) => new Promise(resolve => {
  const request = (secure ? https : http).get({ hostname: '127.0.0.1', port: 3001, path: '/api/ping', rejectUnauthorized: false, timeout: 2000 }, response => {
    response.resume(); resolve(response.statusCode === 200);
  });
  request.on('error', () => resolve(false));
  request.on('timeout', () => { request.destroy(); resolve(false); });
});
while (Date.now() - started < 120000) {
  if (await probe(false) || await probe(true)) {
    console.log(`[startup] Cortex disponible après ${Date.now() - started} ms (${new Date().toISOString()})`);
    process.exit(0);
  }
  console.log('Connexion au serveur en cours...');
  await new Promise(resolve => setTimeout(resolve, 2000));
}
console.error('Cortex ne répond pas après 120 secondes. Consulter la fenêtre serveur.');
process.exit(1);
