// Hugging Face Inference Providers — image generation.
//
// STATUS: stub (see cloudflare-image.js header — same phasing rationale).
// Classification: CREDIT — free accounts currently get a small amount of
// free inference credit, not an unlimited free API. Never claim "FLUX
// fonctionne gratuitement" without checking live availability/credit first.

import { getImageCloudKey } from '../sqlite.js';

export function isHuggingFaceConfigured() {
  return !!getImageCloudKey('huggingface_token');
}

export function huggingfaceCapabilities() {
  return {
    provider: 'huggingface',
    classification: 'credit',
    freeTierNote: 'Crédits gratuits limités (compte gratuit) — pas une API gratuite illimitée. Le modèle réellement utilisé doit être vérifié disponible au moment de la requête.',
    capabilities: { text_to_image: true, image_to_image: false, image_edit: false, negative_prompt: true, seed: true, custom_size: true },
  };
}

// eslint-disable-next-line no-unused-vars
export async function generateWithHuggingFace(_params) {
  return { ok: false, errorCode: 'provider_unavailable', message: 'Intégration Hugging Face Inference Providers non activée dans cette version (stub réservé à la phase cloud).' };
}
