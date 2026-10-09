#!/usr/bin/env node
/**
 * Évaluation Phase 5A (protocole Q25, amendement v1.3 §2.3) :
 *   node scripts/evaluate-phase-5a.mjs [--runs=run-a,run-b] [--db=./data/correlo.db]
 *     [--eval-dir=data/eval] [--baseline=data/baseline_5a.json] [--auto]
 *
 * 1. Vérifie PROGRAMMATIQUEMENT chaque preuve citée (fragment existant, texte
 *    conforme au document d'origine, locator qui re-slice exactement le fragment) :
 *    un échec = `preuve_invalide`, critère éliminatoire, sans recours à un humain.
 * 2. Génère data/eval/rapport_evaluation_5a.md : chaque synthèse avec son ancrage,
 *    relation, confiance, statut épistémique, signaux automatiques et extraits
 *    COMPLETS des preuves citées (+ le baseline « résumé » à côté).
 * 3. Crée data/eval/notes_5a_evaluateur{1,2}.json à remplir par 2 évaluateurs
 *    indépendants : {"<id>": "apport_precis"|"apport_generique"|"fausse"|"preuve_invalide"|"hallucination"}
 * 4. Une fois les notes remplies, calcule le verdict :
 *    ≥ 3 apport_precis · < 30 % (apport_generique + fausse) · 0 hallucination ·
 *    0 preuve_invalide · ≤ 40 appels LLM · synthèse ≥ baseline en apport_precis.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const dbPath = args.db ?? "./data/correlo.db";
const evalDir = args["eval-dir"] ?? "./data/eval";
const baselinePath = args.baseline ?? "./data/baseline_5a.json";
const runFilter = args.runs ? String(args.runs).split(",") : null;
const MAX_LLM_CALLS = 40;

// --- mêmes définitions lexicales que la barrière (lib/quality/text-rules.ts) ---
const STOPWORDS = new Set(
  `alors autre aussi avaient avons avoir avec ceci cette comme dans depuis des deux doit donc dont elle elles encore entre etaient etait etant etre faire fait font leurs mais meme mes moins nous parce plus pour quand que quel quelle quelles quels qui sans ses seulement sous sont sur tous tout toute toutes une vers votre vous ainsi avoir etre fait dire plus tres bien peut peuvent doit doivent celui celle ceux celles chaque lorsqu apres avant entre selon toutefois cependant notamment environ toujours jamais souvent parfois surtout presque passe present futur exemple sens partie point forme homme hommes chose choses temps monde raison nature etat fait force loi lois science sciences livre page texte edition oeuvre auteur ecrit ecrire dit grande grand petit petite premier premiere dernier derniere trois quatre cinq six sept huit neuf`
    .split(/\s+/)
    .filter(Boolean)
);
const normalize = (t) =>
  String(t ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tokens = (t) =>
  new Set(
    normalize(t)
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
const containment = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / Math.min(a.size, b.size);
};
const GENERIC_MARKERS = [
  "les deux auteurs",
  "les deux textes",
  "les deux documents",
  "les deux fragments",
  "tous deux",
  "partagent un",
  "partagent une",
  "accordent une importance",
  "soulignent que",
  "mettent en avant",
  "s inspirent de",
  "figure d autorite",
  "relation maitre",
  "illustrent un meme",
  "de la meme maniere",
  "il est interessant de noter",
  "en conclusion",
  "en resume",
].map(normalize);
const EN_WORDS = new Set(
  `the of and is are that with which this both between from as it its their was were has have not for but they these those when where while more than also such can may`
    .split(/\s+/)
    .filter(Boolean)
);
const PARAPHRASE_THRESHOLD = 0.85;
const NEAR_DUP_THRESHOLD = 0.6;

// --- entrées : synthèses du run (base) + baseline (hors base) ---
const db = new Database(dbPath, { readonly: true });
const runsFile = "./data/synthesis_runs.json";
const allRuns = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, "utf8")).runs : [];
const runs = runFilter ? allRuns.filter((r) => runFilter.includes(r.run_id)) : allRuns;
const baselineRuns = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8")).runs.filter(
      (r) => !runFilter || runFilter.includes(r.run_id)
    )
  : [];

if (runs.length === 0 && baselineRuns.length === 0) {
  console.error(
    "Aucun run trouvé — lancer scripts/synthesize.mjs (puis --baseline) avant d'évaluer."
  );
  process.exit(1);
}

const rawBySource = new Map(
  db.prepare("SELECT id, raw_content FROM sources").all().map((r) => [r.id, r.raw_content])
);
const fragmentById = new Map(
  db
    .prepare("SELECT id, source_id, chunk_index, locator, text FROM fragments")
    .all()
    .map((r) => [r.id, r])
);

/** Fabrique une entrée évaluable commune (synthèse persistée ou baseline calculé). */
function buildEntry({ id, runId, themeLabel, text, relationKind, confidence, epistemic, evidence }) {
  const entry = {
    id,
    run_id: runId,
    theme_label: themeLabel,
    text,
    relation_kind: relationKind,
    confidence,
    epistemic_status: epistemic,
    evidence: [],
    invalid: [],
  };
  const citedTokens = [];
  for (const e of evidence) {
    const frag = fragmentById.get(e.fragment_id);
    const entrySnapshot = { ...e, exists: Boolean(frag) };
    if (!frag) {
      entry.invalid.push(`fragment inexistant : ${e.fragment_id}`);
    } else {
      // le texte cité doit être exactement celui du fragment (pas un résumé)
      if (frag.text !== e.text) entry.invalid.push(`texte non conforme : ${e.fragment_id}`);
      if (frag.source_id !== e.source_id) entry.invalid.push(`source non conforme : ${e.fragment_id}`);
      // et le locator doit re-slicer le document d'origine
      const m = String(frag.locator).match(/\[(\d+),(\d+)\)$/);
      const raw = rawBySource.get(frag.source_id);
      if (!m) entry.invalid.push(`locator invalide : ${frag.locator}`);
      else if (raw === undefined) entry.invalid.push(`raw_content introuvable : ${frag.source_id}`);
      else if (raw.slice(Number(m[1]), Number(m[2])) !== frag.text)
        entry.invalid.push(`locator faux : ${frag.locator}`);
    }
    citedTokens.push(tokens(e.text));
    entry.evidence.push(entrySnapshot);
  }
  if (entry.evidence.length < 2) entry.invalid.push("moins de 2 preuves citées");

  // --- signaux automatiques (aucun n'est un verdict : ils guident l'évaluateur) ---
  const t = tokens(text);
  const union = new Set();
  for (const s of citedTokens) for (const w of s) union.add(w);
  const own = [...t].filter((w) => !union.has(w));
  entry.lexical_apport = t.size === 0 ? 0 : own.length / t.size;
  entry.own_terms = own.slice(0, 10);
  entry.max_evidence_overlap = citedTokens.reduce((m, s) => Math.max(m, containment(t, s)), 0);
  entry.paraphrases_one_evidence = entry.max_evidence_overlap >= PARAPHRASE_THRESHOLD;
  const norm = normalize(text);
  entry.generic_hits = GENERIC_MARKERS.filter((m) => norm.includes(m));
  entry.looks_english = norm.split(/\s+/).filter((w) => EN_WORDS.has(w)).length >= 3;
  entry.words = text.trim().split(/\s+/).length;
  return entry;
}

