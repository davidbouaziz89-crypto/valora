# VALORA — procédure de mise en ligne (jour J)

État au 19/11/2026 : **rien n'est en production.** Tout est prêt et vérifié sur bancs locaux.
Chaque étape « base » ou « serveur » se fait **seulement avec le GO de David**, **une seule
conversation à la fois** sur le serveur, sous le **verrou de déploiement**.

| Élément | Où | État |
|---|---|---|
| Appli VALORA | `~/projects/valora` (`main`), GitHub privé | prête, non publiée |
| Zeste sans Prêts/Or | `~/projects/zeste`, branche `separation-valora` | prête, non publiée (`main` = 4ab662a inchangé) |
| Schéma `valora` | `sql/valora-setup.sql` | non appliqué |
| Copie des prêts | `sql/valora-import-prets.sql` | non appliquée |
| Estimation des montres | `supabase/functions/valora-montre-cote/` | non installée |
| Or | tables `zeste.or_*` + fonction `zeste-or-cours` | **déjà en production, rien à faire** |

## Vérifications faites le 19/11/2026 (avant le GO)

| Point | Comment | Résultat |
|---|---|---|
| Sauvegarde | `sauvegarde-zeste.sh` sur le serveur (lecture seule) → `~/sauvegardes/zeste-20261119-195125` ; rechargée par `verifier-sauvegarde.mjs` | ✅ rechargée à l'identique (13/13 contrôles) |
| Prêts | `outils/verifier-copie-prets.mjs` sur une copie LOCALE de cette sauvegarde (copie supprimée ensuite) | ✅ tous les prêts et tous les remboursements, copie à l'identique, totaux € et ₪ identiques, rejeu sans doublon, retour arrière OK |
| Or | même copie, `tests/essai/deux-applis.mjs` + VRAIE cotation Swissquote | ✅ écran Or de VALORA identique ligne à ligne (71 lignes) à celui du Zeste en ligne ; lecture serveur identique avant/après |
| Séparation | même banc : Zeste (en ligne + nouvelle version) et VALORA sur la même origine | ✅ modif VALORA → Zeste intact ; modif Zeste → VALORA et prêts figés intacts ; sessions séparées (déconnexion de l'une sans effet sur l'autre) ; clés locales disjointes |
| Montres | appel RÉEL sur l'environnement de TEST (même image et même routeur que la prod) | ✅ Rolex 126610LN 14 483 € (6 relevés), Omega 310.30.42.50.01.002 6 277 € (7), Tudor M79030N 3 561 $ (4), référence inventée → « aucune donnée fiable » ; 16 à 45 s ; 0,14 à 0,51 $ |
| API réelle | environnement de TEST : RPC VALORA | ✅ refus sans connexion, cloisonnement entre comptes, conflit de version, quota réservé au serveur, tables non exposées, CORS |
| Production (lecture seule) | | clé Anthropic déjà présente dans le conteneur des fonctions ; routeur identique au test ; ni schéma ni fonction VALORA encore présents |

Environnement de test laissé avec : schéma `valora` + fonction `valora-montre-cote`, **sans clé** (retirée après l'essai).
Piège vu en test : `docker restart` ne relit pas `env_file` (il faut `docker compose up -d <service>`). En production
la clé est déjà dans le conteneur : **aucun redémarrage à faire**.

## Ordre (≈ 30 min)

0. **Contrôles avant** (lecture seule) : pas de schéma `valora` en prod ; `zeste.user_data` a bien
   `rev` ; nombre de prêts par compte (garder le chiffre). Sauvegarde : `outils/sauvegarde-zeste.sh`
   du dépôt Zeste (sur le serveur), puis répétition complète sur une copie locale de CETTE sauvegarde :
   `PGLITE_DIR=… node outils/verifier-copie-prets.mjs <dossier>` (doit finir par ✅ ; supprimer la copie ensuite).
1. **Base** : `sql/valora-setup.sql` — d'abord `BEGIN … ROLLBACK` (répétition), puis pour de vrai.
   Vérification : requêtes en bas du fichier. Sans effet sur Zeste (nouveau schéma, nouvelles fonctions).
2. **Fonction d'estimation** : copier `index.ts` ET `logique.ts` dans
   `/opt/supabase/volumes/functions/valora-montre-cote/` (aucun redémarrage : nouvelle fonction prise
   immédiatement ; clé déjà présente, SDK `npm:` et durée validés en test le 19/11).
   **Un appel réel** sur une montre connue (≈ 0,25 $) depuis VALORA une fois publiée.
3. **Publication de VALORA** (GO David : publication sur un domaine) — proposition : GitHub Pages
   comme Zeste → dépôt `valora` passé en public + Pages sur `main` →
   `https://davidbouaziz89-crypto.github.io/valora/`. (Même domaine que Zeste : sans conséquence,
   clés locales et session séparées `valora_*` / `valora-auth`, service worker limité à `/valora/`.)
4. **Publication de Zeste sans Prêts/Or** : fusion de `separation-valora` dans `main`, push.
5. **Juste après : copie des prêts** — `sql/valora-import-prets.sql`, puis le contrôle en bas du
   fichier : **0 ligne attendue** + totaux par compte et par devise identiques Zeste / VALORA.
   La copie est **rejouable** : la relancer le lendemain rattrape un prêt saisi entre-temps sur un
   téléphone resté sur l'ancienne version de Zeste (un prêt déjà présent dans VALORA n'est jamais écrasé).
6. **Sur l'iPhone de David** : ouvrir l'adresse de VALORA dans Safari → Partager → « Sur l'écran
   d'accueil » ; se connecter avec l'identifiant habituel ; vérifier Prêts (mêmes soldes que Zeste
   avant), Or (mêmes pièces), créer un coffre, ajouter une montre avec photo, lancer une estimation.
   Rouvrir Zeste : plus d'onglets Prêts/Or, tâches et films intacts.

## Retours arrière
- Zeste : republier `main` = 4ab662a (les prêts n'ont jamais quitté la sauvegarde de Zeste → ils
  réapparaissent tels qu'au jour J). ⚠️ Les modifications faites ensuite dans VALORA n'y sont pas.
- VALORA appli : dépublier (Pages désactivé). Données conservées en base.
- VALORA base : `sql/valora-setup-retour.sql` — ⛔ efface coffres, montres, photos et prêts copiés ;
  seulement si VALORA n'a pas servi, sinon `outils/sauvegarde-valora.sh` d'abord.
- Fonction : supprimer le dossier `valora-montre-cote`.

## Coûts
Estimation d'une montre ≈ 0,25 $ (0,15 à 0,40 $, pire cas rare ≈ 2 $). Plafond : 20/jour/compte,
300/mois au total (≈ 45 à 120 $ au maximum si le plafond était atteint). Aucun abonnement.
