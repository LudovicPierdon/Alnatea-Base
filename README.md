# alnatea-base

Scripts Alnatea qui pilotent Base (BaseLinker) et tournent sur GitHub Actions.

- `commandes/commande-fournisseur.mjs` : commande fournisseur automatique en flux tendu (voir l'en-tête du fichier). Planifié toutes les 30 minutes par `.github/workflows/commande-fournisseur.yml`.
- `lib/baselinker.mjs`, `lib/env.mjs` : accès à l'API Base. Le jeton vient du secret de dépôt `BASELINKER_TOKEN` (en local, du fichier `acces\.env` du hub).

Ce dépôt est une vue partielle du dossier `Mon Drive\Claude\Alnatea\Site Shopify` (voir `.gitignore`).
