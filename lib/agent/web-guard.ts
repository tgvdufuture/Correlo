import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WebRefusal } from "@/lib/agent/web-refusals";

// réexport : le vocabulaire des refus vit dans un module **pur** (`web-refusals.ts`),
// parce que l'écran doit pouvoir l'afficher sans entraîner `node:dns` dans un bundle client
export { WEB_REFUSAL_LABEL } from "@/lib/agent/web-refusals";
export type { WebRefusal } from "@/lib/agent/web-refusals";

/**
 * Durcissement réseau des outils web (Phase 6, amendement v1.3 §13.4).
 *
 * **Pourquoi ce module existe.** Jusqu'ici une URL entrait dans l'app par un geste de
 * l'utilisateur (une URL collée en 1A) : le PRD §8 laissait le durcissement des URL en
 * *question ouverte*, ce qui était défendable pour une app locale mono-utilisateur.
 * En Phase 6, l'URL est choisie **par le modèle**, lui-même influençable par un document
 * ingéré — le risque de *prompt injection via documents ingérés* que le PRD §7 liste
 * depuis la v1.2 devient une capacité d'action : une page peut demander au modèle de lire
 * `http://169.254.169.254/latest/meta-data/` ou `http://localhost:3232/api/...`. Le
 * durcissement n'est donc plus une option.
 *
 * Ce que le module garantit, dans l'ordre où ça compte :
 *  1. **http(s) seulement**, sans identifiants dans l'URL (`http://user:pass@hôte`) ;
 *  2. l'hôte est **résolu** (DNS) et l'adresse obtenue doit être **publique** : privée,
 *     bouclage, lien local, multicast, réservé, documentation — IPv4 **et** IPv6, y
 *     compris les formes qui encapsulent une IPv4 (mappée `::ffff:a.b.c.d`, compatible
 *     `::a.b.c.d`, 6to4 `2002::/16`, NAT64 `64:ff9b::/96`, Teredo `2001:0000::/32`) ;
 *  3. les redirections sont suivies **à la main** (`redirect: "manual"`), **revalidées à
 *     chaque saut** (la redirection est le contournement classique : une URL publique qui
 *     répond `302 Location: http://127.0.0.1:11434`), et plafonnées ;
 *  4. le corps est **plafonné pendant la lecture** (et non après coup) et le type doit
 *     être textuel.
 *
 * **Ce que ce module ne garantit pas, et qu'il ne faut pas lui faire dire.** Il y a une
 * fenêtre entre la résolution DNS contrôlée ici et la résolution faite par `fetch` par le
 * système : un hôte malveillant peut répondre une adresse publique au contrôle puis une
 * adresse privée à la connexion (DNS rebinding). Fermer cette fenêtre demanderait de
 * connecter sur l'adresse validée (épinglage IP + en-tête `Host`), ce qu'`undici` n'expose
 * pas sans transport personnalisé. Les gardes ci-dessous fermant les chemins normaux
 * (`localhost`, métadonnées cloud, IP privées, redirections), l'exposition résiduelle est
 * le rebinding actif — notée comme réserve, pas tue.
 */

/** Timeout d'une lecture de page (mêmes valeurs que l'ingestion : pages réelles lourdes). */
export const WEB_PAGE_TIMEOUT_MS = 45_000;

/** Plafond d'octets d'une page lue. */
export const WEB_PAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Redirections suivies au plus (chacune revalidée). */
export const WEB_MAX_REDIRECTS = 3;

/** Longueur du texte conservé pour une page (borne le prompt et la copie persistée). */
export const WEB_PAGE_MAX_CHARS = 4_000;

/** Refus d'une URL ou d'une lecture — porté jusqu'à l'étape de conversation. */
export class WebRefusalError extends Error {
  constructor(
    readonly refusal: WebRefusal,
    message: string
  ) {
    super(message);
    this.name = "WebRefusalError";
  }
}

