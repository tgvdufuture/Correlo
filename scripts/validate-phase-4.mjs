#!/usr/bin/env node
/**
 * Validation Phase 4 (PRD §4, US-09) — à lancer **après** avoir ouvert des enquêtes :
 *   node scripts/validate-phase-4.mjs [chemin-db]
 *
 * Le script est **en lecture seule** : comme 1B, 2B et 3, il constate ce que l'usage
 * a produit, il ne rejoue pas l'API. Il applique la même vérification que le serveur
 * (`lib/agent/citations.ts`) : existence du fragment, texte identique, source
 * identique — recalculée ici sur la base, au moment où on regarde.
 *
 * AC1 — 1 agent, ≤ 5 étapes : plafond respecté, un appel LLM au plus par étape
 *        (jamais plusieurs agents en parallèle), indices de catalogue contigus.
 * AC2 — toute citation est vérifiée programmatiquement contre des fragments
 *        existants (id + texte) ; une étape dont une citation ne tient plus est
 *        `failed` et n'est **jamais** affichée comme preuve.
 * AC3 — aucune vérification web : les actions possibles sont énumérées et aucune
 *        n'est un accès réseau (la seule sortie réseau du produit est le chat LLM).
 *
 * Et une **mesure** de la barrière de conclusion (`lib/quality/conclusion.ts`,
 * `conclusion-v2`) : chaque conclusion stockée est re-jugée avec la règle courante. Une
 * conclusion **acceptée** que la règle refuse est une mesure, pas un échec — le run
 * peut dater d'une version antérieure de la barrière (c'est même le cas de référence :
 * les deux conclusions du run du 2026-09-18 ont été acceptées par un service qui
 * n'appliquait ni la juxtaposition ni les formules holistiques). En revanche, une
 * conclusion d'un document produit **sous la règle courante** doit être acceptée :
 * c'est l'acceptation `done` du protocole, et elle est vérifiée.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
// import **relatif** de TypeScript : le validateur est un script Node (24, type stripping),
// pas un module compilé par Next — même convention que `evaluate-phase-2a.mjs`. La barrière
// est importée, pas réécrite : ce que le serveur filtre est ce que le validateur juge.
import {
  CONCLUSION_RULE_VERSION,
  judgeConclusion,
} from "../lib/quality/conclusion.ts";

const dbPath = process.argv[2] ?? "./data/correlo.db";
if (!fs.existsSync(dbPath)) {
  console.error(`Base introuvable : ${dbPath}`);
  process.exit(1);
}

const STEP_BUDGET = 5;
const ACTIONS = new Set(["search", "expand", "conclude", "invalid"]);
const TERMINAL = new Set(["conclude", "invalid"]);

const db = new Database(dbPath, { readonly: true });
const failures = [];
const warn = (m) => failures.push(m);

const rows = db
  .prepare("SELECT rowid, * FROM investigations ORDER BY rowid")
  .all();
const fragments = new Map(
  db.prepare("SELECT id, source_id, text FROM fragments").all().map((f) => [f.id, f])
);
const suggestions = new Map(
  db.prepare("SELECT id, claim, state FROM suggestions").all().map((s) => [s.id, s])
);
const jobs = new Map(
  db.prepare("SELECT id, kind, status, error FROM jobs WHERE kind = 'investigation'").all().map((j) => [j.id, j])
);

console.log(`Base : ${dbPath}`);
console.log(
  `investigations : ${rows.length} · jobs investigation : ${jobs.size} · suggestions : ${suggestions.size}\n`
);

if (rows.length === 0) {
  warn("Aucune investigation : l'API n'a pas été exercée (POST /api/suggestions/:id/investigate), rien à valider");
}

/* ---------------------------------- AC1 ---------------------------------- */

console.log("AC1 — 1 agent, ≤ 5 étapes");
let maxSteps = 0;
let cachedSteps = 0;
let terminalOk = 0;
const statusCounts = {};

