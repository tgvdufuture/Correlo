/**
 * Phase 6 — conversation (amendement v1.3 §13).
 *
 * Un tour = **un job** (`kind = 'conversation'`) et une ligne `messages` pour la
 * réponse. Le tour est mené par un seul agent, borné à `CONVERSATION_STEP_BUDGET` étapes
 * **internes**, plus — quand le serveur **constate** que le corpus ne suffit pas — au
 * plus `WEB_STEP_BUDGET` étapes **web** (§13.4, AC5′).
 *
 * Deux invariants viennent de la Phase 4 et sont repris tels quels :
 *  - **le modèle ne voit jamais d'identifiant de fragment** : il cite des indices de
 *    catalogue, le serveur rattache (`CatalogueEntry` est réutilisé tel quel) ;
 *  - **le serveur assemble** ce qui est affiché. Ici c'est plus fort qu'en Phase 4 :
 *    le modèle ne rend pas de prose, il rend des **affirmations** ; `messages.text` est
 *    la concaténation de ces affirmations. Sans cela, « chaque affirmation porte une
 *    provenance » (AC1) ne serait pas vérifiable — il faudrait deviner à quelle phrase
 *    se rattache quelle citation, et la Phase 4 a mesuré ce que vaut cette devinette
 *    (0,27 de recouvrement sur une clause qui résume pourtant correctement son
 *    fragment, §11.3).
 *
 * Trois familles de provenance, et **le serveur seul** les rattache (§13.3) : le corpus
 * (revérifié à chaque lecture, fragment local et immuable), le web (**copie datée** : une
 * page peut changer, et la relire à chaque affichage serait un appel réseau déclenché par
 * un rendu), le workspace (`chemin:ligne`, **revérifié à chaque lecture** comme le corpus :
 * le fichier est local, le relire ne coûte rien et ne sort de nulle part). L'asymétrie est le
 * point de conception, pas un oubli — une copie web vieillit, un fichier modifié **cesse
 * d'appuyer** l'affirmation.
 *
 * L'enveloppe du tour vit dans `messages.run` (JSON) : le schéma d'une table v1.2 n'a
 * aucune colonne pour les métadonnées de run, et `messages` n'a pas à les multiplier.
 * Même parti pris que `investigations.steps`.
 */

import type { CatalogueEntry } from "@/lib/agent/types";

/** Plafond dur d'étapes **internes** par tour (AC5′). */
export const CONVERSATION_STEP_BUDGET = 5;

/** Plafond dur d'étapes **web** par tour, en plus des étapes internes (AC5′). */
export const WEB_STEP_BUDGET = 3;

/**
 * Combien de **refus non facturés** la boucle tolère en plus de ses budgets (AC5′).
 *
 * **Pourquoi ce n'est pas `budget + budget web`.** Les deux budgets bornent ce qui est
 * *exécuté*, et un refus ne coûte rien — c'est la règle (§13.4). Mais chaque itération est un
 * appel LLM, donc la boucle a besoin d'une borne à elle. La prendre égale à la somme des
 * budgets fait qu'un refus **prend la place de la réponse** : mesuré en écrivant les tests du
 * workspace, où une lecture refusée par le confinement a consommé la dernière itération d'un
 * tour à 3 étapes — le tour échouait (`step_budget_exhausted`) alors que le budget interne
 * n'était pas épuisé et qu'il restait de quoi répondre. C'était déjà vrai pour les refus web ;
 * la lecture de fichier l'a rendu fréquent. Les deux bornes sont donc **séparées** : ce
 * compteur n'enlève jamais une étape facturée au tour.
 *
 * Trois, parce que trois refus d'affilée disent que le modèle n'écoute pas le motif qu'on
 * vient de lui rendre — et que le tour doit alors se terminer par un échec **tracé**
 * (`refus_repete`), pas boucler.
 */
export const MAX_REFUSED_STEPS = 3;

/** Nombre d'affirmations admises dans une réponse. Borne le document persisté. */
export const MAX_CLAIMS = 8;

/** Longueur maximale d'une affirmation (le tour n'est pas une dissertation). */
export const MAX_CLAIM_CHARS = 600;

/** Preuves citables par affirmation (au-delà, la citation n'éclaire plus rien). */
export const MAX_CITATIONS_PER_CLAIM = 6;

