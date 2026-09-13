// Réception partielle — traite les lignes de commandes clients que le fournisseur n'a pas livrées.
// Complète commande-fournisseur.mjs (qui prépare les bons) et stock-check.mjs (qui passe les commandes en stock).
//
// Règle (décisions de Ludovic du 2026-09-14) :
//   - Une ligne de commande client tracée sur un bon de commande fournisseur CLOS (terminé, terminé partiellement,
//     annulé après envoi) est en échec si le stock net du produit ne la couvre pas une fois déduites les quantités
//     encore attendues sur les bons ouverts. Le manquant est attribué d'abord aux lignes « non livrables », puis
//     aux commandes les plus récentes (les plus anciennes sont servies en premier).
//   - Premier échec : la quantité manquante est remise UNE fois sur le brouillon suivant du même fournisseur
//     (trace `try: 2`, `poid1` = premier bon), commentaire sur la commande client.
//   - Second échec, ou produit déjà non livrable (`nl`, ou manquant sur deux bons clos du fournisseur en 30 jours) :
//     la ligne est isolée pour remboursement :
//       · toutes les lignes de la commande en échec → la commande passe en « A rembourser » ;
//       · sinon → commande de remboursement créée en « A rembourser » (port 0, lignes non liées au catalogue),
//         lignes supprimées / réduites dans la commande d'origine (réservation libérée), qui poursuit son flux
//         avec ses lignes reçues ou encore attendues chez un autre fournisseur.
//     Le remboursement lui-même se fait sur la marketplace (manuel), puis la commande de remboursement en « Annulées ».
//   - Un bon annulé sans avoir été envoyé n'est pas un échec : la quantité est simplement remise sur le brouillon
//     courant, sans compter de tentative.
//   Seul changement de statut automatique : « A rembourser ».
//
// Usage : node commandes/reception-partielle.mjs [--appliquer] [--jours=90] [--commande=ID] [--produit=ID]
//   sans option     simulation : affiche les échecs détectés et ce qui serait fait, n'écrit rien
//   --appliquer     écrit dans Base (brouillons, commandes de remboursement, lignes, statuts, trace, commentaires)
//   --jours=N       fenêtre de lecture des commandes clients (défaut 90 jours, maximum de l'API)
//   --commande=ID   ne traite que cette commande client
//   --produit=ID    ne traite que ce produit Base
// Journal : commandes/journal/reception-partielle-AAAA-MM.log
import { ST, NOM_STATUT_BON, STATUTS_DEMANDE, PO_CLOS, options, creerJournal, lireTrace, chargerCommandes, resumeStatuts, chargerBons, chargerProduits, produitsDesCommandes, ecritures, bilan, dateCourte } from "./lib-commandes.mjs";

const { APPLIQUER, JOURS, SEULE, PRODUIT } = options(undefined, { jours: 90 });
const log = creerJournal("reception-partielle", APPLIQUER);
console.log(`Réception partielle — ${APPLIQUER ? "ÉCRITURE DANS BASE" : "simulation (rien n'est écrit)"} — fenêtre ${JOURS} j${SEULE ? ` — commande ${SEULE}` : ""}${PRODUIT ? ` — produit ${PRODUIT}` : ""}`);

const commandes = await chargerCommandes(JOURS);
console.log(`commandes confirmées lues : ${commandes.size} — ${resumeStatuts(commandes)}`);
const bons = await chargerBons();
console.log(`bons de commande : ${bons.bons.length} au total, ${bons.bonsOuverts.length} ouverts, ${bons.bonsClosRecents.length} clos récents`);
const { infoProduit } = await chargerProduits(produitsDesCommandes(commandes), bons.fournisseurs);
const E = ecritures({ APPLIQUER, log, bons });

// ---------- 1. Lignes candidates : tracées sur un bon clos (ou non livrables) dans une commande ouverte ----------
const ouvertes = [...commandes.values()].filter((o) => STATUTS_DEMANDE.has(o.order_status_id) && (!SEULE || o.order_id === SEULE));
const candidats = {}; // pid → [{ o, t, l, nl, bon, manque }]
for (const o of ouvertes) {
  for (const t of lireTrace(o)) {
    if (!(Number(t.qty) > 0) || t.ann || t.fin) continue;
    if (PRODUIT && String(t.pid) !== PRODUIT) continue;
    const l = (o.products || []).find((x) => x.order_product_id === t.opid);
    if (!l) continue; // ligne disparue de la commande
    const bon = t.poid ? bons.parId[t.poid] : null;
    if (!t.nl && !(bon && PO_CLOS.has(Number(bon.status)))) continue; // bon ouvert (en route) ou sans bon : rien à faire
    (candidats[t.pid] ||= []).push({ o, t, l, nl: !!t.nl, bon, manque: 0, annuleSansEnvoi: !!(bon && Number(bon.status) === 5 && !Number(bon.date_sent)) });
  }
}

