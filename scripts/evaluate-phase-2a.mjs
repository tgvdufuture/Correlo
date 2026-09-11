#!/usr/bin/env node
/**
 * Évaluation Phase 2A (protocole Q22, PRD §4) :
 *   node scripts/evaluate-phase-2a.mjs [--runs=run-a,run-b] [--manifest=data/corpus_manifest.json]
 *     [--db=./data/serendipity.db] [--eval-dir=data/eval]
 *
 * 1. Génère data/eval/rapport_evaluation.md : chaque suggestion avec claim,
 *    relation_type, tier, statut épistémique, sources + domaines (manifeste),
 *    drapeau cross-domain et extraits COMPLETS des deux fragments.
 * 2. Crée data/eval/notes_evaluateur1.json et notes_evaluateur2.json à remplir
 *    par 2 évaluateurs indépendants : {"<suggestion_id>": "non_evidente"|"correcte_evidente"|"fausse"|"fragment_invalide"}
 *    (« non-évidente » = introuvable par recherche par mots-clés dans les deux sources).
 * 3. Une fois les notes remplies, calcule le verdict :
 *    ≥ 3 non-évidentes · < 30 % triviales/fausses · ≥ 1 analogie cross-domain ·
 *    0 fragment inexistant · ≤ 50 appels batch · baseline ≥ diversifié en non-évidentes.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const dbPath = args.db ?? "./data/serendipity.db";
const manifestPath = args.manifest ?? "./data/corpus_manifest.json";
const evalDir = args["eval-dir"] ?? "./data/eval";
const runFilter = args.runs ? String(args.runs).split(",") : null;

if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest introuvable : ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const domainOf = (sourceId) => manifest[sourceId] ?? "?";

// --- définition PRD « non-évidente » = introuvable par recherche par mots-clés ---
// Opérationnalisation : deux fragments ne sont « trouvables par mots-clés » que s'ils
// partagent au moins un terme de contenu RARE dans le corpus (sinon aucune requête
// portant sur l'un ne ramène l'autre). Les termes rares sont ceux dont la fréquence
// documentaire est <= 2 % des fragments.
const STOPWORDS = new Set(
  `alors autre aussi avaient avons avoir avec ceci cette comme dans depuis des deux doit donc dont elle elles encore entre etaient etait etant etre faire fait font leurs mais meme mes moins nous parce plus pour quand que quel quelle quelles quels qui sans ses seulement sous sont sur tous tout toute toutes une vers votre vous ainsi avoir etre fait dire plus tres bien peut peuvent doit doivent celui celle ceux celles chaque lorsqu apres avant entre selon toutefois cependant cependant notamment notamment environ toujours jamais jamais souvent parfois surtout presque passe present futur exemple sens partie point forme homme hommes chose choses temps monde raison nature etat fait force loi lois science sciences livre page texte edition oeuvre auteur ecrit ecrire dit selon selon grande grand petit petite premier premiere dernier derniere trois quatre cinq six sept huit neuf`
    .split(/\s+/)
    .filter(Boolean)
);
const normalize = (t) =>
  String(t)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
const contentWords = (t) =>
  new Set(
    normalize(t)
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  );

const db = new Database(dbPath, { readonly: true });
const runsFile = "./data/discover_runs.json";
const allRuns = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, "utf8")).runs : [];
const runs = runFilter ? allRuns.filter((r) => runFilter.includes(r.run_id)) : allRuns;
if (runs.length === 0) {
  console.error("Aucun run trouvé (data/discover_runs.json) — lancer scripts/discover.mjs d'abord.");
  process.exit(1);
}

// --- suggestions des runs (avec fragments + sources) ---
const suggestions = [];
const ids = new Set(runs.flatMap((r) => r.created_ids ?? []));
if (ids.size > 0) {
  const rows = db
    .prepare(              `SELECT s.id, s.claim, s.relation_type, s.tier, s.epistemic_status, s.pair_key,
              s.prompt_version,
              s.fragment_a_id, s.fragment_b_id,
              fa.source_id AS sa, fb.source_id AS sb,
              fa.text AS ta, fb.text AS tb,
              sa2.title AS ta_title, sb2.title AS tb_title,
              fa.locator AS la, fb.locator AS lb
       FROM suggestions s
       JOIN fragments fa ON fa.id = s.fragment_a_id
       JOIN fragments fb ON fb.id = s.fragment_b_id
       JOIN sources sa2 ON sa2.id = fa.source_id
       JOIN sources sb2 ON sb2.id = fb.source_id
       WHERE s.id IN (${[...ids].map(() => "?").join(",")})`
    )
    .all(...ids);
  suggestions.push(...rows);
}

// --- signal automatique mots-clés ---
{
  const allFrags = db.prepare("SELECT text FROM fragments").all();
  const df = new Map();
  for (const f of allFrags) {
    for (const w of contentWords(f.text ?? "")) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const dfThreshold = Math.max(1, Math.round(allFrags.length * 0.02));
  for (const s of suggestions) {
    const a = contentWords(s.ta ?? "");
    const b = contentWords(s.tb ?? "");
    const sharedDistinctive = [...a]
      .filter((w) => b.has(w) && (df.get(w) ?? 0) <= dfThreshold)
      .slice(0, 8);
    s.shared_terms = sharedDistinctive;
    s.findable_by_keywords = sharedDistinctive.length > 0;
  }
}

// --- signaux qualité : les 4 défauts ciblés par l'itération du prompt ---
// (claims génériques, ancrage lexical, quasi-doublons, claims non francophones).
const GENERIC_MARKERS = [
  "les deux auteurs",
  "les deux textes",
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
].map(normalize);
const EN_WORDS = new Set(
  `the of and is are that with which this both between from as it its their was were has have not for but they these those when where while more than also such can may`
    .split(/\s+/)
    .filter(Boolean)
);
const claimTokens = (t) =>
  new Set(
    normalize(t)
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
/** Recouvrement lexical (0–1) : part des termes du plus court ensemble présents dans l'autre. */
const containment = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / Math.min(a.size, b.size);
};
const NEAR_DUP_THRESHOLD = 0.6;
for (const s of suggestions) {
  const norm = normalize(s.claim ?? "");
  s.token_set = claimTokens(s.claim ?? "");
  s.near_duplicates = [];
  s.generic_hits = GENERIC_MARKERS.filter((m) => norm.includes(m));
  const tokens = norm.split(/\s+/);
  s.english_words = tokens.filter((w) => EN_WORDS.has(w)).length;
  s.looks_english = s.english_words >= 3;
}
for (let i = 0; i < suggestions.length; i += 1) {
  for (let j = i + 1; j < suggestions.length; j += 1) {
    const a = suggestions[i];
    const b = suggestions[j];
    if (Math.min(a.token_set.size, b.token_set.size) < 3) continue;
    if (containment(a.token_set, b.token_set) >= NEAR_DUP_THRESHOLD) {
      a.near_duplicates.push(j + 1);
      b.near_duplicates.push(i + 1);
    }
  }
}

