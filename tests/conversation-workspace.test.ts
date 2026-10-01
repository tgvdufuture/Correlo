import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { createConversationsRepo, conversationTitle } from "@/lib/repositories/conversations";
import { createConversationCanvasRepo } from "@/lib/repositories/conversation-canvases";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { ConversationService } from "@/lib/agent/conversation-service";
import { createConversationReviewService } from "@/lib/agent/conversation-review";
import { createWorkspace, type WorkspaceReader } from "@/lib/agent/workspace";
import { createWebTools, type WebTools } from "@/lib/agent/web-tools";
import type { WebSearchProvider, WebSearchResult } from "@/lib/agent/web-search";
import type { ConversationTurn } from "@/lib/agent/conversation-types";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";

/**
 * Phase 6 — `read_file` : le workspace local (amendement v1.3 §13.5, AC3).
 *
 * Le modèle est scripté et le workspace est un **vrai dossier temporaire** : ce qui est testé
 * ici est la décision du serveur (qui est exposé, ce qui est facturé, ce qui est citable, ce
 * qui tient encore à la relecture), jamais la pertinence de ce que le modèle lit.
 */

const V = (x: number, y: number): number[] => [x, y, 0, 0, 0, 0, 0, 0];
const AT = new Date("2026-09-20T10:00:00.000Z");

const NOTES = ["titre", "deux mesures", "et un protocole", "fin"].join("\n");

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Racine jetable contenant `notes.md` (4 lignes) — la copie citée en dépend. */
function makeRoot(): { root: string; notes: string } {
  const root = tmpDir("serendipity-ws-conv-");
  const notes = path.join(root, "notes.md");
  fs.writeFileSync(notes, NOTES);
  return { root, notes };
}

class ScriptedLlm implements LlmProvider {
  calls = 0;
  prompts: string[] = [];
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
    return schema.parse(action);
  }
}

/**
 * Corpus à **une seule** source : `usableEvidence` vaut 0, donc le serveur juge le corpus
 * insuffisant et expose le web dès qu'une exploration a abouti (§13.4).
 */
/**
 * Corpus **maigre** (1 fragment, sous `WEB_UNLOCK_MIN_EVIDENCE = 2`) : c'est lui qui
 * déclenche le constat « corpus insuffisant ». (Avant le 2026-10-01, la fixture portait
 * 4 fragments : le critère exigeait deux sources ; désormais une source fournie suffit
 * à répondre, donc « insuffisant » veut dire réellement maigre.)
 */
function singleSourceCorpus() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "s1", "Claude Bernard");
  makeFragment(db, {
    sourceId: s1,
    chunkIndex: 0,
    id: "frag-0",
    text: "La mesure experimentale fixe les conditions de l'observation.",
    vector: V(1, 0),
  });
  return { db };
}

/** Corpus à **deux** sources : le constat de suffisance tient, donc le web n'est pas exposé. */
function corpus() {
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
  return { db, fA, fB };
}

function startTurn(db: ReturnType<typeof makeTestDb>["db"], question = "Que disent ces documents ?") {
  const conversations = createConversationsRepo(db);
  conversations.create({
    id: "conv-1",
    anchorKind: "corpus",
    anchorRef: null,
    title: conversationTitle(question),
    chatModel: "test-model",
    promptVersion: "conversation-v7",
  });
  const user = conversations.addUserMessage({ id: "msg-user-1", conversationId: "conv-1", text: question });
  return { conversations, user, question };
}

/**
 * Le connecteur web est **faux** : ce que ces tests vérifient est l'interaction entre le
 * constat de corpus et le workspace, jamais la qualité d'une recherche. Un connecteur est
 * nécessaire pour que le web **puisse** être exposé — sinon le cas ne se produit pas.
 */
class FakeSearch implements WebSearchProvider {
  name = "fake";
  queries: string[] = [];
  constructor(
    private results: WebSearchResult[] = [
      { title: "Protocoles", url: "https://exemple.org/protocoles", snippet: null, published_at: null },
    ]
  ) {}
  async search(query: string): Promise<WebSearchResult[]> {
    this.queries.push(query);
    return this.results;
  }
}

