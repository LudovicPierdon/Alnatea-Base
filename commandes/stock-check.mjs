// Stock check — remplace l'add-on prestataire « Stock Check ».
// Passe en « En stock » (146726) les commandes clients « En attente de réception » (146725) dont toutes les lignes
// sont couvertes par le stock. Ne touche à rien d'autre : ni bons de commande (commande-fournisseur.mjs), ni
// échecs de réception (reception-partielle.mjs).
//
// Règle : le stock Base est net des réservations (négatif = manquant). Pour chaque produit, le manquant
// (max(0, −stock)) est attribué aux lignes des commandes en attente les plus récentes d'abord : les plus
// anciennes sont servies en premier, quelle que soit l'origine du manquant (celle-ci relève de reception-partielle.mjs).
// Une commande dont aucune ligne n'absorbe de manquant est couverte → « En stock ». Les commandes en cours de
// traitement (Nouvelles, Mis en expédier, En stock) ne sont jamais considérées comme manquantes.
// Une commande contenant une ligne non liée au catalogue n'est pas déplacée (impossible de juger).
//
// Usage : node commandes/stock-check.mjs [--appliquer] [--jours=30] [--commande=ID]
//   sans option     simulation : affiche les commandes qui passeraient en stock, n'écrit rien
//   --appliquer     change réellement les statuts dans Base
//   --jours=N       fenêtre de lecture des commandes clients (défaut 30 jours)
//   --commande=ID   ne traite que cette commande client
// Journal : commandes/journal/stock-check-AAAA-MM.log
import { ST, options, creerJournal, chargerCommandes, resumeStatuts, chargerProduits, produitsDesCommandes, ecritures, bilan } from "./lib-commandes.mjs";

const { APPLIQUER, JOURS, SEULE } = options();
const log = creerJournal("stock-check", APPLIQUER);
console.log(`Stock check — ${APPLIQUER ? "ÉCRITURE DANS BASE" : "simulation (rien n'est écrit)"} — fenêtre ${JOURS} j${SEULE ? ` — commande ${SEULE}` : ""}`);

const commandes = await chargerCommandes(JOURS);
console.log(`commandes confirmées lues : ${commandes.size} — ${resumeStatuts(commandes)}`);
const { infoProduit } = await chargerProduits(produitsDesCommandes(commandes), {});
const E = ecritures({ APPLIQUER, log, bons: null });

const enAttente = [...commandes.values()].filter((o) => o.order_status_id === ST.ATTENTE && (!SEULE || o.order_id === SEULE));
console.log(`\ncommandes en attente de réception : ${enAttente.length}`);

// Lignes candidates par produit ; le manquant est absorbé par les commandes les plus récentes.
const lignesParProduit = {};
for (const o of enAttente) {
  for (const l of o.products || []) {
    if (!l.product_id || String(l.product_id) === "0") continue;
    (lignesParProduit[l.product_id] ||= []).push({ o, l, manque: 0 });
  }
}
for (const [pid, lignes] of Object.entries(lignesParProduit)) {
  const info = infoProduit(pid);
  let reste = info ? Math.max(0, -info.stock) : Infinity; // produit introuvable : considéré manquant
  lignes.sort((a, b) => b.o.date_confirmed - a.o.date_confirmed); // plus récentes d'abord
  for (const x of lignes) {
    if (reste <= 0) break;
    x.manque = Math.min(Number(x.l.quantity), reste);
    reste -= x.manque;
  }
}

for (const o of enAttente.sort((a, b) => a.date_confirmed - b.date_confirmed)) {
  const lignes = o.products || [];
  const nonLiees = lignes.filter((l) => !l.product_id || String(l.product_id) === "0");
  const manquantes = lignes.map((l) => (lignesParProduit[l.product_id] || []).find((x) => x.o === o && x.l === l)).filter((x) => x && x.manque > 0);
  const tete = `commande ${o.order_id} (${o.order_source}, ${new Date(o.date_confirmed * 1000).toISOString().slice(0, 10)}, ${lignes.length} ligne(s))`;
  if (nonLiees.length) { log(`  ? ${tete} : ${nonLiees.length} ligne(s) non liée(s) au catalogue (${nonLiees.map((l) => l.sku || l.ean || l.name).join(", ")}) — non déplacée`); E.actions.indecidables = (E.actions.indecidables || 0) + 1; continue; }
  if (manquantes.length) { console.log(`  = ${tete} : manque ${manquantes.map((x) => `${x.l.sku} x${x.manque}`).join(", ")} — reste en attente`); E.actions.enAttente = (E.actions.enAttente || 0) + 1; continue; }
  await E.changerStatut(o, ST.EN_STOCK, "toutes les lignes couvertes par le stock");
}

console.log(`\n${bilan(APPLIQUER, E.actions)}`);
