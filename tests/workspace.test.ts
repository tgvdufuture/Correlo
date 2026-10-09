import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKSPACE_DEFAULT_LINES,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_READ_BYTES,
  WorkspaceRefusalError,
  createWorkspace,
  workspaceExcerpt,
} from "@/lib/agent/workspace";

/**
 * Phase 6 — le workspace (amendement v1.3 §13.5, AC3).
 *
 * Ce qui est testé ici est le **confinement**, pas la pertinence : racine, liens symboliques,
 * plages, plafonds, texte seulement. Aucun réseau, aucune base.
 */

const dirs: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "correlo-ws-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Le lecteur, plus le refus attendu — écrit une fois pour ne pas répéter le try/catch. */
function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorkspaceRefusalError) return e.refusal;
    throw e;
  }
  throw new Error("aucun refus levé");
}

/**
 * Les liens symboliques de dossier (`junction`) ne demandent pas de privilège sur Windows.
 * Si la plateforme refuse malgré tout, les deux tests de lien sont **sautés** plutôt que
 * d'échouer pour une raison qui ne concerne pas le code testé.
 */
const symlinksSupported = (() => {
  const base = tmpRoot();
  const target = path.join(base, "cible");
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, path.join(base, "lien"), "junction");
    return true;
  } catch {
    return false;
  }
})();

