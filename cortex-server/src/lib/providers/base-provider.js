// Base Provider Interface
// Abstraction unifiée pour tous les providers IA
// Chaque provider doit implémenter cette interface

import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError } from '../provider-errors.js';

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} [vision=false] - Supporte les images/vidéo
 * @property {boolean} [tools=false] - Supporte les outils/functions calling
 * @property {boolean} [embeddings=false] - Supporte les embeddings
 * @property {boolean} [streaming=false] - Supporte le streaming
 * @property {boolean} [chat=false] - Supporte le chat conversational
 * @property {boolean} [completions=false] - Supporte les complétions
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} id - Identifiant unique du provider
 * @property {string} label - Nom affiché
 * @property {'local'|'cloud'} type - Type de provider
 * @property {'none'|'api-key'|'oauth-token'|'session'} authType - Méthode d'authentification
 * @property {number} [priority=0] - Priorité dans le routage (plus élevé = plus prioritaire)
 * @property {number} [timeout=90000] - Timeout par défaut en ms
 * @property {boolean} [isLocal=false] - Provider local
 * @property {boolean} [isConfigured=false] - Provider configuré
 * @property {string[]} [defaultModels=[]] - Modèles par défaut
 * @property {ProviderCapabilities} [capabilities={}] - Capacités du provider
 * @property {'low'|'medium'|'high'} [estimatedCostClass='medium'] - Classe de coût estimé
 * @property {boolean} [fallbackCompatible=true] - Compatible avec le fallback automatique
 * @property {string} [endpoint] - Endpoint configurable
 */

/**
 * @typedef {Object} HealthStatus
 * @property {'connected'|'degraded'|'unavailable'|'not_configured'|'rate_limited'|'auth_error'} status
 * @property {string} [error=null] - Message d'erreur
 * @property {number} [retryAfterMs=0] - Temps avant retry
 */

/**
 * @typedef {Object} ModelInfo
 * @property {string} id - Identifiant du modèle
 * @property {string} displayName - Nom affiché
 * @property {number} [contextLength=0] - Longueur de contexte max
 * @property {boolean} [vision=false] - Supporte la vision
 * @property {boolean} [tools=false] - Supporte les outils
 * @property {boolean} [local=false] - Modèle local
 */

/**
 * @typedef {Object} ProviderStats
 * @property {number} totalRequests - Nombre total de requêtes
 * @property {number} successCount - Nombre de succès
 * @property {number} errorCount - Nombre d'erreurs
 * @property {number} quotaHits - Nombre de hits de quota
 * @property {number} avgLatencyMs - Latence moyenne
 */

/**
 * Classe de base pour tous les providers IA
 * Chaque provider concret doit étendre cette classe
 */
export class BaseProvider {
  /**
   * @param {ProviderConfig} config
   */
  constructor(config) {
    this.config = {
      id: config.id,
      label: config.label,
      type: config.type || 'cloud',
      authType: config.authType || 'api-key',
      priority: config.priority || 0,
      timeout: config.timeout || 90_000,
      isLocal: config.isLocal || false,
      defaultModels: config.defaultModels || [],
      capabilities: config.capabilities || {},
      estimatedCostClass: config.estimatedCostClass || 'medium',
      fallbackCompatible: config.fallbackCompatible !== false,
      endpoint: config.endpoint || null,
    };
    this._healthCache = null;
    this._healthCacheTime = 0;
    this._healthCacheTTL = 30000; // 30 secondes
  }

  /**
   * ID du provider
   * @returns {string}
   */
  get id() {
    return this.config.id;
  }

  /**
   * Label du provider
   * @returns {string}
   */
  get label() {
    return this.config.label;
  }

  /**
   * Type du provider
   * @returns {'local'|'cloud'}
   */
  get type() {
    return this.config.type;
  }

  /**
   * Type d'authentification
   * @returns {'none'|'api-key'|'oauth-token'|'session'}
   */
  get authType() {
    return this.config.authType;
  }

  /**
   * Priorité du provider
   * @returns {number}
   */
  get priority() {
    return this.config.priority;
  }

