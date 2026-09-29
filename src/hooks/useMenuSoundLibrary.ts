import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { player } from "@/lib/audio/player";
import {
  MENU_CATEGORIES,
  type MenuCaptureEvent,
  type MenuSoundId,
  type StoredMenuSound,
  cutMenuStep,
  toStoredMenuSound,
} from "@/lib/menusounds";
import { menuSoundStore } from "@/lib/store";

const ORDER = new Map(MENU_CATEGORIES.map((category, index) => [category.id, index]));

function byCategoryThenTime(a: StoredMenuSound, b: StoredMenuSound) {
  return (
    (ORDER.get(a.category) ?? 0) - (ORDER.get(b.category) ?? 0) || a.createdAt - b.createdAt
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
    const map = Object.fromEntries(MENU_CATEGORIES.map((c) => [c.id, 0])) as Record<
      MenuSoundId,
      number
    >;
    for (const sound of sounds) map[sound.category] += 1;
    return map;
  }, [sounds]);

  /**
   * Replaces one kind outright. A re-recorded step is not additive on purpose: a
   * person who records ten Escape presses again means to replace the ten they had,
   * and leaving the old ones behind would double the pool and halve the variety.
   */
  const replaceCategory = useCallback(
    async (category: MenuSoundId, cuts: ReturnType<typeof cutMenuStep>) => {
      const definition = MENU_CATEGORIES.find((entry) => entry.id === category);
      if (!definition) return 0;
      const next = cuts.map((entry, index) => toStoredMenuSound(entry.cut, category, index));
      setSounds((prev) =>
        [...prev.filter((sound) => sound.category !== category), ...next].sort(byCategoryThenTime),
      );
      try {
        await menuSoundStore.replaceCategory(category, next);
      } catch {
        toast.error("Could not save those menu sounds", {
          description: "The browser storage rejected the write. Free up space and try again.",
        });
        return 0;
      }
      return next.length;
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
    replaceCategory,
    remove,
    clearAll,
    preview,
  };
}

export type { MenuCaptureEvent, MenuSoundId, StoredMenuSound };
