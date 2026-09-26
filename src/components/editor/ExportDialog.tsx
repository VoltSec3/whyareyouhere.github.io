import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { player } from "@/lib/audio/player";
import { formatSeconds } from "@/lib/audio/wav";
import { exportPack, packFileName } from "@/lib/exporter";
import { metaStore } from "@/lib/store";
import { CATEGORIES, type PackMeta, type StoredSound } from "@/lib/types";
import type { StoredNoise } from "@/lib/store";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

import { NoiseRecorder } from "./NoiseRecorder";

type ExportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sounds: StoredSound[];
  counts: Record<string, number>;
  noise: StoredNoise | null;
  onNoiseChange: (noise: StoredNoise | null) => void;
};

const BLANK: PackMeta = { title: "", description: "", creator: "" };

export function ExportDialog({
  open,
  onOpenChange,
  sounds,
  counts,
  noise,
  onNoiseChange,
}: ExportDialogProps) {
  const [meta, setMeta] = useState<PackMeta>(BLANK);
  const [busy, setBusy] = useState(false);
  const [touchedCreator, setTouchedCreator] = useState(false);

  useEffect(() => {
    if (!open) return;
    player.stop();
    let active = true;
    metaStore
      .get<PackMeta>("pack")
      .then((saved) => {
        if (active && saved) {
          setMeta({ ...BLANK, ...saved });
          setTouchedCreator(!!saved.creator);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open]);

  const effective = useMemo<PackMeta>(
    () => ({
      title: meta.title.trim() || "Untitled Clickpack",
      description: meta.description.trim(),
      creator: (meta.creator.trim() || meta.title.trim() || "untitled").trim(),
    }),
    [meta],
  );

  const fileName = packFileName(effective);
  const total = sounds.length;
  const titleInvalid = !meta.title.trim();

  const handleExport = async () => {
    if (titleInvalid) {
      toast.error("Give the clickpack a title first");
      return;
    }
    if (total === 0) {
      toast.error("Nothing to export", {
        description: "Save at least one click or release to the library first.",
      });
      return;
    }

    setBusy(true);
    try {
      await metaStore.set<PackMeta>("pack", { ...effective, creator: meta.creator.trim() });
      const result = await exportPack({
        meta: effective,
        sounds,
        noise: noise ? { wav: noise.wav, duration: noise.duration } : null,
      });
      toast.success("Clickpack exported", {
        description: `${result.fileName} · ${(result.size / 1024).toFixed(0)} KB`,
      });
      onOpenChange(false);
    } catch (error) {
      toast.error("Export failed", {
        description: error instanceof Error ? error.message : "Something went wrong building the zip.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="max-h-[92vh] overflow-y-auto">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle>Export clickpack</DialogTitle>
            <DialogDescription>
              Name the pack, describe it, optionally attach a noise bed, and download a zip that is
              already laid out the way clickpack loaders expect.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="pack-title">
                Clickpack Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pack-title"
                value={meta.title}
                autoFocus
                placeholder="Sawyer's Soft Desk Pack"
                aria-invalid={titleInvalid}
                onChange={(event) => setMeta((prev) => ({ ...prev, title: event.target.value }))}
              />
              {titleInvalid && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AlertCircle className="size-3" />
                  This becomes the first line of readme.txt.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="pack-description">Clickpack Description</Label>
              <textarea
                id="pack-description"
                value={meta.description}
                rows={4}
                placeholder="Recorded on a wooden desk in a quiet room. Every click is trimmed and normalised to 48 kHz."
                onChange={(event) =>
                  setMeta((prev) => ({ ...prev, description: event.target.value }))
                }
                className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/40 w-full resize-y rounded-md border px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                Written underneath the title inside readme.txt.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pack-creator">Creator (optional)</Label>
              <Input
                id="pack-creator"
                value={touchedCreator ? meta.creator : effective.creator}
                placeholder="SawyerSayo"
                onChange={(event) => {
                  setTouchedCreator(true);
                  setMeta((prev) => ({ ...prev, creator: event.target.value }));
                }}
              />
              <p className="text-xs text-muted-foreground">
                Saved as <span className="text-foreground">{fileName}</span>
              </p>
            </div>

            <Separator />

            <NoiseRecorder noise={noise} onChange={onNoiseChange} />

            <div className="space-y-3">
              <p className="text-sm font-medium">What goes in the zip</p>
              <div className="rounded-lg border border-border bg-background p-3 font-mono text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-foreground">readme.txt</span>
                  <span className="truncate text-muted-foreground">
                    {effective.title}
                    {effective.description ? " + description" : ""}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className={noise ? "text-foreground" : "text-muted-foreground"}>
                    noise.wav
                  </span>
                  <span className="truncate text-muted-foreground">
                    {noise ? formatSeconds(noise.duration, 2) : "not included"}
                  </span>
                </div>
                <Separator className="my-2" />
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  {CATEGORIES.map((category) => (
                    <div key={category.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground">{category.id}</span>
                      <span className="text-foreground tabular-nums">
                        {counts[category.id] ?? 0}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>
                  {total} clip{total === 1 ? "" : "s"}
                </span>
                <span>48 kHz · 16-bit · mono</span>
                {total === 0 && (
                  <span className="text-destructive">Save at least one clip before exporting.</span>
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleExport} disabled={busy || titleInvalid || total === 0}>
              {busy ? "Building zip…" : "Export .zip"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