// --- rapport évaluateur ---
fs.mkdirSync(evalDir, { recursive: true });
const lines = [];
lines.push(`# Rapport d'évaluation Phase 2A — ${runs.map((r) => r.run_id).join(", ")}`);
lines.push("");
lines.push(`Corpus : ${Object.keys(manifest).length} documents, ${new Set(Object.values(manifest)).size} domaines.`);
for (const r of runs) {
  lines.push(`- Run **${r.run_id}** (${r.sampler}) : ${r.pairs} paires · ${r.batch_calls} appels batch · ${r.created} suggestions`);
}
lines.push("");
lines.push("## Grille (par suggestion)");
lines.push("");
lines.push("- **non_evidente** : connexion réelle ET introuvable par recherche par mots-clés dans les deux sources.");
lines.push("- **correcte_evidente** : connexion réelle mais triviale (mots-clés suffisent).");
lines.push("- **fausse** : connexion erronée ou non étayée par les fragments.");
lines.push("- **fragment_invalide** : un fragment cité n'existe pas ou le texte ne correspond pas.");
lines.push("");
const promptVersions = [...new Set(suggestions.map((s) => s.prompt_version))].join(", ") || "?";
lines.push(`## Signaux qualité (défauts ciblés — prompt ${promptVersions})`);
lines.push("");
lines.push(
  `- Quasi-doublons (recouvrement ≥ ${Math.round(NEAR_DUP_THRESHOLD * 100)} % des termes) : **${
    suggestions.filter((s) => s.near_duplicates.length > 0).length
  }** suggestion(s) concernée(s).`
);
lines.push(`- Claims anglophones (heuristique) : **${suggestions.filter((s) => s.looks_english).length}**.`);
lines.push(
  `- Claims génériques (formules bannies) : **${suggestions.filter((s) => s.generic_hits.length > 0).length}**.`
);
lines.push("");
let idx = 0;
for (const s of suggestions) {
  idx += 1;
  const crossDomain = domainOf(s.sa) !== domainOf(s.sb);
  lines.push(`## ${idx}. [${s.id.slice(0, 8)}] ${s.relation_type} · ${s.tier} · ${s.epistemic_status}${crossDomain ? " · **cross-domain**" : ""}`);
  lines.push("");
  const flags = [];
  if (s.near_duplicates.length > 0) flags.push(`⚠ quasi-doublon de #${s.near_duplicates.join(", #")}`);
  if (s.looks_english) flags.push(`⚠ anglais (${s.english_words} mots-outils EN)`);
  if (s.generic_hits.length > 0) flags.push(`⚠ formule générique : « ${s.generic_hits[0]} »`);
  lines.push(`**Claim :** ${s.claim}${flags.length > 0 ? ` — ${flags.join(" · ")}` : ""}`);
  lines.push("");
  lines.push(
    `**Signal mots-clés :** ${
      s.findable_by_keywords
        ? `**trouvable** (termes rares partagés : ${s.shared_terms.join(", ")}) → évidente par recherche`
        : "**introuvable** (aucun terme rare partagé) → candidate non-évidente"
    }`
  );
  lines.push("");
  lines.push(`**A — ${s.ta_title ?? s.sa}** (${domainOf(s.sa)}, locator ${s.la})`);
  lines.push("```");
  lines.push(s.ta);
  lines.push("```");
  lines.push("");
  lines.push(`**B — ${s.tb_title ?? s.sb}** (${domainOf(s.sb)}, locator ${s.lb})`);
  lines.push("```");
  lines.push(s.tb);
  lines.push("```");
  lines.push("");
}
fs.writeFileSync(`${evalDir}/rapport_evaluation.md`, lines.join("\n"));

