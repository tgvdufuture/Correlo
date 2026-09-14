import type { z } from "zod";
import type { Db } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";
import { decodeEmbedding } from "@/lib/llm/embedding-codec";
import type { LlmProvider, PromptCache } from "@/lib/llm/types";
import { LlmRateLimitError } from "@/lib/llm/errors";
import { contentSig } from "@/lib/discover/epistemic";
import { buildSeeds, SEED_VERSION, type SynthesisSeed } from "@/lib/synth/seeds";
import { selectEvidence } from "@/lib/synth/select";
import {
  SYNTHESIS_BASELINE_PROMPT_VERSION,
  SYNTHESIS_PROMPT_VERSION,
  buildBaselinePrompt,
  buildSynthesisPrompt,
  type PromptEvidence,
} from "@/lib/synth/prompts";
import {
  makeSynthesisSchema,
  attachSynthesisResult,
  type AttachedSynthesisResult,
} from "@/lib/synth/parser";
import { rejectSynthesis, synthesisTokens, type SynthesisRejection } from "@/lib/synth/rules";
import { isNearDuplicateTokens } from "@/lib/quality/text-rules";
import type { ThemesRepo } from "@/lib/repositories/themes";
import type {
  EvidenceSnapshotEntry,
  SynthesesRepo,
  SynthesisConfidence,
  SynthesisEpistemicStatus,
  SynthesisRelationKind,
} from "@/lib/repositories/syntheses";

/**
 * Moteur de synthèses (PRD v1.3, Phase 5A §2.1).
 *
 * Pipeline : fragments du corpus → **graines** cross-document déterministes
 * (`buildSeeds`, réutilise le sampler de la 2A) → garde-fous de preuve
 * (`selectEvidence`) → 1 appel LLM par graine → barrière déterministe
 * (`rejectSynthesis`) → provenance vérifiée → insertion.
 *
 * Le regroupement par thèmes (k-means d'embeddings) a été **mesuré et abandonné**
 * (2026-09-13) : sur ce corpus il retrouvait les documents, et le débruitage ne gardait
 * que leurs fragments atypiques — voir `lib/synth/seeds.ts`. L'ancrage d'une synthèse
 * est donc une **paire de preuves** de deux documents, pas un centroïde.
 *
 * Garanties structurelles, toutes vérifiées côté serveur :
 *   - le modèle ne renvoie que des **indices** de preuves ; les IDs de fragments
 *     sont résolus par le serveur, et les sources parentes sont dérivées des
 *     fragments réels (jamais de la déclaration du modèle) ;
 *   - ≥ 2 sources distinctes, vérifié en base par le repo (`intra_source`) ;
 *   - `FACT` impossible : absent du schéma Zod et refusé par la base ;
 *   - `content_sig` UNIQUE + quasi-doublons inter-thèmes du run.
 *
 * Reproductibilité : mêmes fragments + même `runId` ⇒ mêmes graines, mêmes preuves,
 * mêmes prompts. Rejouer un run n'insère aucune nouvelle synthèse (dédup).
 */
export interface SynthesisRunSkipped {
  /** Graine sans 2 preuves non redondantes issues de sources distinctes. */
  noEvidence: number;
  /** Le modèle s'est abstenu — réponse légitime, pas un échec. */
  llmSkipped: number;
  /** Entrée non-skippée incomplète (le superRefine ne devrait pas la laisser passer). */
  invalidEntry: number;
  /** Énoncé refusé par la barrière déterministe (générique, paraphrase, langue…). */
  rejected: number;
  /** Énoncé reformulant une synthèse déjà retenue dans ce run. */
  nearDuplicate: number;
  /** Graine ayant déjà atteint son nombre maximal de synthèses. */
  capacity: number;
  /** Preuves citées mono-source (le repo refuserait : on l'écarte avant l'appel DB). */
  intraSource: number;
  /** Énoncé identique (content_sig) déjà en base. */
  duplicate: number;
  /** Indice de preuve ne correspondant à aucun fragment réel. */
  evidenceMissing: number;
}

