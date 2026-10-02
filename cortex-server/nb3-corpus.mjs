// NB-3 calibration corpus — a small, controlled, fully synthetic local corpus:
// French / English / mixed language, technical docs, near duplicates, irrelevant
// docs, contradictory docs, one long document (chunking / overlap), one table.
// Every "relevant" label is decided by construction (the fact lives in exactly
// the named document(s)). No real personal data.

const INSTRUMENTS = [
  ['Zenith spectrometer', 'requires a 45 minute warmup before the first measurement', 'lampe'],
  ['Borealis centrifuge', 'must never exceed 12000 rpm when the rotor is older than five years', 'rotor'],
  ['Quasar oscilloscope', 'stores calibration data for 18 months in its internal flash memory', 'flash'],
  ['Meridian titrator', 'uses a 0.1 molar sodium hydroxide reagent that expires after 30 days', 'reagent'],
  ['Cobalt microscope', 'has a fixed 40x objective lens that should be cleaned with lens tissue only', 'lens'],
  ['Argon incubator', 'holds a constant temperature of 37 degrees with a tolerance of 0.2 degrees', 'temperature'],
  ['Helios thermocycler', 'completes a full 30 cycle amplification in about 95 minutes', 'cycle'],
  ['Nimbus pipette station', 'is serviced every 6 months by the maintenance team', 'service'],
  ['Vertex balance', 'has a readability of 0.001 gram and a maximum capacity of 220 gram', 'capacity'],
  ['Onyx freezer', 'keeps samples at minus 80 degrees and raises an alarm above minus 70 degrees', 'alarm'],
  ['Stratus autoclave', 'runs its sterilisation program at 121 degrees for 20 minutes', 'sterilisation'],
  ['Aurora plate reader', 'reads a 96 well plate in under 40 seconds at 450 nanometres', 'plate'],
];

const FILLER = [
  'Operators must log every use in the shared notebook and report anomalies to the lab manager.',
  'The device should be placed on a stable bench away from direct sunlight and vibration sources.',
  'Consumables are stored in the blue cabinet next to the entrance and inventoried monthly.',
  'Before any maintenance the power supply has to be disconnected and the area cleared.',
  'Training records are kept by the safety officer and renewed each year for all users.',
  'A laminated quick reference card is attached to the side of the unit for new operators.',
  'Cleaning after use is mandatory and follows the standard operating procedure of the laboratory.',
  'Unexpected noises or error messages must be reported immediately before the next experiment.',
];

export const FACTS = INSTRUMENTS;
export const FILLERS = FILLER;

function longHandbook() {
  const parts = ['# Laboratory Equipment Handbook', '', 'This handbook describes the shared instruments of the analytical laboratory.', ''];
  INSTRUMENTS.forEach(([name, fact], i) => {
    parts.push(`## ${i + 1}. ${name}`, '');
    parts.push(`${FILLER[i % FILLER.length]} ${FILLER[(i + 3) % FILLER.length]}`);
    parts.push('');
    parts.push(`The ${name} ${fact}. ${FILLER[(i + 5) % FILLER.length]}`);
    parts.push('');
    parts.push(`${FILLER[(i + 1) % FILLER.length]} ${FILLER[(i + 6) % FILLER.length]} ${FILLER[(i + 2) % FILLER.length]}`);
    parts.push('');
  });
  return parts.join('\n');
}

const tableHtml = `<html><head><title>Catalogue produits</title></head><body><h1>Product specifications</h1>
<table><tr><th>Product</th><th>Price</th><th>Warranty</th></tr>
<tr><td>Nimbus keyboard</td><td>89 euros</td><td>2 years</td></tr>
<tr><td>Vertex monitor</td><td>329 euros</td><td>3 years</td></tr>
<tr><td>Orion docking station</td><td>149 euros</td><td>1 year</td></tr></table></body></html>`;

