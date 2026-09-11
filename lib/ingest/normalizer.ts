/**
 * Normalisation Q17 (PRD §3.3) : NFKC, CRLF→LF, trim des fins de ligne,
 * max 2 lignes vides consécutives. Source canonique des fragments.
 */
export function normalizeText(input: string): string {
  let text = input.normalize("NFKC");
  // CRLF (et CR seul) → LF
  text = text.replace(/\r\n?/g, "\n");
  // trim des fins de ligne (espaces/tabulations de fin)
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
  // max 2 lignes vides consécutives
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blankRun += 1;
      if (blankRun > 2) continue;
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}