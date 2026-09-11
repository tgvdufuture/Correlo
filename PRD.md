PRD — Sérendipité (moteur de connexions personnel)

Version : 1.2 · Date : 2026-09-10 · Statut : Locked — décisions Q1–Q24 intégrées · Remplace v1.1 · Amendé v1.3 (Synthèses & Conversation) : voir PRD-v1.3-amendement.md
0. Executive Summary

Application web locale (Next.js) où l'utilisateur dépose des sources (texte, PDF, URL). Le système les découpe en fragments (~2 000 caractères), les indexe via embeddings locaux (Ollama), puis découvre des connexions entre fragments selon 3 types de relations (analogie, contradiction, cause), via des appels LLM par batchs (Groq par défaut, Ollama en alternative locale). Chaque connexion est proposée sous forme de suggestion avec claim, statut épistémique normalisé, preuves citables et tier. L'utilisateur ouvre une investigation menée par un seul agent, puis peut intégrer la suggestion en un clic comme Construction sur son canvas, avec provenance complète. Aucune vérification web. Un PoC de découverte en CLI, sans UI, est un jalon bloquant avant toute construction d'interface. Positionnement : local-first (embeddings toujours locaux ; le chat part vers Groq uniquement si l'utilisateur garde la config par défaut).

Primary success metric :

    3–4 découvertes « wow » par session de test sur 12–15 documents réels, ≥ 40 % de suggestions ouvertes, ≥ 20 % intégrées.

1. Strategic Context
1.1 Problem Statement

    Situation actuelle : les notes, articles et PDF d'un penseur solo s'accumulent dans des silos ; la relecture croisée est manuelle et focalisée sur ce qu'on cherche déjà.
    Pain point : aucun outil ne fait émerger des relations non évidentes (analogie, contradiction, cause) entre ses propres sources, avec une preuve vérifiable et un statut épistémique explicite.
    Pourquoi maintenant : les embeddings locaux (Ollama) et les LLM à faible coût (Groq free tier) rendent le pipeline réalisable sur une machine personnelle.

1.2 Goals

    G1 : produire 3–4 connexions non évidentes par session sur un corpus réel de 12–15 documents, mesurées par le protocole du PoC (§4, Phase 2A).
    G2 : chaque suggestion et Construction porte une provenance vérifiable (fragment citable, locator, hash de source) et un statut épistémique normalisé jamais élevé automatiquement.
    G3 : les données restent locales par défaut : embeddings 100 % locaux, chat configurable (groq/ollama), zéro appel réseau non configuré.

1.3 Non-Goals

Cette phase ne fera PAS :

    De vérification web ou de RAG sur internet.
    D'ingestion vidéo/audio/image/code.
    De multi-agent, de scoring pondéré, de graphe de connaissances autonome.
    De multi-user, auth, cloud, ou synchronisation.
    De relations intra-source en MVP (fragment_a.source_id == fragment_b.source_id interdit).
    De profondeur de Construction > 1 (depth = 1).
    De bascule silencieuse entre providers LLM.

2. Users & Context
2.1 Primary Persona

    Role : « penseur solo » — chercheur, écrivain ou analyste qui gère un corpus documentaire personnel.
    Niveau technique : sait installer une app desktop et Ollama ; n'est pas développeur.
    Contexte : machine personnelle, corpus de 10–100 documents (articles, PDF, notes, pages web).
    Environnement : desktop macOS/Linux/Windows, navigateur, Ollama en local, compte Groq optionnel.
    Job-to-be-done : découvrir des relations non évidentes entre ses lectures, avec des preuves qu'il peut vérifier lui-même.

