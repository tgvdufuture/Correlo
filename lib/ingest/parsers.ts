import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { PDFParse } from "pdf-parse";
import { normalizeText } from "@/lib/ingest/normalizer";
import { countReplacementChars, decodeHtmlPage, decodeTextBytes } from "@/lib/ingest/decoding";
import { stripGutenbergBoilerplate } from "@/lib/ingest/boilerplate";

/** PDF sans texte extractible. */
/** Balise de structure : un document HTML commence par l'une d'elles. */
const HTML_STRUCTURE = /<\s*(!doctype\s+html|html|head|body|svg|table)\b/i;

export class PdfNoTextError extends Error {
  constructor() {
    super("texte non extractible");
    this.name = "PdfNoTextError";
  }
}

/** Fetch ou extraction URL impossible. */
export class UrlExtractionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UrlExtractionError";
    this.code = code;
  }
}

export interface PdfPage {
  num: number;
  text: string;
}

/**
 * Texte brut d'un fichier texte : décodage explicite (UTF-8 strict, repli
 * windows-1252) — un fichier latin-1 ne produit plus de U+FFFD, BOM toléré.
 */
export function parseTextBuffer(buf: Buffer): string {
  const { text } = decodeTextBytes(new Uint8Array(buf), null);
  const decoded = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Un fichier HTML **déposé** n'est pas du texte : sans cette branche, un `.htm`
  // passait en `type: "TEXT"` et était indexé **tel quel**, balises et tout. Mesuré le
  // 2026-10-02 sur le corpus réel : `UserDiag − Acer Nitro AN515-58 (Laptop).htm`, un
  // dump de diagnostic, y a laissé **988 fragments** de coordonnées SVG
  // (`42.49163428103907 70.75447113934685`) — 496 sans un seul mot de 4 lettres. C'est le
  // plus gros fichier du corpus (1,9 Mo) et il aspirait le voisinage d'embeddings : deux
  // des cinq étapes d'un tour réel ont été consommées par ce bruit. Le chemin **URL**
  // nettoyait déjà (`SKIP_TAGS` porte `SVG`) ; c'est le dépôt qui ne le faisait pas.
  if (looksLikeHtml(decoded)) {
    const extracted = extractHtmlText(decoded);
    if (extracted.text.trim().length > 0) {
      console.info(
        `[ingest] HTML déposé converti en texte (Readability) : ${decoded.length} → ${extracted.text.length} caractères`
      );
      return extracted.text;
    }
    // extraction vide : on rend le texte brut plutôt que de perdre le document
    console.warn("[ingest] HTML déposé sans texte extractible — indexation du brut");
  }
  // Un .txt issu de Project Gutenberg porte le même boilerplate qu'une page URL :
  // licence et en-tête/pied ne doivent pas devenir du contenu indexé.
  const cleaned = stripGutenbergBoilerplate(decoded);
  if (cleaned.stripped) {
    console.info(
      `[ingest] boilerplate Gutenberg retiré (${cleaned.reason}) : ${cleaned.removedChars} caractères`
    );
  }
  return cleaned.text;
}

/**
 * Un tampon est-il du HTML **et non** du texte qui en parle ?
 *
 * Trois conditions, cumulées, parce que chacune seule a un faux positif mesuré :
 *  1. une balise de **structure** dans les premiers 4 000 caractères (`html`, `body`,
 *     `svg`, `table`…) — un document sans structure n’est pas indexable comme page ;
 *  2. au moins quatre balises ouvrantes ;
 *  3. un **ratio de balises fermantes** supérieur à la moitié.
 *
 * La densité de balises **ne discrimine pas**, et deux seuils l’ont démontré sur les
 * documents réels qui décident du cas (dump de diagnostic de 1,58 Mo contre un cours de
 * HTML de 529 caractères) : 1 balise pour 232 caractères d’un côté, 1 pour 176 de l
 * autre — trop proches. Un seuil à 400 laissait passer le cours de HTML ; un seuil à 100
 * rejetait le vrai diagnostic. Le ratio, lui, les sépare par deux ordres de grandeur :
 *
 *   - dump de diagnostic : 6 824 ouvrantes, 6 410 fermantes -> **0,94**
 *   - cours de HTML citant les balises : 3 ouvrantes, **0** fermante -> **0,00**
 *
 * Un document referme ses conteneurs ; un texte qui en parle n’ouvre rien.
 */
function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 4_000);
  const structured = HTML_STRUCTURE.test(head);
  if (!structured) return false;
  const opens = (text.match(/<[a-z][^>]*>/gi) ?? []).length;
  if (opens < 4) return false;
  const closes = (text.match(/<\/[a-z][^>]*>/gi) ?? []).length;
  return closes / opens >= 0.5;
}

/** Extraction des pages d'un PDF (pdf-parse). */
export async function extractPdfPages(buf: Buffer): Promise<PdfPage[]> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const result = await parser.getText();
  return result.pages.map((p) => ({ num: p.num, text: p.text ?? "" }));
}

export interface UrlExtraction {
  text: string;
  title: string | null;
  headings: { text: string; offset: number }[];
}

/**
 * Fetch + Readability (PRD US-03) : timeout 45 s (pages réelles lourdes —
 * Wikisource « texte entier » dépasse 15 s), taille max 10 Mo.
 * Le texte extrait est normalisé ; les en-têtes portent leurs offsets (approximatifs
 * avant normalisation, utilisés uniquement comme libellé de locator).
 */
