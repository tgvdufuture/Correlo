#!/usr/bin/env node
/**
 * Re-vectorisation du corpus dans l'espace **actif** — la bascule de connecteur
 * d'embeddings (Ollama ↔ API) sans laisser deux espaces incomparables en base.
 *
 *   node scripts/reembed.mjs [--db=./data/correlo.db] [--env=.env.local]
 *     [--sources=<id,id...>] [--batch-size=32] [--force] [--dry-run] [--wait=3600]
 *
 * Le travail est exécuté par le worker du serveur (`npm run dev`) : le script enfile
 * un job `reembed` puis suit sa progression. Le corpus reste exploitable pendant
 * l'opération (une transaction par lot) et un job interrompu reprend au lot suivant
 * tout seul — les fragments déjà dans l'espace actif sont sautés.
 *
 * Bascule dans l'autre sens : changer `EMBED_PROVIDER` dans `.env.local`, redémarrer
 * le serveur, relancer ce script. C'est la même commande dans les deux sens.
 *
 * ⚠ Conséquence sur les runs : les embeddings changent, donc les similarités et
 * l'échantillon aussi. L'identité persistée d'un run discover (`corpus_hash`,
 * `seed`) ne porte pas l'espace vectoriel — un run archivé n'est **plus**
 * reproductible à l'identique après une re-vectorisation, même si son identité se
 * recalcule. Le résumé du job enregistre les espaces avant/après pour que ce soit
 * lisible.
 */
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);

// `.env.local` porte le réglage de l'espace actif : le CLI doit lire le même fichier
// que le serveur, sinon il enfilera un job pour un espace que le worker n'utilise pas.
const envPath = String(args.env ?? ".env.local");
try {
  process.loadEnvFile(envPath);
} catch {
  // fichier absent : les variables peuvent venir de l'environnement (CI, shell)
}
if (args.db) process.env.DATABASE_PATH = String(args.db);

// Imports directs du .ts : Node retire les types. Ces trois modules sont sans alias
// au runtime, exactement pour permettre ce partage (voir lib/llm/active-space.ts).
const { getEmbeddingSpace } = await import("../lib/llm/active-space.ts");
const { listCorpusSpaces, sameSpace, spaceLabel } = await import("../lib/llm/embedding-space.ts");

const dbPath = String(args.db ?? process.env.DATABASE_PATH ?? "./data/correlo.db");
const batchSize = Number(args["batch-size"] ?? process.env.NVIDIA_EMBED_BATCH_SIZE ?? 32);
const waitSeconds = Number(args.wait ?? 3600);
const force = args.force === true;
const dryRun = args["dry-run"] === true;
const sourceIds = args.sources
  ? String(args.sources)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const space = getEmbeddingSpace();
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

console.log(`Espace actif : ${spaceLabel(space)}`);
console.log(`Connecteur  : ${process.env.EMBED_PROVIDER ?? "ollama"} → ${space.model}`);
console.log(`Base        : ${dbPath}\n`);

const from = listCorpusSpaces(db, sourceIds);
if (from.length === 0) {
  console.log("Aucun fragment à re-vectoriser.");
  db.close();
  process.exit(0);
}
console.log("Espaces présents en base :");
for (const s of from) {
  const state = sameSpace(s, space) ? "✓ actif" : "→ à re-vectoriser";
  console.log(
    `  ${state.padEnd(20)} ${spaceLabel(s).padEnd(48)} ${String(s.fragments).padStart(5)} fragments · ${s.sources} source(s)`
  );
}

const conditions = [];
const params = [];
if (sourceIds) {
  conditions.push(`source_id IN (${sourceIds.map(() => "?").join(",")})`);
  params.push(...sourceIds);
}
if (!force) {
  conditions.push(
    "NOT (embedding_model = ? AND embedding_dimensions = ? AND embedding_version = ?)"
  );
  params.push(space.model, space.dimensions, space.version);
}
const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
const candidates = db
  .prepare(`SELECT COUNT(*) AS n FROM fragments ${where}`)
  .get(...params).n;
const skipCount = from
  .filter((s) => sameSpace(s, space))
  .reduce((n, s) => n + s.fragments, 0);

