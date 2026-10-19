// [COMP-7 PRODUCT WIRING] Concrete composition of the Companion answer path.
//
// The only place where the Companion context engine, the COMP-7 graph read port and the Companion local model are put
// together. It deliberately sits outside both module families: Companion modules never import graph code, graph
// modules never import Companion code. The graph reaches the Companion only through the certified
// createCompanionKgReadPort (fixed 'companion' consumer of the KG consumer API: read only, public scope, no private
// sources, MEMBER_OF neighbourhood only, authority NONE). No raw store or table is handed to a Companion module.
// Called only after the Companion boot gate has opened the Companion store; a closed / failing graph only means
// "no graph context" — it never blocks the Companion.

import { createCompanionContextEngine } from './companion-context.js';
import { createCompanionModel } from './companion-model.js';
import { createCompanionConversation, resolveCompanionKgGate } from './companion-conversation.js';
import { createCompanionKgReadPort } from './kg-companion-context.js';

/**
 * @param {object} deps
 *   companion   CompanionMemory (context engine port: preferences / view / session / recordContextAssembly)
 *   memoryPort  NB-5 read port (retrieve)
 *   kgStore     the graph store opened at boot, or null when the graph is closed
 *   kgConsumer  tests only: an injected 'companion' consumer client instead of a store
 *   env         reads the COMP-7 operator switch only
 *   client, store, getSettings, getHardware   forwarded to the Companion local model
 *   model       tests only: an injected model double
 */
export function wireCompanionConversation({
  companion, memoryPort, kgStore = null, kgConsumer = null, env = process.env,
  client = null, store = null, getSettings = () => ({}), getHardware = async () => null, logger = null, model = null, now = undefined,
  timeoutMs = undefined,
} = {}) {
  const gate = resolveCompanionKgGate({ kgOpen: Boolean(kgStore || kgConsumer), env });
  let knowledgePort = null;
  if (gate.enabled) {
    // a graph that cannot even be bound only removes graph context — never the answer path
    try {
      const port = createCompanionKgReadPort({ store: kgStore, consumer: kgConsumer, enabled: true });
      if (port.capability.state === 'ACTIVE') knowledgePort = port;
    } catch {
      knowledgePort = null;
    }
  }
  const kgGate = knowledgePort ? gate : Object.freeze({ enabled: false, reason: gate.enabled ? 'KG_UNAVAILABLE' : gate.reason });
  const contextEngine = createCompanionContextEngine({ companion, memoryPort, knowledgePort, getSettings, ...(now ? { now } : {}) });
  const companionModel = model ?? createCompanionModel({ client, store, getSettings, getHardware });
  const conversation = createCompanionConversation({ contextEngine, model: companionModel, kgGate, logger, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  return Object.freeze({ conversation, kgGate });
}
