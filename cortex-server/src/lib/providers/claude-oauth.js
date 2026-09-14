// Claude OAuth / Setup Token Provider
// Mode distinct de l'API Anthropic classique
// Utilise le client officiel Claude Code ou le setup-token

import { execFile, execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BaseProvider } from './base-provider.js';
import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError, parseRetryAfterMs } from '../provider-errors.js';

const CLAUDE_CLI_EXECUTABLE = 'claude';
const TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 10_000;

// Anti-egress guard: DOCTEUR_TEST_MODE is set by test-setup.mjs (imported
// first by every test-*.mjs). It must never be possible for a standard test
// run to spawn the real Claude Code CLI and hit the user's subscription —
// only an explicit DOCTEUR_LIVE_TESTS=1 opt-in bypasses this.
function assertLiveCallAllowed() {
  if (process.env.DOCTEUR_TEST_MODE === '1' && process.env.DOCTEUR_LIVE_TESTS !== '1') {
    throw new Error('EXTERNAL_CALL_BLOCKED_IN_TEST: claude CLI generate()/testConnection() blocked — set DOCTEUR_LIVE_TESTS=1 to run a real live smoke test.');
  }
}

// On Windows, npm installs the Claude Code CLI as a `.cmd` batch shim (e.g.
// `claude.cmd`) that ultimately execs a native `claude.exe` (unlike Codex,
// which resolves to a further `node <script.js>` call — see the equivalent
// helper in codex.js). spawn/execFile with shell:false cannot run a `.cmd`
// directly (Windows needs cmd.exe to interpret it) — but shell:true
// re-introduces shell metacharacter interpretation for any dynamic argument
// (e.g. requestedModel) passed through argv. A non-`.cmd` path (a real .exe
// resolved directly) never needed a shell in the first place — spawn it
// directly with shell:false. A `.cmd` path needs its shim parsed to find the
// real .exe it points to. Returns a spawn plan tagged 'direct' or 'resolved',
// or null only when the path IS a .cmd shim that could not be parsed — the
// caller must treat that as SAFE_CLI_ENTRYPOINT_NOT_RESOLVED, never silently
// falling back to shell:true.
export function planSafeSpawn(cliPath) {
  if (!cliPath.toLowerCase().endsWith('.cmd')) {
    return { mode: 'direct', command: cliPath };
  }
  try {
    const shim = fs.readFileSync(cliPath, 'utf8');
    const match = shim.match(/"%dp0%\\(node_modules\\[^"]+\.exe)"/i);
    if (!match) return null;
    const exePath = path.join(path.dirname(cliPath), match[1]);
    if (!fs.existsSync(exePath)) return null;
    return { mode: 'resolved', command: exePath };
  } catch {
    return null;
  }
}

// Back-compat alias kept for the existing test suite (test-cli-shell-resolution.mjs)
// asserting the .cmd-shim-parsing behavior specifically; only ever returns a
// path for the 'resolved' (shim-parsed) case, never 'direct'.
export function resolveNativeEntrypoint(cliPath) {
  if (!cliPath.toLowerCase().endsWith('.cmd')) return null;
  const plan = planSafeSpawn(cliPath);
  return plan && plan.mode === 'resolved' ? plan.command : null;
}

// Official Claude Code setup-token mechanism: `claude setup-token` produces a
// long-lived OAuth token meant to be exported as CLAUDE_CODE_OAUTH_TOKEN. The
// CLI itself reads this env var and uses it for auth — this is NOT an
// ANTHROPIC_API_KEY and must never be conflated with one, stored, logged, or
// sent to the frontend. We only ever forward it to the CLI subprocess's own
// environment (never as a CLI argument, so it can't leak via ps/task manager
// command-line inspection or shell history).
export const ClaudeAuthMode = Object.freeze({
  SETUP_TOKEN: 'setup_token',
  CLI_SESSION: 'cli_session',
  NONE: 'none',
});

