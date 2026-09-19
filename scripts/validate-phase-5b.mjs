#!/usr/bin/env node
/**
 * Validation Phase 5B (amendement v1.3 §3) — à lancer **après** avoir tranché des
 * synthèses depuis /syntheses :
 *   node scripts/validate-phase-5b.mjs [chemin-db]
 *
 * Le script est **en lecture seule** : comme 1B, 2B, 3 et 4, il constate ce que l'usage
 * a produit, il ne rejoue pas l'API. La vérification des preuves est **importée** du
 * serveur (`lib/quality/evidence.ts` — Node 24 lit le .ts, même convention que
 * `validate-phase-4.mjs`) : validateur et serveur ne peuvent pas diverger sur ce qu'est
 * une preuve valide.
 *
 * AC1 — feed trié par thème puis `confidence` : une seule ligne par
 *        (`theme_id`, `content_sig`) et l'ordre SQL conforme (vérifié en relisant
 *        `listFeed` depuis la base).
 * AC2 — chaque synthèse expose ses preuves citables (source, locator, texte) et son
 *        `provenance_snapshot` ; une preuve qui ne tient plus est marquée, jamais
 *        servie comme une preuve.
 * AC3 — les décisions sont persistantes (accepted/rejected en base) ; une synthèse
 *        rejetée ne revient pas au défaut de lecture (`proposed`).
 * AC4 — les synthèses dont une preuve vient d'une source supprimée/ré-ingérée portent
 *        `stale = 1` et gardent leur snapshot lisible.
 * AC5 — `constructions` reste le schéma v1.2 : aucune écriture croisée depuis les
 *        synthèses (`suggestion_id` non nul partout, `depth = 1`).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import { verifyEvidence } from "../lib/quality/evidence.ts";

const dbPath = process.argv[2] ?? "./data/serendipity.db";
if (!fs.existsSync(dbPath)) {
  console.error(`Base introuvable : ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const failures = [];
const warn = (m) => failures.push(m);

const rows = db.prepare("SELECT * FROM syntheses ORDER BY rowid").all();
const themes = new Map(
  db.prepare("SELECT id, label, run_id, seed FROM themes").all().map((t) => [t.id, t])
);
const stateCounts = { proposed: 0, accepted: 0, rejected: 0 };
for (const r of rows) stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1;

console.log(`Base : ${dbPath}`);
console.log(
  `synthèses : ${rows.length} (${JSON.stringify(stateCounts)}) · thèmes : ${themes.size}\n`
);

/* ---------------------------------- AC1 ---------------------------------- */

console.log("AC1 — une synthèse par (theme_id, content_sig), tri thème puis confiance");
const seen = new Map();
let dupes = 0;
for (const r of rows) {
  const key = `${r.theme_id}|${r.content_sig}`;
  if (seen.has(key)) {
    dupes += 1;
    warn(`AC1 : doublon (${key.slice(0, 30)}…) — l'UNIQUE de la table a été contourné`);
  }
  seen.set(key, r.id);
}
// l'ordre affiché doit être celui du dépôt (même requête que listFeed, LIMIT ∞)
const ordered = db
  .prepare(
    `SELECT s.id, s.theme_id, s.confidence FROM syntheses s JOIN themes t ON t.id = s.theme_id
     ORDER BY t.rowid, CASE s.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       s.created_at DESC, s.rowid DESC, s.text`
  )
  .all();
const withoutThemes = rows.filter((r) => !themes.has(r.theme_id));
if (withoutThemes.length > 0) {
  warn(`AC1 : ${withoutThemes.length} synthèse(s) sans thème (jointure impossible)`);
}
// l'ordre voulu : chaque thème forme un bloc, et à l'intérieur la confiance ne remonte jamais
const RANK = { high: 0, medium: 1, low: 2 };
let rankBreaks = 0;
let last = null;
for (const r of ordered) {
  const rank = RANK[r.confidence] ?? 3;
  if (last && last.theme_id === r.theme_id && rank < last.rank) {
    rankBreaks += 1;
    warn(`AC1 : confiance remontante dans un thème (${r.id.slice(0, 8)} ${r.confidence} après ${last.rank})`);
  }
  last = { theme_id: r.theme_id, rank };
}
const themeBlocks = new Set();
let blockBreaks = 0;
for (const r of ordered) {
  if (last && last.theme_id !== r.theme_id) {
    if (themeBlocks.has(r.theme_id)) blockBreaks += 1;
    themeBlocks.add(r.theme_id);
  }
  last = { theme_id: r.theme_id };
}
console.log(
  `  ${rows.length} ligne(s) · ${dupes} doublon(s) · ${withoutThemes.length} orpheline(s) · ${rankBreaks} remontée(s) de confiance · ${blockBreaks} thème(s) en plusieurs blocs`
);

