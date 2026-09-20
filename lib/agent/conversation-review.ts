import type { Db } from "@/lib/db/client";
import {
  createConversationsRepo,
  turnInFlight,
  type MessageRow,
} from "@/lib/repositories/conversations";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import {
  parseConversationTurn,
  type ConversationAnchorKind,
  type ConversationStatus,
  type ConversationStep,
  type MessageRole,
  type WorkspaceRead,
} from "@/lib/agent/conversation-types";
import type { WorkspaceReader } from "@/lib/agent/workspace";
import { verifyConversationTurn, type VerifiedClaim } from "@/lib/agent/conversation-citations";

/**
 * Lecture d'une **conversation** (Phase 6, amendement v1.3 §13).
 *
 * Aucun appel LLM : comme la revue de suggestions (Phase 3) et le feed de synthèses
 * (Phase 5B), c'est du CRUD + lecture, donc entièrement testable hors ligne. Le service
 * est le seul endroit où les invariants sont appliqués ; les routes ne font que traduire
 * son résultat en statut HTTP.
 *
 * Deux décisions de conception :
 *
 * 1. **Le verdict des affirmations est recalculé à cette lecture**
 *    (`verifyConversationTurn`, règle partagée `lib/quality/evidence.ts`). Ce qui est
 *    renvoyé n'est donc pas « ce qui était vrai le jour du tour » mais « ce qui tient
 *    maintenant » : une source supprimée depuis fait passer l'affirmation en **non
 *    sourcée** (AC1), et le texte copié au moment T reste affichable.
 * 2. **Le catalogue n'est pas renvoyé.** C'est la plus grosse part du document, et il
 *    serait redondant : chaque affirmation porte déjà la copie des fragments qu'elle
 *    cite (locator, titre de source, texte). Ce qui est renvoyé pour le tour, c'est ce
 *    qui **s'affiche** — les étapes de l'agent, les compteurs, l'éventuel échec. Le
 *    catalogue reste dans la ligne (`messages.run`), où il sert à la vérification.
 * 3. **Le lecteur du workspace est injecté**, jamais lu depuis la configuration globale
 *    (`createConversationReviewService(db, { workspace })`) : c'est le seul moyen pour
 *    qu'une citation de fichier soit revérifiée **par la même règle** que pendant le tour,
 *    et pour qu'un test ne dépende pas du `.env.local` de la machine. Sans lecteur, une
 *    citation de fichier est déclarée `racine_absente` — jamais crue sur parole.
 */

export interface ConversationAnchorView {
  kind: ConversationAnchorKind;
  ref: string | null;
  /**
   * Énoncé de la synthèse ancrée, tronqué — ce que l'écran affiche en tête. `null` quand
   * l'ancre a disparu : une synthèse supprimée ne supprime pas la conversation (le schéma
   * ne pose pas de FK, précisément pour ça), et l'écran doit dire d'où venait la
   * conversation, pas laisser croire à une question posée sur le corpus entier.
   */
  label: string | null;
}

/**
 * Une **lecture de fichier** du tour, telle qu'elle s'affiche : le chemin relatif et la plage
 * (AC3), plus le motif d'un éventuel refus. La copie vit dans la provenance de l'affirmation
 * qui la cite — même parti pris que pour une page web, et pour la même raison : deux
 * copies du même texte feraient deux vérités à l'écran.
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

/**
 * Un résultat de recherche web tel qu'il s'affiche : l'URL et sa **date de lecture** sont
 * visibles (AC2′b), et le texte lu n'est pas renvoyé ici — il est déjà dans la copie de
 * l'affirmation qui le cite, et le dupliquer ferait deux vérités à l'écran.
 */export interface ConversationWebResultView {
  index: number;
  url: string;
  title: string | null;
  snippet: string | null;
  found_at: string;
  read: boolean;
  retrieved_at?: string;
  /** Lecture tentée et refusée (motif du durcissement réseau). */
  failure?: string;
}

