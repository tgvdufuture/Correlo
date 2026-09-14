import type { z } from "zod";
import type { Db } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";
import { decodeEmbedding } from "@/lib/llm/embedding-codec";
import type { LlmProvider, PromptCache } from "@/lib/llm/types";
import { DISCOVERY_PROMPT_VERSION, buildDiscoveryPrompt } from "@/lib/discover/prompts";
import { makeDiscoveryBatchSchema, attachResults, type AttachedResult } from "@/lib/discover/parser";
import {
  contentSig,
  normalizeEpistemicStatus,
  pairKeyFor,
  type EpistemicStatus,
} from "@/lib/discover/epistemic";
import { makeSeed, samplePairs, type PairCandidate } from "@/lib/discover/sampler";
import { claimTokens, isNearDuplicateClaim, rejectClaim } from "@/lib/discover/claim-rules";
import type { SuggestionsRepo } from "@/lib/repositories/suggestions";
import { LlmRateLimitError } from "@/lib/llm/errors";

export interface DiscoveryRunOptions {
  runId: string;
  sampler: "diversified" | "top6";
  maxPairs?: number;
  maxPairsPerSource?: number;
  batchSize?: number;
  /** Reprise au checkpoint : nombre de paires déjà traitées (0 = début). */
  startBatch?: number;
  /**
   * Compteurs cumulés d'une tentative précédente (reprise au checkpoint) : sans eux
   * un run repris après une coupure perdrait les suggestions déjà créées dans son
   * rapport (et sous-estimerait les appels batch consommés).
   */
  resume?: {
    createdIds?: string[];
    batchCalls?: number;
    batchCallsFromCache?: number;
    skipped?: Partial<DiscoveryRunResult["skipped"]>;
  };
  /** Troncature des fragments dans le prompt (quotas d'entrée du provider). */
  maxFragmentChars?: number;
  /** Pause entre deux batchs (fenêtre ITPM du provider, ex. 65 s sur Groq free). */
  interBatchDelayMs?: number;
  /** Cache par hash de prompt (modèle + prompt_version + contenu) — évite de re-payer un batch identique. */
  promptCache?: PromptCache;
  /** Progression cumulée (reprise incluse) — persistée par le worker pour survivre à une coupure. */
  onProgress?: (info: {
    processed: number;
    total: number;
    created: number;
    createdIds: string[];
    batchCalls: number;
    batchCallsFromCache: number;
    skipped: DiscoveryRunResult["skipped"];
  }) => void;
}

export interface CreatedSuggestion {
  id: string;
  claim: string;
  relationType: AttachedResult["relationType"];
  tier: AttachedResult["tier"];
  epistemicStatus: EpistemicStatus;
  pairKey: string;
  a: { id: string; sourceId: string; sourceTitle: string | null; text: string };
  b: { id: string; sourceId: string; sourceTitle: string | null; text: string };
}

export interface DiscoveryRunResult {
  runId: string;
  corpusHash: string;
  seed: string;
  sampler: DiscoveryRunOptions["sampler"];
  pairsTotal: number;
  batchCalls: number;
  batchCallsFromCache: number;
  created: CreatedSuggestion[];
  /** Ids de toutes les suggestions créées par le run, tentatives précédentes incluses. */
  createdIds: string[];
  skipped: {
    duplicate: number;
    blocked: number;
    intraSource: number;
    fragmentMissing: number;
    /** cause sans cause_fragment (sens inconnu — pair_key impossible). */
    causeSideMissing: number;
    /** entrée non-skippée incomplète (champs requis manquants — ne devrait pas arriver). */
    invalidEntry: number;
    /** claim refusé par la barrière déterministe (générique, placeholder, anglais, fourre-tout). */
    claimRejected: number;
    /** claim reformulant une idée déjà retenue dans ce run (quasi-doublon inter-paires). */
    nearDuplicate: number;
  };
}

interface CorpusFragment {
  id: string;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
}

/**
 * Pipeline Phase 2A : fragments du corpus → candidats Q20 → batchs LLM (8–10 paires,
 * candidate_id serveur, sortie Zod-validée) → normalisation épistémique → insertion.
 * Contraintes §3.2 appliquées : cross-source, dédup, variantes bloquées, jamais de résumé.
 */
export class DiscoveryService {
  constructor(
    private deps: {
      db: Db;
      suggestions: SuggestionsRepo;
      chat: LlmProvider;
      chatModel: string;
      /**
       * Signature du **réglage** du chat (modèle + effort de raisonnement + budget).
       * Entre dans la clé de cache : un même prompt n'a pas la même réponse selon
       * que le modèle raisonne ou non (mesuré : 10 skips → 10 synthèses).
       */
      chatSignature?: string;
      /** Cache persisté (worker) ou en mémoire (tests). Surchargeable par run. */
      promptCache?: PromptCache;
    }
  ) {}

