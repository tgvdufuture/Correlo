/**
 * Détecteur de **juxtaposition** — défaut 1 mesuré sur le run `discovery-v4`.
 *
 * Le patron dominant de la production n'était pas une formule figée (que les
 * marqueurs génériques attrapent) mais une **structure** : deux attributions
 * coordonnées, « X dit A, tandis que Y dit B », sans qu'aucune relation ne soit
 * énoncée entre A et B. Le prompt v4 l'interdisait déjà en prose ; le modèle le
 * produit quand même, donc la règle est appliquée **côté serveur** — comme les
 * autres (PRD : « mieux vaut skip qu'un claim faible »).
 *
 * Un énoncé est une juxtaposition si :
 *   1. il se découpe en **deux clauses** attribuées à deux textes différents
 *      (connecteur de bipartition : `tandis que`, `alors que`, `;`, `, comme `,
 *      clause comparative initiale `Comme …`, connecteur de bipartition **initial**
 *      `Alors que X …, Y …`), **et**
 *   2. aucun **prédicat relationnel** n'énonce *comment* un texte éclaire l'autre
 *      (`préfigure`, `reflète`, `trouve son équivalent`…), **et**
 *   3. les deux clauses ne **partagent aucun terme de contenu** — pas même un
 *      concept commun (les deux énoncés parlent alors d'objets différents, ce qui
 *      est exactement ce que « relier » ne veut pas dire).
 *
 * Le point 2 tient une **liste blanche** : n'y figurent que des prédicats qui
 * énoncent une relation. Deux familles en ont été retirées après le run `jux-v1`,
 * parce qu'elles **exemptaient précisément les énoncés visés** :
 *   - les formules de comparaison (`montrant deux modèles d'autorité`, `même
 *     logique`…) — ce sont des formules **génériques**, pas des relations ; elles
 *     sont désormais rejetées comme telles par le profil de claim
 *     (`CLAIM_TEXT_PROFILE`, famille « les deux auteurs ») ;
 *   - `contrairement à`, qui **affirme** un contraste argumenté — c'est une
 *     relation, et il le fallait d'autant plus que le connecteur était
 *     inopérant en position initiale (point 1) : le laisser dans la liste de
 *     bipartition condamnait le seul type de relation *contradiction* que le PRD
 *     demande de produire.
 *
 * Le troisième point est volontairement généreux : il suffit d'un **terme commun**
 * (au moins 5 lettres, comparé sur sa racine de 5 lettres — la convention déjà
 * employée par le détecteur d'ancre, qui rapproche *douter* de *doute* et
 * *recommandation* de *recommandé*) pour que le claim soit conservé. Le but n'est
 * pas de trancher les cas fins — c'est de couper net la coordination vide, qui est
 * mesurable et déterministe. Les cas fins restent à la charge des évaluateurs.
 *
 * Contrepartie assumée de l'appariement par racine : un lien purement de surface
 * (racine commune entre *juge* et *juger*) passe le troisième point. Cohérent avec le prong d'ancrage
 * — un mot **fréquent** partagé n'est pas une ancre, donc il ne disqualifie pas.
 *
 * Module **pur** (aucune dépendance, aucune E/S), partagé comme le détecteur
 * d'ancre : la barrière serveur (`lib/discover/claim-rules.ts`) et l'évaluateur
 * (`scripts/evaluate-phase-2a.mjs`) appellent cette source unique. L'import de
 * `text-rules` est **relatif** : le module reste importable par Node sans l'alias
 * `@/` (l'évaluateur n'est pas compilé par Next), comme `lexical-anchor.ts`.
 */

import { textTokens } from "./text-rules.ts";

/**
 * Version de la règle — à incrémenter si les marqueurs ou les prongs changent.
 *
 * `jux-v2` (2026-09-15) : bipartition **initiale** (`Alors que X …, Y …`) détectée —
 * en `jux-v1` les connecteurs n'étaient cherchés qu'à un indice `> 0`, donc un
 * énoncé commençant par le connecteur passait la règle (`val-div` : « Alors que le
 * manteau du cavalier yankee…, la robe de jésuite… »). Formules de comparaison
 * retirées de la liste de prédicats relationnels, `contrairement à` ajouté (voir
 * l'en-tête).
 */
export const JUXTAPOSITION_RULE_VERSION = "jux-v2";

/** Longueur de racine : convention du projet (détecteur d'ancre, `lexical-anchor`). */
const STEM_LENGTH = 5;

/**
 * Connecteurs qui séparent deux clauses attribuées à deux textes. `contrairement
 * à` n'y figure pas : il **affirme** un contraste, donc il appartient aux
 * prédicats relationnels.
 */
const BIPARTITION_MARKERS = ["tandis que", "alors que", "au contraire", "la ou "];

/**
 * Prédicats relationnels : l'énoncé dit **comment** un texte éclaire l'autre.
 * Liste construite sur les prédicats réellement employés par le corpus — un
 * prédicat absent de cette liste n'est pas une erreur, c'est un verbe de plus à
 * ajouter (d'où la version de règle).
 */
