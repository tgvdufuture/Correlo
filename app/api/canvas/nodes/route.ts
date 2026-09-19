import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  createCanvasRepo,
  type CanvasItemKind,
  type ItemPosition,
} from "@/lib/repositories/canvas";

const KINDS: CanvasItemKind[] = ["construction", "source"];

interface Body {
  items?: {
    kind?: unknown;
    ref?: unknown;
    x?: unknown;
    y?: unknown;
    frame_id?: unknown;
  }[];
}

/** Nombre fini (une coordonnée n'est jamais NaN, ni infinie). */
function isCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * PATCH /api/canvas/nodes — déplacement d'éléments en **lot** (glisser une
 * sélection = une seule requête). Les positions sont **absolues** : rejouer la
 * requête ne déplace rien de plus.
 *
 * `frame_id` absent = appartenance inchangée ; `frame_id: null` = sortir du
 * conteneur. Un élément inconnu est ignoré (compté 0) plutôt que créé : une
 * position n'invente ni un fichier ni une Construction.
 */
export async function PATCH(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ code: "invalid_payload", message: "JSON invalide" }, { status: 400 });
  }
  const nodes = body?.items;
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 500) {
    return NextResponse.json(
      {
        code: "invalid_payload",
        message: "attendu {items: [{kind, ref, x, y}], 1..500}",
      },
      { status: 400 }
    );
  }
  const items: ItemPosition[] = [];
  for (const n of nodes) {
    if (!KINDS.includes(n?.kind as CanvasItemKind) || typeof n.ref !== "string" || !n.ref) {
      return NextResponse.json(
        { code: "invalid_payload", message: "chaque élément exige kind ∈ {construction, source} et ref" },
        { status: 400 }
      );
    }
    if (!isCoord(n.x) || !isCoord(n.y)) {
      return NextResponse.json(
        { code: "invalid_payload", message: "x et y numériques requis" },
        { status: 400 }
      );
    }
    if (n.frame_id !== undefined && n.frame_id !== null && typeof n.frame_id !== "string") {
      return NextResponse.json(
        { code: "invalid_payload", message: "frame_id doit être une chaîne ou null" },
        { status: 400 }
      );
    }
    items.push({
      kind: n.kind as CanvasItemKind,
      ref: n.ref,
      x: n.x,
      y: n.y,
      ...(n.frame_id === undefined ? {} : { frame_id: n.frame_id as string | null }),
    });
  }

  const moved = createCanvasRepo(getDb()).moveItems(items);
  return NextResponse.json({ requested: items.length, moved });
}
