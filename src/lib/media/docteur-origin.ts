import { getImageUrl } from '../cortex/client';

/** Docteur's API origin, derived from the client's own URL builder (the BASE formula is never re-implemented). Its local
 *  media routes are the only loopback URLs the Media Reader accepts. */
export function docteurApiOrigin(): string | null {
  try { return new URL(getImageUrl('origin-probe')).origin; } catch { return null; }
}
