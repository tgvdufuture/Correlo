import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { Db } from "@/lib/db/client";
import { buildCorpusIndex } from "@/lib/agent/retrieval";
import { contentWords, stemOf } from "@/lib/quality/lexical-anchor";

/**
 * Mesure : que partage **réellement** un fragment retenu par `search` avec la question ?
 *
 * Née d'un **tour réel** (2026-09-20) qui a déclaré `corpus_suffisant` sur cette question :
 * « Que disent les documents sur la régulation européenne des batteries lithium et le
 * recyclage des véhicules électriques ? » — le corpus (12 œuvres du XIXᵉ) n'en parle
 * évidemment pas, mais la recherche lexicale a rendu **4 fragments de 4 sources
 * distinctes** (Madame Bovary, La chasse au météore, Vie de Jésus…), donc le critère de
 * déverrouillage du web (§13.4) a conclu que le corpus suffisait.
 *
 * Ce que la mesure établit, et qui **écarte le correctif évident** : exiger « au moins
 * deux racines partagées » ne sépare pas le bruit du pertinent — les fragments hors sujet
 * en partagent 2, voire 3, parce que la requête du modèle est longue et que ses racines
 * (`regul`, `elect`, `disen`, `comme`) sont banales. Une question légitime
 * (« Que dit Claude Bernard sur l'observation et l'expérience ? ») partage exactement le
 * même profil (2 racines). **Aucun seuil de comptage de racines ne fait la différence** ;
 * c'est le même mur que la Phase 4 avait mesuré (0,27 de recouvrement, §11.3).
 *
 * Le test **chiffre le contre-exemple** : si un jour la recherche lexicale cesse de rendre
 * du bruit multi-sources, il le dira — et la décision pourra être revue sur une mesure
 * neuve plutôt que sur un souvenir.
 *
 * Sur demande, jamais dans la suite ordinaire : il lit le **corpus réel** (un corpus
 * différent donnerait d'autres chiffres, et une mesure qui dépend du contenu de la base n'a
 * rien à faire dans un test qui doit être déterministe) :
 *
 *     MEASURE_UNLOCK=1 npx vitest run tests/measure-unlock.test.ts
 */
const DB = process.env.DATABASE_PATH ?? "data/correlo.db";
const measure = process.env.MEASURE_UNLOCK === "1";

const QUESTIONS = [
  "Que disent les documents sur la régulation européenne des batteries lithium et le recyclage des véhicules électriques ?",
  "Qu'est-ce que le doute méthodique selon Descartes ?",
  "Que dit Claude Bernard sur l'observation et l'expérience ?",
  "Comment Montesquieu décrit-il la séparation des pouvoirs ?",
  "Quelles sont les règles de la conversation et des échanges selon les documents ?",
];

describe.skipIf(!measure || !existsSync(DB))("mesure : ce que la recherche lexicale partage avec la question", () => {
  it("chiffre le contre-exemple : du bruit hors sujet atteint le même nombre de racines qu'une question légitime", () => {
    // lecture seule : la base du corpus réel n'est jamais écrite par une mesure
    const db = new Database(DB, { readonly: true }) as unknown as Db;
    const index = buildCorpusIndex(db);
    console.log(`corpus : ${index.size} fragments`);

    for (const question of QUESTIONS) {
      const stems = new Set(contentWords(question).map(stemOf));
      const hits = index.search(question, 6);
      const rows = hits.map((f) => {
        const own = new Set(contentWords(f.text).map(stemOf));
        const shared = [...stems].filter((s) => own.has(s));
        return {
          shared,
          title: (f.sourceTitle ?? "?").slice(0, 26),
          preview: f.text.replace(/\s+/g, " ").slice(0, 90),
        };
      });
      const byCount = new Map<number, number>();
      for (const r of rows) byCount.set(r.shared.length, (byCount.get(r.shared.length) ?? 0) + 1);
      console.log(`\n« ${question} »`);
      console.log(
        `  racines de la question : ${[...stems].join(", ")}`
      );
      console.log(
        `  ${rows.length} fragment(s) retenu(s) → ` +
          [...byCount.entries()].sort().map(([n, c]) => `${n} racine(s) partagée(s) : ${c}`).join(" | ")
      );
      for (const r of rows) {
        console.log(`    ${r.shared.length}× [${r.shared.join(",")}] ${r.title} — ${r.preview}`);
      }
    }

    // le contre-exemple, chiffré : la question hors corpus rend du bruit **multi-source**
    // partageant **plusieurs** racines — donc « corpus_suffisant », donc aucun outil web
    const noise = shares(QUESTIONS[0], 2);
    expect(noise.length).toBeGreaterThanOrEqual(4);
    expect(new Set(noise.map((r) => r.sourceId)).size).toBeGreaterThanOrEqual(2);
    // et une question légitime ne se distingue pas par ce comptage : même profil
    const legit = shares(QUESTIONS[2], 2);
    expect(legit.length).toBeGreaterThanOrEqual(2);
    db.close();

    function shares(question: string, min: number) {
      const stems = new Set(contentWords(question).map(stemOf));
      return index.search(question, 8).flatMap((f) => {
        const own = new Set(contentWords(f.text).map(stemOf));
        const shared = [...stems].filter((s) => own.has(s));
        return shared.length >= min ? [{ sourceId: f.sourceId, shared }] : [];
      });
    }
  });
});
