// NVIDIA PAIR (Pipeline for AI Research) provider
// PAIR est un service local de NVIDIA pour l'inférence distribuée
// Docs: https://developer.nvidia.com/pair

import fetch from 'node-fetch';
import { BaseProvider } from './base-provider.js';
import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError, parseRetryAfterMs } from '../provider-errors.js';

const PAIR_DEFAULT_ENDPOINT = 'http://localhost:8080';
const TIMEOUT_MS = 60_000;

// Resolution order for the endpoint actually used by the router singleton:
// 1. user setting persisted in sqlite (meta key 'pair_endpoint')
// 2. PAIR_ENDPOINT environment variable
// 3. PAIR_DEFAULT_ENDPOINT
function resolveInitialEndpoint(config) {
  if (config.endpoint) return config.endpoint;
  if (process.env.PAIR_ENDPOINT) return process.env.PAIR_ENDPOINT;
  return PAIR_DEFAULT_ENDPOINT;
}

/**
 * Provider NVIDIA PAIR
 * - Local inference service par NVIDIA
 * - Peut être utilisé comme alternative à Ollama
 * - Fallback automatique vers Ollama si indisponible
 */
export class PAIRProvider extends BaseProvider {
  constructor(config = {}) {
    super({
      id: 'pair',
      label: 'NVIDIA PAIR',
      type: 'local',
      authType: 'none',
      priority: 1, // Haute priorité pour le local
      timeout: config.timeout || TIMEOUT_MS,
      isLocal: true,
      defaultModels: [], // Modèles détectés dynamiquement
      capabilities: {
        vision: true, // PAIR supporte les modèles multimodaux
        tools: false,
        embeddings: true,
        streaming: true,
        chat: true,
        completions: true,
      },
      estimatedCostClass: 'low', // Local = coût nul
      fallbackCompatible: true,
      endpoint: resolveInitialEndpoint(config),
    });
    this._endpoint = resolveInitialEndpoint(config);
    this._modelsCache = null;
    this._modelsCacheTime = 0;
    this._modelsCacheTTL = 300_000; // 5 minutes
  }

  /**
   * Endpoint PAIR
   * @returns {string}
   */
  get endpoint() {
    return this._endpoint;
  }

  /**
   * Configure l'endpoint
   * @param {string} endpoint - Nouvelle URL de l'endpoint
   */
  setEndpoint(endpoint) {
    if (!endpoint) {
      this._endpoint = PAIR_DEFAULT_ENDPOINT;
    } else {
      // Normaliser l'endpoint
      this._endpoint = String(endpoint).replace(/\/$/, '');
    }
    this._modelsCache = null; // Invalider le cache
  }

  /**
   * Vérifie si PAIR est configuré (toujours vrai, mais vérifie l'endpoint)
   * @returns {Promise<boolean>}
   */
  async isConfigured() {
    // PAIR n'a pas besoin de clé API, mais nécessite un endpoint valide
    return !!this._endpoint;
  }

