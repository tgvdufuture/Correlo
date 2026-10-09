#!/usr/bin/env node
/**
 * Ré-ingestion de sources (PRD §205) : « changement de chunker_version ⇒ suppression
 * + ré-ingestion de la source ; les Suggestions disparaissent en CASCADE, les
 * Constructions survivent via provenance_snapshot et passent stale = 1 ».
 *
 *   node scripts/reingest.mjs [--sources=gutenberg|all|<id,id...>] [--db=./data/correlo.db]
 *     [--wait=1800]
 *
 * `gutenberg` (défaut) cible les sources URL dont le texte stocké porte encore le
 * boilerplate Project Gutenberg — typiquement après un changement d'extraction.
 *
 * Le travail est exécuté par le worker du serveur (npm run dev) : le script
 * supprime les fragments, remet la source à `pending`, enfile un job `ingest`
 * puis suit la progression jusqu'au bout.
 */
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);

const dbPath = args.db ?? "./data/correlo.db";
const selector = String(args.sources ?? "gutenberg");
const waitSeconds = Number(args.wait ?? 1800);
// Doit suivre CHUNKER_VERSION (lib/ingest/chunker.ts) : c'est lui qui invalide la
// clé d'idempotence du job d'ingestion.
const CHUNKER_VERSION = "chunker-v1";

/** SHA256(parts) — même formule que lib/repositories/jobs.ts. */
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const idempotencyKey = (parts) => sha256Hex(parts.join("|"));

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

const GUTENBERG_MARKER = /PROJECT GUTENBERG EBOOK|PROJECT GUTENBERG LICENSE|gutenberg\.org/i;

const all = db
  .prepare("SELECT id, type, title, canonical_path, raw_content FROM sources ORDER BY created_at")
  .all();

let targets;
if (selector === "all") {
  targets = all;
} else if (selector === "gutenberg") {
  targets = all.filter((s) => GUTENBERG_MARKER.test(s.raw_content ?? ""));
} else {
  const ids = selector.split(",").map((s) => s.trim()).filter(Boolean);
  targets = all.filter((s) => ids.includes(s.id));
  const unknown = ids.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`Sources introuvables : ${unknown.join(", ")}`);
    process.exit(1);
  }
}

if (targets.length === 0) {
  console.log("Aucune source à ré-ingérer.");
  db.close();
  process.exit(0);
}

const now = new Date().toISOString();
const jobs = [];
const tx = db.transaction(() => {
  for (const s of targets) {
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM fragments WHERE source_id = ?")
      .get(s.id).n;
    // 1) les fragments partent en premier (CASCADE : suggestions liées supprimées)
    db.prepare("DELETE FROM fragments WHERE source_id = ?").run(s.id);
    // 2) hash placeholder : le vrai hash est recalculé par le job d'ingest
    //    (un hash unique évite la détection de doublon contre soi-même)
    const placeholderHash = `pending:${s.id}`;
    db.prepare(
      "UPDATE sources SET content_hash = ?, summary_status = 'pending' WHERE id = ?"
    ).run(placeholderHash, s.id);

    // 3) job ingest — upsert sur la clé d'idempotence (rejouable à l'identique)
    const key = idempotencyKey(["ingest", s.id, placeholderHash, CHUNKER_VERSION]);
    db.prepare(
      `INSERT INTO jobs (id, kind, payload, status, attempts, idempotency_key, source_id,
         created_at, updated_at, next_run_at)
       VALUES (?, 'ingest', ?, 'pending', 0, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         payload = excluded.payload, status = 'pending', error = NULL,
         checkpoint = NULL, progress_json = NULL, lease_token = NULL, lease_until = NULL,
         updated_at = excluded.updated_at, next_run_at = excluded.next_run_at`
    ).run(
      randomUUID(),
      JSON.stringify({ source_id: s.id, ...(s.type === "URL" ? { url: s.canonical_path } : {}) }),
      key,
      s.id,
      now,
      now,
      now
    );
    const job = db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(key);
    jobs.push({ sourceId: s.id, jobId: job.id, before });
    console.log(
      `→ ${s.type} · ${(s.title ?? s.id).slice(0, 60)} : ${before} fragment(s) supprimés, job ${job.id.slice(0, 8)}`
    );
  }
});
tx();

