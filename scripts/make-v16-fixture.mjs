#!/usr/bin/env node
/**
 * Fabrique la **fixture jetable** des checks navigateur de l'explorateur
 * (v1.6) : `data/eval/v16-check.db`.
 *   node scripts/make-v16-fixture.mjs
 *
 * Pourquoi ce script existe : les checks `browser-check-explorer.mjs` et
 * `browser-check-explorer-nested.mjs` **écrivent** (création, déplacement,
 * suppression, dépôt de fichier). Les lancer sur `data/serendipity.db`
 * toucherait la base réelle. Or la fixture était jusqu'ici VACUUM-ée « à la
 * main », sans script — les checks étaient donc **injouables** pour quiconque
 * n'était pas l'auteur de la v1.6.
 *
 * Ce que la fixture apporte sur la copie, et pourquoi :
 *  - « Veille vérification » : une seconde carte racine, pour que la grille
 *    montre plus d'un tableau ;
 *  - « Zone de vérification » : une frame **dans l'atelier**, cliquable dans la
 *    vignette (`button[title*="Zone de vérification"]`) — l'atelier n'en a qu'une
 *    (« Cadre »), de nom différent.
 * Elle s'appuie sur le contenu réel de la base (l'atelier et ses 27 objets, dont
 * la construction « … la bombe nucléaire … » que le check cherche) : la copie
 * est vraie, seules les deux briques manquantes sont ajoutées.
 *
 * **Idempotent** : les deux briques sont supprimées puis recréées, on peut le
 * relancer sanscumuler.
 *
 * La base réelle n'est ouverte qu'en **lecture seule**, et son contenu est
 * dénombré avant et après : la fixture ne peut pas l'avoir modifiée.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SRC = "data/serendipity.db";
const OUT = "data/eval/v16-check.db";

if (!fs.existsSync(SRC)) {
  console.error(`Source absente : ${SRC}`);
  process.exit(1);
}

/* ── l'état de la vraie base, compté AVANT ── */
const count = (db) => ({
  canvases: db.prepare("select count(*) n from canvases").get().n,
  items: db.prepare("select count(*) n from canvas_items").get().n,
  conversations: db.prepare("select count(*) n from conversations").get().n,
});

const srcRead = new Database(SRC, { readonly: true });
const before = count(srcRead);
srcRead.close();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });
fs.rmSync(`${OUT}-wal`, { force: true });
fs.rmSync(`${OUT}-shm`, { force: true });

/* ── la copie jetable ── */
const seed = new Database(SRC, { readonly: true });
seed.exec(`VACUUM INTO '${OUT}'`);
seed.close();

const db = new Database(OUT);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const now = new Date().toISOString();
const VILLE = "Veille vérification";
const FRAME = "Zone de vérification";

/* Idempotence : on repart d'un état propre pour les deux briques. */
const oldFrame = db.prepare("select id from canvas_frames where label = ?").all(FRAME);
for (const f of oldFrame) db.prepare("delete from canvas_frames where id = ?").run(f.id);

const oldCanvases = db.prepare("select id from canvases where label = ?").all(VILLE);
for (const c of oldCanvases) {
  // Les objets du tableau condamné sont **relogés chez l'atelier** (v1.6 §14.2),
  // pas détruits — même règle que le dépôt, pour ne pas laisser la FK en l'air.
  db.prepare(
    "update canvas_items set canvas_id = 'canvas-atelier' where canvas_id = ?"
  ).run(c.id);
  db.prepare("delete from canvases where id = ?").run(c.id);
}

db.prepare(
  "insert into canvases (id, label, color, is_default, pinned, position, created_at, updated_at, parent_id, kind) values (?,?,?,0,0,?,?,?,null,'canvas')"
).run(crypto.randomUUID(), VILLE, null, 900, now, now);

/* La frame vit dans l'atelier, à un endroit dégagé : les items posés
   interceptent les clics, il faut un bord libre (le check clique à +14/+14). */
const frameId = crypto.randomUUID();
const placed = db
  .prepare(
    "select max(x) mx, max(y) my from canvas_items where canvas_id = 'canvas-atelier'"
  )
  .get();
const fx = (placed.mx ?? 0) + 60;
const fy = (placed.my ?? 0) + 60;
db.prepare(
  "insert into canvas_frames (id, canvas_id, label, kind, x, y, width, height, color, z, created_at, updated_at) values (?,?,?,'frame',?,?,640,420,?,0,?,?)"
).run(frameId, "canvas-atelier", FRAME, fx, fy, "blue", now, now);

const report = {
  atelier: db
    .prepare("select count(*) n from canvas_items where canvas_id='canvas-atelier'")
    .get().n,
  canvasRacine: db
    .prepare("select count(*) n from canvases where parent_id is null")
    .get().n,
  frames: db.prepare("select count(*) n from canvas_frames").get().n,
  bombe: db
    .prepare(
      "select count(*) n from constructions where text like '%bombe nucléaire%'"
    )
    .get().n,
};
db.close();

/* ── l'état de la vraie base, compté APRÈS ── */
const after = new Database(SRC, { readonly: true });
const afterCount = count(after);
after.close();

console.log(`Fixture : ${OUT}`);
console.log(`  atelier       : ${report.atelier} objet(s)`);
console.log(`  cartes racine : ${report.canvasRacine} (dont « ${VILLE} »)`);
console.log(`  frames        : ${report.frames} (dont « ${FRAME} »)`);
console.log(`  « bombe nucléaire » : ${report.bombe} construction(s)`);

const untouched =
  before.canvases === afterCount.canvases &&
  before.items === afterCount.items &&
  before.conversations === afterCount.conversations;
console.log(
  `  base réelle   : ${untouched ? "INCHANGÉE" : "⚠ MODIFIÉE"} (${JSON.stringify(before)} → ${JSON.stringify(afterCount)})`
);
if (!untouched) process.exit(1);