2.2 User Stories
ID	User story	Priorité	Phase
US-01	En tant que penseur solo, je veux importer une source texte afin de la découper en fragments indexés.	P0	1A
US-02	En tant que penseur solo, je veux importer un PDF afin d'exploiter son texte avec des localisateurs citables.	P0	1A
US-03	En tant que penseur solo, je veux importer une URL afin d'ajouter un contenu lisible à ma bibliothèque.	P0	1A
US-04	En tant que penseur solo, je veux consulter ma bibliothèque et l'état de chaque ingestion afin de savoir quelles sources sont exploitables.	P0	1A
US-05	En tant que penseur solo, je veux recevoir des suggestions de connexions entre fragments de sources différentes afin de découvrir des relations non évidentes.	P1	2A–3
US-06	En tant que penseur solo, je veux rejeter une suggestion avec une raison prédéfinie afin qu'elle ne réapparaisse pas.	P1	3
US-07	En tant que penseur solo, je veux accepter une suggestion afin de créer une Construction traçable sur mon canvas.	P1	3
US-08	En tant que penseur solo, je veux conserver la provenance d'une Construction et savoir quand elle devient obsolète afin de pouvoir réévaluer mes idées.	P1	3
US-09	En tant que penseur solo, je veux ouvrir une investigation menée par un seul agent afin d'approfondir une suggestion avec des citations vérifiables.	P1	4
US-10	En tant que penseur solo, je veux choisir Ollama pour le chat afin d'utiliser mes contenus sans les envoyer à Groq, sans bascule silencieuse.	P0*	1A

* US-10 est P0 pour la configuration provider et le comportement sans clé Groq ; l'UX de réglage complet est ultérieure.
2.3 User Story Acceptance Criteria
US-01 — Import texte

    AC1 : une source texte crée un Source, un content_hash et un job d'ingestion asynchrone.
    AC2 : l'ingestion crée des fragments séquentiels, chacun avec un embedding Float32 LE, L2-normalisé, 768 dims.
    AC3 : un contenu déjà présent (même content_hash) retourne 409 et ne crée rien.

US-02 — Import PDF

    AC1 : un PDF textuel est copié dans data/sources/{id}.pdf et son texte normalisé stocké dans raw_content.
    AC2 : un PDF sans texte extractible retourne 422 « texte non extractible ».
    AC3 : les fragments PDF portent le numéro de page dans leur locator.

US-03 — Import URL

    AC1 : une URL valide crée une source URL avec texte extrait via Readability, même normalisation et même hash que les autres types.
    AC2 : un échec de fetch ou d'extraction rend le job visible en failed sans bloquer l'UI.

US-04 — Bibliothèque

    AC1 : la bibliothèque affiche titre, type, date, nombre de fragments, ingest_status et summary_status.
    AC2 : ingest_status est dérivé uniquement des jobs kind='ingest' ∈ {pending, running, done, failed}, le job le plus récent fait foi.
    AC3 : un job repris après crash ne crée aucun doublon de source ni de fragment.

US-05 — Suggestions

    AC1 : chaque suggestion affiche claim, relation_type, tier, statut épistémique (avec définition au survol, figé à la création) et ≥ 2 fragments cliquables.
    AC2 : les deux fragments appartiennent à des sources différentes.
    AC3 : les sorties LLM sont validées Zod ; 0 fragment inexistant ; 0 résumé en preuve.
    AC4 : une paire rejetée ne réapparaît pas, y compris sous une reformulation (blocage par pair_key).

US-06 — Rejet

    AC1 : le rejet exige exactement une raison ∈ {trivial, false, already_known, off_topic} ; requête sans raison → 400.
    AC2 : la raison est persistée et la paire est bloquée pour les variantes futures.

US-07 — Acceptation

    AC1 : l'acceptation crée une Construction avec depth = 1, parent_source_ids, evidence_fragment_ids, provenance_snapshot.
    AC2 : epistemic_status = min_rang(INFERENCE, statut suggestion) — jamais FACT.
    AC3 : une même suggestion ne peut être intégrée deux fois (suggestion_id UNIQUE).

US-08 — Provenance & STALE

    AC1 : après suppression ou ré-ingestion d'une source, la Construction conserve son provenance_snapshot lisible (source, hash, fragment, texte, locator).
    AC2 : la Construction passe à stale = 1 quand ses fragments d'origine disparaissent.

US-09 — Investigation

    AC1 : une investigation utilise 1 agent et ≤ 5 étapes.
    AC2 : toute citation est vérifiée programmatiquement contre des fragments existants (id + texte).
    AC3 : aucune vérification web.

