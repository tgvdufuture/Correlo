import type { Db } from "@/lib/db/client";
// imports **relatifs** (pas les alias `@/`) : le validateur `scripts/validate-phase-6.mjs`
// importe cette règle depuis un script Node sans résolution d'alias — même convention que
// `lib/quality/evidence.ts`, et pour la même raison : le validateur et le serveur ne
// peuvent pas diverger sur ce qu'est une citation vérifiable.
import {
  evidenceProblem,
  loadLiveFragments,
  type EvidenceProblem,
} from "../quality/evidence.ts";
import {
  webExcerpt,
  type ClaimProvenance,
  type ConversationClaim,
  type ConversationTurn,
  type FileProvenance,
  type FragmentProvenance,
  type WebProvenance,
  type WebProblem,
  type WorkspaceRead,
} from "./conversation-types.ts";
import {
  WorkspaceRefusalError,
  workspaceExcerpt,
  type WorkspaceReader,
} from "./workspace.ts";
import type { WorkspaceProblem } from "./workspace-refusals.ts";

// le vocabulaire des problèmes vit dans des modules **purs** : l'écran doit pouvoir
// l'afficher sans entraîner ni la base ni `node:fs` dans un bundle client
export { WEB_PROBLEM_LABEL } from "./conversation-types.ts";
export type { WebProblem } from "./conversation-types.ts";
export { WORKSPACE_PROBLEM_LABEL } from "./workspace-refusals.ts";
export type { WorkspaceProblem } from "./workspace-refusals.ts";

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
 * **Workspace.** Troisième famille, et la règle est celle du corpus, pas celle du web : la
 * plage lue est **relue maintenant** (`Chemin:ligne`, AC3), et la citation ne tient que si la
 * plage est identique. Le fichier est local, le relire ne coûte rien et ne déclenche aucun
 * appel — il n'y a donc **aucune raison** de se contenter d'une date. Un fichier modifié
 * depuis fait passer l'affirmation en « non sourcée » : elle n'a pas vieilli, elle **cesse
 * d'être appuyée**. La relecture passe par le **même** confinement que le tour (`createWorkspace`
 * puis `read`) : un lien symbolique détourné, une racine déplacée ou un chemin devenu
 * illisible se voient ici comme ils se seraient vus pendant le tour.
 *
 * Ce que cette vérification **ne fait pas**, dans les trois familles : juger si
 * l'affirmation est *impliquée* par l'extrait. C'est mesuré aveugle en Phase 4 (§11.3 :
 * 0,27 de recouvrement sur une clause qui résume pourtant correctement son fragment). On
 * vérifie ce qui est citable.
 */

/** Une provenance après vérification : `verified === false` ⇒ jamais présentée comme preuve. */
export type VerifiedProvenance =
  | (FragmentProvenance & { verified: boolean; problem?: EvidenceProblem })
  | (WebProvenance & { verified: boolean; problem?: WebProblem })
  | (FileProvenance & { verified: boolean; problem?: WorkspaceProblem });

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
 * Ce qui est injecté à la relecture. Le lecteur du workspace est **passé**, jamais lu depuis
 * la configuration globale : une variable d'environnement qui change ne doit pas changer le
 * verdict d'un test, et une route qui n'aurait pas de racine doit le dire explicitement
 * (`workspace: null` ⇒ une citation de fichier est `racine_absente`, donc non vérifiée).
 */
export interface VerifyConversationOptions {
  workspace?: WorkspaceReader | null;
}

/**
 * Recalcule le verdict de chaque affirmation contre le **tour enregistré** et la base
 * **maintenant**. Aucune entrée : un document sans provenance rend un verdict vide.
 */
export function verifyConversationTurn(
  db: Db,
  turn: ConversationTurn,
  opts?: VerifyConversationOptions
): TurnVerdict {
  const ids = turn.claims.flatMap((c) =>
    c.provenance.filter((p): p is FragmentProvenance => p.kind === "fragment").map((p) => p.fragment_id)
  );
  const live = loadLiveFragments(db, ids);
  const web = turn.web_results ?? [];
  const workspace = opts?.workspace ?? null;
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
      if (entry.kind === "file") {
        const problem = fileProblem(workspace, turn, entry);
        if (problem) unverified += 1;
        return problem ? { ...entry, verified: false, problem } : { ...entry, verified: true };
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
 * L'intégrité d'une **citation de fichier** (AC3), vérifiée **par relecture**, sans réseau et
 * sans base : la provenance doit correspondre à une lecture de ce tour, et la plage doit
 * **toujours dire la même chose**.
 *
 * Cinq contrôles, dans cet ordre — le premier qui échoue est le motif affiché :
 *  1. une lecture de ce tour porte cet indice, et elle a réussi (`lecture_absente`) ;
 *  2. la racine est configurée **maintenant** (`racine_absente`) : sans elle, il n'y a rien
 *     à revérifier — et c'est le cas où il serait tentant de croire la copie sur parole ;
 *  3. le chemin et la date enregistrés correspondent à la lecture du tour, et la copie
 *     conservée est bien celle de la plage lue (`copie_modifiee`) ;
 *  4. la plage est **relue aujourd'hui par le même confinement** : un chemin sorti de la
 *     racine est `hors_racine`, tout autre refus du lecteur est `fichier_illisible` ;
 *  5. la plage relue donne le **même texte** (`copie_modifiee`) — c'est le seul contrôle qui
 *     dépend du disque, et c'est lui qui rend une citation de fichier honnête : elle décrit
 *     le document tel qu'il est, pas tel qu'il était.
 */
export function fileProblem(
  workspace: WorkspaceReader | null,
  turn: ConversationTurn,
  prov: FileProvenance
): WorkspaceProblem | null {
  const reads: WorkspaceRead[] = turn.workspace_reads ?? [];
  const stored = reads.find((r) => r.index === prov.index && !r.failure && r.text !== undefined);
  if (!stored) return "lecture_absente";
  if (!workspace || !workspace.enabled) return "racine_absente";
  if (
    stored.path !== prov.path ||
    stored.from_line !== prov.from_line ||
    stored.to_line !== prov.to_line ||
    stored.read_at !== prov.read_at ||
    workspaceExcerpt(stored.text ?? "") !== prov.excerpt
  ) {
    return "copie_modifiee";
  }
  let fresh: { text: string };
  try {
    fresh = workspace.read({
      path: prov.path,
      from: prov.from_line,
      to: prov.to_line,
    });
  } catch (e) {
    if (e instanceof WorkspaceRefusalError) {
      return e.refusal === "chemin_hors_racine" || e.refusal === "racine_invalide"
        ? "hors_racine"
        : "fichier_illisible";
    }
    return "fichier_illisible";
  }
  return workspaceExcerpt(fresh.text) === prov.excerpt ? null : "copie_modifiee";
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