function hasSetupToken() {
  return !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/**
 * Provider Claude OAuth / Setup Token
 * 
 * Ce provider utilise le client officiel Claude Code CLI qui gère lui-même
 * l'authentification OAuth et le setup-token.
 * 
 * Contrairement à l'API Anthropic classique (claude-api-key), ce provider:
 * - Utilise `claude` CLI installé sur la machine
 * - Nécessite une authentification via `claude auth login`
 * - Utilise le token géré par le CLI (pas besoin de le récupérer)
 * - Ne stocke JAMAIS le token dans les settings Docteurs
 * 
 * Modes supportés:
 * - OAuth via `claude auth login` (token géré par le CLI)
 * - Setup token via environnement ou fichier de config Claude
 */
export class ClaudeOAuthProvider extends BaseProvider {
  constructor(config = {}) {
    super({
      id: 'claude-oauth',
      label: 'Claude Code (OAuth)',
      type: 'cloud',
      authType: 'oauth-token',
      priority: 5, // Haute priorité (payant)
      timeout: config.timeout || TIMEOUT_MS,
      isLocal: false,
      defaultModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-3-5-sonnet-20250620'],
      capabilities: {
        vision: true,
        tools: true,
        embeddings: false,
        streaming: true,
        chat: true,
        completions: true,
      },
      estimatedCostClass: 'high', // Payant
      fallbackCompatible: true,
    });
    
    this._cliPath = null;
    this._isAvailable = null;
    this._isAuthenticated = null;
  }

  /**
   * Trouve le chemin du CLI Claude
   * @returns {string|null}
   */
  findCliPath() {
    // Essayer d'abord dans le PATH
    try {
      // Sous Windows, essayer avec .cmd et .exe
      const extensions = ['.cmd', '.exe', ''];
      for (const ext of extensions) {
        try {
          const result = execFileSync(CLAUDE_CLI_EXECUTABLE + ext, ['--version'], {
            timeout: PROBE_TIMEOUT_MS,
            encoding: 'utf8',
          });
          return CLAUDE_CLI_EXECUTABLE + ext;
        } catch {
          // Essayer avec npm global
          const npmPath = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
          if (fs.existsSync(npmPath)) {
            return npmPath;
          }
        }
      }
    } catch {
      // Ignorer
    }
    
    // Essayer des chemins communs sous Windows
    const commonPaths = [
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      path.join(process.env.ProgramFiles || 'C:\Program Files', 'Claude Code', 'claude.exe'),
    ];
    
    for (const p of commonPaths) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // Ignorer
      }
    }
    
    return null;
  }

  /**
   * Vérifie si le CLI Claude est installé
   * @returns {Promise<boolean>}
   */
  async isCliInstalled() {
    if (this._isAvailable !== null) return this._isAvailable;
    
    try {
      const cliPath = this._cliPath || this.findCliPath();
      if (!cliPath) {
        this._isAvailable = false;
        return false;
      }
      
      await new Promise((resolve, reject) => {
        execFile(cliPath, ['--version'], { timeout: PROBE_TIMEOUT_MS, shell: true }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          } else {
            // Vérifier que c'est bien Claude Code
            const output = stdout || stderr || '';
            if (/claude|Claude Code/i.test(output)) {
              this._cliPath = cliPath;
              this._isAvailable = true;
              resolve(true);
            } else {
              this._isAvailable = false;
              resolve(false);
            }
          }
        });
      });
      
      return this._isAvailable;
    } catch {
      this._isAvailable = false;
      return false;
    }
  }

  /**
   * Détermine le mode d'authentification effectif, par priorité :
   * 1. CLAUDE_CODE_OAUTH_TOKEN (setup-token) si présent
   * 2. session CLI existante (`claude auth login`) si authentifiée
   * 3. aucun
   * @returns {Promise<'setup_token'|'cli_session'|'none'>}
   */
  async getAuthMode() {
    if (hasSetupToken()) {
      // Setup-token still requires the CLI binary itself to be installed —
      // the token is consumed BY the CLI, it's not a standalone HTTP auth path.
      const installed = await this.isCliInstalled();
      if (installed) return ClaudeAuthMode.SETUP_TOKEN;
    }
    const cliAuthenticated = await this.isCliSessionAuthenticated();
    if (cliAuthenticated) return ClaudeAuthMode.CLI_SESSION;
    return ClaudeAuthMode.NONE;
  }

  /**
   * Vérifie uniquement la session CLI classique (`claude auth login`),
   * indépendamment d'un éventuel setup-token.
   * @returns {Promise<boolean>}
   */
  async isCliSessionAuthenticated() {
    if (this._isAuthenticated !== null) return this._isAuthenticated;

    try {
      const installed = await this.isCliInstalled();
      if (!installed) {
        this._isAuthenticated = false;
        return false;
      }

      await new Promise((resolve, reject) => {
        execFile(this._cliPath, ['auth', 'status'], { timeout: PROBE_TIMEOUT_MS, shell: true }, (error, stdout, stderr) => {
          if (error) {
            // Code de sortie 1 = non authentifié
            if (error.code === 1 || error.killed) {
              this._isAuthenticated = false;
              resolve(false);
            } else {
              reject(error);
            }
          } else {
            // Sortie vide ou "Logged in" = authentifié
            const output = (stdout || stderr || '').toLowerCase();
            this._isAuthenticated = output.includes('logged') || output.includes('authenticated') || output.includes('connected');
            resolve(this._isAuthenticated);
          }
        });
      });

      return this._isAuthenticated;
    } catch {
      this._isAuthenticated = false;
      return false;
    }
  }

  /**
   * Vérifie si l'utilisateur est authentifié avec Claude Code, tous modes
   * confondus (setup-token OU session CLI).
   * @returns {Promise<boolean>}
   */
  async isAuthenticated() {
    const mode = await this.getAuthMode();
    return mode !== ClaudeAuthMode.NONE;
  }

  /**
   * Vérifie si le provider est configuré
   * @returns {Promise<boolean>}
   */
  async isConfigured() {
    return this.isAuthenticated();
  }

  /**
   * Teste la connexion à Claude Code
   * @returns {Promise<{ok: boolean, model?: string, error?: string}>}
   */
  async testConnection() {
    assertLiveCallAllowed();
    try {
      const authMode = await this.getAuthMode();
      if (authMode === ClaudeAuthMode.NONE) {
        return {
          ok: false,
          authMode,
          error: 'Claude Code: non authentifié. Exécutez `claude auth login` ou configurez CLAUDE_CODE_OAUTH_TOKEN.',
        };
      }

      // Tester avec une requête simple
      const cliPath = this._cliPath;
      const prompt = 'Réponds juste "OK".';

      return new Promise((resolve) => {
        const args = [
          '-p', // Mode prompt
          '--output-format', 'text',
          '--verbose', '0',
          '--no-session-persistence',
          '--restricted',
          '--safe-mode',
        ];

        // The setup-token, when present, is forwarded ONLY via the child
        // process's environment — never as a CLI argument (would leak via
        // process listing / shell history) and never logged.
        const procEnv = { ...process.env };
        if (authMode === ClaudeAuthMode.SETUP_TOKEN) {
          procEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }

        const plan = planSafeSpawn(cliPath);
        if (!plan) {
          resolve({ ok: false, error: 'SAFE_CLI_ENTRYPOINT_NOT_RESOLVED: impossible de résoudre un point d\'entrée sûr pour Claude Code CLI (shim .cmd non reconnu) — appel bloqué plutôt que d\'utiliser un shell.' });
          return;
        }
        const proc = spawn(plan.command, args, { timeout: TIMEOUT_MS, env: procEnv, shell: false });

        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (data) => {
          output += data.toString();
        });

        proc.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ ok: true, model: this.defaultModels[0], authMode });
          } else {
            resolve({
              ok: false,
              authMode,
              error: `Claude Code: erreur (code ${code}) - ${errorOutput || 'Unknown error'}`,
            });
          }
        });

        proc.on('error', (err) => {
          resolve({
            ok: false,
            authMode,
            error: `Claude Code: ${err.message}`,
          });
        });

        // Envoyer le prompt
        proc.stdin.write(prompt);
        proc.stdin.end();
      });
    } catch (error) {
      return {
        ok: false,
        error: `Claude Code: ${error.message}`,
      };
    }
  }

  /**
   * Récupère les modèles disponibles depuis Claude Code
   * Note: Claude CLI ne fournit pas de liste de modèles via CLI
   * On retourne les modèles par défaut
   * @returns {Promise<ModelInfo[]>}
   */
  async listModels() {
    const authenticated = await this.isAuthenticated();
    if (!authenticated) {
      return [];
    }
    
    // Retourner les modèles par défaut
    // Claude CLI utilise les modèles par défaut du service
    return this.defaultModels.map(modelId => ({
      id: modelId,
      displayName: modelId,
      contextLength: modelId.includes('haiku') ? 200000 : modelId.includes('sonnet') ? 200000 : 200000,
      vision: true,
      tools: true,
      local: false,
      provider: 'claude-oauth',
    }));
  }

  /**
   * Génère une réponse avec Claude Code CLI
   * @param {Object} request - Requête de génération
   * @param {Array<{role: string, content: string}>} request.messages - Messages
   * @param {string} [request.model] - Modèle à utiliser
   * @param {number} [request.maxTokens=4096] - Nombre max de tokens
   * @param {number} [request.temperature=0.7] - Température
   * @returns {Promise<{text: string, model: string, usage?: {input_tokens: number, output_tokens: number}}>}
   */
  async generate(request) {
    assertLiveCallAllowed();
    const { messages, model: requestedModel, maxTokens = 4096, temperature = 0.7 } = request;
    if (requestedModel && !/^[A-Za-z0-9_.\-/]{1,128}$/.test(requestedModel)) {
      throw this.createError(
        'Claude Code: nom de modèle invalide (caractères non autorisés)',
        ErrorCategory.MODEL_UNAVAILABLE
      );
    }

    const authMode = await this.getAuthMode();
    if (authMode === ClaudeAuthMode.NONE) {
      throw this.createError(
        'Claude Code: non authentifié. Exécutez `claude auth login` ou configurez CLAUDE_CODE_OAUTH_TOKEN.',
        ErrorCategory.AUTH_FAILED
      );
    }

    const cliPath = this._cliPath;
    if (!cliPath) {
      throw this.createError(
        'Claude Code: CLI non trouvé',
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
    }

    // Convertir les messages en prompt
    // Claude CLI en mode prompt attend du texte brut
    const systemMessages = messages.filter(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    
    const systemPrompt = systemMessages.length > 0 
      ? systemMessages.map(m => m.content).join('\n\n')
      : '';
    
    const conversation = userMessages.map(m => 
      `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`
    ).join('\n\n');
    
    const fullPrompt = systemPrompt 
      ? `SYSTEM: ${systemPrompt}\n\n${conversation}`
      : conversation;
    
    // Ajouter le prompt utilisateur
    const prompt = `${fullPrompt}\n\nHuman:`;
    
    // Construire les arguments
    const args = [
      '-p', // Mode prompt
      '--output-format', 'text',
      '--verbose', '0',
      '--no-session-persistence',
      '--restricted',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
    ];
    
    // Ajouter le modèle si spécifié
    if (requestedModel) {
      args.push('--model', requestedModel);
    }
    
    // Ajouter max tokens
    args.push('--max-tokens', String(maxTokens));
    
    // Ajouter température
    args.push('--temperature', String(temperature));
    
    const plan = planSafeSpawn(cliPath);
    if (!plan) {
      throw this.createError(
        'SAFE_CLI_ENTRYPOINT_NOT_RESOLVED: impossible de résoudre un point d\'entrée sûr pour Claude Code CLI (shim .cmd non reconnu) — appel bloqué plutôt que d\'utiliser un shell avec des arguments dynamiques.',
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
    }

    try {
      return new Promise((resolve, reject) => {
        // Setup-token forwarded only via child-process env, never as an arg.
        const procEnv = { ...process.env };
        if (authMode === ClaudeAuthMode.SETUP_TOKEN) {
          procEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }

        const proc = spawn(plan.command, args, { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, env: procEnv, shell: false });

        let output = '';
        let errorOutput = '';
        let modelUsed = requestedModel || this.defaultModels[0];
        
        proc.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        proc.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
        
        proc.on('close', (code) => {
          if (code === 0) {
            // Extraire le texte de la réponse
            // Claude CLI peut retourner du JSON ou du texte
            let text = output.trim();
            
            // Essayer de parser comme JSON
            try {
              const json = JSON.parse(text);
              if (json.completion) {
                text = json.completion;
              } else if (json.content) {
                text = json.content;
              } else if (Array.isArray(json) && json[0]?.completion) {
                text = json[0].completion;
              }
            } catch {
              // Ignorer, utiliser le texte brut
            }
            
            // Nettoyer la réponse
            text = text
              .replace(/^Assistant:?\s*/i, '')
              .replace(/^Human:?\s*/i, '')
              .trim();
            
            if (!text) {
              reject(this.createError(
                'Claude Code: réponse vide',
                ErrorCategory.UNKNOWN
              ));
              return;
            }
            
            resolve({
              text,
              model: `claude-oauth/${modelUsed}`,
              authMode,
              usage: {
                input_tokens: 0, // Non disponible via CLI
                output_tokens: 0,
              },
            });
          } else {
            const errorMsg = errorOutput || output || 'Unknown error';
            let category = ErrorCategory.UNKNOWN;
            
            if (errorMsg.includes('quota') || errorMsg.includes('rate limit')) {
              category = ErrorCategory.RATE_LIMITED;
            } else if (errorMsg.includes('auth') || errorMsg.includes('login') || errorMsg.includes('token')) {
              category = ErrorCategory.AUTH_FAILED;
            } else if (errorMsg.includes('timeout')) {
              category = ErrorCategory.TIMEOUT;
            } else if (errorMsg.includes('model not found') || errorMsg.includes('unknown model')) {
              category = ErrorCategory.MODEL_UNAVAILABLE;
            }
            
            const err = this.createError(
              `Claude Code: ${errorMsg}`,
              category
            );
            
            if (category === ErrorCategory.RATE_LIMITED) {
              err.isQuota = true;
            }
            
            reject(err);
          }
        });
        
        proc.on('error', (err) => {
          if (err.name === 'AbortError' || err.killed) {
            reject(this.createError(
              `Claude Code: timeout après ${TIMEOUT_MS}ms`,
              ErrorCategory.TIMEOUT
            ));
          } else {
            reject(this.createError(
              `Claude Code: ${err.message}`,
              ErrorCategory.PROVIDER_UNAVAILABLE
            ));
          }
        });
        
        // Envoyer le prompt
        proc.stdin.write(prompt);
        proc.stdin.end();
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw this.createError(
          `Claude Code: timeout après ${TIMEOUT_MS}ms`,
          ErrorCategory.TIMEOUT
        );
      }
      throw this.createError(
        `Claude Code: ${error.message}`,
        error.category || ErrorCategory.PROVIDER_UNAVAILABLE
      );
    }
  }

  /**
   * Génère avec streaming (si supporté)
   * @param {Object} request - Requête de génération
   * @param {Function} onChunk - Callback pour chaque chunk
   * @returns {Promise<{model: string, usage?: {input_tokens: number, output_tokens: number}}|null>}
   */
  async generateStream(request, onChunk) {
    // Le streaming avec Claude CLI est complexe (format SSE personnalisé)
    // Pour l'instant, on retourne null pour utiliser le fallback non-streaming
    return null;
  }

  /**
   * Récupère le statut de santé
   * @returns {Promise<HealthStatus>}
   */
  async getHealth() {
    const installed = await this.isCliInstalled();
    if (!installed) {
      return {
        status: 'unavailable',
        authMode: ClaudeAuthMode.NONE,
        error: 'Claude Code CLI non installé',
      };
    }

    const authMode = await this.getAuthMode();
    if (authMode === ClaudeAuthMode.NONE) {
      return {
        status: 'auth_required',
        authMode,
        error: 'Non authentifié - exécutez `claude auth login` ou configurez CLAUDE_CODE_OAUTH_TOKEN',
      };
    }

    // Tester la connexion
    const result = await this.testConnection();
    if (result.ok) {
      return {
        status: 'connected',
        authMode,
        error: null,
      };
    }

    return {
      status: 'unavailable',
      authMode,
      error: result.error,
    };
  }
}

// Instance par défaut
export const claudeOAuthProvider = new ClaudeOAuthProvider();

// Test de clé (compatible avec l'ancienne API)
export async function testKey() {
  const provider = claudeOAuthProvider;
  const result = await provider.testConnection();
  if (!result.ok) {
    const err = claudeOAuthProvider.createError(result.error || 'Claude Code connection failed', ErrorCategory.AUTH_FAILED);
    err.authMode = result.authMode;
    throw err;
  }
  return { ok: true, model: result.model, authMode: result.authMode };
}

// Completion (compatible avec l'ancienne API du router)
export async function complete({ model, messages, maxTokens }) {
  return claudeOAuthProvider.generate({ model, messages, maxTokens });
}

// Note: Ce module nécessite le CLI Claude Code installé
// Installation: npm install -g @anthropic-ai/claude-code
// Authentification (deux modes, setup-token prioritaire si présent):
//   Mode A — setup-token : `claude setup-token` puis exporter
//            CLAUDE_CODE_OAUTH_TOKEN dans l'environnement du serveur.
//   Mode B — session CLI : `claude auth login`.
