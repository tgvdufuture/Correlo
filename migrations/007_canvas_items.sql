-- Migration 007 — le canvas devient l'atelier (fichiers + liens + Constructions)
--
-- Constat : la 006 ne savait disposer que des **Constructions** (`canvas_nodes`,
-- clé étrangère vers `constructions`). Or l'usage réel du produit est l'inverse —
-- on dépose des **fichiers**, on les dispose librement, et l'IA propose ensuite
-- des liens *entre eux*. Un canvas où les fichiers n'existent pas ne peut pas
-- montrer ce que l'IA a trouvé : `suggestions` relie déjà deux **fragments**, donc
-- deux sources — il ne manquait que la place des sources.
--
-- Le PRD §3.2 verrouille le schéma v1.2 : on n'ajoute donc rien à `sources` ni à
-- `constructions`. Une entité NOUVELLE remplace `canvas_nodes` et accepte les deux
-- natures d'élément, comme `discover_runs` (005) et `themes`/`syntheses` (002/003)
-- ont été ajoutés sans toucher aux tables existantes.
--
-- `item_kind` ∈ {construction, source} + `item_ref` (uuid de l'entité) forment la
-- clé : un élément du canvas *est* une entité du produit, il n'a pas d'identité
-- propre — `UNIQUE` implicite par la clé primaire. La conséquence, assumée : une
-- entité supprimée laisse une ligne à retirer explicitement (SQLite n'a pas de clé
-- étrangère polymorphe) — c'est `prune()` du dépôt qui s'en charge, avant chaque
-- lecture, et `DELETE /api/sources/:id` pour le cas courant.
--
-- `canvas_frames` (006) est inchangé : un cadre/groupe contient désormais
-- indifféremment des fichiers et des Constructions.
CREATE TABLE canvas_items (
  item_kind  TEXT NOT NULL CHECK (item_kind IN ('construction', 'source')),
  item_ref   TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          INTEGER NOT NULL DEFAULT 0,
  frame_id   TEXT REFERENCES canvas_frames(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_ref)
);

CREATE INDEX idx_canvas_items_frame ON canvas_items(frame_id);

-- Les Constructions déjà disposées descendent d'une bande, pour laisser la
-- première rangée aux fichiers (qui sont ce que l'on regarde en premier).
UPDATE canvas_nodes
SET y = y + (((SELECT COUNT(*) FROM sources s
               WHERE EXISTS (SELECT 1 FROM fragments f WHERE f.source_id = s.id)) + 3) / 4)
        * 240 + 120;

INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
SELECT 'construction', construction_id, x, y, z, frame_id, created_at, updated_at
FROM canvas_nodes
ORDER BY z ASC, rowid ASC;

DROP TABLE canvas_nodes;

-- Les sources déjà ingérées prennent place : grille de 4 colonnes, `z` au-dessus
-- des Constructions (elles se dessinent donc devant elles). Une source sans
-- fragment (import en attente, échec) n'a rien à montrer : elle sera placée au
-- moment de son ingestion (`placeMissing`).
INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
SELECT
  'source',
  s.id,
  60 + ((ROW_NUMBER() OVER (ORDER BY s.rowid) - 1) % 4) * 340,
  60 + (((ROW_NUMBER() OVER (ORDER BY s.rowid) - 1) / 4)) * 240,
  1000 + ROW_NUMBER() OVER (ORDER BY s.rowid),
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sources s
WHERE EXISTS (SELECT 1 FROM fragments f WHERE f.source_id = s.id);
