-- Migration 010 — les canvases deviennent plusieurs (v1.6, amendement §14, l'explorateur).
--
-- Constat : il n'existe qu'**un seul** espace de plan (l'atelier, migrations 006/007),
-- alors que l'usage v1.6 est d'**explorer ses tableaux** — donc d'en avoir plusieurs.
-- Le PRD §3.2 verrouille le schéma v1.2 : on n'ajoute aucune colonne à
-- `constructions`, `sources` ni `conversations`. Trois entités nouvelles ou
-- reconstruites, comme 003/008/009 l'ont fait pour `jobs` :
--
--  - `canvases` : le tableau lui-même (label, étiquette couleur, épinglé, ordre) ;
--  - `canvas_frames` : **reconstruite** — une frame appartient à un canvas
--    (`canvas_id`). SQLite ne sait pas ajouter une colonne NOT NULL avec clé
--    étrangère ; la danse est celle de 007 (qui a reconstruit `canvas_nodes` en
--    `canvas_items` sous les mêmes contraintes de FK) ;
--  - `conversation_canvases` : table de liaison (multi-ancrage, §14.3) — une
--    conversation peut traverser plusieurs tableaux.
--
-- Deux parti pris gouvernent la suppression (§14.5 AC1/AC4) :
--  - supprimer un **canvas** détache ses objets, jamais l'inverse : une
--    Construction supprimée emporte son `canvas_items` (CASCADE existant), mais
--    supprimer un canvas ne supprime **aucune** entité. Les frames du canvas
--    supprimé retombent sur l'atelier (réaffectées), et les items qu'elles
--    rangeaient repassent « hors frame » (frame_id NULL) — visibles et
--    récupérables, jamais perdus.
--  - l'atelier est **non supprimable** (`is_default = 1`, unique ci-dessous) :
--    c'est le réceptacle des détachements et le premier canvas de l'app.

CREATE TABLE canvases (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  color      TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Un seul réceptacle : deux ateliers rendraient la règle de détachement ambiguë.
CREATE UNIQUE INDEX idx_canvases_default ON canvases(is_default) WHERE is_default = 1;

-- L'atelier existant devient le premier canvas (§14.2). Sans lui, les frames
-- migrées n'auraient pas de parent — et l'explorateur serait vide à l'ouverture.
INSERT INTO canvases (id, label, color, is_default, pinned, position, created_at, updated_at)
SELECT
  'canvas-atelier',
  'Atelier',
  NULL,
  1,
  1,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Sauvegarde des items **avant** de toucher aux frames : `canvas_items.frame_id`
-- porte un `ON DELETE SET NULL`, donc vider `canvas_frames` sous les FK effacerait
-- les appartennances — alors que les frames renaissent avec **les mêmes ids** et
-- doivent les retrouver. On copie, on dépose (la FK disparaît avec la table),
-- puis on restaurera après la reconstruction.
CREATE TABLE canvas_items_bak (
  item_kind  TEXT NOT NULL,
  item_ref   TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          INTEGER NOT NULL DEFAULT 0,
  frame_id   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_ref)
);
INSERT INTO canvas_items_bak SELECT * FROM canvas_items;
DROP TABLE canvas_items;

-- Reconstruction de `canvas_frames` avec son parent. Tout ce qui existe
-- aujourd'hui appartient à l'atelier.
CREATE TABLE canvas_frames_new (
  id         TEXT PRIMARY KEY,
  canvas_id  TEXT NOT NULL REFERENCES canvases(id),
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('frame','group')),
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  width      REAL NOT NULL CHECK (width > 0),
  height     REAL NOT NULL CHECK (height > 0),
  color      TEXT,
  z          INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO canvas_frames_new
  (id, canvas_id, label, kind, x, y, width, height, color, z, created_at, updated_at)
SELECT id, 'canvas-atelier', label, kind, x, y, width, height, color, z, created_at, updated_at
FROM canvas_frames;

DROP TABLE canvas_frames;
ALTER TABLE canvas_frames_new RENAME TO canvas_frames;
CREATE INDEX idx_canvas_frames_canvas ON canvas_frames(canvas_id);

-- Restauration des items, DDL identique à 007 : les frame_id sauvegardés
-- re-pointent vers les frames re-nées (mêmes ids), les appartenances survivent.
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
INSERT INTO canvas_items SELECT * FROM canvas_items_bak;
CREATE INDEX idx_canvas_items_frame ON canvas_items(frame_id);
DROP TABLE canvas_items_bak;

-- Le multi-ancrage (§14.3) : une conversation peut traverser plusieurs tableaux.
-- `anchor_kind/anchor_ref` (009) reste lisible pour l'ancrage historique — la
-- règle de lecture est « ancré sur le corpus » tant qu'aucune liaison n'existe.
CREATE TABLE conversation_canvases (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  canvas_id       TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, canvas_id)
);
CREATE INDEX idx_conversation_canvases_canvas ON conversation_canvases(canvas_id);