  /**
   * Teste la connexion à PAIR
   * @param {Object} [options] - Options
   * @param {string} [options.endpoint] - Endpoint à tester
   * @returns {Promise<{ok: boolean, model?: string, error?: string}>}
   */
  async testConnection(options = {}) {
    const endpoint = options.endpoint || this._endpoint;
    
    try {
      const response = await fetch(`${endpoint}/v1/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const errorMsg = body?.error?.message || body?.error || response.statusText || 'Unknown error';
        return {
          ok: false,
          error: `PAIR: ${response.status} - ${errorMsg}`,
        };
      }

      const data = await response.json();
      const models = data?.data || [];
      
      if (models.length === 0) {
        return {
          ok: true,
          model: null,
          warning: 'PAIR: connecté mais aucun modèle disponible',
        };
      }

      return {
        ok: true,
        model: models[0]?.id || models[0]?.name,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          ok: false,
          error: `PAIR: timeout après ${TIMEOUT_MS}ms`,
        };
      }
      return {
        ok: false,
        error: `PAIR: ${error.message}`,
      };
    }
  }

  /**
   * Récupère les modèles disponibles depuis PAIR
   * @returns {Promise<ModelInfo[]>}
   */
  async listModels() {
    // Utiliser le cache
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCacheTime < this._modelsCacheTTL) {
      return this._modelsCache;
    }

    try {
      const response = await fetch(`${this._endpoint}/v1/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        throw this.createError(
          `PAIR models: ${response.status} - ${response.statusText}`,
          classifyHttpError(response.status, await response.json().catch(() => ({})))
        );
      }

      const data = await response.json();
      const models = data?.data || [];

      this._modelsCache = models.map(model => ({
        id: model.id || model.name,
        displayName: model.name || model.id,
        contextLength: model.context_length || model.max_tokens || 0,
        vision: model.capabilities?.includes('vision') || 
                model.capabilities?.includes('image') || false,
        tools: model.capabilities?.includes('tools') || 
               model.capabilities?.includes('functions') || false,
        local: true,
        provider: 'pair',
      }));
      
      this._modelsCacheTime = now;
      return this._modelsCache;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw this.createError(
          `PAIR models: timeout après ${TIMEOUT_MS}ms`,
          ErrorCategory.TIMEOUT
        );
      }
      throw this.createError(
        `PAIR models: ${error.message}`,
        error.category || ErrorCategory.NETWORK_ERROR
      );
    }
  }

  /**
   * Vérifie si un modèle est disponible
   * @param {string} modelName - Nom du modèle
   * @returns {Promise<boolean>}
   */
  async hasModel(modelName) {
    const models = await this.listModels().catch(() => []);
    return models.some(m => 
      m.id === modelName || 
      m.displayName === modelName ||
      m.id.includes(modelName)
    );
  }

  /**
   * Génère une réponse avec PAIR
   * @param {Object} request - Requête de génération
   * @param {Array<{role: string, content: string}>} request.messages - Messages
   * @param {string} [request.model] - Modèle à utiliser
   * @param {number} [request.maxTokens=4096] - Nombre max de tokens
   * @param {number} [request.temperature=0.7] - Température
   * @returns {Promise<{text: string, model: string, usage?: {input_tokens: number, output_tokens: number}}>}
   */
  async generate(request) {
    const { messages, model: requestedModel, maxTokens = 4096, temperature = 0.7 } = request;

    // Vérifier que PAIR est disponible
    const health = await this.getHealth();
    if (health.status !== 'connected') {
      throw this.createError(
        `PAIR: non disponible - ${health.error}`,
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
    }

    // Si un modèle spécifique est demandé, vérifier qu'il existe
    let modelToUse = requestedModel;
    if (modelToUse) {
      const hasModel = await this.hasModel(modelToUse);
      if (!hasModel) {
        throw this.createError(
          `PAIR: modèle "${modelToUse}" non trouvé`,
          ErrorCategory.MODEL_UNAVAILABLE
        );
      }
    } else {
      // Utiliser le premier modèle disponible
      const models = await this.listModels().catch(() => []);
      if (models.length === 0) {
        throw this.createError(
          'PAIR: aucun modèle disponible',
          ErrorCategory.MODEL_UNAVAILABLE
        );
      }
      modelToUse = models[0].id;
    }

    // Convertir les messages au format PAIR
    // PAIR utilise le format OpenAI-compatible
    const payload = {
      model: modelToUse,
      messages: messages.map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })),
      max_tokens: maxTokens,
      temperature,
    };

    try {
      const response = await fetch(`${this._endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const category = classifyHttpError(response.status, body);
        const err = this.createError(
          `PAIR: ${response.status} - ${body?.error?.message || response.statusText}`,
          category
        );
        
        if (category === ErrorCategory.RATE_LIMITED) {
          err.retryAfterMs = parseRetryAfterMs(response.headers, body);
        }
        
        if (category === ErrorCategory.QUOTA_EXCEEDED || category === ErrorCategory.RATE_LIMITED) {
          err.isQuota = true;
        }
        
        throw err;
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || '';

      if (!text) {
        throw this.createError(
          'PAIR: réponse vide',
          ErrorCategory.UNKNOWN
        );
      }

      return {
        text,
        model: `pair/${modelToUse}`,
        usage: {
          input_tokens: data.usage?.prompt_tokens ?? 0,
          output_tokens: data.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw this.createError(
          `PAIR: timeout après ${TIMEOUT_MS}ms`,
          ErrorCategory.TIMEOUT
        );
      }
      throw this.createError(
        `PAIR: ${error.message}`,
        error.category || ErrorCategory.NETWORK_ERROR
      );
    }
  }

  /**
   * Génère avec streaming (si supporté par PAIR)
   * @param {Object} request - Requête de génération
   * @param {Function} onChunk - Callback pour chaque chunk
   * @returns {Promise<{model: string, usage?: {input_tokens: number, output_tokens: number}}|null>}
   */
  async generateStream(request, onChunk) {
    const { messages, model: requestedModel, maxTokens = 4096, temperature = 0.7 } = request;

    // Vérifier que PAIR est disponible
    const health = await this.getHealth();
    if (health.status !== 'connected') {
      return null; // Fallback non-streaming
    }

    let modelToUse = requestedModel;
    if (!modelToUse) {
      const models = await this.listModels().catch(() => []);
      if (models.length === 0) return null;
      modelToUse = models[0].id;
    }

    const payload = {
      model: modelToUse,
      messages: messages.map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })),
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };

    try {
      const response = await fetch(`${this._endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw this.createError(
          `PAIR streaming: ${response.status} - ${body?.error?.message || response.statusText}`,
          classifyHttpError(response.status, body)
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let model = `pair/${modelToUse}`;
      let inputTokens = 0;
      let outputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // Parser les chunks (SSE ou JSONL)
        const lines = buffer.split('\n').filter(l => l.trim());
        buffer = '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') break;
            
            try {
              const chunk = JSON.parse(dataStr);
              if (chunk.choices?.[0]?.delta?.content) {
                onChunk(chunk.choices[0].delta.content, model);
              }
              if (chunk.usage) {
                inputTokens += chunk.usage.prompt_tokens || 0;
                outputTokens += chunk.usage.completion_tokens || 0;
              }
            } catch (e) {
              // Ignorer les chunks malformés
            }
          } else {
            // Essayer de parser comme JSON direct
            try {
              const chunk = JSON.parse(line);
              if (chunk.choices?.[0]?.delta?.content) {
                onChunk(chunk.choices[0].delta.content, model);
              }
            } catch (e) {
              // Ignorer
            }
          }
        }
      }

      return {
        model,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw this.createError(
          `PAIR streaming: timeout après ${TIMEOUT_MS}ms`,
          ErrorCategory.TIMEOUT
        );
      }
      throw this.createError(
        `PAIR streaming: ${error.message}`,
        error.category || ErrorCategory.NETWORK_ERROR
      );
    }
  }

  /**
   * Génère des embeddings avec PAIR
   * @param {Object} request - Requête d'embeddings
   * @param {string} request.text - Texte à embedder
   * @param {string} [request.model] - Modèle à utiliser
   * @returns {Promise<number[]|null>}
   */
  async embed(request) {
    const { text, model: requestedModel } = request;

    try {
      let modelToUse = requestedModel;
      if (!modelToUse) {
        // Trouver un modèle avec embeddings
        const models = await this.listModels().catch(() => []);
        const embedModel = models.find(m => m.id.includes('embed') || m.capabilities?.includes('embeddings'));
        if (!embedModel) return null;
        modelToUse = embedModel.id;
      }

      const payload = {
        model: modelToUse,
        input: text,
      };

      const response = await fetch(`${this._endpoint}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        throw this.createError(
          `PAIR embeddings: ${response.status}`,
          classifyHttpError(response.status, await response.json().catch(() => ({})))
        );
      }

      const data = await response.json();
      const embeddings = data?.data?.[0]?.embedding;

      if (!embeddings || !Array.isArray(embeddings)) {
        return null;
      }

      return embeddings;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw this.createError(
          `PAIR embeddings: timeout après ${TIMEOUT_MS}ms`,
          ErrorCategory.TIMEOUT
        );
      }
      return null; // Ne pas throw, embeddings est optionnel
    }
  }
}

// Instance par défaut
export const pairProvider = new PAIRProvider();

// Recharge l'endpoint du singleton depuis les settings persistés (sqlite),
// à appeler une fois au démarrage du serveur, après initSqlite(). Priorité :
// 1. réglage utilisateur sauvegardé  2. variable d'env PAIR_ENDPOINT
// 3. valeur par défaut (déjà appliquée par le constructeur).
// Log non sensible pour tracer la config effective au démarrage.
export function loadPairEndpointFromStorage(getMetaFn, logger) {
  try {
    const stored = getMetaFn('pair_endpoint', null);
    if (stored) {
      pairProvider.setEndpoint(stored);
    }
    logger?.info({ endpoint: pairProvider.endpoint }, 'PAIR_ENDPOINT_CONFIGURED');
  } catch (err) {
    logger?.warn({ error: err.message }, 'PAIR_ENDPOINT_LOAD_FAILED');
  }
}

// Fonction pour créer un provider PAIR avec endpoint personnalisé
export function createPAIRProvider(endpoint) {
  return new PAIRProvider({ endpoint });
}

// Test de clé (compatible avec l'ancienne API)
export async function testKey(apiKey, endpoint) {
  // PAIR n'a pas de clé API, on teste juste la connexion
  const provider = createPAIRProvider(endpoint);
  const result = await provider.testConnection();
  if (!result.ok) {
    throw pairProvider.createError(result.error || 'PAIR connection failed', ErrorCategory.PROVIDER_UNAVAILABLE);
  }
  return { ok: true, model: result.model };
}

// Completion (compatible avec l'ancienne API du router)
export async function complete({ apiKey, model, messages, maxTokens }) {
  const provider = pairProvider;
  if (model) {
    provider.setEndpoint(model); // Utiliser model comme endpoint si fourni
  }
  return provider.generate({ messages, model, maxTokens });
}
