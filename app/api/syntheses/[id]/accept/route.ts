import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createSynthesisReviewService } from "@/lib/synth/review-service";

/**
 * POST /api/syntheses/:id/accept — AC3 : l'acceptation est **persistante**.
 *
 * 200 avec la synthèse mise à jour · 404 si inconnue · 409 si déjà tranchée.
 *
 * Ce que cette route **ne fait pas**, et c'est volontaire (AC5) : elle n'écrit rien dans
 * `constructions` ni sur le canvas. Une synthèse est multi-sources et son texte n'est pas
 * un claim de paire : le schéma v1.2 impose `constructions.suggestion_id NOT NULL`, donc
 * une synthèse ne *peut pas* devenir une Construction sans décision de modèle de données
 * — c'est la décision reportée en v1.4 (amendement §5). Accepter ici signifie « cette
 * synthèse est retenue » : elle sort de la file de propositions et reste consultable.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = createSynthesisReviewService(getDb()).decide(id, "accept");
  if (!result.ok) {
    return NextResponse.json(
      { code: result.reason },
      { status: result.reason === "not_found" ? 404 : 409 }
    );
  }
  return NextResponse.json(result.synthesis);
}
