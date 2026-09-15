// Cloudflare Workers AI — image generation provider.
//
// STATUS: stub. Real HTTP calls are NOT implemented in this pass — only the
// shape (capability declaration, key checks, quota classification) needed by
// the router and Settings UI. Wiring the real fetch() call and validating it
// against a live Cloudflare account is deliberate future work requiring
// explicit user opt-in (see mission: "Phase 2 CLOUD... attendre validation
// explicite utilisateur avant tout appel réel").
//
// Classification: FREE TIER (provider-advertised quota, not guaranteed —
// see freeTierNote). Never say "gratuit illimité".

import { getImageCloudKey } from '../sqlite.js';

export const CLOUDFLARE_IMAGE_MODEL_DEFAULT = '@cf/black-forest-labs/flux-1-schnell';

export function isCloudflareConfigured() {
  return !!getImageCloudKey('cloudflare_account_id') && !!getImageCloudKey('cloudflare_api_token');
}

export function cloudflareCapabilities() {
  return {
    provider: 'cloudflare',
    classification: 'free_tier',
    freeTierNote: 'Free tier — quota fournisseur (actuellement ~10 000 Neurons/jour selon la documentation Cloudflare ; ce quota peut changer et n’est pas garanti par Docteur).',
    billingCaveat: 'Docteur limite ses propres usages, mais ne peut pas garantir l’absence de facturation au niveau du compte fournisseur si d’autres services utilisent le même quota.',
    capabilities: { text_to_image: true, image_to_image: false, image_edit: false, negative_prompt: false, seed: true, custom_size: true },
  };
}

// eslint-disable-next-line no-unused-vars
export async function generateWithCloudflare(_params) {
  return { ok: false, errorCode: 'provider_unavailable', message: 'Intégration Cloudflare Workers AI non activée dans cette version (stub réservé à la phase cloud).' };
}