for (const row of rows) {
  const id = row.id.slice(0, 8);
  let doc;
  try {
    doc = JSON.parse(row.steps);
  } catch {
    warn(`AC1 : investigation ${id} — steps illisible (JSON invalide)`);
    continue;
  }
  statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;

  // la ligne doit porter la question, sinon l'enquête est orpheline
  if (!suggestions.has(row.suggestion_id)) {
    warn(`AC1 : investigation ${id} — suggestion absente (${row.suggestion_id})`);
  }
  if (doc.step_budget > STEP_BUDGET) {
    warn(`AC1 : investigation ${id} — budget ${doc.step_budget} > ${STEP_BUDGET}`);
  }
  if (doc.steps.length > STEP_BUDGET) {
    warn(`AC1 : investigation ${id} — ${doc.steps.length} étapes > ${STEP_BUDGET}`);
  }
  maxSteps = Math.max(maxSteps, doc.steps.length);
  cachedSteps += doc.steps_from_cache ?? 0;

  // 1 agent : un appel LLM au plus par étape, et jamais plus d'étapes que le budget
  if (doc.llm_calls > doc.steps.length) {
    warn(
      `AC1 : investigation ${id} — ${doc.llm_calls} appels pour ${doc.steps.length} étapes ` +
        `(un appel par étape : plusieurs appels pour une action = agent parallèle ou reprise non tracée)`
    );
  }
  if (typeof doc.chat_model !== "string" || doc.chat_model.length === 0) {
    warn(`AC1 : investigation ${id} — modèle de chat absent`);
  }
  if (typeof doc.prompt_version !== "string" || doc.prompt_version.length === 0) {
    warn(`AC1 : investigation ${id} — version de prompt absente`);
  }

  // indices de catalogue contigus et uniques : le modèle cite des indices, donc une
  // numérotation trouée rendrait une citation ambiguë
  const indices = doc.catalogue.map((e) => e.index);
  const expected = indices.map((_, i) => i);
  if (JSON.stringify(indices) !== JSON.stringify(expected)) {
    warn(`AC1 : investigation ${id} — indices de catalogue non contigus (${indices.join(",")})`);
  }

  // une enquête `done` doit porter une conclusion non échouée, et une enquête
  // terminale ne doit rien laisser en cours
  const last = doc.steps[doc.steps.length - 1];
  if (row.status === "done") {
    if (!last || last.action !== "conclude" || last.failed) {
      warn(`AC1/AC2 : investigation ${id} — statut done sans conclusion valide`);
    } else {
      terminalOk += 1;
    }
  }
  if (row.status === "failed" && !doc.failure) {
    warn(`AC1 : investigation ${id} — statut failed sans raison`);
  }
}

console.log(
  `  ${rows.length} enquête(s) · états ${JSON.stringify(statusCounts)} · maximum ${maxSteps} étape(s) · ` +
    `${cachedSteps} étape(s) servie(s) par le cache`
);
console.log(
  `  plafond de ${STEP_BUDGET} étapes respecté ${rows.every((r) => safeParse(r.steps).steps.length <= STEP_BUDGET) ? "✓" : "✗"} · ` +
    `1 appel par étape ${rows.every((r) => safeParse(r.steps).llm_calls <= safeParse(r.steps).steps.length) ? "✓" : "✗"}`
);

/* ---------------------------------- AC2 ---------------------------------- */

console.log("\nAC2 — citations vérifiées programmatiquement");
let citations = 0;
let verified = 0;
let rejected = 0;
let stepsFailed = 0;
let unverifiedEntries = 0;