export interface ConversationRunView {
  prompt_version: string;
  chat_model: string;
  step_budget: number;
  /** Plafond d'étapes web du tour (0 = outils non exposés). */
  web_budget: number;
  /** Étapes internes et web **consommées** — l'AC5′ les compte séparément. */
  internal_steps: number;
  web_steps: number;
  llm_calls: number;
  steps_from_cache: number;
  history_messages: number;
  /** Déverrouillage des outils web (§13.4) : un constat serveur, jamais une humeur. */
  web_unlocked: boolean;
  web_unlock_min_evidence: number;
  /** `corpus_suffisant`, `corpus_insuffisant`, `acces_desactive`, `connecteur_absent`, `constat_en_attente`. */
  web_unlock_reason?: string;
  /** Résultats de la recherche du tour (URL, date de lecture, refus). */
  web_results: ConversationWebResultView[];
  /**
   * Racine du workspace **au moment du tour** (`null` s'il n'y en avait pas). Affichée avec
   * les lectures : une citation de fichier ne veut rien dire sans savoir d'où elle vient.
   */
  workspace_root: string | null;
  /** Lectures de fichiers du tour, refus compris. */
  workspace_reads: WorkspaceReadView[];
  /** La synthèse ancrée n'existe plus. */
  anchor_missing: boolean;
  steps: ConversationStep[];
  failure?: string;
}

export interface ConversationMessageView {
  id: string;
  role: MessageRole;
  text: string;
  status: ConversationStatus;
  created_at: string;
  /** Affirmations avec leur verdict **d'aujourd'hui**. */
  claims: VerifiedClaim[];
  /** Affirmations sans preuve survivante — comptées, jamais présentées comme un fait. */
  unsourced: number;
  unverified: number;
  failure?: string;
  /** `null` pour un message de l'utilisateur (il n'a pas de tour). */
  run: ConversationRunView | null;
}

