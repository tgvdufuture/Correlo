import { z } from "zod";

/**
 * Sortie LLM de la synthèse d'un thème (PRD v1.3 §2.1-3).
 *
 * Le modèle ne renvoie jamais d'ID de fragment : il renvoie les **indices** des
 * preuves citées, assignés par le serveur. `FACT` n'est même pas représentable
 * ici — la base le refuserait (`CHECK`) — ce qui rend l'erreur impossible plutôt
 * que seulement déconseillée.
 */
export const SYNTHESIS_OUTPUT_SCHEMA = z.object({
  /** L'énoncé de synthèse (requis sauf si skip — cf. superRefine). */
  synthesis: z.string().trim().max(2000).optional(),
  relation_kind: z.enum(["combination", "extension", "tension", "application"]).optional(),
  /** Indices des preuves citées, attribués par le serveur. */
  evidence: z.array(z.number().int().min(0)).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  epistemic_status: z.enum(["INFERENCE", "HYPOTHESIS", "SPECULATION"]).optional(),
  /** true : rien à ajouter pour ce thème — c'est une réponse valide, pas un échec. */
  skip: z.boolean().optional(),
});

/**
 * Schéma du thème (construit par nombre de preuves) : les contrôles applicatifs
 * (indices dans les bornes, sans doublon, au moins 2 énoncés cités) passent par
 * Zod pour que le retry de correction du provider les couvre aussi — sinon un
 * indice halluciné consommerait un appel entier sans recours.
 */
export function makeSynthesisSchema(
  evidenceCount: number
): z.ZodType<z.infer<typeof SYNTHESIS_OUTPUT_SCHEMA>> {
  return SYNTHESIS_OUTPUT_SCHEMA.superRefine((val, ctx) => {
    if (val.skip) {
      if (val.synthesis || val.relation_kind || val.evidence || val.confidence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "skip et les autres champs sont mutuellement exclusifs",
        });
      }
      return;
    }
    for (const [field, value] of [
      ["synthesis", val.synthesis],
      ["relation_kind", val.relation_kind],
      ["evidence", val.evidence],
      ["confidence", val.confidence],
    ] as const) {
      if (!value || (Array.isArray(value) && value.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} requis hors skip`,
        });
      }
    }
    const indices = val.evidence ?? [];
    if (indices.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "une synthèse cite au moins 2 preuves",
      });
    }
    const seen = new Set<number>();
    for (const i of indices) {
      if (i >= evidenceCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `preuve ${i} hors du jeu fourni (${evidenceCount} preuves)`,
        });
      }
      if (seen.has(i)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `preuve ${i} citée deux fois` });
      }
      seen.add(i);
    }
  });
}

export interface AttachedSynthesisResult {
  synthesis: string;
  relationKind: "combination" | "extension" | "tension" | "application" | null;
  /** Indices cités, dédupliqués et sans répétition (ordonnés comme renvoyés). */
  evidenceIndices: number[];
  confidence: "low" | "medium" | "high" | null;
  epistemicStatus: "INFERENCE" | "HYPOTHESIS" | "SPECULATION" | null;
  skipped: boolean;
}

/** Rattache la sortie validée au thème (le serveur rattache, jamais le modèle). */
export function attachSynthesisResult(
  parsed: z.infer<typeof SYNTHESIS_OUTPUT_SCHEMA>
): AttachedSynthesisResult {
  return {
    synthesis: parsed.synthesis ?? "",
    relationKind: parsed.relation_kind ?? null,
    evidenceIndices: parsed.evidence ?? [],
    confidence: parsed.confidence ?? null,
    epistemicStatus: parsed.epistemic_status ?? null,
    skipped: parsed.skip === true,
  };
}
