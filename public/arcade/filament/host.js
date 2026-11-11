// [FILAMENT-1] Filament — host protocol shell (same protocol v1 and same checks as public/arcade/synapse-run/foundation.js).
// The game (game.js, bundled from src/arcade/filament/) is loaded just before this file; each validated host command is
// forwarded to it as a same-document "filament:host" event {type, reducedMotion}. The game never sees raw host messages.
// Runs inside <iframe sandbox="allow-scripts"> with an opaque origin and the page CSP (connect-src 'none').
//   host → game : ARCADE_INIT {reducedMotion} · ARCADE_PAUSE {} · ARCADE_RESUME {} · ARCADE_STOP {}
//                 ARCADE_FULLSCREEN_STATE {fullscreen}
//                 ARCADE_SAVE_RESULT {op, status, …} + requestId                                       [FILAMENT-3]
//   game → host : ARCADE_READY {} · ARCADE_STATE {state} · ARCADE_ERROR {code}
//                 ARCADE_EXIT_REQUEST {} — the in-game "Retour à l'Arcade" button; the host honours it only for a game
//                 whose registry entry declares HOST_EXIT_REQUEST, and only as the user's own Stop
//                 ARCADE_SAVE_LOAD {} · ARCADE_SAVE_WRITE {saveVersion, data} + requestId                 [FILAMENT-3]
// Every message carries the per-launch instanceId the host put in this page's URL fragment.
// [FILAMENT-3] Save bridge (same rules as Synapse Run's): this page has no storage of its own (opaque origin); the host
// owns the save (GAME-3 store, IndexedDB "docteur-arcade", key "arcade:v1:filament"). This file asks for the save once
// after INIT and forwards every LOAD / WRITE result to game.js as a "filament:save-result" event
// {op, status, code?, saveVersion?, data?}. game.js asks for a write with a "filament:save-write" event
// {saveVersion, data}; this file alone builds the typed ARCADE_SAVE_WRITE, at most MAX_PENDING requests at a time.
// A result is accepted only for a request this page sent and has not seen answered, with the same operation. There is
// no delete path for the game: resetting progress is the host's explicit two-step Arcade control.
(function () {
  'use strict';
  var CHANNEL = 'docteur-arcade';
  var VERSION = 1;
  var GAME_ID = 'filament';
  // The fixed registry serves this document on the host's site. location.origin retains the URL's origin,
  // even though self.origin is opaque. Only host -> sandbox needs targetOrigin="*".
  var HOST_ORIGIN = window.location.origin;
  var LABELS = { waiting: 'en attente de Docteur', active: 'actif', paused: 'en pause', stopped: 'arrêté' };
  var SAVE_ERROR_CODES = ['UNKNOWN_GAME', 'INVALID_SAVE_VERSION', 'INVALID_SAVE_PAYLOAD', 'SAVE_TOO_LARGE', 'CORRUPT_SAVE', 'UNSUPPORTED_SAVE_VERSION', 'STORAGE_UNAVAILABLE', 'STORAGE_FAILED', 'SAVE_BUSY'];
  var MAX_PENDING = 4;

  var match = /^#instance=([0-9a-f]{32})$/.exec(window.location.hash);
  var instanceId = match ? match[1] : null;
  var state = 'waiting';
  var statusEl = document.getElementById('fl-status');
  var root = document.documentElement;
  var requestCount = 0;
  var pending = {}; // requestId → 'LOAD' | 'WRITE'
  var pendingCount = 0;

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

  function render() {
    root.setAttribute('data-state', state);
    if (statusEl) statusEl.textContent = 'État : ' + LABELS[state];
  }

  function setState(next) {
    state = next;
    render();
    send('ARCADE_STATE', { state: next });
  }

  function keys(o) { return Object.keys(o).sort().join(','); }

  function toGame(name, detail) {
    if (typeof document.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  function notifyGame(type, reducedMotion) {
    toGame('filament:host', { type: type, reducedMotion: reducedMotion === true });
  }

  // [FILAMENT-3] a save result for a request this page sent and has not seen answered, with the same operation
  function isSaveResult(d) {
    if (keys(d) !== 'channel,gameId,instanceId,payload,requestId,type,v' || d.type !== 'ARCADE_SAVE_RESULT') return false;
    if (d.channel !== CHANNEL || d.v !== VERSION || d.gameId !== GAME_ID || d.instanceId !== instanceId) return false;
    if (typeof d.requestId !== 'string' || !Object.prototype.hasOwnProperty.call(pending, d.requestId)) return false;
    var p = d.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.op !== pending[d.requestId]) return false;
    if (p.status === 'ERROR') return typeof p.code === 'string' && SAVE_ERROR_CODES.indexOf(p.code) !== -1;
    if (p.op === 'LOAD') {
      if (p.status === 'EMPTY') return true;
      return p.status === 'FOUND' && !!p.save && typeof p.save === 'object' && typeof p.save.saveVersion === 'number';
    }
    return p.status === 'SAVED';
  }

  function onSaveResult(d) {
    var op = pending[d.requestId];
    delete pending[d.requestId];
    pendingCount -= 1;
    var p = d.payload;
    var detail = { op: op, status: p.status };
    if (p.status === 'ERROR') detail.code = p.code;
    if (op === 'LOAD' && p.status === 'FOUND') { detail.saveVersion = p.save.saveVersion; detail.data = p.save.data; }
    toGame('filament:save-result', detail);
  }

  function request(op, type, payload) {
    if (!instanceId || pendingCount >= MAX_PENDING) return false;
    var requestId = nextRequestId();
    pending[requestId] = op;
    pendingCount += 1;
    send(type, payload, requestId);
    return true;
  }

  // write request from game.js: only {saveVersion: positive integer, data}; nothing else is forwarded
  function saveWrite(event) {
    var detail = event && event.detail;
    var ok = (state === 'active' || state === 'paused') && !!detail && typeof detail === 'object' &&
      typeof detail.saveVersion === 'number' && detail.saveVersion % 1 === 0 && detail.saveVersion > 0 &&
      request('WRITE', 'ARCADE_SAVE_WRITE', { saveVersion: detail.saveVersion, data: detail.data });
    if (!ok) toGame('filament:save-result', { op: 'WRITE', status: 'ERROR', code: 'SAVE_BUSY' });
  }

  function isHostCommand(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (isSaveResult(d)) return true;
    if (keys(d) !== 'channel,gameId,instanceId,payload,type,v') return false;
    if (d.channel !== CHANNEL || d.v !== VERSION || d.gameId !== GAME_ID || d.instanceId !== instanceId) return false;
    var p = d.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (d.type === 'ARCADE_INIT') return keys(p) === 'reducedMotion' && typeof p.reducedMotion === 'boolean';
    if (d.type === 'ARCADE_FULLSCREEN_STATE') return keys(p) === 'fullscreen' && typeof p.fullscreen === 'boolean';
    if (d.type === 'ARCADE_PAUSE' || d.type === 'ARCADE_RESUME' || d.type === 'ARCADE_STOP') return keys(p) === '';
    return false;
  }

  function exitRequest() {
    if (state === 'active' || state === 'paused') send('ARCADE_EXIT_REQUEST', {});
  }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('filament:exit-request', exitRequest);
    document.addEventListener('filament:save-write', saveWrite);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== HOST_ORIGIN || !isHostCommand(event.data)) return;
    var d = event.data;
    // after STOP nothing is accepted any more, late save results included
    if (state === 'stopped') return;
    if (d.type === 'ARCADE_FULLSCREEN_STATE') {
      root.setAttribute('data-host-fullscreen', d.payload.fullscreen ? 'true' : 'false');
    } else if (d.type === 'ARCADE_SAVE_RESULT') {
      onSaveResult(d);
    } else if (d.type === 'ARCADE_INIT') {
      if (state !== 'waiting') return;
      setState('active');
      notifyGame('INIT', d.payload.reducedMotion);
      request('LOAD', 'ARCADE_SAVE_LOAD', {});
    } else if (d.type === 'ARCADE_PAUSE') {
      if (state === 'active') { setState('paused'); notifyGame('PAUSE'); }
    } else if (d.type === 'ARCADE_RESUME') {
      if (state === 'paused') { setState('active'); notifyGame('RESUME'); }
    } else if (d.type === 'ARCADE_STOP') {
      root.setAttribute('data-host-fullscreen', 'false');
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('filament:exit-request', exitRequest);
        document.removeEventListener('filament:save-write', saveWrite);
      }
      setState('stopped');
      notifyGame('STOP');
    }
  });

  window.addEventListener('error', function () { send('ARCADE_ERROR', { code: 'GAME_RUNTIME_ERROR' }); });

  render();
  if (!instanceId) {
    if (statusEl) statusEl.textContent = 'État : à lancer depuis l’Arcade Docteur';
    return;
  }
  send('ARCADE_READY', {});
})();
