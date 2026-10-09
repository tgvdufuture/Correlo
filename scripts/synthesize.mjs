#!/usr/bin/env node
/**
 * CLI Phase 5A — moteur de synthèses (SANS UI) :
 *   node scripts/synthesize.mjs [--manifest=data/corpus_manifest.json]
 *     [--run-id=...] [--max-seeds=12]
 *     [--baseline]                 contrôle « résumé » (n'écrit rien en base)
 *     [--wait=900] [--db=./data/correlo.db]
 *
 * Le job est exécuté par le worker du serveur (npm run dev) ; le CLI suit la
 * progression (progress_json) et produit le rapport + data/synthesis_runs.json.
 * Graines (paires cross-document), preuves et prompts sont déterministes : un run est
 * rejouable à l'identique, et un rejeu n'insère aucune nouvelle synthèse (dédup
 * content_sig + quasi-doublons).
 *
 * Le mode `--baseline` écrit data/baseline_5a.json : mêmes graines, mêmes preuves,
 * même budget, consigne de résumé — c'est le contrôle du protocole Q25.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);

const dbPath = args.db ?? "./data/correlo.db";
const manifestPath = args.manifest ?? "./data/corpus_manifest.json";
const mode = args.baseline ? "baseline" : "synthesis";
const runId = args["run-id"] ?? `synth-${mode}-${Date.now().toString(36)}`;
const maxSeeds = args["max-seeds"] !== undefined ? Number(args["max-seeds"]) : undefined;
const maxSeedsPerSource =
  args["max-seeds-per-source"] !== undefined ? Number(args["max-seeds-per-source"]) : undefined;
const minEvidence = args["min-evidence"] !== undefined ? Number(args["min-evidence"]) : undefined;
const maxEvidence = args["max-evidence"] !== undefined ? Number(args["max-evidence"]) : undefined;
const maxPerSeed =
  args["max-syntheses-per-seed"] !== undefined
    ? Number(args["max-syntheses-per-seed"])
    : undefined;
const maxEvidenceChars =
  args["max-evidence-chars"] !== undefined ? Number(args["max-evidence-chars"]) : undefined;
const interSeedDelayMs =
  args["inter-seed-delay-ms"] !== undefined ? Number(args["inter-seed-delay-ms"]) : undefined;
const waitSeconds = Number(args.wait ?? 900);

if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest introuvable : ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const sourceIds = Object.keys(manifest).sort();

const db = new Database(dbPath);
const missing = sourceIds.filter(
  (id) => !db.prepare("SELECT 1 FROM sources WHERE id = ?").get(id)
);
if (missing.length > 0) {
  console.error(`Sources du manifeste absentes de la base : ${missing.length}`);
  process.exit(1);
}
const contentHashes = Object.fromEntries(
  db
    .prepare(
      `SELECT id, content_hash FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`
    )
    .all(...sourceIds)
    .map((r) => [r.id, r.content_hash])
);
// mêmes formules que le service (lib/synth/synth-service.ts)
const corpusHash = createHash("sha256")
  .update(
    sourceIds
      .map((id) => `${id}:${contentHashes[id]}`)
      .sort()
      .join("|"),
    "utf8"
  )
  .digest("hex");
const seed = createHash("sha256").update(`${corpusHash}|${runId}`, "utf8").digest("hex");

// modèle de chat courant (idempotency) — lu depuis .env.local sans dépendance
const env = {};
for (const line of fs.readFileSync("./.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const chatModel =
  env.LLM_CHAT_PROVIDER === "ollama" ? env.OLLAMA_CHAT_MODEL : (env.GROQ_CHAT_MODEL ?? "");
// Doit suivre lib/synth/prompts.ts : c'est lui qui invalide l'idempotency key
// quand la consigne change.
const promptVersion = mode === "baseline" ? "synthesis-baseline-v2" : "synthesis-v2";
const idempotencyKey = createHash("sha256")
  .update(
    [
      "synthesize",
      runId,
      mode,
      corpusHash,
      String(maxSeeds ?? 0),
      promptVersion,
      chatModel,
    ].join("|"),
    "utf8"
  )
  .digest("hex");

const now = new Date().toISOString();
db.prepare(
  `INSERT INTO jobs (id, kind, payload, status, attempts, idempotency_key, created_at, updated_at, next_run_at)
   VALUES (?, 'synthesize', ?, 'pending', 0, ?, ?, ?, ?)
   ON CONFLICT(idempotency_key) DO UPDATE SET
     payload = excluded.payload, status = 'pending', error = NULL,
     -- checkpoint et compteurs CONSERVÉS : relancer le même run-id après un échec
     -- doit REPRENDRE à la graine suivante (avec ses compteurs cumulés), pas repartir
     -- de zéro. Un run neuf se demande avec un autre --run-id — c'est aussi ce qui
     -- évite d'orpheliner les synthèses déjà persistées pour ce run.
     lease_token = NULL, lease_until = NULL,
     updated_at = excluded.updated_at, next_run_at = excluded.next_run_at`
).run(
  crypto.randomUUID(),
  JSON.stringify({
    run_id: runId,
    source_ids: sourceIds,
    mode,
    max_seeds: maxSeeds,
    max_seeds_per_source: maxSeedsPerSource,
    min_evidence: minEvidence,
    max_evidence: maxEvidence,
    max_syntheses_per_seed: maxPerSeed,
    max_evidence_chars: maxEvidenceChars,
    inter_seed_delay_ms: interSeedDelayMs,
  }),
  idempotencyKey,
  now,
  now,
  now
);
const job = db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(idempotencyKey);

console.log(
  `Run ${runId} — mode ${mode} · ${sourceIds.length} docs · seed ${seed.slice(0, 12)}…`
);
if (mode === "baseline") {
  console.log("Mode baseline : aucune graine ni énoncé ne sera écrit en base.");
}
console.log(`Job ${job.id} en attente du worker (serveur dev requis).`);

const deadline = Date.now() + waitSeconds * 1000;
let lastProgress = "";
for (;;) {
  const row = db
    .prepare("SELECT status, progress_json, error FROM jobs WHERE id = ?")
    .get(job.id);
  if (row.status === "done") break;
  if (row.status === "failed") {
    console.error(`\nJob failed : ${row.error}`);
    process.exit(1);
  }
  if (row.progress_json) {
    const p = JSON.parse(row.progress_json);
    if (JSON.stringify(p) !== lastProgress) {
      lastProgress = JSON.stringify(p);
      console.log(
        `  … ${p.processed ?? "?"}/${p.total ?? "?"} graines · ${p.created ?? 0} énoncés · ` +
          `${p.llm_calls ?? 0} appel(s)`
      );
    }
  }
  if (Date.now() > deadline) {
    console.error(
      `\nTimeout après ${waitSeconds}s — le worker tourne-t-il ? (npm run dev) ` +
        `Job toujours ${row.status}.`
    );
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

const summary = JSON.parse(
  db.prepare("SELECT progress_json FROM jobs WHERE id = ?").get(job.id).progress_json
);

if (mode === "baseline") {
  // Les preuves d'un baseline sont sérialisées avec les **mêmes clés** que
  // `syntheses.provenance_snapshot` : l'évaluateur vérifie le baseline exactement comme
  // les synthèses (fragment existant, texte conforme, locator qui re-slice). Sans cela
  // les 12 résumés sortaient en `preuve_invalide` (défaut du run réel du 2026-09-14 :
  // l'API du service expose du camelCase, la base du snake_case).
  const toSnapshot = (evidence) =>
    (evidence ?? []).map((e) => ({
      fragment_id: e.fragment_id ?? e.fragmentId,
      source_id: e.source_id ?? e.sourceId,
      source_title: e.source_title ?? e.sourceTitle ?? null,
      locator: e.locator,
      text: e.text,
    }));
  const items = (summary.baseline_items ?? []).map((it) => ({
    ...it,
    evidence: toSnapshot(it.evidence),
  }));
  const file = "./data/baseline_5a.json";
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { runs: [] };
  all.runs = all.runs.filter((r) => r.run_id !== runId);
  all.runs.push({
    run_id: runId,
    mode: "baseline",
    prompt_version: promptVersion,
    corpus_hash: corpusHash,
    seed,
    created_at: now,
    completed_at: new Date().toISOString(),
    seeds_total: summary.seeds_total,
    llm_calls: summary.llm_calls,
    skipped: summary.skipped,
    items,
  });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  console.log(`\n=== Baseline « résumé » — run ${runId} ===`);
  console.log(
    `${items.length} résumés sur ${summary.seeds_total} graines · ${summary.llm_calls} appel(s) LLM`
  );
  for (const item of items) {
    console.log(`\n[${item.seedLabel}]`);
    console.log(`  ${item.text}`);
  }
  console.log(`\nRésultats écrits hors base : ${file}`);
  console.log(
    `\nPas de persistance : un baseline ne doit pas polluer le corpus de production.`
  );
} else {
  // Les énoncés du run sont ceux **ancrés sur ses graines** (theme_id ∈ seed_ids), pas
  // ceux de la passe en cours. Défaut trouvé au premier rejeu réel (2026-09-14) : un
  // rejeu (AC2) repart à 0 énoncé créé et son `progress_json` **écrase** le compteur de
  // la première passe — la liste des énoncés du run devenait alors vide côté rapport et
  // l'évaluation portait sur 0 synthèse. On interroge donc la base (la vérité), en
  // union avec le compteur de la passe courante (utile si la graine n'est pas persistée).
  const seedIds = summary.seed_ids ?? [];
  const persistedIds = seedIds.length
    ? db
        .prepare(
          `SELECT id FROM syntheses WHERE theme_id IN (${seedIds.map(() => "?").join(",")})`
        )
        .all(...seedIds)
        .map((r) => r.id)
    : [];
  const ids = [...new Set([...(summary.created_ids ?? []), ...persistedIds])];
  const rows = ids.length
    ? db
        .prepare(
          `SELECT sy.*, t.label AS theme_label
           FROM syntheses sy JOIN themes t ON t.id = sy.theme_id
           WHERE sy.id IN (${ids.map(() => "?").join(",")})`
        )
        .all(...ids)
    : [];
  const runsFile = "./data/synthesis_runs.json";
  const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, "utf8")) : { runs: [] };
  // Un même run_id peut être rejoué (AC2) : chaque passe est conservée (`passes`) et le
  // coût cumulé du run additionné, au lieu d'écraser la trace de la première. Sans cela,
  // l'AC2 (« un rejeu n'insère 0 nouvelle synthèse ») ne laissait aucune preuve chiffrée
  // — le rejeu écrasait le rapport du passage payant.
  const previous = runs.runs.find((r) => r.run_id === runId);
  const pass = {
    completed_at: new Date().toISOString(),
    llm_calls: summary.llm_calls ?? 0,
    llm_calls_from_cache: summary.llm_calls_from_cache ?? 0,
    created: summary.created ?? 0,
    created_ids: summary.created_ids ?? [],
    skipped: summary.skipped,
  };
  runs.runs = runs.runs.filter((r) => r.run_id !== runId);
  runs.runs.push({
    run_id: runId,
    mode,
    prompt_version: promptVersion,
    corpus_hash: corpusHash,
    seed,
    created_at: previous?.created_at ?? now,
    completed_at: new Date().toISOString(),
    seeds_total: summary.seeds_total,
    seed_ids: summary.seed_ids ?? [],
    llm_calls: (previous?.llm_calls ?? 0) + (summary.llm_calls ?? 0),
    llm_calls_from_cache:
      (previous?.llm_calls_from_cache ?? 0) + (summary.llm_calls_from_cache ?? 0),
    created: ids.length,
    created_ids: ids,
    skipped: summary.skipped,
    rejected_by_reason: summary.rejected_by_reason,
    manifest: manifestPath,
    passes: [...(previous?.passes ?? []), pass],
  });
  fs.writeFileSync(runsFile, JSON.stringify(runs, null, 2));

  console.log(`\n=== Rapport du run ${runId} ===`);
  console.log(
    `Graines : ${summary.seeds_total} (${summary.seed_ids?.length ?? 0} persistées) · ` +
      `appels LLM : ${summary.llm_calls}` +
      `${summary.llm_calls_from_cache ? ` (+${summary.llm_calls_from_cache} depuis cache)` : ""}`
  );
  console.log(`Synthèses créées : ${summary.created} (${ids.length} au total pour ce run)`);
  console.log(`Skips : ${JSON.stringify(summary.skipped)}`);
  const rejected = summary.rejected_by_reason ?? {};
  if (Object.keys(rejected).length > 0) {
    console.log(`Rejets par la barrière : ${JSON.stringify(rejected)}`);
  }
  const byKind = {};
  for (const s of rows) byKind[s.relation_kind] = (byKind[s.relation_kind] ?? 0) + 1;
  console.log("Par relation :", JSON.stringify(byKind));    for (const s of rows) {
      const evidence = JSON.parse(s.evidence_fragment_ids);
    const snapshot = JSON.parse(s.provenance_snapshot);      console.log(`\n  [${s.id.slice(0, 8)}] ${s.relation_kind} · ${s.confidence} · ${s.epistemic_status}`);
      console.log(`    Rapprochement : ${s.theme_label}`);
    console.log(`    ${s.text}`);
    for (const entry of snapshot) {
      console.log(
        `      · ${entry.source_title ?? entry.source_id} (${entry.locator}) ` +
          `${String(entry.text).slice(0, 70).replace(/\s+/g, " ")}…`
      );
    }
    if (evidence.length < 2) console.log(`      ⚠ ${evidence.length} preuve(s) !`);
  }
  console.log(`\nRapport détaillé pour évaluateurs : node scripts/evaluate-phase-5a.mjs`);
}