  async run(sourceIds: string[], opts: DiscoveryRunOptions): Promise<DiscoveryRunResult> {
    const maxPairs = opts.maxPairs ?? 200;
    // batchs de 3 paires (fragments intégraux) : quota d'entrée réel du provider
    // (7 000 tokens/min sur Groq free) — déviation documentée vs « batchs 8-10 »
    const batchSize = opts.batchSize ?? 3;
    const fragments = this.loadFragments(sourceIds);
    const corpusHash = this.computeCorpusHash(sourceIds);
    const seed = makeSeed(corpusHash, opts.runId);

    const pairs = samplePairs({
      fragments,
      seedHex: seed,
      sampler: opts.sampler,
      maxPairs,
      maxPairsPerSource: opts.maxPairsPerSource,
    });
    const startIdx = Math.min(Math.max(opts.startBatch ?? 0, 0), pairs.length);
    const resumeSkipped = opts.resume?.skipped ?? {};

    const result: DiscoveryRunResult = {
      runId: opts.runId,
      corpusHash,
      seed,
      sampler: opts.sampler,
      pairsTotal: pairs.length,
      batchCalls: opts.resume?.batchCalls ?? 0,
      batchCallsFromCache: opts.resume?.batchCallsFromCache ?? 0,
      created: [],
      createdIds: [...(opts.resume?.createdIds ?? [])],
      skipped: {
        duplicate: resumeSkipped.duplicate ?? 0,
        blocked: resumeSkipped.blocked ?? 0,
        intraSource: resumeSkipped.intraSource ?? 0,
        fragmentMissing: resumeSkipped.fragmentMissing ?? 0,
        causeSideMissing: resumeSkipped.causeSideMissing ?? 0,
        invalidEntry: resumeSkipped.invalidEntry ?? 0,
        claimRejected: resumeSkipped.claimRejected ?? 0,
        nearDuplicate: resumeSkipped.nearDuplicate ?? 0,
      },
    };
    const byId = new Map(fragments.map((f) => [f.id, f]));
    // claims déjà créés (y compris par une tentative précédente) : fournis au modèle
    // pour qu'il skippe les reformulations — la dédup pair_key ne voit pas les
    // quasi-doublons qui portent sur des paires différentes.
    const resumeClaims = (opts.resume?.createdIds ?? []).length
      ? this.deps.suggestions.listByIds(opts.resume?.createdIds ?? []).map((s) => s.claim)
      : [];
    // signatures des claims déjà retenus : sert à rejeter les quasi-doublons
    // (même idée reformulée sur une autre paire — la dédup pair_key ne les voit pas)
    const coveredTokenSets = resumeClaims.map((c) => claimTokens(c));

    for (let i = startIdx; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      const priorClaims = [...resumeClaims, ...result.created.map((c) => c.claim)].slice(-25);
      const results = await this.processBatch(batch, byId, opts, priorClaims);
      result.batchCalls += results.batchCalls;
      result.batchCallsFromCache += results.fromCache;
      // 1 batch/min : la fenêtre ITPM du provider doit se vider entre deux appels
      if (i + batchSize < pairs.length && opts.interBatchDelayMs) {
        await sleep(opts.interBatchDelayMs);
      }

      for (const r of results.attached) {
        if (r.skipped) continue;
        // entrée incomplète (le superRefine ne devrait pas la laisser passer) — défense en profondeur
        if (!r.relationType || !r.tier || !r.epistemicStatus) {
          result.skipped.invalidEntry += 1;
          continue;
        }
        // cause sans sens (cause_fragment oublié) : pair_key impossible → entrée ignorée
        if (r.relationType === "cause" && !r.causeSide) {
          result.skipped.causeSideMissing += 1;
          continue;
        }
        const pair = batch[r.candidateId];
        const a = byId.get(pair.aId);
        const b = byId.get(pair.bId);
        if (!a || !b) {
          result.skipped.fragmentMissing += 1;
          continue;
        }
        const claim = r.claim;
        // barrière déterministe : le prompt seul ne suffit pas à écarter les 4 défauts
        const rejection = rejectClaim(claim);
        if (rejection) {
          result.skipped.claimRejected += 1;
          console.warn(`[discover] claim rejeté (${rejection}) : ${claim.slice(0, 120)}`);
          continue;
        }
        const tokens = claimTokens(claim);
        if (coveredTokenSets.some((t) => isNearDuplicateClaim(tokens, t))) {
          result.skipped.nearDuplicate += 1;
          continue;
        }
        const status = normalizeEpistemicStatus(r.epistemicStatus, claim, a.text, b.text);
        const key = pairKeyFor(r.relationType, a.id, b.id, r.causeSide);
        const insert = this.deps.suggestions.create({
          claim,
          relation_type: r.relationType,
          tier: r.tier,
          fragment_a_id: a.id,
          fragment_b_id: b.id,
          pair_key: key,
          content_sig: contentSig(claim),
          epistemic_status: status,
          prompt_version: DISCOVERY_PROMPT_VERSION,
          chat_model: this.deps.chatModel,
        });
        if (!insert.ok) {
          const key = {
            duplicate: "duplicate",
            blocked_variant: "blocked",
            intra_source: "intraSource",
            fragment_missing: "fragmentMissing",
          }[insert.reason] as keyof typeof result.skipped;
          result.skipped[key] += 1;
          continue;
        }
        coveredTokenSets.push(tokens);
        result.created.push({
          id: insert.id,
          claim,
          relationType: r.relationType,
          tier: r.tier,
          epistemicStatus: status,
          pairKey: key,
          a: { id: a.id, sourceId: a.sourceId, sourceTitle: a.sourceTitle, text: a.text },
          b: { id: b.id, sourceId: b.sourceId, sourceTitle: b.sourceTitle, text: b.text },
        });
        result.createdIds.push(insert.id);
      }
      opts.onProgress?.({
        processed: Math.min(i + batchSize, pairs.length),
        total: pairs.length,
        created: result.createdIds.length,
        // copie : la référence vivante serait mutée par les batchs suivants
        createdIds: [...result.createdIds],
        batchCalls: result.batchCalls,
        batchCallsFromCache: result.batchCallsFromCache,
        skipped: result.skipped,
      });
    }
    return result;
  }

