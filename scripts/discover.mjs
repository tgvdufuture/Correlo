#!/usr/bin/env node
/**
 * CLI Phase 2A — PoC découverte (SANS UI) :
 *   node scripts/discover.mjs [--manifest=data/corpus_manifest.json]
 *     [--run-id=...] [--sampler=diversified|top6] [--max-pairs=200]
 *     [--max-pairs-per-source=20] [--batch-size=10] [--wait=600] [--db=./data/serendipity.db]
 *
 * Le job est exécuté par le worker du serveur (npm run dev) ; le CLI suit
 * la progression (progress_json) et produit le rapport + discover_runs.json.
 * Les suggestions créées le sont avec les contraintes §3.3 (dédup, variantes
 * bloquées, cross-source) — un run est rejouable à l'identique (seed déterministe).
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

const dbPath = args.db ?? "./data/serendipity.db";
const manifestPath = args.manifest ?? "./data/corpus_manifest.json";
const sampler = args.sampler === "top6" ? "top6" : "diversified";
const runId = args["run-id"] ?? `run-${sampler}-${Date.now().toString(36)}`;
const maxPairs = Number(args["max-pairs"] ?? 200);
const maxPairsPerSource = Number(args["max-pairs-per-source"] ?? 20);
const batchSize = Number(args["batch-size"] ?? 4);
const maxFragmentChars = Number(args["max-fragment-chars"] ?? 2400);
const interBatchDelayMs = Number(args["inter-batch-delay-ms"] ?? 65000);
const waitSeconds = Number(args.wait ?? 600);

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
    .prepare(`SELECT id, content_hash FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`)
    .all(...sourceIds)
    .map((r) => [r.id, r.content_hash])
);
const corpusHash = createHash("sha256")
  .update(sourceIds.map((id) => `${id}:${contentHashes[id]}`).join("|"), "utf8")
  .digest("hex");
const seed = createHash("sha256").update(`${corpusHash}|${runId}`, "utf8").digest("hex");

// modèle de chat courant (idempotency) — lu depuis .env.local sans dépendance
const env = {};
for (const line of fs.readFileSync("./.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const chatModel =
  env.LLM_CHAT_PROVIDER === "ollama" ? env.OLLAMA_CHAT_MODEL : env.GROQ_CHAT_MODEL ?? "";
// Doit suivre DISCOVERY_PROMPT_VERSION (lib/discover/prompts.ts) : c'est lui qui
// invalide l'idempotency key quand le prompt change.
const promptVersion = "discovery-v4";
const idempotencyKey = createHash("sha256")
  .update(["discover", runId, sampler, corpusHash, String(maxPairs), promptVersion, chatModel].join("|"), "utf8")
  .digest("hex");

const now = new Date().toISOString();
db.prepare(
  `INSERT INTO jobs (id, kind, payload, status, attempts, idempotency_key, created_at, updated_at, next_run_at)
   VALUES (?, 'discover', ?, 'pending', 0, ?, ?, ?, ?)
   ON CONFLICT(idempotency_key) DO UPDATE SET
     payload = excluded.payload, status = 'pending', error = NULL,
     checkpoint = NULL, progress_json = NULL, lease_token = NULL, lease_until = NULL,
     updated_at = excluded.updated_at, next_run_at = excluded.next_run_at`
).run(
  crypto.randomUUID(),
  JSON.stringify({
    run_id: runId,
    source_ids: sourceIds,
    sampler,
    max_pairs: maxPairs,
    max_pairs_per_source: maxPairsPerSource,
    batch_size: batchSize,
    max_fragment_chars: maxFragmentChars,
    inter_batch_delay_ms: interBatchDelayMs,
  }),
  idempotencyKey,
  now,
  now,
  now
);
const job = db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(idempotencyKey);

console.log(`Run ${runId} — ${sampler} · corpus ${sourceIds.length} docs · seed ${seed.slice(0, 12)}…`);
console.log(`Job ${job.id} en attente du worker (serveur dev requis).`);

// suivi de progression
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
      console.log(`  … ${p.processed ?? "?"}/${p.total ?? "?"} paires · ${p.created ?? 0} créées`);
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

// rapport
const summary = JSON.parse(db.prepare("SELECT progress_json FROM jobs WHERE id = ?").get(job.id).progress_json);
const ids = summary.created_ids ?? [];
const rows = ids.length
  ? db
      .prepare(`SELECT * FROM suggestions WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids)
  : [];

const runsFile = "./data/discover_runs.json";
const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, "utf8")) : { runs: [] };
runs.runs.push({
  run_id: runId,
  sampler,
  corpus_hash: corpusHash,
  seed,
  created_at: now,
  completed_at: new Date().toISOString(),
  pairs: summary.pairs,
  batch_calls: summary.batch_calls,
  batch_calls_from_cache: summary.batch_calls_from_cache,
  created: summary.created,
  created_ids: ids,
  skipped: summary.skipped,
  manifest: manifestPath,
});
fs.writeFileSync(runsFile, JSON.stringify(runs, null, 2));

console.log(`\n=== Rapport du run ${runId} ===`);
console.log(`Paires échantillonnées : ${summary.pairs} · appels batch : ${summary.batch_calls}${summary.batch_calls_from_cache ? ` (+${summary.batch_calls_from_cache} depuis cache)` : ""}`);
console.log(`Suggestions créées : ${summary.created}`);
console.log(`Skips : ${JSON.stringify(summary.skipped)}`);
const byType = {};
const byTier = {};
for (const s of rows) {
  byType[s.relation_type] = (byType[s.relation_type] ?? 0) + 1;
  byTier[s.tier] = (byTier[s.tier] ?? 0) + 1;
}
console.log("Par type :", JSON.stringify(byType), "· par tier :", JSON.stringify(byTier));
for (const s of rows) {
  console.log(`\n  [${s.id.slice(0, 8)}] ${s.relation_type} · ${s.tier} · ${s.epistemic_status}`);
  console.log(`    ${s.claim}`);
}
console.log(`\nRapport détaillé pour évaluateurs : node scripts/evaluate-phase-2a.mjs`);