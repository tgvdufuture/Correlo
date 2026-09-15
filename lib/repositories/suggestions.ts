import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import type { EpistemicStatus } from "@/lib/discover/epistemic";

export type RelationType = "analogy" | "contradiction" | "cause";
export type SuggestionTier = "strong" | "medium" | "weak";
export type SuggestionState = "discovered" | "shown" | "opened" | "accepted" | "rejected";

export interface SuggestionRow {
  id: string;
  claim: string;
  relation_type: RelationType;
  tier: SuggestionTier;
  state: SuggestionState;
  fragment_a_id: string;
  fragment_b_id: string;
  pair_key: string;
  content_sig: string;
  epistemic_status: EpistemicStatus;
  prompt_version: string;
  chat_model: string;
  feedback_reason: string | null;
}

export interface NewSuggestion {
  claim: string;
  relation_type: RelationType;
  tier: SuggestionTier;
  fragment_a_id: string;
  fragment_b_id: string;
  pair_key: string;
  content_sig: string;
  epistemic_status: EpistemicStatus;
  prompt_version: string;
  chat_model: string;
}

export type CreateResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: "fragment_missing" | "intra_source" | "blocked_variant" | "duplicate";
      /**
       * `duplicate` uniquement : id de la suggestion **identique** déjà en base
       * (même pair_key, même relation_type, même content_sig). Rejouer un run
       * retombe sur ces lignes : c'est la preuve que le run reproduit sa propre
       * sortie (Phase 2B, AC1) et non un échec d'insertion.
       */
      existingId?: string;
    };

export interface SuggestionsRepo {
  create(s: NewSuggestion): CreateResult;
  /** Une suggestion accepted/rejected sur (pair_key, relation_type) bloque les variantes. */
  isVariantBlocked(pairKey: string, relationType: RelationType): boolean;
  listByIds(ids: string[]): SuggestionRow[];
  listAll(limit?: number): SuggestionRow[];
  countByState(): Record<SuggestionState, number>;
}

export function createSuggestionsRepo(db: Db): SuggestionsRepo {
  return {
    create(s: NewSuggestion): CreateResult {
      // fragments existants + paire intra-source interdite (0 ID inventé, §3.2)
      const frags = db
        .prepare(
          `SELECT f.id, f.source_id FROM fragments f
           WHERE f.id IN (?, ?) ORDER BY CASE f.id WHEN ? THEN 0 ELSE 1 END`
        )
        .all(s.fragment_a_id, s.fragment_b_id, s.fragment_a_id) as {
        id: string;
        source_id: string;
      }[];
      if (frags.length !== 2) return { ok: false, reason: "fragment_missing" };
      if (frags[0].source_id === frags[1].source_id) return { ok: false, reason: "intra_source" };

      // variantes bloquées : accepted/rejected sur (pair_key, relation_type)
      const blocked = db
        .prepare(
          `SELECT 1 FROM suggestions
           WHERE pair_key = ? AND relation_type = ? AND state IN ('accepted', 'rejected')
           LIMIT 1`
        )
        .get(s.pair_key, s.relation_type);
      if (blocked) return { ok: false, reason: "blocked_variant" };

      const id = randomUUID();
      try {
        db.prepare(
          `INSERT INTO suggestions (id, claim, relation_type, tier, state,
             fragment_a_id, fragment_b_id, pair_key, content_sig, epistemic_status,
             prompt_version, chat_model)
           VALUES (@id, @claim, @relation_type, @tier, 'discovered',
             @fragment_a_id, @fragment_b_id, @pair_key, @content_sig, @epistemic_status,
             @prompt_version, @chat_model)`
        ).run({ id, ...s });
        return { ok: true, id };
      } catch {
        // UNIQUE(pair_key, relation_type, content_sig) — variante identique déjà
        // présente : on renvoie son id (un rejeu doit pouvoir la reconnaître)
        const existing = db
          .prepare(
            `SELECT id FROM suggestions
             WHERE pair_key = ? AND relation_type = ? AND content_sig = ?`
          )
          .get(s.pair_key, s.relation_type, s.content_sig) as { id: string } | undefined;
        return { ok: false, reason: "duplicate", existingId: existing?.id };
      }
    },

    isVariantBlocked(pairKey, relationType) {
      return !!db
        .prepare(
          `SELECT 1 FROM suggestions
           WHERE pair_key = ? AND relation_type = ? AND state IN ('accepted', 'rejected')
           LIMIT 1`
        )
        .get(pairKey, relationType);
    },

    listByIds(ids) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      return db
        .prepare(`SELECT * FROM suggestions WHERE id IN (${placeholders})`)
        .all(...ids) as SuggestionRow[];
    },

    listAll(limit = 500) {
      return db
        .prepare("SELECT * FROM suggestions ORDER BY rowid DESC LIMIT ?")
        .all(limit) as SuggestionRow[];
    },

    countByState() {
      const rows = db
        .prepare("SELECT state, COUNT(*) AS c FROM suggestions GROUP BY state")
        .all() as { state: SuggestionState; c: number }[];
      const out = { discovered: 0, shown: 0, opened: 0, accepted: 0, rejected: 0 };
      for (const r of rows) out[r.state] = r.c;
      return out;
    },
  };
}