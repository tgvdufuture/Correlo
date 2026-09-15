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
import { makeSeed, samplePairs, SAMPLER_VERSION, type PairCandidate } from "@/lib/discover/sampler";
import {
  claimAnchorTerms,
  claimTokens,
  isJuxtaposition,
  isNearDuplicateClaim,
  rejectClaim,
} from "@/lib/discover/claim-rules";
import { documentFrequency, rareThreshold } from "@/lib/quality/lexical-anchor";
import type { SuggestionsRepo } from "@/lib/repositories/suggestions";
import { MAX_PROVIDER_ATTEMPTS, providerRetryDelayMs } from "@/lib/llm/retry";

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
  /**
   * Appelé dès que l'identité du run est connue (`corpus_hash`, `seed`) et
   * **avant** le premier appel LLM : c'est là que le worker persiste la ligne
   * `discover_runs` (Phase 2B, AC1). Un run qui échoue ensuite reste donc
   * visible avec son identité, au lieu de ne laisser qu'un `progress_json`.
   */
  onStarted?: (info: {
    runId: string;
    corpusHash: string;
    seed: string;
    sampler: DiscoveryRunOptions["sampler"];
    samplerVersion: string;
    /** Version de prompt et modèle réellement utilisés : ce sont eux qui routent le cache. */
    promptVersion: string;
    chatModel: string;
    pairsTotal: number;
    sourceIds: string[];
  }) => void;
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
  samplerVersion: string;
  pairsTotal: number;
  batchCalls: number;
  batchCallsFromCache: number;
  created: CreatedSuggestion[];
  /**
   * `createdIds` = **sortie du run**, pas seulement les insertions du dernier
   * passage : un rejeu qui retombe sur des suggestions identiques les rattache à
   * ce run (mêmes ids). C'est ce qui rend « rejouable à l'identique » vérifiable
   * — et c'est ce que persiste `discover_runs.created_ids` (AC1).
   */
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
    /** claim reliant les deux fragments par un mot rare partagé (ancrage lexical — Q22 : évident, donc pas une découverte). */
    claimAnchored: number;
    /** claim réduit à deux attributions coordonnées sans relation énoncée (« X dit A, tandis que Y dit B »). */
    claimJuxtaposed: number;
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
    // Ancrage lexical : la rareté d'un terme se mesure sur le corpus du run.
    // Calculée une fois (pas par claim) — c'est le seul paramètre global de la règle.
    const anchorDf = documentFrequency(fragments.map((f) => f.text));
    const anchorThreshold = rareThreshold(fragments.length);
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
    // identité du run publiée avant le premier appel LLM : le worker y persiste
    // `discover_runs` (AC1), un échec en cours de route laisse donc une trace
    opts.onStarted?.({
      runId: opts.runId,
      corpusHash,
      seed,
      sampler: opts.sampler,
      samplerVersion: SAMPLER_VERSION,
      promptVersion: DISCOVERY_PROMPT_VERSION,
      chatModel: this.deps.chatModel,
      pairsTotal: pairs.length,
      sourceIds: [...sourceIds],
    });

    const result: DiscoveryRunResult = {
      runId: opts.runId,
      corpusHash,
      seed,
      sampler: opts.sampler,
      samplerVersion: SAMPLER_VERSION,
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
        claimAnchored: resumeSkipped.claimAnchored ?? 0,
        claimJuxtaposed: resumeSkipped.claimJuxtaposed ?? 0,
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
    // claims retenus par CE run, dans l'ordre où ils l'ont été — rejeu compris.
    // C'est le contexte « déjà couvert » donné au modèle au batch suivant : le
    // dériver des seules *insertions* rendrait un rejeu non reproductible (voir
    // plus bas, un doublon doit avancer le contexte comme une insertion).
    const runClaims: string[] = [];

    for (let i = startIdx; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      const priorClaims = [...resumeClaims, ...runClaims].slice(-25);
      const results = await this.processBatch(batch, byId, opts, priorClaims);
      result.batchCalls += results.batchCalls;
      result.batchCallsFromCache += results.fromCache;
      // 1 batch/min : la fenêtre ITPM du provider doit se vider entre deux appels.
      // Un batch servi par le cache ne consomme aucun token : payer l'attente ferait
      // durer un rejeu (dont tous les batchs sont en cache) exactement comme le run
      // initial, alors qu'il ne touche pas le provider. La pause suit donc l'appel réel.
      if (i + batchSize < pairs.length && opts.interBatchDelayMs && results.batchCalls > 0) {
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
        // barrière de juxtaposition : deux attributions coordonnées sans relation
        // énoncée n'apportent rien (défaut 1 mesuré sur discovery-v4)
        if (isJuxtaposition(claim)) {
          result.skipped.claimJuxtaposed += 1;
          console.warn(`[discover] claim rejeté (juxtaposition) : ${claim.slice(0, 120)}`);
          continue;
        }
        // barrière d'ancrage lexical : la connexion ne doit pas tenir à un mot rare
        // partagé — elle serait trouvable par mots-clés, donc évidente (PRD §4, Q22)
        const anchors = claimAnchorTerms(claim, {
          textA: a.text,
          textB: b.text,
          df: anchorDf,
          threshold: anchorThreshold,
        });
        if (anchors.length > 0) {
          result.skipped.claimAnchored += 1;
          console.warn(
            `[discover] claim rejeté (anchoring: ${anchors.join(", ")}) : ${claim.slice(0, 120)}`
          );
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
        // Une suggestion identique déjà en base n'est pas une perte : c'est la MÊME
        // connexion, qu'un rejeu reproduit à l'identique (Phase 2B, AC1). Elle compte
        // donc dans la sortie du run (`createdIds`) **et fait avancer son contexte**
        // au même titre qu'une insertion. Sans ce second point, le prompt du batch
        // suivant n'est plus celui du run d'origine — le modèle ignore quelles idées
        // sont déjà retenues, le cache de prompt rate, et le rejeu produit d'autres
        // claims : mesuré sur `val-div` rejoué, 12 suggestions neuves là où 0 était
        // attendu (1 des 6 connexions retrouvée).
        if (!insert.ok && (insert.reason !== "duplicate" || !insert.existingId)) {
          result.skipped[INSERT_SKIP_KEY[insert.reason]] += 1;
          continue;
        }
        // `existingId` est garanti ici (branche précédente) : un doublon est une
        // connexion identique à rattacher au run, pas un rejet.
        const suggestionId = insert.ok ? insert.id : (insert.existingId as string);
        // Une reprise peut re-proposer une suggestion déjà portée par le checkpoint :
        // elle ne doit ni doubler les compteurs ni répéter le claim au modèle.
        if (!result.createdIds.includes(suggestionId)) {
          result.createdIds.push(suggestionId);
          coveredTokenSets.push(tokens);
          runClaims.push(claim);
        }
        if (insert.ok) {
          result.created.push({
            id: suggestionId,
            claim,
            relationType: r.relationType,
            tier: r.tier,
            epistemicStatus: status,
            pairKey: key,
            a: { id: a.id, sourceId: a.sourceId, sourceTitle: a.sourceTitle, text: a.text },
            b: { id: b.id, sourceId: b.sourceId, sourceTitle: b.sourceTitle, text: b.text },
          });
        } else {
          result.skipped.duplicate += 1;
        }
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
    // Retry interne des incidents **passagers** (429 mais aussi 503/timeout) : ce sont
    // des états du provider, pas des échecs du run. Les attempts du job restent
    // réservés aux échecs réels (cf. lib/llm/retry.ts).
    let parsed: z.infer<ReturnType<typeof makeDiscoveryBatchSchema>> | null = null;
    for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        parsed = await this.deps.chat.chat(messages, schema);
        // trace de durée : un batch anormalement lent est un signal de provider saturé
        console.log(
          `[discover] batch LLM (${batch.length} paires) : ${Date.now() - startedAt} ms`
        );
        break;
      } catch (e) {
        const delay = providerRetryDelayMs(e, attempt);
        if (delay === null || attempt === MAX_PROVIDER_ATTEMPTS - 1) throw e;
        console.warn(
          `[discover] incident provider — tentative ${attempt + 1}/${MAX_PROVIDER_ATTEMPTS} ` +
            `dans ${Math.round(delay / 1000)}s après ${Date.now() - startedAt} ms : ` +
            `${(e as Error).message.slice(0, 140)}`
        );
        await sleep(delay);
      }
    }
    if (!parsed) throw new Error("batch sans résultat après tentatives");
    promptCache?.set(cacheKey, parsed);
    return { attached: attachResults(parsed), batchCalls: 1, fromCache: 0 };
  }
}

/** Rejet d'insertion → compteur de `skipped` correspondant. */
const INSERT_SKIP_KEY = {
  duplicate: "duplicate",
  blocked_variant: "blocked",
  intra_source: "intraSource",
  fragment_missing: "fragmentMissing",
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}