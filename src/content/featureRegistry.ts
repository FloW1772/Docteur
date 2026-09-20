import { HELP_DIRECTORY, type FeatureKey } from './capabilities.ts';

export type FeatureStatus =
  | 'AVAILABLE'
  | 'PARTIAL'
  | 'EXPERIMENTAL'
  | 'NOT_AVAILABLE'
  | 'DRAFT'
  | 'UNVERIFIED';

export interface FeatureDefinition {
  id: string;
  name: string;
  category: string;
  shortDescription: string;
  purpose: string;
  howItWorks: string;
  inputs: string[];
  outputs: string[];
  security: string[];
  limitations: string[];
  prerequisites: string[];
  relatedFeatures: string[];
  status: FeatureStatus;
  available: boolean;
  verified: boolean;
  technicalReferences: string[];
  routes?: string[];
  sourceModules?: string[];
  sourceTests?: string[];
  introducedIn?: string;
  lastValidatedAt?: string;
  documentationVersion?: string;
  aliases?: string[];
}

function normalizeFeatureText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

export function isExplainableDefinition(definition: FeatureDefinition): boolean {
  return definition.status !== 'DRAFT' &&
    definition.status !== 'UNVERIFIED' &&
    definition.available === true &&
    definition.verified === true;
}

export function getRegisteredFeatures(): FeatureDefinition[] {
  return [...FEATURE_DEFINITIONS];
}

export function getExplainableFeatures(): FeatureDefinition[] {
  return FEATURE_DEFINITIONS.filter(isExplainableDefinition);
}

export function getFeatureDefinition(featureId: string): FeatureDefinition | null {
  return FEATURE_DEFINITION_BY_ID.get(featureId) ?? null;
}

export function getRelatedFeatures(featureId: string): FeatureDefinition[] {
  const definition = getFeatureDefinition(featureId);
  if (!definition) return [];
  const relatedIds = new Set<string>(definition.relatedFeatures ?? []);
  const localId = definition.id;
  const matchIds = new Set<string>();
  for (const candidate of FEATURE_DEFINITIONS) {
    if (candidate.id === localId) continue;
    if (relatedIds.has(candidate.id)) matchIds.add(candidate.id);
    if (definition.relatedFeatures?.some(ref => normalizeFeatureText(ref) === normalizeFeatureText(candidate.id))) {
      matchIds.add(candidate.id);
    }
  }
  return FEATURE_DEFINITIONS.filter(item => matchIds.has(item.id));
}

export function searchFeatures(query: string): FeatureDefinition[] {
  const q = normalizeFeatureText(query);
  if (!q) return [];
  const matches = new Map<string, number>();

  for (const definition of FEATURE_DEFINITIONS) {
    const haystacks = [
      definition.id,
      definition.name,
      definition.category,
      definition.shortDescription,
      definition.purpose,
      ...(definition.aliases ?? []),
      ...(definition.relatedFeatures ?? []),
    ].map(value => normalizeFeatureText(value));

    let score = 0;
    for (const haystack of haystacks) {
      if (!haystack) continue;
      if (haystack === q) score += 100;
      else if (haystack.includes(q)) score += 20;
      else if (q.includes(haystack)) score += 10;
    }

    if (score > 0) matches.set(definition.id, score);
  }

  return [...matches.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => getFeatureDefinition(id))
    .filter((item): item is FeatureDefinition => item !== null);
}

export function resolveFeatureAlias(value: string): string | null {
  const normalized = normalizeFeatureText(value);
  if (!normalized) return null;
  const direct = FEATURE_DEFINITION_BY_ID.get(normalized);
  if (direct) return direct.id;

  for (const definition of FEATURE_DEFINITIONS) {
    if (normalizeFeatureText(definition.id) === normalized) return definition.id;
    if (definition.aliases?.some(alias => normalizeFeatureText(alias) === normalized)) return definition.id;
    if (definition.aliases?.some(alias => normalizeFeatureText(alias).includes(normalized))) return definition.id;
    if (definition.name && normalizeFeatureText(definition.name).includes(normalized)) return definition.id;
  }

  return null;
}

const FEATURE_KIND_BY_STATE: Record<string, FeatureStatus> = {
  disponible: 'AVAILABLE',
  local: 'AVAILABLE',
  a_configurer: 'PARTIAL',
  partiel: 'PARTIAL',
};

