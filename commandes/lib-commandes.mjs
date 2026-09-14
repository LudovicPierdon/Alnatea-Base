// Bibliothèque commune des scripts « commandes » (Base = BaseLinker, catalogue Alnatea 27452, entrepôt bl_45864).
// Utilisée par commande-fournisseur.mjs, stock-check.mjs et reception-partielle.mjs.
//
// Sémantique du stock dans ce compte : la valeur `stock` renvoyée par l'API est déjà nette des réservations
// (physique = stock + réservé). Un stock négatif est donc du manquant.
//
// Trace par commande client (champ commande 44156 « QT ajouté », texte limité à 200 caractères par Base).
// En mémoire : [{ opid, pid, ean, sid, poid, qty, try?, ann?, fin? }]
//   opid  : identifiant de la ligne de commande     pid / ean : produit (relus sur la ligne de commande)
//   sid   : fournisseur (relu sur le bon)            poid : bon de commande fournisseur courant
//   qty   : quantité commandée au fournisseur pour cette ligne
//   try   : 2 après un premier échec de réception   ann : 1 si annulation déjà traitée   fin : « rembourser »
// Dans le champ : format compact « ~opid.poid.qty[flags];+delta.poid.qty… » (nombres en base 36, opid en delta
// par rapport à la ligne précédente, flags : 2 = 2e tentative, a = annulation traitée, r = remboursement) ;
// ~14 caractères par ligne, donc 14 lignes possibles. L'ancien format JSON de l'add-on (« [{"opid":…}] ») est
// encore lu ; il dépassait 200 caractères dès 3 lignes et était alors tronqué (illisible).
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bl } from "../lib/baselinker.mjs";

export const INV = 27452, WH = "bl_45864", WH_ID = 45864, DEVISE = "EUR";
export const ST = { NOUVELLES: 141531, EXPEDIER: 141532, ATTENTE: 146725, EN_STOCK: 146726, ENVOYE: 141533, PARTIEL: 142067, A_REMBOURSER: 150724, ANNULEES: 141534 };
export const NOM_STATUT = { 141531: "Nouvelles commandes", 141532: "Mis en expédier", 146725: "En attente de réception", 146726: "En stock", 141533: "Envoyé", 142067: "Envoi partiel", 150724: "A rembourser", 141534: "Annulées" };
/** Statuts dont les lignes constituent la demande ouverte (réservations légitimes). */
export const STATUTS_DEMANDE = new Set([ST.NOUVELLES, ST.EXPEDIER, ST.ATTENTE, ST.EN_STOCK]);
export const CHAMP_TRACE = "44156", CHAMP_FOURNISSEUR_PRODUIT = "extra_field_12633";
/** Statuts de bon de commande clos : 3 terminé, 4 terminé partiellement, 5 annulé (0 brouillon, 1/6 envoyé, 2 en réception = ouverts). */
export const PO_CLOS = new Set([3, 4, 5]);
export const NOM_STATUT_BON = { 0: "brouillon", 1: "envoyé", 2: "en réception", 3: "terminé", 4: "terminé partiellement", 5: "annulé", 6: "envoyé" };
export const MAX_COMMENTAIRE = 200;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dateLocale = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const AUJOURDHUI = dateLocale();
export const dateCourte = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

/** Options de ligne de commande communes : --appliquer, --jours=N, --commande=ID, --rattrapage, --produit=ID, --delai=N. */
export function options(argv = process.argv.slice(2), { jours = 90, delai = 60 } = {}) {
  const opt = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  return {
    APPLIQUER: argv.includes("--appliquer"),
    JOURS: Number(opt("jours") || jours),
    SEULE: opt("commande") ? Number(opt("commande")) : null,
    PRODUIT: opt("produit") ? String(opt("produit")) : null,
    RATTRAPAGE: argv.includes("--rattrapage"),
    DELAI: opt("delai") === null ? delai : Number(opt("delai")),
    opt,
  };
}

