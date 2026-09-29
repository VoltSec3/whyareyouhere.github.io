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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { player } from "@/lib/audio/player";
import { autocutTake, type AutoCutClip } from "@/lib/audio/autocut";
import type { DenoiseMethod } from "@/lib/audio/denoise";
import type { Take } from "@/hooks/useSessionRecorder";
import { formatSeconds } from "@/lib/audio/wav";
import { exportPack, packFileName, type ExportProgress, type ExportTarget } from "@/lib/exporter";
import {
  DEFAULT_ZCB_LAYOUT,
  validateZcbMenuSounds,
  validateZcbPack,
  ZCB_LAYOUTS,
  zcbLayout,
  zcbRootName,
  type ZcbLayoutId,
  type ZcbReport,
} from "@/lib/zcb";
import {
  MENU_CATEGORIES,
  emptyMenuSoundCounts,
  type StoredMenuSound,
} from "@/lib/menusounds";
import { metaStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CATEGORIES, type PackMeta, type StoredSound } from "@/lib/types";
import type { StoredNoise } from "@/lib/store";
import { AlertCircle, Check, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { NoiseRecorder } from "./NoiseRecorder";

type ExportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sounds: StoredSound[];
  counts: Record<string, number>;
  noise: StoredNoise | null;
  onNoiseChange: (noise: StoredNoise | null) => void;
  /**
   * Menu sounds, kept out of `sounds` and out of the slot tree. Optional: the
   * export handles an empty list, and ZCB shows the toggle greyed out when the
   * pack ends up with none.
   */
  menuSounds: StoredMenuSound[];
  /** The take on stage, so Autocut has something to cut when the library is empty. */
  take: Take | null;
  onAutocutSave: (clips: AutoCutClip[]) => Promise<boolean>;
};

const BLANK: PackMeta = { title: "", description: "", creator: "" };

type MethodOption = {
  id: DenoiseMethod;
  label: string;
  hint: string;
  needsNoise: boolean;
};

const METHODS: MethodOption[] = [
  {
    id: "live",
    label: "Live",
    hint: "Learns the noise floor from each clip's own quiet moments.",
    needsNoise: false,
  },
  {
    id: "spectral",
    label: "Spectral",
    hint: "Uses the recorded noise bed to target what the room is really doing.",
    needsNoise: true,
  },
];

const TARGETS: { id: ExportTarget; label: string; hint: string }[] = [
  {
    id: "zcb",
    label: "ZCB 3",
    hint: "For ZCB Live on Geode. Wraps the pack in its own folder and writes a slot per player.",
  },
  {
    id: "generic",
    label: "Generic",
    hint: "A flat folder tree that any clickpack loader can walk.",
  },
];