describe("le lecteur du workspace", () => {
  it("n'existe pas sans racine — et un appel direct refuse au lieu de lire", () => {
    const reader = createWorkspace("");
    expect(reader.enabled).toBe(false);
    expect(reader.root).toBeNull();
    expect(refusalOf(() => reader.read({ path: "notes.md" }))).toBe("racine_absente");

    const undefinedRoot = createWorkspace(undefined);
    expect(undefinedRoot.enabled).toBe(false);
    expect(refusalOf(() => undefinedRoot.read({ path: "notes.md" }))).toBe("racine_absente");
  });

  it("lit une plage de lignes et rend le chemin **relatif** à la racine", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "notes.md"), ["un", "deux", "trois", "quatre", "cinq"].join("\n"));
    const reader = createWorkspace(root);
    expect(reader.enabled).toBe(true);

    const read = reader.read({ path: "notes.md", from: 2, to: 4 });
    expect(read.text).toBe("deux\ntrois\nquatre");
    expect(read.path).toBe("notes.md");
    expect(read.from_line).toBe(2);
    expect(read.to_line).toBe(4);
    expect(read.lines).toBe(3);
    expect(read.bytes).toBe(Buffer.byteLength("deux\ntrois\nquatre"));

    // un sous-dossier garde la forme portable `/`, même sur Windows
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "protocole.md"), "ligne\n");
    expect(reader.read({ path: "docs/protocole.md" }).path).toBe("docs/protocole.md");
  });

  it("sans fin demandée, rend une fenêtre bornée plutôt que « tout le fichier »", () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, "long.txt"),
      Array.from({ length: WORKSPACE_DEFAULT_LINES + 50 }, (_, i) => `ligne ${i + 1}`).join("\n")
    );
    const read = createWorkspace(root).read({ path: "long.txt" });
    expect(read.from_line).toBe(1);
    expect(read.to_line).toBe(WORKSPACE_DEFAULT_LINES);

    // et la fin demandée explicitement est bornée à la dernière ligne réelle
    const tail = createWorkspace(root).read({ path: "long.txt", from: 240, to: 9_999 });
    expect(tail.to_line).toBe(WORKSPACE_DEFAULT_LINES + 50);
  });

  it("refuse tout ce qui sort de la racine, `..` compris", () => {
    // même parent pour la racine et le dehors : `../` doit tomber sur un fichier **existant**,
    // sinon la sortie se confondrait avec « chemin introuvable » et le test ne prouverait rien
    const base = tmpRoot();
    const root = path.join(base, "racine");
    const outside = path.join(base, "dehors");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.writeFileSync(path.join(root, "notes.md"), "notes");
    const reader = createWorkspace(root);

    expect(refusalOf(() => reader.read({ path: "../dehors/secret.txt" }))).toBe(
      "chemin_hors_racine"
    );
    expect(refusalOf(() => reader.read({ path: "interne/../../dehors/secret.txt" }))).toBe(
      "chemin_hors_racine"
    );
    expect(refusalOf(() => reader.read({ path: path.join(outside, "secret.txt") }))).toBe(
      "chemin_hors_racine"
    );
    // et un chemin absolu **dans** la racine reste légitime : c'est la résolution qui décide
    expect(reader.read({ path: path.join(root, "notes.md") }).text).toBe("notes");
  });

  it.skipIf(!symlinksSupported)("résout les liens symboliques et refuse ceux qui sortent", () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.mkdirSync(path.join(root, "interne"));
    fs.writeFileSync(path.join(root, "interne", "notes.md"), "notes internes");
    // lien qui reste dedans : autorisé
    fs.symlinkSync(path.join(root, "interne"), path.join(root, "raccourci"), "junction");
    // lien qui sort : refusé — c'est le contournement que le confinement doit voir
    fs.symlinkSync(outside, path.join(root, "evasion"), "junction");
    const reader = createWorkspace(root);

    expect(reader.read({ path: "raccourci/notes.md" }).text).toBe("notes internes");
    expect(refusalOf(() => reader.read({ path: "evasion/secret.txt" }))).toBe("chemin_hors_racine");
  });

  it("refuse un dossier — et n'énumère jamais son contenu", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "a.md"), "a");
    const reader = createWorkspace(root);

    expect(refusalOf(() => reader.read({ path: "." }))).toBe("cible_non_fichier");
    expect(refusalOf(() => reader.read({ path: "docs" }))).toBe("cible_non_fichier");
    // l'objet rendu n'expose que `read` (et la résolution de la racine) : aucune surface
    // pour lister un dossier ou écrire un fichier
    expect(Object.keys(reader).sort()).toEqual(["enabled", "read", "resolve", "root"]);
  });

  it("ne sert pas de fichier non textuel, et pas un fichier au-delà du plafond", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "binaire.bin"), Buffer.from([0x50, 0x44, 0x46, 0x00, 0x01]));
    fs.writeFileSync(path.join(root, "enorme.txt"), "a".repeat(WORKSPACE_MAX_FILE_BYTES + 1));
    const reader = createWorkspace(root);

    expect(refusalOf(() => reader.read({ path: "binaire.bin" }))).toBe("fichier_binaire");
    expect(refusalOf(() => reader.read({ path: "enorme.txt" }))).toBe("fichier_trop_gros");
  });

  it("refuse une plage incohérente, hors texte, ou trop longue pour une copie", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "notes.md"), ["a", "b", "c"].join("\n"));
    // 300 Ko de texte : sous le plafond du **fichier**, au-dessus du plafond de la **copie**
    fs.writeFileSync(
      path.join(root, "gros.txt"),
      Array.from({ length: 6_000 }, (_, i) => `ligne ${i + 1} ${"x".repeat(60)}`).join("\n")
    );
    const reader = createWorkspace(root);

    expect(refusalOf(() => reader.read({ path: "notes.md", from: 0 }))).toBe("plage_invalide");
    expect(refusalOf(() => reader.read({ path: "notes.md", from: 3, to: 1 }))).toBe("plage_invalide");
    expect(refusalOf(() => reader.read({ path: "notes.md", from: 99 }))).toBe("plage_hors_texte");
    expect(refusalOf(() => reader.read({ path: "gros.txt", from: 1, to: 6_000 }))).toBe(
      "plage_trop_longue"
    );
    // la même plage, plus courte, passe : le refus dit quoi faire
    const narrow = reader.read({ path: "gros.txt", from: 1, to: 100 });
    expect(narrow.bytes).toBeLessThan(WORKSPACE_MAX_READ_BYTES);
    // et sans fin demandée, la fenêtre par défaut tient le plafond sans refuser
    expect(reader.read({ path: "gros.txt" }).bytes).toBeLessThan(WORKSPACE_MAX_READ_BYTES);
  });

  it("décode un fichier non UTF-8 par la chaîne de l'ingestion, pas par devinette", () => {
    const root = tmpRoot();
    // « é » en windows-1252 : le décodage strict UTF-8 échoue, le repli cp1252 s'applique
    fs.writeFileSync(path.join(root, "cp1252.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(createWorkspace(root).read({ path: "cp1252.txt" }).text).toBe("café\n");
  });

  it("distingue un chemin vide d'un chemin inexistant, et signale une racine inutilisable", () => {
    const root = tmpRoot();
    const reader = createWorkspace(root);
    expect(refusalOf(() => reader.read({ path: "   " }))).toBe("chemin_invalide");
    expect(refusalOf(() => reader.read({ path: "absent.md" }))).toBe("chemin_introuvable");

    const broken = createWorkspace(path.join(root, "pas-la"));
    expect(broken.enabled).toBe(true);
    expect(broken.resolve()).toBeNull();
    expect(refusalOf(() => broken.read({ path: "notes.md" }))).toBe("racine_invalide");

    // la résolution n'est **pas** une copie de l'état du disque : un dossier qui apparaît
    // après la construction est lu sans redémarrer (défaut mesuré en vérification navigateur,
    // où le serveur démarre avant que la racine existe)
    fs.mkdirSync(path.join(root, "pas-la"));
    fs.writeFileSync(path.join(root, "pas-la", "notes.md"), "deux mesures");
    expect(broken.read({ path: "notes.md" }).text).toBe("deux mesures");

    fs.writeFileSync(path.join(root, "un-fichier.txt"), "x");
    const fileAsRoot = createWorkspace(path.join(root, "un-fichier.txt"));
    expect(fileAsRoot.resolve()).toBeNull();
    expect(refusalOf(() => fileAsRoot.read({ path: "notes.md" }))).toBe("racine_invalide");
  });

  it("la copie citée est normalisée et plafonnée — c'est le serveur qui la produit", () => {
    expect(workspaceExcerpt("a\n\n  b\tc  ")).toBe("a b c");
    const long = workspaceExcerpt("x".repeat(5_000));
    expect(long.length).toBe(1_200);
    expect(long.endsWith("…")).toBe(true);
  });
});