export async function extractUrlText(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number }
): Promise<UrlExtraction> {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024;

  // le signal couvre fetch + lecture du corps : un serveur qui envoie les
  // en-têtes puis un corps lent ne doit pas laisser le job running à vie
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  let html: string;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (app locale Sérendipité)" },
    });
    if (!res.ok) {
      throw new UrlExtractionError("fetch_failed", `HTTP ${res.status} pour ${url}`);
    }
    // Les octets sont décodés explicitement (charset déclaré, puis UTF-8 strict,
    // puis windows-1252) : `res.text()` produisait des U+FFFD silencieux sur les
    // pages servies en latin-1 sans charset (constat : 429 fragments corrompus).
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new UrlExtractionError("fetch_failed", `Page > ${maxBytes} octets`);
    }
    const decoded = decodeHtmlPage(bytes, res.headers.get("content-type"));
    html = decoded.text;
    if (decoded.fallback) {
      console.warn(`[ingest] décodage ${decoded.charset} (charset non déclaré) pour ${url}`);
    }
    const replacements = countReplacementChars(html);
    if (replacements > 0) {
      console.warn(`[ingest] ${replacements} caractère(s) de remplacement dans ${url}`);
    }
  } catch (e) {
    if (e instanceof UrlExtractionError) throw e;
    throw new UrlExtractionError(
      "fetch_failed",
      `Échec du fetch (${url}) : ${(e as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }

  return extractHtmlText(html, url);
}

/**
 * HTML → texte, **partagé** par les deux chemins d'ingestion (page URL et fichier déposé).
 *
 * Un seul code de nettoyage pour les deux : c'est la condition pour qu'un `.htm` déposé
 * et la même page récupérée par URL produisent le même texte — donc des fragments
 * comparables et un diagnostic reproductible. La factorisation vient du défaut mesuré le
 * 2026-10-02 : le chemin URL écartait déjà le SVG (`SKIP_TAGS`), le chemin dépôt non, et
 * 988 fragments de coordonnées d'un diagnostic machine sont entrés dans le corpus.
 */
export function extractHtmlText(html: string, url = "file:///depot"): UrlExtraction {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  let text = "";
  let headings: { text: string; offset: number }[] = [];
  let title: string | null = null;

  if (article) {
    const extracted = articleTextWithHeadings(article.content ?? "", url);
    text = extracted.text;
    headings = extracted.headings;
    title = article.title || null;
  }

  if (text.length < 500) {
    // Repli : Readability échoue sur certains CMS (MediaWiki/Wikisource, etc.) —
    // on prend le conteneur principal du document tel quel.
    const container = dom.window.document.querySelector(
      "#mw-content-text, article, [role='main'], .mw-parser-output"
    );
    if (container) {
      const extracted = articleTextWithHeadings(container.innerHTML, url);
      if (extracted.text.length > text.length) {
        text = extracted.text;
        headings = extracted.headings;
      }
    }
    if (!title) {
      title = dom.window.document.querySelector("h1")?.textContent?.trim() || null;
    }
  }

  // Retrait du boilerplate Gutenberg (licence, en-tête/pied) : sans lui, la licence
  // devient du contenu indexé — deux thèmes de la Phase 5A en étaient entièrement faits.
  const cleaned = stripGutenbergBoilerplate(text);
  if (cleaned.stripped) {
    console.info(
      `[ingest] boilerplate Gutenberg retiré (${cleaned.reason}) : ${cleaned.removedChars} caractères`
    );
    text = cleaned.text;
    // les offsets des en-têtes sont recalés sur le texte nettoyé : les locators
    // `#titre;[start,end)` sont calculés sur ce texte, pas sur l'original
    headings = headings
      .map((h) => ({ ...h, offset: h.offset - cleaned.removedPrefix }))
      .filter((h) => h.offset >= 0 && h.offset < text.length);
  }

  if (text.length < 100) {
    throw new UrlExtractionError("empty_extraction", "Contenu extrait vide ou < 100 caractères");
  }
  return { text, title, headings };
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "TABLE", "TR", "TD", "TH",
  "SECTION", "ARTICLE", "FIGURE", "FIGCAPTION", "HEADER", "FOOTER", "ASIDE",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DL", "DT", "DD",
]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "SVG", "FORM"]);

/**
 * Parcourt le contenu de l'article (HTML) dans l'ordre du document :
 * sépare les blocs par des lignes vides, enregistre les en-têtes avec leur offset.
 */
function articleTextWithHeadings(contentHtml: string, url: string): {
  text: string;
  headings: { text: string; offset: number }[];
} {
  const dom = new JSDOM(contentHtml, { url });
  const root = dom.window.document.body;
  const parts: string[] = [];
  const headings: { text: string; offset: number }[] = [];
  let length = 0;

  const push = (s: string): void => {
    parts.push(s);
    length += s.length;
  };
  const separator = (): void => {
    if (parts.length && !parts[parts.length - 1].endsWith("\n")) push("\n\n");
  };

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const t = node.nodeValue ?? "";
      if (t.length) push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (HEADING_TAGS.has(tag)) {
      separator();
      const hText = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (hText) headings.push({ text: hText, offset: length });
    }
    if (tag === "BR") {
      push("\n");
      return;
    }
    if (BLOCK_TAGS.has(tag)) separator();
    for (const child of Array.from(el.childNodes)) walk(child);
    if (BLOCK_TAGS.has(tag)) push("\n");
  };

  walk(root);
  return { text: normalizeText(parts.join("")), headings };
}