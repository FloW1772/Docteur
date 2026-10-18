// SEC-REMED-4B — Phase 13 closure inventory: every place in src/ that touches an error's TEXT (err.message, .stack,
// String(err), { err: e }) must be either
//   • SANITIZED          — it goes through safe-error-contract.js (publicErrorBody / publicErrorMessage / safeErrorReason /
//                          safeErrorLogFields / hasTrustedMessage) or classifyModelError;
//   • CLASSIFICATION_READ — the text is only compared / matched to pick a code, never copied into an output;
//   • GUARDED_AT_LOG_BOUNDARY — a pino logger field whose key is an error-text key: logger.js withholds it structurally;
//   • or listed below with an explicit class and reason.
// A new unclassified occurrence fails this test. Static analysis only: no server, no DB, no network.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const OCC = /\b(err|error|e|err2|ex|exc|cause|caught|readErr|statErr|writeErr|parseErr|fallbackErr)\??\.(message|stack)\b|String\((err|error|e)\)|\{ err: (e|err|error) \}|\berr: (e|err|error)\b(?![.?])/;
const SANITIZED = /publicErrorBody|publicErrorMessage|safeErrorLogFields|safeErrorReason|toSafePublicError|hasTrustedMessage\(|isPublicError\((err|error|e)\) \?|if \(isPublicError\((err|error|e)\)\) return|classifyModelError/;
const SINK = /c\.json\(|c\.text\(|send\(|onEvent\(|write\(|return \{|resolve\(\{|reason:|error_message:|errorMessage:|lastError|\.error = |insertActivityLog|update\w*\(|push\(\{/;
const CLASSIFY = /\.message\s*(===|!==)|\.message\??\.(includes|startsWith|endsWith|match|toLowerCase)\(|String\([^)]*\.message[^)]*\)\.toLowerCase\(|\.test\(|toLowerCase\(\)/;
const LOGGER = /\blogger\b|\blog\(\s*'(warn|error|info)'/;
const GUARDED_KEY = /\b(err|error|errors|error_message|error_stack|errorMessage|err_message|stack|cause|stderr|lastError): (err|error|e|err2|ex)\??\.(message|stack)\b(?! *\?\? *'[^']*'\s*\})|\{ err: (e|err|error) \}|\berr: (e|err|error)\b(?![.?])/;

// [file, substring of the line, class, reason]. Classes:
//   SAFE_TRUSTED_APPLICATION_ERROR — the error is a Docteur type whose message is written by Docteur (checked here);
//   UNTRUSTED_CARRIER_NOT_A_SINK   — builds / forwards an error object that carries untrusted text; no client, log or
//                                    store sink here (sinks downstream go through the contract);
//   NOT_USER_REACHABLE             — boot-time / disabled / unmounted code path;
//   TEST_ONLY                      — test helper shipped in src/;
//   REMAINING_SEC4_SURFACE         — reachable relay inside a module this mission was not allowed to modify (frozen):
//                                    reported in the audit report as residual, never silently accepted.
const MANIFEST = [
  // ── contract itself ──
  ['src/lib/safe-error-contract.js', 'error.message', 'SAFE_TRUSTED_APPLICATION_ERROR', 'returns the message only for a PublicError / closed-table error (hasTrustedMessage)'],
  ['src/lib/safe-error-contract.js', 'e.message', 'SAFE_TRUSTED_APPLICATION_ERROR', 'e = toSafePublicError(...) output (already sanitized)'],
  ['src/lib/model-router.js', 'if (error instanceof ModelRouteError) return { code: error.code, message: error.message', 'SAFE_TRUSTED_APPLICATION_ERROR', 'ModelRouteError messages are written by Docteur (SEC-REMED-4)'],
  ['src/lib/model-router.js', 'const text = `${error?.name', 'SAFE_TRUSTED_APPLICATION_ERROR', 'classifyModelError: text READ to pick a code, never copied (SEC-REMED-4 static test)'],
  ['src/lib/model-router.js', "route?.error?.message ?? 'Aucune route.'", 'SAFE_TRUSTED_APPLICATION_ERROR', 'route.error is a ModelRouteError-shaped object built by selectRoute (Docteur text)'],
  ['src/routes/model-router.js', 'message: err.message, hint: err.hint', 'SAFE_TRUSTED_APPLICATION_ERROR', 'only inside `if (err instanceof ModelRouteError)`'],
  ['src/server.js', 'throw new Error(`TLS certificate invalid: ${error.message}`)', 'NOT_USER_REACHABLE', 'boot-time TLS config check (LOCAL_NETWORK only); aborts startup, no HTTP surface'],
  ['src/routes/capture.js', "return c.json({ error: err.code, message: err.message }, 400)", 'SAFE_TRUSTED_APPLICATION_ERROR', 'youtube-channel-queue inputError(): literal Docteur messages (EMPTY_INPUT / TOO_MANY_INPUTS)'],
  ['src/routes/capture.js', "return c.json({ error: err.code, message: err.message }, 503)", 'SAFE_TRUSTED_APPLICATION_ERROR', "youtube-channel-queue inputError('QUEUE_CLOSED', 'File YouTube arrêtée')"],
  ['src/routes/capture.js', 'return c.json({ error: err.message }, 400);', 'SAFE_TRUSTED_APPLICATION_ERROR', 'normalizeDiscoveryOptions() only throws literal TypeErrors (Docteur validation)'],
  ['src/routes/download.js', 'URL bloquée : ${e.message}', 'SAFE_TRUSTED_APPLICATION_ERROR', 'assertSafeUrl → EgressDeniedError, message from the closed Web Egress table'],
  ['src/routes/browser.js', 'return c.json({ error: error.message }, 400);', 'SAFE_TRUSTED_APPLICATION_ERROR', 'validateCustomBrowserPath: Docteur-written validation messages (SEC-11 hardened)'],
  ['src/routes/browser.js', 'return c.json({ error: error.message, ...(error.code', 'SAFE_TRUSTED_APPLICATION_ERROR', 'openUrlInSelectedBrowser: Docteur-written refusals with codes (SEC-11 hardened)'],
  ['src/routes/document-toolbox.js', 'if (err instanceof ToolboxError)', 'SAFE_TRUSTED_APPLICATION_ERROR', 'ToolboxError: Docteur messages; other errors → fixed text'],
  ['src/routes/media-studio.js', 'if (err instanceof StudioError)', 'SAFE_TRUSTED_APPLICATION_ERROR', 'StudioError: Docteur messages'],
  ['src/routes/media-studio.js', "if (err?.name === 'RootPolicyDeniedError')", 'SAFE_TRUSTED_APPLICATION_ERROR', 'Root Policy denial text is written by the Root Policy engine'],
  ['src/routes/recorder.js', 'if (err instanceof RecorderError)', 'SAFE_TRUSTED_APPLICATION_ERROR', 'RecorderError: Docteur messages; never a path or a stack (frozen module)'],
  ['src/routes/companion.js', "message: known ? error.message : 'Erreur interne.'", 'SAFE_TRUSTED_APPLICATION_ERROR', 'only known CompanionError codes keep their message (frozen module)'],
  ['src/routes/notebook-ai-history.js', 'if (err instanceof NotebookImportError)', 'SAFE_TRUSTED_APPLICATION_ERROR', 'NotebookImportError messages are Docteur-written — except PARSER_FAILED (see notebook-parsers.js residual)'],
  ['src/routes/notebook-ai-history.js', 'if (err instanceof ZipSecurityError)', 'SAFE_TRUSTED_APPLICATION_ERROR', 'ZipSecurityError: Docteur messages'],
  ['src/routes/notebook-documents.js', 'return c.json({ error: err.message, code: err.code, status: err.status }', 'SAFE_TRUSTED_APPLICATION_ERROR', 'inside the typed NotebookDocumentError branch (Docteur messages)'],
  ['src/routes/eetf.js', 'safeMessage(e.message)', 'NOT_USER_REACHABLE', 'EETF route not mounted by server.js (EETF disabled pending human activation)'],
  ['src/routes/omega-outbound.js', "const value = error?.code || error?.message || 'internal_error'", 'SAFE_TRUSTED_APPLICATION_ERROR', 'OMEGA outbound errors are typed with codes (frozen OMEGA V2)'],
  ['src/routes/code-intel.js', "error.message === 'query_", 'SAFE_TRUSTED_APPLICATION_ERROR', 'comparison against Docteur sentinels; output is the literal'],

  // ── frozen / disabled modules: residual reachable relays (reported) ──
  ['src/routes/notebook.js', 'toSafeNotebookAskError(error)', 'SANITIZED', 'SEC-REMED-4C: Notebook ask uses the global safe contract; summary/export remain separately inventoried if their raw sinks match'],
  ['src/routes/notebook.js', 'toSafeNotebookSummaryError(error)', 'SANITIZED', 'SEC-REMED-4D: Notebook summary uses the existing safe error contract for HTTP and allowlisted logger fields'],
  ['src/routes/notebook.js', 'safeErrorLogFields(error, {', 'SANITIZED', 'Notebook export uses toSafePublicError and allowlisted safeErrorLogFields for HTTP and logs (SEC-REMED-4F)'],
  ['src/routes/notebook-documents.js', 'toSafeNotebookDocAskError(err)', 'SANITIZED', 'SEC-REMED-4E: Notebook document ask uses the existing safe error contract for HTTP and allowlisted logger fields'],
  ['src/lib/notebook-parsers.js', 'NotebookImportError(', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'parser diagnostics remain an internal carrier; the authorized document route maps them to a stable message (SEC-REMED-4F)'],
  ['src/lib/notebook-ai-history.js', 'safeImportMessage(code)', 'SANITIZED', 'AI-history setup and pipeline jobs expose stable code/message pairs only (SEC-REMED-4F)'],
  ['src/lib/notebook-documents.js', 'safeImportFailureMessage(code)', 'SANITIZED', 'document indexing jobs expose stable code/message pairs only (SEC-REMED-4F)'],
  ['src/lib/notebook-documents.js', "error: err.message }, 'NOTEBOOK_DOC_VECTOR_PURGE_FAILED'", 'GUARDED_AT_LOG_BOUNDARY', 'log(...) wrapper → pino logger: error key withheld'],
  ['src/routes/kg.js', 'error.message', 'NOT_USER_REACHABLE', 'KG disabled: every /api/kg route answers 503 KG_DISABLED; becomes a residual on KG activation (KG staged, not modified)'],
  ['src/lib/kg-', '.message', 'NOT_USER_REACHABLE', 'Knowledge Graph modules: KG disabled pending human activation (staged, not modified)'],
  ['src/lib/kg-test.js', 'error', 'TEST_ONLY', 'KG test harness helper'],
  ['src/lib/eetf-', 'e', 'NOT_USER_REACHABLE', 'EETF: not mounted (disabled pending human activation); typed EetfError + failWith codes'],
  ['src/lib/investigator-ai.js', 'e.message', 'NOT_USER_REACHABLE', 'Investigator V1: untracked, not mounted, fake-AI only'],
  ['src/lib/maitre-', 'err', 'REMAINING_SEC4_SURFACE', 'Maître (frozen): host fs / exec error text (redacted only by pattern in maitre-windows-exec) returned as `detail` to the loopback Maître console'],
  ['src/lib/omega-', 'error', 'REMAINING_SEC4_SURFACE', 'OMEGA (frozen V2): PowerShell / indicator spawn text returned as `detail` / code fallback to the loopback admin flow'],
  ['src/lib/omega-', 'err', 'REMAINING_SEC4_SURFACE', 'OMEGA (frozen V2): idem'],
  ['src/lib/omega-', ' e.', 'REMAINING_SEC4_SURFACE', 'OMEGA (frozen V2): idem (`${e.code}: ${e.message}`)'],
  ['src/lib/rassilon-', 'err', 'REMAINING_SEC4_SURFACE', 'RASSILON (frozen): connection / embedding / bind error text inside typed Rassilon*Error details'],
  ['src/lib/rassilon-', 'error', 'REMAINING_SEC4_SURFACE', 'RASSILON (frozen): idem'],
  ['src/lib/device-fabric-', 'error', 'REMAINING_SEC4_SURFACE', 'Device Fabric (frozen): `error?.code ?? error?.message` used as a code fallback'],
  ['src/lib/companion-', 'e', 'SAFE_TRUSTED_APPLICATION_ERROR', 'Companion (frozen, disabled): CompanionError re-wrapping keeps Docteur codes; model failures already mapped to MODEL_* codes'],

  // ── untrusted carriers: provider / connector / subprocess modules build errors holding upstream text ──
  ['src/lib/providers/', 'message', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'provider modules put upstream text into thrown / health objects; never PublicError, so every sink falls back to fixed text'],
  ['src/lib/providers/', 'error', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'idem (health cache / test result objects; routes expose status/category only)'],
  ['src/lib/provider-errors.js', 'body?.error?.message', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'read to classify the category'],
  ['src/lib/whisper-groq.js', 'Groq Whisper ${res.status}', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'thrown to callers that map it to fixed text (voice / capture)'],
  ['src/lib/connectors/', 'body?.error?.message', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'thrown to connector routes (publicErrorBody)'],
  ['src/lib/kiwix-catalog.js', '${err.message}', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'thrown to kiwix routes (publicErrorBody)'],
  ['src/lib/kiwix-client.js', '${err.message}', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'thrown to kiwix routes / answerQuestion (sanitized)'],
  ['src/lib/kiwix-policy.js', "String(err?.message ?? err ?? '')", 'SAFE_TRUSTED_APPLICATION_ERROR', 'read to classify; kiwixErrorBody never includes raw text'],
  ['src/lib/lancedb.js', '${err.message}', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'thrown to neuron / index / answer callers (sanitized)'],
  ['src/lib/secret-store.js', '${result.error.message}', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'DPAPI launch failure thrown to key routes (publicErrorBody)'],
  ['src/lib/code-intel-git.js', "detail: (err.stderr || err.message", 'UNTRUSTED_CARRIER_NOT_A_SINK', 'routes return result.reason only, never detail'],
  ['src/lib/code-intel-search.js', "detail: (err.stderr || err.message", 'UNTRUSTED_CARRIER_NOT_A_SINK', 'routes return result.reason only, never detail'],
  ['src/lib/metagpt-orchestrator.js', 'stderr: String(e)', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'stderr is no longer persisted nor returned (runnerErrorCode keeps the error_code only)'],
  ['src/lib/openmontage-adapter.js', 'String(e)', 'UNTRUSTED_CARRIER_NOT_A_SINK', 'routes/openmontage.js keeps a closed render status, never the adapter text'],
  ['src/lib/media-studio.js', '${e.code ?? e.message}', 'SAFE_TRUSTED_APPLICATION_ERROR', 'spawn errors always carry a system code (ENOENT/EACCES): the message branch is the unreachable fallback'],
  ['src/lib/investment-timeline.js', 'errors.push({ error: err.message, input: raw })', 'SAFE_TRUSTED_APPLICATION_ERROR', 'buildTimelineEvent throws literal Docteur codes only'],
  ['src/lib/youtube-channel-queue.js', 'job.message = job.error.message', 'SAFE_TRUSTED_APPLICATION_ERROR', 'job.error built from Docteur constants or the sanitized discovery result'],
  ['src/lib/youtube-discovery.js', 'err?.name', 'SAFE_TRUSTED_APPLICATION_ERROR', 'error event uses the sanitized code/message computed just above'],
  ['src/lib/port-preflight.js', "detail: String(err.message || '')", 'NOT_USER_REACHABLE', 'boot-time single-instance probe (netstat / tasklist); local OS output, no HTTP surface'],
  ['src/lib/deep-capture.js', 'ssrf:', 'SAFE_TRUSTED_APPLICATION_ERROR', 'egress reason code'],
  ['src/lib/media-studio.js', 'Root Policy : ${err.message}', 'SAFE_TRUSTED_APPLICATION_ERROR', 'Root Policy denial text / StudioError text only; anything else → fixed text'],
  ['src/lib/youtube-discovery.js', "const message = trusted ? err.message : 'Échec de la découverte YouTube'", 'SAFE_TRUSTED_APPLICATION_ERROR', 'trusted = PublicError (closed yt-dlp table) or Docteur DISCOVERY_* timeout'],
  ['src/routes/metagpt.js', 'err.message === err.code) return { error: err.code, code: err.code }', 'SAFE_TRUSTED_APPLICATION_ERROR', 'policyError(code): message is the Docteur code itself'],
];

const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

function classify(rel, line) {
  if (SANITIZED.test(line)) return 'SANITIZED';
  if (CLASSIFY.test(line) && !SINK.test(line)) return 'CLASSIFICATION_READ';
  if (LOGGER.test(line) && GUARDED_KEY.test(line) && !/c\.json|send\(|insertActivityLog|reason: (err|error)\b|\$\{(err|error|e)\??\.message/.test(line)) return 'GUARDED_AT_LOG_BOUNDARY';
  const hit = MANIFEST.find(([file, needle]) => (rel === file || (file.endsWith('/') || file.endsWith('-') ? rel.startsWith(file) : false)) && line.includes(needle));
  return hit ? hit[2] : null;
}

function inventory() {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(HERE, 'src'));
  const rows = [];
  for (const f of files) {
    const rel = path.relative(HERE, f).replace(/\\/g, '/');
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (isComment(line) || !OCC.test(line)) return;
      rows.push({ rel, line: i + 1, text: line.trim(), cls: classify(rel, line) });
    });
  }
  return rows;
}

test('SEC-4B inventory: every error-text occurrence in src/ is sanitized, a classification read, log-guarded or explicitly classified', () => {
  const rows = inventory();
  const unclassified = rows.filter(r => !r.cls);
  const counts = rows.reduce((acc, r) => { acc[r.cls ?? 'UNCLASSIFIED'] = (acc[r.cls ?? 'UNCLASSIFIED'] ?? 0) + 1; return acc; }, {});
  if (process.env.SEC4B_INVENTORY_DUMP) {
    fs.writeFileSync(process.env.SEC4B_INVENTORY_DUMP, JSON.stringify({ counts, rows }, null, 2));
  }
  test.diagnostic?.(JSON.stringify(counts));
  assert.deepEqual(unclassified.map(r => `${r.rel}:${r.line}: ${r.text.slice(0, 160)}`), [], 'unclassified error-text sinks');
  assert.ok(rows.length > 100, 'the scanner sees the code base');
});

test('SEC-4B inventory: the REMAINING_SEC4_SURFACE entries are only in frozen modules this mission could not modify (Notebook, Maître, OMEGA, RASSILON, Device Fabric)', () => {
  const residual = inventory().filter(r => r.cls === 'REMAINING_SEC4_SURFACE');
  for (const r of residual) assert.match(r.rel, /^src\/(routes|lib)\/(notebook|maitre-|omega-|rassilon-|device-fabric-)/, `${r.rel}:${r.line}`);
});
