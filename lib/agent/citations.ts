import type { Db } from "@/lib/db/client";
import {
  evidenceProblem,
  loadLiveFragments,
  type EvidenceProblem,
} from "@/lib/quality/evidence";
import type {
  CatalogueEntry,
  CitationProblem,
  InvestigationDocument,
} from "@/lib/agent/types";

/**
 * Vérification programmatique des citations (PRD US-09 AC2).
 *
 * « Toute citation est vérifiée programmatiquement contre des fragments existants
 * (id + texte) » — et « une citation invalide ⇒ étape marquée failed, jamais
 * affichée comme preuve ». Les deux règles vivent ici, et **nulle part ailleurs** :
 * l'API, le validateur `scripts/validate-phase-4.mjs` et les tests appellent la
 * même fonction, donc ils ne peuvent pas diverger sur ce qu'est une preuve valide.
 *
 * La **comparaison** elle-même (`evidenceProblem`) vit dans `lib/quality/evidence.ts` :
 * le feed de synthèses (Phase 5B) vérifie les mêmes copies au moment T, et deux copies
 * d'une même règle finissent par diverger — c'est exactement le défaut trouvé dans cette
 * base avec la barrière de conclusion non branchée. Les types restent compatibles :
 * `CitationProblem` est `EvidenceProblem`.
 *
 * La vérification est faite **à la lecture**, pas au moment du run : la question
 * posée est « cette citation tient-elle encore, maintenant ? ». Une source
 * re-ingérée (`CASCADE` sur ses fragments) ou supprimée rend l'entrée non
 * vérifiable ; le texte copié au moment T reste alors consultable, mais il n'est
 * plus présenté comme une preuve.
 */

/** Fragment minimal attendu pour construire une entrée de catalogue. */
export interface CitationSource {
  id: string;
  source_id: string;
  source_title: string | null;
  chunk_index: number;
  locator: string;
  text: string;
}

/** Copie d'un fragment au moment T — la seule chose que la vérification compare. */
export function toCatalogueEntry(
  fragment: CitationSource,
  index: number,
  origin: CatalogueEntry["origin"]
): CatalogueEntry {
  return {
    index,
    fragment_id: fragment.id,
    source_id: fragment.source_id,
    source_title: fragment.source_title,
    chunk_index: fragment.chunk_index,
    locator: fragment.locator,
    text: fragment.text,
    origin,
  };
}

/**
 * Document tel que persisté. Tolérant par construction : un `steps` illisible ne
 * doit pas faire tomber l'écran — il est traité comme une investigation vide, et
 * l'appelant décide (le service n'écrirait jamais un document vide).
 */
export function parseInvestigationDocument(raw: string | null): InvestigationDocument {
  const empty: InvestigationDocument = {
    prompt_version: "",
    chat_model: "",
    step_budget: 0,
    llm_calls: 0,
    steps_from_cache: 0,
    catalogue: [],
    steps: [],
  };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<InvestigationDocument>;
    return {
      ...empty,
      ...parsed,
      catalogue: Array.isArray(parsed.catalogue) ? parsed.catalogue : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    };
  } catch {
    return empty;
  }
}

/**
 * Recalcule `verified` / `problem` de chaque entrée, puis l'état de chaque étape.
 *
 * Une étape est `failed` si le service l'a marquée comme telle **ou** si l'une des
 * entrées qu'elle cite (conclusion) ou donne à lire (observation) n'est plus
 * vérifiable. Le document renvoyé est une copie : la ligne en base n'est jamais
 * réécrite par une lecture.
 */
export function verifyDocument(db: Db, doc: InvestigationDocument): InvestigationDocument {
  const live = loadLiveFragments(db, doc.catalogue.map((e) => e.fragment_id));
  const verified: CatalogueEntry[] = doc.catalogue.map((entry) => {
    const problem: EvidenceProblem | null = evidenceProblem(live.get(entry.fragment_id), entry);
    return {
      ...entry,
      verified: problem === null,
      problem: (problem ?? undefined) as CitationProblem | undefined,
    };
  });
  const byIndex = new Map(verified.map((e) => [e.index, e]));

  const steps = doc.steps.map((step) => {
    const cited = [...(step.citations ?? []), ...step.observation];
    const broken = cited.some((index) => {
      const entry = byIndex.get(index);
      return !entry || entry.verified !== true;
    });
    return broken
      ? { ...step, failed: true, failure: step.failure ?? "citation_non_verifiee" }
      : { ...step };
  });

  return {
    ...doc,
    catalogue: verified,
    steps,
    unverified: verified.filter((e) => e.verified !== true).length,
  };
}

