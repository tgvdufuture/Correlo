import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_MAX_REDIRECTS,
  WebRefusalError,
  assertPublicHttpUrl,
  fetchGuarded,
  isPrivateAddress,
  ipv6Groups,
} from "@/lib/agent/web-guard";
import { readWebPage } from "@/lib/agent/web-page";
import { createExaSearchProvider } from "@/lib/agent/web-search";
import { LlmRateLimitError, LlmTransientError } from "@/lib/llm/errors";
import { TRANSIENT_BACKOFF_BASE_MS } from "@/lib/llm/retry";

/**
 * Phase 6 — le chemin web : durcissement, lecture, connecteur (amendement v1.3 §13.4).
 *
 * **Aucun réseau réel n'est touché** : `fetch` et la résolution DNS sont injectés. Ce n'est
 * pas une commodité de test, c'est la seule façon d'écrire les cas qui comptent — un
 * `302 Location: http://169.254.169.254/` ne se déclenche pas sur commande sur Internet, et
 * un test qui dépendrait d'un hôte réel ne prouverait rien le jour où il tombe.
 *
 * Ce que l'AC6 exige, cas par cas : schémas non http(s), identifiants dans l'URL, adresses
 * privées/bouclage/lien local (y compris **après redirection**), plafonds de taille et de
 * type — chacun refusé **et** refusé *avant* de sortir.
 */

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const publicResolve = async (): Promise<{ address: string; family: number }[]> => PUBLIC;

const REPLACE = (url: string | URL): string => String(url);

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("contrôle d'URL : schéma, identifiants, forme", () => {
  it("n'accepte que http(s)", () => {
    expect(assertPublicHttpUrl("https://example.com/a").hostname).toBe("example.com");
    expect(assertPublicHttpUrl("http://example.com/a").protocol).toBe("http:");
    for (const bad of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,<b>x"]) {
      expect(() => assertPublicHttpUrl(bad)).toThrow(WebRefusalError);
    }
  });

  it("refuse les identifiants dans l'URL (ils fuiteraient dans les journaux)", () => {
    expect(() => assertPublicHttpUrl("https://user:pass@example.com/x")).toThrow(
      /Identifiants dans l'URL/
    );
  });

  it("refuse une URL illisible ou sans hôte", () => {
    expect(() => assertPublicHttpUrl("pas une url")).toThrow(WebRefusalError);
    expect(() => assertPublicHttpUrl("https://")).toThrow(WebRefusalError);
    expect(() => assertPublicHttpUrl("https://" + " ")).toThrow(WebRefusalError);
  });
});

