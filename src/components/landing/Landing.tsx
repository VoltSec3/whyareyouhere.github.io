import { AnimateIn } from "@/components/animate-in";
import { Button } from "@/components/ui/button";
import { CATEGORIES } from "@/lib/types";
import { ArrowUpRight, FileArchive, Layers, MousePointerClick, Scissors } from "lucide-react";

type LandingProps = {
  onEnter: () => void;
  savedCount: number;
  ready: boolean;
};

const STEPS = [
  {
    icon: MousePointerClick,
    title: "Record",
    body: "Every mouse press and release, every key down and key up is timestamped via an algorithm while your microphone listens.",
  },
  {
    icon: Scissors,
    title: "Cut",
    body: "Drag across the waveform to grab a single press or release. The transient is found and the tail trimmed clean.",
  },
  {
    icon: Layers,
    title: "Save",
    body: "Hover Save and pick micro, soft, standard or hard. Your clip is stored in the browser and ready to preview.",
  },
  {
    icon: FileArchive,
    title: "Export",
    body: "Add a title, a description and an optional noise bed, then download a ready-to-use clickpack for ZCB!",
  },
];

const FOLDER_TREE = [
  "noise.wav",
  "readme.txt",
  ...CATEGORIES.map((category) => `${category.id}/`),
];

export function Landing({ onEnter, savedCount, ready }: LandingProps) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 w-full border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <a href="#" className="text-base font-bold tracking-tight">
            CutIt<span className="italic text-brand">Quik</span>
          </a>
          <div className="flex items-center gap-6">
            <a
              href="#how"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              How it works
            </a>
            <a
              href="#packs"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              Packs
            </a>
            <Button size="sm" onClick={onEnter} disabled={!ready}>
              Enter the Editor
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto flex min-h-[75vh] max-w-5xl flex-col items-center justify-center px-6 py-24 text-center">
          <AnimateIn>
            <h1 className="max-w-3xl text-5xl font-bold tracking-tight sm:text-6xl">
              Cut clicks and releases
              <br />
              <span className="italic text-brand">right out of your mic</span>
            </h1>
          </AnimateIn>
          <AnimateIn delay={100}>
            <p className="mt-6 max-w-xl text-lg text-muted-foreground">
              Record your input, slice it into handpicked samples, and get a clickpack that
              drops straight into your clickpacks folder.
            </p>
          </AnimateIn>
          <AnimateIn delay={200}>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" onClick={onEnter} disabled={!ready}>
                Enter the Editor
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#how">See how it works</a>
              </Button>
            </div>
          </AnimateIn>
          {savedCount > 0 && (
            <AnimateIn delay={300}>
              <p className="mt-6 text-sm text-muted-foreground">
                {savedCount} saved {savedCount === 1 ? "clip" : "clips"} waiting in your browser.
              </p>
            </AnimateIn>
          )}
        </section>

        <section id="how" className="scroll-mt-14 border-t py-24">
          <div className="mx-auto max-w-5xl px-6">
            <AnimateIn>
              <div className="mb-14 text-center">
                <p className="mb-2 text-sm font-medium text-brand">Four steps</p>
                <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
              </div>
            </AnimateIn>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <AnimateIn key={step.title} delay={index * 100}>
                  <div className="h-full rounded-lg border bg-card p-6">
                    <step.icon className="mb-4 h-6 w-6 text-brand" />
                    <h3 className="mb-2 font-semibold">{step.title}</h3>
                    <p className="text-sm text-muted-foreground">{step.body}</p>
                  </div>
                </AnimateIn>
              ))}
            </div>
          </div>
        </section>

        <section id="packs" className="scroll-mt-14 border-t py-24">
          <div className="mx-auto max-w-5xl px-6">
            <AnimateIn>
              <div className="mb-14 text-center">
                <p className="mb-2 text-sm font-medium text-brand">Ready to use</p>
                <h2 className="text-3xl font-bold tracking-tight">Every pack, sorted for ZCB</h2>
                <p className="mx-auto mt-2 max-w-xl text-muted-foreground">
                  Clips are saved into a proper folder structure for ZCB detection.
                </p>
              </div>
            </AnimateIn>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {CATEGORIES.map((category, index) => (
                <AnimateIn key={category.id} delay={index * 60}>
                  <div className="rounded-lg border bg-card p-6">
                    <h3 className="font-semibold">{category.label}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{category.hint}</p>
                  </div>
                </AnimateIn>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t py-24">
          <div className="mx-auto max-w-5xl px-6">
            <AnimateIn>
              <div className="mb-14 text-center">
                <p className="mb-2 text-sm font-medium text-brand">One download</p>
                <h2 className="text-3xl font-bold tracking-tight">What you get</h2>
              </div>
            </AnimateIn>
            <AnimateIn>
              <div className="mx-auto max-w-2xl rounded-lg border bg-card p-6">
                <ul className="space-y-2 font-mono text-sm">
                  {FOLDER_TREE.map((entry) => (
                    <li key={entry} className="flex items-center gap-2">
                      <span className="text-brand">{entry.endsWith("/") ? "+" : "="}</span>
                      <span>{entry}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </AnimateIn>
          </div>
        </section>

        <section className="border-t py-24">
          <div className="mx-auto max-w-5xl px-6">
            <AnimateIn>
              <div className="rounded-lg bg-brand p-12 text-center text-brand-foreground">
                <h2 className="text-3xl font-bold tracking-tight">Start cutting</h2>
                <p className="mx-auto mt-2 max-w-md text-brand-foreground">
                  Everything runs in your browser. Nothing is uploaded, nothing is stored on a
                  server.
                </p>
                <Button size="lg" variant="secondary" className="mt-8" onClick={onEnter} disabled={!ready}>
                  Enter the Editor
                </Button>
              </div>
            </AnimateIn>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex min-h-14 max-w-5xl flex-col items-center justify-between gap-3 px-6 py-6 text-sm text-muted-foreground sm:flex-row">
          <span>&copy; {new Date().getFullYear()} CutItQuik</span>
          <div className="flex gap-4">
            <a href="#how" className="transition-colors hover:text-foreground">
              How it works
            </a>
            <a href="#packs" className="transition-colors hover:text-foreground">
              Packs
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
