# MASTER PHASE 8 — Faisabilité d'un entraînement local léger

Date: 2026-09-15
**MODE : AUDIT SEUL.** Aucun téléchargement, aucun entraînement, aucune installation de
framework n'a été effectué pendant cette phase.

## 1. Matériel réel mesuré (cette machine)

| Ressource | Valeur mesurée |
|---|---|
| RAM système | 34 053 414 912 octets ≈ **32 Go** |
| GPU dédié | NVIDIA GeForce RTX 5060 Laptop |
| VRAM (via `nvidia-smi`) | **8 151 MiB ≈ 8 Go** — chiffre fiable (WMI `AdapterRAM` sous-évaluait à ~4 Go à cause d'un bug 32-bit connu, `nvidia-smi` fait foi) |
| GPU intégré | Intel UHD Graphics (2 Go partagés, non pertinent pour l'entraînement) |
| Disque libre (C:) | ≈ **52,5 Go** |
| Modèles Ollama déjà configurés (settings réels) | `mistral-nemo:12b-instruct-2407-q4_K_M` (chat), `qwen2.5:14b-instruct-q3_K_M` (mode puissant), `nomic-embed-text` (embeddings), `llama3.2:3b` (fallback léger) |

**Constat clé** : cette machine charge déjà régulièrement des modèles 12-14B fortement
quantifiés (q3/q4) dans 8 Go de VRAM pour l'usage normal de Docteur. Il ne reste
**quasiment aucune marge VRAM libre** pour faire tourner un entraînement (LoRA/QLoRA)
simultanément à un usage normal — un entraînement devrait attendre que le modèle de chat
principal soit déchargé, ou se limiter à un modèle de base très petit (0.5B-1.5B).

## 2. Étude des approches (RAG / mémoire adaptative / LoRA / QLoRA / adapter / reranker)

### 2.1 "Connaître mes documents" → RAG (déjà en place)
Le Notebook local (Phase 5) et le RAG existant (`answerQuestion`, `searchNeurons`) couvrent
déjà ce besoin sans aucun entraînement : récupération vectorielle + citation de source.
**Aucun gain identifié** à remplacer ceci par du fine-tuning — le RAG reste supérieur pour
ce cas d'usage (traçabilité des sources, mise à jour instantanée sans ré-entraînement,
citations vérifiables).

### 2.2 "Retenir mes préférences" → Mémoire adaptative (déjà en place)
La mémoire adaptative (Phase 3, `episodic_memories` + `preference_facts` avec métadonnées
et budget de contexte) couvre ce besoin. Un fine-tuning pour "mémoriser" des préférences
serait strictement inférieur : non éditable, non traçable, nécessiterait un ré-entraînement
à chaque nouvelle préférence, et pourrait halluciner ou mal généraliser des préférences
contradictoires — la mémoire structurée déjà en place n'a aucun de ces défauts.

### 2.3 "Imiter mon style" → LoRA (pertinent en théorie, coût/bénéfice défavorable ici)
Cas d'usage où un adapter LoRA a un sens réel (contrairement aux deux précédents). Mais :
- Nécessite un dataset d'exemples de style (paires instruction→réponse dans le style visé)
  — aucun mécanisme de génération/curation de ce type de dataset n'existe dans Docteur
  aujourd'hui (à construire de zéro).
- Sur 8 Go de VRAM déjà occupés par l'usage normal, un entraînement LoRA sur un modèle
  ≥3B nécessiterait de décharger le modèle de chat principal pendant toute la durée de
  l'entraînement — dégradation d'usage non négligeable pour un gain incertain.
- Docteur dispose déjà d'un mécanisme de "exemples de style" réutilisés dans les prompts
  (`style_examples`, visible dans les réglages Modèles) — une forme de "few-shot" qui capture
  une partie du bénéfice visé par LoRA, à coût zéro en VRAM/temps d'entraînement.

### 2.4 "Classer/reranker mes neurones" → petit modèle spécialisé (le plus prometteur, mais non prioritaire)
Un reranker léger (ex. cross-encoder MiniLM, quelques dizaines de Mo, CPU-friendly) pourrait
améliorer l'ordonnancement top-k du RAG/Notebook au-delà du score de similarité cosinus
actuel. C'est l'option la plus réaliste techniquement (petit modèle, pas de LoRA, inférence
seule — pas d'entraînement nécessaire si on utilise un reranker pré-entraîné public plutôt
que d'en entraîner un depuis les données de l'utilisateur). **Mais** : n'est pas un besoin
exprimé dans la mission actuelle, et améliorer le score de retrieval demanderait d'abord une
mesure de la qualité actuelle du retrieval (hors périmètre de cette phase, à évaluer en
Phase 9 — audit).

## 3. Estimation matérielle pour un entraînement LoRA/QLoRA réaliste sur cette machine

| Taille de modèle de base | QLoRA (4-bit) VRAM estimée | Réaliste sur 8 Go ? |
|---|---|---|
| 0.5B | ~2-3 Go | Oui, avec marge |
| 1B | ~3-4 Go | Oui, avec marge modérée |
| 1.5B | ~4-5 Go | Oui, marge faible si le chat model reste chargé |
| 3B | ~6-8 Go | Limite — nécessite de décharger tout autre modèle |
| 7B+ | ~12-16 Go même en QLoRA 4-bit | **Non réaliste** sur cette machine — explicitement exclu par la mission |

Ces estimations sont des ordres de grandeur génériques (règle empirique QLoRA ≈ taille du
modèle en Go pour les poids 4-bit + 1-3 Go d'overhead d'entraînement/optimiseur) — **aucun
téléchargement ni test réel n'a été effectué pour les vérifier sur cette machine**, par
respect du mode audit-seul de cette phase.

Dataset : les documents bruts de l'utilisateur (neurones, notebooks) ne sont **pas**
directement un bon dataset d'entraînement — il faudrait construire un pipeline de génération
de paires instruction→réponse avec déduplication, suppression de secrets, et consentement
explicite avant tout aperçu de dataset (aucun de ces éléments n'existe aujourd'hui).

## 4. Décision de classement

| Cas d'usage | Classement | Justification |
|---|---|---|
| Connaître mes documents | **C — NON RECOMMANDÉ** (pour LoRA/fine-tuning) | RAG déjà en place, strictement meilleur pour ce besoin |
| Retenir mes préférences | **C — NON RECOMMANDÉ** (pour LoRA/fine-tuning) | Mémoire adaptative déjà en place, strictement meilleure pour ce besoin |
| Imiter mon style | **B — POSSIBLE MAIS PEU UTILE** | Techniquement faisable (0.5-1.5B QLoRA), mais coût (dataset à construire, VRAM à libérer) disproportionné par rapport au mécanisme "exemples de style" déjà existant et gratuit |
| Classer/reranker mes neurones | **B — POSSIBLE MAIS PEU UTILE** *pour l'instant* | Prometteur en théorie mais pas un besoin exprimé, nécessiterait d'abord une mesure de la qualité actuelle du retrieval (Phase 9) |

**Aucun cas d'usage n'atteint le niveau A (RECOMMANDÉ).**

## 5. Conséquence — application stricte de la règle mission

> "SI B ou C : NE PAS implémenter de training. Continuer vers la phase suivante avec
> rapport."

Tous les cas étudiés sont classés B ou C. **Aucune infrastructure d'entraînement (dataset
preview, estimation VRAM/disque/durée, bouton démarrer/annuler) n'a été implémentée dans
cette phase**, conformément à la règle mission. Aucun code n'a été ajouté au produit pour
cette phase — c'est un rapport d'étude uniquement.

