/** Types de l'API bibliothèque (miroir de lib/repositories/sources.ts). */

export type JobStatus = "pending" | "running" | "done" | "failed";
export type SummaryStatus = "pending" | "done" | "failed";
export type SourceType = "TEXT" | "PDF" | "URL";

export interface SourceListItem {
  id: string;
  type: SourceType;
  title: string | null;
  canonical_path: string | null;
  content_hash: string;
  summary: string | null;
  summary_status: SummaryStatus;
  created_at: string;
  fragment_count: number;
  ingest_status: JobStatus;
  ingest_error: string | null;
  ingest_job_id: string | null;
  summary_error: string | null;
  summary_job_id: string | null;
}

export interface JobError {
  code: string;
  message?: string;
}

export function parseJobError(raw: string | null): JobError | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as JobError;
    return typeof parsed?.code === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Feed de suggestions et Constructions (Phase 3, miroir de
 * lib/repositories/suggestions.ts et constructions.ts).
 * ------------------------------------------------------------------ */

export type RelationType = "analogy" | "contradiction" | "cause";
export type SuggestionTier = "strong" | "medium" | "weak";
export type SuggestionState =
  | "discovered"
  | "shown"
  | "opened"
  | "accepted"
  | "rejected";
export type EpistemicStatus = "FACT" | "INFERENCE" | "HYPOTHESIS" | "SPECULATION";
export type FeedbackReason = "trivial" | "false" | "already_known" | "off_topic";

export interface FeedFragment {
  id: string;
  source_id: string;
  source_title: string | null;
  chunk_index: number;
  locator: string;
  text: string;
}

export interface FeedItem {
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
  fragments: FeedFragment[];
}

export interface ProvenanceEntry {
  source_id: string;
  source_title: string | null;
  source_content_hash: string;
  fragment_id: string;
  fragment_text: string;
  locator: string;
}

export interface ConstructionItem {
  id: string;
  text: string;
  epistemic_status: EpistemicStatus;
  parent_source_ids: string[];
  evidence_fragment_ids: string[];
  suggestion_id: string | null;
  depth: number;
  stale: boolean;
  provenance_snapshot: ProvenanceEntry[];
}

export const RELATION_LABEL: Record<RelationType, string> = {
  analogy: "analogie",
  contradiction: "contradiction",
  cause: "cause",
};

export const TIER_LABEL: Record<SuggestionTier, string> = {
  strong: "forte",
  medium: "moyenne",
  weak: "faible",
};

export const FEEDBACK_REASON_LABEL: Record<FeedbackReason, string> = {
  trivial: "triviale",
  false: "fausse",
  already_known: "déjà connue",
  off_topic: "hors sujet",
};

/* ------------------------------------------------------------------ *
 * Canvas (Phase 3, volet canvas libre) — miroir de lib/repositories/canvas.ts.
 * ------------------------------------------------------------------ */

export type CanvasFrameKind = "frame" | "group";
/** Nature d'un élément du canvas : un **fichier** (source) ou une Construction. */
export type CanvasItemKind = "construction" | "source";

/** Cadre (panneau titré) ou groupe (contour pointillé) : les deux déplacent leurs membres. */
export interface CanvasFrame {
  id: string;
  label: string;
  kind: CanvasFrameKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string | null;
  z: number;
  created_at: string;
  updated_at: string;
}

interface ItemPlacement {
  /** Identite de l'entite : `constructions.id` ou `sources.id`. */
  ref: string;
  x: number;
  y: number;
  z: number;
  frame_id: string | null;
}

export type CanvasItem =
  | (ItemPlacement & { kind: "construction"; construction: ConstructionItem })
  | (ItemPlacement & { kind: "source"; source: SourceListItem });

/**
 * Lien entre deux fichiers du canvas : une suggestion vue comme une arête.
 * `fragments` porte les deux preuves citées (claim, type, tier).
 */
export interface CanvasLink {
  id: string;
  from_source_id: string;
  to_source_id: string;
  relation_type: RelationType;
  tier: SuggestionTier;
  state: SuggestionState;
  epistemic_status: EpistemicStatus;
  claim: string;
  fragments: FeedFragment[];
}

