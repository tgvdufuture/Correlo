-- Migration 011 — un item hors frame appartient à **son** tableau (v1.6 §14.2, étape 3).
--
-- Constat : la 010 a donné un parent aux **frames** (`canvas_frames.canvas_id`) mais
-- laissé `canvas_items` sans canvas : l'appartenance d'un item hors frame se lisait
-- « c'est l'atelier » (le réceptacle). Le PRD §14.2 tranche autrement :
-- « une construction posée hors frame appartient **au canvas** » — la même règle pour
-- un fichier déposé dans un autre tableau. Sans cela, le tableau focalisé
-- (`/canvas/[id]`) ne peut ni montrer ni recevoir d'objet libre : tout item posé hors
-- frame retombe dans l'atelier, et un dépôt explicite ailleurs est un silence.
--
-- La danse est celle de 010 : SQLite ne sait pas ajouter une colonne NOT NULL avec
-- défaut sur une table porteuse d'une FK polymorphe vivante ; on sauvegarde, on
-- reconstruit avec la colonne, on restaure en rattachant les items existants à
-- l'atelier (le seul canvas qui en avait — aucune position ne bouge).
--
-- Ce qui change pour le code : « hors frame » n'est plus synonyme d'« atelier » ;
-- chaque item porte désormais **les deux** parents (`canvas_id` + `frame_id` nullable).
-- Les lectures se scopent sur `canvas_id` seul ; `frame_id` reste l'appartenance de
-- rangement, les CASCADEs et la règle de détachement de la 010 restent les mêmes.

CREATE TABLE canvas_items_new (
  item_kind  TEXT NOT NULL CHECK (item_kind IN ('construction', 'source')),
  item_ref   TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          INTEGER NOT NULL DEFAULT 0,
  canvas_id  TEXT NOT NULL REFERENCES canvases(id),
  frame_id   TEXT REFERENCES canvas_frames(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_ref)
);

-- Les items existants étaient tous, par construction, des items de l'atelier :
-- la 010 n'avait pas d'autre canvas, et l'écran de l'atelier seul posait des items.
INSERT INTO canvas_items_new
  (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
SELECT
  item_kind, item_ref, x, y, z,
  -- un item framé hérite du canvas de **sa** frame (robuste si un autre canvas
  -- existait déjà) ; un item hors frame retombe sur l'atelier
  COALESCE((SELECT f.canvas_id FROM canvas_frames f WHERE f.id = canvas_items.frame_id),
           'canvas-atelier'),
  frame_id, created_at, updated_at
FROM canvas_items;

DROP TABLE canvas_items;
ALTER TABLE canvas_items_new RENAME TO canvas_items;
CREATE INDEX idx_canvas_items_frame ON canvas_items(frame_id);
CREATE INDEX idx_canvas_items_canvas ON canvas_items(canvas_id);
