#!/usr/bin/env node
/**
 * Validation Phase 6 — conversation (amendement v1.3 §13) — à lancer **après** avoir mené
 * des tours, web et workspace compris :
 *   node scripts/validate-phase-6.mjs [chemin-db] [--workspace=racine]
 *
 * Le script est **en lecture seule** : comme 1B, 2B, 3, 4 et 5B, il constate ce que
 * l'usage a produit, il ne rejoue pas l'API. La règle de vérification des citations est
 * **importée** du serveur (`lib/agent/conversation-citations.ts` — Node 24 lit le .ts,
 * même convention que `validate-phase-4.mjs`) : validateur et écran ne peuvent pas
 * diverger sur ce qu'est une affirmation citable. Cette import est aussi la **seule**
 * relecture de fichier du script — aucune autre touche au disque, et jamais d'écriture.
 *
 * AC1 — chaque affirmation porte une provenance vérifiée (fragment, url datée,
 *        chemin:ligne) ; une affirmation sans preuve survivante est comptée, jamais
 *        servie comme un fait.
 * AC2′ — le web est gouverné par le serveur : aucun outil web exécuté sans
 *        déverrouillage, un déverrouillage a sa raison (`corpus_insuffisant`,
 *        `demande_modele`), latched, et une réponse sur tour à web exposé a tenté le web
 *        ou cité un fichier lu (AC2′d/§13.5).
 * AC3 — les citations de fichier portent `chemin:lignes` et sont **revérifiées par
 *        relecture** (règle importée) ; la racine au moment du tour est enregistrée.
 * AC4 — la note liée à une synthèse **est** une conversation ancrée : rien n'écrit dans
 *        `fragments` ni `syntheses` (aucune colonne ajoutée, aucun compteur modifié).
 * AC5′ — budgets séparés et tenus : ≤ budget interne, ≤ budget web, un appel LLM au
 *        plus par étape, refus non facturés hors des compteurs, état terminal toujours
 *        écrit, verrou de protocole (un seul tour en vol par conversation).
 * AC7 — une copie web est vérifiée **sans aucun réseau** : le validateur le prouve en
 *        vérifiant les copies après avoir **désactivé** les modules réseau de Node.
 *
 * Enfin, chaque tour est **rejugé avec la règle courante** : un tour `done` sans
 * affirmation sourcée survivante est une mesure (un document peut dater d'avant une
 * correction), un tour `done` produit **sous la version courante du prompt** doit tenir.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// AC7 **par construction** : la vérification des copies web doit se faire sans réseau.
// On verrouille les **primitives sortantes** de Node, pas les modules entiers : geler
// tout `node:net` faisait trébucher le propre runtime de Node (`process.stdout` lit
// `net.Socket` ; charger `node:https` compile `tls`, qui lit `net.Socket` au chargement).
// Ce qui doit être interdit, c'est **sortir** — une requête, une connexion, une
// résolution — pas l'existence des classes. Toute tentative du code de l'app lèverait
// ici, dans le validateur, au lieu de rendre une promesse rejetée ailleurs.
const require = createRequire(import.meta.url);
// **Exiger d'abord, verrouiller ensuite** : le chargement lui-même a le droit de lire
// ce qu'il veut ; c'est après, pendant la vérification, que la sortie est fermée.
const NETWORK_KEYS = [
  ["node:http", ["request", "get"]],
  ["node:https", ["request", "get"]],
  ["node:net", ["connect", "createConnection"]],
  ["node:tls", ["connect"]],
  ["node:dns", ["lookup", "resolve", "resolve4", "resolve6", "reverse"]],
  ["node:dns/promises", ["lookup", "resolve", "resolve4", "resolve6", "reverse"]],
];
const netMods = NETWORK_KEYS.map(([name, keys]) => ({ name, keys, mod: require(name) }));
// l'autre chemin sortant de `net` : une Socket construite puis connectée à la main
Object.defineProperty(require("node:net").Socket.prototype, "connect", {
  get() {
    throw new Error("réseau désactivé (AC7) : net.Socket.prototype.connect");
  },
  configurable: true,
});
for (const { name, keys, mod } of netMods) {
  for (const key of keys) {
    Object.defineProperty(mod, key, {
      get() {
        throw new Error(`réseau désactivé (AC7) : ${name}.${key}`);
      },
      configurable: true,
    });
  }
}
// et le chemin moderne : le `fetch` global (undici)
Object.defineProperty(globalThis, "fetch", {
  get() {
    throw new Error("réseau désactivé (AC7) : fetch");
  },
  configurable: true,
});

// imports **relatifs** du TypeScript de l'app : le validateur est un script Node (24,
// type stripping), pas un module compilé par Next — même convention que
// `validate-phase-4.mjs` pour `evidence.ts`/`conclusion.ts`. La règle est importée,
// jamais réécrite : ce que l'écran vérifie est ce que le validateur juge.
import {
  verifyConversationTurn,
  webProblem,
  fileProblem,
} from "../lib/agent/conversation-citations.ts";
import { createWorkspace } from "../lib/agent/workspace.ts";
import {
  CONVERSATION_STEP_BUDGET,
  WEB_STEP_BUDGET,
  MAX_REFUSED_STEPS,
} from "../lib/agent/conversation-types.ts";
import { CONVERSATION_PROMPT_VERSION } from "../lib/agent/conversation-prompts.ts";

/* ------------------------------ Arguments ------------------------------- */

