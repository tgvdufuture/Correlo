/**
 * Décodage des octets à l'ingestion (US-03).
 *
 * Constat réel (2026-09-11) : une page Gutenberg servie sans charset exploitable a été
 * décodée en UTF-8 alors que son corps était en latin-1/CP1252 → **429 fragments sur
 * 3 731** contenaient U+FFFD (« sauv�s », « Caract�re », « hyst�riques »).
 *
 * Règle appliquée : on ne devine jamais en silence.
 *   1. charset déclaré par l'en-tête HTTP `Content-Type` ;
 *   2. sinon charset déclaré dans le document (`<meta charset>`, `http-equiv`, `<?xml encoding>`);
 *   3. sinon **UTF-8 strict** (`fatal`) : s'il échoue, les octets ne sont pas de l'UTF-8 ;
 *   4. alors seulement, repli `windows-1252` (tous les octets y ont une correspondance).
 *
 * U+FFFD ne peut donc plus apparaître par accident : il ne subsiste que si le contenu
 * est réellement corrompu, et `countReplacementChars` permet de le signaler.
 */

export const REPLACEMENT_CHAR = "\uFFFD";

/** Nombre de caractères de remplacement (U+FFFD) dans un texte. */
export function countReplacementChars(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === REPLACEMENT_CHAR) n += 1;
  return n;
}

/**
 * Libellés de jeux de caractères → libellés compris par `TextDecoder`.
 * `iso-8859-1` et `latin1` désignent en pratique windows-1252 (règle WHATWG) :
 * c'est ce que les serveurs envoient vraiment, et ça évite un décodage mojibake.
 */
const CHARSET_ALIASES: Record<string, string> = {
  "utf8": "utf-8",
  "utf-8": "utf-8",
  "unicode-1-1-utf-8": "utf-8",
  "us-ascii": "utf-8",
  "ascii": "utf-8",
  "iso-8859-1": "windows-1252",
  "iso8859-1": "windows-1252",
  "iso_8859-1": "windows-1252",
  "latin1": "windows-1252",
  "latin-1": "windows-1252",
  "l1": "windows-1252",
  "cp1252": "windows-1252",
  "windows-1252": "windows-1252",
  "iso-8859-15": "iso-8859-15",
  "cp1250": "windows-1250",
  "windows-1250": "windows-1250",
};

/** Normalise un libellé de charset (minuscules, sans guillemets) ; null si vide. */
export function normalizeCharsetLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const clean = label.trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!clean) return null;
  return CHARSET_ALIASES[clean] ?? clean;
}

/** Charset déclaré par un en-tête `Content-Type` (`text/html; charset=utf-8`). */
export function charsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const m = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return normalizeCharsetLabel(m?.[1]);
}

/** Charset déclaré dans le document lui-même (balises `<meta>`, déclaration XML). */
export function detectCharsetFromMarkup(head: string): string | null {
  const meta =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-:.]+)/i) ??
    head.match(
      /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset=([a-z0-9_\-:.]+)/i
    ) ??
    head.match(/<\?xml[^>]*encoding\s*=\s*["']([a-z0-9_\-:.]+)["']/i);
  return normalizeCharsetLabel(meta?.[1]);
}

function tryDecode(buf: Uint8Array, label: string, fatal = false): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(buf);
  } catch {
    return null; // libellé inconnu de la plateforme, ou octets invalides en mode strict
  }
}

/**
 * Correspondances CP1252 des octets 0x80–0x9F (absentes d'ISO-8859-1) : guillemets
 * typographiques, tirets longs, €, œ… Indispensable ici : selon la plateforme, Node
 * peut résoudre le libellé « windows-1252 » vers ISO-8859-1 — vérifié en test, où
 * 0x92 ressortait en U+0092 au lieu de « ’ ». On applique donc la table nous-mêmes,
 * ce qui rend le résultat identique sur toutes les plateformes.
 */
const CP1252_HIGH_BYTES: Record<number, string> = {
  0x80: "\u20AC",
  0x82: "\u201A",
  0x83: "\u0192",
  0x84: "\u201E",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02C6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017D",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201C",
  0x94: "\u201D",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02DC",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203A",
  0x9c: "\u0153",
  0x9e: "\u017E",
  0x9f: "\u0178",
};

/** Remplace les caractères de contrôle C1 par leur équivalent CP1252. */
export function applyCp1252HighBytes(text: string): string {
  return text.replace(/[\u0080-\u009F]/g, (ch) => CP1252_HIGH_BYTES[ch.charCodeAt(0)] ?? ch);
}

/** Décodage « un octet par caractère » (CP1252), corrigé si la plateforme latinise. */
function decodeSingleByte(buf: Uint8Array): string | null {
  const raw = tryDecode(buf, "windows-1252") ?? tryDecode(buf, "latin1");
  return raw === null ? null : applyCp1252HighBytes(raw);
}

export interface DecodedText {
  text: string;
  /** Charset réellement utilisé (jamais deviné en silence). */
  charset: string;
  /** true si on a dû se rabattre sur un décodage non déclaré. */
  fallback: boolean;
}

/** Décode des octets selon un charset déclaré, sinon via la détection UTF-8 stricte. */
export function decodeTextBytes(
  buf: Uint8Array,
  declaredCharset?: string | null
): DecodedText {
  const declared = normalizeCharsetLabel(declaredCharset);
  if (declared === "windows-1252") {
    const text = decodeSingleByte(buf);
    if (text !== null) return { text, charset: declared, fallback: false };
  } else if (declared && declared !== "utf-8") {
    const text = tryDecode(buf, declared);
    if (text !== null) return { text, charset: declared, fallback: false };
  }
  // UTF-8 strict : l'échec est le signal fiable d'un contenu non-UTF-8.
  // UTF-8 non déclaré = défaut du web, ce n'est pas un repli.
  const utf8 = tryDecode(buf, "utf-8", true);
  if (utf8 !== null) return { text: utf8, charset: "utf-8", fallback: false };

  const cp1252 = decodeSingleByte(buf);
  if (cp1252 !== null) return { text: cp1252, charset: "windows-1252", fallback: true };

  // dernier recours : UTF-8 tolérant — l'appelant peut compter les U+FFFD restants
  return { text: tryDecode(buf, "utf-8") ?? "", charset: "utf-8", fallback: true };
}

/** Décode une page HTML : en-tête HTTP, puis `<meta>`/XML, puis détection stricte. */
export function decodeHtmlPage(buf: Uint8Array, contentType?: string | null): DecodedText {
  const fromHeader = charsetFromContentType(contentType);
  const declared =
    fromHeader ??
    detectCharsetFromMarkup(Buffer.from(buf.subarray(0, 4096)).toString("latin1"));
  return decodeTextBytes(buf, declared);
}
