// Recale les brouillons de bons de commande fournisseur sur le besoin réel (flux tendu).
// Besoin d'un produit = réservations des commandes ouvertes (Nouvelles, Mis en expédier, En attente de réception,
// En stock) − stock physique (stock + réservé, plafonné à 0) − quantités non reçues sur les bons envoyés (non brouillon).
//   - ligne de brouillon dont la quantité ≠ besoin → quantité remplacée (l'API remplace la ligne du même produit) ;
//   - besoin 0 → ligne à retirer à la main (l'API refuse la quantité 0) ;
//   - produit en besoin absent de tout brouillon → ajouté au brouillon de son fournisseur (créé au besoin).
// Ne touche ni aux bons envoyés, ni aux commandes clients, ni aux traces. À lancer APRÈS reception-partielle.mjs
// pour que les traces des commandes pointent déjà sur les brouillons.
//
// Usage : node commandes/recaler-brouillons.mjs [--appliquer] [--jours=90]
import { bl } from "../lib/baselinker.mjs";
import { options, creerJournal, ligneBon, chargerCommandes, resumeStatuts, demandeOuverte, chargerBons, chargerProduits, produitsDesCommandes, ecritures, bilan } from "./lib-commandes.mjs";

const { APPLIQUER, JOURS } = options(undefined, { jours: 90 });
const log = creerJournal("recaler-brouillons", APPLIQUER);
console.log(`Recalage des brouillons — ${APPLIQUER ? "ÉCRITURE DANS BASE" : "simulation (rien n'est écrit)"} — fenêtre ${JOURS} j`);

const commandes = await chargerCommandes(JOURS);
console.log(`commandes confirmées lues : ${commandes.size} — ${resumeStatuts(commandes)}`);
const demande = demandeOuverte(commandes);
const bons = await chargerBons();
const ids = new Set(produitsDesCommandes(commandes));
for (const b of bons.bonsOuverts) for (const it of bons.lignesBon[b.id]) ids.add(String(it.product_id));
const { infoProduit } = await chargerProduits(ids, bons.fournisseurs);
const E = ecritures({ APPLIQUER, log, bons });

const surEnvoyes = {};
for (const b of bons.bonsOuverts.filter((b) => Number(b.status) !== 0)) for (const it of bons.lignesBon[b.id]) surEnvoyes[it.product_id] = (surEnvoyes[it.product_id] || 0) + Math.max(0, Number(it.quantity) - Number(it.completed_quantity || 0));
const besoin = (pid) => { const i = infoProduit(pid); if (!i) return 0; return Math.max(0, (demande[pid] || 0) - Math.max(0, i.stock + i.reserveBase) - (surEnvoyes[pid] || 0)); };
const detail = (pid) => { const i = infoProduit(pid); return `demande ${demande[pid] || 0}, physique ${Math.max(0, i.stock + i.reserveBase)}, sur bons envoyés ${surEnvoyes[pid] || 0}`; };

const dansBrouillon = new Set();
for (const b of bons.bonsOuverts.filter((b) => Number(b.status) === 0)) {
  log(`brouillon ${bons.nomBon(b.id)} (${bons.nomFournisseur(b.supplier_id)}) : ${bons.lignesBon[b.id].length} ligne(s)`);
  for (const it of bons.lignesBon[b.id]) {
    dansBrouillon.add(String(it.product_id));
    const n = besoin(it.product_id), sku = infoProduit(it.product_id)?.sku || it.product_id;
    if (n === Number(it.quantity)) continue;
    if (n === 0) { log(`  - ${sku} : ${it.quantity} → 0 : à retirer à la main (l'API refuse la quantité 0) — ${detail(it.product_id)}`); E.actions.aRetirerALaMain = (E.actions.aRetirerALaMain || 0) + 1; continue; }
    const item = ligneBon(it, n);
    if (APPLIQUER) {
      try { await bl("addInventoryPurchaseOrderItems", { order_id: b.id, items: [item] }); }
      catch (e) { log(`  ! ${sku} : ${it.quantity} → ${n} refusé par l'API (${e.message.slice(0, 120)}) — à corriger à la main`); E.actions.aLaMain = (E.actions.aLaMain || 0) + 1; continue; }
    }
    log(`  ${n === 0 ? "-" : "~"} ${sku} : ${it.quantity} → ${n}${n === 0 ? " (à retirer)" : ""} — ${detail(it.product_id)}`);
    it.quantity = n; E.actions[n === 0 ? "retraits" : "modifications"] = (E.actions[n === 0 ? "retraits" : "modifications"] || 0) + 1;
  }
}
console.log("\nproduits en besoin absents des brouillons :");
for (const pid of Object.keys(demande).sort()) {
  const n = besoin(pid);
  if (n <= 0 || dansBrouillon.has(String(pid))) continue;
  const info = infoProduit(pid);
  if (!info.supplier_id) { log(`  ? ${info.sku} x${n} : aucun fournisseur`); E.actions.sansFournisseur = (E.actions.sansFournisseur || 0) + 1; continue; }
  try { await E.ajouterAuBrouillon(pid, info, n, `recalage, ${detail(pid)}`); }
  catch (e) { log(`  ! ${info.sku} x${n} (${bons.nomFournisseur(info.supplier_id)}) : ${e.message.slice(0, 160)}`); E.actions.nonAjoutes = (E.actions.nonAjoutes || 0) + 1; }
}
console.log(`\n${bilan(APPLIQUER, E.actions)}`);
