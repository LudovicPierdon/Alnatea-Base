// Commande fournisseur automatique (flux tendu) — remplace l'add-on prestataire « Suplier PO auto ».
//
// Principe (process corrigé du 2026-09-11, décisions du 2026-09-13) :
//   1. Prend les commandes clients confirmées au statut « Nouvelles commandes » sans trace « QT ajouté » (champ 44156).
//   2. Pour chaque ligne liée à un produit du catalogue : déficit = min(−stock, demande ouverte) − en attente,
//      où stock = stock Base (déjà net des réservations : négatif = manquant), demande ouverte = somme des lignes des
//      commandes ouvertes (Nouvelles, Mis en expédier, En attente de réception, En stock ; plafond contre les
//      réservations fantômes) et en attente = quantités non reçues des bons de commande non clos.
//      Quantité à commander = min(quantité de la ligne, déficit).
//   3. Ajoute (ou augmente) la ligne dans le brouillon de bon de commande du fournisseur du produit, en le créant
//      au besoin. L'API remplace une ligne existante du même produit : on renvoie donc ancienne + nouvelle quantité.
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
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bl } from "../lib/baselinker.mjs";

const INV = 27452, WH = "bl_45864", WH_ID = 45864, DEVISE = "EUR";
const ST = { NOUVELLES: 141531, EXPEDIER: 141532, ATTENTE: 146725, EN_STOCK: 146726, ENVOYE: 141533, PARTIEL: 142067, ANNULEES: 141534 };
const STATUTS_DEMANDE = new Set([ST.NOUVELLES, ST.EXPEDIER, ST.ATTENTE, ST.EN_STOCK]);
const CHAMP_TRACE = "44156", CHAMP_FOURNISSEUR_PRODUIT = "extra_field_12633";
const PO_CLOS = new Set([3, 4, 5]); // terminé, terminé partiellement (clos), annulé ; tout autre statut (0 brouillon, 1/6 envoyé, 2 en réception) est ouvert
const MAX_COMMENTAIRE = 200;

