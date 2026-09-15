#!/usr/bin/env node
/**
 * Validation Phase 2B (PRD §4) — à lancer après un run discover :
 *   node scripts/validate-phase-2b.mjs [chemin-db] [--run=val-div]
 *
 * AC1 — le job discover persiste `run_id`, `corpus_hash`, `seed`, `sampler_version`
 *       (table `discover_runs`, migration 005) et le run est **rejouable à
 *       l'identique**. Le contrôle est programmatique et sans LLM : l'identité
 *       persistée doit être **recalculable** à partir du corpus figé —
 *       `corpus_hash = SHA256(sorted source_id:content_hash)` et
 *       `seed = SHA256(corpus_hash | run_id)` — donc rejouable par un tiers, sans
 *       le payload du job. La sortie du run (`created_ids`) doit, elle, exister
 *       réellement en base.
 *
 * AC2 — les suggestions produites respectent §3.3 : 0 paire intra-source,
 *       0 doublon (UNIQUE pair_key, relation_type, content_sig), pair_key
 *       canonique, fragments existants, statut épistémique légal (FACT seulement
 *       si le claim est présent textuellement), aucun résumé cité en preuve.
 *
 * Le rejeu lui-même (même `run_id` relancé ⇒ mêmes suggestions) se démontre en
 * relançant `npm run discover -- --run-id=<id>` sur le même corpus : les lignes
 * `discover_runs.created_ids` avant/après doivent être identiques. Ce script en
 * vérifie la contrepartie statique (l'identité est recalculable et la sortie est
 * en base) ; le rejeu est mesuré côté job (`skipped.duplicate` = sortie reproduite).
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

const args = process.argv.slice(2).filter((a) => a.startsWith("--"));
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dbPath = positional[0] ?? "./data/serendipity.db";
const runOnly = args.find((a) => a.startsWith("--run="))?.slice("--run=".length) ?? null;

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
/** Canonicalisation §3.3 : NFKC → minuscules → espaces compactés → ponctuation finale retirée. */
const canonical = (s) =>
  String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…]+$/g, "");

const db = new Database(dbPath, { readonly: true });
const failures = [];
const warn = (msg) => failures.push(msg);

// --- table présente ? ---
const hasTable = !!db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discover_runs'")
  .get();
if (!hasTable) {
  console.error("Table discover_runs absente — migration 005 non appliquée.");
  process.exit(1);
}

const runs = runOnly
  ? db.prepare("SELECT * FROM discover_runs WHERE run_id = ?").all(runOnly)
  : db.prepare("SELECT * FROM discover_runs ORDER BY started_at, rowid").all();
if (runs.length === 0) {
  console.error(
    runOnly
      ? `Run ${runOnly} absent de discover_runs.`
      : "Aucun run dans discover_runs — lancer npm run discover d'abord."
  );
  process.exit(1);
}

console.log(`discover_runs : ${runs.length} run(s)${runOnly ? ` (filtré sur ${runOnly})` : ""}\n`);

const round = (hex) => `${hex.slice(0, 12)}…`;
const allCreatedIds = new Set();

for (const run of runs) {
  console.log(`--- ${run.run_id} [${run.status}] ${run.sampler} / ${run.sampler_version}`);
  const sourceIds = JSON.parse(run.source_ids);
  const createdIds = JSON.parse(run.created_ids);
  const skipped = JSON.parse(run.skipped ?? "{}");

  // --- AC1 : identité complète ---
  for (const field of ["run_id", "corpus_hash", "seed", "sampler_version", "prompt_version", "chat_model"]) {
    if (!run[field]) warn(`AC1 : ${run.run_id} — champ vide : ${field}`);
  }

  // corpus_hash recalculé depuis les sources figées du run
  const rows = db
    .prepare(
      `SELECT id, content_hash FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`
    )
    .all(...sourceIds);
  if (rows.length !== sourceIds.length) {
    warn(`AC1 : ${run.run_id} — ${sourceIds.length - rows.length} source(s) du run absente(s) de la base`);
  }
  const corpusHash = sha256(rows.map((r) => `${r.id}:${r.content_hash}`).sort().join("|"));
  const seed = sha256(`${corpusHash}|${run.run_id}`);
  const identityOk = corpusHash === run.corpus_hash && seed === run.seed;
  if (!identityOk) {
    warn(
      `AC1 : ${run.run_id} — identité non recalculable (corpus_hash ${corpusHash === run.corpus_hash ? "ok" : "≠"}, ` +
        `seed ${seed === run.seed ? "ok" : "≠"}) : le run n'est pas rejouable à l'identique`
    );
  }

  // sortie du run réellement en base
  const found = createdIds.length
    ? db
        .prepare(`SELECT id, prompt_version, chat_model FROM suggestions WHERE id IN (${createdIds.map(() => "?").join(",")})`)
        .all(...createdIds)
    : [];
  if (found.length !== createdIds.length) {
    warn(`AC1 : ${run.run_id} — ${createdIds.length - found.length} id(s) de created_ids absent(s) de suggestions`);
  }
  if (run.created !== createdIds.length) {
    warn(`AC1 : ${run.run_id} — created=${run.created} ≠ created_ids=${createdIds.length}`);
  }
  const promptVersions = [...new Set(found.map((f) => f.prompt_version))];
  if (promptVersions.some((v) => v !== run.prompt_version)) {
    console.log(
      `    info : suggestions rattachées produites avec un prompt différent (${promptVersions.join(", ")}) ` +
        `— rejeu d'un run antérieur au changement de prompt`
    );
  }
  console.log(
    `    identité ${identityOk ? "✓" : "✗"} · corpus ${sourceIds.length} docs · ${run.pairs} paires · ` +
      `${run.batch_calls} appel(s) batch (+${run.batch_calls_from_cache} cache) · ${run.created} suggestion(s)`
  );
  console.log(
    `    corpus_hash ${round(run.corpus_hash)} · seed ${round(run.seed)} · prompt ${run.prompt_version} · modèle ${run.chat_model}`
  );
  console.log(`    skipped ${JSON.stringify(skipped)}`);
  for (const id of createdIds) allCreatedIds.add(id);
  if (run.status !== "done") warn(`AC1 : ${run.run_id} — statut ${run.status} (run non terminé)`);
}