export interface SynthesisRunOptions {
  runId: string;
  /**
   * `synthesis` (défaut) : le produit, journalisé en base avec barrière qualité.
   * `baseline` : contrôle **« résumé »** du protocole Q25 — mêmes graines,
   * mêmes preuves, même budget d'appels, mais consigne de résumé et **aucune
   * écriture**. Le baseline n'est délibérément pas filtré par la barrière (un
   * résumé est par construction une paraphrase) : c'est ce qui rend la
   * comparaison honnête. Ses résultats reviennent dans `syntheses` pour que
   * l'appelant les écrive hors base.
   */
  mode?: "synthesis" | "baseline";
  /** Reprise : index de la première graine à traiter (0 = début). */
  startSeed?: number;
  /**
   * **Plafond du run**, pas une taille de fenêtre : le run construit exactement
   * `totalSeeds` graines et traite `[startSeed, totalSeeds)`. Une reprise au
   * checkpoint ne peut donc pas traiter davantage de graines que le run n'en
   * autorise (constaté en réel le 2026-09-13 : `--max-themes=12` avait traité
   * 24 thèmes, le plafond étant réappliqué comme fenêtre après un 429).
   */
  totalSeeds?: number;
  /** Plafond de graines portant sur un même document (équilibre du corpus). */
  maxSeedsPerSource?: number;
  /** Preuves minimales par graine (défaut 2). */
  minEvidence?: number;
  /** Preuves maximales par graine (défaut 4). */
  maxEvidence?: number;
  /** Synthèses maximales par graine, runs précédents inclus (défaut 3, PRD v1.3). */
  maxSynthesesPerSeed?: number;
  /** Troncature des preuves dans le prompt (quotas d'entrée du provider). */
  maxEvidenceChars?: number;
  /** Pause entre deux graines (fenêtre de quota du provider). */
  interSeedDelayMs?: number;
  /** Cache par hash de prompt (modèle + prompt_version + contenu). */
  promptCache?: PromptCache;
  /**
   * Compteurs d'une tentative précédente (reprise après coupure) : sans eux le
   * rapport d'un run repris sous-estimerait ce qui a déjà été produit.
   */
  resume?: {
    createdIds?: string[];
    llmCalls?: number;
    llmCallsFromCache?: number;
    skipped?: Partial<SynthesisRunSkipped>;
    rejectedByReason?: Partial<Record<SynthesisRejection, number>>;
    /**
     * Énoncés d'une tentative précédente, pour un **baseline** uniquement : il n'écrit
     * rien en base, donc une reprise ne peut pas les retrouver autrement. Sans eux, un
     * baseline interrompu (coupure provider) puis repris ne rapportait que les graines
     * restantes — le contrôle Q25 comparait alors 11 synthèses à 8 résumés (défaut
     * constaté sur le run réel du 2026-09-14).
     */
    baselineItems?: CreatedSynthesis[];
  };
  onProgress?: (info: {
    processed: number;
    total: number;
    created: number;
    createdIds: string[];
    llmCalls: number;
    llmCallsFromCache: number;
    skipped: SynthesisRunSkipped;
    /** Énoncés d'un baseline (transportés par le checkpoint, jamais persistés en base). */
    baselineItems?: CreatedSynthesis[];
  }) => void;
}

export interface CreatedSynthesis {
  id: string;
  /** Id de la ligne d'ancrage (`themes`) créée pour la graine. */
  seedId: string;
  seedLabel: string;
  text: string;
  relationKind: SynthesisRelationKind;
  confidence: SynthesisConfidence;
  epistemicStatus: SynthesisEpistemicStatus;
  evidence: {
    fragmentId: string;
    sourceId: string;
    sourceTitle: string | null;
    chunkIndex: number;
    locator: string;
    text: string;
  }[];
}

