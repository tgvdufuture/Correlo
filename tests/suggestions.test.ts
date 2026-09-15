import { describe, expect, it } from "vitest";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { contentSig } from "@/lib/discover/epistemic";

function newSuggestion(over: Partial<Parameters<ReturnType<typeof createSuggestionsRepo>["create"]>[0]> = {}) {
  return {
    claim: "Le fragment B reformule l'idée du fragment A.",
    relation_type: "analogy" as const,
    tier: "medium" as const,
    fragment_a_id: "frag-a",
    fragment_b_id: "frag-b",
    pair_key: "frag-a:frag-b",
    content_sig: contentSig("Le fragment B reformule l'idée du fragment A."),
    epistemic_status: "INFERENCE" as const,
    prompt_version: "discovery-v1",
    chat_model: "test-model",
    ...over,
  };
}

describe("repository suggestions", () => {
  it("crée une suggestion valide (state discovered, contraintes remplies)", () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "Contenu source un.");
    const s2 = makeTextSource(db, "Contenu source deux.");
    makeFragment(db, { sourceId: s1, text: "aaa", id: "frag-a" });
    makeFragment(db, { sourceId: s2, text: "bbb", id: "frag-b" });
    const repo = createSuggestionsRepo(db);

    const res = repo.create(newSuggestion());
    expect(res.ok).toBe(true);
    const row = db.prepare("SELECT * FROM suggestions WHERE id = ?").get((res as { id: string }).id) as {
      state: string;
      pair_key: string;
    };
    expect(row.state).toBe("discovered");
    expect(row.pair_key).toBe("frag-a:frag-b");
  });

  it("doublon exact (pair_key, relation_type, content_sig) → duplicate", () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "Contenu source un.");
    const s2 = makeTextSource(db, "Contenu source deux.");
    makeFragment(db, { sourceId: s1, text: "aaa", id: "frag-a" });
    makeFragment(db, { sourceId: s2, text: "bbb", id: "frag-b" });
    const repo = createSuggestionsRepo(db);
    const first = repo.create(newSuggestion());
    expect(first.ok).toBe(true);
    // le doublon renvoie l'id de la ligne identique : un rejeu de run doit pouvoir
    // reconnaître qu'il reproduit SA sortie (Phase 2B, AC1) et non un échec
    expect(repo.create(newSuggestion())).toEqual({
      ok: false,
      reason: "duplicate",
      existingId: (first as { id: string }).id,
    });
  });

  it("variante bloquée : accepted/rejected sur (pair_key, relation_type) interdit l'insertion", () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "Contenu source un.");
    const s2 = makeTextSource(db, "Contenu source deux.");
    makeFragment(db, { sourceId: s1, text: "aaa", id: "frag-a" });
    makeFragment(db, { sourceId: s2, text: "bbb", id: "frag-b" });
    const repo = createSuggestionsRepo(db);
    const first = repo.create(newSuggestion());
    expect(first.ok).toBe(true);
    db.prepare("UPDATE suggestions SET state = 'rejected' WHERE id = ?").run(
      (first as { id: string }).id
    );
    // même paire, claim reformulé (content_sig différent) → bloqué par la variante
    const variant = repo.create(
      newSuggestion({ claim: "Le fragment B reformule l'idée du fragment A, autrement dit." })
    );
    expect(variant).toEqual({ ok: false, reason: "blocked_variant" });
    // paire différente → toujours créable
    const other = repo.create(
      newSuggestion({
        fragment_a_id: "frag-a",
        fragment_b_id: "frag-b",
        pair_key: "autre:paire",
      })
    );
    expect(other.ok).toBe(true);
  });

  it("paire intra-source interdite", () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "Contenu source unique.");
    makeFragment(db, { sourceId: s1, text: "aaa", id: "frag-a" });
    makeFragment(db, { sourceId: s1, text: "bbb", id: "frag-b", chunkIndex: 1 });
    const repo = createSuggestionsRepo(db);
    expect(repo.create(newSuggestion())).toEqual({ ok: false, reason: "intra_source" });
  });

  it("fragment inexistant → fragment_missing (0 ID inventé)", () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "Contenu source un.");
    makeFragment(db, { sourceId: s1, text: "aaa", id: "frag-a" });
    const repo = createSuggestionsRepo(db);
    expect(
      repo.create(newSuggestion({ fragment_b_id: "frag-inexistant" }))
    ).toEqual({ ok: false, reason: "fragment_missing" });
  });

  it("countByState : répartition des états", () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "Contenu source un.");
    const s2 = makeTextSource(db, "Contenu source deux.");
    makeFragment(db, { sourceId: s1, text: "aaa", id: "frag-a" });
    makeFragment(db, { sourceId: s2, text: "bbb", id: "frag-b" });
    const repo = createSuggestionsRepo(db);
    repo.create(newSuggestion());
    expect(repo.countByState().discovered).toBe(1);
    expect(repo.countByState().rejected).toBe(0);
  });
});