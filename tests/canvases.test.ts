import { describe, expect, it } from "vitest";
import { makeTestDb, makeTextSource } from "./helpers";
import {
  ATELIER_CANVAS_ID,
  createCanvasesRepo,
  recentCanvasIds,
} from "@/lib/repositories/canvases";
import { createConversationCanvasRepo } from "@/lib/repositories/conversation-canvases";
import { createExplorerService } from "@/lib/explorer/explorer-service";
import { createConversationsRepo } from "@/lib/repositories/conversations";
import { nowIso, type Db } from "@/lib/db/client";

/** Passe-partout pour l'assertion `frame_id: null` (le type SQL n'expose pas NULL). */
const NULL_FRAME = null;

/**
 * Les tableaux (v1.6 §14, migration 010, étape 1).
 *
 * Ce qui doit tenir, et qui casse silencieusement si on se trompe :
 *  - l'atelier existe **toujours**, est unique, et n'est pas supprimable ;
 *  - supprimer un tableau détache : frames dissoutes, items « hors frame »,
 *    conversations déliées — **aucune** Construction n'est jamais supprimée ;
 *  - les appartenances de la migration survivent (la reconstruction ne perd rien) ;
 *  - le multi-ancrage est idempotent, et ses CASCADEs disent la survie ;
 *  - l'explorateur lit sans écrire : deux snapshots d'affilée ne bougent rien.
 */

function makeConversation(db: Db, title: string): string {
  const repo = createConversationsRepo(db);
  const row = repo.create({
    anchorKind: "corpus",
    title,
    chatModel: "test-model",
    promptVersion: "v8",
  });
  return row.id;
}

describe("migration 010 — l'atelier devient le premier canvas", () => {
  it("la base neuve contient exactement l'atelier", () => {
    const { db } = makeTestDb();
    const rows = db.prepare("SELECT * FROM canvases").all() as { id: string; is_default: number; pinned: number; label: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ATELIER_CANVAS_ID);
    expect(rows[0].label).toBe("Atelier");
    expect(rows[0].is_default).toBe(1);
    expect(rows[0].pinned).toBe(1);
  });

  it("un second atelier est impossible (index unique partiel)", () => {
    const { db } = makeTestDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO canvases (id, label, is_default, position, created_at, updated_at)
           VALUES ('x', 'X', 1, 1, ?, ?)`
        )
        .run(nowIso(), nowIso())
    ).toThrow();
  });

  it("les frames existantes appartiennent à l'atelier après migration", () => {
    const { db } = makeTestDb();
    db.prepare(
      `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, z, created_at, updated_at)
       VALUES ('f1', ?, 'Mesures', 'frame', 0, 0, 300, 200, 1, ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());
    const row = db
      .prepare("SELECT canvas_id FROM canvas_frames WHERE id = 'f1'")
      .get() as { canvas_id: string };
    expect(row.canvas_id).toBe(ATELIER_CANVAS_ID);
  });
});

