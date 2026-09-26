import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatSeconds } from "@/lib/audio/wav";
import { CATEGORIES, type CategoryId } from "@/lib/types";

export type SelectionMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Viewport point the menu should point at (bottom-centre of the selection). */
  anchor: { x: number; y: number } | null;
  duration: number;
  counts: Record<CategoryId, number>;
  onPreview: () => void;
  onSave: (category: CategoryId) => void;
  onDiscard: () => void;
};

export function SelectionMenu({
  open,
  onOpenChange,
  anchor,
  duration,
  counts,
  onPreview,
  onSave,
  onDiscard,
}: SelectionMenuProps) {
  if (!anchor) return null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      {/* Invisible anchor: Radix positions the menu against this point. */}
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed block size-px opacity-0"
          style={{ left: anchor.x, top: anchor.y }}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        className="min-w-[15rem] p-1.5"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-3">
          <span className="font-mono text-xs tabular-nums">{formatSeconds(duration, 3)}</span>
          <span className="text-xs font-normal text-muted-foreground">cut</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={onPreview}>Preview this cut</DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="font-semibold text-brand data-[state=open]:bg-brand data-[state=open]:text-brand-foreground">
            Save
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[17rem]">
            <DropdownMenuLabel>Save as</DropdownMenuLabel>
            {CATEGORIES.map((category, index) => (
              <div key={category.id}>
                {index === 2 || index === 4 || index === 6 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  onSelect={() => onSave(category.id)}
                  className="gap-3 py-2.5 pr-2.5 pl-2.5"
                >
                  <span className="flex-1 font-medium whitespace-nowrap">{category.label}</span>
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {category.hint}
                  </span>
                  <span className="w-9 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {counts[category.id] ? `+${counts[category.id] + 1}` : "+1"}
                  </span>
                </DropdownMenuItem>
              </div>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive" onSelect={onDiscard}>
          Discard selection
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SelectionHint() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
      <span>Drag across the waveform to select one click or release</span>
      <span>
        Hover <strong className="font-medium text-foreground">Save</strong> to file it
      </span>
      <span>Drag the edges to fine tune</span>
      <span>Suggested markers never move your cut</span>
      <span>Scroll to pan · ctrl + scroll to zoom</span>
    </div>
  );
}