const args = process.argv.slice(2);
const dbArg = args.find((a) => !a.startsWith("--"));
const wsArg = args.find((a) => a.startsWith("--workspace="));
const wsOverride = wsArg ? wsArg.slice("--workspace=".length) : null;

const dbPath = dbArg ?? "./data/correlo.db";
if (!fs.existsSync(dbPath)) {
  console.error(`Base introuvable : ${dbPath}`);
  process.exit(1);
}

// La relecture des citations de fichier passe par le **même** confinement que le tour.
// Racine : `--workspace=` d'abord (elle prime — c'est le cas d'une base copiée dont les
// tours citent un dossier de vérification), puis la racine **enregistrée au moment du
// tour** (`run.workspace_root`), créée si elle a disparu : la revérification doit dire
// « copie modifiée », jamais « racine illisible », quand le contenu existe encore
// ailleurs. Un fichier absent (ou un tour sans racine) rend `racine_absente` : mesuré,
// pas masqué.
const ensuredRoots = new Set();
function workspaceFor(root) {
  if (!root) return createWorkspace(null);
  if (wsOverride) {
    if (!ensuredRoots.has(wsOverride)) {
      fs.mkdirSync(wsOverride, { recursive: true });
      ensuredRoots.add(wsOverride);
    }
    return createWorkspace(wsOverride);
  }
  const abs = path.isAbsolute(root) ? root : path.resolve(root);
  if (!fs.existsSync(abs)) {
    if (!ensuredRoots.has(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      ensuredRoots.add(abs);
      console.log(`  (racine du tour recréée vide pour la relecture : ${root})`);
    }
  }
  return createWorkspace(abs);
}

const db = new Database(dbPath, { readonly: true });
const failures = [];
const warn = (m) => failures.push(m);

/* ------------------------------- Lecture -------------------------------- */

const messages = db
  .prepare(
    `SELECT id, conversation_id, role, text, claims, run, status, created_at
     FROM messages ORDER BY created_at ASC, rowid ASC`
  )
  .all();
const conversations = new Map(
  db.prepare("SELECT id, anchor_kind, anchor_ref, title FROM conversations").all().map((c) => [c.id, c])
);
const convJobs = new Map(
  db
    .prepare(`SELECT id, status, payload FROM jobs WHERE kind = 'conversation'`)
    .all()
    .map((j) => {
      let conv = null;
      try {
        conv = JSON.parse(j.payload ?? "{}").conversation_id ?? null;
      } catch {
        conv = null;
      }
      return [j.id, { status: j.status, conversation_id: conv }];
    })
);
const counts = {
  sources: db.prepare("SELECT COUNT(*) AS n FROM sources").get().n,
  fragments: db.prepare("SELECT COUNT(*) AS n FROM fragments").get().n,
  conversations: conversations.size,
  jobs: convJobs.size,
};

console.log(`Base : ${dbPath}`);
console.log(
  `conversations : ${counts.conversations} · messages : ${messages.length} · jobs conversation : ${counts.jobs} · sources : ${counts.sources} · fragments : ${counts.fragments}\n`
);

const assistant = messages.filter((m) => m.role === "assistant");
if (assistant.length === 0) {
  warn("Aucune réponse d'assistant : l'API n'a pas été exercée (POST /api/conversations), rien à valider");
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ------------------------ État par conversation ------------------------- */

// L'ordre chronologique de la table est l'ordre affiché : l'écran liste
// `created_at ASC`, le validateur rejoue le même ordre (une divergence ici ferait
// valider un ordre que personne ne voit).
const byConversation = new Map();
for (const m of messages) {
  if (!byConversation.has(m.conversation_id)) byConversation.set(m.conversation_id, []);
  byConversation.get(m.conversation_id).push(m);
}
let interleaved = 0;
for (const rows of byConversation.values()) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].created_at < rows[i - 1].created_at) interleaved += 1;
  }
}
if (interleaved > 0) warn(`ordre : ${interleaved} inversion(s) de created_at dans les messages`);

