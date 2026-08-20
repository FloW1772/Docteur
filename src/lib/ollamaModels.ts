export interface OllamaRecommendedModel {
  name: string;
  label: string;
  category: 'generaliste' | 'code' | 'embeddings';
  approxSizeBytes: number;
  approxVramGiB: number;
  note: string;
}

export const OLLAMA_MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const OLLAMA_RECOMMENDED_MODELS: OllamaRecommendedModel[] = [
  {
    name: 'qwen2.5:7b',
    label: 'Qwen 2.5 7B',
    category: 'generaliste',
    approxSizeBytes: 4_800_000_000,
    approxVramGiB: 4.5,
    note: 'Bon équilibre vitesse/qualité',
  },
  {
    name: 'qwen2.5:14b',
    label: 'Qwen 2.5 14B',
    category: 'generaliste',
    approxSizeBytes: 8_900_000_000,
    approxVramGiB: 9.5,
    note: 'Plus précis, risque de dépasser 8 Go',
  },
  {
    name: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    category: 'generaliste',
    approxSizeBytes: 2_100_000_000,
    approxVramGiB: 2.2,
    note: 'Très léger et rapide',
  },
  {
    name: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    category: 'generaliste',
    approxSizeBytes: 4_900_000_000,
    approxVramGiB: 5.6,
    note: 'Polyvalent, plus lourd que 3B',
  },
  {
    name: 'mistral:7b',
    label: 'Mistral 7B',
    category: 'generaliste',
    approxSizeBytes: 4_100_000_000,
    approxVramGiB: 4.3,
    note: 'Solide pour les usages généraux',
  },
  {
    name: 'gemma2:9b',
    label: 'Gemma 2 9B',
    category: 'generaliste',
    approxSizeBytes: 5_500_000_000,
    approxVramGiB: 6.6,
    note: 'Qualité élevée, plus exigeant',
  },
  {
    name: 'qwen2.5-coder:7b',
    label: 'Qwen 2.5 Coder 7B',
    category: 'code',
    approxSizeBytes: 4_900_000_000,
    approxVramGiB: 4.8,
    note: 'Spécialisé code / assistance technique',
  },
  {
    name: 'nomic-embed-text',
    label: 'Nomic Embed Text',
    category: 'embeddings',
    approxSizeBytes: 275_000_000,
    approxVramGiB: 0.6,
    note: 'Modèle d’embeddings local',
  },
];

const BYTE_UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

export function isStrictOllamaModelName(name: string): boolean {
  return OLLAMA_MODEL_NAME_PATTERN.test(name.trim());
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return 'inconnu';
  if (bytes < 1024) return `${bytes} o`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export function formatGiB(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)} Go`;
}

export function getRecommendedModel(name: string): OllamaRecommendedModel | undefined {
  return OLLAMA_RECOMMENDED_MODELS.find(model => model.name === name);
}

export function formatModelDisplaySize(actualSizeBytes: number | null | undefined, fallbackSizeBytes: number): string {
  return formatBytes(actualSizeBytes ?? fallbackSizeBytes);
}