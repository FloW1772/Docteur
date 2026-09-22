/**
 * Code Intelligence Gateway — strictly read-only. Repository text/filename/
 * symbol search plus a git status/diff/log/show wrapper. No apply, no
 * write, no shell, no network, no cloud call anywhere in this route.
 *
 * Guard shape copied verbatim from sherlock.js: loopback-only, Host
 * allowlist, Origin allowlist (checked only when the header is present),
 * content-type gate on the one route that reads query params from a JSON
 * body (none currently — all routes here are GET with querystring params,
 * kept for consistency with the established pattern should a POST ever
 * be added), bodyLimit as a second, independent middleware layer.
 */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { searchText, searchFilenames, searchSymbols, WorkspacePathError as SearchPathError } from '../lib/code-intel-search.js';
import { gitStatus, gitDiff, gitLog, gitShow, isGitAvailable, GitUnavailableError, InvalidRefError, WorkspacePathError as GitPathError } from '../lib/code-intel-git.js';

const local = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

const PATH_ERROR_STATUS = {
  code_intel_path_invalid: 400,
  code_intel_path_too_long: 400,
  code_intel_path_absolute_denied: 400,
  code_intel_path_traversal_denied: 403,
  code_intel_path_not_found: 404,
  code_intel_path_symlink_escape_denied: 403,
  code_intel_path_excluded: 403,
};

function handlePathError(c, error) {
  if (error instanceof SearchPathError || error instanceof GitPathError) {
    return c.json({ ok: false, error: error.code }, PATH_ERROR_STATUS[error.code] ?? 400);
  }
  return null;
}

export function createCodeIntelRoute({ logger, isLocal = c => { try { return local(getConnInfo(c).remote.address); } catch { return false; } } } = {}) {
  const app = new Hono();

  app.use('/code-intel/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'local_access_required' }, 403);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) return c.json({ error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        if (!['http:', 'https:'].includes(new URL(origin).protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) {
          return c.json({ error: 'origin_denied' }, 403);
        }
      } catch {
        return c.json({ error: 'origin_denied' }, 403);
      }
    }
    await next();
  });
  app.use('/code-intel/*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  app.get('/code-intel/status', c => {
    return c.json({
      ok: true,
      readOnly: true,
      gitAvailable: isGitAvailable(),
      capabilities: ['text_search', 'filename_search', 'symbol_search_heuristic', 'git_status', 'git_diff', 'git_log', 'git_show'],
    });
  });

  app.get('/code-intel/search', async c => {
    const query = c.req.query('q');
    const kind = c.req.query('kind') ?? 'text'; // text | filename
    const limit = c.req.query('limit');
    try {
      const result = kind === 'filename'
        ? await searchFilenames({ query, limit })
        : await searchText({ query, limit, caseSensitive: c.req.query('caseSensitive') === 'true' });
      if (!result.ok) return c.json({ ok: false, error: result.reason }, result.reason === 'timeout' ? 504 : 500);
      return c.json(result);
    } catch (error) {
      const pathResponse = handlePathError(c, error);
      if (pathResponse) return pathResponse;
      if (error.message === 'query_required') return c.json({ ok: false, error: 'query_required' }, 400);
      if (error.message === 'query_too_long') return c.json({ ok: false, error: 'query_too_long' }, 400);
      logger?.error?.({ error: error.message }, 'CODE_INTEL_SEARCH_FAILED');
      return c.json({ ok: false, error: 'search_failed' }, 500);
    }
  });

  app.get('/code-intel/symbols', async c => {
    const query = c.req.query('q');
    const limit = c.req.query('limit');
    try {
      const result = await searchSymbols({ query, limit });
      if (!result.ok) return c.json({ ok: false, error: result.reason }, result.reason === 'timeout' ? 504 : 500);
      return c.json(result);
    } catch (error) {
      if (error.message === 'query_required') return c.json({ ok: false, error: 'query_required' }, 400);
      if (error.message === 'query_too_long') return c.json({ ok: false, error: 'query_too_long' }, 400);
      logger?.error?.({ error: error.message }, 'CODE_INTEL_SYMBOLS_FAILED');
      return c.json({ ok: false, error: 'search_failed' }, 500);
    }
  });

  app.get('/code-intel/git/status', async c => {
    try {
      const result = await gitStatus();
      if (!result.ok) return c.json({ ok: false, error: result.reason }, result.reason === 'timeout' ? 504 : 500);
      return c.json(result);
    } catch (error) {
      if (error instanceof GitUnavailableError) return c.json({ ok: false, error: 'git_not_found' }, 503);
      logger?.error?.({ error: error.message }, 'CODE_INTEL_GIT_STATUS_FAILED');
      return c.json({ ok: false, error: 'git_command_failed' }, 500);
    }
  });

  app.get('/code-intel/git/diff', async c => {
    const staged = c.req.query('staged') === 'true';
    const relPath = c.req.query('path') || null;
    try {
      const result = await gitDiff({ staged, relPath });
      if (!result.ok) return c.json({ ok: false, error: result.reason }, result.reason === 'timeout' ? 504 : 500);
      return c.json(result);
    } catch (error) {
      const pathResponse = handlePathError(c, error);
      if (pathResponse) return pathResponse;
      if (error instanceof GitUnavailableError) return c.json({ ok: false, error: 'git_not_found' }, 503);
      logger?.error?.({ error: error.message }, 'CODE_INTEL_GIT_DIFF_FAILED');
      return c.json({ ok: false, error: 'git_command_failed' }, 500);
    }
  });

  app.get('/code-intel/git/log', async c => {
    const limit = c.req.query('limit');
    try {
      const result = await gitLog({ limit });
      if (!result.ok) return c.json({ ok: false, error: result.reason }, result.reason === 'timeout' ? 504 : 500);
      return c.json(result);
    } catch (error) {
      if (error instanceof GitUnavailableError) return c.json({ ok: false, error: 'git_not_found' }, 503);
      logger?.error?.({ error: error.message }, 'CODE_INTEL_GIT_LOG_FAILED');
      return c.json({ ok: false, error: 'git_command_failed' }, 500);
    }
  });

  app.get('/code-intel/git/show', async c => {
    const ref = c.req.query('ref');
    const relPath = c.req.query('path') || null;
    try {
      const result = await gitShow({ ref, relPath });
      if (!result.ok) return c.json({ ok: false, error: result.reason }, result.reason === 'timeout' ? 504 : 500);
      return c.json(result);
    } catch (error) {
      const pathResponse = handlePathError(c, error);
      if (pathResponse) return pathResponse;
      if (error instanceof InvalidRefError) return c.json({ ok: false, error: 'invalid_ref' }, 400);
      if (error instanceof GitUnavailableError) return c.json({ ok: false, error: 'git_not_found' }, 503);
      logger?.error?.({ error: error.message }, 'CODE_INTEL_GIT_SHOW_FAILED');
      return c.json({ ok: false, error: 'git_command_failed' }, 500);
    }
  });

  return app;
}
