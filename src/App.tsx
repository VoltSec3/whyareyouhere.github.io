import { Toaster } from "sonner";

import { Editor } from "@/components/editor/Editor";
import { Landing } from "@/components/landing/Landing";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useClickLibrary } from "@/hooks/useClickLibrary";
import { useView } from "@/hooks/useView";

export default function App() {
  const { view, navigate } = useView();
  const library = useClickLibrary();

  return (
    <TooltipProvider>
      {view === "editor" ? (
        <Editor onExit={() => navigate("landing")} />
      ) : (
        <Landing
          onEnter={() => navigate("editor")}
          savedCount={library.total}
          ready={!library.loading}
        />
      )}

      <Toaster
        theme="dark"
        position="bottom-right"
        closeButton
        toastOptions={{
          classNames: {
            toast:
              "group rounded-xl border border bg-popover text-popover-foreground",
            description: "text-muted-foreground",
            actionButton: "bg-primary text-primary-foreground",
          },
        }}
      />
    </TooltipProvider>
  );
}
