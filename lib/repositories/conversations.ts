import { randomUUID } from "node:crypto";
import { nowIso, type Db } from "@/lib/db/client";
import type {
  ConversationAnchorKind,
  ConversationClaim,
  ConversationStatus,
  ConversationTurn,
  MessageRole,
} from "@/lib/agent/conversation-types";

/**
 * Conversation et ses messages (Phase 6, amendement v1.3 §13, migration 009).
 *
 * Le schéma v1.2 (§3.3) reste intact : `conversations` et `messages` sont deux entités
 * **nouvelles**, comme les thèmes et les synthèses l'ont été en 002. Aucune colonne n'est
 * ajoutée à une table verrouillée, et l'enveloppe du tour vit dans `messages.run` (JSON) —
 * même parti pris que `investigations.steps`.
 *
 * La table `messages` porte **l'état de la file** : une ligne n'existe qu'à partir du
 * premier appel LLM, donc `status` (`pending`, `done`, `failed`) est ce qui permet à
 * l'écran de dire « en cours » ou « échec » au lieu d'afficher un silence.
 *
 * `anchor_ref` n'a pas de clé étrangère vers `syntheses` : une synthèse supprimée doit
 * laisser la conversation **lisible** (même parti pris que `canvas_items`, où SQLite ne
 * sait de toute façon pas faire de FK polymorphe). L'existence de l'ancre est vérifiée
 * ici, à la création — un `anchor_kind = 'synthesis'` sans synthèse vivante serait un
 * état que l'écran devrait deviner.
 */
export interface ConversationRow {
  id: string;
  anchor_kind: ConversationAnchorKind;
  anchor_ref: string | null;
  title: string;
  chat_model: string;
  prompt_version: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  text: string;
  claims: string;
  run: string | null;
  status: ConversationStatus;
  created_at: string;
}

export interface NewConversation {
  /** Généré si absent (les tests le passent explicitement). */
  id?: string;
  anchorKind: ConversationAnchorKind;
  /** Requis si `anchorKind === 'synthesis'`, interdit sinon (le CHECK le redit en base). */
  anchorRef?: string | null;
  title: string;
  chatModel: string;
  promptVersion: string;
}

export interface ConversationsRepo {
  create(c: NewConversation): ConversationRow;
  getById(id: string): ConversationRow | null;
  /** Conversations les plus récemment actives d'abord (l'écran les liste). */
  list(limit?: number): ConversationRow[];
  deleteById(id: string): void;
  /**
   * Message de l'utilisateur : c'est une **entrée**, pas un résultat de run, donc il est
   * écrit par la route qui enfile le tour. Son `id` sert de clé d'idempotence au job :
   * rejouer la même question (double clic, reprise) retombe sur le même tour, alors que
   * reposer la même question crée un message neuf — donc un tour neuf.
   */
  addUserMessage(input: { id?: string; conversationId: string; text: string }): MessageRow;
  /**
   * Réponse de l'assistant. `id` est celui du **job** : un rejeu du même tour met à jour
   * *sa* ligne au lieu d'empiler une seconde réponse (même convention que la Phase 4, où
   * l'id d'une investigation est celui de son job).
   *
   * `text` est **assemblé** par le service à partir de `claims` — jamais la prose brute du
   * modèle : c'est la seule façon pour qu'une affirmation affichée et sa provenance ne
   * puissent pas diverger.
   */
  upsertAssistantMessage(input: {
    id: string;
    conversationId: string;
    status: ConversationStatus;
    text: string;
    claims: ConversationClaim[];
    turn: ConversationTurn;
  }): void;
  getMessage(id: string): MessageRow | null;
  /**
   * Messages d'une conversation, dans l'ordre chronologique. `limit` garde les **derniers**
   * (l'historique réinjecté dans le prompt est borné) tout en rendant l'ordre croissant.
   */
  listMessages(conversationId: string, opts?: { limit?: number }): MessageRow[];
}

/**
 * Un tour est **en vol** : il faut attendre avant de poser une autre question.
 *
 * Deux situations, et la seconde n'avait pas été prévue — mesuré sur la base jetable de
 * vérification HTTP (2026-09-19) : la route ne regardait que le **dernier message**, en le
 * testant `status === 'pending'`. Or la ligne de réponse est écrite par le **worker**, au
 * premier appel LLM, pas à l'enfilement : entre le `POST` et la prise en charge du job, la
 * dernière ligne est une question, donc `done` — le test laissait passer. Deux questions
 * d'affilée ont ainsi produit deux tours en parallèle sur la même conversation, chacun avec
 * le même catalogue de 2 fragments, affichés dans l'ordre `Q1 Q2 A1 A2` : exactement l'ordre
 * arbitraire que cette garde existe pour empêcher.
 *
 *  1. la **dernière ligne est une question** — un tour est en file ou en cours ;
 *  2. la dernière ligne est une réponse **`pending`** — le tour tourne, aucun message n'est
 *     encore écrit.
 *
 * Une réponse rendue (`done`) ou échouée (`failed`) vaut réponse : l'utilisateur peut
 * enchaîner, y compris après un échec — c'est le seul moyen de réessayer sans nouvelle
 * conversation.
 */
