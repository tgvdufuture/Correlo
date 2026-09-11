# Project Progress — Sérendipité (PRD v1.2 + amendement v1.3)

## Direction (2026-09-11) — réorientation validée par l'utilisateur
- [x] Diagnostic produit : l'unité de sortie du PRD v1.2 (Suggestion = **paire** de fragments, relations `analogy`/`contradiction`/`cause`, critère « non-évidente = introuvable par mots-clés ») **ne peut pas** produire une synthèse multi-sources du type « le néo-brutalisme reprend les codes du brutalisme en y ajoutant une dimension personnelle ». Ce n'était pas un problème de prompt : il manquait une entité et une phase.
- [x] **Amendement v1.3 écrit** (`PRD-v1.3-amendement.md`, pointé depuis l'en-tête du PRD) : Phases **5A (moteur de synthèses, PoC CLI, jalon bloquant)**, **5B (feed de synthèses)**, **6 (conversation : agent + web explicite + workspace local en lecture seule)**. Thèmes **déduits du corpus** (clustering d'embeddings locaux, aucun domaine codé en dur), table `themes` + `syntheses`, barrière déterministe, protocole d'évaluation dédié (Q25) + baseline « résumé par thème ».
- [x] §3.2 *DO NOT CHANGE* du PRD intégralement préservé (aucune colonne ajoutée à `sources`/`fragments`/`suggestions`/`jobs`/`constructions`) ; le socle paire 2A/2B reste le **niveau preuve**.
- [ ] Décisions reportées en v1.4 (documentées) : promotion d'une synthèse en Construction (colonne `synthesis_id` ?) et ingestion multimodale (image/plan → colonne `modality`).