// ---------- 2. Attribution du manquant par produit ----------
let nbLignes = 0;
for (const [pid, lignes] of Object.entries(candidats)) {
  const info = infoProduit(pid);
  const residuel = info ? Math.max(0, -info.stock) - (bons.enAttente[pid] || 0) : Infinity; // manquant que personne ne livrera
  let reste = Math.max(0, residuel);
  lignes.sort((a, b) => (b.nl - a.nl) || (b.o.date_confirmed - a.o.date_confirmed));
  for (const x of lignes) {
    if (x.annuleSansEnvoi) { x.manque = Number(x.t.qty); continue; } // à remettre, sans compter d'échec
    if (reste <= 0) break;
    x.manque = Math.min(Number(x.t.qty), Number(x.l.quantity), reste);
    reste -= x.manque;
  }
  const enEchec = lignes.filter((x) => x.manque > 0);
  nbLignes += enEchec.length;
  if (enEchec.length && info) console.log(`\nproduit ${info.sku} ${info.ean} : stock ${info.stock}, en attente ${bons.enAttente[pid] || 0} → manquant ${Math.max(0, residuel)} sur ${lignes.length} ligne(s) tracée(s) sur bon clos`);
}
console.log(`\nlignes en échec de réception : ${nbLignes}`);

// ---------- 3. Traitement commande par commande ----------
const parCommande = new Map();
for (const lignes of Object.values(candidats)) for (const x of lignes) if (x.manque > 0) (parCommande.get(x.o) || parCommande.set(x.o, []).get(x.o)).push(x);
for (const [o, lignes] of [...parCommande.entries()].sort((a, b) => a[0].date_confirmed - b[0].date_confirmed)) {
  log(`commande ${o.order_id} (${o.order_source}, ${dateCourte(o.date_confirmed)}, ${(o.products || []).length} ligne(s))`);
  const trace = lireTrace(o), alertes = [], echecs = [];
  for (const x of lignes) {
    const t = trace.find((y) => y.opid === x.t.opid);
    const info = infoProduit(x.t.pid) || { sku: x.l.sku, ean: x.l.ean, supplier_id: x.t.sid, cout: x.l.price_brutto, supplier_code: "" };
    const etatBon = x.bon ? `${bons.nomBon(x.bon.id)} ${NOM_STATUT_BON[x.bon.status] || x.bon.status} le ${dateCourte(x.bon.date_completed || x.bon.date_received || x.bon.date_created)}` : "";
    if (x.annuleSansEnvoi) {
      const poid = await E.ajouterAuBrouillon(x.t.pid, info, x.manque, `bon ${etatBon} (jamais envoyé), commande ${o.order_id}`, x.t.sid);
      Object.assign(t, { poid, qty: x.manque });
      continue;
    }
    const tentative = Number(t.try || 1);
    const recents = bons.echecsRecents(x.t.sid, x.t.pid);
    if (!x.nl && tentative < 2 && recents.length < 2) {
      const poid = await E.ajouterAuBrouillon(x.t.pid, info, x.manque, `1er échec : ${etatBon}, commande ${o.order_id}`, x.t.sid);
      Object.assign(t, { poid, qty: x.manque, try: 2, poid1: x.t.poid });
      alertes.push(`${info.sku} x${x.manque} non livré (${etatBon}), recommandé une fois sur ${bons.nomBon(poid)}`);
      E.actions.premiersEchecs = (E.actions.premiersEchecs || 0) + 1;
      continue;
    }
    const motif = x.nl ? `non livrable chez ${bons.nomFournisseur(x.t.sid)}`
      : tentative >= 2 ? `non livré 2 fois par ${bons.nomFournisseur(x.t.sid)} (${bons.nomBon(x.t.poid1)}, ${etatBon})`
      : `non livrable chez ${bons.nomFournisseur(x.t.sid)} (manquant sur ${recents.map((b) => bons.nomBon(b.id)).join(" et ")})`;
    echecs.push({ ligne: x.l, qte: x.manque, motif, t });
  }
  if (echecs.length) {
    const r = await E.isolerPourRemboursement(o, echecs);
    for (const e of echecs) Object.assign(e.t, { fin: "rembourser", rid: r.rid });
    alertes.push(`${echecs.map((e) => `${e.ligne.sku} x${e.qte} ${e.motif}`).join(" ; ")} → ${r.commentaire}`);
  }
  await E.ecrireCommande(o, trace, alertes, "Réception");
}

console.log(`\n${bilan(APPLIQUER, E.actions)}`);
