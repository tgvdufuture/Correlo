import { afterEach, describe, expect, it, vi } from "vitest";
import {
  charsetFromContentType,
  countReplacementChars,
  decodeHtmlPage,
  decodeTextBytes,
  detectCharsetFromMarkup,
  normalizeCharsetLabel,
} from "@/lib/ingest/decoding";
import { extractUrlText, parseTextBuffer } from "@/lib/ingest/parsers";

/**
 * Octets réels d'une page Gutenberg en CP1252 : `0xE8` = « è », `0x92` = « ’ »,
 * `0xE9` = « é ». Décodés en UTF-8, ils produisent tous des U+FFFD.
 */
function cp1252Sentence(): Uint8Array {
  const ascii = "Caract";
  return new Uint8Array([
    ...Buffer.from(ascii, "latin1"),
    0xe8, // è
    ...Buffer.from("re d", "latin1"),
    0x92, // ’
    ...Buffer.from("Ad", "latin1"),
    0xe9, // é
    ...Buffer.from("la", "latin1"),
    0xef, // ï
    ...Buffer.from("de. Les hyst", "latin1"),
    0xe9,
    ...Buffer.from("riques sont sauv", "latin1"),
    0xe9,
    ...Buffer.from("es.", "latin1"),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("décodage à l'ingestion", () => {
  it("décode proprement un corps UTF-8 (aucun U+FFFD)", () => {
    const text = "Caractère d’Adélaïde — les hystériques sont sauvées.";
    const decoded = decodeTextBytes(new Uint8Array(Buffer.from(text, "utf8")), null);
    expect(decoded).toEqual({ text, charset: "utf-8", fallback: false });
    expect(countReplacementChars(decoded.text)).toBe(0);
  });

  it("reconnaît un corps CP1252/latin-1 et ne produit aucun U+FFFD", () => {
    const decoded = decodeTextBytes(cp1252Sentence(), null);
    expect(decoded.charset).toBe("windows-1252");
    expect(decoded.fallback).toBe(true);
    expect(decoded.text).toBe("Caractère d’Adélaïde. Les hystériques sont sauvées.");
    expect(countReplacementChars(decoded.text)).toBe(0);
  });

  it("respecte un charset déclaré par l'en-tête HTTP", () => {
    expect(charsetFromContentType("text/html; charset=UTF-8")).toBe("utf-8");
    expect(charsetFromContentType("text/html; charset=iso-8859-1")).toBe("windows-1252");
    expect(charsetFromContentType("text/html")).toBeNull();

    const decoded = decodeTextBytes(cp1252Sentence(), "iso-8859-1");
    expect(decoded.charset).toBe("windows-1252");
    expect(decoded.fallback).toBe(false); // charset déclaré : ce n'est pas un repli
    expect(decoded.text).toContain("Caractère");
  });

  it("lit le charset déclaré dans le document (<meta>, http-equiv, XML)", () => {
    expect(detectCharsetFromMarkup('<meta charset="windows-1252">')).toBe("windows-1252");
    expect(
      detectCharsetFromMarkup(
        '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">'
      )
    ).toBe("windows-1252");
    expect(detectCharsetFromMarkup('<?xml version="1.0" encoding="ISO-8859-15"?>')).toBe(
      "iso-8859-15"
    );
    expect(detectCharsetFromMarkup("<html><head></head>")).toBeNull();

    const page = decodeHtmlPage(cp1252Sentence(), null);
    expect(page.text).toContain("hystériques");
    expect(countReplacementChars(page.text)).toBe(0);
  });

  it("retire le BOM UTF-8 et normalise les libellés de charset", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("Été", "utf8")]);
    expect(decodeTextBytes(withBom, null).text).toBe("Été");
    expect(normalizeCharsetLabel(' "Latin-1" ')).toBe("windows-1252");
    expect(normalizeCharsetLabel("")).toBeNull();
    expect(countReplacementChars("a\uFFFDb")).toBe(1);
  });

  it("parseTextBuffer décode un fichier latin-1 sans le corrompre", () => {
    expect(parseTextBuffer(Buffer.from(cp1252Sentence()))).toBe(
      "Caractère d’Adélaïde. Les hystériques sont sauvées."
    );
  });

  it("extractUrlText : une page sans charset mais en latin-1 est lue correctement", async () => {
    const body = cp1252Sentence();
    const paragraph = Buffer.concat([
      Buffer.from("<html><head><title>Histoire</title></head><body><article><h1>Chapitre</h1><p>", "latin1"),
      Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([body, Buffer.from(" ", "latin1")]))),
      Buffer.from("</p></article></body></html>", "latin1"),
    ]);
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array(paragraph), {
          status: 200,
          headers: { "content-type": "text/html" }, // aucun charset déclaré
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const extracted = await extractUrlText("https://example.org/histoire");
    expect(extracted.text).toContain("Caractère d’Adélaïde");
    expect(extracted.text).toContain("hystériques");
    expect(countReplacementChars(extracted.text)).toBe(0);
  });

  it("extractUrlText : une page UTF-8 reste inchangée", async () => {
    const paragraph =
      "<html><head><meta charset=\"utf-8\"><title>T</title></head><body><article><h1>Chapitre</h1><p>" +
      "Caractère d’Adélaïde, les hystériques sont sauvées. ".repeat(10) +
      "</p></article></body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(Buffer.from(paragraph, "utf8"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      )
    );

    const extracted = await extractUrlText("https://example.org/utf8");
    expect(extracted.text).toContain("Caractère d’Adélaïde");
    expect(countReplacementChars(extracted.text)).toBe(0);
  });
});
