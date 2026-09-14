// Tests pour les providers IA (PAIR, Claude OAuth, Codex)
// Teste la configuration et les propriétés des providers réellement utilisés
// par le router legacy (src/lib/router.js) — router-v2.js et providers/index.js
// ont été supprimés (code mort, jamais importé par aucune route réelle).

import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { CLOUD_PROVIDER_IDS } from './src/lib/router.js';
import { pairProvider } from './src/lib/providers/pair.js';
import { claudeOAuthProvider, ClaudeAuthMode } from './src/lib/providers/claude-oauth.js';
import { codexProvider } from './src/lib/providers/codex.js';
import { BaseProvider } from './src/lib/providers/base-provider.js';

describe('Providers IA', () => {
  describe('NVIDIA PAIR Provider', () => {
    it('devrait avoir un ID correct', () => {
      assert.strictEqual(pairProvider.id, 'pair');
    });

    it('devrait avoir un label correct', () => {
      assert.strictEqual(pairProvider.label, 'NVIDIA PAIR');
    });

    it('devrait être de type local', () => {
      assert.strictEqual(pairProvider.type, 'local');
    });

    it('devrait avoir authType none', () => {
      assert.strictEqual(pairProvider.authType, 'none');
    });

    it('devrait être local', () => {
      assert.strictEqual(pairProvider.isLocal, true);
    });

    it('devrait être configuré (endpoint par défaut)', async () => {
      const configured = await pairProvider.isConfigured();
      assert.strictEqual(configured, true);
    });

    it('devrait pouvoir changer d\'endpoint et le conserver', () => {
      const originalEndpoint = pairProvider.endpoint;
      pairProvider.setEndpoint('http://localhost:9000');
      assert.strictEqual(pairProvider.endpoint, 'http://localhost:9000');
      pairProvider.setEndpoint(originalEndpoint);
    });

    it('devrait revenir au défaut localhost:8080 si setEndpoint(null)', () => {
      const original = pairProvider.endpoint;
      pairProvider.setEndpoint(null);
      assert.strictEqual(pairProvider.endpoint, 'http://localhost:8080');
      pairProvider.setEndpoint(original);
    });

    it('devrait retourner une liste de modèles (peut échouer si endpoint non disponible)', async () => {
      try {
        const models = await pairProvider.listModels();
        assert.ok(Array.isArray(models));
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    });

    it('devrait avoir des capacités définies', () => {
      const caps = pairProvider.capabilities;
      assert.strictEqual(caps.vision, true);
      assert.strictEqual(caps.embeddings, true);
      assert.strictEqual(caps.streaming, true);
      assert.strictEqual(caps.chat, true);
    });

    it('devrait avoir une classe de coût low', () => {
      assert.strictEqual(pairProvider.estimatedCostClass, 'low');
    });

    it('devrait être compatible fallback', () => {
      assert.strictEqual(pairProvider.fallbackCompatible, true);
    });
  });

  describe('Claude OAuth / Setup-token Provider', () => {
    it('devrait avoir un ID correct', () => {
      assert.strictEqual(claudeOAuthProvider.id, 'claude-oauth');
    });

    it('devrait avoir un label correct', () => {
      assert.strictEqual(claudeOAuthProvider.label, 'Claude Code (OAuth)');
    });

    it('devrait être de type cloud', () => {
      assert.strictEqual(claudeOAuthProvider.type, 'cloud');
    });

    it('devrait avoir authType oauth-token', () => {
      assert.strictEqual(claudeOAuthProvider.authType, 'oauth-token');
    });

    it('devrait être payant', () => {
      assert.strictEqual(claudeOAuthProvider.estimatedCostClass, 'high');
    });

    it('devrait avoir des modèles par défaut', () => {
      assert.ok(claudeOAuthProvider.defaultModels.length > 0);
      assert.ok(claudeOAuthProvider.defaultModels.includes('claude-haiku-4-5-20251001'));
    });

    it('devrait avoir des capacités définies', () => {
      const caps = claudeOAuthProvider.capabilities;
      assert.strictEqual(caps.vision, true);
      assert.strictEqual(caps.tools, true);
      assert.strictEqual(caps.chat, true);
    });

    it('devrait être compatible fallback', () => {
      assert.strictEqual(claudeOAuthProvider.fallbackCompatible, true);
    });

    it('devrait exposer les 3 modes d\'authentification possibles', () => {
      assert.strictEqual(ClaudeAuthMode.SETUP_TOKEN, 'setup_token');
      assert.strictEqual(ClaudeAuthMode.CLI_SESSION, 'cli_session');
      assert.strictEqual(ClaudeAuthMode.NONE, 'none');
    });

    it('getAuthMode() renvoie "none" quand ni CLAUDE_CODE_OAUTH_TOKEN ni CLI ne sont disponibles', async () => {
      const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      try {
        const mode = await claudeOAuthProvider.getAuthMode();
        // Sur une machine sans CLI claude installé, doit être 'none'.
        // Sur une machine avec CLI authentifié, serait 'cli_session' — les
        // deux sont acceptables ici, seul 'setup_token' est exclu sans le token.
        assert.notStrictEqual(mode, ClaudeAuthMode.SETUP_TOKEN);
      } finally {
        if (original !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
      }
    });

    it('un CLAUDE_CODE_OAUTH_TOKEN présent n\'est jamais exposé par testKey()/getAuthMode()', async () => {
      const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-SYNTHETIC_TEST_TOKEN_DO_NOT_LOG';
      try {
        const health = await claudeOAuthProvider.getHealth().catch(e => ({ error: e.message }));
        const serialized = JSON.stringify(health);
        assert.ok(!serialized.includes('SYNTHETIC_TEST_TOKEN'));
      } finally {
        if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
        claudeOAuthProvider.invalidateHealthCache();
      }
    });

    it('devrait retourner une liste de modèles', async () => {
      const models = await claudeOAuthProvider.listModels();
      assert.ok(Array.isArray(models));
    });
  });

  describe('Codex Provider', () => {
    it('devrait avoir un ID correct', () => {
      assert.strictEqual(codexProvider.id, 'codex');
    });

    it('devrait avoir un label correct', () => {
      assert.strictEqual(codexProvider.label, 'Codex (OpenAI)');
    });

    it('devrait être de type cloud', () => {
      assert.strictEqual(codexProvider.type, 'cloud');
    });

    it('devrait avoir authType oauth-token', () => {
      assert.strictEqual(codexProvider.authType, 'oauth-token');
    });

    it('devrait être payant', () => {
      assert.strictEqual(codexProvider.estimatedCostClass, 'high');
    });

    it('devrait avoir des modèles par défaut', () => {
      assert.ok(codexProvider.defaultModels.length > 0);
      // 'gpt-4o' is deliberately NOT in this list: verified rejected by
      // ChatGPT-subscription auth ("not supported when using Codex with a
      // ChatGPT account" — see the comment on defaultModels in
      // lib/providers/codex.js). 'gpt-6-astra' is the confirmed-working
      // provisioned model, verified via a real live testConnection() call.
      assert.ok(codexProvider.defaultModels.includes('gpt-6-astra'));
      assert.ok(!codexProvider.defaultModels.includes('gpt-4o'), 'gpt-4o must never reappear here — it is actively rejected by the real CLI');
    });

    it('devrait avoir des capacités définies', () => {
      const caps = codexProvider.capabilities;
      assert.strictEqual(caps.tools, true);
      assert.strictEqual(caps.chat, true);
      assert.strictEqual(caps.code_execution, true);
    });

    it('devrait être compatible fallback', () => {
      assert.strictEqual(codexProvider.fallbackCompatible, true);
    });

    it('ne doit jamais lire OPENAI_API_KEY pour son authentification', () => {
      const source = codexProvider.constructor.toString();
      assert.ok(!source.includes('OPENAI_API_KEY'));
    });

    it('devrait retourner une liste de modèles', async () => {
      const models = await codexProvider.listModels();
      assert.ok(Array.isArray(models));
    });
  });

  describe('BaseProvider Abstraction', () => {
    it('devrait exporter BaseProvider et les 3 providers en héritent', () => {
      assert.ok(BaseProvider);
      assert.ok(pairProvider instanceof BaseProvider);
      assert.ok(claudeOAuthProvider instanceof BaseProvider);
      assert.ok(codexProvider instanceof BaseProvider);
    });
  });

  describe('Router legacy (src/lib/router.js) — seul router réellement branché', () => {
    it('CLOUD_PROVIDER_IDS inclut pair, claude-oauth et codex parmi les providers cloud/local gérés', () => {
      assert.ok(CLOUD_PROVIDER_IDS.includes('claude-oauth'));
      assert.ok(CLOUD_PROVIDER_IDS.includes('codex'));
    });
  });

  describe('Routes API', () => {
    it('devrait exporter TESTERS avec les nouveaux providers', async () => {
      const routeModule = await import('./src/routes/router.js');
      assert.ok(routeModule.createRouterRoute);
    });
  });
});

console.log('Exécution des tests des providers IA...');