/** Résultats web enregistrés par une recherche (le service borne à ce plafond). */
export const MAX_WEB_RESULTS = 10;

/**
 * Longueur maximale d'une requête (`search`, `search_web`) et du motif d'une demande
 * d'accès web (`ask_web`). Un plafond, pas une validation sémantique : ces deux chaînes
 * sont affichées dans la trace du tour.
 */
export const MAX_WEB_QUERY_CHARS = 300;

/** Longueur de la copie de passage conservée avec une citation web. */
export const WEB_EXCERPT_CHARS = 1_200;

/** Tours précédents réinjectés dans le prompt : borne la taille et le coût. */
export const DEFAULT_HISTORY_MESSAGES = 6;

/**
 * Bornes d'une question d'utilisateur. Elles ne sont pas décoratives : la question part
 * telle quelle dans le prompt **et** dans la ligne persistée, donc une question vide ou
 * de 50 000 caractères doit être refusée par la route, pas découverte par le provider.
 */
export const MIN_QUESTION_CHARS = 2;
export const MAX_QUESTION_CHARS = 2_000;

export type ConversationAnchorKind = "synthesis" | "corpus";
export type ConversationStatus = "pending" | "done" | "failed";
export type MessageRole = "user" | "assistant";

/**
 * Action d'une étape. `invalid` n'est jamais produite par le modèle : c'est la trace
 * d'une sortie inexploitable (schéma refusé après le retry de correction), écrite pour
 * qu'un échec reste **lisible** — même convention qu'en Phase 4.
 *
 * `read_file` est le seul outil **local** du tour (§13.5, AC3) : il n'est ni dans le budget
 * web ni dans le réseau, mais il consomme une étape **interne** — c'est du travail de
 * l'agent, et un outil gratuit serait un outil qu'on appelle en boucle. Il n'existe que si
 * une racine est configurée (`WORKSPACE_ROOT`) : sans racine, l'action est refusée
 * (`outil_workspace_indisponible`) et n'est même pas annoncée dans le prompt.
 *
 * Les outils web (`search_web`, `read_page`) sont déclarés par le schéma **comme les
 * autres** : le schéma valide la *forme*, c'est le **service** qui refuse une action qui
 * n'a pas été exposée (constat d'insuffisance, `WEB_ACCESS=off`, budget web épuisé). La
 * visibilité reste donc gouvernée par le serveur, jamais par ce que le modèle croit avoir
 * le droit de faire.
 *
 * `ask_web` est la **demande du modèle**, et c'est le second chemin de déverrouillage
 * (§13.4, décision du 2026-09-20) : le constat de volume ne sait pas reconnaître « le
 * corpus ne répond pas » — mesuré sur la question des batteries, où il a déclaré
 * `corpus_suffisant` sur 4 fragments hors sujet. La demande exige une exploration
 * **aboutie** (comme le constat) et coûte **une étape interne** : c'est le prix de
 * « l'IA décide », et il est visible dans la trace du tour.
 */
export type ConversationAction =
  | "search"
  | "expand"
  | "ask_web"
  | "answer"
  | "search_web"
  | "read_page"
  | "read_file"
  | "invalid";

/** Budget auquel une étape est imputée : c'est ce que l'AC5′ compte séparément. */
export type ConversationStepScope = "internal" | "web";

export function stepScope(action: ConversationAction): ConversationStepScope {
  return action === "search_web" || action === "read_page" ? "web" : "internal";
}

/**
 * Motif de refus d'une réponse. Tous sont **récupérables** : la réponse refusée
 * consomme son étape, le modèle voit le motif dans la transcription et se reprend dans
 * le budget restant. Aucun échec de forme ne tue le tour au premier essai — c'est ce qui
 * fait la valeur de la règle (elle instruit, elle ne jette pas).
 */
export type AnswerRejection =
  | "reponse_hors_catalogue"
  | "reponse_web_non_lue"
  | "reponse_avec_repere_technique"
  | "reponse_web_ignoree"
  | "reponse_sans_aucune_preuve"
  | "reponse_sans_exploration";