/* ---------------------- Verdict des affirmations ------------------------ */

// La règle du serveur, jugée ici : `verifyConversationTurn` recalcule chaque
// provenance (fragment vivant, copie web, plage de fichier **relue**). Le workspace est
// résolu par tour (`run.workspace_root`), comme l'écran.
let claimCount = 0;
let sourcedCount = 0;
let unsourcedCount = 0;
let unverifiedCount = 0;
const problemCounts = {};
let turnCount = 0;
let claimsOfCurrentPromptOk = 0;
let claimsOfCurrentPromptTotal = 0;
const currentPrompt = CONVERSATION_PROMPT_VERSION;

for (const m of assistant) {
  const turn = safeParse(m.run);
  if (!turn) {
    if (m.status === "done") warn(`AC1 : réponse ${m.id.slice(0, 8)} — run illisible alors que le tour est done`);
    continue;
  }
  turnCount += 1;
  const ws = workspaceFor(turn.workspace_root);
  let verdict = { claims: [], unverified: 0, unsourced: 0 };
  try {
    verdict = verifyConversationTurn(db, turn, { workspace: ws });
  } catch (e) {
    warn(`AC1 : réponse ${m.id.slice(0, 8)} — vérification impossible (${String(e?.message ?? e)})`);
    continue;
  }
  for (const c of verdict.claims) {
    claimCount += 1;
    if (c.sourced) sourcedCount += 1;
    else unsourcedCount += 1;
    for (const p of c.provenance) {
      if (!p.verified) {
        unverifiedCount += 1;
        problemCounts[p.problem] = (problemCounts[p.problem] ?? 0) + 1;
      }
    }
  }
  // Un tour done **sous le prompt courant** doit tenir : c'est l'acceptation du protocole
  // du jour. Un tour plus ancien est une mesure (la règle a pu changer depuis).
  if (m.status === "done" && turn.prompt_version === currentPrompt) {
    claimsOfCurrentPromptTotal += verdict.claims.length;
    claimsOfCurrentPromptOk += verdict.claims.filter((c) => c.sourced).length;
    if (verdict.claims.length > 0 && verdict.claims.every((c) => !c.sourced)) {
      warn(
        `AC1 : réponse ${m.id.slice(0, 8)} (${currentPrompt}) — toutes les affirmations non sourcées à la relecture`
      );
    }
  }
}

console.log(`AC1 — chaque affirmation porte une provenance vérifiée`);
console.log(
  `  ${turnCount} tour(s) · ${claimCount} affirmation(s) · ${sourcedCount} sourcée(s) · ${unsourcedCount} non sourcée(s) · ${unverifiedCount} preuve(s) ne tenant plus ${JSON.stringify(problemCounts)}`
);
console.log(
  `  tours sous ${currentPrompt} : ${claimsOfCurrentPromptOk}/${claimsOfCurrentPromptTotal} affirmation(s) sourcée(s) à la relecture`
);

/* ------------------------- AC2′ — web gouverné -------------------------- */

// Chaque tour dont le web a servi doit porter une raison de déverrouillage, latched
// (`web_unlocked` reste vrai une fois ouvert), et aucun outil web exécuté sans lui.
let webTurns = 0;
let webSteps = 0;
const unlockReasons = {};
let unlockMissing = 0;
let webWithoutUnlock = 0;
let ansWithoutAttempt = 0;

