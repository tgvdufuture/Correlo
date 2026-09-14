-- Migration 004 — cache de prompt persistant (Phase 5A, critère AC2)
--
-- Constat mesuré (2026-09-13) : `SynthesisService` et `DiscoveryService` acceptent une
-- option `promptCache` et comptabilisent `llm_calls_from_cache`, mais aucune
-- implémentation persistante n'était branchée. Conséquence : rejouer un même run
-- rappelait le LLM, qui **reformule** — donc `content_sig` (SHA256 du texte
-- canonicalisé) ne pouvait pas dédupliquer, et l'AC2 « rejouer un run n'insère
-- 0 nouvelle synthèse » était hors de portée, non par un défaut de dédup mais
-- parce que la même question recevait une réponse différente.
--
-- La clé est SHA256(modèle de chat | version de prompt | messages) : le cache ne
-- sert jamais une réponse produite pour un autre prompt ni par un autre modèle.
-- Aucune donnée n'est partagée entre modèles, aucune réponse n'est devinée.
CREATE TABLE llm_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,   -- JSON de la réponse, déjà validée par le schéma Zod du service
  created_at TEXT NOT NULL
);

CREATE INDEX idx_llm_cache_created ON llm_cache(created_at);