## Phase 5A — moteur de synthèses (en cours)
- [x] **Étape 1 — données** : migration `002_v1_3.sql` (`themes` + `syntheses`, aucune colonne ajoutée aux tables v1.2), repos `lib/repositories/themes.ts` et `syntheses.ts`.
  - `syntheses` : sources parentes **dérivées des fragments réels** (jamais de la confiance du modèle), ≥ 2 sources distinctes exigées, `content_sig` UNIQUE (dédup), `epistemic_status` **FACT refusé par contrainte de schéma**, `markStaleBySource` via `provenance_snapshot` (reste calculable après suppression/ré-ingestion d'une source). Un `SQLITE_CONSTRAINT_CHECK` n'est plus confondu avec un doublon.
- [x] **Étape 2 — thèmes** : `lib/cluster/kmeans.ts` (k-means déterministe **extrait du sampler** : une seule implémentation, comportement bit pour bit vérifié par les tests 2A) + `lib/synth/themes.ts` (clusters d'embeddings locaux, libellés TF-IDF, `k = clamp(round(n/25), 4, 24)`, clusters mono-source ou trop petits écartés).
  - **Mesure réelle** (12 docs du manifeste, 3 731 fragments × 768 dims) : **2,2 s**, k=24, 9 thèmes retenus, 494 fragments hors thème (clusters mono-source ou < 2 fragments — écartés par construction).
  - **Deux constats réels à traiter** : (1) **boilerplate Gutenberg** — 3 thèmes (37 fragments) dont les libellés sont `project · gutenberg · donations…` : le texte de licence est ingéré et **pollue aussi les paires 2A** ; (2) **déséquilibre des clusters** — un cluster catch-all de **1 213 fragments (32 %)** dont le libellé reste générique (`homme · contre · grand · hommes`).
- [x] **Étape 3 — preuves** : `lib/synth/select.ts` — une preuve par source (≥ 2 sources), départ sur le fragment le **plus périphérique** du thème, puis farthest-point sampling (jamais les plus proches → on ne retombe pas sur le baseline « top-6 cosine »), et **garde-fou de redondance** (cosine > 0,97 écartée : deux textes identiques ne permettent rien d'ajouter). Résultat déterministe et indépendant de l'ordre d'entrée.
  - **Mesure réelle** (12 docs) : **9/9 thèmes exploitables**, **7 cross-domain**, preuves issues de 7 à 10 sources, `minCos` 0,55–0,63 (jeu réellement divers, pas des quasi-doublons), **28 ms** pour toute la chaîne thèmes → preuves.
  - **Constat aggravé** : le texte de licence Gutenberg devient lui-même des preuves candidate (`electronic · project · gutenberg · works`) ; il faut l'exclure en amont.
- [ ] Étape 4 : prompt de synthèse + service + barrière partagée (`lib/quality/text-rules.ts`).
- [ ] Étape 5 : job `synthesize` + CLI + évaluateur Q25 (baseline « résumé par thème »). ⚠️ **`jobs.kind` a un CHECK qui n'autorise pas encore `synthesize`** → migration 003 (reconstruction de table) ou décision explicite.
- [ ] Étape 6 : 2 runs (synthèse + baseline) + 2 évaluateurs.

## État du chantier 2A (itération prompt, 2026-09-11)
- [x] Prompt `discovery-v4` : interdiction des claims génériques (formules « les deux… », autorité/apprentissage), de l'ancrage lexical, des repères `A`/`B`/`Texte 1`, sortie **en français**, rédite par sujet/scène, exigence « un fragment éclaire l'autre », ≤ 30 mots, raisonnement autorisé mais JSON final obligatoire.
- [x] **Barrière déterministe** `lib/discover/claim-rules.ts` (générique / placeholder / anglais / fourre-tout / quasi-doublons inter-paires) branchée dans `discovery-service` : les 4 défauts ne peuvent plus atteindre la base. Compteurs `claimRejected` et `nearDuplicate` dans `progress_json`.
- [x] Provider : `GROQ_MAX_TOKENS`, `GROQ_CHAT_TIMEOUT_SECONDS` (défaut 300 s), retry automatique sur `finish_reason: length` avec budget doublé (un modèle qui raisonne ne perd plus son batch sur troncature).
- [x] Tests : **98/98** ✓, lint ✓, typecheck ✓.
- [ ] Runs de validation 2A **en pause** : re-mesurer sur l'ancienne grille serait du travail jeté maintenant que la cible est la Phase 5A (couche preuve conservée).
- [x] **Encodage corrigé à l'ingestion** (2026-09-11) : `lib/ingest/decoding.ts` — décodage explicite (charset de l'en-tête HTTP, puis `<meta>`/`<?xml>`, sinon **UTF-8 strict**, repli `windows-1252`). Piège réel trouvé en test : Node résout le libellé `windows-1252` vers latin-1 (`0x92` → U+0092 au lieu de « ’ ») → la **table CP1252 officielle est appliquée nous-mêmes**, résultat identique sur toutes les plateformes. 8 tests, dont un bout-en-bout sur `extractUrlText` (page sans charset en CP1252).
  - **Ré-ingestion** de la source corrompue : **429 → 0** fragment corrompu (440/440 réindexés, `replacement_chars: 0` dans le checkpoint, résumé chaîné `done`), aucun mojibake résiduel (`Ã©`, `â€™`, `Â«` : 0 occurrence).
  - **Phase 1B re-passée : PASS** — 3 731/3 731 locators re-slicés, 3 731 BLOB conformes, 12/12 sources séquentielles.
  - Effet mesuré sur les thèmes : 9 → **6 thèmes**, disparition des libellés poubelles (`avait · tait · homme · contre`, `ebook · gutenberg · project · jules`) et apparition d'un thème enfin lisible — **`droit · nation · humanite · liberte` (128 fragments)** : le contenu de la source corrompue était illisible, il forme maintenant un thème.
  - Garde-fou : tout texte ingéré contenant U+FFFD est **signalé** (log serveur + `replacement_chars` dans `progress_json`) — plus de corruption silencieuse.
- [x] **Boilerplate Gutenberg retiré à l'ingestion** (2026-09-11) : `lib/ingest/boilerplate.ts`, appliqué par `extractUrlText` **et** `parseTextBuffer` (un `.txt` Gutenberg porte le même en-tête). Règles fiables, en-tête et pied traités **indépendamment** (un `START` écarté par Readability ne doit pas empêcher le retrait de l'en-tête) : marqueurs officiels `*** START/END OF … PROJECT GUTENBERG EBOOK … ***`, sinon signature forte (`This eBook is for the use of anyone anywhere`, `Project Gutenberg's …` en tête) + bloc de métadonnées (`Title:`/`Author:`…), sinon signatures de licence en fin de document (> 60 %). Garde-fou : un document qui parle simplement de Gutenberg dans son corps n'est **pas** touché. 7 tests, dont un bout-en-bout `extractUrlText` (recalage des offsets d'en-têtes vérifié).
  - **Ré-ingestion** des 6 sources concernées via `scripts/reingest.mjs` (nouveau CLI — applique le contrat PRD §205 : suppression des fragments + job `ingest`, CASCADE sur les Suggestions, Constructions passe `stale = 1`) : **2 751 → 2 726 fragments**, 0 occurrence résiduelle de `START/END … GUTENBERG`, `This eBook is for the use of anyone`, `Updated editions will replace`, `501(c)(3)`, `gutenberg.org`. Suggestions orphelines supprimées en CASCADE : 35 → 4.
  - **Phase 1B re-passée : PASS** — 3 706/3 706 locators re-slicés, 3 706 BLOB conformes, 12/12 sources séquentielles.
  - Effet mesuré sur les thèmes (12 docs) : **plus aucun libellé construit sur le boilerplate** (`gutenberg`, `ebook`, `donations`, `electronic`, `support` : 0 thème) ; 6 thèmes, **6/6** avec un jeu de preuves exploitable en cross-source (`selectEvidence`, `distinctSources ≥ 2`). Dernier problème de corpus connu : **aucun**.