// PRD §205 / US-08 AC2 / Phase 5B AC4 : les Constructions **et les synthèses**
// survivent via provenance_snapshot et passent stale = 1 — mais **seulement celles qui
// citent une source ré-ingérée** (marquer tout le canvas périmé ferait perdre
// l'information de péremption). Les deux requêtes sont écrites ici en SQL direct,
// comme le reste du script (il ne charge pas les modules TS de `lib/`) : elles doivent
// donc rester alignées sur `markSourceDependentsStale` (lib/repositories/stale.ts) et
// la vérification est faite par le validateur, pas par la lecture.
const markStale = db.prepare(
  `UPDATE constructions SET stale = 1
   WHERE stale = 0 AND EXISTS (
     SELECT 1 FROM json_each(constructions.provenance_snapshot) je
     WHERE json_extract(je.value, '$.source_id') = ?
   )`
);
const markStaleSyntheses = db.prepare(
  `UPDATE syntheses SET stale = 1
   WHERE stale = 0 AND EXISTS (
     SELECT 1 FROM json_each(syntheses.provenance_snapshot) e
     WHERE json_extract(e.value, '$.source_id') = ?
   )`
);
let staled = 0;
let staledSyntheses = 0;
for (const j of jobs) {
  staled += markStale.run(j.sourceId).changes;
  staledSyntheses += markStaleSyntheses.run(j.sourceId).changes;
}
if (staled > 0) {
  console.log(`⚠ ${staled} construction(s) citant une source ré-ingérée → stale = 1`);
}
if (staledSyntheses > 0) {
  console.log(`⚠ ${staledSyntheses} synthèse(s) citant une source ré-ingérée → stale = 1`);
}

console.log(`\n${jobs.length} source(s) en file — worker requis (npm run dev). Suivi…\n`);

const deadline = Date.now() + waitSeconds * 1000;
for (;;) {
  const states = jobs.map((j) =>
    db.prepare("SELECT status, error FROM jobs WHERE id = ?").get(j.jobId)
  );
  if (states.every((s) => s.status === "done")) break;
  const failed = states.filter((s) => s.status === "failed");
  if (failed.length) {
    console.error("Job(s) en échec :");
    for (const f of failed) console.error(`  ${f.error}`);
    db.close();
    process.exit(1);
  }
  const progress = jobs
    .map((j) => {
      const row = db
        .prepare("SELECT progress_json FROM jobs WHERE id = ?")
        .get(j.jobId);
      const p = row?.progress_json ? JSON.parse(row.progress_json) : null;
      return p ? `${p.processed ?? "?"}/${p.total ?? "?"}` : "…";
    })
    .join(" · ");
  process.stdout.write(`\r  ${states.filter((s) => s.status === "done").length}/${jobs.length} terminés — ${progress}   `);
  if (Date.now() > deadline) {
    console.error(`\nTimeout après ${waitSeconds}s — le worker tourne-t-il ? (npm run dev)`);
    db.close();
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log("\n\n=== Bilan de ré-ingestion ===");
let totalBefore = 0;
let totalAfter = 0;
for (const j of jobs) {
  const src = db
    .prepare("SELECT title, raw_content, content_hash FROM sources WHERE id = ?")
    .get(j.sourceId);
  const after = db
    .prepare("SELECT COUNT(*) AS n FROM fragments WHERE source_id = ?")
    .get(j.sourceId).n;
  const leaks = GUTENBERG_MARKER.test(src.raw_content ?? "") ? "⚠ fuite" : "✓ propre";
  totalBefore += j.before;
  totalAfter += after;
  console.log(
    `  ${(src.title ?? j.sourceId).slice(0, 55).padEnd(56)} ${String(j.before).padStart(5)} → ${String(after).padStart(5)} fragments · ${leaks}`
  );
}
const suggestions = db.prepare("SELECT COUNT(*) AS n FROM suggestions").get().n;
console.log(
  `\nFragments : ${totalBefore} → ${totalAfter} · suggestions restantes (CASCADE) : ${suggestions}`
);
console.log("Vérifier la Phase 1B : npm run validate:corpus");
db.close();