export interface ConversationView {
  id: string;
  title: string;
  anchor: ConversationAnchorView;
  chat_model: string;
  created_at: string;
  updated_at: string;
  /**
   * Racine du workspace **configurée aujourd'hui** (le réglage, pas le tour) : l'écran
   * l'affiche pour que l'utilisateur sache ce que l'agent a le droit de lire — et il ne la
   * choisit pas (un sélecteur de dossier serait un écran de réglages, hors AC3).
   */
  workspace_root: string | null;
  /**
   * Une question attend sa réponse (en file **ou** en cours). C'est ce que l'écran suit pour
   * se rafraîchir et pour désactiver le champ : un tour en file n'a encore aucune ligne
   * `pending` à observer, donc sans ce champ l'écran afficherait un silence figé.
   */
  awaiting_reply: boolean;
  messages: ConversationMessageView[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  anchor_kind: ConversationAnchorKind;
  anchor_ref: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
  last: { role: MessageRole; text: string; status: ConversationStatus } | null;
  /**
   * Un tour est en file ou en cours — l'écran peut le dire sans lire la file. Même prédicat
   * que le 409 de `POST /api/conversations/:id/messages` (`turnInFlight`).
   */
  pending: boolean;
}

export interface ConversationReviewService {
  list(limit?: number): ConversationSummary[];
  /** `null` quand la conversation n'existe pas (la route répond 404). */
  read(id: string): ConversationView | null;
}

export function createConversationReviewService(
  db: Db,
  opts?: { workspace?: WorkspaceReader | null }
): ConversationReviewService {
  const conversations = createConversationsRepo(db);
  const syntheses = createSynthesesRepo(db);
  const workspace = opts?.workspace ?? null;

  const anchorLabel = (kind: ConversationAnchorKind, ref: string | null): string | null => {
    if (kind !== "synthesis" || !ref) return null;
    const synthesis = syntheses.getById(ref);
    if (!synthesis) return null;
    return synthesis.text.length > 160 ? `${synthesis.text.slice(0, 159)}…` : synthesis.text;
  };

  const runView = (raw: string | null): ConversationRunView | null => {
    if (!raw) return null;
    const turn = parseConversationTurn(raw);
    return {
      prompt_version: turn.prompt_version,
      chat_model: turn.chat_model,
      step_budget: turn.step_budget,
      web_budget: turn.web_budget,
      internal_steps: turn.internal_steps,
      web_steps: turn.web_steps,
      llm_calls: turn.llm_calls,
      steps_from_cache: turn.steps_from_cache,
      history_messages: turn.history_messages,
      web_unlocked: turn.web_unlocked,
      web_unlock_min_evidence: turn.web_unlock_min_evidence,
      ...(turn.web_unlock_reason ? { web_unlock_reason: turn.web_unlock_reason } : {}),
      web_results: turn.web_results.map((r) => ({
        index: r.index,
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        found_at: r.found_at,
        read: r.read === true,
        ...(r.retrieved_at ? { retrieved_at: r.retrieved_at } : {}),
        ...(r.failure ? { failure: r.failure } : {}),
      })),
      workspace_root: turn.workspace_root ?? null,
      workspace_reads: (turn.workspace_reads ?? []).map((r: WorkspaceRead) => ({
        index: r.index,
        path: r.path,
        from_line: r.from_line,
        to_line: r.to_line,
        ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
        read_at: r.read_at,
        ...(r.failure ? { failure: r.failure } : {}),
      })),
      anchor_missing: turn.anchor_missing === true,
      steps: turn.steps,
      ...(turn.failure ? { failure: turn.failure } : {}),
    };
  };

  const messageView = (row: MessageRow): ConversationMessageView => {
    const base = {
      id: row.id,
      role: row.role,
      text: row.text,
      status: row.status,
      created_at: row.created_at,
      run: runView(row.run),
    };
    if (row.role !== "assistant" || !row.run) {
      return { ...base, claims: [], unsourced: 0, unverified: 0 };
    }
    const turn = parseConversationTurn(row.run);
    // la relecture passe le **même** lecteur que le tour : un chemin sorti de la racine, un
    // fichier modifié ou une racine retirée se voient ici, au lieu d'être crus sur parole
    const verdict = verifyConversationTurn(db, turn, { workspace });
    return {
      ...base,
      claims: verdict.claims,
      unsourced: verdict.unsourced,
      unverified: verdict.unverified,
      ...(turn.failure ? { failure: turn.failure } : {}),
    };
  };

  return {
    list(limit = 50) {
      const rows = conversations.list(limit);
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      // deux requêtes pour toute la liste (jamais une par ligne) : les compteurs, puis le
      // dernier message de chaque conversation
      const counts = new Map<string, number>();
      for (const r of db
        .prepare(
          `SELECT conversation_id, COUNT(*) AS n FROM messages
           WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id`
        )
        .all(...ids) as { conversation_id: string; n: number }[]) {
        counts.set(r.conversation_id, r.n);
      }
      const lasts = new Map<string, MessageRow>();
      for (const r of db
        .prepare(
          `SELECT m.* FROM messages m
           JOIN (
             SELECT conversation_id, MAX(rowid) AS r FROM messages
             WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id
           ) x ON m.rowid = x.r`
        )
        .all(...ids) as MessageRow[]) {
        lasts.set(r.conversation_id, r);
      }
      return rows.map((row) => {
        const last = lasts.get(row.id) ?? null;
        return {
          id: row.id,
          title: row.title,
          anchor_kind: row.anchor_kind,
          anchor_ref: row.anchor_ref,
          created_at: row.created_at,
          updated_at: row.updated_at,
          messages: counts.get(row.id) ?? 0,
          last: last ? { role: last.role, text: last.text, status: last.status } : null,
          // en file (dernière ligne = la question) ou en cours (dernière ligne = `pending`) :
          // les deux sont « en attente », et c'est le même prédicat que la garde d'enfilement
          pending: turnInFlight(last),
        };
      });
    },

    read(id) {
      const conversation = conversations.getById(id);
      if (!conversation) return null;
      const rows = conversations.listMessages(id);
      const messages = rows.map(messageView);
      return {
        id: conversation.id,
        title: conversation.title,
        anchor: {
          kind: conversation.anchor_kind,
          ref: conversation.anchor_ref,
          label: anchorLabel(conversation.anchor_kind, conversation.anchor_ref),
        },
        chat_model: conversation.chat_model,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        workspace_root: workspace?.enabled ? workspace.root : null,
        awaiting_reply: turnInFlight(rows.at(-1)),
        messages,
      };
    },
  };
}
