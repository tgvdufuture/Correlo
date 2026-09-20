/**
 * Motifs de refus d'une lecture web (Phase 6, amendement v1.3 §13.4).
 *
 * **Pourquoi ce module est séparé du durcissement.** `lib/agent/web-guard.ts` importe
 * `node:dns/promises` : il ne peut pas entrer dans un bundle client. Or les libellés de ces
 * motifs sont affichés par l'écran, qui doit les lire depuis un module **pur**. Le
 * compilateur l'a dit à sa manière, et de façon nette — `npm run build` a échoué sur
 * `the chunking context (unknown) does not support external modules (request:
 * node:dns/promises)` dès que `lib/api-types.ts` a réexporté la table de libellés depuis le
 * durcissement. Le type et ses libellés vivent donc ici, sans aucune dépendance Node, et le
 * durcissement les réutilise (une seule règle, un seul endroit — la maison ne garde pas deux
 * copies d'un même vocabulaire).
 */

/** Motifs de refus d'une lecture web — tous **structurels**, aucun ne juge le contenu. */
export type WebRefusal =
  | "url_invalide"
  | "schema_refuse"
  | "adresse_locale"
  | "resolution_echec"
  | "redirection_refusee"
  | "http_echec"
  | "type_refuse"
  | "corps_trop_gros"
  | "lecture_echec";

/** Libellés affichables (l'écran montre le motif, jamais un code nu). */
export const WEB_REFUSAL_LABEL: Record<WebRefusal, string> = {
  url_invalide: "URL illisible",
  schema_refuse: "schéma refusé (http/https seulement, sans identifiants)",
  adresse_locale: "adresse locale ou privée refusée",
  resolution_echec: "hôte non résolu",
  redirection_refusee: "redirection refusée (ou trop de redirections)",
  http_echec: "réponse HTTP en erreur",
  type_refuse: "type de contenu non textuel",
  corps_trop_gros: "page au-delà du plafond de taille",
  lecture_echec: "lecture de la page impossible",
};
