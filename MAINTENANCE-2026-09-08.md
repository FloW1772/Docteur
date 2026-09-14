# Vérification et corrections — 8 septembre 2026

## LanceDB : compaction réalisée sur la base réelle

| Mesure | Avant | Après |
|---|---:|---:|
| Taille physique de `cortex-server/data/cortex.lance` | 11 111 887 083 octets | 24 352 313 octets |
| Fragments actifs | 182 | 1 |
| Entrées indexées | 6 587 | 6 587 |

Durée : **209 544 ms**, soit **3 min 29,5 s**. Gain : **11 087 534 770 octets**, soit **11,09 Go / 10,33 Gio**, environ **99,78 %**.

Tous les identifiants ont été comparés, pas seulement les compteurs : ensembles identiques. Les cinq résultats et scores d’une recherche avec un vecteur existant sont strictement identiques avant/après. Après démarrage temporaire d’Ollama, une nouvelle question a produit un embedding `nomic-embed-text` de 768 dimensions et retourné des résultats dans la base compactée. Aucun neurone indexé avant l’opération n’a perdu son entrée. Cela ne prétend pas que tous les neurones de l’application étaient déjà indexés avant l’intervention.

Mesures et empreinte des identifiants : [compaction-report.json](cortex-server/compaction-report.json). Le dossier `data/` entier mesure environ **224,23 Mo** après intervention ; les autres données et sauvegardes ont été conservées.

### Diagnostic du seuil

L’audit antérieur de 15 693 fragments n’est pas reproduit : l’API native `table.stats()` indique **182 fragments actifs**, **24 484 404 octets actifs**, mais **78 611 fichiers** et 11,11 Go physiques avant nettoyage. Ne pas confondre fragments actifs et fichiers des anciennes versions ; l’état a aussi pu évoluer depuis cet audit.

Deux défauts sont établis dans le code :

- Le seuil de 1 000 n’était évalué qu’une fois au démarrage. Un import franchissant ce seuil ensuite n’était pas contrôlé.
- `cleanupOlderThan: new Date(0)` conserve toutes les versions postérieures à 1970. Une compaction peut donc réduire les fragments actifs sans libérer les anciennes versions. Le contrôle des seuls fragments ignore alors la consommation réelle du disque.

Aucune trace `LANCEDB_AUTO_COMPACT` n’a été trouvée dans le journal consulté. L’historique exact du chiffre 15 693 ne peut pas être établi à partir de ce journal.

Corrections : contrôle au démarrage puis toutes les cinq minutes ; déclenchement à **1 000 fragments**, ou lorsque la taille physique atteint **le maximum de 256 Mio et trois fois la taille active**. Nettoyage des versions obsolètes antérieures au début de l’opération, avec les protections natives conservées pour les fichiers de transactions non vérifiés. Les opérations simultanées partagent une promesse de compaction ; les erreurs et mesures sont journalisées.

Settings affichait déjà des statistiques, mais sa « taille » ne mesurait que la version active. Il affiche désormais l’espace physique et « Compacter maintenant », avec fragments, taille, nombre d’entrées avant/après et durée. Le délai de la requête a été porté à 15 minutes : l’ancien délai de 90 secondes était inférieur à la durée réelle mesurée.

## Professeur

Le code présent contenait déjà Groq, Gemini et OpenRouter, côté route et sélecteur. Les trois clés sont bien stockées dans `metadata.cloud_api_keys`, lues par le même `getCloudKeys()` que le routeur général. Le mode strictement local est **désactivé** dans la base réelle. L’endpoint actuel renvoie les trois sections configurées : le symptôme « seulement le local » n’a pas été reproduit avec cette version. Aucun serveur Cortex n’écoutait sur le port 3001 au début des vérifications ; une ancienne version en cours d’exécution ou en cache reste une hypothèse, pas un diagnostic confirmé.

Défauts corrigés :