const HELP_FEATURE_BY_ID = new Map<string, { name: string; description: string; category: string; feature: FeatureKey; keywords?: string[] }>();
for (const category of HELP_DIRECTORY) {
  for (const item of category.items) {
    const id = String(item.feature);
    if (!HELP_FEATURE_BY_ID.has(id)) {
      HELP_FEATURE_BY_ID.set(id, {
        name: item.name,
        description: item.description,
        category: category.title,
        feature: item.feature,
        keywords: item.keywords,
      });
    }
  }
}

function sanitizeLimitations(text: string): string[] {
  const clean = text
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? [clean] : ['Limites non documentées.'];
}

function buildFeatureDefinitionFromHelp(item: { name: string; description: string; category: string; feature: FeatureKey; keywords?: string[] }): FeatureDefinition {
  const status = FEATURE_KIND_BY_STATE[item.feature === 'settings-models' ? 'disponible' : 'local'] ?? 'AVAILABLE';
  const safeKeywords = item.keywords?.filter(Boolean) ?? [];
  const knownReferences = [
    `src/content/capabilities.ts`,
    `src/App.tsx`,
    `src/components/modals/HelpModal.tsx`,
  ];

  return {
    id: item.feature,
    name: item.name,
    category: item.category,
    shortDescription: item.description,
    purpose: item.description,
    howItWorks: `Docteur expose ${item.name} via le catalogue de fonctionnalités et le mécanisme central de navigation/commande.`,
    inputs: safeKeywords.length > 0 ? safeKeywords : [item.name],
    outputs: ['Vue/outil ouvert dans l’interface Docteur', 'Description dans le Centre d’aide et la recherche locale'],
    security: ['Aucune commande shell ou exécution externe n’est ajoutée par la documentation elle-même.', 'Les permissions restent celles du système concerné.'],
    limitations: sanitizeLimitations(item.description),
    prerequisites: safeKeywords.length > 0 ? safeKeywords.slice(0, 2) : ['Aucune'],
    relatedFeatures: [item.feature],
    status,
    available: status === 'AVAILABLE',
    verified: true,
    technicalReferences: knownReferences,
    routes: ['/', 'help'],
    sourceModules: ['src/content/capabilities.ts'],
    sourceTests: ['scripts/test-feature-registry.mjs'],
    introducedIn: 'current',
    lastValidatedAt: new Date().toISOString(),
    documentationVersion: '1.0.0',
    aliases: [item.name, ...(safeKeywords.length > 0 ? safeKeywords : [])],
  };
}

export const FEATURE_DEFINITIONS: FeatureDefinition[] = Array.from(HELP_FEATURE_BY_ID.values()).map(buildFeatureDefinitionFromHelp);

export const FEATURE_DEFINITION_BY_ID: Map<string, FeatureDefinition> = new Map(
  FEATURE_DEFINITIONS.map(definition => [definition.id, definition]),
);
export const KNOWN_FEATURE_IDS = [...FEATURE_DEFINITION_BY_ID.keys()] as FeatureKey[];

export function registerFeatureDefinition(definition: FeatureDefinition): FeatureDefinition {
  const existingIndex = FEATURE_DEFINITION_BY_ID.get(definition.id);
  if (existingIndex && existingIndex.status !== 'DRAFT' && existingIndex.status !== 'UNVERIFIED') {
    return existingIndex;
  }
  FEATURE_DEFINITION_BY_ID.set(definition.id, definition);
  const index = FEATURE_DEFINITIONS.findIndex(item => item.id === definition.id);
  if (index >= 0) {
    FEATURE_DEFINITIONS[index] = definition;
  } else {
    FEATURE_DEFINITIONS.push(definition);
  }
  return definition;
}

export function getMissingFeatureDefinitions(): string[] {
  const knownIds = new Set(FEATURE_DEFINITIONS.map(definition => definition.id));
  return [...HELP_FEATURE_BY_ID.keys()].filter(id => !knownIds.has(id));
}