export interface SynthesisRunResult {
  runId: string;
  corpusHash: string;
  seed: string;
  /** Ids des lignes d'ancrage persistées (une par graine). */
  seedIds: string[];
  seedsTotal: number;
  llmCalls: number;
  llmCallsFromCache: number;
  syntheses: CreatedSynthesis[];
  /** Ids de toutes les synthèses du run (tentatives précédentes incluses). */
  createdIds: string[];
  skipped: SynthesisRunSkipped;
  rejectedByReason: Partial<Record<SynthesisRejection, number>>;
  /** Mode du run — un baseline ne doit jamais être évalué comme un produit. */
  mode: "synthesis" | "baseline";
}

/** Le run existe déjà avec un autre corpus/seed : rejouer écraserait des synthèses. */
export class SeedRunConflictError extends Error {
  constructor(runId: string) {
    super(
      `run ${runId} déjà persisté avec d'autres graines (corpus ou seed différent) : ` +
        `supprimez le run (themes.deleteByRun) avant de le rejouer`
    );
    this.name = "SeedRunConflictError";
  }
}

interface CorpusFragment {
  id: string;
  sourceId: string;
  sourceTitle: string | null;
  sourceContentHash: string;
  chunkIndex: number;
  locator: string;
  text: string;
  embedding: Float32Array;
}

/** Nombre de graines d'un run par défaut (1 appel LLM par graine). */
export const DEFAULT_RUN_SEEDS = 12;

export class SynthesisService {
  constructor(
    private deps: {
      db: Db;
      themes: ThemesRepo;
      syntheses: SynthesesRepo;
      chat: LlmProvider;
      chatModel: string;
      /**
       * Signature du **réglage** du chat (modèle + effort de raisonnement + budget).
       * Entre dans la clé de cache : à prompt identique, un modèle qui raisonne ne
       * produit pas la même réponse qu'un modèle qui répond sans lire (mesuré :
       * 10 skips sans raisonnement → synthèses réelles avec `reasoning_effort=low`).
       */
      chatSignature?: string;
      /** Cache persisté (worker) ou en mémoire (tests). Surchargeable par run. */
      promptCache?: PromptCache;
    }
  ) {}