function webTools(search: WebSearchProvider): WebTools {
  return createWebTools(
    {
      access: "on",
      provider: "exa",
      exaApiKey: "clé-de-test",
      maxSteps: 3,
      unlockMinEvidence: 2,
      searchResults: 5,
    },
    {
      search,
      read: async (url: string) => ({
        url,
        title: "Page lue",
        text: "Un protocole de mesure experimental.".repeat(5),
        redirects: [],
        bytes: 10,
      }),
    }
  );
}

function makeService(
  db: ReturnType<typeof makeTestDb>["db"],
  chat: LlmProvider,
  workspace?: WorkspaceReader,
  web?: WebTools
) {
  return new ConversationService({
    db,
    conversations: createConversationsRepo(db),
    syntheses: createSynthesesRepo(db),
    canvasLinks: createConversationCanvasRepo(db),
    fragments: createFragmentsRepo(db),
    sources: createSourcesRepo(db),
    chat,
    chatModel: "test-model",
    chatSignature: "test-model|low|2048",
    workspace,
    web,
    now: () => AT,
  });
}

function turnOf(db: ReturnType<typeof makeTestDb>["db"], messageId = "msg-assistant-1"): ConversationTurn {
  const row = createConversationsRepo(db).getMessage(messageId);
  return JSON.parse(row?.run ?? "{}") as ConversationTurn;
}

/** Empreinte de l'arbre : sert à prouver qu'un tour n'écrit **rien** dans le workspace. */
function treeHash(root: string): string {
  const entries: string[] = [];
  for (const name of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const full = path.join(root, name);
    if (!fs.statSync(full).isFile()) continue;
    entries.push(`${name}:${fs.readFileSync(full).length}:${fs.readFileSync(full).toString("base64")}`);
  }
  return entries.join("|");
}

