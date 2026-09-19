import type { Db } from "@/lib/db/client";
import { createCanvasRepo } from "@/lib/repositories/canvas";
import { createConstructionsRepo, type ConstructionView } from "@/lib/repositories/constructions";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import {
  createSuggestionsRepo,
  isFeedbackReason,
  type FeedFragment,
  type FeedItem,
  type FeedOptions,
  type FeedbackReason,
  type RelationType,
  type SuggestionState,
  type SuggestionTier,
} from "@/lib/repositories/suggestions";
import { capAtInference, type EpistemicStatus } from "@/lib/discover/epistemic";

/**
 * Revue d'une suggestion (PRD Phase 3 / US-06, US-07) — acceptation en
 * Construction, rejet motivé, exposition du feed.
 *
 * Aucun appel LLM : la phase 3 est du CRUD + UI, donc entièrement testable
 * hors ligne. Ce service est l'endroit unique où les invariants du PRD sont
 * appliqués (§3.2) ; les routes ne font que traduire le résultat en statut HTTP.
 */

export type AcceptResult =
  | { ok: true; construction: ConstructionView }
  | { ok: false; reason: "not_found" | "already_integrated" | "fragments_missing" };

export type RejectResult = { ok: true } | { ok: false; reason: "not_found" | "invalid_reason" };

export type OpenResult = { ok: true } | { ok: false; reason: "not_found" };

/**
 * Lien affiché entre deux **fichiers** du canvas (une suggestion, vue comme une
 * arête). La suggestion relie deux fragments : deux sources, donc deux éléments du
 * canvas — c'est pourquoi un fichier n'a pas besoin d'être « lié » à un nœud
 * spécial, et pourquoi une arête disparaît quand un des deux fichiers s'en va.
 */
export interface CanvasLink {
  /** Suggestion retenue pour la paire (la représentante du feed). */
  id: string;
  from_source_id: string;
  to_source_id: string;
  relation_type: RelationType;
  tier: SuggestionTier;
  state: SuggestionState;
  /** Statut du claim, **figé à la création** (§3.2) : affiché tel quel, jamais recalculé. */
  epistemic_status: EpistemicStatus;
  claim: string;
  fragments: FeedFragment[];
}

export interface ReviewService {
  /** Feed exposé : AC1 (1 par paire+relation, tri par tier) + passage `discovered` → `shown`. */
  feed(opts?: FeedOptions): FeedItem[];
  /**
   * Les liens du canvas : les suggestions en cours (exposées au passage, comme le
   * feed) **et** celles déjà intégrées, restreintes aux fichiers présents sur le
   * canvas. Aucune n'est dupliquée : une paire de fichiers donne une arête par
   * type de relation, ce qui est exactement la règle d'exposition du feed.
   */
  linksFor(sourceRefs: string[]): CanvasLink[];
  open(id: string): OpenResult;
  /**
   * US-07 : accept → Construction (depth=1, snapshot de provenance, statut plafonné).
   *
   * `place` (facultatif) est l'endroit du canvas où la Construction doit apparaître :
   * le client y met le milieu des deux fichiers reliés, pour que l'énoncé accepté
   * naisse **entre** ses sources au lieu d'atterrir dans la première case libre.
   * Sans lui, la première case libre fait foi.
   */
  accept(suggestionId: string, place?: { x: number; y: number }): AcceptResult;
  /** US-06 : reject exige exactement une raison prédéfinie ; la paire est bloquée. */
  reject(suggestionId: string, reason: unknown): RejectResult;
}