/** Résolution DNS injectable (les tests fournissent des serveurs faux, sans réseau). */
export type ResolveHost = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolve: ResolveHost = async (hostname) => lookup(hostname, { all: true });

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Contrôle **synchrone** d'une URL : schéma, identifiants, forme. Volontairement séparé de
 * la résolution DNS : une recherche web peut filtrer les URL manifestement inutilisables
 * sans payer une résolution, et la lecture complète (`fetchGuarded`) refait le contrôle
 * plus la résolution, **à chaque saut**.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebRefusalError("url_invalide", `URL illisible : ${raw.slice(0, 120)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebRefusalError(
      "schema_refuse",
      `Schéma refusé (${url.protocol}) : http ou https seulement (${url.href.slice(0, 120)})`
    );
  }
  if (url.username || url.password) {
    throw new WebRefusalError(
      "schema_refuse",
      `Identifiants dans l'URL refusés (${url.hostname})`
    );
  }
  if (!url.hostname) {
    throw new WebRefusalError("url_invalide", "URL sans hôte");
  }
  return url;
}

/**
 * Vrai si l'adresse ne doit **jamais** être contactée. Adresse illisible ⇒ `true` : le
 * défaut d'un contrôle de sécurité est de refuser, pas de laisser passer.
 */
export function isPrivateAddress(address: string): boolean {
  const zone = address.indexOf("%");
  const ip = zone >= 0 ? address.slice(0, zone) : address;
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) {
    const groups = ipv6Groups(ip);
    return groups ? isPrivateIPv6(groups) : true;
  }
  return true;
}

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true;
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 « ce réseau »
  if (a === 10) return true; // privé
  if (a === 127) return true; // bouclage
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // lien local (métadonnées cloud)
  if (a === 172 && b >= 16 && b <= 31) return true; // privé
  if (a === 192 && b === 168) return true; // privé
  if (a === 192 && (b === 0 || b === 88)) return true; // 192.0.0/24, 192.0.2/24, 192.88.99/24
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true; // bancs d'essai et documentation
  if (a === 203 && b === 0) return true; // documentation 203.0.113/24
  if (a >= 224) return true; // multicast, réservé, 255.255.255.255
  return false;
}

function isPrivateIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((g) => g === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true; // bouclage ::1
  }
  // IPv4 encapsulée : mappée (::ffff:a.b.c.d) et compatible (::a.b.c.d) — c'est une IPv4
  if ([g0, g1, g2, g3, g4].every((g) => g === 0) && (g5 === 0 || g5 === 0xffff)) {
    return isPrivateIPv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if ((g0 & 0xffc0) === 0xfe80) return true; // lien local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0x0000) return true; // Teredo (tunnelise une IPv4)
  if (g0 === 0x2002) {
    // 6to4 : l'IPv4 est dans les 32 bits suivants
    return isPrivateIPv4(`${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`);
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`); // NAT64 64:ff9b::/96
  }
  return false;
}

/** Développe un littéral IPv6 en 8 groupes de 16 bits, ou `null` s'il est illisible. */
export function ipv6Groups(raw: string): number[] | null {
  const zone = raw.indexOf("%");
  let text = zone >= 0 ? raw.slice(0, zone) : raw;

  // IPv4 en fin de littéral (`::ffff:127.0.0.1`)
  let tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => n > 255)) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = text.slice(0, dotted.index);
    if (text.endsWith(":")) text = text.slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  if (!head) return null;
  if (halves.length === 1) {
    const all = [...head, ...tail];
    return all.length === 8 ? all : null;
  }
  const rest = parse(halves[1]);
  if (!rest) return null;
  const zeros = 8 - head.length - rest.length - tail.length;
  if (zeros < 0) return null;
  return [...head, ...Array<number>(zeros).fill(0), ...rest, ...tail];
}

/**
 * Résout l'hôte **puis** refuse les adresses non publiques. Refuser si **une seule**
 * adresse renvoyée est privée : un hôte qui répond à la fois publique et privée est soit
 * mal configuré, soit en train de tenter un rebinding — dans les deux cas la lecture
 * n'est pas nécessaire.
 */
export async function assertResolvablePublicHost(
  url: URL,
  resolve: ResolveHost = defaultResolve
): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new WebRefusalError("adresse_locale", `Adresse non publique refusée (${hostname})`);
    }
    return;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolve(hostname);
  } catch (e) {
    throw new WebRefusalError(
      "resolution_echec",
      `Hôte non résolu (${hostname}) : ${(e as Error).message}`
    );
  }
  if (addresses.length === 0) {
    throw new WebRefusalError("resolution_echec", `Hôte sans adresse (${hostname})`);
  }
  const refused = addresses.find((a) => isPrivateAddress(a.address));
  if (refused) {
    throw new WebRefusalError(
      "adresse_locale",
      `Adresse non publique refusée (${hostname} → ${refused.address})`
    );
  }
}

export interface GuardedPage {
  /** URL effectivement lue (après redirections — c'est celle qui est citée). */
  url: string;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
  /** Chaîne des redirections suivies, dans l'ordre. */
  redirects: string[];
}

/**
 * Lecture durcie d'une URL : contrôle du schéma, résolution contrôlée, redirections
 * suivies à la main **et revalidées**, plafonds de taille et de durée appliqués pendant la
 * lecture. Toute sortie de route est un `WebRefusalError` — jamais un `fetch` silencieux
 * vers une adresse qu'on n'a pas voulue.
 */
export async function fetchGuarded(
  rawUrl: string,
  opts?: {
    fetchImpl?: typeof fetch;
    resolve?: ResolveHost;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
  }
): Promise<GuardedPage> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const resolve = opts?.resolve ?? defaultResolve;
  const timeoutMs = opts?.timeoutMs ?? WEB_PAGE_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? WEB_PAGE_MAX_BYTES;
  const maxRedirects = opts?.maxRedirects ?? WEB_MAX_REDIRECTS;

  let url = assertPublicHttpUrl(rawUrl);
  const redirects: string[] = [];
  // le signal couvre fetch **et** la lecture du corps : un serveur qui envoie les en-têtes
  // puis un corps lent ne doit pas laisser le tour en cours à vie
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (;;) {
      await assertResolvablePublicHost(url, resolve);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (app locale Sérendipité)",
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          },
        });
      } catch (e) {
        if (e instanceof WebRefusalError) throw e;
        throw new WebRefusalError(
          "lecture_echec",
          `Échec du fetch (${url.href}) : ${(e as Error).message}`
        );
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        if (!location) {
          throw new WebRefusalError(
            "redirection_refusee",
            `Redirection ${res.status} sans Location (${url.href})`
          );
        }
        if (redirects.length >= maxRedirects) {
          throw new WebRefusalError(
            "redirection_refusee",
            `Plus de ${maxRedirects} redirections (${url.href})`
          );
        }
        // `new URL(location, url)` résout une Location relative **et** la revalide :
        // c'est le saut le plus dangereux, il ne doit pas passer sans contrôle
        const next = assertPublicHttpUrl(new URL(location, url).href);
        redirects.push(next.href);
        url = next;
        continue;
      }

      if (!res.ok) {
        throw new WebRefusalError("http_echec", `HTTP ${res.status} pour ${url.href}`);
      }
      const contentType = res.headers.get("content-type");
      if (contentType && !isTextual(contentType)) {
        throw new WebRefusalError("type_refuse", `Type non textuel (${contentType})`);
      }
      const bytes = await readCapped(res, maxBytes);
      return { url: url.href, status: res.status, contentType, bytes, redirects };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Types acceptés : du texte. Un en-tête **absent** est accepté (beaucoup de pages réelles
 * n'en posent pas sur leurs réponses 200), et c'est l'extraction ensuite qui constate ;
 * un en-tête **présent et non textuel** est refusé sans lire le corps.
 */
function isTextual(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "application/json"
  );
}

/**
 * Lit le corps en **coupant dès le dépassement** (et non après coup) : un `arrayBuffer()`
 * sur un flux sans fin tiendrait 10 Mo en mémoire puis refuserait, ce qui laisse quand même
 * le serveur choisir combien on télécharge.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebRefusalError("corps_trop_gros", `Page annoncée à ${declared} octets`);
  }
  const body = res.body;
  if (!body) return new Uint8Array(await res.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WebRefusalError("corps_trop_gros", `Page au-delà de ${maxBytes} octets`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
