/**
 * Titre d'une source importée par fichier (US-03).
 *
 * Constat réel (2026-09-13) : « La Loi (Frédéric Bastiat).txt », choisi depuis un outil
 * Windows qui encode les noms de fichier en CP1252, est arrivé au serveur décodé en UTF-8 :
 * le titre stocké était « La Loi (Fr�d�ric Bastiat) ». Ce titre se retrouve dans les
 * prompts de synthèse et dans `provenance_snapshot` — un titre abîmé est donc une
 * provenance abîmée.
 *
 * Règle : on ne répare jamais en devinant.
 * - le **mojibake réversible** (« FrÃ©dÃ©ric ») est réparé : les octets sont retrouvables,
 *   donc la correction est exacte et vérifiable ;
 * - **U+FFFD est destructif** : l'octet perdu n'existe plus. Un aller-retour latin-1
 *   produirait « Frýdýric » — silencieusement faux, donc pire que le mal. On se rabat
 *   alors sur un titre **dérivé du contenu**, qui est la seule information intacte.
 */

export const REPLACEMENT_CHAR = "\uFFFD";

/** Marqueurs de mojibake « UTF-8 lu comme latin-1 » (Ã©, Â«, â€™…). */
const MOJIBAKE_MARKERS = /[\u00C2-\u00C3\u00E2][\u0080-\u00BF\u20AC\u201A-\u2122]/;

/**
 * Répare « UTF-8 lu comme latin-1 » (sans perte : les octets sont reconstruits).
 * Renvoie null si le texte n'est pas du mojibake, ou si la « réparation » introduit
 * du U+FFFD (ce serait un remplacement à l'aveugle).
 */
export function repairMojibake(text: string): string | null {
  if (!MOJIBAKE_MARKERS.test(text)) return null;
  // Chaque caractère ≤ 0xFF vaut son octet d'origine ; au-delà, la conversion perdrait
  // de l'information → on refuse de tenter.
  if (/[^\u0000-\u00FF]/.test(text.replace(/\uFFFD/g, ""))) return null;
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  if (decoded.includes(REPLACEMENT_CHAR)) return null;
  if (MOJIBAKE_MARKERS.test(decoded)) return null;
  return decoded;
}

/** Première ligne du contenu qui peut faire un titre : non vide, sans U+FFFD, 4–120 car. */
export function titleFromContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const lines = content.split("\n");
  for (const line of lines.slice(0, 40)) {
    const candidate = line.replace(/\s+/g, " ").trim().replace(/[.,;:·\-–—]+$/, "").trim();
    if (candidate.length < 4 || candidate.length > 120) continue;
    if (candidate.includes(REPLACEMENT_CHAR)) continue;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Titre utilisable pour une source importée par fichier.
 * @param raw      titre fourni (champ `title` ou nom de fichier)
 * @param content  texte de la source, utilisé seulement si le titre est abîmé
 */
export function sanitizeSourceTitle(
  raw: string | null | undefined,
  content?: string | null
): { title: string; repaired: boolean; source: "given" | "content" | "stripped" } {
  const base = (raw ?? "").replace(/\s+/g, " ").trim();
  if (base && !base.includes(REPLACEMENT_CHAR)) {
    const fixed = repairMojibake(base);
    if (fixed !== null && fixed.trim()) {
      return { title: fixed.trim(), repaired: true, source: "given" };
    }
    return { title: base, repaired: false, source: "given" };
  }

  const fromContent = titleFromContent(content);
  if (fromContent) return { title: fromContent, repaired: true, source: "content" };

  // Dernier recours : on retire les caractères abîmés plutôt que de les stocker.
  const stripped = base
    .split(REPLACEMENT_CHAR)
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\(\s*\)/g, "")
    .trim();
  return { title: stripped || "Source sans titre", repaired: true, source: "stripped" };
}
