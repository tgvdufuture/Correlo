import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createReviewService } from "@/lib/discover/review-service";
import type { FeedItem } from "@/lib/repositories/suggestions";

const STATES = ["open", "discovered", "shown", "opened", "accepted", "rejected"] as const;

/**
 * GET /api/suggestions?state= — feed (AC1) : **une seule suggestion par
 * (pair_key, relation_type)**, tier le plus élevé, tie-break la plus récente,
 * puis tri par tier. Chaque ligne porte ses 2 fragments (source, locator, texte)
 * pour l'affichage US-05 AC1.
 *
 * Effet de bord assumé : les suggestions réellement servies passent de
 * `discovered` à `shown` — c'est la définition de l'exposition, et la métrique
 * « ≥ 40 % de suggestions ouvertes » en dépend.
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

  const service = createReviewService(getDb());
  const feed = service.feed({
    state: (rawState ?? "open") as "open",
    ...(limit === undefined ? {} : { limit }),
  });
  return NextResponse.json(feed satisfies FeedItem[]);
}