## Done
- [x] Scaffold Next.js 16 (App Router, TS, Tailwind v4) + shadcn/ui (radix, preset nova)
- [x] `.env.example` + validation env Zod (`lib/config/env.ts`)
- [x] `lib/db/client.ts` (better-sqlite3, WAL, foreign_keys, migrator) + `migrations/001_v1_2.sql` (schéma v1.2 verrouillé)
- [x] Repositories : sources (ingest_status dérivé des jobs), fragments, jobs (lease/token/checkpoint/idempotency/recovery/retry/backoff)
- [x] `lib/llm/*` : LlmProvider, GroqProvider, OllamaChatProvider, OllamaProvider, HybridProvider, embedding-codec Float32 LE L2 (contrôles de lecture)
- [x] `lib/ingest/*` : normalisation Q17, parsers (texte/pdf-parse/fetch+Readability), chunker-v1 (2 000/800/2 400/300, locators UTF-16, surrogates), embedding-service, ingest-service (checkpoint, chaînage summary)
- [x] `lib/jobs/*` : worker (concurrence 1–2, backoff+jitter, Retry-After, max 5 attempts), bootstrap (recovery au boot), instrumentation.ts
- [x] API : POST/GET `/api/sources` (201/409/422/400), GET/DELETE `/api/sources/:id` (stale=1), POST `/api/jobs/:id/retry` (200/404/409)
- [x] UI bibliothèque (shadcn) : import drag & drop + URL, table statuts, erreurs visibles, relance, suppression, polling 3 s
- [x] Tests vitest : chunker (bornes/overlap/UTF-16/locators), normalizer, embedding-codec, ingestion intégration (TEXT/URL/PDF, doublon URL), crash/reprise 0 doublon, lease expiré/valide, idempotency, token obligatoire, summary (missing key, requeue, max attempts)
- [x] README (Ollama, env vars, validation, local-first) + PROGRESS.md

