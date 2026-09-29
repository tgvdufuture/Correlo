import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createCanvasRepo, MAX_FRAME_LABEL, type CanvasFrameKind } from "@/lib/repositories/canvas";
import { createCanvasesRepo } from "@/lib/repositories/canvases";

const KIND: CanvasFrameKind[] = ["frame", "group"];

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * POST /api/canvas/frames — crée un **cadre** (panneau titré) ou un **groupe**
 * (contour pointillé). Les deux déplacent leurs membres ; seul le rendu diffère.
 * 201 le conteneur créé.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "invalid_payload", message: "JSON invalide" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind;
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (!KIND.includes(kind as CanvasFrameKind)) {
    return NextResponse.json(
      { code: "invalid_kind", message: "kind ∈ {frame, group}" },
      { status: 400 }
    );
  }
  if (!label || label.length > MAX_FRAME_LABEL) {
    return NextResponse.json(
      { code: "invalid_label", message: `label requis, ≤ ${MAX_FRAME_LABEL} caractères` },
      { status: 400 }
    );
  }
  if (!isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height)) {
    return NextResponse.json(
      { code: "invalid_geometry", message: "x, y, width, height numériques requis" },
      { status: 400 }
    );
  }
  if (b.width <= 0 || b.height <= 0) {
    return NextResponse.json(
      { code: "invalid_geometry", message: "width et height strictement positifs" },
      { status: 400 }
    );
  }
  if (b.color !== undefined && b.color !== null && typeof b.color !== "string") {
    return NextResponse.json({ code: "invalid_color", message: "color doit être une chaîne" }, { status: 400 });
  }

  // v1.6 §14.2 : un cadre est posé dans le tableau qui l'a demandé (`?canvas=`),
  // l'atelier restant le défaut. Un tableau inconnu est refusé avant l'écriture.
  const requested = new URL(req.url).searchParams.get("canvas");
  const db = getDb();
  if (requested && !createCanvasesRepo(db).getById(requested)) {
    return NextResponse.json({ code: "canvas_not_found" }, { status: 404 });
  }
  const frame = createCanvasRepo(db, requested ?? undefined).createFrame({
    label,
    kind: kind as CanvasFrameKind,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    color: (b.color as string | null | undefined) ?? null,
  });
  return NextResponse.json(frame, { status: 201 });
}
