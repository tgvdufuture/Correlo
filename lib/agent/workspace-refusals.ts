/**
 * Motifs de refus d'une lecture de fichier (Phase 6, amendement v1.3 §13.5, AC3).
 *
 * **Pourquoi un module séparé, comme pour le web.** `lib/agent/workspace.ts` importe
 * `node:fs` et `node:path` : il ne peut pas entrer dans un bundle client. Or ces motifs
 * **sont affichés** (l'écran montre ce que l'agent a tenté de lire et ce qui a été refusé),
 * et ils sont aussi la catégorie du problème constaté à la relecture d'une citation. Le type
 * et ses libellés vivent donc ici, sans aucune dépendance Node — la même raison que
 * `web-refusals.ts`, et la même règle : un seul vocabulaire, un seul endroit.
 *
 * Tous sont **structurels** : aucun ne juge le contenu du fichier.
 */

/** Motifs de refus d'une lecture dans le workspace. */
export type WorkspaceRefusal =
  /** Chemin vide, illisible, ou contenant un octet nul. */
  | "chemin_invalide"
  /** Chemin résolu hors de la racine confinée (liens symboliques compris). */
  | "chemin_hors_racine"
  /** Le chemin n'existe pas (ou n'est pas atteignable). */
  | "chemin_introuvable"
  /** La cible existe mais n'est pas un fichier ordinaire (dossier, lien nommé, périphérique). */
  | "cible_non_fichier"
  /** Fichier au-delà du plafond de lecture (`WORKSPACE_MAX_FILE_BYTES`). */
  | "fichier_trop_gros"
  /** Octet nul dans le fichier : ce n'est pas du texte, on ne le sert pas. */
  | "fichier_binaire"
  /** Plage demandée incohérente (début < 1, fin avant le début). */
  | "plage_invalide"
  /** La plage commence après la dernière ligne du fichier. */
  | "plage_hors_texte"
  /** La plage rendue dépasserait le plafond de copie (`WORKSPACE_MAX_READ_BYTES`). */
  | "plage_trop_longue"
  /** La racine configurée n'existe pas ou n'est pas un dossier (`WORKSPACE_ROOT`). */
  | "racine_invalide"
  /** Aucune racine configurée : l'outil n'existe pas, et un appel direct refuse aussi. */
  | "racine_absente"
  /** Échec d'entrée/sortie non classé. */
  | "lecture_echec";

export const WORKSPACE_REFUSAL_LABEL: Record<WorkspaceRefusal, string> = {
  chemin_invalide: "chemin illisible",
  chemin_hors_racine: "chemin hors de la racine confinée",
  chemin_introuvable: "chemin introuvable",
  cible_non_fichier: "la cible n'est pas un fichier",
  fichier_trop_gros: "fichier au-delà du plafond de lecture",
  fichier_binaire: "fichier non textuel",
  plage_invalide: "plage de lignes incohérente",
  plage_hors_texte: "plage au-delà de la fin du fichier",
  plage_trop_longue: "plage trop longue pour une copie citée",
  racine_invalide: "racine du workspace illisible",
  racine_absente: "aucun workspace configuré",
  lecture_echec: "lecture du fichier impossible",
};

/**
 * Ce qui rend une citation de fichier **non fiable** à la relecture (AC1/AC3).
 *
 * Asymétrie assumée, et c'est le point de conception : une copie **web** ne peut pas être
 * revérifiée (la page peut changer, et la relire serait une requête réseau déclenchée par un
 * rendu) — elle est **datée**. Un fichier du workspace, lui, est **local** : on le relit à
 * chaque affichage, et la citation n'est valable que si la plage est **identique** à ce
 * qu'elle était pendant le tour. Un fichier modifié depuis ne « vieillit » pas : il **cesse
 * d'appuyer** l'affirmation.
 */
export type WorkspaceProblem =
  /** Le tour n'a jamais lu cette plage : rien à vérifier, donc rien à afficher comme preuve. */
  | "lecture_absente"
  /** La copie enregistrée ne correspond plus à la lecture du tour, ou au fichier d'aujourd'hui. */
  | "copie_modifiee"
  /** Le fichier n'est plus lisible (supprimé, devenu un dossier, binaire, hors plafond…). */
  | "fichier_illisible"
  /** Le chemin sort aujourd'hui de la racine confinée (lien symbolique changé, racine déplacée). */
  | "hors_racine"
  /** Plus aucune racine configurée : la plage ne peut pas être revérifiée. */
  | "racine_absente";

export const WORKSPACE_PROBLEM_LABEL: Record<WorkspaceProblem, string> = {
  lecture_absente: "plage jamais lue pendant ce tour",
  copie_modifiee: "copie de la plage modifiée depuis le tour",
  fichier_illisible: "fichier absent ou illisible aujourd'hui",
  hors_racine: "chemin hors de la racine confinée",
  racine_absente: "aucun workspace configuré : plage non revérifiable",
};
