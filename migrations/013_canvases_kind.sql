-- Migration 013 — le dossier est un conteneur, pas une surface (v1.6.2).
--
-- Retour d'usage de la v1.6.1 : imbriquer des **canvases** brouille la métaphore —
-- un tableau qui contient des tableaux qui ont des plans… et l'explorateur ne dit
-- plus ce qu'on ouvre. Le modèle propre, celui d'un explorateur de fichiers :
--
--  - **le dossier (`kind = 'folder'`) est un conteneur pur** : il ne porte ni
--    frame, ni item, ni conversation — il **range** des canvas et des dossiers ;
--  - **le canvas (`kind = 'canvas'`) est une surface de travail** : le plan
--    (frames + items), les conversations ancrées — exactement le canvas d'aujourd'hui ;
--  - **côte à côte** : un dossier contient des canvas ET des dossiers, mélangés,
--    comme un répertoire contient des fichiers et des sous-répertoires.
--
-- Deux conséquences structurelles, portées par le dépôt (testées) :
--  - un dossier ne peut pas vivre sous un canvas (`parent_id` pointe toujours un
--    dossier) : ce qui se range va dans un conteneur — un canvas n'est pas un
--    conteneur. (Un canvas reste, lui, créé à la racine ou dans un dossier.)
--  - les gardes d'écriture refusent ce que la ligne ne doit pas porter : créer une
--    frame, poser un item, lier une conversation **dans un dossier** est une erreur
--    nommée, jamais un silence.
--
-- `ALTER TABLE` (leçon de la 012) : la table est référencée par trois tables
-- enfants, la reconstruction est interdite par FK. Chaque canvas existant naît
-- `kind = 'canvas'` (défaut) — l'arbre v1.6.1 se lit comme un arbre de dossiers
-- avec des canvas dedans, rien ne bouge.

ALTER TABLE canvases ADD COLUMN kind TEXT NOT NULL DEFAULT 'canvas' CHECK (kind IN ('canvas', 'folder'));
CREATE INDEX idx_canvases_kind ON canvases(kind);
