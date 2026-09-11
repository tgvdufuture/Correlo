# Amendement PRD v1.3 — Synthèses & Conversation

Statut : **à valider** (proposé le 2026-09-11) · Amende le PRD v1.2 (Locked) · Ne remplace aucune section non citée.

## 0. Pourquoi cet amendement

Constat de validation : le PRD v1.2 définit l'unité de sortie comme une **Suggestion = connexion entre exactement deux fragments de deux sources**, bornée à 3 relations (`analogy`/`contradiction`/`cause`), et mesure la qualité par « **non-évidente = introuvable par recherche par mots-clés** » (§4, Phase 2A).

Cela produit des phrases du type « ces deux passages se répondent parce que… », jamais une **synthèse** du type :

> « Le néo-brutalisme reprend les codes du brutalisme en y ajoutant une dimension plus personnelle. »

Cette phrase n'est aucune des 3 relations : elle **ajoute** aux documents un énoncé qu'aucun ne porte seul, et elle reste vraie pour n'importe quel domaine (architecture, droit, cuisine, code). C'est le niveau que le produit doit atteindre : une **proposition** multi-sources, traçable, qui ouvre ensuite une conversation.

**Conséquence** : ce n'est pas un réglage de prompt. Il faut une entité et une phase nouvelles, **sans toucher au schéma verrouillé de la Suggestion** (§3.2 et §3.3 restent intacts).

## 1. Ce qui change dans le PRD

| Section v1.2 | Changement v1.3 |
|---|---|
| §0 Executive Summary | Le produit ne s'arrête plus à la suggestion : il propose des **Synthèses** (multi-sources, citées), que l'utilisateur explore ensuite en conversation avec un agent (interne + web). |
| §1.3 Non-Goals | « Aucune vérification web » devient : **web autorisé uniquement en Phase 6** (conversation), jamais dans la découverte, toujours sur action explicite et avec citation. « Graphie de connaissances autonome » reste exclu. Ingestion **image/audio/vidéo** : hors périmètre v1.3, décision reportée (voir §7). |
| §3.1 Architecture | Ajout : thèmes par clustering d'embeddings **locaux** (aucun appel réseau), moteur de synthèse (1 appel LLM par thème), agent de conversation confiné à `lib/agent/` (seul module autorisé à sortir sur le web). |
| §3.3 Data Models | Ajout de `themes` et `syntheses` (nouvelles tables). **Aucune colonne ajoutée** à `sources`, `fragments`, `suggestions`, `jobs`. `constructions` inchangée (voir §5, décision reportée). |
| §4 Roadmap | Ajout des **Phases 5A/5B** (synthèses) et **Phase 6** (conversation). Les Phases 1A–4 restent valides et inchangées. |
| §6 Success Metrics | Ajout des critères de lancement des synthèses (voir §4.4). Les métriques v1.2 restent valides pour le feed de suggestions. |

Ce qui **ne change pas** : la §3.2 *DO NOT CHANGE* dans son intégralité (schéma des suggestions, `pair_key`, blocage de variantes, statuts épistémiques, intra-source interdit, no-fallback, confinement LLM). Les Phases 2A/2B restent le **socle de preuve** : elles produisent des relations fiables, qui servent d'indices au moteur de synthèse.

## 2. Phase 5A — Moteur de synthèses (PoC CLI, sans UI) — jalon bloquant

**Goal** : prouver qu'à partir d'un corpus de 12–15 documents hétérogènes, le moteur produit des synthèses **multi-sources, ajoutant** quelque chose aux documents, entièrement traçables — sans qu'on lui fournisse de question.

**Dependency** : Phase 1B complète (corpus ingéré + embeddings). Indépendant de 2A/2B (la synthèse travaille sur les fragments ; les paires ne sont pas requises).

### 2.1 Pipeline

1. **Thèmes déduits du corpus** (`lib/synth/themes.ts`)
   - k-means déterministe (seed = `sha256(corpus_hash | run_id)`) sur les embeddings locaux des fragments, `k = clamp(round(n_fragments / 25), 4, 24)`.
   - Label du thème = termes **distinctifs** (TF-IDF du cluster), calculé sans LLM → gratuit, local, reproductible.
   - Aucune catégorie de domaine codée en dur : le moteur ne sait pas que le corpus parle d'architecture, de droit ou de code.
2. **Sélection des preuves** (`lib/synth/select.ts`)
   - Pour chaque thème : 2 à 4 fragments issus de **sources distinctes** (≥ 2 sources), choisis pour maximiser la **diversité** (1 par source, les plus éloignés dans le cluster), jamais les plus proches — sinon on reproduit le baseline trivial « top-6 cosine ».
