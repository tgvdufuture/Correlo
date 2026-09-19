import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import type { EpistemicStatus } from "@/lib/discover/epistemic";

/**
 * Une entrée de `provenance_snapshot` (US-08 AC1) : copie **au moment de
 * l'acceptation** de tout ce qui rend la Construction vérifiable même après
 * disparition de la source. C'est cette copie — et non une jointure — qui est
 * affichée, sinon la provenance mourrait avec ses fragments (CASCADE).
 */
export interface ProvenanceEntry {
  source_id: string;
  source_title: string | null;
  source_content_hash: string;
  fragment_id: string;
  fragment_text: string;
  locator: string;
}

/** Ligne brute (JSON en TEXT) telle que stockée. */
export interface ConstructionRow {
  id: string;
  text: string;
  epistemic_status: EpistemicStatus;
  parent_source_ids: string;
  evidence_fragment_ids: string;
  suggestion_id: string | null;
  depth: number;
  stale: 0 | 1;
  provenance_snapshot: string;
}

/** Vue lisible : JSON décodé, prête pour l'API et l'affichage. */
export interface ConstructionView {
  id: string;
  text: string;
  epistemic_status: EpistemicStatus;
  parent_source_ids: string[];
  evidence_fragment_ids: string[];
  suggestion_id: string | null;
  depth: number;
  stale: boolean;
  provenance_snapshot: ProvenanceEntry[];
}

export interface NewConstruction {
  text: string;
  epistemic_status: EpistemicStatus;
  parentSourceIds: string[];
  evidenceFragmentIds: string[];
  suggestionId: string;
  snapshot: ProvenanceEntry[];
}

export type CreateConstructionResult =
  | { ok: true; construction: ConstructionView }
  /** `suggestion_id` est UNIQUE : une suggestion ne s'intègre qu'une fois (US-07 AC3). */
  | { ok: false; reason: "already_integrated" };

export interface ConstructionsRepo {
  create(c: NewConstruction): CreateConstructionResult;
  list(): ConstructionView[];
  getById(id: string): ConstructionView | null;
  getBySuggestion(suggestionId: string): ConstructionView | null;
  /**
   * US-08 AC2 / AC3 : passe `stale = 1` aux Constructions dont le
   * `provenance_snapshot` cite la source, et renvoie le nombre touché. Appelée
   * avant la suppression (CASCADE) comme après une ré-ingestion. Le snapshot
   * n'est jamais modifié : il reste affichable.
   */
  markStaleForSource(sourceId: string): number;
}

/**
 * Décodage d'une ligne brute vers la vue lisible (JSON → tableaux).
 * Exporté pour être **la** fonction de décodage : le dépôt du canvas relit des
 * `constructions` jointes à `canvas_nodes` et doit produire exactement la même
 * forme, sinon deux représentations de la même ligne divergeraient.
 */
export function decodeConstruction(row: ConstructionRow): ConstructionView {
  return {
    id: row.id,
    text: row.text,
    epistemic_status: row.epistemic_status,
    parent_source_ids: JSON.parse(row.parent_source_ids) as string[],
    evidence_fragment_ids: JSON.parse(row.evidence_fragment_ids) as string[],
    suggestion_id: row.suggestion_id,
    depth: row.depth,
    stale: row.stale === 1,
    provenance_snapshot: JSON.parse(row.provenance_snapshot) as ProvenanceEntry[],
  };
}

export function createConstructionsRepo(db: Db): ConstructionsRepo {
  return {
    create(c: NewConstruction): CreateConstructionResult {
      const id = randomUUID();
      try {
        db.prepare(
          `INSERT INTO constructions (id, text, epistemic_status, parent_source_ids,
             evidence_fragment_ids, suggestion_id, depth, stale, provenance_snapshot)
           VALUES (@id, @text, @epistemic_status, @parent_source_ids, @evidence_fragment_ids,
             @suggestion_id, 1, 0, @provenance_snapshot)`
        ).run({
          id,
          text: c.text,
          epistemic_status: c.epistemic_status,
          // depth = 1 est aussi contraint en base (CHECK) — non-goal §1.3
          parent_source_ids: JSON.stringify(c.parentSourceIds),
          evidence_fragment_ids: JSON.stringify(c.evidenceFragmentIds),
          suggestion_id: c.suggestionId,
          provenance_snapshot: JSON.stringify(c.snapshot),
        });
      } catch {
        return { ok: false, reason: "already_integrated" };
      }
      const created = db.prepare("SELECT * FROM constructions WHERE id = ?").get(id) as
        | ConstructionRow
        | undefined;
      // impossible : l'insertion vient de réussir
      if (!created) throw new Error("construction introuvable après insertion");
      return { ok: true, construction: decodeConstruction(created) };
    },

    list() {
      return (
        db
          .prepare("SELECT * FROM constructions ORDER BY rowid DESC")
          .all() as ConstructionRow[]
      ).map(decodeConstruction);
    },

    getById(id) {
      const row = db.prepare("SELECT * FROM constructions WHERE id = ?").get(id) as
        | ConstructionRow
        | undefined;
      return row ? decodeConstruction(row) : null;
    },

    getBySuggestion(suggestionId) {
      const row = db
        .prepare("SELECT * FROM constructions WHERE suggestion_id = ?")
        .get(suggestionId) as ConstructionRow | undefined;
      return row ? decodeConstruction(row) : null;
    },

    markStaleForSource(sourceId) {
      return db
        .prepare(
          `UPDATE constructions SET stale = 1
           WHERE stale = 0 AND EXISTS (
             SELECT 1 FROM json_each(constructions.provenance_snapshot) je
             WHERE json_extract(je.value, '$.source_id') = ?
           )`
        )
        .run(sourceId).changes;
    },
  };
}
