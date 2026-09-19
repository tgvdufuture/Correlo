import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createSynthesisReviewService } from "@/lib/synth/review-service";
import type { SynthesisFeedState } from "@/lib/repositories/syntheses";

const STATES = ["proposed", "accepted", "rejected", "all"] as const;

/**
 * GET /api/syntheses?state=&limit= — feed des synthèses (Phase 5B AC1-AC2).
 *
 * Tri : **par thème puis `confidence`** (high → medium → low), la plus récente d'abord à
 * confiance égale (le tri vit dans le dépôt, une seule requête pour l'écran et pour le
 * validateur). Défaut `proposed` : une synthèse tranchée sort de la file de travail —
 * c'est la définition de « accepter/rejeter est persistant » (AC3).
 *
 * Chaque ligne porte ses preuves **vérifiées à la lecture** (fragment existant, source
 * et texte identiques) et son `provenance_snapshot` : l'écran n'a donc jamais besoin de
 * recomposer la provenance, et une preuve qui ne tient plus arrive marquée comme telle
 * (AC2/AC4) au lieu d'être servie comme une preuve.
 */
export async function GET(req: NextRequest) {
  const rawState = req.nextUrl.searchParams.get("state");
  if (rawState && !(STATES as readonly string[]).includes(rawState)) {
    return NextResponse.json(
      { code: "invalid_state", message: `state ∈ {${STATES.join(", ")}}` },
      { status: 400 }
    );
  }
  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    return NextResponse.json(
      { code: "invalid_limit", message: "limit doit être un entier entre 1 et 500" },
      { status: 400 }
    );
  }

  const service = createSynthesisReviewService(getDb());
  return NextResponse.json(
    service.feed({
      state: (rawState ?? "proposed") as SynthesisFeedState,
      ...(limit === undefined ? {} : { limit }),
    })
  );
}
