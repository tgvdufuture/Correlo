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
 *
 * La mesure appliquée est `measure-2a-v2` (voir scripts/lib/measure-2a.mjs) :
 *  - évidence élargie à l'ancre lexicale du claim (mot-clé fabriqué par le modèle) ;
 *  - crédit de découverte plafonné à un par couple de sources et par run.
 * L'évaluateur imprime toujours la valeur brute à côté de la valeur pénalisée.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import { CLAIM_TEXT_PROFILE, rejectText } from "../lib/quality/text-rules.ts";
import { isJuxtapositionClaim } from "../lib/quality/juxtaposition.ts";
import {
  MEASURE_VERSION,
  normalizeText as normalize,
  contentWords,
  documentFrequency,
  rareThreshold,
  judgeSuggestion,
  sourcePairKey,
  discoveryCredits,
} from "./lib/measure-2a.mjs";

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

const db = new Database(dbPath, { readonly: true });
// Les runs vivent désormais en base (`discover_runs`, migration 005 — Phase 2B) :
// l'identité d'un run est une entité persistante, plus un fichier à côté de la DB.
const hasRunTable = !!db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discover_runs'")
  .get();
if (!hasRunTable) {
  console.error("Table discover_runs absente — migration 005 non appliquée sur cette base.");
  process.exit(1);
}
// Une comparaison Q22 se fait **à budget égal**, entre l'échantillonneur diversifié et
// la baseline top-6 : c'est le couple le plus récent de runs terminés partageant le
// même nombre de paires. Prendre « le dernier run de chaque échantillonneur » serait
// faux dès qu'un run isolé (autre budget, autre corpus — un run de validation 2B, par
// exemple) termine après la paire de comparaison : il entrerait dans le verdict.
// `--runs=` impose une paire explicite (statut quelconque, pour inspecter un échec).
const doneRuns = runFilter
  ? []
  : db
      .prepare("SELECT * FROM discover_runs WHERE status = 'done' ORDER BY completed_at DESC, rowid DESC")
      .all();
let comparisonPair = [];
if (!runFilter) {
  for (const r of doneRuns) {
    const mate = doneRuns.find((o) => o.sampler !== r.sampler && o.pairs === r.pairs);
    if (mate) {
      comparisonPair = [r, mate].sort((a) => (a.sampler === "diversified" ? -1 : 1));
      break;
    }
  }
}
const runRows = runFilter
  ? db
      .prepare(`SELECT * FROM discover_runs WHERE run_id IN (${runFilter.map(() => "?").join(",")})`)
      .all(...runFilter)
  : comparisonPair;
const allRuns = runRows.map((r) => ({
  run_id: r.run_id,
  sampler: r.sampler,
  sampler_version: r.sampler_version,
  corpus_hash: r.corpus_hash,
  seed: r.seed,
  prompt_version: r.prompt_version,
  chat_model: r.chat_model,
  status: r.status,
  pairs: r.pairs,
  batch_calls: r.batch_calls,
  batch_calls_from_cache: r.batch_calls_from_cache,
  created: r.created,
  created_ids: JSON.parse(r.created_ids),
  skipped: JSON.parse(r.skipped),
}));
const runs = allRuns;
if (runs.length === 0) {
  console.error("Aucun run dans discover_runs — lancer scripts/discover.mjs d'abord.");
  process.exit(1);
}
console.log(
  `Runs évalués : ${runs.map((r) => `${r.run_id} (${r.sampler}, ${r.pairs} paires, ${r.created} suggestions)`).join(" · ")}`
);
if (runs.length === 2 && runs[0].pairs !== runs[1].pairs) {
  console.warn(
    `⚠ budgets différents (${runs.map((r) => r.pairs).join(" vs ")} paires) : le comparatif ` +
      `Q22 se fait à budget égal — vérifier la sélection (--runs=…).`
  );
}
if (runs.length === 2 && new Set(runs.map((r) => r.sampler)).size < 2) {
  console.warn("⚠ sélection sans baseline : il faut un run diversified ET un run top6.");
}

