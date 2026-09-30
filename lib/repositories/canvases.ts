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

/**
 * Pourquoi un canvas n'a qu'**un** raison de refuser un parent (`cycle`) et pas
 * de raison « inconnu » : la clé étrangère (`parent_id REFERENCES canvases(id)`,
 * migration 012) refuse elle-même un parent qui n'existe pas — et `RESTRICT`
 * refuse aussi de supprimer un tableau qui a des enfants (on déplace d'abord).
 * Les erreurs FK restent des erreurs nommées ici (`SqliteError` → raison métier).
 */
export type SetParentFailure = {
  ok: false;
  reason: "cycle" | "atelier" | "not_found" | "parent_not_found" | "folder_sous_canvas";
};

/** Vrai si `candidate` est `ancestorId` ou vit sous lui (profondeur libre). */
function isWithinSubtree(db: Db, candidate: string, ancestorId: string): boolean {
  let current: string | null = candidate;
  const seen = new Set<string>([ancestorId]);
  while (current !== null) {
    if (current === ancestorId) return true;
    if (seen.has(current)) return false; // ne peut pas arriver (le dépôt refuse les cycles)
    seen.add(current);
    const row = db.prepare("SELECT parent_id FROM canvases WHERE id = ?").get(current) as
      | { parent_id: string | null }
      | undefined;
    current = row?.parent_id ?? null;
  }
  return false;
}

/**
 * **Un dossier est un conteneur pur** (v1.6.2) : ni frame, ni item, ni conversation
 * ne peut s'y poser — il range, il ne porte pas. Le dépôt du canvas et les liaisons
 * de conversations l'appellent avant toute écriture ; la garde est **ici** pour que
 * les deux dépôts ne puissent pas diverger sur ce qu'est un dossier.
 * Erreur nommée (`item_dans_dossier`, `frame_dans_dossier`,
 * `conversation_dans_dossier`) — jamais un silence.
 */
export function ensureNotFolder(db: Db, canvasId: string, what: "item" | "frame" | "conversation"): void {
  const row = db.prepare("SELECT kind, label FROM canvases WHERE id = ?").get(canvasId) as
    | { kind: CanvasKind; label: string }
    | undefined;
  if (!row) return; // l'inconnu reste l'affaire de l'appelant (FK ou 404 nommé)
  if (row.kind === "folder") {
    const reason =
      what === "item" ? "item_dans_dossier" : what === "frame" ? "frame_dans_dossier" : "conversation_dans_dossier";
    throw new Error(`canvases : « ${row.label} » est un dossier, on n'y pose pas de ${what} (${reason})`);
  }
}

/**
 * L'étiquette couleur : la palette fermée vit dans `lib/api-types` (source unique,
 * importable côté client sans dépendance serveur) — le dépôt ne la réimplémente pas,
 * il la **réexporte** pour que ses validateurs restent les siens.
 */
import { CANVAS_COLORS } from "@/lib/api-types";
export { CANVAS_COLORS };
export type CanvasColor = (typeof CANVAS_COLORS)[number] | null;

export const ATELIER_CANVAS_ID = "canvas-atelier";

/**
 * Les deux natures de la collection (v1.6.2, migration 013) : le **dossier** est
 * un conteneur pur (il range des canvas et des dossiers, il n'a pas de plan), le
 * **canvas** est la surface de travail (le plan, les conversations ancrées).
 * Même distinction qu'un répertoire et un document dans un explorateur de
 * fichiers — et les mêmes gardes : on ne « pose » rien dans un document.
 */
export const CANVAS_KINDS = ["canvas", "folder"] as const;
export type CanvasKind = (typeof CANVAS_KINDS)[number];

/** Le suffixe des refus de garde dossiers/canvases (`erreur_canvas_dans_dossier`…). */
export type FolderGuardReason =
  | "folder_sous_canvas"
  | "frame_dans_dossier"
  | "item_dans_dossier"
  | "conversation_dans_dossier";

export interface CanvasRow {
  id: string;
  label: string;
  color: string | null;
  is_default: number;
  pinned: number;
  position: number;
  /** Le tableau qui contient celui-ci (NULL = racine de l'explorateur). */
  parent_id: string | null;
  /** La nature (v1.6.2) : surface de travail (`canvas`) ou conteneur (`folder`). */
  kind: CanvasKind;
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
  /** La nature de ce qu'on crée (défaut : un canvas — l'usage majoritaire). */
  kind?: CanvasKind;
  /** Créer directement sous un dossier (l'arbre pose le bouton « + » au bon endroit). */
  parentId?: string | null;
}