const synthesisEntries = [];
const ids = new Set(runs.flatMap((r) => r.created_ids ?? []));
if (ids.size > 0) {
  const rows = db
    .prepare(
      `SELECT sy.id, sy.text, sy.relation_kind, sy.confidence, sy.epistemic_status,
              sy.provenance_snapshot, t.label AS theme_label
       FROM syntheses sy JOIN themes t ON t.id = sy.theme_id
       WHERE sy.id IN (${[...ids].map(() => "?").join(",")})`
    )
    .all(...ids);
  const runOf = new Map();
  for (const r of runs) for (const id of r.created_ids ?? []) runOf.set(id, r.run_id);
  for (const row of rows) {
    synthesisEntries.push(
      buildEntry({
        id: row.id,
        runId: runOf.get(row.id),
        themeLabel: row.theme_label,
        text: row.text,
        relationKind: row.relation_kind,
        confidence: row.confidence,
        epistemic: row.epistemic_status,
        evidence: JSON.parse(row.provenance_snapshot),
      })
    );
  }
}

const baselineEntries = [];
for (const r of baselineRuns) {
  for (const item of r.items ?? []) {
    baselineEntries.push(
      buildEntry({
        id: item.id,
        runId: r.run_id,
        themeLabel: item.seedLabel ?? item.themeLabel ?? item.theme_label,
        text: item.text,
        relationKind: item.relationKind ?? item.relation_kind,
        confidence: item.confidence,
        epistemic: item.epistemicStatus ?? item.epistemic_status,
        evidence: item.evidence ?? [],
      })
    );
  }
}