  async run(sourceIds: string[], opts: SynthesisRunOptions): Promise<SynthesisRunResult> {
    const mode = opts.mode ?? "synthesis";
    const maxSynthesesPerSeed = opts.maxSynthesesPerSeed ?? 3;
    const minEvidence = opts.minEvidence ?? 2;
    const maxEvidence = opts.maxEvidence ?? 4;

    const fragments = this.loadFragments(sourceIds);
    const corpusHash = this.computeCorpusHash(sourceIds);
    // même formule que `makeSeed` (2A) : sha256(corpus_hash | run_id)
    const seed = sha256Hex(`${corpusHash}|${opts.runId}`);
    const totalSeeds = opts.totalSeeds ?? DEFAULT_RUN_SEEDS;
    const seeds = buildSeeds({
      fragments,
      seedHex: seed,
      maxSeeds: totalSeeds,
      maxSeedsPerSource: opts.maxSeedsPerSource,
      sourceTitles: new Map(fragments.map((f) => [f.sourceId, f.sourceTitle])),
    });
    // un baseline ne persiste rien : ni ancrage, ni synthèses (il ne doit pas
    // polluer le corpus de production qu'il sert à évaluer)
    const seedIds =
      mode === "baseline"
        ? seeds.map((s) => `baseline-${s.index}`)
        : this.ensureSeeds(opts.runId, corpusHash, seed, seeds);

    const byId = new Map(fragments.map((f) => [f.id, f]));
    const resumeSkipped = opts.resume?.skipped ?? {};
    const result: SynthesisRunResult = {
      runId: opts.runId,
      corpusHash,
      seed,
      seedIds,
      seedsTotal: seeds.length,
      llmCalls: opts.resume?.llmCalls ?? 0,
      llmCallsFromCache: opts.resume?.llmCallsFromCache ?? 0,
      mode,
      // un baseline repris repart avec les énoncés déjà calculés (tentative précédente)
      syntheses: mode === "baseline" ? [...(opts.resume?.baselineItems ?? [])] : [],
      createdIds: [...(opts.resume?.createdIds ?? [])],
      skipped: {
        noEvidence: resumeSkipped.noEvidence ?? 0,
        llmSkipped: resumeSkipped.llmSkipped ?? 0,
        invalidEntry: resumeSkipped.invalidEntry ?? 0,
        rejected: resumeSkipped.rejected ?? 0,
        nearDuplicate: resumeSkipped.nearDuplicate ?? 0,
        capacity: resumeSkipped.capacity ?? 0,
        intraSource: resumeSkipped.intraSource ?? 0,
        duplicate: resumeSkipped.duplicate ?? 0,
        evidenceMissing: resumeSkipped.evidenceMissing ?? 0,
      },
      rejectedByReason: { ...(opts.resume?.rejectedByReason ?? {}) },
    };

    // synthèses déjà présentes pour ces thèmes (tentative précédente incluse) :
    // elles comptent dans la capacité et fournissent les énoncés à ne pas reformuler
    const coveredTexts: string[] = [];
    const coveredTokenSets: Set<string>[] = [];
    // Énoncés du run **déjà persistés**, rangés par index de thème. C'est la source du
    // « déjà formulé » envoyé au modèle — et non la liste des réponses de l'invocation
    // en cours. Raison mesurée (2026-09-13) : un run interrompu puis repris au
    // checkpoint, ou simplement rejoué, repart avec une liste en mémoire vide ; les
    // prompts des thèmes suivants différaient donc de ceux du premier passage, la clé
    // de cache changeait, le modèle était rappelé et **reformulait** — d'où de
    // nouvelles synthèses insérées à chaque reprise.
    //
    // Le prompt d'un thème ne dépend désormais que de ce que le run a **déjà produit
    // pour les thèmes précédents** : identique sur un rejeu, sur une reprise et sur le
    // premier passage, donc clé de cache stable et AC2 tenable. Le thème courant est
    // exclu (sur un rejeu il aurait sinon un contenu que le premier passage n'avait
    // pas) ; l'anti-répétition sur un même thème reste portée par la barrière.
    const persistedTextsBySeed: string[][] = seedIds.map(() => []);
    if (mode === "synthesis") {
      seedIds.forEach((seedId, index) => {
        for (const row of this.deps.syntheses.listByTheme(seedId)) {
          persistedTextsBySeed[index].push(row.text);
          coveredTexts.push(row.text);
          coveredTokenSets.push(synthesisTokens(row.text));
        }
      });
    }

    const start = Math.min(Math.max(opts.startSeed ?? 0, 0), seeds.length);
    const end = seeds.length;

    for (let i = start; i < end; i++) {
      const currentSeed = seeds[i];
      const seedId = seedIds[i];
      const callsBefore = result.llmCalls;
      const members = currentSeed.fragmentIds
        .map((id) => byId.get(id))
        .filter((f): f is CorpusFragment => f !== undefined);

      // capacité de la graine atteinte (rejeu) : on n'ajoute pas une n-ième variante
      if (
        mode === "synthesis" &&
        this.deps.syntheses.listByTheme(seedId).length >= maxSynthesesPerSeed
      ) {
        result.skipped.capacity += 1;
      } else {
        // La graine est déjà diverse (deux documents) : `selectEvidence` n'apporte ici
        // que ses garde-fous — filtre d'appareil et refus des quasi-doublons — et peut
        // réduire la graine à moins de 2 preuves, ce qui l'écarte (comportement voulu).
        const selection = selectEvidence({
          fragments: members,
          centroid: currentSeed.centroid,
          minEvidence,
          maxEvidence,
        });
        if (selection.evidence.length < minEvidence) {
          result.skipped.noEvidence += 1;
        } else {
          await this.synthesizeSeed({
            seed: currentSeed,
            seedId,
            selection: selection.evidence,
            opts,
            result,
            coveredTexts,
            coveredTokenSets,
            seedIndex: i,
            persistedTextsBySeed,
          });
        }
      }

      // L'attente inter-graines protège la **fenêtre de quota du provider** : elle n'a de
      // sens que si la graine a réellement appelé le LLM. Une graine servie par le cache
      // (cas d'un rejeu AC2 : 12 graines, 0 appel) n'appelle rien et n'a donc rien à
      // respecter — sinon un rejeu coûte 12 × 65 s pour aucun appel, et dépasse le
      // `--wait` du CLI (constaté sur le rejeu réel du 2026-09-14).
      if (i + 1 < end && opts.interSeedDelayMs && result.llmCalls > callsBefore) {
        await sleep(opts.interSeedDelayMs);
      }
      opts.onProgress?.({
        processed: i + 1,
        total: seeds.length,
        // un baseline ne crée rien en base : il ne compte que ses énoncés calculés
        created: mode === "baseline" ? result.syntheses.length : result.createdIds.length,
        createdIds: [...result.createdIds],
        llmCalls: result.llmCalls,
        llmCallsFromCache: result.llmCallsFromCache,
        skipped: result.skipped,
        // le checkpoint doit transporter les énoncés d'un baseline : ils ne sont nulle
        // part ailleurs, et une reprise perdrait sinon ceux déjà calculés
        baselineItems: mode === "baseline" ? result.syntheses : undefined,
      });
    }
    return result;
  }