const args = process.argv.slice(2);
const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const APPLIQUER = args.includes("--appliquer");
const JOURS = Number(opt("jours") || 30);
const SEULE = opt("commande") ? Number(opt("commande")) : null;
const RATTRAPAGE = args.includes("--rattrapage");
const ICI = (f) => fileURLToPath(new URL(f, import.meta.url));
const AUJOURDHUI = new Date().toISOString().slice(0, 10);
mkdirSync(ICI("journal"), { recursive: true });
const JOURNAL = ICI(`journal/commande-fournisseur-${AUJOURDHUI.slice(0, 7)}.log`);
const log = (msg) => { const l = `${new Date().toISOString()} ${APPLIQUER ? "APPLIQUER" : "SIMULATION"} ${msg}`; console.log(msg); appendFileSync(JOURNAL, l + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Commande fournisseur — ${APPLIQUER ? "ÉCRITURE DANS BASE" : "simulation (rien n'est écrit)"} — fenêtre ${JOURS} j${SEULE ? ` — commande ${SEULE}` : ""}${RATTRAPAGE ? " — rattrapage" : ""}`);

// ---------- 1. Commandes clients confirmées de la fenêtre ----------
const commandes = new Map();
{
  let depuis = Math.floor(Date.now() / 1000) - JOURS * 86400;
  for (let i = 0; i < 200; i++) {
    const d = await bl("getOrders", { date_confirmed_from: depuis, include_custom_extra_fields: true });
    const os = d.orders || [];
    let nouveaux = 0;
    for (const o of os) if (!commandes.has(o.order_id)) { commandes.set(o.order_id, o); nouveaux++; }
    if (os.length < 100 || nouveaux === 0) break;
    depuis = Math.max(...os.map((o) => o.date_confirmed));
    await sleep(200);
  }
}
const lireTrace = (o) => { try { const t = JSON.parse((o.custom_extra_fields || {})[CHAMP_TRACE] || "[]"); return Array.isArray(t) ? t : []; } catch { return []; } };
const parStatut = {};
for (const o of commandes.values()) parStatut[o.order_status_id] = (parStatut[o.order_status_id] || 0) + 1;
console.log(`commandes confirmées lues : ${commandes.size} — par statut : ${Object.entries(parStatut).map(([k, v]) => `${k}:${v}`).join(" ")}`);

// ---------- 2. Demande ouverte par produit ----------
const demande = {}; // product_id → quantité dans les commandes ouvertes
for (const o of commandes.values()) {
  if (!STATUTS_DEMANDE.has(o.order_status_id)) continue;
  for (const l of o.products || []) if (l.product_id && String(l.product_id) !== "0") demande[l.product_id] = (demande[l.product_id] || 0) + Number(l.quantity);
}

// ---------- 3. Bons de commande ouverts et quantités en attente ----------
const bons = [];
for (let page = 1; page < 50; page++) {
  const d = await bl("getInventoryPurchaseOrders", { warehouse_id: WH_ID, page });
  const ps = d.purchase_orders || [];
  bons.push(...ps);
  if (ps.length < 100) break;
}
const bonsOuverts = bons.filter((b) => !PO_CLOS.has(Number(b.status)));
const lignesBon = {}; // id du bon → lignes
const enAttente = {}; // product_id → quantité commandée non reçue
for (const b of bonsOuverts) {
  const d = await bl("getInventoryPurchaseOrderItems", { order_id: b.id });
  lignesBon[b.id] = d.items || [];
  for (const it of lignesBon[b.id]) {
    const reste = Math.max(0, Number(it.quantity) - Number(it.completed_quantity || 0));
    enAttente[it.product_id] = (enAttente[it.product_id] || 0) + reste;
  }
  await sleep(100);
}
const brouillons = {}; // supplier_id → bon brouillon (le plus récent)
for (const b of bonsOuverts.filter((b) => Number(b.status) === 0)) if (!brouillons[b.supplier_id] || b.id > brouillons[b.supplier_id].id) brouillons[b.supplier_id] = b;
console.log(`bons de commande : ${bons.length} au total, ${bonsOuverts.length} ouverts, brouillons par fournisseur : ${Object.keys(brouillons).length}`);

// ---------- 4. Fournisseurs et données produits ----------
const fournisseurs = Object.fromEntries(((await bl("getInventorySuppliers", {})).suppliers || []).map((s) => [s.supplier_id, s]));
const fournisseurParNom = Object.fromEntries(Object.values(fournisseurs).map((s) => [s.name.trim().toLowerCase(), s.supplier_id]));
const idsProduits = new Set(Object.keys(demande));
for (const o of commandes.values()) for (const l of o.products || []) if (l.product_id && String(l.product_id) !== "0") idsProduits.add(String(l.product_id));
const produits = {};
{
  const liste = [...idsProduits];
  for (let i = 0; i < liste.length; i += 1000) {
    const d = await bl("getInventoryProductsData", { inventory_id: INV, products: liste.slice(i, i + 1000), include_suppliers: true });
    Object.assign(produits, d.products || {});
  }
}
const infoProduit = (pid) => {
  const p = produits[pid];
  if (!p) return null;
  const four = (p.suppliers || [])[0];
  const nomExtra = ((p.text_fields || {})[CHAMP_FOURNISSEUR_PRODUIT] || "").trim().toLowerCase();
  const supplier_id = four?.id || fournisseurParNom[nomExtra] || null;
  return {
    sku: p.sku, ean: p.ean, nom: (p.text_fields || {}).name || "",
    stock: Number((p.stock || {})[WH] ?? 0), reserveBase: Number((p.reservations || {})[WH] ?? 0),
    supplier_id, supplier_code: four?.product_code || "", cout: four?.cost ?? p.average_cost ?? 0,
  };
};
// Dans Base, « stock » est déjà net des réservations (physique = stock + réservé). Un stock négatif est donc du manquant.
// On le plafonne à la demande réelle des commandes ouvertes pour ignorer les réservations fantômes (commandes envoyées jamais complétées).
const deficit = (pid, info) => Math.min(Math.max(0, -info.stock), demande[pid] || 0) - (enAttente[pid] || 0);
const detailProduit = (pid, info) => `demande ${demande[pid] || 0}, stock ${info.stock} (réservé Base ${info.reserveBase}), en attente ${enAttente[pid] || 0}`;

// ---------- 5. Écritures (réelles ou simulées) ----------
const actions = { lignes: 0, bonsCrees: 0, commandesTraitees: 0, alertes: 0, annulations: 0 };
async function ajouterAuBrouillon(pid, info, qte, origine) {
  const sid = info.supplier_id;
  let bon = brouillons[sid];
  if (!bon) {
    if (APPLIQUER) {
      const r = await bl("addInventoryPurchaseOrder", { warehouse_id: WH_ID, supplier_id: sid, payer_id: -1, currency: DEVISE, name: "" });
      bon = { id: r.order_id, supplier_id: sid, status: 0, document_number: r.document_number };
    } else bon = { id: `NOUVEAU-${sid}`, supplier_id: sid, status: 0, document_number: "(à créer)" };
    brouillons[sid] = bon; lignesBon[bon.id] = []; actions.bonsCrees++;
    log(`  + brouillon ${bon.document_number} créé pour ${fournisseurs[sid]?.name} (${sid})`);
  }
  const existante = lignesBon[bon.id].find((it) => String(it.product_id) === String(pid));
  const ancienne = existante ? Number(existante.quantity) : 0;
  const nouvelleQte = ancienne + qte;
  const item = existante
    ? { product_id: Number(pid), quantity: nouvelleQte, item_cost: existante.item_cost, supplier_code: existante.supplier_code, location: existante.location, batch: existante.batch, expiry_date: existante.expiry_date, serial_no: existante.serial_no, comments: existante.comments }
    : { product_id: Number(pid), quantity: nouvelleQte, item_cost: info.cout, supplier_code: info.supplier_code };
  if (APPLIQUER) await bl("addInventoryPurchaseOrderItems", { order_id: bon.id, items: [item] });
  if (existante) existante.quantity = nouvelleQte; else lignesBon[bon.id].push({ ...item, completed_quantity: 0 });
  enAttente[pid] = (enAttente[pid] || 0) + qte;
  actions.lignes++;
  log(`  + ${info.sku} ${info.ean} : ${existante ? `ligne ${ancienne} → ${nouvelleQte}` : `nouvelle ligne ${qte}`} dans ${bon.document_number} (${fournisseurs[sid]?.name}) — ${origine}`);
  return bon.id;
}
async function ecrireCommande(o, trace, alertes) {
  const champs = { order_id: o.order_id, custom_extra_fields: { [CHAMP_TRACE]: JSON.stringify(trace) } };
  if (alertes.length) {
    const ajout = `[Cde fournisseur ${AUJOURDHUI}] ${alertes.join(" ; ")}`;
    const ancien = (o.admin_comments || "").trim();
    let texte = ancien ? `${ancien}\n${ajout}` : ajout;
    if (texte.length > MAX_COMMENTAIRE) texte = ajout.slice(0, MAX_COMMENTAIRE);
    champs.admin_comments = texte;
    actions.alertes += alertes.length;
    log(`  ! commande ${o.order_id} : ${ajout}`);
  }
  if (APPLIQUER) await bl("setOrderFields", champs);
}

// ---------- 6. Nouvelles commandes non tracées ----------
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
    const poid = await ajouterAuBrouillon(pid, info, qte, `commande ${o.order_id}, ${detail}`);
    trace.push({ opid: l.order_product_id, pid: Number(pid), ean: info.ean, sid: info.supplier_id, poid, qty: qte });
  }
  await ecrireCommande(o, trace, alertes);
  actions.commandesTraitees++;
}

// ---------- 7. Commandes annulées après trace ----------
const annulees = [...commandes.values()].filter((o) => o.order_status_id === ST.ANNULEES && lireTrace(o).some((t) => Number(t.qty) > 0 && !t.ann) && (!SEULE || o.order_id === SEULE));
if (annulees.length) console.log(`\nCommandes annulées après commande fournisseur : ${annulees.length}`);
for (const o of annulees) {
  const trace = lireTrace(o), alertes = [];
  for (const t of trace) {
    if (!(Number(t.qty) > 0) || t.ann) continue;
    const bon = bonsOuverts.find((b) => b.id === Number(t.poid));
    const info = infoProduit(t.pid) || { sku: t.ean, ean: t.ean };
    if (bon && Number(bon.status) === 0) {
      const ligne = (lignesBon[bon.id] || []).find((it) => String(it.product_id) === String(t.pid));
      if (!ligne) alertes.push(`annulée : ${info.sku} x${t.qty} absent du brouillon ${bon.document_number}`);
      else if (Number(ligne.quantity) - Number(t.qty) <= 0) alertes.push(`annulée : retirer ${info.sku} du brouillon ${bon.document_number} à la main (ligne à 0)`);
      else {
        const nouvelle = Number(ligne.quantity) - Number(t.qty);
        if (APPLIQUER) await bl("addInventoryPurchaseOrderItems", { order_id: bon.id, items: [{ product_id: Number(t.pid), quantity: nouvelle, item_cost: ligne.item_cost, supplier_code: ligne.supplier_code, location: ligne.location, batch: ligne.batch, expiry_date: ligne.expiry_date, serial_no: ligne.serial_no, comments: ligne.comments }] });
        log(`  - ${info.sku} : ligne ${ligne.quantity} → ${nouvelle} dans ${bon.document_number} (commande ${o.order_id} annulée)`);
        ligne.quantity = nouvelle; enAttente[t.pid] = Math.max(0, (enAttente[t.pid] || 0) - Number(t.qty));
      }
    } else if (bon) alertes.push(`annulée : ${info.sku} x${t.qty} déjà commandé (bon ${bon.document_number} envoyé)`);
    // bon clos ou introuvable : rien à faire, on marque seulement la trace
    t.ann = 1; actions.annulations++;
  }
  await ecrireCommande(o, trace, alertes);
}

// ---------- 8. Rattrapage global (option) ----------
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
    await ajouterAuBrouillon(pid, info, d, `rattrapage, ${detailProduit(pid, info)}`);
  }
  console.log(`rattrapage : ${n} produit(s) en déficit`);
}

console.log(`\nBilan ${APPLIQUER ? "(écrit dans Base)" : "(simulation)"} : ${actions.commandesTraitees} commande(s) traitée(s), ${actions.lignes} ligne(s) de bon de commande, ${actions.bonsCrees} brouillon(s) créé(s), ${actions.annulations} annulation(s), ${actions.alertes} alerte(s)`);
