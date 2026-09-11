import { z } from "zod";

/** Sortie LLM d'un batch : candidate_id attribués par le serveur, jamais d'IDs de fragments. */
export const DISCOVERY_OUTPUT_SCHEMA = z.object({
  results: z.array(
    z.object({
      candidate_id: z.number().int().min(0),
      /** Requis sauf si skip — cf. superRefine du schéma de batch. */
      claim: z.string().trim().max(2000).optional(),
      relation_type: z.enum(["analogy", "contradiction", "cause"]).optional(),
      tier: z.enum(["strong", "medium", "weak"]).optional(),
      epistemic_status: z.enum(["FACT", "INFERENCE", "HYPOTHESIS", "SPECULATION"]).optional(),
      cause_fragment: z.enum(["a", "b"]).optional(),
      /** true : aucune connexion convaincante pour cette paire — pas de suggestion. */
      skip: z.boolean().optional(),
    })
  ),
});

/**
 * Schéma du batch (construit par taille de batch) : la validation applicative
 * (candidate_id dans les bornes, sans doublon, cause_fragment requis) passe par
 * Zod pour que le retry de correction du provider couvre aussi ces erreurs.
 */
export function makeDiscoveryBatchSchema(batchSize: number): z.ZodType<z.infer<typeof DISCOVERY_OUTPUT_SCHEMA>> {
  return DISCOVERY_OUTPUT_SCHEMA.superRefine((val, ctx) => {
    const seen = new Set<number>();
    for (const r of val.results) {
      if (r.candidate_id >= batchSize) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `candidate_id ${r.candidate_id} hors du batch (taille ${batchSize})`,
        });
      }
      if (seen.has(r.candidate_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `candidate_id ${r.candidate_id} dupliqué`,
        });
      }
      seen.add(r.candidate_id);
      // cause sans cause_fragment : toléré par le schéma (le service ignore alors
      // l'entrée — un oubli du modèle ne fait pas échouer tout le batch).
      if (r.skip) {
        // objet skip pur : aucun autre champ n'est attendu
        if (r.claim) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `candidate_id ${r.candidate_id} : skip et claim mutuellement exclusifs`,
          });
        }
      } else {
        for (const [field, value] of [
          ["claim", r.claim],
          ["relation_type", r.relation_type],
          ["tier", r.tier],
          ["epistemic_status", r.epistemic_status],
        ] as const) {
          if (!value) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `candidate_id ${r.candidate_id} : ${field} requis`,
            });
          }
        }
      }
    }
  });
}

export interface AttachedResult {
  candidateId: number;
  claim: string;
  relationType: "analogy" | "contradiction" | "cause" | null;
  tier: "strong" | "medium" | "weak" | null;
  epistemicStatus: "FACT" | "INFERENCE" | "HYPOTHESIS" | "SPECULATION" | null;
  causeSide: "a" | "b" | null;
  skipped: boolean;
}

/** Rattache les résultats validés aux paires du batch (le serveur rattache, jamais le modèle). */
export function attachResults(parsed: z.infer<typeof DISCOVERY_OUTPUT_SCHEMA>): AttachedResult[] {
  return parsed.results.map((r) => ({
    candidateId: r.candidate_id,
    claim: r.claim ?? "",
    relationType: r.relation_type ?? null,
    tier: r.tier ?? null,
    epistemicStatus: r.epistemic_status ?? null,
    causeSide: r.cause_fragment ?? null,
    skipped: r.skip === true,
  }));
}