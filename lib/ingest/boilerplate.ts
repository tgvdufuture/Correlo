/**
 * Retrait du boilerplate Gutenberg à l'ingestion (US-03).
 *
 * Constat réel (2026-09-11) : sur les sources Project Gutenberg du corpus, le texte
 * de licence (dons, `501(c)(3)`, « Updated editions will replace the previous one »…)
 * était ingéré comme contenu du document → **deux thèmes entiers** construits dessus
 * (`electronic · project · gutenberg · works`, `donations · support · freely · including`)
 * et pollution des pools de preuves comme des paires de la découverte.
 *
 * En-tête et pied sont traités **indépendamment** (le repli d'en-tête doit fonctionner
 * même si le pied est reconnu, sinon un document où Readability a écarté le marqueur
 * `START` garde tout son en-tête — constaté sur un HTML synthétique). Règles, par
 * ordre de fiabilité :
 *   1. marqueurs officiels `*** START OF (THE|THIS) PROJECT GUTENBERG EBOOK … ***`
 *      et `*** END OF (THE|THIS) PROJECT GUTENBERG EBOOK … ***` : le contenu réel est
 *      strictement entre les deux ;
 *   2. en-tête sans marqueur : signature forte (`This eBook is for the use of anyone
 *      anywhere…`) ou titre en tête (`Project Gutenberg's …`), puis on consomme le bloc
 *      de métadonnées qui suit (`Title:`, `Author:`, `Release date:`…), borné aux
 *      premiers milliers de caractères ;
 *   3. pied sans marqueur : signatures de licence (`PROJECT GUTENBERG LICENSE`,
 *      `Project Gutenberg Literary Archive Foundation`, `501(c)(3)`…), prises
 *      uniquement **après 60 % du texte** pour ne jamais couper un document qui
 *      parlerait de Gutenberg dans son corps.
 *
 * Le texte hors boilerplate n'est jamais modifié : les offsets du contenu conservé
 * servent de base aux locators, et `removedPrefix` permet de recaler les en-têtes.
 */

export interface BoilerplateStripResult {
  text: string;
  stripped: boolean;
  /** Caractères retirés au total (en-tête + pied). */
  removedChars: number;
  /**
   * Caractères retirés AVANT le contenu conservé : sert à recaler les offsets des
   * en-têtes (`#titre;[start,end)`) calculés avant le retrait.
   */
  removedPrefix: number;
  reason:
    | "start_end_markers"
    | "start_marker"
    | "end_marker"
    | "header_signature"
    | "license_signature"
    | null;
}

const START_MARKER = /^[ \t]*\*\*\*[ \t]*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*$/gim;
const END_MARKER = /^[ \t]*\*\*\*[ \t]*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*$/gim;

/** Au-delà, on refuse de croire qu'il s'agit encore d'un en-tête. */
const HEADER_SEARCH_LIMIT = 5_000;
/** Un titre en tête est en tête : au-delà, c'est une mention de Gutenberg dans le corps. */
const HEADER_TITLE_LIMIT = 300;
/** Fenêtre de consommation du bloc de métadonnées après la signature. */
const HEADER_METADATA_WINDOW = 3_000;

const HEADER_STRONG = /This\s+e-?[Bb]ook\s+is\s+for\s+the\s+use\s+of\s+anyone\s+anywhere/i;
const HEADER_TITLE = /^[ \t]*Project\s+Gutenberg'?s\s+/im;
/** Lignes de métadonnées du bloc d'en-tête Gutenberg. */
const HEADER_METADATA_LINE =
  /^[ \t]*(?:Title|Author|Release date|Language|Credits|Character set encoding|Original title|Transcriber|Produced by|Most recently updated)[ \t]*:[^\n]*$/gim;

const LICENSE_SIGNATURES = [
  /Updated\s+editions\s+will\s+replace/i,
  /PROJECT\s+GUTENBERG\s+LICEN[SC]E/i,
  /Project\s+Gutenberg\s+Literary\s+Archive\s+Foundation/i,
  /Most\s+people\s+start\s+at\s+our\s+website/i,
  /Section\s+1\.\s+General\s+Terms\s+of\s+Use/i,
  /501\(c\)\(3\)/,
];

