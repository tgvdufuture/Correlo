import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/ingest/normalizer";

describe("normalizeText (Q17)", () => {
  it("NFKC : pleine largeur et ligatures", () => {
    expect(normalizeText("ＡＢＣ ﬁ")).toBe("ABC fi");
    // composition des caractères décomposés
    expect(normalizeText("e\u0301")).toBe("é");
  });

  it("CRLF → LF (et CR seul)", () => {
    expect(normalizeText("a\r\nb\r\nc")).toBe("a\nb\nc");
    expect(normalizeText("a\rb")).toBe("a\nb");
  });

  it("trim des fins de ligne", () => {
    expect(normalizeText("a  \nb\t\nc ")).toBe("a\nb\nc");
  });

  it("max 2 lignes vides consécutives", () => {
    expect(normalizeText("a\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(normalizeText("a\n\n\n\nb\n\n\nc")).toBe("a\n\n\nb\n\n\nc");
  });

  it("préserve les fins de ligne uniques (paragraphes)", () => {
    expect(normalizeText("p1\n\np2\np3")).toBe("p1\n\np2\np3");
  });
});