for (const row of rows) {
  const id = row.id.slice(0, 8);
  const doc = safeParse(row.steps);
  const byId = new Map(doc.catalogue.map((e) => [e.fragment_id, e]));
  const live = new Map();
  for (const entry of doc.catalogue) {
    const fragment = fragments.get(entry.fragment_id);
    const problem = !fragment
      ? "fragment_absent"
      : fragment.source_id !== entry.source_id
        ? "source_modifiee"
        : fragment.text !== entry.text
          ? "texte_modifie"
          : null;
    live.set(entry.fragment_id, problem);
    if (problem) unverifiedEntries += 1;
  }

  for (const step of doc.steps) {
    if (!ACTIONS.has(step.action)) {
      warn(`AC3 : investigation ${id} — action inconnue « ${step.action} »`);
    }
    // une extension de l'agent ne doit pas pouvoir sortir du corpus sans que ce
    // script le signale : la seule action dont la charge est libre est la conclusion
    if (!TERMINAL.has(step.action) && typeof step.input?.query !== "string" && step.action === "search") {
      warn(`AC2 : investigation ${id} — étape ${step.index} sans requête`);
    }
    const cited = step.citations ?? [];
    for (const index of cited) {
      citations += 1;
      const entry = doc.catalogue.find((e) => e.index === index);
      if (!entry) {
        rejected += 1;
        if (!step.failed) {
          warn(
            `AC2 : investigation ${id} — étape ${step.index} cite [${index}] hors catalogue et n'est pas marquée failed`
          );
        }
        continue;
      }
      if (live.get(entry.fragment_id)) {
        rejected += 1;
        // AC2 : une citation invalide ⇒ l'étape est failed, jamais une preuve
        if (!step.failed) {
          warn(
            `AC2 : investigation ${id} — étape ${step.index} : citation [${index}] non vérifiable ` +
              `(${live.get(entry.fragment_id)}) alors que l'étape n'est pas marquée failed`
          );
        }
      } else {
        verified += 1;
      }
    }
    if (step.failed) stepsFailed += 1;
  }

  // la conclusion d'une enquête `done` doit être appuyée sur ≥ 1 citation vérifiée
  if (row.status === "done") {
    const conclusion = doc.steps[doc.steps.length - 1];
    const ok = (conclusion?.citations ?? []).filter((index) => {
      const entry = doc.catalogue.find((e) => e.index === index);
      return entry && !live.get(entry.fragment_id);
    });
    if (ok.length < 1) {
      warn(`AC2 : investigation ${id} — conclusion sans citation vérifiée`);
    }
  }

  // le job correspondant doit exister et ne pas contredire l'enquête
  const job = jobs.get(row.id);
  if (!job) {
    warn(`AC2 : investigation ${id} — aucun job investigation associé (id d'enquête = id de job)`);
  } else if (job.status === "done" && row.status === "running") {
    warn(`AC2 : investigation ${id} — job terminé mais enquête encore marquée running`);
  }

  // l'enquête doit citer ce que la suggestion portait (garde-fou minimal : la
  // suggestion existe toujours, la FK l'impose)
  if (byId.size < 2) {
    warn(`AC2 : investigation ${id} — catalogue à moins de 2 entrées (les graines manquent)`);
  }
}

console.log(
  `  ${citations} citation(s) · ${verified} vérifiée(s) · ${rejected} rejetée(s) · ` +
    `${stepsFailed} étape(s) failed · ${unverifiedEntries} entrée(s) de catalogue non vérifiable(s)`
);
console.log(
  `  toutes les citations vérifiées contre la base ${rejected === 0 ? "✓" : "✗"} · ` +
    `${terminalOk} conclusion(s) valide(s)`
);

/* ------------------------- Barrière de conclusion ------------------------ */

console.log(`\nConclusions — barrière appliquée (${CONCLUSION_RULE_VERSION})`);
let acceptedByBarrier = 0;
let refusedByBarrier = 0;
let refusedLegacy = 0;
let storedRuleVersion = 0;
const reasonCounts = {};