export const DOCS = [
  // French
  { name: 'recette-tarte-pommes.md', lang: 'fr', kind: 'general', text: '# Tarte aux pommes\n\n## Ingrédients\n\nFarine, beurre, sucre, quatre pommes et une pincée de cannelle.\n\n## Préparation\n\nÉtaler la pâte, disposer les pommes en rosace puis cuire au four à 180 degrés pendant 35 minutes.' },
  { name: 'politique-conges.txt', lang: 'fr', kind: 'hr', text: 'Politique de congés. Chaque salarié bénéficie de 25 jours de congés payés par an. La demande doit être déposée deux semaines à l\'avance auprès du responsable. Le télétravail est autorisé deux jours par semaine.' },
  { name: 'guide-sauvegarde.md', lang: 'fr', kind: 'technical', text: '# Guide de sauvegarde\n\n## Planification\n\nLa sauvegarde complète s\'exécute chaque nuit à 02h00 sur le serveur de fichiers. Les sauvegardes sont conservées pendant 30 jours.\n\n## Restauration\n\nPour restaurer la dernière sauvegarde, lancer la commande restore --latest depuis la console d\'administration.' },
  { name: 'rgpd-registre.txt', lang: 'fr', kind: 'legal', text: 'Le RGPD impose la tenue d\'un registre des traitements de données personnelles. Le délégué à la protection des données (DPO) contrôle ce registre et répond aux demandes d\'accès des personnes concernées sous un mois.' },
  { name: 'astronomie-mars.txt', lang: 'fr', kind: 'general', text: 'Mars est surnommée la planète rouge à cause de l\'oxyde de fer présent à sa surface. Elle possède deux petites lunes, Phobos et Déimos. Un jour martien dure environ 24 heures et 37 minutes.' },
  { name: 'reunion-orion.md', lang: 'mixed', kind: 'notes', text: '# Réunion projet Orion\n\nLe 12 mars, la sprint review a validé le module d\'export. La deadline pour la release 2.0 est fixée au 30 avril. Action : Marie prépare la démo pour les stakeholders.' },
  // English
  { name: 'network-setup.md', lang: 'en', kind: 'technical', text: '# Network Setup\n\n## Firewall\n\nAllow inbound TCP 443 for the web gateway and block every other inbound port by default.\n\n## VPN\n\nThe VPN uses WireGuard and listens on UDP port 51820. Each device receives a unique key pair.' },
  { name: 'kubernetes-deploy.md', lang: 'en', kind: 'technical', text: '# Kubernetes Deployment\n\nDeployments use a rolling update strategy with a readiness probe on /healthz. To revert a faulty release run kubectl rollout undo deployment/web. Pods are scheduled on nodes labelled tier=app.' },
  { name: 'error-codes.txt', lang: 'en', kind: 'technical', text: 'ERR-4021: authentication token expired, the client must log in again.\nERR-5093: upstream service timeout after 30 seconds.\nERR-7710: database migration lock could not be acquired.' },
  { name: 'ci-cd-pipeline.md', lang: 'en', kind: 'technical', text: '# CI/CD Pipeline\n\nThe CI pipeline runs on every pull request with four stages: lint, unit tests, build and security scan. Merges to main trigger the CD stage which deploys to staging automatically.' },
  { name: 'solar-system.txt', lang: 'en', kind: 'general', text: 'Jupiter is the largest planet in the solar system. Its Great Red Spot is a storm larger than Earth that has lasted for centuries. Jupiter has at least 95 known moons.' },
  { name: 'api-rate-limits.md', lang: 'en', kind: 'technical', text: '# API Rate Limits\n\nThe public API allows 100 requests per minute for each API key. Exceeding the limit returns HTTP status 429 with a Retry-After header.' },
  { name: 'onboarding-handbook.md', lang: 'en', kind: 'hr', text: '# Onboarding Handbook\n\nNew employees receive a laptop on their first day. Every employee is entitled to 25 vacation days per year. Remote work is possible up to three days per week.' },
  { name: 'security-policy.txt', lang: 'en', kind: 'policy', text: 'Security policy. Passwords must contain at least 14 characters. Multi-factor authentication is required for all administrative accounts. Service keys are rotated every 90 days.' },
  // Contradictory pairs
  { name: 'status-v2-a.txt', lang: 'fr', kind: 'status', text: 'La version 2 du service est active en production depuis le 3 mars. Le service de paiement utilise la version 2.' },
  { name: 'status-v2-b.txt', lang: 'fr', kind: 'status', text: 'La version 2 du service est désactivée en production depuis le 20 mars. Le service de paiement utilise la version 1.' },
  { name: 'throughput-a.txt', lang: 'en', kind: 'status', text: 'The maximum throughput of the Quixote link is 10 Mbit/s according to the 2023 network audit.' },
  { name: 'throughput-b.txt', lang: 'en', kind: 'status', text: 'The maximum throughput of the Quixote link is 100 Mbit/s according to the 2025 upgrade report.' },
  // Near duplicates
  { name: 'retention-policy-v1.txt', lang: 'en', kind: 'policy', text: 'Backups are retained for 30 days. Older backups are deleted automatically every night at 03:00 by the cleanup job.' },
  { name: 'retention-policy-copy.txt', lang: 'en', kind: 'policy', text: 'Backups are retained for 30 days. Older backups are deleted automatically each night at 03:00 by the cleanup job.' },
  // Irrelevant / distractors
  { name: 'football-results.txt', lang: 'fr', kind: 'distractor', text: 'Le match du club de Vauclair s\'est terminé sur le score de 2 à 1 après une prolongation. L\'entraîneur a salué l\'esprit d\'équipe des joueurs.' },
  { name: 'gardening-tips.txt', lang: 'en', kind: 'distractor', text: 'Tomatoes need at least six hours of sunlight and regular watering. Add compost to the soil in spring and remove side shoots weekly.' },
  { name: 'poeme-automne.txt', lang: 'fr', kind: 'distractor', text: 'Les feuilles tombent doucement sur le chemin du soir, le vent murmure un chant ancien et la lumière s\'éteint derrière les collines.' },
  // Mixed language
  { name: 'notes-mixed.md', lang: 'mixed', kind: 'notes', text: '# Notes backend\n\nRéunion avec l\'équipe backend. We decided to migrate the database to PostgreSQL 16. La migration est prévue en mai. Rollback plan: restore the nightly snapshot.' },
  // Long document + table
  { name: 'long-handbook.md', lang: 'en', kind: 'long', text: longHandbook() },
  { name: 'table-specs.html', lang: 'en', kind: 'table', bytes: tableHtml },
];