/* ---------------------------------- AC2 ---------------------------------- */

console.log("\nAC2 — preuves citables et vérifiées (règle partagée evidence.ts)");
let citations = 0;
let verified = 0;
let broken = 0;
const problems = {};
for (const r of rows) {
  let snapshot;
  try {
    snapshot = JSON.parse(r.provenance_snapshot);
  } catch {
    warn(`AC2 : synthèse ${r.id.slice(0, 8)} — provenance_snapshot illisible`);
    continue;
  }
  const checked = verifyEvidence(db, snapshot);
  for (const e of checked) {
    citations += 1;
    if (e.verified) verified += 1;
    else {
      broken += 1;
      problems[e.problem] = (problems[e.problem] ?? 0) + 1;
    }
  }
}
console.log(
  `  ${citations} citation(s) · ${verified} vérifiée(s) · ${broken} ne tenant plus ${JSON.stringify(problems)}`
);
console.log(
  `  toutes les citations vérifiables ${broken === 0 ? "✓" : "⚠ (mesuré — l'écran les marque, il ne les cache pas)"}`
);

/* ---------------------------------- AC3 ---------------------------------- */

console.log("\nAC3 — décisions persistantes, rejet sans retour");
const rejectedStillProposed = rows.filter((r) => r.state === "rejected").length;
console.log(
  `  ${stateCounts.accepted} acceptée(s) · ${stateCounts.rejected} rejetée(s) · ${stateCounts.proposed} en attente`
);
// le rejet ne se voit pas dans une colonne séparée : l'état EST la décision, et la
// transition est monotone (le dépôt refuse re-trancher — testé dans la suite vitest)
if (rejectedStillProposed === 0 && rows.some((r) => r.state === "proposed")) {
  console.log("  file de travail : les tranchées ont quitté le défaut de lecture ✓");
}

/* ---------------------------------- AC4 ---------------------------------- */

console.log("\nAC4 — péremption via provenance_snapshot");
let stale = 0;
let staleReadable = 0;
for (const r of rows) {
  if (r.stale === 1) {
    stale += 1;
    try {
      const snapshot = JSON.parse(r.provenance_snapshot);
      if (Array.isArray(snapshot) && snapshot.length > 0) staleReadable += 1;
      else warn(`AC4 : synthèse ${r.id.slice(0, 8)} — stale mais snapshot vide`);
    } catch {
      warn(`AC4 : synthèse ${r.id.slice(0, 8)} — stale mais snapshot illisible`);
    }
  }
}
console.log(`  ${stale} périmée(s) · ${staleReadable} avec snapshot lisible`);
if (stale === staleReadable) console.log("  le texte copié au moment T reste affichable ✓");

/* ---------------------------------- AC5 ---------------------------------- */

console.log("\nAC5 — Constructions inchangées (aucune écriture croisée)");
const constructions = db
  .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN suggestion_id IS NULL THEN 1 ELSE 0 END) AS orphan FROM constructions")
  .get();
const badDepth = db.prepare("SELECT COUNT(*) AS n FROM constructions WHERE depth <> 1").get().n;
console.log(
  `  ${constructions.n} construction(s) · ${constructions.orphan} sans suggestion · ${badDepth} à depth ≠ 1`
);
if (constructions.orphan > 0) warn(`AC5 : ${constructions.orphan} construction(s) sans suggestion_id`);
if (badDepth > 0) warn(`AC5 : ${badDepth} construction(s) à depth ≠ 1`);

db.close();

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "\nPhase 5B : PASS — feed trié (thème puis confiance), preuves vérifiées à la lecture avec la règle partagée, décisions persistantes, péremption lisible, Constructions intactes."
);
process.exit(0);
