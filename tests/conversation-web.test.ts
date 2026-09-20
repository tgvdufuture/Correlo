import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";
import { createConversationsRepo, conversationTitle } from "@/lib/repositories/conversations";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { ConversationService, usableEvidence } from "@/lib/agent/conversation-service";
import { createConversationReviewService } from "@/lib/agent/conversation-review";
import { createWebTools, type WebTools } from "@/lib/agent/web-tools";
import { WebRefusalError } from "@/lib/agent/web-guard";
import { webExcerpt, type ConversationTurn } from "@/lib/agent/conversation-types";
import { contentSig } from "@/lib/discover/epistemic";
import type { WebSearchProvider, WebSearchResult } from "@/lib/agent/web-search";
import type { WebPage } from "@/lib/agent/web-page";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";

/**
 * Phase 6 — outils web : déverrouillage **par constat**, budgets séparés, citations datées
 * (amendement v1.3 §13.4, AC2′/AC5′/AC6/AC7).
 *
 * Le modèle est scripté et les deux outils sont faux : ce qui est testé ici est la
 * **décision du serveur** (qui expose quoi, quand, et ce qu'il accepte de citer), jamais la
 * qualité d'une recherche réelle. La latence d'un tour est celle d'un objet en mémoire.
 */

const V = (x: number, y: number): number[] => [x, y, 0, 0, 0, 0, 0, 0];
const AT = new Date("2026-09-20T09:30:00.000Z");
const READ_AT = new Date("2026-09-20T09:31:00.000Z");

const PAGE_TEXT =
  "La mesure experimentale fixe les conditions de l'observation et les protocoles du laboratoire. ".repeat(3);

const SEARCH_RESULTS: WebSearchResult[] = [
  {
    title: "Comparaison des protocoles",
    url: "https://exemple.org/protocoles",
    snippet: "publié le 2024-03-04",
    published_at: "2024-03-04T00:00:00.000Z",
  },
  {
    title: "Manuel de métrologie",
    url: "https://exemple.net/metrologie",
    snippet: null,
    published_at: null,
  },
];

class ScriptedLlm implements LlmProvider {
  calls = 0;
  prompts: string[] = [];
  /** Le message système : les règles durables y vivent, le message d'utilisateur porte l'état. */
  systems: string[] = [];
  constructor(private actions: Record<string, unknown>[]) {}
  async embed(): Promise<number[]> {
    throw new Error("pas d'embedding dans la conversation");
  }
  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    const action =
      this.actions[Math.min(this.calls, this.actions.length - 1)] ?? {
        action: "search",
        query: "mesure",
      };
    this.calls += 1;
    this.prompts.push(messages[messages.length - 1].content);
    this.systems.push(messages[0].content);
    return schema.parse(action);
  }
}

class FakeSearch implements WebSearchProvider {
  name = "fake";
  queries: string[] = [];
  constructor(
    private results: WebSearchResult[] = SEARCH_RESULTS,
    private failure?: Error
  ) {}
  async search(query: string): Promise<WebSearchResult[]> {
    this.queries.push(query);
    if (this.failure) throw this.failure;
    return this.results;
  }
}

function makeRead(input?: { failure?: Error; url?: string }) {
  const calls: string[] = [];
  const read = async (url: string): Promise<WebPage> => {
    calls.push(url);
    if (input?.failure) throw input.failure;
    return { url: input?.url ?? url, title: "Page lue", text: PAGE_TEXT, redirects: [], bytes: 10 };
  };
  return { read, calls };
}

function tools(opts?: {
  access?: "on" | "off";
  provider?: "exa" | "none";
  search?: WebSearchProvider;
  read?: (url: string) => Promise<WebPage>;
}): WebTools {
  return createWebTools(
    {
      access: opts?.access ?? "on",
      provider: opts?.provider ?? "exa",
      exaApiKey: "clé-de-test",
      maxSteps: 3,
      unlockMinEvidence: 2,
      searchResults: 5,
    },
    { search: opts?.search, read: opts?.read }
  );
}

/** Corpus à **deux** sources : le catalogue porte assez de preuves transversales. */
function twoSources() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "s1", "Descartes");
  const s2 = makeTextSource(db, "s2", "Claude Bernard");
  const fA = makeFragment(db, {
    sourceId: s1,
    chunkIndex: 0,
    id: "frag-doute",
    text: "Le doute methodique ecarte les opinions seulement probables de la mesure.",
    vector: V(1, 0),
  });
  const fB = makeFragment(db, {
    sourceId: s2,
    chunkIndex: 0,
    id: "frag-mesure",
    text: "La mesure experimentale fixe les conditions de l'observation.",
    vector: V(0, 1),
  });
  makeFragment(db, {
    sourceId: s2,
    chunkIndex: 1,
    id: "frag-conditions",
    text: "Les conditions de la mesure exigent une observation repetee.",
    vector: V(0.7, 0.7),
  });
  return { db, s1, s2, fA, fB };
}

