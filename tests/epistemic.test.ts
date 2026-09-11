import { describe, expect, it } from "vitest";
import {
  canonicalizeClaim,
  contentSig,
  normalizeEpistemicStatus,
  pairKeyFor,
} from "@/lib/discover/epistemic";

describe("épistémique (statuts, content_sig, pair_key)", () => {
  it("canonicalise un claim : NFKC, minuscules, espaces, ponctuation finale", () => {
    expect(canonicalizeClaim("  La Loi, c'est   la Justice. ")).toBe("la loi, c'est la justice");
    expect(canonicalizeClaim("Causa…!")).toBe("causa");
    expect(canonicalizeClaim("ÉLÉGANT")).toBe("élégant");
  });

  it("content_sig : stable et discriminant", () => {
    expect(contentSig("La Loi.")).toBe(contentSig("  la loi "));
    expect(contentSig("La Loi")).not.toBe(contentSig("La Loi et l'Ordre"));
  });

  it("FACT : conservé si le claim est textuellement présent (match normalisé)", () => {
    const fragA = "La loi, c'est la justice. Tout le reste est accessoire.";
    expect(normalizeEpistemicStatus("FACT", "La Loi, c'est la Justice", fragA, "autre texte")).toBe(
      "FACT"
    );
  });

  it("FACT : rétrogradé en INFERENCE si absent des deux fragments cités", () => {
    expect(
      normalizeEpistemicStatus("FACT", "Le ciel est vert pomme", "Fragment A sans rapport", "Fragment B aussi")
    ).toBe("INFERENCE");
  });

  it("les statuts non-FACT sont conservés", () => {
    expect(normalizeEpistemicStatus("HYPOTHESIS", "x", "a", "b")).toBe("HYPOTHESIS");
    expect(normalizeEpistemicStatus("SPECULATION", "x", "a", "b")).toBe("SPECULATION");
  });

  it("pair_key : analogy/contradiction triés, cause ordonnée cause:effet", () => {
    expect(pairKeyFor("analogy", "bb", "aa", null)).toBe("aa:bb");
    expect(pairKeyFor("contradiction", "bb", "aa", null)).toBe("aa:bb");
    expect(pairKeyFor("cause", "bb", "aa", "b")).toBe("aa:bb"); // b est la cause
    expect(pairKeyFor("cause", "bb", "aa", "a")).toBe("bb:aa"); // a est la cause
  });
});