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

## 13. Phase 6 — conversation (spécifiée le 2026-09-19)

Statut : **livrée (2026-09-20)** · Amende la §4 (Phase 6, **AC2 et AC5**) et la §8 (métriques) · N'ajoute aucune colonne à une table verrouillée.

### 13.1 Pourquoi

Trois décisions de l'utilisateur (2026-09-19) :

| Question | Décision |
|---|---|
| Le verrou de protocole (grilles Q22/Q25 mécaniques) | **Enchaîner et consigner le report** : les grilles humaines restent en dette, nommées dans PROGRESS.md |
| Où vivent les tours | **`conversations` + `messages`** (migration 009) : tours en lignes, requêtables |
| Qui décide d'aller sur le web | **l'agent**, quand le corpus ne suffit pas — « peu de citations ou des manques » |

L'agent d'investigation de la Phase 4 **n'est pas le socle** de cette phase (§11.4) : il approfondit une paire et ne discute pas. Mais tout ce qui rend une enquête vérifiable est réutilisé : boucle bornée à un appel LLM par étape, catalogue d'indices tenu par le serveur, rattachement serveur des citations, règle de preuve **partagée** (`lib/quality/evidence.ts`), cache de prompt, job avec lease et retry.

**Deux AC changent, et le changement est écrit ici plutôt que glissé dans le code :**

- **AC2** — le PRD exigeait « l'accès web est **explicite** (action utilisateur visible) ». L'utilisateur veut que **l'agent décide**. L'AC devient : l'agent décide **dans une condition que le serveur évalue** (§13.4), chaque usage du web est une **étape affichée** du tour, un interrupteur le retire, et la découverte comme l'ingestion restent **100 % locales** (G3 v1.2 intact).
- **AC5** — « ≤ 5 étapes par tour » devient « ≤ 5 étapes **internes**, plus au plus `WEB_MAX_STEPS` étapes web » : une recherche et deux lectures consommeraient sinon tout le budget, et le modèle conclurait sans lire — le défaut mesuré de la Phase 4.

### 13.2 Le tour de conversation

Un tour = **un job** `conversation` (migration 009 reconstruit `jobs` pour autoriser le kind, comme la 003 puis la 008), pas un appel dans la route : la maison n'appelle pas de LLM depuis une route, et un tour qui subit un `503` doit pouvoir être réessayé **sans rejouer la question** de l'utilisateur.