  /**
   * Timeout par défaut
   * @returns {number}
   */
  get timeout() {
    return this.config.timeout;
  }

  /**
   * Est-ce un provider local
   * @returns {boolean}
   */
  get isLocal() {
    return this.config.isLocal;
  }

  /**
   * Modèles par défaut
   * @returns {string[]}
   */
  get defaultModels() {
    return this.config.defaultModels;
  }

  /**
   * Capacités du provider
   * @returns {ProviderCapabilities}
   */
  get capabilities() {
    return this.config.capabilities;
  }

  /**
   * Classe de coût estimé
   * @returns {'low'|'medium'|'high'}
   */
  get estimatedCostClass() {
    return this.config.estimatedCostClass;
  }

  /**
   * Compatible avec le fallback automatique
   * @returns {boolean}
   */
  get fallbackCompatible() {
    return this.config.fallbackCompatible;
  }

  /**
   * Endpoint configurable
   * @returns {string|null}
   */
  get endpoint() {
    return this.config.endpoint;
  }

  /**
   * Vérifie si le provider est configuré
   * Doit être implémenté par chaque provider
   * @param {Object} [options] - Options supplémentaires
   * @param {string} [options.apiKey] - Clé API à vérifier
   * @param {string} [options.token] - Token OAuth à vérifier
   * @returns {Promise<boolean>}
   */
  async isConfigured(options = {}) {
    throw new Error(`${this.id}: isConfigured() must be implemented`);
  }

  /**
   * Teste la connexion au provider
   * Doit être implémenté par chaque provider
   * @param {Object} [options] - Options supplémentaires
   * @param {string} [options.apiKey] - Clé API à tester
   * @param {string} [options.token] - Token OAuth à tester
   * @returns {Promise<{ok: boolean, model?: string, error?: string}>}
   */
  async testConnection(options = {}) {
    throw new Error(`${this.id}: testConnection() must be implemented`);
  }

  /**
   * Récupère la liste des modèles disponibles
   * Doit être implémenté par chaque provider
   * @param {Object} [options] - Options supplémentaires
   * @returns {Promise<ModelInfo[]>}
   */
  async listModels(options = {}) {
    throw new Error(`${this.id}: listModels() must be implemented`);
  }

  /**
   * Génère une réponse
   * Doit être implémenté par chaque provider
   * @param {Object} request - Requête de génération
   * @param {string[]} request.messages - Messages de la conversation
   * @param {string} [request.model] - Modèle à utiliser
   * @param {number} [request.maxTokens] - Nombre max de tokens
   * @param {number} [request.temperature] - Température
   * @param {Object} [request.options] - Options supplémentaires
   * @returns {Promise<{text: string, model: string, usage?: {input_tokens: number, output_tokens: number}}>}
   */
  async generate(request) {
    throw new Error(`${this.id}: generate() must be implemented`);
  }

  /**
   * Génère avec streaming
   * Optionnel - peut retourner null si non supporté
   * @param {Object} request - Requête de génération
   * @param {Function} onChunk - Callback pour chaque chunk
   * @returns {Promise<{model: string, usage?: {input_tokens: number, output_tokens: number}}|null>}
   */
  async generateStream(request, onChunk) {
    return null; // Non supporté par défaut
  }

  /**
   * Génère des embeddings
   * Optionnel - peut retourner null si non supporté
   * @param {Object} request - Requête d'embeddings
   * @param {string} request.text - Texte à embedder
   * @param {string} [request.model] - Modèle à utiliser
   * @returns {Promise<number[]|null>}
   */
  async embed(request) {
    return null; // Non supporté par défaut
  }

