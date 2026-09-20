#!/usr/bin/env node
/**
 * Vérification navigateur Phase 6 — l'écran de conversation et ses deux portes d'entrée.
 *   node scripts/browser-check-6.mjs [base-url]
 *
 * Pourquoi ce script existe, alors que les tests couvrent le service, les routes et la
 * lecture : la Phase 5B a montré qu'un défaut d'écran peut être **invisible** au build, au
 * lint et aux 400 tests (crash React #185 : la page blanchissait). Ici le risque est du même
 * ordre — l'écran suit un tour **asynchrone** (en file, puis en cours, puis rendu) et il est
 * le seul endroit où l'AC1 devient visible : une affirmation, et sous elle ses preuves
 * revérifiées.
 *
 * Ce que le script fait, dans l'ordre :
 *  A. la nav mène à l'écran de création, qui liste les conversations passées ;
 *  B. la **première porte** — `/syntheses` → « Discuter » → l'écran porte l'ancre de la
 *     synthèse (AC4 : c'est là que naît la note liée) ;
 *  C. la **seconde porte** — une question posée sur le corpus entier, depuis l'écran ;
 *  D. le tour : le champ passe à « Réponse en cours » (désactivé) puis la réponse s'affiche,
 *     avec ses provenances, ses étapes et **aucun indice de catalogue dans la phrase**
 *     affichée (« le fragment [0] affirme que… » était le défaut réel du 2026-09-19) ;
 *  E. le **tour web** : une conversation porteuse d'une citation web (écrite directement
 *     dans la copie de base, cf. `seedWebTurn`) doit afficher l'URL, la **date de lecture**
 *     et la liste des résultats — sans quoi l'AC2′b (« chaque usage du web est une étape
 *     visible ») serait tenu côté serveur et invisible côté écran ;
 *  F. le **tour workspace** : une conversation porteuse d'une citation de fichier
 *     (`seedWorkspaceTurn`) doit afficher la **racine active**, le `chemin:lignes` et la
 *     lecture dans les étapes. Le script **écrit lui-même** la racine qu'il cite
 *     (`data/eval/ws-check`), donc la revérification à l'affichage passe — et si le serveur
 *     n'a pas été lancé avec le même `WORKSPACE_ROOT`, le check le dit au lieu de laisser
 *     croire à un défaut d'écran.
 *
 * Ce que le script ne fait **pas** : juger la réponse. Le serveur a déjà vérifié ce qui est
 * citable ; ici on regarde ce qui est *affiché*.
 *
 * Prérequis : un serveur lancé sur une **copie jetable** de la base (jamais la base réelle —
 * l'étape C écrit vraiment un tour et paie un appel LLM par étape, et l'étape E y écrit une
 * conversation de vérification).
 *   DATABASE_PATH=./data/eval/phase6-http2.db WORKSPACE_ROOT=./data/eval/ws-check \
 *     npx next dev -p 3232
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import Database from "better-sqlite3";

const SHOT_DIR = "data/eval/screenshots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const BASE = process.argv[2] ?? "http://localhost:3224";
const CHROME = "C:/Users/timot/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe";
const SHORT = 700; // timeout de lecture : jamais le défaut (30 s)

const results = [];
const check = (name, ok, detail = "") =>
  results.push({ name, ok, detail: String(detail).slice(0, 240) });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("requestfailed", (r) => {
  // un `ERR_ABORTED` est bénin ici : l'écran se ré-écrit pendant un re-rendu de suivi
  if (r.failure()?.errorText === "net::ERR_ABORTED") return;
  failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`);
});

const clean = (s) => s.replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lecture courte et réessayée : renvoie "" si le nœud est remplacé en plein vol. */
async function quickText(locator, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return clean(await locator.innerText({ timeout: SHORT }));
    } catch {
      await sleep(150);
    }
  }
  return "";
}

/** Attend qu'un prédicat Node soit vrai (relit le DOM à chaque tour : re-rendus ok). */
async function pollUntil(fn, timeoutMs, stepMs = 400) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* nœud remplacé entre-temps : on réessaie */
    }
    await sleep(stepMs);
  }
  return false;
}

const bodyText = () => quickText(page.locator("main"));
const askButton = () => page.getByRole("button", { name: /Demander|Réponse en cours/ });

