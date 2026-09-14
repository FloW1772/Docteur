import { Hono } from 'hono';
import { scanPagesForSecrets } from '../lib/secret-scan.js';

export function createSecretScanRoute({ logger } = {}) {
  const route = new Hono();

  // GET /api/maintenance/secret-scan — local, read-only audit of user
  // content (neurons/pages) for API-key-shaped substrings. Never returns
  // matched values, never makes a network call, never modifies data. See
  // src/lib/secret-scan.js for the full contract.
  route.get('/maintenance/secret-scan', (c) => {
    try {
      const result = scanPagesForSecrets();
      if (logger) {
        // Log only counts — never the findings' fields/matches/fingerprints
        // in bulk, to keep even this summary line trivially safe.
        logger.info({
          total: result.total_matches,
          plausible: result.plausible_real_secret,
          example: result.likely_example_text,
          ambiguous: result.ambiguous,
        }, 'secret-scan: pages audit complete');
      }
      return c.json(result);
    } catch (error) {
      if (logger) logger.error({ error: error.message }, 'secret-scan: failed');
      return c.json({ error: 'Échec du scan' }, 500);
    }
  });

  return route;
}