US-10 — Choix du provider chat

    AC1 : LLM_CHAT_PROVIDER=groq (défaut) utilise GROQ_CHAT_MODEL ; =ollama utilise OLLAMA_CHAT_MODEL.
    AC2 : aucun fallback automatique entre providers.
    AC3 : sans GROQ_API_KEY : ingestion et embeddings fonctionnent ; le résumé passe en summary_status='failed' avec erreur structurée missing_groq_api_key, 0 retry automatique, relance manuelle après config.

3. Technical Specification
3.1 Architecture Overview

    Stack : Next.js 14+ (App Router, TypeScript), Tailwind.
    Base de données : SQLite via better-sqlite3, WAL, PRAGMA foreign_keys = ON.
    Chat LLM : LLM_CHAT_PROVIDER=groq (défaut) → Groq llama-3.3-70b-versatile (overridable via GROQ_CHAT_MODEL), API OpenAI-compatible, JSON mode + validation Zod + 1 retry de correction. LLM_CHAT_PROVIDER=ollama → OllamaChatProvider (OLLAMA_CHAT_MODEL). Pas de fallback automatique.
    Embeddings : Ollama nomic-embed-text en local (768 dims, L2-normalisés, Float32 little-endian en BLOB). Aucun embedding cloud.
    Accès LLM : interface LlmProvider { chat(messages, schema): JSON; embed(text): number[] } — GroqProvider (chat), OllamaChatProvider (chat), OllamaProvider (embed), composés en HybridProvider. Tout appel SDK/réseau LLM est confiné à lib/llm/.
    Parsing : texte natif ; PDF via pdf-parse ; URL via fetch + @mozilla/readability.
    Jobs : queue en DB (table jobs), concurrence 1–2, lease + checkpoint, recovery au boot.
    Déploiement : app locale (localhost), aucune donnée hors machine sauf appels chat au provider configuré.

3.2 DO NOT CHANGE