const DB_PATH = process.env.DATABASE_PATH ?? "";
const WEB_CONVERSATION_ID = "conv-web-check";
const WS_CONVERSATION_ID = "conv-ws-check";
/** Racine créée **par ce script** : le serveur doit la recevoir en `WORKSPACE_ROOT`. */
const WS_ROOT = "data/eval/ws-check";
const WS_FILE = "notes/protocole.md";

/**
 * Écrit un tour **web** dans la copie de base, sans appeler le modèle.
 *
 * C'est le seul moyen de vérifier l'affichage d'une citation web sans clé ni réseau : le
 * document de tour est celui qu'un vrai tour produirait (mêmes champs, mêmes familles de
 * provenance), et la vérification à la lecture le reprend tel quel — donc ce que l'écran
 * affiche ici est exactement ce qu'il affichera d'une page réellement lue.
 */
function seedWebTurn() {
  const at = "2026-09-20T09:30:00.000Z";
  const url = "https://exemple.org/protocoles-des-mesures";
  const page =
    "La mesure experimentale fixe les conditions de l'observation et les protocoles du laboratoire.";
  const run = {
    prompt_version: "conversation-v3",
    chat_model: "graine-de-verification",
    step_budget: 5,
    web_budget: 3,
    llm_calls: 4,
    steps_from_cache: 0,
    history_messages: 0,
    internal_steps: 2,
    web_steps: 2,
    web_unlocked: true,
    web_unlock_min_evidence: 2,
    web_unlock_reason: "corpus_insuffisant",
    web_results: [
      {
        index: 0,
        url,
        title: "Protocoles de mesure",
        snippet: "publié le 2024-03-04",
        found_at: at,
        read: true,
        text: page,
        retrieved_at: at,
      },
    ],
    catalogue: [],
    steps: [
      {
        index: 1,
        action: "search",
        scope: "internal",
        input: { query: "observation fiable" },
        added: [0],
        observation: [0],
      },
      {
        index: 2,
        action: "search_web",
        scope: "web",
        input: { query: "protocoles de mesure" },
        added: [],
        observation: [],
        web_added: [0],
        web_observation: [0],
      },
      {
        index: 3,
        action: "read_page",
        scope: "web",
        input: { result: 0 },
        added: [],
        observation: [],
        web_observation: [0],
      },
      {
        index: 4,
        action: "answer",
        scope: "internal",
        input: {},
        added: [],
        observation: [],
        web_observation: [0],
      },
    ],
    claims: [
      {
        text: "Le protocole publié décrit la même exigence que le corpus.",
        provenance: [
          { kind: "url", index: 0, url, title: "Protocoles de mesure", retrieved_at: at, excerpt: page },
        ],
      },
    ],
    unsourced: 0,
  };

  const db = new Database(DB_PATH);
  try {
    const write = db.transaction(() => {
      db.prepare("DELETE FROM conversations WHERE id = ?").run(WEB_CONVERSATION_ID);
      db.prepare(
        `INSERT INTO conversations (id, anchor_kind, anchor_ref, title, chat_model, prompt_version, created_at, updated_at)
         VALUES (?, 'corpus', NULL, ?, ?, ?, ?, ?)`
      ).run(WEB_CONVERSATION_ID, "Question de vérification web", "graine", "conversation-v3", at, at);
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, text, claims, run, status, created_at)
         VALUES (?, ?, 'user', ?, '[]', NULL, 'done', ?)`
      ).run(`${WEB_CONVERSATION_ID}-u`, WEB_CONVERSATION_ID, "Que dit le web sur la mesure ?", at);
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, text, claims, run, status, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?, 'done', ?)`
      ).run(
        `${WEB_CONVERSATION_ID}-a`,
        WEB_CONVERSATION_ID,
        run.claims[0].text,
        JSON.stringify(run.claims),
        JSON.stringify(run),
        at
      );
    });
    write();
  } finally {
    db.close();
  }
}

/**
 * Écrit la racine citée par la graine workspace, et **rend la plage avec sa copie** : la
 * vérification à l'affichage relit le fichier par le confinement, donc la graine doit citer
 * ce qui existe réellement — un texte inventé donnerait un « copie modifiée » qui ne dirait
 * rien de l'écran.
 */
function seedWorkspaceFixture() {
  fs.mkdirSync(`${WS_ROOT}/notes`, { recursive: true });
  fs.writeFileSync(
    `${WS_ROOT}/${WS_FILE}`,
    [
      "# Protocole de calibration — atelier 4",
      "1. Laisser la sonde reposer vingt minutes à température ambiante.",
      "2. Étalonner sur deux points seulement : 4,0 et 7,0.",
      "",
    ].join("\n")
  );
  const lines = fs.readFileSync(`${WS_ROOT}/${WS_FILE}`, "utf8").split(/\r\n|\n/);
  const text = lines.slice(0, 3).join("\n");
  return { text, excerpt: clean(text), from: 1, to: 3 };
}

