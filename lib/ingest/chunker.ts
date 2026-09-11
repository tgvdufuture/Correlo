import type { SourceType } from "@/lib/repositories/sources";

/**
 * Chunker v1 (PRD F1.2) : cible 2 000, min 800, max 2 400, overlap 300,
 * coupe paragraphe → phrase → coupe dure, locators UTF-16 demi-ouverts
 * alignés sur String.slice().
 */

export const CHUNKER_VERSION = "chunker-v1";
export const CHUNK_TARGET = 2000;
export const CHUNK_MIN = 800;
export const CHUNK_MAX = 2400;
export const CHUNK_OVERLAP = 300;

export interface Chunk {
  /** Borne de début (unités de code UTF-16 sur le texte source). */
  start: number;
  /** Borne de fin (demi-ouverte). */
  end: number;
}

export interface PageMapEntry {
  /** Offset UTF-16 du début de page dans raw_content. */
  offset: number;
  page_num: number;
}

export interface HeadingMapEntry {
  offset: number;
  text: string;
}

const SENTENCE_ENDERS = new Set([".", "!", "?", "…"]);

/**
 * Découpe un texte en chunks [start,end) respectant les bornes.
 * Doc < 800 ⇒ fragment unique. Dernier chunk < 800 fusionné si ≤ 2 400.
 */
export function chunkText(
  text: string,
  opts?: Partial<{ target: number; min: number; max: number; overlap: number }>
): Chunk[] {
  const target = opts?.target ?? CHUNK_TARGET;
  const min = opts?.min ?? CHUNK_MIN;
  const max = opts?.max ?? CHUNK_MAX;
  const overlap = opts?.overlap ?? CHUNK_OVERLAP;

  const len = text.length;
  if (len < min) return [{ start: 0, end: len }];
  if (len <= max) return [{ start: 0, end: len }];

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < len) {
    const upper = Math.min(start + max, len);
    const lower = start + min;
    const cutTarget = Math.min(start + target, upper);
    let end: number;
    if (lower > upper) {
      // reste trop petit pour une coupe bornée : fragment final conservé tel quel
      end = len;
    } else {
      const paraCut = findParagraphCut(text, lower, upper, cutTarget);
      if (paraCut !== -1) {
        end = paraCut;
      } else {
        const sentCut = findSentenceCut(text, lower, upper, cutTarget);
        // coupe dure à la borne max (jamais au milieu d'une paire de surrogates)
        end = sentCut !== -1 ? sentCut : upper;
      }
      end = fixSurrogateBoundary(text, end, lower, upper);
    }
    chunks.push({ start, end });
    if (end === len) break;
    // overlap 300 : le chunk suivant réutilise la fin du précédent
    start = end - overlap;
  }

  // Dernier fragment < min fusionné au précédent si le résultat ≤ max
  const last = chunks[chunks.length - 1];
  if (chunks.length > 1 && last.end - last.start < min) {
    const prev = chunks[chunks.length - 2];
    if (last.end - prev.start <= max) {
      prev.end = last.end;
      chunks.pop();
    }
  }

  return chunks;
}

/**
 * Décale une coupe qui tomberait au milieu d'une paire de surrogates (UTF-16),
 * pour ne jamais produire de demi-emoji dans un fragment.
 */
function fixSurrogateBoundary(text: string, cut: number, lower: number, upper: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const prev = text.charCodeAt(cut - 1);
  const cur = text.charCodeAt(cut);
  const isHigh = prev >= 0xd800 && prev <= 0xdbff;
  const isLow = cur >= 0xdc00 && cur <= 0xdfff;
  if (!isHigh || !isLow) return cut;
  if (cut - 1 >= lower) return cut - 1;
  if (cut + 1 <= upper) return cut + 1;
  return cut;
}

/**
 * Coupe de paragraphe (\n\n) la plus proche de `cutTarget` dans [lower, upper].
 * Retourne la position de fin de coupure (après le \n\n), ou -1.
 */
function findParagraphCut(text: string, lower: number, upper: number, cutTarget: number): number {
  // en arrière depuis cutTarget
  let idx = text.lastIndexOf("\n\n", cutTarget);
  while (idx !== -1) {
    const end = idx + 2;
    if (end >= lower && end <= upper) return end;
    if (end < lower) return -1;
    idx = text.lastIndexOf("\n\n", idx - 1);
  }
  // en avant depuis cutTarget
  idx = text.indexOf("\n\n", cutTarget);
  while (idx !== -1) {
    const end = idx + 2;
    if (end >= lower && end <= upper) return end;
    if (end > upper) return -1;
    idx = text.indexOf("\n\n", idx + 2);
  }
  return -1;
}

/**
 * Coupe phrase (. ! ? …) ou saut de ligne simple, la plus proche de
 * `cutTarget` dans [lower, upper]. Retourne la position après le marqueur, ou -1.
 */
function findSentenceCut(text: string, lower: number, upper: number, cutTarget: number): number {
  const isCut = (i: number): boolean =>
    text[i] === "\n" || SENTENCE_ENDERS.has(text[i] as string);

  // en arrière depuis cutTarget
  for (let i = cutTarget; i >= lower; i--) {
    if (isCut(i)) return i + 1;
  }
  // en avant depuis cutTarget (on peut dépasser la cible, jamais upper)
  for (let i = cutTarget + 1; i <= upper - 1; i++) {
    if (isCut(i)) return i + 1;
  }
  return -1;
}

/**
 * Locator par type de source (PRD §3.3) :
 * PDF `p.N;[start,end)` · TEXT `[start,end)` · URL `#heading;[start,end)`.
 * Les bornes sont toujours des offsets UTF-16 sur raw_content (String.slice()).
 */
export function buildLocator(
  type: SourceType,
  chunk: Chunk,
  pages?: PageMapEntry[],
  headings?: HeadingMapEntry[]
): string {
  const range = `[${chunk.start},${chunk.end})`;
  if (type === "PDF") {
    const page = pages?.length
      ? [...pages].reverse().find((p) => p.offset <= chunk.start) ?? pages[0]
      : null;
    return page ? `p.${page.page_num};${range}` : range;
  }
  if (type === "URL") {
    const heading =
      headings?.length
        ? [...headings].reverse().find((h) => h.offset <= chunk.start) ?? headings[0]
        : null;
    const label = heading ? heading.text.replace(/\n+/g, " ").trim().slice(0, 80) : "root";
    return `#${label};${range}`;
  }
  return range;
}