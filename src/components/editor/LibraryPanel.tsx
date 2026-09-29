import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatSeconds } from "@/lib/audio/wav";
import { MENU_CATEGORIES, type MenuSoundCounts } from "@/lib/menusounds";
import { CATEGORIES, type CategoryId, type StoredSound } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronRight, Inbox, Keyboard, TrashIcon } from "lucide-react";

type LibraryPanelProps = {
  sounds: StoredSound[];
  loading: boolean;
  activeId: string | null;
  onPreview: (sound: StoredSound) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  /**
   * Menu sounds are a separate library, so the panel is a summary with a button
   * rather than another set of rows. They are recorded through a guided dialog
   * rather than by dragging over a take, and they are filed by kind rather than
   * by loudness, so folding them into `CATEGORIES` would be a lie about both.
   */
  menuCount: number;
  menuCounts: MenuSoundCounts;
  onRecordMenu: () => void;
};

export function LibraryPanel({
  sounds,
  loading,
  activeId,
  onPreview,
  onRemove,
  onClearAll,
  menuCount,
  menuCounts,
  onRecordMenu,
}: LibraryPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<CategoryId>>(() => new Set());
  const total = sounds.length;

  const toggle = (id: CategoryId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <aside className="flex h-full min-h-0 w-[21rem] shrink-0 flex-col border-l border-border bg-card xl:w-[23rem]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-semibold tracking-tight">Library</p>
          <p className="text-xs text-muted-foreground">
            {loading ? "Loading…" : `${total} clip${total === 1 ? "" : "s"} saved`}
          </p>
        </div>
        {total > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClearAll}
                aria-label="Clear library"
              >
                <TrashIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear every saved clip</TooltipContent>
          </Tooltip>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2.5">
          {loading ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-9 animate-pulse rounded-lg bg-accent" />
              ))}
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
              <div className="grid size-11 place-items-center rounded-lg bg-accent text-muted-foreground">
                <Inbox className="size-5" />
              </div>
              <p className="text-sm font-medium">Nothing saved yet</p>
              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                Record a take, drag over a click and hover{" "}
                <span className="text-foreground">Save</span> to file it here.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {CATEGORIES.map((category) => {
                const bucket = sounds.filter((sound) => sound.category === category.id);
                const isOpen = !collapsed.has(category.id);
                return (
                  <div key={category.id}>
                    <button
                      type="button"
                      onClick={() => toggle(category.id)}
                      className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-90",
                        )}
                      />
                      <span className="flex-1 truncate text-sm font-medium">
                        {category.label}
                      </span>
                      <span
                        className={cn(
                          "min-w-6 text-right text-xs tabular-nums",
                          bucket.length ? "text-muted-foreground" : "text-muted-foreground/60",
                        )}
                      >
                        {bucket.length}
                      </span>
                    </button>

                    {isOpen && bucket.length > 0 && (
                      <div className="mt-1 mb-2 grid grid-cols-2 gap-1.5 pl-6 pr-1">
                        {bucket.map((sound, index) => (
                          <ClipChip
                            key={sound.id}
                            sound={sound}
                            index={index + 1}
                            active={activeId === sound.id}
                            onPreview={() => onPreview(sound)}
                            onRemove={() => onRemove(sound.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="space-y-2 border-t border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Keyboard className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              Menu sounds
            </p>
            <p className="text-xs text-muted-foreground">
              {menuCount === 0 ? (
                "Optional. Escape, menu clicks and typing."
              ) : (
                MENU_CATEGORIES.filter(
                  (c) => (menuCounts[c.id]?.press ?? 0) + (menuCounts[c.id]?.release ?? 0) > 0,
                )
                  .map((c) => {
                    const pools = menuCounts[c.id];
                    // Releases are a separate pool, so a kind with both reads as
                    // "25 +20 rel" rather than as one inflated number.
                    return (
                      `${c.label} ${pools.press}` +
                      (pools.release > 0 ? ` +${pools.release} rel` : "")
                    );
                  })
                  .join(" · ")
              )}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onRecordMenu} className="shrink-0">
            {menuCount === 0 ? "Record" : "Edit"}
          </Button>
        </div>
        <p className="font-mono text-[0.65rem] leading-relaxed text-muted-foreground">
          {CATEGORIES.length} folders · clips export as 1.wav, 2.wav, 3.wav …
        </p>
      </div>
    </aside>
  );
}

function ClipChip({
  sound,
  index,
  active,
  onPreview,
  onRemove,
}: {
  sound: StoredSound;
  index: number;
  active: boolean;
  onPreview: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 transition-colors",
        active
          ? "border-brand bg-brand text-brand-foreground"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <button
        type="button"
        onClick={onPreview}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="min-w-0">
          <span className="block text-xs leading-tight font-medium">
            {index}.wav
          </span>
          <span className="block text-[0.65rem] leading-tight text-muted-foreground">
            {formatSeconds(sound.duration, 2)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Delete ${index}.wav`}
        className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-background text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
