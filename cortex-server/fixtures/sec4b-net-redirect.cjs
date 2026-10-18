// SEC-REMED-4B test preload (node --require, AFTER nb7-net-spy.cjs): redirects the cloud provider hosts the boot test
// exercises (api.groq.com) to the hostile loopback upstream $SEC4B_UPSTREAM, so the real provider code runs end to end
// without leaving the machine. Every other non-loopback attempt is still blocked and recorded by nb7-net-spy.cjs.
const UPSTREAM = process.env.SEC4B_UPSTREAM;
const REDIRECT_HOSTS = new Set(['api.groq.com']);
const inner = globalThis.fetch;
if (inner && UPSTREAM) {
  globalThis.fetch = function (input, init) {
    let u = null;
    try { u = new URL(typeof input === 'string' ? input : (input.url ?? String(input))); } catch { /* relative */ }
    if (u && REDIRECT_HOSTS.has(u.hostname)) return inner.call(this, UPSTREAM + u.pathname + u.search, init);
    return inner.call(this, input, init);
  };
}
