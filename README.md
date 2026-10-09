# Correlo

Moteur de connexions personnel, **local-first**. Correlo ingère vos documents, les découpe
en fragments, les vectorise, puis cherche des **rapprochements non évidents** entre eux —
ceux qu'une recherche par mots-clés ne trouverait pas. Chaque piste est proposée, jamais
imposée : vous l'acceptez, la rejetez, ou l'approfondissez en conversation.

Une connexion qui ne tient qu'à un mot rare partagé, ou à deux fragments du même document,
est écartée par une barrière explicite (`lib/discover/claim-rules.ts`) : le moteur ne
présente pas comme une découverte ce qui était déjà trouvable.

## Prérequis

- **Node.js 20+** (Next.js 16).
- Des embeddings : **Ollama** en local avec `nomic-embed-text` (défaut), ou un endpoint
  OpenAI-compatible via `EMBED_PROVIDER=api`.
- Un modèle de chat : **Groq** par défaut (`GROQ_API_KEY`), ou Ollama en local.

## Démarrage

```bash
npm install
cp .env.example .env.local   # renseigner au minimum GROQ_API_KEY
npm run dev
```

L'application écoute sur <http://localhost:3000>. La base SQLite est **créée et migrée
automatiquement au démarrage** : `instrumentation.ts` applique les migrations de
`migrations/` puis démarre le worker de jobs. Aucune étape de setup manuelle.

## Écrans

| Route | Rôle |
| --- | --- |
| `/` | L'explorateur de tableaux — l'accueil. On ouvre l'app sur ses tableaux, pas sur un document |
| `/canvas/<id>` | L'atelier d'un tableau : dépôt de fichiers, suggestions, aperçu (`/canvas` y mène) |
| `/conversation` | Conversation sur le corpus ; c'est là que les connexions se discutent |
| `/sources` | Les documents ingérés et l'état de leur traitement |
| `/suggestions` | Les connexions découvertes, à accepter ou rejeter |
| `/syntheses` | Les synthèses produites sur un thème |

## Configuration

Tout est documenté dans `.env.example`. Les réglages qui changent le comportement :

| Variable | Défaut | Effet |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/correlo.db` | Base SQLite locale. C'est le corpus entier : la sauvegarder, c'est sauvegarder le travail |
| `LLM_CHAT_PROVIDER` | `groq` | `groq` ou `ollama`. **Aucun repli automatique** entre les deux |
| `GROQ_API_KEY` | — | Requise quand `LLM_CHAT_PROVIDER=groq` |
| `EMBED_PROVIDER` | `ollama` | `ollama` (local, 768 dims) ou `api` (2048 dims) |
| `NVIDIA_API_KEY` | — | Requise quand `EMBED_PROVIDER=api` sur `integrate.api.nvidia.com` |
| `SEARCH_PROVIDER` | `none` | `exa` active la recherche web de l'agent. `none` ⇒ les outils web **n'existent pas** |
| `WORKSPACE_ROOT` | vide | Dossier local que l'agent a le droit de **lire**, en lecture seule. Vide ⇒ l'outil n'existe pas |

> **Changer `EMBED_PROVIDER` rebascule l'espace vectoriel.** Un vecteur n'a de sens que
> dans l'espace qui l'a produit : après un changement, lancer `npm run reembed` (`--dry-run`
> pour voir d'abord). Tant que le corpus n'est pas aligné, l'analyse refuse de comparer
> deux espaces au lieu de produire des liens faux.

Les identifiants sont lus depuis `.env.local`, jamais committé.

## Commandes

```bash
npm run dev         # serveur de développement (migrations + worker)
npm run build       # build de production
npm run start       # serveur de production
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
```

Longs travaux sur le corpus — **le serveur doit tourner** (`npm run dev`), car c'est son
worker qui exécute les jobs ; ces scripts se contentent d'enfiler et de suivre :

```bash
npm run discover    # un run de découverte (chemins, options : --help dans scripts/discover.mjs)
npm run reingest    # ré-ingérer des sources (changement de découpage)
npm run reembed     # re-vectoriser le corpus dans l'espace actif
npm run synth       # produire des synthèses
```

## Structure

```
app/          routes (pages) et API
components/   interface (explorateur, atelier, conversation)
lib/          le moteur : ingestion, embeddings, découverte, jobs, conversation
migrations/   schéma SQLite, appliqué au démarrage
scripts/      CLI de travaux longs
data/         base SQLite locale (ignorée par git)
```

## Licence

MIT — voir [LICENSE](LICENSE).
