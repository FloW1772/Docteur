// [GAME-2] Synapse Run — host protocol shell. [GAME-4] The game itself is game.js (bundled from
// src/arcade/synapse-run/), loaded just before this file; each validated host command is forwarded to it as a
// same-document "synapse-run:host" event. The game never sees raw host messages.
// Runs inside <iframe sandbox="allow-scripts"> with an opaque origin and the page CSP (connect-src 'none').
// The only channel is the Docteur Arcade postMessage protocol v1 (src/lib/arcade/protocol.ts):
//   host → game : ARCADE_INIT {reducedMotion} · ARCADE_PAUSE {} · ARCADE_RESUME {} · ARCADE_STOP {}
//                 ARCADE_SAVE_RESULT {op, status, …} + requestId                                  [GAME-3]
//   game → host : ARCADE_READY {} · ARCADE_STATE {state} · ARCADE_ERROR {code}
//                 ARCADE_SAVE_LOAD {} · ARCADE_SAVE_WRITE {saveVersion, data} · ARCADE_SAVE_DELETE {} + requestId
// Every message carries the per-launch instanceId the host put in this page's URL fragment.
// [GAME-3] This page has no storage of its own (opaque origin): the host owns the save. The foundation only asks
// for its save once after INIT to show that the bridge answers; it never writes or deletes anything.
(function () {
  'use strict';
  var CHANNEL = 'docteur-arcade';
  var VERSION = 1;
  var GAME_ID = 'synapse-run';
  // The fixed registry serves this document on the host's site. location.origin retains the URL's origin,
  // even though self.origin is opaque. Only host -> sandbox needs targetOrigin="*".
  var HOST_ORIGIN = window.location.origin;
  var LABELS = { waiting: 'en attente de Docteur', active: 'actif', paused: 'en pause', stopped: 'arrêté' };
  var SAVE_LABELS = { EMPTY: 'aucune', FOUND: 'disponible', ERROR: 'indisponible' };

  var match = /^#instance=([0-9a-f]{32})$/.exec(window.location.hash);
  var instanceId = match ? match[1] : null;
  var state = 'waiting';
  var statusEl = document.getElementById('sr-status');
  var saveEl = document.getElementById('sr-save');
  var root = document.documentElement;
  var requestCount = 0;
  var pendingLoad = null;

  function send(type, payload, requestId) {
    if (!instanceId || window.parent === window) return;
    var message = { channel: CHANNEL, v: VERSION, type: type, gameId: GAME_ID, instanceId: instanceId, payload: payload };
    if (requestId) message.requestId = requestId;
    window.parent.postMessage(message, HOST_ORIGIN);
  }

  // correlation only: 16 lowercase hex digits, unique within this launch
  function nextRequestId() {
    requestCount += 1;
    return ('0000000000000000' + requestCount.toString(16)).slice(-16);
  }

  function renderSave(status) {
    root.setAttribute('data-save', status);
    saveEl.textContent = 'Sauvegarde locale : ' + SAVE_LABELS[status];
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

  // [GAME-4] hand a validated command to game.js (absent in the Node test harness: no DOM events there)
  function notifyGame(type, reducedMotion) {
    if (typeof document.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    document.dispatchEvent(new CustomEvent('synapse-run:host', { detail: { type: type, reducedMotion: reducedMotion === true } }));
  }

  // Strict shape check: anything else is ignored (no dynamic dispatch, no eval).
  function isLoadResult(d) {
    if (keys(d) !== 'channel,gameId,instanceId,payload,requestId,type,v' || d.type !== 'ARCADE_SAVE_RESULT') return false;
    if (d.channel !== CHANNEL || d.v !== VERSION || d.gameId !== GAME_ID || d.instanceId !== instanceId) return false;
    if (pendingLoad === null || d.requestId !== pendingLoad) return false;
    var p = d.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.op !== 'LOAD') return false;
    return p.status === 'EMPTY' || p.status === 'FOUND' || p.status === 'ERROR';
  }

  function isHostCommand(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (isLoadResult(d)) return true;
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
    if (d.type === 'ARCADE_SAVE_RESULT') {
      pendingLoad = null;
      renderSave(d.payload.status);
    } else if (d.type === 'ARCADE_INIT') {
      if (state !== 'waiting') return;
      root.setAttribute('data-reduced-motion', d.payload.reducedMotion ? 'true' : 'false');
      setState('active');
      notifyGame('INIT', d.payload.reducedMotion);
      pendingLoad = nextRequestId();
      send('ARCADE_SAVE_LOAD', {}, pendingLoad);
    } else if (d.type === 'ARCADE_PAUSE') {
      if (state === 'active') { setState('paused'); notifyGame('PAUSE'); }
    } else if (d.type === 'ARCADE_RESUME') {
      if (state === 'paused') { setState('active'); notifyGame('RESUME'); }
    } else if (d.type === 'ARCADE_STOP') {
      setState('stopped');
      notifyGame('STOP');
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