export function ExportDialog({
  open,
  onOpenChange,
  sounds,
  counts,
  noise,
  onNoiseChange,
  menuSounds,
  take,
  onAutocutSave,
}: ExportDialogProps) {
  const [meta, setMeta] = useState<PackMeta>(BLANK);
  const [busy, setBusy] = useState(false);
  const [touchedCreator, setTouchedCreator] = useState(false);
  const [denoise, setDenoise] = useState(false);
  const [method, setMethod] = useState<DenoiseMethod>("live");
  const [target, setTarget] = useState<ExportTarget>("zcb");
  const [layoutId, setLayoutId] = useState<ZcbLayoutId>(DEFAULT_ZCB_LAYOUT);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [autocutting, setAutocutting] = useState(false);
  const [autocutProgress, setAutocutProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

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

  const fileName = packFileName(effective, target);
  const layout = zcbLayout(layoutId);
  const root = zcbRootName(effective.title);
  const total = sounds.length;
  const titleInvalid = !meta.title.trim();
  const hasNoise = !!noise?.wav?.byteLength;
  const activeMethod = METHODS.find((option) => option.id === method) ?? METHODS[0]!;

  /**
   * ZCB's loader never rejects a pack for sounding wrong, it just works around
   * it, so the report is the only place these problems can surface.
   */
  const report: ZcbReport | null = useMemo(
    () => (target === "zcb" ? validateZcbPack(sounds) : null),
    [sounds, target],
  );

  /**
   * Menu sounds are reported separately and merged in, so one card can tell the
   * person that a gameplay tier is thin *and* that a menu folder is missing an
   * attack, without the two reports having to know about each other.
   */
  const menuReport: ZcbReport | null = useMemo(
    () => (target === "zcb" ? validateZcbMenuSounds(menuSounds) : null),
    [menuSounds, target],
  );

  const findings = useMemo(
    () => [...(report?.findings ?? []), ...(menuReport?.findings ?? [])],
    [report, menuReport],
  );
  const menuCount = menuSounds.length;
  const menuCounts = useMemo(() => {
    const map = emptyMenuSoundCounts();
    for (const sound of menuSounds) map[sound.category][sound.phase] += 1;
    return map;
  }, [menuSounds]);

  // Keep the choice valid: a noise bed can be cleared after spectral is picked.
  const effectiveMethod: DenoiseMethod = method === "spectral" && !hasNoise ? "live" : method;

  // Autocut is only worth offering when there is nothing to export and a take
  // still on stage to cut.
  const canAutocut = total === 0 && !!take && take.events.length > 0;

  const handleAutocut = async () => {
    if (!take) return;
    setAutocutting(true);
    setAutocutProgress({ done: 0, total: take.events.length });
    try {
      const clips = await autocutTake(take.samples, take.sampleRate, take.events, {
        onProgress: (done, all) => setAutocutProgress({ done, total: all }),
      });
      if (clips.length === 0) {
        toast.error("Autocut found no real clicks", {
          description: "Nothing in this take was loud enough to be a performance.",
        });
        return;
      }
      const saved = await onAutocutSave(clips);
      if (saved) {
        const byCategory = clips.reduce<Record<string, number>>((acc, clip) => {
          acc[clip.intensity] = (acc[clip.intensity] ?? 0) + 1;
          return acc;
        }, {});
        const summary = (["micro", "soft", "medium", "hard"] as const)
          .filter((intensity) => byCategory[intensity])
          .map((intensity) => `${byCategory[intensity]} ${intensity}`)
          .join(", ");
        toast.success(`Autocut saved ${clips.length} clip${clips.length === 1 ? "" : "s"}`, {
          description: summary,
        });
      }
    } catch {
      toast.error("Autocut could not finish", {
        description: "The take could not be cut. Try recording it again.",
      });
    } finally {
      setAutocutting(false);
      setAutocutProgress(null);
    }
  };

  const handleExport = async () => {
    if (titleInvalid) {
      toast.error("Give the clickpack a title first");
      return;
    }
    if (total === 0 && menuCount === 0) {
      toast.error("Nothing to export", {
        description: "Save at least one clip, or record some menu sounds, first.",
      });
      return;
    }

    setBusy(true);
    setProgress({ value: 0, step: "Preparing", detail: "reading the library" });
    try {
      await metaStore.set<PackMeta>("pack", { ...effective, creator: meta.creator.trim() });
      const result = await exportPack(
        {
          meta: effective,
          sounds,
          menuSounds,
          noise: noise ? { wav: noise.wav, duration: noise.duration } : null,
          denoise: denoise ? { method: effectiveMethod } : null,
          target,
          zcbLayout: layoutId,
        },
        { onProgress: setProgress },
      );
      toast.success("Clickpack exported", {
        description:
          target === "zcb"
            ? `${result.fileName} · unzip into .zcb/clickpacks`
            : `${result.fileName} · ${(result.size / 1024).toFixed(0)} KB`,
      });
      onOpenChange(false);
    } catch (error) {
      toast.error("Export failed", {
        description: error instanceof Error ? error.message : "Something went wrong building the zip.",
      });
    } finally {
      setBusy(false);
      setProgress(null);
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
            {canAutocut && (
              <div className="rounded-md border border-border bg-accent/40 p-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Nothing saved yet</p>
                    <p className="text-xs text-muted-foreground">
                      Autocut cuts a clip around every press and release in your last take
                      ({take?.events.length ?? 0} found) and files each one under micro, soft,
                      medium or hard by how loud it was.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={autocutting || busy}
                    onClick={() => void handleAutocut()}
                  >
                    {autocutting ? "Cutting…" : "Autocut"}
                  </Button>
                </div>
                {autocutting && autocutProgress && (
                  <div className="mt-3 space-y-1.5">
                    <Progress
                      value={(autocutProgress.done / Math.max(1, autocutProgress.total)) * 100}
                      aria-label="Autocutting"
                      aria-valuetext={`${autocutProgress.done} of ${autocutProgress.total}`}
                    />
                    <p className="text-xs text-muted-foreground">
                      Autocutting · {autocutProgress.done} of {autocutProgress.total} events
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="pack-title">
                Clickpack Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pack-title"
                value={meta.title}
                autoFocus
                placeholder="Sayo's Soft Desk Pack"
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
                placeholder="Recorded on a wooden desk in a quiet room. Every clip is trimmed by hand and exported at 48 kHz."
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
                placeholder="sdsa"
                onChange={(event) => {
                  setTouchedCreator(true);
                  setMeta((prev) => ({ ...prev, creator: event.target.value }));
                }}
              />
              <p className="text-xs text-muted-foreground">
                Saved as <span className="text-foreground">{fileName}</span>
              </p>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium">Export for</p>
              <div role="radiogroup" aria-label="Export target" className="grid gap-2 sm:grid-cols-2">
                {TARGETS.map((option) => {
                  const active = target === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={busy}
                      onClick={() => setTarget(option.id)}
                      className={cn(
                        "rounded-md border px-3 py-2.5 text-left transition-colors",
                        "outline-none focus-visible:ring-ring/40 focus-visible:ring-[3px]",
                        "disabled:pointer-events-none disabled:opacity-50",
                        active
                          ? "border-primary bg-accent"
                          : "border-border bg-background hover:bg-accent/50",
                      )}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">{option.label}</span>
                        {active && <Check className="size-3.5 shrink-0" aria-hidden />}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {option.hint}
                      </span>
                    </button>
                  );
                })}
              </div>

              {target === "zcb" && (
                <div className="space-y-2">
                  <Label htmlFor="zcb-layout">Slots</Label>
                  <select
                    id="zcb-layout"
                    value={layoutId}
                    disabled={busy}
                    onChange={(event) => setLayoutId(event.target.value as ZcbLayoutId)}
                    className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/40 h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
                  >
                    {ZCB_LAYOUTS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} · {option.slots.length} slot
                        {option.slots.length === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">{layout.hint}</p>
                </div>
              )}
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="denoise-switch" className="cursor-pointer">
                    Denoise background
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Runs a spectral gate over every clip as it is written to the zip. Transient
                    protection keeps the click itself intact.
                  </p>
                </div>
                <Switch
                  id="denoise-switch"
                  checked={denoise}
                  onCheckedChange={setDenoise}
                  disabled={busy}
                />
              </div>

              {denoise && (
                <div
                  role="radiogroup"
                  aria-label="Denoise method"
                  className="space-y-2 border-l border-border pl-3"
                >
                  {METHODS.map((option) => {
                    const active = effectiveMethod === option.id;
                    const unavailable = option.needsNoise && !hasNoise;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={busy || unavailable}
                        onClick={() => setMethod(option.id)}
                        className={cn(
                          "w-full rounded-md border px-3 py-2.5 text-left transition-colors",
                          "outline-none focus-visible:ring-ring/40 focus-visible:ring-[3px]",
                          "disabled:pointer-events-none disabled:opacity-50",
                          active
                            ? "border-primary bg-accent"
                            : "border-border bg-background hover:bg-accent/50",
                        )}
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium">{option.label}</span>
                          {active && <Check className="size-3.5 shrink-0" aria-hidden />}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {unavailable
                            ? "Needs a noise bed - record or attach one below."
                            : option.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator />

            <NoiseRecorder noise={noise} onChange={onNoiseChange} />

            <div className="space-y-3">
              <p className="text-sm font-medium">What goes in the zip</p>
              <div className="rounded-lg border border-border bg-background p-3 font-mono text-xs">
                {target === "zcb" && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-foreground">{root}/</span>
                    <span className="truncate text-muted-foreground">
                      {layout.slots.join(" ")}
                    </span>
                  </div>
                )}
                <div
                  className={`flex items-center justify-between gap-3 ${target === "zcb" ? "mt-1" : ""}`}
                >
                  <span className="text-foreground">
                    {target === "zcb" ? `${root}/readme.txt` : "readme.txt"}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {effective.title}
                    {effective.description ? " + description" : ""}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className={noise ? "text-foreground" : "text-muted-foreground"}>
                    {target === "zcb" ? `${root}/noise.wav` : "noise.wav"}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {noise ? formatSeconds(noise.duration, 2) : "not included"}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className={denoise ? "text-foreground" : "text-muted-foreground"}>
                    Denoise
                  </span>
                  <span className="truncate text-muted-foreground">
                    {denoise ? activeMethod.label : "off"}
                  </span>
                </div>
                {/*
                  Menu sounds sit outside the slot tree and are listed separately,
                  because they are not copied per slot: one Escape sound serves
                  every player at the same keyboard. Showing them multiplied by
                  the slot count would be wrong, so the tree shows the single copy
                  that is actually written.
                */}
                {menuCount > 0 && (
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className="text-foreground">
                      {target === "zcb" ? `${root}/menusounds/` : "menusounds/"}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {menuCount} clip{menuCount === 1 ? "" : "s"} · not per slot
                    </span>
                  </div>
                )}
                <Separator className="my-2" />
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  {CATEGORIES.map((category) => (
                    <div key={category.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground">{category.id}</span>
                      <span className="text-foreground tabular-nums">
                        {target === "zcb" && layout.slots.length > 1
                          ? (counts[category.id] ?? 0) * layout.slots.length
                          : (counts[category.id] ?? 0)}
                      </span>
                    </div>
                  ))}
                </div>
                {menuCount > 0 && (
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-2 sm:grid-cols-4">
                    {/* One row per folder actually written, not per kind, because a
                        release pool is its own folder in the archive. */}
                    {MENU_CATEGORIES.flatMap((category) => {
                      const pools = menuCounts[category.id];
                      const rows = [{ folder: category.folder, count: pools.press }];
                      if (category.release) {
                        rows.push({ folder: category.release.folder, count: pools.release });
                      }
                      return rows
                        .filter((row) => row.count > 0)
                        .map((row) => (
                          <div key={row.folder} className="flex items-center justify-between gap-2">
                            <span className="truncate text-muted-foreground">{row.folder}</span>
                            <span className="text-foreground tabular-nums">{row.count}</span>
                          </div>
                        ));
                    })}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>
                  {total} clip{total === 1 ? "" : "s"}
                </span>
                <span>48 kHz · 16-bit · mono</span>
                {target === "zcb" && layout.slots.length > 1 && (
                  <span>× {layout.slots.length} slots = {total * layout.slots.length} files</span>
                )}
                {total === 0 && (
                  <span className="text-destructive">Save at least one clip before exporting.</span>
                )}
              </div>
              {menuCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  Menu sounds are written once to{" "}
                  <span className="font-mono text-foreground">
                    {target === "zcb" ? `${root}/menusounds/` : "menusounds/"}
                  </span>
                  , not once per slot, and are left un-denoised so the recorder&apos;s cuts survive
                  intact.
                </p>
              )}
            </div>

            {report && (total > 0 || menuCount > 0) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">ZCB readiness</p>
                  {findings.length === 0 ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Check className="size-3.5" aria-hidden />
                      Nothing to flag
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {findings.filter((f) => f.severity === "error").length > 0 &&
                        `${findings.filter((f) => f.severity === "error").length} blocking`}
                      {findings.filter((f) => f.severity === "error").length > 0 &&
                        findings.filter((f) => f.severity === "warning").length > 0 &&
                        " · "}
                      {findings.filter((f) => f.severity === "warning").length > 0 &&
                        `${findings.filter((f) => f.severity === "warning").length} to look at`}
                    </span>
                  )}
                </div>

                {findings.length > 0 && (
                  <ul className="space-y-2">
                    {findings.map((finding) => (
                      <li
                        key={finding.id}
                        className={cn(
                          "rounded-md border px-3 py-2 text-xs",
                          finding.severity === "error"
                            ? "border-destructive/40 bg-destructive/5"
                            : "border-border bg-accent/30",
                        )}
                      >
                        <span className="flex items-start gap-2">
                          {finding.severity === "error" ? (
                            <AlertCircle className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
                          ) : (
                            <TriangleAlert
                              className="mt-px size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                          )}
                          <span className="space-y-0.5">
                            <span className="block font-medium text-foreground">{finding.title}</span>
                            <span className="block text-muted-foreground">{finding.detail}</span>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {target === "zcb" && (
                  <p className="text-xs text-muted-foreground">
                    Unzip, then move <span className="font-mono text-foreground">{root}/</span>{" "}
                    into <span className="font-mono text-foreground">.zcb/clickpacks/</span> next
                    to your Geometry Dash executable.
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="space-y-3 border-t border-border px-6 py-4">
            {busy && progress && (
              <div className="space-y-1.5 px-0.5 text-left">
                <Progress
                  value={progress.value * 100}
                  aria-label={progress.step}
                  aria-valuetext={progress.detail}
                />
                <p className="text-xs text-muted-foreground">
                  {progress.step} · {progress.detail}
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={handleExport}
                disabled={busy || titleInvalid || (total === 0 && menuCount === 0)}
              >
                {busy ? "Exporting…" : "Export .zip"}
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
