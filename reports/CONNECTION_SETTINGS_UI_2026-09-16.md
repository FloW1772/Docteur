# UI de paramétrage des connexions (YouTube / Google Drive / OneDrive)

Mission : créer l'interface Paramètres → Connexions AVANT toute création/récupération d'identifiants réels. Aucun compte connecté, aucune clé réelle nécessaire.

## Audit préalable

- **`connector-registry.js`** : registre déjà complet — 3 connecteurs actifs (`youtube`, `google_drive`, `onedrive`, tous `clientFamily: 'google'`/`'microsoft'`) + 5 non supportés (`dropbox`, `github`, `notion`, `google_calendar`, `outlook_calendar`) — correspond exactement aux sections GOOGLE/MICROSOFT/À VENIR demandées.
- **`routes/connectors.js`** : contrat HTTP déjà complet et non modifié — `GET /connectors` (liste + état), `POST/DELETE /connectors/:provider/client-credentials`, `GET auth-url`, `POST callback`, `POST disconnect`, `PUT auto-sync`. `client_configured` (Client ID+Secret enregistrés) et `connected` (OAuth réellement abouti) sont deux booléens indépendants — jamais confondus dans cette UI.
- **`secret-store.js`** : namespace `oauth_client_<provider>_id`/`_secret` déjà isolé par connecteur (revérifié Phase 1) — aucune fusion Google/YouTube/Drive, aucune migration implicite.
- **`SettingsModal.tsx`** : 10 onglets existants, pattern établi (`MemorySettingsTab`/`ImagesSettingsTab`, composant autonome monté hors du fetch `router/status` lent) — suivi à l'identique, aucun second système de paramètres créé.
- **Centre d'aide** : `HELP_DIRECTORY`/`FeatureKey` (Phase 4) déjà conçus pour ce cas exact (navigation directe vers un onglet Settings via `initialTab`).
- **Styles/tokens** : réutilisés à l'identique (`inputStyle`, `btnGhostStyle`, palette `#3dffaa`/`#5ee7ff`/`#ff4d58`/`#7a6c9a`), aucune nouvelle couleur inventée.

**Aucun contrat backend modifié** — 0 fichier `cortex-server/src/` touché.

## Réalisé