describe("dépôt canvases — la collection", () => {
  it("créer, renommer, colorier, épingler, réordonner (persistant)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const a = repo.create({ label: "Veille IA", color: "blue" });
    const b = repo.create({ label: "Thèse" });
    expect(a.position).toBe(1); // après l'atelier (position 0)
    expect(b.position).toBe(2);

    repo.update(a.id, { label: "Veille IA — 2026", pinned: true, color: "violet" });
    const updated = repo.getById(a.id)!;
    expect(updated.label).toBe("Veille IA — 2026");
    expect(updated.pinned).toBe(1);
    expect(updated.color).toBe("violet");

    // l'ordre manuel se voit **dans le groupe non épinglé** (l'épinglage passe
    // avant la position — la même règle que l'arbre de la maquette) : on dé-épingle
    repo.update(a.id, { pinned: false });
    repo.reorder([b.id, a.id]);
    const order = repo.list().map((c) => c.id);
    expect(order.indexOf(b.id)).toBeLessThan(order.indexOf(a.id));
  });

  it("supprimer l'atelier est refusé, supprimer un canvas détache sans rien détruire", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const cv = repo.create({ label: "Éphémère" });
    db.prepare(
      `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, z, created_at, updated_at)
       VALUES ('f-eph', ?, 'Frame éphémère', 'frame', 0, 0, 200, 150, 1, ?, ?)`
    ).run(cv.id, nowIso(), nowIso());
    // un item rangé dans la frame du tableau condamné
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 10, 10, 1, 'f-eph', ?, ?)`
    ).run(nowIso(), nowIso());
    // ... et un item hors frame, qui appartient à l'atelier et ne bouge pas
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-2', 400, 10, 2, NULL, ?, ?)`
    ).run(nowIso(), nowIso());

    expect(repo.deleteById(ATELIER_CANVAS_ID)).toEqual({ ok: false, reason: "atelier" });

    const result = repo.deleteById(cv.id);
    expect(result).toEqual({ ok: true, detached: { frames: 1, conversations: 0 } });

    // le canvas est parti
    expect(repo.getById(cv.id)).toBeNull();
    // ses frames sont **dissoutes** — pas réaffectées comme coquilles vides
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM canvas_frames WHERE id = 'f-eph'").get() as { n: number }).n
    ).toBe(0);
    // l'objet rangé dedans survit, « hors frame » — sa position n'a pas bougé
    const item = db
      .prepare("SELECT frame_id, x, y FROM canvas_items WHERE item_ref = 'c-1'")
      .get() as { frame_id: string | null; x: number; y: number };
    expect(item.frame_id).toBeNull();
    expect(item.x).toBe(10);
    expect(item.y).toBe(10);
    // l'item hors frame n'a jamais été concerné
    const horsFrame = db
      .prepare("SELECT frame_id FROM canvas_items WHERE item_ref = 'c-2'")
      .get() as { frame_id: string | null };
    expect(horsFrame.frame_id).toBeNull();
  });

  it("les compteurs distinguent par frame et hors frame (atelier)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    db.prepare(
      `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, z, created_at, updated_at)
       VALUES ('f-a', ?, 'Framée', 'frame', 0, 0, 300, 200, 1, ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 10, 10, 1, 'f-a', ?, ?)`
    ).run(nowIso(), nowIso());
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('source', 's-1', 20, 20, 2, NULL, ?, ?)`
    ).run(nowIso(), nowIso());

    const atelierCounts = repo.counts(ATELIER_CANVAS_ID);
    expect(atelierCounts).toEqual({ frames: 1, constructions: 1, sources: 1, conversations: 0 });
  });

  it("la récence est dérivée : toucher une conversation liée fait remonter le tableau", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const cv = repo.create({ label: "Veille" });
    const conv = makeConversation(db, "Une question sur la veille");
    createConversationCanvasRepo(db).link(conv, cv.id);
    // la conversation est plus récente que le canvas : elle le fait remonter
    const recent = recentCanvasIds(db, 5);
    expect(recent[0]).toBe(cv.id);
  });
});

describe("multi-ancrage — conversation_canvases", () => {
  it("lier à plusieurs tableaux, idempotent, délier, remplacer (setLinks)", () => {
    const { db } = makeTestDb();
    const canvases = createCanvasesRepo(db);
    const liaisons = createConversationCanvasRepo(db);
    const c1 = canvases.create({ label: "A" }).id;
    const c2 = canvases.create({ label: "B" }).id;
    const conv = makeConversation(db, "Question multi-tableaux");

    expect(liaisons.link(conv, c1)).toBe(true);
    expect(liaisons.link(conv, c1)).toBe(false); // idempotent
    expect(liaisons.link(conv, c2)).toBe(true);
    expect(liaisons.listForConversation(conv)).toEqual([c1, c2]);

    expect(liaisons.unlink(conv, c1)).toBe(true);
    expect(liaisons.unlink(conv, c1)).toBe(false);
    expect(liaisons.listForConversation(conv)).toEqual([c2]);

    const res = liaisons.setLinks(conv, [c1]);
    expect(res).toEqual({ linked: 1, unlinked: 1 });
    expect(liaisons.listForConversation(conv)).toEqual([c1]);
  });

  it("lier une conversation ou un tableau inexistant est une erreur, pas un silence", () => {
    const { db } = makeTestDb();
    const canvases = createCanvasesRepo(db);
    const liaisons = createConversationCanvasRepo(db);
    const cv = canvases.create({ label: "A" }).id;
    expect(() => liaisons.link("conv-inconnue", cv)).toThrow();
    expect(() => liaisons.link("conv-inconnue", "canvas-inconnu")).toThrow();
  });

  it("supprimer le tableau délie (la conversation reste) ; supprimer la conversation aussi", () => {
    const { db } = makeTestDb();
    const canvases = createCanvasesRepo(db);
    const liaisons = createConversationCanvasRepo(db);
    const cv = canvases.create({ label: "B" }).id;
    const conv = makeConversation(db, "Une conversation qui reste");
    liaisons.link(conv, cv);

    canvases.deleteById(cv);
    expect(liaisons.listForConversation(conv)).toEqual([]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = ?").get(conv) as { n: number }).n
    ).toBe(1); // elle reste, hors tableau

    const cv2 = canvases.create({ label: "C" }).id;
    liaisons.link(conv, cv2);
    createConversationsRepo(db).deleteById(conv);
    expect(liaisons.listForConversation(conv)).toEqual([]);
  });

  it("listForCanvas liste les conversations, récentes d'abord", () => {
    const { db } = makeTestDb();
    const canvases = createCanvasesRepo(db);
    const liaisons = createConversationCanvasRepo(db);
    const cv = canvases.create({ label: "A" }).id;
    const conv1 = makeConversation(db, "Première");
    const conv2 = makeConversation(db, "Seconde");
    liaisons.link(conv1, cv);
    liaisons.link(conv2, cv);
    createConversationsRepo(db).addUserMessage({ conversationId: conv2, text: "toucher" });
    const listed = liaisons.listForCanvas(cv);
    expect(listed.map((c) => c.id)).toEqual([conv2, conv1]);
  });
});

describe("service explorateur — le snapshot", () => {
  it("lit l'arbre, les compteurs, la récence — sans rien écrire", () => {
    const { db } = makeTestDb();
    const canvases = createCanvasesRepo(db);
    const liaisons = createConversationCanvasRepo(db);
    const cv = canvases.create({ label: "Veille IA", color: "blue" });
    const conv = makeConversation(db, "Une question sur la veille");
    liaisons.link(conv, cv.id);
    db.prepare(
      `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, z, created_at, updated_at)
       VALUES ('f-v', ?, 'Calibration', 'frame', 0, 0, 300, 200, 1, ?, ?)`
    ).run(cv.id, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 10, 10, 1, 'f-v', ?, ?)`
    ).run(nowIso(), nowIso());

    const service = createExplorerService(db);
    const snap = service.snapshot();

    expect(snap.canvases).toHaveLength(2);
    const veille = snap.canvases.find((c) => c.id === cv.id)!;
    expect(veille.label).toBe("Veille IA");
    expect(veille.frames).toHaveLength(1);
    expect(veille.frames[0]).toMatchObject({ label: "Calibration", constructions: 1, sources: 0 });
    expect(veille.totals).toEqual({ frames: 1, constructions: 1, sources: 0, conversations: 1 });
    expect(veille.conversations).toEqual([
      { id: conv, title: "Une question sur la veille", updated_at: expect.any(String) },
    ]);

    const atelier = snap.canvases.find((c) => c.is_default)!;
    expect(atelier.label).toBe("Atelier");

    // la récence contient les deux tableaux et la conversation liée
    const kinds = snap.recent.map((e) => e.kind);
    expect(kinds).toContain("canvas");
    expect(kinds).toContain("conversation");
  });

  it("deux snapshots d'affilée ne changent aucune ligne (lecture pure)", () => {
    const { db } = makeTestDb();
    const service = createExplorerService(db);
    service.snapshot();
    const before = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM canvases) AS a,
                (SELECT COUNT(*) FROM canvas_frames) AS b,
                (SELECT COUNT(*) FROM canvas_items) AS c,
                (SELECT IFNULL(MAX(updated_at), '') FROM canvases) AS d`
      )
      .get() as { a: number; b: number; c: number; d: string };
    service.snapshot();
    const after = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM canvases) AS a,
                (SELECT COUNT(*) FROM canvas_frames) AS b,
                (SELECT COUNT(*) FROM canvas_items) AS c,
                (SELECT IFNULL(MAX(updated_at), '') FROM canvases) AS d`
      )
      .get() as { a: number; b: number; c: number; d: string };
    expect(after).toEqual(before);
  });

  it("les nodes positionnés portent les positions réelles (AC2) et les titres dérivés", () => {
    const { db } = makeTestDb();
    db.prepare(
      `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, z, created_at, updated_at)
       VALUES ('f-a', ?, 'Framée', 'frame', 0, 0, 600, 400, 1, ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());
    // une construction (texte connu) et une source (titre dérivé) — un item
    // orphelin (construction supprimée) est sauté, jamais inventé
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 30, 40, 1, 'f-a', ?, ?)`
    ).run(nowIso(), nowIso());
    db.prepare(
      `INSERT INTO constructions (id, text, epistemic_status, parent_source_ids, evidence_fragment_ids,
         suggestion_id, depth, stale, provenance_snapshot)
       VALUES ('c-1', 'Bernard oppose observation et expérience.', 'INFERENCE', '[]', '[]', NULL, 1, 0, '[]')`
    ).run();
    const src = makeTextSource(db, "Contenu de la source");
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('source', ?, 250, 60, 2, NULL, ?, ?)`
    ).run(src, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-fantôme', 99, 99, 3, NULL, ?, ?)`
    ).run(nowIso(), nowIso());

    const atelier = createExplorerService(db)
      .snapshot()
      .canvases.find((c) => c.is_default)!;
    expect(atelier.nodes).toHaveLength(2); // le fantôme est sauté
    const c = atelier.nodes.find((n) => n.ref === "c-1");
    expect(c).toMatchObject({
      kind: "construction",
      frame_id: "f-a",
      x: 30,
      y: 40,
      text: "Bernard oppose observation et expérience.",
      epistemic_status: "INFERENCE",
      stale: false,
    });
    const s = atelier.nodes.find((n) => n.ref === src);
    expect(s).toMatchObject({ kind: "source", frame_id: NULL_FRAME, x: 250, y: 60 });
    expect((s as { title: string }).title).toBe("Source de test");
  });

  it("l'atelier porte les items hors frame dans son snapshot", () => {
    const { db } = makeTestDb();
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, frame_id, created_at, updated_at)
       VALUES ('source', 's-1', 10, 10, 1, NULL, ?, ?)`
    ).run(nowIso(), nowIso());
    const snap = createExplorerService(db).snapshot();
    const atelier = snap.canvases.find((c) => c.is_default)!;
    expect(atelier.unframed).toEqual({ constructions: 0, sources: 1 });
    expect(atelier.totals.sources).toBe(1);
  });
});
