import { afterEach, describe, expect, it, vi } from "vitest";
import { stripGutenbergBoilerplate } from "@/lib/ingest/boilerplate";
import { extractUrlText, parseTextBuffer } from "@/lib/ingest/parsers";

const HEADER =
  "Project Gutenberg's Histoire de France, by Jules Michelet\n\n" +
  "This eBook is for the use of anyone anywhere at no cost and with almost no\n" +
  "restrictions whatsoever. You may copy it, give it away or re-use it under the\n" +
  "terms of the Project Gutenberg License included with this eBook.\n\n" +
  "Title: Histoire de France\n\nAuthor: Jules Michelet\n\n";
const START = "*** START OF THE PROJECT GUTENBERG EBOOK HISTOIRE DE FRANCE ***\n\n";
const BODY = "Chapitre premier\n\nLa France était alors divisée en plusieurs provinces.\n\n";
const END = "*** END OF THE PROJECT GUTENBERG EBOOK HISTOIRE DE FRANCE ***\n\n";
const LICENSE =
  "Updated editions will replace the previous one—the old editions will be renamed.\n\n" +
  "THE FULL PROJECT GUTENBERG LICENSE\n\n" +
  "Project Gutenberg Literary Archive Foundation is a 501(c)(3) organization.\n" +
  "Most people start at our website which has the main PG search facility.\n";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retrait du boilerplate Gutenberg", () => {
  it("conserve strictement le contenu entre les marqueurs START et END", () => {
    const result = stripGutenbergBoilerplate(HEADER + START + BODY + END + LICENSE);
    expect(result.text).toBe(BODY);
    expect(result.stripped).toBe(true);
    expect(result.reason).toBe("start_end_markers");
    expect(result.removedPrefix).toBe((HEADER + START).length);
    expect(result.removedChars).toBe(HEADER.length + START.length + END.length + LICENSE.length);
  });

  it("gère les variantes « THIS PROJECT GUTENBERG » et les marqueurs isolés", () => {
    const thisVariant =
      HEADER + "*** START OF THIS PROJECT GUTENBERG EBOOK VIE DE JÉSUS ***\n\n" + BODY;
    const startOnly = stripGutenbergBoilerplate(thisVariant);
    expect(startOnly.reason).toBe("start_marker");
    expect(startOnly.text).toBe(BODY);

    const endOnly = stripGutenbergBoilerplate(BODY + END + LICENSE);
    expect(endOnly.reason).toBe("end_marker");
    expect(endOnly.text).toBe(BODY);
    expect(endOnly.removedPrefix).toBe(0);
  });

  it("retire un pied de licence sans marqueur (signatures en fin de document)", () => {
    const longBody = BODY.repeat(20);
    const result = stripGutenbergBoilerplate(longBody + LICENSE);
    expect(result.reason).toBe("license_signature");
    expect(result.text).toBe(longBody);
    expect(result.text).not.toContain("501(c)(3)");
  });

  it("ne touche pas à un document qui parle de Gutenberg dans son corps", () => {
    const text =
      "Gutenberg a inventé l'imprimerie à caractères mobiles vers 1450.\n\n" +
      "Cette innovation a transformé la diffusion des textes en Europe.\n\n" +
      "Project Gutenberg est aujourd'hui une bibliothèque numérique.\n";
    const result = stripGutenbergBoilerplate(text);
    expect(result.stripped).toBe(false);
    expect(result.text).toBe(text);
  });

  it("est idempotent et neutre sur un texte sans boilerplate", () => {
    const withBoilerplate = HEADER + START + BODY + END + LICENSE;
    const once = stripGutenbergBoilerplate(withBoilerplate);
    const twice = stripGutenbergBoilerplate(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.stripped).toBe(false);

    const clean = stripGutenbergBoilerplate(BODY);
    expect(clean).toEqual({
      text: BODY,
      stripped: false,
      removedChars: 0,
      removedPrefix: 0,
      reason: null,
    });
    expect(stripGutenbergBoilerplate("").text).toBe("");
  });

  it("parseTextBuffer retire le boilerplate d'un fichier .txt Gutenberg", () => {
    const buf = Buffer.from(HEADER + START + BODY + END + LICENSE, "utf8");
    expect(parseTextBuffer(buf)).toBe(BODY);
    // un fichier texte sans boilerplate est rendu tel quel
    expect(parseTextBuffer(Buffer.from(BODY, "utf8"))).toBe(BODY);
  });

  it("extractUrlText retire le boilerplate ET recale les offsets d'en-têtes", async () => {
    const html =
      "<html><head><title>Histoire de France</title></head><body><article><h1>Sommaire</h1><div>" +
      HEADER.replace(/\n/g, "<br>") +
      "</div><div>" +
      START.replace(/\n/g, "<br>") +
      "</div><div><h2>Chapitre premier</h2><p>La France était alors divisée en plusieurs provinces.</p>" +
      "<p>Le royaume était morcelé et les seigneurs disposaient de leurs terres.</p>" +
      "<p>Ce récit couvre les années 1724 à 1759 et les transformations du royaume.</p></div>" +
      "<div>" +
      END.replace(/\n/g, "<br>") +
      LICENSE.replace(/\n/g, "<br>") +
      "</div></article></body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Buffer.from(html, "utf8"), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          })
      )
    );

    const extracted = await extractUrlText("https://www.gutenberg.org/files/1/1-h.htm");
    expect(extracted.text).not.toContain("START OF THE PROJECT GUTENBERG");
    expect(extracted.text).not.toContain("Updated editions will replace");
    expect(extracted.text).not.toContain("This eBook is for the use of anyone");
    expect(extracted.text).toContain("La France était alors divisée");

    // chaque en-tête conservé pointe bien sur son titre dans le texte nettoyé
    for (const heading of extracted.headings) {
      expect(extracted.text.slice(heading.offset).startsWith(heading.text)).toBe(true);
    }
  });
});
