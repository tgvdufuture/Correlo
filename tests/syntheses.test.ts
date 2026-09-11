import { describe, expect, it } from "vitest";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { createThemesRepo } from "@/lib/repositories/themes";
import {
  createSynthesesRepo,
  type EvidenceSnapshotEntry,
  type NewSynthesis,
} from "@/lib/repositories/syntheses";
import { decodeEmbedding } from "@/lib/llm/embedding-codec";
import { contentSig } from "@/lib/discover/epistemic";

function setup() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "Contenu un : le brutalisme assume le béton brut.", "Source un");
  const s2 = makeTextSource(db, "Contenu deux : le bilan fiscal amortit les charges.", "Source deux");
  const s3 = makeTextSource(db, "Contenu trois : l'urbanisme planifie les volumes.", "Source trois");
  const f1 = makeFragment(db, {
    sourceId: s1,
    chunkIndex: 0,
    text: "Le brutalisme assume le béton brut et la trame.",
  });
  const f2 = makeFragment(db, {
    sourceId: s1,
    chunkIndex: 1,
    text: "La façade reprend la trame du béton coulé.",
  });
  const f3 = makeFragment(db, {
    sourceId: s2,
    chunkIndex: 0,
    text: "Le bilan fiscal amortit les charges sur plusieurs exercices.",
  });
  const f4 = makeFragment(db, {
    sourceId: s3,
    chunkIndex: 0,
    text: "L'urbanisme planifie les volumes et les circulations.",
  });
  const themes = createThemesRepo(db);
  const themeId = themes.createMany([
    {
      runId: "run-1",
      corpusHash: "corpus-hash",
      seed: "seed-hex",
      label: "brutalisme · beton",
      centroid: [1, 0, 0, 0, 0, 0, 0, 0],
      size: 3,
      samplerVersion: "themes-v1",
    },
  ])[0];
  const syntheses = createSynthesesRepo(db);
  return { db, s1, s2, s3, f1, f2, f3, f4, themes, themeId, syntheses };
}

function snapshotOf(
  fragments: { id: string; sourceId: string; text: string }[]
): EvidenceSnapshotEntry[] {
  return fragments.map((f, i) => ({
    fragment_id: f.id,
    source_id: f.sourceId,
    source_title: null,
    content_hash: `hash-${i}`,
    locator: "[0,10)",
    text: f.text,
  }));
}