/** Journal mensuel commandes/journal/<nom>-AAAA-MM.log : une ligne par action, et écho console. */
export function creerJournal(nom, APPLIQUER) {
  const ici = (f) => fileURLToPath(new URL(f, import.meta.url));
  mkdirSync(ici("journal"), { recursive: true });
  const fichier = ici(`journal/${nom}-${AUJOURDHUI.slice(0, 7)}.log`);
  return (msg) => {
    console.log(msg);
    try { appendFileSync(fichier, `${new Date().toISOString()} ${APPLIQUER ? "APPLIQUER" : "SIMULATION"} ${msg}\n`); } catch { /* journal facultatif (ex. GitHub Actions) */ }
  };
}

const b36 = (n) => Number(n).toString(36);
const deB36 = (s) => parseInt(s, 36);
/** Encode la trace au format compact (voir en-tête). Les champs pid/ean/sid ne sont pas stockés (relus). */
export function encoderTrace(entries) {
  let prec = 0;
  return "~" + entries.map((t) => {
    const opid = Number(t.opid);
    const part = prec ? `+${b36(opid - prec)}` : b36(opid);
    prec = opid;
    const flags = `${Number(t.try) >= 2 ? "2" : ""}${t.ann ? "a" : ""}${t.fin ? "r" : ""}`;
    return `${part}.${t.poid ? b36(t.poid) : ""}.${b36(t.qty || 0)}${flags}`;
  }).join(";");
}
/** Lit la trace d'une commande (format compact ou ancien JSON). Renvoie [] si absente ou illisible. */
export function lireTrace(o) {
  const brut = (o.custom_extra_fields || {})[CHAMP_TRACE] || "";
  if (!brut.startsWith("~")) { try { const t = JSON.parse(brut || "[]"); return Array.isArray(t) ? t : []; } catch { return []; } }
  const lignes = Object.fromEntries((o.products || []).map((l) => [String(l.order_product_id), l]));
  const out = []; let prec = 0;
  for (const e of brut.slice(1).split(";").filter(Boolean)) {
    const m = /^(\+?)([0-9a-z]+)\.([0-9a-z]*)\.([0-9a-z]+?)([2ar]*)$/.exec(e);
    if (!m) continue;
    const opid = m[1] ? prec + deB36(m[2]) : deB36(m[2]);
    prec = opid;
    const l = lignes[String(opid)];
    const t = { opid, pid: l ? Number(l.product_id) : null, ean: l?.ean || "", sid: null, poid: m[3] ? deB36(m[3]) : null, qty: deB36(m[4]) };
    if (m[5].includes("2")) t.try = 2;
    if (m[5].includes("a")) t.ann = 1;
    if (m[5].includes("r")) t.fin = "rembourser";
    out.push(t);
  }
  return out;
}
/** Vrai si la commande porte une trace lisible (même vide : « ~ » ou « [] » = traitée, rien à commander). */
export function estTracee(o) {
  const brut = (o.custom_extra_fields || {})[CHAMP_TRACE] || "";
  if (!brut) return false;
  if (brut.startsWith("~")) return true;
  try { return Array.isArray(JSON.parse(brut)); } catch { return false; }
}

/** Commandes clients confirmées des N derniers jours (dédoublonnées par order_id, statut lu sur chaque commande). */
export async function chargerCommandes(jours) {
  const commandes = new Map();
  let depuis = Math.floor(Date.now() / 1000) - jours * 86400;
  for (let i = 0; i < 200; i++) {
    const d = await bl("getOrders", { date_confirmed_from: depuis, include_custom_extra_fields: true });
    const os = d.orders || [];
    let nouveaux = 0;
    for (const o of os) if (!commandes.has(o.order_id)) { commandes.set(o.order_id, o); nouveaux++; }
    if (os.length < 100 || nouveaux === 0) break;
    depuis = Math.max(...os.map((o) => o.date_confirmed));
    await sleep(200);
  }
  return commandes;
}

export function resumeStatuts(commandes) {
  const parStatut = {};
  for (const o of commandes.values()) parStatut[o.order_status_id] = (parStatut[o.order_status_id] || 0) + 1;
  return Object.entries(parStatut).map(([k, v]) => `${NOM_STATUT[k] || k} ${v}`).join(", ");
}

