-- Migration 002 — amendement v1.3 (Phases 5A/5B : synthèses multi-sources)
-- Le schéma v1.2 (§3.3) reste verrouillé : AUCUNE colonne n'est ajoutée à
-- sources / fragments / suggestions / constructions / jobs. Les thèmes et les
-- synthèses sont deux entités nouvelles (PRD-v1.3-amendement.md §7).

-- Un thème = un cluster de fragments issu du clustering d'embeddings LOCAUX
-- (aucun appel réseau) ; le libellé est calculé par TF-IDF, sans LLM.
CREATE TABLE themes (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  corpus_hash         TEXT NOT NULL,
  seed                TEXT NOT NULL,
  label               TEXT NOT NULL,
  centroid            BLOB NOT NULL,          -- Float32 LE, L2-normalisé (même codec que les fragments)
  centroid_dimensions INTEGER NOT NULL,
  size                INTEGER NOT NULL,
  sampler_version     TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_themes_run ON themes(run_id);

-- Une synthèse = un énoncé multi-sources qui AJOUTE aux documents (PRD v1.3) :
-- au moins 2 sources distinctes, preuves citables, jamais FACT.
CREATE TABLE syntheses (
  id                    TEXT PRIMARY KEY,
  text                  TEXT NOT NULL,
  theme_id              TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  relation_kind         TEXT NOT NULL CHECK (relation_kind IN ('combination','extension','tension','application')),
  -- jamais FACT : une synthèse dit par construction plus qu'une preuve isolée
  epistemic_status      TEXT NOT NULL CHECK (epistemic_status IN ('INFERENCE','HYPOTHESIS','SPECULATION')),
  parent_source_ids     TEXT NOT NULL,        -- JSON (uuid[]) dérivé en base, pas de la confiance du LLM
  evidence_fragment_ids TEXT NOT NULL,        -- JSON (uuid[])
  provenance_snapshot   TEXT NOT NULL,        -- JSON : survit à la suppression d'une source
  content_sig           TEXT NOT NULL UNIQUE, -- SHA256(texte canonicalisé) — dédup des reformulations
  confidence            TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  state                 TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','accepted','rejected')),
  stale                 INTEGER NOT NULL DEFAULT 0,
  prompt_version        TEXT NOT NULL,
  chat_model            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_syntheses_theme ON syntheses(theme_id);
CREATE INDEX idx_syntheses_state ON syntheses(state);
