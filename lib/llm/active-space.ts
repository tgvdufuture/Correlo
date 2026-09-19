import { getConfig } from "../config/env.ts";
import { EMBEDDING_DIMENSIONS, EMBEDDING_VERSION } from "./embedding-codec.ts";
import type { EmbeddingSpace } from "./embedding-space.ts";

/**
 * Espace vectoriel **actif** : le réglage (`EMBED_PROVIDER` + modèle) qui définit
 * dans quel espace le corpus est écrit.
 *
 * Ce module vit à part de `lib/llm/llm.ts` pour une raison précise : il doit être
 * chargeable par un CLI (`node scripts/reembed.mjs`). Node retire les types mais ne
 * résout pas l'alias `@/`, et refuse les propriétés de constructeur — d'où des imports
 * **relatifs avec extension** ici, comme le fait déjà `scripts/discover.mjs` avec
 * `lib/discover/prompts.ts`. Sans cela, le CLI devrait recalculer l'espace de son côté,
 * et une divergence entre les deux calculs produirait une clé d'idempotence fausse.
 *
 * Rappel : l'espace actif ne décrit pas la base. Des fragments peuvent y avoir été
 * écrits dans un autre espace (bascule non suivie d'une re-vectorisation) — c'est
 * `listCorpusSpaces` qui le dit, et `npm run reembed` qui le corrige.
 */
export function getEmbeddingSpace(): EmbeddingSpace {
  const c = getConfig();
  if (c.EMBED_PROVIDER === "api") {
    return {
      model: c.NVIDIA_EMBED_MODEL,
      dimensions: c.NVIDIA_EMBED_DIMENSIONS,
      version: apiEmbeddingVersion(c.NVIDIA_EMBED_MODEL),
    };
  }
  return {
    model: c.OLLAMA_EMBED_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    version: EMBEDDING_VERSION,
  };
}

/** `nvidia/nemotron-3-embed-1b` → `nvidia-nemotron-3-embed-1b-v1` (colonne `embedding_version`). */
export function apiEmbeddingVersion(model: string): string {
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}-v1`;
}