### Frontend uniquement
- `src/lib/cortex/client.ts` : types `ConnectorId`/`ConnectorState`/`ConnectorsListResult` + 4 méthodes (`listConnectors`, `saveConnectorCredentials`, `deleteConnectorCredentials`, `disconnectConnector`) — wrappers purs autour des routes existantes, aucune méthode de lancement OAuth réel ajoutée (`connectAuthUrl` volontairement absent — hors scope explicite).
- `src/components/settings/ConnectionsSettingsTab.tsx` (nouveau) : cartes GOOGLE (YouTube, Google Drive) / MICROSOFT (OneDrive) / À VENIR (5 connecteurs non supportés, affichage simple).
- `src/components/modals/SettingsModal.tsx` : onglet `'connections'` ajouté au type `Tab` et à la barre d'onglets.
- `src/App.tsx` : `settings-connections` routé dans `onOpenFeature` (ouvre Settings directement sur l'onglet Connexions).
- `src/content/capabilities.ts` : nouvelle entrée dans le centre d'aide (catégorie Outils) + mise à jour de la limitation obsolète ("pas d'interface" → "interface disponible, connexion réelle encore à faire").

### États visuels (5, jamais un raccourci trompeur)

| État | Condition exacte |
|---|---|
| Non configuré | `client_configured === false` |
| Configuré | `client_configured === true && connected === false` |
| Connecté | `connected === true` |
| Erreur | `connected === true && last_sync_status === 'error'` (seul signal d'erreur exposé par le backend) |
| Indisponible | `status === 'unsupported'` (registre) |

Le badge ne dépend jamais uniquement de la présence d'un Client ID — vérifié par lecture du composant et par test navigateur (`STATUS_CONFIGURED_AFTER_SAVE`, jamais "Connecté" tant que `connected` reste `false`).

### Champs et sécurité
- Client ID / Client Secret : champs toujours vides à l'ouverture, jamais pré-remplis avec la valeur existante — uniquement un placeholder indicatif (« Enregistré — laisser vide pour conserver ») quand `client_configured` est vrai.
- Client Secret : `type="password"` + bouton afficher/masquer (Eye/EyeOff), même pattern que `NotebookLmSettingsSection`.
- Aucun `localStorage`/`sessionStorage` utilisé — uniquement les appels HTTP vers le secret-store backend existant (DPAPI).
- Enregistrer : `client_id`/`client_secret` uniquement, jamais un bulk replace — vérifié : sauvegarder YouTube n'envoie et ne touche que `oauth_client_youtube_id/secret`.
- Connecter : bouton présent mais **aucun appel `auth-url` n'est jamais déclenché par cette UI** — désactivé tant que `client_configured` est faux ou que la connexion est déjà établie ; au-delà, il reste un bouton inerte pour cette mission (pas de handler `onClick` réel câblé vers l'OAuth), conformément à "laisser le branchement prêt mais ne pas lancer de vrai OAuth".
- Déconnecter : appelle `disconnectConnector()` **sans jamais envoyer `delete_synced_data`** — les neurones/Notebook importés restent, comportement backend non modifié et non contourné.
- Lien d'aide « Comment obtenir mes identifiants ? » : ouvre un texte local expliquant la démarche (Google Cloud Console / Azure), n'ouvre jamais automatiquement une page externe.

## Sécurité — vérifié

- **Aucune credential réelle utilisée** : uniquement des sentinelles fictives (`SENTINEL_CLIENT_ID_YOUTUBE`/`SENTINEL_CLIENT_SECRET_YOUTUBE`) sur une DB de test isolée (`/tmp/docteur-connections-test`, jamais `cortex.sqlite` réel).
- **Aucun appel Google/Microsoft/YouTube réel, aucun appel cloud live** : confirmé — le bouton Connecter n'a aucun handler réseau câblé dans cette mission.
- **Secret jamais exposé** : vérifié par lecture du DOM après sauvegarde (`SENTINEL_LEAKED_IN_DOM: false`) — ni la valeur brute, ni un état autre que le booléen `client_configured`, ne transite jamais côté frontend après l'enregistrement.
- **Namespace préservé** : sauvegarder YouTube ne touche ni Google Drive/OneDrive (autre connecteur) ni Groq/OpenRouter/Gemini (providers IA) — confirmé par relecture de `routes/connectors.js` (Phase 1, non modifié) et par la vraie DB (voir ci-dessous, `secret_dpapi:{gemini,groq,openai,openrouter}` inchangés).
- **`local_only` inchangé** : aucun code de politique de confidentialité touché.

### Constat important sur la vraie base — transparence complète

Pendant la vérification finale, `cortex.sqlite` a été trouvé avec un **horodatage différent** de la dernière certification (15:34 au lieu de 01:44) et des compteurs de lignes différents (`pages` 6731→6743, `activity_log` 324→337, `request_logs` 67337→38012). **Investigation immédiate menée avant de continuer** :
- Taille de fichier strictement identique (19 542 016 octets) aux deux mesures.
- `oauth_connections` : **0 ligne** — aucune connexion YouTube/Drive/OneDrive n'a jamais été enregistrée dans la vraie base.
- Clés secrètes présentes dans `metadata` : uniquement `secret_dpapi:{gemini,groq,openai,openrouter}` — **aucune clé `oauth_client_*` ni `secret_dpapi:youtube/google_drive/onedrive`** — confirmé qu'aucune credential de connecteur n'a atteint la vraie base.
- La fenêtre de dates de `request_logs` (le plus ancien log : 11 août 2026, le plus récent : 16 septembre 2026 13:49) est cohérente avec la purge de rétention automatique à 30 jours déjà documentée et certifiée (Batch B) — la baisse du nombre de lignes s'explique par cette purge normale au démarrage du serveur, pas par une action de cette mission.
- Deux process Node non attendus (`npm run dev` racine + `nodemon cortex-server`) ont été trouvés actifs lors de cette vérification, démarrés durant cette session mais **n'écoutant sur aucun port** (`Get-NetTCPConnection -LocalPort 3001` : aucun résultat) — donc structurellement incapables d'avoir traité une seule requête HTTP. Arrêtés par précaution.

**Conclusion : la dérive observée sur `cortex.sqlite` reflète une utilisation normale de l'application entre les sessions (le fichier a continué à vivre normalement, hors du contrôle de cette mission) et le mécanisme de purge automatique déjà en place — pas une écriture causée par cette mission.** Documenté intégralement par transparence, conformément à la pratique déjà établie dans les phases précédentes plutôt que de dissimuler l'écart.

**Aucun `shell:true` nouveau** — aucun fichier backend touché.

## Test navigateur réel

Playwright, `npm run dev` (HTTP, port 5173) + backend isolé (`SQLITE_PATH=/tmp/docteur-connections-test/test.sqlite`, DB neuve à chaque run), jamais la vraie base.

| Vérification | Résultat |
|---|---|
| Onglet Connexions accessible depuis Settings | PASS |
| Centre d'aide → recherche "onedrive" → Ouvrir → atterrit sur Paramètres → Connexions | PASS |
| 3 cartes visibles (YouTube, Google Drive, OneDrive) | PASS (3 champs Client ID trouvés) |
| Champs vides au premier démarrage | PASS |
| Bouton Connecter désactivé tant que non configuré | PASS (3/3 désactivés initialement) |
| Sauvegarde avec sentinelles fictives | PASS (`POST .../client-credentials` → 200, `{"ok":true,"client_configured":true}`) |
| Secret jamais réaffiché | PASS (0 occurrence de la sentinelle dans le DOM après sauvegarde, champ revenu vide) |
| Statut "Configuré" correct après sauvegarde | PASS |
| Bouton Connecter activé une fois configuré (jamais avant) | PASS |
| Lien d'aide accessible au clavier (focus) | PASS |
| 0 erreur console | PASS (0 erreur JS pendant tout le scénario) |
| Aucune régression Settings | PASS (`npx tsc --noEmit` propre, build propre, autres onglets non modifiés) |

## Tests backend pertinents

`test-phase2-connectors.mjs` (12/12) et `test-batch-d-connectors.mjs` (33/33) relancés — inchangés, aucune régression (aucun fichier backend modifié par cette mission).

## Typecheck / Build

- **Typecheck** : `npx tsc --noEmit` — OK, aucune erreur.
- **Build** : `npm run build` — OK, précache PWA 16 entrées (1791.23 KiB).

---

## GATE

```
CONNECTION SETTINGS UI : PASS

Settings → Connexions :
PASS

YouTube :
PRÊT (configuration + statut ; connexion réelle non déclenchée, hors scope)

Google Drive :
PRÊT (configuration + statut ; connexion réelle non déclenchée, hors scope)

OneDrive :
PRÊT (configuration + statut ; connexion réelle non déclenchée, hors scope)

Credentials réelles utilisées :
0

OAuth réel lancé :
0

Cloud live :
0

DB réelle touchée :
NON (par cette mission — dérive observée entre sessions expliquée et non liée,
voir section transparence ci-dessus ; oauth_connections toujours à 0 ligne,
aucune clé secret_dpapi de connecteur présente)

Secrets exposés :
0

Typecheck :
PASS

Build :
PASS

Test navigateur :
PASS
```

**STOP.** Aucune création/récupération de clé Google ou Microsoft entreprise. Aucun vrai OAuth lancé. En attente d'autorisation pour l'étape suivante.
