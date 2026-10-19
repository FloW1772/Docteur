// EETF V1 — EETF-CERT: the Root Policy decision function EETF services use when the caller passes none.
// Routes never import the policy module themselves (Root Policy static audit); the same `enforce` is used — no bypass.
export { enforce as eetfEnforce } from './root-policy/index.js';