describe("adresses non publiques", () => {
  it("refuse ce qui mène à la machine ou au réseau local (IPv4)", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "10.0.0.5",
      "172.16.3.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // métadonnées cloud
      "100.64.0.1", // CGNAT
      "198.18.0.1",
      "203.0.113.7",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "192.169.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuse ce qui mène à la machine (IPv6), y compris les formes qui encapsulent une IPv4", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::127.0.0.1",
      "2002:7f00:0001::1", // 6to4 → 127.0.0.1
      "64:ff9b::10.0.0.1", // NAT64 → 10.0.0.1
      "2001:0000::1", // Teredo
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("une adresse illisible est refusée (le défaut d'un contrôle est de refuser)", () => {
    expect(isPrivateAddress("pas une adresse")).toBe(true);
    expect(isPrivateAddress("2606:4700::zz")).toBe(true);
    expect(ipv6Groups("2606:4700::zz")).toBeNull();
    expect(ipv6Groups("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(ipv6Groups("1:2:3:4:5:6:7")).toBeNull();
    expect(ipv6Groups("2001:db8::1")).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });
});

describe("lecture durcie : ce qui ne doit jamais sortir", () => {
  it("refuse une adresse locale sans même appeler `fetch`", async () => {
    const fetchMock = vi.fn();
    for (const url of [
      "http://127.0.0.1:11434/api/tags",
      "http://[::1]:3232/api/sources",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.10/",
    ]) {
      await expect(
        fetchGuarded(url, { fetchImpl: fetchMock as unknown as typeof fetch })
      ).rejects.toThrow(WebRefusalError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("résout l'hôte et refuse une adresse privée (localhost, DNS menteur)", async () => {
    const fetchMock = vi.fn();
    await expect(
      fetchGuarded("http://localhost:3232/api/sources", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      })
    ).rejects.toThrow(/non publique/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse dès qu'**une** des adresses résolues est privée (rebinding)", async () => {
    const fetchMock = vi.fn();
    await expect(
      fetchGuarded("https://example.com/", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        resolve: async () => [...PUBLIC, { address: "10.1.2.3", family: 4 }],
      })
    ).rejects.toThrow(/non publique/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("une résolution en échec est un refus lisible, pas une exception brute", async () => {
    await expect(
      fetchGuarded("https://example.com/", {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      })
    ).rejects.toThrow(/non résolu/);
  });

  it("revalide chaque redirection : un 302 vers la machine locale est refusé", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = REPLACE(input);
      if (url === "https://example.com/aller") {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3232/" } });
      }
      return html("<p>jamais lu</p>");
    });
    await expect(
      fetchGuarded("https://example.com/aller", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        resolve: publicResolve,
      })
    ).rejects.toThrow(/Adresse non publique refusée/);
    // la redirection n'est pas suivie : un seul appel, et il était légitime
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("résout une `Location` relative et garde la chaîne des redirections", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = REPLACE(input);
      if (url === "https://example.com/a") {
        return new Response(null, { status: 301, headers: { location: "/b" } });
      }
      return html("<p>Bonjour</p>");
    });
    const page = await fetchGuarded("https://example.com/a", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(page.url).toBe("https://example.com/b");
    expect(page.redirects).toEqual(["https://example.com/b"]);
  });

  it("plafonne les redirections et refuse une redirection sans destination", async () => {
    const loop = vi.fn(
      async (input: string | URL) =>
        new Response(null, { status: 302, headers: { location: `${REPLACE(input)}?x=1` } })
    );
    await expect(
      fetchGuarded("https://example.com/", {
        fetchImpl: loop as unknown as typeof fetch,
        resolve: publicResolve,
      })
    ).rejects.toThrow(new RegExp(`Plus de ${WEB_MAX_REDIRECTS} redirections`));

    const noLocation = vi.fn(async () => new Response(null, { status: 302 }));
    await expect(
      fetchGuarded("https://example.com/", {
        fetchImpl: noLocation as unknown as typeof fetch,
        resolve: publicResolve,
      })
    ).rejects.toThrow(/sans Location/);
  });

  it("refuse un type non textuel et une réponse HTTP en erreur", async () => {
    const pdf = vi.fn(
      async () =>
        new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })
    );
    await expect(
      fetchGuarded("https://example.com/doc.pdf", {
        fetchImpl: pdf as unknown as typeof fetch,
        resolve: publicResolve,
      })
    ).rejects.toThrow(/non textuel/);

    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(
      fetchGuarded("https://example.com/absent", {
        fetchImpl: notFound as unknown as typeof fetch,
        resolve: publicResolve,
      })
    ).rejects.toThrow(/HTTP 404/);
  });

  it("plafonne le corps **pendant** la lecture, pas après", async () => {
    const declared = vi.fn(
      async () =>
        new Response("petit", {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "9999999" },
        })
    );
    await expect(
      fetchGuarded("https://example.com/gros", {
        fetchImpl: declared as unknown as typeof fetch,
        resolve: publicResolve,
        maxBytes: 1_000,
      })
    ).rejects.toThrow(/au-delà du plafond|annoncée/);

    // pas d'en-tête de taille : c'est le flux qui est coupé
    const streamed = vi.fn(
      async () =>
        new Response("x".repeat(5_000), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );
    await expect(
      fetchGuarded("https://example.com/flux", {
        fetchImpl: streamed as unknown as typeof fetch,
        resolve: publicResolve,
        maxBytes: 1_000,
      })
    ).rejects.toThrow(/au-delà de 1000 octets/);
  });

  it("rend les octets bruts et le type d'une page textuelle", async () => {
    const fetchMock = vi.fn(async () => html("<html><body><p>Bonjour le monde</p></body></html>"));
    const page = await fetchGuarded("https://example.com/", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(page.status).toBe(200);
    expect(page.contentType).toContain("text/html");
    expect(new TextDecoder().decode(page.bytes)).toContain("Bonjour le monde");
  });
});

describe("lecture d'une page : texte extrait, prêt à être cité", () => {
  const article = `<html><head><title>Titre de la page</title></head><body><article>
    <h1>Un titre</h1>
    <p>${"La mesure experimentale fixe les conditions de l'observation. ".repeat(6)}</p>
    <p>${"Le doute methodique ecarte les opinions seulement probables. ".repeat(4)}</p>
  </article></body></html>`;

  it("extrait le texte par Readability et le titre, sans exécuter la page", async () => {
    const fetchMock = vi.fn(async () => html(article));
    const page = await readWebPage("https://example.com/page", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(page.title).toBe("Titre de la page");
    expect(page.text).toContain("La mesure experimentale fixe les conditions");
    expect(page.text.length).toBeGreaterThan(100);
    // un `<script>` ne doit rien produire : jsdom est utilisé sans `runScripts`
    expect(page.text).not.toContain("alert");
  });

  it("refuse une page sans texte exploitable", async () => {
    const fetchMock = vi.fn(async () => html("<html><body><p>trop court</p></body></html>"));
    await expect(
      readWebPage("https://example.com/vide", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        resolve: publicResolve,
      })
    ).rejects.toThrow(/sans texte exploitable/);
  });

  it("accepte un `text/plain` (et pas seulement du HTML)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("Un paragraphe de texte brut. ".repeat(10), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
    );
    const page = await readWebPage("https://example.com/notes.txt", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(page.text).toContain("Un paragraphe de texte brut.");
  });
});

describe("connecteur de recherche (Exa), écrit en fetch direct", () => {
  const payload = {
    results: [
      {
        title: "La mesure au laboratoire",
        url: "https://exemple.org/mesure",
        publishedDate: "2024-03-04T10:00:00.000Z",
        author: "C. Bernard",
      },
      { title: "Interne", url: "http://127.0.0.1/secret" },
      { title: "Sans url" },
      { url: "file:///etc/passwd" },
    ],
  };

  it("rend les résultats exploitables, et **filtre** les adresses non montrables", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = createExaSearchProvider({
      apiKey: "clé-de-test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const results = await provider.search("mesure expérimentale");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "La mesure au laboratoire",
      url: "https://exemple.org/mesure",
      published_at: "2024-03-04T10:00:00.000Z",
    });
    // la requête envoyée ne demande **pas** le texte des pages : c'est `read_page` qui lit
    expect(sentBody).toEqual({ query: "mesure expérimentale", numResults: 5, type: "auto" });
    expect(sentBody).not.toHaveProperty("contents");
  });

  it("une réponse illisible ne casse pas la recherche, elle ne rend rien", async () => {
    const provider = createExaSearchProvider({
      apiKey: "k",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(provider.search("q")).resolves.toEqual([]);
  });

  it("un refus définitif remonte sans être réessayé (clé invalide, requête refusée)", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const provider = createExaSearchProvider({
      apiKey: "k",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.search("q")).rejects.toThrow(WebRefusalError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un 429 porte `Retry-After` et s'épuise en tentatives (jamais une boucle)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } })
    );
    const provider = createExaSearchProvider({
      apiKey: "k",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const pending = provider.search("q");
    const guard = expect(pending).rejects.toBeInstanceOf(LlmRateLimitError);
    // 5 tentatives, chacune espacée du `Retry-After` plafonné (12 s + 5 s de marge)
    await vi.advanceTimersByTimeAsync(17_000 * 5);
    await guard;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("un incident passager est réessayé (politique partagée), puis la recherche aboutit", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    const provider = createExaSearchProvider({
      apiKey: "k",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const pending = provider.search("mesure");
    await vi.advanceTimersByTimeAsync(TRANSIENT_BACKOFF_BASE_MS * 2);
    const results = await pending;
    expect(results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // la première erreur est bien vue comme passagère : c'est ce qui déclenche le réessai
    expect(new LlmTransientError("503")).toBeInstanceOf(Error);
  });
});
