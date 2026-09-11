import type { z } from "zod";
import type { ChatMessage } from "@/lib/llm/types";
import { LlmOutputError } from "@/lib/llm/errors";

/**
 * Chat JSON + validation Zod + 1 retry de correction (PRD §3.5, NFR error handling).
 * `call` exécute un appel réseau brut et renvoie le contenu textuel de la réponse.
 */
export async function chatWithJsonCorrection<T extends z.ZodType>(opts: {
  call: (messages: ChatMessage[]) => Promise<string>;
  messages: ChatMessage[];
  schema: T;
}): Promise<z.infer<T>> {
  let content = await opts.call(opts.messages);
  let parsed = tryParseJson(content);
  let check = parsed === null ? null : opts.schema.safeParse(parsed);

  if (!check?.success) {
    // 1 retry de correction — jamais de fallback de provider.
    const correction: ChatMessage = {
      role: "user",
      content:
        "Ta réponse précédente était invalide (JSON mal formé ou ne respectant pas le schéma). Réponds UNIQUEMENT en JSON valide respectant exactement le schéma demandé.",
    };
    content = await opts.call([...opts.messages, { role: "assistant", content }, correction]);
    parsed = tryParseJson(content);
    check = parsed === null ? null : opts.schema.safeParse(parsed);
  }

  if (!check?.success) {
    const detail = check
      ? check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ")
      : "JSON non parsable";
    // la sortie brute (tronquée) aide au diagnostic des échecs de validation
    const raw = content.replace(/\s+/g, " ").slice(0, 300);
    throw new LlmOutputError(`Sortie LLM invalide après retry de correction — ${detail} | brut: ${raw}`);
  }
  return check.data;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Repli : beaucoup de modèles enveloppent leur JSON dans de la prose
    // (« We need to output JSON… »), même avec response_format=json_object.
    const embedded = extractJsonObject(s);
    if (embedded === null) return null;
    try {
      return JSON.parse(embedded);
    } catch {
      return null;
    }
  }
}

/**
 * Premier objet JSON équilibré d'un texte (accolades appariées, chaînes et échappements
 * respectés). Renvoie null si aucun objet complet n'est trouvé.
 */
function extractJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}