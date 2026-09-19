/**
 * Phase 4 — Investigation (PRD §4, US-09).
 *
 * Une investigation est menée par **un seul agent** et bornée à **5 étapes** (AC1).
 * Le schéma de la table `investigations` est verrouillé depuis la v1.2 (§3.2/§3.3) :
 * `id, suggestion_id, status, steps, created_at, updated_at` — il n'existe **aucune
 * colonne** pour les métadonnées de run (version de prompt, modèle, compteur
 * d'appels). Elles vivent donc dans le JSON de `steps`, sous forme d'enveloppe
 * (`InvestigationDocument`) dont le tableau `steps` porte au plus `step_budget`
 * entrées d'action. C'est la seule façon d'ajouter ces métadonnées sans toucher au
 * schéma verrouillé — même parti pris que les migrations 002–008, qui n'ont jamais
 * ajouté de colonne à une table v1.2.
 *
 * Invariant central (AC2) : **le modèle ne voit jamais d'identifiant de fragment**.
 * Le serveur tient un *catalogue* de fragments et n'expose au modèle que des
 * **indices** ; le rattachement indice → fragment est fait côté serveur, et chaque
 * citation est revérifiée en base avant d'être affichée.
 */

/** Plafond dur de l'agent (AC1) : au-delà, le schéma n'a plus de sens. */
export const INVESTIGATION_STEP_BUDGET = 5;

/** Nombre de fragments ajoutés au catalogue par une action `search` / `expand`. */
export const DEFAULT_AGENT_PAGE_SIZE = 4;

/** Taille maximale du catalogue : borne la taille du prompt et du document persisté. */
export const DEFAULT_AGENT_CATALOGUE_SIZE = 16;

/** Longueur maximale d'un énoncé de conclusion (l'investigation n'est pas une dissertation). */
export const MAX_ANSWER_CHARS = 1_200;

export type InvestigationStatus = "running" | "done" | "failed";

/**
 * Action d'une étape. `invalid` n'est jamais produite par le modèle : c'est la
 * trace d'une sortie inexploitable (schéma refusé après le retry de correction, ou
 * indice de catalogue inconnu). Elle existe pour qu'un échec reste **lisible**
 * au lieu de disparaître.
 */
export type InvestigationAction = "search" | "expand" | "conclude" | "invalid";

export type CitationProblem =
  | "fragment_absent"
  | "texte_modifie"
  | "source_modifiee"
  | "indice_hors_catalogue";

/**
 * Entrée du catalogue : un fragment **tel qu'il a été montré à l'agent**, avec sa
 * copie de texte au moment T. C'est cette copie que la vérification compare au
 * fragment vivant — exactement la logique de `provenance_snapshot` (US-08), pour
 * qu'une source supprimée en cours d'investigation ne transforme pas une preuve
 * en affirmation silencieuse.
 *
 * `verified` / `problem` sont **recalculés à chaque lecture** (`verifyDocument`) et
 * ne sont jamais persistés comme une vérité : la vérification doit porter sur la
 * base au moment où l'utilisateur regarde, pas sur le jour du run.
 */
export interface CatalogueEntry {
  /** Indice vu par le modèle (`[0]`, `[1]`, …) — jamais un id de fragment. */
  index: number;
  fragment_id: string;
  source_id: string;
  source_title: string | null;
  chunk_index: number;
  locator: string;
  text: string;
  origin: "seed" | "search" | "expand";
  verified?: boolean;
  problem?: CitationProblem;
}

/** Une étape = une action de l'agent, et ce qu'elle a produit. */
export interface InvestigationStep {
  /** 1..step_budget — un index, pas un compteur de tentatives. */
  index: number;
  action: InvestigationAction;
  input: { query?: string; fragment?: number };
  /** Indices de catalogue **ajoutés** par cette étape (search / expand). */
  added: number[];
  /** Indices que l'étape donne à lire (ses preuves) — vides si elle n'a rien ajouté. */
  observation: number[];
  /** `conclude` uniquement : l'énoncé produit. */
  answer?: string;
  /** `conclude` uniquement : les indices cités à l'appui de l'énoncé. */
  citations?: number[];
  /**
   * AC2 : une étape dont une citation n'est pas vérifiable est marquée `failed` et
   * **n'est jamais affichée comme preuve**.
   */
  failed: boolean;
  failure?: string;
}

/** Document persisté dans `investigations.steps` (et renvoyé par l'API). */
export interface InvestigationDocument {
  prompt_version: string;
  chat_model: string;
  /**
   * Version de la **barrière de conclusion** appliquée (`lib/quality/conclusion.ts`).
   * Un refus stocké doit nommer la règle qui l'a produit : `conclusion-v1` fondait la
   * juxtaposition sur l'attribution lexicale, `conclusion-v2` sur la structure — un
   * document relu après la bascule ne se juge pas de la même façon.
   */
  conclusion_rule_version?: string;
  /** Version de la règle de juxtaposition en prose (`jux-prose-v1`). */
  juxtaposition_rule_version?: string;
  /** Plafond effectivement appliqué (≤ INVESTIGATION_STEP_BUDGET). */
  step_budget: number;
  /** Appels LLM réellement payés (un appel par étape, jamais plus). */
  llm_calls: number;
  /** Étapes servies par le cache de prompt (un rejeu = 0 appel). */
  steps_from_cache: number;
  catalogue: CatalogueEntry[];
  steps: InvestigationStep[];
  /** Raison de l'échec global quand `status = 'failed'`. */
  failure?: string;
  /** Recalculé à la lecture : entrées de catalogue non vérifiables. */
  unverified?: number;
}

export const INVESTIGATION_ACTION_LABEL: Record<InvestigationAction, string> = {
  search: "recherche dans le corpus",
  expand: "voisinage d'un fragment",
  conclude: "conclusion",
  invalid: "sortie inexploitable",
};