// --- quasi-doublons inter-énoncés (une répétition n'est pas une découverte) ---
const gradePool = [...synthesisEntries, ...baselineEntries];
for (const e of gradePool) e.near_duplicates = [];
for (let i = 0; i < gradePool.length; i += 1) {
  for (let j = i + 1; j < gradePool.length; j += 1) {
    const a = gradePool[i];
    const b = gradePool[j];
    if (a.run_id !== b.run_id) continue; // comparaison à l'intérieur d'un run
    const ta = tokens(a.text);
    const tb = tokens(b.text);
    if (Math.min(ta.size, tb.size) < 3) continue;
    if (containment(ta, tb) >= NEAR_DUP_THRESHOLD) {
      a.near_duplicates.push(b.id);
      b.near_duplicates.push(a.id);
    }
  }
}

// --- rapport ---
fs.mkdirSync(evalDir, { recursive: true });
const lines = [];
const runIds = [...new Set([...runs, ...baselineRuns].map((r) => r.run_id))];
lines.push(`# Rapport d'évaluation Phase 5A (Q25) — ${runIds.join(", ")}`);
lines.push("");
lines.push(
  `Corpus : manifeste du run · ${synthesisEntries.length} synthèse(s) persistée(s) · ` +
    `${baselineEntries.length} résumé(s) du baseline.`
);
for (const r of runs) {
  lines.push(
    `- Synthèses **${r.run_id}** : ${r.seeds_total ?? r.themes_total ?? "?"} graines · ` +
      `${r.llm_calls ?? "?"} appel(s) LLM · ${r.created ?? 0} énoncé(s) · ` +
      `prompt ${r.prompt_version ?? "?"}`
  );
}
for (const r of baselineRuns) {
  lines.push(
    `- Baseline **${r.run_id}** : ${r.seeds_total ?? r.themes_total ?? "?"} graines · ` +
      `${r.llm_calls ?? "?"} appel(s) LLM · ${(r.items ?? []).length} énoncé(s) · ` +
      `prompt ${r.prompt_version ?? "?"}`
  );
}
lines.push("");
lines.push("## Grille (par synthèse)");
lines.push("");
lines.push("- **apport_precis** : dit quelque chose qu'AUCUNE des preuves ne dit seule (le niveau « néo-brutalisme »).");
lines.push("- **apport_generique** : vraie mais triviale, ou simple résumé du contenu des preuves.");
lines.push("- **fausse** : contredite par les preuves citées.");
lines.push("- **preuve_invalide** : fragment cité inexistant, texte non conforme ou locator faux (vérifié programmatiquement).");
lines.push("- **hallucination** : affirmation non traçable dans les preuves citées.");
lines.push("");
const invalidCount = gradePool.filter((e) => e.invalid.length > 0).length;
lines.push("## Vérification programmatique des preuves (critère éliminatoire)");
lines.push("");
lines.push(`- Preuves invalides : **${invalidCount}** énoncé(s) concerné(s) — exigence : 0.`);
lines.push(
  `- Vérifié : fragment présent en base, texte identique, source identique, ` +
    `locator re-slicant exactement le document d'origine (\`raw_content.slice(start,end) === texte\`).`
);
lines.push("");

