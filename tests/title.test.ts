import { describe, expect, it } from "vitest";
import {
  repairMojibake,
  sanitizeSourceTitle,
  titleFromContent,
} from "@/lib/ingest/title";

describe("sanitizeSourceTitle", () => {
  it("laisse passer un titre sain (aucune dégradation)", () => {
    const r = sanitizeSourceTitle("La Loi (Frédéric Bastiat).txt");
    expect(r.title).toBe("La Loi (Frédéric Bastiat).txt");
    expect(r.repaired).toBe(false);
    expect(r.source).toBe("given");
  });

  it("répare le mojibake réversible (« UTF-8 lu comme latin-1 »)", () => {
    // octets UTF-8 de « Frédéric » décodés en latin-1
    const mojibake = Buffer.from("La Loi (Frédéric Bastiat).txt", "utf8").toString("latin1");
    expect(mojibake).toBe("La Loi (FrÃ©dÃ©ric Bastiat).txt");
    const r = sanitizeSourceTitle(mojibake);
    expect(r.title).toBe("La Loi (Frédéric Bastiat).txt");
    expect(r.repaired).toBe(true);
  });

  it("ne répare PAS à l'aveugle quand U+FFFD a détruit l'octet : il se rabat sur le contenu", () => {
    // Cas réel : « La Loi (Frédéric Bastiat).txt » arrivé en CP1252 et décodé en UTF-8.
    // U+FFFD ne contient plus l'octet d'origine → aucune réparation exacte n'existe.
    const raw = "La Loi (Fr\uFFFDr\uFFFDric Bastiat).txt";
    const content = "Pour les autres utilisations de ce mot ou de ce titre, voir La Loi .\nFrédéric Bastiat";
    const r = sanitizeSourceTitle(raw, content);
    expect(r.title).not.toContain("\uFFFD");
    expect(r.title).toBe("Pour les autres utilisations de ce mot ou de ce titre, voir La Loi");
    expect(r.source).toBe("content");
    expect(r.repaired).toBe(true);
  });

  it("stocke un titre sans U+FFFD même sans contenu exploitable", () => {
    const r = sanitizeSourceTitle("La Loi (Fr\uFFFDr\uFFFDric Bastiat).txt", "\n\n");
    expect(r.title).not.toContain("\uFFFD");
    // Le retrait est assumé : les octets perdus ne peuvent pas être inventés.
    expect(r.title).toBe("La Loi (Frrric Bastiat).txt");
    expect(r.source).toBe("stripped");
  });

  it("titre vide et contenu vide → titre générique, jamais vide", () => {
    const r = sanitizeSourceTitle("", "");
    expect(r.title).toBe("Source sans titre");
  });

  it("remonte en priorité le mojibake réparable d'un titre déjà sans U+FFFD", () => {
    const mojibake = "M\u00c3\u00a9moire.pdf";
    expect(sanitizeSourceTitle(mojibake).title).toBe("Mémoire.pdf");
  });
});

describe("repairMojibake", () => {
  it("renvoie null quand il n'y a pas de mojibake (aucun effet de bord)", () => {
    expect(repairMojibake("Voyage au Centre de la Terre")).toBeNull();
    expect(repairMojibake("Les Confessions de Saint Augustin")).toBeNull();
  });

  it("refuse un texte contenant des caractères hors latin-1 (conversion destructrice)", () => {
    // « Â» suivi d'un caractère non latin-1 : la reconversion perdrait de l'information.
    expect(repairMojibake("Â\u2019x《")).toBeNull();
  });

  it("refuse une « réparation » qui produirait elle-même du U+FFFD", () => {
    // 0xC3 seul est une séquence UTF-8 incomplète → la réparation est refusée.
    expect(repairMojibake("\u00c3")).toBeNull();
  });
});

describe("titleFromContent", () => {
  it("ignore les lignes vides, trop courtes ou abîmées", () => {
    const content = "\n\nab\nLa Loi\nsuite";
    expect(titleFromContent(content)).toBe("La Loi");
  });

  it("ignore une ligne contenant U+FFFD et prend la suivante", () => {
    expect(titleFromContent("La L\uFFFD Loi\nFrédéric Bastiat")).toBe("Frédéric Bastiat");
  });

  it("ne descend pas indéfiniment dans le document", () => {
    const content = Array.from({ length: 60 }, () => "x").join("\n") + "\nTitre réel";
    expect(titleFromContent(content)).toBeNull();
  });

  it("retire la ponctuation finale parasites", () => {
    expect(titleFromContent("La Loi :")).toBe("La Loi");
  });
});
