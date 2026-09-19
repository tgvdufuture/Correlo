import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  createCanvasRepo,
  type CanvasItemKind,
  type ItemRef,
} from "@/lib/repositories/canvas";

const KINDS: CanvasItemKind[] = ["construction", "source"];

interface Body {
  items?: { kind?: unknown; ref?: unknown }[];
  /** `false` retire les éléments du conteneur (sans les déplacer). */
  assign?: unknown;
}

/**
 * POST /api/canvas/frames/:id/members — range des éléments dans un conteneur, ou
 * les en retire (`assign: false`). Un conteneur mélange librement fichiers et
 * Constructions. L'appartenance ne déplace **jamais** un élément : c'est le
 * déplacement du conteneur qui les entraîne ensuite.
 * 200 {updated} · 400 · 404 si le conteneur n'existe pas.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ code: "invalid_payload", message: "JSON invalide" }, { status: 400 });
  }
  const raw = body?.items;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > 500 ||
    raw.some((i) => !KINDS.includes(i?.kind as CanvasItemKind) || typeof i.ref !== "string")
  ) {
    return NextResponse.json(
      {
        code: "invalid_payload",
        message: "attendu {items: [{kind, ref}], 1..500}",
      },
      { status: 400 }
    );
  }
  if (body.assign !== undefined && typeof body.assign !== "boolean") {
    return NextResponse.json({ code: "invalid_payload", message: "assign doit être un booléen" }, { status: 400 });
  }

  const canvas = createCanvasRepo(getDb());
  const frames = canvas.getState().frames;
  if (!frames.some((f) => f.id === id)) {
    return NextResponse.json({ code: "not_found" }, { status: 404 });
  }
  const items: ItemRef[] = raw.map((i) => ({
    kind: i.kind as CanvasItemKind,
    ref: i.ref as string,
  }));
  const updated = canvas.assign(items, body.assign === false ? null : id);
  return NextResponse.json({ updated });
}
