import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createConstructionsRepo } from "@/lib/repositories/constructions";

/**
 * GET /api/constructions — les Constructions du canvas (US-07/US-08).
 * Chaque ligne porte son `provenance_snapshot` **décodé** : source, hash,
 * fragment, locator et texte tels qu'ils étaient à l'acceptation, donc
 * affichables même après suppression ou ré-ingestion de la source (US-08 AC1),
 * avec `stale` pour signaler la péremption (US-08 AC2).
 */
export async function GET() {
  const constructions = createConstructionsRepo(getDb());
  return NextResponse.json(constructions.list());
}
