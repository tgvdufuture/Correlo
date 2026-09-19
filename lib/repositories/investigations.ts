import type { Db } from "@/lib/db/client";
import { nowIso } from "@/lib/db/client";
import type { InvestigationDocument, InvestigationStatus } from "@/lib/agent/types";

/**
 * Table `investigations` (v1.2 §3.3, **schéma verrouillé**) :
 * `id, suggestion_id FK ON DELETE CASCADE, status, steps, created_at, updated_at`.
 *
 * Conséquence assumée du verrouillage : il n'y a pas de `created_at` par passe ni de
 * colonne de métadonnées — le document JSON de `steps` porte tout (cf.
 * `lib/agent/types.ts`). L'`id` est celui du **job** (`jobs.id`) : une investigation
 * appartient à une question, et un rejeu du même job met à jour *sa* ligne au lieu
 * d'en créer une seconde. C'est ce qui rend « relancer une investigation » idempotent
 * sans avoir à stocker un `job_id` (colonne inexistante).
 */
export interface InvestigationRow {
  id: string;
  suggestion_id: string;
  status: InvestigationStatus;
  steps: string;
  created_at: string;
  updated_at: string;
}

export interface InvestigationsRepo {
  /** INSERT … ON CONFLICT(id) : la ligne d'une investigation rejouée est mise à jour. */
  upsert(input: {
    id: string;
    suggestionId: string;
    status: InvestigationStatus;
    document: InvestigationDocument;
  }): void;
  getById(id: string): InvestigationRow | null;
  /** Dernière investigation d'une suggestion (la plus récemment mise à jour). */
  latestBySuggestion(suggestionId: string): InvestigationRow | null;
}

export function createInvestigationsRepo(db: Db): InvestigationsRepo {
  return {
    upsert({ id, suggestionId, status, document }) {
      const now = nowIso();
      db.prepare(
        `INSERT INTO investigations (id, suggestion_id, status, steps, created_at, updated_at)
         VALUES (@id, @suggestion_id, @status, @steps, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           suggestion_id = excluded.suggestion_id,
           status = excluded.status,
           steps = excluded.steps,
           updated_at = excluded.updated_at`
      ).run({
        id,
        suggestion_id: suggestionId,
        status,
        steps: JSON.stringify(document),
        now,
      });
    },

    getById(id) {
      return (
        (db.prepare("SELECT * FROM investigations WHERE id = ?").get(id) as
          | InvestigationRow
          | undefined) ?? null
      );
    },

    latestBySuggestion(suggestionId) {
      return (
        (db
          .prepare(
            `SELECT * FROM investigations WHERE suggestion_id = ?
             ORDER BY updated_at DESC, rowid DESC LIMIT 1`
          )
          .get(suggestionId) as InvestigationRow | undefined) ?? null
      );
    },
  };
}