  /**
   * Récupère le statut de santé du provider
   * @param {Object} [options] - Options supplémentaires
   * @returns {Promise<HealthStatus>}
   */
  async getHealth(options = {}) {
    // Utiliser le cache
    const now = Date.now();
    if (this._healthCache && now - this._healthCacheTime < this._healthCacheTTL) {
      return this._healthCache;
    }

    try {
      const configured = await this.isConfigured(options);
      if (!configured) {
        this._healthCache = {
          status: 'not_configured',
          error: 'Provider not configured',
        };
        this._healthCacheTime = now;
        return this._healthCache;
      }

      const result = await this.testConnection(options);
      if (result.ok) {
        this._healthCache = {
          status: 'connected',
          error: null,
        };
      } else {
        this._healthCache = {
          status: 'unavailable',
          error: result.error || 'Connection failed',
        };
      }
      this._healthCacheTime = now;
      return this._healthCache;
    } catch (error) {
      this._healthCache = {
        status: 'unavailable',
        error: error.message,
      };
      this._healthCacheTime = now;
      return this._healthCache;
    }
  }

  /**
   * Invalide le cache de santé
   */
  invalidateHealthCache() {
    this._healthCache = null;
    this._healthCacheTime = 0;
  }

  /**
   * Crée une erreur classée pour ce provider
   * @param {string} message - Message d'erreur
   * @param {string} category - Catégorie d'erreur
   * @returns {Error}
   */
  createError(message, category) {
    const err = classifiedError(message, category);
    err.provider = this.id;
    return err;
  }

  /**
   * Classifie une erreur HTTP
   * @param {number} status - Code HTTP
   * @param {Object} body - Corps de la réponse
   * @returns {string}
   */
  classifyHttpError(status, body) {
    return classifyHttpError(status, body);
  }

  /**
   * Classifie une erreur réseau
   * @param {Error} error - Erreur réseau
   * @returns {string}
   */
  classifyNetworkError(error) {
    return classifyNetworkError(error);
  }

  /**
   * Vérifie si une erreur est de type quota/rate limit
   * @param {Error} error - Erreur à vérifier
   * @returns {boolean}
   */
  isQuotaError(error) {
    return error.category === ErrorCategory.QUOTA_EXCEEDED ||
           error.category === ErrorCategory.RATE_LIMITED ||
           error.isQuota === true;
  }

  /**
   * Vérifie si une erreur est d'authentification
   * @param {Error} error - Erreur à vérifier
   * @returns {boolean}
   */
  isAuthError(error) {
    return error.category === ErrorCategory.AUTH_FAILED;
  }
}

/**
 * Factory pour créer des instances de providers
 * Centralise la création et la configuration
 */
export class ProviderFactory {
  constructor() {
    this._instances = new Map();
  }

  /**
   * Enregistre un provider
   * @param {string} id - ID du provider
   * @param {Object} provider - Instance du provider
   */
  register(id, provider) {
    this._instances.set(id, provider);
  }

  /**
   * Récupère un provider
   * @param {string} id - ID du provider
   * @returns {BaseProvider|null}
   */
  get(id) {
    return this._instances.get(id) || null;
  }

  /**
   * Récupère tous les providers
   * @returns {Map<string, BaseProvider>}
   */
  getAll() {
    return this._instances;
  }

  /**
   * Liste des IDs de tous les providers
   * @returns {string[]}
   */
  getIds() {
    return Array.from(this._instances.keys());
  }

  /**
   * Filtre les providers par type
   * @param {'local'|'cloud'|null} type - Type de provider (null = tous)
   * @returns {BaseProvider[]}
   */
  getByType(type) {
    if (!type) return Array.from(this._instances.values());
    return Array.from(this._instances.values())
      .filter(p => p.type === type);
  }

  /**
   * Filtre les providers configurés
   * @returns {BaseProvider[]}
   */
  async getConfigured() {
    const providers = Array.from(this._instances.values());
    const results = await Promise.all(
      providers.map(async p => ({ provider: p, configured: await p.isConfigured() }))
    );
    return results.filter(r => r.configured).map(r => r.provider);
  }

  /**
   * Filtre les providers disponibles (configurés + connexion OK)
   * @returns {BaseProvider[]}
   */
  async getAvailable() {
    const providers = Array.from(this._instances.values());
    const results = await Promise.all(
      providers.map(async p => {
        const configured = await p.isConfigured();
        if (!configured) return null;
        const health = await p.getHealth();
        if (health.status !== 'connected') return null;
        return p;
      })
    );
    return results.filter(Boolean);
  }
}

// Singleton de la factory
export const providerFactory = new ProviderFactory();
