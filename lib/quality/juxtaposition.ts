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
 * sans verbe de report — un report dit ce que dit un texte, il ne dit pas de quoi
 * parle un énoncé. Exporté pour la règle **en prose** (`isProseJuxtaposition`), qui
 * compte la matière d'une clause avant d'y chercher un verbe de report.
 */
export function clauseTerms(clause: string): Set<string> {
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

/* ====================================================================== *
 * Juxtaposition **en prose** (2026-09-18) — la même faute, jugée sur une réponse
 * d'investigation et non sur un claim d'une phrase.
 * ====================================================================== */

/**
 * Version de la règle en prose — tracée avec l'investigation (`conclusion_rule_version`).
 *
 * Distincte de `JUXTAPOSITION_RULE_VERSION` (`jux-v2`), qui juge les claims : celle-ci
 * ne la remplace pas et ne la modifie pas — le verdict 2A gelé reste lisible sous la
 * même règle.
 */
export const PROSE_JUXTAPOSITION_RULE_VERSION = "jux-prose-v1";

/**
 * Connecteurs de bipartition **en prose**. La liste des claims (`tandis que`,
 * `alors que`…) est complétée de deux familles qu'un claim d'une seule phrase ne peut
 * pas employer : l'opposition simple (`mais`, `cependant`, `en revanche`, `de son
 * côté`) et la distribution (`d'un côté… de l'autre`).
 */
const PROSE_BIPARTITION_MARKERS = [
  ...BIPARTITION_MARKERS,
  " mais ",
  " cependant",
  " en revanche",
  " de son cote",
  " pour sa part",
];

/**
 * Verbes de **report** : « X dit que … ». Propre à la règle en prose (et donc
 * distincte de `REPORTING_STEMS`, qui sert aux claims et dont la modification
 * déplacerait le verdict 2A gelé) — un énoncé qui empile deux reports dit ce que
 * chacun affirme, pas ce que les deux permettent d'établir.
 *
 * Le piège de ce genre de liste est la **conjugaison** : un préfixe qui couvre le
 * singulier peut manquer le pluriel (`montre` couvre `montrent`, mais `soutien` ne
 * couvre pas `soutient` — voyelle qui change). Constaté en mesurant la sortie réelle :
 * « Descartes **soutient** que… » n'était pas compté comme un report, et la
 * juxtaposition passait. Les radicaux sont donc pris assez courts pour couvrir la
 * famille, quitte à attraper un mot voisin — un faux positif ici rend la règle plus
 * stricte, un faux négatif la rend aveugle, et c'est la seconde erreur qui est arrivée.
 */
const PROSE_REPORTING_STEMS = [
  "affirm",
  "souti", // soutient, soutiennent, soutien — et « souten » pour soutenir/soutenait
  "souten",
  "consid",
  "montr",
  "expliqu",
  "decri", // décrit, décrivent — « decrit » ne couvre pas « decrivent »
  "ecri",
  "defin",
  "rappel",
  "reconn",
  "pretend",
  "propos",
  "estim",
  "observ",
  "insist",
  "soulign",
  "pense",
  "juge",
  "declar",
  "present",
  "analys",
  "contest",
  "adme", // admet, admettent
  "avanc",
  "formul",
  "enseign",
  "attribu",
  "qualifi",
  "indiqu",
  "constat",
  "remarqu",
];

/**
 * Prédicats relationnels **en prose** : l'énoncé dit comment un texte **éclaire**
 * l'autre. Construits par familles, sur les relations que le produit reconnaît
 * (`combination`, `extension`, `tension`, `application`, vocabulaire de la 5A) :
 * prolonger, appliquer, fonder, s'opposer, reprendre.
 *
 * Ce qui **n'y figure pas**, volontairement :
 *   - les verbes de report (`affirme`, `souligne`, `considère`, `montre`) : attribuer
 *     un contenu à un texte ne relie rien — c'est précisément le patron visé ;
 *   - `fait de` / `faisant de` : « faisant de lui un interprète actif » caractérise le
 *     sujet au lieu d'énoncer une relation entre les deux textes (mesuré sur la sortie
 *     réelle du 2026-09-18, où cette tournure terminait une juxtaposition).
 *
 * Comme pour la règle des claims, un prédicat absent n'est pas une erreur : c'est un
 * verbe de plus à ajouter — d'où la version de règle. La règle est **conservatrice
 * dans ce sens** : trouver une relation fait passer l'énoncé.
 */
const PROSE_RELATIONAL_MARKERS = [
  // prolonger / dépasser
  "prolonge",
  "pousse plus loin",
  "va plus loin",
  "etend",
  "radicalise",
  "approfondit",
  "complete",
  "depasse",
  // appliquer / transposer
  "applique",
  "transpose",
  "s applique",
  "s appuie",
  "se sert",
  "trouve dans",
  "fournit",
  "donne a",
  // fonder / expliquer / rendre compte
  "fonde",
  "justifie",
  "rend compte",
  "explique",
  "eclaire",
  "permet de",
  "permet d",
  "rend possible",
  "conditionne",
  "met en evidence",
  "revele",
  "se traduit",
  // s'opposer / arbitrer / corriger
  "s oppose",
  "contredit",
  "corrige",
  "invalide",
  "restreint",
  "arbitre",
  "tranche",
  "refute",
  "borne",
  // reprendre / correspondre (et la liste déjà employée pour les claims)
  "correspond",
  "repond a",
  "fait echo",
  "s inspire",
  "reprend",
  "se retrouve",
  "se rejoignent",
  "rejoint",
  "trouve son equivalent",
  "prefigure",
  "reflete",
  "revient a",
  "contrairement a",
];

/**
 * Recouvrement de termes en dessous duquel on ne juge pas une clause : une clause
 * trop courte (« voir [0] », « ce point est décisif ») ne porte pas d'attribution.
 */
export const PROSE_MIN_CLAUSE_TERMS = 4;

/**
 * Découpe une réponse en clauses : ponctuation forte, puis **chaque** occurrence d'un
 * connecteur de bipartition (le premier trouvé, puis on repart après lui).
 *
 * Une première version coupait au premier connecteur rencontré dans la liste, puis
 * cherchait les suivants **dans le reste** seulement : « A …, mais B …, tandis que C … »
 * donnait deux clauses et non trois, la première portant deux reports. Un découpage
 * complet donne les vraies frontières — c'est ce que compte la règle.
 */
export function splitProseClauses(text: string): string[] {
  // les indices écrits par le modèle (« (voir [0]) ») ne sont pas des termes de contenu
  const normalized = prenormalize(text).replace(/\(\s*voir\s*\[?\d+\]?\s*\)/g, " ");
  const pattern = new RegExp(PROSE_BIPARTITION_MARKERS.join("|"), "g");
  const parts: string[] = [];
  for (const sentence of normalized.split(/(?<=[.;!?])\s+/)) {
    let rest = sentence;
    let match = pattern.exec(rest);
    while (match && match.index > 0) {
      parts.push(rest.slice(0, match.index));
      rest = rest.slice(match.index + match[0].length);
      pattern.lastIndex = 0;
      match = pattern.exec(rest);
    }
    parts.push(rest);
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Vrai si la clause **attribue** un contenu à un texte (verbe de report). */
export function hasReportingVerb(clause: string): boolean {
  for (const token of textTokens(clause)) {
    if (PROSE_REPORTING_STEMS.some((stem) => token.startsWith(stem))) return true;
  }
  return false;
}

/** Vrai si une réponse dit **comment** un texte éclaire l'autre. */
export function hasProseRelationalPredicate(text: string): boolean {
  if (hasRelationalPredicate(text)) return true;
  const flat = stripPurposeSpans(prenormalize(text));
  return PROSE_RELATIONAL_MARKERS.some((marker) => flat.includes(marker));
}

/**
 * Vrai si une réponse est une **juxtaposition en prose** : des reports mis côte à côte.
 *
 * Cas réel qui a motivé la règle (2026-09-18, corpus de 3 853 fragments) : « Bernard et
 * Descartes considèrent tous deux l'expérimentateur comme un intermédiaire entre la
 * nature et la connaissance, mais Bernard souligne que … (voir [0]), tandis que
 * Descartes montre que … (voir [1]), faisant de lui un interprète actif plutôt qu'un
 * simple spectateur. » — deux reports coordonnés, aucune relation énoncée entre les
 * documents.
 *
 * **Pourquoi pas l'attribution lexicale** : la première version exigeait que chaque
 * clause soit « attribuable » à un fragment cité (part de ses termes présents dans le
 * fragment ≥ 0,5). Mesurée sur la sortie réelle, elle est aveugle — la clause
 * « Descartes montre que l'expérimentateur doit partir d'expériences particulières, en
 * remontant des effets aux causes cachées » ne partage que **0,27** de ses termes avec
 * le fragment de Descartes qu'elle résume : le modèle attribue une idée à un document
 * sans reprendre son vocabulaire. Le signal fiable n'est donc pas lexical, il est
 * **structurel** : deux reports, un connecteur, aucune relation.
 *
 * Trois conditions, toutes déterministes :
 *   1. aucune expression relationnelle (`hasProseRelationalPredicate`) ;
 *   2. au moins **deux clauses différentes** portent un **verbe de report** ;
 *   3. la réponse contient un **connecteur de bipartition** (`tandis que`, `alors
 *      que`, `mais`, `cependant`, `en revanche`, `de son côté`, `pour sa part`, `;`).
 *
 * La règle juge une **forme**, pas une vérité : elle ne dit pas si l'addition est
 * juste (c'est le rôle des évaluateurs, comme en 2A), elle dit que l'énoncé se
 * contente de redire les deux documents l'un après l'autre. Elle est volontairement
 * conservatrice dans l'autre sens : un prédicat relationnel de la liste suffit à faire
 * passer la réponse — un verbe manquant est un verbe à ajouter, d'où la version.
 */
export function isProseJuxtaposition(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed) return false;
  if (hasProseRelationalPredicate(trimmed)) return false;
  if (!hasBipartitionConnector(trimmed)) return false;

  const reporting = splitProseClauses(trimmed).filter(
    (clause) => clauseTerms(clause).size >= PROSE_MIN_CLAUSE_TERMS && hasReportingVerb(clause)
  );
  return reporting.length >= 2;
}

/** Vrai si la réponse coordonne deux membres (`tandis que`, `mais`, `;`…). */
function hasBipartitionConnector(text: string): boolean {
  const normalized = prenormalize(text);
  if (normalized.includes(";")) return true;
  return PROSE_BIPARTITION_MARKERS.some((marker) => normalized.includes(marker));
}