  private loadFragments(sourceIds: string[]): CorpusFragment[] {
    if (sourceIds.length === 0) return [];
    const placeholders = sourceIds.map(() => "?").join(",");
    const rows = this.deps.db
      .prepare(
        `SELECT f.id, f.source_id, f.chunk_index, f.text, f.embedding, f.embedding_dimensions AS dims,
                s.title AS source_title
         FROM fragments f JOIN sources s ON s.id = f.source_id
         WHERE f.source_id IN (${placeholders})
         ORDER BY s.id, f.chunk_index`
      )
      .all(...sourceIds) as {
      id: string;
      source_id: string;
      chunk_index: number;
      text: string;
      embedding: Buffer;
      dims: number;
      source_title: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      sourceTitle: r.source_title,
      chunkIndex: r.chunk_index,
      text: r.text,
      embedding: new Float32Array(decodeEmbedding(r.embedding, r.dims)),
    }));
  }

  /** SHA256 des « source_id:content_hash » triés — stable par corpus, seed du sampling. */
  private computeCorpusHash(sourceIds: string[]): string {
    const rows = this.deps.db
      .prepare(
        `SELECT id, content_hash FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`
      )
      .all(...sourceIds) as { id: string; content_hash: string }[];
    const list = rows
      .map((r) => `${r.id}:${r.content_hash}`)
      .sort()
      .join("|");
    return sha256Hex(list);
  }

  private async processBatch(
    batch: PairCandidate[],
    byId: Map<string, CorpusFragment>,
    opts: DiscoveryRunOptions,
    priorClaims: string[]
  ): Promise<{ attached: AttachedResult[]; batchCalls: number; fromCache: number }> {
    const promptPairs = batch.map((p, idx) => ({
      candidateId: idx,
      aText: byId.get(p.aId)?.text ?? "",
      bText: byId.get(p.bId)?.text ?? "",
      aTitle: byId.get(p.aId)?.sourceTitle ?? null,
      bTitle: byId.get(p.bId)?.sourceTitle ?? null,
    }));
    const messages = buildDiscoveryPrompt(promptPairs, {
      maxFragmentChars: opts.maxFragmentChars,
      priorClaims,
    });
    const schema = makeDiscoveryBatchSchema(batch.length);

    // cache par hash de prompt (PRD §3.4 : modèle + prompt_version + contenu inclus)
    const cacheKey = sha256Hex(
      JSON.stringify([
        this.deps.chatSignature ?? this.deps.chatModel,
        DISCOVERY_PROMPT_VERSION,
        messages,
      ])
    );
    const promptCache = opts.promptCache ?? this.deps.promptCache;
    const cached = promptCache?.get(cacheKey);
    if (cached !== undefined) {
      const parsed = cached as z.infer<ReturnType<typeof makeDiscoveryBatchSchema>>;
      return { attached: attachResults(parsed), batchCalls: 0, fromCache: 1 };
    }
    // retry interne sur rate-limit (Retry-After respecté) : la fenêtre ITPM se vide
    // entre deux tentatives ; les attempts du job ne sont pas consommés par le quota
    let parsed: z.infer<ReturnType<typeof makeDiscoveryBatchSchema>> | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const startedAt = Date.now();
      try {
        parsed = await this.deps.chat.chat(messages, schema);
        // trace de durée : un batch anormalement lent est un signal de quota atteint
        console.log(
          `[discover] batch LLM (${batch.length} paires) : ${Date.now() - startedAt} ms`
        );
        break;
      } catch (e) {
        if (e instanceof LlmRateLimitError && attempt < 4) {
          // sleep plafonné : un retry-after énorme ne doit pas figer le worker
          // (le lease expire pendant ce temps → job running à vie)
          console.warn(
            `[discover] rate-limit (Retry-After ${e.retryAfterSeconds}s) — ` +
              `tentative ${attempt + 1}/5 après ${Date.now() - startedAt} ms`
          );
          await sleep((Math.min(e.retryAfterSeconds, 120) + 5) * 1000);
          continue;
        }
        throw e;
      }
    }
    if (!parsed) throw new Error("batch sans résultat après tentatives");
    promptCache?.set(cacheKey, parsed);
    return { attached: attachResults(parsed), batchCalls: 1, fromCache: 0 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}