/**
 * Corpus à **une seule** source : le catalogue ne porte aucune preuve transversale, donc
 * `usableEvidence` vaut 0 — c'est le cas « le corpus ne suffit pas ».
 */
function oneSource() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "s1", "Claude Bernard");
  for (let i = 0; i < 4; i++) {
    makeFragment(db, {
      sourceId: s1,
      chunkIndex: i,
      id: `frag-${i}`,
      text: `La mesure experimentale numero ${i} fixe les conditions de l'observation.`,
      vector: V(1, i * 0.1),
    });
  }
  return { db, s1 };
}

function seedSynthesis(db: ReturnType<typeof makeTestDb>["db"], evidence: string[]): string {
  const fragments = createFragmentsRepo(db);
  const sources = createSourcesRepo(db);
  db.prepare(
    `INSERT INTO themes (id, run_id, corpus_hash, seed, label, centroid, centroid_dimensions,
       size, sampler_version, created_at)
     VALUES ('theme-1', 'run-1', 'hash-1', 'seed-1', 'doute · mesure', ?, 8, 2, 'seeds-v1', '2026-09-20')`
  ).run(encodeEmbedding(V(1, 0), 8));
  const text = "Le doute cartésien énonce la règle que la mesure expérimentale applique au vivant.";
  const created = createSynthesesRepo(db).create({
    text,
    theme_id: "theme-1",
    relation_kind: "extension",
    epistemic_status: "INFERENCE",
    evidence_fragment_ids: evidence,
    provenance_snapshot: evidence.map((id) => {
      const f = fragments.getById(id) as NonNullable<ReturnType<typeof fragments.getById>>;
      return {
        fragment_id: f.id,
        source_id: f.source_id,
        source_title: sources.getById(f.source_id)?.title ?? null,
        content_hash: "hash",
        locator: f.locator,
        text: f.text,
      };
    }),
    content_sig: contentSig(text),
    confidence: "high",
    prompt_version: "synthesis-v2",
    chat_model: "test-model",
  });
  if (!created.ok) throw new Error(`synthèse de test refusée : ${created.reason}`);
  return created.id;
}

function startTurn(
  db: ReturnType<typeof makeTestDb>["db"],
  opts?: { anchor?: string | null; question?: string }
) {
  const conversations = createConversationsRepo(db);
  const question = opts?.question ?? "Que disent ces documents sur la mesure ?";
  conversations.create({
    id: "conv-1",
    anchorKind: opts?.anchor ? "synthesis" : "corpus",
    anchorRef: opts?.anchor ?? null,
    title: conversationTitle(question),
    chatModel: "test-model",
    promptVersion: "conversation-v4",
  });
  const user = conversations.addUserMessage({ id: "msg-user-1", conversationId: "conv-1", text: question });
  return { conversations, user, question };
}

function makeService(
  db: ReturnType<typeof makeTestDb>["db"],
  chat: LlmProvider,
  web?: WebTools
) {
  return new ConversationService({
    db,
    conversations: createConversationsRepo(db),
    syntheses: createSynthesesRepo(db),
    fragments: createFragmentsRepo(db),
    sources: createSourcesRepo(db),
    chat,
    chatModel: "test-model",
    chatSignature: "test-model|low|2048",
    web,
    now: () => AT,
  });
}

function turnOf(db: ReturnType<typeof makeTestDb>["db"], messageId = "msg-assistant-1"): ConversationTurn {
  const row = createConversationsRepo(db).getMessage(messageId);
  return JSON.parse(row?.run ?? "{}") as ConversationTurn;
}

