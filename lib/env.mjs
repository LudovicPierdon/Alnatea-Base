// Lecture des secrets centralisés dans « Mon Drive\Claude\acces\.env » (KEY=VALEUR).
// Une variable d'environnement système du même nom a priorité sur le fichier.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FICHIER_ENV = fileURLToPath(new URL("../../../acces/.env", import.meta.url));

let cache = null;
function charger() {
  if (cache) return cache;
  cache = {};
  let texte = "";
  try { texte = readFileSync(FICHIER_ENV, "utf8").replace(/^﻿/, ""); } catch { return cache; }
  for (const ligne of texte.split(/\r?\n/)) {
    const l = ligne.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i < 0) continue;
    cache[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return cache;
}

/** Valeur d'une clé (environnement système, puis .env). Lève une erreur si absente et sans défaut. */
export function env(cle, defaut) {
  const v = process.env[cle] ?? charger()[cle];
  if (v === undefined || v === "") {
    if (defaut !== undefined) return defaut;
    throw new Error(`Clé « ${cle} » absente de ${FICHIER_ENV} (et de l'environnement)`);
  }
  return v;
}
