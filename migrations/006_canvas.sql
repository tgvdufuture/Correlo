-- Migration 006 — disposition du canvas (Phase 3, volet canvas libre)
--
-- Constat : une Construction (migration 001) porte son contenu, son statut et sa
-- provenance, mais **aucune position**. Le PRD §3.2 verrouille le schéma v1.2 :
-- on n'ajoute donc aucune colonne à `constructions` — la disposition vit dans des
-- entités NOUVELLES, comme `discover_runs` (005), `themes`/`syntheses` (002/003)
-- et `llm_cache` (004). Une Construction supprimée emporte sa disposition
-- (CASCADE), et dissoudre un cadre ne touche jamais aux nœuds qu'il contenait.
--
-- Deux entités plutôt qu'une : un **cadre** (« frame ») et un **groupe** partagent
-- la même mécanique (déplacer le conteneur déplace ses membres) mais se dessinent
-- différemment — panneau titré pour le cadre, contour pointillé pour le groupe —
-- et c'est le seul endroit où la distinction doit être stockée.
--
-- `canvas_nodes.z` : ordre d'empilement. `canvas_frames.z` : un cadre se dessine
-- sous ses nœuds, l'ordre relatif des cadres entre eux évite qu'un cadre déplacé
-- passe sous les autres.
--
-- `canvas_nodes.frame_id` : appartenance, `ON DELETE SET NULL` — supprimer un
-- cadre **dissout** le groupe sans déplacer ni supprimer un seul nœud (les
-- positions restent celles du dernier déplacement). Supprimer un cadre ne doit
-- jamais faire disparaître une Construction.
CREATE TABLE canvas_frames (
  id         TEXT PRIMARY KEY,
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

CREATE TABLE canvas_nodes (
  construction_id TEXT PRIMARY KEY REFERENCES constructions(id) ON DELETE CASCADE,
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  z               INTEGER NOT NULL DEFAULT 0,
  frame_id        TEXT REFERENCES canvas_frames(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_canvas_nodes_frame ON canvas_nodes(frame_id);

-- Placement initial des Constructions déjà présentes : sans cela, elles
-- apparaîtraient empilées à l'origine (0,0) après la migration. Grille de 4
-- colonnes, dans l'ordre de création — même règle que `nextFreeSlot()` du dépôt,
-- qui place « 4 par ligne sous le point le plus bas » pour les suivantes.
INSERT INTO canvas_nodes (construction_id, x, y, z, frame_id, created_at, updated_at)
SELECT
  c.id,
  60 + ((ROW_NUMBER() OVER (ORDER BY c.rowid) - 1) % 4) * 340,
  60 + (((ROW_NUMBER() OVER (ORDER BY c.rowid) - 1) / 4)) * 260,
  ROW_NUMBER() OVER (ORDER BY c.rowid),
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM constructions c;
