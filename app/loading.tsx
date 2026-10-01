import { Skeleton } from "@/components/ui/skeleton";

/**
 * L'état de chargement **de route**.
 *
 * Avant : une navigation vers une page nouvelle vidait la colonne de droite puis la
 * repeuplait — le comportement d'un lien web. `loading.tsx` encadre `page.tsx` dans
 * une frontière Suspense : pendant que la page est en vol, l'écran garde sa forme.
 *
 * Il n'y a qu'un seul fichier, à la racine de `app/` : il vaut pour toutes les routes
 * et il est volontairement dans la **géométrie de `PageShell`** (même largeur, mêmes
 * marges, même place pour l'icône et le titre). Un squelette de forme différente de la
 * page réelle produirait exactement le saut qu'on voulait supprimer — c'est la
 * géométrie, pas la quantité de gris, qui fait la continuité.
 *
 * La sidebar vit dans `layout.tsx` : elle reste donc affichée et cliquable pendant le
 * chargement, comme dans une vraie app.
 */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-8 py-8" aria-busy="true">
      {/* L'en-tête, aux dimensions exactes de `PageShell` : icône de 40px, titre sur
          une ligne de 28px, sous-titre sur deux lignes de 24px. */}
      <header className="mb-8 flex items-start gap-4">
        <Skeleton className="size-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="mt-2 h-4 w-full max-w-xl" />
          <Skeleton className="mt-2 h-4 w-2/3 max-w-md" />
        </div>
      </header>

      {/* Des blocs de hauteurs inégales : une pile de hauteurs toutes identiques
          trahit le squelette plus sûrement qu'un simple « ça charge ». */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-4/5 rounded-xl" />
      </div>
    </main>
  );
}