export function turnInFlight(last: MessageRow | undefined | null): boolean {
  if (!last) return false;
  if (last.role === "user") return true;
  return last.status === "pending";
}

/** Titre d'une conversation : le premier message, tronqué à la première phrase longue. */
export function conversationTitle(question: string, max = 80): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat || "Conversation";
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function createConversationsRepo(db: Db): ConversationsRepo {
  const touch = db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?");

  return {
    create(c) {
      if (c.anchorKind === "synthesis") {
        if (!c.anchorRef) {
          throw new Error("conversation : anchor_kind=synthesis exige anchor_ref");
        }
        const exists = db.prepare("SELECT id FROM syntheses WHERE id = ?").get(c.anchorRef);
        if (!exists) throw new Error(`conversation : synthèse introuvable (${c.anchorRef})`);
      } else if (c.anchorRef) {
        throw new Error("conversation : anchor_kind=corpus n'admet pas anchor_ref");
      }
      const now = nowIso();
      const row: ConversationRow = {
        id: c.id ?? randomUUID(),
        anchor_kind: c.anchorKind,
        anchor_ref: c.anchorRef ?? null,
        title: c.title,
        chat_model: c.chatModel,
        prompt_version: c.promptVersion,
        created_at: now,
        updated_at: now,
      };
      db.prepare(
        `INSERT INTO conversations (id, anchor_kind, anchor_ref, title, chat_model, prompt_version, created_at, updated_at)
         VALUES (@id, @anchor_kind, @anchor_ref, @title, @chat_model, @prompt_version, @created_at, @updated_at)`
      ).run(row);
      return row;
    },

    getById(id) {
      return (
        (db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
          | ConversationRow
          | undefined) ?? null
      );
    },

    list(limit = 50) {
      return db
        .prepare(
          `SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC LIMIT ?`
        )
        .all(limit) as ConversationRow[];
    },

    deleteById(id) {
      db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    },

    addUserMessage({ id, conversationId, text }) {
      const now = nowIso();
      const row: MessageRow = {
        id: id ?? randomUUID(),
        conversation_id: conversationId,
        role: "user",
        text,
        claims: "[]",
        run: null,
        status: "done",
        created_at: now,
      };
      const write = db.transaction(() => {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, text, claims, run, status, created_at)
           VALUES (@id, @conversation_id, @role, @text, @claims, @run, @status, @created_at)`
        ).run(row);
        touch.run(now, conversationId);
      });
      write();
      return row;
    },

    upsertAssistantMessage({ id, conversationId, status, text, claims, turn }) {
      const now = nowIso();
      const write = db.transaction(() => {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, text, claims, run, status, created_at)
           VALUES (@id, @conversation_id, 'assistant', @text, @claims, @run, @status, @created_at)
           ON CONFLICT(id) DO UPDATE SET
             text = excluded.text,
             claims = excluded.claims,
             run = excluded.run,
             status = excluded.status`
        ).run({
          id,
          conversation_id: conversationId,
          text,
          claims: JSON.stringify(claims),
          run: JSON.stringify(turn),
          status,
          created_at: now,
        });
        touch.run(now, conversationId);
      });
      write();
    },

    getMessage(id) {
      return (
        (db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined) ??
        null
      );
    },

    listMessages(conversationId, opts) {
      const limit = opts?.limit;
      if (limit === undefined) {
        return db
          .prepare(
            `SELECT * FROM messages WHERE conversation_id = ?
             ORDER BY created_at ASC, rowid ASC`
          )
          .all(conversationId) as MessageRow[];
      }
      // Les `limit` **derniers** messages, rendus dans l'ordre chronologique. Le tri
      // décroissant se fait dans la requête (où `rowid` se résout sur la table) et le
      // retournement en mémoire : une sous-requête `SELECT *` n'expose pas `rowid`, donc
      // un `ORDER BY rowid` à l'extérieur échouerait (mesuré).
      const rows = db
        .prepare(
          `SELECT * FROM messages WHERE conversation_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`
        )
        .all(conversationId, limit) as MessageRow[];
      return rows.reverse();
    },
  };
}