/** Position de fin de la ligne contenant `index`. */
function endOfLine(text: string, index: number): number {
  const nl = text.indexOf("\n", index);
  return nl === -1 ? text.length : nl + 1;
}

/** Première correspondance d'une liste de motifs après `from`. */
function firstMatchAfter(
  text: string,
  patterns: RegExp[],
  from: number
): { index: number; pattern: RegExp } | null {
  let best: { index: number; pattern: RegExp } | null = null;
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    re.lastIndex = from;
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, pattern };
  }
  return best;
}

/** Consomme les lignes vides qui suivent immédiatement `index`. */
function skipBlankLines(text: string, index: number): number {
  const m = text.slice(index).match(/^(?:[ \t]*\n)+/);
  return m ? index + m[0].length : index;
}

/**
 * Fin du bloc d'en-tête, ou `null` si le texte ne commence pas par un en-tête
 * Gutenberg. Une signature forte peut être un peu plus loin ; le titre, lui, doit
 * être en tête de document — sinon c'est une mention de Gutenberg dans le corps.
 */
function headerCut(text: string): number | null {
  const strong = HEADER_STRONG.exec(text);
  const title = HEADER_TITLE.exec(text);
  const anchor =
    title && title.index < HEADER_TITLE_LIMIT
      ? title.index
      : strong && strong.index < HEADER_SEARCH_LIMIT
        ? strong.index
        : null;
  if (anchor === null) return null;

  const limit = Math.min(text.length, anchor + HEADER_METADATA_WINDOW);
  let cut = endOfLine(text, anchor);
  const re = new RegExp(HEADER_METADATA_LINE.source, HEADER_METADATA_LINE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= limit) break;
    const end = endOfLine(text, m.index);
    if (end > cut) cut = end;
  }
  return skipBlankLines(text, cut);
}

/** Début du pied de licence, ou `null`. Cherché seulement en fin de document. */
function footerCut(text: string): number | null {
  const license = firstMatchAfter(text, LICENSE_SIGNATURES, Math.floor(text.length * 0.6));
  return license ? license.index : null;
}

export function stripGutenbergBoilerplate(text: string): BoilerplateStripResult {
  const unchanged: BoilerplateStripResult = {
    text,
    stripped: false,
    removedChars: 0,
    removedPrefix: 0,
    reason: null,
  };
  if (!text) return unchanged;

  // dernier START et premier END : certaines pages répètent un marqueur dans les
  // métadonnées, l'encadrement réel est le plus serré
  const starts = [...text.matchAll(START_MARKER)];
  const ends = [...text.matchAll(END_MARKER)];
  const startMatch = starts.length > 0 ? starts[starts.length - 1] : null;
  const endMatch = ends.length > 0 ? ends[0] : null;

  let from = 0;
  let to = text.length;
  let headerStripped = false;

  if (startMatch) {
    from = skipBlankLines(text, endOfLine(text, startMatch.index));
    headerStripped = true;
  } else {
    const cut = headerCut(text);
    if (cut !== null && cut > 0) {
      from = cut;
      headerStripped = true;
    }
  }

  if (endMatch) {
    to = endMatch.index;
  } else {
    const cut = footerCut(text);
    if (cut !== null && cut > from) to = cut;
  }

  if (from >= to) return unchanged;
  if (from === 0 && to === text.length) return unchanged;
  const kept = text.slice(from, to);
  if (!kept.trim()) return unchanged;

  const reason: BoilerplateStripResult["reason"] =
    startMatch && endMatch
      ? "start_end_markers"
      : startMatch
        ? "start_marker"
        : headerStripped
          ? "header_signature"
          : endMatch
            ? "end_marker"
            : "license_signature";

  return {
    text: kept,
    stripped: from > 0 || to < text.length,
    removedChars: from + (text.length - to),
    removedPrefix: from,
    reason,
  };
}
