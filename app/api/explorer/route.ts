import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createExplorerService } from "@/lib/explorer/explorer-service";

/**
 * GET /api/explorer — le snapshot de l'explorateur (v1.6 §14, étape 2).
 *
 * Tout ce que l'écran dessine : les tableaux (arbre, compteurs, dossiers), les
 * frames et les **nodes positionnés** (la vignette du plan, AC2), les conversations
 * liées, l'activité récente dérivée. Lecture pure : appeler cette route ne répare
 * ni ne place rien — l'état montré est l'état stocké, et c'est le dépôt de
 * l'atelier qui purge/complete quand **son** écran s'ouvre.
 *
 * `no-store` : le snapshot suit les écritures des autres écrans (une conversation
 * qui tourne fait bouger la récence) — un cache ici montrerait un passé.
 */
export async function GET() {
  const snapshot = createExplorerService(getDb()).snapshot();
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
