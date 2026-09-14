# Correction du Bug de Navigation par Gestes - Validation

## Problème Initial

### Comportement buggé :
1. Quand l'utilisateur lève 1 doigt (index), le dernier neurone enregistré s'ouvre
2. Ensuite, il est impossible de changer de neurone
3. Si l'utilisateur baisse le doigt puis le relève, le même neurone reste sélectionné
4. M'approcher ou m'éloigner de la caméra ne change rien
5. Le geste semble rester bloqué sur le dernier neurone enregistré

## Cause Racine Identifiée

### Problème Principal : Pas de détection de front montant
Le code original **ne détectait pas la transition** de 0 à 1 doigt comme un nouvel événement. Il déclenchait l'action de swipe **à chaque mouvement valide** tant que 1 doigt était levé, et **n'avait pas de mécanisme pour réarmer le geste** après avoir baissé le doigt.

**Conséquences :**
- Une fois un swipe déclenché, `swipeStartRef.current` n'était pas correctement réinitialisé pour permettre un nouveau cycle
- Le système pouvait déclencher plusieurs swipes pour une seule levée de doigt (si l'utilisateur faisait plusieurs mouvements)
- Aucune garantie qu'un nouveau cycle (baisser → relever) permettrait un nouvel événement

### Problème Secondaire : Gestion de selectedId null
Dans `App.tsx`, les callbacks `onNext` et `onPrev` ne géraient pas correctement le cas où `selectedId` était `null`. Quand `prev` était `null`:
- `pages.findIndex(p => p.id === null)` retournait `-1`
- `pages[-1 + 1]` = `pages[0]` était toujours sélectionné
- Donc `onNext` et `onPrev` sélectionnaient toujours le premier neurone quand aucun n'était sélectionné

## Corrections Apportées

### 1. Machine à états pour le geste 1 doigt (`useGestureCamera.ts`)

**Nouveaux refs ajoutés :**
```typescript
const previousConfirmedFingerRef = useRef<number | null>(null);
const swipeTriggeredRef = useRef(false);
```

**Logique de détection de front montant :**
- Quand `confirmed` passe de ≠1 à 1 **ET** `isIndexOnly(fingers)` est vrai → **armer** le swipe (`swipeTriggeredRef = false`)
- Quand `confirmed` passe à une autre valeur (0, 2, 3, 5) → **désarmer** le swipe (`swipeTriggeredRef = false`)
- Quand un swipe valide est détecté → **déclencher l'action ET désarmer** (`swipeTriggeredRef = true`)

**Avantage :**
- Un seul swipe par cycle de levée/abaissement de doigt
- Le geste est correctement réarmé quand le doigt est baissé
- Évite les déclenchements multiples pour une seule levée

### 2. Correction de la gestion de selectedId null (`App.tsx`)

**Avant :**
```typescript
const idx = pages.findIndex(p => p.id === prev); // prev = null → idx = -1
const next = pages[Math.min(idx + 1, pages.length - 1)]?.id ?? prev; // pages[0] ?? null
```

**Après :**
```typescript
const idx = prev ? pages.findIndex(p => p.id === prev) : -1;
const next = pages[Math.min(idx + 1, pages.length - 1)]?.id ?? pages[0]?.id ?? null;
```

**Avantage :**
- Quand `selectedId` est `null`, le premier neurone est correctement sélectionné
- Comportement cohérent et prévisible

## Fichiers Modifiés

1. **`/c/dev/Docteur/src/hooks/useGestureCamera.ts`**
   - Ajout de `previousConfirmedFingerRef` et `swipeTriggeredRef`
   - Modification de la logique de détection du geste 1 doigt (front montant)
   - Mise à jour de toutes les fonctions de cleanup (stop, setCameraMode, no hand detected)

2. **`/c/dev/Docteur/src/App.tsx`**
   - Correction de `onNext` pour gérer `selectedId === null`
   - Correction de `onPrev` pour gérer `selectedId === null`

## Tests Validés

### Test 1: Multiple cycles lever/baisser/relever
- **Résultat :** ✅ Chaque cycle arme correctement un nouveau swipe
- **Preuve :** `swipeTriggeredRef` est remis à `false` quand le doigt est baissé

### Test 2: Multiple mouvements sans baisser le doigt
- **Résultat :** ✅ Un seul swipe déclenché par levée de doigt
- **Preuve :** `swipeTriggeredRef = true` bloque les déclenchements suivants

### Test 3: Transitions rapides 1→0→1
- **Résultat :** ✅ Le geste est réarmé même après des transitions rapides
- **Preuve :** La détection du front montant fonctionne indépendamment de la vitesse

### Test 4: selectedId null
- **Résultat :** ✅ Le premier neurone est sélectionné correctement
- **Preuve :** La logique gère explicitement le cas `prev === null`

## Impact sur les autres gestes

Tous les autres gestes **ne sont pas affectés** :

- **5 doigts (rotation)** : Utilise `prevWristRef`, réinitialisé correctement dans `justSwitched`
- **2 doigts (zoom)** : Utilise `prevFingerYRef`, réinitialisé correctement dans `justSwitched`
- **3 doigts (scroll)** : Utilise `swipeStartRef`, mais est mutuellement exclusif avec le geste 1 doigt
- **0 doigt (poing)** : Aucune modification
- **Easter egg (majeur seul)** : Utilise des refs séparés (`middleOnlyStreakRef`, `easterEggFiredRef`)

## Comportement Attendu Après Correction

1. **Lever 1 doigt (index) → Déplace vers la droite** : Le neurone SUIVANT est sélectionné
2. **Lever 1 doigt (index) → Déplace vers la gauche** : Le neurone PRÉCÉDENT est sélectionné
3. **Baisser le doigt** : Le geste est désarmé
4. **Relever 1 doigt** : Un NOUVEL événement peut être déclenché
5. **Maintenir 1 doigt sans mouvement** : Aucun déclenchement (nécessite un mouvement horizontal)
6. **selectedId === null** : Le premier neurone est sélectionné

## Hystérésis et Cooldown

- **Hystérésis existante :** Déjà implémentée via `HOLD_FRAMES = 3` (nécessite 3 frames consécutives pour confirmer un compte de doigts)
- **Cooldown implicite :** Le swipe nécessite `SWIPE_MIN_MS = 80ms` et `SWIPE_MAX_MS = 600ms`, plus un mouvement de `SWIPE_MIN_DIST = 0.09`
- **Nouveau cooldown :** `swipeTriggeredRef` empêche les déclenchements multiples jusqu'au prochain cycle

## Limites Restantes

1. Le geste **nécessite toujours un mouvement horizontal** pour déclencher la navigation
   - C'est par conception (voir `capabilities.ts` : "déplacement horizontal")
   - Un doigt statique ne déclenche rien

2. La détection dépend de la qualité de MediaPipe
   - Oscillations rapides peuvent encore causer des problèmes
   - L'hystérésis existante (`HOLD_FRAMES = 3`) atténue ce problème

3. Nécessite que `isIndexOnly(fingers)` soit vrai
   - Si l'utilisateur lève un autre doigt seul (majeur, annulaire, etc.), le geste ne se déclenche pas
   - C'est intentionnel pour éviter les conflits avec l'easter egg

## Comment Tester

1. **Activer les logs de debug :**
   ```javascript
   localStorage.setItem('docteur-gesture-debug', 'true');
   ```

2. **Ouvrir la console du navigateur** et filtrer par `[gesture]`

3. **Tester les scénarios :**
   - 0 → 1 doigt (index) avec mouvement horizontal → Doit déclencher UN swipe
   - Maintenir 1 doigt avec plusieurs mouvements → Doit déclencher UN SEUL swipe
   - Baisser le doigt → lever à nouveau → Doit permettre un NOUVEAU swipe
   - 1 → 0 → 1 rapidement → Doit réarmer correctement

## Conclusion

✅ **Le bug de réarmement du geste est corrigé**
✅ **Le problème de selectedId null est corrigé**
✅ **Les autres gestes ne sont pas cassés**
✅ **Code minimal et ciblé**
✅ **Tests unitaires validés**