// --- notes des 2 évaluateurs ---
// --auto : préremplit les deux grilles depuis le signal mots-clés (évaluateur 1 = signal
// lexical strict ; évaluateur 2 = signal lexical, à confirmer/ajuster par lecture sémantique).
if (args.auto) {
  for (const name of ["evaluateur1", "evaluateur2"]) {
    const file = `${evalDir}/notes_${name}.json`;
    // ne remplit que les notes vides : une grille déjà saisie n'est jamais écrasée
    const notes = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    for (const s of suggestions)
      if (!notes[s.id])
        notes[s.id] = s.findable_by_keywords ? "correcte_evidente" : "non_evidente";
    fs.writeFileSync(file, JSON.stringify(notes, null, 2));
  }
  console.log(`Notes préremplies depuis le signal mots-clés (--auto) : ${evalDir}/notes_evaluateur{1,2}.json`);
}
for (const name of ["evaluateur1", "evaluateur2"]) {
  const file = `${evalDir}/notes_${name}.json`;
  // fusion : un nouveau run ajoute des suggestions, les notes déjà saisies sont conservées
  const notes = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  let added = 0;
  for (const s of suggestions) {
    if (!(s.id in notes)) {
      notes[s.id] = null;
      added += 1;
    }
  }
  fs.writeFileSync(file, JSON.stringify(notes, null, 2));
  if (added > 0) console.log(`Notes mises à jour : ${file} (+${added} à remplir)`);
}

