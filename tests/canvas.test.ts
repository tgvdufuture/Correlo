import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { createCanvasRepo } from "@/lib/repositories/canvas";
import { createReviewService } from "@/lib/discover/review-service";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { contentSig } from "@/lib/discover/epistemic";
import { createSourcesRepo } from "@/lib/repositories/sources";
import type { Db } from "@/lib/db/client";

/**
 * Canvas-atelier (Phase 3, volets canvas libre et fichiers) — migrations 006/007.
 *
 * Ce qui doit tenir, et qui casse silencieusement si on se trompe :
 *  - un **fichier déposé n'est jamais caché** : une source ingérée est placée ;
 *  - un **déplacement de conteneur** décale exactement ses membres — **fichiers
 *    comme Constructions** —, une seule fois ;
 *  - la **dissolution** ne déplace ni ne supprime rien ;
 *  - les positions sont **absolues** : rejouer une requête ne cumule pas les décalages ;
 *  - aucune ligne **orpheline** : l'entité supprimée emporte son élément (`prune`).
 */

const BEFORE_007 = [
  "001_v1_2.sql",
  "002_v1_3.sql",
  "003_jobs_synthesize.sql",
  "004_llm_cache.sql",
  "005_discover_runs.sql",
  "006_canvas.sql",
];

const migration = (name: string): string =>
  fs.readFileSync(path.join(process.cwd(), "migrations", name), "utf8");

/** Base au schéma d'avant la 007 (canvas limité aux Constructions). */
function dbBefore007(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of BEFORE_007) db.exec(migration(file));
  return db;
}

function insertConstruction(
  db: Db | Database.Database,
  id: string,
  over: { text?: string; stale?: number } = {}
) {
  db.prepare(
    `INSERT INTO constructions (id, text, epistemic_status, parent_source_ids,
       evidence_fragment_ids, suggestion_id, depth, stale, provenance_snapshot)
     VALUES (?, ?, 'INFERENCE', '["s1","s2"]', '["f1","f2"]', NULL, 1, ?, '[]')`
  ).run(id, over.text ?? `Construction ${id}`, over.stale ?? 0);
}

describe("migration 007 — le canvas accueille les fichiers", () => {
  it("reprend la disposition de la 006 et place les sources ingérées, sans chevauchement", () => {
    const db = dbBefore007();
    // des positions distinctes avant la 007 (sinon on ne testerait que le décalage)
    const before: [string, number, number][] = [
      ["c1", 10, 20],
      ["c2", 350, 20],
      ["c3", 10, 280],
    ];
    for (const [id, x, y] of before) {
      insertConstruction(db, id);
      db.prepare(
        `INSERT INTO canvas_nodes (construction_id, x, y, z, frame_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'now', 'now')`
      ).run(id, x, y, 1);
    }
    const withFragments = makeTextSource(db, "Contenu ingéré, un peu long pour découper.");
    makeFragment(db, { sourceId: withFragments, text: "Fragment du fichier ingéré." });
    const withoutFragments = makeTextSource(db, "Fichier jamais ingéré.");
    db.prepare(
      `INSERT INTO canvas_frames (id, label, kind, x, y, width, height, color, z, created_at, updated_at)
       VALUES ('fr1', 'Cadre', 'frame', 0, 0, 400, 300, NULL, 1, 'now', 'now')`
    ).run();
    db.prepare("UPDATE canvas_nodes SET frame_id = 'fr1' WHERE construction_id = 'c1'").run();

    db.exec(migration("007_canvas_items.sql"));

    // la table de la 006 disparaît, ses lignes sont reprises
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'canvas_nodes'").get()).toBeUndefined();
    const items = db
      .prepare("SELECT item_kind, item_ref, x, y, frame_id FROM canvas_items ORDER BY item_kind, z")
      .all() as { item_kind: string; item_ref: string; x: number; y: number; frame_id: string | null }[];

    // les 3 Constructions sont reprises, leur appartenance intacte, leur y descendu
    const constructions = items.filter((i) => i.item_kind === "construction");
    expect(constructions.map((c) => c.item_ref).sort()).toEqual(["c1", "c2", "c3"]);
    expect(constructions.every((c) => c.y > 20)).toBe(true);
    expect(constructions.find((c) => c.item_ref === "c1")?.frame_id).toBe("fr1");

    // seule la source **ingérée** est placée
    expect(items.filter((i) => i.item_kind === "source").map((s) => s.item_ref)).toEqual([
      withFragments,
    ]);
    expect(items.some((i) => i.item_ref === withoutFragments)).toBe(false);

    // aucun chevauchement : 4 emplacements distincts
    expect(new Set(items.map((i) => `${i.x}:${i.y}`)).size).toBe(items.length);
    db.close();
  });

  it("la provenance et le `stale` restent lisibles : la 007 ne touche pas aux tables verrouillées", () => {
    const db = dbBefore007();
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const before = { sources: columns("sources"), constructions: columns("constructions") };

    db.exec(migration("007_canvas_items.sql"));

    expect(columns("sources")).toEqual(before.sources);
    expect(columns("constructions")).toEqual(before.constructions);
    db.close();
  });
});