## Remaining
- [x] Vérification finale : `npm run typecheck` ✓, `npm test` (42/42) ✓, `npm run lint` ✓, `npm run build` ✓, smoke test serveur (201/409/400/204, retries → failed structuré sans Ollama)
- [x] Test navigateur avec Ollama réel : TEXT/PDF/URL importés, embeddings nomic-embed-text (768 dims, L2=1.0), locators exacts (`p.1;`, `#en-tête;`), overlap 300, résumés qwen3:8b en français, rendu UI vérifié (DOM + screenshot)
- [x] Correctifs issus du test réel : timeouts fetch sur les providers LLM (chat 120 s, embed 30 s) — un LLM muet ne laisse plus un job running à vie
- [x] Test provider Groq avec clé réelle : clé valide, résumé `done` via `qwen/qwen3.8-27b` (1 appel, JSON + Zod OK), embeddings toujours locaux. Déviation documentée : le modèle PRD `llama-3.3-70b-versatile` n'existe plus chez Groq → défaut mis à jour en `qwen/qwen3.8-27b` (env.ts, .env.example, README)
- [x] Phase 1B — validation DB/CLI sur corpus réel : **12 documents / 5 domaines (Histoire, Philosophie, Littérature, Science, Économie)** ingérés (Gutenberg + Wikisource FR, + Bastiat via wikitexte) — `npm run validate:corpus` (scripts/validate-phase-1b.mjs + data/corpus_manifest.json) → **PASS** : 3 731 fragments ≤ 5 000, locators re-slicés 3 731/3 731 (100 %), BLOB conformes 3 731/3 731 (100 %), chunk_index séquentiels 12/12, 0 job failed
- [x] Correctifs issus de la 1B : fallback parser URL MediaWiki (`#mw-content-text` — Wikisource DjVu passait de 133 à 188 KB extraits), timeouts chat couvrant fetch **et** corps (Groq/Ollama — un corps lent ne bloque plus le job), timeout fetch URL 15 → 45 s (pages « texte entier » réelles), liste `/api/sources` sans `raw_content` (17 KB vs ~5 MB par poll)
- [x] Phase 2A — PoC découverte CLI (jalon bloquant, SANS UI) : `lib/discover/*` (sampler Q20 déterministe top-3+2 clusters+1 lointain, prompt discovery-v3, parser Zod + rattachement `candidate_id`, normalisation épistémique FACT→INFERENCE, `content_sig`), `lib/repositories/suggestions.ts` (dédup `pair_key`/`relation_type`/`content_sig`, variantes bloquées, intra-source interdit), `discovery-service` (reprise au checkpoint + compteurs cumulés + cache de prompt), job `discover` dans le worker, `scripts/discover.mjs` + `scripts/evaluate-phase-2a.mjs` (grille 2 évaluateurs + signal mots-clés + verdict programmatique). Tests : 82/82
- [x] Phase 2A — run de validation sur le corpus de 12 docs (endpoint chat configurable : NVIDIA NIM free tier, `nvidia/nemotron-3-super-120b-a12b`), budget strictement égal aux deux runs (48 paires, batchs de 4, troncature 1 200) :
  - **val-div** (diversifié) : 19 suggestions · **15 non-évidentes** (signal mots-clés) · 14 cross-domain · 0 écarté · 12 appels
  - **val-base** (baseline top-6 cosine) : 16 suggestions · 11 non-évidentes · 13 cross-domain · 0 écarté · 12 appels
  - Critères : ≥ 3 non-évidentes ✓ (26) · ≥ 1 analogie cross-domain ✓ · 0 fragment inexistant ✓ · ≤ 50 appels batch ✓ (24) · diversification ≥ baseline ✓ (15 > 11) · **« < 30 % triviales/fausses » : 26 % au sens littéral du protocole, mais ~40 % selon une lecture sémantique** (voir Remaining)