export interface CanvasPatch {
  label?: string;
  color?: CanvasColor;
  pinned?: boolean;
  /** Déplacer le tableau (et tout ce qu'il contient) sous un dossier — ou à la racine (`null`). */
  parentId?: string | null;
}

export interface CanvasesRepo {
  /** L'atelier (créé par la migration 010, recréé ici s'il a été perdu). */
  getAtelier(): CanvasRow;
  getById(id: string): CanvasRow | null;
  /** La collection, dans l'ordre manuel (l'arbre de l'explorateur la lit). */
  list(): CanvasRow[];
  create(c: NewCanvas): CanvasRow;
  /**
   * Le seul patch qui peut **échouer nommément** : déplacer un tableau sous l'un
   * de ses descendants ferait un cycle (`reason: 'cycle'`), déplacer l'atelier le
   * ferait perdre sa place de réceptacle racine (`reason: 'atelier'`), déplacer
   * quoi que ce soit **sous un canvas** déposerait un conteneur dans une surface
   * (`reason: 'folder_sous_canvas'`), et un id ou un parent inconnu est nommé
   * (`not_found` / `parent_not_found`).
   */
  setParent(id: string, parentId: string | null): { ok: true; row: CanvasRow } | SetParentFailure;
  update(id: string, patch: CanvasPatch): CanvasRow | null;
  /** Nouvel ordre total des ids (les inconnus sont ignorés, les absents gardés au rang). */
  reorder(ids: string[]): number;
  /**
   * Supprime un tableau et **détache** : ses sous-tableaux remontent au parent
   * du supprimé (les enfants d'un dossier supprimé deviennent les enfants du
   * **grand-parent** — au niveau duquel ils étaient visibles — jamais éparpillés
   * à la racine ; un parent NULL reste NULL), frames réaffectées à l'atelier,
   * items de ces frames rendus « hors frame », liaisons de conversations retirées.
   * L'atelier lui-même est refusé (`reason: 'atelier'`). Renvoie ce qui a bougé,
   * pour que l'écran puisse **dire** ce qui survit (le dialogue l'annonce).
   */
  deleteById(id: string): { ok: true; detached: { frames: number; conversations: number; children: number } } | { ok: false; reason: "atelier" | "not_found" };
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
      const kind: CanvasKind = c.kind ?? "canvas";
      // **Ce qui se range va dans un conteneur** : un dossier ne vit jamais sous
      // un canvas (v1.6.2) — et un parent inconnu est une erreur nommée, pas un
      // 500 de FK. Un canvas, lui, se crée à la racine ou dans un dossier.
      if (c.parentId) {
        const parent = db.prepare("SELECT id, kind FROM canvases WHERE id = ?").get(c.parentId) as
          | { id: string; kind: CanvasKind }
          | undefined;
        if (!parent) throw new Error("canvases : parent inconnu");
        if (kind === "folder" && parent.kind !== "folder") {
          throw new Error("canvases : un dossier ne peut pas vivre sous un canvas (folder_sous_canvas)");
        }
      }
      const now = nowIso();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO canvases (id, label, color, is_default, pinned, position, parent_id, kind, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM canvases), ?, ?, ?, ?)`
      ).run(id, label, c.color ?? null, c.pinned === true ? 1 : 0, c.parentId ?? null, kind, now, now);
      return db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as CanvasRow;
    },

    setParent(id, parentId) {
      const canvas = db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as
        | CanvasRow
        | undefined;
      if (!canvas) return { ok: false, reason: "not_found" };
      // l'atelier reste le réceptacle **racine** : le déplacer sous un tableau
      // rendrait la règle de détachement ambiguë (même raisonnement que l'index
      // unique de la 010 qui interdit un second atelier)
      if (canvas.is_default === 1 && parentId !== null) return { ok: false, reason: "atelier" };
      if (parentId !== null) {
        const parent = db.prepare("SELECT id, kind FROM canvases WHERE id = ?").get(parentId) as
          | { id: string; kind: CanvasKind }
          | undefined;
        if (!parent) return { ok: false, reason: "parent_not_found" };
        // **ce qui se range va dans un conteneur** : un dossier sous un canvas
        // déposerait un conteneur dans une surface — refus nommé (v1.6.2)
        if (canvas.kind === "folder" && parent.kind !== "folder") {
          return { ok: false, reason: "folder_sous_canvas" };
        }
        // un tableau ne peut pas vivre sous lui-même ni sous l'un de ses
        // descendants : le graphe resterait un arbre, jamais un cycle
        if (parentId === id || isWithinSubtree(db, parentId, id)) {
          return { ok: false, reason: "cycle" };
        }
      }
      db.prepare("UPDATE canvases SET parent_id = ?, updated_at = ? WHERE id = ?").run(
        parentId,
        nowIso(),
        id
      );
      return { ok: true, row: db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as CanvasRow };
    },

    update(id, patch) {
      const current = db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as
        | CanvasRow
        | undefined;
      if (!current) return null;
      // le déplacement passe par `setParent` (gardes de cycle) : `update` ne
      // trahit jamais son contrat « renommer/colorier/épingler » avec un effet
      // de structure silencieux
      if (patch.parentId !== undefined && patch.parentId !== current.parent_id) {
        const moved = this.setParent(id, patch.parentId);
        if (!moved.ok) throw new Error(`canvases : déplacement refusé (${moved.reason})`);
        if (patch.label === undefined && patch.color === undefined && patch.pinned === undefined) {
          return moved.row;
        }
      }
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
        //    dissolution, §14.5 AC1). Depuis la 011, un item porte **son** canvas :
        //    il reste au tableau supprimé... qui disparaît — l'atelier est le seul
        //    réceptacle pour ces orphelins (§14.2 : « l'atelier a un hors canvas »).
        const frames = db
          .prepare("DELETE FROM canvas_frames WHERE canvas_id = ?")
          .run(id).changes;
        // 1bis. les items **hors frame** du tableau condamné sont relogés chez
        //    l'atelier (le réceptacle) : un item ne peut pas survivre à un canvas
        //    absent (FK NOT NULL de la 011) — positions intactes, aucun objet
        //    n'est détruit (§14.5 AC1).
        db.prepare(
          "UPDATE canvas_items SET canvas_id = 'canvas-atelier', updated_at = ? WHERE canvas_id = ? AND frame_id IS NULL"
        ).run(nowIso(), id);
        // 2. les liaisons de conversations partent avec le tableau (CASCADE de la
        //    010, explicite ici pour les compter) : les conversations restent,
        //    hors tableau (§14.5 AC4)
        const conversations = db
          .prepare("DELETE FROM conversation_canvases WHERE canvas_id = ?")
          .run(id).changes;
        // 3. les **sous-tableaux** remontent au parent du supprimé (v1.6.1) : ce
        //    qui était visible à son niveau reste visible au même endroit — la
        //    suppression d'un dossier ne renverse jamais l'arbre. L'atelier reste
        //    le réceptacle par défaut : un enfant d'un tableau racine repasse
        //    racine lui-même (parent NULL), conformément à « NULL = racine ».
        const children = db
          .prepare(
            `UPDATE canvases SET parent_id =
               (SELECT parent_id FROM canvases WHERE id = ?),
               updated_at = ?
             WHERE parent_id = ?`
          )
          .run(id, nowIso(), id).changes;
        db.prepare("DELETE FROM canvases WHERE id = ?").run(id);
        return { frames, conversations, children };
      });
      return { ok: true, detached: tx() };
    },

    counts(id) {
      const canvas = db.prepare("SELECT 1 AS ok FROM canvases WHERE id = ?").get(id);
      if (!canvas) return { frames: 0, constructions: 0, sources: 0, conversations: 0 };
      // depuis la 011, un item porte **son** canvas (`canvas_items.canvas_id`) :
      // l'appartenance ne se déduit plus de la frame ni du réceptacle
      const frames = (db.prepare("SELECT COUNT(*) AS n FROM canvas_frames WHERE canvas_id = ?").get(id) as { n: number }).n;
      const constructions = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM canvas_items WHERE canvas_id = ? AND item_kind = 'construction'"
          )
          .get(id) as { n: number }
      ).n;
      const sources = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM canvas_items WHERE canvas_id = ? AND item_kind = 'source'"
          )
          .get(id) as { n: number }
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
