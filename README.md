# Sérendipité — moteur de connexions personnel

Application web locale (Next.js) où vous déposez des sources (texte, PDF, URL).
Le système les découpe en fragments (~2 000 caractères), les indexe via des
embeddings **locaux** (Ollama), puis découvrira des connexions non évidentes
entre fragments (analogie, contradiction, cause).

**Positionnement : local-first.** Les embeddings sont toujours calculés en local
(Ollama). Le chat ne part vers Groq que si vous gardez la configuration par défaut
(`LLM_CHAT_PROVIDER=groq`) ; basculez sur `ollama` pour rester 100 % hors ligne.

> État actuel : **Phase 1A** (ingestion TEXT/PDF/URL, chunker-v1, embeddings
> Ollama, file de jobs asynchrone avec reprise, bibliothèque). Les phases
> découverte/feed/canvas (1B–4) ne sont pas implémentées.

## Prérequis

- Node.js ≥ 20 (testé sur Node 24)
- [Ollama](https://ollama.com) installé et lancé, avec le modèle d'embedding :

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
npm run dev                  # http://localhost:3000/sources
```

## Variables d'environnement (`.env.local`)

| Variable | Défaut | Description |
|---|---|---|
| `DATABASE_PATH` | `./data/serendipity.db` | Base SQLite locale |
| `LLM_CHAT_PROVIDER` | `groq` | `groq` ou `ollama` — aucun fallback automatique |
| `GROQ_API_KEY` | — | Requise uniquement si `LLM_CHAT_PROVIDER=groq` |
| `GROQ_CHAT_MODEL` | `qwen/qwen3.8-27b` | Modèle de chat Groq (le défaut historique `llama-3.3-70b-versatile` n'existe plus chez Groq) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Serveur Ollama local |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Modèle d'embeddings (toujours local, 768 dims) |
| `OLLAMA_CHAT_MODEL` | — | Requis uniquement si `LLM_CHAT_PROVIDER=ollama` |

Sans `GROQ_API_KEY` : l'ingestion et les embeddings fonctionnent ; le résumé de
source passe en `failed` avec `missing_groq_api_key` (visible dans la
bibliothèque, relance manuelle après configuration).

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

## Validation (Phases 1B, 2A, 2B)

Mêmes prérequis que ci-dessus (corpus réel de `data/corpus_manifest.json`, Ollama pour
les embeddings, `GROQ_API_KEY` pour le chat) :

```bash
npm run validate:corpus    # 1B : locators re-slicés, BLOB conformes, ≤ 5 000 fragments
npm run dev                # le worker exécute les jobs discover (à laisser tourner)
npm run discover -- --run-id=val-div --max-pairs=48 --batch-size=4
npm run validate:phase2b   # 2B : identité de run persistée + contraintes §3.3
npm run eval:phase2a       # 2A : rapport + grille des 2 évaluateurs + verdict Q22
```

L'identité d'un run discover — `run_id`, `corpus_hash`, `seed`, `sampler_version` — est
persistée dans la table `discover_runs` (migration 005). Relancer le même `--run-id`
**rejoue le même run** (mêmes paires, mêmes prompts) au lieu d'en créer un autre.

## Architecture

- **Base** : SQLite via `better-sqlite3` (WAL, `foreign_keys = ON`), schéma
  verrouillé `migrations/001_v1_2.sql` (PRD §3.3).
- **LLM** : confiné dans `lib/llm/` — `LlmProvider` (chat configurable +
  embeddings Ollama), `GroqProvider`, `OllamaChatProvider`, `OllamaProvider`,
  `HybridProvider`, codec Float32 LE L2-normalisé.
- **Ingestion** : `lib/ingest/` — normalisation Q17, chunker-v1
  (2 000 ± 300, min 800 / max 2 400, overlap 300, locators UTF-16), parsers
  (texte / `pdf-parse` / fetch + Readability).
- **Jobs** : table `jobs` (lease + token + checkpoint + idempotency), worker
  concurrence 1–2, recovery au boot des leases expirés uniquement, backoff +
  jitter, max 5 attempts.
- **UI** : `app/sources` — import drag & drop + URL, bibliothèque avec statuts,
  polling léger (3 s), relance manuelle des jobs en échec.

## Local-first

- Aucune donnée ne quitte la machine, sauf les appels chat au provider configuré
  (`groq` par défaut, `ollama` sinon).
- Les fichiers d'origine sont copiés dans `data/sources/` (gitignoré).
- Le résumé de source est un routage non citable : seuls les fragments sont citables.