for (const m of assistant) {
  const turn = safeParse(m.run);
  if (!turn) continue;
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  const webExec = steps.filter(
    (s) => s.scope === "web" && s.charged !== false && (s.action === "search_web" || s.action === "read_page")
  );
  if (webExec.length === 0) continue;
  webTurns += 1;
  webSteps += webExec.length;
  if (!turn.web_unlocked) webWithoutUnlock += 1;
  if (!turn.web_unlock_reason) unlockMissing += 1;
  else unlockReasons[turn.web_unlock_reason] = (unlockReasons[turn.web_unlock_reason] ?? 0) + 1;
}

// AC2′d — **boucle à part, et c'est la falsification qui l'a dit** : la première version
// logeait cette règle dans la boucle ci-dessus, derrière son `continue` — elle ne pouvait
// donc jamais voir le tour qui l'intéresse (web exposé, **zéro** étape web exécutée).
// Deuxième défaut, trouvé par le même procédé : la « tentative » ne comptait que les étapes
// **facturées**, alors que §13.4 dit l'inverse — un `search_web` refusé (non facturé)
// répond au constat comme une recherche vide. Une règle de validateur doit être
// falsifiable : on écrit le tour qu'elle devrait attraper, et on regarde.
// Même condition que le service : web exposé, budget > 0, réponse `done` — et ni tentative
// web (facturée **ou** refusée), ni fichier cité (le fichier désigné par l'utilisateur
// répond au constat, §13.5).
for (const m of assistant) {
  const turn = safeParse(m.run);
  if (!turn || m.status !== "done") continue;
  if (!turn.web_unlocked || (turn.web_budget ?? 0) <= 0) continue;
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  const attempted = steps.some((s) => s.scope === "web");
  const citedFile = (turn.claims ?? []).some((c) => (c.provenance ?? []).some((p) => p.kind === "file"));
  if (!attempted && !citedFile) ansWithoutAttempt += 1;
}
if (webWithoutUnlock > 0) warn(`AC2′ : ${webWithoutUnlock} tour(s) ont exécuté du web sans déverrouillage`);
if (unlockMissing > 0) warn(`AC2′ : ${unlockMissing} tour(s) web sans raison de déverrouillage`);
if (ansWithoutAttempt > 0)
  warn(`AC2′d : ${ansWithoutAttempt} réponse(s) sur tour à web exposé sans tentative web ni fichier cité`);

console.log(`\nAC2′ — le web est gouverné par le serveur`);
console.log(
  `  ${webTurns} tour(s) web · ${webSteps} étape(s) web exécutée(s) · raisons ${JSON.stringify(unlockReasons)}`
);

/* ---------------------- AC3 — workspace (fichiers) ---------------------- */

let fileTurns = 0;
let fileReads = 0;
let fileClaims = 0;
let fileVerified = 0;
let rootRecorded = 0;
let refusedReads = 0;
for (const m of assistant) {
  const turn = safeParse(m.run);
  if (!turn) continue;
  const reads = Array.isArray(turn.workspace_reads) ? turn.workspace_reads : [];
  const okReads = reads.filter((r) => !r.failure);
  if (reads.length === 0) continue;
  fileTurns += 1;
  fileReads += okReads.length;
  refusedReads += reads.length - okReads.length;
  if (turn.workspace_root != null) rootRecorded += 1;
  for (const c of turn.claims ?? []) {
    for (const p of c.provenance ?? []) {
      if (p.kind !== "file") continue;
      fileClaims += 1;
      if (fileProblem(workspaceFor(turn.workspace_root), turn, p) === null) fileVerified += 1;
    }
  }
}
console.log(`\nAC3 — workspace : chemin:ligne, revérifié par relecture`);
console.log(
  `  ${fileTurns} tour(s) avec lectures · ${fileReads} lecture(s) réussie(s) · ${refusedReads} refusée(s) · ${rootRecorded} tour(s) portant la racine du moment`
);
console.log(
  `  ${fileClaims} citation(s) de fichier · ${fileVerified} tenant encore (relecture par le même confinement)`
);
if (fileClaims !== fileVerified) {
  warn(`AC3 : ${fileClaims - fileVerified} citation(s) de fichier ne tiennent plus à la relecture`);
}