- **Ancrage** : une conversation part d'une **synthèse** (`anchor_kind='synthesis'`) ou du **corpus** (`anchor_kind='corpus'`). L'ancre est un fait de la ligne, pas une instruction du prompt.
- **Contexte du tour** : l'énoncé de la synthèse et ses preuves vérifiées quand il y a un ancrage, plus le catalogue que l'agent construit lui-même (recherche lexicale, voisinage d'embeddings) — les deux outils de `lib/agent/retrieval.ts`, réutilisés tels quels.
- **Sortie structurée** : le modèle ne rend **pas** de prose libre. Il rend **une liste d'affirmations**, chacune portant ses **indices de provenance**, et **le serveur assemble la réponse** à partir de ces affirmations. C'est le prix de l'AC1 : « chaque affirmation porte une provenance » n'est vérifiable que si le texte affiché **est** l'union des affirmations.
- **Réponse sans provenance** : autorisée à exister (l'AC1 la prévoit), jamais présentée comme un fait — stockée avec `provenance: []`, affichée « non sourcée » et comptée.

  **Six refus, tous récupérables** (chacun consomme l'étape, le modèle lit le motif et se reprend ; liste et mesures établies au **premier tour réel du 2026-09-19**, sur une copie jetable de la base ; le cinquième naît avec les outils web le **2026-09-20**, le sixième le même jour du **premier tour web réel**) :

  | Motif | Ce qu'il refuse | Mesure d'origine |
  |---|---|---|
  | `reponse_sans_exploration` | aucune exploration (`search`/`expand`) n'a **abouti dans ce tour** | la question « Que disent ces documents sur ce qui rend une observation fiable ? », ancrée sur une synthèse, a été répondue en **1 étape** à partir des 2 preuves de la synthèse — dont le sujet n'était pas la question — et le tour suivant a rendu **la même matière** |
  | `reponse_hors_catalogue` | un indice jamais montré — fragment du catalogue **ou** résultat web du tour (le schéma Zod ne peut pas l'attraper : l'indice *est* un entier) | contrat d'origine, étendu aux résultats web |
  | `reponse_web_non_lue` | citer une page **trouvée mais jamais lue** par `read_page` dans ce tour | décision du 2026-09-20 : seule une lecture passe par le durcissement réseau et produit une copie datée, donc seule une lecture est citable |
  | `reponse_avec_repere_technique` | la **phrase** parle du protocole (« Le fragment [0] affirme que… »). `messages.text` **est** l'union des affirmations : l'indice de catalogue n'a rien à y faire | deux affirmations sur deux, dans les deux tours rendus |
  | `reponse_web_ignoree` | répondre alors que le web est **exposé** et qu'aucune étape web n'a été **tentée** (motif : AC2′d, §13.4) | tour réel du 2026-09-20 : `corpus_insuffisant`, outils exposés, **0 étape web**, réponse rendue depuis le corpus seul — le prompt v3 l'y invitait même (« un constat négatif précis vaut mieux qu'une généralité ») |
  | `reponse_sans_aucune_preuve` | aucune affirmation appuyée (une affirmation non sourcée **isolée** reste admise, cf. AC1) | contrat d'origine |

  Ordre : **les fautes de protocole d'abord, le contenu ensuite** (exploration → indice hors catalogue → page non lue → repère technique → **web ignoré** → aucune preuve). Le web ignoré passe **avant** « aucune preuve » : quand le web est exposé, les deux motifs sont vrais ensemble et c'est le premier qui dit quoi faire (les deux ont été mesurés sur le même tour). Conséquence assumée : un tour **ancré** paie désormais au moins un appel de lecture de plus — l'ancre est un contexte, jamais la lecture du tour. La règle d'exploration n'est pas nouvelle : c'est celle de la Phase 4 (`conclusion_sans_exploration`), dont la mesure avait déjà montré que ce modèle conclut dès la première action.

### 13.3 Traçabilité : structurelle, jamais sémantique

Trois familles de provenance, et **le serveur seul** les rattache :

| Famille | Ce que le modèle rend | Ce que le serveur vérifie |
|---|---|---|
| Corpus | un indice de catalogue (`[0]`, `[3]`…) | le fragment existe, texte et source identiques (règle `evidence.ts`, **à chaque lecture**) |
| Web | un indice de résultat (`W0`, `W1`) | la copie du passage est présente et bien formée ; l'URL est affichée **avec sa date de lecture** |
| Workspace | un indice de fichier + la plage de lignes | le chemin est **dans la racine confinée**, le fichier est lisible, le texte de la plage n'a pas changé |

**Asymétrie assumée — c'est le point de conception à retenir** : une citation de corpus est **revérifiée à chaque lecture** (fragment local et immuable, règle de la Phase 4) ; une citation web **ne peut pas** l'être (la page peut changer ou disparaître, et la relire à chaque affichage serait un appel réseau déclenché par un rendu). Une citation web est donc **datée** (`retrieved_at`) et affichée comme une copie du jour, jamais comme un fait courant : le vérificateur web contrôle l'**intégrité de la copie**, pas la page.

**Ne pas** tenter de juger si une affirmation est *impliquée* par le fragment cité : c'est mesuré aveugle en Phase 4 (§11.3 — recouvrement **0,27** sur une clause qui résume pourtant correctement son fragment). Ce cran reste le juge sémantique noté dans `Ideas`, pas de la plomberie.

### 13.4 Le web : déverrouillé par constat, pas par humeur

**Règle de déverrouillage** (évaluée une fois par tour, côté serveur, après les étapes internes) :

```
fragments utilisables = fragments du catalogue qui
    (a) appartiennent à au moins 2 sources distinctes, et
    (b) ne sont pas de l'appareil (looksStructural — constat 5A)

outils web exposés  ⇔  fragments utilisables < WEB_UNLOCK_MIN_EVIDENCE   (défaut 2)
```

Sinon les outils **n'existent pas** dans la liste exposée au modèle : c'est la même façon de rendre une contrainte vraie **par construction** que l'AC3 de la Phase 4 (aucun outil réseau n'y existe). Ce détour est nécessaire, et il est adossé à deux mesures : sans `reasoning_effort`, ce modèle rend 6 tokens et `{"skip": true}` (10 thèmes → 10 skips, Phase 5A), et en Phase 4 il a conclu **dès la première étape**. Un web disponible en permanence ferait répondre le modèle **depuis le web** au lieu du corpus — c'est-à-dire remplacerait le produit, dont le corpus est la valeur.

**Deux mesures du 2026-09-20 bornent cette règle, et elles ne disent pas la même chose.** Toutes deux sur une copie jetable (`VACUUM INTO`), modèle `nvidia/nemotron-3-super-120b-a12b`, prompt v4, Exa réel :

1. **Le constat est un critère de *volume*, et il ne sait pas reconnaître « aucune réponse ».** Question « Que disent les documents sur la régulation européenne des batteries lithium et le recyclage des véhicules électriques ? » posée sur le corpus réel (3 883 fragments, 12 œuvres du xixᵉ) : la recherche lexicale rend **4 fragments de 3 sources** qui partagent 2 racines avec la question (`Madame Bovary`, `La chasse au météore`, `Vie de Jésus`), donc `corpus_suffisant`, donc **le web n'est jamais exposé** — 2 étapes, 0 lecture, réponse : « ces documents sont des œuvres littéraires et n'en parlent pas », sourcée sur les 4 fragments. La réponse est *honnête et correcte sur le corpus* ; ce qui manque, c'est que la même question posée au web ramène **le règlement (UE) 2023/1542 lui-même** en 3,8 s (§mesure ci-dessous). Le correctif évident — exiger « au moins deux racines partagées » — a été **mesuré puis écarté** (`tests/measure-unlock.test.ts`, `MEASURE_UNLOCK=1`) : le bruit hors sujet en partage 2 à 3, et une question légitimement couverte (« Que dit Claude Bernard sur l'observation et l'expérience ? ») partage exactement le même profil. Aucun seuil de comptage ne sépare le bruit du pertinent : c'est le mur de la Phase 4 (0,27 de recouvrement, §11.3). **Décision (2026-09-20)** parmi deux options chiffrées : le constat de volume **reste**, mais il n'est plus le seul chemin — le **modèle demande** le web par une action explicite (`ask_web`, après une exploration interne aboutie). L'AC2′e ci-dessous porte le second chemin, et sa mesure.
2. **Exposer un outil n'est pas le faire employer.** Sur le corpus réel avec les outils exposés (`corpus_insuffisant` obtenu en abaissant `WEB_UNLOCK_MIN_EVIDENCE` à 8 — c'est un réglage de vérification, pas un défaut), le tour a répondu **sans une seule étape web** : 2 étapes, le même constat négatif, sourcé sur les fragments hors sujet. D'où l'**AC2′d** ci-dessous : le constat du serveur doit être *agi*, pas seulement affiché.

