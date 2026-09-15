// Pollinations — optional image generation provider.
//
// STATUS: stub (see cloudflare-image.js header — same phasing rationale).
// Classification: QUOTA/CREDIT ("Pollen" system) — never "gratuit garanti".
// A 402 response from Pollinations means budget/quota exhausted: no
// aggressive retry, fall back to local.

import { getImageCloudKey } from '../sqlite.js';

export function isPollinationsConfigured() {
  return !!getImageCloudKey('pollinations_key');
}

export function pollinationsCapabilities() {
  return {
    provider: 'pollinations',
    classification: 'quota',
    freeTierNote: 'Système de crédits "Pollen" — quota, pas un accès gratuit garanti. Un code 402 signifie quota/budget épuisé.',
    capabilities: { text_to_image: true, image_to_image: false, image_edit: false, negative_prompt: true, seed: true, custom_size: true },
  };
}

// eslint-disable-next-line no-unused-vars
export async function generateWithPollinations(_params) {
  return { ok: false, errorCode: 'provider_unavailable', message: 'Intégration Pollinations non activée dans cette version (stub réservé à la phase cloud).' };
}
