// [GAME-2] Synapse Run — foundation screen only (no gameplay, no saves; GAME-3/GAME-4 add those).
// Runs inside <iframe sandbox="allow-scripts"> with an opaque origin and the page CSP (connect-src 'none').
// The only channel is the Docteur Arcade postMessage protocol v1 (src/lib/arcade/protocol.ts):
//   host → game : ARCADE_INIT {reducedMotion} · ARCADE_PAUSE {} · ARCADE_RESUME {} · ARCADE_STOP {}
//   game → host : ARCADE_READY {} · ARCADE_STATE {state} · ARCADE_ERROR {code}
// Every message carries the per-launch instanceId the host put in this page's URL fragment.
(function () {
  'use strict';
  var CHANNEL = 'docteur-arcade';
  var VERSION = 1;
  var GAME_ID = 'synapse-run';
  // The fixed registry serves this document on the host's site. location.origin retains the URL's origin,
  // even though self.origin is opaque. Only host -> sandbox needs targetOrigin="*".
  var HOST_ORIGIN = window.location.origin;
  var LABELS = { waiting: 'en attente de Docteur', active: 'actif', paused: 'en pause', stopped: 'arrêté' };

  var match = /^#instance=([0-9a-f]{32})$/.exec(window.location.hash);
  var instanceId = match ? match[1] : null;
  var state = 'waiting';
  var statusEl = document.getElementById('sr-status');
  var root = document.documentElement;

  function send(type, payload) {
    if (!instanceId || window.parent === window) return;
    window.parent.postMessage({ channel: CHANNEL, v: VERSION, type: type, gameId: GAME_ID, instanceId: instanceId, payload: payload }, HOST_ORIGIN);
  }

  function render() {
    root.setAttribute('data-state', state);
    statusEl.textContent = 'État : ' + LABELS[state];
  }

  function setState(next) {
    state = next;
    render();
    send('ARCADE_STATE', { state: next });
  }

  function keys(o) { return Object.keys(o).sort().join(','); }

  // Strict shape check: anything else is ignored (no dynamic dispatch, no eval).
  function isHostCommand(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (keys(d) !== 'channel,gameId,instanceId,payload,type,v') return false;
    if (d.channel !== CHANNEL || d.v !== VERSION || d.gameId !== GAME_ID || d.instanceId !== instanceId) return false;
    var p = d.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (d.type === 'ARCADE_INIT') return keys(p) === 'reducedMotion' && typeof p.reducedMotion === 'boolean';
    if (d.type === 'ARCADE_PAUSE' || d.type === 'ARCADE_RESUME' || d.type === 'ARCADE_STOP') return keys(p) === '';
    return false;
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== HOST_ORIGIN || !isHostCommand(event.data)) return;
    var d = event.data;
    if (state === 'stopped') return;
    if (d.type === 'ARCADE_INIT') {
      if (state !== 'waiting') return;
      root.setAttribute('data-reduced-motion', d.payload.reducedMotion ? 'true' : 'false');
      setState('active');
    } else if (d.type === 'ARCADE_PAUSE') {
      if (state === 'active') setState('paused');
    } else if (d.type === 'ARCADE_RESUME') {
      if (state === 'paused') setState('active');
    } else if (d.type === 'ARCADE_STOP') {
      setState('stopped');
    }
  });

  window.addEventListener('error', function () { send('ARCADE_ERROR', { code: 'GAME_RUNTIME_ERROR' }); });

  render();
  if (!instanceId) {
    statusEl.textContent = 'État : à lancer depuis l’Arcade Docteur';
    return;
  }
  send('ARCADE_READY', {});
})();
