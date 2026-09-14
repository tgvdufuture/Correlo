import type { Db } from "@/lib/db/client";
import type { PromptCache } from "@/lib/llm/types";

/**
 * Cache de prompt persisté (migration 004).
 *
 * Raison d'être : rejouer un même run doit produire les mêmes énoncés, donc
 * `content_sig` doit pouvoir dédupliquer. Sans cache, le modèle reformule et la
 * dédup est aveugle. Le cache ne sert **que** des réponses déjà validées par le
 * schéma Zod du service appelant, et uniquement pour la clé exacte
 * (modèle | version de prompt | messages).
 */
export function createPromptCache(db: Db): PromptCache {
  const select = db.prepare("SELECT value FROM llm_cache WHERE key = ?");
  const upsert = db.prepare(
    `INSERT INTO llm_cache (key, value, created_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  return {
    get(key: string): unknown | undefined {
      const row = select.get(key) as { value: string } | undefined;
      if (!row) return undefined;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        // entrée illisible : on ne sert pas une réponse douteuse
        return undefined;
      }
    },
    set(key: string, value: unknown): void {
      upsert.run(key, JSON.stringify(value), new Date().toISOString());
    },
  };
}
