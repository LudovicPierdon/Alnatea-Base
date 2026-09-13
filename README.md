# alnatea-base

Scripts Alnatea qui pilotent Base (BaseLinker) et tournent sur GitHub Actions (PC éteint ou non). Chaque script est
indépendant, simule par défaut et n'écrit dans Base qu'avec `--appliquer`. Les trois se succèdent chaque demi-heure
dans le même groupe de concurrence (jamais deux à la fois) :

| Heure | Script | Rôle | Variable de dépôt (arguments planifiés) |
|---|---|---|---|
| :00 / :30 | `commandes/commande-fournisseur.mjs` | Prépare les brouillons de bons de commande fournisseur pour les nouvelles commandes clients (flux tendu), retire les annulations, trace dans le champ « QT ajouté ». | `ARGUMENTS_PLANIFIES` |
| :05 / :35 | `commandes/reception-partielle.mjs` | Lignes non livrées par le fournisseur : recommandées une fois, puis isolées pour remboursement (commande « A rembourser »). | `ARGUMENTS_RECEPTION_PARTIELLE` |
| :15 / :45 | `commandes/stock-check.mjs` | Passe en « En stock » les commandes « En attente de réception » entièrement couvertes par le stock. | `ARGUMENTS_STOCK_CHECK` |

Réglages GitHub (Settings → Secrets and variables → Actions) : secret `BASELINKER_TOKEN` (jeton API Base) ; variables
ci-dessus vides = simulation, `--appliquer` = écriture. Lancement manuel : onglet Actions → « Run workflow » avec des
arguments libres (`--commande=ID`, `--jours=N`, `--rattrapage`…). L'en-tête de chaque script décrit sa règle et ses options.

`commandes/lib-commandes.mjs` : lecture des commandes, bons de commande, produits, trace, écritures communes.
`lib/baselinker.mjs`, `lib/env.mjs` : accès à l'API Base. En local, le jeton vient du fichier `acces\.env` du hub.

Ce dépôt est une vue partielle du dossier `Mon Drive\Claude\Alnatea\Site Shopify` (voir `.gitignore`).