// type, query, relevant document names (empty = NO relevant source expected)
export const QUERIES = [
  ['exact keyword', 'WireGuard', ['network-setup.md']],
  ['exact keyword', 'Phobos', ['astronomie-mars.txt']],
  ['exact keyword', 'kubectl', ['kubernetes-deploy.md']],
  ['semantic paraphrase', 'how many days off do employees get each year', ['onboarding-handbook.md', 'politique-conges.txt']],
  ['semantic paraphrase', 'what happens when a client sends too many calls to the API', ['api-rate-limits.md']],
  ['semantic paraphrase', 'how do I roll back a broken release', ['kubernetes-deploy.md']],
  ['acronym', 'RGPD', ['rgpd-registre.txt']],
  ['acronym', 'CI/CD', ['ci-cd-pipeline.md']],
  ['acronym', 'DPO', ['rgpd-registre.txt']],
  ['filename', 'error-codes', ['error-codes.txt']],
  ['filename', 'network-setup.md', ['network-setup.md']],
  ['filename', 'politique-conges', ['politique-conges.txt']],
  ['heading', 'Firewall', ['network-setup.md']],
  ['heading', 'Ingrédients', ['recette-tarte-pommes.md']],
  ['heading', 'Restauration', ['guide-sauvegarde.md']],
  ['multi-word phrase', 'rolling update', ['kubernetes-deploy.md']],
  ['multi-word phrase', 'congés payés', ['politique-conges.txt']],
  ['multi-word phrase', 'multi-factor authentication', ['security-policy.txt']],
  ['question natural language', 'Quel port utilise le VPN ?', ['network-setup.md']],
  ['question natural language', 'What is the API rate limit per minute?', ['api-rate-limits.md']],
  ['question natural language', 'Quand la sauvegarde s\'exécute-t-elle ?', ['guide-sauvegarde.md']],
  ['french accents', 'planète rouge', ['astronomie-mars.txt']],
  ['french accents', 'Deimos', ['astronomie-mars.txt']],
  ['french accents', 'delegue a la protection des donnees', ['rgpd-registre.txt']],
  ['english query', 'largest planet in the solar system', ['solar-system.txt']],
  ['english query', 'how long are passwords required to be', ['security-policy.txt']],
  ['french query vs english doc', 'Combien de requêtes par minute l\'API autorise-t-elle ?', ['api-rate-limits.md']],
  ['french query vs english doc', 'Sur quel port écoute le VPN ?', ['network-setup.md']],
  ['french query vs english doc', 'Quelle est la plus grande planète du système solaire ?', ['solar-system.txt']],
  ['technical identifier', 'ERR-4021', ['error-codes.txt']],
  ['technical identifier', 'PostgreSQL 16', ['notes-mixed.md']],
  ['technical identifier', 'UDP 51820', ['network-setup.md']],
  ['rare term', 'Zenith spectrometer warmup', ['long-handbook.md']],
  ['rare term', 'Borealis centrifuge rpm', ['long-handbook.md']],
  ['rare term', 'Stratus autoclave sterilisation', ['long-handbook.md']],
  ['long document fact', 'how long does the Helios thermocycler take to complete amplification', ['long-handbook.md']],
  ['long document fact', 'what temperature does the Onyx freezer maintain', ['long-handbook.md']],
  ['table', 'price of the Nimbus keyboard', ['table-specs.html']],
  ['table', 'Orion docking station warranty', ['table-specs.html']],
  ['contradiction', 'La version 2 du service est-elle active ?', ['status-v2-a.txt', 'status-v2-b.txt']],
  ['contradiction', 'maximum throughput of the Quixote link', ['throughput-a.txt', 'throughput-b.txt']],
  ['near duplicate', 'how long are backups retained', ['retention-policy-v1.txt', 'retention-policy-copy.txt', 'guide-sauvegarde.md']],
  ['mixed language', 'database migration rollback plan', ['notes-mixed.md']],
  ['mixed language', 'release 2.0 deadline', ['reunion-orion.md']],
  // Negatives: nothing in the corpus answers these
  ['negative', 'capital of Australia', []],
  ['negative', 'comment réparer un pneu de vélo', []],
  ['negative', 'stock price of Tesla today', []],
  ['negative', 'recette du couscous marocain', []],
  ['negative', 'who painted the Mona Lisa', []],
  ['negative', 'how to train a puppy to sit', []],
  ['negative', 'quelle est la formule de la relativité restreinte', []],
  ['negative', 'best hiking trails in Norway', []],
];
