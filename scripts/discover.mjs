#!/usr/bin/env node
/**
 * CLI Phase 2A — PoC découverte (SANS UI) :
 *   node scripts/discover.mjs [--manifest=data/corpus_manifest.json]
 *     [--run-id=...] [--sampler=diversified|top6] [--max-pairs=200]
 *     [--max-pairs-per-source=20] [--batch-size=10] [--wait=600] [--db=./data/correlo.db]
 *     [--focus=id1,id2]   # sources examinées en premier (dépôt d'un fichier)
 *     [--seed=hex]        # rejoue la sélection d'un run archivé (comparaison)
 *     [--resume]          # relance un run interrompu depuis son checkpoint
 *
 * `--seed` sert à **isoler une variable** : rejouer à l'identique la sélection d'un
 * run archivé (même ordre, mêmes tirages PRNG, même k-means) sous un `--run-id` neuf,
 * pour que la seule différence mesurée soit celle qu'on veut expliquer. Contrepartie :
 * l'identité du run n'est alors plus dérivable de son `run_id` — la seed rejouée est
 * persistée telle quelle dans `discover_runs.seed`, le run reste donc traçable.
 *
 * Le job est exécuté par le worker du serveur (npm run dev) ; le CLI suit
 * la progression (progress_json) et produit le rapport. Les suggestions créées
 * le sont avec les contraintes §3.3 (dédup, variantes bloquées, cross-source) —
 * un run est rejouable à l'identique (seed déterministe).
 *
 * Depuis la Phase 2B, l'identité du run (`run_id`, `corpus_hash`, `seed`,
 * `sampler_version`) est **persistée en base** par le worker dans `discover_runs`
 * (migration 005) et lue ici depuis la base : plus de fichier `discover_runs.json`
 * à côté de la DB. Relancer le CLI avec le même `--run-id` rejoue le même run.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
// Import direct du .ts (Node 24 retire les types ; l'import de `prompts.ts` n'a
// que des imports `type`, sans alias) : la version de prompt qui invalide
// l'idempotency key n'est plus recopiée à la main dans le CLI.
import { DISCOVERY_PROMPT_VERSION } from "../lib/discover/prompts.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);

const dbPath = args.db ?? "./data/correlo.db";
const manifestPath = args.manifest ?? "./data/corpus_manifest.json";
const sampler = args.sampler === "top6" ? "top6" : "diversified";
const runId = args["run-id"] ?? `run-${sampler}-${Date.now().toString(36)}`;
const maxPairs = Number(args["max-pairs"] ?? 200);
const maxPairsPerSource = Number(args["max-pairs-per-source"] ?? 20);
const batchSize = Number(args["batch-size"] ?? 4);
const maxFragmentChars = Number(args["max-fragment-chars"] ?? 2400);
const interBatchDelayMs = Number(args["inter-batch-delay-ms"] ?? 65000);
// `--focus` : rejouer à la main ce que le dépôt d'un fichier déclenche tout seul —
// l'échantillonneur examine d'abord ces sources (sampler-v2)
const focusSourceIds = String(args.focus ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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
const seed = args.seed
  ? String(args.seed)
  : createHash("sha256").update(`${corpusHash}|${runId}`, "utf8").digest("hex");

// modèle de chat courant (idempotency) — lu depuis .env.local sans dépendance
const env = {};
for (const line of fs.readFileSync("./.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const chatModel =
  env.LLM_CHAT_PROVIDER === "ollama" ? env.OLLAMA_CHAT_MODEL : env.GROQ_CHAT_MODEL ?? "";
// C'est lui qui invalide l'idempotency key quand le prompt change.
const promptVersion = DISCOVERY_PROMPT_VERSION;
const idempotencyKey = createHash("sha256")
  .update(
    [
      "discover",
      runId,
      sampler,
      corpusHash,
      String(maxPairs),
      focusSourceIds.join(","),
      promptVersion,
      chatModel,
    ].join("|"),
    "utf8"
  )
  .digest("hex");

const now = new Date().toISOString();
// `--resume` : relancer **le même** run sans repartir de zéro. Le provider peut
// épuiser les tentatives du job en pleine course (503, sortie LLM non parsable) ;
// sans ce mode, seul l'upsert ci-dessous existe — il remet le checkpoint à `NULL`
// et jette les batchs déjà traités. Ici on remet juste le job en file en gardant
// `checkpoint` et `progress_json` : le worker reprend au batch interrompu.
if (args.resume) {
  const existing = db
    .prepare("SELECT id, status, attempts, checkpoint FROM jobs WHERE idempotency_key = ?")
    .get(idempotencyKey);
  if (!existing) {
    console.error(`--resume : aucun job pour ce run (${runId}) — lancez-le d'abord.`);
    process.exit(1);
  }
  if (existing.status === "done") {
    console.error(`--resume : le run ${runId} est déjà terminé (rien à reprendre).`);
    process.exit(1);
  }
  const cp = existing.checkpoint ? JSON.parse(existing.checkpoint) : null;
  db.prepare(
    `UPDATE jobs SET status = 'pending', attempts = 0, error = NULL,
       lease_token = NULL, lease_until = NULL, updated_at = ?, next_run_at = ?
     WHERE id = ?`
  ).run(now, now, existing.id);
  console.log(
    `Reprise du job ${existing.id} (${runId}) : tentative ${existing.attempts} abandonnée, ` +
      `reprise au batch ${cp?.done_batches ?? 0} — la sélection est inchangée.`
  );
} else
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
    ...(focusSourceIds.length > 0 ? { focus_source_ids: focusSourceIds } : {}),
    max_pairs: maxPairs,
    max_pairs_per_source: maxPairsPerSource,
    batch_size: batchSize,
    max_fragment_chars: maxFragmentChars,
    inter_batch_delay_ms: interBatchDelayMs,
    ...(args.seed ? { seed: String(args.seed) } : {}),
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

// rapport — l'identité du run est lue depuis la base (Phase 2B, AC1), pas depuis
// le progress_json du job ni depuis un fichier annexe : c'est la même ligne que
// celle sur laquelle porte la validation de la phase.
const run = db.prepare("SELECT * FROM discover_runs WHERE run_id = ?").get(runId);
if (!run) {
  console.error(
    `Run ${runId} terminé, mais absent de discover_runs — le worker du serveur ` +
      `persiste-t-il l'identité du run (migration 005 + serveur à jour) ?`
  );
  process.exit(1);
}
const summary = {
  pairs: run.pairs,
  batch_calls: run.batch_calls,
  batch_calls_from_cache: run.batch_calls_from_cache,
  created: run.created,
  skipped: JSON.parse(run.skipped),
};
const ids = JSON.parse(run.created_ids);
const rows = ids.length
  ? db
      .prepare(`SELECT * FROM suggestions WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids)
  : [];

console.log(`\n=== Rapport du run ${runId} ===`);
console.log(`Statut : ${run.status} · sampler ${run.sampler} (${run.sampler_version}) · prompt ${run.prompt_version} · modèle ${run.chat_model}`);
console.log(`Corpus : ${JSON.parse(run.source_ids).length} docs · corpus_hash ${run.corpus_hash.slice(0, 12)}… · seed ${run.seed.slice(0, 12)}…`);
console.log(`Paires échantillonnées : ${summary.pairs} · appels batch : ${summary.batch_calls}${summary.batch_calls_from_cache ? ` (+${summary.batch_calls_from_cache} depuis cache)` : ""}`);
console.log(
  `Suggestions : ${summary.created} (dont ${summary.skipped.duplicate ?? 0} déjà en base — ` +
    `même paire, même relation, même claim : rattachées à ce run)`
);
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
console.log(`\nRapport détaillé pour évaluateurs : npm run eval:phase2a`);
console.log(`Contraintes §3.3 et identité du run : npm run validate:phase2b`);