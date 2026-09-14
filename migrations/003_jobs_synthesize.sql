-- Migration 003 — autorise le kind de job `synthesize` (Phase 5A, amendement v1.3 §2.1).
--
-- SQLite ne sait pas modifier une contrainte CHECK : la table doit être
-- reconstruite (procédure standard « rebuild table »). Aucune colonne n'est
-- ajoutée, renommée ou supprimée, aucun index ne change de définition : seules
-- les valeurs acceptées par `kind` sont étendues. La table jobs n'est
-- référencée par aucune clé étrangère, donc la reconstruction ne peut pas
-- casser une contrainte d'intégrité. Le migrator exécute ce fichier dans une
-- transaction, où `PRAGMA foreign_keys` serait de toute façon sans effet.

CREATE TABLE jobs_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('ingest','summary','discover','investigation','synthesize')),
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_id       TEXT REFERENCES sources(id) ON DELETE CASCADE,
  lease_until     TEXT,
  heartbeat_at    TEXT,
  lease_token     TEXT,
  checkpoint      TEXT,
  progress_json   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  next_run_at     TEXT NOT NULL
);

INSERT INTO jobs_new (id, kind, payload, status, attempts, error, idempotency_key,
  source_id, lease_until, heartbeat_at, lease_token, checkpoint, progress_json,
  created_at, updated_at, next_run_at)
SELECT id, kind, payload, status, attempts, error, idempotency_key,
  source_id, lease_until, heartbeat_at, lease_token, checkpoint, progress_json,
  created_at, updated_at, next_run_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_status_next_run ON jobs(status, next_run_at);
CREATE INDEX idx_jobs_source ON jobs(source_id);