export function createFeatureDefinitionDraft(
  id: string,
  name: string,
  overrides: Partial<FeatureDefinition> = {},
): FeatureDefinition {
  const fallback: FeatureDefinition = {
    id,
    name,
    category: overrides.category ?? 'undocumented',
    shortDescription: overrides.shortDescription ?? 'Feature détectée sans définition explicite.',
    purpose: overrides.purpose ?? 'Capacité détectée par le code sans définition certifiée.',
    howItWorks: overrides.howItWorks ?? 'Le système doit être validé avant d’être présenté comme disponible.',
    inputs: overrides.inputs ?? ['Aucune donnée sûre détectée.'],
    outputs: overrides.outputs ?? ['Renseignement technique brut de l’application.'],
    security: overrides.security ?? ['Aucune sécurité certifiée; l’état reste non vérifié.'],
    limitations: overrides.limitations ?? ['Cette capacité ne peut pas être présentée comme certifiée sans validation.'],
    prerequisites: overrides.prerequisites ?? ['Validation du module et des routes associées.'],
    relatedFeatures: overrides.relatedFeatures ?? [],
    status: 'DRAFT',
    available: false,
    verified: false,
    technicalReferences: overrides.technicalReferences ?? ['Détection automatique par le registry.'],
    routes: overrides.routes ?? [],
    sourceModules: overrides.sourceModules ?? [],
    sourceTests: overrides.sourceTests ?? [],
    introducedIn: overrides.introducedIn,
    lastValidatedAt: overrides.lastValidatedAt,
    documentationVersion: overrides.documentationVersion ?? 'draft',
    aliases: overrides.aliases ?? [name],
  };

  return { ...fallback, ...overrides, status: 'DRAFT', available: false, verified: false };
}

export function validateFeatureRegistry() {
  const seen = new Map<string, number>();
  const issues: string[] = [];
  const missingDefinitions = [...HELP_FEATURE_BY_ID.keys()].filter(id => !FEATURE_DEFINITION_BY_ID.has(id));

  for (const definition of FEATURE_DEFINITIONS) {
    if (!definition.id) issues.push('Definition with empty id');
    if (!['AVAILABLE', 'PARTIAL', 'EXPERIMENTAL', 'NOT_AVAILABLE', 'DRAFT', 'UNVERIFIED'].includes(definition.status)) {
      issues.push(`Invalid status for ${definition.id}: ${definition.status}`);
    }
    const first = seen.get(definition.id) ?? 0;
    seen.set(definition.id, first + 1);
    if (definition.available && definition.status === 'DRAFT') {
      issues.push(`Available draft found: ${definition.id}`);
    }
    if (definition.available && !HELP_FEATURE_BY_ID.has(definition.id)) {
      issues.push(`Orphan available definition: ${definition.id}`);
    }
    for (const ref of definition.relatedFeatures ?? []) {
      if (ref && !FEATURE_DEFINITION_BY_ID.has(ref) && !HELP_FEATURE_BY_ID.has(ref as string)) {
        issues.push(`Invalid reference in ${definition.id}: ${ref}`);
      }
    }
  }

  const duplicateIds = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const orphanAvailableDefinitions = FEATURE_DEFINITIONS.filter(definition => definition.available && !HELP_FEATURE_BY_ID.has(definition.id)).map(definition => definition.id);

  if (missingDefinitions.length > 0) issues.push(...missingDefinitions.map(id => `Missing FeatureDefinition: ${id}`));
  if (duplicateIds.length > 0) issues.push(...duplicateIds.map(id => `Duplicate FeatureDefinition: ${id}`));
  if (orphanAvailableDefinitions.length > 0) issues.push(...orphanAvailableDefinitions.map(id => `Orphan AVAILABLE feature: ${id}`));

  return {
    valid: issues.length === 0,
    issues,
    missingDefinitions: missingDefinitions,
    duplicateIds,
    orphanAvailableDefinitions,
  };
}

export function explainFeature(featureId: string): string {
  const definition = getFeatureDefinition(featureId);
  if (!definition) {
    const draft = createFeatureDefinitionDraft(featureId, featureId, {
      category: 'unknown',
      shortDescription: `La fonctionnalité « ${featureId} » est détectée par le code mais n’a pas encore de définition explicite.`,
    });
    return `${draft.name} est une définition DRAFT non certifiée — elle ne doit pas être présentée comme disponible.`;
  }

  if (definition.status === 'NOT_AVAILABLE') {
    return `${definition.name} n’est actuellement pas disponible.`;
  }

  if (definition.status === 'DRAFT' || definition.status === 'UNVERIFIED') {
    return `${definition.name} est ${definition.status.toLowerCase()} et n’est pas encore certifiée comme disponible.`;
  }

  return `${definition.name} — ${definition.shortDescription} ${definition.limitations[0] ? `Limites : ${definition.limitations[0]}.` : ''}`;
}

export const FEATURE_REGISTRY_SUMMARY = {
  total: FEATURE_DEFINITIONS.length,
  missing: getMissingFeatureDefinitions(),
  valid: validateFeatureRegistry().valid,
};
