import { ExternalAgents } from '../cortex-server/src/lib/external-agents.js';
const service = new ExternalAgents({projectRoot: process.cwd()});
try { console.log(JSON.stringify(await service.detect(), null, 2)); }
finally { await service.shutdown(); }