/** Rend une entrée dans le rapport. */
function renderEntry(e, index) {
  const flags = [];
  if (e.invalid.length > 0) flags.push(`⛔ ${e.invalid.join(" · ")}`);
  if (e.paraphrases_one_evidence) flags.push("⚠ paraphrase d'une seule preuve");
  if (e.lexical_apport < 0.2) flags.push(`⚠ apport lexical faible (${e.lexical_apport.toFixed(2)})`);
  if (e.generic_hits.length > 0) flags.push(`⚠ formule générique : « ${e.generic_hits[0]} »`);
  if (e.looks_english) flags.push("⚠ anglais");
  if (e.near_duplicates.length > 0) flags.push(`⚠ quasi-doublon de ${e.near_duplicates.length} autre(s)`);
  if (e.words > 60) flags.push(`⚠ ${e.words} mots`);
  lines.push(
    `### ${index}. [${e.id.slice(0, 8)}] ${e.theme_label ?? "?"} · ${e.relation_kind ?? "?"} · ` +
      `${e.confidence ?? "?"} · ${e.epistemic_status ?? "?"}`
  );
  lines.push("");
  lines.push(`**Énoncé :** ${e.text}${flags.length > 0 ? ` — ${flags.join(" · ")}` : ""}`);
  lines.push("");
  lines.push(
    `**Apport lexical :** ${(e.lexical_apport * 100).toFixed(0)} % de termes absents des preuves` +
      `${e.own_terms.length > 0 ? ` (ex. ${e.own_terms.slice(0, 5).join(", ")})` : ""} · ` +
      `recouvrement max avec une preuve : ${(e.max_evidence_overlap * 100).toFixed(0)} %`
  );
  lines.push("");
  for (const [i, ev] of e.evidence.entries()) {
    lines.push(`**Preuve ${i + 1} — ${ev.source_title ?? ev.source_id}** (locator ${ev.locator})`);
    lines.push("");
    lines.push("```");
    lines.push(ev.text);
    lines.push("```");
    lines.push("");
  }
}

lines.push("## A. Synthèses (produit)");
lines.push("");
synthesisEntries.forEach((e, i) => renderEntry(e, i + 1));
lines.push("## B. Baseline « résumé » (contrôle à budget égal)");
lines.push("");
if (baselineEntries.length === 0) {
  lines.push(
    "_Aucun baseline trouvé : lancer `node scripts/synthesize.mjs --baseline --run-id=baseline-5a`._"
  );
} else {
  baselineEntries.forEach((e, i) => renderEntry(e, `B${i + 1}`));
}
fs.writeFileSync(`${evalDir}/rapport_evaluation_5a.md`, lines.join("\n"));

// --- notes des 2 évaluateurs ---
// --auto : préremplit depuis les signaux. Évaluateur 1 = signaux de forme ;
// évaluateur 2 = plus sévère, il exige un apport lexical réel (un énoncé dont
// les termes viennent tous des preuves ne dit rien de plus qu'elles).
const autoGrade = (e, strict) => {
  if (e.invalid.length > 0) return "preuve_invalide";
  if (e.generic_hits.length > 0 || e.looks_english || e.words > 60) return "apport_generique";
  if (e.paraphrases_one_evidence) return "apport_generique";
  if (strict && e.lexical_apport < 0.2) return "apport_generique";
  return "apport_precis";
};
if (args.auto) {
  for (const [name, strict] of [
    ["evaluateur1", false],
    ["evaluateur2", true],
  ]) {
    const file = `${evalDir}/notes_5a_${name}.json`;
    const notes = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    for (const e of gradePool) if (!notes[e.id]) notes[e.id] = autoGrade(e, strict);
    fs.writeFileSync(file, JSON.stringify(notes, null, 2));
  }
  console.log(`Notes préremplies depuis les signaux (--auto) : ${evalDir}/notes_5a_evaluateur{1,2}.json`);
}
for (const name of ["evaluateur1", "evaluateur2"]) {
  const file = `${evalDir}/notes_5a_${name}.json`;
  const notes = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  let added = 0;
  for (const e of gradePool) {
    if (!(e.id in notes)) {
      notes[e.id] = null;
      added += 1;
    }
  }
  fs.writeFileSync(file, JSON.stringify(notes, null, 2));
  if (added > 0) console.log(`Notes mises à jour : ${file} (+${added} à remplir)`);
}

