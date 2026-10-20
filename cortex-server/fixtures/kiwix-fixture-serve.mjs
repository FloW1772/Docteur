// [KWX-1] TEST-ONLY stand-in for kiwix-serve.exe (kiwix-tools is not installed: real certification stays NOT_RUN).
// It receives the EXACT argument shape the Kiwix lifecycle builds (`--port=N --address=127.0.0.1 --blockexternal
// <abs .zim>…`) — the test's injected spawn function runs `node <this file> --fixture-mode=<mode> <those args>`.
// Modes:
//   healthy         listen on --address:--port, GET / → 200
//   slow            same, after --fixture-delay ms (default 1200)
//   crash-on-start  exit 7 before listening
//   crash-after     healthy, then exit 3 after --fixture-after ms (default 700)
//   unhealthy       listen, GET / → 500 (never a kiwix-like answer)
//   wide            IGNORES --address and listens on 0.0.0.0 (the unsafe binding the lifecycle must refuse)
import http from 'node:http';

const arg = (name, fallback = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const mode = arg('fixture-mode', 'healthy');
const port = Number(arg('port'));
const address = mode === 'wide' ? '0.0.0.0' : (arg('address') ?? '127.0.0.1');

if (mode === 'crash-on-start') setTimeout(() => process.exit(7), 50);
else {
  const server = http.createServer((req, res) => {
    if (mode !== 'unhealthy' && req.url?.startsWith('/search?')) {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end('<?xml version="1.0"?><rss><channel><item><title>Fixture article</title><link>/content/pokepedia/A/Fixture</link><description>Local result</description></item></channel></rss>');
      return;
    }
    if (mode !== 'unhealthy' && req.url === '/content/pokepedia/A/Fixture') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<article>Local Kiwix fixture content</article>');
      return;
    }
    res.writeHead(mode === 'unhealthy' ? 500 : 200, { 'content-type': 'text/plain' });
    res.end('kiwix fixture');
  });
  const listen = () => server.listen(port, address);
  if (mode === 'slow') setTimeout(listen, Number(arg('fixture-delay', '1200'))); else listen();
  if (mode === 'crash-after') setTimeout(() => process.exit(3), Number(arg('fixture-after', '700')));
}