/** Une conversation qui cite un fichier du workspace, pour regarder ce que l'écran en dit. */
function seedWorkspaceTurn(seed) {
  const at = "2026-09-20T11:00:00.000Z";
  const run = {
    prompt_version: "conversation-v8",
    chat_model: "graine-de-verification",
    step_budget: 5,
    web_budget: 3,
    llm_calls: 2,
    steps_from_cache: 0,
    history_messages: 0,
    internal_steps: 2,
    web_steps: 0,
    web_unlocked: false,
    web_unlock_min_evidence: 2,
    web_unlock_reason: "constat_en_attente",
    web_results: [],
    workspace_root: WS_ROOT,
    workspace_reads: [
      {
        index: 0,
        path: WS_FILE,
        from_line: seed.from,
        to_line: seed.to,
        text: seed.text,
        bytes: Buffer.byteLength(seed.text, "utf8"),
        read_at: at,
      },
    ],
    catalogue: [],
    steps: [
      {
        index: 1,
        action: "read_file",
        scope: "internal",
        input: { path: WS_FILE, from: seed.from, to: seed.to },
        added: [],
        observation: [],
        workspace_added: [0],
        workspace_observation: [0],
      },
      { index: 2, action: "answer", scope: "internal", input: {}, added: [], observation: [], workspace_observation: [0] },
    ],
    claims: [
      {
        text: "Le protocole de l'atelier 4 impose un repos de vingt minutes et un étalonnage sur deux points.",
        provenance: [
          {
            kind: "file",
            index: 0,
            path: WS_FILE,
            from_line: seed.from,
            to_line: seed.to,
            read_at: at,
            excerpt: seed.excerpt,
          },
        ],
      },
    ],
    unsourced: 0,
  };

  const db = new Database(DB_PATH);
  try {
    const write = db.transaction(() => {
      db.prepare("DELETE FROM conversations WHERE id = ?").run(WS_CONVERSATION_ID);
      db.prepare(
        `INSERT INTO conversations (id, anchor_kind, anchor_ref, title, chat_model, prompt_version, created_at, updated_at)
         VALUES (?, 'corpus', NULL, ?, ?, ?, ?, ?)`
      ).run(WS_CONVERSATION_ID, "Question de vérification workspace", "graine", "conversation-v8", at, at);
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, text, claims, run, status, created_at)
         VALUES (?, ?, 'user', ?, '[]', NULL, 'done', ?)`
      ).run(`${WS_CONVERSATION_ID}-u`, WS_CONVERSATION_ID, "Que dit notes/protocole.md ?", at);
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, text, claims, run, status, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?, 'done', ?)`
      ).run(
        `${WS_CONVERSATION_ID}-a`,
        WS_CONVERSATION_ID,
        run.claims[0].text,
        JSON.stringify(run.claims),
        JSON.stringify(run),
        at
      );
    });
    write();
  } finally {
    db.close();
  }
}

