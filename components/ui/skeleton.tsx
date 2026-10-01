import { cn } from "@/lib/utils";

/**
 * Le rectangle de chargement (primitive shadcn).
 *
 * Il ne « charge » rien : il **occupe la place** de ce qui arrive. C'est toute la
 * différence entre une app et une page web qui blanchit puis se remplit — le
 * contenu doit changer, la forme de l'écran doit rester stable.
 *
 * `animate-pulse` vient de `tw-animate-css`, importé en tête de `globals.css`.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  );
}

export { Skeleton };