describe("la règle de déverrouillage (constat serveur)", () => {
  it("compte les fragments utilisables : non structurels et de deux sources distinctes", () => {
    const two = twoSources();
    const entries = [
      { source_id: two.s1, text: "Le doute methodique ecarte les opinions probables.", locator: "[0,10)" },
      { source_id: two.s2, text: "La mesure experimentale fixe les conditions.", locator: "[0,10)" },
    ].map((e, i) => ({ ...e, index: i, fragment_id: `f${i}`, chunk_index: 0, source_title: null, origin: "seed" as const }));
    expect(usableEvidence(entries)).toBe(2);

    // une seule source : aucune preuve transversale, donc rien d'utilisable
    expect(usableEvidence([entries[0]])).toBe(0);
    // l'appareil (sommaire, index, notes) n'est pas une preuve — constat 5A
    const apparatus = [
      { ...entries[0], text: "TABLE DES MATIERES\nChapitre I .... 1\nChapitre II .... 15\nChapitre III .... 42\nChapitre IV .... 88", locator: "#TABLE DES MATIERES" },
      { ...entries[1], text: "NOTES\n1. Voir ci-dessus.\n2. Ibid.\n3. Ibid.", locator: "#NOTES" },
    ];
    expect(usableEvidence(apparatus)).toBe(0);
  });

  it("un corpus qui suffit garde les outils web **absents** de la liste exposée", async () => {
    const { db, fA, fB } = twoSources();
    const anchor = seedSynthesis(db, [fA, fB]);
    const { conversations, user, question } = startTurn(db, { anchor });
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles de mesure" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [1] }] },
    ]);
    const fake = new FakeSearch();
    const { read, calls: reads } = makeRead();
    const service = makeService(db, llm, tools({ search: fake, read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    expect(result.status).toBe("done");
    const turn = turnOf(db);
    expect(turn.web_unlocked).toBe(false);
    expect(turn.web_unlock_reason).toBe("corpus_suffisant");
    expect(turn.web_budget).toBe(3);
    expect(turn.web_steps).toBe(0);
    expect(turn.llm_calls).toBe(3);
    // l'outil n'existe pas pour ce tour : refusé, **et rien n'est sorti**
    expect(turn.steps[1]).toMatchObject({
      action: "search_web",
      failure: "outil_web_indisponible",
      charged: false,
    });
    expect(fake.queries).toEqual([]);
    expect(reads).toEqual([]);
    // et le prompt ne le présente pas comme disponible : c'est la formulation de l'AC2′a
    expect(llm.prompts[1]).toContain("search_web — NON EXPOSÉE");
    expect(llm.prompts[1]).not.toContain("search_web\",\"query");
    expect(conversations.getMessage("msg-assistant-1")?.status).toBe("done");
  });

  it("un corpus insuffisant expose les outils **après** une exploration, et le tour cite une page datée", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles de mesure" },
      { action: "read_page", result: 0 },
      {
        action: "answer",
        claims: [
          { text: "La mesure fixe les conditions de l'observation.", citations: [0] },
          { text: "Le protocole publié décrit la même exigence.", web: [0] },
        ],
      },
    ]);
    const fake = new FakeSearch();
    const { read, calls: reads } = makeRead();
    const service = makeService(db, llm, tools({ search: fake, read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    expect(result.status).toBe("done");
    const turn = turnOf(db);
    expect(turn.web_unlocked).toBe(true);
    expect(turn.web_unlock_reason).toBe("corpus_insuffisant");
    expect(turn.web_unlock_min_evidence).toBe(2);
    // budgets séparés (AC5′) : 2 internes (search, answer) + 2 web (search_web, read_page)
    expect(turn.internal_steps).toBe(2);
    expect(turn.web_steps).toBe(2);
    expect(turn.steps.map((s) => s.action)).toEqual(["search", "search_web", "read_page", "answer"]);
    expect(turn.steps[2].scope).toBe("web");

    // la page lue est une **copie datée** : URL, date de lecture, texte conservé
    expect(fake.queries).toEqual(["protocoles de mesure"]);
    expect(reads).toEqual(["https://exemple.org/protocoles"]);
    expect(turn.web_results).toHaveLength(2);
    expect(turn.web_results[0]).toMatchObject({
      index: 0,
      url: "https://exemple.org/protocoles",
      title: "Page lue",
      read: true,
      found_at: AT.toISOString(),
      retrieved_at: AT.toISOString(),
    });
    expect(turn.web_results[0].text).toContain("La mesure experimentale");
    expect(turn.web_results[1].read).toBe(false);

    // la provenance web est rattachée par le serveur, jamais recopiée par le modèle
    const web = turn.claims[1].provenance[0];
    expect(web).toMatchObject({
      kind: "url",
      index: 0,
      url: "https://exemple.org/protocoles",
      title: "Page lue",
      retrieved_at: AT.toISOString(),
      excerpt: webExcerpt(PAGE_TEXT),
    });

    // le texte affiché est l'union des affirmations, sans indice de protocole
    const text = createConversationsRepo(db).getMessage("msg-assistant-1")?.text ?? "";
    expect(text).toContain("La mesure fixe les conditions");
    expect(text).not.toMatch(/\[0\]|W0/);

    // l'exposition est écrite **dans le prompt**, sans quoi le modèle ne peut pas savoir
    // qu'un outil existe (et le tour réel du 2026-09-20 a montré qu'il ne le devine pas)
    expect(llm.prompts[0]).toContain("search_web — NON EXPOSÉE");
    expect(llm.prompts[1]).toContain("recherche web, EXPOSÉE");
    expect(llm.prompts[1]).toContain("seules les pages lues sont citables");
    expect(llm.prompts[1]).toContain("Étapes web restantes : 3");

    // la lecture du tour est vérifiée **sans réseau** : la copie correspond à la lecture
    const view = createConversationReviewService(db).read("conv-1");
    const claims = view?.messages[1].claims ?? [];
    expect(claims[1].sourced).toBe(true);
    expect(claims[1].provenance[0].verified).toBe(true);
    // AC7 : afficher un tour ne rejoue aucune lecture de page
    expect(reads).toEqual(["https://exemple.org/protocoles"]);
    // et l'écran porte l'URL et la date, pas seulement un indice
    expect(view?.messages[1].run?.web_results[0]).toMatchObject({
      url: "https://exemple.org/protocoles",
      read: true,
      retrieved_at: AT.toISOString(),
    });
    expect(view?.messages[1].run?.web_unlock_reason).toBe("corpus_insuffisant");
  });

  it("le constat attend une exploration : avant elle, les outils restent fermés", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search_web", query: "mesure" },
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "Le protocole publié dit la même chose.", web: [0] }] },
    ]);
    const fake = new FakeSearch();
    const service = makeService(db, llm, tools({ search: fake, read: makeRead().read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    expect(result.status).toBe("done");
    const turn = turnOf(db);
    // le premier appel web est refusé (constat pas fait), le second passe (corpus insuffisant)
    expect(turn.steps[0]).toMatchObject({ action: "search_web", failure: "outil_web_indisponible" });
    expect(turn.steps[0].charged).toBe(false);
    // rien n'est sorti **avant** le constat : la seule requête est celle d'après l'exploration
    expect(fake.queries).toEqual(["protocoles"]);
    expect(turn.web_unlocked).toBe(true);
    // l'étape refusée n'est pas facturée : 2 internes (search + answer), 2 web
    expect(turn.internal_steps).toBe(2);
    expect(turn.web_steps).toBe(2);
  });

  it("outils exposés et ignorés : la réponse est refusée, et le tour va chercher dehors", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db, { question: "Que disent ces documents sur la mesure ?" });
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      // le corpus ne dit rien de la question : le constat expose le web…
      { action: "answer", claims: [{ text: "Rien dans le corpus n'en parle.", citations: [0] }] },
      { action: "search_web", query: "protocoles de mesure" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "Le protocole publié décrit la même exigence.", web: [0] }] },
    ]);
    const fake = new FakeSearch();
    const service = makeService(db, llm, tools({ search: fake, read: makeRead().read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    // … l'ignorer est un refus (défaut mesuré sur un tour réel : outils exposés, 0 étape web,
    // réponse rendue depuis le corpus seul)
    expect(result.status).toBe("done");
    const turn = turnOf(db);
    expect(turn.steps[1]).toMatchObject({ action: "answer", refused: "reponse_web_ignoree" });
    expect(turn.steps[1].charged).not.toBe(false);
    // le refus est récupérable : le tour sort, lit, et répond — c'est la règle qui l'y envoie
    expect(fake.queries).toEqual(["protocoles de mesure"]);
    expect(turn.claims[0].provenance[0]).toMatchObject({ kind: "url", index: 0 });
    // la règle est annoncée au modèle (message système), sinon elle serait un piège
    expect(llm.systems[0]).toContain("reponse_web_ignoree");
    expect(llm.systems[0]).toContain("sans aucune étape web");
  });

  it("le constat d'un `search_web` refusé suffit : on n'exige pas un succès du web", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [0] }] },
    ]);
    const fake = new FakeSearch();
    const read = async (): Promise<WebPage> => {
      throw new WebRefusalError("adresse_locale", "adresse non publique refusée");
    };
    const service = makeService(db, llm, tools({ search: fake, read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    // le durcissement a refusé la page : le tour ne peut plus rien citer du web, mais il a
    // **répondu au constat** — le refuser une seconde fois le condamnerait à échouer
    expect(result.status).toBe("done");
    const turn = turnOf(db);
    expect(fake.queries).toEqual(["protocoles"]);
    expect(turn.claims[0].provenance[0]).toMatchObject({ kind: "fragment", index: 0 });
  });

  it("le constat exige une exploration **interne** : un refus web ne le remplace pas", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search_web", query: "mesure" },
      { action: "search_web", query: "mesure encore" },
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [0] }] },
    ]);
    const fake = new FakeSearch();
    const service = makeService(db, llm, tools({ search: fake, read: makeRead().read }));

    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    const turn = turnOf(db);
    // deux refus avant l'exploration : un refus web ne vaut pas un constat d'insuffisance,
    // sinon il suffirait d'appeler l'outil pour l'ouvrir
    expect(turn.steps[0]).toMatchObject({ failure: "outil_web_indisponible", charged: false });
    expect(turn.steps[1]).toMatchObject({ failure: "outil_web_indisponible", charged: false });
    expect(fake.queries).toEqual([]);
    // une fois l'exploration faite, le constat tombe (une seule source) : outils exposés
    expect(turn.web_unlocked).toBe(true);
    expect(turn.web_steps).toBe(0);
  });

  it("`WEB_ACCESS=off` retire les outils quel que soit le constat", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "mesure" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [0] }] },
    ]);
    const fake = new FakeSearch();
    const service = makeService(db, llm, tools({ access: "off", search: fake, read: makeRead().read }));

    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    const turn = turnOf(db);
    expect(turn.web_budget).toBe(0);
    expect(turn.web_unlocked).toBe(false);
    expect(turn.web_unlock_reason).toBe("acces_desactive");
    expect(turn.steps[1]).toMatchObject({ failure: "outil_web_indisponible" });
    expect(fake.queries).toEqual([]);
  });

  it("sans connecteur, les outils n'existent pas — et le tour le dit", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [0] }] },
    ]);
    const service = makeService(db, llm, tools({ provider: "none", read: makeRead().read }));

    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });
    expect(turnOf(db).web_unlock_reason).toBe("connecteur_absent");
  });
});