3. **Synthèse** (`lib/synth/prompts.ts` + `synth-service.ts`)
   - 1 appel LLM par thème, sortie Zod : `{ synthesis, relation_kind, evidence: number[], confidence }`.
   - Le serveur assigne les indices des preuves : le modèle **ne renvoie jamais d'IDs** (même règle que 2A) et ne peut citer qu'un fragment fourni.
   - Consigne centrale : *« Énonce ce que ces documents permettent d'affirmer **ensemble** et qu'aucun ne dit seul. Si tu ne peux rien ajouter, skip. »*
   - `relation_kind` (vocabulaire **étendu**, la synthèse n'est pas une relation de paire) : `combination` (fusion de deux apports), `extension` (l'un prolonge/actualise l'autre), `tension` (ils se contredisent et la synthèse arbitre), `application` (un principe d'un document éclaire un cas d'un autre).
4. **Barrière déterministe** (`lib/quality/text-rules.ts`, généralisation de `claim-rules.ts` déjà en place)
   - Refus si : < 2 sources distinctes · paraphrase d'une preuve (recouvrement lexical trop fort) · placeholders (« Texte 1 », « A ») · formule générique · langue ≠ corpus · > 60 mots ou > 2 phrases · quasi-doublon d'une synthèse existante (`content_sig` + recouvrement inter-synthèses) · > 3 synthèses pour un même thème.
   - Les 4 défauts mesurés sur la Phase 2A (générique, ancrage lexical, quasi-doublons, langue) sont donc **inaccessibles** à la base, pas seulement déconseillés au modèle.
5. **Traçabilité**
   - `evidence_fragment_ids` + `provenance_snapshot` (source, hash, locator, texte) à la création, comme les Constructions.
   - Vérification programmatique : chaque fragment cité existe et son texte correspond (réutilise la validation prévue en Phase 4).
6. **Reproductibilité** : `run_id`, `corpus_hash`, `seed`, `sampler_version`, `prompt_version`, `chat_model` persistés ; ≤ 40 appels batch par run de 12–15 documents.

### 2.2 Acceptance Criteria (Phase 5A)

- AC1 : un run produit des `themes` et des `syntheses` persistées, avec `evidence_fragment_ids` ≥ 2 et `parent_source_ids` ≥ 2 sources distinctes — **0 synthèse mono-source**, **0 fragment inventé**.
- AC2 : rejouer le même run (même `run_id`, même corpus) sélectionne les **mêmes** thèmes et preuves, et n'insère **0** nouvelle synthèse (dédup `content_sig`).
- AC3 : une synthèse dont une preuve est une paraphrase littérale du document est refusée par la barrière (test unitaire).
- AC4 : la synthèse est en français si le corpus est français, quel que soit le modèle (barrière déterministe).
- AC5 : le CLI `scripts/synthesize.mjs` produit un rapport lisible (thème, synthèse, `relation_kind`, preuves citées avec locators) sans UI.

### 2.3 Protocole d'évaluation (Q25 — remplace la grille 2A **pour cette phase**)

- 2 évaluateurs indépendants, grille par synthèse :
  - `apport_precis` : dit quelque chose qu'**aucune** des preuves ne dit seule (le niveau « néo-brutalisme »).
  - `apport_generique` : vraie mais triviale / simple résumé.
  - `fausse` : contredite par les preuves.
  - `preuve_invalide` : fragment cité inexistant ou texte non correspondant.
  - `hallucination` : affirmation non traçable dans les preuves.
- **Baseline** : « résumé par thème » — mêmes thèmes, mêmes fragments, même nombre d'appels, mais consigne de résumé au lieu de synthèse. La synthèse doit faire **au moins aussi bien** en `apport_precis` que le résumé.
- Pass/fail : **≥ 3 `apport_precis`** · **< 30 % `apport_generique` + `fausse`** · **0 hallucination** · **0 preuve invalide** · ≤ 40 appels batch.
- Fail ⇒ itérer ici (thèmes, sélection des preuves, prompt, barrière), pas en Phase 5B.

## 3. Phase 5B — Feed de synthèses + exploration

**Goal** : rendre les synthèses actionnables, avec provenance préservée.

- AC1 : un feed de synthèses triées par thème puis `confidence`, une seule synthèse par (`theme_id`, `content_sig`).
- AC2 : chaque synthèse affiche ses preuves citables (source, locator, texte) et son `provenance_snapshot`.
- AC3 : accepter/rejeter une synthèse est persistant ; une synthèse rejetée ne réapparaît pas, y compris **reformulée** (dédup `content_sig` + variantes bloquées par `theme_id`).
- AC4 : suppression/ré-ingestion d'une source ⇒ synthèse `stale = 1`, `provenance_snapshot` intact et affichable.
- AC5 : les Constructions v1.2 restent inchangées ; une synthèse **n'écrit pas** dans `constructions` (voir §5).

## 4. Phase 6 — Conversation (agent interne + web + workspace)

**Goal** : depuis une synthèse (ou le corpus), converser avec un agent qui répond en citant ses sources, internes **et** externes.

- AC1 : chaque affirmation de l'agent porte une provenance : `fragment_id` (+ locator), `url` (web), ou `chemin:ligne` (fichier du workspace). Une affirmation sans provenance est affichée comme « non sourcée » et n'est **jamais** présentée comme un fait.
- AC2 : l'accès web est **explicite** (action utilisateur visible) et **confiné à `lib/agent/`** — la découverte et l'ingestion restent 100 % locales (G3 v1.2 préservé).
- AC3 : l'agent peut lire un **workspace local** désigné par l'utilisateur (lecture seule, chemins confinés, jamais d'écriture).
- AC4 : la conversation peut créer une note liée à la synthèse (question/ réponse/ sources), sans modifier les fragments ni les synthèses.
- AC5 : ≤ 5 étapes de raisonnement par tour, comme la Phase 4 (héritage direct).

## 5. Décision reportée (à trancher en v1.4)

- **Construction depuis une synthèse** : `constructions.suggestion_id` est `UNIQUE` et `depth = 1` (§3.3). Promouvoir une synthèse sur le canvas exigerait soit une colonne `synthesis_id`, soit un nœud de canvas distinct. **v1.3 ne tranche pas** et n'ajoute rien : les synthèses vivent dans leur propre feed.
- **Ingestion multimodale** (image d'architecture, plan) : nécessiterait une colonne `modality` sur `fragments` (§3.3 verrouillé) ou une table dérivée + embeddings image. Hors périmètre v1.3 ; l'exigence réelle retenue ici est l'**agnosticisme au domaine**, pas le multimodal.

## 6. Direction de code

**Réutilisé tel quel** : ingestion/chunking/normalisation, embeddings locaux, jobs + lease + checkpoint + recovery, provenance/`provenance_snapshot`, provider chat configurable (`GROQ_BASE_URL`, timeout, `max_tokens`), dédup `content_sig`, protocoles 2 évaluateurs et scripts d'évaluation, et la **barrière qualité déterministe** livrée le 2026-09-11.

**Nouveau** :
- `lib/quality/text-rules.ts` — règles partagées paires/synthèses (générique, placeholders, langue, quasi-doublons).
- `lib/synth/themes.ts`, `lib/synth/select.ts`, `lib/synth/prompts.ts`, `lib/synth/synth-service.ts`.
- `lib/repositories/syntheses.ts`, `lib/repositories/themes.ts` + migration (`themes`, `syntheses`).
- Job `synthesize` dans le worker, `scripts/synthesize.mjs`, `scripts/evaluate-phase-5a.mjs`.
- `lib/agent/` (Phase 6) : outils internes (recherche dans les fragments), web (explicite, citée), workspace (lecture seule).

**Le socle paire (2A/2B) reste en service** : son feed v1.2 est valide, et ses relations (`analogy`/`contradiction`/`cause`) deviennent des **indices optionnels** injectés dans le prompt de synthèse (v1.3 : la synthèse s'appuie sur les fragments ; l'injection des paires est un réglage de qualité, pas une dépendance).

## 7. Données — modèles ajoutés (§3.3 bis)

`themes`

| Champ | Type | Notes |
|---|---|---|
| id | uuid PK | |
| run_id, corpus_hash, seed | TEXT | reproductibilité (§2.1) |
| label | TEXT | libellé TF-IDF du cluster (sans LLM) |
| centroid | BLOB | Float32 LE, L2-normalisé, même format que les fragments |
| size | INTEGER | nombre de fragments du cluster |
| sampler_version, prompt_version, chat_model | TEXT | traçabilité du run |
| created_at | timestamp | |

`syntheses`

| Champ | Type | Notes |
|---|---|---|
| id | uuid PK | |
| text | TEXT NOT NULL | l'énoncé de synthèse (≤ 60 mots) |
| theme_id | FK themes ON DELETE CASCADE | |
| relation_kind | TEXT | `combination` \| `extension` \| `tension` \| `application` |
| epistemic_status | TEXT NOT NULL | jamais FACT : INFERENCE, ou HYPOTHESIS si < 3 sources ou preuve non vérifiée |
| parent_source_ids, evidence_fragment_ids | JSON (uuid[]) | ≥ 2 sources distinctes ; validation applicative obligatoire (pas de vraie FK) |
| provenance_snapshot | JSON | source, hash, locator, texte au moment de la création |
| content_sig | TEXT NOT NULL UNIQUE | SHA256(texte canonicalisé) — dédup des reformulations |
| confidence | TEXT | `low` \| `medium` \| `high` (proposé par le modèle, jamais élevé automatiquement) |
| state | TEXT | `proposed` \| `accepted` \| `rejected` \| `stale` |
| stale | INTEGER DEFAULT 0 | source supprimée / ré-ingérée |
| prompt_version, chat_model | TEXT NOT NULL | |
| created_at | timestamp | |

## 8. Métriques (§6 bis)

Launch Criteria (évalués après Phase 5A) — tous vrais avant de continuer :

- ≥ 3 synthèses `apport_precis` par session sur 12–15 documents réels.
- < 30 % `apport_generique` + `fausse` ; **0 hallucination** ; 0 preuve invalide.
- La synthèse fait au moins aussi bien que le baseline « résumé par thème ».
- ≥ 1 conversation engagée par session (Phase 6) et ≥ 20 % des synthèses acceptées.

Primary metric (inchangée dans sa formulation v1.2, étendue) : **découvertes « wow » par session** — désormais mesurée aussi sur les synthèses (`apport_precis`), pas seulement sur les paires.
