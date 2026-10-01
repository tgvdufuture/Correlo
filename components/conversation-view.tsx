"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CornerDownLeft,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  MessageSquare,
  Quote,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  ANSWER_REJECTION_LABEL,
  CONVERSATION_ACTION_LABEL,
  CONVERSATION_FAILURE_LABEL,
  EVIDENCE_PROBLEM_LABEL,
  STEP_FAILURE_LABEL,
  WEB_PROBLEM_LABEL,
  WEB_REFUSAL_LABEL,
  WEB_UNLOCK_REASON_LABEL,
  WORKSPACE_PROBLEM_LABEL,
  WORKSPACE_REFUSAL_LABEL,
  type ClaimProvenanceView,
  type ConversationClaimView,
  type ConversationMessageView,
  type ConversationRunView,
  type ConversationSummary,
  type ConversationView as ConversationViewData,
} from "@/lib/api-types";

/**
 * Un motif d'échec d'étape : son libellé s'il en a un, le code brut sinon (jamais un blanc).
 * Trois familles se mélangent dans la trace d'un tour — les règles du serveur (ex. budget
 * épuisé), les refus du durcissement réseau, ceux du confinement du workspace — et l'écran
 * n'a pas à savoir laquelle a parlé.
 */
function failureLabel(code: string): string {
  return (
    STEP_FAILURE_LABEL[code] ??
    WEB_REFUSAL_LABEL[code as keyof typeof WEB_REFUSAL_LABEL] ??
    WORKSPACE_REFUSAL_LABEL[code as keyof typeof WORKSPACE_REFUSAL_LABEL] ??
    code
  );
}

/**
 * Conversation (Phase 6, amendement v1.3 §13).
 *
 * L'écran **ne calcule rien et ne décide de rien** : le serveur assemble la réponse à
 * partir des affirmations du modèle et revérifie chaque provenance à la lecture. Ici on
 * affiche, une affirmation par ligne avec ses preuves — c'est littéralement l'AC1 : une
 * affirmation dont aucune provenance ne survit est montrée « non sourcée », jamais comme
 * un fait.
 *
 * Deux modes, un seul composant :
 *  - `conversationId = null` — la première question **crée** la conversation (son titre
 *    est le premier message), puis l'écran navigue vers `/conversation/<id>`. Une
 *    conversation n'existe donc jamais à vide ;
 *  - `conversationId` fourni — on lit, on pose d'autres questions, et on suit le tour en
 *    cours tant que la réponse est `pending`.
 *
 * Les étapes de l'agent sont affichées (recherches, fragments lus, refus) : c'est la
 * contrepartie visible de « l'agent lit le corpus » — sans elles, une réponse sourcée
 * serait un oracle.
 */