try {
  /* ============ A — nav → écran de création ============ */
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  const nav = page.getByRole("link", { name: "Conversation" }).first();
  check("nav : une entrée « Conversation »", (await nav.count()) >= 1);
  await nav.click({ force: true, timeout: 5_000 });
  await page.waitForURL(/\/conversation$/, { timeout: 15_000 });
  const intro = await bodyText();
  check(
    "création : champ « Première question » et ancre corpus annoncée",
    /Première question/.test(intro) && /ensemble du corpus/.test(intro),
    intro.slice(0, 160)
  );
  // la liste est chargée par l'écran **après** le montage : on l'attend (le lire au timeout
  // par défaut, c'est lire un état transitoire — constaté en écrivant ce script)
  const listed = await pollUntil(async () => /Conversations récentes/.test(await bodyText()), 10_000);
  const listText = await bodyText();
  check(
    "création : les conversations passées sont listées (ou l'écran dit qu'il n'y en a pas)",
    listed && (/Aucune conversation/.test(listText) || /message\(s\)/.test(listText)),
    (listText.match(/Conversations récentes.{0,120}/) ?? [""])[0]
  );
  await page.screenshot({ path: `${SHOT_DIR}/6-conversation-creation.png` });

  /* ============ B — première porte : « Discuter » depuis une synthèse ============ */
  await page.goto(`${BASE}/syntheses`, { waitUntil: "load" });
  const discuter = page.getByRole("link", { name: /Discuter/ }).first();
  const hasDiscuter = await pollUntil(async () => (await discuter.count()) > 0, 20_000);
  check("synthèses : un lien « Discuter »", hasDiscuter);
  if (hasDiscuter) {
    await discuter.click({ force: true, timeout: 5_000 });
    await page.waitForURL(/\/conversation\?anchor=synthesis/, { timeout: 15_000 });
    const anchored = await bodyText();
    check(
      "synthèses : « Discuter » ouvre la conversation ancrée sur cette synthèse",
      /Part de la synthèse/.test(anchored) && /point de départ, pas la question/.test(anchored),
      anchored.slice(0, 200)
    );
  }

  /* ============ C — seconde porte : une question sur le corpus entier ============ */
  await page.goto(`${BASE}/conversation`, { waitUntil: "load" });
  await askButton().waitFor({ timeout: 15_000 });
  const question = "Que disent les documents sur ce qui rend une observation fiable ?";
  await page.locator("#conversation-draft").fill(question);
  await askButton().click({ force: true, timeout: 5_000 });

  // la conversation créée a sa propre adresse, et le champ attend la réponse
  const addressed = await pollUntil(async () => /\/conversation\/[0-9a-f-]{8}/.test(page.url()), 20_000);
  check("question posée : l'écran navigue vers /conversation/<id>", addressed, page.url());

  const waiting = await pollUntil(async () => {
    const t = await quickText(askButton(), 1);
    return /Réponse en cours/.test(t);
  }, 15_000);
  check(
    "tour en vol : le champ est désactivé et dit « Réponse en cours »",
    waiting,
    await quickText(askButton(), 1)
  );

  /* ============ D — la réponse rendue ============ */
  const rendered = await pollUntil(async () => {
    const t = await quickText(askButton(), 1);
    return /^Demander$/.test(t);
  }, 180_000);
  // les étapes vivent dans un `<details>` **replié** : un `innerText` sur `main` ne les voit
  // pas (piège rencontré ici). On déplie avant de lire — c'est aussi ce que fait l'utilisateur.
  const summary = page.locator("summary", { hasText: "Tour de l'agent" }).first();
  if ((await summary.count()) > 0) await summary.click({ force: true, timeout: SHORT });
  await sleep(300);
  const final = await bodyText();
  await page.screenshot({ path: `${SHOT_DIR}/6-conversation-reponse.png` });

  check("le tour se termine : le champ est de nouveau actif", rendered, final.slice(0, 120));
  check(
    "la question est rendue telle qu'elle a été posée",
    final.includes(clean(question)),
    ""
  );
  check(
    "aucun indice de catalogue dans la phrase affichée (défaut du 2026-09-19)",
    !/fragment\s*\[\s*\d+\s*\]/i.test(final) && !/\btexte\s*\[\s*\d+\s*\]/i.test(final),
    (final.match(/fragment\s*\[\s*\d+\s*\]/i) ?? [""])[0]
  );
  check(
    "les provenances sont rendues sous les affirmations (indice · source · locator)",
    /\[\d+\]\s/.test(final) && /·/.test(final),
    ""
  );
  check(
    "le tour de l'agent est affiché : étapes et appels LLM",
    /Tour de l'agent/.test(final) && /\d+\/\d+ étape/.test(final) && /appel/.test(final),
    (final.match(/Tour de l'agent[^.]{0,120}/) ?? [""])[0]
  );
  check(
    "l'agent a lu avant de répondre : une étape de lecture apparaît",
    /recherche dans le corpus|voisinage d'un fragment/.test(final),
    ""
  );
  check(
    "aucune preuve signalée comme ne tenant plus (base intacte)",
    !/ne tiennent plus/.test(final) && !/citation rejetée/.test(final),
    ""
  );

  /* ============ E — un tour web : URL, date de lecture, étapes visibles ============ */
  // Garde : cette graine ÉCRIT une conversation. Sur la base réelle, ce serait un artefact
  // d'outil dans les données du produit — arrivé en écrivant ce script, parce que
  // `DATABASE_PATH` était exporté dans le shell. Le chemin doit donc désigner une copie
  // jetable, sinon on ne grave rien.
  const disposable = /data[\\/]eval[\\/]/.test(DB_PATH);
  if (!DB_PATH || !fs.existsSync(DB_PATH) || !disposable) {
    check(
      "tour web : copie de base jetable disponible pour la graine",
      false,
      `DATABASE_PATH=${DB_PATH || "(non défini)"} — attendu sous data/eval/`
    );
  } else {
    seedWebTurn();
    await page.goto(`${BASE}/conversation/${WEB_CONVERSATION_ID}`, { waitUntil: "load" });
    const loaded = await pollUntil(async () => /Protocoles de mesure/.test(await bodyText()), 15_000);
    const webSummary = page.locator("summary", { hasText: "Tour de l'agent" }).first();
    if ((await webSummary.count()) > 0) await webSummary.click({ force: true, timeout: SHORT });
    await sleep(300);
    const web = await bodyText();
    await page.screenshot({ path: `${SHOT_DIR}/6-conversation-web.png` });

    check("tour web : la citation est affichée", loaded, web.slice(0, 160));
    check(
      "tour web : l'URL de la page citée est visible (AC2′b)",
      web.includes("https://exemple.org/protocoles-des-mesures"),
      ""
    );
    check(
      "tour web : la citation est datée (« copie lue le … »)",
      /copie lue le\s*2026-09-20/.test(web),
      (web.match(/copie lue le[^·]{0,20}/) ?? [""])[0]
    );
    check(
      "tour web : la recherche et la lecture sont des étapes affichées",
      /recherche web/.test(web) && /lecture d'une page web/.test(web) && /W0/.test(web),
      ""
    );
    check(
      "tour web : le motif du déverrouillage est dit, et les budgets séparés",
      /corpus insuffisant/.test(web) && /étape\(s\) interne\(s\)/.test(web) && /\d+\/3 web/.test(web),
      (web.match(/Tour de l'agent[^.]{0,120}/) ?? [""])[0]
    );
    check(
      "tour web : la copie n'est pas signalée comme ne tenant plus (vérifiée à la lecture)",
      !/ne tiennent plus/.test(web),
      ""
    );
  }

  /* ============ F — un tour workspace : racine, chemin:lignes, étape de lecture ============ */
  if (!DB_PATH || !fs.existsSync(DB_PATH) || !disposable) {
    check(
      "tour workspace : copie de base jetable disponible pour la graine",
      false,
      `DATABASE_PATH=${DB_PATH || "(non défini)"} — attendu sous data/eval/`
    );
  } else {
    seedWorkspaceTurn(seedWorkspaceFixture());
    await page.goto(`${BASE}/conversation/${WS_CONVERSATION_ID}`, { waitUntil: "load" });
    const loaded = await pollUntil(async () => /atelier 4 impose/.test(await bodyText()), 15_000);
    const wsSummary = page.locator("summary", { hasText: "Tour de l'agent" }).first();
    if ((await wsSummary.count()) > 0) await wsSummary.click({ force: true, timeout: SHORT });
    await sleep(300);
    const ws = await bodyText();
    await page.screenshot({ path: `${SHOT_DIR}/6-conversation-workspace.png` });

    check("tour workspace : la citation est affichée", loaded, ws.slice(0, 160));
    check(
      "tour workspace : la racine active est affichée (AC3 — l'écran la dit, ne la choisit pas)",
      /Lecture locale autorisée/.test(ws) && /ws-check/.test(ws),
      (ws.match(/Lecture locale autorisée[^.]{0,80}/) ?? [""])[0]
    );
    check(
      "tour workspace : la citation porte le chemin et la plage",
      /notes\/protocole\.md/.test(ws) && /lignes 1-3/.test(ws),
      (ws.match(/notes\/protocole\.md[^·]{0,40}/) ?? [""])[0]
    );
    check(
      "tour workspace : la lecture de fichier est une étape visible",
      /lecture d'un fichier du workspace/.test(ws) && /F0/.test(ws),
      ""
    );
    check(
      "tour workspace : la plage est revérifiée à l'affichage (le fichier n'a pas bougé)",
      !/ne tiennent plus/.test(ws) && !/fichier absent/.test(ws),
      (ws.match(/ne tiennent plus[^.]{0,60}/) ?? [""])[0]
    );
  }
} catch (e) {
  check("ERREUR de parcours", false, e.message);
} finally {
  await browser.close();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
check("0 erreur console", consoleErrors.length === 0, consoleErrors.join(" | "));
check("0 requête en échec", failedRequests.length === 0, failedRequests.join(" | "));
for (const r of results.slice(-2)) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