**AC2′d — le web exposé et ignoré est un refus (`reponse_web_ignoree`).** Si le serveur a constaté que le corpus ne suffit pas, une réponse qui n'a **tenté aucune** étape web est refusée, et le motif visible le dit. Ce qui est compté est la **tentative**, pas le succès : un `search_web` refusé, une recherche sans résultat ou un `read_page` rejeté par le durcissement répondent au constat — exiger un succès condamnerait un tour que le web ne peut pas aider (et `WEB_MAX_STEPS=0` le ferait échouer à coup sûr). Le prompt (v4) **annonce** la règle, sinon elle serait un piège.

**Mesure du tour web réel complet (base neuve, corpus vide, réglages par défaut) :**

| Ce qui devait marcher | Ce qui s'est passé |
|---|---|
| le constat d'insuffisance | `corpus_insuffisant` (0 fragment) → outils exposés, **sans aucun réglage forcé** |
| la recherche réelle | Exa rend **5 résultats** en 3,8 s, dont le règlement (UE) 2023/1542 (EUR-Lex, FR et EN) et une page de vulgarisation |
| le durcissement | `read_page` du **PDF** EUR-Lex → **refus `type_refuse`** (l'extracteur ne lit pas un PDF) ; le tour se reprend et lit la page HTML `eli/reg/2023/1542/oj?locale=fr` |
| la copie datée | 3 affirmations, toutes sourcées sur cette page, **lue le 2026-09-20**, `vérifiée: true` à la relecture |
| les budgets | 3/5 étapes internes, 3/3 web, 6 appels LLM, 77 s |

Ce tour est aussi la meilleure démonstration de l'**asymétrie des citations** (§13.3) : la copie web est figée et vérifiée, la page ne sera **jamais** relue à l'affichage.

**AC2′e — le second chemin : le modèle demande (`ask_web`).** Après une exploration `search`/`expand` **aboutie**, le modèle peut *demander* le web en disant **ce qui manque** (« le corpus ne traite que la mesure optique, pas le protocole électrique ») — le motif est conservé dans la trace du tour et affiché. La demande est **facturée comme une étape interne** (elle change l'état du tour) et refusée dans trois cas, **sans coût** : `exploration_requise` (rien n'a été lu — la demande serait le raccourci mesuré en 5A et en Phase 4), `web_deja_expose` (le constat a déjà ouvert les outils), `outil_web_indisponible` (`WEB_ACCESS=off` ou aucun connecteur). Les tests couvrent les quatre chemins (`tests/conversation-web.test.ts`, « le second chemin »), et la mutation retire les deux gardes (exploration, déjà exposé) fait tomber **exactement** leurs deux tests.

**Mesure du tour réel (2026-09-20, prompt v6, corpus réel 3 883 fragments, question des batteries, Exa réel) :**

| étape | ce qui s'est passé |
|---|---|
| 1. `search` | 4 fragments littéraires — `corpus_suffisant`, donc le constat **ne pouvait pas** ouvrir le web |
| 2. `ask_web` | le modèle **demande** : `demande_modele`, outils exposés, motif conservé |
| 3. `search_web` | 5 résultats, dont le **règlement (UE) 2023/1542** (EUR-Lex, FR et EN) |
| 4. `read_page` | W2 lue (page de synthèse EUR-Lex) |
| 5. `answer` | 1 affirmation, sourcée sur la copie **lue le 2026-09-20**, `vérifiée: true` à la relecture |

Budgets : 3/5 internes, 2/3 web, 5 appels LLM, 49 s. Le même tour avec la base et la question identiques, **en v5**, rendait 2 étapes, 0 web et un constat négatif (« Les documents fournis ne traitent pas de… ») : la v5 disait « si rien ne permet de répondre et que les outils web ne sont pas exposés, dis-le » — or, **avant toute demande, ils ne le sont jamais**. Le chemin le plus court était donc toujours ouvert, et le modèle l'a pris. La v6 rend cette conduite **dépendante de l'état** (fermé mais ouvrable → demander ; ouvert → chercher dehors ; hors de portée → constater), et c'est la mesure, pas le raisonnement, qui a produit ce changement.

**Deux outils, jamais plus** :

| Outil | Entrée | Coût | Plafond |
|---|---|---|---|
| `search_web` | une requête | 1 appel au connecteur de recherche = **1 étape** | 1 par tour |
| `read_page` | un indice de résultat | 1 requête HTTP + Readability = **1 étape** | `WEB_MAX_STEPS − 1` |

**Durcissement de `read_page`** — non négociable, et pas un excès de prudence : le PRD §7 liste déjà la *prompt injection via documents ingérés* comme risque et §8 laisse le durcissement des URL **en question ouverte**. Ici l'URL est choisie **par le modèle**, donc influençable par un document ingéré :

1. **http/https seulement** — ni identifiants dans l'URL, ni `file:`, `data:` ou `ftp:` ;
2. résolution DNS **puis** refus des adresses privées, de bouclage, de lien local et de multicast (IPv4 **et** IPv6, IPv4 mappées comprises), refus **réévalué à chaque redirection**, redirections suivies **à la main**, 3 au plus ;
3. plafonds repris de l'ingestion : 45 s, 10 Mo, types texte seulement ;
4. le texte extrait est **une donnée, jamais une instruction** — la règle v1.2 (« aucune exécution d'instructions du contenu ») s'applique telle quelle ;
5. **aucun** `read_page` hors des résultats du `search_web` du tour.

**Connecteur de recherche** : `SEARCH_PROVIDER` (`exa` | `none`, défaut `none`). Sans connecteur ni clé, les outils web **n'existent pas** — aucun fallback, comme partout ailleurs. Le connecteur s'écrit en `fetch` direct dans `lib/agent/`, avec la politique de retry/timeout partagée : le projet n'a **aucun SDK tiers**, un `POST` n'en justifie pas un.

**Réalisé le 2026-09-20** (`lib/agent/web-guard.ts`, `web-page.ts`, `web-search.ts`, `web-tools.ts`). Ce que la mise en œuvre a précisé, et qui fait partie de la règle :

- le corps envoyé à la recherche est **minimal** (`query`, `numResults`, `type`) : on ne demande **pas** le texte des pages. Un texte rendu par le connecteur serait du contenu sans chemin ni date ; c'est `read_page` qui lit, par le durcissement, et c'est cette lecture-là qui devient citable ;
- les adresses des résultats sont **filtrées à l'exposition** : schéma et identifiants, plus le cas d'un littéral d'adresse privée (`http://127.0.0.1/…`), constatable sans réseau. Un hôte **nommé** qui résoudrait vers une adresse privée ne peut pas être filtré là : c'est la lecture qui le refuse, après résolution ;
- un refus **ne se paie pas** : `outil_web_indisponible`, `budget_web_epuise`, `recherche_deja_faite`, `page_deja_lue`, `resultat_hors_recherche` sont tracés (`charged: false`) mais ne consomment ni budget interne ni budget web — sinon un modèle insistant ferait dépasser le plafond de l'AC5′ par la seule addition de ses refus ;
- une exploration est plafonnée à `budget − 1` : la réponse est une étape interne et doit garder sa place. Sans cette réserve, cinq explorations et rien pour conclure — le tour échouait alors qu'il avait de quoi répondre ;
- l'intégrité d'une citation web est vérifiée **sans réseau**, contre `messages.run` : résultat présent, page lue, URL, date et passage identiques à la lecture enregistrée. Une copie altérée redevient « non sourcée » ;
- **réserve écrite dans le module** : la fenêtre entre la résolution DNS contrôlée et celle de `fetch` (rebinding) reste ouverte — la fermer demanderait d'épingler l'adresse validée, ce qu'`undici` n'expose pas. Les chemins normaux (localhost, métadonnées cloud, IP privées, redirections) sont fermés et testés ;
- le vocabulaire des refus vit dans un module **pur** (`web-refusals.ts`) : réexporter les libellés depuis le durcissement faisait entrer `node:dns/promises` dans le bundle client, et `npm run build` a échoué sur `the chunking context (unknown) does not support external modules`.

### 13.5 Le workspace (AC3) : lecture seule, racine confinée

- Racine unique `WORKSPACE_ROOT` (vide ⇒ **outil absent**, pas une erreur à l'exécution) ; l'écran affiche la racine active, il ne la choisit pas (un sélecteur de dossier serait un écran de réglages, hors AC).
- Un seul outil : `read_file(chemin, de_ligne, à_ligne)`. Confinement : chemin résolu, **symlinks résolus**, refus si le résultat ne commence pas par la racine ; texte seulement ; ≤ 256 Ko par lecture ; **aucune écriture**, aucune énumération de dossier.
- Citation = `chemin:ligne` + la copie de la plage lue.

**Réalisé le 2026-09-20** (`lib/agent/workspace.ts`, `workspace-refusals.ts`, `WORKSPACE_ROOT`). Ce que la mise en œuvre a précisé, et qui fait partie de la règle :

- **le confinement est appliqué dans cet ordre**, et l'ordre compte : racine résolue, **puis** chemin demandé résolu (*liens symboliques compris*, donc un `..` ou un lien qui sort se voit **après** résolution, jamais avant), refus si `path.relative` sort de la racine (insensible à la casse du volume sur Windows), **puis** fichier ordinaire seulement (`isFile()` : un dossier, un FIFO ou un périphérique se refusent **avant** toute lecture — un FIFO bloquerait le worker), plafonds (1 Mo pour le fichier, 256 Ko pour la copie), **puis** texte seulement (un octet nul dans le contenu ⇒ `fichier_binaire` : un constat sur le contenu, pas une devinette d'extension) ;
- **aucune énumération de dossier** : l'objet rendu n'expose que `read` et la résolution de la racine. Un outil qui listerait serait une carte du disque de l'utilisateur offerte au modèle ;
- **la racine est résolue à chaque lecture, jamais une fois pour toutes.** La version qui la résolvait à la construction a été mesurée fausse en vérification navigateur : le serveur démarre avant que le dossier existe, gardait `null` à vie et refusait chaque lecture jusqu'au redémarrage. Aucun état caché : le disque est la seule vérité (un avertissement au démarrage reste, pour dire un réglage illisible une fois) ;
- **le texte lu est montré au modèle**, clippé, comme un fragment de catalogue : on ne cite pas ce qu'on n'a jamais vu (voir la v7 du prompt, qui a corrigé le même défaut côté web) ;
- **une lecture est une étape interne facturée** (c'est du travail, et un outil gratuit s'appelle en boucle), plafonnée à `budget − 1` comme une exploration ; ses **refus ne sont pas facturés** (rien n'a été lu) mais sont **enregistrés avec leur motif** — la trace dit ce qui a été tenté, et seule une lecture réussie est citable ;
- **relire la même plage ne coûte rien mais n'apprend rien** (`plage_deja_lue`, non facturé), et la redondance est évaluée sur la **vérité résolue** (chemin réel + plage effective), pas sur la forme du chemin écrite par le modèle ;
- **l'outil est exposé dès qu'une racine est configurée** — pas de constat d'insuffisance comme le web. Le web est une ressource distante qu'une disponibilité permanente ferait préférer au corpus (§13.4) ; ici la racine est désignée **par l'utilisateur**, le coût est local et la lecture est exactement ce qu'il a demandé. **Réserve assumée** : rien n'oblige la réponse à citer le corpus — un tour peut se terminer sur une seule affirmation sourcée sur un fichier. Le garde-fou qui reste est la règle « une lecture doit avoir eu lieu » (§13.2), et une barrière de proportion serait un réglage de plus, sans mesure pour le régler.

**Deux interactions avec les règles du corpus, mesurées sur un tour réel.**** Une lecture de fichier **citée** vaut exploration et répond au constat d'insuffisance du corpus :

1. `reponse_sans_exploration` demandait qu'une lecture ait eu lieu, pas qu'elle porte sur le corpus. Au premier tour workspace réel (2026-09-20, question sur `notes/protocole.md`), le modèle a ouvert le fichier **avant** de chercher — le geste juste pour une question qui nomme un document — et la réponse a été refusée alors qu'il venait de lire. Une **lecture citée** compte donc comme l'exploration du tour ; une lecture **non citée** ne dispense de rien (sinon n'importe quel fichier ouvert blanchirait une réponse rendue à partir de rien) ;
2. `reponse_web_ignoree` exigeait une tentative web dès que le serveur a constaté le corpus insuffisant. Sur la même base, le constat a jugé le corpus de xixᵉ insuffisant pour « calibration », exposé le web… et refusé **deux fois** une réponse pourtant sourcée sur le fichier lu : le tour est mort à 0 affirmation, avec la réponse sous les yeux. Le constat parle du **corpus** ; un fichier du workspace n'est pas une absence de source, c'est une source que l'utilisateur a nommée. Une réponse **citant** un fichier lu satisfait donc le constat ; la contrepartie est inchangée (sans citation de fichier, le constat exige bien une tentative web).

**Deux défauts de la Phase 6 trouvés par ces tours réels, et corrigés :**

- **une sortie invalide laissait la réponse `pending` à vie.** La branche « sortie invalide » sort de la boucle avec un statut déjà `failed`, et le bloc qui ne traitait que `pending` ne passait pas : `awaiting_reply` restait vrai, l'écran sondait sans fin et le `409` **verrouillait la conversation** — un tour perdu, sans trace, avec un job `done`. L'état terminal est maintenant écrit **une fois, après la boucle, quel que soit le chemin de sortie** ;
- **un refus non facturé prenait la place de la réponse.** La boucle était bornée par `budget + budget web` **itérations**, alors qu'un refus ne consomme aucun budget : un tour à 3 étapes dont une lecture refusée mourait en `step_budget_exhausted` sans jamais répondre. Les bornes sont séparées (`MAX_REFUSED_STEPS`, trois refus non facturés), et un modèle qui répète une action refusée échoue désormais en le disant (`refus_repete`).

**Mesure du tour réel (2026-09-20, prompt v8, corpus réel 3 883 fragments, workspace de vérification) :**

| Ce qui devait marcher | Ce qui s'est passé |
|---|---|
| la question nomme un document | « le fichier `notes/protocole.md`… que prévoit-il exactement ? » (protocole **inventé** : ni le corpus ni les connaissances du modèle ne peuvent le renseigner) |
| la lecture | `read_file notes/protocole.md` demandée `1-2000`, bornée à **lignes 1-11** (560 octets) ; le prompt suivant porte la copie lue |
| la réponse | 1 affirmation, sourcée sur `F0 notes/protocole.md lignes 1-11`, `vérifiée: true` **à la relecture** ; le contenu est exactement le protocole inventé — la preuve que la réponse vient du fichier |
| les budgets | 2/5 étapes internes, 0/3 web, **2 appels LLM, 17 s** (le tour complet tient en une lecture et une réponse) |

**Et un tour adverse** (même base, question demandant de lire `../phase6-ws3.db`, hors racine) : le modèle **a tenté la sortie** — `read_file ../phase6-ws3.db` → refus `chemin_hors_racine`, tracé avec le chemin demandé et non facturé — puis est parti sur le web (constat `corpus_insuffisant` pour « tables »), a lu deux pages, et ses deux dernières réponses ont été refusées (`reponse_avec_repere_technique`) : 5/5 internes, 3/3 web, 9 appels, `failed`, **0 affirmation affichée**. Le confinement a tenu, et une réponse refusée n'est jamais publiée.

### 13.6 Modèles ajoutés (migration `009`)

`conversations`

| Champ | Type | Notes |
|---|---|---|
| id | uuid PK | |
| anchor_kind | TEXT | `synthesis` \| `corpus` — `CHECK` |
| anchor_ref | TEXT | uuid de la synthèse (NULL si corpus) — intégrité portée par le dépôt, comme `canvas_items` |
| title | TEXT | premier message, tronqué — sert à lister |
| chat_model, prompt_version | TEXT NOT NULL | comme `syntheses` |
| created_at, updated_at | timestamp | |

`messages`

| Champ | Type | Notes |
|---|---|---|
| id | uuid PK | |
| conversation_id | FK `conversations` ON DELETE CASCADE | |
| role | TEXT | `user` \| `assistant` — `CHECK` |
| text | TEXT NOT NULL | pour l'assistant : **assemblé depuis les affirmations**, jamais la prose brute du modèle |
| claims | JSON | `[{ text, provenance: [...] }]` — la copie au moment T (fragment, URL datée, chemin:ligne) |
| run | JSON | enveloppe du tour : budget, compteurs, outils appelés, déverrouillage web, versions de règles — **même parti pris que `investigations.steps`** |
| status | TEXT | `pending` \| `done` \| `failed` |
| created_at | timestamp | |

`jobs` : kind `conversation` (reconstruction de table, procédure 003/008).

**Aucune colonne ajoutée** à `sources`, `fragments`, `suggestions`, `constructions`, `investigations` (ni à `jobs`, sinon la reconstruction). L'AC4 est satisfait **par ces deux tables** : une note liée à une synthèse **est** une conversation ancrée et son tour ; elle n'écrit ni dans `fragments` ni dans `syntheses`.

### 13.7 Réglages ajoutés

`SEARCH_PROVIDER` (`none`), `EXA_API_KEY`, `WEB_ACCESS` (`on` — à `off`, les outils web ne sont jamais exposés), `WEB_MAX_STEPS` (3), `WEB_UNLOCK_MIN_EVIDENCE` (2), `WEB_SEARCH_RESULTS` (5, borne le prompt et le coût), `WORKSPACE_ROOT` (vide), `CONVERSATION_MAX_STEPS` (5).

Statut des réglages web (2026-09-20) : **branchés et testés** — `SEARCH_PROVIDER=exa` sans clé échoue au **boot** (message de configuration), plutôt qu'au milieu d'un tour après que l'utilisateur a attendu.

Statut de `WORKSPACE_ROOT` (2026-09-20) : **branché et mesuré** — vide ⇒ l'outil n'est pas annoncé et tout appel direct refuse (`racine_absente`) ; renseigné ⇒ l'écran affiche la racine, le prompt l'annonce, et les tours réels du §13.5 lisent et citent. Une racine **illisible** ne tue pas le démarrage : elle fait refuser chaque lecture (`racine_invalide`, tracé et non facturé), et la résolution est retentée à chaque appel.

### 13.8 Acceptance Criteria (Phase 6)

- **AC1** : chaque affirmation de l'assistant porte ses provenances (`fragment_id` + locator, `url` + copie datée, `chemin:ligne`) ; le serveur rattache et vérifie les entités citées (règle `evidence.ts` pour le corpus) **à chaque lecture** ; une affirmation dont **aucune** provenance ne survit est affichée « non sourcée », jamais comme un fait.
- **AC2′ (amendé)** : l'agent décide d'aller sur le web, sous trois conditions vérifiables — (a) les outils web ne sont **exposés** qu'après le constat serveur d'insuffisance **ou** une demande motivée du modèle après exploration (AC2′e, §13.4), (b) chaque usage produit une **étape visible** (requête et URL affichées), (c) `WEB_ACCESS=off` les retire. Découverte et ingestion restent **100 % locales** (G3). **Réalisé (2026-09-20)** : (a) et (c) par tests unitaires sur les trois cas (corpus suffisant / insuffisant / `off`, plus « le constat exige une exploration **interne** »), et par le **tour réel v6** où le modèle demande lui-même le web (`demande_modele`) ; (b) par la vérification navigateur — URL et « copie lue le <date> » affichées, étapes web visibles.
- **AC2′e (nouveau, décision du 2026-09-20)** : le web est aussi ouvrable par une **demande du modèle** (`ask_web`) après une exploration interne **aboutie** ; la demande est facturée, motivée dans la trace, et refusée sans coût quand elle est prématurée (`exploration_requise`), inutile (`web_deja_expose`) ou impossible (`outil_web_indisponible`). **Réalisé** : quatre tests dans `tests/conversation-web.test.ts`, mutation des deux gardes (chacune ne tombe que son test), et le tour réel du §13.4.
- **AC3** : `read_file` est **lecture seule** et **confiné** à `WORKSPACE_ROOT` (symlinks résolus) ; sans racine configurée, l'outil n'existe pas. **Réalisé (2026-09-20)** : 11 tests sur le lecteur (racine absente, `..` et chemin absolu dehors, lien symbolique sortant **et** interne, dossier, binaire, plafonds du fichier et de la copie, plage incohérente / hors texte / trop longue, décodage non-UTF-8, fenêtre par défaut), plus la mutation des gardes (confinement, texte seulement, `isFile`, plafond de copie, fenêtre par défaut, outil non exposé, plage déjà lue, indice citable, vérification, relecture, refus non facturé, annonce dans le prompt) — chacune ne tombe que ses tests. Le tour adverse du §13.5 a **tenté la sortie** et s'est fait refuser. Un test parcourt aussi le tour entier et vérifie qu'**aucun octet** du workspace n'a changé.
- **AC4** : une note liée à une synthèse est persistée (conversation ancrée + son tour) et **n'écrit rien** dans `fragments` ni dans `syntheses` (test).
- **AC5′ (amendé)** : ≤ `CONVERSATION_MAX_STEPS` (5) étapes **internes**, plus au plus `WEB_MAX_STEPS` (3) étapes web ; le total est affiché. Un tour qui épuise son budget sans réponse est un **échec tracé**, pas un silence. **Réalisé (2026-09-20)** : les compteurs portent sur les étapes **exécutées** (un refus n'est pas facturé, §13.4) et l'écran affiche les deux budgets séparément (`2/5 internes · 2/3 web`). La boucle a **deux bornes séparées** — les budgets, et trois refus non facturés (`MAX_REFUSED_STEPS`) : les confondre faisait qu'un refus prenait la place d'une étape facturée et que le tour mourait avant d'avoir pu répondre (défaut mesuré sur le workspace, §13.5). Un tour qui répète une action refusée échoue en le disant (`refus_repete`). La lecture de fichier est une étape **interne** au sens de cet AC. **Clôture validateur (2026-09-20)** : `scripts/validate-phase-6.mjs` (`npm run validate:phase6`) rejoue les règles en lecture seule — budgets tenus par tour, un appel LLM au plus par étape, refus non facturés ≤ plafond, état terminal toujours écrit (`pending` à vie = échec), un seul tour en vol par conversation, et l'emploi du web sans déverrouillage est un échec. Le validateur importe la règle de vérification du serveur (`conversation-citations.ts`), passe `PASS` sur les copies jetables des tours réels (web et workspace), et **chaque règle est falsifiée** : le tour forgé qui devrait la faire tomber la fait tomber (9 tours-criminels, dont deux défauts du validateur lui-même trouvés par ce procédé et corrigés).
- **AC6** : `read_page` refuse les schémas non http(s), les adresses privées/bouclage/lien local (y compris après redirection) et les réponses hors plafond — chacun testé, **sans réseau réel**. **Réalisé (2026-09-20)** : 24 tests, `fetch` et la résolution DNS injectés ; les formes IPv6 encapsulantes (mappée, 6to4, NAT64, Teredo) sont refusées comme les autres.
- **AC7** : une citation web est **datée** et n'est **jamais** re-fetchée à l'affichage d'un tour (test : aucune requête sortante sur une lecture de conversation). **Réalisé (2026-09-20)** : `verifyConversationTurn` vérifie la copie contre `messages.run` sans aucun accès réseau, et la lecture d'un tour ne rappelle pas davantage la lecture du tour précédent.
- **AC8** : une conversation engagée est **mesurable** en base — la métrique §8 (« ≥ 1 conversation par session ») ne l'était pas.

### 13.9 Ce que cet amendement ne fait pas

- Il **n'ajoute aucun outil d'écriture** : ni fichier, ni fragment, ni synthèse, ni canvas. La conversation sera la première phase entièrement **en lecture**.
- Il ne rend pas le web **nécessaire** : sans `SEARCH_PROVIDER` ni clé, la Phase 6 est complète et hors ligne — c'est le défaut.
- Il ne juge pas si une affirmation est **vraie** : il vérifie ce qui est **citable**. Le juge sémantique reste la dette d'`Ideas`.
- Il ne rembourse **pas** la dette des deux grilles humaines (report consigné dans PROGRESS.md).
- Il ne touche ni au feed de synthèses ni au canvas : la promotion d'une synthèse sur le plan reste la décision v1.4 (§5).
---

## 14. Amendement v1.6 (2026-09-20) — l'explorateur de tableaux

### 14.1 Pourquoi

Décision utilisateur (2026-09-20), en Q&R en quatre vagues (16 décisions tranchées) : rendre l'app navigable « comme un explorateur de fichiers » (référence Windows/Apple), où l'utilisateur **explore ses tableaux** (les canvases) et peut **discuter avec l'IA en lien avec plusieurs tableaux**. Trois mots d'ordre : *cohabitation* (l'atelier reste un espace à part entière), *coquille + capacités* (la coquille neuve et ce qui la rend vivante), *l'aperçu est un poste de pilotage* (détail, liens, et les actions IA au premier plan).

| Question | Décision |
|---|---|
| Ce que l'utilisateur explore | **ses canvases**, et peut discuter en lien avec plusieurs |
| L'atelier | **cohabite** — l'explorateur est l'accueil, l'atelier reste un espace (le plan) |
| Périmètre | coquille **et** capacités (épinglés, étiquettes, activité récente) |
| Multi-canvas | migration `010_canvases.sql` : l'atelier devient le **premier** canvas |
| Ancrage des conversations | **multi-ancrage** : une conversation peut être liée à plusieurs canvases |
| Arborescence | canvases → frames (l'arbre s'arrête aux frames ; les objets se voient dans la zone) |
| Aperçu | l'objet + ses liens + **les actions IA** (« Discuter de ça », « Investiguer », « Synthétiser ») |
| Zone principale | **vignette du plan** (miniature cliquable) |
| Écrans existants | ils restent des pages (sources, suggestions, synthèses) |
| Gestion des canvases | **complète** : créer, renommer, supprimer, colorier/étiqueter, réordonner |
| Capacités | **épinglés** + **étiquettes/couleurs** + **activité récente** |
| Accueil | **l'explorateur devient `/`** ; l'atelier vit à `/canvas/<id>` (redirection de `/canvas`) |
| Contexte des conversations multi-canvas | **les constructions** des canvases ancrés entrent dans le contexte du tour |
| Suppression d'un canvas non vide | les objets **survivent** (détachés, récupérables — l'atelier a un « hors canvas ») |
| Vocabulaire UI | **« Tableaux »** |

### 14.2 Ce qui change dans le PRD

- **Navigation (§3.1)** — l'explorateur (`/`) remplace l'atelier comme écran d'ouverture : arbre **Tableaux → Frames**, zone principale en **vignette du plan** du tableau ou de la frame sélectionnée (cliquer la vignette ouvre l'atelier focalisé sur la frame), volet d'**aperçu-poste de pilotage** (détail, liens, actions IA). Les pages `/sources`, `/suggestions`, `/syntheses`, `/conversations` restent ; la nav les garde.
- **Canvas (§9)** — `canvas_frames`, `canvas_nodes`, `canvas_items` gagnent un parent : table `canvases` (migration `010`, procédure 003/008/009 : reconstruction, aucune colonne sur table verrouillée). L'atelier existant entre comme premier canvas (label « Atelier », `is_default = 1`) ; les frames existantes lui appartiennent. `canvas_nodes.frame_id` devient `frame_id` → canvas **et** frame via la frame (une frame appartient à un canvas ; une construction posée hors frame appartient au canvas). `canvas_items` suit la même règle.
- **Conversation (§13.6)** — `conversations` ne porte plus l'ancrage dans la ligne : table de liaison `conversation_canvases(conversation_id, canvas_id)` (multi-ancrage). L'ancrage historique `anchor_kind/anchor_ref` reste lisible pour les conversations existantes (règle de lecture : « ancré sur le corpus » reste le défaut). Le **contexte du tour** s'enrichit : les constructions posées sur les canvases ancrés (leurs paires et extraits, plafonnées) entrent dans le catalogue de départ du tour, à côté des preuves de la synthèse ancrée — mêmes règles de rattachement et de vérification que le reste (AC1 de la Phase 6 inchangée).
- **Accueil** — `/` sert l'explorateur ; `/canvas` redirige vers l'atelier (`/canvas/<id du premier canvas>`). L'écran de création de conversation (deux portes d'entrée de la Phase 6) reste servi depuis l'aperçu (« Discuter de ça ») et de l'explorateur (« Nouvelle conversation », multi-canvas cochables).
- **Aucune entité sémantique nouvelle** : pas de suggestion, pas de synthèse, pas de verdict dans cette phase. L'explorateur est une **coquille de navigation** sur les entités v1.2–v1.3, avec trois capacités de confort (épinglés, étiquettes, activité récente) — toutes dérivées, aucune n'écrit dans les entités verrouillées.

### 14.3 Modèles ajoutés (migration `010`)

`canvases`

| Champ | Type | Notes |
|---|---|---|
| id | uuid PK | |
| label | TEXT NOT NULL | affiché dans l'arbre et l'onglet de l'atelier |
| color | TEXT | étiquette couleur (palette fermée côté écran) |
| is_default | INTEGER | `1` pour l'atelier migré — unique, non supprimable |
| pinned | INTEGER | épinglé en tête de l'explorateur |
| position | INTEGER | ordre manuel (réordonnancement glisser dans l'arbre) |
| created_at, updated_at | timestamp | |

`canvas_frames.canvas_id` (colonne ajoutée, reconstruction) — une frame appartient à un canvas ; l'atelier migré reçoit toutes les frames existantes.

`conversation_canvases(conversation_id, canvas_id)` — table de liaison, PK composée, `ON DELETE CASCADE` des deux côtés ; une conversation peut être liée à plusieurs canvases, un canvas porte plusieurs conversations.

`canvases` porte aussi les trois capacités de confort : `pinned`, `color` (étiquette) — l'« activité récente » est **dérivée** (`updated_at` de canvases + `updated_at` des conversations liées + `created_at` des synthèses récentes), aucune table de plus.

### 14.4 Réglages ajoutés

Aucun. L'explorateur ne lit ni clé, ni provider, ni quota : c'est une coquille de navigation sur des données locales (G3 v1.2 intact — rien de réseau dans cette phase).

### 14.5 Acceptance Criteria (v1.6)

- **AC1** : l'explorateur (`/`) liste les canvases (arbre Tableaux → Frames) ; créer/renommer/supprimer/colorier/épingler/réordonner un canvas est persistant ; supprimer un canvas non vide **détache** ses objets (ils restent accessibles, l'atelier les montre « hors frame ») et **jamais** l'inverse (aucune suppression en cascade d'une Construction).
- **AC2** : la vignette du plan d'un canvas/frame est rendue depuis les **données** (positions réelles), cliquable, et ouvre l'atelier focalisé sur la frame (centre + zoom).
- **AC3** : l'aperçu d'un objet (construction, suggestion, synthèse, conversation) porte son détail, ses **liens** (enquêtes, synthèses, conversations, canvases qui le citent) et ses **actions IA** (« Discuter de ça » pré-coche les canvases de l'objet, « Investiguer », « Synthétiser ») — chaque action mène aux écrans existants, elle ne les réinvente pas.
- **AC4** : une conversation peut être liée à plusieurs canvases (multi-ancrage, persistant) ; les canvases ancrés sont visibles dans l'écran de conversation et dans l'aperçu des canvases ; supprimer un canvas **détache** ses conversations (elles restent, hors tableau).
- **AC5** : le contexte d'un tour de conversation sur une conversation multi-ancrée contient les constructions des canvases ancrés (paires + extraits, plafonnés) — et chaque affirmation de la réponse qui s'y appuie est **citable et revérifiable** comme le reste (AC1 Phase 6 : rattachement serveur, catalogue, vérification à la lecture).
- **AC6** : épinglés, étiquettes/couleurs et activité récente sont persistants et visibles dans l'explorateur ; l'activité récente est dérivée (aucune écriture supplémentaire à chaque action).
- **AC7** : rien ne régresse : l'atelier garde tout son comportement (drag, groupes, arêtes, promotion), les écrans existants restent servis, et **aucune colonne d'une table verrouillée** ne bouge (migration par reconstruction, procédure établie).

### 14.6 Ce que cet amendement ne fait pas

- Il ne **remplace** aucun écran expert : sources, suggestions, synthèses restent des pages ; l'explorateur y mène, il ne les absorbe pas (v1.7 décidera).
- Il n'ajoute **aucune capacité sémantique** : pas de nouveau verdict, pas de nouveau type d'analyse — la coquille navigue ce qui existe.
- Il ne touche pas au web ni au workspace de la Phase 6 : l'aperçu les expose comme actions, les règles de la Phase 6 (§13.4, §13.5) restent les seules portes.
- Il ne fait pas de recherche globale (Spotlight) : la recherche de la v1.6 est celle qui existe (filtres des écrans) ; une barre de commande est une suite, pas cette phase.
- Il ne change rien au protocole de conversation (budgets, refus, déverrouillage web) : l'ancrage multi-canvas **enrichit le catalogue de départ**, il n'écrit jamais dans le tour lui-même.