export const ANSWER_REJECTION_LABEL: Record<AnswerRejection, string> = {
  reponse_hors_catalogue:
    "citation d'un fragment, d'une page ou d'un fichier qui n'a pas été montré pendant ce tour",
  reponse_web_non_lue: "citation d'une page qui n'a pas été lue pendant ce tour",
  reponse_avec_repere_technique:
    "le texte parle du protocole (indice de catalogue, repère) au lieu du sujet",
  reponse_web_ignoree:
    "le serveur a constaté que le corpus ne suffit pas et a exposé les outils web : le tour n'a fait aucune étape web",
  reponse_sans_aucune_preuve: "aucune affirmation appuyée par une preuve",
  reponse_sans_exploration: "réponse sans avoir lu le corpus",
};

/**
 * Provenance **corpus** : la copie du fragment **au moment du tour** (le catalogue), pas
 * la ligne vivante — la vérification est faite à la lecture, en comparant les deux.
 */
export interface FragmentProvenance {
  kind: "fragment";
  /** Indice de catalogue cité par le modèle (`[0]`, `[3]`…). */
  index: number;
  fragment_id: string;
  source_id: string;
  source_title: string | null;
  locator: string;
  text: string;
}

/**
 * Provenance **web** : `excerpt` est la copie du passage **lue pendant ce tour**, et
 * `retrieved_at` en est la date. Elle n'est **jamais re-fetchée** à l'affichage (AC7) :
 * c'est une copie du jour, dite comme telle, et le vérificateur contrôle l'intégrité de
 * la copie (elle correspond à une lecture du tour), pas la page.
 *
 * `index` est l'indice de **résultat** (`W0`), pas une position dans le texte : il permet
 * de retrouver la lecture du tour dans `web_results`.
 */
export interface WebProvenance {
  kind: "url";
  index: number;
  url: string;
  title: string | null;
  retrieved_at: string;
  excerpt: string;
}

/**
 * Provenance **workspace** : `chemin:ligne` plus la copie de la plage lue. Aucune date :
 * contrairement à une copie web, celle-ci **est revérifiée à chaque affichage** — le
 * fichier est local, le relire ne coûte rien. `path` est **relatif à la racine** (le
 * chemin absolu n'est ni cité ni affiché : la racine est un réglage de la machine, pas une
 * information de la réponse), et `index` est l'indice de lecture (`F0`).
 */
export interface FileProvenance {
  kind: "file";
  index: number;
  path: string;
  from_line: number;
  to_line: number;
  /** Date de la lecture, affichée ; la validité, elle, se juge en relisant la plage. */
  read_at: string;
  excerpt: string;
}

/** Provenance d'une affirmation : trois familles, une seule forme de rattachement. */
export type ClaimProvenance = FragmentProvenance | WebProvenance | FileProvenance;

/** Une affirmation : son texte, et les preuves qui l'appuient (0 preuve = non sourcée). */
export interface ConversationClaim {
  text: string;
  provenance: ClaimProvenance[];
}

/** La copie d'une page telle qu'elle a été lue pendant le tour (jamais la page vivante). */
export interface WebResult {
  /** Indice vu par le modèle (`W0`, `W1`) — le rattachement reste côté serveur. */
  index: number;
  url: string;
  title: string | null;
  /** Repère de choix (date, auteur) — **jamais citable**. */
  snippet: string | null;
  /** Date de la recherche. */
  found_at: string;
  /** `true` une fois la page lue : **seule une page lue est citable**. */
  read: boolean;
  /** Copie du texte lu, plafonnée (`WEB_PAGE_MAX_CHARS`). */
  text?: string;
  /** Date de la lecture — celle qui est affichée avec la citation. */
  retrieved_at?: string;
  /** Lecture tentée et refusée (motif du durcissement réseau). */
  failure?: string;
}

/**
 * Une **lecture de fichier** du tour (`read_file`). `index` est l'indice vu par le modèle
 * (`F0`, `F1`) : il ne voit jamais un identifiant technique, et il cite un indice — le
 * serveur rattache le chemin. Une lecture **refusée** est conservée elle aussi (avec son
 * motif) : la trace du tour doit dire ce qui a été tenté, pas seulement ce qui a réussi.
 * Seule une lecture réussie (`text`) est **citable**.
 */
export interface WorkspaceRead {
  index: number;
  path: string;
  from_line: number;
  to_line: number;
  /** Copie de la plage lue (plafonnée), absente quand la lecture a été refusée. */
  text?: string;
  bytes?: number;
  read_at: string;
  failure?: string;
}

