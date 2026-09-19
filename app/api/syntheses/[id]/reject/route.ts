import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createSynthesisReviewService } from "@/lib/synth/review-service";

/**
 * POST /api/syntheses/:id/reject — AC3 : le rejet est **persistant**, et une synthèse
 * rejetée ne réapparaît pas dans le feed (`state = 'proposed'` est le défaut de lecture).
 *
 * 200 avec la synthèse mise à jour · 404 si inconnue · 409 si déjà tranchée.
 *
 * **Pas de motif de rejet**, contrairement aux suggestions (US-06) : la table `syntheses`
 * du schéma v1.4 (migration `002`) n'a pas de colonne pour le porter, et l'amendement ne
 * le demande pas (AC3 dit seulement « accepter/rejeter est persistant »). Ajouter une
 * colonne à une table livrée pour un champ que personne ne lit serait une migration pour
 * rien — si le besoin d'analyser les rejets apparaît, il sera tranché comme une évolution
 * de schéma, pas glissé ici.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = createSynthesisReviewService(getDb()).decide(id, "reject");
  if (!result.ok) {
    return NextResponse.json(
      { code: result.reason },
      { status: result.reason === "not_found" ? 404 : 409 }
    );
  }
  return NextResponse.json(result.synthesis);
}
