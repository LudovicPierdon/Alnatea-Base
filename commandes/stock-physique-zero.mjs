// Remet le stock PHYSIQUE à zéro pour tous les produits du catalogue (flux tendu : rien n'est en entrepôt).
// Dans ce compte, l'API renvoie un stock net des réservations (physique = stock + réservé) : la cible est donc
// stock = −réservé pour chaque produit dont stock + réservé ≠ 0.
// Le contrôle strict des documents de stock doit être DÉSACTIVÉ le temps de l'opération (l'API est bloquée sinon).
//
// Étape de test obligatoire : le premier produit écrit est relu pour déterminer si l'API interprète la valeur
// envoyée comme le physique ou comme le net ; le script s'arrête si le résultat n'est pas celui attendu.
//
// Usage : node commandes/stock-physique-zero.mjs [--appliquer] [--produit=ID]
//   sans option     simulation : liste les produits à corriger, n'écrit rien
//   --appliquer     écrit dans Base (test sur un produit, puis lots de 1000)
//   --produit=ID    ne traite que ce produit (utile pour le test)
import { bl } from "../lib/baselinker.mjs";
import { INV, WH, options, creerJournal, sleep } from "./lib-commandes.mjs";

const { APPLIQUER, PRODUIT } = options();
const log = creerJournal("stock-physique-zero", APPLIQUER);
console.log(`Stock physique à zéro — ${APPLIQUER ? "ÉCRITURE DANS BASE" : "simulation (rien n'est écrit)"}${PRODUIT ? ` — produit ${PRODUIT}` : ""}`);

const lire = async () => {
  const out = {};
  for (let page = 1; page < 20; page++) {
    const d = await bl("getInventoryProductsStock", { inventory_id: INV, page });
    const ps = Object.values(d.products || {});
    for (const p of ps) out[p.product_id] = { stock: Number((p.stock || {})[WH] ?? 0), res: Number((p.reservations || {})[WH] ?? 0) };
    if (ps.length < 1000) break;
  }
  return out;
};
const etat = await lire();
const aCorriger = Object.entries(etat).filter(([pid, v]) => v.stock + v.res !== 0 && (!PRODUIT || pid === PRODUIT));
const skus = {};
for (let i = 0; i < aCorriger.length; i += 1000) {
  const d = await bl("getInventoryProductsData", { inventory_id: INV, products: aCorriger.slice(i, i + 1000).map(([pid]) => pid) });
  for (const [pid, p] of Object.entries(d.products || {})) skus[pid] = p.sku;
}
console.log(`produits dont le physique ≠ 0 : ${aCorriger.length}`);
for (const [pid, v] of aCorriger) log(`  ${skus[pid] || pid} : stock ${v.stock}, réservé ${v.res}, physique ${v.stock + v.res} → stock cible ${-v.res}`);
if (!APPLIQUER || !aCorriger.length) { console.log("\nBilan (simulation) : rien n'est écrit"); process.exit(0); }

// Test sur le premier produit : on envoie la valeur « physique » 0 et on relit.
const [pid0, v0] = aCorriger[0];
await bl("updateInventoryProductsStock", { inventory_id: INV, products: { [pid0]: { [WH]: 0 } } });
await sleep(1500);
const relu = (await lire())[pid0];
let mode;
if (relu.stock === -relu.res) mode = "physique"; // 0 envoyé = physique 0 → stock net −réservé
else if (relu.stock === 0) mode = "net"; // 0 envoyé = net 0
else { log(`  ! test ${skus[pid0] || pid0} : relu stock ${relu.stock}, réservé ${relu.res} — résultat inattendu, arrêt`); process.exit(1); }
log(`  test ${skus[pid0] || pid0} : l'API interprète la valeur comme le stock ${mode} (relu stock ${relu.stock}, réservé ${relu.res})`);
const valeur = (v) => (mode === "physique" ? 0 : -v.res);
if (mode === "net" && relu.res !== 0) await bl("updateInventoryProductsStock", { inventory_id: INV, products: { [pid0]: { [WH]: -relu.res } } });

const reste = aCorriger.slice(1);
for (let i = 0; i < reste.length; i += 1000) {
  const lot = Object.fromEntries(reste.slice(i, i + 1000).map(([pid, v]) => [pid, { [WH]: valeur(v) }]));
  const r = await bl("updateInventoryProductsStock", { inventory_id: INV, products: lot });
  if (r.warnings && Object.keys(r.warnings).length) log(`  ! avertissements : ${JSON.stringify(r.warnings).slice(0, 500)}`);
  log(`  lot ${i / 1000 + 1} : ${Object.keys(lot).length} produit(s) écrit(s)`);
}
await sleep(1500);
const apres = await lire();
const restants = Object.entries(apres).filter(([pid, v]) => v.stock + v.res !== 0 && (!PRODUIT || pid === PRODUIT));
log(`Bilan (écrit dans Base) : ${aCorriger.length} produit(s) corrigé(s), physique ≠ 0 restant : ${restants.length}${restants.length ? " → " + restants.map(([pid, v]) => `${skus[pid] || pid} ${v.stock}/${v.res}`).join(", ") : ""}`);
