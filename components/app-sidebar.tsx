"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLinkStatus } from "next/link";
import {
  Compass,
  LayoutGrid,
  Library,
  MessageSquare,
  Moon,
  Puzzle,
  Sun,
} from "lucide-react";
import { canvasColorClass } from "@/lib/api-types";

/**
 * La sidebar **globale** — la colonne permanente de l'application.
 *
 * Avant : chaque écran avait sa coquille (la nav horizontale du layout, ou la
 * colonne privée de l'explorateur) et la page « Tableaux » servait de vestibule.
 * Désormais la navigation vit ici, sur toutes les pages, et l'écran Tableaux
 * n'est plus une page qu'on visite : c'est l'arrière-plan du bureau, atteint
 * par le premier lien.
 *
 * Le composant est un **client** (il lit `usePathname` pour l'état actif) mais
 * les données (épinglés, conversations récentes) viennent du snapshot de
 * l'explorateur : un seul fetch partagé, rechargé quand la route change — la
 * base reste la vérité, la sidebar ne garde rien.
 */

const NAV = [
  { href: "/", label: "Tableaux", icon: LayoutGrid },
  { href: "/sources", label: "Bibliothèque", icon: Library },
  { href: "/suggestions", label: "Connexions", icon: Compass },
  { href: "/syntheses", label: "Synthèses", icon: Puzzle },
  { href: "/conversation", label: "Conversation", icon: MessageSquare },
] as const;

interface PinnedCanvas {
  id: string;
  label: string;
  color: string | null;
  kind: string;
  totals: { constructions: number; sources: number };
}

interface RecentConversation {
  id: string;
  title: string;
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [pinned, setPinned] = useState<PinnedCanvas[]>([]);
  const [conversations, setConversations] = useState<RecentConversation[]>([]);

  /* Les raccourcis du bureau (polish desktop) : Alt+1..5 naviguent comme la nav —
     les ordres clavier sont la différence entre « un site qu'on clique » et « une
     app qu'on pilote ». Le combo Alt évite de voler les raccourcis de saisie. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const idx = Number(e.key) - 1;
      const target = NAV[idx];
      if (target) {
        e.preventDefault();
        router.push(target.href);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  useEffect(() => {
    let alive = true;
    fetch("/api/explorer", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (data: {
          canvases?: { id: string; label: string; color: string | null; kind: string; pinned: boolean; totals: { constructions: number; sources: number } }[];
        } | null) => {
          if (!alive || !data?.canvases) return;
          setPinned(
            data.canvases
              .filter((c) => c.pinned)
              .map((c) => ({
                id: c.id,
                label: c.label,
                color: c.color,
                kind: c.kind,
                totals: c.totals,
              }))
          );
          const convs = data.canvases.flatMap((c) =>
            (c as unknown as { conversations?: RecentConversation[] }).conversations ?? []
          );
          setConversations(convs.slice(0, 6));
        }
      )
      .catch(() => {
        // la sidebar ne tombe jamais : sans snapshot, les listes restent vides
      });
    return () => {
      alive = false;
    };
  }, [pathname]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4">
      <Link href="/" className="flex items-center gap-2 px-2 pb-4">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <SparkleMark />
        </span>
        <span className="text-sm font-semibold tracking-tight">Sérendipité</span>
      </Link>

      <nav className="space-y-0.5 text-sm" aria-label="Navigation principale">
        {NAV.map((item, idx) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              title={`${item.label} (Alt+${idx + 1})`}
              className={`group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors ${
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              }`}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              <kbd
                className={`hidden text-[10px] text-sidebar-foreground/40 group-hover:inline ${
                  active ? "inline" : ""
                }`}
              >
                ⌥{idx + 1}
              </kbd>
              <NavHint />
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 flex-1 overflow-y-auto">
        <p className="px-2 text-[11px] uppercase tracking-wider text-sidebar-foreground/50">
          Épinglés
        </p>
        <div className="mt-1 space-y-0.5">
          {pinned.map((c) => (
            <Link
              key={c.id}
              href={c.kind === "folder" ? "/" : `/canvas/${c.id}`}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              title={c.kind === "folder" ? "Ouvrir Tableaux (dossier épinglé)" : `Ouvrir « ${c.label} »`}
            >
              <span className={`size-2.5 shrink-0 rounded-sm ${canvasColorClass(c.color)}`} />
              <span className="truncate">{c.label}</span>
              <span className="ml-auto text-[11px] text-sidebar-foreground/50">
                {c.totals.constructions + c.totals.sources}
              </span>
            </Link>
          ))}
          {pinned.length === 0 && (
            <p className="px-2.5 text-xs leading-5 text-sidebar-foreground/40">
              Rien d&apos;épinglé — ★ sur une carte du bureau
            </p>
          )}
        </div>

        <p className="mt-5 px-2 text-[11px] uppercase tracking-wider text-sidebar-foreground/50">
          Conversations récentes
        </p>
        <div className="mt-1 space-y-0.5">
          {conversations.map((v) => (
            <Link
              key={v.id}
              href={`/conversation/${v.id}`}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate">{v.title}</span>
            </Link>
          ))}
          {conversations.length === 0 && (
            <p className="px-2.5 text-xs text-sidebar-foreground/40">Aucune conversation.</p>
          )}
        </div>
      </div>

      <ThemeToggle />
    </aside>
  );
}

/**
 * L'indicateur « cette navigation est en cours », posé sur le lien qu'on vient de
 * cliquer. `useLinkStatus` (depuis Next 15.3) ne rend `pending` que tant que la
 * route cible n'a pas été substituée — c'est le seul endroit où l'app peut dire
 * « j'ai bien reçu le clic » sans mentir sur ce qui est déjà affiché.
 *
 * Il est **réservé** dans le flux (largeur fixe, `visibility` plutôt que
 * `display`) et n'apparaît qu'après 100 ms : les navigations locale sont trop
 * rapides pour qu'un indicateur clignote, et un clignotement se lit comme un bug.
 * Le `role="status"` est voluntaryment absent — le squelette de `app/loading.tsx`
 * porte déjà l'information pour les lecteurs d'écran.
 */
function NavHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`size-1.5 shrink-0 rounded-full bg-sidebar-foreground/60 transition-opacity duration-150 ${
        pending ? "nav-hint-pending opacity-100" : "opacity-0"
      }`}
    />
  );
}

/**
 * La bascule de thème : sombre par défaut (choix du 2026-10-01), persistée en localStorage.
 * La source de vérité est la **classe DOM** posée avant l'hydratation par le script du
 * layout : l'état React la lit au montage, il ne la redécide pas — un flash de thème
 * clair au premier rendu serait exactement l'impression « site web » qu'on quitte.
 */
function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const apply = (prefers: boolean) => {
      setDark(prefers);
      document.documentElement.classList.toggle("dark", prefers);
    };
    apply(window.localStorage.getItem("theme") ? window.localStorage.getItem("theme") === "dark" : true);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    window.localStorage.setItem("theme", next ? "dark" : "light");
  };

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      title={dark ? "Passer en clair" : "Passer en sombre"}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      {dark ? "Clair" : "Sombre"}
    </button>
  );
}

/** Le piquet de la marque : une étincelle (sérendipité) dessinée, pas une émoji. */
function SparkleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
      <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2L12 2z" />
    </svg>
  );
}
