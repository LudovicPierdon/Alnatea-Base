// Accès à l'API BaseLinker (https://api.baselinker.com/) pour le catalogue Alnatea.
// Le jeton BASELINKER_TOKEN est lu dans « Mon Drive\Société\Alnatea\Claude\acces\.env » via lib/env.mjs
// (ou dans la variable d'environnement du même nom) : ce fichier ne contient aucun secret.
import { env } from "./env.mjs";

const ENDPOINT = "https://api.baselinker.com/connector.php";

const jeton = () => env("BASELINKER_TOKEN");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Quota BaseLinker : 100 requêtes / minute pour TOUT le compte (scripts, serveur MCP, autres sessions) ; au-delà,
// Base bloque le jeton (blocage du 2026-10-03 vers 2 h). Frein commun : un appel toutes les 700 ms au plus (≈ 85 / min).
const INTERVALLE_MS = 700;
let prochain = 0;
async function frein() {
  const maintenant = Date.now(), attente = Math.max(0, prochain - maintenant);
  prochain = Math.max(maintenant, prochain) + INTERVALLE_MS;
  if (attente) await sleep(attente);
}

/** Appel d'une méthode BaseLinker. Renvoie la réponse JSON (status SUCCESS) ou lève une erreur. */
export async function bl(method, parameters = {}, { retries = 4 } = {}) {
  const body = new URLSearchParams({ method, parameters: JSON.stringify(parameters) });
  for (let attempt = 0; ; attempt++) {
    await frein();
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "X-BLToken": jeton(), "Content-Type": "application/x-www-form-urlencoded" }, body });
    const json = await res.json().catch(() => ({}));
    if (json.status === "SUCCESS") return json;
    // Limite BaseLinker : 100 requêtes / minute → attente puis nouvel essai.
    if (attempt < retries && (res.status === 429 || /limit/i.test(json.error_message || ""))) { await sleep(15000); continue; }
    throw new Error(`BaseLinker ${method} : ${json.error_code || res.status} ${json.error_message || ""}`.trim());
  }
}

/** Liste complète des produits d'un catalogue (pages de 1000 identifiants).
 *  Variantes incluses par défaut (sans include_variants, Base ne renvoie que les produits simples et les parents).
 *  Les parents de familles (SKU « FAM-… », sans EAN ni prix) ne se vendent pas : les écarter si besoin (p.sku.startsWith("FAM-")). */
export async function listeProduits(inventory_id, filtres = {}) {
  const out = {};
  for (let page = 1; ; page++) {
    const d = await bl("getInventoryProductsList", { inventory_id, page, include_variants: true, ...filtres });
    const ids = Object.keys(d.products || {});
    Object.assign(out, d.products);
    if (ids.length < 1000) break;
  }
  return out;
}

/** Données détaillées de produits par lots de 1000 identifiants (avec l'onglet Fournisseurs : `suppliers`). */
export async function donneesProduits(inventory_id, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 1000) {
    const d = await bl("getInventoryProductsData", { inventory_id, products: ids.slice(i, i + 1000), include_suppliers: true });
    Object.assign(out, d.products);
  }
  return out;
}
