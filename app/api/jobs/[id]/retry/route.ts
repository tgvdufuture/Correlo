import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createJobsRepo } from "@/lib/repositories/jobs";

/** POST /api/jobs/:id/retry — relance manuelle : 200 re-pending · 404 · 409 max attempts. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const jobs = createJobsRepo(db);
  const res = jobs.retry(id);
  if (!res.ok) {
    if (res.reason === "not_found") {
      return NextResponse.json({ code: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      { code: "max_attempts", message: "Nombre maximal de tentatives atteint" },
      { status: 409 }
    );
  }
  return NextResponse.json({ status: "pending" });
}