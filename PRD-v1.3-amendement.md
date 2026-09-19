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

> **Révision du 2026-09-13 — décision utilisateur : les thèmes (clusters d'embeddings) sont abandonnés au profit des graines.** Mesures sur le corpus réel : le k-means **brut** retrouvait les *documents* (15 clusters mono-source sur 24, 493 fragments jetés) ; le débruitage de la composante document (`themes-v2`) ne gardait que ce qui *s'écarte* d'un document — donc ses fragments atypiques — et **20 libellés sur 24 sont devenus du bruit lexical** (`hommes · homme · their · rodolphe`, `nature · herself · there · black`) avec un document dominant à 63 %. Le clustering **lexical** (TF-IDF) a été mesuré puis écarté aussi (Bovary 100 %, Renan 99 %, Bernard 97 % : le vocabulaire propre à chaque œuvre écrase le sujet partagé). Conséquence vérifiée côté LLM : *avec* raisonnement activé, `qwen/qwen3.8-27b` skippe 3 thèmes sur 3 en jugeant le rapprochement « a keyword match that doesn't correspond to a real intellectual thread », et `openai/gpt-oss-120b` ne produit sur le même prompt qu'un énoncé **générique**. La couche d'ancrage était donc le défaut bloquant, pas le modèle.

1. **Graines déduites du corpus** (`lib/synth/seeds.ts`, `seeds-v1`) — remplace le clustering
   - Une graine = **une paire de fragments de deux documents différents**, produite par le sampler déterministe de la Phase 2A (`samplePairs`, seed = `sha256(corpus_hash | run_id)`), déjà mesuré sur ce corpus (15 suggestions non-évidentes cross-domain). Le rapprochement est donc **une preuve sélectionnée**, pas la moyenne d'un groupe à interpréter.
   - Tri par cosinus décroissant : une synthèse a besoin de deux documents qui se **rencontrent**. Les quasi-doublons (cosinus > 0,95) sont écartés — le second n'ajouterait rien au premier — et l'appareil (sommaire, notes, index) est retiré du pool **avant** l'échantillonnage.
   - Équilibre : `max_seeds_per_source` (défaut 3) borne la contribution de chaque document, sinon un document volumineux accapare le run (mesuré : *Madame Bovary* = 494 fragments contre ~30 pour certains textes).
   - Label de la graine = termes **partagés** par ses deux fragments, les plus discriminants d'abord (TF-IDF du corpus, plancher `df ≥ 3` : sans ce plancher, le libellé d'une graine réelle était `disparoitre · forger · sourioient · calomniateur`, des coquilles d'OCR). Aucun terme partagé ⇒ repli explicite sur les titres : l'absence de recouvrement est une information, pas un silence.
   - Aucune catégorie de domaine codée en dur : le moteur ne sait pas que le corpus parle de science, d'histoire ou de littérature.
2. **Preuves** (`lib/synth/select.ts`)
   - La graine **est** le jeu de preuves (2 fragments, 2 documents). `selectEvidence` n'apporte plus qu'une fonction de **garde-fous** : filtre d'appareil (par locator notamment : `#FOOTNOTES`, `#NOTES`, `#TABLE DES MATIÈRES`) et refus des quasi-doublons. Une graine qui retombe sous 2 preuves utilisables est écartée (`noEvidence`), pas forcée.
3. **Synthèse** (`lib/synth/prompts.ts` + `synth-service.ts`)
   - 1 appel LLM par graine, sortie Zod : `{ synthesis, relation_kind, evidence: number[], confidence }`.
   - Le serveur assigne les indices des preuves : le modèle **ne renvoie jamais d'IDs** (même règle que 2A) et ne peut citer qu'un fragment fourni.
   - Consigne centrale (`synthesis-v2`) : *« Énonce ce que ces deux documents permettent d'affirmer **ensemble** et qu'aucun ne dit seul. »* La révision v2 corrige un défaut mesuré du prompt v1 : il faisait du skip la sortie la plus sûre (« il vaut infiniment mieux renvoyer skip ») et le modèle s'en servait comme réponse par défaut (10 thèmes → 10 skips, sans même lire les preuves). Le prompt dit désormais **pourquoi** la graine existe et fait du skip un constat précis et argumenté ; la barrière déterministe reste le juge des énoncés creux.
   - `relation_kind` (vocabulaire **étendu**, la synthèse n'est pas une relation de paire) : `combination` (fusion de deux apports), `extension` (l'un prolonge/actualise l'autre), `tension` (ils se contredisent et la synthèse arbitre), `application` (un principe d'un document éclaire un cas d'un autre).
4. **Barrière déterministe** (`lib/quality/text-rules.ts`, généralisation de `claim-rules.ts` déjà en place)
   - Refus si : < 2 sources distinctes · paraphrase d'une preuve (recouvrement lexical trop fort) · placeholders (« Texte 1 », « A ») · formule générique · langue ≠ corpus · > 60 mots ou > 2 phrases · quasi-doublon d'une synthèse existante (`content_sig` + recouvrement inter-synthèses) · > 3 synthèses pour une même graine.
   - Les 4 défauts mesurés sur la Phase 2A (générique, ancrage lexical, quasi-doublons, langue) sont donc **inaccessibles** à la base, pas seulement déconseillés au modèle.
5. **Traçabilité**
   - `evidence_fragment_ids` + `provenance_snapshot` (source, hash, locator, texte) à la création, comme les Constructions.
   - Vérification programmatique : chaque fragment cité existe et son texte correspond (réutilise la validation prévue en Phase 4).
6. **Reproductibilité** : `run_id`, `corpus_hash`, `seed`, `sampler_version`, `prompt_version`, `chat_model` persistés ; ≤ 40 appels batch par run de 12–15 documents.
   - Le rapport d'un run est reconstruit à chaque passe : les énoncés du run sont lus **en base** (`theme_id ∈ seed_ids`), pas dans le compteur de la passe courante (un rejeu en crée 0 et écraserait sinon la liste), et chaque passe est conservée dans `passes` avec son coût propre.
   - **Cache de prompt persisté** (migration `004_llm_cache.sql`), clé = `SHA256(chat_model | prompt_version | messages)`. Un rejeu du même run ne rappelle pas le modèle — sans quoi, celui-ci **reformulant** la même réponse, `content_sig` ne pourrait rien dédupliquer et l'AC2 serait hors de portée. Le « déjà formulé » injecté dans le prompt est celui des énoncés **déjà persistés du run, filtrés aux graines précédentes** (`persistedTextsBySeed`) : le prompt d'une graine est alors une fonction pure de (graine, preuves, `run_id`), donc identique sur un premier passage, une reprise au checkpoint et un rejeu — condition des clés de cache stables (mesuré : un rejeu fait 0 appel et 0 insertion). L'anti-répétition reste **garanti par la barrière déterministe**, pas par le prompt.
   - **Attente inter-graines conditionnelle** : la pause de quota n'est payée que par une graine qui a **réellement appelé** le LLM. Sans cette condition, un rejeu (12 graines, 0 appel) coûtait 12 × 65 s et dépassait le `--wait` du CLI — le run n'était alors jamais rapporté (constaté sur le rejeu réel du 2026-09-14).

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

- **Construction depuis une synthèse** : `constructions.suggestion_id` est `UNIQUE` et `depth = 1` (§3.3). Promouvoir une synthèse sur le canvas exigerait soit une colonne `synthesis_id`, soit un nœud de canvas distinct. **v1.3 ne tranche pas** et n'ajoute rien : les synthèses vivent dans leur propre feed. → **voie ouverte par §9** : le canvas accepte désormais des éléments polymorphes (`canvas_items.item_kind`), donc « un nœud de canvas distinct » est le chemin naturel — reste à décider du contenu d'une synthèse posée sur le plan.
- **Ingestion multimodale** (image d'architecture, plan) : nécessiterait une colonne `modality` sur `fragments` (§3.3 verrouillé) ou une table dérivée + embeddings image. Hors périmètre v1.3 ; l'exigence réelle retenue ici est l'**agnosticisme au domaine**, pas le multimodal.

## 6. Direction de code

**Réutilisé tel quel** : ingestion/chunking/normalisation, embeddings locaux, jobs + lease + checkpoint + recovery, provenance/`provenance_snapshot`, provider chat configurable (`GROQ_BASE_URL`, timeout, `max_tokens`), dédup `content_sig`, protocoles 2 évaluateurs et scripts d'évaluation, et la **barrière qualité déterministe** livrée le 2026-09-11.

**Nouveau** :
- `lib/quality/text-rules.ts` — règles partagées paires/synthèses (générique, placeholders, langue, quasi-doublons).
- `lib/synth/themes.ts`, `lib/synth/select.ts`, `lib/synth/prompts.ts`, `lib/synth/synth-service.ts`.
- `lib/repositories/syntheses.ts`, `lib/repositories/themes.ts` + migration (`themes`, `syntheses`).
- Job `synthesize` dans le worker (migration `003_jobs_synthesize.sql`), `scripts/synthesize.mjs`, `scripts/evaluate-phase-5a.mjs`.
- `lib/repositories/llm-cache.ts` + migration `004_llm_cache.sql` — cache de prompt persisté (reproductibilité, AC2).
- `lib/ingest/title.ts` — un titre de source issu d'un nom de fichier abîmé (U+FFFD) n'est jamais stocké tel quel : il apparaîtrait dans le prompt et dans la provenance.
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
| centroid_dimensions | INTEGER | 768 en production — nécessaire pour relire le BLOB avec le codec contrôlé |
| size | INTEGER | nombre de fragments du cluster |
| sampler_version | TEXT | version de l'algorithme de thèmes (`themes-v1`) |
| created_at | timestamp | |

> Pas de `prompt_version` / `chat_model` sur un thème : le clustering et les libellés
> sont **entièrement locaux** (k-means + TF-IDF), aucun LLM n'intervient à ce niveau.

`syntheses`

| Champ | Type | Notes |
|---|---|---|
| id | uuid PK | |
| text | TEXT NOT NULL | l'énoncé de synthèse (≤ 60 mots) |
| theme_id | FK themes ON DELETE CASCADE | |
| relation_kind | TEXT | `combination` \| `extension` \| `tension` \| `application` |
| epistemic_status | TEXT NOT NULL | contrainte `CHECK (IN ('INFERENCE','HYPOTHESIS','SPECULATION'))` : un FACT est **refusé par la base**, pas seulement déconseillé |
| parent_source_ids, evidence_fragment_ids | JSON (uuid[]) | ≥ 2 sources distinctes ; validation applicative obligatoire (pas de vraie FK) |
| provenance_snapshot | JSON | source, hash, locator, texte au moment de la création |
| content_sig | TEXT NOT NULL UNIQUE | SHA256(texte canonicalisé) — dédup des reformulations |
| confidence | TEXT | `low` \| `medium` \| `high` (proposé par le modèle, jamais élevé automatiquement) |
| state | TEXT | `proposed` \| `accepted` \| `rejected` (la péremption est portée par `stale`, pas par l'état) |
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

## 9. Amendement v1.4 (2026-09-16) — le canvas comme atelier

Statut : **validé par l'utilisateur** · Amende la §4 (Phases 2B/3) et la §3.3 *bis* · Ne change **aucun** critère d'acceptation existant.

### 9.1 Pourquoi

Le PRD (v1.2 §4, Phase 3) parle de « la Construction sur son canvas » sans jamais définir l'écran, et ne connaît qu'un seul type d'objet posable : les Constructions. Or l'usage réel du produit est **l'inverse** : on dépose des **documents**, on les dispose, et on veut voir ce que le moteur en tire — une suggestion relie deux **fragments**, donc deux **sources**, et rien dans l'écran ne montrait ces sources. Demande de l'utilisateur : « que le canvas soit la page principale, que l'upload affiche les fichiers dans le canvas comme pour stocker, avec la disposition modulable comme Photoshop, et qu'en parallèle l'IA s'interroge sur les fichiers et propose des liens entre eux ».

Trois décisions tranchées avec l'utilisateur :

| Question | Décision |
|---|---|
| Que porte le canvas une fois les fichiers déposés ? | **Fichiers + liens + Constructions** |
| Quand l'IA cherche-t-elle des liens ? | **Automatiquement après dépôt** (à la fin de l'ingestion) |
| Que deviennent la Bibliothèque et la page Connexions ? | **Tout dans le canvas** (l'atelier est le lieu de travail ; les deux autres écrans restent, secondaires) |

### 9.2 Ce qui change dans le PRD

| Section | Changement v1.4 |
|---|---|
| §3.1 Architecture | L'écran d'entrée est un **plan de travail** (`/`) : sources, liens et Constructions sur une même surface, positions persistées. Aucun appel LLM nouveau : la découverte est celle de la Phase 2A, déclenchée par l'ingestion. |
| §3.3 Data Models | Les dispositions vivent dans des tables **nouvelles** (`canvas_items` polymorphe, `canvas_frames`), jamais dans une colonne d'une table verrouillée. |
| §4 Phase 3 | Les AC de la Phase 3 (feed AC1-AC3, US-05 à US-08) sont **inchangés** : l'atelier les rend visibles, il n'en retire aucun. La règle d'exposition §3.2 continue d'être posée par le feed **et** par le panneau de liens de l'atelier. |
| §4 Phase 2A/2B | Un run peut être **focalisé** (`focus_source_ids`) : les sources à examiner passent en tête de l'échantillonnage. `SAMPLER_VERSION` passe à `sampler-v2`. |
| §6 Métriques | Inchangées. L'atelier est le premier écran qui rend la métrique « ≥ 40 % de suggestions ouvertes » **directement actionnable** (l'ouvrir fait partie de la décision). |
| §5 (décision reportée) | La « promotion d'une synthèse sur le canvas » dispose désormais d'un chemin naturel (élément de canvas d'un troisième `item_kind`) ; la décision de fond reste ouverte. |

### 9.3 Modèles ajoutés (complément à §7)

`canvas_items` (migration `007`) — polymorphe :

| Champ | Type | Notes |
|---|---|---|
| item_kind | TEXT | `construction` \| `source` — `CHECK` |
| item_ref | TEXT | uuid de l'entité (`constructions.id` / `sources.id`) |
| x, y, z | REAL / INTEGER | positions **absolues** ; `z` = ordre d'empilement |
| frame_id | TEXT | → `canvas_frames(id)`, `ON DELETE SET NULL` (dissoudre ne déplace rien) |
| created_at, updated_at | timestamp | |
| — | — | `PRIMARY KEY (item_kind, item_ref)` |

SQLite n'a **pas** de clé étrangère polymorphe : l'intégrité est assurée par le dépôt (`prune()` retire les orphelines avant chaque lecture, et la suppression d'une source retire son élément dans la transaction qui la supprime).

`canvas_frames` (migration `006`) est inchangée : un cadre/groupe contient indifféremment des fichiers et des Constructions.

### 9.4 Réglages ajoutés

`AUTO_DISCOVER` (`on` par défaut), `AUTO_DISCOVER_MAX_PAIRS` (12), `AUTO_DISCOVER_MAX_PAIRS_PER_SOURCE` (12), `AUTO_DISCOVER_BATCH_SIZE` (4), `AUTO_DISCOVER_MAX_FRAGMENT_CHARS` (2400), `AUTO_DISCOVER_INTER_BATCH_DELAY_MS` (65 000 — fenêtre de quota du provider). `off` rend le comportement d'avant (run déclenché à la main).

### 9.5 Ce que cet amendement ne fait pas

- Il ne change **aucune** contrainte §3.2/§3.3 (schéma verrouillé, intra-source, blocage de variantes, statuts épistémiques, provenance copiée).
- Il n'ajoute **aucun** appel LLM dans les routes : l'analyse reste un job (`discover`), avec lease, checkpoint et reprise (Phase 2A/2B).
- Il ne supprime pas les écrans Bibliothèque et Connexions : ce sont des vues secondaires du même contenu, pas des flux parallèles.

## 10. Amendement v1.5 (2026-09-16) — connecteur d'embeddings et espace vectoriel du corpus

Statut : **validé par l'utilisateur** · Amende la §3.1 (architecture) et la §3.2 *DO NOT CHANGE* **sur une seule phrase** (l'origine des embeddings) · Ne change aucun critère d'acceptation.

### 10.1 Pourquoi

La §3.1 disait : « thèmes par clustering d'embeddings **locaux** (aucun appel réseau) », et `lib/llm/types.ts` (§3.2 *DO NOT CHANGE*) précisait « embed = Ollama local ». Conséquence opérationnelle : **un dépôt de fichier exigeait qu'Ollama tourne**, sinon l'ingestion s'arrêtait à l'étape d'embedding — alors que le chat, lui, passait déjà par un connecteur distant. Demande de l'utilisateur : « je ne veux pas utiliser Ollama mais les connecteurs API », avec une contrainte explicite : **pouvoir revenir à Ollama à tout moment, et que ça marche**.

Cette demande n'est pas qu'un réglage : un vecteur n'a de sens que dans l'espace qui l'a produit. Le service réel ne propose, sur le compte utilisé, **qu'un seul** modèle d'embeddings (`nvidia/nemotron-3-embed-1b`) et **2048 dims non négociables** (`768` → `400`). Basculer le connecteur laisse donc forcément deux espaces incomparables en base — et un corpus mixte ne produit pas une erreur : il produit des similarités **fausses mais plausibles** (`dotProduct(a, b, dims)` lit les `dims` premières valeurs de chaque vecteur).

### 10.2 Ce qui change dans le PRD

| Section | Changement v1.5 |
|---|---|
| §3.1 Architecture | Les embeddings ne sont plus « locaux » par définition : **connecteur configurable** — `ollama` (local, 768 dims, le **défaut**) ou `api` (endpoint OpenAI-compatible `POST /embeddings`, 2048 dims pour le modèle mesuré). Le chat reste inchangé. |
| §3.2 *DO NOT CHANGE* | **Une seule phrase change** : « embed = Ollama local » devient « embed = connecteur configurable (`EMBED_PROVIDER`) ». Les signatures de `LlmProvider`, le confinement LLM, l'absence de fallback automatique, le schéma des suggestions et toutes les autres contraintes sont **inchangés**. |
| §3.3 Data Models | **Aucune colonne ajoutée** aux tables verrouillées : `fragments.embedding_model/dimensions/version` existaient déjà et portent l'identité de l'espace. Migration `008` : `jobs.kind` accepte `reembed` (reconstruction de table, même procédure que la `003`). |
| §3.5 / Phase 2A | Nouvel **invariant dur** : un run refuse un corpus multi-espaces (`EmbeddingSpaceMismatchError`), avant tout appel LLM. Un run focalisé (`sampler-v2`) et les barrières existantes ne bougent pas. |
| §4 Roadmap | Aucune phase ajoutée, aucun AC modifié : la bascule est un **outil d'exploitation** (`npm run reembed`), pas une phase produit. |
| §6 Métriques | Inchangées. Elles se lisent désormais sur un corpus aligné — ce que l'atelier rend visible par un bandeau. |

### 10.3 L'invariant, et pourquoi il est un refus plutôt qu'un avertissement

Trois règles, toutes vérifiées côté serveur :

1. **Un run ne compare que des vecteurs du même espace** (identité complète : modèle, dimensions, version). Deux modèles de même dimension restent deux espaces. Violation ⇒ le run **échoue** en nommant les espaces présents et la commande de réparation, au lieu de rendre des liens faux.
2. **Rien n'est caché par un défaut de disposition ni par un défaut de configuration** : l'atelier affiche ce qui est hors espace (`GET /api/canvas → embeddingSpace`), et une configuration invalide ne rend pas l'écran indisponible — elle est nommée dans le bandeau.
3. **La réparation est la même commande dans les deux sens** : `npm run reembed` écrit le corpus entier dans l'espace **actif**, par lots (transaction par lot, corpus exploitable pendant l'opération), en **sautant** ce qui est déjà dans l'espace visé (donc reprenable après une coupure), et le CLI enregistre les espaces avant/après.

### 10.4 Réglages ajoutés

`EMBED_PROVIDER` (`ollama` | `api`, défaut `ollama`), `NVIDIA_BASE_URL`, `NVIDIA_API_KEY`, `NVIDIA_EMBED_MODEL` (`nvidia/nemotron-3-embed-1b`), `NVIDIA_EMBED_DIMENSIONS` (`2048`), `NVIDIA_EMBED_INPUT_TYPE` (`passage` | `query` | `off`), `NVIDIA_EMBED_BATCH_SIZE` (`32`), `NVIDIA_EMBED_TIMEOUT_SECONDS` (`120`). Le CLI accepte `--dry-run`, `--force`, `--sources`, `--batch-size`, `--wait`.

### 10.5 Ce que cet amendement ne fait pas

- Il ne change **aucune** contrainte de la §3.3 (aucune colonne ajoutée, aucun nouveau kind d'entité).
- Il ne modifie **pas** la formule d'identité d'un run (`corpus_hash = SHA256(source_id:content_hash)`, AC1 de la Phase 2B) : elle ne porte donc pas l'espace vectoriel. Conséquence écrite noir sur blanc dans le CLI : après une re-vectorisation, un run archivé n'est **plus reproductible à l'identique** bien que son identité se recalcule.
- Il ne rend pas le connecteur distant **obligatoire** ni ne retire Ollama : le défaut du schéma reste `ollama`, et le retour en 768 dims est une commande.
- Il ne touche pas à la qualité de la découverte : les essais réels montrent que la qualité du **rapprochement** suit celle des embeddings, mais le taux de suggestions retenues reste borné par les barrières de la Phase 2A (défaut « juxtaposition », déjà documenté). Sa règle en prose (`jux-prose-v1`) est **distincte** de celle des claims (`jux-v2`) : le verdict 2A gelé reste lisible sous sa propre version.

## 11. Phase 4 — investigation (implémentée le 2026-09-18)

Statut : **livrée** · N'ajoute **aucun** critère d'acceptation (US-09 AC1–AC3 du PRD v1.2 sont repris tels quels) · Ne modifie aucune table.

### 11.1 Ce que l'agent a le droit de faire

Un **seul** agent, une boucle séquentielle, **un appel LLM par étape**, **5 étapes au plus** (plafond dur : un payload qui demande plus est tronqué). Chaque étape est **une** action, choisie par le modèle parmi trois :

| Action | Entrée | Ce que le serveur fait |
|---|---|---|
| `search` | une requête libre | recherche **lexicale** sur le corpus (racines de 5 lettres, score IDF) — aucun appel réseau |
| `expand` | un indice de catalogue | voisinage **vectoriel** du fragment, dans un autre document (embeddings déjà en base) |
| `conclude` | un énoncé + des indices cités | termine l'enquête, sous réserve des règles du §11.3 |

Deux conséquences voulues : **AC3 est vrai par construction** (aucun outil de l'agent ne peut sortir sur le réseau, il n'en existe pas), et la recherche est **déterministe** (elle n'encode pas la requête, donc elle ne dépend ni du provider d'embeddings ni d'un appel supplémentaire).

### 11.2 Traçabilité : le modèle ne voit jamais d'identifiant

Le serveur tient un **catalogue** de fragments et n'expose au modèle que des **indices** (`[0]`, `[3]`…) ; le rattachement indice → fragment est serveur, comme le rattachement `candidate_id` de la Phase 2A. Le catalogue conserve une **copie** du texte au moment T (même logique que `provenance_snapshot`, US-08) : c'est elle qui est comparée au fragment vivant **à chaque lecture**. Trois pertes de statut, toutes testées : fragment disparu, texte modifié, source modifiée ; dans chaque cas l'étape passe `failed` et l'énoncé **n'est jamais présenté comme une preuve** (AC2).

### 11.3 La barrière de conclusion (`conclusion-v2`, 2026-09-18)

Le prompt seul ne suffisait pas — constaté deux fois sur des runs réels (corpus de 3 853 fragments) : le modèle a d'abord conclu **dès la première action**, à partir des deux seules graines, en reformulant la suggestion ; puis, une fois cette voie fermée, il a produit une **juxtaposition reformulée** (« … mais Bernard souligne …, tandis que Descartes montre … »). Cinq refus déterministes s'appliquent désormais côté serveur, dans un module **pur et partagé** (`lib/quality/conclusion.ts`, appelé par le service, le validateur et les tests — le service n'en réimplémente aucune) :

1. **`conclusion_sans_exploration`** — conclure sans qu'aucune exploration (`search`/`expand`) n'ait **abouti** est refusé : il n'y a rien d'approfondi dans une réponse qui n'a regardé que la question. Seule règle **de run** (elle lit la trace) ; les quatre suivantes lisent le **texte**.
2. **`conclusion_juxtaposition`** — deux **reports** (verbes : affirme, souligne, montre, considère…) coordonnés par un **connecteur de bipartition** (`tandis que`, `alors que`, `mais`, `cependant`, `en revanche`, `de son côté`, `;`) et **aucun prédicat relationnel** : l'énoncé redit les deux documents l'un après l'autre. La règle est **structurelle**, pas attributive : mesurée sur la sortie réelle, l'attribution d'une clause à son fragment par recouvrement lexical plafonne à **0,27** pour une clause qui le résume pourtant correctement — le modèle attribue sans reprendre les mots.
3. **`conclusion_recopie_la_question`** — une conclusion qui partage ≥ 80 % des termes significatifs de la suggestion ne l'approfondit pas, elle la rejoue. Le seuil est **propre à l'enquête** : le seuil partagé de paraphrase (`text-rules`, 0,85 — « un énoncé qui recopie une preuve ») a été mesuré à **0,846** sur cette sortie réelle, un cran sous la barre, et sert un autre problème — il n'a pas été touché.
4. **`conclusion_generique`** — formules holistiques, vraies de n'importe quelle paire (« tous deux », « les deux documents », « partagent la même exigence »…).
5. **`conclusion_hors_format`** / **`conclusion_langue`** — moins de 12 mots, plus de 160 mots, plus de 4 phrases, ou un énoncé non francophone. Le prompt demande 40–120 mots ; la barrière est plus large, elle ne coupe que ce qui n'est pas un énoncé.

Un refus **consomme l'étape mais ne termine pas l'enquête** : les cinq motifs sont **récupérables**, le modèle voit le refus et sa raison dans la transcription et se reprend dans le budget restant ; si le budget s'épuise, la raison rapportée est celle du refus, jamais un énoncé creux. Le prompt (`investigation-v2`) énonce les cinq motifs, **décrit** la juxtaposition et donne un contre-exemple réel : la règle est le juge, mais elle ne doit pas être une surprise.

**Effet mesuré** (même suggestion, même corpus, chemin réel job → worker) : avant → 1 étape, puis 3 étapes et une juxtaposition **acceptée** ; après → **5 étapes**, étapes 3 et 4 refusées (`conclusion_generique`), étape 5 acceptée avec une relation énoncée. Le document d'enquête porte `conclusion_rule_version` / `juxtaposition_rule_version` : un refus stocké nomme la règle qui l'a produit, et `npm run validate:phase4` re-joue la barrière sur toutes les conclusions stockées.

### 11.4 Ce que cet amendement ne fait pas

- Il ne garantit **pas** la **justesse** d'une relation : la barrière coupe la coordination **vide**, pas une relation fausse ou plaquée — « … trouve son équivalent dans …, mais l'un …, l'autre … » passe. Ce dernier cran demande une évaluation sémantique (modèle + lecture humaine), comme la grille Q25 de la 5A ; décision de protocole, pas de plomberie.
- Il n'ajoute **ni conversation ni accès web** : c'est la Phase 6, et l'agent d'investigation n'en est pas le socle (il ne lit que le corpus, il ne discute pas).
- Il ne tranche pas la promotion d'une synthèse ni celle d'une **investigation** sur le canvas (§5).
- Il ne rend pas un document d'enquête immuable : c'est un **résultat revérifié à chaque lecture**, pas un fait figé — la table ne stocke pas de `stale`, la vérification le remplace.

## 12. Phase 5B — feed de synthèses (implémentée le 2026-09-18)

Statut : **livrée** · Reprend les AC1–AC5 du §3 tels quels · N'ajoute **aucune** table ni colonne (le schéma de la 5A suffit : `state` et `stale` existaient déjà, ils n'étaient juste pas servis).

### 12.1 Ce qui rend les synthèses actionnables

- **Feed** : `GET /api/syntheses` — tri **par thème puis `confidence`** (high → medium → low, la plus récente d'abord à confiance égale), le tri vit **dans le dépôt** (une seule requête SQL pour l'écran et le validateur, ils ne peuvent pas diverger). Défaut de lecture `proposed` : une synthèse tranchée **quitte la file de travail** (AC3), mais reste visible avec `state=accepted|rejected|all`.
- **Preuves citables** : chaque ligne porte son `provenance_snapshot` **avec le verdict de la vérification recalculé à cette lecture** (règle partagée `lib/quality/evidence.ts`, importée par le serveur, le validateur et les tests — source unique, même parti pris que la Phase 4). Ce qui est affiché **est** le snapshot : la copie au moment T reste lisible quand la source a disparu (AC2/AC4), et l'écran n'a jamais besoin de recomposer la provenance.
- **Décisions** : `POST /api/syntheses/:id/accept|reject` — persistantes, **re-trancher est refusé** (`already_decided` → 409) au lieu d'être silencieux ; `not_found` → 404. Une synthèse tranchée ne revient pas au défaut de lecture, **y compris reformulée** : la dédup `content_sig` existait, et le service de synthèse **ferme la graine** dont une synthèse a été tranchée (`skipped.decided` — le test précède celui de capacité : la capacité dit « assez de propositions », la décision dit « cette graine a été jugée »).
- **Péremption** : `lib/repositories/stale.ts` (`markSourceDependentsStale`) marque constructions **et** synthèses d'un seul appel — appelé par `DELETE /api/sources/:id` et par `scripts/reingest.mjs` (AC4). Défaut corrigé au passage : le dépôt des synthèses avait un `markStaleBySource` **que la route DELETE n'appelait pas** — supprimer une source laissait ses synthèses fraîches.
- **AC5 vrai par construction** : accepter n'écrit **rien ailleurs** — ni `constructions` (le schéma v1.2 y impose un `suggestion_id` NOT NULL), ni le canvas. La promotion d'une synthèse sur le plan reste la décision reportée en v1.4 (§5) ; le §9 y a déjà ouvert la voie (`canvas_items.item_kind`).

### 12.2 Le feed est un service de lecture, pas un écran qui calcule

`lib/synth/review-service.ts` ne fait **aucun appel LLM** (comme la revue de suggestions de la Phase 3, c'est du CRUD + vérification, testé hors ligne). Les trois états d'une preuve sont **distincts et nommés** : `verified` (la citation tient), `unverified > 0` (une preuve connue ne tient plus — fragment absent, texte modifié…), `provenance_lost` (la copie JSON est illisible — il n'y a **rien à montrer**, ce n'est pas le même état qu'une preuve dont le texte a changé). L'écran (`/syntheses`, `components/synthesis-feed.tsx`) n'affiche que ce qu'il reçoit : il ne refait aucun calcul, deux lectures du même état ne peuvent pas diverger.

### 12.3 Ce que cet amendement ne fait pas

- **Pas de motif de rejet** : le rejet d'une synthèse est sans motif, comme le PRD le spécifie pour cette phase (celui des suggestions, lui, en a un depuis la Phase 3).
- **Pas de promotion sur le canvas** (§5, décision v1.4) : le feed reste le seul lieu des synthèses ; accepter ne pose rien sur le plan.
- **Pas d'exploration depuis une synthèse** : la conversation de la Phase 6 partira d'une synthèse ou du corpus ; ce feed ne fait que les rendre lisibles et trançables.
- Le validateur (`npm run validate:phase5b`) est **en lecture seule**, comme 1B/2B/3/4 : il constate ce que l'usage a produit, il ne rejoue pas l'API — trancher depuis `/syntheses` reste un geste humain.