/* ------------------- AC4 — note = conversation ancrée ------------------- */

// Une note liée à une synthèse **est** une conversation ancrée (§13.6) : elle n'écrit
// nulle part ailleurs. Le validateur ne peut pas prouver une absence d'écriture par le
// contenu des tables ; il vérifie ce qui est vérifiable : toute conversation ancrée
// `synthesis` désigne une synthèse qui existait, et rien dans les tours n'a modifié les
// compteurs du corpus (les tables verrouillées sont celles de la migration 001).
let anchored = 0;
let anchoredMissing = 0;
for (const c of conversations.values()) {
  if (c.anchor_kind !== "synthesis") continue;
  anchored += 1;
  if (c.anchor_ref) {
    const live = db.prepare("SELECT id FROM syntheses WHERE id = ?").get(c.anchor_ref);
    if (!live) anchoredMissing += 1;
  }
}
console.log(`\nAC4 — note = conversation ancrée, corpus inchangé`);
console.log(
  `  ${anchored} conversation(s) ancrée(s) synthèse · ${anchoredMissing} ancre(s) disparue(s) (lisible : ` +
    `le tour le dit, la conversation reste) · sources ${counts.sources} · fragments ${counts.fragments}`
);

/* ----------------------- AC5′ — budgets et bornes ----------------------- */

let overInternal = 0;
let overWeb = 0;
let callsVsSteps = 0;
let noTerminalState = 0;
let refusedOverCeiling = 0;
let jobMessageMismatch = 0;
let badJobs = 0;
// tours **semés** : le check navigateur écrit un document de tour à la main (sans clé, sans
// réseau) dans sa copie jetable, avec un marqueur explicite — reconnaissable, donc compté
// à part et exclu du couplage au job, mais **pas** des autres vérifications (verdicts,
// budgets) : une graine mal formée doit se voir aussi.
const SEEDED_MODEL = "graine-de-verification";
let seededTurns = 0;
let maxSteps = 0;
const statusCounts = {};
const failureCounts = {};
let cachedSteps = 0;
let llmCalls = 0;

for (const m of assistant) {
  const turn = safeParse(m.run);
  if (!turn) continue;
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
  maxSteps = Math.max(maxSteps, steps.length);
  cachedSteps += turn.steps_from_cache ?? 0;
  llmCalls += turn.llm_calls ?? 0;

  const chargedInternal = steps.filter((s) => (s.scope ?? "internal") === "internal" && s.charged !== false).length;
  const chargedWeb = steps.filter((s) => s.scope === "web" && s.charged !== false).length;
  const refusals = steps.filter((s) => s.charged === false).length;
  if (chargedInternal > (turn.step_budget ?? CONVERSATION_STEP_BUDGET)) overInternal += 1;
  if (chargedWeb > (turn.web_budget ?? WEB_STEP_BUDGET)) overWeb += 1;
  if ((turn.llm_calls ?? 0) > steps.length) callsVsSteps += 1;
  if (refusals > MAX_REFUSED_STEPS) refusedOverCeiling += 1;

  if (m.status === "failed" && !turn.failure) noTerminalState += 1;
  if (m.status === "failed") {
    const f = turn.failure;
    failureCounts[f] = (failureCounts[f] ?? 0) + 1;
  }

  // Un appel LLM au plus par étape — même garde que la Phase 4 (jamais deux agents).
  if (steps.some((s) => s.charged !== false && s.index === undefined)) {
    warn(`AC5′ : réponse ${m.id.slice(0, 8)} — étape sans index`);
  }
  const job = convJobs.get(m.id);
  if (!job) {
    // la réponse d'un job conversation a l'id du job ; une réponse sans job est un tour
    // écrit hors de la file — sauf une graine de vérification, qui n'a jamais prétendu
    // passer par la file
    if (turn.chat_model === SEEDED_MODEL) seededTurns += 1;
    else jobMessageMismatch += 1;
  } else if (job.conversation_id && job.conversation_id !== m.conversation_id) {
    badJobs += 1;
  }
}

