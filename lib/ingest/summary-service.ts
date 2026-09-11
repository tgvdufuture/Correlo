import { z } from "zod";
import type { Db } from "@/lib/db/client";
import type { SourcesRepo } from "@/lib/repositories/sources";
import type { JobRow, JobsRepo } from "@/lib/repositories/jobs";
import type { LlmProvider, ChatMessage } from "@/lib/llm/types";

export const SUMMARY_PROMPT_VERSION = "summary-v1";

export const SummarySchema = z.object({
  summary: z.string().min(1),
});

export interface SummaryDeps {
  db: Db;
  sources: SourcesRepo;
  jobs: JobsRepo;
  llm: LlmProvider;
  /** Nom du modèle de chat (métadonnées/idempotency). */
  chatModel: string;
  /** Vrai si LLM_CHAT_PROVIDER=groq sans GROQ_API_KEY (US-10 AC3). */
  groqKeyMissing: boolean;
}

/**
 * Résumé de source : routage uniquement, jamais citable (PRD §3.2).
 * Sans clé Groq ⇒ summary_status='failed' avec erreur structurée
 * missing_groq_api_key, 0 retry automatique.
 */
export class SummaryService {
  constructor(private deps: SummaryDeps) {}

  /** Marque la source en summary_status='failed' (échec permanent du job). */
  markSourceSummaryFailed(sourceId: string): void {
    this.deps.sources.setSummaryFailed(sourceId);
  }

  async runSummary(job: JobRow): Promise<void> {
    const payload = JSON.parse(job.payload) as { source_id: string };
    const source = this.deps.sources.getById(payload.source_id);
    if (!source) return; // source supprimée

    if (source.raw_content.length < 100) {
      // URL en cours d'ingestion : réessayer plus tard sans consommer d'attempt
      this.deps.jobs.requeue(job.id, job.lease_token as string, new Date(Date.now() + 5000).toISOString());
      return;
    }

    if (this.deps.groqKeyMissing) {
      this.deps.sources.setSummaryFailed(source.id);
      this.deps.jobs.fail(
        job.id,
        job.lease_token as string,
        JSON.stringify({
          code: "missing_groq_api_key",
          message:
            "GROQ_API_KEY manquante : renseigner .env.local (ou LLM_CHAT_PROVIDER=ollama), puis relancer le résumé.",
        })
      );
      return;
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          'Tu résumes des documents pour un penseur solo. Réponds UNIQUEMENT en JSON : {"summary": string} avec 2 à 3 phrases factuelles. N\'invente aucun fait absent du texte.',
      },
      {
        role: "user",
        content: `Résume le texte source suivant :\n\n---\n${source.raw_content.slice(0, 12_000)}\n---`,
      },
    ];

    const out = await this.deps.llm.chat(messages, SummarySchema);
    this.deps.sources.setSummaryDone(source.id, out.summary);
    this.deps.jobs.complete(job.id, job.lease_token as string);
  }
}