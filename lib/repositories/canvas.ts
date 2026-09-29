import { randomUUID } from "node:crypto";
import { nowIso, type Db } from "@/lib/db/client";
import { ATELIER_CANVAS_ID } from "@/lib/repositories/canvases";
import {
  decodeConstruction,
  type ConstructionRow,
  type ConstructionView,
} from "@/lib/repositories/constructions";
import {
  createSourcesRepo,
  type SourceListItem,
} from "@/lib/repositories/sources";

/**
 * Canvas-atelier (Phase 3, volets « canvas libre » puis « les fichiers sur le
 * canvas ») — migrations 006 et 007.
 *
 * Le canvas n'accueille plus seulement des Constructions : c'est le **plan de
 * travail** où l'on dépose des fichiers, et où l'IA vient poser ses trouvailles.
 * Trois invariants gouvernent ce fichier :
 *
 *  1. **Rien n'est jamais caché par un défaut de disposition.** Une Construction —
 *     ou un fichier ingéré — sans ligne `canvas_items` serait invisible : on la
 *     place (`placeMissing`, idempotent) au lieu de l'ignorer.
 *  2. **Aucune ligne orpheline.** `canvas_items` ne peut pas porter de clé
 *     étrangère polymorphe (SQLite) : `prune()` retire les éléments dont l'entité
 *     n'existe plus, avant toute lecture. C'est ce qui remplace le CASCADE de la
 *     006 sans le laisser à la charge de l'appelant.
 *  3. **Déplacer un conteneur déplace ses membres, côté serveur.** Le client envoie
 *     la position du cadre, pas celles de ses membres : le serveur applique le même
 *     delta dans la même transaction. Sinon deux fenêtres, ou un rejeu, les
 *     déplaceraient deux fois.
 */

export type CanvasFrameKind = "frame" | "group";
export type CanvasItemKind = "construction" | "source";

/** Libellé de conteneur : longueur maximale acceptée par les routes. */
export const MAX_FRAME_LABEL = 120;

export interface CanvasFrame {
  id: string;
  label: string;
  kind: CanvasFrameKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string | null;
  z: number;
  created_at: string;
  updated_at: string;
}

interface ItemPlacement {
  kind: CanvasItemKind;
  ref: string;
  x: number;
  y: number;
  z: number;
  frame_id: string | null;
}

/**
 * Élément du canvas : sa place, et **l'entité qu'il représente**.
 *
 * Le fichier n'a pas de copie de son titre sur le canvas : il porte la ligne de
 * `sources` telle que la bibliothèque l'affiche (`ingest_status` dérivé des jobs,
 * compte de fragments). Sans cela, deux écrans donneraient deux vérités sur la
 * même source.
 */
export type CanvasItem =
  | (ItemPlacement & { kind: "construction"; construction: ConstructionView })
  | (ItemPlacement & { kind: "source"; source: SourceListItem });

export interface CanvasState {
  frames: CanvasFrame[];
  items: CanvasItem[];
}

export interface ItemPosition {
  kind: CanvasItemKind;
  ref: string;
  x: number;
  y: number;
  /** Absent = l'appartenance n'est pas modifiée. `null` = sortir du conteneur. */
  frame_id?: string | null;
}

export interface ItemRef {
  kind: CanvasItemKind;
  ref: string;
}

export interface NewFrame {
  label: string;
  kind: CanvasFrameKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null;
}

export interface FramePatch {
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string | null;
  z?: number;
}

export interface CanvasRepo {
  getState(): CanvasState;
  /** Retire les éléments dont l'entité n'existe plus. Renvoie le nombre purgé. */
  prune(): number;
  /**
   * Place ce qui n'a pas encore de disposition (idempotent) : les Constructions,
   * et les sources **ingérées** (au moins un fragment). Renvoie le nombre créé.
   */
  placeMissing(): number;
  /** Donne une position à une entité si elle n'en a pas. */
  place(kind: CanvasItemKind, ref: string): void;
  /** Pose une entité à une position **choisie** (fichier lâché à cet endroit). */
  placeAt(kind: CanvasItemKind, ref: string, x: number, y: number): void;
  /** Déplace des éléments (positions **absolues** : rejouer la requête est sans effet). */
  moveItems(items: ItemPosition[]): number;
  createFrame(f: NewFrame): CanvasFrame;
  /** Déplace/redimensionne un cadre ; un déplacement décale ses membres du même delta. */
  updateFrame(id: string, patch: FramePatch): { frame: CanvasFrame; shifted: number } | null;
  /** Dissout un cadre : il disparaît, ses membres gardent leur position. */
  dissolveFrame(id: string): boolean;
  /** Range des éléments dans un conteneur (`null` = aucun). */
  assign(items: ItemRef[], frameId: string | null): number;
  /** Retire des éléments (suppression d'une source, par exemple). */
  removeItems(kind: CanvasItemKind, refs: string[]): number;
}

