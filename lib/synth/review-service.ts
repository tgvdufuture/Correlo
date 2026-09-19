import type { Db } from "@/lib/db/client";
import {
  createSynthesesRepo,
  type EvidenceSnapshotEntry,
  type SynthesisConfidence,
  type SynthesisEpistemicStatus,
  type SynthesisFeedOptions,
  type SynthesisFeedRow,
  type SynthesisRelationKind,
  type SynthesisState,
} from "@/lib/repositories/syntheses";
import {
  loadLiveFragments,
  verifyEvidence,
  type VerifiedEvidence,
} from "@/lib/quality/evidence";

/**
 * Revue des **synthèses** (Phase 5B, amendement v1.3 §3) — rendre actionnable ce que
 * la Phase 5A a produit : feed trié par thème puis `confidence`, preuves **citables**
 * et vérifiées à la lecture, `provenance_snapshot` affichable, acceptation/rejet
 * persistants.
 *
 * Aucun appel LLM : comme la revue de suggestions (Phase 3), c'est du CRUD + lecture,
 * donc entièrement testable hors ligne. Le service est le seul endroit où les
 * invariants du PRD sont appliqués ; les routes ne font que traduire son résultat en
 * statut HTTP.
 *
 * Deux décisions de conception qui viennent du PRD, pas du goût :
 *
 * 1. **La vérification des preuves est faite à la lecture**, avec la règle partagée
 *    (`lib/quality/evidence.ts`) — le PRD l'écrit pour les synthèses (« chaque fragment
 *    cité existe et son texte correspond, réutilise la validation prévue en Phase 4 »).
 *    Une synthèse dont une preuve ne tient plus est **affichée comme telle** : ses
 *    citations ne sont plus des preuves, mais le `provenance_snapshot` reste lisible
 *    (AC4 — c'est tout l'intérêt d'avoir copié le texte au moment T).
 * 2. **Une synthèse tranchée ne se retranche pas** (AC3 : accepter/rejeter est
 *    persistant). Re-trancher est refusé (`already_decided`) au lieu d'être silencieux :
 *    un écran qui afficherait un nouvel état sans que la base l'ait pris ferait croire à
 *    une décision enregistrée.
 *
 * Accepter une synthèse **n'écrit rien ailleurs** (AC5) : ni `constructions` — le schéma
 * v1.2 y impose un `suggestion_id` NOT NULL —, ni le canvas. La promotion d'une synthèse
 * sur le plan de travail est la décision reportée en v1.4 (§5 de l'amendement), et la
 * Phase 6 y reviendra pour la conversation.
 */

export interface SynthesisThemeInfo {
  id: string;
  label: string;
  run_id: string;
  seed: string;
}

export interface SynthesisFeedItem {
  id: string;
  text: string;
  content_sig: string;
  relation_kind: SynthesisRelationKind;
  epistemic_status: SynthesisEpistemicStatus;
  confidence: SynthesisConfidence;
  state: SynthesisState;
  /** Une preuve de la synthèse a disparu ou changé ⇒ à réévaluer (AC4). */
  stale: boolean;
  created_at: string;
  prompt_version: string;
  chat_model: string;
  theme: SynthesisThemeInfo;
  parent_source_ids: string[];
  evidence_fragment_ids: string[];
  /**
   * Preuves citables (source, locator, texte) : **le `provenance_snapshot` lui-même**,
   * avec le verdict de la vérification recalculé à cette lecture. C'est la copie au
   * moment T qui est affichée — jamais une jointure — donc elle reste lisible quand la
   * source a disparu (AC2/AC4). Le champ n'est pas dupliqué en `provenance_snapshot` :
   * deux clés pour le même contenu finiraient par diverger.
   */
  evidence: VerifiedEvidence<EvidenceSnapshotEntry>[];
  /** Preuves qui ne tiennent plus (0 = toutes vérifiées). */
  unverified: number;
  /**
   * Copie de provenance perdue (JSON illisible) : les preuves existent par leurs ids
   * mais il n'y a **rien à montrer** — l'écran doit le dire, pas afficher « tout va
   * bien ». Distinct d'une preuve vérifiée : `unverified` compte les preuves connues
   * dont la vérification échoue, celle-ci compte l'absence de copie.
   */
  provenance_lost: boolean;
}

export type SynthesisDecision = "accept" | "reject";

export type DecideSynthesisResult =
  | { ok: true; synthesis: SynthesisFeedItem }
  | { ok: false; reason: "not_found" | "already_decided" };

export interface SynthesisReviewService {
  feed(opts?: SynthesisFeedOptions): SynthesisFeedItem[];
  decide(id: string, decision: SynthesisDecision): DecideSynthesisResult;
}

export function createSynthesisReviewService(db: Db): SynthesisReviewService {
  const syntheses = createSynthesesRepo(db);

  const build = (rows: SynthesisFeedRow[]): SynthesisFeedItem[] => {
    // une seule lecture de fragments pour tout le feed (les snapshots des 200 lignes)
    const snapshots = rows.map((row) => parseSnapshot(row.provenance_snapshot));
    const live = loadLiveFragments(
      db,
      snapshots.flat().map((e) => e.fragment_id)
    );
    return rows.map((row, i) => {
      const snapshot = snapshots[i];
      const evidence = verifyEvidence(db, snapshot, live);
      return {
        id: row.id,
        text: row.text,
        content_sig: row.content_sig,
        relation_kind: row.relation_kind,
        epistemic_status: row.epistemic_status,
        confidence: row.confidence,
        state: row.state,
        stale: row.stale === 1,
        created_at: row.created_at,
        prompt_version: row.prompt_version,
        chat_model: row.chat_model,
        theme: {
          id: row.theme_id,
          label: row.theme_label,
          run_id: row.theme_run_id,
          seed: row.theme_seed,
        },
        parent_source_ids: JSON.parse(row.parent_source_ids) as string[],
        evidence_fragment_ids: JSON.parse(row.evidence_fragment_ids) as string[],
        evidence,
        unverified: evidence.filter((e) => !e.verified).length,
        provenance_lost: snapshot.length === 0,
      };
    });
  };

  const service: SynthesisReviewService = {
    feed(opts = {}) {
      return build(syntheses.listFeed(opts));
    },

    decide(id, decision) {
      if (!syntheses.getById(id)) return { ok: false, reason: "not_found" };
      const changed = decision === "accept" ? syntheses.accept(id) : syntheses.reject(id);
      if (!changed) return { ok: false, reason: "already_decided" };
      const row = syntheses.getFeedById(id);
      // impossible : la ligne vient d'être mise à jour
      if (!row) return { ok: false, reason: "not_found" };
      return { ok: true, synthesis: build([row])[0] };
    },
  };

  return service;
}

/**
 * Le snapshot persisté est la source de l'affichage. S'il est illisible, on ne devine
 * **pas** : on renvoie une liste vide, et l'appelant le dit (`provenance_lost`).
 * Reconstruire des entrées vides depuis les ids ferait passer une copie perdue pour une
 * preuve dont le texte a changé — deux états qu'il ne faut pas confondre. Aucune ligne
 * saine ne peut arriver ici : le dépôt exige un snapshot à la création.
 */
function parseSnapshot(raw: string): EvidenceSnapshotEntry[] {
  try {
    const parsed = JSON.parse(raw) as EvidenceSnapshotEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