export interface CanvasState {
  frames: CanvasFrame[];
  items: CanvasItem[];
  links: CanvasLink[];
}

/** Tailles nominales : servent au calcul d'appartenance, au cadrage et aux arêtes. */
export const NODE_WIDTH = 300;
export const NODE_HEIGHT = 170;
export const SOURCE_WIDTH = 260;
export const SOURCE_HEIGHT = 132;
export const FRAME_DEFAULT_WIDTH = 460;
export const FRAME_DEFAULT_HEIGHT = 340;

/**
 * Définitions des statuts épistémiques, affichées au survol (US-05 AC1, §3.6).
 * Elles décrivent le statut **figé à la création** : il n'est jamais élevé
 * automatiquement (§3.2).
 */
/* ------------------------------------------------------------------ *
 * Synthèses (Phase 5B) — miroir de lib/synth/review-service.ts.
 * ------------------------------------------------------------------ */

export type SynthesisRelationKind = "combination" | "extension" | "tension" | "application";
export type SynthesisConfidence = "low" | "medium" | "high";
export type SynthesisState = "proposed" | "accepted" | "rejected";
export type SynthesisEpistemicStatus = "INFERENCE" | "HYPOTHESIS" | "SPECULATION";

export interface SynthesisEvidence {
  fragment_id: string;
  source_id: string;
  source_title: string | null;
  content_hash: string;
  locator: string;
  text: string;
  verified: boolean;
  /** Absent quand `verified` est vrai. */
  problem?: "fragment_absent" | "source_modifiee" | "texte_modifie";
}

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
  /** Une preuve a disparu ou changé : à réévaluer (AC4), le snapshot reste lisible. */
  stale: boolean;
  created_at: string;
  prompt_version: string;
  chat_model: string;
  theme: SynthesisThemeInfo;
  parent_source_ids: string[];
  evidence_fragment_ids: string[];
  /** Le `provenance_snapshot` (copie au moment T) + le verdict recalculé à la lecture. */
  evidence: SynthesisEvidence[];
  unverified: number;
  /** Copie de provenance perdue (JSON illisible) : rien à montrer pour les preuves. */
  provenance_lost: boolean;
}

export const SYNTHESIS_RELATION_LABEL: Record<SynthesisRelationKind, string> = {
  combination: "combinaison",
  extension: "prolongement",
  tension: "tension",
  application: "application",
};

export const SYNTHESIS_CONFIDENCE_LABEL: Record<SynthesisConfidence, string> = {
  high: "élevée",
  medium: "moyenne",
  low: "faible",
};

export const EVIDENCE_PROBLEM_LABEL: Record<NonNullable<SynthesisEvidence["problem"]>, string> = {
  fragment_absent: "fragment disparu",
  source_modifiee: "source remplacée",
  texte_modifie: "texte modifié",
};

/* ------------------------------------------------------------------ *
 * Investigation (Phase 4) — le domaine vit dans `lib/agent/types.ts`, qui n'a
 * **aucun import** et peut donc être chargé par un composant client tel quel. On le
 * réexporte ici pour que les écrans aient un seul chemin d'import, sans dupliquer des
 * types qui doivent rester identiques à ce que l'API renvoie.
 * ------------------------------------------------------------------ */

export type {
  CatalogueEntry as InvestigationCatalogueEntry,
  InvestigationAction,
  InvestigationDocument,
  InvestigationStatus,
  InvestigationStep,
} from "@/lib/agent/types";
export { INVESTIGATION_ACTION_LABEL } from "@/lib/agent/types";

/** Libellés d'état d'une investigation (l'écran suit la file, pas seulement la base). */
export type InvestigationFeedStatus = "none" | "pending" | "running" | "done" | "failed";

export const INVESTIGATION_STATUS_LABEL: Record<InvestigationFeedStatus, string> = {
  none: "Aucune enquête",
  pending: "En attente",
  running: "Enquête en cours",
  done: "Enquête terminée",
  failed: "Enquête échouée",
};