console.log(
  `\nÀ re-vectoriser : ${candidates} fragment(s)` +
    (force ? " (--force : tout est refait)" : ` · ${skipCount} déjà dans l'espace actif (sautés)`) +
    ` · ${Math.ceil(candidates / batchSize)} appel(s) de ${batchSize} textes`
);

if (candidates === 0) {
  console.log("\nRien à faire : le corpus est déjà dans l'espace actif.");
  db.close();
  process.exit(0);
}
if (dryRun) {
  console.log("\n--dry-run : aucun job enfilé.");
  db.close();
  process.exit(0);
}

// Clé d'idempotence : l'espace cible **et** la portée. Rejouer la même commande
// reprend le même job (attempts conservés) ; changer de connecteur crée un job neuf.
const idempotencyKey = sha256Hex(
  ["reembed", space.model, String(space.dimensions), space.version, sourceIds ? sourceIds.join(",") : "all", force ? "force" : "skip"].join("|")
);
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO jobs (id, kind, payload, status, attempts, idempotency_key, source_id,
     created_at, updated_at, next_run_at)
   VALUES (?, 'reembed', ?, 'pending', 0, ?, NULL, ?, ?, ?)
   ON CONFLICT(idempotency_key) DO UPDATE SET
     payload = excluded.payload, status = 'pending', error = NULL,
     checkpoint = NULL, progress_json = NULL, lease_token = NULL, lease_until = NULL,
     updated_at = excluded.updated_at, next_run_at = excluded.next_run_at`
).run(
  randomUUID(),
  JSON.stringify({
    force,
    ...(sourceIds ? { source_ids: sourceIds } : {}),
    batch_size: batchSize,
  }),
  idempotencyKey,
  now,
  now,
  now
);
const jobId = db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(idempotencyKey).id;
console.log(`\nJob ${jobId.slice(0, 8)} en file — worker requis (npm run dev). Suivi…`);

const deadline = Date.now() + waitSeconds * 1000;
let lastLine = "";
for (;;) {
  const job = db.prepare("SELECT status, error, progress_json FROM jobs WHERE id = ?").get(jobId);
  if (job.status === "done") break;
  if (job.status === "failed") {
    console.error(`\nJob en échec : ${job.error}`);
    db.close();
    process.exit(1);
  }
  const p = job.progress_json ? JSON.parse(job.progress_json) : null;
  const line = p
    ? `${p.processed ?? 0}/${p.total ?? candidates} fragments · ${p.batches ?? 0} lot(s)`
    : "en attente du worker…";
  if (line !== lastLine) {
    process.stdout.write(`\r  ${line}                    `);
    lastLine = line;
  }
  if (Date.now() > deadline) {
    console.error(`\nTimeout après ${waitSeconds}s — le worker tourne-t-il ? (npm run dev)`);
    db.close();
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 1500));
}

const final = db
  .prepare("SELECT progress_json FROM jobs WHERE id = ?")
  .get(jobId).progress_json;
const summary = final ? JSON.parse(final) : null;
const to = listCorpusSpaces(db, sourceIds);

console.log("\n\n=== Bilan de re-vectorisation ===");
if (summary) {
  console.log(
    `  ${summary.processed} fragment(s) re-vectorisés en ${summary.batches} lot(s)` +
      (summary.skipped ? ` · ${summary.skipped} déjà à jour` : "")
  );
}
console.log("  Espace après :");
for (const s of to) {
  console.log(`    ${spaceLabel(s).padEnd(48)} ${String(s.fragments).padStart(5)} fragments`);
}
const others = to.filter((s) => !sameSpace(s, space));
if (others.length > 0) {
  console.log(
    `\n⚠ ${others.length} autre(s) espace(s) subsistent : relance ce script pour terminer ` +
      "(un fragment sauté un jour de coupure réseau est repris au passage suivant)."
  );
}
console.log(
  `\nRappel : les embeddings ont changé, donc l'échantillonnage aussi. Un run discover ` +
    `archivé n'est plus reproductible à l'identique — relance-le pour de nouveaux liens.`
);
db.close();