describe("budgets web : bornés, séparés, et un refus ne se paie pas", () => {
  it("une recherche par tour, deux lectures, et le troisième `read_page` est refusé", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "read_page", result: 0 },
      { action: "read_page", result: 1 },
      { action: "read_page", result: 2 },
      { action: "answer", claims: [{ text: "Ce que dit la page.", web: [0] }] },
    ]);
    const fake = new FakeSearch([
      ...SEARCH_RESULTS,
      { title: "Troisième", url: "https://exemple.io/trois", snippet: null, published_at: null },
    ]);
    const { read, calls: reads } = makeRead();
    const service = makeService(db, llm, tools({ search: fake, read }));

    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    const turn = turnOf(db);
    const actions = turn.steps.map((s) => s.action);
    // le budget web (3) est épuisé par une recherche + deux lectures : la troisième lecture
    // est refusée **avant** d'être tentée, et n'est donc pas payée
    expect(actions).toEqual([
      "search",
      "search_web",
      "read_page",
      "read_page",
      "read_page",
      "answer",
    ]);
    expect(turn.steps[4]).toMatchObject({ failure: "budget_web_epuise", charged: false });
    expect(turn.web_steps).toBe(3);
    expect(reads).toHaveLength(2);
    expect(turn.claims).toHaveLength(1);
    expect(turn.unsourced).toBe(0);
  });

  it("une deuxième recherche web dans le même tour est refusée, sans être payée", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "search_web", query: "encore" },
      { action: "answer", claims: [{ text: "Vu sur le web.", web: [0] }] },
    ]);
    const fake = new FakeSearch();
    const { read } = makeRead();
    const service = makeService(db, llm, tools({ search: fake, read }));

    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });
    const turn = turnOf(db);
    expect(turn.steps[2]).toMatchObject({ failure: "recherche_deja_faite", charged: false });
    expect(fake.queries).toEqual(["protocoles"]);
    expect(turn.web_steps).toBe(1);
  });

  it("`read_page` hors des résultats du tour est refusé (aucune adresse choisie librement)", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_page", result: 7 },
      { action: "answer", claims: [{ text: "Ce que dit le corpus.", citations: [0] }] },
    ]);
    const { read, calls: reads } = makeRead();
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read }));

    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });
    const turn = turnOf(db);
    expect(turn.steps[1]).toMatchObject({
      action: "read_page",
      failure: "resultat_hors_recherche",
      charged: false,
    });
    expect(reads).toEqual([]);
  });
});

