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