import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createReviewService } from "@/lib/discover/review-service";

/**
 * POST /api/suggestions/:id/accept — US-07 : crée une Construction depth = 1
 * avec `parent_source_ids`, `evidence_fragment_ids` et `provenance_snapshot`
 * (copie des preuves au moment T), statut = min_rang(INFERENCE, statut suggestion).
 * 201 la Construction · 409 si déjà intégrée · 404 · 422 si les preuves ont disparu.
 *
 * Corps **facultatif** `{x, y}` : la place de la Construction sur le canvas (le
 * client y met le milieu des deux fichiers reliés). Illisible ou absent ⇒ première
 * place libre, jamais une erreur : une position n'est pas une donnée métier.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let place: { x: number; y: number } | undefined;
  try {
    const body = (await req.json()) as { x?: unknown; y?: unknown } | null;
    if (
      body &&
      typeof body.x === "number" &&
      typeof body.y === "number" &&
      Number.isFinite(body.x) &&
      Number.isFinite(body.y)
    ) {
      place = { x: body.x, y: body.y };
    }
  } catch {
    place = undefined;
  }

  const result = createReviewService(getDb()).accept(id, place);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : result.reason === "fragments_missing" ? 422 : 409;
    return NextResponse.json({ code: result.reason }, { status });
  }
  return NextResponse.json(result.construction, { status: 201 });
}
