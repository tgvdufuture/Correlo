import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import type { EpistemicStatus } from "@/lib/discover/epistemic";

export type RelationType = "analogy" | "contradiction" | "cause";
export type SuggestionTier = "strong" | "medium" | "weak";
export type SuggestionState = "discovered" | "shown" | "opened" | "accepted" | "rejected";
/** Raisons de rejet (US-06 AC1) — exactement une, hors de cette liste → 400. */
export const FEEDBACK_REASONS = ["trivial", "false", "already_known", "off_topic"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export function isFeedbackReason(v: unknown): v is FeedbackReason {
  return typeof v === "string" && (FEEDBACK_REASONS as readonly string[]).includes(v);
}

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

/** Fragment cité par une suggestion, avec de quoi l'afficher (US-05 AC1). */
export interface FeedFragment {
  id: string;
  source_id: string;
  source_title: string | null;
  chunk_index: number;
  locator: string;
  text: string;
}

/** Ligne de feed : la suggestion retenue + ses 2 fragments cliquables. */
export interface FeedItem extends SuggestionRow {
  fragments: FeedFragment[];
}

export interface FeedOptions {
  /**
   * `open` (défaut) = tout sauf accepted/rejected : c'est ce que le feed expose.
   * Une valeur d'état filtre explicitement (ex. revoir les rejetées).
   */
  state?: SuggestionState | "open";
  /** Plafond de suggestions retournées (le feed est trié : les meilleures d'abord). */
  limit?: number;
}

export interface SuggestionsRepo {
  create(s: NewSuggestion): CreateResult;
  getById(id: string): SuggestionRow | null;
  /** Une suggestion accepted/rejected sur (pair_key, relation_type) bloque les variantes. */
  isVariantBlocked(pairKey: string, relationType: RelationType): boolean;
  /**
   * Feed (AC1, §3.2) : **une seule suggestion par (pair_key, relation_type)** —
   * tier le plus élevé, tie-break la plus récente. Les fragments sont joints pour
   * l'affichage (claim, relation, tier, statut, ≥ 2 fragments).
   */
  listFeed(opts?: FeedOptions): FeedItem[];
  /**
   * Exposition (`discovered` → `shown`) des suggestions réellement servies par le
   * feed. Utilisée par la route GET ; sans elle la métrique « ≥ 40 % ouvertes »
   * serait inexploitable (`shown`/`opened` n'étaient jamais posés).
   */
  markExposed(ids: string[]): number;
  /** Ouverture du détail (`discovered|shown` → `opened`). Jamais de retour en arrière. */
  markOpened(id: string): boolean;
  /**
   * Décision de l'utilisateur sur une suggestion, appliquée à **toutes** les
   * variantes de (pair_key, relation_type) : c'est ce qui rend « 0 rejetée ne
   * réapparaît, y compris sous une reformulation » vrai au niveau de la paire
   * (§3.2 blocage de variantes) et non de la seule ligne décidée.
   */
  decide(
    id: string,
    decision: { state: "accepted" } | { state: "rejected"; reason: FeedbackReason }
  ): number;
  listByIds(ids: string[]): SuggestionRow[];
  listAll(limit?: number): SuggestionRow[];
  countByState(): Record<SuggestionState, number>;
}

/**
 * Ordre d'exposition des tiers : strong > medium > weak (§3.2).
 * `suggestions` n'a pas de `created_at` (§3.3 verrouillé) : la récence du
 * tie-break est donc l'ordre d'insertion (`rowid`), la convention déjà utilisée
 * par `listAll`.
 */
const TIER_ORDER =
  "CASE s.tier WHEN 'strong' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";

/** Représentante d'une paire : tier le plus élevé, tie-break la plus récente. */
const FEED_REPRESENTATIVE = `
  SELECT s.* FROM suggestions s
  WHERE s.rowid = (
    SELECT s2.rowid FROM suggestions s2
    WHERE s2.pair_key = s.pair_key AND s2.relation_type = s.relation_type
    ORDER BY CASE s2.tier WHEN 'strong' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             s2.rowid DESC
    LIMIT 1
  )
`;

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

    getById(id) {
      return (
        (db.prepare("SELECT * FROM suggestions WHERE id = ?").get(id) as
          | SuggestionRow
          | undefined) ?? null
      );
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

    listFeed(opts = {}) {
      const state = opts.state ?? "open";
      const limit = opts.limit ?? 200;
      const where =
        state === "open" ? "s.state NOT IN ('accepted', 'rejected')" : "s.state = @state";
      const rows = db
        .prepare(
          `${FEED_REPRESENTATIVE}
           AND ${where}
           ORDER BY ${TIER_ORDER}, s.rowid DESC
           LIMIT @limit`
        )
        .all(state === "open" ? { limit } : { state, limit }) as SuggestionRow[];
      if (rows.length === 0) return [];

      // fragments des 2 côtés, en une requête (jointure sources pour le titre)
      const ids = [...new Set(rows.flatMap((r) => [r.fragment_a_id, r.fragment_b_id]))];
      const placeholders = ids.map(() => "?").join(",");
      const frags = db
        .prepare(
          `SELECT f.id, f.source_id, s.title AS source_title, f.chunk_index, f.locator, f.text
           FROM fragments f LEFT JOIN sources s ON s.id = f.source_id
           WHERE f.id IN (${placeholders})`
        )
        .all(...ids) as FeedFragment[];
      const byId = new Map(frags.map((f) => [f.id, f]));
      return rows.map((r) => ({
        ...r,
        fragments: [byId.get(r.fragment_a_id), byId.get(r.fragment_b_id)].filter(
          (f): f is FeedFragment => !!f
        ),
      }));
    },

    markExposed(ids) {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      return db
        .prepare(
          `UPDATE suggestions SET state = 'shown'
           WHERE state = 'discovered' AND id IN (${placeholders})`
        )
        .run(...ids).changes;
    },

    markOpened(id) {
      return (
        db
          .prepare(
            `UPDATE suggestions SET state = 'opened'
             WHERE id = ? AND state IN ('discovered', 'shown')`
          )
          .run(id).changes === 1
      );
    },

    decide(id, decision) {
      // La décision porte sur la paire, pas sur la ligne : toutes les variantes
      // de (pair_key, relation_type) basculent ensemble (§3.2).
      const target = db
        .prepare("SELECT pair_key, relation_type FROM suggestions WHERE id = ?")
        .get(id) as { pair_key: string; relation_type: RelationType } | undefined;
      if (!target) return 0;
      const patch =
        decision.state === "accepted"
          ? { state: "accepted" as const, feedback_reason: null }
          : { state: "rejected" as const, feedback_reason: decision.reason };
      return db
        .prepare(
          `UPDATE suggestions SET state = @state, feedback_reason = @feedback_reason
           WHERE pair_key = @pair_key AND relation_type = @relation_type`
        )
        .run({ ...patch, pair_key: target.pair_key, relation_type: target.relation_type }).changes;
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
