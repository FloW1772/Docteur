# SH-1 — Audit Sherlock avant installation

Audit initial terminé le 17 septembre 2026. Aucun import ni exécution de Sherlock effectué avant ce rapport. Sources téléchargées comme texte, sous external/Sherlock-source/<SHA>, avec inventaire SHA256 AUDIT_DOWNLOAD.json.

## Provenance et pin

- Canonique : https://github.com/sherlock-project/sherlock ; organisation sherlock-project ; site officiel https://sherlockproject.xyz.
- Licence MIT (LICENSE vérifiée ; SHA256 53873dd0c41a38676a1be819b10d5ae45f319d033c92723d77c85fdda587b88f).
- Dernière release interrogée via API officielle : v0.16.2, publiée le 2026-09-08 à 20:54:15 UTC.
- Pin exact du tag, vérifié par GET https://api.github.com/repos/sherlock-project/sherlock/git/ref/tags/v0.16.2 : **a38ba54fda799cd786a2ab67a50143e1a63169e6**, objet commit.
- Dernière activité de master observée via API lors de l'audit : 376018708c0f6948d3f978a9ae2915024e794654, 2026-09-09T18:47:35Z. Ce commit n'est PAS le pin de certification.
- La page web de l'historique servait une vue périmée d'août : les métadonnées API directes ont priorité.

## Code et packaging

pyproject.toml déclare Python ^3.9, Poetry Core comme backend et l'entrée CLI sherlock_project.sherlock:main. Le code contient des annotations utilisant les unions modernes : Python 3.10 sera utilisé. Dépendances déclarées : certifi, colorama, PySocks, requests, requests-futures, stem, pandas, openpyxl et tomli. Les contraintes amont sont larges ; elles ne constituent pas un lock reproductible. Un lock des wheels effectivement installées doit être produit avant certification.

Aucun hook custom d'installation ni code auto-modifiant repéré dans les sources runtime examinées. .github contient des workflows de maintenance ; .actor/actor.sh utilise Bash, substitutions et Apify ; Dockerfile installe via pip. Ces chemins de distribution ne seront ni exécutés ni exposés. Aucun privilège administrateur requis pour un venv dans le workspace.

## Surfaces identifiées

- sherlock.py : requests + requests-futures ; jusqu'à 20 workers. La base peut sélectionner GET, HEAD, POST ou PUT. V1 Docteur sera limitée à GET/HEAD et à un nombre borné de sites.
- sites.py : téléchargement par défaut depuis https://data.sherlockproject.xyz ; téléchargement d'exclusions depuis une branche flottante. CLI : requête automatique de version et option de base distante/PR. Ces chemins seront exclus du runner Docteur.
- Redirects autorisés par défaut pour certaines méthodes de détection ; aucun filtrage localhost/LAN/metadata présent. Le réseau devra appartenir à Docteur, avec validation DNS et connexion à l'adresse validée à chaque saut.
- Filesystem : exports texte/CSV/XLSX et répertoires de sortie depuis main(). Le runner n'appellera pas main() ; résultats structurés sur stdio uniquement.
- notify.py : webbrowser.open est accessible via QueryNotifyPrint/browse. Le runner utilisera un notifier contrôlé, sans navigateur.
- Aucun subprocess/os.system/eval/exec trouvé dans les fichiers runtime inspectés. Les dépendances et la bibliothèque standard restent une surface : interdiction dynamique des créations de processus et sockets côté enfant prévue.
- Pas de SDK de télémétrie identifié dans le runtime inspecté. La vérification de version est néanmoins un appel réseau implicite, exclu du runner.
- Les résultats upstream peuvent conserver response_text : ce HTML ne sera pas exposé ni transmis aux agents.

## Base de sites

Provenance : sherlock_project/resources/data.json au SHA exact ci-dessus.
SHA256 : **3fdfc6694c5cd99798881215554b09e617c6d5284a6219fae309882566a9fb30**.
Taille : 104039 octets. Acquisition : 2026-09-17.
Aucun refresh automatique autorisé. Toute mise à jour implique nouveau pin, nouvel audit, nouveau hash et relance des tests avant activation.

## État de l'intégration Docteur préexistante

lib/sherlock.js utilise PATH pour sherlock/pipx, hérite de process.env, ne fixe ni cwd ni HOME et concatène les sorties sans plafond. Validation actuelle accepte --help et tronque les espaces par trim. Pas de filtrage réseau ni des URLs parsées. Annulation child.kill sans garantie sur descendants. Routes locales Sherlock sans leurs propres gardes loopback/origin/JSON. Ces insuffisances interdisent de certifier l'intégration existante.

## Modèle de menace et décision

Composant réseau non fiable ; username, base de sites, réponses HTTP et résultats restent des données. Docteur valide l'identité de chaque site et construit toutes les requêtes. Le child n'aura aucun socket ; ses demandes HTTP passent par un broker Docteur, sans cookies, secrets, proxy hérité ni URL libre fournie par l'API. HOME/TEMP sont dédiés, les writes confinés au job. Les redirections, IP privées, IPv4-mapped IPv6, link-local et metadata seront refusées.

SH-1 : **PASS pour poursuivre l'implémentation isolée**. Pas de provenance ambiguë, dépendance manifestement malveillante, automodification inattendue ou besoin admin identifié. Ceci ne certifie pas encore le runtime ni les dépendances transitives ; ces contrôles et le lock restent requis avant SH-15.