/** Demande ouverte par produit : somme des lignes des commandes en statut de demande. */
export function demandeOuverte(commandes) {
  const demande = {};
  for (const o of commandes.values()) {
    if (!STATUTS_DEMANDE.has(o.order_status_id)) continue;
    for (const l of o.products || []) if (l.product_id && String(l.product_id) !== "0") demande[l.product_id] = (demande[l.product_id] || 0) + Number(l.quantity);
  }
  return demande;
}

/**
 * Bons de commande fournisseur de l'entrepôt : liste complète (tous statuts), lignes des bons ouverts,
 * quantités en attente (commandées non reçues sur les bons ouverts), brouillon courant par fournisseur.
 */
export async function chargerBons() {
  const bons = [];
  for (let page = 1; page < 50; page++) {
    const d = await bl("getInventoryPurchaseOrders", { warehouse_id: WH_ID, page }); // sans inventory_id (sinon liste vide)
    const ps = d.purchase_orders || [];
    bons.push(...ps);
    if (ps.length < 100) break;
  }
  const parId = Object.fromEntries(bons.map((b) => [b.id, b]));
  const bonsOuverts = bons.filter((b) => !PO_CLOS.has(Number(b.status)));
  const lignesBon = {};
  for (const b of bonsOuverts) {
    lignesBon[b.id] = (await bl("getInventoryPurchaseOrderItems", { order_id: b.id })).items || [];
    await sleep(100);
  }
  const enAttente = {};
  for (const b of bonsOuverts) for (const it of lignesBon[b.id]) {
    const reste = Math.max(0, Number(it.quantity) - Number(it.completed_quantity || 0));
    enAttente[it.product_id] = (enAttente[it.product_id] || 0) + reste;
  }
  const brouillons = {};
  for (const b of bonsOuverts.filter((b) => Number(b.status) === 0)) if (!brouillons[b.supplier_id] || b.id > brouillons[b.supplier_id].id) brouillons[b.supplier_id] = b;
  const fournisseurs = Object.fromEntries(((await bl("getInventorySuppliers", {})).suppliers || []).map((s) => [s.supplier_id, s]));
  const nomBon = (id) => parId[id]?.document_number || parId[id]?.name || `bon ${id}`;
  const nomFournisseur = (sid) => fournisseurs[sid]?.name || `fournisseur ${sid}`;
  return { bons, parId, bonsOuverts, lignesBon, enAttente, brouillons, fournisseurs, nomBon, nomFournisseur };
}

