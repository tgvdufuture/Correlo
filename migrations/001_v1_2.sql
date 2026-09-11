-- Migration 001 — schéma v1.2 (PRD §3.3, DO NOT CHANGE)
-- SQLite, WAL, foreign_keys = ON (appliqués par lib/db/client.ts)

CREATE TABLE sources (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('TEXT','PDF','URL')),
  title          TEXT,
  canonical_path TEXT,
  raw_content    TEXT NOT NULL,
  content_hash   TEXT NOT NULL UNIQUE,
  summary        TEXT,
  summary_status TEXT NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending','done','failed')),
  created_at     TEXT NOT NULL
);

CREATE TABLE fragments (
  id                   TEXT PRIMARY KEY,
  source_id            TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_index          INTEGER NOT NULL,
  locator              TEXT NOT NULL,
  text                 TEXT NOT NULL,
  embedding            BLOB NOT NULL,
  embedding_model      TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  embedding_version    TEXT NOT NULL,
  chunker_version      TEXT NOT NULL DEFAULT 'chunker-v1',
  UNIQUE (source_id, chunk_index)
);
CREATE INDEX idx_fragments_source ON fragments(source_id);

CREATE TABLE suggestions (
  id              TEXT PRIMARY KEY,
  claim           TEXT NOT NULL,
  relation_type   TEXT NOT NULL CHECK (relation_type IN ('analogy','contradiction','cause')),
  tier            TEXT NOT NULL CHECK (tier IN ('strong','medium','weak')),
  state           TEXT NOT NULL DEFAULT 'discovered' CHECK (state IN ('discovered','shown','opened','accepted','rejected')),
  fragment_a_id   TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  fragment_b_id   TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  pair_key        TEXT NOT NULL,
  content_sig     TEXT NOT NULL,
  epistemic_status TEXT NOT NULL CHECK (epistemic_status IN ('FACT','INFERENCE','HYPOTHESIS','SPECULATION')),
  prompt_version  TEXT NOT NULL,
  chat_model      TEXT NOT NULL,
  feedback_reason TEXT CHECK (feedback_reason IN ('trivial','false','already_known','off_topic')),
  UNIQUE (pair_key, relation_type, content_sig)
);
CREATE INDEX idx_suggestions_state ON suggestions(state);
CREATE INDEX idx_suggestions_pair ON suggestions(pair_key, relation_type);

CREATE TABLE constructions (
  id                    TEXT PRIMARY KEY,
  text                  TEXT NOT NULL,
  epistemic_status      TEXT NOT NULL CHECK (epistemic_status IN ('FACT','INFERENCE','HYPOTHESIS','SPECULATION')),
  parent_source_ids     TEXT NOT NULL,
  evidence_fragment_ids TEXT NOT NULL,
  suggestion_id         TEXT UNIQUE REFERENCES suggestions(id) ON DELETE SET NULL,
  depth                 INTEGER NOT NULL CHECK (depth = 1),
  stale                 INTEGER NOT NULL DEFAULT 0,
  provenance_snapshot   TEXT NOT NULL
);

CREATE TABLE investigations (
  id            TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  steps         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('ingest','summary','discover','investigation')),
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
CREATE INDEX idx_jobs_status_next_run ON jobs(status, next_run_at);
CREATE INDEX idx_jobs_source ON jobs(source_id);