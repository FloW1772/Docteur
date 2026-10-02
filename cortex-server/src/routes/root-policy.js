import { Hono } from 'hono';
import { getPolicyView, getRootPolicyStatus } from '../lib/root-policy/index.js';

/**
 * ROOT POLICY — READ-ONLY API. There is deliberately no POST / PUT / PATCH / DELETE here (and none anywhere that touches the policy):
 * no LLM, agent, plugin, MCP server, remote command or web page can modify the Root Policy through Docteur. It changes only through the
 * offline human tool (root-policy-tool.mjs). The static audit fails if a mutating method is ever added to this file.
 */
export function createRootPolicyRoute() {
  const route = new Hono();

  // Status for Settings > Security > Root Policy (state, version, integrity, source, AI modification: FORBIDDEN).
  route.get('/root-policy/status', (c) => c.json(getRootPolicyStatus()));

  // Read-only view of the ACTIVE policy (null when the policy is invalid — the status explains why).
  route.get('/root-policy/policy', (c) => c.json(getPolicyView()));

  return route;
}