describe("read_file — exposition et facturation", () => {
  it("sans racine, l'outil n'est pas annoncé et un appel direct est refusé sans être facturé", async () => {
    const { db } = corpus();
    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md" },
      { action: "answer", claims: [{ text: "Le protocole fixe deux mesures.", files: [0] }] },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [1] }] },
    ]);
    const service = makeService(db, llm);
    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    expect(turn.workspace_root).toBeNull();
    expect(turn.workspace_reads).toHaveLength(0);

    // le refus est tracé, motivé, et **non facturé** : rien n'a été lu
    const refused = turn.steps.find((s) => s.action === "read_file");
    expect(refused?.failure).toBe("outil_workspace_indisponible");
    expect(refused?.charged).toBe(false);
    // 3 étapes facturées : la recherche, la **réponse refusée** (une réponse refusée reste
    // une tentative de réponse, elle se paie) et la réponse acceptée — mais pas le refus
    // d'outil, qui n'a rien exécuté
    expect(turn.internal_steps).toBe(3);

    // et l'indice de fichier inexistant est refusé comme une citation hors catalogue
    const firstAnswer = turn.steps.find((s) => s.action === "answer");
    expect(firstAnswer?.refused).toBe("reponse_hors_catalogue");

    // le prompt ne présente pas l'outil comme disponible : un prompt qui tairait la règle
    // que le serveur applique serait un piège
    expect(llm.prompts[1]).toContain("read_file — NON EXPOSÉE");
  });

  it("avec une racine, la lecture est annoncée, facturée une étape interne, et citable", async () => {
    const { db } = corpus();
    const { root, notes } = makeRoot();
    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      { action: "answer", claims: [{ text: "Le document fixe deux mesures et un protocole.", files: [0] }] },
    ]);
    const service = makeService(db, llm, createWorkspace(root));
    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    expect(result.workspaceReads).toBe(1);

    // la racine **du tour** est écrite, et la lecture porte le chemin relatif + la plage
    expect(turn.workspace_root).toBe(root);
    expect(turn.workspace_reads).toHaveLength(1);
    expect(turn.workspace_reads[0]).toMatchObject({
      index: 0,
      path: "notes.md",
      from_line: 2,
      to_line: 3,
    });

    // la provenance porte `chemin:ligne` et la copie **du serveur**
    const claim = turn.claims[0];
    expect(claim.provenance).toHaveLength(1);
    expect(claim.provenance[0]).toMatchObject({
      kind: "file",
      index: 0,
      path: "notes.md",
      from_line: 2,
      to_line: 3,
      read_at: AT.toISOString(),
      excerpt: "deux mesures et un protocole",
    });
    expect(turn.unsourced).toBe(0);

    // la lecture est une étape interne facturée : 3 étapes (recherche, lecture, réponse)
    expect(turn.internal_steps).toBe(3);
    const step = turn.steps.find((s) => s.action === "read_file");
    expect(step?.scope).toBe("internal");
    expect(step?.charged).not.toBe(false);
    expect(step?.workspace_observation).toEqual([0]);
    expect(step?.input).toMatchObject({ path: "notes.md", from: 2, to: 3 });

    // le prompt suivant annonce l'outil, la racine, et **montre le texte lu**
    expect(llm.prompts[1]).toContain("read_file");
    expect(llm.prompts[1]).toContain(root);
    expect(llm.prompts[2]).toContain("--- FICHIERS DU WORKSPACE (1) ---");
    expect(llm.prompts[2]).toContain("F0 · notes.md lignes 2-3");
    expect(llm.prompts[2]).toContain("deux mesures");

    // la relecture, avec le même confinement, confirme la citation
    const review = createConversationReviewService(db, { workspace: createWorkspace(root) });
    const view = review.read("conv-1");
    const message = view?.messages.at(-1);
    expect(message?.claims[0].sourced).toBe(true);
    expect(message?.claims[0].provenance[0]).toMatchObject({ kind: "file", verified: true });
    expect(message?.unverified).toBe(0);
    expect(view?.workspace_root).toBe(root);
    expect(view?.messages.at(-1)?.run?.workspace_reads[0]).toMatchObject({ path: "notes.md" });
    expect(fs.readFileSync(notes, "utf8")).toBe(NOTES);
  });

  it("relire la même plage ne coûte rien mais n'apprend rien", async () => {
    const { db } = corpus();
    const { root } = makeRoot();
    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      { action: "read_file", path: "./notes.md", from: 2, to: 3 },
      { action: "answer", claims: [{ text: "Le document fixe deux mesures.", files: [0] }] },
    ]);
    const service = makeService(db, llm, createWorkspace(root));
    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    // la redondance est vue sur la **vérité résolue** (même fichier, même plage), pas sur la
    // forme du chemin écrite par le modèle
    const reads = turn.steps.filter((s) => s.action === "read_file");
    expect(reads[1].failure).toBe("plage_deja_lue");
    expect(reads[1].charged).toBe(false);
    expect(turn.workspace_reads).toHaveLength(1);
    expect(turn.internal_steps).toBe(3);
  });

  it("une lecture refusée par le confinement est tracée, lisible, et non facturée", async () => {
    const { db } = corpus();
    const base = tmpDir("serendipity-ws-esc-");
    const root = path.join(base, "racine");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "notes.md"), NOTES);
    fs.writeFileSync(path.join(base, "secret.txt"), "secret");
    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "../secret.txt" },
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      // la tentative refusée occupe l'indice F0 : c'est F1 qui est citable, exactement comme
      // le prompt le montre au modèle
      { action: "answer", claims: [{ text: "Le document fixe deux mesures.", files: [1] }] },
    ]);
    const service = makeService(db, llm, createWorkspace(root));
    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    const refused = turn.steps.find((s) => s.action === "read_file" && s.failure);
    expect(refused?.failure).toBe("chemin_hors_racine");
    expect(refused?.charged).toBe(false);
    // la tentative est **enregistrée** : la trace du tour dit ce qui a été essayé
    expect(turn.workspace_reads[0]).toMatchObject({ path: "../secret.txt", failure: "chemin_hors_racine" });
    expect(turn.steps.find((s) => s.action === "read_file" && !s.failure)?.workspace_observation).toEqual([
      1,
    ]);
    // et le refus est annoncé au modèle, motif compris
    expect(llm.prompts[2]).toContain("refusé (chemin hors de la racine confinée)");
    // la lecture réussie qui suit reste citable
    expect(turn.claims[0].provenance[0]).toMatchObject({ kind: "file", path: "notes.md" });
    expect(turn.internal_steps).toBe(3); // recherche, lecture refusée (0), lecture (1), réponse
  });

  it("la lecture est plafonnée à `budget − 1` : la réponse garde sa place", async () => {
    const { db } = corpus();
    const { root } = makeRoot();
    fs.writeFileSync(path.join(root, "autre.md"), NOTES);
    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md", from: 1, to: 2 },
      { action: "read_file", path: "autre.md", from: 1, to: 2 },
      { action: "answer", claims: [{ text: "Le document fixe deux mesures.", files: [0] }] },
    ]);
    // budget serré : une exploration est plafonnée à `budget − 1`, donc la deuxième lecture
    // n'a plus de place — et la réponse, si
    const service = makeService(db, llm, createWorkspace(root));
    const result = await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
      maxSteps: 3,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    const reads = turn.steps.filter((s) => s.action === "read_file");
    expect(reads[0].failure).toBeUndefined();
    expect(reads[1].failure).toBe("budget_interne_epuise");
    expect(reads[1].charged).toBe(false);
    // 3 étapes internes au plus, la réponse comprise
    expect(turn.internal_steps).toBeLessThanOrEqual(turn.step_budget);
    expect(turn.internal_steps).toBe(3);
  });

  it("un tour ne modifie **rien** dans le workspace", async () => {
    const { db } = corpus();
    const { root } = makeRoot();
    fs.mkdirSync(path.join(root, "sous"));
    fs.writeFileSync(path.join(root, "sous", "autre.md"), "un\n");
    const before = treeHash(root);

    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md" },
      { action: "read_file", path: "sous" },
      { action: "answer", claims: [{ text: "Le document fixe deux mesures.", files: [0] }] },
    ]);
    await makeService(db, llm, createWorkspace(root)).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    expect(treeHash(root)).toBe(before);
    const turn = turnOf(db);
    // lire un dossier est refusé : l'outil n'énumère pas plus qu'il n'écrit
    expect(turn.steps.find((s) => s.action === "read_file" && s.failure)?.failure).toBe(
      "cible_non_fichier"
    );
  });
});

