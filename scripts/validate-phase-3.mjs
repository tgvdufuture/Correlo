#!/usr/bin/env node
/**
 * Validation Phase 3 (PRD §4) — à lancer **après** avoir exercé l'API du feed :
 *   node scripts/validate-phase-3.mjs [chemin-db]
 *
 * Le script est en lecture seule et vérifie l'état **résultant du trafic réel** :
 * il ne rejoue pas l'API lui-même (comme 1B et 2B, il constate ce que l'usage a
 * produit). Le trafic se fait normalement sur une **copie** de la base, pour que
 * le test de suppression de source (AC3) ne touche pas le corpus de travail.
 *
 * AC1 — feed : une seule suggestion exposée par (pair_key, relation_type), tri par
 *       tier décroissant, chaque suggestion porte 2 fragments existants de 2
 *       sources distinctes.
 * AC2 — accept → Construction depth = 1, parent_source_ids ≥ 2 sources distinctes,
 *       evidence_fragment_ids réels, provenance_snapshot complet et fidèle,
 *       epistemic_status = min_rang(INFERENCE, statut suggestion) ; reject →
 *       raison ∈ énumération persistée ; 0 paire décidée n'a de variante vivante.
 * AC3 — suppression de source : les Constructions qui citaient le snapshot
 *       disparu sont stale = 1 et leur provenance reste lisible.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const dbPath = process.argv[2] ?? "./data/serendipity.db";
if (!fs.existsSync(dbPath)) {
  console.error(`Base introuvable : ${dbPath}`);
  process.exit(1);
}

const RANK = { FACT: 3, INFERENCE: 2, HYPOTHESIS: 1, SPECULATION: 0 };
const FEEDBACK_REASONS = ["trivial", "false", "already_known", "off_topic"];
const TIER = { strong: 0, medium: 1, weak: 2 };

const db = new Database(dbPath, { readonly: true });
const failures = [];
const warn = (m) => failures.push(m);

const suggestions = db.prepare("SELECT rowid, * FROM suggestions ORDER BY rowid").all();
const constructions = db.prepare("SELECT * FROM constructions ORDER BY rowid").all();
const fragments = new Map(
  db.prepare("SELECT id, text, locator, source_id FROM fragments").all().map((f) => [f.id, f])
);
const sources = new Map(db.prepare("SELECT id, title, content_hash FROM sources").all().map((s) => [s.id, s]));

console.log(`Base : ${dbPath}`);
console.log(`suggestions : ${suggestions.length} · constructions : ${constructions.length}\n`);

if (suggestions.length === 0 && constructions.length === 0) {
  warn("Aucune suggestion ni construction : l'API du feed n'a pas été exercée, rien à valider");
}

/* ---------------------------------- AC1 ---------------------------------- */

