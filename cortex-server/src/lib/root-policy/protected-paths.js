/**
 * ROOT POLICY V1 closure (RPC-2B) — which files an AI-driven APPLY path may never create, overwrite, delete or move.
 *
 * Root Policy is signed by a human and cannot be changed at runtime. The two flows that apply model-proposed file changes
 * (external agents → `review()`, MetaGPT → apply runner) already require a human approval of the diff; this module adds the missing
 * barrier: a change that resolves INTO the Root Policy perimeter is refused outright, whoever approved it.
 *
 * The perimeter is deliberately small and exact (NOT all of cortex-server/, NOT every file whose name contains "root-policy"):
 *   • the active signed pair + its human-only recovery copy      cortex-server/policy/            (or $DOCTEUR_ROOT_POLICY_DIR)
 *   • the engine, loader, trust anchors, this module              cortex-server/src/lib/root-policy/
 *   • the read-only HTTP surface                                  cortex-server/src/routes/root-policy.js
 *   • the offline human signing tool (it receives the passphrase) cortex-server/root-policy-tool.mjs
 *   • the per-machine anti-rollback state + local audit chain    cortex-server/data/root-policy/  (or <SQLITE_PATH dir>/root-policy)
 *   • the encrypted signing key location                          ~/.docteur/root-policy/
 * Reading is never restricted: the policy is public and an agent may use it as context.
 *
 * The decision is made on the CANONICAL path, never on the string the caller supplied: `..`, `.`, mixed separators, case, trailing dots
 * and spaces (Windows ignores them), and any symlink / junction on the way are resolved first. Prefix confusion is impossible
 * (`policy-backup` is not `policy`): a path is inside a directory only when it equals it or continues after a separator.
 * If a path inside the perimeter cannot be resolved with certainty it is treated as protected (fail closed); this concerns only
 * paths that already contain a link whose target cannot be read — an ordinary missing file is simply "not protected".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORTEX_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WINDOWS = process.platform === 'win32';
const CASE_INSENSITIVE = WINDOWS || process.platform === 'darwin';
const MAX_LINK_HOPS = 16;
// The offline signing tool is only DESIGNATED below (a path to protect), never imported or launched. The Root Policy static audit allows exactly that
// one declaration line in this file, and only while the file stays free of any execution / network / dynamic-load primitive (see signingToolFindings).

/** The exact perimeter (absolute, not yet canonical). Evaluated on every call so tests / env overrides are honoured. */
export function rootPolicyProtectedPaths({ env = process.env, home = os.homedir() } = {}) {
  const dirs = [
    path.join(CORTEX_SERVER, 'policy'),
    path.join(CORTEX_SERVER, 'src', 'lib', 'root-policy'),
    path.join(CORTEX_SERVER, 'data', 'root-policy'),
    path.join(home, '.docteur', 'root-policy'),
  ];
  if (env.DOCTEUR_ROOT_POLICY_DIR) dirs.push(path.resolve(env.DOCTEUR_ROOT_POLICY_DIR));
  if (env.SQLITE_PATH) dirs.push(path.join(path.dirname(path.resolve(env.SQLITE_PATH)), 'root-policy'));
  const files = [
    path.join(CORTEX_SERVER, 'src', 'routes', 'root-policy.js'),
    path.join(CORTEX_SERVER, 'root-policy-tool.mjs'),
  ];
  return { dirs, files };
}

class Ambiguous extends Error {}

// Windows silently drops trailing dots and spaces from every path component: `policy.` and `policy ` open `policy`.
function dropWindowsDecor(part) {
  if (!WINDOWS) return part;
  let end = part.length;
  while (end > 0 && (part[end - 1] === '.' || part[end - 1] === ' ')) end--;
  return part.slice(0, end);
}

function stripVerbatimPrefix(p) {
  if (!WINDOWS) return p;
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

/**
 * Canonical form used ONLY for the protection decision: absolute, `..`/`.` collapsed, every existing link followed
 * (symlink, junction), Windows decoration dropped, case folded where the filesystem is case-insensitive.
 * The deepest existing ancestor is resolved with the OS (long names, real casing); the not-yet-existing tail is appended lexically.
 */
export function canonicalForProtection(target, hops = 0) {
  if (typeof target !== 'string' || target.includes('\0')) throw new Ambiguous('unresolvable');
  if (hops > MAX_LINK_HOPS) throw new Ambiguous('too_many_links');
  const abs = path.resolve(stripVerbatimPrefix(target));
  const { root } = path.parse(abs);
  const parts = abs.slice(root.length).split(path.sep).filter(p => p && p !== '.');

  let existing = root;
  let consumed = 0;
  for (; consumed < parts.length; consumed++) {
    const next = path.join(existing, parts[consumed]);
    try { fs.lstatSync(next); } catch { break; }
    existing = next;
  }

  let real = existing;
  try {
    real = stripVerbatimPrefix(fs.realpathSync.native(existing));
  } catch {
    // The deepest existing entry could not be resolved: a link whose target is missing / unreadable. Follow it by hand
    // (a dangling link can still be a way to CREATE a file at its target); if even that is impossible the perimeter check fails closed.
    let link;
    try { link = fs.readlinkSync(existing); } catch { throw new Ambiguous('unresolvable_entry'); }
    const linked = path.resolve(path.dirname(existing), stripVerbatimPrefix(link));
    real = canonicalForProtection(linked, hops + 1);
  }

  const tail = parts.slice(consumed).map(dropWindowsDecor).filter(Boolean);
  const canonical = path.join(real, ...tail);
  return CASE_INSENSITIVE ? canonical.toLowerCase() : canonical;
}
const inside = (candidate, dir) => candidate === dir || candidate.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * True when `target` (any spelling: absolute, relative to cwd, with `..`, mixed separators, other casing, through a link) designates
 * a file or directory of the Root Policy perimeter. `options.paths` (tests) replaces the perimeter.
 */
export function isRootPolicyProtected(target, options = {}) {
  const perimeter = options.paths ?? rootPolicyProtectedPaths(options);
  let candidate;
  try {
    candidate = canonicalForProtection(target);
  } catch {
    // Cannot be resolved with certainty. Only a path that LEXICALLY sits in the perimeter is refused for that reason; anything else
    // that is merely odd keeps working (an ordinary file must never become unwritable because of this check).
    return lexicallyInside(target, perimeter);
  }
  for (const dir of perimeter.dirs) if (inside(candidate, safeCanonical(dir))) return true;
  for (const file of perimeter.files) if (candidate === safeCanonical(file)) return true;
  return false;
}

function safeCanonical(p) {
  try { return canonicalForProtection(p); } catch { const abs = path.resolve(p); return CASE_INSENSITIVE ? abs.toLowerCase() : abs; }
}

function lexicallyInside(target, perimeter) {
  if (typeof target !== 'string') return true;
  const abs = path.resolve(target.replaceAll('\0', ''));
  const folded = CASE_INSENSITIVE ? abs.toLowerCase() : abs;
  return perimeter.dirs.some(d => inside(folded, CASE_INSENSITIVE ? path.resolve(d).toLowerCase() : path.resolve(d)))
    || perimeter.files.some(f => folded === (CASE_INSENSITIVE ? path.resolve(f).toLowerCase() : path.resolve(f)));
}

/** Throws a `root_policy_protected` error (no path, no content in the message) when a mutation would touch the perimeter. */
export function assertNotRootPolicyPath(target, { operation = 'write', ...options } = {}) {
  if (isRootPolicyProtected(target, options)) {
    throw Object.assign(new Error('root_policy_protected'), { code: 'root_policy_protected', operation });
  }
}