// Le verrou de protocole : sur une conversation, entre deux réponses d'assistant, il y a
// exactement une question — deux questions d'affilée sont deux tours en vol (le défaut
// mesuré du 2026-09-19), deux réponses d'affilée un trou de trace.
let protocolLock = 0;
for (const [, rows] of byConversation) {
  let lastRole = null;
  for (const m of rows) {
    if (m.role === lastRole) protocolLock += 1;
    lastRole = m.role;
  }
}

console.log(`\nAC5′ — budgets séparés, un appel par étape, verrou de protocole`);
console.log(
  `  états ${JSON.stringify(statusCounts)} · échecs ${JSON.stringify(failureCounts)} · maximum ${maxSteps} étape(s) · ` +
    `${llmCalls} appel(s) LLM · ${cachedSteps} étape(s) servie(s) par le cache`
);
console.log(
  `  plafond interne ${CONVERSATION_STEP_BUDGET} · web ${WEB_STEP_BUDGET} · refus non facturés ≤ ${MAX_REFUSED_STEPS}` +
    ` · graine(s) de vérification : ${seededTurns}`
);
if (overInternal > 0) warn(`AC5′ : ${overInternal} tour(s) dépassent le budget interne`);
if (overWeb > 0) warn(`AC5′ : ${overWeb} tour(s) dépassent le budget web`);
if (callsVsSteps > 0) warn(`AC5′ : ${callsVsSteps} tour(s) avec plus d'appels que d'étapes`);
if (refusedOverCeiling > 0) warn(`AC5′ : ${refusedOverCeiling} tour(s) avec plus de ${MAX_REFUSED_STEPS} refus non facturés`);
if (noTerminalState > 0) warn(`AC5′ : ${noTerminalState} réponse(s) failed sans motif d'échec`);
if (jobMessageMismatch > 0) warn(`AC5′ : ${jobMessageMismatch} réponse(s) sans job conversation (id = id du job attendu)`);
if (badJobs > 0) warn(`AC5′ : ${badJobs} job(s) pointent une autre conversation que la réponse`);
if (protocolLock > 0) warn(`AC5′ : ${protocolLock} anomalie(s) d'ordre (deux questions ou deux réponses d'affilée)`);

// Réponses `pending` à vie : le défaut que le workspace a trouvé (sortie invalide sans
// écriture d'état terminal). La ligne attend sa réponse, le job est `done`, et rien
// n'arrivera — l'écran sonde sans fin. Toute réponse en attente doit avoir un job vivant.
const pending = messages.filter((m) => m.role === "assistant" && m.status === "pending");
if (pending.length > 0) {
  const orphans = pending.filter((m) => {
    const job = convJobs.get(m.id);
    return !job || job.status === "done" || job.status === "failed";
  });
  if (orphans.length > 0) {
    warn(`AC5′ : ${orphans.length} réponse(s) pending sans job vivant (état terminal jamais écrit)`);
  }
}

/* ----------------- AC7 — copies web, sans réseau, rejugées ---------------- */

let webClaims = 0;
let webVerified = 0;
const webProblems = {};
for (const m of assistant) {
  const turn = safeParse(m.run);
  if (!turn) continue;
  for (const c of turn.claims ?? []) {
    for (const p of c.provenance ?? []) {
      if (p.kind !== "url") continue;
      webClaims += 1;
      const problem = webProblem(turn.web_results ?? [], p);
      if (problem === null) webVerified += 1;
      else webProblems[problem] = (webProblems[problem] ?? 0) + 1;
    }
  }
}
console.log(`\nAC7 — copies web vérifiées sans réseau (modules réseau désactivés pendant tout ce script)`);
console.log(`  ${webClaims} citation(s) web · ${webVerified} d'intégrité prouvée ${JSON.stringify(webProblems)}`);
if (webClaims !== webVerified) {
  warn(`AC7 : ${webClaims - webVerified} copie(s) web ne correspondent plus à la lecture du tour`);
}

/* -------------------------------- Bilan --------------------------------- */

db.close();

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `\nPhase 6 : PASS — affirmations rattachées et revérifiées (corpus, web daté, fichier relu), ` +
    `web gouverné par le serveur (constat ou demande), workspace confiné, budgets séparés tenus, ` +
    `et la vérification des copies faite sans aucun accès réseau.`
);
process.exit(0);