L'agent de code ne doit pas modifier :

    Le schéma v1.2 (§3.3) — noms de tables et colonnes verrouillés.
    L'interface LlmProvider et le confinement à lib/llm/ (chat = provider configurable, embeddings = Ollama ; aucune référence Gemini).
    Le résumé de source n'est jamais citable — seuls les Fragments le sont.
    Les statuts épistémiques : ordre FACT > INFERENCE > HYPOTHESIS > SPECULATION (rangs 3/2/1/0 en code). Suggestion : statut proposé par le LLM, normalisé à la création (FACT rétrogradé en INFERENCE si le claim n'est pas présent textuellement — match normalisé — dans un fragment cité). Construction : min_rang(INFERENCE, statut suggestion) ; jamais FACT ; jamais élevée automatiquement.
    La paire interdite : fragment_a.source_id == fragment_b.source_id.
    La règle d'exposition feed : une seule suggestion par (pair_key, relation_type) — tier le plus élevé, tie-break la plus récente.
    Le blocage de variantes : une suggestion accepted/rejected sur (pair_key, relation_type) interdit l'insertion de nouvelles variantes.
    Le no-fallback : aucune bascule de provider sans reconfiguration explicite.
    Le format des user stories / AC (référence contractuelle).

3.3 Data Models

Source
Champ	Type	Notes
id	uuid PK	
type	TEXT/PDF/URL	
title	text	
canonical_path	text	fichier original (PDF copié dans data/sources/{id}.pdf) ou URL ; ne contient pas le texte
raw_content	TEXT NOT NULL	texte normalisé : NFKC, CRLF→LF, trim des fins de ligne, max 2 lignes vides consécutives — source canonique des fragments
content_hash	TEXT NOT NULL UNIQUE	sha256 du contenu normalisé ; doublon → 409
summary	TEXT NULL	routage UNIQUEMENT, non citable
summary_status	TEXT DEFAULT 'pending'	pending / done / failed — non bloquant
created_at	timestamp	

Fragment
Champ	Type	Notes
id, source_id (FK CASCADE)		
chunk_index	INTEGER NOT NULL	UNIQUE(source_id, chunk_index)
locator	text	format : p.N;[start,end) (PDF), [start,end) (texte), #heading;[start,end) (URL) ; intervalle demi-ouvert en unités de code UTF-16 sur raw_content (aligné sur String.slice())
text	text	chunk exact ; cible 2 000, min 800, max 2 400, overlap 300 ; coupe paragraphe → phrase → coupe dure à 2 400 ; dernier fragment < 800 fusionné au précédent si max respecté ; doc < 800 ⇒ fragment unique
embedding	BLOB NOT NULL	Float32 LE, byteLength == dims × 4, L2-normalisé
embedding_model	TEXT NOT NULL	ex. nomic-embed-text
embedding_dimensions	INTEGER NOT NULL	ex. 768
embedding_version	TEXT NOT NULL	changement ⇒ réindexation complète
chunker_version	TEXT NOT NULL DEFAULT 'chunker-v1'	changement ⇒ re-chunk + ré-embed de la source

Suggestion
Champ	Type	Notes
id, claim, relation_type (analogy/contradiction/cause), tier (strong/medium/weak), state (discovered/shown/opened/accepted/rejected)		
fragment_a_id / fragment_b_id	FK ON DELETE CASCADE	
pair_key	TEXT NOT NULL	analogy/contradiction : min_id:max_id trié ; cause : cause_id:effect_id ordonné
content_sig	text NOT NULL	SHA256(claim canonicalisé : NFKC → minuscules → espaces compactés → ponctuation finale supprimée)
contrainte		UNIQUE(pair_key, relation_type, content_sig)
epistemic_status	enum	normalisé à la création (§3.2)
prompt_version	TEXT NOT NULL	
chat_model	TEXT NOT NULL	
feedback_reason	TEXT NULL	trivial / false / already_known / off_topic — obligatoire si rejected

Construction
Champ	Type	Notes
id, text		
epistemic_status	enum	calculé à la création : min_rang(INFERENCE, statut suggestion)
parent_source_ids, evidence_fragment_ids	json (uuid[])	pas de vraies FK → validation applicative obligatoire
suggestion_id	FK ON DELETE SET NULL, UNIQUE	empêche double intégration
depth	INTEGER CHECK (depth = 1)	
stale	INTEGER DEFAULT 0	
provenance_snapshot	TEXT NOT NULL (JSON)	copie des preuves : {source_id, source_title, source_content_hash, fragment_id, fragment_text, locator}[]

Investigation (inchangé v1.1) : id, suggestion_id FK ON DELETE CASCADE, status (running/done/failed), steps JSON (≤ 5), created_at, updated_at.

Job
Champ	Notes
id, kind (ingest/summary/discover/investigation), payload (JSON valide)	
status (pending/running/done/failed), attempts (≥ 0, max 5), error	un retry réutilise le même job et la même idempotency_key (attempts++)
idempotency_key UNIQUE	SHA256(kind, source_id, content_hash, chunker_version, modèle, prompt_version) ; un nouveau job pour la même opération logique upserte ou remplace l'ancien
source_id	uuid NULL, REFERENCES sources(id) ON DELETE CASCADE, indexé
lease_until, heartbeat_at, lease_token	job running ⇒ lease_token obligatoire ; toute écriture de statut exige le token correspondant
checkpoint, progress_json	reprise par étape
created_at, updated_at, next_run_at	backoff ; index (status, next_run_at), index (source_id)

Recovery au boot : uniquement les jobs running dont lease_until < now repassent pending. Re-chunk : changement de chunker_version ⇒ suppression + ré-ingestion de la source ; les Suggestions disparaissent en CASCADE, les Constructions survivent via provenance_snapshot et passent stale = 1.
3.4 API / Interface Contracts

(Hypothèse assumée : détail porté depuis v1.0 pour les endpoints non listés.)
Endpoint	Input	Output	Erreurs
POST /api/sources	multipart (TEXT/PDF) ou JSON {type:"URL", url}	201 {id, content_hash, ingest_status:"pending"}	409 doublon hash · 422 PDF sans texte · 400 payload invalide
GET /api/sources	—	liste + ingest_status (dérivé des jobs ingest uniquement, le plus récent fait foi, lease expiré ⇒ pending) et summary_status	—
GET /api/sources/:id	—	détail + compte de fragments + statuts	404
DELETE /api/sources/:id	—	204 ; CASCADE fragments/suggestions ; Constructions → stale=1	404
GET /api/suggestions?state=	état	feed : 1 suggestion par (pair_key, relation_type), tri par tier	—
POST /api/suggestions/:id/accept	—	201 Construction	409 déjà intégrée
POST /api/suggestions/:id/reject	{feedback_reason: enum}	200	400 si raison manquante
POST /api/jobs/:id/retry	—	200 job re-pending	404 · 409 si max attempts atteint

Retry/quota global : concurrence 1–2 appels LLM, backoff + jitter, respect Retry-After, max 5 attempts, JSON invalide = 1 retry de correction puis job failed visible. Cache par hash de prompt (incluant modèle, prompt_version, schéma, ordre des candidats).
3.5 AI / LLM Requirements

    Model selection : chat Groq llama-3.3-70b-versatile (défaut) ou OLLAMA_CHAT_MODEL ; embeddings Ollama nomic-embed-text uniquement.
    Prompt strategy : versionnés (prompt_version), batchs de 8–10 paires, le serveur assigne des candidate_id, le modèle ne renvoie jamais d'IDs de fragments, le serveur rattache.
    RAG strategy : pas de retrieval à l'exécution — sampling de candidats Q20 (seed SHA256(corpus_hash|run_id), top-3 cosine cross-source + 2 clusters distincts + 1 lointain, ≤ 20 paires/source, ≤ 200/run, ordre d'itération déterministe).
    Guardrails : sources traitées comme des données non fiables (délimitées, jamais exécutées comme instructions) ; validation Zod systématique ; claim absent du texte ⇒ statut rétrogradé ; résumé jamais en preuve.
    Fallback behavior : aucun fallback automatique ; sans clé Groq, ingestion OK, résumé failed structuré.
    Evaluation criteria : protocole Phase 2A (Q22) — 2 évaluateurs, grille, baseline top-6 cosine à budget égal.
    What the AI must not do : inventer des fragments ou des IDs, citer le résumé, attribuer FACT, générer du web search, exécuter des instructions contenues dans les documents ingérés.