  private async synthesizeSeed(args: {
    seed: SynthesisSeed;
    seedId: string;
    selection: CorpusFragment[];
    opts: SynthesisRunOptions;
    result: SynthesisRunResult;
    coveredTexts: string[];
    coveredTokenSets: Set<string>[];
    seedIndex: number;
    persistedTextsBySeed: string[][];
  }): Promise<void> {
    const {
      seed,
      seedId,
      selection,
      opts,
      result,
      coveredTexts,
      coveredTokenSets,
      seedIndex,
      persistedTextsBySeed,
    } = args;

    const promptEvidence: PromptEvidence[] = selection.map((e, index) => ({
      index,
      text: e.text,
      sourceTitle: e.sourceTitle,
    }));
    const baseline = opts.mode === "baseline";
    const messages = baseline
      ? buildBaselinePrompt({
          seedLabel: seed.label,
          evidence: promptEvidence,
          maxEvidenceChars: opts.maxEvidenceChars,
        })
      : buildSynthesisPrompt({
          seedLabel: seed.label,
          evidence: promptEvidence,
          maxEvidenceChars: opts.maxEvidenceChars,
          priorSyntheses: persistedTextsBySeed
            .slice(0, seedIndex)
            .flat()
            .slice(-25),
        });
    const promptVersion = baseline ? SYNTHESIS_BASELINE_PROMPT_VERSION : SYNTHESIS_PROMPT_VERSION;
    const schema = makeSynthesisSchema(selection.length);
    const cacheKey = sha256Hex(
      JSON.stringify([this.deps.chatSignature ?? this.deps.chatModel, promptVersion, messages])
    );
    const promptCache = opts.promptCache ?? this.deps.promptCache;

    let parsed: z.infer<ReturnType<typeof makeSynthesisSchema>>;
    const cached = promptCache?.get(cacheKey);
    if (cached !== undefined) {
      parsed = cached as z.infer<ReturnType<typeof makeSynthesisSchema>>;
      result.llmCallsFromCache += 1;
    } else {
      parsed = await this.chatWithRetry(messages, schema);
      result.llmCalls += 1;
      promptCache?.set(cacheKey, parsed);
    }

    const attached: AttachedSynthesisResult = attachSynthesisResult(parsed);
    if (attached.skipped) {
      result.skipped.llmSkipped += 1;
      return;
    }
    if (!attached.relationKind || !attached.confidence || attached.evidenceIndices.length < 2) {
      result.skipped.invalidEntry += 1;
      return;
    }

    // les indices deviennent des fragments réels — le modèle n'a jamais vu d'ID
    const cited: CorpusFragment[] = [];
    const seenIndices = new Set<number>();
    for (const index of attached.evidenceIndices) {
      if (seenIndices.has(index)) continue;
      seenIndices.add(index);
      const evidence = selection[index];
      if (!evidence) {
        result.skipped.evidenceMissing += 1;
        return;
      }
      cited.push(evidence);
    }
    if (cited.length < 2) {
      result.skipped.evidenceMissing += 1;
      return;
    }
    if (new Set(cited.map((e) => e.sourceId)).size < 2) {
      result.skipped.intraSource += 1;
      return;
    }

    // Barrière déterministe : le prompt seul ne suffit pas à écarter paraphrase et
    // généralités. Le baseline en est délibérément exempté — un résumé EST une
    // paraphrase de ses preuves ; le filtrer viderait le contrôle et rendrait la
    // comparaison de la Phase 5A sans valeur.
    let tokens = new Set<string>();
    if (!baseline) {
      const rejection = rejectSynthesis(
        attached.synthesis,
        cited.map((e) => e.text)
      );
      if (rejection) {
        result.skipped.rejected += 1;
        result.rejectedByReason[rejection] = (result.rejectedByReason[rejection] ?? 0) + 1;
        console.warn(
          `[synth] synthèse rejetée (${rejection}) : ${attached.synthesis.slice(0, 120)}`
        );
        return;
      }
      tokens = synthesisTokens(attached.synthesis);
      if (coveredTokenSets.some((t) => isNearDuplicateTokens(tokens, t))) {
        result.skipped.nearDuplicate += 1;
        return;
      }
    }

    const snapshot: EvidenceSnapshotEntry[] = cited.map((e) => ({
      fragment_id: e.id,
      source_id: e.sourceId,
      source_title: e.sourceTitle,
      content_hash: e.sourceContentHash,
      locator: e.locator,
      text: e.text,
    }));
    const epistemicStatus = (attached.epistemicStatus ?? "INFERENCE") as SynthesisEpistemicStatus;
    const evidence = cited.map((e) => ({
      fragmentId: e.id,
      sourceId: e.sourceId,
      sourceTitle: e.sourceTitle,
      chunkIndex: e.chunkIndex,
      locator: e.locator,
      text: e.text,
    }));

    // le baseline s'arrête ici : rien n'est écrit, l'énoncé repart vers l'appelant
    if (baseline) {
      result.syntheses.push({
        id: `baseline:${opts.runId}:${seed.index}`,
        seedId,
        seedLabel: seed.label,
        text: attached.synthesis,
        relationKind: attached.relationKind,
        confidence: attached.confidence,
        epistemicStatus,
        evidence,
      });
      return;
    }

    const insert = this.deps.syntheses.create({
      text: attached.synthesis,
      theme_id: seedId,
      relation_kind: attached.relationKind,
      // le modèle propose, le serveur ne relève jamais : un FACT est irreprésentable
      epistemic_status: epistemicStatus,
      evidence_fragment_ids: cited.map((e) => e.id),
      provenance_snapshot: snapshot,
      content_sig: contentSig(attached.synthesis),
      confidence: attached.confidence,
      prompt_version: SYNTHESIS_PROMPT_VERSION,
      chat_model: this.deps.chatModel,
    });
    if (!insert.ok) {
      if (insert.reason === "duplicate") {
        result.skipped.duplicate += 1;
      } else if (insert.reason === "intra_source") {
        result.skipped.intraSource += 1;
      } else {
        result.skipped.evidenceMissing += 1;
      }
      return;
    }

    coveredTexts.push(attached.synthesis);
    coveredTokenSets.push(tokens);
    // la graine courante entre dans l'historique du run : les graines SUIVANTES le verront
    persistedTextsBySeed[seedIndex].push(attached.synthesis);
    result.createdIds.push(insert.id);
    result.syntheses.push({
      id: insert.id,
      seedId,
      seedLabel: seed.label,
      text: attached.synthesis,
      relationKind: attached.relationKind,
      confidence: attached.confidence,
      epistemicStatus,
      evidence,
    });
  }

