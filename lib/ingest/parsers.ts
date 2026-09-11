import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { PDFParse } from "pdf-parse";
import { normalizeText } from "@/lib/ingest/normalizer";

/** PDF sans texte extractible. */
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

/** Texte brut d'un fichier texte (UTF-8, BOM toléré). */
export function parseTextBuffer(buf: Buffer): string {
  let s = buf.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
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
    html = await res.text();
  } catch (e) {
    if (e instanceof UrlExtractionError) throw e;
    throw new UrlExtractionError(
      "fetch_failed",
      `Échec du fetch (${url}) : ${(e as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }
  if (html.length > maxBytes) {
    throw new UrlExtractionError("fetch_failed", `Page > ${maxBytes} octets`);
  }

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