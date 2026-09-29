import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { player } from "@/lib/audio/player";
import {
  MENU_CATEGORIES,
  MENU_PHASES,
  emptyMenuSoundCounts,
  type MenuCaptureEvent,
  type MenuSoundId,
  type MenuSoundCounts,
  type MenuSoundPhase,
  type StoredMenuSound,
  cutMenuStep,
  toStoredMenuSound,
} from "@/lib/menusounds";
import { menuSoundStore } from "@/lib/store";

const ORDER = new Map(MENU_CATEGORIES.map((category, index) => [category.id, index]));

function byCategoryThenTime(a: StoredMenuSound, b: StoredMenuSound) {
  return (
    (ORDER.get(a.category) ?? 0) - (ORDER.get(b.category) ?? 0) ||
    // Presses before releases of the same kind, so the library lists a gesture in
    // the order it happens rather than interleaving the two pools.
    MENU_PHASES.indexOf(a.phase) - MENU_PHASES.indexOf(b.phase) ||
    a.createdAt - b.createdAt
  );
}

export function useMenuSoundLibrary() {
  const [sounds, setSounds] = useState<StoredMenuSound[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    menuSoundStore
      .all()
      .then((stored) => {
        if (active) setSounds(stored.sort(byCategoryThenTime));
      })
      .catch(() => {
        if (active) toast.error("Could not read your menu sounds from this browser.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const counts = useMemo(() => {
    const map = emptyMenuSoundCounts();
    for (const sound of sounds) map[sound.category][sound.phase] += 1;
    return map;
  }, [sounds]);

  /**
   * Replaces one pool outright. A re-recorded step is not additive on purpose: a
   * person who records ten Escape presses again means to replace the ten they had,
   * and leaving the old ones behind would double the pool and halve the variety.
   *
   * One take normally contains both halves of a gesture, so this is called once per
   * phase and the two pools are replaced independently.
   */
  const replacePool = useCallback(
    async (
      category: MenuSoundId,
      cuts: ReturnType<typeof cutMenuStep>,
    ): Promise<{ press: number; release: number }> => {
      const definition = MENU_CATEGORIES.find((entry) => entry.id === category);
      if (!definition) return { press: 0, release: 0 };

      const banked: Partial<Record<MenuSoundPhase, StoredMenuSound[]>> = {};
      for (const phase of MENU_PHASES) {
        const phaseCuts = cuts.filter((entry) => entry.event.phase === phase);
        if (phaseCuts.length === 0) continue;
        banked[phase] = phaseCuts.map((entry, index) =>
          toStoredMenuSound(entry.cut, category, phase, index),
        );
      }

      const phases = Object.keys(banked) as MenuSoundPhase[];
      if (phases.length === 0) return { press: 0, release: 0 };

      setSounds((prev) =>
        [
          ...prev.filter(
            (sound) => sound.category !== category || !phases.includes(sound.phase),
          ),
          ...phases.flatMap((phase) => banked[phase]!),
        ].sort(byCategoryThenTime),
      );
      try {
        for (const phase of phases) {
          await menuSoundStore.replaceCategoryPhase(category, phase, banked[phase]!);
        }
      } catch {
        toast.error("Could not save those menu sounds", {
          description: "The browser storage rejected the write. Free up space and try again.",
        });
        return { press: 0, release: 0 };
      }
      return {
        press: banked.press?.length ?? 0,
        release: banked.release?.length ?? 0,
      };
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    setSounds((prev) => prev.filter((sound) => sound.id !== id));
    player.invalidate(id);
    try {
      await menuSoundStore.remove(id);
    } catch {
      toast.error("Could not delete that clip.");
    }
  }, []);

  const clearAll = useCallback(async () => {
    setSounds([]);
    try {
      await menuSoundStore.clear();
    } catch {
      toast.error("Could not clear the menu sounds.");
    }
  }, []);

  const preview = useCallback(async (sound: StoredMenuSound) => {
    try {
      await player.playWav(sound.wav, sound.id);
    } catch {
      toast.error("Could not play that clip.");
    }
  }, []);

  return {
    sounds,
    loading,
    counts,
    total: sounds.length,
    replacePool,
    remove,
    clearAll,
    preview,
  };
}

export type { MenuCaptureEvent, MenuSoundId, MenuSoundCounts, MenuSoundPhase, StoredMenuSound };
