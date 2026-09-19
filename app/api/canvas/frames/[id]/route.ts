import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createCanvasRepo, MAX_FRAME_LABEL, type FramePatch } from "@/lib/repositories/canvas";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * PATCH /api/canvas/frames/:id — déplace, redimensionne ou renomme un conteneur.
 *
 * **Un déplacement décale ses membres du même delta, côté serveur** (même
 * transaction) : le client n'envoie pas la position des membres, sinon deux
 * fenêtres — ou un rejeu — les déplaceraient deux fois.
 * 200 {frame, shifted} · 400 géométrie invalide · 404.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "invalid_payload", message: "JSON invalide" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: FramePatch = {};

  if (b.label !== undefined) {
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (!label || label.length > MAX_FRAME_LABEL) {
      return NextResponse.json(
        { code: "invalid_label", message: `label requis, ≤ ${MAX_FRAME_LABEL} caractères` },
        { status: 400 }
      );
    }
    patch.label = label;
  }
  for (const key of ["x", "y", "width", "height", "z"] as const) {
    if (b[key] === undefined) continue;
    if (!isNum(b[key])) {
      return NextResponse.json(
        { code: "invalid_geometry", message: `${key} doit être un nombre` },
        { status: 400 }
      );
    }
    patch[key] = b[key] as number;
  }
  if (patch.width !== undefined && patch.width <= 0) {
    return NextResponse.json({ code: "invalid_geometry", message: "width > 0" }, { status: 400 });
  }
  if (patch.height !== undefined && patch.height <= 0) {
    return NextResponse.json({ code: "invalid_geometry", message: "height > 0" }, { status: 400 });
  }
  if (b.color !== undefined) {
    if (b.color !== null && typeof b.color !== "string") {
      return NextResponse.json({ code: "invalid_color", message: "color doit être une chaîne ou null" }, { status: 400 });
    }
    patch.color = b.color as string | null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ code: "invalid_payload", message: "aucun champ à modifier" }, { status: 400 });
  }

  const result = createCanvasRepo(getDb()).updateFrame(id, patch);
  if (!result) return NextResponse.json({ code: "not_found" }, { status: 404 });
  return NextResponse.json(result);
}

/**
 * DELETE /api/canvas/frames/:id — **dissout** le conteneur : il disparaît, ses
 * membres gardent exactement leur position (aucun nœud n'est supprimé ni déplacé).
 * 204 · 404.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const dissolved = createCanvasRepo(getDb()).dissolveFrame(id);
  if (!dissolved) return NextResponse.json({ code: "not_found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
