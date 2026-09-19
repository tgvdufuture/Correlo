import { describe, expect, it } from "vitest";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { createSuggestionsRepo, type NewSuggestion } from "@/lib/repositories/suggestions";
import { createConstructionsRepo } from "@/lib/repositories/constructions";
import { createReviewService } from "@/lib/discover/review-service";
import { contentSig } from "@/lib/discover/epistemic";

/**
 * Phase 3 — feed, acceptation, rejet, péremption.
 * AC1 : feed trié par tier, une seule suggestion par (pair_key, relation_type).
 * AC2 : accept → Construction (US-07) ; reject → US-06 ; 0 rejetée ne réapparaît.
 * AC3 : suppression de source ⇒ Construction stale = 1, provenance intacte (US-08).
 */

/** Corpus minimal : 2 sources, 2 fragments, une suggestion insérable. */
function setup() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "Contenu source un.");
  const s2 = makeTextSource(db, "Contenu source deux.");
  const fA = makeFragment(db, { sourceId: s1, text: "Le texte du fragment A.", id: "frag-a" });
  const fB = makeFragment(db, { sourceId: s2, text: "Le texte du fragment B.", id: "frag-b" });
  const suggestions = createSuggestionsRepo(db);
  const constructions = createConstructionsRepo(db);
  const service = createReviewService(db);
  const add = (over: Partial<NewSuggestion> = {}) => {
    const claim = over.claim ?? "Le fragment B déplace l'idée du fragment A.";
    const res = suggestions.create({
      claim,
      relation_type: "analogy",
      tier: "medium",
      fragment_a_id: fA,
      fragment_b_id: fB,
      pair_key: "frag-a:frag-b",
      content_sig: contentSig(claim),
      epistemic_status: "INFERENCE",
      prompt_version: "discovery-v4",
      chat_model: "test-model",
      ...over,
    });
    if (!res.ok) throw new Error(`insertion de test refusée : ${res.reason}`);
    return res.id;
  };
  return { db, s1, s2, fA, fB, suggestions, constructions, service, add };
}

describe("feed (AC1)", () => {
  it("n'expose qu'une suggestion par (pair_key, relation_type), la mieux classée", () => {
    const { service, add } = setup();
    add({ claim: "Version faible.", tier: "weak" });
    add({ claim: "Version moyenne.", tier: "medium" });
    const strong = add({ claim: "Version forte.", tier: "strong" });

    const feed = service.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe(strong);
    expect(feed[0].claim).toBe("Version forte.");
  });

  it("tie-break à tier égal : la plus récente (ordre d'insertion)", () => {
    const { service, add } = setup();
    add({ claim: "Première version forte.", tier: "strong" });
    const last = add({ claim: "Seconde version forte.", tier: "strong" });

    const feed = service.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe(last);
  });

  it("deux relation_type sur la même paire sont deux lignes de feed", () => {
    const { service, add } = setup();
    add({ claim: "Analogie.", relation_type: "analogy" });
    add({ claim: "Contradiction.", relation_type: "contradiction" });

    expect(service.feed().map((f) => f.relation_type).sort()).toEqual([
      "analogy",
      "contradiction",
    ]);
  });

  it("trie par tier décroissant (strong, medium, weak)", () => {
    const { service, add } = setup();
    add({ claim: "Faible.", tier: "weak", pair_key: "p3" });
    add({ claim: "Forte.", tier: "strong", pair_key: "p1" });
    add({ claim: "Moyenne.", tier: "medium", pair_key: "p2" });

    expect(service.feed().map((f) => f.tier)).toEqual(["strong", "medium", "weak"]);
  });

  it("joint les 2 fragments avec source, locator et texte (US-05 AC1)", () => {
    const { service, add } = setup();
    add();

    const [item] = service.feed();
    expect(item.fragments).toHaveLength(2);
    expect(item.fragments.map((f) => f.text)).toEqual([
      "Le texte du fragment A.",
      "Le texte du fragment B.",
    ]);
    expect(item.fragments.every((f) => f.source_title && f.locator)).toBe(true);
    expect(item.fragments.map((f) => f.source_id)).toHaveLength(2);
  });

  it("marque les suggestions exposées `shown` (sans les rétrograder ensuite)", () => {
    const { service, suggestions, add } = setup();
    add();

    expect(service.feed()[0].state).toBe("shown");
    expect(suggestions.countByState().shown).toBe(1);
    // seconde exposition : déjà `shown`, la ligne ne change pas
    expect(service.feed()[0].state).toBe("shown");
  });
});

