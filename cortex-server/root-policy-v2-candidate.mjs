#!/usr/bin/env node
/**
 * ROOT POLICY V1 closure (RPC-2C) — OFFLINE helper to prepare and REVIEW a Policy V2 CANDIDATE. It never signs.
 *
 *   node root-policy-v2-candidate.mjs build --out <file> [--issued-at <ISO-8601>]   write the canonical, UNSIGNED version-2 candidate; print its sha256
 *   node root-policy-v2-candidate.mjs diff  --candidate <file> [--active <dir>]     validate the candidate and print the semantic V1 → V2 diff
 *   node root-policy-v2-candidate.mjs hash  --candidate <file>                      print the sha256 of the candidate's bytes
 *
 * What it does NOT do (by construction, and checked by test-rpc2c-policy-v2-candidate.mjs):
 *   • it does not import the signing tool, read any key, ask for a passphrase or write any signature;
 *   • it never writes inside the Root Policy perimeter (the active policy directory, its recovery copy, the engine, the anti-rollback state…) and
 *     refuses to overwrite an existing file — the active V1 pair cannot be replaced by it;
 *   • it only READS the active policy (to diff against it).
 * The signed bytes of the later human ceremony are the canonical bytes of this file: `sha256` printed here = `sha256` printed by the signing step.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDefaultPolicy } from './src/lib/root-policy/default-policy.js';
import { canonicalize, validatePolicy } from './src/lib/root-policy/schema.js';
import { isRootPolicyProtected } from './src/lib/root-policy/protected-paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACTIVE_DIR = process.env.DOCTEUR_ROOT_POLICY_DIR ? path.resolve(process.env.DOCTEUR_ROOT_POLICY_DIR) : path.join(HERE, 'policy');
export const CANDIDATE_VERSION = 2;

export const sha256Hex = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** The canonical bytes of the V2 candidate (what would be signed). */
export function buildCandidateText({ issuedAt = new Date().toISOString() } = {}) {
  if (Number.isNaN(Date.parse(issuedAt))) throw new Error('issuedAt must be an ISO-8601 date');
  const policy = buildDefaultPolicy({ version: CANDIDATE_VERSION, issuedAt });
  const check = validatePolicy(policy);
  if (!check.ok) throw new Error(`candidate refused by the schema: ${check.errors.slice(0, 5).join('; ')}`);
  return canonicalize(policy);
}

/** Flatten a document to `path → JSON value` for leaf comparison (arrays are ordered values). */
function flatten(value, prefix = '$', out = new Map()) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) out.set(prefix, '{}');
    for (const key of keys) flatten(value[key], `${prefix}.${key}`, out);
  } else out.set(prefix, JSON.stringify(value));
  return out;
}

/**
 * Semantic V1 → V2 diff. Every leaf is UNCHANGED, ADDED, REMOVED or CHANGED; entries are grouped by what a human reviews.
 * @returns {{ counts:{UNCHANGED:number,ADDED:number,REMOVED:number,CHANGED:number}, added:string[], removed:string[], changed:Array<{path:string,from:string,to:string}>, groups:object }}
 */
export function semanticDiff(active, candidate) {
  const a = flatten(active); const b = flatten(candidate);
  const added = []; const removed = []; const changed = []; let unchanged = 0;
  for (const [key, value] of b) {
    if (!a.has(key)) added.push(key);
    else if (a.get(key) === value) unchanged++;
    else changed.push({ path: key, from: a.get(key), to: value });
  }
  for (const key of a.keys()) if (!b.has(key)) removed.push(key);
  const groupOf = (p) => (/^\$\.modules\.([^.]+)/.exec(p)?.[1] ? `module:${/^\$\.modules\.([^.]+)/.exec(p)[1]}` : /^\$\.capabilities\.PROCESS\.START_TYPED/.test(p) ? 'capability:PROCESS.START_TYPED' : /^\$\.(version|issuedAt)$/.test(p) ? 'document:version/date' : `other:${p}`);
  const groups = {};
  for (const [kind, list] of [['ADDED', added], ['REMOVED', removed], ['CHANGED', changed.map(c => c.path)]]) {
    for (const p of list) { const g = groupOf(p); (groups[g] ??= { ADDED: 0, REMOVED: 0, CHANGED: 0 })[kind]++; }
  }
  return { counts: { UNCHANGED: unchanged, ADDED: added.length, REMOVED: removed.length, CHANGED: changed.length }, added, removed, changed, groups };
}

/** Refuses to write inside the Root Policy perimeter or over an existing file. Pure decision + the write. */
export function writeCandidate(outFile, text, options = {}) {
  const target = path.resolve(outFile);
  if (isRootPolicyProtected(target, options)) throw new Error('refused: the output path is inside the Root Policy perimeter');
  if (fs.existsSync(target)) throw new Error('refused: the output file already exists (this tool never overwrites)');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' });
  return target;
}

const readActive = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'root-policy.json'), 'utf8'));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i++; } else out._.push(argv[i]); }
  return out;
}

function main() {
  const [command] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  const say = (...a) => console.log(...a);
  const die = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };

  if (command === 'build') {
    if (!args.out) die('--out <file> required');
    const text = buildCandidateText({ issuedAt: args['issued-at'] });
    let target; try { target = writeCandidate(args.out, text); } catch (e) { die(e.message); }
    say(`Candidate written (UNSIGNED, version ${CANDIDATE_VERSION}): ${target}`);
    say(`sha256 ${sha256Hex(text)}  (${Buffer.byteLength(text)} bytes)`);
    return;
  }
  if (command === 'hash') {
    if (!args.candidate) die('--candidate <file> required');
    say(sha256Hex(fs.readFileSync(path.resolve(args.candidate), 'utf8')));
    return;
  }
  if (command === 'diff') {
    if (!args.candidate) die('--candidate <file> required');
    const text = fs.readFileSync(path.resolve(args.candidate), 'utf8');
    let candidate; try { candidate = JSON.parse(text); } catch { die('candidate is not valid JSON'); }
    const check = validatePolicy(candidate);
    const active = readActive(args.active ? path.resolve(args.active) : DEFAULT_ACTIVE_DIR);
    say(`candidate sha256   ${sha256Hex(text)}`);
    say(`candidate canonical ${canonicalize(candidate) === text ? 'YES (byte-identical to canonical form)' : 'NO — it would be re-canonicalised before signing'}`);
    say(`candidate version  ${candidate.version}   (active ${active.version})`);
    say(`schema validation  ${check.ok ? 'OK' : `FAILED: ${check.errors.slice(0, 5).join('; ')}`}`);
    const diff = semanticDiff(active, candidate);
    say(`UNCHANGED ${diff.counts.UNCHANGED}   ADDED ${diff.counts.ADDED}   REMOVED ${diff.counts.REMOVED}   CHANGED ${diff.counts.CHANGED}`);
    for (const [group, c] of Object.entries(diff.groups)) say(`  ${group.padEnd(34)} +${c.ADDED}  -${c.REMOVED}  ~${c.CHANGED}`);
    for (const p of diff.removed) say(`  REMOVED ${p}`);
    for (const c of diff.changed) say(`  CHANGED ${c.path}: ${c.from.slice(0, 60)} → ${c.to.slice(0, 60)}`);
    for (const p of diff.added) say(`  ADDED   ${p}`);
    process.exit(check.ok && diff.counts.REMOVED === 0 ? 0 : 2);
  }
  say('usage: build --out <file> [--issued-at <ISO>] | diff --candidate <file> [--active <dir>] | hash --candidate <file>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
