import { randomUUID } from "node:crypto";
import { nowIso, type Db } from "@/lib/db/client";

/**
 * Les tableaux (v1.6, amendement §14, migration 010).
 *
 * Il n'y avait qu'**un seul** espace de plan — l'atelier (migrations 006/007).
 * L'explorateur en fait une **collection** : chaque canvas est un « tableau »
 * que l'on parcourt, étiquette, épingle, supprime. Trois règles y survivent :
 *
 *  1. **L'atelier est le réceptacle.** `is_default = 1` est unique (index partiel
 *     en base) et non supprimable côté dépôt : supprimer un canvas y renvoie ses
 *     frames (réaffectées), et les items rangés dans ces frames repassent « hors
 *     frame » (`frame_id` NULL — le `ON DELETE SET NULL` existant). Une
 *     Construction n'est **jamais** supprimée par la suppression d'un tableau.
 *  2. **La collection est totale, en une transaction.** Créer, renommer,
 *     colorier, épingler, réordonner, supprimer : tout ce que l'écran propose est
 *     ici, et rien d'autre n'écrit dans `canvases`.
 *  3. **L'ordre est un entier**, pas une liste : `position` se réécrit en bloc
 *     (`reorder`) — glisser un tableau dans l'arbre n'est pas un diff, c'est un
 *     nouvel ordre total.
 */

/** Longueur maximale d'un label de tableau (même règle que les frames). */
export const MAX_CANVAS_LABEL = 120;

/** L'étiquette couleur, validée côté dépôt (la palette fermée est un choix d'écran). */
export const CANVAS_COLORS = [
  "red",
  "amber",
  "green",
  "cyan",
  "blue",
  "violet",
] as const;
export type CanvasColor = (typeof CANVAS_COLORS)[number] | null;

export const ATELIER_CANVAS_ID = "canvas-atelier";

