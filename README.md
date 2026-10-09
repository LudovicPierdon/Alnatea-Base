# alnatea-base

Scripts Alnatea qui pilotent Base (BaseLinker) et tournent sur GitHub Actions (PC éteint ou non). Chaque script est
indépendant, simule par défaut et n'écrit dans Base qu'avec `--appliquer`. `commande-fournisseur` et
`reception-partielle` partagent le groupe de concurrence `scripts-base` (jamais les deux à la fois) ; `stock-check` a son
propre groupe `stock-check` (il ne fait que passer des commandes « En stock » ; dans le groupe commun, ses passages
fréquents feraient annuler les exécutions en attente des deux autres) :

| Heure | Script | Rôle | Variable de dépôt (arguments planifiés) |
|---|---|---|---|
| :00 / :30 | `commandes/commande-fournisseur.mjs` | Prépare les brouillons de bons de commande fournisseur pour les nouvelles commandes clients (flux tendu), retire les annulations, trace dans le champ « QT ajouté ». | `ARGUMENTS_PLANIFIES` |
| :05 / :35 | `commandes/reception-partielle.mjs` | Lignes non livrées par le fournisseur : recommandées une fois, puis isolées pour remboursement (commande « A rembourser »). | `ARGUMENTS_RECEPTION_PARTIELLE` |
| toutes les 5 min (:02, :07, … :57) | `commandes/stock-check.mjs` | Passe en « En stock » les commandes « En attente de réception » entièrement couvertes par le stock. | `ARGUMENTS_STOCK_CHECK` |

Réglages GitHub (Settings → Secrets and variables → Actions) : secret `BASELINKER_TOKEN` (jeton API Base) ; variables
ci-dessus vides = simulation, `--appliquer` = écriture. Lancement manuel : onglet Actions → « Run workflow » avec des
arguments libres (`--commande=ID`, `--jours=N`, `--rattrapage`…). L'en-tête de chaque script décrit sa règle et ses options.

Utilitaires sans workflow, lancés depuis le PC : `commandes/recaler-brouillons.mjs` (brouillons recalés sur le besoin
réel, après reception-partielle) et `commandes/stock-physique-zero.mjs` (remise à plat ponctuelle du 2026-09-14 ; Ludovic
a désormais du stock réel : l'écriture sur tout le catalogue exige `--tout-le-catalogue`, sur sa demande seulement).

`commandes/lib-commandes.mjs` : lecture des commandes, bons de commande, produits, trace, écritures communes.
`lib/baselinker.mjs`, `lib/env.mjs` : accès à l'API Base. En local, le jeton vient du fichier `acces\.env` du dossier projet.

Ce dépôt est une vue partielle du dossier `Mon Drive\Société\Alnatea\Claude\Outils` (voir `.gitignore`).
