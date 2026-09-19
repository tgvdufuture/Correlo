import type { Db } from "@/lib/db/client";
import { createConstructionsRepo } from "@/lib/repositories/constructions";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";

/**
 * **Péremption d'une source** (PRD §205, US-08 AC2, Phase 5B AC4) : quand les
 * fragments d'une source disparaissent — suppression (`DELETE /api/sources/:id`) ou
 * ré-ingestion (`scripts/reingest.mjs`) —, tout ce qui cite ses fragments passe
 * `stale = 1` : les Constructions **et** les synthèses.
 *
 * Pourquoi ce petit module plutôt que deux appels sur place : les deux appelants
 * (la route de suppression et le script de ré-ingestion) doivent marquer **les deux
 * entités**, et le 2026-09-18 le script marquait les Constructions et le dépôt des
 * synthèses portait un `markStaleBySource`… **que personne n'appelait**. Une règle
 * écrite à deux endroits finit par n'exister qu'à un seul : ici, l'oubli d'une entité
 * se voit dans la signature, et les appelants n'ont plus à savoir quelles entités
 * citent des fragments.
 *
 * Les deux marquages lisent `provenance_snapshot` (jamais une jointure) : la
 * péremption reste calculable **après** la disparition des fragments, et le snapshot
 * reste affichable tel quel.
 */
export interface StaleMarkResult {
  constructions: number;
  syntheses: number;
}

export function markSourceDependentsStale(db: Db, sourceId: string): StaleMarkResult {
  const constructions = createConstructionsRepo(db).markStaleForSource(sourceId);
  const syntheses = createSynthesesRepo(db).markStaleBySource(sourceId);
  return { constructions, syntheses };
}