describe("repo themes", () => {
  it("écrit et relit les thèmes d'un run (centroïde Float32 LE relu à l'identique)", () => {
    const { themes } = setup();
    const rows = themes.listByRun("run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("brutalisme · beton");
    expect(rows[0].size).toBe(3);
    expect(rows[0].centroid_dimensions).toBe(8);
    expect(rows[0].sampler_version).toBe("themes-v1");
    expect(decodeEmbedding(rows[0].centroid, rows[0].centroid_dimensions)[0]).toBeCloseTo(1, 6);
    expect(themes.countByRun("run-1")).toBe(1);
    expect(themes.countByRun("run-inconnu")).toBe(0);
  });

  it("supprimer un run supprime ses thèmes et, en cascade, ses synthèses", () => {
    const { themes, syntheses, themeId, f1, f3 } = setup();
    const created = syntheses.create({
      ...baseSynthesis(themeId),
      evidence_fragment_ids: [f1, f3],
      provenance_snapshot: snapshotOf([
        { id: f1, sourceId: "s1", text: "a" },
        { id: f3, sourceId: "s2", text: "b" },
      ]),
    });
    expect(created.ok).toBe(true);
    expect(themes.deleteByRun("run-1")).toBe(1);
    expect(themes.listByRun("run-1")).toEqual([]);
    expect(syntheses.listByTheme(themeId)).toEqual([]);
  });
});

function baseSynthesis(themeId: string): Omit<NewSynthesis, "evidence_fragment_ids" | "provenance_snapshot"> {
  return {
    text: "Le brutalisme et la comptabilité partagent une même exigence de structure explicite.",
    theme_id: themeId,
    relation_kind: "combination",
    epistemic_status: "INFERENCE",
    content_sig: contentSig("synthese-de-test"),
    confidence: "medium",
    prompt_version: "synthesis-v1",
    chat_model: "test-model",
  };
}

describe("repo syntheses", () => {
  it("dérive les sources parentes des fragments réels (jamais de la confiance du modèle)", () => {
    const { db, syntheses, themeId, f1, f3, s1, s2 } = setup();
    const res = syntheses.create({
      ...baseSynthesis(themeId),
      evidence_fragment_ids: [f1, f3],
      provenance_snapshot: snapshotOf([
        { id: f1, sourceId: s1, text: "Le brutalisme assume le béton brut." },
        { id: f3, sourceId: s2, text: "Le bilan fiscal amortit les charges." },
      ]),
    });
    expect(res).toMatchObject({ ok: true, parentSourceIds: [s1, s2] });
    const row = db.prepare("SELECT * FROM syntheses").get() as {
      parent_source_ids: string;
      evidence_fragment_ids: string;
      state: string;
      stale: number;
    };
    expect(JSON.parse(row.parent_source_ids)).toEqual([s1, s2]);
    expect(JSON.parse(row.evidence_fragment_ids)).toEqual([f1, f3]);
    expect(row.state).toBe("proposed");
    expect(row.stale).toBe(0);
  });

  it("refuse une preuve mono-source, une preuve manquante et un thème inconnu", () => {
    const { syntheses, themeId, f1, f2, f3, s1, s2 } = setup();
    const common = baseSynthesis(themeId);

    expect(
      syntheses.create({
        ...common,
        evidence_fragment_ids: [f1, f2], // deux fragments de la même source
        provenance_snapshot: snapshotOf([
          { id: f1, sourceId: s1, text: "a" },
          { id: f2, sourceId: s1, text: "b" },
        ]),
      })
    ).toEqual({ ok: false, reason: "intra_source" });

    expect(
      syntheses.create({
        ...common,
        evidence_fragment_ids: [f1, "fragment-inexistant"],
        provenance_snapshot: snapshotOf([
          { id: f1, sourceId: s1, text: "a" },
          { id: "fragment-inexistant", sourceId: s2, text: "b" },
        ]),
      })
    ).toEqual({ ok: false, reason: "evidence_missing" });

    expect(
      syntheses.create({
        ...common,
        evidence_fragment_ids: [f1], // une seule preuve
        provenance_snapshot: snapshotOf([{ id: f1, sourceId: s1, text: "a" }]),
      })
    ).toEqual({ ok: false, reason: "evidence_missing" });

    expect(
      syntheses.create({
        ...baseSynthesis("theme-inexistant"),
        evidence_fragment_ids: [f1, f3],
        provenance_snapshot: snapshotOf([
          { id: f1, sourceId: s1, text: "a" },
          { id: f3, sourceId: s2, text: "b" },
        ]),
      })
    ).toEqual({ ok: false, reason: "theme_missing" });
  });

  it("n'insère qu'une fois un même énoncé (dédup content_sig)", () => {
    const { db, syntheses, themeId, f1, f3, s1, s2 } = setup();
    const payload = {
      ...baseSynthesis(themeId),
      evidence_fragment_ids: [f1, f3],
      provenance_snapshot: snapshotOf([
        { id: f1, sourceId: s1, text: "a" },
        { id: f3, sourceId: s2, text: "b" },
      ]),
    };
    expect(syntheses.create(payload).ok).toBe(true);
    expect(syntheses.create(payload)).toEqual({ ok: false, reason: "duplicate" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM syntheses").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("ne peut pas stocker un FACT (contrainte de schéma) et ne le confond pas avec un doublon", () => {
    const { syntheses, themeId, f1, f3, s1, s2 } = setup();
    expect(() =>
      syntheses.create({
        ...baseSynthesis(themeId),
        // cast volontaire : la base doit refuser un FACT même si le type l'interdit déjà
        epistemic_status: "FACT" as never,
        evidence_fragment_ids: [f1, f3],
        provenance_snapshot: snapshotOf([
          { id: f1, sourceId: s1, text: "a" },
          { id: f3, sourceId: s2, text: "b" },
        ]),
      })
    ).toThrow(/CHECK constraint failed/);
  });

  it("accept / reject : transitions depuis proposed seulement", () => {
    const { syntheses, themeId, f1, f3, s1, s2 } = setup();
    const created = syntheses.create({
      ...baseSynthesis(themeId),
      evidence_fragment_ids: [f1, f3],
      provenance_snapshot: snapshotOf([
        { id: f1, sourceId: s1, text: "a" },
        { id: f3, sourceId: s2, text: "b" },
      ]),
    });
    if (!created.ok) throw new Error("création attendue");
    expect(syntheses.accept(created.id)).toBe(true);
    expect(syntheses.accept(created.id)).toBe(false); // déjà tranchée
    expect(syntheses.reject(created.id)).toBe(false);
    expect(syntheses.countByState()).toEqual({ proposed: 0, accepted: 1, rejected: 0 });
    expect(syntheses.listDecidedByTheme(themeId).map((s) => s.state)).toEqual(["accepted"]);
  });

  it("marque stale seulement les synthèses qui citent la source, via provenance_snapshot", () => {
    const { db, syntheses, themeId, f1, f3, f4, s1, s2, s3 } = setup();
    const one = syntheses.create({
      ...baseSynthesis(themeId),
      content_sig: contentSig("synthese-un"),
      evidence_fragment_ids: [f1, f3],
      provenance_snapshot: snapshotOf([
        { id: f1, sourceId: s1, text: "Le brutalisme assume le béton brut." },
        { id: f3, sourceId: s2, text: "Le bilan fiscal amortit les charges." },
      ]),
    });
    // ne cite pas s1 : doit rester intacte
    const other = syntheses.create({
      ...baseSynthesis(themeId),
      content_sig: contentSig("synthese-deux"),
      evidence_fragment_ids: [f3, f4],
      provenance_snapshot: snapshotOf([
        { id: f3, sourceId: s2, text: "Le bilan fiscal amortit." },
        { id: f4, sourceId: s3, text: "L'urbanisme planifie les volumes." },
      ]),
    });
    if (!one.ok || !other.ok) throw new Error("création attendue");

    expect(syntheses.markStaleBySource(s1)).toBe(1);
    expect(syntheses.markStaleBySource(s1)).toBe(0); // déjà marquée
    const rows = db.prepare("SELECT id, stale FROM syntheses").all() as {
      id: string;
      stale: number;
    }[];
    expect(rows.find((r) => r.id === one.id)?.stale).toBe(1);
    expect(rows.find((r) => r.id === other.id)?.stale).toBe(0);

    // la source disparaît (fragments en cascade) : la synthèse reste stale et sa
    // provenance_snapshot reste lisible — c'est la garantie de réévaluation
    db.prepare("DELETE FROM sources WHERE id = ?").run(s1);
    const after = db.prepare("SELECT stale, provenance_snapshot FROM syntheses WHERE id = ?").get(one.id) as {
      stale: number;
      provenance_snapshot: string;
    };
    expect(after.stale).toBe(1);
    const snapshot = JSON.parse(after.provenance_snapshot) as EvidenceSnapshotEntry[];
    expect(snapshot[0]).toMatchObject({ source_id: s1, locator: "[0,10)" });
    expect(snapshot[0].text).toContain("brutalisme");
  });
});