describe("dépôt canvas — fichiers et Constructions", () => {
  it("place une Construction qui n'a pas de disposition (jamais invisible)", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    insertConstruction(db, "c2");
    const canvas = createCanvasRepo(db);

    expect(canvas.placeMissing()).toBe(2);
    const { items } = canvas.getState();
    expect(items).toHaveLength(2);
    expect(items.every((i) => Number.isFinite(i.x) && Number.isFinite(i.y))).toBe(true);
    // idempotent : un second passage ne crée ni ne déplace rien
    const before = items.map((i) => `${i.ref}:${i.x}:${i.y}`);
    expect(canvas.placeMissing()).toBe(0);
    expect(canvas.getState().items.map((i) => `${i.ref}:${i.x}:${i.y}`)).toEqual(before);
  });

  it("place les sources ingérées, et seulement elles", () => {
    const { db } = makeTestDb();
    const ingested = makeTextSource(db, "Contenu du fichier ingéré.");
    makeFragment(db, { sourceId: ingested, text: "Fragment ingéré." });
    const waiting = makeTextSource(db, "Contenu du fichier en attente d'ingestion.");

    const canvas = createCanvasRepo(db);
    expect(canvas.placeMissing()).toBe(1);
    const { items } = canvas.getState();
    expect(items.map((i) => i.ref)).toEqual([ingested]);
    expect(items.some((i) => i.ref === waiting)).toBe(false);
    // elle reste absente après une seconde lecture, et rien ne casse
    expect(canvas.getState().items).toHaveLength(1);
  });

  it("expose le fichier tel que la bibliothèque le décrit (statut, fragments)", () => {
    const { db } = makeTestDb();
    const id = makeTextSource(db, "Contenu du fichier.", "Titre lisible");
    makeFragment(db, { sourceId: id, text: "Fragment A." });
    makeFragment(db, { sourceId: id, text: "Fragment B.", chunkIndex: 1 });

    const item = createCanvasRepo(db).getState().items[0];
    expect(item.kind).toBe("source");
    if (item.kind !== "source") return;
    expect(item.source.title).toBe("Titre lisible");
    expect(item.source.fragment_count).toBe(2);
    expect(["pending", "running", "done"]).toContain(item.source.ingest_status);
  });

  it("pose un fichier déposé à l'endroit exact du lâcher", () => {
    const { db } = makeTestDb();
    const id = makeTextSource(db, "Contenu déposé.");
    const canvas = createCanvasRepo(db);
    canvas.placeAt("source", id, 742, 318);

    const item = canvas.getState().items[0];
    expect({ x: item.x, y: item.y }).toEqual({ x: 742, y: 318 });
  });

  it("`placeAt` ne réécrit pas une position déjà prise (un dépôt rejoué ne bouge rien)", () => {
    const { db } = makeTestDb();
    const id = makeTextSource(db, "Contenu déposé.");
    const canvas = createCanvasRepo(db);
    canvas.placeAt("source", id, 10, 20);
    canvas.placeAt("source", id, 900, 900);
    expect({ x: canvas.getState().items[0].x, y: canvas.getState().items[0].y }).toEqual({
      x: 10,
      y: 20,
    });
  });

  it("déplace en lot, ignore un élément inconnu, et ne touche pas l'appartenance si elle est absente", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    insertConstruction(db, "c2");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    const frame = canvas.createFrame({
      label: "Cadre",
      kind: "frame",
      x: 0,
      y: 0,
      width: 500,
      height: 400,
    });
    expect(canvas.assign([{ kind: "construction", ref: "c1" }], frame.id)).toBe(1);

    const moved = canvas.moveItems([
      { kind: "construction", ref: "c1", x: 100, y: 120 },
      { kind: "construction", ref: "c2", x: 300, y: 320 },
      { kind: "construction", ref: "inconnu", x: 1, y: 2 },
    ]);

    expect(moved).toBe(2);
    const { items } = canvas.getState();
    expect(items.find((n) => n.ref === "c1")).toMatchObject({ x: 100, y: 120, frame_id: frame.id });
    expect(items.find((n) => n.ref === "c2")).toMatchObject({ x: 300, y: 320, frame_id: null });
  });

  it("accepte une sortie de conteneur explicite (frame_id: null)", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    const frame = canvas.createFrame({
      label: "Groupe",
      kind: "group",
      x: 0,
      y: 0,
      width: 500,
      height: 400,
    });
    canvas.assign([{ kind: "construction", ref: "c1" }], frame.id);

    canvas.moveItems([{ kind: "construction", ref: "c1", x: 900, y: 900, frame_id: null }]);
    const item = canvas.getState().items[0];
    expect(item.frame_id).toBeNull();
    expect({ x: item.x, y: item.y }).toEqual({ x: 900, y: 900 });
  });

  it("positions absolues : rejouer la même requête ne cumule pas les décalages", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    for (let i = 0; i < 3; i++) {
      canvas.moveItems([{ kind: "construction", ref: "c1", x: 42, y: 24 }]);
    }
    const item = canvas.getState().items.find((n) => n.ref === "c1");
    expect({ x: item?.x, y: item?.y }).toEqual({ x: 42, y: 24 });
  });

  it("déplacer un conteneur décale **ses fichiers et ses Constructions**, une seule fois", () => {
    const { db } = makeTestDb();
    const src = makeTextSource(db, "Contenu du fichier groupé.");
    makeFragment(db, { sourceId: src, text: "Fragment du fichier." });
    insertConstruction(db, "c1");
    insertConstruction(db, "c2");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    const frame = canvas.createFrame({
      label: "Cadre",
      kind: "frame",
      x: 0,
      y: 0,
      width: 900,
      height: 700,
    });
    canvas.assign(
      [
        { kind: "source", ref: src },
        { kind: "construction", ref: "c1" },
      ],
      frame.id
    );
    canvas.moveItems([
      { kind: "source", ref: src, x: 100, y: 100 },
      { kind: "construction", ref: "c1", x: 200, y: 200 },
      { kind: "construction", ref: "c2", x: 300, y: 300 },
    ]);

    const result = canvas.updateFrame(frame.id, { x: 50, y: 25 });
    expect(result?.shifted).toBe(2);

    const { items } = canvas.getState();
    expect(items.find((n) => n.ref === src)).toMatchObject({ x: 150, y: 125 });
    expect(items.find((n) => n.ref === "c1")).toMatchObject({ x: 250, y: 225 });
    // l'élément hors cadre ne bouge pas
    expect(items.find((n) => n.ref === "c2")).toMatchObject({ x: 300, y: 300 });
  });

  it("redimensionner ou renommer un conteneur ne déplace aucun élément", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    const frame = canvas.createFrame({
      label: "Cadre",
      kind: "frame",
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    canvas.assign([{ kind: "construction", ref: "c1" }], frame.id);
    canvas.moveItems([{ kind: "construction", ref: "c1", x: 100, y: 100 }]);

    expect(canvas.updateFrame(frame.id, { width: 1200, height: 900 })?.shifted).toBe(0);
    expect(canvas.updateFrame(frame.id, { label: "Renommé" })?.shifted).toBe(0);
    expect(canvas.getState().items[0]).toMatchObject({ x: 100, y: 100 });
    expect(canvas.getState().frames[0]).toMatchObject({
      label: "Renommé",
      width: 1200,
      height: 900,
    });
  });

  it("dissout un conteneur en laissant les éléments en place", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    const frame = canvas.createFrame({
      label: "Groupe",
      kind: "group",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    canvas.assign([{ kind: "construction", ref: "c1" }], frame.id);
    canvas.moveItems([{ kind: "construction", ref: "c1", x: 55, y: 66 }]);

    expect(canvas.dissolveFrame(frame.id)).toBe(true);
    expect(canvas.dissolveFrame(frame.id)).toBe(false);
    const state = canvas.getState();
    expect(state.frames).toHaveLength(0);
    expect(state.items[0]).toMatchObject({ x: 55, y: 66, frame_id: null });
  });

  it("refuse de ranger dans un conteneur inconnu", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    expect(canvas.assign([{ kind: "construction", ref: "c1" }], "inconnu")).toBe(0);
    expect(canvas.getState().items[0].frame_id).toBeNull();
  });

  it("expose le `stale` de la Construction sur l'élément (US-08 AC2 sur le canvas)", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    const canvas = createCanvasRepo(db);
    canvas.placeMissing();
    const first = canvas.getState().items[0];
    expect(first.kind === "construction" && first.construction.stale).toBe(false);

    db.prepare("UPDATE constructions SET stale = 1 WHERE id = 'c1'").run();
    const after = canvas.getState().items[0];
    expect(after.kind === "construction" && after.construction.stale).toBe(true);
  });

  it("une source supprimée emporte son élément de canvas, sans toucher aux autres", () => {
    const { db } = makeTestDb();
    const gone = makeTextSource(db, "Fichier qui va disparaître.");
    const kept = makeTextSource(db, "Fichier qui reste.");
    makeFragment(db, { sourceId: gone, text: "Fragment qui disparaît." });
    makeFragment(db, { sourceId: kept, text: "Fragment qui reste." });
    const canvas = createCanvasRepo(db);
    canvas.getState();
    expect(canvas.getState().items).toHaveLength(2);

    createSourcesRepo(db).deleteById(gone);

    // `prune()` tourne avant chaque lecture : le canvas ne montre jamais un fichier absent
    const items = canvas.getState().items;
    expect(items.map((i) => i.ref)).toEqual([kept]);
    expect(canvas.prune()).toBe(0);
  });

  it("une Construction supprimée emporte son élément (aucune ligne orpheline)", () => {
    const { db } = makeTestDb();
    insertConstruction(db, "c1");
    const canvas = createCanvasRepo(db);
    canvas.getState();

    db.prepare("DELETE FROM constructions WHERE id = 'c1'").run();
    expect(canvas.getState().items).toHaveLength(0);
  });

  it("déplacer une source ne crée pas d'élément pour une source inexistante", () => {
    const { db } = makeTestDb();
    const canvas = createCanvasRepo(db);
    expect(canvas.moveItems([{ kind: "source", ref: "inconnue", x: 5, y: 5 }])).toBe(0);
    expect(canvas.getState().items).toHaveLength(0);
  });
});