/** Une étape = une action de l'agent, et ce qu'elle a produit. */
export interface ConversationStep {
  /**
   * Ordinal de l'étape dans le tour (1..internal_budget+web_budget) : un index, pas un
   * compteur de tentatives. Le budget auquel elle est imputée est `scope`.
   */
  index: number;
  action: ConversationAction;
  /** `internal` ou `web` — ce que l'AC5′ compte séparément. */
  scope?: ConversationStepScope;
  input: {
    query?: string;
    fragment?: number;
    result?: number;
    reason?: string;
    /** `read_file` : chemin demandé (tel quel, dans la trace du tour). */
    path?: string;
    /** `read_file` : plage demandée. */
    from?: number;
    to?: number;
  };
  /** Indices de catalogue **ajoutés** par cette étape (search / expand). */
  added: number[];
  /** Indices que l'étape donne à lire (ses preuves) — vides si elle n'a rien ajouté. */
  observation: number[];
  /** Indices de résultats web **ajoutés** par l'étape (`search_web`). */
  web_added?: number[];
  /** Indices de pages **lues** par l'étape (`read_page`). */
  web_observation?: number[];
  /** Indice de lecture de fichier produit par l'étape (`read_file`), réussi ou refusé. */
  workspace_added?: number[];
  /** Indices de lectures **citables** issues de cette étape (lecture réussie). */
  workspace_observation?: number[];
  /** `answer` refusée : le motif, et le tour continue dans le budget restant. */
  refused?: AnswerRejection;
  /** Trace d'une sortie inexploitable, d'un outil non exposé ou d'un refus réseau. */
  failure?: string;
  /**
   * `false` ⇒ l'étape n'a **rien consommé** : outil non exposé, budget épuisé, action
   * redondante (`recherche_deja_faite`, `page_deja_lue`, `resultat_hors_recherche`). Elle
   * est **tracée et affichée** — le modèle doit voir ce qui a été refusé — mais elle ne
   * compte ni dans `internal_steps` ni dans `web_steps` : l'AC5′ borne ce qui est
   * *exécuté*, et faire payer un refus reviendrait à compter les refus comme du budget.
   * Absent = étape facturée (le cas ordinaire).
   */
  charged?: boolean;
}

/** Document persisté dans `messages.run` (réponse de l'assistant). */
export interface ConversationTurn {
  prompt_version: string;
  chat_model: string;
  /** Plafond effectivement appliqué aux étapes **internes** (≤ CONVERSATION_STEP_BUDGET). */
  step_budget: number;
  /** Plafond effectivement appliqué aux étapes **web** (0 = web non exposé). */
  web_budget: number;
  /** Appels LLM réellement payés (un appel par étape, jamais plus). */
  llm_calls: number;
  /** Étapes servies par le cache de prompt (un rejeu du même tour = 0 appel). */
  steps_from_cache: number;
  /** Messages d'historique réinjectés dans le prompt de ce tour. */
  history_messages: number;
  /** Étapes internes consommées (≤ `step_budget`). */
  internal_steps: number;
  /** Étapes web consommées (≤ `web_budget`). */
  web_steps: number;
  /**
   * Déverrouillage des outils web (§13.4), par **deux chemins** : le serveur a constaté que
   * le catalogue ne porte pas `web_unlock_min_evidence` fragments utilisables de deux
   * sources (`corpus_insuffisant`), ou le **modèle a demandé** le web après avoir exploré
   * (`demande_modele`). Latched : une fois exposés, ils restent exposés pour le tour.
   */
  web_unlocked: boolean;
  /** Seuil appliqué (`WEB_UNLOCK_MIN_EVIDENCE`) — un tour relu doit dire la règle du jour. */
  web_unlock_min_evidence: number;
  /** Pourquoi cet état : `corpus_suffisant`, `corpus_insuffisant`, `demande_modele`, `acces_desactive`, `connecteur_absent`. */
  web_unlock_reason?: string;
  /** Résultats de la recherche web du tour, et les pages lues (copies datées). */
  web_results: WebResult[];
  /**
   * Racine du workspace **au moment du tour** (`null` quand il n'y en avait pas) : un tour
   * relu doit dire d'où venaient ses fichiers, même si le réglage a changé depuis — c'est
   * exactement le cas où une citation cesse d'être revérifiable, et il doit être lisible.
   */
  workspace_root?: string | null;
  /** Lectures de fichiers du tour (copies des plages lues, refus compris). */
  workspace_reads: WorkspaceRead[];
  catalogue: CatalogueEntry[];
  steps: ConversationStep[];
  /**
   * La synthèse ancrée n'existe plus (le schéma ne pose pas de FK vers `syntheses`,
   * précisément pour que la conversation reste lisible). L'ancre est un point de départ,
   * pas une condition d'existence : le tour continue sans elle, et le dit.
   */
  anchor_missing?: boolean;
  /** Affirmations assemblées en `messages.text`, dans leur ordre d'affichage. */
  claims: ConversationClaim[];
  /** Affirmations **sans** preuve survivante — comptées, jamais présentées comme un fait. */
  unsourced: number;
  /** Raison de l'échec global quand `status = 'failed'`. */
  failure?: string;
}

