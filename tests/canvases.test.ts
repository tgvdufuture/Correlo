import { describe, expect, it } from "vitest";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import {
  ATELIER_CANVAS_ID,
  createCanvasesRepo,
  recentCanvasIds,
  resolveCanvasTarget,
  type CanvasRow,
} from "@/lib/repositories/canvases";
import { createCanvasRepo } from "@/lib/repositories/canvas";
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
    // un item rangé dans la frame du tableau condamné (011 : les items portent
    // leur canvas — l'item framé suit la frame, l'hors-frame reste chez l'atelier)
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 10, 10, 1, ?, 'f-eph', ?, ?)`
    ).run(cv.id, nowIso(), nowIso());
    // ... et un item hors frame, qui appartient à l'atelier et ne bouge pas
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-2', 400, 10, 2, ?, NULL, ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());

    expect(repo.deleteById(ATELIER_CANVAS_ID)).toEqual({ ok: false, reason: "atelier" });

    const result = repo.deleteById(cv.id);
    expect(result).toEqual({ ok: true, detached: { frames: 1, conversations: 0, children: 0 } });

    // le canvas est parti
    expect(repo.getById(cv.id)).toBeNull();
    // ses frames sont **dissoutes** — pas réaffectées comme coquilles vides
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM canvas_frames WHERE id = 'f-eph'").get() as { n: number }).n
    ).toBe(0);
    // l'objet rangé dedans survit, « hors frame » — sa position n'a pas bougé,
    // et il est **relogé chez l'atelier** : son canvas a disparu sous lui, le
    // réceptacle l'accueille (011 + §14.2 « l'atelier a un hors canvas »)
    const item = db
      .prepare("SELECT frame_id, x, y, canvas_id FROM canvas_items WHERE item_ref = 'c-1'")
      .get() as { frame_id: string | null; x: number; y: number; canvas_id: string };
    expect(item.frame_id).toBeNull();
    expect(item.x).toBe(10);
    expect(item.y).toBe(10);
    expect(item.canvas_id).toBe(ATELIER_CANVAS_ID);
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
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 10, 10, 1, ?, 'f-a', ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('source', 's-1', 20, 20, 2, ?, NULL, ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());

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

describe("l'imbrication — les sous-tableaux (v1.6.1, migration 012)", () => {
  it("créer sous un parent, déplacer, remettre à la racine (persistant)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const parent = repo.create({ label: "Veille" });
    const child = repo.create({ label: "Papiers", parentId: parent.id });
    expect(child.parent_id).toBe(parent.id);

    // un déplacement par le patch dédié (l'API passe ici)
    const moved = repo.setParent(child.id, ATELIER_CANVAS_ID);
    expect(moved.ok).toBe(true);
    expect((moved as { row: CanvasRow }).row.parent_id).toBe(ATELIER_CANVAS_ID);

    // retour à la racine : parent NULL
    const root = repo.setParent(child.id, null);
    expect(root.ok).toBe(true);
    expect((root as { row: CanvasRow }).row.parent_id).toBeNull();
  });

  it("un parent inconnu est une erreur nommée, pas un silence", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const cv = repo.create({ label: "A" });
    expect(repo.setParent(cv.id, "canvas-inconnu")).toEqual({ ok: false, reason: "parent_not_found" });
    expect(() => repo.create({ label: "B", parentId: "canvas-inconnu" })).toThrow();
  });

  it("un cycle est impossible : sous soi, sous un descendant, profondeur libre sinon", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const a = repo.create({ label: "A" });
    const b = repo.create({ label: "B", parentId: a.id });
    const c = repo.create({ label: "C", parentId: b.id });
    // l'arbre accepte la profondeur libre (A → B → C)…
    expect(repo.getById(c.id)!.parent_id).toBe(b.id);
    // …mais jamais un cycle : C ne peut pas adopter son grand-parent A
    expect(repo.setParent(a.id, c.id)).toEqual({ ok: false, reason: "cycle" });
    expect(repo.setParent(a.id, a.id)).toEqual({ ok: false, reason: "cycle" });
    // B non plus (descendant direct) — et rien n'a bougé
    expect(repo.setParent(a.id, b.id)).toEqual({ ok: false, reason: "cycle" });
    expect(repo.getById(a.id)!.parent_id).toBeNull();
  });

  it("l'atelier ne peut pas être déplacé sous un tableau (réceptacle racine)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const parent = repo.create({ label: "Conteneur" });
    expect(repo.setParent(ATELIER_CANVAS_ID, parent.id)).toEqual({ ok: false, reason: "atelier" });
    // mais il reste une racine parfaitement ordinaire pour ses propres enfants
    const child = repo.create({ label: "Sous-atelier", parentId: ATELIER_CANVAS_ID });
    expect(child.parent_id).toBe(ATELIER_CANVAS_ID);
  });

  it("supprimer un tableau fait remonter ses sous-tableaux au grand-parent", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const grandParent = repo.create({ label: "Veille" });
    const mid = repo.create({ label: "2026", parentId: grandParent.id });
    const child1 = repo.create({ label: "Papiers", parentId: mid.id });
    const child2 = repo.create({ label: "Modèles", parentId: mid.id });

    const result = repo.deleteById(mid.id);
    expect(result).toEqual({ ok: true, detached: { frames: 0, conversations: 0, children: 2 } });
    expect(repo.getById(mid.id)).toBeNull();
    // les enfants sont visibles là où leur parent était : sous le grand-parent
    expect(repo.getById(child1.id)!.parent_id).toBe(grandParent.id);
    expect(repo.getById(child2.id)!.parent_id).toBe(grandParent.id);

    // supprimer un tableau **racine** : ses enfants redeviennent racines
    const rootChild = repo.create({ label: "Orphelin de racine", parentId: grandParent.id });
    repo.deleteById(grandParent.id);
    expect(repo.getById(rootChild.id)!.parent_id).toBeNull();
  });

  it("la suppression d'un parent n'est pas possible sans traiter ses enfants (FK RESTRICT)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const parent = repo.create({ label: "Père" });
    repo.create({ label: "Fils", parentId: parent.id });
    // `deleteById` remonte les enfants AVANT le DELETE : la FK ne peut jamais
    // crier — mais une écriture brute (le côté qui ne passe pas par le dépôt)
    // est bien refusée par RESTRICT
    expect(() =>
      db.prepare("DELETE FROM canvases WHERE id = ?").run(parent.id)
    ).toThrow();
    expect(repo.getById(parent.id)).not.toBeNull();
  });
});

describe("la distinction dossier / canvas (v1.6.2, migration 013)", () => {
  it("un dossier se crée, se range dans un dossier, et côte à côte avec des canvas", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const folder = repo.create({ label: "Veille", kind: "folder" });
    expect(folder.kind).toBe("folder");
    // dans un dossier : un canvas ET un sous-dossier, mélangés (le cœur de la demande)
    const cv = repo.create({ label: "Papiers", parentId: folder.id, kind: "canvas" });
    const sub = repo.create({ label: "Archives", parentId: folder.id, kind: "folder" });
    expect(cv.kind).toBe("canvas");
    expect(sub.parent_id).toBe(folder.id);
    // le défaut reste « canvas » (l'usage majoritaire)
    expect(repo.create({ label: "Sans nature" }).kind).toBe("canvas");
  });

  it("un dossier vit sous un canvas (v1.6.3 — chaque tableau range, l'atelier compris)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    // le signalement v1.6.2 : créer un dossier « dans l'atelier » (un canvas)
    // le repoussait à la racine — la règle est levée, le parent est honoré
    const cv = repo.create({ label: "Une surface" });
    const inside = repo.create({ label: "Dossier dans le canvas", parentId: cv.id, kind: "folder" });
    expect(inside.parent_id).toBe(cv.id);
    // et par déplacement : le dossier rejoint le canvas
    const folder = repo.create({ label: "Dossier racine", kind: "folder" });
    const moved = repo.setParent(folder.id, cv.id);
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.row.parent_id).toBe(cv.id);
  });

  it("un canvas vit sous un canvas, y compris sous l'atelier", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const atelier = repo.getAtelier();
    const child = repo.create({ label: "Sous-tableau de l'atelier", parentId: atelier.id });
    expect(child.parent_id).toBe(ATELIER_CANVAS_ID);
    const cv = repo.create({ label: "Une surface" });
    const grandchild = repo.create({ label: "Sous-surface", parentId: cv.id });
    expect(grandchild.parent_id).toBe(cv.id);
  });

  it("un dossier est un conteneur pur : ni frame, ni item, ni conversation", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const folder = repo.create({ label: "Conteneur", kind: "folder" });
    // le dépôt du canvas scopé sur un dossier est refusé dès la construction
    expect(() => createCanvasRepo(db, folder.id)).toThrow(/frame_dans_dossier|item_dans_dossier/);
    // les liaisons de conversations aussi (garde partagée, jamais dupliquée)
    const conv = makeConversation(db, "Une question");
    expect(() => createConversationCanvasRepo(db).link(conv, folder.id)).toThrow(
      /conversation_dans_dossier/
    );
  });

  it("le snapshot montre un dossier vide de plan et le contenu mixte reste lisible", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const folder = repo.create({ label: "Veille", kind: "folder" });
    repo.create({ label: "Papiers", parentId: folder.id, kind: "canvas" });
    const snap = createExplorerService(db).snapshot();
    const folderSummary = snap.canvases.find((c) => c.id === folder.id)!;
    expect(folderSummary.kind).toBe("folder");
    // conteneur pur : aucun plan, aucune conversation (les gardes garantissent
    // qu'il n'y en a pas — le service n'assemble pas ce qui ne peut pas exister)
    expect(folderSummary.frames).toEqual([]);
    expect(folderSummary.conversations).toEqual([]);
    expect(folderSummary.totals).toEqual({ frames: 0, constructions: 0, sources: 0, conversations: 0 });
    // le canvas enfant reste une surface ordinaire
    const child = snap.canvases.find((c) => c.label === "Papiers")!;
    expect(child.kind).toBe("canvas");
    expect(child.parent_id).toBe(folder.id);
  });

  it("supprimer un dossier fait remonter canvas ET sous-dossiers mêlés", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const root = repo.create({ label: "Racine de check", kind: "folder" });
    const mid = repo.create({ label: "2026", parentId: root.id, kind: "folder" });
    const cv = repo.create({ label: "Canvas dedans", parentId: mid.id, kind: "canvas" });
    const sub = repo.create({ label: "Dossier dedans", parentId: mid.id, kind: "folder" });
    const result = repo.deleteById(mid.id);
    expect(result).toEqual({ ok: true, detached: { frames: 0, conversations: 0, children: 2 } });
    // les deux natures remontent au même endroit
    expect(repo.getById(cv.id)!.parent_id).toBe(root.id);
    expect(repo.getById(sub.id)!.parent_id).toBe(root.id);
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
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 10, 10, 1, ?, 'f-v', ?, ?)`
    ).run(cv.id, nowIso(), nowIso());

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
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-1', 30, 40, 1, ?, 'f-a', ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO constructions (id, text, epistemic_status, parent_source_ids, evidence_fragment_ids,
         suggestion_id, depth, stale, provenance_snapshot)
       VALUES ('c-1', 'Bernard oppose observation et expérience.', 'INFERENCE', '[]', '[]', NULL, 1, 0, '[]')`
    ).run();
    const src = makeTextSource(db, "Contenu de la source");
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('source', ?, 250, 60, 2, ?, NULL, ?, ?)`
    ).run(src, ATELIER_CANVAS_ID, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('construction', 'c-fantôme', 99, 99, 3, ?, NULL, ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());

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
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('source', 's-1', 10, 10, 1, ?, NULL, ?, ?)`
    ).run(ATELIER_CANVAS_ID, nowIso(), nowIso());
    const snap = createExplorerService(db).snapshot();
    const atelier = snap.canvases.find((c) => c.is_default)!;
    expect(atelier.unframed).toEqual({ constructions: 0, sources: 1 });
    expect(atelier.totals.sources).toBe(1);
  });

  it("les nodes portent leurs liens IA (AC3) : compteurs, lecture pure", () => {
    const { db } = makeTestDb();
    const now = nowIso();
    const s1 = makeTextSource(db, "Première source.");
    const s2 = makeTextSource(db, "Seconde source.");
    const f1 = makeFragment(db, { sourceId: s1, text: "Fragment A." });
    const f2 = makeFragment(db, { sourceId: s2, text: "Fragment B." });
    // une suggestion OUVERTE sur la paire, avec une enquête en cours
    db.prepare(
      `INSERT INTO suggestions (id, claim, relation_type, tier, state, fragment_a_id, fragment_b_id,
         pair_key, content_sig, epistemic_status, prompt_version, chat_model)
       VALUES ('sg-1', 'Paire non tranchée.', 'analogy', 'medium', 'shown', ?, ?, 'pair-1', 'sig-1', 'INFERENCE', 'pv', 'm')`
    ).run(f1, f2);
    db.prepare(
      `INSERT INTO investigations (id, suggestion_id, status, steps, created_at, updated_at)
       VALUES ('inv-1', 'sg-1', 'done', '[]', ?, ?)`
    ).run(now, now);
    // une synthèse proposée citant s1 (parent_source_ids JSON)
    db.prepare(
      `INSERT INTO themes (id, run_id, corpus_hash, seed, label, centroid, centroid_dimensions,
         size, sampler_version, created_at)
       VALUES ('th-1', 'run-1', 'hash', '1', 'Thème', x'0000803F', 8, 10, 'sv', ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO syntheses (id, text, theme_id, relation_kind, epistemic_status, parent_source_ids,
         evidence_fragment_ids, provenance_snapshot, content_sig, confidence, state, stale,
         prompt_version, chat_model, created_at)
       VALUES ('sy-1', 'Énoncé multi-sources.', 'th-1', 'combination', 'INFERENCE', ?,
         '[]', '[]', 'sig-sy', 'high', 'proposed', 0, 'pv', 'm', ?)`
    ).run(JSON.stringify([s1]), now);
    // une construction posée sur l'atelier (hors suggestion — rien à lier)
    db.prepare(
      `INSERT INTO constructions (id, text, epistemic_status, parent_source_ids, evidence_fragment_ids,
         suggestion_id, depth, stale, provenance_snapshot)
       VALUES ('c-1', 'Une construction sans suggestion.', 'INFERENCE', '[]', '[]', NULL, 1, 0, '[]')`
    ).run();
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('source', ?, 10, 10, 1, ?, NULL, ?, ?),
              ('construction', 'c-1', 50, 50, 2, ?, NULL, ?, ?)`
    ).run(s1, ATELIER_CANVAS_ID, now, now, ATELIER_CANVAS_ID, now, now);

    const snap = createExplorerService(db).snapshot();
    const atelier = snap.canvases.find((c) => c.is_default)!;
    const sourceNode = atelier.nodes.find((n) => n.ref === s1);
    expect(sourceNode).toMatchObject({
      links: { suggestions: 1, syntheses: 1, investigations: 1 },
    });
    const constructionNode = atelier.nodes.find((n) => n.ref === "c-1");
    // une construction hors suggestion n'a AUCUN lien : rien n'est inventé
    expect(constructionNode).toMatchObject({
      links: { suggestions: 0, syntheses: 0, investigations: 0 },
    });
    // lecture pure : deux snapshots d'affilée ne changent rien
    const again = createExplorerService(db).snapshot();
    expect(again.canvases.find((c) => c.is_default)!.nodes).toEqual(atelier.nodes);
  });
});