describe("le workspace et les règles de lecture du corpus", () => {
  it("une lecture de fichier **citée** vaut exploration : un document nommé se répond", async () => {
    const { db } = corpus();
    const { root } = makeRoot();
    const { question } = startTurn(db, "Que dit notes/protocole.md ?");
    // le modèle ouvre le fichier **avant** toute recherche : le geste juste pour une question
    // qui nomme un document, et il ne doit pas être puni pour l'ordre
    const llm = new ScriptedLlm([
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      { action: "answer", claims: [{ text: "Le document fixe deux mesures et un protocole.", files: [0] }] },
    ]);
    const result = await makeService(db, llm, createWorkspace(root)).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    expect(turn.steps.map((s) => s.action)).toEqual(["read_file", "answer"]);
    expect(turn.steps[1].refused).toBeUndefined();
    expect(turn.internal_steps).toBe(2);
    expect(turn.claims[0].provenance[0]).toMatchObject({ kind: "file", path: "notes.md" });
  });

  it("un fichier lu mais **non cité** ne dispense pas de chercher dans le corpus", async () => {
    const { db } = corpus();
    const { root } = makeRoot();
    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      // lecture décorative : aucune provenance de fichier, aucune recherche — la règle doit
      // tenir, sinon n'importe quel fichier ouvert blanchirait une réponse rendue à partir
      // de rien
      { action: "answer", claims: [{ text: "Le protocole fixe deux mesures." }] },
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [1] }] },
    ]);
    const result = await makeService(db, llm, createWorkspace(root)).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    expect(turn.steps[1].refused).toBe("reponse_sans_exploration");
    expect(turn.claims[0].provenance[0]).toMatchObject({ kind: "fragment" });
  });

  it("le constat « le corpus ne suffit pas » est satisfait par un fichier cité", async () => {
    const { db } = singleSourceCorpus();
    const { root } = makeRoot();
    const { question } = startTurn(db, "Que dit notes/protocole.md sur la mesure ?");
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      { action: "answer", claims: [{ text: "Le document fixe deux mesures et un protocole.", files: [0] }] },
    ]);
    const fake = new FakeSearch();
    const result = await makeService(db, llm, createWorkspace(root), webTools(fake)).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });

    const turn = turnOf(db);
    expect(result.status).toBe("done");
    // le web **a** été exposé (constat de corpus), et la réponse n'a fait aucune étape web :
    // elle est acceptée parce qu'elle s'appuie sur un document que l'utilisateur a désigné
    expect(turn.web_unlocked).toBe(true);
    expect(turn.web_unlock_reason).toBe("corpus_insuffisant");
    expect(turn.web_steps).toBe(0);
    expect(turn.steps.at(-1)?.refused).toBeUndefined();
    expect(turn.claims[0].provenance[0]).toMatchObject({ kind: "file" });

    // la contrepartie reste : sans citation de fichier, le constat exige une tentative web
    const { db: other } = singleSourceCorpus();
    startTurn(other, "Que dit le corpus sur la mesure ?");
    const otherLlm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [0] }] },
      { action: "search_web", query: "protocoles" },
      { action: "answer", claims: [{ text: "La mesure fixe les conditions.", citations: [0] }] },
    ]);
    const second = await makeService(other, otherLlm, createWorkspace(root), webTools(new FakeSearch())).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus sur la mesure ?",
    });
    expect(second.status).toBe("done");
    expect(turnOf(other).steps[2].refused).toBe("reponse_web_ignoree");
    expect(turnOf(other).web_steps).toBe(1);
  });
});