## 6. Ce qui pourrait faire basculer une future réévaluation vers A

- Une demande utilisateur explicite et récurrente pour un style d'écriture personnalisé que
  les "exemples de style" actuels ne captureraient pas de façon satisfaisante.
- Une mesure concrète (Phase 9 ou usage réel) montrant que le classement top-k du RAG/
  Notebook est régulièrement insuffisant, justifiant l'investissement dans un reranker.
- Une évolution matérielle (VRAM disponible significativement supérieure) qui réduirait le
  coût d'opportunité d'un entraînement LoRA coexistant avec l'usage normal de Docteur.

## GATE PHASE 8

| Critère | Résultat |
|---|---|
| Mode audit uniquement respecté | Conforme — 0 ligne de code produit, 0 téléchargement, 0 entraînement |
| Matériel réel mesuré (pas supposé) | Conforme (`nvidia-smi`, RAM, disque réels) |
| Modèles proposés réalistes (0.5-3B, pas 7B+) | Conforme |
| Dataset : consentement/preview/dédup étudiés | Conforme (étudié, non implémenté) |
| Décision A/B/C appliquée strictement | Conforme — tout est B ou C, aucune infrastructure construite |
| Aucune donnée externe téléchargée | Conforme |

**PASS**

**→ CONTINUE vers PHASE 9 (audit global Docteur — lecture seule, aucune correction appliquée).**