const COLUMNS = 4;
const COLUMN_WIDTH = 340;
const ROW_HEIGHT = 260;
const MARGIN = 60;

const NEXT_Z = `COALESCE((SELECT MAX(z) FROM canvas_items), 0) + 1`;

export function createCanvasRepo(db: Db, canvasId: string = ATELIER_CANVAS_ID): CanvasRepo {
  const sourcesRepo = createSourcesRepo(db);
  /**
   * Le canvas que **cet** écran sert. L'atelier garde le défaut (appel sans
   * argument = comportement historique inchangé) ; l'écran focalisé (`/canvas/[id]`,
   * v1.6 §14.2) passe l'id du tableau qu'il affiche — lectures, placements et
   * créations de frames opèrent tous sur **ce** canvas.
   */

  /** Première case libre : on complète la rangée du bas, puis on descend. */
  const slotFor = (): { x: number; y: number } => {
    const rows = db.prepare("SELECT x, y FROM canvas_items").all() as {
      x: number;
      y: number;
    }[];
    if (rows.length === 0) return { x: MARGIN, y: MARGIN };
    const bottom = Math.max(...rows.map((r) => r.y));
    const inBottomRow = rows.filter((r) => Math.abs(r.y - bottom) < 1).length;
    return inBottomRow >= COLUMNS
      ? { x: MARGIN, y: bottom + ROW_HEIGHT }
      : { x: MARGIN + inBottomRow * COLUMN_WIDTH, y: bottom };
  };

  const insertItem = (kind: CanvasItemKind, ref: string, x: number, y: number): void => {
    const now = nowIso();
    // Un item vit sur **un seul** plan (PK globale). Deux cas au conflit :
    //  - **même tableau** : le dépôt re-joué ne bouge rien (positions absolues,
    //    idempotence historique — rejouer une requête ne déplace pas l'item) ;
    //  - **autre tableau** : c'est un **déplacement entre plans** — le geste
    //    explicite de l'utilisateur (`INSERT OR IGNORE` laisserait l'item sur
    //    l'autre plan, un silence inacceptable pour un dépôt qui répond 2xx).
    // L'item est posé **hors frame** dans CE tableau : le rangement dans un
    // conteneur est un geste séparé (`assign`).
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ${NEXT_Z}, ?, NULL, ?, ?)
       ON CONFLICT (item_kind, item_ref) DO UPDATE SET
         x = excluded.x, y = excluded.y, z = excluded.z,
         canvas_id = excluded.canvas_id, frame_id = NULL, updated_at = excluded.updated_at
         WHERE canvas_items.canvas_id != excluded.canvas_id`
    ).run(kind, ref, x, y, canvasId, now, now);
  };

  return {
    getState(): CanvasState {
      // une entité supprimée laisserait une ligne fantôme ; une entité non
      // disposée serait invisible : on nettoie et on complète avant de lire
      this.prune();
      this.placeMissing();
      // depuis la 010, l'atelier est **un** canvas parmi d'autres : l'état ne montre
      // que les frames **de ce canvas** (et ses items hors frame, qui lui appartiennent)
      const frames = db
        .prepare(
          `SELECT * FROM canvas_frames WHERE canvas_id = ?
           ORDER BY z ASC, rowid ASC`
        )
        .all(canvasId) as CanvasFrame[];
      const rows = db
        .prepare(
          `SELECT item_kind, item_ref, x, y, z, frame_id
           FROM canvas_items
           WHERE canvas_id = ?
           ORDER BY z ASC, rowid ASC`
        )
        .all(canvasId) as (ItemPlacement & { item_kind: CanvasItemKind; item_ref: string })[];

      // les deux entités jointes en une requête chacune (jamais N+1)
      const constructionRefs = rows.filter((r) => r.item_kind === "construction");
      const constructions = new Map<string, ConstructionView>();
      if (constructionRefs.length > 0) {
        const placeholders = constructionRefs.map(() => "?").join(",");
        const found = db
          .prepare(`SELECT * FROM constructions WHERE id IN (${placeholders})`)
          .all(...constructionRefs.map((r) => r.item_ref)) as ConstructionRow[];
        for (const c of found) constructions.set(c.id, decodeConstruction(c));
      }
      const sources = new Map<string, SourceListItem>(
        sourcesRepo.list().map((s) => [s.id, s])
      );

      const items: CanvasItem[] = [];
      for (const r of rows) {
        const base = { x: r.x, y: r.y, z: r.z, frame_id: r.frame_id };
        if (r.item_kind === "construction") {
          const construction = constructions.get(r.item_ref);
          // `prune()` vient de tourner : l'absence est une course avec une
          // suppression concurrente, on saute plutôt que d'inventer un nœud
          if (construction) items.push({ kind: "construction", ref: r.item_ref, ...base, construction });
        } else {
          const source = sources.get(r.item_ref);
          if (source) items.push({ kind: "source", ref: r.item_ref, ...base, source });
        }
      }
      return { frames, items };
    },

    prune() {
      return db
        .prepare(
          `DELETE FROM canvas_items
           WHERE (item_kind = 'construction'
                  AND item_ref NOT IN (SELECT id FROM constructions))
              OR (item_kind = 'source'
                  AND item_ref NOT IN (SELECT id FROM sources))`
        )
        .run().changes;
    },

    placeMissing() {
      // **Portée du placement : ce canvas.** Une entité déjà posée sur un autre
      // tableau a sa ligne `canvas_items` — elle ne sera pas re-placée ici
      // (`PRIMARY KEY (item_kind, item_ref)`) : un item vit sur **un seul** plan.
      // L'atelier reste le seul à placer **automatiquement** (ingestion, constructions
      // acceptées) : un objet arrive dans un autre tableau par un geste explicite
      // (déposer, ranger) — jamais en masse.
      if (canvasId !== ATELIER_CANVAS_ID) {
        return 0;
      }
      const orphans = db
        .prepare(
          `SELECT c.id AS ref FROM constructions c
           WHERE NOT EXISTS (
             SELECT 1 FROM canvas_items i
             WHERE i.item_kind = 'construction' AND i.item_ref = c.id
           )
           ORDER BY c.rowid ASC`
        )
        .all() as { ref: string }[];
      const sources = db
        .prepare(
          `SELECT s.id AS ref FROM sources s
           WHERE EXISTS (SELECT 1 FROM fragments f WHERE f.source_id = s.id)
             AND NOT EXISTS (
               SELECT 1 FROM canvas_items i
               WHERE i.item_kind = 'source' AND i.item_ref = s.id
             )
           ORDER BY s.rowid ASC`
        )
        .all() as { ref: string }[];
      if (orphans.length === 0 && sources.length === 0) return 0;
      const tx = db.transaction(() => {
        // les fichiers d'abord : ils prennent les places hautes, sous la dernière ligne
        for (const s of sources) {
          const slot = slotFor();
          insertItem("source", s.ref, slot.x, slot.y);
        }
        for (const o of orphans) {
          const slot = slotFor();
          insertItem("construction", o.ref, slot.x, slot.y);
        }
      });
      tx();
      return orphans.length + sources.length;
    },

    place(kind, ref) {
      const slot = slotFor();
      insertItem(kind, ref, slot.x, slot.y);
    },

    placeAt(kind, ref, x, y) {
      insertItem(kind, ref, x, y);
    },

    moveItems(items) {
      if (items.length === 0) return 0;
      const now = nowIso();
      // seuls les éléments existants bougent : une position ne crée pas d'élément
      // pour une entité inconnue — et un déplacement reste **dans le canvas** de
      // l'écran qui l'a demandé : le client ne porte pas la vérité de l'appartenance
      const update = db.prepare(
        `UPDATE canvas_items SET
           x = @x,
           y = @y,
           frame_id = CASE WHEN @has_frame = 1 THEN @frame_id ELSE frame_id END,
           updated_at = @updated_at
         WHERE item_kind = @kind AND item_ref = @ref AND canvas_id = @canvas_id`
      );
      const tx = db.transaction(() => {
        let moved = 0;
        for (const item of items) {
          moved += update.run({
            kind: item.kind,
            ref: item.ref,
            x: item.x,
            y: item.y,
            has_frame: item.frame_id === undefined ? 0 : 1,
            frame_id: item.frame_id ?? null,
            canvas_id: canvasId,
            updated_at: now,
          }).changes;
        }
        return moved;
      });
      return tx();
    },

    createFrame(f) {
      const id = randomUUID();
      const now = nowIso();
      const z =
        ((db.prepare("SELECT COALESCE(MAX(z), 0) AS z FROM canvas_frames").get() as {
          z: number;
        }).z ?? 0) + 1;
      db.prepare(
        `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, color, z, created_at, updated_at)
         VALUES (@id, @canvas_id, @label, @kind, @x, @y, @width, @height, @color, @z, @created_at, @updated_at)`
      ).run({
        id,
        // le cadre est posé dans l'écran qui l'a demandé : l'atelier chez lui,
        // le tableau focalisé chez lui (v1.6 §14.2)
        canvas_id: canvasId,
        label: f.label,
        kind: f.kind,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        color: f.color ?? null,
        z,
        created_at: now,
        updated_at: now,
      });
      return db.prepare("SELECT * FROM canvas_frames WHERE id = ?").get(id) as CanvasFrame;
    },

    updateFrame(id, patch) {
      const current = db.prepare("SELECT * FROM canvas_frames WHERE id = ?").get(id) as
        | CanvasFrame
        | undefined;
      if (!current) return null;
      const next = { ...current, ...patch };
      const dx = next.x - current.x;
      const dy = next.y - current.y;
      const moved = dx !== 0 || dy !== 0;

      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE canvas_frames SET label = @label, x = @x, y = @y, width = @width,
             height = @height, color = @color, z = @z, updated_at = @updated_at
           WHERE id = @id`
        ).run({ ...next, updated_at: nowIso() });
        let shifted = 0;
        if (moved) {
          // les membres suivent leur conteneur, dans la même transaction —
          // fichiers et Constructions confondus
          shifted = db
            .prepare(
              `UPDATE canvas_items SET x = x + @dx, y = y + @dy, updated_at = @updated_at
               WHERE frame_id = @id`
            )
            .run({ id, dx, dy, updated_at: nowIso() }).changes;
        }
        return shifted;
      });
      const shifted = tx();
      return {
        frame: db.prepare("SELECT * FROM canvas_frames WHERE id = ?").get(id) as CanvasFrame,
        shifted,
      };
    },

    dissolveFrame(id) {
      // `canvas_items.frame_id` est ON DELETE SET NULL : les éléments restent où
      // ils sont, ils perdent seulement leur appartenance
      return db.prepare("DELETE FROM canvas_frames WHERE id = ?").run(id).changes === 1;
    },

    assign(items, frameId) {
      if (items.length === 0) return 0;
      if (frameId !== null) {
        const frame = db.prepare("SELECT 1 FROM canvas_frames WHERE id = ?").get(frameId);
        if (!frame) return 0;
      }
      const now = nowIso();
      const update = db.prepare(
        `UPDATE canvas_items SET frame_id = @frame_id, updated_at = @updated_at
         WHERE item_kind = @kind AND item_ref = @ref`
      );
      const tx = db.transaction(() => {
        let updated = 0;
        for (const item of items) {
          updated += update.run({
            kind: item.kind,
            ref: item.ref,
            frame_id: frameId,
            updated_at: now,
          }).changes;
        }
        return updated;
      });
      return tx();
    },

    removeItems(kind, refs) {
      if (refs.length === 0) return 0;
      const placeholders = refs.map(() => "?").join(",");
      return db
        .prepare(
          `DELETE FROM canvas_items WHERE item_kind = ? AND item_ref IN (${placeholders})`
        )
        .run(kind, ...refs).changes;
    },
  };
}
