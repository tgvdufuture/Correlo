import type { Db } from "@/lib/db/client";
import {
  evidenceProblem,
  loadLiveFragments,
  type EvidenceProblem,
} from "@/lib/quality/evidence";
import {
  webExcerpt,
  type ClaimProvenance,
  type ConversationClaim,
  type ConversationTurn,
  type FragmentProvenance,
  type WebProvenance,
  type WebProblem,
} from "@/lib/agent/conversation-types";

// le vocabulaire des problèmes vit dans `conversation-types` (module pur) : l'écran doit
// pouvoir l'afficher sans entraîner la base dans un bundle client
export { WEB_PROBLEM_LABEL } from "@/lib/agent/conversation-types";
export type { WebProblem } from "@/lib/agent/conversation-types";

/**
 * Ce qui rend une **affirmation** citable (AC1), vérifié **à la lecture**.
 *
 * **Corpus.** La comparaison est celle qui fait foi depuis la Phase 4 : `evidenceProblem`
 * (`lib/quality/evidence.ts`) — le fragment existe-t-il encore, appartient-il à la même
 * source, son texte est-il identique à la copie faite au moment T ? La Phase 5B a déjà
 * évité d'en écrire une seconde copie ; la Phase 6 fait de même, et c'est le même module
 * qui répond pour l'enquête, le feed de synthèses et la conversation. La question posée est
 * « cette citation tient-elle **encore**, maintenant ? » — une source re-ingérée (`CASCADE`
 * sur ses fragments) ou supprimée transforme une affirmation sourcée en affirmation **non
 * sourcée**, affichée comme telle au lieu d'être servie comme un fait.
 *
 * **Web.** Une page peut changer ou disparaître, et la relire à chaque affichage serait une
 * requête réseau déclenchée par un rendu — exactement ce que l'AC7 interdit. Une citation
 * web est donc une **copie datée**, et ce qui est vérifié ici est l'**intégrité de la
 * copie** : elle doit correspondre à une page réellement **lue pendant ce tour** (indice,
 * URL, date et passage identiques à la lecture enregistrée). Aucun accès réseau n'est
 * fait — le vérificateur travaille sur `messages.run`, et nulle part ailleurs.
 *
 * Ce que cette vérification **ne fait pas**, dans les deux familles : juger si
 * l'affirmation est *impliquée* par l'extrait. C'est mesuré aveugle en Phase 4 (§11.3 :
 * 0,27 de recouvrement sur une clause qui résume pourtant correctement son fragment). On
 * vérifie ce qui est citable.
 */

/** Une provenance après vérification : `verified === false` ⇒ jamais présentée comme preuve. */
export type VerifiedProvenance =
  | (FragmentProvenance & { verified: boolean; problem?: EvidenceProblem })
  | (WebProvenance & { verified: boolean; problem?: WebProblem });

export interface VerifiedClaim {
  text: string;
  provenance: VerifiedProvenance[];
  /**
   * Au moins une provenance survit. `false` ⇒ l'affirmation est affichée « non
   * sourcée » : l'AC1 l'autorise à exister, jamais à passer pour un fait.
   */
  sourced: boolean;
}

export interface TurnVerdict {
  claims: VerifiedClaim[];
  /** Preuves connues qui ne tiennent plus (fragment disparu, copie web modifiée…). */
  unverified: number;
  /** Affirmations sans preuve survivante. */
  unsourced: number;
}

/**
 * Recalcule le verdict de chaque affirmation contre le **tour enregistré** et la base
 * **maintenant**. Aucune entrée : un document sans provenance rend un verdict vide.
 */
export function verifyConversationTurn(db: Db, turn: ConversationTurn): TurnVerdict {
  const ids = turn.claims.flatMap((c) =>
    c.provenance.filter((p): p is FragmentProvenance => p.kind === "fragment").map((p) => p.fragment_id)
  );
  const live = loadLiveFragments(db, ids);
  const web = turn.web_results ?? [];
  let unverified = 0;
  let unsourced = 0;

  const claims: VerifiedClaim[] = turn.claims.map((claim: ConversationClaim) => {
    const provenance: VerifiedProvenance[] = claim.provenance.map((entry: ClaimProvenance) => {
      if (entry.kind === "fragment") {
        const problem = evidenceProblem(live.get(entry.fragment_id), entry);
        if (problem) unverified += 1;
        return problem
          ? { ...entry, verified: false, problem }
          : { ...entry, verified: true };
      }
      const problem = webProblem(web, entry);
      if (problem) unverified += 1;
      return problem ? { ...entry, verified: false, problem } : { ...entry, verified: true };
    });
    const sourced = provenance.some((p) => p.verified);
    if (!sourced) unsourced += 1;
    return { text: claim.text, provenance, sourced };
  });

  return { claims, unverified, unsourced };
}

/**
 * L'intégrité d'une copie web, **sans réseau** : la provenance doit correspondre à une
 * lecture de ce tour. Les cinq contrôles sont exactement ce qu'une copie datée doit
 * pouvoir prouver ; le moindre écart est un `verified: false`, jamais un silence.
 */
export function webProblem(results: ConversationTurn["web_results"], prov: WebProvenance): WebProblem | null {
  const result = results.find((r) => r.index === prov.index);
  if (!result) return "resultat_absent";
  if (!result.read) return "page_non_lue";
  if (result.url !== prov.url) return "copie_modifiee";
  if (!result.retrieved_at || Number.isNaN(Date.parse(prov.retrieved_at))) return "date_invalide";
  if (result.retrieved_at !== prov.retrieved_at) return "copie_modifiee";
  if (webExcerpt(result.text ?? "") !== prov.excerpt) return "copie_modifiee";
  return null;
}