// Groupes (pair_key, relation_type) et leur représentante : tier le plus élevé,
// tie-break la plus récente — la règle §3.2 du feed.
const groups = new Map();
for (const s of suggestions) {
  const key = `${s.pair_key}|${s.relation_type}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(s);
}

const OPEN_STATES = new Set(["discovered", "shown", "opened"]);
const exposed = suggestions.filter((s) => OPEN_STATES.has(s.state));

// AC1 : deux variantes exposées de la même paire ne peuvent pas coexister
const exposedKeys = new Map();
for (const s of exposed) {
  const key = `${s.pair_key}|${s.relation_type}`;
  exposedKeys.set(key, (exposedKeys.get(key) ?? 0) + 1);
}
const duplicateExposed = [...exposedKeys.entries()].filter(([, n]) => n > 1);
if (duplicateExposed.length > 0) {
  warn(
    `AC1 : ${duplicateExposed.length} (pair_key, relation_type) exposée(s) plusieurs fois — ` +
      `le feed doit n'en retenir qu'une (tier le plus élevé, tie-break la plus récente)`
  );
}

// AC1 : tri par tier décroissant, puis plus récente d'abord (ordre d'insertion)
const feed = exposed
  .map((s) => ({
    ...s,
    // la représentante d'un groupe est celle qui a le meilleur rang, puis le rowid max
    best: groups
      .get(`${s.pair_key}|${s.relation_type}`)
      .reduce((a, b) => (TIER[a.tier] !== TIER[b.tier] ? (TIER[a.tier] < TIER[b.tier] ? a : b) : a.rowid > b.rowid ? a : b)),
  }))
  .filter((s) => s.id === s.best.id)
  .sort((a, b) => TIER[a.tier] - TIER[b.tier] || b.rowid - a.rowid);
// une ligne exposée doit être la représentante de son groupe : sinon le feed
// afficherait une variante moins bien classée que ce que la paire contient
const notRepresentative = exposed.filter(
  (s) => !feed.some((f) => f.id === s.id)
);
if (notRepresentative.length > 0 && exposed.length === groups.size && exposed.length > 0) {
  // ne peut arriver que si une variante non décidée cohabite avec une décidée
  warn(`AC1 : ${notRepresentative.length} suggestion(s) exposée(s) qui ne sont pas la représentante de leur paire`);
}
let orderErrors = 0;
for (let i = 1; i < feed.length; i++) {
  const prev = feed[i - 1];
  const cur = feed[i];
  if (TIER[prev.tier] > TIER[cur.tier] || (TIER[prev.tier] === TIER[cur.tier] && prev.rowid < cur.rowid)) {
    orderErrors += 1;
  }
}
if (orderErrors > 0) warn(`AC1 : ${orderErrors} inversion(s) dans le tri par tier / récence`);

// AC1 / US-05 AC1-AC2 : chaque suggestion porte ≥ 2 fragments réels, de 2 sources
let badFragments = 0;
for (const s of suggestions) {
  const fa = fragments.get(s.fragment_a_id);
  const fb = fragments.get(s.fragment_b_id);
  if (!fa || !fb) {
    badFragments += 1;
    continue;
  }
  if (fa.source_id === fb.source_id) badFragments += 1;
}
if (badFragments > 0) warn(`AC1 : ${badFragments} suggestion(s) sans 2 fragments de sources distinctes`);

const tierCounts = {};
for (const f of feed) tierCounts[f.tier] = (tierCounts[f.tier] ?? 0) + 1;
const stateCounts = {};
for (const s of suggestions) stateCounts[s.state] = (stateCounts[s.state] ?? 0) + 1;
console.log("AC1 — feed");
console.log(`  ${groups.size} paire(s) (pair_key, relation_type) · ${feed.length} exposée(s) · états ${JSON.stringify(stateCounts)}`);
console.log(`  tiers du feed : ${JSON.stringify(tierCounts)}`);
console.log(
  `  1 exposition par paire ${duplicateExposed.length === 0 ? "✓" : "✗"} · ` +
    `tri par tier ${orderErrors === 0 ? "✓" : "✗"} · ` +
    `2 fragments de sources distinctes ${badFragments === 0 ? "✓" : "✗"}`
);

/* ---------------------------------- AC2 ---------------------------------- */

console.log("\nAC2 — acceptation et rejet");

// 0 paire décidée avec une variante vivante (US-05 AC4 : « 0 rejetée ne réapparaît »)
let liveVariants = 0;
for (const [, rows] of groups) {
  const decided = rows.filter((r) => r.state === "accepted" || r.state === "rejected");
  if (decided.length === 0) continue;
  // toutes les lignes de la paire doivent porter la même décision
  const states = new Set(decided.map((r) => r.state));
  const reasons = new Set(decided.map((r) => r.feedback_reason));
  if (rows.length !== decided.length) liveVariants += rows.length - decided.length;
  if (states.size > 1 || reasons.size > 1) {
    warn(`AC2 : décision incohérente sur la paire ${rows[0].pair_key} / ${rows[0].relation_type}`);
  }
}
if (liveVariants > 0) warn(`AC2 : ${liveVariants} variante(s) encore vivante(s) sur une paire décidée`);

// reject : raison persistée et légale
const rejected = suggestions.filter((s) => s.state === "rejected");
const badReasons = rejected.filter((s) => !FEEDBACK_REASONS.includes(s.feedback_reason));
if (badReasons.length > 0) warn(`AC2 : ${badReasons.length} rejet(s) sans raison valide (US-06 AC1)`);
if (rejected.length > 0) {
  const reasons = {};
  for (const r of rejected) reasons[r.feedback_reason] = (reasons[r.feedback_reason] ?? 0) + 1;
  console.log(`  rejets : ${rejected.length} · raisons ${JSON.stringify(reasons)}`);
}

// accept : une Construction par suggestion, invariants de US-07
const bySuggestion = new Map();
for (const c of constructions) {
  if (c.suggestion_id) {
    bySuggestion.set(c.suggestion_id, (bySuggestion.get(c.suggestion_id) ?? 0) + 1);
  }
}
const doubleIntegrated = [...bySuggestion.entries()].filter(([, n]) => n > 1);
if (doubleIntegrated.length > 0) warn(`AC2 : ${doubleIntegrated.length} suggestion(s) intégrée(s) plusieurs fois`);

let snapshotOk = 0;
let snapshotDivergent = 0;
let snapshotOrphan = 0;
for (const c of constructions) {
  const suggestion = suggestions.find((s) => s.id === c.suggestion_id);
  if (c.depth !== 1) warn(`AC2 : construction ${c.id.slice(0, 8)} — depth ${c.depth} ≠ 1`);
  if (c.epistemic_status === "FACT") {
    warn(`AC2 : construction ${c.id.slice(0, 8)} — FACT interdit (US-07 AC2)`);
  }
  if (suggestion && RANK[c.epistemic_status] > RANK[suggestion.epistemic_status]) {
    warn(`AC2 : construction ${c.id.slice(0, 8)} — statut au-dessus de sa suggestion (pas de min_rang)`);
  }

  const parents = JSON.parse(c.parent_source_ids);
  const evidence = JSON.parse(c.evidence_fragment_ids);
  const snapshot = JSON.parse(c.provenance_snapshot);
  if (new Set(parents).size < 2) warn(`AC2 : construction ${c.id.slice(0, 8)} — ${new Set(parents).size} source(s) parente(s) (< 2)`);
  if (evidence.length < 2) warn(`AC2 : construction ${c.id.slice(0, 8)} — ${evidence.length} preuve(s) (< 2)`);
  if (snapshot.length !== evidence.length) {
    warn(`AC2 : construction ${c.id.slice(0, 8)} — snapshot ${snapshot.length} ≠ ${evidence.length} preuve(s)`);
  }
  if (snapshot.some((e) => !e.source_id || !e.source_content_hash || !e.fragment_id || !e.locator || !e.fragment_text)) {
    warn(`AC2 : construction ${c.id.slice(0, 8)} — snapshot incomplet (source, hash, fragment, locator, texte requis)`);
  }

  // Fidélité du snapshot : tant que le fragment existe, texte et locator doivent
  // correspondre ; s'il a disparu (source supprimée), la copie est la seule
  // source et c'est AC3 qui prend le relais.
  for (const e of snapshot) {
    const live = fragments.get(e.fragment_id);
    if (!live) {
      snapshotOrphan += 1;
      continue;
    }
    if (live.text !== e.fragment_text || live.locator !== e.locator) {
      snapshotDivergent += 1;
    } else {
      snapshotOk += 1;
    }
  }
}
if (snapshotDivergent > 0) {
  warn(`AC2 : ${snapshotDivergent} entrée(s) de provenance divergente(s) du fragment vivant`);
}
console.log(`  acceptations : ${constructions.length} · 1 seule par suggestion ${doubleIntegrated.length === 0 ? "✓" : "✗"}`);
console.log(
  `  provenance fidèle : ${snapshotOk} entrée(s) vérifiée(s) · ${snapshotOrphan} orpheline(s) (fragment disparu)`
);
console.log(`  0 variante vivante sur paire décidée ${liveVariants === 0 ? "✓" : "✗"} · raisons valides ${badReasons.length === 0 ? "✓" : "✗"}`);

/* ---------------------------------- AC3 ---------------------------------- */

console.log("\nAC3 — provenance et péremption");
const staleConstructions = constructions.filter((c) => c.stale === 1);
let staleWithoutReason = 0;
let staleNotFlagged = 0;
for (const c of constructions) {
  const snapshot = JSON.parse(c.provenance_snapshot);
  // une source citée par le snapshot n'existe plus ⇒ la Construction est périmée
  const missing = snapshot.some((e) => !sources.has(e.source_id));
  if (missing && c.stale !== 1) staleNotFlagged += 1;
  if (c.stale === 1 && !missing) staleWithoutReason += 1;
}
if (staleNotFlagged > 0) {
  warn(`AC3 : ${staleNotFlagged} construction(s) citant une source disparue sans stale = 1 (US-08 AC2)`);
}
if (staleWithoutReason > 0) {
  console.log(`  info : ${staleWithoutReason} construction(s) stale = 1 alors que toutes leurs sources existent (ré-ingestion)`);
}
for (const c of staleConstructions) {
  const snapshot = JSON.parse(c.provenance_snapshot);
  if (snapshot.some((e) => !e.fragment_text)) {
    warn(`AC3 : construction ${c.id.slice(0, 8)} périmée sans texte de provenance (US-08 AC1)`);
  }
}
console.log(`  ${constructions.length} construction(s) · ${staleConstructions.length} périmée(s)`);
console.log(
  `  péremption signalée ${staleNotFlagged === 0 ? "✓" : "✗"} · provenance lisible après suppression ${
    staleConstructions.every((c) => JSON.parse(c.provenance_snapshot).every((e) => e.fragment_text)) ? "✓" : "✗"
  }`
);
db.close();

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "\nPhase 3 : PASS — feed à une ligne par paire, acceptations conformes à US-07, provenance survivante et péremption signalée."
);
process.exit(0);