describe("liens du canvas — les suggestions vues comme des arêtes", () => {
  function withLink(
    db: Db,
    opts: {
      tier?: "strong" | "weak";
      relation?: "analogy" | "cause";
      /** Distingue deux appels sur la même base (contenus ⇒ ids de sources distincts). */
      tag?: string;
    } = {}
  ) {
    const tag = opts.tag ?? "";
    const suffix = tag ? ` ${tag}.` : ".";
    const s1 = makeTextSource(db, `Premier document, contenu distinct${suffix}`);
    const s2 = makeTextSource(db, `Second document, autre contenu${suffix}`);
    const fA = makeFragment(db, { sourceId: s1, text: `Fragment A du premier${suffix}`, id: `fa-${s2}` });
    const fB = makeFragment(db, { sourceId: s2, text: `Fragment B du second${suffix}`, id: `fb-${s1}` });
    makeFragment(db, {
      sourceId: s1,
      text: `Fragment A2 du premier${suffix}`,
      chunkIndex: 1,
      id: `fa2-${s2}`,
    });
    const claim = `Le second document déplace la thèse du premier${suffix}`;
    const created = createSuggestionsRepo(db).create({
      claim,
      relation_type: opts.relation ?? "analogy",
      tier: opts.tier ?? "strong",
      fragment_a_id: fA,
      fragment_b_id: fB,
      pair_key: [fA, fB].sort().join(":"),
      content_sig: contentSig(claim),
      epistemic_status: "INFERENCE",
      prompt_version: "discovery-v4",
      chat_model: "test-model",
    });
    if (!created.ok) throw new Error(`suggestion non créée : ${created.reason}`);
    return { s1, s2, id: created.id };
  }

  it("rend une arête par suggestion, avec ses fichiers, son statut et ses preuves", () => {
    const { db } = makeTestDb();
    const { s1, s2, id } = withLink(db);
    const canvas = createCanvasRepo(db);
    const sourceRefs = canvas.getState().items.filter((i) => i.kind === "source").map((i) => i.ref);

    const links = createReviewService(db).linksFor(sourceRefs);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      id,
      from_source_id: s1,
      to_source_id: s2,
      relation_type: "analogy",
      tier: "strong",
      epistemic_status: "INFERENCE",
    });
    expect(links[0].fragments).toHaveLength(2);
    // l'affichage d'un lien **est** une exposition (§3.2) : `discovered` → `shown`
    expect(links[0].state).toBe("shown");
  });

  it("n'attache aucune arête à un fichier absent du canvas", () => {
    const { db } = makeTestDb();
    const { s1 } = withLink(db);
    const links = createReviewService(db).linksFor([s1]);
    expect(links).toHaveLength(0);
  });

  it("garde une arête intégrée (état `accepted`) et retire une arête rejetée", () => {
    const { db } = makeTestDb();
    const { s1, s2, id } = withLink(db);
    const canvas = createCanvasRepo(db);
    const refs = () =>
      canvas.getState().items.filter((i) => i.kind === "source").map((i) => i.ref);
    const service = createReviewService(db);

    const accepted = service.accept(id, { x: 500, y: 400 });
    expect(accepted.ok).toBe(true);
    const integrated = service.linksFor(refs());
    expect(integrated).toHaveLength(1);
    expect(integrated[0].state).toBe("accepted");

    // la Construction acceptée est **déjà** sur le canvas, à la place demandée
    const construction = canvas.getState().items.find((i) => i.kind === "construction");
    expect(construction).toBeDefined();
    expect({ x: construction?.x, y: construction?.y }).toEqual({ x: 500, y: 400 });

    const { s1: t1, s2: t2, id: second } = withLink(db, { relation: "cause", tag: "bis" });
    expect([t1, t2].length).toBe(2);
    expect(service.reject(second, "off_topic").ok).toBe(true);
    const afterReject = service.linksFor(refs());
    expect(afterReject.map((l) => l.id)).not.toContain(second);
    expect([s1, s2]).toContain(afterReject[0].from_source_id);
  });
});
