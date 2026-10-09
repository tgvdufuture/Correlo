# Correlo — moteur de connexions personnel

Application web locale (Next.js) où vous déposez des sources (texte, PDF, URL).
Le système les découpe en fragments (~2 000 caractères), les indexe par embeddings
— **locaux** (Ollama) ou par **connecteur API** (`EMBED_PROVIDER=api`) — puis
découvre des connexions non évidentes entre fragments (analogie, contradiction, cause).

**Positionnement : local-first par défaut.** Les embeddings sont calculés en local
(Ollama) tant que `EMBED_PROVIDER=ollama` ; le connecteur API existe pour se passer
d'un Ollama en marche, il envoie alors le texte des fragments au service configuré.
Le chat ne part vers un endpoint distant que si vous le configurez (`LLM_CHAT_PROVIDER`)
— basculez sur `ollama` pour rester 100 % hors ligne.

> **L'espace vectoriel est un réglage du corpus.** Les vecteurs d'Ollama (768 dims) et
> ceux du connecteur API (2048 dims) ne sont pas comparables. Changer `EMBED_PROVIDER`
> sans re-vectoriser laisse deux espaces en base : l'analyse **refuse** alors de les
> comparer (bandeau sur l'atelier) au lieu de produire des liens faux. `npm run reembed`
> remet le corpus dans l'espace actif — **la même commande dans les deux sens**.

> État actuel : **1A** ingestion · **1B** validation corpus réel · **2A** PoC de
> découverte (jalon bloquant, verdict PASS) · **2B** moteur discover persistant ·
> **5A** moteur de synthèses · **3** complète (feed de connexions, Constructions,
> STALE, canvas libre avec groupes et cadres, **atelier** : le canvas est
> l'écran d'entrée et porte les **fichiers**, leurs **liens** et les Constructions) ·
> **4** investigation : un agent borné à 5 étapes approfondit une connexion en
> explorant le corpus, et **chaque citation est revérifiée en base** avant d'être
> affichée (« Investiguer » sur une carte du feed ou un lien de l'atelier).
> Restent : les phases **5B**/**6** (feed de synthèses, conversation).

## Prérequis

- Node.js ≥ 20 (testé sur Node 24)
- [Ollama](https://ollama.com) installé et lancé, avec le modèle d'embedding —
  **seulement** si `EMBED_PROVIDER=ollama` (le défaut) :

```bash
ollama pull nomic-embed-text
```

Pour le chat local (optionnel) :

```bash
ollama pull llama3.3
```

## Installation

```bash
npm install
cp .env.example .env.local   # puis ajuster
npm run dev                  # http://localhost:3000/ (l'atelier)
```

## Variables d'environnement (`.env.local`)

| Variable | Défaut | Description |
|---|---|---|
| `DATABASE_PATH` | `./data/correlo.db` | Base SQLite locale |
| `LLM_CHAT_PROVIDER` | `groq` | `groq` ou `ollama` — aucun fallback automatique |
| `GROQ_API_KEY` | — | Requise uniquement si `LLM_CHAT_PROVIDER=groq` |
| `GROQ_CHAT_MODEL` | `qwen/qwen3.8-27b` | Modèle de chat Groq (le défaut historique `llama-3.3-70b-versatile` n'existe plus chez Groq) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Serveur Ollama local |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Modèle d'embeddings local (768 dims) |
| `OLLAMA_CHAT_MODEL` | — | Requis uniquement si `LLM_CHAT_PROVIDER=ollama` |
| `EMBED_PROVIDER` | `ollama` | `ollama` (local) ou `api` (endpoint OpenAI-compatible `POST /embeddings`) |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Endpoint d'embeddings si `EMBED_PROVIDER=api` |
| `NVIDIA_API_KEY` | — | Requise si `EMBED_PROVIDER=api` sur `integrate.api.nvidia.com` |
| `NVIDIA_EMBED_MODEL` | `nvidia/nemotron-3-embed-1b` | Modèle d'embeddings du connecteur API |
| `NVIDIA_EMBED_DIMENSIONS` | `2048` | Dimensions **rendues** par le modèle (non négociables : `400` si autre valeur) |
| `NVIDIA_EMBED_INPUT_TYPE` | `passage` | `passage` (document) \| `query` \| `off` (champ omis) |
| `NVIDIA_EMBED_BATCH_SIZE` | `32` | Textes par appel d'embeddings (mesuré : 32 en 2,7 s) |
| `NVIDIA_EMBED_TIMEOUT_SECONDS` | `120` | Timeout d'un lot |
| `AUTO_DISCOVER` | `on` | `off` = aucune analyse déclenchée par un dépôt (runs à la main) |
| `AUTO_DISCOVER_MAX_PAIRS` | `12` | Paires du run automatique (le corpus entier coûte des heures) |
| `AUTO_DISCOVER_MAX_PAIRS_PER_SOURCE` | `12` | Plafond par source dans ce run |
| `AUTO_DISCOVER_BATCH_SIZE` | `4` | Paires par appel LLM |
| `AUTO_DISCOVER_MAX_FRAGMENT_CHARS` | `2400` | Troncature des fragments dans le prompt |
| `AUTO_DISCOVER_INTER_BATCH_DELAY_MS` | `65000` | Pause entre deux lots (fenêtre de quota du provider) |
| `WORKSPACE_ROOT` | — | Racine **unique** des fichiers que l'agent peut lire (`read_file`, Phase 6). Vide ⇒ l'outil n'existe pas |

Sans `GROQ_API_KEY` : l'ingestion et les embeddings fonctionnent ; le résumé de
source passe en `failed` avec `missing_groq_api_key` (visible dans la
bibliothèque, relance manuelle après configuration).

## Changer de connecteur d'embeddings (`npm run reembed`)

Un vecteur n'a de sens que dans l'espace qui l'a produit : on ne peut pas comparer un
vecteur de 768 dims (Ollama) à un vecteur de 2048 dims (connecteur API). La bascule
se fait donc en **deux temps**, dans les deux sens :

```bash
# 1) choisir l'espace actif
#    .env.local : EMBED_PROVIDER=api   (ou ollama pour revenir en 768 dims)
# 2) redémarrer le serveur, puis re-vectoriser le corpus existant
npm run dev
npm run reembed                      # --dry-run pour voir l'ampleur, --force pour tout refaire
```

Le job `reembed` est **reprenable** (un fragment déjà dans l'espace actif est sauté) et
**n'écrit qu'un lot à la fois** : le corpus reste exploitable pendant l'opération. Le
CLI affiche les espaces présents avant/après, et l'atelier porte un bandeau tant que le
corpus n'est pas aligné sur l'espace actif. Mesuré sur le corpus réel : **3 849
fragments, 121 lots, ~4 min** avec `nvidia/nemotron-3-embed-1b`.

> ⚠ L'identité persistée d'un run discover (`corpus_hash`, `seed`) ne porte pas l'espace
> vectoriel : après une re-vectorisation, les similarités et l'échantillon changent, donc
> un run archivé **n'est plus reproductible à l'identique** même si son identité se
> recalcule. Relancez le run pour de nouveaux liens.

## Validation (Phase 1A)

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest : chunker, codec embeddings, ingestion, crash/reprise, lease, offsets UTF-16
npm run build
```

Scénario manuel :

1. `ollama serve` lancé, `ollama pull nomic-embed-text`.
2. `npm run dev`, ouvrir `/sources`.
3. Importer un fichier `.txt`/`.md`, un PDF textuel, et une URL.
4. Vérifier dans la bibliothèque : ingestion `terminé`, fragments > 0,
   résumé `terminé` (ou `échec` avec `missing_groq_api_key` sans clé).
5. Redémarrer pendant une ingestion : le job reprend au checkpoint, aucun doublon.

## Validation (Phases 1B, 2A, 2B, 3, 4, 5B)

Mêmes prérequis que ci-dessus (corpus réel de `data/corpus_manifest.json`, embeddings —
Ollama local ou `EMBED_PROVIDER=api` — et `GROQ_API_KEY` pour le chat) :

```bash
npm run validate:corpus    # 1B : locators re-slicés, BLOB conformes, ≤ 5 000 fragments
npm run dev                # le worker exécute les jobs discover (à laisser tourner)
npm run discover -- --run-id=val-div --max-pairs=48 --batch-size=4
npm run validate:phase2b   # 2B : identité de run persistée + contraintes §3.3
npm run eval:phase2a       # 2A : rapport + grille des 2 évaluateurs + verdict Q22
```

Phase 3 (feed, Constructions, STALE) — le validateur constate l'état produit par
le **trafic réel** ; il ne rejoue pas l'API lui-même :

```bash
npm run dev                # puis exercer le feed depuis /suggestions
npm run validate:phase3    # 1 ligne de feed par paire, US-07, provenance et stale
```

Phase 4 (investigation) — l'agent explore le corpus **tout seul**, et ses citations
sont revérifiées à la lecture ; le validateur constate ce que le trafic a produit :

```bash
npm run dev                        # puis « Investiguer » sur une carte du feed (ou un lien de l'atelier)
npm run validate:phase4            # ≤ 5 étapes, 1 appel par étape, citations revérifiées en base
```

Une enquête ne sort **jamais** du corpus : ses deux outils (recherche lexicale,
voisinage d'embeddings) sont locaux, et le seul appel réseau reste le chat du provider
configuré. Une suggestion inconnue répond **404** (rien n'est enfilé), et relancer la
même enquête rejoue la même question depuis le cache de prompt.

Le validateur **re-joue aussi la barrière de conclusion** sur chaque conclusion
stockée : il affiche l'état d'alors et le verdict d'aujourd'hui, et exige l'accord pour
un document produit sous la règle courante (`conclusion_rule_version`). Les runs
antérieurs à la barrière restent donc lisibles, sans être jugés avec une règle qu'ils
n'ont pas connue.

Phase 5B (synthèses) — le feed est l'écran `/syntheses` : triées par thème puis
confiance, preuves **citables** (source, locator, texte) et vérifiées à la lecture,
accepter/rejeter persistant. Le validateur constate ce que la revue a produit :

```bash
npm run dev                        # puis trancher depuis /syntheses
npm run validate:phase5b           # feed trié, citations revérifiées, décisions, stale
```

Une synthèse tranchée **quitte le défaut de lecture** (AC3) et ne revient pas — pas
plus **reformulée** : la graine dont une synthèse a été jugée est fermée. Une preuve qui
ne tient plus (source supprimée ou ré-ingérée) arrive **marquée**, jamais servie comme
une preuve, et le texte copié au moment T reste affichable (AC4). Accepter n'écrit rien
ailleurs : les Constructions restent le socle paire v1.2 (AC5).

Phase 6 (conversation) — l'écran de conversation (`/conversations`, avec deux portes
d'entrée : « Discuter » sur une synthèse, ou une question posée au corpus entier) mène
des tours d'agent **affirmation par affirmation** : chaque affirmation porte ses
provenances (fragment du corpus, page web **datée**, fichier `chemin:lignes`) et le
serveur les revérifie à chaque lecture. Le validateur constate ce que les tours ont
produit — et rejugé chaque tour avec la règle du jour :

```bash
npm run dev                        # puis discuter depuis /conversations (web et workspace en réglages)
npm run validate:phase6            # provenances revérifiées, web gouverné, budgets tenus, sans réseau
```

Le web est **gouverné par le serveur** : les outils ne sont exposés qu'après le constat
d'insuffisance du corpus **ou** une demande motivée du modèle (`ask_web`) — et une
réponse rendue sur un tour à web exposé a tenté le web ou cité un fichier lu. Le
workspace (`WORKSPACE_ROOT`) est un seul outil, `read_file`, lecture seule, confiné
(symlinks résolus) ; sans racine, l'outil n'existe pas. Le validateur vérifie les copies
web **les modules réseau de Node désactivés** — une citation web n'est jamais re-fetchée
(AC7). Chaque règle du validateur est **falsifiée** : le tour qui devrait la faire
tomber la fait tomber.

Vérification navigateur (écrans `/syntheses` et panneau d'investigation) : les scripts
ouvrent les pages dans un Chromium piloté (`playwright-core`, devDependency ; l'exécutable
est celui déjà présent dans `%LOCALAPPDATA%\ms-playwright` — passer `executablePath` si
les versions diffèrent) et exercent les parcours réels sur une **copie jetable** de la
base. La relance d'enquête est servie par le cache de prompt : 0 appel LLM.

```bash
npm run check:browser:5b              # /syntheses : feed, preuves, décisions, ordre (14/14)
npm run check:browser:4               # panneau d'investigation (atelier + feed), idempotence (14/14)
```

L'**atelier** (`/`, l'ancien `/canvas` y redirige) se vérifie à la main : déposer un
fichier (il se pose **là où il est lâché** et apparaît aussitôt), le déplacer puis
recharger (la position tient), sélectionner deux fichiers puis « Grouper » et déplacer
le groupe (les deux suivent, sans double décalage), dissoudre (rien ne bouge), cliquer une
**arête** (les deux fichiers reliés se mettent en avant, le panneau surligne le lien),
« Ouvrir les preuves » puis « Intégrer » (la Construction naît **entre les deux
fichiers**), rejeter avec une raison (l'arête disparaît), double-cliquer un élément
périmé (provenance et explication).

Un dépôt enchaîne **ingestion → résumé → analyse** : c'est la fin de l'ingestion (qui
écrit les embeddings) qui met en file le run `discover`, **focalisé sur le fichier
déposé**, et l'écran relit tout seul tant qu'un job est en attente ou en cours.
`npm run discover -- --focus=<id1>,<id2>` rejoue ce comportement à la main.

L'identité d'un run discover — `run_id`, `corpus_hash`, `seed`, `sampler_version` — est
persistée dans la table `discover_runs` (migration 005). Relancer le même `--run-id`
**rejoue le même run** (mêmes paires, mêmes prompts) au lieu d'en créer un autre.

### Suivre un tour de conversation pendant qu'il tourne

La trace de l'agent s'ouvre **tant que la réponse est en attente** : les étapes,
les fragments ajoutés, les pages web lues ou refusées, les compteurs de budget. Un
tour **terminé** se replie — le bruit d'un tour achevé n'a pas sa place au milieu
de la lecture.

Le repli a été mesuré faux : le tour réel du 2026-10-02 (8 appels LLM,
4 min 45) a laissé l'écran affiché un texte d'attente **identique pendant toute
sa durée**, alors que la trace était déjà écrite en base à chaque étape et
servie par l'API. Le travail était fait, il était invisible. Le texte d'attente est
désormais tiré des compteurs du tour : le budget se remplit sous les yeux.

## Architecture

- **Base** : SQLite via `better-sqlite3` (WAL, `foreign_keys = ON`), schéma
  verrouillé `migrations/001_v1_2.sql` (PRD §3.3).
- **LLM** : confiné dans `lib/llm/` — `LlmProvider` (chat configurable + embeddings
  configurable), `GroqProvider`, `OllamaChatProvider`, `OllamaProvider` (local),
  `ApiEmbedProvider` (endpoint OpenAI-compatible), `HybridProvider`, codec Float32
  LE L2-normalisé.
- **Espace vectoriel** : `lib/llm/embedding-space.ts` porte l'identité d'un espace
  (modèle, dimensions, version) et la **détection** de ce que porte la base ;
  `lib/ingest/reembed-service.ts` la **réparation** (`npm run reembed`, job `reembed`,
  migration `008`). Découverte et synthèse refusent un corpus multi-espaces
  (`EmbeddingSpaceMismatchError`) plutôt que de comparer des vecteurs de longueurs
  différentes — `dotProduct` lirait sinon les `dims` premières valeurs de chaque
  vecteur et rendrait des similarités fausses mais plausibles.
- **Ingestion** : `lib/ingest/` — normalisation Q17, chunker-v1
  (2 000 ± 300, min 800 / max 2 400, overlap 300, locators UTF-16), parsers
  (texte / `pdf-parse` / fetch + Readability).
- **Jobs** : table `jobs` (lease + token + checkpoint + idempotency), worker
  concurrence 1–2, recovery au boot des leases expirés uniquement, backoff +
  jitter, max 5 attempts.
- **Découverte / revue** : `lib/discover/` — sampler Q20 déterministe, prompt +
  rattachement serveur des preuves, barrières qualité (`lib/quality/`),
  `review-service` (feed, acceptation, rejet). `lib/repositories/` porte
  `themes`, `syntheses`, `discover_runs`, `constructions`.
- **Investigation** : `lib/agent/` — un **seul** agent borné à 5 étapes (job
  `investigation`, table `investigations` du schéma v1.2, aucune migration). Il ne
  dispose que de deux outils **locaux** (recherche lexicale sur le corpus, voisinage
  d'embeddings en base) : aucune vérification web n'est possible par construction
  (US-09 AC3). Le modèle **ne voit jamais d'identifiant de fragment** — il cite des
  indices de catalogue, le serveur rattache — et `lib/agent/citations.ts` vérifie
  chaque citation (fragment existant, texte identique, source identique) **à chaque
  lecture** : une étape dont une citation ne tient pas passe `failed` et n'est jamais
  présentée comme une preuve. Une **barrière de conclusion** (`lib/quality/conclusion.ts`,
  `conclusion-v2`, partagée avec le validateur) refuse une conclusion qui n'approfondit
  rien : conclure sans avoir exploré, recopier la question, **juxtaposer** deux reports
  coordonnés sans énoncer de relation, ou se contenter d'une formule holistique. Un refus
  consomme l'étape et le modèle peut se reprendre dans le budget restant.
- **UI** : `app/sources` — import drag & drop + URL, bibliothèque avec statuts,
  polling léger (3 s), relance manuelle des jobs en échec. `app/suggestions` —
  feed des connexions : preuves dépliables, intégration en Construction, rejet motivé.
  `app/suggestions` reste le feed complet des connexions. `app/page.tsx` —
  **l'atelier** (`components/canvas/`) : fichiers, arêtes de liens et Constructions
  sur une même surface, pan/zoom, lasso, groupes et cadres qui entraînent leur
  contenu, panneau de liens (preuves, intégrer, rejeter), inspecteur qui suit la
  nature de l'élément, dépôt de fichiers au point du lâcher. « Investiguer » (feed ou
  panneau de liens) ouvre le suivi de l'enquête : étapes, réponse, et citations
  affichées **seulement** si elles se vérifient encore.
- **Canvas / atelier** : `lib/repositories/canvas.ts` + `migrations/006_canvas.sql`
  (cadres) et `007_canvas_items.sql` (éléments **polymorphes** : fichiers *et*
  Constructions) — la disposition vit dans des tables **nouvelles** : le schéma v1.2
  verrouillé n'est pas touché. Déplacer un conteneur décale ses membres **côté
  serveur**, dans la même transaction ; supprimer un conteneur ne déplace ni ne
  supprime aucun élément ; les éléments dont l'entité a disparu sont purgés avant
  chaque lecture (`prune`). Les liens ne sont **pas** stockés : ce sont les
  suggestions du feed, dessinées entre les fichiers qu'elles relient
  (`review-service.linksFor`).

### HTML déposé ≠ texte

Un fichier `.htm`/`.html` **déposé** est converti en texte avant d'être indexé : balises
écartées, `<svg>`/`<script>`/`<style>` supprimés. Le chemin **URL** le faisait déjà ; le
dépôt, non — un diagnostic machine est alors entré tel quel dans le corpus. Mesuré sur le
corpus réel : `UserDiag − Acer Nitro AN515-58 (Laptop).htm` y laissait **988 fragments** de
coordonnées SVG, dont 496 sans un seul mot de quatre lettres — le plus gros fichier du
corpus, et il aspirait le voisinage d'embeddings de tout le reste. Après correctif : **17
fragments**, tout le bruit supprimé.

La reconnaissance est délibérément stricte, pour qu'un `.txt` qui *parle* de HTML reste du
texte. Le discriminant mesuré n'est **pas** la densité de balises (1 pour 232 caractères
pour le diagnostic, 1 pour 176 pour un cours de HTML — trop proches pour un seuil) mais le
**ratio de balises fermantes** : **0,94** pour le premier, **0,00** pour le second. Un
document referme ses conteneurs, un texte qui en parle n'ouvre rien.

> Un fichier déjà ingéré **conserve** ses fragments : le correctif s'applique aux prochains
> dépôts. Le ré-ingérer est le seul chemin pour le nettoyer.

## Local-first

- Aucune donnée ne quitte la machine, sauf les appels chat au provider configuré
  (`groq` par défaut, `ollama` sinon) — et, si vous activez `EMBED_PROVIDER=api`, le
  **texte des fragments** envoyé au service d'embeddings choisi.
- Les fichiers d'origine sont copiés dans `data/sources/` (gitignoré).
- Le résumé de source est un routage non citable : seuls les fragments sont citables.

## Licence

MIT — voir [LICENSE](LICENSE).