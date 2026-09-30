-- Migration 012 — les tableaux s'imbriquent : `canvases.parent_id` (v1.6.1).
--
-- Constat : la 010 a posé la collection à plat (« canvases → frames, l'arbre
-- s'arrête aux frames », §14.1) ; l'usage réel veut des **sous-dossiers** — un
-- tableau dans un tableau (ex. « Veille » découpée en « Papiers », « Modèles »).
-- Le parent est un fait de la ligne, comme `pinned` : une colonne, pas une table.
--
-- **Pas de reconstruction ici**, et c'est délibéré : reconstruire `canvases`
-- oblige à la déposer alors que `canvas_frames`, `canvas_items` et
-- `conversation_canvases` la référencent — la FK crie au premier DROP, et le
-- build (prerender de `/canvas`, qui ouvre la base neuve) l'a attrapé. Or SQLite
-- sait **ajouter une colonne nullable portant une FK** (`ADD COLUMN ... 
-- REFERENCES`) : défaut NULL, donc chaque canvas existant naît racine — exactement
-- l'état voulu, aucune danse, aucune table enfant touchée.
--
-- Deux règles gouvernent l'imbrication, portées par le dépôt (testées) :
--  - **un cycle est impossible** — pas par CHECK (SQLite ne sait pas vérifier un
--    graphe), mais par le dépôt : `setParent` refuse de poser un tableau sous l'un
--    de ses descendants (`reason: 'cycle'`). La FK seule refuse un parent inconnu ;
--    la profondeur libre est acceptée (l'arbre n'est pas borné) ;
--  - **l'atelier reste le réceptacle racine** — il est non supprimable (010) et
--    ne peut pas être déplacé sous un autre tableau (dépôt, `reason: 'atelier'`).
--
-- `ON DELETE RESTRICT` plutôt que CASCADE : supprimer un tableau qui a des
-- enfants doit être **impossible en base** si quelqu'un passe outre le dépôt —
-- le dépôt, lui, remonte les enfants AVANT le DELETE (grand-parent, ou racine).

ALTER TABLE canvases ADD COLUMN parent_id TEXT REFERENCES canvases(id) ON DELETE RESTRICT;
CREATE INDEX idx_canvases_parent ON canvases(parent_id);
