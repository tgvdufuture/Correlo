import type { Db } from "@/lib/db/client";

/**
 * **Ce qu'est une preuve valide** — définition unique, partagée par toutes les phases
 * qui citent des fragments : l'enquête (Phase 4, `lib/agent/citations.ts`), le feed de
 * synthèses (Phase 5B, `lib/synth/review-service.ts`), le validateur et les tests.
 *
 * Le PRD l'écrit à deux endroits (§2.1 « Vérification programmatique : chaque fragment
 * cité existe et son texte correspond (réutilise la validation prévue en Phase 4) ») :
 * la règle est donc la même, mais elle n'était jusqu'ici écrite que pour la Phase 4.
 * Deux copies d'une même comparaison finissent toujours par diverger — c'est le premier
 * défaut trouvé dans cette base (barrière de conclusion non branchée, Phase 4).
 *
 * La comparaison ne porte que sur ce qui est **observable** : le fragment existe-t-il
 * encore, appartient-il à la même source, et son texte est-il identique à la copie faite
 * au moment T ? Un texte modifié n'est pas « la même preuve » : la citation ne tient
 * plus, même si la ligne existe toujours.
 *
 * Module à **import de type seulement** : il reste chargeable par un script Node
 * (`scripts/validate-phase-5b.mjs`) sans alias `@/` à l'exécution.
 */

export type EvidenceProblem = "fragment_absent" | "source_modifiee" | "texte_modifie";

/** Fragment tel qu'il existe **maintenant** en base. */
export interface LiveFragment {
  source_id: string;
  text: string;
}

/**
 * Preuve attendue : la copie faite au moment T (`provenance_snapshot`,
 * `evidence_fragment_ids` + catalogue d'enquête). C'est la seule chose qui est
 * comparée — jamais une jointure.
 */
export interface ExpectedEvidence {
  fragment_id: string;
  source_id: string;
  text: string;
}

/**
 * Preuve vérifiée à la lecture : `verified === false` ⇒ jamais présentée comme telle.
 *
 * **Générique** : une preuve porte ses champs utiles à l'affichage (`locator`,
 * `source_title`, `content_hash`…) et la vérification les conserve. Sans cela, un
 * snapshot de synthèse perdrait au passage ce qui rend une citation citable — et il
 * faudrait le recomposer côté écran, donc à un endroit de plus.
 */
export type VerifiedEvidence<T extends ExpectedEvidence = ExpectedEvidence> = T & {
  verified: boolean;
  problem?: EvidenceProblem;
};

/**
 * Fragments vivants par id (lecture par lots : la limite de variables SQLite est 999,
 * et un feed peut citer des centaines de fragments).
 */
export function loadLiveFragments(db: Db, ids: string[]): Map<string, LiveFragment> {
  const out = new Map<string, LiveFragment>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT id, source_id, text FROM fragments WHERE id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(...chunk) as (LiveFragment & { id: string })[];
    for (const r of rows) out.set(r.id, { source_id: r.source_id, text: r.text });
  }
  return out;
}

/**
 * Pourquoi une preuve ne tient plus, ou `null` si elle tient.
 *
 * L'ordre des tests est celui des messages : un fragment disparu prime sur une source
 * qui a changé (sans fragment, il n'y a plus de source à comparer).
 */
export function evidenceProblem(
  live: LiveFragment | undefined,
  expected: Pick<ExpectedEvidence, "source_id" | "text">
): EvidenceProblem | null {
  if (!live) return "fragment_absent";
  if (live.source_id !== expected.source_id) return "source_modifiee";
  if (live.text !== expected.text) return "texte_modifie";
  return null;
}

/**
 * Vérifie un lot de preuves attendues contre la base, dans l'ordre d'entrée.
 *
 * `preloaded` permet à un appelant qui vérifie **plusieurs lots** (le feed d'un écran)
 * de charger les fragments une seule fois : sans lui, un feed de 200 synthèses ferait
 * 200 requêtes groupées au lieu d'une.
 */
export function verifyEvidence<T extends ExpectedEvidence>(
  db: Db,
  entries: T[],
  preloaded?: Map<string, LiveFragment>
): VerifiedEvidence<T>[] {
  const live =
    preloaded ??
    loadLiveFragments(
      db,
      entries.map((e) => e.fragment_id)
    );
  return entries.map((entry) => {
    const problem = evidenceProblem(live.get(entry.fragment_id), entry);
    return problem
      ? { ...entry, verified: false, problem }
      : { ...entry, verified: true };
  });
}

/** Libellés affichés d'un problème de preuve (écran de synthèses et feed d'enquête). */
export const EVIDENCE_PROBLEM_LABEL: Record<EvidenceProblem, string> = {
  fragment_absent: "fragment disparu",
  source_modifiee: "source remplacée",
  texte_modifie: "texte modifié",
};
