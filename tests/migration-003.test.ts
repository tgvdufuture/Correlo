import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * La migration 003 reconstruit entièrement la table `jobs` (SQLite ne sait pas
 * modifier une contrainte CHECK). Ce test vérifie les deux propriétés qui font
 * qu'une reconstruction est acceptable : **aucune perte** et **aucune
 * régression** — la clé étrangère vers `sources` et les index doivent survivre.
 */
const migration = (name: string): string =>
  fs.readFileSync(path.join(process.cwd(), "migrations", name), "utf8");

const JOB_COLUMNS = `(id, kind, payload, status, attempts, idempotency_key, source_id,
  created_at, updated_at, next_run_at)`;

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(migration("001_v1_2.sql"));
  db.exec(migration("002_v1_3.sql"));
  db.prepare(
    `INSERT INTO sources (id, type, raw_content, content_hash, created_at)
     VALUES ('s1', 'TEXT', 'contenu', 'hash-s1', '2026-09-11T00:00:00.000Z')`
  ).run();
  return db;
}

function insertJob(db: Database.Database, kind: string, id: string, sourceId: string | null) {
  db.prepare(
    `INSERT INTO jobs ${JOB_COLUMNS}
     VALUES (?, ?, '{}', 'pending', 0, ?, ?, '2026-09-11T00:00:00.000Z',
       '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')`
  ).run(id, kind, `idem-${id}`, sourceId);
}

describe("migration 003 — kind de job synthesize", () => {
  it("refuse synthesize avant, l'accepte après, et préserve les jobs existants", () => {
    const db = setupDb();
    insertJob(db, "ingest", "j1", "s1");
    insertJob(db, "discover", "j2", null);
    // la contrainte d'origine n'autorise pas le nouveau kind
    expect(() => insertJob(db, "synthesize", "j3", null)).toThrow(/CHECK constraint failed/);

    db.exec(migration("003_jobs_synthesize.sql"));

    // aucun job perdu, valeurs intactes (reconstruction avec copie explicite)
    const rows = db.prepare("SELECT id, kind, status, source_id FROM jobs ORDER BY id").all() as {
      id: string;
      kind: string;
      status: string;
      source_id: string | null;
    }[];
    expect(rows).toEqual([
      { id: "j1", kind: "ingest", status: "pending", source_id: "s1" },
      { id: "j2", kind: "discover", status: "pending", source_id: null },
    ]);

    insertJob(db, "synthesize", "j3", null);
    expect((db.prepare("SELECT kind FROM jobs WHERE id = 'j3'").get() as { kind: string }).kind).toBe(
      "synthesize"
    );

    // les index sont recréés (DROP TABLE les emporte avec la table)
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_jobs_status_next_run");
    expect(indexes).toContain("idx_jobs_source");

    // et la clé étrangère vers sources survit : supprimer la source supprime le job
    db.prepare("DELETE FROM sources WHERE id = 's1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id = 'j1'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 2 });
    db.close();
  });

  it("un second passage ne duplique ni ne perd de job", () => {
    const db = setupDb();
    db.exec(migration("003_jobs_synthesize.sql"));
    insertJob(db, "synthesize", "j1", null);
    // en pratique `schema_migrations` empêche un second passage ; on vérifie que
    // la reconstruction elle-même est sans effet de bord sur les données
    db.exec(migration("003_jobs_synthesize.sql"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
    expect(
      (db.prepare("SELECT kind FROM jobs WHERE id = 'j1'").get() as { kind: string }).kind
    ).toBe("synthesize");
    db.close();
  });
});
