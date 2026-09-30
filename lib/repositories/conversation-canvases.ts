import { nowIso, type Db } from "@/lib/db/client";
import { ensureNotFolder } from "@/lib/repositories/canvases";

/**
 * Multi-ancrage des conversations (v1.6 §14.3, migration 010).
 *
 * `conversations` (009) porte encore son ancrage historique (`anchor_kind` /
 * `anchor_ref`) — lisible pour les conversations existantes, règle de lecture :
 * « ancré sur le corpus » tant qu'aucune liaison n'existe. La table de liaison
 * ajoute ce que la ligne ne peut pas dire : une conversation qui **traverse**
 * plusieurs tableaux. La PK composée rend un doublon impossible au niveau le plus
 * bas ; les CASCADE (des deux côtés) disent la survie : supprimer un canvas
 * détache ses conversations (elles restent), supprimer une conversation emporte
 * ses liaisons.
 */
export interface ConversationCanvasRepo {
  /** Tableaux liés, dans l'ordre de la collection (l'écran affiche les pastilles). */
  listForConversation(conversationId: string): string[];
  /** Conversations liées, les plus récemment actives d'abord (l'aperçu les liste). */
  listForCanvas(canvasId: string, limit?: number): { id: string; title: string; updated_at: string }[];
  /** Idempotent : re-lier une liaison existante ne déplace ni ne double rien. */
  link(conversationId: string, canvasId: string): boolean;
  unlink(conversationId: string, canvasId: string): boolean;
  /** Remplace l'ensemble des liaisons (l'écran coche/décoche, on pose l'état final). */
  setLinks(conversationId: string, canvasIds: string[]): { linked: number; unlinked: number };
}

export function createConversationCanvasRepo(db: Db): ConversationCanvasRepo {
  const ORDER_SQL = `ORDER BY c.pinned DESC, c.position ASC, c.created_at ASC`;

  return {
    listForConversation(conversationId) {
      return (
        db
          .prepare(
            `SELECT cc.canvas_id FROM conversation_canvases cc
             JOIN canvases c ON c.id = cc.canvas_id
             WHERE cc.conversation_id = ?
             ${ORDER_SQL}`
          )
          .all(conversationId) as { canvas_id: string }[]
      ).map((r) => r.canvas_id);
    },

    listForCanvas(canvasId, limit = 20) {
      return db
        .prepare(
          `SELECT co.id, co.title, co.updated_at FROM conversation_canvases cc
           JOIN conversations co ON co.id = cc.conversation_id
           WHERE cc.canvas_id = ?
           ORDER BY co.updated_at DESC, co.rowid DESC
           LIMIT ?`
        )
        .all(canvasId, limit) as { id: string; title: string; updated_at: string }[];
    },

    link(conversationId, canvasId) {
      const conv = db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error(`conversation_canvases : conversation inconnue (${conversationId})`);
      const cv = db.prepare("SELECT 1 FROM canvases WHERE id = ?").get(canvasId);
      if (!cv) throw new Error(`conversation_canvases : tableau inconnu (${canvasId})`);
      // une conversation s'ancre sur une **surface de travail** — un dossier n'a
      // rien à discuter (il ne porte aucun objet) ; garde partagée, jamais dupliquée
      ensureNotFolder(db, canvasId, "conversation");
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO conversation_canvases (conversation_id, canvas_id, created_at)
           VALUES (?, ?, ?)`
        )
        .run(conversationId, canvasId, nowIso());
      return res.changes === 1;
    },

    unlink(conversationId, canvasId) {
      return (
        db
          .prepare(
            "DELETE FROM conversation_canvases WHERE conversation_id = ? AND canvas_id = ?"
          )
          .run(conversationId, canvasId).changes === 1
      );
    },

    setLinks(conversationId, canvasIds) {
      const tx = db.transaction(() => {
        const unique = [...new Set(canvasIds)];
        const before = (
          db
            .prepare("SELECT canvas_id FROM conversation_canvases WHERE conversation_id = ?")
            .all(conversationId) as { canvas_id: string }[]
        ).map((r) => r.canvas_id);
        let linked = 0;
        const insert = db.prepare(
          `INSERT OR IGNORE INTO conversation_canvases (conversation_id, canvas_id, created_at)
           VALUES (?, ?, ?)`
        );
        for (const canvasId of unique) {
          linked += insert.run(conversationId, canvasId, nowIso()).changes;
        }
        let unlinked = 0;
        const remove = db.prepare(
          "DELETE FROM conversation_canvases WHERE conversation_id = ? AND canvas_id = ?"
        );
        for (const canvasId of before) {
          if (!unique.includes(canvasId)) unlinked += remove.run(conversationId, canvasId).changes;
        }
        return { linked, unlinked };
      });
      return tx();
    },
  };
}