export function createReviewService(db: Db): ReviewService {
  const suggestions = createSuggestionsRepo(db);
  const constructions = createConstructionsRepo(db);
  const fragments = createFragmentsRepo(db);
  const sources = createSourcesRepo(db);
  const canvas = createCanvasRepo(db);

  const service: ReviewService = {
    feed(opts = {}) {
      const items = suggestions.listFeed(opts);
      const exposed = suggestions.markExposed(items.map((i) => i.id));
      // le payload reflète l'état après exposition, sinon le client afficherait
      // « discovered » pour des suggestions qu'il vient de recevoir
      return exposed > 0
        ? items.map((i) => (i.state === "discovered" ? { ...i, state: "shown" as const } : i))
        : items;
    },

    linksFor(sourceRefs) {
      const present = new Set(sourceRefs);
      // `feed()` marque l'exposition : les liaisons affichées sur le canvas sont
      // vues par l'utilisateur, exactement comme une carte du feed.
      const open = service.feed({ limit: 500 });
      const integrated = suggestions.listFeed({ state: "accepted", limit: 500 });
      const links: CanvasLink[] = [];
      for (const item of [...open, ...integrated]) {
        const [a, b] = item.fragments;
        // un fragment supprimé (source re-ingérée) casse l'arête : on la retire au
        // lieu d'afficher un lien vers un fichier absent
        if (!a || !b || a.source_id === b.source_id) continue;
        if (!present.has(a.source_id) || !present.has(b.source_id)) continue;
        links.push({
          id: item.id,
          from_source_id: a.source_id,
          to_source_id: b.source_id,
          relation_type: item.relation_type,
          tier: item.tier,
          state: item.state,
          epistemic_status: item.epistemic_status,
          claim: item.claim,
          fragments: item.fragments,
        });
      }
      return links;
    },

    open(id) {
      if (!suggestions.getById(id)) return { ok: false, reason: "not_found" };
      // `opened` est monotone : ré-ouvrir une suggestion acceptée ne la rétrograde pas
      suggestions.markOpened(id);
      return { ok: true };
    },

    accept(suggestionId, place) {
      const suggestion = suggestions.getById(suggestionId);
      if (!suggestion) return { ok: false, reason: "not_found" };
      // 409 avant même de construire le snapshot : une même suggestion ne
      // s'intègre qu'une fois (US-07 AC3, `suggestion_id` UNIQUE)
      if (constructions.getBySuggestion(suggestionId)) {
        return { ok: false, reason: "already_integrated" };
      }

      const fragA = fragments.getById(suggestion.fragment_a_id);
      const fragB = fragments.getById(suggestion.fragment_b_id);
      if (!fragA || !fragB) return { ok: false, reason: "fragments_missing" };

      // Copie au moment T (jamais une jointure) : la provenance doit survivre au
      // CASCADE des fragments (US-08 AC1).
      const snapshot = [fragA, fragB].map((f) => {
        const source = sources.getById(f.source_id);
        return {
          source_id: f.source_id,
          source_title: source?.title ?? null,
          source_content_hash: source?.content_hash ?? "",
          fragment_id: f.id,
          fragment_text: f.text,
          locator: f.locator,
        };
      });

      const run = db.transaction((): AcceptResult => {
        const created = constructions.create({
          // texte initial : le claim, seule formulation disponible à ce stade
          text: suggestion.claim,
          // min_rang(INFERENCE, statut suggestion) — jamais FACT (§3.2)
          epistemic_status: capAtInference(suggestion.epistemic_status),
          parentSourceIds: [...new Set(snapshot.map((s) => s.source_id))].sort(),
          evidenceFragmentIds: snapshot.map((s) => s.fragment_id),
          suggestionId,
          snapshot,
        });
        if (!created.ok) return { ok: false, reason: "already_integrated" };
        suggestions.decide(suggestionId, { state: "accepted" });
        // dispose la Construction sur le canvas dans la même transaction : une
        // Construction acceptée ne peut pas exister sans position (sinon elle
        // serait invisible sur le canvas jusqu'à la prochaine lecture)
        if (place) canvas.placeAt("construction", created.construction.id, place.x, place.y);
        else canvas.place("construction", created.construction.id);
        return { ok: true, construction: created.construction };
      });
      return run();
    },

    reject(suggestionId, reason) {
      // US-06 AC1 : raison obligatoire ET dans l'énumération, sinon 400
      if (!isFeedbackReason(reason)) return { ok: false, reason: "invalid_reason" };
      if (!suggestions.getById(suggestionId)) return { ok: false, reason: "not_found" };
      suggestions.decide(suggestionId, {
        state: "rejected",
        reason: reason as FeedbackReason,
      });
      return { ok: true };
    },
  };
  return service;
}