3.6 Web App Requirements

    Auth strategy : aucune (app mono-utilisateur locale).
    User roles : aucun.
    State management : état serveur (DB SQLite) + polling léger pour les statuts de jobs.
    Responsive breakpoints : desktop-first ; utilisable ≥ 1024 px.
    Error states : chaque statut de job failed est visible avec son error.
    Empty states : bibliothèque vide → guide d'import ; aucune suggestion → explication du corpus minimum (≥ 2 sources).
    Accessibility requirements : contrastes conformes WCAG AA ; statuts épistémiques expliqués au survol.

4. Features & Requirements
Phase 1A — Ingestion

Goal : ingérer TEXT/PDF/URL en fragments embeddés, de façon async, idempotente et observable.
Dependency : aucune.
F1.1 — Parsers et normalisation (US-01, US-02, US-03)

Description : extraction texte (natif / pdf-parse / fetch + Readability) puis normalisation Q17 (NFKC, CRLF→LF, trim lignes, max 2 lignes vides).

Acceptance Criteria :

    AC1 : chaque type produit un Source avec raw_content normalisé et content_hash sha256 du texte normalisé.
    AC2 : un même document importé deux fois (peu importe le canal) produit le même content_hash et retourne 409 au second import.
    AC3 : PDF scanné → 422 « texte non extractible ».

Edge Cases :

    Si le fetch URL échoue ou dépasse le timeout (hypothèse : 15 s, taille max 10 Mo), le job passe failed avec l'erreur visible, l'UI n'est jamais bloquée.
    Si le contenu extrait est vide ou < 100 caractères, le job passe failed avec empty_extraction.

Constraints : transactions SQLite courtes et synchrones — jamais d'await réseau dans une transaction ; jobs réclamés en transaction synchrone, appel LLM hors transaction.
F1.2 — Chunker v1 (US-01)