for (const row of rows) {
  const id = row.id.slice(0, 8);
  const doc = safeParse(row.steps);
  const suggestion = suggestions.get(row.suggestion_id);
  const claim = suggestion?.claim ?? "";
  const currentRule = doc.conclusion_rule_version === CONCLUSION_RULE_VERSION;
  if (doc.conclusion_rule_version) storedRuleVersion += 1;

  for (const step of doc.steps) {
    if (step.action !== "conclude" || !step.answer) continue;
    const verdict = judgeConclusion({ answer: step.answer, claim });
    const stored = step.failed ? `failed (${step.failure})` : "acceptée";
    if (verdict.ok) {
      acceptedByBarrier += 1;
    } else {
      refusedByBarrier += 1;
      reasonCounts[verdict.reason] = (reasonCounts[verdict.reason] ?? 0) + 1;
      if (!step.failed) refusedLegacy += 1;
    }
    console.log(
      `  ${id} étape ${step.index} — stockée « ${stored} », règle ${doc.conclusion_rule_version ?? "antérieure"} → ` +
        `aujourd'hui ${verdict.ok ? "acceptée" : `refusée (${verdict.reason})`}`
    );
    // sous la règle courante, l'accord entre ce qui est stocké et ce que la règle dit
    // est un critère : un document produit maintenant ne peut pas porter une conclusion
    // acceptée que la barrière refuse
    if (currentRule && !verdict.ok && !step.failed) {
      warn(
        `conclusion : investigation ${id} — étape ${step.index} stockée acceptée mais refusée ` +
          `par la barrière courante (${verdict.reason})`
      );
    }
  }
}

console.log(
  `  ${acceptedByBarrier} acceptée(s) · ${refusedByBarrier} refusée(s) ${JSON.stringify(reasonCounts)} · ` +
    `${storedRuleVersion}/${rows.length} document(s) portant une version de règle`
);
console.log(
  `  runs antérieurs à la barrière : ${refusedLegacy} conclusion(s) acceptée(s) à l'époque et refusée(s) ` +
    `aujourd'hui (mesure, pas échec : la règle qui les jugerait n'existait pas)`
);

/* ---------------------------------- AC3 ---------------------------------- */

console.log("\nAC3 — aucune vérification web");
console.log("  actions observées : " + JSON.stringify([...ACTIONS].join(", ")));
console.log(
  "  l'agent ne dispose que de deux outils, tous deux locaux (recherche lexicale sur le corpus, " +
    "voisinage d'embeddings en base) : aucune étape ne peut atteindre le réseau."
);

db.close();

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "\nPhase 4 : PASS — un agent borné à 5 étapes, citations vérifiées contre la base, " +
    "et aucune étape d'enquête jamais affichée comme preuve quand sa citation ne tient pas."
);
process.exit(0);

function safeParse(raw) {
  try {
    const doc = JSON.parse(raw);
    return {
      step_budget: doc.step_budget ?? 0,
      llm_calls: doc.llm_calls ?? 0,
      steps_from_cache: doc.steps_from_cache ?? 0,
      catalogue: Array.isArray(doc.catalogue) ? doc.catalogue : [],
      steps: Array.isArray(doc.steps) ? doc.steps : [],
      failure: doc.failure,
      chat_model: doc.chat_model,
      prompt_version: doc.prompt_version,
      // les versions de règle sont lues comme les autres champs : les oublier ici ferait
      // juger un document avec une règle qu'il n'a pas connue (constaté — le validateur
      // annonçait « règle antérieure » pour un document produit avec `conclusion-v2`)
      conclusion_rule_version: doc.conclusion_rule_version,
      juxtaposition_rule_version: doc.juxtaposition_rule_version,
    };
  } catch {
    return {
      step_budget: 0,
      llm_calls: 0,
      steps_from_cache: 0,
      catalogue: [],
      steps: [],
      failure: undefined,
      chat_model: undefined,
      prompt_version: undefined,
      conclusion_rule_version: undefined,
      juxtaposition_rule_version: undefined,
    };
  }
}
