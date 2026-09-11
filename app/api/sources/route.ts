import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, ensureDataDirs, getDb } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createJobsRepo, idempotencyKey } from "@/lib/repositories/jobs";
import { CHUNKER_VERSION } from "@/lib/ingest/chunker";
import { normalizeText } from "@/lib/ingest/normalizer";
import { extractPdfPages, parseTextBuffer } from "@/lib/ingest/parsers";

/**
 * POST /api/sources — import TEXT/PDF (multipart) ou URL (JSON).
 * 201 {id, content_hash, ingest_status:"pending"} · 409 doublon · 422 PDF sans texte · 400 invalide.
 * La réponse est rapide : le travail (chunk/embed) se fait en job asynchrone (F1.5 AC2).
 */
export async function POST(req: NextRequest) {
  ensureDataDirs();
  const db = getDb();
  const sources = createSourcesRepo(db);
  const jobs = createJobsRepo(db);
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const type = form.get("type");
    const file = form.get("file");
    if (type !== "TEXT" && type !== "PDF") {
      return NextResponse.json({ code: "invalid_payload", message: "type doit être TEXT ou PDF" }, { status: 400 });
    }
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ code: "invalid_payload", message: "fichier manquant ou vide" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const title = (typeof form.get("title") === "string" ? (form.get("title") as string).trim() : "") || file.name;

    if (type === "TEXT") {
      const rawContent = normalizeText(parseTextBuffer(buf));
      if (!rawContent.trim()) {
        return NextResponse.json({ code: "empty_extraction", message: "Fichier texte vide" }, { status: 400 });
      }
      const contentHash = sha256Hex(rawContent);
      if (sources.getByContentHash(contentHash)) {
        return NextResponse.json({ code: "duplicate_content", message: "Contenu déjà présent" }, { status: 409 });
      }
      const id = randomUUID();
      fs.writeFileSync(path.join(DATA_DIR, `${id}.txt`), rawContent);
      sources.create({
        id,
        type: "TEXT",
        title,
        canonical_path: `data/sources/${id}.txt`,
        raw_content: rawContent,
        content_hash: contentHash,
      });
      enqueueIngest(jobs, id, contentHash, {});
      return NextResponse.json({ id, content_hash: contentHash, ingest_status: "pending" }, { status: 201 });
    }

    // PDF : copie + extraction à la requête (422 si sans texte, hash dans la 201)
    const id = randomUUID();
    const pdfPath = path.join(DATA_DIR, `${id}.pdf`);
    fs.writeFileSync(pdfPath, buf);
    let pages;
    try {
      pages = await extractPdfPages(buf);
    } catch {
      fs.rmSync(pdfPath, { force: true });
      return NextResponse.json({ code: "pdf_no_text", message: "texte non extractible" }, { status: 422 });
    }
    const pageMap: { offset: number; page_num: number }[] = [];
    const pageTexts: string[] = [];
    let offset = 0;
    for (const p of pages) {
      const t = normalizeText(p.text).trim();
      if (!t.length) continue;
      pageMap.push({ offset, page_num: p.num });
      pageTexts.push(t);
      offset += t.length + 2; // '\n\n' entre pages
    }
    const rawContent = pageTexts.join("\n\n");
    if (rawContent.length < 100) {
      fs.rmSync(pdfPath, { force: true });
      return NextResponse.json({ code: "pdf_no_text", message: "texte non extractible" }, { status: 422 });
    }
    const contentHash = sha256Hex(rawContent);
    if (sources.getByContentHash(contentHash)) {
      fs.rmSync(pdfPath, { force: true });
      return NextResponse.json({ code: "duplicate_content", message: "Contenu déjà présent" }, { status: 409 });
    }
    sources.create({
      id,
      type: "PDF",
      title,
      canonical_path: `data/sources/${id}.pdf`,
      raw_content: rawContent,
      content_hash: contentHash,
    });
    enqueueIngest(jobs, id, contentHash, { page_map: pageMap });
    return NextResponse.json({ id, content_hash: contentHash, ingest_status: "pending" }, { status: 201 });
  }

  // JSON : {type:"URL", url}
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "invalid_payload", message: "JSON invalide" }, { status: 400 });
  }
  const { type, url } = (body ?? {}) as { type?: unknown; url?: unknown };
  if (type !== "URL" || typeof url !== "string") {
    return NextResponse.json({ code: "invalid_payload", message: "attendu {type:\"URL\", url}" }, { status: 400 });
  }
  let normalizedUrl: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocole");
    normalizedUrl = u.toString();
  } catch {
    return NextResponse.json({ code: "invalid_url", message: "URL invalide" }, { status: 400 });
  }
  // hash placeholder unique par URL : le vrai hash est calculé par le job d'ingest
  // (doublon de contenu détecté alors : rien n'est créé).
  const placeholderHash = sha256Hex(`url:${normalizedUrl}`);
  if (sources.getByContentHash(placeholderHash)) {
    return NextResponse.json({ code: "duplicate_content", message: "URL déjà importée" }, { status: 409 });
  }
  const id = randomUUID();
  sources.create({
    id,
    type: "URL",
    title: normalizedUrl,
    canonical_path: normalizedUrl,
    raw_content: "",
    content_hash: placeholderHash,
  });
  enqueueIngest(jobs, id, placeholderHash, { url: normalizedUrl });
  return NextResponse.json({ id, content_hash: placeholderHash, ingest_status: "pending" }, { status: 201 });
}

/**
 * GET /api/sources — bibliothèque avec ingest_status dérivé des jobs ingest
 * (le plus récent fait foi, lease expiré ⇒ pending) et summary_status.
 */
export async function GET() {
  const db = getDb();
  const sources = createSourcesRepo(db);
  return NextResponse.json(sources.list());
}

function enqueueIngest(
  jobs: ReturnType<typeof createJobsRepo>,
  sourceId: string,
  contentHash: string,
  payload: { url?: string; page_map?: { offset: number; page_num: number }[] }
): void {
  jobs.createJob({
    kind: "ingest",
    payload: { source_id: sourceId, ...payload },
    sourceId,
    idempotencyKey: idempotencyKey(["ingest", sourceId, contentHash, CHUNKER_VERSION]),
  });
  // le job summary est chaîné à la fin de l'ingestion (voir ingest-service)
}