/**
 * Réponse de `GET /api/suggestions/:id/investigation`.
 *
 * `investigation` est le document **vérifié à la lecture** : les entrées non
 * vérifiables portent `verified: false`, et une étape dont une citation ne tient plus
 * est `failed` — l'écran ne doit donc jamais afficher ses citations comme des preuves.
 * `job` porte l'état de la file (une enquête n'existe en base qu'à partir du premier
 * appel LLM) et l'erreur structurée d'un échec de job.
 */
export interface InvestigationResponse {
  status: InvestigationFeedStatus;
  investigation: import("@/lib/agent/types").InvestigationDocument | null;
  job: { id: string; status: JobStatus; error: JobError | null } | null;
}

/* ------------------------------------------------------------------ *
 * Conversation (Phase 6) — miroir de lib/agent/conversation-review.ts.
 * ------------------------------------------------------------------ */

export type {
  ConversationAction,
  ConversationAnchorKind,
  ConversationStatus,
  ConversationStep,
  MessageRole,
} from "@/lib/agent/conversation-types";
export {
  ANSWER_REJECTION_LABEL,
  CONVERSATION_ACTION_LABEL,
} from "@/lib/agent/conversation-types";
// modules **purs** : `web-guard` (qui importe `node:dns`) et `conversation-citations` (qui
// lit la base) ne peuvent pas entrer dans un bundle client — le build l'a attrapé
export { WEB_REFUSAL_LABEL } from "@/lib/agent/web-refusals";
export { WEB_PROBLEM_LABEL } from "@/lib/agent/conversation-types";
// même règle pour le workspace : `lib/agent/workspace.ts` importe `node:fs`, ses libellés
// vivent dans un module pur (et un seul endroit)
export { WORKSPACE_REFUSAL_LABEL, WORKSPACE_PROBLEM_LABEL } from "@/lib/agent/workspace-refusals";
export type { WorkspaceProblem } from "@/lib/agent/workspace-refusals";

/**
 * Une provenance d'affirmation, **vérifiée à cette lecture**. `verified: false` ⇒ elle
 * n'appuie plus rien : l'affirmation est affichée « non sourcée », le texte copié au
 * moment T restant consultable (AC1).
 */
export interface FragmentProvenanceView {
  kind: "fragment";
  index: number;
  fragment_id: string;
  source_id: string;
  source_title: string | null;
  locator: string;
  text: string;
  verified: boolean;
  /** Absent quand `verified` est vrai. */
  problem?: "fragment_absent" | "source_modifiee" | "texte_modifie";
}

/**
 * Une provenance **web** : une copie **datée**, vérifiée contre la lecture du tour —
 * jamais re-fetchée à l'affichage (AC7). L'URL et la date sont montrées ensemble : c'est
 * ce que « copie du jour » veut dire pour qui lit.
 */
export interface WebProvenanceView {
  kind: "url";
  index: number;
  url: string;
  title: string | null;
  retrieved_at: string;
  excerpt: string;
  verified: boolean;
  /** Absent quand `verified` est vrai. */
  problem?: "resultat_absent" | "page_non_lue" | "copie_modifiee" | "date_invalide";
}

/**
 * Une provenance **workspace** : `chemin:ligne` plus la copie de la plage. Pas de date
 * affichée comme un fait du jour (contrairement au web) : la plage est **revérifiée à cette
 * lecture**, et `verified: false` dit laquelle des deux choses a changé — la copie ou le
 * fichier.
 */
export interface FileProvenanceView {
  kind: "file";
  index: number;
  path: string;
  from_line: number;
  to_line: number;
  read_at: string;
  excerpt: string;
  verified: boolean;
  /** Absent quand `verified` est vrai. */
  problem?:
    | "lecture_absente"
    | "copie_modifiee"
    | "fichier_illisible"
    | "hors_racine"
    | "racine_absente";
}

export type ClaimProvenanceView = FragmentProvenanceView | WebProvenanceView | FileProvenanceView;

