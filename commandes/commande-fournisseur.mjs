// Commande fournisseur automatique (flux tendu) — remplace l'add-on prestataire « Suplier PO auto ».
// Ne fait QUE préparer les brouillons de bons de commande fournisseur ; le passage des commandes clients en stock
// est fait par stock-check.mjs, les échecs de réception par reception-partielle.mjs.
//
// Principe (process corrigé du 2026-09-11, décisions des 13 et 14/09/2026) :
//   1. Prend les commandes clients confirmées au statut « Nouvelles commandes » sans trace « QT ajouté » (champ 44156).
//   2. Pour chaque ligne liée à un produit du catalogue : déficit = min(−stock, demande ouverte) − en attente,
//      où stock = stock Base (déjà net des réservations : négatif = manquant), demande ouverte = somme des lignes des
//      commandes ouvertes (Nouvelles, Mis en expédier, En attente de réception, En stock ; plafond contre les
//      réservations fantômes) et en attente = quantités non reçues des bons de commande non clos.
//      Quantité à commander = min(quantité de la ligne, déficit).
//   3. Ajoute (ou augmente) la ligne dans le brouillon de bon de commande du fournisseur du produit, en le créant
//      au besoin. L'API remplace une ligne existante du même produit : on renvoie donc ancienne + nouvelle quantité.
//      Produit « non livrable » (deux bons clos sans le livrer chez ce fournisseur en 30 jours) : rien n'est commandé,
//      la ligne est tracée `nl:1` et reception-partielle.mjs l'isole pour remboursement.
//   4. Trace EAN · quantité · bon de commande dans le champ 44156 (même format que l'ancien add-on), et signale
//      les cas à voir par un commentaire administrateur sur la commande client (seul canal de signalement).
//   5. Commande annulée après trace : retire la quantité du brouillon s'il l'est encore, sinon commente.
//   Aucun changement de statut des commandes clients.
//
// Usage : node commandes/commande-fournisseur.mjs [--appliquer] [--jours=30] [--commande=ID] [--rattrapage]
//   sans option     simulation : affiche ce qui serait fait, n'écrit rien dans Base
//   --appliquer     écrit dans Base (bons de commande, trace 44156, commentaires)
//   --jours=N       fenêtre de lecture des commandes clients (défaut 30 jours)
//   --commande=ID   ne traite que cette commande client
//   --rattrapage    en plus : pour tout produit en déficit (toutes commandes ouvertes confondues, tracées ou non),
//                   propose d'ajouter le manquant au brouillon du fournisseur (sans trace par commande)
// Journal : commandes/journal/commande-fournisseur-AAAA-MM.log (une ligne par action, dates ISO).
import { ST, options, creerJournal, lireTrace, chargerCommandes, resumeStatuts, demandeOuverte, chargerBons, chargerProduits, produitsDesCommandes, ecritures, bilan } from "./lib-commandes.mjs";

const { APPLIQUER, JOURS, SEULE, RATTRAPAGE } = options();
const log = creerJournal("commande-fournisseur", APPLIQUER);
console.log(`Commande fournisseur — ${APPLIQUER ? "ÉCRITURE DANS BASE" : "simulation (rien n'est écrit)"} — fenêtre ${JOURS} j${SEULE ? ` — commande ${SEULE}` : ""}${RATTRAPAGE ? " — rattrapage" : ""}`);

// ---------- 1. Données ----------
const commandes = await chargerCommandes(JOURS);
console.log(`commandes confirmées lues : ${commandes.size} — ${resumeStatuts(commandes)}`);
const demande = demandeOuverte(commandes);
const bons = await chargerBons();
console.log(`bons de commande : ${bons.bons.length} au total, ${bons.bonsOuverts.length} ouverts, brouillons par fournisseur : ${Object.keys(bons.brouillons).length}`);
const { infoProduit } = await chargerProduits(produitsDesCommandes(commandes), bons.fournisseurs);
const deficit = (pid, info) => Math.min(Math.max(0, -info.stock), demande[pid] || 0) - (bons.enAttente[pid] || 0);
const detailProduit = (pid, info) => `demande ${demande[pid] || 0}, stock ${info.stock} (réservé Base ${info.reserveBase}), en attente ${bons.enAttente[pid] || 0}`;
const E = ecritures({ APPLIQUER, log, bons });

// ---------- 2. Nouvelles commandes non tracées ----------
const aTraiter = [...commandes.values()]
  .filter((o) => o.order_status_id === ST.NOUVELLES && lireTrace(o).length === 0 && (!SEULE || o.order_id === SEULE))
  .sort((a, b) => a.date_confirmed - b.date_confirmed);