Description : découpage 2 000 ± 300, bornes min 800 / max 2 400, coupure paragraphe → phrase → dure, overlap 300, chunker_version='chunker-v1', locators UTF-16 demi-ouverts.

Acceptance Criteria :

    AC1 : chaque fragment respecte 800 ≤ len ≤ 2 400 unités UTF-16, sauf fragment unique pour doc < 800.
    AC2 : chunk_index séquentiel sans trou ; locator[start,end) slice le texte exact du fragment (raw_content.slice(start, end) === fragment.text).
    AC3 : un paragraphe > 2 400 est coupé par phrases puis coupe dure sans dépasser la borne.

Edge Cases :

    Si le dernier fragment < 800, il est fusionné au précédent si le résultat ≤ 2 400, sinon conservé tel quel.
    Si le texte contient des coupures ambiguës (pas de phrase complète), la coupe dure s'applique.

F1.3 — Embedding service (US-01)

Description : chaque fragment → embedding Ollama, L2-normalisé, Float32 LE en BLOB, avec lecture de contrôle (byteLength == dims × 4, valeurs finies).

Acceptance Criteria :

    AC1 : chaque fragment a embedding, embedding_model, embedding_dimensions=768, embedding_version.
    AC2 : un vecteur non conforme (taille ou NaN) fait échouer le job avec erreur explicite, jamais de BLOB invalide en DB.

Edge Cases : si Ollama est injoignable, le job ingère les fragments sans embeddings ? Non — le job reste running avec checkpoint jusqu'à disponibilité, puis failed après max attempts.
F1.4 — Queue de jobs + recovery (US-04, US-10)

Description : table jobs avec lease/token/checkpoint/idempotency, worker concurrence 1–2, recovery au boot conditionnelle aux leases expirés.

Acceptance Criteria :

    AC1 : crash pendant running puis reboot ⇒ le job est repris au checkpoint, sans doublon de fragments (testé).
    AC2 : un job à lease valide n'est pas repris au boot ; un job à lease expiré l'est.
    AC3 : sans GROQ_API_KEY, le job summary passe failed avec missing_groq_api_key, 0 retry ; ingestion et embeddings fonctionnent.

F1.5 — API sources + bibliothèque (US-04)

Description : endpoints §3.4 + UI bibliothèque (liste, statuts, import drag & drop).

Acceptance Criteria :

    AC1 : la bibliothèque reflète ingest_status et summary_status à jour.
    AC2 : import bloqué ≤ 200 ms côté UI (async via jobs).

Phase 1A Completion Checklist

    US-01 à US-04 et US-10 implémentées et testées.
    Flow import → fragments → embeddings → bibliothèque fonctionne bout en bout.
    Tests : chunker, embedding-codec, ingestion intégration, crash/reprise, lease expiré, offsets UTF-16.

Phase 1B — Validation DB/CLI sur corpus réel

Goal : prouver le pipeline sur données réelles sans UI de découverte.
Dependency : Phase 1A complète.

    AC1 : 12–15 documents réels (≥ 3 domaines) ingérés sans job failed.
    AC2 : 100 % des locators re-slicent le bon texte ; 0 BLOB non conforme ; corpus ≤ 5 000 fragments traité en mémoire.

Phase 2A — PoC découverte en CLI (SANS UI) — jalon bloquant

Goal : valider que le moteur produit des connexions non évidentes avant toute UI.
Dependency : Phase 1B complète.

Pipeline : candidats diversifiés Q20 ; plafond 200 paires/run ; source_a != source_b ; dédup (pair_key, relation_type, content_sig) + variantes bloquées ; batchs de 8–10 paires ; serveur assigne des candidate_id, le modèle ne renvoie jamais d'IDs de fragments, le serveur rattache ; sortie Zod-validée, 1 retry de correction.