// --- AC2 : contraintes §3.3 sur les suggestions produites ---
const ids = [...allCreatedIds];
console.log(`\nAC2 — contraintes §3.3 sur les ${ids.length} suggestion(s) des runs :`);
if (ids.length === 0) {
  warn("AC2 : aucun run n'a produit de suggestion — impossible de conclure sur §3.3");
}
const placeholders = ids.map(() => "?").join(",") || "NULL";
const suggestions = ids.length
  ? db
      .prepare(
        `SELECT s.id, s.claim, s.relation_type, s.pair_key, s.content_sig, s.epistemic_status,
                s.fragment_a_id AS fa, s.fragment_b_id AS fb,
                da.source_id AS sa, db2.source_id AS sb,
                da.text AS ta, db2.text AS tb
         FROM suggestions s
         JOIN fragments da ON da.id = s.fragment_a_id
         JOIN fragments db2 ON db2.id = s.fragment_b_id
         WHERE s.id IN (${placeholders})`
      )
      .all(...ids)
  : [];
if (suggestions.length !== ids.length) {
  warn(
    `AC2 : ${ids.length - suggestions.length} suggestion(s) sans fragments existants ` +
      `(join fragments vide) — fragment inexistant interdit`
  );
}

let intraSource = 0;
let badPairKey = 0;
const badEpistemic = [];
for (const s of suggestions) {
  if (s.sa === s.sb) intraSource += 1;
  // pair_key canonique (§3.3) : ids triés, ou (cause) paire ordonnée des deux ids
  const sorted = s.fa < s.fb ? `${s.fa}:${s.fb}` : `${s.fb}:${s.fa}`;
  const ordered = `${s.fa}:${s.fb}`;
  const reverse = `${s.fb}:${s.fa}`;
  const ok =
    s.relation_type === "cause" ? s.pair_key === ordered || s.pair_key === reverse : s.pair_key === sorted;
  if (!ok) badPairKey += 1;
  // FACT seulement si le claim est présent textuellement dans une preuve (§3.2)
  if (s.epistemic_status === "FACT") {
    const c = canonical(s.claim ?? "");
    if (!canonical(s.ta ?? "").includes(c) && !canonical(s.tb ?? "").includes(c)) {
      badEpistemic.push(s.id);
    }
  }
}
if (intraSource > 0) warn(`AC2 : ${intraSource} paire(s) intra-source (fragment_a.source_id == fragment_b.source_id)`);
if (badPairKey > 0) warn(`AC2 : ${badPairKey} pair_key non canonique(s)`);
if (badEpistemic.length > 0) warn(`AC2 : ${badEpistemic.length} suggestion(s) FACT sans claim textuel dans une preuve`);

const dupes = ids.length
  ? db
      .prepare(
        `SELECT pair_key, relation_type, content_sig, COUNT(*) AS n
         FROM suggestions WHERE id IN (${placeholders})
         GROUP BY pair_key, relation_type, content_sig HAVING n > 1`
      )
      .all(...ids)
  : [];
if (dupes.length > 0) warn(`AC2 : ${dupes.length} doublon(s) (pair_key, relation_type, content_sig)`);

// Les preuves sont des fragments (FK) : le résumé de source n'est joignable par aucune colonne.
const byStatus = {};
for (const s of suggestions) byStatus[s.epistemic_status] = (byStatus[s.epistemic_status] ?? 0) + 1;
console.log(
  `    0 intra-source ${intraSource === 0 ? "✓" : "✗"} · 0 doublon ${dupes.length === 0 ? "✓" : "✗"} · ` +
    `pair_key canonique ${badPairKey === 0 ? "✓" : "✗"} · ${suggestions.length} fragment(s) existant(s) ` +
    `(join) · statuts ${JSON.stringify(byStatus)}`
);
console.log("    0 résumé cité en preuve ✓ (suggestions.fragment_a_id/b → fragments uniquement)");

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `\nPhase 2B : PASS — identité de run persistée et recalculable ; suggestions conformes §3.3.`
);
console.log(
  "Rejeu : relancer `npm run discover -- --run-id=<id>` sur le même corpus et comparer created_ids."
);
process.exit(0);