console.log(`\nNouvelles commandes à traiter : ${aTraiter.length}`);
for (const o of aTraiter) {
  log(`commande ${o.order_id} (${o.order_source}, ${new Date(o.date_confirmed * 1000).toISOString().slice(0, 16)}) : ${(o.products || []).length} ligne(s)`);
  const trace = [], alertes = [];
  for (const l of o.products || []) {
    const pid = l.product_id;
    if (!pid || String(pid) === "0") { alertes.push(`ligne non liée au catalogue : ${l.sku || l.ean || l.name}`); continue; }
    const info = infoProduit(pid);
    if (!info) { alertes.push(`produit ${pid} introuvable dans le catalogue`); continue; }
    const qte = Math.min(Number(l.quantity), Math.max(0, deficit(pid, info)));
    const detail = detailProduit(pid, info);
    if (qte <= 0) { log(`  = ${info.sku} x${l.quantity} : couvert — ${detail}`); trace.push({ opid: l.order_product_id, pid: Number(pid), ean: info.ean, sid: info.supplier_id, poid: null, qty: 0 }); continue; }
    if (!info.supplier_id) { alertes.push(`${info.sku} x${qte} : aucun fournisseur, rien commandé`); trace.push({ opid: l.order_product_id, pid: Number(pid), ean: info.ean, sid: null, poid: null, qty: 0 }); continue; }
    const echecs = bons.echecsRecents(info.supplier_id, pid);
    if (echecs.length >= 2) {
      alertes.push(`${info.sku} x${qte} : non livrable chez ${bons.nomFournisseur(info.supplier_id)} (manquant sur ${echecs.map((b) => bons.nomBon(b.id)).join(" et ")}), à rembourser`);
      trace.push({ opid: l.order_product_id, pid: Number(pid), ean: info.ean, sid: info.supplier_id, poid: null, qty: qte, nl: 1 });
      continue;
    }
    const poid = await E.ajouterAuBrouillon(pid, info, qte, `commande ${o.order_id}, ${detail}`);
    trace.push({ opid: l.order_product_id, pid: Number(pid), ean: info.ean, sid: info.supplier_id, poid, qty: qte });
  }
  await E.ecrireCommande(o, trace, alertes);
  E.actions.commandesTraitees = (E.actions.commandesTraitees || 0) + 1;
}

// ---------- 3. Commandes annulées après trace ----------
const annulees = [...commandes.values()].filter((o) => o.order_status_id === ST.ANNULEES && lireTrace(o).some((t) => Number(t.qty) > 0 && !t.ann && !t.fin) && (!SEULE || o.order_id === SEULE));
if (annulees.length) console.log(`\nCommandes annulées après commande fournisseur : ${annulees.length}`);
for (const o of annulees) {
  const trace = lireTrace(o), alertes = [];
  for (const t of trace) {
    if (!(Number(t.qty) > 0) || t.ann || t.fin) continue;
    const info = infoProduit(t.pid) || { sku: t.ean, ean: t.ean };
    if (t.poid) {
      const alerte = await E.retirerDuBrouillon(t.poid, t.pid, t.qty, info, `commande ${o.order_id} annulée`);
      if (alerte) alertes.push(`annulée : ${alerte}`);
    }
    t.ann = 1; E.actions.annulations = (E.actions.annulations || 0) + 1;
  }
  await E.ecrireCommande(o, trace, alertes);
}

// ---------- 4. Rattrapage global (option) ----------
if (RATTRAPAGE) {
  console.log("\nRattrapage : produits en déficit toutes commandes ouvertes confondues");
  let n = 0;
  for (const pid of Object.keys(demande).sort()) {
    const info = infoProduit(pid);
    if (!info) continue;
    const d = deficit(pid, info);
    if (d <= 0) continue;
    n++;
    if (!info.supplier_id) { log(`  ? ${info.sku} ${info.ean} : déficit ${d}, aucun fournisseur`); continue; }
    if (bons.echecsRecents(info.supplier_id, pid).length >= 2) { log(`  ? ${info.sku} ${info.ean} : déficit ${d}, non livrable chez ${bons.nomFournisseur(info.supplier_id)} (2 échecs récents)`); continue; }
    await E.ajouterAuBrouillon(pid, info, d, `rattrapage, ${detailProduit(pid, info)}`);
  }
  console.log(`rattrapage : ${n} produit(s) en déficit`);
}

console.log(`\n${bilan(APPLIQUER, E.actions)}`);