describe("la citation de fichier est revérifiée à la lecture", () => {
  /** Un tour qui cite `notes.md` lignes 2-3, puis le monde change. */
  async function turnCiting(root: string) {
    const { db } = corpus();
    const { question } = startTurn(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "read_file", path: "notes.md", from: 2, to: 3 },
      { action: "answer", claims: [{ text: "Le document fixe deux mesures.", files: [0] }] },
    ]);
    await makeService(db, llm, createWorkspace(root)).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question,
    });
    return db;
  }

  function verdict(db: ReturnType<typeof makeTestDb>["db"], workspace?: WorkspaceReader | null) {
    const view = createConversationReviewService(db, { workspace }).read("conv-1");
    const message = view?.messages.at(-1);
    return { view, message, provenance: message?.claims[0].provenance[0] };
  }

  it("la plage citée qui change fait tomber la preuve — et **elle seule**", async () => {
    const { root, notes } = makeRoot();
    const db = await turnCiting(root);
    const workspace = createWorkspace(root);
    expect(verdict(db, workspace).provenance).toMatchObject({ verified: true });

    // modifier une ligne **hors** de la plage citée ne touche pas la preuve : l'AC3 vérifie
    // « le texte de la plage », pas l'état du fichier entier
    fs.writeFileSync(notes, ["titre", "deux mesures", "et un protocole", "fin", "ajout"].join("\n"));
    expect(verdict(db, workspace).provenance).toMatchObject({ verified: true });

    // modifier une ligne **dans** la plage : la citation cesse d'appuyer l'affirmation
    fs.writeFileSync(notes, ["titre", "deux mesures", "et un AUTRE protocole", "fin"].join("\n"));
    const after = verdict(db, workspace);
    expect(after.provenance).toMatchObject({ verified: false, problem: "copie_modifiee" });
    expect(after.message?.claims[0].sourced).toBe(false);
    expect(after.message?.unsourced).toBe(1);
    expect(after.message?.unverified).toBe(1);
    // et le texte copié au moment T reste consultable : on dit ce qu'on a lu, sans le servir
    // comme un fait
    expect(after.message?.text).toBe("Le document fixe deux mesures.");
  });

  it("un fichier supprimé, un chemin détourné et une racine retirée sont dits, pas tus", async () => {
    const { root, notes } = makeRoot();
    const db = await turnCiting(root);

    fs.rmSync(notes);
    expect(verdict(db, createWorkspace(root)).provenance).toMatchObject({
      verified: false,
      problem: "fichier_illisible",
    });

    // le fichier remplacé par un lien qui **sort** de la racine : hors racine, jamais « lu »
    const base = path.dirname(root);
    fs.writeFileSync(path.join(base, "dehors.txt"), "deux mesures\net un protocole");
    fs.symlinkSync(path.join(base, "dehors.txt"), notes, "file");
    const escaped = verdict(db, createWorkspace(root)).provenance;
    expect(escaped?.verified).toBe(false);
    expect(["hors_racine", "fichier_illisible"]).toContain(escaped?.problem);

    // plus de racine configurée : la citation n'est pas « vraie », elle est **non
    // revérifiable** — ce n'est pas la même chose, et l'écran le dit
    fs.rmSync(notes, { force: true });
    expect(verdict(db, null).provenance).toMatchObject({
      verified: false,
      problem: "racine_absente",
    });
  });
});
