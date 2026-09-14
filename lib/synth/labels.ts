/**
 * Vocabulaire des libellés (thèmes 5A → graines de synthèse).
 *
 * Reste de l'ancien module `themes.ts` : seul le calcul des libellés subsiste, le
 * clustering ayant été remplacé par les graines (`lib/synth/seeds.ts`). Tout est
 * déterministe, local, et sans appel réseau.
 */

/**
 * Libellé d'un ensemble de textes : termes les plus DISCRIMINANTS (TF-IDF), pas les
 * plus fréquents du corpus. `tf` = nombre de fragments de l'ensemble contenant le terme.
 *
 * `minDf` écarte les termes d'un seul fragment du corpus : sans ce plancher, l'idf
 * explose et le libellé d'une graine réelle était `disparoitre · forger · sourioient ·
 * calomniateur` — des coquilles d'OCR et des formes verbales rares, jamais le sujet.
 * Avec `minDf` : `histoire · homme · famille · siecle`. Le plancher est appliqué au
 * corpus, pas à l'ensemble libellé.
 */
export function labelCluster(
  texts: string[],
  df: Map<string, number>,
  corpusSize: number,
  opts: { terms?: number; fallbackIndex?: number; minDf?: number } = {}
): string {
  const terms = opts.terms ?? 4;
  const minDf = opts.minDf ?? 3;
  const tf = new Map<string, number>();
  for (const text of texts) {
    // présence par fragment (pas le comptage brut) : évite le biais des fragments longs
    for (const term of new Set(tokenize(text))) tf.set(term, (tf.get(term) ?? 0) + 1);
  }
  const scored = [...tf.entries()]
    .filter(([term]) => (df.get(term) ?? 0) >= minDf)
    .map(([term, count]) => ({
      term,
      score:
        (count / Math.max(1, texts.length)) *
        Math.log((corpusSize + 1) / ((df.get(term) ?? 0) + 1)),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const picked = scored.slice(0, terms).map((s) => s.term);
  if (picked.length > 0) return picked.join(" · ");
  // repli : un terme partagé trop rare pour être retenu vaut mieux qu'un libellé vide
  const shared = [...tf.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, terms)
    .map(([term]) => term);
  return shared.length > 0 ? shared.join(" · ") : `Grappe ${(opts.fallbackIndex ?? 0) + 1}`;
}

/** Termes significatifs d'un texte pour les libellés (minuscules, sans accents). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    // longueur ≥ 5 : écarte les résidus de césure/OCR (« é-tait » → « tait ») qui
    // polluaient les libellés du corpus réel sans rien dire du thème
    .filter((w) => w.length >= 5 && !/^\d+$/.test(w) && !LABEL_STOPWORDS.has(w));
}

/**
 * Mots vides pour les LIBELLÉS : mots-outils français + anglais (le corpus contient la
 * traduction anglaise de *Madame Bovary* : `their`, `herself`, `would` sortaient en tête
 * des libellés) + vocabulaire générique du document (texte, auteur, chapitre…) qui ne
 * dit rien du sujet.
 */
export const LABEL_STOPWORDS = new Set(
  `avait avaient aura aurait auraient soit soient fut furent sera serait seront
   tait taient etait etaient ete etre avoir ayant eu
   alors apres aussi autre autres avant avec avoir bien car cas ce cet cette ces chaque chez
   comme comment dans depuis des deux doit doivent donc dont elle elles encore entre est etait etaient ete etre
   eux fait faire faites fois font hors ici il ils jamais je jusqu leur leurs lorsque mais meme mes moins
   mon ne nos notre nous on ont ou oui par parce pas peut peuvent plus plusieurs pour pourquoi
   quand que quel quelle quelles quels qui quoi sans se ses si son sont sous souvent sur ta tandis tant te tes
   toi toujours ton tres trop tu un une vers vos votre vous y a au aux du de la le les
   ainsi cependant donc enfin ensuite etc exemple partie point sujet propos egard travers
   texte textes extrait extraits passage passages fragment fragments auteur auteurs oeuvre oeuvres
   livre livres page pages chapitre chapitres edition editions tome volume note notes
   citation citations paragraphe paragraphes ligne lignes mot mots phrase phrases
   premier premiere premiers premieres dernier derniere derniers dernieres
   apres avant depuis toutefois neanmoins pourtant cependant notamment surtout
   doit doit-on peut-on faut-il s agit s'agit
   about above after again against being below between both could doing during further hers herself himself
   itself myself ourselves should theirs themselves these those through under until upon very were what when
   where which while whom whose would yours yourself yourselves there their them they this that with have
   having does done made make many might must much other others some such than then only once over same`
    .split(/\s+/)
    .filter(Boolean)
);