export interface ConversationClaimView {
  text: string;
  provenance: ClaimProvenanceView[];
  /** Au moins une provenance survit — sinon l'affirmation est montrée « non sourcée ». */
  sourced: boolean;
}

/** Le tour tel qu'il s'affiche : les étapes de l'agent, pas le catalogue (il est dans la ligne). */
export interface ConversationWebResultView {
  index: number;
  url: string;
  title: string | null;
  snippet: string | null;
  found_at: string;
  read: boolean;
  retrieved_at?: string;
  failure?: string;
}

/**
 * Une lecture de fichier du tour, telle qu'elle s'affiche : chemin relatif et plage (AC3),
 * plus le motif d'un refus. La copie du texte vit dans la provenance de l'affirmation citée.
 */
export interface WorkspaceReadView {
  index: number;
  path: string;
  from_line: number;
  to_line: number;
  bytes?: number;
  read_at: string;
  failure?: string;
}

export interface ConversationRunView {
  prompt_version: string;
  chat_model: string;
  step_budget: number;
  web_budget: number;
  internal_steps: number;
  web_steps: number;
  llm_calls: number;
  steps_from_cache: number;
  history_messages: number;
  web_unlocked: boolean;
  web_unlock_min_evidence: number;
  web_unlock_reason?: string;
  web_results: ConversationWebResultView[];
  /** Racine du workspace **au moment du tour** (`null` s'il n'y en avait pas). */
  workspace_root: string | null;
  workspace_reads: WorkspaceReadView[];
  anchor_missing: boolean;
  steps: import("@/lib/agent/conversation-types").ConversationStep[];
  failure?: string;
}

export interface ConversationMessageView {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "pending" | "done" | "failed";
  created_at: string;
  claims: ConversationClaimView[];
  unsourced: number;
  unverified: number;
  failure?: string;
  run: ConversationRunView | null;
}

export interface ConversationAnchorView {
  kind: "synthesis" | "corpus";
  ref: string | null;
  /** Énoncé de la synthèse ancrée, tronqué — `null` si elle a disparu. */
  label: string | null;
}