describe("ce qui est citable : une page lue, datée, jamais relue", () => {
  it("citer une page seulement trouvée est refusé (`reponse_web_non_lue`), et le tour le dit", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db, { question: "Que disent ces documents sur la mesure ?" });
    const actions = [
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "answer", claims: [{ text: "Une page que je n'ai pas lue.", web: [1] }] },
      { action: "read_page", result: 1 },
      { action: "answer", claims: [{ text: "Une page lue, citée.", web: [1] }] },
    ];
    const llm = new ScriptedLlm(actions);
    const { read, calls: reads } = makeRead();
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read }));

    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });
    const turn = turnOf(db);
    expect(turn.steps[2].refused).toBe("reponse_web_non_lue");
    // la reprise est possible dans le budget restant : le tour aboutit
    expect(turn.claims[0].provenance[0]).toMatchObject({ kind: "url", index: 1 });
    expect(reads).toEqual(["https://exemple.net/metrologie"]);
  });

  it("citer un résultat qui n'existe pas est refusé (`reponse_hors_catalogue`)", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "answer", claims: [{ text: "Une page inventée.", web: [9] }] },
    ]);
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read: makeRead().read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });
    expect(result.status).toBe("failed");
    expect(turnOf(db).steps[2].refused).toBe("reponse_hors_catalogue");
  });

  it("un tour dont **aucune** affirmation ne s'appuie est refusé (`reponse_sans_aucune_preuve`)", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db, { question: "Que disent ces documents ?" });
    // le web est exposé : le tour tente dehors (le constat de la règle 5 est satisfait) avant
    // de rendre des affirmations sans appui — c'est **ce** motif-là qui doit tomber
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "Une affirmation sans aucun appui." }] },
      { action: "answer", claims: [{ text: "Une autre, toujours sans appui." }] },
    ]);
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read: makeRead().read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("reponse_sans_aucune_preuve");
  });

  it("une lecture refusée par le durcissement est tracée, et la page n'est **pas** citable", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "Ce que dit la page.", web: [0] }] },
    ]);
    const read = async (): Promise<WebPage> => {
      throw new WebRefusalError("adresse_locale", "adresse non publique refusée");
    };
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });
    const turn = turnOf(db);
    expect(turn.steps[2]).toMatchObject({ action: "read_page", failure: "adresse_locale" });
    expect(turn.web_results[0].read).toBe(false);
    expect(turn.web_results[0].failure).toBe("adresse_locale");
    expect(turn.steps[3].refused).toBe("reponse_web_non_lue");
    expect(result.status).toBe("failed");
  });

  it("une copie dont l'URL a changé ne tient plus (la date seule ne suffit pas)", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "Le protocole publié dit la même chose.", web: [0] }] },
    ]);
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read: makeRead().read }));
    await service.run("conv-1", { messageId: "msg-assistant-1", questionMessageId: user.id, question });

    // la lecture enregistrée pointe désormais ailleurs : la provenance ne correspond plus
    const turn = turnOf(db);
    turn.web_results[0].url = "https://ailleurs.example/page";
    db.prepare("UPDATE messages SET run = ? WHERE id = 'msg-assistant-1'").run(JSON.stringify(turn));

    const message = createConversationReviewService(db).read("conv-1")?.messages[1];
    const prov = message?.claims[0].provenance[0];
    expect(prov?.verified).toBe(false);
    if (prov?.kind !== "url") throw new Error("provenance web attendue");
    expect(prov.problem).toBe("copie_modifiee");
    expect(message?.unsourced).toBe(1);
  });

  it("la copie web est vérifiée à la lecture : une copie modifiée ne tient plus", async () => {
    const { db, user, question } = (() => {
      const { db } = oneSource();
      return { db, ...startTurn(db) };
    })();
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "search_web", query: "protocoles" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "Le protocole publié dit la même chose.", web: [0] }] },
    ]);
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read: makeRead().read }));
    await service.run("conv-1", { messageId: "msg-assistant-1", questionMessageId: user.id, question });

    const review = createConversationReviewService(db);
    expect(review.read("conv-1")?.messages[1].claims[0].sourced).toBe(true);

    // on altère la copie enregistrée : la vérification doit le voir **sans réseau**
    const write = (mutate: (t: ConversationTurn) => void) => {
      const turn = turnOf(db);
      mutate(turn);
      db.prepare("UPDATE messages SET run = ? WHERE id = 'msg-assistant-1'").run(JSON.stringify(turn));
    };
    const verdict = () => {
      const message = review.read("conv-1")?.messages[1];
      const prov = message?.claims[0].provenance[0];
      if (prov?.kind !== "url") throw new Error("provenance web attendue");
      return { message, prov };
    };

    // 1) le passage copié n'est plus le même
    write((turn) => {
      turn.web_results[0].text = "Un texte entièrement different de celui qui a ete lu.";
    });
    const texte = verdict();
    expect(texte.prov.verified).toBe(false);
    expect(texte.prov.problem).toBe("copie_modifiee");

    // 2) le texte redevient conforme, mais la date de lecture n'est plus celle du tour
    write((turn) => {
      turn.web_results[0].text = PAGE_TEXT;
      turn.web_results[0].retrieved_at = READ_AT.toISOString();
    });
    const date = verdict();
    expect(date.prov.verified).toBe(false);
    expect(date.prov.problem).toBe("copie_modifiee");
    expect(date.message?.unverified).toBe(1);
    expect(date.message?.unsourced).toBe(1);
    expect(date.message?.claims[0].sourced).toBe(false);
  });
});

