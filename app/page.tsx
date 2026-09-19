import { CanvasWorkspace } from "@/components/canvas/canvas-workspace";

/**
 * Le plan de travail — page principale.
 *
 * Le produit se présente comme un espace où l'on **dépose ses documents** : le
 * canvas est l'écran d'entrée, pas une vue annexe. Les fichiers y prennent place,
 * l'analyse cherche leurs liens en tâche de fond, et les énoncés acceptés y restent
 * sous forme de Constructions.
 *
 * L'application web ne calcule rien ici : les positions vivent en base
 * (`canvas_items`, `canvas_frames`) et sont relues après chaque geste.
 */
export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-[1800px] flex-1 px-6 py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Plan de travail</h1>
        <p className="text-sm text-muted-foreground">
          Déposez des fichiers : ils se posent là où vous les lâchez, et l&apos;analyse cherche
          ensuite ce qui les relie. Les liens s&apos;affichent sur le plan et dans le panneau ; un
          lien intégré devient une construction, que vous pouvez déplacer et ranger comme le reste.
        </p>
      </header>
      <CanvasWorkspace />
    </main>
  );
}