export interface ConversationView {
  id: string;
  title: string;
  anchor: ConversationAnchorView;
  chat_model: string;
  created_at: string;
  updated_at: string;
  /** Racine du workspace configurée **aujourd'hui** (`null` : aucune). */
  workspace_root: string | null;
  /** Une question attend sa réponse (en file ou en cours) — l'écran suit ce champ. */
  awaiting_reply: boolean;
  messages: ConversationMessageView[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  anchor_kind: "synthesis" | "corpus";
  anchor_ref: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
  last: { role: "user" | "assistant"; text: string; status: "pending" | "done" | "failed" } | null;
  pending: boolean;
}

export const CONVERSATION_STATUS_LABEL: Record<ConversationMessageView["status"], string> = {
  pending: "Réponse en cours",
  done: "Réponse rendue",
  failed: "Tour échoué",
};

/**
 * Pourquoi un tour n'a pas rendu de réponse. Le motif **nomme la règle** qui a refusé :
 * un écran qui afficherait « échec » sans dire laquelle laisserait croire à une panne, alors
 * que chaque refus est une décision (et que le modèle, lui, a pu se reprendre).
 */
export const CONVERSATION_FAILURE_LABEL: Record<string, string> = {
  step_budget_exhausted: "Le budget d'étapes est épuisé avant qu'une réponse soit acceptée.",
  refus_repete:
    "Trois refus d'affilée : l'agent a répété une action qui venait d'être refusée, sans répondre.",
  reponse_sans_exploration: "L'agent a voulu répondre sans avoir rien lu du corpus.",
  reponse_sans_aucune_preuve: "Aucune affirmation n'était appuyée par un fragment du corpus.",
  reponse_hors_catalogue: "Une citation portait sur un fragment que l'agent n'avait jamais vu.",
  reponse_web_non_lue: "Une citation portait sur une page que l'agent n'avait pas lue pendant ce tour.",
  reponse_web_ignoree:
    "Le corpus ne suffisait pas (outils web exposés) et l'agent a répondu sans rien chercher dehors.",
  reponse_avec_repere_technique:
    "La réponse parlait du protocole (indice de catalogue) au lieu du sujet.",
  sortie_invalide: "Le modèle n'a pas rendu d'action exploitable.",
};

/**
 * Motifs d'échec **d'étape** qui ne viennent pas d'un refus de lecture (ceux-là ont leur
 * propre table, par outil). Un écran qui afficherait le code brut (`outil_web_indisponible`)
 * laisserait croire à une panne, alors que c'est une règle du serveur qui s'applique.
 */
export const STEP_FAILURE_LABEL: Record<string, string> = {
  outil_web_indisponible: "outil web non exposé à ce tour",
  budget_web_epuise: "budget web épuisé",
  recherche_deja_faite: "une seule recherche web par tour",
  page_deja_lue: "page déjà lue",
  resultat_hors_recherche: "résultat absent de la recherche de ce tour",
  recherche_echec: "recherche web en échec",
  aucun_resultat: "recherche sans résultat",
  outil_workspace_indisponible: "aucun workspace configuré",
  plage_deja_lue: "plage déjà lue dans ce tour",
  budget_interne_epuise: "budget interne épuisé",
  indice_hors_catalogue: "indice absent du catalogue",
  sortie_invalide: "sortie du modèle inexploitable",
};

/**
 * Ce que veut dire un tour « exposé au web » : la décision est un **constat serveur**
 * (§13.4), et l'écran doit dire lequel — un `false` muet n'apprend rien à qui regarde.
 */
export const WEB_UNLOCK_REASON_LABEL: Record<string, string> = {
  acces_desactive: "accès web désactivé (WEB_ACCESS=off)",
  connecteur_absent: "aucun connecteur de recherche configuré",
  constat_en_attente: "constat pas encore fait (aucune exploration aboutie)",
  corpus_suffisant: "le corpus suffisait",
  corpus_insuffisant: "corpus insuffisant — outils web exposés",
};

/* ------------------------------------------------------------------ *
 * Espace vectoriel du corpus (miroir de lib/llm/embedding-space.ts).
 * ------------------------------------------------------------------ */

export interface EmbeddingSpaceInfo {
  model: string;
  dimensions: number;
  version: string;
}

/** Un espace réellement présent en base, avec son poids. */
export interface CorpusSpaceInfo extends EmbeddingSpaceInfo {
  fragments: number;
  sources: number;
}

/**
 * L'espace **actif** (le réglage) face aux espaces réellement présents en base.
 *
 * `outOfSpace > 0` ⇒ une bascule de connecteur d'embeddings n'a pas été suivie d'une
 * re-vectorisation : ces fragments ne peuvent être comparés à rien (deux espaces
 * vectoriels n'ont pas de similarité), et l'analyse le refuse au lieu de produire des
 * liens faux. C'est ce que l'atelier affiche.
 */
export interface EmbeddingSpaceState {
  active: EmbeddingSpaceInfo;
  corpus: CorpusSpaceInfo[];
  /** Fragments hors espace actif (0 = aligné). */
  outOfSpace: number;
  /** Fichiers dont **tous** les fragments sont hors espace actif. */
  outOfSpaceSources: number;
  aligned: boolean;
  /** Réglage illisible (variable d'environnement invalide) — le reste de l'écran vit. */
  error?: string;
}

/** La commande qui remet le corpus dans l'espace actif (dans les deux sens). */
export const EMBEDDING_SPACE_COMMAND = "npm run reembed";

export const EPISTEMIC_DEFINITION: Record<EpistemicStatus, string> = {
  FACT: "Énoncé présent textuellement dans une preuve citée. Jamais attribué automatiquement à une Construction.",
  INFERENCE:
    "Conclusion tirée des preuves par le modèle : plausible, mais pas littéralement dans le texte.",
  HYPOTHESIS: "Piste proposée par le modèle, qui demanderait une vérification supplémentaire.",
  SPECULATION: "Ouverture sans appui fort dans les preuves — à traiter comme une piste.",
};