describe("l'atelier focalisé — le dépôt scopé par tableau (v1.6 §14.2, étape 3)", () => {
  /** Une base avec deux tableaux : l'atelier et un tableau « Veille ». */
  function withTwoCanvases(db: Db): string {
    const now = nowIso();
    db.prepare(
      `INSERT INTO canvases (id, label, color, is_default, pinned, position, created_at, updated_at)
       VALUES ('canvas-veille', 'Veille', 'cyan', 0, 0, 2, ?, ?)`
    ).run(now, now);
    return "canvas-veille";
  }

  it("getState ne montre que les frames et les items de CE tableau", () => {
    const { db } = makeTestDb();
    const veille = withTwoCanvases(db);
    const now = nowIso();
    // des sources **réelles** : `getState()` purge les orphelins avant de lire,
    // un ref inventé disparaîtrait au premier appel (comportement voulu)
    const atelierSource = makeTextSource(db, "Contenu posé chez l'atelier.");
    const veilleSource = makeTextSource(db, "Contenu posé chez Veille.");
    // une frame chez l'atelier, une chez Veille ; un item dans chacune
    db.prepare(
      `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, z, created_at, updated_at)
       VALUES ('f-atelier', ?, 'Chez l''atelier', 'frame', 0, 0, 500, 300, 1, ?, ?)`
    ).run(ATELIER_CANVAS_ID, now, now);
    db.prepare(
      `INSERT INTO canvas_frames (id, canvas_id, label, kind, x, y, width, height, z, created_at, updated_at)
       VALUES ('f-veille', ?, 'Chez Veille', 'frame', 0, 0, 500, 300, 1, ?, ?)`
    ).run(veille, now, now);
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('source', ?, 10, 10, 1, ?, 'f-atelier', ?, ?)`
    ).run(atelierSource, ATELIER_CANVAS_ID, now, now);
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('source', ?, 20, 20, 1, ?, 'f-veille', ?, ?)`
    ).run(veilleSource, veille, now, now);

    const atelier = createCanvasRepo(db).getState();
    expect(atelier.frames.map((f) => f.id)).toEqual(["f-atelier"]);
    expect(atelier.items.map((i) => i.ref)).toEqual([atelierSource]);

    const focused = createCanvasRepo(db, veille).getState();
    expect(focused.frames.map((f) => f.id)).toEqual(["f-veille"]);
    expect(focused.items.map((i) => i.ref)).toEqual([veilleSource]);
  });

  it("createFrame pose le cadre chez le tableau qui le demande — jamais chez l'atelier", () => {
    const { db } = makeTestDb();
    const veille = withTwoCanvases(db);
    createCanvasRepo(db, veille).createFrame({
      label: "Papiers",
      kind: "frame",
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
    const owner = db
      .prepare("SELECT canvas_id FROM canvas_frames WHERE label = 'Papiers'")
      .get() as { canvas_id: string };
    expect(owner.canvas_id).toBe(veille);
    // l'atelier, lui, n'a rien vu
    expect(createCanvasRepo(db).getState().frames).toHaveLength(0);
  });

  it("placeMissing ne place automatiquement que pour l'atelier — pas de placement en masse ailleurs", () => {
    const { db } = makeTestDb();
    const veille = withTwoCanvases(db);
    const id = makeTextSource(db, "Contenu.");
    makeFragment(db, { sourceId: id, text: "Fragment." });

    // l'atelier place tout ce qui n'a pas de disposition (comportement historique)
    expect(createCanvasRepo(db).placeMissing()).toBe(1);
    // le focalisé Veille : rien n'est placé automatiquement (un objet arrive ici
    // par un geste explicite — déposer, ranger — jamais en masse)
    expect(createCanvasRepo(db, veille).placeMissing()).toBe(0);
    expect(createCanvasRepo(db, veille).getState().items).toHaveLength(0);
  });

  it("un item vit sur un seul plan : déposer ici l'enlève de là (PK globale)", () => {
    const { db } = makeTestDb();
    const veille = withTwoCanvases(db);
    const id = makeTextSource(db, "Contenu posé dans l'atelier puis déplacé.");
    const atelier = createCanvasRepo(db);
    atelier.placeAt("source", id, 10, 10);
    expect(atelier.getState().items.map((i) => i.ref)).toEqual([id]);

    // un geste explicite dans Veille : l'item passe d'un plan à l'autre
    createCanvasRepo(db, veille).placeAt("source", id, 300, 200);
    expect(createCanvasRepo(db, veille).getState().items.map((i) => i.ref)).toEqual([id]);
    expect(atelier.getState().items).toHaveLength(0);
  });

  it("les écritures restent justes pour l'atelier (aucune régression, AC7)", () => {
    const { db } = makeTestDb();
    const id = makeTextSource(db, "Contenu.");
    const canvas = createCanvasRepo(db); // sans argument : comportement historique
    canvas.placeAt("source", id, 5, 5);
    const frame = canvas.createFrame({
      label: "Ancien geste",
      kind: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
    expect(canvas.getState().frames.map((f) => f.id)).toEqual([frame.id]);
    expect(canvas.getState().items.map((i) => i.ref)).toEqual([id]);
  });
});

describe("resolveCanvasTarget — la cible d'un dépôt de fichier (v1.6.3)", () => {
  it("un canvas existant est une cible valide (la ligne est résolue)", () => {
    const { db } = makeTestDb();
    const atelier = createCanvasesRepo(db).getAtelier();
    const hit = resolveCanvasTarget(db, atelier.id);
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.row.id).toBe(ATELIER_CANVAS_ID);
  });

  it("un id inconnu est refusé nommément (not_found — pas un 500 de FK plus tard)", () => {
    const { db } = makeTestDb();
    const miss = resolveCanvasTarget(db, "canvas-fantome");
    expect(miss).toEqual({ ok: false, reason: "not_found" });
  });

  it("un dossier n'est PAS une cible : on n'y dépose pas de fichier (est_un_dossier)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const folder = repo.create({ label: "Classeur", kind: "folder" });
    const refused = resolveCanvasTarget(db, folder.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("est_un_dossier");
      // la ligne accompagne le refus : l'écran peut NOMMER le dossier fautif
      expect(refused.row?.label).toBe("Classeur");
    }
  });

  it("la règle tient pour un dossier imbriqué (sous-dossier d'un dossier)", () => {
    const { db } = makeTestDb();
    const repo = createCanvasesRepo(db);
    const parent = repo.create({ label: "Parent", kind: "folder" });
    const child = repo.create({ label: "Enfant", kind: "folder", parentId: parent.id });
    const refused = resolveCanvasTarget(db, child.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("est_un_dossier");
  });
});
