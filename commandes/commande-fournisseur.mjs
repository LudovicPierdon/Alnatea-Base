// Commande fournisseur automatique (flux tendu) — remplace l'add-on prestataire « Suplier PO auto ».
// Ne fait QUE préparer les brouillons de bons de commande fournisseur ; le passage des commandes clients en stock
// est fait par stock-check.mjs, les échecs de réception par reception-partielle.mjs.
//
// Principe (process corrigé du 2026-09-11, décisions des 13 et 14/09/2026) :
//   1. Prend les commandes clients confirmées, ouvertes (Nouvelles, Mis en expédier, En attente de réception, En stock)
//      et sans trace « QT ajouté » (champ 44156) : une commande passée en attente de réception dès l'étiquette créée
//      n'est donc jamais oubliée.
//   2. Pour chaque ligne liée à un produit du catalogue : déficit = min(−stock, demande ouverte) − en attente,
//      où stock = stock Base (déjà net des réservations : négatif = manquant), demande ouverte = somme des lignes des
//      commandes ouvertes (Nouvelles, Mis en expédier, En attente de réception, En stock ; plafond contre les
//      réservations fantômes) et en attente = quantités non reçues des bons de commande non clos.
//      Quantité à commander = min(quantité de la ligne, déficit).
//   3. Ajoute (ou augmente) la ligne dans le brouillon de bon de commande du fournisseur du produit, en le créant
//      au besoin. Si le manquant est déjà couvert par un bon ouvert du fournisseur (brouillon ou envoyé), la ligne
//      est tracée sur ce bon sans rien ajouter, pour que reception-partielle.mjs puisse la suivre. L'API remplace une ligne existante du même produit : on renvoie donc ancienne + nouvelle quantité.
//      Chaque commande client suit le cycle complet (décision du 14/09) : aucun produit n'est exclu d'office, même
//      s'il a déjà manqué chez ce fournisseur.
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
import { ST, STATUTS_DEMANDE, options, creerJournal, lireTrace, chargerCommandes, resumeStatuts, demandeOuverte, chargerBons, chargerProduits, produitsDesCommandes, ecritures, bilan } from "./lib-commandes.mjs";

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
  .filter((o) => STATUTS_DEMANDE.has(o.order_status_id) && lireTrace(o).length === 0 && (!SEULE || o.order_id === SEULE))
  .sort((a, b) => a.date_confirmed - b.date_confirmed);
console.log(`\nCommandes ouvertes sans trace à traiter : ${aTraiter.length}`);
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
    if (qte <= 0) {
      // Couvert : par le stock, ou par un bon ouvert du fournisseur → on trace ce bon pour pouvoir suivre la réception.
      const bonOuvert = bons.bonsOuverts.find((b) => String(b.supplier_id) === String(info.supplier_id) && (bons.lignesBon[b.id] || []).some((it) => String(it.product_id) === String(pid) && Number(it.quantity) > Number(it.completed_quantity || 0)));
      log(`  = ${info.sku} x${l.quantity} : couvert${bonOuvert ? ` (déjà sur ${bons.nomBon(bonOuvert.id)})` : ""} — ${detail}`);
      trace.push({ opid: l.order_product_id, pid: Number(pid), ean: info.ean, sid: info.supplier_id, poid: bonOuvert ? bonOuvert.id : null, qty: bonOuvert ? Number(l.quantity) : 0 });
      continue;
    }
    if (!info.supplier_id) { alertes.push(`${info.sku} x${qte} : aucun fournisseur, rien commandé`); trace.push({ opid: l.order_product_id, pid: Number(pid), ean: info.ean, sid: null, poid: null, qty: 0 }); continue; }
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
    await E.ajouterAuBrouillon(pid, info, d, `rattrapage, ${detailProduit(pid, info)}`);
  }
  console.log(`rattrapage : ${n} produit(s) en déficit`);
}

console.log(`\n${bilan(APPLIQUER, E.actions)}`);
