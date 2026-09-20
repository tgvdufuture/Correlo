-- Migration 009 — conversation (Phase 6, amendement v1.3 §13).
--
-- Deux entités **nouvelles**, comme la 002 : le schéma v1.2 (§3.3) reste intact,
-- aucune colonne n'est ajoutée à sources / fragments / suggestions / constructions /
-- investigations. Le `jobs` est en revanche reconstruit, exactement comme la 003
-- (`synthesize`) puis la 008 (`reembed`) : SQLite ne sait pas modifier une contrainte
-- CHECK, et `kind` doit accepter `conversation`.

-- Une conversation part d'une **synthèse** ou du corpus. L'ancre est un fait de la
-- ligne : le CHECK l'impose, plutôt que de laisser un `anchor_ref` nul circuler avec
-- `anchor_kind = 'synthesis'` (un état que l'écran devrait deviner).
-- Pas de clé étrangère vers `syntheses` : la contrainte serait tenable ici (l'ancre
-- n'est pas polymorphe), mais une synthèse supprimée doit laisser la conversation
-- lisible — c'est le parti pris des `canvas_items`. L'existence de l'ancre est
-- vérifiée au dépôt, à la création.
CREATE TABLE conversations (
  id             TEXT PRIMARY KEY,
  anchor_kind    TEXT NOT NULL CHECK (anchor_kind IN ('synthesis','corpus')),
  anchor_ref     TEXT,
  title          TEXT NOT NULL,
  chat_model     TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (
    (anchor_kind = 'synthesis' AND anchor_ref IS NOT NULL) OR
    (anchor_kind = 'corpus' AND anchor_ref IS NULL)
  )
);
CREATE INDEX idx_conversations_anchor ON conversations(anchor_kind, anchor_ref);

-- Un message est un tour de la conversation. Pour l'assistant :
--  - `text` est **assemblé par le serveur** à partir de `claims` (jamais la prose brute
--    du modèle) : c'est la seule façon de rendre « chaque affirmation porte une
--    provenance » vérifiable ;
--  - `claims` porte la copie des preuves au moment T (fragment, texte, locator) ;
--  - `run` porte l'enveloppe du tour (budget, compteurs, catalogue, étapes) — le schéma
--    d'une table v1.2 n'a pas de colonnes pour ces métadonnées, et cette table-ci n'a
--    pas à les multiplier : même parti pris que `investigations.steps`.
-- `status` rend l'attente et l'échec **lisibles** : une ligne n'existe qu'à partir du
-- premier appel LLM, donc l'écran doit pouvoir dire « en cours » et « échec ».
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text            TEXT NOT NULL,
  claims          TEXT NOT NULL DEFAULT '[]',
  run             TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE jobs_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('ingest','summary','discover','investigation','synthesize','reembed','conversation')),
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