describe("le second chemin : le modèle demande le web (`ask_web`)", () => {
  /**
   * Le cas qui a motivé la règle (mesure du 2026-09-20) : un corpus à deux sources, donc
   * `corpus_suffisant` pour le constat de volume, mais la question porte hors sujet. Le
   * modèle, lui, peut le constater après avoir lu — encore faut-il qu'il ait lu.
   */
  it("refuse la demande **avant** toute exploration (`exploration_requise`), et n'ouvre rien", async () => {
    const { db, fA, fB } = twoSources();
    const anchor = seedSynthesis(db, [fA, fB]);
    const { user, question } = startTurn(db, { anchor });
    const llm = new ScriptedLlm([
      { action: "ask_web", reason: "le corpus ne parle pas de la regulation des batteries" },
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [1] }] },
    ]);
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read: makeRead().read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    expect(result.status).toBe("done");
    const turn = turnOf(db);
    // la première étape est tracée, elle n'a rien coûté et n'a rien ouvert
    expect(turn.steps[0]).toMatchObject({
      action: "ask_web",
      failure: "exploration_requise",
      charged: false,
    });
    expect(turn.web_unlocked).toBe(false);
    expect(turn.web_unlock_reason).toBe("corpus_suffisant");
    expect(turn.web_steps).toBe(0);
    // 2 étapes internes facturées : l'exploration et la réponse — jamais la demande refusée
    expect(turn.internal_steps).toBe(2);
    // et le prompt de la demande ne présente pas les outils comme disponibles
    expect(llm.prompts[0]).toContain("search_web — NON EXPOSÉE");
    // mais il **dit** de demander au lieu de rendre un constat négatif (v6)
    expect(llm.prompts[0]).toContain("DEMANDE le web (ask_web)");
  });

  it("refuse la demande quand aucun connecteur n'est configuré (`outil_web_indisponible`)", async () => {
    const { db, fA, fB } = twoSources();
    const anchor = seedSynthesis(db, [fA, fB]);
    const { user, question } = startTurn(db, { anchor });
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "ask_web", reason: "il me faut des sources externes" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [1] }] },
    ]);
    // web désactivé : le refus est rendu **avant** toute autre considération, sinon le
    // modèle croirait avoir ouvert un web qui existe
    const service = makeService(db, llm, tools({ access: "off" }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    expect(result.status).toBe("done");
    const turn = turnOf(db);
    expect(turn.steps[1]).toMatchObject({
      action: "ask_web",
      failure: "outil_web_indisponible",
      charged: false,
    });
    expect(turn.web_unlocked).toBe(false);
    expect(turn.web_budget).toBe(0);
    expect(turn.web_unlock_reason).toBe("acces_desactive");
    // web hors de portée : c'est le **seul** état où le constat négatif est la conduite annoncée
    expect(llm.prompts[0]).toContain("Le web n'est pas disponible pour ce tour");
    expect(llm.prompts[0]).not.toContain("DEMANDE le web (ask_web)");
  });

  it("refuse la demande quand le web est **déjà** exposé (`web_deja_expose`)", async () => {
    const { db } = oneSource();
    const { user, question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      // le constat a déjà ouvert les outils à l'étape précédente : la demande est un détour
      { action: "ask_web", reason: "le corpus ne suffit pas" },
      { action: "search_web", query: "protocoles de mesure" },
      { action: "read_page", result: 0 },
      { action: "answer", claims: [{ text: "Le protocole publié décrit la même exigence.", web: [0] }] },
    ]);
    const service = makeService(db, llm, tools({ search: new FakeSearch(), read: makeRead().read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    expect(result.status).toBe("done");
    const turn = turnOf(db);
    expect(turn.steps[1]).toMatchObject({
      action: "ask_web",
      failure: "web_deja_expose",
      charged: false,
    });
    // le motif du déverrouillage reste celui du **constat** : la demande refusée n'écrase rien
    expect(turn.web_unlock_reason).toBe("corpus_insuffisant");
    expect(turn.web_unlocked).toBe(true);
    // et le tour a bien travaillé dehors : la demande refusée n'a pas mangé d'étape web
    expect(turn.web_steps).toBe(2);
  });

  it("ouvre le web sur demande après exploration (`demande_modele`), et le tour va lire dehors", async () => {
    const { db, fA, fB } = twoSources();
    const anchor = seedSynthesis(db, [fA, fB]);
    const { user, question } = startTurn(db, { anchor, question: "Que disent ces documents sur la régulation des batteries ?" });
    const llm = new ScriptedLlm([
      { action: "search", query: "batteries lithium recyclage" },
      { action: "ask_web", reason: "le corpus ne traite que le doute et la mesure, pas la régulation" },
      { action: "search_web", query: "règlement UE 2023/1542 batteries" },
      { action: "read_page", result: 0 },
      {
        action: "answer",
        claims: [
          { text: "La mesure fixe les conditions.", citations: [1] },
          { text: "Le règlement impose une exigence de recyclage.", web: [0] },
        ],
      },
    ]);
    const fake = new FakeSearch();
    const { read, calls: reads } = makeRead();
    const service = makeService(db, llm, tools({ search: fake, read }));

    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: user.id,
      question,
    });

    expect(result.status).toBe("done");
    const turn = turnOf(db);
    // le constat de volume, lui, disait « suffisant » : c'est bien la **demande** qui ouvre
    expect(turn.web_unlocked).toBe(true);
    expect(turn.web_unlock_reason).toBe("demande_modele");
    // la demande est facturée comme une étape interne (elle a changé l'état du tour)
    expect(turn.internal_steps).toBe(3);
    expect(turn.web_steps).toBe(2);
    expect(fake.queries).toEqual(["règlement UE 2023/1542 batteries"]);
    expect(reads).toEqual(["https://exemple.org/protocoles"]);
    // le prompt suivant la demande expose les outils, et ne propose plus de les demander
    expect(llm.prompts[1]).toContain("search_web — NON EXPOSÉE");
    expect(llm.prompts[2]).toContain('{"action":"search_web","query":"..."}');
    expect(llm.prompts[2]).toContain("ask_web — inutile");
    expect(llm.prompts[2]).toContain("Va chercher dehors (search_web)");
    // le motif de la demande est conservé dans la trace du tour
    expect(turn.steps[1]).toMatchObject({ action: "ask_web", input: { reason: expect.stringContaining("régulation") } });
    // et la réponse porte une provenance web datée
    const webProv = turn.claims[1].provenance[0];
    expect(webProv.kind).toBe("url");
  });
});

describe("assemblage des outils depuis les réglages", () => {
  it("clotûre le plafond d'étapes web et explique pourquoi le web est absent", () => {
    const on = createWebTools({
      access: "on",
      provider: "exa",
      exaApiKey: "clé",
      maxSteps: 99,
      unlockMinEvidence: 2,
    });
    expect(on.enabled).toBe(true);
    expect(on.maxSteps).toBe(3);
    expect(on.provider).toBe("exa");
    expect(on.search).not.toBeNull();

    const noKey = createWebTools({
      access: "on",
      provider: "exa",
      exaApiKey: "",
      maxSteps: 3,
      unlockMinEvidence: 2,
    });
    expect(noKey.enabled).toBe(false);
    expect(noKey.disabledReason).toBe("connecteur_absent");
    expect(noKey.search).toBeNull();

    const off = createWebTools({
      access: "off",
      provider: "exa",
      exaApiKey: "clé",
      maxSteps: 3,
      unlockMinEvidence: 2,
    });
    expect(off.enabled).toBe(false);
    expect(off.disabledReason).toBe("acces_desactive");
  });
});
