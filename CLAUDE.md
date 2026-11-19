# VALORA 💎 — Prêts, Or, Coffres, Montres (PWA personnelle)

Appli perso de David, **séparée de Zeste le 19/11/2026** : Zeste garde les tâches, les courses et
les films ; VALORA reprend les **Prêts** et l'**Or** de Zeste (code identique) et ajoute les
**Coffres** et les **Montres**. Dépôt : `~/projects/valora` (GitHub `davidbouaziz89-crypto/valora`,
privé tant que rien n'est publié). ⚠️ Pas un logiciel du portail de gestion.

## Nature du projet

Même nature que Zeste : **une seule page `index.html` autonome, sans build**, vanilla JS,
`supabase-js` par CDN. **N'introduis jamais d'étape de compilation.**

| Fichier | Rôle |
|---|---|
| `index.html` | toute l'appli (4 onglets) |
| `sw.js` | service worker (hors-ligne) — **incrémenter `CACHE` à chaque publication** |
| `manifest.json`, `icon-*.png`, `apple-touch-icon.png`, `favicon-32.png`, `icon-src.html` | installation PWA (icône 💎 générée depuis `icon-src.html` par Chrome headless) |
| `sql/valora-setup.sql` (+ `-retour`) | schéma `valora` : état synchronisé, photos, quota des estimations |
| `sql/valora-import-prets.sql` | copie des prêts de Zeste vers VALORA (jamais de déplacement, rejouable) |
| `supabase/functions/valora-montre-cote/` | estimation de la valeur des montres (Claude + recherche web, contrôles anti-invention, BCE) |
| `outils/sauvegarde-valora.sh` | sauvegarde lecture seule du schéma `valora` (sur le serveur) |
| `MISE-EN-LIGNE.md` | procédure du jour J (rien n'est en production au 19/11/2026) |
| `tests/` | bancs (voir plus bas) |

### Origine du code
`index.html` a été construit le 19/11/2026 à partir du `index.html` de Zeste (`main` = 4ab662a) :
styles, module Prêts, formulaire de prêt, synchro (numéro de version, conflits, copies de secours)
et **tout le script de l'onglet Or** repris **à l'identique**, seules les clés locales
(`valora`, `valora_*`, `valora_or_*`) et les fonctions de synchro (`valora_*`) changent.
Une correction faite dans Prêts ou Or de VALORA ne concerne plus Zeste (qui ne les a plus).

## Données

- **Prêts, Coffres, Montres** : `valora.user_data` (une ligne par compte, tout l'état en jsonb, `rev`
  anti-écrasement), accès UNIQUEMENT par `valora_load_mine` / `valora_save_mine` / `valora_rev_mine`
  (security definer, `auth.uid()`). RLS activée **sans aucune policy** : volontaire.
- Format des prêts **identique à Zeste** (`debts`), contrôle serveur des remboursements identique
  (`valora.verif_remboursements` = copie de `zeste.verif_remboursements`).
- Coffres : `coffres[] = {id, nom, items[]}`, élément = `{type:'objet', nom, qte, valeurC|null, cur, photo}`
  ou `{type:'enveloppe', nom, montantC, cur}`. Montres : `{marque, modele, ref, prixC|null, cur,
  dateAchat, photo, cote}` ; `cote = {valeurC, cur, methode:'auto'|'manuel', source, date, …}`.
  **Montants en centimes entiers ; devises EUR/USD/ILS jamais additionnées entre elles.**
- **Photos** : `valora.photos` (JPEG base64 ≤ 450 Ko, identifiant uuid choisi par l'appareil),
  copie locale IndexedDB `valora-photos`, envoi différé si hors connexion.
- **Or : PAS dans le schéma valora.** L'onglet Or utilise les tables `zeste.or_*`, les fonctions
  `zeste_or_*` et l'edge function `zeste-or-cours` **déjà en production** (dépôt Zeste) : choix du
  19/11/2026 pour ne rien copier ni déplacer (aucun risque pour les achats, ventes, historique).
  ⚠️ Ne jamais supprimer ces objets en pensant « nettoyer Zeste » : ils appartiennent à VALORA.

## Estimation des montres
`valora-montre-cote` : Claude Opus 5.5 + recherche web, puis contrôles côté serveur — URL du relevé
présente dans les résultats de recherche (sinon rejeté), même référence, ≤ 18 mois, conversion au
taux BCE (jamais de taux inventé), **valeur = médiane calculée par le code**, fiable seulement avec
≥ 2 relevés de 2 pages distinctes et un écart max/min ≤ 3. Sinon « pas d'estimation fiable » et
saisie manuelle proposée. Quota : 20/jour/compte, 300/mois au total. Coût ≈ 0,25 $ par estimation.

## Vérifier son travail
```bash
~/.bun/bin/bun build index.html --outdir /tmp/x        # syntaxe
node --experimental-strip-types --test tests/montres/cote.test.mjs
PGLITE_DIR=… node --test tests/sql/valora.test.mjs     # pglite 0.5.9 installé HORS du dépôt
PGLITE_DIR=… node --experimental-strip-types tests/essai/serveur-essai.mjs 8777   # appli complète en local
```
Les bancs SQL et d'essai chargent la chaîne de production de Zeste depuis `~/projects/zeste`
(`ZESTE_DIR` pour un autre chemin). Le banc d'essai utilise la VRAIE fonction du cours de l'or et la
VRAIE fonction d'estimation, branchées sur de faux Swissquote / Claude / BCE (valeurs marquées FICTIF).

Puis contrôle **sur iPhone** (installation PWA, clavier, photo prise avec l'appareil).

## Règles
Mêmes règles de travail que Zeste (voir `~/projects/zeste/CLAUDE.md`, section « Règles de travail ») :
français partout, plan avant une tâche non triviale, rien de publié / déployé / supprimé sans
l'accord de David, commit + push après chaque modification.
