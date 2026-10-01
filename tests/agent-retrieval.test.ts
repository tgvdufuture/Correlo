import { describe, expect, it } from "vitest";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { buildCorpusIndex, interleave, type IndexedFragment } from "@/lib/agent/retrieval";
import { buildInvestigationPrompt } from "@/lib/agent/prompts";
import { INVESTIGATION_ACTION_SCHEMA } from "@/lib/agent/schema";
import type { CatalogueEntry } from "@/lib/agent/types";

/**
 * Phase 4 — outils locaux de l'agent (US-09).
 *
 * Ces tests portent sur ce que l'agent **peut voir** : la recherche lexicale, le
 * voisinage vectoriel, le catalogue présenté au modèle. Le comportement du modèle est
 * simulé dans `investigation.test.ts` ; ici, aucun LLM n'intervient.
 */

/** Corpus : 3 sources, 5 fragments dont un sommaire (appareil). */
function corpus() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "s1", "Source un");
  const s2 = makeTextSource(db, "s2", "Source deux");
  const s3 = makeTextSource(db, "s3", "Source trois");
  const f1 = makeFragment(db, {
    sourceId: s1,
    chunkIndex: 0,
    id: "frag-methode",
    text: "L'experience de la methode experimentale sur les corps pesants.",
    vector: [1, 0, 0, 0, 0, 0, 0, 0],
  });
  const f2 = makeFragment(db, {
    sourceId: s2,
    chunkIndex: 0,
    id: "frag-mesures",
    text: "La methode experimentale exige des mesures repetees.",
    vector: [0.7, 0.7, 0, 0, 0, 0, 0, 0],
  });
  const f3 = makeFragment(db, {
    sourceId: s3,
    chunkIndex: 0,
    id: "frag-commerce",
    text: "Le commerce des nations suit des lois differentes.",
    vector: [0, 1, 0, 0, 0, 0, 0, 0],
  });
  const f4 = makeFragment(db, {
    sourceId: s1,
    chunkIndex: 1,
    id: "frag-sommaire",
    text: "Table des matieres\nChapitre I\nChapitre II\nChapitre III",
    vector: [1, 0, 0, 0, 0, 0, 0, 0],
  });
  return { db, s1, s2, s3, f1, f2, f3, f4 };
}

