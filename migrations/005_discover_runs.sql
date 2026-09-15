-- Migration 005 — métadonnées de run du job `discover` (Phase 2B, AC1)
--
-- Constat (2026-09-15) : en 2A, l'identité d'un run (`run_id`, `corpus_hash`,
-- `seed`, version d'échantillonnage) n'existait que dans `jobs.progress_json` —
-- écrasé à chaque réexécution et remis à NULL par l'upsert d'`idempotency_key` —
-- et dans `data/discover_runs.json`, écrit par le CLI. Après deux runs réels
-- (`val-div`, `val-base`), la base ne conservait donc **aucune trace** de leur
-- identité : impossible de rejouer « le même » run sans le payload du job.
--
-- `discover_runs` est une entité NOUVELLE : le schéma v1.2 (§3.2 DO NOT CHANGE)
-- reste intact — aucune colonne n'est ajoutée à sources / fragments / suggestions /
-- constructions / jobs. Même parti pris que `themes` (migration 002) pour la 5A.
--
-- Clé primaire `run_id` : rejouer un run met à jour **sa** ligne au lieu d'en créer
-- une seconde. Un rejeu ne peut donc pas passer pour un run supplémentaire, et deux
-- runs ne partagent jamais une identité. `sampler_version` est persistée avec la
-- seed : sans elle, un `run_id` rejoué après un changement d'algorithme produirait
-- un autre échantillon sans que rien ne le signale.
CREATE TABLE discover_runs (
  run_id                 TEXT PRIMARY KEY,
  job_id                 TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  sampler                TEXT NOT NULL CHECK (sampler IN ('diversified','top6')),
  sampler_version        TEXT NOT NULL,
  corpus_hash            TEXT NOT NULL,
  seed                   TEXT NOT NULL,
  prompt_version         TEXT NOT NULL,
  chat_model             TEXT NOT NULL,
  source_ids             TEXT NOT NULL,               -- JSON (uuid[]) : corpus figé du run
  pairs                  INTEGER NOT NULL DEFAULT 0,
  batch_calls            INTEGER NOT NULL DEFAULT 0,
  batch_calls_from_cache INTEGER NOT NULL DEFAULT 0,
  created                INTEGER NOT NULL DEFAULT 0,
  created_ids            TEXT NOT NULL DEFAULT '[]',  -- JSON (uuid[]) : sortie du run
  skipped                TEXT NOT NULL DEFAULT '{}',  -- JSON : compteurs de rejets
  error                  TEXT,
  started_at             TEXT NOT NULL,
  completed_at           TEXT
);
CREATE INDEX idx_discover_runs_status ON discover_runs(status);
CREATE INDEX idx_discover_runs_corpus ON discover_runs(corpus_hash, sampler);
