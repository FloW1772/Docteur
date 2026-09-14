// Codex Provider
// Utilise le CLI Codex officiel d'OpenAI
// Authentification gérée par `codex login`

import { execFile, execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BaseProvider } from './base-provider.js';
import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError, parseRetryAfterMs } from '../provider-errors.js';

const CODEX_CLI_EXECUTABLE = 'codex';
const TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 10_000;

// Anti-egress guard: DOCTEUR_TEST_MODE is set by test-setup.mjs (imported
// first by every test-*.mjs). It must never be possible for a standard test
// run to spawn the real Codex CLI and hit the user's subscription — only an
// explicit DOCTEUR_LIVE_TESTS=1 opt-in bypasses this.
function assertLiveCallAllowed() {
  if (process.env.DOCTEUR_TEST_MODE === '1' && process.env.DOCTEUR_LIVE_TESTS !== '1') {
    throw new Error('EXTERNAL_CALL_BLOCKED_IN_TEST: codex CLI generate()/testConnection() blocked — set DOCTEUR_LIVE_TESTS=1 to run a real live smoke test.');
  }
}

// On Windows, npm installs a CLI as a `.cmd` batch shim (e.g.
// `codex.cmd`) that ultimately runs `node <real-entry.js> %*`. spawn/execFile
// with shell:false cannot execute a `.cmd` file directly (Windows requires
// cmd.exe to interpret it) — but shell:true re-introduces shell metacharacter
// interpretation for any dynamic argument (e.g. requestedModel) passed
// through argv. So: a non-`.cmd` path (a real .exe/binary resolved from PATH
// or a common install location) never needed a shell in the first place —
// spawn it directly with shell:false. A `.cmd` path needs its shim parsed to
// find the real `node_modules/@openai/codex/bin/codex.js` it points to, so we
// can spawn `process.execPath` (node.exe) with that script as the first arg,
// bypassing cmd.exe entirely. Returns a spawn plan tagged 'direct' (no shell
// ever needed), 'resolved' (shim parsed, shell bypassed), or null only when
// the path IS a .cmd shim that could not be parsed — a case the caller must
// treat as SAFE_CLI_ENTRYPOINT_NOT_RESOLVED rather than silently falling back
// to shell:true (see callers below).
export function planSafeSpawn(cliPath) {
  if (!cliPath.toLowerCase().endsWith('.cmd')) {
    return { mode: 'direct', command: cliPath, prefixArgs: [] };
  }
  try {
    const shim = fs.readFileSync(cliPath, 'utf8');
    // Matches: "%dp0%\node_modules\@openai\codex\bin\codex.js" or similar,
    // resolved relative to the shim's own directory.
    const match = shim.match(/"%dp0%\\(node_modules\\[^"]+\.js)"/i);
    if (!match) return null;
    const entryPath = path.join(path.dirname(cliPath), match[1]);
    if (!fs.existsSync(entryPath)) return null;
    return { mode: 'resolved', command: process.execPath, prefixArgs: [entryPath] };
  } catch {
    return null;
  }
}

// Back-compat alias kept for the existing test suite (test-cli-shell-resolution.mjs)
// asserting the .cmd-shim-parsing behavior specifically; only ever returns a
// plan for the 'resolved' (shim-parsed) case, never 'direct'.
export function resolveNodeEntrypoint(cliPath) {
  if (!cliPath.toLowerCase().endsWith('.cmd')) return null;
  const plan = planSafeSpawn(cliPath);
  return plan && plan.mode === 'resolved' ? { command: plan.command, prefixArgs: plan.prefixArgs } : null;
}

/**
 * Provider Codex
 * 
 * Ce provider utilise le client officiel Codex CLI qui gère lui-même
 * l'authentification OAuth.
 * 
 * Caractéristiques:
 * - Utilise `codex` CLI installé sur la machine
 * - Nécessite une authentification via `codex login`
 * - Utilise le token géré par le CLI (pas besoin de le récupérer)
 * - Ne stocke JAMAIS le token dans les settings Docteur
 * - Supporte l'exécution de code dans un environnement sandbox
 * 
 * Limites:
 * - Pas de streaming natif via CLI (à implémenter)
 * - Les outils avancés sont désactivés par défaut
 */