describe("index local du corpus (outils de l'agent)", () => {
  it("recherche lexicale : déterministe, ordonnée, sans fragment d'appareil", () => {
    const { db, f1, f2 } = corpus();
    const index = buildCorpusIndex(db);
    expect(index.size).toBe(4);

    const found = index.search("methode experimentale", 3).map((f) => f.id);
    expect(found).toContain(f1);
    expect(found).toContain(f2);
    // le sommaire parle aussi de « matieres », mais un appareil n'est pas une preuve
    expect(index.search("matieres", 5).map((f) => f.id)).not.toContain("frag-sommaire");
    // même question, même réponse (aucun aléa : ni PRNG ni ordre de Map)
    expect(index.search("methode experimentale", 3).map((f) => f.id)).toEqual(found);
    // requête sans terme de contenu : aucun résultat, jamais tout le corpus
    expect(index.search("de la", 3)).toEqual([]);
  });

  /**
   * Recherche sémantique (décision du 2026-10-01) : la requête est encodée par le
   * connecteur local et ordonnée par cosine. Le corpus de test dit « modèle de langage »
   * — une requête « LLM » ne partage aucun mot, donc la lexicale ne rend rien : c'est
   * exactement l'angle mort que la sémantique comble. Sans encodeur, `semanticSearch`
   * est vide (comportement des phases 4/6, et voie des tests sans réseau).
   */
  it("recherche sémantique : trouve par le sens quand les mots manquent, vide sans encodeur", async () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "s1", "IA");
    makeFragment(db, {
      sourceId: s1,
      id: "frag-llm-fr",
      text: "Les modeles de langage predisent le mot suivant d'une sequence.",
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
    });
    const embedQuery = async (): Promise<number[]> => [1, 0, 0, 0, 0, 0, 0, 0];

    const index = buildCorpusIndex(db, { embedQuery });
    // lexical : « LLM » ne partage rien avec le texte français
    expect(index.search("LLM", 3)).toEqual([]);
    // sémantique : la requête pointe le même espace que le fragment
    const semantic = await index.semanticSearch("LLM", 3);
    expect(semantic.map((f) => f.id)).toContain("frag-llm-fr");

    // sans encodeur : pas d'erreur, juste aucun résultat (dégradation, jamais panne)
    const bare = buildCorpusIndex(db);
    await expect(bare.semanticSearch("LLM", 3)).resolves.toEqual([]);
  });

  it("interleave : fusion par rang, lexical d'abord, sans doublon", () => {
    const f = (id: string): IndexedFragment => ({
      id,
      sourceId: "s",
      sourceTitle: null,
      chunkIndex: 0,
      locator: "",
      text: "",
      embedding: new Float32Array(8),
    });
    const a = f("a");
    const b = f("b");
    const c = f("c");
    // intercalage par rang : a (lex 1), b (sem 1), c (lex 2)…
    expect(interleave([a, c], [b], 5).map((x) => x.id)).toEqual(["a", "b", "c"]);
    // doublon écarté, borne k respectée
    expect(interleave([a, b], [a], 2).map((x) => x.id)).toEqual(["a", "b"]);
    expect(interleave([a, b, c], [], 2).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("voisinage vectoriel : hors de la source du fragment, appareil exclu, ordre par cosine", () => {
    const { db } = corpus();
    const index = buildCorpusIndex(db);
    const near = index.neighbours("frag-methode", 3).map((f) => f.id);
    // ordre strictement décroissant de cosine : [0.7,0.7] (0,707) puis [0,1] (0)
    expect(near).toEqual(["frag-mesures", "frag-commerce"]);
    expect(near).not.toContain("frag-sommaire"); // même source ET appareil
    expect(index.neighbours("inconnu", 3)).toEqual([]);
  });

  it("un fragment d'appareil reste adressable, mais n'est jamais proposé", () => {
    const { db } = corpus();
    const index = buildCorpusIndex(db);
    expect(index.get("frag-sommaire")?.structural).toBe(true);
    // une graine d'appareil doit pouvoir être étendue : ses voisins sont proposés...
    expect(index.neighbours("frag-sommaire", 3).map((f) => f.id)).toContain("frag-mesures");
    // ...mais lui-même ne figure dans aucun résultat
    const offered = [
      ...index.search("matieres", 5).map((f) => f.id),
      ...index.neighbours("frag-methode", 5).map((f) => f.id),
    ];
    expect(offered).not.toContain("frag-sommaire");
  });
});

describe("prompt et schéma de l'agent", () => {
  const entry = (index: number, id: string): CatalogueEntry => ({
    index,
    fragment_id: id,
    source_id: `src-${index}`,
    source_title: `Titre ${index}`,
    chunk_index: 0,
    locator: "[0,10)",
    text: `Texte du fragment ${index}.`,
    origin: "seed",
  });

  it("le catalogue est cité par indice, jamais par identifiant de fragment", () => {
    const messages = buildInvestigationPrompt({
      claim: "Le doute de Descartes prepare la mesure de Claude Bernard.",
      relationType: "analogy",
      catalogue: [entry(0, "frag-secret-a"), entry(1, "frag-secret-b")],
      steps: [],
      stepBudget: 5,
    });
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("[0]");
    expect(user).toContain("[1]");
    expect(user).toContain("Actions restantes : 5");
    // aucun identifiant technique ne peut fuiter : le modèle ne connaît que des indices
    expect(user).not.toContain("frag-secret-a");
    expect(user).not.toContain("frag-secret-b");
    // le contrat d'action est dans le message système
    expect(messages[0].content).toContain("\"action\":\"conclude\"");
  });

  it("transcription : les étapes passées disent ce qui a été ajouté, et le budget décompte", () => {
    const messages = buildInvestigationPrompt({
      claim: "claim",
      relationType: "cause",
      catalogue: [entry(0, "a"), entry(1, "b"), entry(2, "c")],
      steps: [
        { index: 1, action: "search", input: { query: "mesure" }, added: [2], observation: [2], failed: false },
        { index: 2, action: "expand", input: { fragment: 9 }, added: [], observation: [], failed: true, failure: "indice_hors_catalogue" },
      ],
      stepBudget: 5,
    });
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("recherche dans le corpus « mesure »");
    expect(user).toContain("[2]");
    expect(user).toContain("indice_hors_catalogue");
    expect(user).toContain("Actions restantes : 3");
    expect(user).toContain("ÉTAPES DÉJÀ EFFECTUÉES (2/5)");
  });

  it("schéma : une action par étape, champs requis par action, citations sans doublon", () => {
    expect(INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "search", query: "mesure" }).success).toBe(true);
    expect(INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "search" }).success).toBe(false);
    expect(INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "expand" }).success).toBe(false);
    expect(INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "expand", fragment: 3 }).success).toBe(true);
    expect(
      INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "conclude", answer: "a", citations: [1, 3] }).success
    ).toBe(true);
    expect(INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "conclude", answer: "a" }).success).toBe(false);
    expect(
      INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "conclude", answer: "a", citations: [1, 1] }).success
    ).toBe(false);
    // une réponse ne peut accompagner qu'une conclusion
    expect(
      INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "search", query: "x", answer: "a" }).success
    ).toBe(false);
    // action inconnue : refusée (elle ne peut pas être exécutée)
    expect(INVESTIGATION_ACTION_SCHEMA.safeParse({ action: "browse", query: "x" }).success).toBe(false);
  });
});