- [x] Correctifs issus de la 2A (chacun avec test quand applicable) :
  - `GROQ_MAX_TOKENS` explicite — sans lui Groq réserve la sortie max contre la fenêtre TPM (8 000/min) : appels **11,8 s → 1,6 s** et fin des 429 en rafale
  - `GROQ_BASE_URL` configurable + `Authorization` omis si clé vide (endpoints anonymes : OVHcloud AI Endpoints) — l'app ne dépend plus d'un seul fournisseur
  - Extraction du JSON **noyé dans de la prose** (`lib/llm/chat.ts`) : beaucoup de modèles bavardent même en `response_format=json_object`
  - Reaper des leases expirés (toutes les 30 s, pas seulement au boot) — un job `running` au lease périmé n'est plus bloqué à vie
  - Diagnostics : cause racine des erreurs réseau (`UND_ERR_*`, `ECONNRESET`), modèle + endpoint dans les erreurs HTTP, retries 429 tracés, durée de chaque batch LLM
- [ ] Phase 2A — itération qualité avant de clore le jalont (le protocole exige 2 évaluateurs indépendants ; `data/eval/notes_evaluateur{1,2}.json` reste à remplir, le verdict est alors calculé automatiquement) :
  - **Défaut 1 — claims génériques** : ~14/35 suggestions sont vraies mais banales (« Both authors assert that observation is essential… », figures d'autorité, « maître/apprenti »). Piste : bannir les formulations « les deux affirment que… », exiger un mécanisme commun explicite et une conséquence non triviale
  - **Défaut 2 — ancrage lexical déguisé** : ex. « une corde suspend un objet » (Madame Bovary ↔ Voyage au centre de la Terre) — le signal mots-clés la classe « non-évidente » mais c'est un ratelier sur un mot. Piste : rejeter les connexions dont le seul appui est un terme partagé sans relation sémantique
  - **Défaut 3 — quasi-doublons** : la même idée revient 4× (» réduire les phénomènes à des conditions simples ↔ clarté et distinction ») sur des paires différentes, donc la dédup `pair_key` ne les attrape pas. Piste : dédup sémantique inter-suggestions du même run
  - **Défaut 4 — langue** : plusieurs claims sortent en anglais sur un corpus français. Piste : imposer la langue de sortie dans le prompt
- [ ] Phases 2B–4 : moteur discover persistant, feed + canvas + Constructions + STALE, investigation 1 agent

## Pièges d'environnement (rencontrés, à connaître)
- **Next.js n'écrase jamais `process.env`** : une variable exportée dans le shell (ici `GROQ_CHAT_MODEL`, `GROQ_API_KEY`) prend le pas sur `.env.local`. Symptôme observé : le modèle « par défaut du schéma » était utilisé malgré un `.env.local` correct → `freebuff`/serveur à relancer avec `unset GROQ_* LLM_CHAT_PROVIDER` ou `env -u …`.
- **Le HMR de `next dev` tue le worker** : éditer un fichier pendant un run discover laisse le job `running` avec un lease périmé et sans aucun log (le process HTTP, lui, répond). Ne pas éditer pendant un run, ou redémarrer ensuite ; le reaper finit par récupérer le job.
- **Quotas LLM gratuits** : le TPD Groq est par modèle mais le compte se fait throttler globalement (`Retry-After` 1 500 s observés) ; Mistral `free` peut être à `x-ratelimit-limit-req-minute: 0` sur un compte donné ; OVHcloud anonyme = ~1 requête sur 4 ; les gateways communautaires (LLM7, Kilo) sont instables. Toujours vérifier le modèle *exact* disponible (un id inconnu renvoie un 404 texte qui ressemble à une panne réseau).

## Ideas
- Bouton « Voir le texte » d'une source (lecture du raw_content) pour vérifier les locators
- Pagination/limite sur la table bibliothèque pour gros corpus
- Observabilité : logger les erreurs de job côté serveur (aujourd'hui elles ne sont visibles qu'à l'échec final, dans la DB)
- Surveiller l'événement `SQLITE_NOMEM` transitoire (observé 1× sur GET liste pendant ingestion, non reproduit ; si récidive : `cache_size` + pagination)