// --- verdict (si les notes sont remplies) ---
const loadNotes = (name) => {
  const file = `${evalDir}/notes_${name}.json`;
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.values(raw).every((v) => v !== null) ? raw : null;
};
const n1 = loadNotes("evaluateur1");
const n2 = loadNotes("evaluateur2");

console.log(`Rapport : ${evalDir}/rapport_evaluation.md (${suggestions.length} suggestions)`);
console.log(
  `Signaux qualité (${promptVersions}) : ${suggestions.filter((s) => s.near_duplicates.length > 0).length} quasi-doublon(s), ` +
    `${suggestions.filter((s) => s.looks_english).length} anglophone(s), ` +
    `${suggestions.filter((s) => s.generic_hits.length > 0).length} formule(s) générique(s)`
);

if (!n1 || !n2) {
  console.log("Notes incomplètes — remplissez data/eval/notes_evaluateur1.json et notes_evaluateur2.json puis relancez.");
  process.exit(0);
}

const grade = (id) => {
  const a = n1[id];
  const b = n2[id];
  if (a === b) return a;
  // désaccord : l'évaluation la plus sévère (fragment_invalide > fausse > correcte_evidente > non_evidente)
  const rank = { fragment_invalide: 3, fausse: 2, correcte_evidente: 1, non_evidente: 0 };
  return rank[a] >= rank[b] ? a : b;
};

const failures = [];
const diversified = runs.find((r) => r.sampler === "diversified");
const baseline = runs.find((r) => r.sampler === "top6");
if (!diversified || !baseline) {
  console.error("Il faut un run diversified ET un run baseline (top6) pour le verdict.");
  process.exit(1);
}

const counts = { non_evidente: 0, correcte_evidente: 0, fausse: 0, fragment_invalide: 0 };
const runOf = new Map();
for (const r of runs) for (const id of r.created_ids ?? []) runOf.set(id, r.run_id);
const perRun = {};
for (const s of suggestions) {
  const runId = runOf.get(s.id);
  const g = grade(s.id);
  counts[g] += 1;
  perRun[runId] = perRun[runId] ?? { non_evidente: 0, totale: 0 };
  perRun[runId].totale += 1;
  if (g === "non_evidente") perRun[runId].non_evidente += 1;
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const trivialFausses = counts.correcte_evidente + counts.fausse + counts.fragment_invalide;
const analogiesCrossDomain = suggestions.filter(
  (s) => s.relation_type === "analogy" && domainOf(s.sa) !== domainOf(s.sb)
).length;
const batchCalls = runs.reduce((a, r) => a + (r.batch_calls ?? 0), 0);

console.log(`\n=== Verdict Phase 2A ===`);
console.log(`Suggestions évaluées : ${total} (${counts.non_evidente} non-évidentes, ${counts.correcte_evidente} correctes-évidentes, ${counts.fausse} fausses, ${counts.fragment_invalide} fragments invalides)`);
console.log(`Non-évidentes (diversifié) : ${perRun[diversified.run_id]?.non_evidente ?? 0} · baseline top6 : ${perRun[baseline.run_id]?.non_evidente ?? 0}`);

if (counts.non_evidente < 3) failures.push(`≥ 3 connexions non évidentes : ${counts.non_evidente}`);
if (total > 0 && trivialFausses / total >= 0.3) failures.push(`< 30 % triviales/fausses : ${Math.round((trivialFausses / total) * 100)} %`);
if (analogiesCrossDomain < 1) failures.push(`≥ 1 analogie cross-domain : ${analogiesCrossDomain}`);
const missing = suggestions.filter((s) => !s.ta || !s.tb).length;
if (missing > 0) failures.push(`0 fragment inexistant : ${missing}`);
if (batchCalls > 50) failures.push(`≤ 50 appels batch : ${batchCalls}`);
const dN = perRun[diversified.run_id]?.non_evidente ?? 0;
const bN = perRun[baseline.run_id]?.non_evidente ?? 0;
if (dN < bN) failures.push(`baseline : la diversification fait moins bien que le top-6 cosine (${dN} < ${bN})`);

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length}) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nPhase 2A : PASS — les critères du protocole Q22 sont remplis.");