export class CodexProvider extends BaseProvider {
  constructor(config = {}) {
    super({
      id: 'codex',
      label: 'Codex (OpenAI)',
      type: 'cloud',
      authType: 'oauth-token',
      priority: 5, // Haute priorité (payant)
      timeout: config.timeout || TIMEOUT_MS,
      isLocal: false,
      // Codex CLI resolves the actual model from CODEX_HOME/config.toml when
      // no --model is passed; ChatGPT-subscription auth only accepts the
      // model(s) provisioned for that account (verified: 'gpt-4o' etc. are
      // rejected with "not supported when using Codex with a ChatGPT
      // account"), so we don't force a model unless the caller asks for one.
      defaultModels: ['gpt-6-astra'],
      capabilities: {
        vision: false, // Codex CLI a des limitations en vision
        tools: true,
        embeddings: false,
        streaming: false, // À implémenter
        chat: true,
        completions: true,
        code_execution: true, // Capacité principale
      },
      estimatedCostClass: 'high', // Payant
      fallbackCompatible: true,
    });
    
    this._cliPath = null;
    this._isAvailable = null;
    this._isAuthenticated = null;
  }

  /**
   * Trouve le chemin du CLI Codex
   * @returns {string|null}
   */
  findCliPath() {
    // Essayer d'abord dans le PATH
    try {
      // Sous Windows, essayer avec .cmd et .exe
      const extensions = ['.cmd', '.exe', ''];
      for (const ext of extensions) {
        try {
          const result = execFileSync(CODEX_CLI_EXECUTABLE + ext, ['--version'], {
            timeout: PROBE_TIMEOUT_MS,
            encoding: 'utf8',
          });
          return CODEX_CLI_EXECUTABLE + ext;
        } catch {
          // Essayer avec npm global
          const npmPath = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd');
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
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      path.join(process.env.ProgramFiles || 'C:\Program Files', 'OpenAI', 'codex.exe'),
      // Chemin npm global
      path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
      path.join(os.homedir(), '.npm-global', 'bin', 'codex.cmd'),
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
   * Vérifie si le CLI Codex est installé
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
            // Vérifier que c'est bien Codex
            const output = stdout || stderr || '';
            if (/codex|Codex|OpenAI/i.test(output)) {
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
   * Vérifie si l'utilisateur est authentifié avec Codex
   * @returns {Promise<boolean>}
   */
  async isAuthenticated() {
    if (this._isAuthenticated !== null) return this._isAuthenticated;
    
    try {
      const installed = await this.isCliInstalled();
      if (!installed) {
        this._isAuthenticated = false;
        return false;
      }
      
      await new Promise((resolve, reject) => {
        execFile(this._cliPath, ['login', 'status'], { timeout: PROBE_TIMEOUT_MS, shell: true }, (error, stdout, stderr) => {
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
            this._isAuthenticated = output.includes('logged') || 
                                 output.includes('authenticated') || 
                                 output.includes('connected') ||
                                 output.includes('active');
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
   * Vérifie si le provider est configuré
   * @returns {Promise<boolean>}
   */
  async isConfigured() {
    return this.isAuthenticated();
  }

  /**
   * Teste la connexion à Codex
   * @returns {Promise<{ok: boolean, model?: string, error?: string}>}
   */
  async testConnection() {
    assertLiveCallAllowed();
    try {
      const authenticated = await this.isAuthenticated();
      if (!authenticated) {
        return {
          ok: false,
          error: 'Codex: non authentifié. Exécutez `codex login` dans votre terminal.',
        };
      }
      
      // Tester avec une requête simple
      const cliPath = this._cliPath;
      const prompt = 'Réponds juste "OK".';
      
      return new Promise((resolve) => {
        const args = [
          '--disable', 'shell_tool',
          'exec',
          '--ignore-user-config',
          '--ephemeral',
          '--skip-git-repo-check',
          '--json',
          '--color', 'never',
          '-s', 'read-only',
          '-C', os.tmpdir(),
          '-c', 'approval_policy="never"',
        ];

        const plan = planSafeSpawn(cliPath);
        if (!plan) {
          resolve({ ok: false, error: 'SAFE_CLI_ENTRYPOINT_NOT_RESOLVED: impossible de résoudre un point d\'entrée sûr pour Codex CLI (shim .cmd non reconnu) — appel bloqué plutôt que d\'utiliser un shell.' });
          return;
        }
        const proc = spawn(plan.command, [...plan.prefixArgs, ...args], { timeout: TIMEOUT_MS, cwd: os.tmpdir(), shell: false });
        
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
            resolve({ ok: true, model: this.defaultModels[0], authMode: 'cli_session' });
          } else {
            resolve({
              ok: false,
              authMode: 'cli_session',
              error: `Codex: erreur (code ${code}) - ${errorOutput || 'Unknown error'}`,
            });
          }
        });

        proc.on('error', (err) => {
          resolve({
            ok: false,
            authMode: 'cli_session',
            error: `Codex: ${err.message}`,
          });
        });

        // Envoyer le prompt sur stdin
        proc.stdin.write(prompt);
        proc.stdin.end();
      });
    } catch (error) {
      return {
        ok: false,
        error: `Codex: ${error.message}`,
      };
    }
  }

  /**
   * Récupère les modèles disponibles depuis Codex
   * Note: Codex CLI ne fournit pas de liste de modèles complète via CLI
   * On retourne les modèles par défaut
   * @returns {Promise<ModelInfo[]>}
   */
  async listModels() {
    const authenticated = await this.isAuthenticated();
    if (!authenticated) {
      return [];
    }
    
    // Retourner les modèles par défaut
    return this.defaultModels.map(modelId => ({
      id: modelId,
      displayName: modelId,
      contextLength: modelId.includes('o1') ? 1000000 : modelId.includes('gpt-4') ? 128000 : 128000,
      vision: modelId.includes('o1') || modelId.includes('gpt-4o'),
      tools: true,
      local: false,
      provider: 'codex',
    }));
  }

  /**
   * Génère une réponse avec Codex CLI
   * @param {Object} request - Requête de génération
   * @param {Array<{role: string, content: string}>} request.messages - Messages
   * @param {string} [request.model] - Modèle à utiliser (omis = défaut de config.toml ; le
   *   compte ChatGPT n'accepte que le modèle qui lui est provisionné)
   * @returns {Promise<{text: string, model: string, usage?: {input_tokens: number, output_tokens: number}}>}
   * Note: codex-cli 0.154.0 `exec` n'expose pas de contrôle maxTokens/temperature.
   */
  async generate(request) {
    assertLiveCallAllowed();
    const { messages, model: requestedModel } = request;
    if (requestedModel && !/^[A-Za-z0-9_.\-/]{1,128}$/.test(requestedModel)) {
      throw this.createError(
        'Codex: nom de modèle invalide (caractères non autorisés)',
        ErrorCategory.MODEL_UNAVAILABLE
      );
    }

    const authenticated = await this.isAuthenticated();
    if (!authenticated) {
      throw this.createError(
        'Codex: non authentifié. Exécutez `codex login` dans votre terminal.',
        ErrorCategory.AUTH_FAILED
      );
    }
    
    const cliPath = this._cliPath;
    if (!cliPath) {
      throw this.createError(
        'Codex: CLI non trouvé',
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
    }
    
    // Convertir les messages en prompt pour Codex
    // Codex exec attend du texte brut sur stdin
    const systemMessages = messages.filter(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    
    const systemPrompt = systemMessages.length > 0 
      ? systemMessages.map(m => m.content).join('\n\n')
      : '';
    
    const conversation = userMessages.map(m => 
      `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
    ).join('\n\n');
    
    const fullPrompt = systemPrompt 
      ? `Instructions: ${systemPrompt}\n\n${conversation}`
      : conversation;
    
    // Ajouter le prompt utilisateur
    const prompt = `${fullPrompt}\n\nUser:`;
    
    // Construire les arguments pour Codex exec — flags vérifiés contre
    // `codex exec --help` (codex-cli 0.154.0). Cette CLI n'expose ni
    // --max-tokens ni --temperature (pas de contrôle d'échantillonnage côté
    // client), et `--profile` charge un fichier de config nommé qui n'existe
    // pas ici — ces trois options ont donc été retirées plutôt que devinées.
    const args = [
      '--disable', 'shell_tool', // seule feature confirmée valide pour bloquer l'exécution shell
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--color', 'never',
      '-s', 'read-only', // sandbox restrictif : lecture seule, pas d'écriture ni de commandes
      '-C', os.tmpdir(),
      '-c', 'approval_policy="never"',
    ];

    // Ajouter le modèle si spécifié (le compte ChatGPT n'accepte que le
    // modèle provisionné pour l'abonnement — voir defaultModels ci-dessus ;
    // omettre --model laisse le CLI utiliser le défaut de config.toml)
    if (requestedModel) {
      args.push('--model', requestedModel);
    }

    const plan = planSafeSpawn(cliPath);
    if (!plan) {
      throw this.createError(
        'SAFE_CLI_ENTRYPOINT_NOT_RESOLVED: impossible de résoudre un point d\'entrée sûr pour Codex CLI (shim .cmd non reconnu) — appel bloqué plutôt que d\'utiliser un shell avec des arguments dynamiques.',
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
    }

    try {
      return new Promise((resolve, reject) => {
        const proc = spawn(plan.command, [...plan.prefixArgs, ...args], { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, cwd: os.tmpdir(), shell: false });
        
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
            // Parser la réponse JSON de Codex
            let text = '';
            
            try {
              // Codex retourne du JSON avec les résultats
              const lines = output.split('\n').filter(l => l.trim());
              for (const line of lines) {
                try {
                  const json = JSON.parse(line);
                  if (json.type === 'result' && json.result) {
                    text += json.result;
                  } else if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
                    text += json.item.text;
                  } else if (json.completion) {
                    text += json.completion;
                  } else if (json.content) {
                    text += json.content;
                  }
                } catch {
                  // Ignorer les lignes non-JSON
                }
              }
            } catch {
              // Si pas de JSON, utiliser le texte brut
              text = output;
            }
            
            text = text.trim();
            
            if (!text) {
              reject(this.createError(
                'Codex: réponse vide',
                ErrorCategory.UNKNOWN
              ));
              return;
            }
            
            resolve({
              text,
              model: `codex/${modelUsed}`,
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
              `Codex: ${errorMsg}`,
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
              `Codex: timeout après ${TIMEOUT_MS}ms`,
              ErrorCategory.TIMEOUT
            ));
          } else {
            reject(this.createError(
              `Codex: ${err.message}`,
              ErrorCategory.PROVIDER_UNAVAILABLE
            ));
          }
        });
        
        // Envoyer le prompt sur stdin
        proc.stdin.write(prompt);
        proc.stdin.end();
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw this.createError(
          `Codex: timeout après ${TIMEOUT_MS}ms`,
          ErrorCategory.TIMEOUT
        );
      }
      throw this.createError(
        `Codex: ${error.message}`,
        error.category || ErrorCategory.PROVIDER_UNAVAILABLE
      );
    }
  }

  /**
   * Génère avec streaming
   * @param {Object} request - Requête de génération
   * @param {Function} onChunk - Callback pour chaque chunk
   * @returns {Promise<{model: string, usage?: {input_tokens: number, output_tokens: number}}|null>}
   */
  async generateStream(request, onChunk) {
    // Le streaming avec Codex CLI est complexe
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
        error: 'Codex CLI non installé',
      };
    }
    
    const authenticated = await this.isAuthenticated();
    if (!authenticated) {
      return {
        status: 'auth_required',
        error: 'Non authentifié - exécutez `codex login`',
      };
    }
    
    // Tester la connexion
    const result = await this.testConnection();
    if (result.ok) {
      return {
        status: 'connected',
        error: null,
      };
    }
    
    return {
      status: 'unavailable',
      error: result.error,
    };
  }
}

// Instance par défaut
export const codexProvider = new CodexProvider();

// Test de clé (compatible avec l'ancienne API)
export async function testKey() {
  const provider = codexProvider;
  const result = await provider.testConnection();
  if (!result.ok) {
    const err = codexProvider.createError(result.error || 'Codex connection failed', ErrorCategory.AUTH_FAILED);
    err.authMode = result.authMode ?? 'none';
    throw err;
  }
  return { ok: true, model: result.model, authMode: result.authMode ?? 'cli_session' };
}

// Completion (compatible avec l'ancienne API du router)
export async function complete({ model, messages, maxTokens }) {
  return codexProvider.generate({ model, messages, maxTokens });
}

// Note: Ce module nécessite le CLI Codex installé
// Installation: npm install -g @openai/codex
// Authentification: codex login