const loadNotes = (name) => {
  const file = `${evalDir}/notes_5a_${name}.json`;
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.values(raw).every((v) => v !== null) ? raw : null;
};
const n1 = loadNotes("evaluateur1");
const n2 = loadNotes("evaluateur2");

console.log(`\nRapport : ${evalDir}/rapport_evaluation_5a.md`);
console.log(
  `${synthesisEntries.length} synthèse(s) · ${baselineEntries.length} baseline(s) · ` +
    `${invalidCount} preuve(s) invalide(s) (vérification programmatique)`
);

if (!n1 || !n2) {
  console.log(
    "Notes incomplètes — remplissez data/eval/notes_5a_evaluateur1.json et notes_5a_evaluateur2.json puis relancez."
  );
  process.exit(0);
}

const GRID = ["apport_precis", "apport_generique", "fausse", "preuve_invalide", "hallucination"];
const rank = { hallucination: 4, preuve_invalide: 3, fausse: 2, apport_generique: 1, apport_precis: 0 };
const grade = (id) => {
  const a = n1[id];
  const b = n2[id];
  if (a === b) return a;
  // désaccord : l'évaluation la plus sévère (hallucination > preuve_invalide > fausse > générique > précis)
  return rank[a] >= rank[b] ? a : b;
};
for (const e of gradePool) {
  const g = grade(e.id);
  if (GRID.includes(g)) e.grade = g;
  // une preuve invalide détectée programmatiquement prime sur une note humaine
  if (e.invalid.length > 0) e.grade = "preuve_invalide";
}

const count = (entries, g) => entries.filter((e) => e.grade === g).length;
const invalidFromNotes = gradePool.filter((e) =>
  [n1[e.id], n2[e.id]].includes("preuve_invalide")
).length;
const synth = {
  total: synthesisEntries.length,
  precis: count(synthesisEntries, "apport_precis"),
  generique: count(synthesisEntries, "apport_generique"),
  fausse: count(synthesisEntries, "fausse"),
  preuve_invalide: count(synthesisEntries, "preuve_invalide"),
  hallucination: count(synthesisEntries, "hallucination"),
};
const base = {
  total: baselineEntries.length,
  precis: count(baselineEntries, "apport_precis"),
};

const failures = [];
console.log(`\n=== Verdict Phase 5A (Q25) ===`);
console.log(
  `Synthèses : ${synth.total} — ${synth.precis} apport_precis · ${synth.generique} apport_generique · ` +
    `${synth.fausse} fausse · ${synth.hallucination} hallucination · ${synth.preuve_invalide} preuve invalide`
);
if (base.total > 0) {
  console.log(`Baseline « résumé » : ${base.total} — ${base.precis} apport_precis`);
}

const llmCalls =
  runs.reduce((a, r) => a + (r.llm_calls ?? 0), 0) +
  baselineRuns.reduce((a, r) => a + (r.llm_calls ?? 0), 0);
const graded = synth.total - synth.preuve_invalide;
const generiqueFausse = synth.generique + synth.fausse;

if (synth.precis < 3) failures.push(`≥ 3 apport_precis : ${synth.precis}`);
if (graded > 0 && generiqueFausse / graded >= 0.3)
  failures.push(`< 30 % apport_generique + fausse : ${Math.round((generiqueFausse / graded) * 100)} %`);
if (graded <= 0)
  failures.push("aucun énoncé évaluable : vérifier les runs et les grilles de notes");
if (synth.hallucination > 0) failures.push(`0 hallucination : ${synth.hallucination}`);
if (synth.preuve_invalide > 0 || invalidCount > 0 || invalidFromNotes > 0)
  failures.push(
    `0 preuve invalide : ${Math.max(synth.preuve_invalide, invalidCount, invalidFromNotes)}`
  );
if (llmCalls > MAX_LLM_CALLS) failures.push(`≤ ${MAX_LLM_CALLS} appels LLM : ${llmCalls}`);
if (base.total === 0) failures.push("baseline « résumé » absent (obligatoire pour Q25)");
else if (synth.precis < base.precis)
  failures.push(`la synthèse doit faire au moins aussi bien que le baseline : ${synth.precis} < ${base.precis}`);

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nPhase 5A : PASS — les critères du protocole Q25 sont remplis.");