- La liste cloud ne reste plus bloquée derrière un Ollama qui ne répond pas : découverte locale bornée à trois secondes.
- Une erreur de chargement ou une ancienne réponse sans section cloud donne une raison explicite.
- Le mode strict grise le cloud, tout en laissant sélectionner et valider un modèle local.
- Le modèle local dédié est réellement utilisé ; auparavant, l’exécution reprenait toujours le modèle du routeur.
- Gemini teste et utilise exactement le modèle choisi ; auparavant, le test utilisait le modèle par défaut et l’exécution une cascade.
- OpenRouter reste limité au modèle gratuit fixe du client partagé ; les autres identifiants sont refusés à la validation. Cette limite est indiquée dans le sélecteur.

Les trois intégrations réutilisent les clients existants. Les fournisseurs sans clé gardent leurs sections grisées avec « Aucune clé configurée — Settings > Modèles ». La sélection reste testée avant enregistrement.

### Appels réels

Tests sur un sujet générique (« Comprendre les fractions simples »), avec clés existantes, réglages et parcours dans une **base SQLite en mémoire**. Aucun réglage ou parcours de production modifié.

| Fournisseur et modèle | Validation | Plan | Première explication |
|---|---|---|---|
| Groq `openai/gpt-oss-120b` | Réussie | 6 étapes, HTTP 201 | HTTP 200, 1 675 caractères |
| Gemini `gemini-3.1-flash-lite` | Réussie | 6 étapes, HTTP 201 | HTTP 200, 1 148 caractères |
| OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` | Réussie | 6 étapes, HTTP 201 | Échec explicite HTTP 503 : réponse vide du fournisseur |

**OpenRouter n’est donc pas validé de bout en bout.** L’interface explique qu’un test court réussi ne garantit pas une réponse longue et qu’une réponse vide sera signalée sans changement silencieux de modèle. Les autres modèles du catalogue n’ont pas tous fait l’objet d’un appel réel. Révisions espacées et progression complète du parcours restent à valider.

## Roadmap

Inventaire vérifié par les routes montées dans `server.js`, les appels du client et les composants/hooks appelés par `App.tsx`. Points examinés : capture/vidéo, recherche/RAG, candidature, agents et planificateur, OCR/voix/gestes, Kiwix, sauvegardes, confidentialité et interface.

La résolution Kiwix `.meta4` vers `.zim` est déjà branchée : l’ancienne note disant le contraire a été retirée. L’import de rapports d’agents par dossier surveillé était également déjà branché et ne figure plus comme travail futur.

La présence de code ne vaut pas validation d’usage. Les fonctions sans preuve suffisante de validation réelle sont en **EN COURS**, sans affirmer qu’elles n’ont jamais été testées par quiconque. **FAIT** contient les validations réelles de cette intervention. Professeur détaille les succès Groq/Gemini et la limite OpenRouter. Les huit décisions écartées demandées sont présentes avec leurs raisons.

Structure éditable en haut du composant, domaines regroupés, trois colonnes colorées sur ordinateur, une colonne sur mobile, décisions écartées sur toute la largeur.

## Vérifications

- `node cortex-server/test-maintenance.mjs` : assertions réussies sur le déclenchement par fragments/espace obsolète, absence de clés, mode strict, refus d’un modèle OpenRouter non pris en charge, respect du modèle local et Gemini sélectionné. Les appels de ces régressions sont simulés ; `--live` active explicitement les tests réels.
- Chromium/Playwright : trois sections cloud, raisons et désactivation, ordre validation puis enregistrement, sélection locale possible en mode strict, Roadmap trois colonnes / une colonne à 390 px, décisions écartées présentes ; aucune erreur JavaScript dans le test final. Les réponses API de ce test d’interface sont simulées.
- `npx tsc --noEmit` : propre.
- Vérification de syntaxe Node des fichiers serveur modifiés et `git diff --check` : propres.

Les nouveaux contrôles périodiques doivent encore être observés sur un cycle prolongé d’utilisation. Redémarrer Docteur pour charger les modifications du serveur.