// --- suggestions des runs (avec fragments + sources), dans l'ordre des runs ---
const ids = new Set(runs.flatMap((r) => r.created_ids ?? []));
const rank = new Map();
runs.forEach((r, runIndex) =>
  (r.created_ids ?? []).forEach((id, i) => rank.set(id, [runIndex, i]))
);
const suggestions = [];
if (ids.size > 0) {
  const rows = db
    .prepare(
      `SELECT s.id, s.claim, s.relation_type, s.tier, s.epistemic_status, s.pair_key,
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
  rows.sort((a, b) => {
    const ra = rank.get(a.id) ?? [0, 0];
    const rb = rank.get(b.id) ?? [0, 0];
    return ra[0] - rb[0] || ra[1] - rb[1];
  });
  suggestions.push(...rows);
}

const runOf = new Map();
for (const r of runs) for (const id of r.created_ids ?? []) runOf.set(id, r.run_id);

// --- mesure v2 : rareté corpus + ancre lexicale du claim ---
{
  const allFrags = db.prepare("SELECT text FROM fragments").all();
  const df = documentFrequency(allFrags.map((f) => f.text ?? ""));
  const threshold = rareThreshold(allFrags.length);
  const ctx = { df, threshold };
  for (const s of suggestions) {
    const verdict = judgeSuggestion({ claim: s.claim ?? "", textA: s.ta ?? "", textB: s.tb ?? "" }, ctx);
    s.shared_terms = verdict.sharedRareTerms;
    s.claim_anchors = verdict.claimAnchors;
    s.findable_by_keywords = s.shared_terms.length > 0; // signal v1 (fragments)
    s.anchored_by_claim = s.claim_anchors.length > 0; // signal v2 (mot-clé fabriqué)
    s.evident = verdict.grade === "correcte_evidente";
    s.grade_auto = verdict.grade;
    s.source_pair = sourcePairKey(s.sa, s.sb);
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
const claimTokens = (t) => new Set(contentWords(t));
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
  // + les formules propres au profil de claim : sinon le rapport annoncerait « 0
  // formule générique » tout en comptant un rejet `generic` dans la barrière.
  s.generic_hits = [...GENERIC_MARKERS, ...(CLAIM_TEXT_PROFILE.extraGenericMarkers ?? [])].filter(
    (m) => norm.includes(m)
  );
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

// --- pénalité de redondance : un crédit de découverte par couple de sources et par run ---
{
  const credits = discoveryCredits(
    suggestions.map((s) => ({
      runId: runOf.get(s.id) ?? "?",
      pairKey: s.source_pair,
      nonEvidente: !s.evident,
    }))
  );
  const firstOf = new Map();
  suggestions.forEach((s, i) => {
    const key = `${runOf.get(s.id) ?? "?"}::${s.source_pair}`;
    if (!s.evident && credits[i] && !firstOf.has(key)) firstOf.set(key, i + 1);
  });
  suggestions.forEach((s, i) => {
    const key = `${runOf.get(s.id) ?? "?"}::${s.source_pair}`;
    s.discovery_credit = credits[i];
    s.redundant_of = !s.evident && !credits[i] ? (firstOf.get(key) ?? null) : null;
  });
}

// --- barrière de qualité (état courant) : règle **serveur**, la même que
// `lib/discover/claim-rules.ts`. Le verdict porte sur ce que la barrière laisse
// passer : c'est ce qu'un rejeu insérerait, et la barrière ne cesse de se durcir.
// Les modules de règles sont purs et importés en relatif (pas d'alias `@/` hors Next).
{
  for (const s of suggestions) {
    s.barrier =
      rejectText(s.claim ?? "", CLAIM_TEXT_PROFILE) ??
      (isJuxtapositionClaim(s.claim ?? "") ? "juxtaposition" : null);
  }
}
const retained = suggestions.filter((s) => s.barrier === null);
const barrierRejections = suggestions.length - retained.length;
const barrierByReason = {};
for (const s of suggestions) {
  if (s.barrier) barrierByReason[s.barrier] = (barrierByReason[s.barrier] ?? 0) + 1;
}

// --- rapport évaluateur ---
fs.mkdirSync(evalDir, { recursive: true });
const lines = [];
lines.push(`# Rapport d'évaluation Phase 2A — ${runs.map((r) => r.run_id).join(", ")}`);
lines.push("");
lines.push(`Mesure **${MEASURE_VERSION}** (ancrage lexical élargi + crédit plafonné par couple de sources).`);
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
lines.push("## Mesure v2 — synthèse");
lines.push("");
lines.push("| run | stockées | **retenues** | non-évidentes (brut) | découvertes distinctes |");
lines.push("|---|---|---|---|---|");
for (const r of runs) {
  const of = suggestions.filter((s) => runOf.get(s.id) === r.run_id);
  const kept = of.filter((s) => s.barrier === null);
  const ne = kept.filter((s) => !s.evident);
  const distinct = new Set(ne.map((s) => s.source_pair)).size;
  lines.push(
    `| ${r.run_id} | ${of.length} | **${kept.length}** | ${ne.length} | **${distinct}** |`
  );
}
lines.push("");
lines.push("## Barrière de qualité (état courant) — règle serveur");
lines.push("");
lines.push(
  "Le **verdict porte sur les suggestions retenues** : les règles déterministes de **forme et de structure** (marqueurs génériques, repères de prompt, juxtaposition) sont réappliquées ici — c'est ce qu'un rejeu stockerait sous la règle courante. Les règles déjà actives pendant le run (ancrage lexical compris) ne sont pas rejouées : leurs rejets ont un ID de run, ils sont dans les `skipped` du run et non dans cette table. Les rejets restent visibles dans les grilles détaillées."
);
lines.push("");
for (const r of runs) {
  const of = suggestions.filter((s) => runOf.get(s.id) === r.run_id);
  const reasons = {};
  for (const s of of) if (s.barrier) reasons[s.barrier] = (reasons[s.barrier] ?? 0) + 1;
  const rejected = of.length - of.filter((s) => s.barrier === null).length;
  lines.push(
    `- **${r.run_id}** : ${rejected} rejet(s) sur ${of.length} — ${Object.entries(reasons).map(([k, v]) => `${k}: ${v}`).join(" · ") || "aucun"}`
  );
}
lines.push("");
lines.push(
  `Écarts par ancrage lexical (v2 vs v1) : **${suggestions.filter((s) => s.anchored_by_claim && !s.findable_by_keywords).length}** suggestion(s) rendue(s) évidente(s) par le mot-clé fabriqué dans le claim.`
);
lines.push(
  `Redondances (couple déjà crédité dans le même run) : **${suggestions.filter((s) => s.redundant_of !== null).length}**.`
);
const promptVersions = [...new Set(suggestions.map((s) => s.prompt_version))].join(", ") || "?";
lines.push("");
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
  if (s.barrier) flags.push(`⛔ **rejetée par la barrière** (${s.barrier}) — exclue du verdict`);
  if (s.near_duplicates.length > 0) flags.push(`⚠ quasi-doublon de #${s.near_duplicates.join(", #")}`);
  if (s.looks_english) flags.push(`⚠ anglais (${s.english_words} mots-outils EN)`);
  if (s.generic_hits.length > 0) flags.push(`⚠ formule générique : « ${s.generic_hits[0]} »`);
  if (s.redundant_of !== null) flags.push(`⚠ redondant — couple de sources déjà crédité par #${s.redundant_of}`);
  lines.push(`**Claim :** ${s.claim}${flags.length > 0 ? ` — ${flags.join(" · ")}` : ""}`);
  lines.push("");
  lines.push(
    `**Signal mots-clés :** ${
      s.findable_by_keywords
        ? `**trouvable** (termes rares partagés : ${s.shared_terms.join(", ")}) → évidente par recherche`
        : s.anchored_by_claim
          ? `**trouvable** (ancre lexicale du claim : ${s.claim_anchors.join(", ")}) → évidente, le claim nomme le mot-clé`
          : "**introuvable** (aucun terme rare partagé) → candidate non-évidente"
    }`
  );
  lines.push("");
  if (s.discovery_credit) lines.push("**Crédit de découverte :** ✓ compte comme connexion distincte du couple.");
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
// --auto : préremplit les grilles VIDES depuis la mesure v2 (évidence par mots-clés,
// ancre lexicale du claim incluse). Une note déjà saisie par un humain n'est jamais
// écrasée : pour re-juger, archiver puis supprimer les fichiers de notes.
if (args.auto) {
  for (const name of ["evaluateur1", "evaluateur2"]) {
    const file = `${evalDir}/notes_${name}.json`;
    const notes = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    for (const s of suggestions) if (!notes[s.id]) notes[s.id] = s.grade_auto;
    fs.writeFileSync(file, JSON.stringify(notes, null, 2));
  }
  console.log(`Notes préremplies depuis la mesure ${MEASURE_VERSION} (--auto) : ${evalDir}/notes_evaluateur{1,2}.json`);
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
  const rank2 = { fragment_invalide: 3, fausse: 2, correcte_evidente: 1, non_evidente: 0 };
  return rank2[a] >= rank2[b] ? a : b;
};

const failures = [];
const diversified = runs.find((r) => r.sampler === "diversified");
const baseline = runs.find((r) => r.sampler === "top6");
if (!diversified || !baseline) {
  console.error("Il faut un run diversified ET un run baseline (top6) pour le verdict.");
  process.exit(1);
}

const counts = { non_evidente: 0, correcte_evidente: 0, fausse: 0, fragment_invalide: 0 };
const perRun = {};
for (const s of retained) {
  const runId = runOf.get(s.id);
  const g = grade(s.id);
  counts[g] += 1;
  perRun[runId] = perRun[runId] ?? { non_evidente: 0, totale: 0, pairs: new Set() };
  perRun[runId].totale += 1;
  if (g === "non_evidente") {
    perRun[runId].non_evidente += 1;
    perRun[runId].pairs.add(s.source_pair);
  }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const trivialFausses = counts.correcte_evidente + counts.fausse + counts.fragment_invalide;
const analogiesCrossDomain = retained.filter(
  (s) => s.relation_type === "analogy" && domainOf(s.sa) !== domainOf(s.sb)
).length;
const batchCalls = runs.reduce((a, r) => a + (r.batch_calls ?? 0), 0);
// découvertes = couples de sources distincts portant au moins une non-évidente (mesure v2)
const distinctPairs = new Set(
  retained.filter((s) => grade(s.id) === "non_evidente").map((s) => s.source_pair)
);
const dRaw = perRun[diversified.run_id]?.non_evidente ?? 0;
const bRaw = perRun[baseline.run_id]?.non_evidente ?? 0;
const dDistinct = perRun[diversified.run_id]?.pairs.size ?? 0;
const bDistinct = perRun[baseline.run_id]?.pairs.size ?? 0;

console.log(`\n=== Verdict Phase 2A (mesure ${MEASURE_VERSION}) ===`);
console.log(
  `Suggestions évaluées : ${total} retenues sur ${suggestions.length} stockées (barrière : ${barrierRejections} rejet(s) — ${Object.entries(barrierByReason).map(([k, v]) => `${k} ${v}`).join(", ") || "aucun"})`
);
console.log(
  `Grille : ${counts.non_evidente} non-évidentes, ${counts.correcte_evidente} correctes-évidentes, ${counts.fausse} fausses, ${counts.fragment_invalide} fragments invalides`
);
console.log(
  `Non-évidentes BRUTES    — diversifié ${dRaw} · baseline ${bRaw} · global ${counts.non_evidente}`
);
console.log(
  `Découvertes DISTINCTES  — diversifié ${dDistinct} · baseline ${bDistinct} · global ${distinctPairs.size} (couples de sources, crédit plafonné)`
);

const missing = retained.filter((s) => !s.ta || !s.tb).length;
const trivialRatio = total > 0 ? Math.round((trivialFausses / total) * 100) : 0;
/** Chaque critère Q22, avec son état — le verdict les imprime tous, réussis compris. */
const criteria = [
  { label: "≥ 3 connexions non évidentes (couples distincts)", value: String(distinctPairs.size), ok: distinctPairs.size >= 3 },
  { label: "< 30 % triviales/fausses", value: `${trivialRatio} %`, ok: total > 0 && trivialFausses / total < 0.3 },
  { label: "≥ 1 analogie cross-domain", value: String(analogiesCrossDomain), ok: analogiesCrossDomain >= 1 },
  { label: "0 fragment inexistant", value: String(missing), ok: missing === 0 },
  { label: "≤ 50 appels batch", value: String(batchCalls), ok: batchCalls <= 50 },
  {
    label: "baseline : la diversification fait au moins aussi bien que le top-6 cosine",
    value: `${dDistinct} ≥ ${bDistinct} couples distincts`,
    ok: dDistinct >= bDistinct,
  },
];
console.log("\nCritères Q22 :");
for (const c of criteria) console.log(`  ${c.ok ? "✓" : "✗"} ${c.label} : ${c.value}`);
for (const c of criteria) if (!c.ok) failures.push(`${c.label} : ${c.value}`);

if (failures.length > 0) {
  console.error(`\nÉCHEC (${failures.length} critère(s)) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nPhase 2A : PASS — les critères du protocole Q22 sont remplis.");
