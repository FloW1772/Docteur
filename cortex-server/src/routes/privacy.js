import { Hono } from 'hono';
import { PRIVATE_SENTINEL, markPrivate, guardCloudCall, getViolations } from '../lib/privacy-guard.js';
import { getPrivacyViolations } from '../lib/sqlite.js';

export function createPrivacyRoute({ logger }) {
  const app = new Hono();

  // GET /api/privacy/violations — journal des tentatives bloquées (sans contenu)
  app.get('/privacy/violations', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const rows = getPrivacyViolations(limit);
    return c.json({ violations: rows });
  });

  // POST /api/privacy/test — vérifie l'étanchéité du verrou de sortie
  // Simule une tentative d'envoi de contenu privé vers chaque provider cloud
  // et vérifie que TOUS sont bloqués. Aucune vraie requête réseau n'est émise.
  app.post('/privacy/test', async (c) => {
    const results = [];
    const testContent = 'Contenu de test — données personnelles fictives';
    const markedMessages = [
      { role: 'user', content: markPrivate(testContent) },
    ];
    const neutralMessages = [
      { role: 'user', content: 'Question anodine sans données privées' },
    ];

    const providers = ['gemini', 'groq', 'openrouter', 'anthropic', 'openai'];

    for (const provider of providers) {
      // Test 1: private content → must be BLOCKED
      let blockedOk = false;
      try {
        guardCloudCall({ messages: markedMessages, provider, functionCalled: 'privacy-test' });
        blockedOk = false; // should have thrown
      } catch (e) {
        blockedOk = e.isPrivacyViolation === true;
      }

      // Test 2: neutral content → must PASS through (not blocked)
      let passOk = false;
      try {
        guardCloudCall({ messages: neutralMessages, provider, functionCalled: 'privacy-test' });
        passOk = true; // no throw = correct
      } catch {
        passOk = false;
      }

      results.push({ provider, blocked_private: blockedOk, passed_neutral: passOk });
    }

    const allPass = results.every(r => r.blocked_private && r.passed_neutral);

    logger.info({ allPass, results }, 'privacy-tightness-test');

    return c.json({ ok: allPass, results });
  });

  return app;
}