Protocole d'évaluation (Q22) :

    Corpus d'itération prompts (5–6 docs) séparé du corpus de validation (12–15 docs, ≥ 3 domaines).
    2 évaluateurs indépendants ; grille par suggestion : non-évidente / correcte-mais-évidente / fausse / fragment-invalide ; « non-évidente » = introuvable par recherche par mots-clés dans les deux sources.
    Cross-domain défini uniquement par corpus_manifest.json ({source_id → domain}) — jamais au runtime.
    Baseline : top-6 cosine pur, même budget (mêmes nombres de paires et d'appels batch).

Pass/fail :

    ≥ 3 connexions non évidentes · < 30 % triviales/fausses · ≥ 1 analogie cross-domain · 0 fragment inexistant · ≤ 50 appels batch.
    Rapport baseline : la diversification fait au moins aussi bien que le top-6 cosine sur les non-évidentes.

Fail ⇒ itérer ici, pas en Phase 3.
Phase 2B — Moteur de découverte validé

Goal : industrialiser le pipeline PoC en job discover persistant.
Dependency : Phase 2A pass.

    AC1 : job discover persiste run_id, corpus_hash, seed, sampler_version et est rejouable à l'identique.
    AC2 : les suggestions créées respectent toutes les contraintes §3.3 (0 doublon, 0 paire intra-source).

Phase 3 — Feed + Canvas + Constructions + STALE

Goal : rendre les suggestions actionnables avec provenance préservée.
Dependency : Phase 2B pass.

    AC1 : feed trié par tier, une seule suggestion par (pair_key, relation_type).
    AC2 : accept → Construction (US-07 AC1–AC3) ; reject → US-06 AC1–AC2 ; 0 rejetée réapparaît.
    AC3 : suppression de source ⇒ Constructions stale=1, provenance_snapshot intact et affichable.

Phase 4 — Investigation (1 agent)

Goal : approfondir une suggestion avec citations vérifiables.
Dependency : Phase 3 complète.

    AC1 : ≤ 5 étapes, 1 agent, chaque citation validée programmatiquement (fragment_id existe + texte match) avant affichage.
    AC2 : citation invalide ⇒ étape marquée failed, jamais affichée comme preuve.

5. Non-Functional Requirements
Category	Requirement	Target
Performance	Clustering/échantillonnage en mémoire	≤ 5 000 fragments
Performance	Réponse UI pendant ingestion	jamais bloquée, import ≤ 200 ms
Reliability	Recovery au boot	leases expirés uniquement, 0 doublon
Reliability	Jobs	max 5 attempts, backoff + jitter, Retry-After respecté
Security	Clé API	GROQ_API_KEY dans .env.local uniquement, requis seulement si provider=groq
Privacy	Positionnement	local-first : embeddings 100 % locaux ; chat vers le provider configuré ; fallback Ollama documenté dans le README
Privacy	Corpus de test	non sensible
Error handling	Sorties LLM	Zod + 1 retry de correction, puis job failed visible
6. Success Metrics
Launch Criteria

Évalués après Phase 2B — tous vrais avant de continuer :

    3–4 « wow »/session sur 12–15 docs réels
    ≥ 40 % de suggestions ouvertes
    ≥ 20 % intégrées
    0 suggestion rejetée réapparaît (y compris reformulée)
    0 résumé cité en preuve
    PoC Phase 2A : pass complet (§4)

Ongoing KPIs

    Primary : taux de non-évidentes validées par les 2 évaluateurs.
    Secondary : taux d'ouverture et d'intégration par session.
    Guardrail : 0 fragment inexistant ; 0 bascule de provider non configurée.

7. Risks & Mitigations
Risk	Likelihood	Impact	Mitigation
Connexions triviales	High	High	Candidats diversifiés Q20, source_a != source_b, tier weak filtré du feed, feedback_reason loggé, PoC bloquant
Sampler biaisé vers sources longues	Medium	High	Quota 20 paires/source, ordre déterministe, baseline de comparaison
JSON instable / gros modèles free	Medium	Medium	Zod + 1 retry de correction + batchs de 8–10 paires
Quotas Groq	High	Medium	Batchs, cache prompt (modèle+prompt_version inclus), concurrence 1–2, backoff
Embeddings incompatibles après swap	Low	Medium	embedding_model/dims/version en DB, réindexation forcée
Provenance perdue après suppression	Low	High	provenance_snapshot sur Construction + stale
Prompt injection via documents ingérés	Medium	Medium	Sources traitées comme données non fiables, délimitation en prompts, aucune exécution d'instructions du contenu
SSRF via ingestion URL	Low	Medium	Hypothèse 1A : localhost solo, timeout 15 s, taille max 10 Mo ; durcissement listé en open question
8. Open Questions

    Wrapper desktop (Tauri/Electron) : reporté, hors MVP.
    Relations intra-source : reportées, hors MVP.
    Réglages modèles par l'utilisateur (UI) : quelle exposition, quelle phase.
    Durcissement ingestion URL (SSRF, redirections, MIME, encodages) : à trancher avant Phase 2A si le corpus de test inclut des URLs non maîtrisées.
    Hypothèse à valider : seuil 800/2 400 chars pertinent pour les documents non-anglophones du corpus réel.

9. Appendix

    Glossaire : Fragment (chunk citable ~2 000 chars) · Suggestion (connexion proposée) · Construction (suggestion intégrée au canvas) · pair_key (identifiant canonique d'une paire orientée ou non) · content_sig (signature canonique d'un claim) · tier (strong/medium/weak) · stale (Construction dont les preuves d'origine ont disparu) · local-first (local par défaut, sortie réseau explicite).
    Docs liés : PRD v1.0 et v1.1 archivés ; delta Q16–Q24 intégré ici.
    Décisions closes : Q1–Q15 (v1.1) · Q16 B · Q17 A · Q18 A · Q19 A · Q20 A · Q21 C · Q22 B · Q23 A · Q24 B.

10. Coding Agent Handoff Prompt — Phase 1A uniquement

Read the PRD above carefully before writing any code.

Start with Phase 1A only.
Do not implement anything from Phases 1B–4 (no suggestions, no discovery, no investigation, no canvas).
Do not modify anything listed in section 3.2 (DO NOT CHANGE).
If any requirement is ambiguous, ask before implementing.

Phase 1A scope: ingestion (TEXT/PDF/URL), Q17 normalization, chunker-v1
(2000 target / min 800 / max 2400 / overlap 300, UTF-16 half-open locators),
Ollama embeddings (768 dims, L2-normalized, Float32 LE BLOB + metadata columns),
async job queue with lease/token/checkpoint/idempotency and boot recovery,
provider selection (LLM_CHAT_PROVIDER=groq|ollama, no silent fallback),
source library UI. Migration file: 001_v1_2.sql (no prior DB exists).

Deliverables in order: package.json/.env.example → lib/config/env.ts →
lib/db/client.ts → migrations/001_v1_2.sql → repositories (sources, fragments,
jobs) → lib/llm/* (LlmProvider, GroqProvider, OllamaChatProvider, OllamaProvider,
HybridProvider, embedding-codec.ts with setFloat32(offset, value, true) and
read-time checks) → lib/ingest/* (parsers, normalizer, chunker, embedding-service,
ingest-service) → lib/jobs/* (queue, worker, recovery) → app/api/sources routes →
app/sources UI → tests (chunker, embedding-codec, ingestion integration, crash
recovery, expired lease, UTF-16 offsets) → README (Ollama install, env vars,
validation steps, local-first statement).

Env vars: DATABASE_PATH=./data/serendipity.db, LLM_CHAT_PROVIDER=groq,
GROQ_API_KEY (required only if provider=groq), GROQ_CHAT_MODEL=llama-3.3-70b-versatile,
OLLAMA_BASE_URL=http://localhost:11434, OLLAMA_EMBED_MODEL=nomic-embed-text,
OLLAMA_CHAT_MODEL (required only if provider=ollama).

After Phase 1A is complete, provide: files changed, implementation summary,
validation steps, risks, suggested tests.

Trois écarts assumés par rapport au verbatim des décisions, signalés dans le document : (a) offsets en UTF-16 plutôt que points de code (alignés sur String.slice), (b) lease_token ajouté à Q23 A (un lease sans token n'empêche pas un worker zombie d'écraser une reprise), (c) Job.source_id typé uuid pour matcher Source.id.