describe("ouverture du détail (métrique « suggestions ouvertes »)", () => {
  it("passe à `opened` depuis discovered ou shown", () => {
    const { service, suggestions, add } = setup();
    const id = add();
    expect(service.open(id)).toEqual({ ok: true });
    expect(suggestions.getById(id)?.state).toBe("opened");
  });

  it("ne rétrograde jamais une suggestion acceptée", () => {
    const { service, suggestions, add } = setup();
    const id = add();
    expect(service.accept(id).ok).toBe(true);
    service.open(id);
    expect(suggestions.getById(id)?.state).toBe("accepted");
  });

  it("404 sur une suggestion inconnue", () => {
    const { service } = setup();
    expect(service.open("inconnue")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("acceptation → Construction (US-07)", () => {
  it("crée une Construction depth = 1 avec provenance complète", () => {
    const { service, add, s1, s2 } = setup();
    const id = add({ claim: "Le fragment B déplace l'idée du fragment A." });

    const res = service.accept(id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.construction;

    expect(c.depth).toBe(1);
    expect(c.suggestion_id).toBe(id);
    expect(c.stale).toBe(false);
    expect(c.text).toBe("Le fragment B déplace l'idée du fragment A.");
    expect(c.parent_source_ids).toEqual([s1, s2].sort());
    expect(c.evidence_fragment_ids).toEqual(["frag-a", "frag-b"]);
    expect(c.provenance_snapshot).toHaveLength(2);
    expect(c.provenance_snapshot.map((p) => p.fragment_text)).toEqual([
      "Le texte du fragment A.",
      "Le texte du fragment B.",
    ]);
    // source, hash et locator sont copiés : c'est ce qui reste vérifiable après CASCADE
    expect(c.provenance_snapshot.every((p) => p.source_content_hash.length === 64)).toBe(true);
    expect(c.provenance_snapshot.every((p) => p.locator.length > 0)).toBe(true);
    expect(c.provenance_snapshot.every((p) => p.source_title !== null)).toBe(true);
  });

  it("plafonne le statut à INFERENCE — jamais FACT (US-07 AC2)", () => {
    const { service, add } = setup();
    const fact = add({ claim: "Claim factuel.", epistemic_status: "FACT", pair_key: "p-fact" });
    const hyp = add({ claim: "Claim hypothétique.", epistemic_status: "HYPOTHESIS", pair_key: "p-hyp" });
    const spec = add({ claim: "Claim spéculatif.", epistemic_status: "SPECULATION", pair_key: "p-spec" });

    for (const [id, expected] of [
      [fact, "INFERENCE"],
      [hyp, "HYPOTHESIS"],
      [spec, "SPECULATION"],
    ] as const) {
      const res = service.accept(id);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.construction.epistemic_status).toBe(expected);
    }
  });

  it("refuse la double intégration (suggestion_id UNIQUE) et laisse une seule ligne", () => {
    const { service, db, add } = setup();
    const id = add();

    expect(service.accept(id).ok).toBe(true);
    expect(service.accept(id)).toEqual({ ok: false, reason: "already_integrated" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM constructions").get()).toEqual({ n: 1 });
  });

  it("passe la suggestion à `accepted`", () => {
    const { service, suggestions, add } = setup();
    const id = add();
    service.accept(id);
    expect(suggestions.getById(id)?.state).toBe("accepted");
  });

  it("404 sur une suggestion inconnue", () => {
    const { service } = setup();
    expect(service.accept("inconnue")).toEqual({ ok: false, reason: "not_found" });
  });

  it("422 si les fragments cités ont disparu", () => {
    const { service, db, add } = setup();
    const id = add();
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM fragments WHERE id = ?").run("frag-a");
    db.pragma("foreign_keys = ON");

    expect(service.accept(id)).toEqual({ ok: false, reason: "fragments_missing" });
  });
});

describe("rejet (US-06)", () => {
  it("exige exactement une raison prédéfinie", () => {
    const { service, suggestions, add } = setup();
    const id = add();

    expect(service.reject(id, undefined)).toEqual({ ok: false, reason: "invalid_reason" });
    expect(service.reject(id, "bogus")).toEqual({ ok: false, reason: "invalid_reason" });
    expect(service.reject(id, 42)).toEqual({ ok: false, reason: "invalid_reason" });
    // rien n'est persisté tant que la raison est invalide
    expect(suggestions.getById(id)?.state).toBe("discovered");
    expect(suggestions.getById(id)?.feedback_reason).toBeNull();
  });

  it("persiste la raison et sort la suggestion du feed", () => {
    const { service, suggestions, add } = setup();
    const id = add();

    expect(service.reject(id, "already_known")).toEqual({ ok: true });
    const row = suggestions.getById(id);
    expect(row?.state).toBe("rejected");
    expect(row?.feedback_reason).toBe("already_known");
    expect(service.feed()).toHaveLength(0);
    // mais elle reste consultable explicitement
    expect(service.feed({ state: "rejected" })).toHaveLength(1);
  });

  it("404 sur une suggestion inconnue (raison valide)", () => {
    const { service } = setup();
    expect(service.reject("inconnue", "trivial")).toEqual({ ok: false, reason: "not_found" });
  });

  it("0 rejetée ne réapparaît, y compris reformulée : variante bloquée", () => {
    const { service, suggestions, add } = setup();
    const id = add({ claim: "Formulation initiale." });
    service.reject(id, "false");

    // reformulation de la même paire et de la même relation : refusée à l'insertion
    expect(
      suggestions.create({
        claim: "Autre manière de dire exactement la même chose.",
        relation_type: "analogy",
        tier: "strong",
        fragment_a_id: "frag-a",
        fragment_b_id: "frag-b",
        pair_key: "frag-a:frag-b",
        content_sig: contentSig("Autre manière de dire exactement la même chose."),
        epistemic_status: "INFERENCE",
        prompt_version: "discovery-v5",
        chat_model: "test-model",
      })
    ).toEqual({ ok: false, reason: "blocked_variant" });
    expect(service.feed()).toHaveLength(0);
  });

  it("la décision couvre toutes les variantes de la paire, pas la seule ligne décidée", () => {
    const { service, suggestions, add } = setup();
    const first = add({ claim: "Variante une.", tier: "weak" });
    const second = add({ claim: "Variante deux.", tier: "strong" });

    service.reject(first, "off_topic");

    // la variante la plus forte ne doit pas resurgir comme représentante
    expect(suggestions.getById(second)?.state).toBe("rejected");
    expect(suggestions.getById(second)?.feedback_reason).toBe("off_topic");
    expect(service.feed()).toHaveLength(0);
  });
});

describe("péremption et provenance (US-08, AC3)", () => {
  it("suppression de source ⇒ stale = 1 avec provenance_snapshot intact", () => {
    const { service, constructions, db, s1, add } = setup();
    const res = service.accept(add());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const snapshotBefore = res.construction.provenance_snapshot;

    db.prepare("DELETE FROM sources WHERE id = ?").run(s1); // CASCADE fragments/suggestions

    expect(constructions.markStaleForSource(s1)).toBe(1);
    const after = constructions.getById(res.construction.id);
    expect(after?.stale).toBe(true);
    // AC1 : la provenance reste lisible après la disparition des fragments
    expect(after?.provenance_snapshot).toEqual(snapshotBefore);
    expect(after?.provenance_snapshot.some((p) => p.fragment_text.length > 0)).toBe(true);
    // et le fragment cité a bien disparu, donc la copie est la seule source
    expect(db.prepare("SELECT COUNT(*) AS n FROM fragments WHERE id = 'frag-a'").get()).toEqual({
      n: 0,
    });
  });

  it("ne périme que les Constructions qui citent la source supprimée", () => {
    const { db, service, constructions, suggestions, s1, add } = setup();
    // une connexion hors de la source s1 : 2 sources neuves, jamais touchées
    const s3 = makeTextSource(db, "Contenu source trois.");
    const s4 = makeTextSource(db, "Contenu source quatre.");
    makeFragment(db, { sourceId: s3, text: "Fragment C.", id: "frag-c" });
    makeFragment(db, { sourceId: s4, text: "Fragment D.", id: "frag-d" });
    const other = suggestions.create({
      claim: "Connexion hors source un.",
      relation_type: "cause",
      tier: "medium",
      fragment_a_id: "frag-c",
      fragment_b_id: "frag-d",
      pair_key: "frag-c:frag-d",
      content_sig: contentSig("Connexion hors source un."),
      epistemic_status: "INFERENCE",
      prompt_version: "discovery-v4",
      chat_model: "test-model",
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;

    const touching = service.accept(add());
    const untouched = service.accept(other.id);
    expect(touching.ok && untouched.ok).toBe(true);

    expect(constructions.markStaleForSource(s1)).toBe(1);
    if (!untouched.ok || !touching.ok) return;
    expect(constructions.getById(touching.construction.id)?.stale).toBe(true);
    expect(constructions.getById(untouched.construction.id)?.stale).toBe(false);

    // une source qui n'apparaît dans aucun snapshot ne touche rien
    expect(constructions.markStaleForSource("source-inexistante")).toBe(0);
  });

  it("marquer deux fois ne recompte pas (stale = 0 → 1 uniquement)", () => {
    const { service, constructions, s1, add } = setup();
    service.accept(add());
    expect(constructions.markStaleForSource(s1)).toBe(1);
    expect(constructions.markStaleForSource(s1)).toBe(0);
    expect(constructions.getById(constructions.list()[0].id)?.stale).toBe(true);
  });
});

describe("liste des Constructions (canvas)", () => {
  it("renvoie les JSON décodés et l'état de péremption", () => {
    const { service, constructions, add } = setup();
    service.accept(add());

    const list = constructions.list();
    expect(list).toHaveLength(1);
    expect(Array.isArray(list[0].parent_source_ids)).toBe(true);
    expect(Array.isArray(list[0].evidence_fragment_ids)).toBe(true);
    expect(Array.isArray(list[0].provenance_snapshot)).toBe(true);
    expect(typeof list[0].stale).toBe("boolean");
  });
});