/** Données produits (stock net, réservations, fournisseur principal, coût) pour un ensemble d'identifiants. */
export async function chargerProduits(ids, fournisseurs) {
  const fournisseurParNom = Object.fromEntries(Object.values(fournisseurs).map((s) => [s.name.trim().toLowerCase(), s.supplier_id]));
  const produits = {};
  const liste = [...new Set([...ids].map(String))];
  for (let i = 0; i < liste.length; i += 1000) {
    const d = await bl("getInventoryProductsData", { inventory_id: INV, products: liste.slice(i, i + 1000), include_suppliers: true });
    Object.assign(produits, d.products || {});
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
  return { produits, infoProduit };
}

/** Identifiants produits présents dans les lignes d'un ensemble de commandes (liées au catalogue). */
export function produitsDesCommandes(commandes) {
  const ids = new Set();
  for (const o of commandes.values()) for (const l of o.products || []) if (l.product_id && String(l.product_id) !== "0") ids.add(String(l.product_id));
  return ids;
}

/**
 * Écritures sur les bons de commande et les commandes clients. `ctx` = { APPLIQUER, log, bons (chargerBons), actions }.
 */
/** Ligne de bon de commande à renvoyer à l'API : champs vides ou dates nulles omis (sinon ERROR_INVALID_DATE). */
export const ligneBon = (it, quantity) => {
  const out = { product_id: Number(it.product_id), quantity };
  for (const k of ["item_cost", "supplier_code", "location", "batch", "expiry_date", "serial_no", "comments"]) {
    const v = it[k];
    if (v === undefined || v === null || v === "" || (typeof v === "string" && v.startsWith("0000"))) continue;
    out[k] = v;
  }
  return out;
};

export function ecritures(ctx) {
  const { APPLIQUER, log, bons } = ctx;
  const actions = ctx.actions || (ctx.actions = {});
  const compte = (k, n = 1) => { actions[k] = (actions[k] || 0) + n; };

  /** Ajoute `qte` du produit au brouillon courant du fournisseur (créé au besoin). Renvoie l'identifiant du bon. */
  async function ajouterAuBrouillon(pid, info, qte, origine, sid = info.supplier_id) {
    let bon = bons.brouillons[sid];
    if (!bon) {
      if (APPLIQUER) {
        // Payeur : le compte n'a aucun payeur (getInventoryPayers vide) et les bons créés dans le panneau portent -1,
        // refusé par l'API (ERROR_PAYER_NOT_FOUND). On essaie sans payer_id, puis avec un payeur existant s'il y en a.
        const candidats = [{}];
        for (const p of (await bl("getInventoryPayers", {})).payers || []) candidats.push({ payer_id: p.payer_id ?? p.id });
        let r = null, erreur = null;
        for (const c of candidats) {
          try { r = await bl("addInventoryPurchaseOrder", { warehouse_id: WH_ID, supplier_id: sid, currency: DEVISE, name: "", ...c }); break; }
          catch (e) { erreur = e; }
        }
        if (!r) throw new Error(`impossible de créer un brouillon pour ${bons.nomFournisseur(sid)} : ${erreur?.message} — créer un payeur dans Base (Bons de commande → paramètres) ou le brouillon à la main`);
        bon = { id: r.order_id, supplier_id: sid, status: 0, document_number: r.document_number };
      } else bon = { id: `NOUVEAU-${sid}`, supplier_id: sid, status: 0, document_number: "(à créer)" };
      bons.brouillons[sid] = bon; bons.lignesBon[bon.id] = []; bons.parId[bon.id] = bon; compte("bonsCrees");
      log(`  + brouillon ${bon.document_number} créé pour ${bons.nomFournisseur(sid)} (${sid})`);
    }
    const existante = bons.lignesBon[bon.id].find((it) => String(it.product_id) === String(pid));
    const ancienne = existante ? Number(existante.quantity) : 0;
    const nouvelleQte = ancienne + qte;
    // L'API remplace la ligne existante du même produit (elle n'additionne pas) : on renvoie ancienne + nouvelle.
    const item = existante ? ligneBon(existante, nouvelleQte) : ligneBon({ product_id: pid, item_cost: info.cout, supplier_code: info.supplier_code }, nouvelleQte);
    if (APPLIQUER) await bl("addInventoryPurchaseOrderItems", { order_id: bon.id, items: [item] });
    if (existante) existante.quantity = nouvelleQte; else bons.lignesBon[bon.id].push({ ...item, completed_quantity: 0 });
    bons.enAttente[pid] = (bons.enAttente[pid] || 0) + qte;
    compte("lignes");
    log(`  + ${info.sku} ${info.ean} : ${existante ? `ligne ${ancienne} → ${nouvelleQte}` : `nouvelle ligne ${qte}`} dans ${bon.document_number} (${bons.nomFournisseur(sid)}) — ${origine}`);
    return bon.id;
  }

  /** Retire `qte` du produit d'un bon encore brouillon. Renvoie un message d'alerte si impossible, sinon null. */
  async function retirerDuBrouillon(poid, pid, qte, info, origine) {
    const bon = bons.parId[poid];
    if (!bon) return null;
    if (Number(bon.status) !== 0) return PO_CLOS.has(Number(bon.status)) ? null : `${info.sku} x${qte} déjà commandé (bon ${bons.nomBon(poid)} envoyé)`;
    const ligne = (bons.lignesBon[poid] || []).find((it) => String(it.product_id) === String(pid));
    if (!ligne) return `${info.sku} x${qte} absent du brouillon ${bons.nomBon(poid)}`;
    const nouvelle = Number(ligne.quantity) - Number(qte);
    if (nouvelle <= 0) return `retirer ${info.sku} du brouillon ${bons.nomBon(poid)} à la main (ligne à 0)`;
    if (APPLIQUER) await bl("addInventoryPurchaseOrderItems", { order_id: poid, items: [ligneBon(ligne, nouvelle)] });
    log(`  - ${info.sku} : ligne ${ligne.quantity} → ${nouvelle} dans ${bons.nomBon(poid)} — ${origine}`);
    ligne.quantity = nouvelle; bons.enAttente[pid] = Math.max(0, (bons.enAttente[pid] || 0) - Number(qte));
    compte("retraits");
    return null;
  }

  /** Écrit la trace et, s'il y a des alertes, un commentaire administrateur daté sur la commande client. */
  async function ecrireCommande(o, trace, alertes, prefixe = "Cde fournisseur") {
    let texteTrace = encoderTrace(trace);
    if (texteTrace.length > 200) { // au-delà de la limite du champ : on abandonne les lignes sans bon ni marqueur
      texteTrace = encoderTrace(trace.filter((t) => t.poid || t.try || t.ann || t.fin));
      if (texteTrace.length > 200) alertes = [...alertes, `trace trop longue (${texteTrace.length} car.), tronquée`];
    }
    const champs = { order_id: o.order_id, custom_extra_fields: { [CHAMP_TRACE]: texteTrace.slice(0, 200) } };
    if (alertes.length) {
      const ajout = `[${prefixe} ${AUJOURDHUI}] ${alertes.join(" ; ")}`;
      const ancien = (o.admin_comments || "").trim();
      let texte = ancien ? `${ancien}\n${ajout}` : ajout;
      if (texte.length > MAX_COMMENTAIRE) texte = ajout.slice(0, MAX_COMMENTAIRE);
      champs.admin_comments = texte; o.admin_comments = texte;
      compte("alertes", alertes.length);
      log(`  ! commande ${o.order_id} : ${ajout}`);
    }
    o.custom_extra_fields = { ...(o.custom_extra_fields || {}), [CHAMP_TRACE]: champs.custom_extra_fields[CHAMP_TRACE] };
    if (APPLIQUER) await bl("setOrderFields", champs);
  }

  /** Change le statut d'une commande client (journalisé). */
  async function changerStatut(o, statut, motif) {
    log(`  > commande ${o.order_id} : ${NOM_STATUT[o.order_status_id] || o.order_status_id} → ${NOM_STATUT[statut] || statut} — ${motif}`);
    if (APPLIQUER) await bl("setOrderStatus", { order_id: o.order_id, status_id: statut });
    o.order_status_id = statut; compte("statuts");
  }

  /**
   * Isole des lignes en échec définitif pour remboursement.
   * `echecs` = [{ ligne (produit de la commande), qte (quantité à rembourser), motif }].
   * - toutes les lignes de la commande entièrement en échec → la commande passe elle-même en « A rembourser » ;
   * - sinon → création d'une commande de remboursement (statut « A rembourser », port 0, lignes non liées au
   *   catalogue pour ne rien réserver), puis suppression / réduction des lignes dans la commande d'origine
   *   (ce qui libère leur réservation). Renvoie { rid, commentaire }.
   */
  async function isolerPourRemboursement(o, echecs) {
    const lignes = o.products || [];
    const qteEchec = (l) => echecs.filter((e) => e.ligne.order_product_id === l.order_product_id).reduce((s, e) => s + e.qte, 0);
    const toutEnEchec = lignes.every((l) => qteEchec(l) >= Number(l.quantity));
    const montant = echecs.reduce((s, e) => s + e.qte * Number(e.ligne.price_brutto), 0);
    const libelle = echecs.map((e) => `${e.ligne.sku || e.ligne.ean} x${e.qte}`).join(", ");
    if (toutEnEchec) {
      await changerStatut(o, ST.A_REMBOURSER, `toutes les lignes en échec (${libelle}), ${montant.toFixed(2)} ${o.currency || DEVISE} à rembourser`);
      compte("remboursements");
      return { rid: null, commentaire: `à rembourser en totalité : ${libelle} (${montant.toFixed(2)} ${o.currency || DEVISE})` };
    }
    const ref = o.external_order_id || o.shop_order_id || o.order_id;
    const nouvelle = {
      order_status_id: ST.A_REMBOURSER, custom_source_id: 0, date_add: Math.floor(Date.now() / 1000), currency: o.currency || DEVISE,
      payment_method: o.payment_method || "", payment_method_cod: false, paid: true,
      user_comments: "", admin_comments: `Remboursement partiel de la commande ${o.order_id} (${o.order_source} ${ref}) : ${echecs.map((e) => e.motif).join(" ; ")}`.slice(0, MAX_COMMENTAIRE),
      phone: o.phone || "", email: o.email || "", user_login: o.user_login || "",
      delivery_method: o.delivery_method || "", delivery_price: 0,
      delivery_fullname: o.delivery_fullname || "", delivery_company: o.delivery_company || "", delivery_address: o.delivery_address || "", delivery_city: o.delivery_city || "", delivery_state: o.delivery_state || "", delivery_postcode: o.delivery_postcode || "", delivery_country_code: o.delivery_country_code || "",
      delivery_point_id: "", delivery_point_name: "", delivery_point_address: "", delivery_point_postcode: "", delivery_point_city: "",
      invoice_fullname: o.invoice_fullname || "", invoice_company: o.invoice_company || "", invoice_nip: o.invoice_nip || "", invoice_address: o.invoice_address || "", invoice_city: o.invoice_city || "", invoice_state: o.invoice_state || "", invoice_postcode: o.invoice_postcode || "", invoice_country_code: o.invoice_country_code || "",
      want_invoice: false, extra_field_1: String(o.extra_field_1 || ""), extra_field_2: `Remboursement partiel cde ${o.order_id}`,
      custom_extra_fields: {},
      products: echecs.map((e) => ({
        storage: "db", storage_id: 0, product_id: 0, variant_id: 0, // ligne non liée au catalogue : aucune réservation
        name: `${e.ligne.name} [remboursement, ${e.motif}]`.slice(0, 200), sku: e.ligne.sku || "", ean: e.ligne.ean || "", location: "", warehouse_id: 0, attributes: e.ligne.attributes || "",
        price_brutto: Number(e.ligne.price_brutto), tax_rate: Number(e.ligne.tax_rate || 0), quantity: e.qte, weight: Number(e.ligne.weight || 0),
      })),
    };
    let rid = "(simulation)";
    if (APPLIQUER) rid = (await bl("addOrder", nouvelle)).order_id;
    log(`  + commande de remboursement ${rid} créée en « A rembourser » pour la commande ${o.order_id} : ${libelle} = ${montant.toFixed(2)} ${nouvelle.currency}, port 0`);
    for (const l of lignes) {
      const q = qteEchec(l);
      if (q <= 0) continue;
      if (q >= Number(l.quantity)) {
        if (APPLIQUER) await bl("deleteOrderProduct", { order_id: o.order_id, order_product_id: l.order_product_id });
        log(`  - commande ${o.order_id} : ligne ${l.sku} x${l.quantity} supprimée (réservation libérée)`);
      } else {
        if (APPLIQUER) await bl("setOrderProductFields", { order_id: o.order_id, order_product_id: l.order_product_id, quantity: Number(l.quantity) - q });
        log(`  - commande ${o.order_id} : ligne ${l.sku} ${l.quantity} → ${Number(l.quantity) - q}`);
      }
    }
    o.products = lignes.map((l) => ({ ...l, quantity: Number(l.quantity) - qteEchec(l) })).filter((l) => l.quantity > 0);
    compte("remboursements");
    return { rid, commentaire: `remboursement ${rid} créé : ${libelle} (${montant.toFixed(2)} ${nouvelle.currency}), lignes retirées de la commande` };
  }

  return { ajouterAuBrouillon, retirerDuBrouillon, ecrireCommande, changerStatut, isolerPourRemboursement, actions };
}

export function bilan(APPLIQUER, actions) {
  const parts = Object.entries(actions).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
  return `Bilan ${APPLIQUER ? "(écrit dans Base)" : "(simulation)"} : ${parts.join(", ") || "rien à faire"}`;
}
