import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX,
  CHUNK_MIN,
  CHUNK_OVERLAP,
  buildLocator,
  chunkText,
} from "@/lib/ingest/chunker";

function para(n: number, char = "a"): string {
  return char.repeat(n);
}

describe("chunkText", () => {
  it("doc < 800 → fragment unique", () => {
    const text = para(500);
    expect(chunkText(text)).toEqual([{ start: 0, end: 500 }]);
  });

  it("doc 800..2400 → fragment unique", () => {
    const text = para(1500);
    expect(chunkText(text)).toEqual([{ start: 0, end: 1500 }]);
  });

  it("bornes 800..2400 respectées, overlap exact, slice aligné (locator AC2)", () => {
    // 10 paragraphes de ~500 chars → ~5 000 chars
    const text = Array.from({ length: 10 }, () => para(500)).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const len = c.end - c.start;
      expect(len).toBeGreaterThanOrEqual(CHUNK_MIN);
      expect(len).toBeLessThanOrEqual(CHUNK_MAX);
      // le slice reproduit exactement le texte du chunk (locators UTF-16)
      expect(text.slice(c.start, c.end).length).toBe(len);
    }
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i + 1].start).toBe(chunks[i].end - CHUNK_OVERLAP);
    }
  });

  it("paragraphe > 2400 : coupe phrase puis coupe dure sans dépasser la borne", () => {
    const sentence = "Les systèmes complexes émergent de règles simples. ";
    const text = sentence.repeat(50); // ~2 500+ chars sans aucun \n
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.end - c.start).toBeLessThanOrEqual(CHUNK_MAX);
      const cutText = text.slice(c.start, c.end);
      // coupe à la phrase : le chunk se termine après le point (ou à la fin du doc)
      expect(cutText.endsWith(".") || c.end === text.length).toBe(true);
    }
  });

  it("coupe dure : aucun séparateur → chunks de 2400 exacts", () => {
    const text = "x".repeat(4800);
    const chunks = chunkText(text);
    expect(chunks[0].end - chunks[0].start).toBe(2400);
    expect(chunks[1].end - chunks[1].start).toBe(2400);
  });

  it("dernier chunk < min fusionné au précédent si ≤ max", () => {
    // chunks [0,400) [350,700) (coupe phrase) puis [650,720) (70 chars) :
    // fusion car 720 - 350 = 370 ≤ 400
    const text = `${"x".repeat(699)}. ${"x".repeat(19)}`;
    const chunks = chunkText(text, { target: 300, min: 100, max: 400, overlap: 50 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1].end).toBe(720);
    expect(chunks[1].end - chunks[1].start).toBe(370); // 720 - 350
  });

  it("dernier chunk < min conservé si la fusion dépasserait la borne", () => {
    const text = "x".repeat(1149);
    const chunks = chunkText(text, { target: 300, min: 100, max: 400, overlap: 50 });
    const last = chunks[chunks.length - 1];
    expect(last.end - last.start).toBeLessThan(100); // conservé tel quel
    expect(last.end - chunks[chunks.length - 2].start).toBeGreaterThan(400);
  });

  it("offsets UTF-16 : emoji (surrogate pairs) jamais coupés, slice exact", () => {
    // '😀' = 2 unités UTF-16 ; la coupe dure à 400 tomberait au milieu de l'emoji
    const text = `${para(399, "a")}😀${para(400, "b")}`;
    const chunks = chunkText(text, { target: 300, min: 100, max: 400, overlap: 50 });
    const first = chunks[0];
    expect(text.slice(first.start, first.end)).toBe(para(399, "a"));
    // aucun chunk ne porte un demi-surrogate en bordure de fin
    for (const c of chunks) {
      const hi = text.charCodeAt(c.end - 1);
      const lo = text.charCodeAt(c.end) ?? 0;
      const splits = hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
      expect(splits).toBe(false);
    }
    // l'emoji entier appartient à un seul chunk
    const owner = chunks.find((c) => c.start <= 399 && c.end > 400);
    expect(owner).toBeDefined();
  });

  it("coupe paragraphe préférée à la phrase", () => {
    // le \n\n (fin 2208) est plus proche de la cible que le point de phrase (1805)
    const text = `${para(1800, "a")} Fin. ${para(400, "b")}\n\n${para(2000, "c")}`;
    const chunks = chunkText(text, { target: 2000, min: 800, max: 2400, overlap: 300 });
    expect(chunks[0].end).toBe(2208);
    expect(text.slice(2206, 2208)).toBe("\n\n");
  });
});

describe("buildLocator", () => {
  it("TEXT : [start,end)", () => {
    expect(buildLocator("TEXT", { start: 10, end: 200 })).toBe("[10,200)");
  });

  it("PDF : page contenant le début du chunk", () => {
    const pages = [
      { offset: 0, page_num: 1 },
      { offset: 1000, page_num: 2 },
      { offset: 2500, page_num: 3 },
    ];
    expect(buildLocator("PDF", { start: 500, end: 900 }, pages)).toBe("p.1;[500,900)");
    expect(buildLocator("PDF", { start: 1000, end: 1400 }, pages)).toBe("p.2;[1000,1400)");
    expect(buildLocator("PDF", { start: 2600, end: 3000 }, pages)).toBe("p.3;[2600,3000)");
  });

  it("URL : dernier en-tête avant le chunk", () => {
    const headings = [
      { offset: 0, text: "Introduction" },
      { offset: 500, text: "Méthode" },
    ];
    expect(buildLocator("URL", { start: 100, end: 300 }, undefined, headings)).toBe(
      "#Introduction;[100,300)"
    );
    expect(buildLocator("URL", { start: 600, end: 800 }, undefined, headings)).toBe(
      "#Méthode;[600,800)"
    );
  });

  it("URL sans en-tête : repli 'root'", () => {
    expect(buildLocator("URL", { start: 0, end: 50 })).toBe("#root;[0,50)");
  });
});