export const CONVERSATION_ACTION_LABEL: Record<ConversationAction, string> = {
  search: "recherche dans le corpus",
  expand: "voisinage d'un fragment",
  ask_web: "demande d'accès web",
  answer: "réponse",
  search_web: "recherche web",
  read_page: "lecture d'une page web",
  read_file: "lecture d'un fichier du workspace",
  invalid: "sortie inexploitable",
};

/**
 * Pourquoi une copie web ne tient plus (jamais présentée comme une preuve). Le vocabulaire
 * vit ici, avec le reste de ce qui s'affiche : la vérification (`conversation-citations`)
 * l'applique, l'écran l'affiche, et il n'en existe qu'une définition.
 */
export type WebProblem =
  | "resultat_absent"
  | "page_non_lue"
  | "copie_modifiee"
  | "date_invalide";

export const WEB_PROBLEM_LABEL: Record<WebProblem, string> = {
  resultat_absent: "résultat absent du tour",
  page_non_lue: "page jamais lue pendant ce tour",
  copie_modifiee: "copie du passage modifiée depuis le tour",
  date_invalide: "date de lecture illisible",
};

/**
 * Copie normalisée d'un passage de page : c'est **elle** qui est conservée et comparée,
 * jamais un extrait que le modèle aurait recopié (rien ne pourrait le vérifier, la page
 * pouvant changer).
 */
export function webExcerpt(text: string, max: number = WEB_EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Un tour vide — la base de tout document écrit (`ConversationService`), et le repli de
 * `parseConversationTurn`. Exporté pour qu'un test qui écrit un tour à la main n'ait pas à
 * recopier les champs : en ajouter un au document ne doit pas casser cinq fixtures.
 */
export function emptyConversationTurn(): ConversationTurn {
  return {
    prompt_version: "",
    chat_model: "",
    step_budget: 0,
    web_budget: 0,
    llm_calls: 0,
    steps_from_cache: 0,
    history_messages: 0,
    internal_steps: 0,
    web_steps: 0,
    web_unlocked: false,
    web_unlock_min_evidence: 0,
    web_results: [],
    workspace_root: null,
    workspace_reads: [],
    catalogue: [],
    steps: [],
    claims: [],
    unsourced: 0,
  };
}

/**
 * Document tolérant par construction : un `run` illisible ne doit pas faire tomber
 * l'écran. Même contrat que `parseInvestigationDocument`.
 */
export function parseConversationTurn(raw: string | null): ConversationTurn {
  const empty = emptyConversationTurn();
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationTurn>;
    return {
      ...empty,
      ...parsed,
      catalogue: Array.isArray(parsed.catalogue) ? parsed.catalogue : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      claims: Array.isArray(parsed.claims) ? parsed.claims : [],
      web_results: Array.isArray(parsed.web_results) ? parsed.web_results : [],
      workspace_reads: Array.isArray(parsed.workspace_reads) ? parsed.workspace_reads : [],
    };
  } catch {
    return empty;
  }
}

/** Le texte affiché d'une réponse : l'union de ses affirmations, dans l'ordre. */
export function assembleAnswerText(claims: ConversationClaim[]): string {
  return claims.map((c) => c.text.trim()).join(" ");
}
