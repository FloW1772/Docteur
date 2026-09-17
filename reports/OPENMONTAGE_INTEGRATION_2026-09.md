# OPENMONTAGE INTEGRATION — Rapport final

Date : 2026-09-17
SHA OpenMontage audité et installé : `08e2151fa02de28a5d6a312b3d575692bf147ad7` (HEAD detached, épinglé, jamais `main`)
Emplacement : `C:\dev\Docteur\external\OpenMontage` (isolé, hors de l'arbre de code Docteur)

## Résumé de la mission

Installation séquentielle, auditée et approuvée étape par étape, d'OpenMontage comme moteur vidéo externe isolé pour Docteur, suivant strictement les règles de sécurité de la mission (aucune installation avant audit, aucun `shell:true`, aucune credential transmise, aucun accès cloud, isolation stricte des workspaces).

## Phases réalisées

| Phase | Objet | Résultat |
|---|---|---|
| Phase 0 | Baseline Docteur avant toute modification | 37/37 tests PASS, typecheck PASS, build PASS |
| OM-1 | Audit du dépôt canonique, licence AGPL-3.0, CVE, supply-chain | INSTALLATION RECOMMANDÉE : OUI AVEC RESTRICTIONS |
| OM-1 (approfondi) | Confirmation indépendante dépôt canonique, analyse juridique AGPL, balayage typosquat | Dépôt confirmé (croissance stars/forks non expliquée, mais aucun malware/typosquat trouvé) ; risque licence FAIBLE (isolation subprocess) |
| OM-2A | Création venv Python 3.10 isolé | PASS |
| OM-2B | Dry-run + installation pip épinglée (46 paquets, wheels uniquement) | PASS — 0 sdist, 0 source non-PyPI, 0 GPU/torch |
| OM-2C | Installation Node/Remotion via `npm ci` | PASS — 199 paquets, lockfile inchangé, 0 package global |
| OM-2C-S | Audit vulnérabilités npm (3 trouvées : browserslist, baseline-browser-mapping, fast-uri) | Toutes confinées à la toolchain de build interne, non exploitables dans l'usage prévu |
| OM-2D | Évaluation HyperFrames | NON INSTALLÉ — Remotion seul suffit pour le périmètre minimal |
| OM-2E | Piper TTS | NON INSTALLÉ — Docteur dispose déjà de capacités TTS |
| OM-2F | `.env` | NON CRÉÉ — non nécessaire au fonctionnement minimal |
| OM-2H | Test standalone minimal (imports, CLI, registry) | PASS — 121 outils découverts, réseau bloqué actif |
| OM-3 (local audit complet) | Audit exhaustif du code source cloné (subprocess, skills agentiques, path traversal) | Risque supply-chain FAIBLE, risque exécution FAIBLE |
| OM-4 | Adapter Docteur → OpenMontage (`openmontage-adapter.js`, `openmontage-policy.js`) | 30/30 tests, cwd Remotion isolé, path traversal bloqué |
| OM-5 | Premier rendu vidéo local réel | PASS — MP4 6.06s, 1920×1080, h264, 365 kB |
| OM-6 | API Hono + UI Studio Vidéo minimale | PASS — 20/20 tests route, test navigateur complet |

## OM-6 — Détail final

```
API :
PASS (5 endpoints : GET status, GET capabilities, POST render, GET job/:id,
POST job/:id/cancel, GET job/:id/artifact — tous loopback-only, allowlist
stricte, aucun chemin/commande/environnement arbitraire exposé)

Studio vidéo :
PASS (onglet "STUDIO VIDÉO" intégré à SettingsModal existant, aucune
architecture UI parallèle créée, lazy-loadé via le mécanisme existant
de la modale parente)

Rendu depuis UI :
PASS (vérifié en navigateur réel avec DB isolée : rendu déclenché, suivi de
progression par polling 1.5s, lecture vidéo dans le navigateur)

Cancellation :
PASS (bug réel trouvé et corrigé pendant la vérification : le client
n'envoyait pas Content-Type: application/json sur l'appel cancel,
déclenchant un 415 — corrigé, cancellation confirmée fonctionnelle)

Local-only :
PASS (badge LOCAL affiché, guard loopback-only sur toutes les routes,
Strict Local / privacy guard / local_only préservés intacts)

Cloud :
0

Credentials :
0

Path escape :
BLOQUÉ (traversal, absolu, UNC — tous testés et bloqués côté adapter ET
côté route ; le job id n'est jamais interprété comme chemin filesystem)

Command injection :
BLOQUÉ (aucun champ UI ne devient un argument shell — resolution/fps
allowlistés strictement, titre/sous-titre sanitizés et transmis uniquement
en tant que prop JSON React, jamais interpolés dans une commande)

shell:true :
0

Tests :
454/454 (incluant 30/30 adapter, 20/20 route, suite Docteur complète)

Typecheck :
PASS

Build :
PASS
```

## Points de vigilance identifiés (non bloquants)

1. **Croissance de stars/forks OpenMontage inexpliquée** (59,7k stars en quelques jours) — traité comme signal non fiable, sans impact sur l'intégrité technique confirmée par l'audit de code exhaustif.
2. **Licence AGPL-3.0** — risque FAIBLE grâce à l'isolation subprocess stricte (venv séparé, process séparé, aucun code partagé). À réévaluer si Docteur est un jour hébergé pour plusieurs utilisateurs distants.
3. **3 vulnérabilités npm** (browserslist, baseline-browser-mapping, fast-uri) dans la toolchain de build Remotion — confinées au build local, non exploitables dans l'architecture actuelle, non corrigées à ce stade (`npm audit fix` volontairement non exécuté sur instruction).
4. **Absence de SECURITY.md** dans le dépôt OpenMontage upstream — signal de maturité process à surveiller.
5. Un bug de client frontend (header manquant sur cancel) a été trouvé et corrigé grâce au test navigateur bout-en-bout — confirme la valeur de cette étape de vérification manuelle en complément des tests automatisés.

## Ce qui n'a PAS été fait (hors périmètre, volontairement)

- Aucune génération cloud (OpenAI, Anthropic, Groq, OpenRouter, Google, ElevenLabs, Atlas, Kling, HeyGen, fal.ai)
- Aucun modèle GPU/local téléchargé
- HyperFrames et Piper TTS restent non installés
- Aucune route de suppression/modification de fichiers arbitraires
- Aucun accès direct au filesystem exposé au client

---

# OPENMONTAGE INTEGRATION : **PASS**

L'intégration OpenMontage → Docteur est fonctionnelle de bout en bout (audit → installation isolée → adapter sécurisé → rendu réel → API/UI), sans dégradation de la baseline Docteur (454/454 tests, typecheck PASS, build PASS), sans fuite de credentials, sans appel cloud, et avec tous les garde-fous de sécurité demandés vérifiés et fonctionnels.

STOP. MetaGPT ne doit pas commencer sans autorisation explicite.
