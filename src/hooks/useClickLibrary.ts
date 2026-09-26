import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { player } from "@/lib/audio/player";
import { metaStore, soundStore, type StoredNoise } from "@/lib/store";
import { CATEGORIES, CATEGORY_MAP, type CategoryId, type StoredSound } from "@/lib/types";

const ORDER = new Map(CATEGORIES.map((category, index) => [category.id, index]));

function byCategoryThenTime(a: StoredSound, b: StoredSound) {
  return (
    (ORDER.get(a.category) ?? 0) - (ORDER.get(b.category) ?? 0) || a.createdAt - b.createdAt
  );
}

export function useClickLibrary() {
  const [sounds, setSounds] = useState<StoredSound[]>([]);
  const [loading, setLoading] = useState(true);
  const [noise, setNoise] = useState<StoredNoise | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([soundStore.all(), metaStore.getNoise()])
      .then(([stored, storedNoise]) => {
        if (!active) return;
        setSounds(stored.sort(byCategoryThenTime));
        setNoise(storedNoise);
      })
      .catch(() => {
        if (active) toast.error("Could not read your saved clips from this browser.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const add = useCallback(async (sound: StoredSound) => {
    try {
      await soundStore.put(sound);
    } catch {
      toast.error("Could not save that clip", {
        description: "The browser storage rejected the write. Free up space and try again.",
      });
      return false;
    }
    setSounds((prev) => [...prev, sound].sort(byCategoryThenTime));
    return true;
  }, []);

  const remove = useCallback(async (id: string) => {
    setSounds((prev) => prev.filter((sound) => sound.id !== id));
    player.invalidate(id);
    try {
      await soundStore.remove(id);
    } catch {
      toast.error("Could not delete that clip.");
    }
  }, []);

  const clearAll = useCallback(async () => {
    setSounds([]);
    try {
      await soundStore.clear();
      toast.success("Library cleared");
    } catch {
      toast.error("Could not clear the library.");
    }
  }, []);

  const setNoiseBed = useCallback(async (value: StoredNoise | null) => {
    setNoise(value);
    try {
      if (value) await metaStore.setNoise(value);
      else await metaStore.clearNoise();
    } catch {
      toast.error("Could not store the noise bed.");
    }
  }, []);

  const counts = useMemo(() => {
    const map = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0])) as Record<CategoryId, number>;
    for (const sound of sounds) map[sound.category] += 1;
    return map;
  }, [sounds]);

  /** Next 1-based file number for a category, so previews match the export. */
  const nextIndex = useCallback(
    (category: CategoryId) => sounds.filter((sound) => sound.category === category).length + 1,
    [sounds],
  );

  const preview = useCallback(async (sound: StoredSound) => {
    try {
      await player.playWav(sound.wav, sound.id);
    } catch {
      toast.error("Could not play that clip.");
    }
  }, []);

  return {
    sounds,
    loading,
    noise,
    counts,
    total: sounds.length,
    add,
    remove,
    clearAll,
    preview,
    setNoiseBed,
    nextIndex,
    labelFor: (id: CategoryId) => CATEGORY_MAP[id].label,
  };
}