export function ConversationView({
  conversationId,
  initialAnchor,
}: {
  conversationId: string | null;
  /**
   * L'ancre de départ. Elle sert au `POST` qui crée la conversation **et** au bandeau
   * avant la première question (`label` est lu côté serveur) ; dès qu'une conversation
   * est chargée, c'est celle de la base qui s'affiche — un état d'écran ne doit pas
   * pouvoir contredire la ligne.
   */
  initialAnchor: { kind: "synthesis" | "corpus"; ref: string | null; label: string | null };
}) {
  const router = useRouter();
  const [view, setView] = useState<ConversationViewData | null>(null);
  const [summaries, setSummaries] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<ConversationViewData> => {
    const res = await fetch(`/api/conversations/${conversationId}`);
    if (!res.ok) throw new Error(`conversation indisponible (${res.status})`);
    return (await res.json()) as ConversationViewData;
  }, [conversationId]);

  // Chargement initial. Une conversation ouverte au rechargement affiche l'historique
  // **du corpus**, pas un écran vide : c'est tout l'intérêt de la persister.
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    void load()
      .then((d) => alive && setView(d))
      .catch(() => alive && setError("Conversation indisponible — rechargez la page."));
    return () => {
      alive = false;
    };
  }, [conversationId, load]);

  // Nouvelle conversation : on montre les précédentes (le titre sert à les reconnaître).
  useEffect(() => {
    if (conversationId) return;
    let alive = true;
    void fetch("/api/conversations?limit=20")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => alive && setSummaries(d as ConversationSummary[]))
      .catch(() => alive && setSummaries([]));
    return () => {
      alive = false;
    };
  }, [conversationId]);

  // Suivi du tour : on redemande l'état tant qu'une question attend sa réponse, et on
  // s'arrête dès qu'elle est terminale — le serveur fait foi.
  //
  // Le critère est `awaiting_reply` et non « le dernier message est `pending` » : la ligne de
  // réponse est écrite par le worker à son démarrage, donc **entre** le `POST` et le premier
  // appel LLM la dernière ligne est encore la question. Un écran qui n'aurait regardé que
  // `pending` serait resté figé sur la question jusqu'à un rechargement manuel (défaut réel
  // de la première version, mesuré en vérification HTTP).
  const working = view?.awaiting_reply ?? false;
  useEffect(() => {
    if (!view || conversationId === null || !view.awaiting_reply) return;
    const timer = setTimeout(() => {
      void load()
        .then(setView)
        .catch(() => setError("Suivi interrompu — rechargez la page pour voir la réponse."));
    }, 2500);
    return () => clearTimeout(timer);
  }, [view, conversationId, load]);

  const ask = async () => {
    const question = draft.trim();
    if (question.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!conversationId) {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            anchor:
              initialAnchor.kind === "synthesis" && initialAnchor.ref
                ? { kind: "synthesis", ref: initialAnchor.ref }
                : { kind: "corpus" },
          }),
        });
        if (res.status === 404) {
          setError("La synthèse d'origine n'existe plus — ouvrez la conversation sur le corpus.");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { conversation_id: string };
        setDraft("");
        // la conversation existe : la suite vit sur son adresse (rechargeable, partageable)
        router.replace(`/conversation/${data.conversation_id}`);
        return;
      }
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (res.status === 409) {
        setError("La réponse précédente est encore en cours : attendez qu'elle arrive.");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setDraft("");
      setView(await load());
    } catch {
      setError("La question n'est pas partie (le serveur n'a pas répondu).");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      {view ? <AnchorBanner anchor={view.anchor} /> : <AnchorBanner anchor={initialAnchor} />}

      {view?.workspace_root ? <WorkspaceBanner root={view.workspace_root} /> : null}

      {!conversationId ? (
        <p className="text-sm text-muted-foreground">
          Posez une question : l&apos;agent lit le corpus (il cherche, élargit, puis
          répond) et rend des <strong>affirmations</strong>, chacune appuyée sur les
          extraits qu&apos;il cite. Une affirmation qu&apos;aucune preuve ne soutient est
          affichée comme <em>non sourcée</em> — elle ne compte pas comme un fait.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      {conversationId === null ? null : view === null ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : view.messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun message dans cette conversation.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {view.messages.map((message) => (
            <li key={message.id}>
              <MessageView message={message} />
            </li>
          ))}
        </ol>
      )}

      <Card>
        <CardContent className="flex flex-col gap-2 py-4">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="conversation-draft">
            {conversationId ? "Votre question" : "Première question"}
          </label>
          <textarea
            id="conversation-draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            rows={3}
            maxLength={2000}
            placeholder="Que disent ces documents sur… ?"
            className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-input/30 dark:disabled:bg-input/80"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              <CornerDownLeft className="inline size-3" /> Entrée envoie, Maj+Entrée va à la ligne.
              {working ? " Une réponse est en cours." : ""}
            </p>
            <Button disabled={busy || working || draft.trim().length < 2} onClick={() => void ask()}>
              {busy || working ? <Loader2 className="animate-spin" /> : <MessageSquare />}
              {working ? "Réponse en cours" : "Demander"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {conversationId === null && summaries ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Conversations récentes</h2>
          {summaries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune conversation pour l&apos;instant.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {summaries.map((s) => (
                <li key={s.id} className="text-sm">
                  <Link href={`/conversation/${s.id}`} className="underline-offset-4 hover:underline">
                    {s.title}
                  </Link>
                  <span className="pl-2 text-xs text-muted-foreground">
                    {s.anchor_kind === "synthesis" ? "depuis une synthèse" : "sur le corpus"} ·{" "}
                    {s.messages} message(s)
                    {s.pending ? " · réponse en attente" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Ce que l'agent a le droit de lire sur cette machine (AC3). L'écran **dit la racine, il ne
 * la choisit pas** : un sélecteur de dossier serait un écran de réglages, et la racine vit
 * dans `WORKSPACE_ROOT`. L'afficher est en revanche nécessaire — un agent qui lit des
 * fichiers locaux doit dire lesquels, sinon la lecture reste invisible.
 */
function WorkspaceBanner({ root }: { root: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <FolderOpen className="size-3.5 shrink-0" />
      <span>
        Lecture locale autorisée (lecture seule, confinée) : <code>{root}</code>. Toute
        affirmation qui cite un fichier est <strong>revérifiée à cet affichage</strong> — un
        fichier modifié depuis apparaît comme tel.
      </span>
    </p>
  );
}

/** D'où part la conversation — et ce que ça implique quand la synthèse a disparu. */
function AnchorBanner({ anchor }: { anchor: ConversationViewData["anchor"] }) {
  if (anchor.kind !== "synthesis") {
    return (
      <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Conversation ouverte sur <strong>l&apos;ensemble du corpus</strong> : l&apos;agent
        doit lire avant de répondre.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
      {anchor.label ? (
        <p>
          <span className="text-muted-foreground">Part de la synthèse :</span> « {anchor.label} »
        </p>
      ) : (
        <p className="flex items-start gap-1.5 text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            La synthèse d&apos;origine n&apos;existe plus : la conversation continue sur le
            corpus, sans elle.
          </span>
        </p>
      )}
      <p className="pt-1 text-muted-foreground">
        La synthèse est un point de départ, pas la question : l&apos;agent peut la nuancer ou la
        contredire.{" "}
        <Link href="/syntheses" className="underline-offset-4 hover:underline">
          Retour aux synthèses
        </Link>
      </p>
    </div>
  );
}

/** Un message : une question, une réponse (affirmation par affirmation), ou un échec dit. */
function MessageView({ message }: { message: ConversationMessageView }) {
  if (message.role === "user") {
    return (
      <Card className="bg-muted/40">
        <CardContent className="py-3">
          <p className="text-xs text-muted-foreground">Vous</p>
          <p className="text-sm whitespace-pre-wrap">{message.text}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">L&apos;agent</span>
          {message.status === "pending" ? (
            <Badge variant="secondary">
              <Loader2 className="animate-spin" />
              lecture du corpus
            </Badge>
          ) : null}
          {message.status === "done" && message.unsourced > 0 ? (
            <Badge variant="outline" title="Ces affirmations ne comptent pas comme des faits">
              {message.unsourced} affirmation(s) non sourcée(s)
            </Badge>
          ) : null}
          {message.unverified > 0 ? (
            <Badge variant="destructive">
              <AlertTriangle />
              {message.unverified} preuve(s) ne tiennent plus
            </Badge>
          ) : null}
        </p>

        {message.status === "pending" ? (
          <p role="status" className="text-sm text-muted-foreground">
            L&apos;agent explore le corpus : il cherche, élargit, puis répond en citant ses
            sources. Cela peut prendre une minute.
          </p>
        ) : null}

        {message.failure ? (
          <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-500">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {CONVERSATION_FAILURE_LABEL[message.failure] ?? `Tour interrompu (${message.failure}).`}
              {message.run?.steps.some((s) => s.refused) ? " Les refus sont dans le tour ci-dessous." : ""}
            </span>
          </p>
        ) : null}

        {message.claims.length > 0 ? <AnswerProse claims={message.claims} /> : null}

        {message.run ? <RunView run={message.run} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * La réponse **en continu**, et les sources **à la fin** — jamais au fil du texte.
 *
 * L'ancien rendu intercalait les cartes de provenance entre les phrases : la réponse se
 * lisait comme une liste annotée, pas comme un texte. Le style académique règle ça — un
 * renvoi numéroté par phrase, le bloc de sources dédupliqué et regroupé après le texte :
 * la lecture est continue, la traçabilité intacte.
 *
 * La déduplication est nécessaire parce que le serveur rattache **par phrase** : trois
 * phrases appuyées sur le même fragment répèteraient trois fois la même source. Chaque
 * source apparaît une fois, numérotée à la première occurrence ; un renvoi de phrase
 * pointe vers ces numéros. Une phrase sans provenance survivante reste signalée (✱/·) —
 * l'honnêteté de l'affichage n'est pas négociable, seule sa place change.
 */
function AnswerProse({ claims }: { claims: ConversationClaimView[] }) {
  const numbered: { claim: ConversationClaimView; marks: number[] }[] = [];
  const registry = new Map<string, number>();
  let next = 1;
  for (const claim of claims) {
    const marks: number[] = [];
    for (const p of claim.provenance) {
      const key = `${p.kind}-${p.index}`;
      let n = registry.get(key);
      if (n === undefined) {
        n = next++;
        registry.set(key, n);
      }
      marks.push(n);
    }
    numbered.push({ claim, marks });
  }
  const sources = [...registry.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([key, n]) => ({
      n,
      provenance: claims
        .flatMap((c) => c.provenance)
        .find((p) => `${p.kind}-${p.index}` === key) as ClaimProvenanceView,
    }));
  const hasOwnKnowledge = claims.some((c) => c.own_knowledge);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed whitespace-pre-wrap">
        {numbered.map(({ claim, marks }, i) => (
          <span key={i}>
            {" "}
            {claim.text}
            {marks.length > 0 ? (
              <sup className="ml-0.5 text-[0.65rem] font-medium text-primary">
                [{marks.join(",")}]
              </sup>
            ) : null}
            {claim.own_knowledge ? (
              <sup
                className="ml-0.5 text-[0.65rem] font-medium text-amber-600 dark:text-amber-500"
                title="Connaissance du modèle, hors corpus : à vérifier avant de la traiter comme un fait"
              >
                ✱
              </sup>
            ) : null}
            {claim.sourced || claim.own_knowledge ? null : (
              <sup
                className="ml-0.5 text-[0.65rem] font-medium text-muted-foreground"
                title="Aucune preuve survivante : à ne pas traiter comme un fait"
              >
                ·
              </sup>
            )}
          </span>
        ))}
      </p>
      {hasOwnKnowledge ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          ✱ passage marqué de la connaissance propre du modèle, hors corpus — à vérifier avant
          de le traiter comme un fait.
        </p>
      ) : null}
      {sources.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground">Sources</p>
          <ol className="flex flex-col gap-1.5">
            {sources.map(({ n, provenance }) => (
              <li key={n} className="flex gap-2">
                <span className="text-xs font-medium text-primary">[{n}]</span>
                <div className="min-w-0 flex-1">
                  <ProvenanceView provenance={provenance} />
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Une provenance, quelle que soit sa famille. Les deux ne se lisent pas de la même façon, et
 * c'est voulu : un fragment est une copie **revérifiée maintenant**, une page web est une
 * **copie datée** (l'AC7 interdit de la relire à l'affichage) — l'écran doit dire laquelle
 * des deux on regarde, sinon il promet une vérification qu'il n'a pas faite.
 */
function ProvenanceView({ provenance }: { provenance: ClaimProvenanceView }) {
  const problem = provenance.verified
    ? null
    : provenance.problem
      ? provenance.kind === "fragment"
        ? EVIDENCE_PROBLEM_LABEL[provenance.problem]
        : provenance.kind === "url"
          ? WEB_PROBLEM_LABEL[provenance.problem]
          : WORKSPACE_PROBLEM_LABEL[provenance.problem]
      : "non vérifiable";
  return (
    <li className="flex flex-col gap-0.5">
      <p className="text-xs text-muted-foreground">
        {provenance.kind === "fragment" ? (
          <>
            <Quote className="mr-1 inline size-3" />
            <span className="font-medium">[{provenance.index}]</span>{" "}
            {provenance.source_title ?? provenance.source_id} · {provenance.locator}
          </>
        ) : provenance.kind === "url" ? (
          <>
            <Globe className="mr-1 inline size-3" />
            <span className="font-medium">W{provenance.index}</span>{" "}
            <a
              href={provenance.url}
              target="_blank"
              rel="noreferrer noopener"
              className="underline-offset-4 hover:underline"
            >
              {provenance.title ?? provenance.url}
            </a>{" "}
            <span className="break-all">{provenance.url}</span> · copie lue le{" "}
            {provenance.retrieved_at.slice(0, 10)}
          </>
        ) : (
          <>
            <FileText className="mr-1 inline size-3" />
            <span className="font-medium">F{provenance.index}</span>{" "}
            <span className="font-mono">{provenance.path}</span> lignes {provenance.from_line}
            -{provenance.to_line} · lu le {provenance.read_at.slice(0, 10)}
          </>
        )}
        {problem ? (
          <span className="pl-1 font-medium text-destructive">
            — {problem}, cette copie n&apos;appuie plus rien
          </span>
        ) : null}
      </p>
      <p className="max-h-28 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground">
        {provenance.kind === "fragment" ? provenance.text : provenance.excerpt}
      </p>
      {provenance.kind === "file" ? (
        <p className="text-xs text-muted-foreground">
          Le fichier est relu <strong>maintenant</strong> : contrairement à une copie web, une
          citation `chemin:ligne` ne vieillit pas, elle cesse d&apos;être appuyée.
        </p>
      ) : null}
    </li>
  );
}

/** Ce que l'agent a fait dans ce tour — visible, y compris ce qui a été refusé. */
function RunView({ run }: { run: ConversationRunView }) {
  const webReason =
    WEB_UNLOCK_REASON_LABEL[run.web_unlock_reason ?? ""] ??
    (run.web_unlocked ? "outils web exposés" : "outils web non exposés");
  return (
    <details className="border-t border-border pt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        <Search className="mr-1 inline size-3" />
        Tour de l&apos;agent : {run.internal_steps}/{run.step_budget} étape(s) interne(s)
        {run.web_budget > 0 ? ` · ${run.web_steps}/${run.web_budget} web` : ""} · {run.llm_calls}{" "}
        appel(s) LLM
        {run.steps_from_cache > 0 ? ` (+${run.steps_from_cache} en cache)` : ""}
        {run.history_messages > 0 ? ` · ${run.history_messages} message(s) d'historique` : ""}
        {run.web_unlocked ? " · web autorisé" : ""}
      </summary>
      {run.anchor_missing ? (
        <p className="pt-2 text-amber-600 dark:text-amber-500">
          La synthèse ancrée n&apos;existait plus au moment du tour.
        </p>
      ) : null}
      <p className="pt-2 text-muted-foreground">
        Web : {webReason} (seuil : {run.web_unlock_min_evidence} fragment(s) utilisable(s)).
      </p>
      {run.workspace_reads.length > 0 ? (
        <div className="pt-2">
          <p className="text-muted-foreground">
            Fichiers du workspace ({run.workspace_reads.length})
            {run.workspace_root ? ` — racine : ${run.workspace_root}` : ""} :
          </p>
          <ul className="flex flex-col gap-0.5">
            {run.workspace_reads.map((r) => (
              <li key={r.index} className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">F{r.index}</span>
                <span className="font-mono">{r.path}</span>
                <span className="text-muted-foreground">
                  lignes {r.from_line}-{r.to_line}
                </span>
                {r.failure ? (
                  <Badge variant="destructive">{failureLabel(r.failure)}</Badge>
                ) : (
                  <Badge variant="secondary">lue le {r.read_at.slice(0, 10)}</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.web_results.length > 0 ? (
        <div className="pt-2">
          <p className="text-muted-foreground">
            Résultats web du tour ({run.web_results.length}) :
          </p>
          <ul className="flex flex-col gap-0.5">
            {run.web_results.map((r) => (
              <li key={r.index} className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">W{r.index}</span>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline-offset-4 hover:underline"
                >
                  {r.title ?? r.url}
                </a>
                <span className="break-all text-muted-foreground">{r.url}</span>
                {r.read ? (
                  <Badge variant="secondary">
                    lue le {(r.retrieved_at ?? "").slice(0, 10)}
                  </Badge>
                ) : r.failure ? (
                  <Badge variant="destructive">{failureLabel(r.failure)}</Badge>
                ) : (
                  <span className="text-muted-foreground">non lue</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.steps.length === 0 ? (
        <p className="pt-2 text-muted-foreground">Aucune étape exécutée.</p>
      ) : (
        <ol className="flex flex-col gap-1 pt-2">
          {run.steps.map((step) => (
            <li key={step.index} className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">Étape {step.index}</span>
              <Badge variant="outline">{CONVERSATION_ACTION_LABEL[step.action]}</Badge>
              {step.input.query ? <span>« {step.input.query} »</span> : null}
              {step.input.fragment !== undefined ? <span>[{step.input.fragment}]</span> : null}
              {step.input.result !== undefined ? <span>W{step.input.result}</span> : null}
              {step.input.path ? (
                <span className="font-mono">{step.input.path}</span>
              ) : null}
              {step.input.from !== undefined || step.input.to !== undefined ? (
                <span>
                  lignes {step.input.from ?? 1}-{step.input.to ?? "…"}
                </span>
              ) : null}
              {step.added.length > 0 ? <span>+{step.added.length} fragment(s)</span> : null}
              {step.web_added && step.web_added.length > 0 ? (
                <span>+{step.web_added.length} résultat(s) web</span>
              ) : null}
              {step.refused ? (
                <Badge variant="secondary">refusé · {ANSWER_REJECTION_LABEL[step.refused]}</Badge>
              ) : null}
              {step.failure ? (
                <Badge variant="destructive">{failureLabel(step.failure)}</Badge>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