  /** Même traitement du quota qu'en 2A : Retry-After respecté, sleep plafonné. */
  private async chatWithRetry<T extends z.ZodType>(
    messages: Parameters<LlmProvider["chat"]>[0],
    schema: T
  ): Promise<z.infer<T>> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const startedAt = Date.now();
      try {
        const parsed = await this.deps.chat.chat(messages, schema);
        console.log(`[synth] appel LLM (graine) : ${Date.now() - startedAt} ms`);
        return parsed;
      } catch (e) {
        if (e instanceof LlmRateLimitError && attempt < 4) {
          console.warn(
            `[synth] rate-limit (Retry-After ${e.retryAfterSeconds}s) — tentative ${attempt + 1}/5`
          );
          await sleep((Math.min(e.retryAfterSeconds, 120) + 5) * 1000);
          continue;
        }
        throw e;
      }
    }
    throw new Error("synthèse sans résultat après tentatives");
  }

  /**
   * Persiste les thèmes du run une seule fois. En reprise, les thèmes déjà
   * persistés sont réutilisés **par index** (le clustering est déterministe), ce
   * qui préserve les synthèses déjà créées — `deleteByRun` les supprimerait en
   * CASCADE.
   */
  private ensureSeeds(
    runId: string,
    corpusHash: string,
    seed: string,
    seeds: SynthesisSeed[]
  ): string[] {
    const existing = this.deps.themes.listByRun(runId);
    if (existing.length === 0) {
      return this.deps.themes.createMany(
        seeds.map((s) => ({
          runId,
          corpusHash,
          seed,
          label: s.label,
          centroid: s.centroid,
          size: s.fragmentIds.length,
          samplerVersion: SEED_VERSION,
        }))
      );
    }
    const same =
      existing.length === seeds.length &&
      existing.every(
        (row, i) =>
          row.corpus_hash === corpusHash && row.seed === seed && row.label === seeds[i].label
      );
    if (!same) throw new SeedRunConflictError(runId);
    return existing.map((row) => row.id);
  }

  private loadFragments(sourceIds: string[]): CorpusFragment[] {
    if (sourceIds.length === 0) return [];
    const placeholders = sourceIds.map(() => "?").join(",");
    const rows = this.deps.db
      .prepare(
        `SELECT f.id, f.source_id, f.chunk_index, f.locator, f.text, f.embedding,
                f.embedding_dimensions AS dims, s.title AS source_title,
                s.content_hash AS source_content_hash
         FROM fragments f JOIN sources s ON s.id = f.source_id
         WHERE f.source_id IN (${placeholders})
         ORDER BY s.id, f.chunk_index`
      )
      .all(...sourceIds) as {
      id: string;
      source_id: string;
      chunk_index: number;
      locator: string;
      text: string;
      embedding: Buffer;
      dims: number;
      source_title: string | null;
      source_content_hash: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      sourceTitle: r.source_title,
      sourceContentHash: r.source_content_hash,
      chunkIndex: r.chunk_index,
      locator: r.locator,
      text: r.text,
      embedding: new Float32Array(decodeEmbedding(r.embedding, r.dims)),
    }));
  }

  /** SHA256 des « source_id:content_hash » triés — seed du clustering et traçabilité. */
  private computeCorpusHash(sourceIds: string[]): string {
    if (sourceIds.length === 0) return sha256Hex("");
    const rows = this.deps.db
      .prepare(
        `SELECT id, content_hash FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`
      )
      .all(...sourceIds) as { id: string; content_hash: string }[];
    return sha256Hex(
      rows
        .map((r) => `${r.id}:${r.content_hash}`)
        .sort()
        .join("|")
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