const RELATIONAL_MARKERS = [
  "trouve son equivalent",
  "trouvent leur equivalent",
  "trouve un equivalent",
  "agit avec la meme",
  "avec la meme resolution",
  "prefigure",
  "illustre",
  "reflete",
  "fait echo",
  "repond a",
  "revient a",
  "montrant",
  "contrairement a",
];

/**
 * Radicaux des **verbes de report** : attribuer un contenu à un texte ne relie
 * rien. Exclus du prong « terme partagé », sinon deux clauses qui disent toutes
 * deux « montre » seraient considérées comme parlant du même objet.
 */
const REPORTING_STEMS = [
  "affirm",
  "soutien",
  "declar",
  "defin",
  "decri",
  "montr",
  "expliqu",
  "preconis",
  "recommand",
  "consider",
  "utilis",
  "emploi",
  "ecri",
  "present",
  "estim",
  "propos",
  "indiqu",
  "qualifi",
  "attribu",
  "confirm",
  "ajout",
  "conclu",
  "appel",
  "nomm",
  "enseign",
];

/**
 * Normalisation **conservant la ponctuation forte** : minuscules + accents
 * retirés. `normalizeText` de `text-rules` transforme `;` en espace, or la
 * bipartition en dépend.
 */
function prenormalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Retire les propositions de but (`pour …`, `afin de …`) avant la recherche d'un
 * prédicat relationnel : « Descartes utilise la dissection **pour illustrer** le
 * mécanisme » n'énonce pas une relation entre les deux textes, c'est le but d'un
 * des deux côtés.
 */
function stripPurposeSpans(text: string): string {
  return text
    .replace(/\b(?:pour|afin de)\s[^,;.]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Racine d'un terme : ses 5 premières lettres (convention du projet). */
function stemOf(term: string): string {
  return term.slice(0, STEM_LENGTH);
}

/**
 * Termes de contenu d'une clause : au moins 5 lettres (convention du projet) et
 * sans verbe de report.
 */
function clauseTerms(clause: string): Set<string> {
  const terms = new Set<string>();
  for (const token of textTokens(clause)) {
    if (REPORTING_STEMS.some((stem) => token.startsWith(stem))) continue;
    terms.add(token);
  }
  return terms;
}

/** Découpe une clause initiale « Comme X …, Y … » en ses deux membres. */
function splitLeadingComme(text: string): [string, string] | null {
  const idx = text.indexOf(",");
  if (idx <= 0) return null;
  return [text.slice(0, idx), text.slice(idx + 1)];
}

/**
 * Découpe un énoncé en ses deux clauses attribuées, ou `null` s'il n'en a pas
 * deux (un énoncé mono-clause n'est pas une juxtaposition).
 */
export function splitJuxtaposedClauses(claim: string): [string, string] | null {
  const text = prenormalize(claim);

  // Coordination par point-virgule.
  const semi = text.indexOf(";");
  if (semi > 0) {
    const left = text.slice(0, semi);
    const right = text.slice(semi + 1);
    if (left.trim() && right.trim()) return [left, right];
  }

  for (const marker of BIPARTITION_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx > 0) {
      const left = text.slice(0, idx);
      const right = text.slice(idx + marker.length);
      if (left.trim() && right.trim()) return [left, right];
    }
    // Connecteur **initial** (« Alors que X …, Y … ») : la seconde clause commence
    // après la virgule du connecteur, pas après le connecteur lui-même.
    if (idx === 0) {
      const sides = splitLeadingComme(text);
      if (sides) return sides;
    }
  }

  // Comparaison « …, comme … » : la seconde clause commence au connecteur.
  const commaComme = text.indexOf(", comme ");
  if (commaComme > 0) {
    return [text.slice(0, commaComme), text.slice(commaComme + 2)];
  }
  // Comparaison initiale « Comme X …, Y … ».
  if (text.startsWith("comme ")) {
    const sides = splitLeadingComme(text);
    if (sides) return sides;
  }

  return null;
}

/** Vrai si l'énoncé énonce explicitement une relation entre les deux clauses. */
export function hasRelationalPredicate(claim: string): boolean {
  const text = stripPurposeSpans(prenormalize(claim));
  return RELATIONAL_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Vrai si l'énoncé est une **juxtaposition vide** : deux attributions coordonnées
 * qu'aucune relation n'unit. Voir l'en-tête du module pour les trois conditions.
 */
export function isJuxtapositionClaim(claim: string): boolean {
  const trimmed = claim.trim();
  if (!trimmed) return false;
  if (hasRelationalPredicate(trimmed)) return false;

  const sides = splitJuxtaposedClauses(trimmed);
  if (!sides) return false;

  const left = clauseTerms(sides[0]);
  const right = clauseTerms(sides[1]);
  // Trop peu de matière d'un côté : on ne juge pas (règle conservatrice).
  if (left.size < 3 || right.size < 3) return false;

  const rightStems = new Set([...right].map(stemOf));
  for (const term of left) if (rightStems.has(stemOf(term))) return false;
  return true;
}