export interface CanvasRow {
  id: string;
  label: string;
  color: string | null;
  is_default: number;
  pinned: number;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CanvasCounts {
  frames: number;
  constructions: number;
  sources: number;
  conversations: number;
}

export interface NewCanvas {
  label: string;
  color?: CanvasColor;
  pinned?: boolean;
}

export interface CanvasPatch {
  label?: string;
  color?: CanvasColor;
  pinned?: boolean;
}

export interface CanvasesRepo {
  /** L'atelier (créé par la migration 010, recréé ici s'il a été perdu). */
  getAtelier(): CanvasRow;
  getById(id: string): CanvasRow | null;
  /** La collection, dans l'ordre manuel (l'arbre de l'explorateur la lit). */
  list(): CanvasRow[];
  create(c: NewCanvas): CanvasRow;
  update(id: string, patch: CanvasPatch): CanvasRow | null;
  /** Nouvel ordre total des ids (les inconnus sont ignorés, les absents gardés au rang). */
  reorder(ids: string[]): number;
  /**
   * Supprime un tableau et **détache** : frames réaffectées à l'atelier, items
   * de ces frames rendus « hors frame », liaisons de conversations retirées.
   * L'atelier lui-même est refusé (`reason: 'atelier'`). Renvoie ce qui a bougé,
   * pour que l'écran puisse **dire** ce qui survit (le dialogue l'annonce).
   */
  deleteById(id: string): { ok: true; detached: { frames: number; conversations: number } } | { ok: false; reason: "atelier" | "not_found" };
  counts(id: string): CanvasCounts;
}

/**
 * L'activité récente est **dérivée** (§14.3 : aucune écriture supplémentaire) :
 * le dernier toucher d'un tableau est `MAX(updated_at du canvas, updated_at des
 * conversations liées)` — poser une construction, lier une conversation, renommer.
 *
 * Limite assumée, à porter à l'étape écran : les **synthèses** ne sont liées à
 * aucun canvas (elles vivent dans les thèmes), donc elles ne peuvent pas entrer
 * dans la récence *par tableau* ; le §14.3 les cite pour le flux global, qui est
 * de l'affichage — pas une règle de tri ici.
 */
export function recentCanvasIds(db: Db, limit = 8): string[] {
  const rows = db
    .prepare(
      `SELECT cv.id FROM canvases cv
       LEFT JOIN conversation_canvases cc ON cc.canvas_id = cv.id
       LEFT JOIN conversations co ON co.id = cc.conversation_id
       GROUP BY cv.id
       ORDER BY MAX(MAX(cv.updated_at, COALESCE(co.updated_at, ''))) DESC,
                cv.position ASC, cv.rowid ASC
       LIMIT ?`
    )
    .all(limit) as { id: string }[];
  return rows.map((r) => r.id);
}

export function createCanvasesRepo(db: Db): CanvasesRepo {
  /** L'atelier existe par la migration ; recréé ici s'il manque (base antérieure). */
  const ensureAtelier = (): CanvasRow => {
    const existing = db
      .prepare("SELECT * FROM canvases WHERE is_default = 1")
      .get() as CanvasRow | undefined;
    if (existing) return existing;
    const now = nowIso();
    db.prepare(
      `INSERT INTO canvases (id, label, color, is_default, pinned, position, created_at, updated_at)
       VALUES (?, 'Atelier', NULL, 1, 1, 0, ?, ?)`
    ).run(ATELIER_CANVAS_ID, now, now);
    return db.prepare("SELECT * FROM canvases WHERE id = ?").get(ATELIER_CANVAS_ID) as CanvasRow;
  };

  return {
    getAtelier: ensureAtelier,

    getById(id) {
      return (db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as CanvasRow | undefined) ?? null;
    },

    list() {
      ensureAtelier();
      return db
        .prepare(
          `SELECT * FROM canvases
           ORDER BY pinned DESC, position ASC, created_at ASC, rowid ASC`
        )
        .all() as CanvasRow[];
    },

    create(c) {
      const label = c.label.trim();
      if (!label) throw new Error("canvases : le label est requis");
      if (label.length > MAX_CANVAS_LABEL) {
        throw new Error(`canvases : label trop long (max ${MAX_CANVAS_LABEL})`);
      }
      const now = nowIso();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO canvases (id, label, color, is_default, pinned, position, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM canvases), ?, ?)`
      ).run(id, label, c.color ?? null, c.pinned === true ? 1 : 0, now, now);
      return db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as CanvasRow;
    },

    update(id, patch) {
      const current = db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as
        | CanvasRow
        | undefined;
      if (!current) return null;
      if (patch.label !== undefined) {
        const label = patch.label.trim();
        if (!label) throw new Error("canvases : le label ne peut pas être vide");
        if (label.length > MAX_CANVAS_LABEL) {
          throw new Error(`canvases : label trop long (max ${MAX_CANVAS_LABEL})`);
        }
      }
      const next = {
        label: patch.label !== undefined ? patch.label.trim() : current.label,
        color: patch.color !== undefined ? patch.color : current.color,
        pinned: patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : current.pinned,
      };
      db.prepare(
        `UPDATE canvases SET label = @label, color = @color, pinned = @pinned, updated_at = @updated_at
         WHERE id = @id`
      ).run({ id, ...next, updated_at: nowIso() });
      return db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as CanvasRow;
    },

    reorder(ids) {
      const now = nowIso();
      const tx = db.transaction(() => {
        // ordre total : les ids connus prennent leur rang, les absents suivent
        const known = db
          .prepare("SELECT id FROM canvases ORDER BY position ASC, rowid ASC")
          .all() as { id: string }[];
        const knownIds = known.map((r) => r.id);
        const head = ids.filter((id) => knownIds.includes(id));
        const tail = knownIds.filter((id) => !ids.includes(id));
        let pos = 0;
        const update = db.prepare("UPDATE canvases SET position = ?, updated_at = ? WHERE id = ?");
        for (const id of [...head, ...tail]) update.run(pos++, now, id);
        return head.length + tail.length;
      });
      return tx();
    },

    deleteById(id) {
      const canvas = db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as
        | CanvasRow
        | undefined;
      if (!canvas) return { ok: false, reason: "not_found" };
      if (canvas.is_default === 1) return { ok: false, reason: "atelier" };

      const tx = db.transaction(() => {
        // 1. les frames du tableau sont **dissoutes avec lui** — une région sans
        //    son tableau n'a pas de sens, et l'atelier ne doit pas hériter de
        //    coquilles vides. Le `ON DELETE SET NULL` de `canvas_items.frame_id`
        //    fait le reste : les objets rangés dedans repassent « hors frame »,
        //    **leurs positions ne bougent pas** (sémantique existante d'une
        //    dissolution, §14.5 AC1 : l'atelier les montre, récupérables).
        const frames = db
          .prepare("DELETE FROM canvas_frames WHERE canvas_id = ?")
          .run(id).changes;
        // 2. les liaisons de conversations partent avec le tableau (CASCADE de la
        //    010, explicite ici pour les compter) : les conversations restent,
        //    hors tableau (§14.5 AC4)
        const conversations = db
          .prepare("DELETE FROM conversation_canvases WHERE canvas_id = ?")
          .run(id).changes;
        db.prepare("DELETE FROM canvases WHERE id = ?").run(id);
        return { frames, conversations };
      });
      return { ok: true, detached: tx() };
    },

    counts(id) {
      const canvas = db.prepare("SELECT is_default FROM canvases WHERE id = ?").get(id) as
        | { is_default: number }
        | undefined;
      if (!canvas) return { frames: 0, constructions: 0, sources: 0, conversations: 0 };
      // l'appartenance d'un item se lit **par sa frame** — sauf « hors frame »,
      // qui appartient à l'atelier (le réceptacle, §14.2)
      const horsFrame = canvas.is_default === 1 ? "OR ci.frame_id IS NULL" : "";
      const frames = (db.prepare("SELECT COUNT(*) AS n FROM canvas_frames WHERE canvas_id = ?").get(id) as { n: number }).n;
      const constructions = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM canvas_items ci
             LEFT JOIN canvas_frames f ON f.id = ci.frame_id
             WHERE (f.canvas_id = @id ${horsFrame}) AND ci.item_kind = 'construction'`
          )
          .get({ id }) as { n: number }
      ).n;
      const sources = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM canvas_items ci
             LEFT JOIN canvas_frames f ON f.id = ci.frame_id
             WHERE (f.canvas_id = @id ${horsFrame}) AND ci.item_kind = 'source'`
          )
          .get({ id }) as { n: number }
      ).n;
      const conversations = (
        db
          .prepare("SELECT COUNT(*) AS n FROM conversation_canvases WHERE canvas_id = ?")
          .get(id) as { n: number }
      ).n;
      return { frames, constructions, sources, conversations };
    },
  };
}
