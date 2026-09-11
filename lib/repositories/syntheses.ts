import { randomUUID } from "node:crypto";
import { nowIso, type Db } from "@/lib/db/client";

export type SynthesisRelationKind = "combination" | "extension" | "tension" | "application";
export type SynthesisConfidence = "low" | "medium" | "high";
export type SynthesisState = "proposed" | "accepted" | "rejected";
/** Jamais FACT : une synthèse dit par construction plus qu'une preuve isolée (PRD v1.3). */
export type SynthesisEpistemicStatus = "INFERENCE" | "HYPOTHESIS" | "SPECULATION";

export interface SynthesisRow {
  id: string;
  text: string;
  theme_id: string;
  relation_kind: SynthesisRelationKind;
  epistemic_status: SynthesisEpistemicStatus;
  parent_source_ids: string;
  evidence_fragment_ids: string;
  provenance_snapshot: string;
  content_sig: string;
  confidence: SynthesisConfidence;
  state: SynthesisState;
  stale: number;
  prompt_version: string;
  chat_model: string;
  created_at: string;
}

export interface EvidenceSnapshotEntry {
  fragment_id: string;
  source_id: string;
  source_title: string | null;
  content_hash: string;
  locator: string;
  text: string;
}

export interface NewSynthesis {
  text: string;
  theme_id: string;
  relation_kind: SynthesisRelationKind;
  epistemic_status: SynthesisEpistemicStatus;
  /** ≥ 2 fragments de ≥ 2 sources distinctes (vérifié en base, jamais sur parole). */
  evidence_fragment_ids: string[];
  provenance_snapshot: EvidenceSnapshotEntry[];
  content_sig: string;
  confidence: SynthesisConfidence;
  prompt_version: string;
  chat_model: string;
}

export type CreateSynthesisResult =
  | { ok: true; id: string; parentSourceIds: string[] }
  | {
      ok: false;
      reason: "theme_missing" | "evidence_missing" | "intra_source" | "duplicate";
    };

export interface SynthesesRepo {
  create(s: NewSynthesis): CreateSynthesisResult;
  listByTheme(themeId: string): SynthesisRow[];
  /** Synthèses tranchées d'un thème (accepted/rejected) — sert au blocage des variantes. */
  listDecidedByTheme(themeId: string): SynthesisRow[];
  listByIds(ids: string[]): SynthesisRow[];
  listAll(limit?: number): SynthesisRow[];
  countByState(): Record<SynthesisState, number>;
  accept(id: string): boolean;
  reject(id: string): boolean;
  /**
   * Marque stale=1 les synthèses dont une preuve vient de `sourceId`. S'appuie sur
   * provenance_snapshot (pas sur les fragments) : l'état reste calculable après
   * suppression ou ré-ingestion de la source. Renvoie le nombre de lignes touchées.
   */
  markStaleBySource(sourceId: string): number;
}

export function createSynthesesRepo(db: Db): SynthesesRepo {
  return {
    create(s: NewSynthesis): CreateSynthesisResult {
      if (!db.prepare("SELECT 1 FROM themes WHERE id = ?").get(s.theme_id)) {
        return { ok: false, reason: "theme_missing" };
      }
      const ids = [...new Set(s.evidence_fragment_ids)];
      if (ids.length < 2) return { ok: false, reason: "evidence_missing" };

      // les sources sont dérivées des fragments réels : le modèle ne fournit que des indices
      const frags = db
        .prepare(
          `SELECT id, source_id FROM fragments WHERE id IN (${ids.map(() => "?").join(",")})`
        )
        .all(...ids) as { id: string; source_id: string }[];
      if (frags.length !== ids.length) return { ok: false, reason: "evidence_missing" };

      const parentSourceIds = [...new Set(frags.map((f) => f.source_id))];
      if (parentSourceIds.length < 2) return { ok: false, reason: "intra_source" };

      const id = randomUUID();
      try {
        db.prepare(
          `INSERT INTO syntheses (id, text, theme_id, relation_kind, epistemic_status,
             parent_source_ids, evidence_fragment_ids, provenance_snapshot, content_sig,
             confidence, state, stale, prompt_version, chat_model, created_at)
           VALUES (@id, @text, @theme_id, @relation_kind, @epistemic_status,
             @parent_source_ids, @evidence_fragment_ids, @provenance_snapshot, @content_sig,
             @confidence, 'proposed', 0, @prompt_version, @chat_model, @created_at)`
        ).run({
          id,
          text: s.text,
          theme_id: s.theme_id,
          relation_kind: s.relation_kind,
          epistemic_status: s.epistemic_status,
          parent_source_ids: JSON.stringify(parentSourceIds),
          evidence_fragment_ids: JSON.stringify(ids),
          provenance_snapshot: JSON.stringify(s.provenance_snapshot),
          content_sig: s.content_sig,
          confidence: s.confidence,
          prompt_version: s.prompt_version,
          chat_model: s.chat_model,
          created_at: nowIso(),
        });
        return { ok: true, id, parentSourceIds };
      } catch (e) {
        // UNIQUE(content_sig) : même énoncé déjà produit (run rejoué, formulation identique).
        // Toute autre violation (CHECK epistemic_status = FACT par exemple) doit remonter :
        // la confondre avec un doublon masquerait un bug de règle, pas un doublon.
        if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          return { ok: false, reason: "duplicate" };
        }
        throw e;
      }
    },

    listByTheme(themeId: string): SynthesisRow[] {
      return db
        .prepare("SELECT * FROM syntheses WHERE theme_id = ? ORDER BY rowid")
        .all(themeId) as SynthesisRow[];
    },

    listDecidedByTheme(themeId: string): SynthesisRow[] {
      return db
        .prepare(
          "SELECT * FROM syntheses WHERE theme_id = ? AND state IN ('accepted','rejected') ORDER BY rowid"
        )
        .all(themeId) as SynthesisRow[];
    },

    listByIds(ids: string[]): SynthesisRow[] {
      if (ids.length === 0) return [];
      return db
        .prepare(`SELECT * FROM syntheses WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as SynthesisRow[];
    },

    listAll(limit = 500): SynthesisRow[] {
      return db
        .prepare("SELECT * FROM syntheses ORDER BY rowid DESC LIMIT ?")
        .all(limit) as SynthesisRow[];
    },

    countByState(): Record<SynthesisState, number> {
      const rows = db
        .prepare("SELECT state, COUNT(*) AS c FROM syntheses GROUP BY state")
        .all() as { state: SynthesisState; c: number }[];
      const out: Record<SynthesisState, number> = { proposed: 0, accepted: 0, rejected: 0 };
      for (const r of rows) out[r.state] = r.c;
      return out;
    },

    accept(id: string): boolean {
      return (
        db
          .prepare("UPDATE syntheses SET state = 'accepted' WHERE id = ? AND state = 'proposed'")
          .run(id).changes > 0
      );
    },

    reject(id: string): boolean {
      return (
        db
          .prepare("UPDATE syntheses SET state = 'rejected' WHERE id = ? AND state = 'proposed'")
          .run(id).changes > 0
      );
    },

    markStaleBySource(sourceId: string): number {
      return db
        .prepare(
          `UPDATE syntheses SET stale = 1
           WHERE stale = 0 AND EXISTS (
             SELECT 1 FROM json_each(syntheses.provenance_snapshot) AS e
             WHERE json_extract(e.value, '$.source_id') = ?
           )`
        )
        .run(sourceId).changes;
    },
  };
}
