#!/usr/bin/env node
/**
 * Validation Phase 1B (PRD §4) — à lancer après ingestion du corpus :
 *   node scripts/validate-phase-1b.mjs [chemin-db] [chemin-manifest]
 *
 * AC1 : 12–15 documents réels (≥ 3 domaines) ingérés sans job failed.
 * AC2 : 100 % des locators re-slicent le bon texte · 0 BLOB non conforme ·
 *       corpus ≤ 5 000 fragments.
 * Manifest : data/corpus_manifest.json — { "source_id": "domaine", ... }
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const dbPath = process.argv[2] ?? "./data/serendipity.db";
const manifestPath = process.argv[3] ?? "./data/corpus_manifest.json";

if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest introuvable : ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const sourceIds = Object.keys(manifest);
const domains = new Set(Object.values(manifest));

const db = new Database(dbPath, { readonly: true });
const failures = [];
const warn = (msg) => failures.push(msg);

// --- AC1 : sources et domaines ---
console.log(`Corpus : ${sourceIds.length} document(s), ${domains.size} domaine(s)`);
if (sourceIds.length < 12 || sourceIds.length > 15) {
  warn(`AC1 : attendu 12-15 documents, trouvé ${sourceIds.length}`);
}
if (domains.size < 3) {
  warn(`AC1 : attendu ≥ 3 domaines, trouvé ${domains.size}`);
}

// 0 job failed pour les sources du corpus (ingest + summary)
const failed = db
  .prepare(
    `SELECT j.kind, j.status, j.error FROM jobs j
     WHERE j.source_id IN (${sourceIds.map(() => "?").join(",")}) AND j.status = 'failed'`
  )
  .all(...sourceIds);
if (failed.length > 0) {
  warn(`AC1 : ${failed.length} job(s) failed — ${JSON.stringify(failed.map((f) => f.kind))}`);
}

// --- AC2 : locators, BLOB, total ---
// raw_content chargé une seule fois par source (éviter la duplication par fragment,
// qui fait exploser le heap sur un gros corpus).
const rawBySource = new Map(
  db
    .prepare(`SELECT id, raw_content FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`)
    .all(...sourceIds)
    .map((r) => [r.id, r.raw_content])
);
const stmt = db.prepare(
  `SELECT f.id, f.locator, f.text, f.embedding, f.embedding_dimensions AS dims,
          f.chunk_index, f.source_id
   FROM fragments f
   WHERE f.source_id IN (${sourceIds.map(() => "?").join(",")})`
);
const rows = stmt.all(...sourceIds);
const total = rows.length;
console.log(`Fragments : ${total}`);
if (total > 5000) warn(`AC2 : corpus ${total} > 5 000 fragments`);

let locatorOk = 0;
let blobOk = 0;
let seqOk = 0;
const perSource = new Map();
for (const r of rows) {
  // locator : [start,end) demi-ouvert sur raw_content (String.slice)
  const m = r.locator.match(/\[(\d+),(\d+)\)$/);
  if (!m) {
    warn(`Locator invalide : ${r.locator} (fragment ${r.id})`);
    continue;
  }
  const start = Number(m[1]);
  const end = Number(m[2]);
  const raw = rawBySource.get(r.source_id);
  if (raw === undefined) warn(`raw_content introuvable pour ${r.source_id}`);
  else if (raw.slice(start, end) === r.text) locatorOk += 1;
  else warn(`Locator faux : ${r.locator} (fragment ${r.id})`);

  // BLOB embedding : byteLength == dims × 4, valeurs finies, L2 ≈ 1
  const buf = r.embedding;
  if (buf.byteLength === r.dims * 4) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let sum = 0;
    let finite = true;
    for (let i = 0; i < r.dims; i++) {
      const v = view.getFloat32(i * 4, true);
      if (!Number.isFinite(v)) finite = false;
      sum += v * v;
    }
    const norm = Math.sqrt(sum);
    if (finite && Math.abs(norm - 1) < 1e-4) blobOk += 1;
    else warn(`BLOB non conforme (norme ${norm}) : fragment ${r.id}`);
  } else {
    warn(`BLOB taille ${buf.byteLength} != ${r.dims * 4} : fragment ${r.id}`);
  }

  // chunk_index séquentiel sans trou par source
  const arr = perSource.get(r.source_id) ?? [];
  arr.push(r.chunk_index);
  perSource.set(r.source_id, arr);
}
for (const [sid, idxs] of perSource) {
  idxs.sort((a, b) => a - b);
  for (let i = 0; i < idxs.length; i++) {
    if (idxs[i] !== i) {
      warn(`chunk_index non séquentiel sur ${sid}`);
      break;
    }
  }
  seqOk += 1;
}

console.log(
  `Locators re-slicés : ${locatorOk}/${total} · BLOB conformes : ${blobOk}/${total} · sources séquentielles : ${seqOk}/${perSource.size}`
);

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nPhase 1B : PASS — corpus valide.");
process.exit(0);