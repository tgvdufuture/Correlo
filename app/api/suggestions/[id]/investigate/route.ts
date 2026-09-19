import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createJobsRepo } from "@/lib/repositories/jobs";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { investigationJobKey, investigationJobPayload } from "@/lib/agent/queue";

/**
 * POST /api/suggestions/:id/investigate — ouvre une investigation (Phase 4, US-09).
 *
 * **202 Accepted** : l'enquête est un travail de fond (jusqu'à 5 appels LLM), menée
 * par le worker — la réponse dit que la question est prise en compte, pas qu'elle
 * est résolue. L'écran suit ensuite `GET /api/suggestions/:id/investigation`.
 *
 * L'enquête est **idempotente par question** (clé = suggestion + version de prompt +
 * réglage du chat) : cliquer deux fois ne crée pas deux enquêtes, et relancer une
 * question déjà traitée la rejoue depuis le cache de prompt (mêmes étapes, 0 appel).
 *
 * L'`id` de l'investigation est celui du **job** : le schéma v1.2 n'a pas de colonne
 * `job_id` et une enquête appartient à une question — un rejeu met donc à jour sa
 * ligne au lieu d'en empiler une seconde.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  // 404 avant d'enfiler : une suggestion supprimée entre-temps ne doit pas produire
  // un job qui échouerait sur la clé étrangère d'`investigations`
  if (!createSuggestionsRepo(db).getById(id)) {
    return NextResponse.json({ code: "not_found" }, { status: 404 });
  }
  const job = createJobsRepo(db).createJob({
    kind: "investigation",
    payload: investigationJobPayload(id),
    sourceId: null,
    idempotencyKey: investigationJobKey(id),
  });
  return NextResponse.json(
    { status: "pending", investigation_id: job.id, job_id: job.id },
    { status: 202 }
  );
}
